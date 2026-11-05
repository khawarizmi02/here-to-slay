import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameEvent, type GameState, type PlayerView } from "@here-to-slay/engine";
import type { Action, RoomMsg } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_RESPONSE_WINDOW_MS, MemoryActionLogStore, RelayConnection, Room, type Bot, type RoomEngine } from "../src/index.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, seededRandom } from "./harness.js";
import { CHALLENGE, HERO, stagedEngine, watched } from "./staged.js";

/*
 * M3 acceptance through the Room on the real engine (TECHNICAL_DESIGN.md
 * §7.4, §7.6, §10.6, §10.7, §14): a friend who is gone during a Response
 * Window is passed for, and the pass is logged; a Host refresh in the middle
 * of a window rebuilds the very same state; and a Room mixing local, remote
 * and bot Seats, all answering Challenges and Modifiers, plays to game over.
 */

const viewOf = (client: Client) => client.last("update").view as PlayerView;

/** A Room on `engine` with a friend, Bob (s2), joined over a fake relay, saving to a store. The game has started. */
async function withFriend(engine: RoomEngine<GameState>) {
  const clock = new FakeClock();
  const relay = new FakeRelay();
  const { roomCode, hostToken } = relay.createRoom();
  const store = new MemoryActionLogStore();
  const timers = new FakeTimers(clock);
  const room = new Room<GameState>({ engine, clock, timers, random: seededRandom("responses"), hostName: "Alice", roomCode, store });
  room.attachRelay(relay.connectHost(roomCode, hostToken));
  const host = new Client(room.hostConnection);
  const bob = new Client(await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob" }));
  await settle();
  host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat" } });
  host.send({ t: "startGame" });
  await settle();
  const wait = async (ms: number) => {
    clock.advance(ms);
    timers.fireDue();
    await settle();
  };
  return { room, relay, roomCode, hostToken, store, clock, host, bob, wait };
}

const PLAY: Action = { type: "PLAY_HERO", player: "s1", card: HERO };

describe("a friend gone during a Response Window", () => {
  it("is passed for when their time runs out, and the pass is logged as a PASS", async () => {
    const game = await withFriend(stagedEngine());
    game.host.send({ t: "action", seat: "s1", action: PLAY, clientSeq: 0 });
    await settle();
    // Bob holds a Challenge, so he is asked with a countdown; then his connection drops.
    expect(viewOf(game.host).responseWindow).toMatchObject({ kind: "challenge", awaiting: ["s2"] });
    game.bob.conn.close();
    await settle();

    await game.wait(DEFAULT_RESPONSE_WINDOW_MS - 1);
    expect(viewOf(game.host).responseWindow).toMatchObject({ kind: "challenge", awaiting: ["s2"] });
    await game.wait(1);
    const view = viewOf(game.host);
    expect(view.responseWindow).toBeNull();
    expect(view.players[0]!.party.map((h) => h.hero.id)).toEqual([HERO]);

    await game.room.whenSaved();
    expect((await game.store.load(game.roomCode))!.actions).toEqual([PLAY, { type: "PASS", player: "s2" }]);
  });
});

describe("a Host refresh in the middle of a Response Window", () => {
  it("rebuilds an identical state from the action log, and the window goes on", async () => {
    const before = watched(stagedEngine());
    const game = await withFriend(before.engine);
    game.host.send({ t: "action", seat: "s1", action: PLAY, clientSeq: 0 });
    await settle();
    expect(viewOf(game.host).responseWindow).toMatchObject({ kind: "challenge", awaiting: ["s2"] });
    const hostUpdate = game.host.last("update");
    await game.room.whenSaved();

    game.relay.dropHost(game.roomCode);
    await settle();
    game.bob.take();
    const after = watched(stagedEngine());
    const timers = new FakeTimers(game.clock);
    const room = Room.restore(
      { engine: after.engine, clock: game.clock, timers, random: seededRandom("refreshed"), store: game.store },
      (await game.store.load(game.roomCode))!,
    );
    expect(after.seen.state).toEqual(before.seen.state);
    const host = new Client(room.hostConnection);
    expect(host.last("update")).toEqual({ ...hostUpdate, events: [] });
    room.attachRelay(game.relay.connectHost(game.roomCode, game.hostToken));
    await settle();
    expect(viewOf(game.bob).responseWindow).toMatchObject({ kind: "challenge", awaiting: ["s2"] });
    expect(game.bob.last("countdown").ms).toBe(DEFAULT_RESPONSE_WINDOW_MS);

    // Bob Challenges in the rebuilt window, and wins the duel once the Modifier Window on it closes.
    host.take();
    game.bob.send({ t: "action", seat: "s2", action: { type: "PLAY_CHALLENGE", player: "s2", card: CHALLENGE }, clientSeq: 0 });
    await settle();
    expect(viewOf(host).responseWindow).toMatchObject({ kind: "modifier" });
    host.send({ t: "action", seat: "s1", action: { type: "PASS", player: "s1" }, clientSeq: 1 });
    game.clock.advance(DEFAULT_RESPONSE_WINDOW_MS);
    timers.fireDue();
    await settle();
    const events = host.inbox.flatMap((m) => (m.t === "update" ? (m.events as GameEvent[]) : []));
    expect(events).toContainEqual(expect.objectContaining({ type: "CHALLENGE_RESOLVED", challenger: "s2", defender: "s1", succeeded: true }));
    expect(viewOf(host).players[0]!.party).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A whole game with every kind of Seat
// ---------------------------------------------------------------------------

const isResponse = (a: Action) => a.type === "PLAY_CHALLENGE" || a.type === "PLAY_MODIFIER";

/**
 * The fuzz policy (§13.1), keener to respond: half the time a player who can
 * Challenge or play a Modifier does. Otherwise a random legal action, and END_TURN only when nothing else is legal.
 */
function responder(legal: readonly Action[], random: () => number): Action {
  const responses = legal.filter(isResponse);
  if (responses.length > 0 && random() < 0.5) return responses[Math.floor(random() * responses.length)]!;
  const others = legal.filter((a) => a.type !== "END_TURN");
  const pool = others.length > 0 ? others : legal;
  return pool[Math.floor(random() * pool.length)]!;
}

/** One Seat's UI: it reads its own messages, and knows whether it is waiting on the Room for an answer to what it sent. */
class SeatUi {
  view!: PlayerView;
  prompt: Extract<RoomMsg, { t: "passDevice" | "respond" }> | undefined;
  lastUpdate!: Extract<RoomMsg, { t: "update" }>;
  /** Set when this UI sends something, until its next update: the Room may hold a friend's pass back. */
  waiting = false;
  clientSeq = 0;

  constructor(
    readonly seat: string,
    readonly client: Client,
    readonly events: GameEvent[] = [],
  ) {
    this.read();
  }

  read(): void {
    for (const msg of this.client.take()) {
      if (msg.t === "update") {
        this.lastUpdate = msg;
        this.view = msg.view as PlayerView;
        this.prompt = undefined;
        this.waiting = false;
        this.events.push(...(msg.events as GameEvent[]));
      } else if (msg.t === "passDevice" || msg.t === "respond") {
        this.prompt = msg;
      }
    }
  }

  act(action: Action): void {
    this.waiting = true;
    this.client.send({ t: "action", seat: this.seat, action, clientSeq: this.clientSeq++ });
  }
}

describe("a Room with local, remote and bot Seats on the real engine", () => {
  it("plays to game over with every Seat answering Challenges and Modifiers, through timeouts and a Host refresh mid-window", { timeout: 60_000 }, async () => {
    const clock = new FakeClock();
    const relay = new FakeRelay();
    const { roomCode, hostToken } = relay.createRoom();
    const store = new MemoryActionLogStore();
    const random = seededRandom("mixed-seats");
    const bot: () => Bot = () => ({ chooseAction: (_view, legal) => responder(legal, random) });
    let timers = new FakeTimers(clock);
    let spy = watched(createRoomEngine(placeholderCardDefs));
    let room = new Room<GameState>({ engine: spy.engine, clock, timers, random: seededRandom("mixed-room"), hostName: "Alice", roomCode, store, bot });
    room.attachRelay(relay.connectHost(roomCode, hostToken));

    // Seats: Alice (s1) and Bob (s2) on the Host's device, Cara (s3) a friend over the relay, and a bot (s4).
    const hostClient = new Client(room.hostConnection);
    hostClient.send({ t: "addLocalSeat", name: "Bob" });
    const bobClient = new Client(room.connectLocalSeat("s2"));
    const cara = new SeatUi("s3", new Client(await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Cara" })));
    await settle();
    hostClient.send({ t: "addBot", difficulty: "easy" });
    expect(hostClient.last("lobby").seats.map((s) => [s.id, s.kind])).toEqual([["s1", "local"], ["s2", "local"], ["s3", "remote"], ["s4", "bot"]]);
    hostClient.send({ t: "startGame" });
    await settle();

    // Every public event, as the Host's Seat sees them, across the refresh.
    const events: GameEvent[] = [];
    let alice = new SeatUi("s1", hostClient, events);
    let bob = new SeatUi("s2", bobClient);
    cara.read();

    const wait = async (ms: number) => {
      clock.advance(ms);
      timers.fireDue();
      await settle();
    };
    const loggedActions = async () => {
      await room.whenSaved();
      return (await store.load(roomCode))!.actions;
    };

    let timeouts = 0;
    let refreshed = false;
    for (let step = 0; alice.view.phase.kind !== "gameOver"; step++) {
      expect(step, "the game didn't end within 20,000 steps").toBeLessThan(20_000);

      // The Host refreshes once, in a Modifier Window, after some responses have been played.
      if (!refreshed && alice.view.responseWindow?.kind === "modifier" && events.some((e) => e.type === "CHALLENGE_PLAYED")) {
        refreshed = true;
        const state = spy.seen.state;
        const hostUpdate = alice.lastUpdate;
        await room.whenSaved();
        relay.dropHost(roomCode);
        await settle();
        spy = watched(createRoomEngine(placeholderCardDefs));
        timers = new FakeTimers(clock);
        room = Room.restore({ engine: spy.engine, clock, timers, random: seededRandom("mixed-room-refreshed"), store, bot }, (await store.load(roomCode))!);
        expect(spy.seen.state, "the refreshed Room rebuilt a different state").toEqual(state);
        alice = new SeatUi("s1", new Client(room.hostConnection), events);
        expect(alice.lastUpdate).toEqual({ ...hostUpdate, events: [] });
        bob = new SeatUi("s2", new Client(room.connectLocalSeat("s2")));
        room.attachRelay(relay.connectHost(roomCode, hostToken));
        await settle();
        cara.read();
        expect(cara.view.responseWindow?.kind).toBe("modifier");
        continue;
      }

      // A local Seat responds once the Room asks it, confirming it has the device first; outside a window it just acts.
      let acted = false;
      for (const ui of [alice, bob]) {
        if (ui.waiting || ui.view.legalActions.length === 0) continue;
        if (ui.view.legalActions.some((a) => a.type === "PASS")) {
          if (ui.prompt?.t === "passDevice") ui.client.send({ t: "confirmPassDevice", seat: ui.seat });
          else if (ui.prompt?.t === "respond") ui.act(responder(ui.prompt.actions, random));
          else continue;
        } else {
          ui.act(responder(ui.view.legalActions, random));
        }
        acted = true;
        break;
      }

      // Cara answers in time, or now and then lets her countdown run out.
      if (!acted && !cara.waiting && cara.view.legalActions.length > 0) {
        const legal = cara.view.legalActions;
        if (legal.some(isResponse) && random() < 0.25) {
          const logged = (await loggedActions()).length;
          await wait(DEFAULT_RESPONSE_WINDOW_MS);
          // The Room passed for her, and logged it.
          expect((await loggedActions()).slice(logged)).toContainEqual({ type: "PASS", player: "s3" });
          timeouts++;
        } else {
          cara.act(responder(legal, random));
          await settle();
        }
        acted = true;
      }

      // Nobody here can act: a bot's or a friend's response is being held back by its delay, or a friend's pass is waiting.
      if (!acted) await wait(500);
      for (const ui of [alice, bob, cara]) ui.read();
    }

    expect(refreshed, "the Host never refreshed mid-window").toBe(true);
    expect(timeouts, "Cara never let a countdown run out").toBeGreaterThan(0);
    const won = events.find((e) => e.type === "GAME_WON");
    expect(won).toEqual({ type: "GAME_WON", player: alice.view.winner, reason: alice.view.winReason });
    for (const ui of [bob, cara]) expect(ui.view.winner).toBe(alice.view.winner);

    // Every kind of Seat answered with both kinds of response card.
    const responded = (type: "CHALLENGE_PLAYED" | "MODIFIER_PLAYED") =>
      new Set(events.flatMap((e) => ((e.type === "CHALLENGE_PLAYED" || e.type === "MODIFIER_PLAYED") && e.type === type ? [e.player] : [])));
    for (const type of ["CHALLENGE_PLAYED", "MODIFIER_PLAYED"] as const) {
      const by = responded(type);
      expect(by.has("s1") || by.has("s2"), `no local Seat sent a ${type}`).toBe(true);
      expect(by.has("s3"), `the remote Seat never sent a ${type}`).toBe(true);
      expect(by.has("s4"), `the bot never sent a ${type}`).toBe(true);
    }
  });
});
