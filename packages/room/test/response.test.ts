import type { Action } from "@here-to-slay/protocol";
import type * as toy from "@here-to-slay/toy-engine";
import { describe, expect, it } from "vitest";
import { MemoryActionLogStore, Room, type Bot } from "../src/index.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, FakeClock, fixedDeck, hotSeat, promptOf, viewOf } from "./harness.js";

// Response windows for local Seats (TECHNICAL_DESIGN.md §7.4, §7.5): a local
// Seat is interrupted only if it holds a usable card, and sees a pass-device
// step before its options. Every hand below is dealt with `handSize: 2`, in
// Seat order, from the top of a fixed deck.

const player = "ignored-by-room";

/** A hot-seat game with a fixed deal, already started. Seat ids are s1 (Alice, the Host), s2, s3, … */
function dealt(names: string[], deckOrder: toy.ToyCardDefId[], overrides: Parameters<typeof hotSeat>[1] = {}) {
  const game = hotSeat(names, { engine: fixedDeck(deckOrder), ...overrides });
  game.host.send({ t: "setConfig", config: { handSize: 2 } });
  game.host.send({ t: "startGame" });
  const seat = (name: string) => game.seatIds[["Alice", ...names].indexOf(name)]!;
  const client = (name: string) => game.clients.get(seat(name))!;
  let clientSeq = 0;
  const act = (name: string, action: { type: Action["type"]; [field: string]: unknown }) =>
    client(name).send({ t: "action", seat: seat(name), action: { ...action, player } as Action, clientSeq: clientSeq++ });
  const confirm = (name: string) => client(name).send({ t: "confirmPassDevice", seat: seat(name) });
  // Every passDevice any Seat got, in the order sent. The Room repeats a prompt after each update, so repeats collapse.
  const asked: string[] = [];
  for (const c of game.clients.values()) {
    c.conn.onMessage((m) => {
      if (m.t === "passDevice") asked.push(m.name);
    });
  }
  const passDevices = () => asked.filter((name, i) => name !== asked[i - 1]);
  return { ...game, seat, client, act, confirm, passDevices };
}

const viewOfHost = (game: { host: Client }) => viewOf(game.host.last("update"));

