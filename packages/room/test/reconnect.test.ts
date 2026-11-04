import type * as toy from "@here-to-slay/toy-engine";
import { describe, expect, it } from "vitest";
import { MemoryActionLogStore, RelayConnection, Room, SEAT_HOLD_MS, type Bot } from "../src/index.js";
import { settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, fixedDeck, viewOf } from "./harness.js";
import { online, player } from "./online.js";

// Reconnection and Seat handover (TECHNICAL_DESIGN.md §10.7). Hands are dealt
// with `handSize: 2`, in Seat order, from the top of a fixed deck.

/** A bot that plays a card whenever it can, so its turn opens a response window. */
const playsCards: Bot = {
  chooseAction: (_view, legal) => legal.find((a) => a.type === "PLAY_HERO") ?? legal.find((a) => a.type === "PASS") ?? legal[0]!,
};

/** The friend's tab reloads: it joins again with the seat token it kept in localStorage. */
async function rejoin(game: Awaited<ReturnType<typeof online>>, name: string) {
  const old = game.client(name).conn as RelayConnection;
  const connection = await RelayConnection.join({ dialer: game.relay.dialer, roomCode: game.roomCode, name, seatToken: old.seatToken });
  const client = new Client(connection);
  await settle();
  return client;
}

async function drop(game: Awaited<ReturnType<typeof online>>, name: string) {
  game.client(name).conn.close();
  await settle();
}

describe("a friend coming back", () => {
  it("gets the same Seat and hand back after a refresh, with a fresh update", async () => {
    // Alice: point_1, point_1. Bob: challenge, point_2.
    const game = await online({ seats: ["Bob"], deck: ["point_1", "point_1", "challenge", "point_2", "point_1", "point_1"] });
    await game.act("Alice", { type: "DRAW_CARD" });
    const before = game.client("Bob").last("update");
    expect(viewOf(before).hand.map((c) => c.id)).toEqual(["challenge#0", "point_2#0"]);

    await drop(game, "Bob");
    const bob = await rejoin(game, "Bob");

    expect(bob.of("update")).not.toHaveLength(0);
    expect(bob.last("update")).toEqual({ ...before, events: [] });
    expect(bob.of("lobby")).toHaveLength(0);
    // And it is still his to play.
    bob.send({ t: "action", seat: game.seat("Bob"), action: { type: "PLAY_HERO", player, card: "point_2#0" }, clientSeq: 1 });
    await settle();
    // Alice holds nothing to answer it with, so it scores at once.
    expect(game.view().players[1]!.score).toBe(2);
  });

  it("keeps the Seat while the friend is back within 2 minutes", async () => {
    const game = await online({ seats: ["Bob"], deck: ["point_1", "point_1", "point_1", "point_1", "point_1", "point_1"], bot: playsCards });
    await game.act("Alice", { type: "DRAW_CARD" });
    await drop(game, "Bob");
    await game.wait(SEAT_HOLD_MS - 1);
    const bob = await rejoin(game, "Bob");
    await game.wait(SEAT_HOLD_MS);
    // Nobody played Bob's turn for him.
    expect(game.view().activePlayer).toBe(game.seat("Bob"));
    expect(game.view().phase).toBe("action");
    expect(viewOf(bob.last("update")).hand).toHaveLength(2);
  });
});

