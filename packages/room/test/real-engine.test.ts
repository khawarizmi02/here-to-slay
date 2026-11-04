import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameEvent, type GameState, type PlayerView } from "@here-to-slay/engine";
import { describe, expect, it } from "vitest";
import type { Action } from "@here-to-slay/protocol";
import { Room } from "../src/index.js";
import { Client, FakeClock, FakeTimers, seededRandom } from "./harness.js";

/*
 * The Room on the real rules engine (ADR-0002: the Room's own tests stay on
 * the toy engine; these check the two fit together).
 */

function realRoom(extra: string[], bots = 0) {
  const clock = new FakeClock();
  const room = new Room<GameState>({
    engine: createRoomEngine(placeholderCardDefs),
    clock,
    timers: new FakeTimers(clock),
    random: seededRandom("real-room"),
    hostName: "Alice",
  });
  const host = new Client(room.hostConnection);
  for (const name of extra) host.send({ t: "addLocalSeat", name });
  for (let i = 0; i < bots; i++) host.send({ t: "addBot", difficulty: "easy" });
  const lobby = host.last("lobby");
  const hostSeat = lobby.you[0]!;
  const clients = new Map<string, Client>([[hostSeat, host]]);
  for (const seat of lobby.seats) {
    if (seat.id !== hostSeat && seat.kind === "local") clients.set(seat.id, new Client(room.connectLocalSeat(seat.id)));
  }
  return { host, clients, seatIds: lobby.seats.map((s) => s.id) };
}

const viewOf = (client: Client) => client.last("update").view as PlayerView;

describe("a Room on the real engine", () => {
  it("starts a real game, and each Seat's view shows only its own hand", () => {
    const { host, clients, seatIds } = realRoom(["Bob", "Cleo"]);
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat" } });
    host.send({ t: "startGame" });

    const hands = new Map<string, string[]>();
    for (const [seat, client] of clients) {
      const view = viewOf(client);
      expect(view.me).toBe(seat);
      expect(view.hand).toHaveLength(5);
      expect(view.players.map((p) => p.id)).toEqual(seatIds);
      expect(view.players.map((p) => p.handCount)).toEqual([5, 5, 5]);
      expect(view.activeMonsters).toHaveLength(3);
      expect(view.responseWindow).toBeNull();
      // The Host's Seat comes first, so firstSeat makes the Host go first.
      expect(view.activePlayer).toBe(seatIds[0]);
      hands.set(seat, view.hand.map((c) => c.id));
    }

    for (const [seat, client] of clients) {
      const json = JSON.stringify(client.inbox);
      for (const [other, hand] of hands) {
        if (other === seat) continue;
        for (const card of hand) expect(json, `${seat} was shown ${other}'s ${card}`).not.toContain(JSON.stringify(card));
      }
    }
  });

  it("completes a leader draft with a local Seat and a bot, then rolls for the first player", () => {
    const { host, seatIds } = realRoom([], 1);
    const [alice, bot] = seatIds as [string, string];
    host.send({ t: "setConfig", config: { leaderSelection: "draft" } });
    host.send({ t: "startGame" });

    // Seat order: the Host's Seat drafts first, and the bot waits its turn.
    let view = viewOf(host);
    expect(view.phase).toEqual({ kind: "setup", step: "leaderSelect" });
    expect(view.activePlayer).toBe(alice);
    const decision = view.pendingDecision;
    if (!decision || !("options" in decision)) throw new Error("Alice was not asked to pick a leader");
    expect(decision.kind).toBe("chooseLeader");
    const choice = decision.options[1]!.id;
    host.send({ t: "action", seat: alice, action: { type: "RESOLVE_DECISION", player: alice, decisionId: decision.id, answer: { selected: [choice] } }, clientSeq: 0 });

    // The bot picks from what is left, then everyone rolls and the game starts.
    view = viewOf(host);
    const leaders = view.players.map((p) => p.leader?.id);
    expect(leaders[0]).toBe(choice);
    expect(leaders[1]).toBeDefined();
    expect(leaders[1]).not.toBe(choice);
    expect(view.phase).toEqual({ kind: "action" });
    expect(view.pendingDecision).toBeNull();
    expect(view.firstPlayerRolls).not.toBeNull();
    expect(view.turnOrder).toHaveLength(2);
    expect(view.turnOrder).toEqual(expect.arrayContaining([alice, bot]));
    // If the bot won the roll, it has already played its first turn.
    expect(view.activePlayer).toBe(alice);
    expect(view.turnNumber).toBe(view.turnOrder[0] === alice ? 1 : 2);
  });

  it("lets bots take their turns, round after round, without stalling", () => {
    const { host, seatIds } = realRoom([], 3);
    const alice = seatIds[0]!;
    // Alice keeps her 5 cards; a bot that draws has hand-limit discards to make.
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat", handLimit: 5 } });
    host.send({ t: "startGame" });

    const rounds = 12;
    const turnsStarted = new Map<string, number>();
    let discards = 0;
    let answered = 0;
    let clientSeq = 0;
    let view = viewOf(host);
    /** Sends Alice's action and reads every update it caused. */
    const send = (action: Action) => {
      host.take();
      host.send({ t: "action", seat: alice, action, clientSeq: clientSeq++ });
      const updates = host.take().filter((m) => m.t === "update");
      for (const msg of updates) {
        for (const e of msg.events as GameEvent[]) {
          if (e.type === "TURN_STARTED") turnsStarted.set(e.player, (turnsStarted.get(e.player) ?? 0) + 1);
          if (e.type === "CARD_DISCARDED") discards++;
        }
      }
      view = updates.at(-1)!.view as PlayerView;
    };
    for (let round = 1; round <= rounds; round++) {
      // Every bot move runs straight away, so each time the Room settles it is Alice's turn again.
      expect(view.activePlayer).toBe(alice);
      expect(view.phase).toEqual({ kind: "action" });
      expect(view.turnNumber).toBe(1 + (round - 1) * seatIds.length);
      send({ type: "END_TURN", player: alice });
      // A bot's hero may ask Alice something, such as a card to discard.
      while (view.activePlayer !== alice) {
        expect(view.pendingDecision).toMatchObject({ player: alice });
        send(view.legalActions[0]!);
        answered++;
      }
    }
    // Every Seat started a turn each round: Alice's first turn began at setup, and her next one has begun.
    expect(Object.fromEntries(turnsStarted)).toEqual(Object.fromEntries(seatIds.map((s) => [s, rounds])));
    expect(view.activePlayer).toBe(alice);
    expect(discards, "no bot ever discarded, so the hand limit went untested").toBeGreaterThan(0);
    expect(answered, "no bot's effect ever asked Alice anything").toBeGreaterThan(0);
  });

  it("stays in the lobby, naming the key, when the engine rejects the config", () => {
    const { host } = realRoom(["Bob"]);
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat", handSize: 5 } });
    host.take();
    host.send({ t: "startGame" });
    expect(host.take()).toEqual([{ t: "error", message: expect.stringContaining('unknown key "handSize"') }]);
  });
});