describe("response windows for local Seats", () => {
  it("never interrupts a local Seat without a usable card, passing for it", async () => {
    const store = new MemoryActionLogStore();
    // Alice: point_2, point_1. Bob: point_1, point_1. Cleo: point_3, point_1.
    const game = dealt(["Bob", "Cleo"], ["point_2", "point_1", "point_1", "point_1", "point_3", "point_1", "point_1"], { store });
    game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });

    expect(game.passDevices()).toEqual([]);
    const view = viewOfHost(game);
    expect(view.players[0]!.score).toBe(2);
    expect(view.activePlayer).toBe(game.seat("Bob"));
    // The passes are ordinary logged actions, so a replay takes the same path.
    await game.room.whenSaved();
    const record = (await store.load(game.room.roomCode))!;
    expect(record.actions.slice(-2)).toEqual([
      { type: "PASS", player: game.seat("Bob") },
      { type: "PASS", player: game.seat("Cleo") },
    ]);
  });

  it("asks local Seats with a usable card one at a time in turn order, each after a pass-device step", () => {
    // Alice: point_2, point_1. Bob: modifier, point_1. Cleo: point_1, point_1. Dan: challenge, point_1.
    const game = dealt(
      ["Bob", "Cleo", "Dan"],
      ["point_2", "point_1", "modifier", "point_1", "point_1", "point_1", "challenge", "point_1", "point_1"],
    );
    game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });

    // Cleo holds nothing usable and is passed for; Bob is asked first, Dan waits.
    expect(game.passDevices()).toEqual(["Bob"]);
    expect(promptOf(game.client("Bob"))).toEqual({ t: "passDevice", seat: game.seat("Bob"), name: "Bob" });
    expect(viewOfHost(game).responseWindow!.awaiting).toEqual([game.seat("Bob"), game.seat("Dan")]);

    // Before confirming, Bob can't respond, and Dan can't jump the queue.
    game.client("Bob").take();
    game.act("Bob", { type: "PASS" });
    expect(game.client("Bob").take()).toEqual([{ t: "actionRejected", clientSeq: 1, error: expect.stringMatching(/device/i) }]);
    game.act("Dan", { type: "PASS" });
    expect(game.client("Dan").last("actionRejected")).toEqual({ t: "actionRejected", clientSeq: 2, error: expect.any(String) });
    game.confirm("Dan");
    expect(game.client("Dan").last("error")).toEqual({ t: "error", message: expect.any(String) });

    // Once Bob confirms, his options appear.
    game.confirm("Bob");
    expect(game.client("Bob").take()).toEqual([
      {
        t: "respond",
        seat: game.seat("Bob"),
        actions: [
          { type: "PASS", player: game.seat("Bob") },
          { type: "PLAY_MODIFIER", player: game.seat("Bob"), card: "modifier#0", value: 1 },
        ],
      },
    ]);
    game.act("Bob", { type: "PASS" });

    // Then Dan.
    expect(promptOf(game.client("Dan"))).toEqual({ t: "passDevice", seat: game.seat("Dan"), name: "Dan" });
    expect(promptOf(game.client("Bob"))).toBeUndefined();
    game.confirm("Dan");
    game.act("Dan", { type: "PASS" });
    expect(viewOfHost(game).players[0]!.score).toBe(2);
    expect(game.passDevices()).toEqual(["Bob", "Dan"]);
  });

  it("starts after the active player and wraps around the table", () => {
    // Alice: modifier, point_1. Bob: modifier, point_1. Cleo: point_2, point_1. Dan: modifier, point_1.
    const game = dealt(
      ["Bob", "Cleo", "Dan"],
      ["modifier", "point_1", "modifier", "point_1", "point_2", "point_1", "modifier", "point_1", "point_1", "point_1", "point_1"],
    );
    game.act("Alice", { type: "DRAW_CARD" });
    game.act("Bob", { type: "DRAW_CARD" });
    game.act("Cleo", { type: "PLAY_HERO", card: "point_2#0" });
    for (const name of ["Dan", "Alice", "Bob"]) {
      expect(game.passDevices().at(-1)).toBe(name);
      game.confirm(name);
      game.act(name, { type: "PASS" });
    }
    expect(game.passDevices()).toEqual(["Dan", "Alice", "Bob"]);
    expect(viewOfHost(game).players[2]!.score).toBe(2);
  });

  it("reopens the window after a response, asking a player who already passed again", () => {
    // Alice: point_2, point_1. Bob: modifier, point_1. Cleo: modifier, point_1.
    const game = dealt(["Bob", "Cleo"], ["point_2", "point_1", "modifier", "point_1", "modifier", "point_1", "point_1"]);
    game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    game.confirm("Bob");
    game.act("Bob", { type: "PASS" });
    game.confirm("Cleo");
    game.act("Cleo", { type: "PLAY_MODIFIER", card: "modifier#1", value: 1 });

    // Bob passed before the modifier, so he is asked again, from the pass-device step.
    expect(promptOf(game.client("Bob"))).toEqual({ t: "passDevice", seat: game.seat("Bob"), name: "Bob" });
    game.act("Bob", { type: "PASS" });
    expect(game.client("Bob").last("actionRejected").error).toMatch(/device/i);
    game.confirm("Bob");
    game.act("Bob", { type: "PASS" });

    // Cleo has nothing usable left, so she is passed for, and the card scores.
    expect(game.passDevices()).toEqual(["Bob", "Cleo", "Bob"]);
    expect(viewOfHost(game).players[0]!.score).toBe(3);
    expect(viewOfHost(game).activePlayer).toBe(game.seat("Bob"));
  });

  it("sends the asked Seat its prompt again after every update while the prompt stands", () => {
    // Alice: point_2, point_1. Bob: modifier, modifier. Cleo: point_1, point_1.
    const game = dealt(["Bob", "Cleo"], ["point_2", "point_1", "modifier", "modifier", "point_1", "point_1", "point_1"]);
    game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    game.confirm("Bob");
    game.act("Bob", { type: "PLAY_MODIFIER", card: "modifier#0", value: 1 });
    // Cleo is passed for again; Bob, still first, keeps the device and gets his new options.
    const prompt = promptOf(game.client("Bob"));
    expect(prompt).toEqual({
      t: "respond",
      seat: game.seat("Bob"),
      actions: [
        { type: "PASS", player: game.seat("Bob") },
        { type: "PLAY_MODIFIER", player: game.seat("Bob"), card: "modifier#1", value: 1 },
      ],
    });
  });

  it("starts every new window at the pass-device step, even when bots open it in the same breath", () => {
    const heroFirst: Bot = { chooseAction: (_view, legal) => legal.find((a) => a.type === "PLAY_HERO") ?? legal[0]! };
    const room = new Room({
      engine: fixedDeck(["point_2", "point_1", "point_1", "point_1", "modifier", "modifier", "point_1", "point_1", "point_1"]),
      clock: new FakeClock(),
      random: () => 0,
      hostName: "Alice",
      bot: () => heroFirst,
    });
    const host = new Client(room.hostConnection);
    host.send({ t: "addBot", difficulty: "easy" });
    host.send({ t: "addLocalSeat", name: "Bob" });
    // Alice: point_2, point_1. Bot: point_1, point_1. Bob: modifier, modifier.
    const [alice, , bobSeat] = host.last("lobby").seats.map((s) => s.id);
    const bob = new Client(room.connectLocalSeat(bobSeat!));
    host.send({ t: "setConfig", config: { handSize: 2 } });
    host.send({ t: "startGame" });
    host.send({ t: "action", seat: alice!, action: { type: "PLAY_HERO", player, card: "point_2#0" }, clientSeq: 0 });
    bob.send({ t: "confirmPassDevice", seat: bobSeat! });
    // Bob's pass resolves Alice's card; the bot's turn follows at once, and it plays a card Bob may answer.
    bob.send({ t: "action", seat: bobSeat!, action: { type: "PASS", player }, clientSeq: 0 });
    expect(viewOf(bob.last("update")).responseWindow?.player).not.toBe(alice);
    expect(promptOf(bob)).toEqual({ t: "passDevice", seat: bobSeat, name: "Bob" });
  });

  it("lets a local Seat with nothing usable pass by itself before the Room passes for it", () => {
    // Alice: point_2, point_1. Bob: point_1, point_1.
    const game = hotSeat(["Bob"], { engine: fixedDeck(["point_2", "point_1", "point_1", "point_1", "point_1"]) });
    const bobSeat = game.seatIds[1]!;
    const bob = game.clients.get(bobSeat)!;
    bob.conn.onMessage((m) => {
      if (m.t === "update" && viewOf(m).responseWindow?.awaiting.includes(bobSeat)) {
        bob.send({ t: "action", seat: bobSeat, action: { type: "PASS", player }, clientSeq: 7 });
      }
    });
    game.host.send({ t: "setConfig", config: { handSize: 2 } });
    game.host.send({ t: "startGame" });
    game.host.send({ t: "action", seat: game.hostSeat, action: { type: "PLAY_HERO", player, card: "point_2#0" }, clientSeq: 0 });
    expect(bob.of("actionRejected")).toEqual([]);
    expect(viewOf(game.host.last("update")).players[0]!.score).toBe(2);
  });

  it("never times out a local Seat", () => {
    const clock = new FakeClock();
    // Alice: point_2, point_1. Bob: challenge, point_1.
    const game = dealt(["Bob"], ["point_2", "point_1", "challenge", "point_1", "point_1"], { clock });
    game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    const version = game.host.last("update").version;

    clock.advance(24 * 60 * 60 * 1000);
    game.host.send({ t: "resync" });
    expect(promptOf(game.client("Bob"))).toEqual({ t: "passDevice", seat: game.seat("Bob"), name: "Bob" });
    game.confirm("Bob");
    clock.advance(24 * 60 * 60 * 1000);
    game.host.send({ t: "resync" });

    expect(game.host.last("update").version).toBe(version);
    expect(viewOfHost(game).responseWindow!.awaiting).toEqual([game.seat("Bob")]);
    game.act("Bob", { type: "PLAY_CHALLENGE", card: "challenge#0" });
    expect(viewOfHost(game).players[0]!.score).toBe(0);
  });

  it("never times out a local Seat on relay ticks either", async () => {
    const clock = new FakeClock();
    const relay = new FakeRelay();
    const { roomCode, hostToken } = relay.createRoom();
    // Alice: point_2, point_1. Bob: challenge, point_1.
    const game = dealt(["Bob"], ["point_2", "point_1", "challenge", "point_1", "point_1"], { clock, roomCode });
    game.room.attachRelay(relay.connectHost(roomCode, hostToken));
    game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    const version = game.host.last("update").version;
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      relay.tick(roomCode);
      await settle();
    }
    expect(game.host.last("update").version).toBe(version);
    expect(viewOfHost(game).responseWindow!.awaiting).toEqual([game.seat("Bob")]);
  });

  it("resolves windows with no artificial delay in a Room of local and bot Seats", () => {
    const clock = new FakeClock();
    const reads: number[] = [];
    const watched = { now: () => (reads.push(clock.now()), clock.now()) };
    const firstLegal: Bot = { chooseAction: (_view, legal) => legal[0]! };
    // Alice: point_2, point_1. Bob: point_1, point_1. Bot: point_1, point_1.
    const room = hotSeat(["Bob"], {
      engine: fixedDeck(["point_2", "point_1", "point_1", "point_1", "point_1", "point_1", "point_1"]),
      clock: watched,
      bot: () => firstLegal,
    });
    room.host.send({ t: "addBot", difficulty: "easy" });
    room.host.send({ t: "setConfig", config: { handSize: 2 } });
    room.host.send({ t: "startGame" });
    room.host.send({ t: "action", seat: room.hostSeat, action: { type: "PLAY_HERO", player, card: "point_2#0" }, clientSeq: 0 });

    // Bob and the bot both passed within the same call, without the clock moving.
    const view = viewOf(room.host.last("update"));
    expect(view.players[0]!.score).toBe(2);
    expect(view.activePlayer).toBe(room.seatIds[1]);
    expect(new Set(reads).size).toBeLessThanOrEqual(1);
  });

  it("asks the same Seat again after a Host refresh mid-window", async () => {
    const store = new MemoryActionLogStore();
    const deck: toy.ToyCardDefId[] = ["point_2", "point_1", "challenge", "point_1", "point_1"];
    // Alice: point_2, point_1. Bob: challenge, point_1.
    const game = dealt(["Bob"], deck, { store, roomCode: "ABC23" });
    game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    game.confirm("Bob");
    await game.room.whenSaved();
    for (const client of game.clients.values()) client.conn.close();

    const room = Room.restore(
      { engine: fixedDeck(deck), clock: new FakeClock(), random: () => 0, store },
      (await store.load("ABC23"))!,
    );
    const host = new Client(room.hostConnection);
    const bob = new Client(room.connectLocalSeat(game.seat("Bob")));
    expect(promptOf(host)).toBeUndefined();
    expect(promptOf(bob)).toEqual({ t: "passDevice", seat: game.seat("Bob"), name: "Bob" });
    bob.send({ t: "confirmPassDevice", seat: game.seat("Bob") });
    bob.send({ t: "action", seat: game.seat("Bob"), action: { type: "PASS", player }, clientSeq: 0 });
    expect(viewOf(host.last("update")).players[0]!.score).toBe(2);
  });

  it("does not hold up remote Seats, which answer in their own time", async () => {
    const relay = new FakeRelay();
    const { roomCode, hostToken } = relay.createRoom();
    const room = new Room({
      engine: fixedDeck(["point_2", "point_1", "challenge", "point_1", "point_1"]),
      clock: new FakeClock(),
      random: () => 0,
      hostName: "Alice",
      roomCode,
    });
    room.attachRelay(relay.connectHost(roomCode, hostToken));
    const host = new Client(room.hostConnection);
    const { RelayConnection } = await import("../src/index.js");
    const friend = new Client(await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob" }));
    await settle();
    const bobSeat = friend.last("lobby").you[0]!;
    host.send({ t: "setConfig", config: { handSize: 2 } });
    host.send({ t: "startGame" });
    host.send({ t: "action", seat: host.last("lobby").you[0]!, action: { type: "PLAY_HERO", player, card: "point_2#0" }, clientSeq: 0 });
    await settle();

    // The friend holds a challenge but gets no pass-device step, and may answer at once.
    friend.send({ t: "confirmPassDevice", seat: bobSeat });
    await settle();
    expect(friend.of("passDevice")).toEqual([]);
    expect(friend.last("error")).toEqual({ t: "error", message: expect.any(String) });
    friend.send({ t: "action", seat: bobSeat, action: { type: "PLAY_CHALLENGE", player, card: "challenge#0" }, clientSeq: 0 });
    await settle();
    expect(viewOf(host.last("update")).turn).toBe(2);
    expect(friend.of("actionRejected")).toEqual([]);
  });
});