describe("a friend gone for 2 minutes", () => {
  it("has their Seat taken over by a bot, which plays it", async () => {
    const game = await online({ seats: ["Bob"], deck: ["point_1", "point_1", "point_2", "point_1", "point_1", "point_1"], bot: playsCards });
    await game.act("Alice", { type: "DRAW_CARD" });
    await drop(game, "Bob");

    await game.wait(SEAT_HOLD_MS - 1);
    expect(game.view().activePlayer).toBe(game.seat("Bob"));
    expect(game.view().phase).toBe("action");

    await game.wait(1);
    // The bot played Bob's point_2, which scored: Alice holds nothing to answer it with.
    expect(game.view().players[1]!.score).toBe(2);
    expect(game.view().activePlayer).toBe(game.seat("Alice"));
  });

  it("answers a response window for the absent friend once the bot takes over", async () => {
    // Alice: point_2, point_1. Bob: challenge, point_1. The bot challenges whatever it can.
    const challenges: Bot = { chooseAction: (_view, legal) => legal.find((a) => a.type === "PLAY_CHALLENGE") ?? legal[0]! };
    const game = await online({
      seats: ["Bob"],
      deck: ["point_2", "point_1", "challenge", "point_1", "point_1"],
      bot: challenges,
      config: { responseWindowMs: 10 * SEAT_HOLD_MS },
    });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    await drop(game, "Bob");
    await game.wait(SEAT_HOLD_MS - 1);
    expect(game.view().responseWindow?.awaiting).toEqual([game.seat("Bob")]);
    // The bot answers after the same random delay as any bot in a Room with remote Seats.
    await game.wait(1);
    await game.wait(2_500);
    expect(game.view().discard.map((c) => c.id)).toEqual(["point_2#0", "challenge#0"]);
  });

  it("gives the Seat back at the next turn boundary, not mid-turn", async () => {
    const store = new MemoryActionLogStore();
    // Alice: point_1, challenge. Bob: point_2, point_1.
    const deck: toy.ToyCardDefId[] = ["point_1", "challenge", "point_2", "point_1", "point_1", "point_1", "point_1", "point_1"];
    const game = await online({ seats: ["Bob"], deck, bot: playsCards, store });
    await game.act("Alice", { type: "DRAW_CARD" });
    await drop(game, "Bob");
    await game.wait(SEAT_HOLD_MS);
    // Bob's bot played point_2; Alice holds a challenge, so the window waits for her.
    expect(game.view().responseWindow).toMatchObject({ player: game.seat("Bob"), awaiting: [game.seat("Alice")] });

    // Bob comes back mid-turn: he watches, but the bot keeps his Seat until the turn ends.
    const bob = await rejoin(game, "Bob");
    expect(viewOf(bob.last("update")).hand.map((c) => c.id)).toEqual(["point_1#1"]);
    bob.send({ t: "action", seat: game.seat("Bob"), action: { type: "PLAY_HERO", player, card: "point_1#1" }, clientSeq: 7 });
    await settle();
    expect(bob.last("actionRejected")).toEqual({ t: "actionRejected", clientSeq: 7, error: "A bot is playing your Seat until the turn ends" });

    // Alice passes; Bob's point scores, and his turn ends.
    game.host.send({ t: "confirmPassDevice", seat: game.seat("Alice") });
    await game.act("Alice", { type: "PASS" });
    expect(game.view().players[1]!.score).toBe(2);
    expect(game.view().activePlayer).toBe(game.seat("Alice"));

    // Alice's turn ends, and Bob's is his again: the bot doesn't move.
    await game.act("Alice", { type: "DRAW_CARD" });
    await game.wait(SEAT_HOLD_MS);
    expect(game.view().activePlayer).toBe(game.seat("Bob"));
    expect(game.view().phase).toBe("action");
    bob.send({ t: "action", seat: game.seat("Bob"), action: { type: "DRAW_CARD", player }, clientSeq: 8 });
    await settle();
    expect(game.view().activePlayer).toBe(game.seat("Alice"));

    await game.room.whenSaved();
    expect((await store.load(game.roomCode))!.actions.map((a) => `${a.player} ${a.type}`)).toEqual([
      "s1 DRAW_CARD",
      "s2 PLAY_HERO", // the bot
      "s1 PASS",
      "s1 DRAW_CARD",
      "s2 DRAW_CARD", // Bob himself
    ]);
  });

  it("asks the returned friend in response windows again, with a countdown, once the Seat is back", async () => {
    // Alice: point_1, point_1. Bob: point_1, modifier.
    const deck: toy.ToyCardDefId[] = ["point_1", "point_1", "point_1", "modifier", ...Array<toy.ToyCardDefId>(8).fill("point_1")];
    const game = await online({ seats: ["Bob"], deck, bot: playsCards });
    await game.act("Alice", { type: "DRAW_CARD" });
    await drop(game, "Bob");
    await game.wait(SEAT_HOLD_MS);
    // The bot played Bob's point_1; Alice holds nothing to answer it with, so the turn is hers again.
    expect(game.view().activePlayer).toBe(game.seat("Alice"));
    const bob = await rejoin(game, "Bob");

    // Alice's turn ends, and Bob has his Seat back.
    await game.act("Alice", { type: "DRAW_CARD" });
    bob.send({ t: "action", seat: game.seat("Bob"), action: { type: "DRAW_CARD", player }, clientSeq: 1 });
    await settle();
    bob.take();
    await game.act("Alice", { type: "PLAY_HERO", card: "point_1#0" });
    expect(bob.last("countdown")).toEqual({ t: "countdown", seat: game.seat("Bob"), ms: 8_000 });
  });
});

