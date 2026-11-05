import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameEvent, type GameState, type PlayerView } from "@here-to-slay/engine";
import type { Action, RoomMsg } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { RelayConnection, Room, type Bot, type RoomEngine } from "../src/index.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, seededRandom } from "./harness.js";

/*
 * Challenges through the Room on the real engine (TECHNICAL_DESIGN.md §7.2,
 * §7.4): a local, a remote and a bot Seat can each Challenge a card the Host
 * plays. Seat ids are s1 (Alice, the Host) and s2.
 */

const HERO = `${placeholderCardDefs.find((d) => d.type === "hero")!.id}#0`;
const CHALLENGE = `${placeholderCardDefs.find((d) => d.type === "challenge")!.id}#0`;

/**
 * The real engine with every hand emptied at the start, then Alice given a
 * hero and s2 a Challenge, and the next dice forced so the challenger wins.
 * The Room replays its log through `createGame`, so this is the same on every replay.
 */
function stagedEngine(): RoomEngine<GameState> {
  const base = createRoomEngine(placeholderCardDefs);
  return {
    ...base,
    createGame(opts) {
      const state = base.createGame(opts);
      for (const p of state.players) {
        state.mainDeck.push(...p.hand);
        p.hand = [];
      }
      state.mainDeck = state.mainDeck.filter((c) => c !== HERO && c !== CHALLENGE);
      state.players[0]!.hand.push(HERO);
      state.players[1]!.hand.push(CHALLENGE);
      // The challenger rolls 12, the defender 2.
      state.rng.forcedDice = [6, 6, 1, 1];
      return state;
    },
  };
}

function roomOn(opts: { bot?: () => Bot; roomCode?: string } = {}) {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const room = new Room<GameState>({
    engine: stagedEngine(),
    clock,
    timers,
    random: seededRandom("challenge-room"),
    hostName: "Alice",
    ...(opts.bot ? { bot: opts.bot } : {}),
    ...(opts.roomCode ? { roomCode: opts.roomCode } : {}),
  });
  return { room, clock, timers, host: new Client(room.hostConnection) };
}

const viewOf = (client: Client) => client.last("update").view as PlayerView;
const eventsOf = (msgs: readonly RoomMsg[]) => msgs.flatMap((m) => (m.t === "update" ? (m.events as GameEvent[]) : []));

const PLAY: Action = { type: "PLAY_HERO", player: "s1", card: HERO };
const CHALLENGE_IT: Action = { type: "PLAY_CHALLENGE", player: "s2", card: CHALLENGE };

/** What every Seat sees once s2's Challenge has sent Alice's hero to the discard pile. */
function expectChallengedAway(view: PlayerView, events: GameEvent[]) {
  expect(events).toContainEqual(expect.objectContaining({ type: "CHALLENGE_PLAYED", player: "s2", defender: "s1" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "CHALLENGE_RESOLVED", challenger: "s2", defender: "s1", succeeded: true }));
  expect(events.some((e) => e.type === "HERO_PLAYED")).toBe(false);
  expect(view.responseWindow).toBeNull();
  expect(view.players[0]!.party).toEqual([]);
  expect(view.discardPile.map((c) => c.id).slice(-2)).toEqual([CHALLENGE, HERO]);
  expect(view.actionPoints).toBe(2);
}

describe("a Challenge through the Room on the real engine", () => {
  it("from a local Seat: the Room asks it at the pass-device step, then it Challenges", () => {
    const { room, host } = roomOn();
    host.send({ t: "addLocalSeat", name: "Bob" });
    const bob = new Client(room.connectLocalSeat("s2"));
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat" } });
    host.send({ t: "startGame" });

    host.send({ t: "action", seat: "s1", action: PLAY, clientSeq: 0 });
    expect(viewOf(bob).responseWindow).toEqual({ kind: "challenge", awaiting: ["s2"], card: { id: HERO, def: HERO.split("#")[0] } });
    expect(bob.last("passDevice")).toEqual({ t: "passDevice", seat: "s2", name: "Bob" });

    bob.send({ t: "confirmPassDevice", seat: "s2" });
    expect(bob.last("respond").actions).toEqual([{ type: "PASS", player: "s2" }, CHALLENGE_IT]);
    bob.take();
    host.take();
    bob.send({ t: "action", seat: "s2", action: CHALLENGE_IT, clientSeq: 0 });

    expectChallengedAway(viewOf(host), eventsOf(host.take()));
    expect(bob.of("actionRejected")).toEqual([]);
  });

  it("from a remote Seat, which is asked with a countdown and Challenges in time", async () => {
    const relay = new FakeRelay();
    const { roomCode, hostToken } = relay.createRoom();
    const { room, host, clock, timers } = roomOn({ roomCode });
    room.attachRelay(relay.connectHost(roomCode, hostToken));
    const bob = new Client(await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob" }));
    await settle();
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat" } });
    host.send({ t: "startGame" });
    await settle();

    host.send({ t: "action", seat: "s1", action: PLAY, clientSeq: 0 });
    await settle();
    const asked = viewOf(bob);
    expect(asked.responseWindow).toMatchObject({ kind: "challenge", awaiting: ["s2"] });
    expect(asked.legalActions).toEqual([{ type: "PASS", player: "s2" }, CHALLENGE_IT]);

    host.take();
    bob.send({ t: "action", seat: "s2", action: CHALLENGE_IT, clientSeq: 0 });
    await settle();
    // Both rolls are in, and the Modifier Window on them waits on everyone: Alice passes if she is asked, and Bob's countdown runs out.
    const duel = viewOf(host);
    expect(duel.responseWindow).toMatchObject({ kind: "modifier" });
    if (duel.legalActions.some((a) => a.type === "PASS")) host.send({ t: "action", seat: "s1", action: { type: "PASS", player: "s1" }, clientSeq: 1 });
    clock.advance(10_000);
    timers.fireDue();
    await settle();
    expectChallengedAway(viewOf(host), eventsOf(host.take()));
    expectChallengedAway(viewOf(bob), eventsOf(bob.inbox));
    expect(bob.of("actionRejected")).toEqual([]);
  });

  it("from a bot Seat, which Challenges as soon as it is asked", () => {
    const challenger: Bot = { chooseAction: (_view, legal) => legal.find((a) => a.type === "PLAY_CHALLENGE") ?? legal[0]! };
    const { host } = roomOn({ bot: () => challenger });
    host.send({ t: "addBot", difficulty: "easy" });
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat" } });
    host.send({ t: "startGame" });

    host.take();
    host.send({ t: "action", seat: "s1", action: PLAY, clientSeq: 0 });
    expectChallengedAway(viewOf(host), eventsOf(host.take()));
  });
});
