import { placeholderCardDefs } from "@here-to-slay/cards";
import { botFactory, createRoomEngine, type GameState, type PlayerView } from "@here-to-slay/engine";
import type { Action } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { RelayConnection, RESPONSE_DELAY_MS, Room, SEAT_HOLD_MS, type BotDifficulty, type BotFactory } from "../src/index.js";
import { ACTION_CAP, playBotGame } from "./bot-games.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, fuzzPick, latestPrompt, seededRandom } from "./harness.js";

/** A scripted human, playing the fuzz policy. */
function scriptedHuman(seed: string) {
  const random = seededRandom(seed);
  return (_view: unknown, legal: Action[]): Action => fuzzPick(legal, random);
}

describe("a human against three easy bots", () => {
  it("finishes without a stall", () => {
    const { view, botMoves } = playBotGame("human-vs-easy", scriptedHuman("human"));
    expect(botMoves, "the bots never moved").toBeGreaterThan(0);
    expect(view.phase.kind).toBe("gameOver");
    expect(view.players.map((p) => p.id)).toContain(view.winner);
    expect(view.legalActions).toEqual([]);
  });
});

describe("a friend's Seat a bot takes over", () => {
  it("is played by the easy bot until the game ends", { timeout: 60_000 }, async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const relay = new FakeRelay();
    const { roomCode, hostToken } = relay.createRoom();
    const made: BotDifficulty[] = [];
    let botMoves = 0;
    // Every Seat's actions but PASSes, as in the all-bot games.
    let actions = 0;
    const easyBots = botFactory(placeholderCardDefs, seededRandom("takeover-bot"));
    const bot: BotFactory = (seat) => {
      made.push(seat.difficulty);
      const easy = easyBots(seat);
      return {
        chooseAction: (view, legal) => {
          botMoves++;
          const action = easy.chooseAction(view, legal);
          if (action.type !== "PASS") actions++;
          return action;
        },
      };
    };
    const room = new Room<GameState>({
      engine: createRoomEngine(placeholderCardDefs),
      clock,
      timers,
      random: seededRandom("takeover-room"),
      hostName: "Alice",
      roomCode,
      bot,
    });
    room.attachRelay(relay.connectHost(roomCode, hostToken));
    const host = new Client(room.hostConnection);
    const bob = new Client(await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob" }));
    await settle();
    const [alice, bobSeat] = host.last("lobby").seats.map((s) => s.id) as [string, string];
    host.send({ t: "startGame" });
    await settle();

    // Bob's tab closes, and stays closed for the whole Seat hold.
    bob.conn.close();
    await settle();
    clock.advance(SEAT_HOLD_MS);
    timers.fireDue();
    await settle();
    expect(made).toEqual(["normal"]);

    const human = scriptedHuman("takeover-alice");
    const view = () => host.last("update").view as PlayerView;
    let clientSeq = 0;
    while (view().phase.kind !== "gameOver") {
      expect(actions, `the game didn't end within ${ACTION_CAP} actions`).toBeLessThan(ACTION_CAP);
      const legal = view().legalActions;
      if (legal.length > 0) {
        if (latestPrompt(host.inbox)?.t === "passDevice") host.send({ t: "confirmPassDevice", seat: alice });
        const action = human(view(), legal);
        if (action.type !== "PASS") actions++;
        host.send({ t: "action", seat: alice, action, clientSeq: clientSeq++ });
      }
      // In a Room with a remote Seat, the bot's answers and Alice's passes land once their Response Delay is up.
      clock.advance(RESPONSE_DELAY_MS.max);
      timers.fireDue();
      await settle();
      expect(host.of("error"), "the Room rejected Alice's action").toEqual([]);
    }

    expect(botMoves, "the bot never played Bob's Seat").toBeGreaterThan(0);
    expect([alice, bobSeat]).toContain(view().winner);
  });
});