describe("the Host refreshing over the relay", () => {
  it("rebuilds the Room mid-window and sends every Seat the same view, and friends see hostAway then hostBack", async () => {
    const store = new MemoryActionLogStore();
    // Alice: point_2, point_1. Bob: challenge, point_1. Cara: point_1, point_1.
    const deck: toy.ToyCardDefId[] = ["point_2", "point_1", "challenge", "point_1", "point_1", "point_1", "point_1"];
    const game = await online({ seats: ["Bob", "Cara"], deck, store });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    // Cara holds nothing and has been passed for; Bob, holding a challenge, still has time.
    await game.wait(2_500);
    expect(game.view().responseWindow?.awaiting).toEqual([game.seat("Bob")]);
    const before = new Map(["Alice", "Bob", "Cara"].map((name) => [name, game.client(name).last("update")]));
    await game.room.whenSaved();

    // The Host's tab reloads: the old Room is gone with its relay socket.
    game.relay.dropHost(game.roomCode);
    await settle();
    for (const name of ["Bob", "Cara"]) game.client(name).take();

    const timers = new FakeTimers(game.clock);
    const room = Room.restore({ engine: fixedDeck(deck), clock: game.clock, timers, random: () => 0.5, store }, (await store.load(game.roomCode))!);
    const host = new Client(room.hostConnection);
    room.attachRelay(game.relay.connectHost(game.roomCode, `host-token-${game.roomCode}`));
    await settle();

    expect(host.last("update")).toEqual({ ...before.get("Alice")!, events: [] });
    for (const name of ["Bob", "Cara"]) {
      const client = game.client(name);
      expect(client.inbox[0]).toEqual({ t: "hostBack" });
      expect(client.last("update")).toEqual({ ...before.get(name)!, events: [] });
    }
    // Bob's deadline restarted at its full duration.
    expect(game.client("Bob").last("countdown").ms).toBe(8_000);

    // And play goes on: Bob challenges.
    game.client("Bob").send({ t: "action", seat: game.seat("Bob"), action: { type: "PLAY_CHALLENGE", player, card: "challenge#0" }, clientSeq: 1 });
    await settle();
    expect(viewOf(host.last("update")).discard.map((c) => c.id)).toEqual(["point_2#0", "challenge#0"]);
  });

  it("tells friends hostAway while the Host is gone, then roomClosed if it never comes back", async () => {
    const game = await online({ seats: ["Bob"], deck: ["point_1", "point_1", "point_1", "point_1", "point_1"] });
    game.client("Bob").take();
    game.relay.dropHost(game.roomCode);
    await settle();
    game.relay.closeRoom(game.roomCode);
    await settle();
    expect(game.client("Bob").take()).toEqual([{ t: "hostAway" }, { t: "roomClosed" }]);
    expect((game.client("Bob").conn as RelayConnection).closed).toBe(true);
  });

  it("holds a friend's Seat for 2 minutes from the refresh, if they don't come back with the Host", async () => {
    const store = new MemoryActionLogStore();
    const deck: toy.ToyCardDefId[] = ["point_1", "point_1", "point_2", "point_1", "point_1", "point_1"];
    const game = await online({ seats: ["Bob"], deck, store });
    await game.act("Alice", { type: "DRAW_CARD" });
    await drop(game, "Bob");
    await game.room.whenSaved();
    game.relay.dropHost(game.roomCode);
    await settle();

    const clock = new FakeClock(game.clock.time + 60_000);
    const timers = new FakeTimers(clock);
    const room = Room.restore({ engine: fixedDeck(deck), clock, timers, random: () => 0.5, store, bot: () => playsCards }, (await store.load(game.roomCode))!);
    const host = new Client(room.hostConnection);
    room.attachRelay(game.relay.connectHost(game.roomCode, `host-token-${game.roomCode}`));
    await settle();

    clock.advance(SEAT_HOLD_MS - 1);
    timers.fireDue();
    expect(viewOf(host.last("update")).phase).toBe("action");
    clock.advance(1);
    timers.fireDue();
    expect(viewOf(host.last("update")).players[1]!.score).toBe(2);
  });
});

