import type { GameState, PlayerView } from "@here-to-slay/engine";
import type * as toy from "@here-to-slay/toy-engine";
import { describe, expect, it } from "vitest";
import { MemoryActionLogStore, RelayConnection, Room, SEAT_HOLD_MS } from "../src/index.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, fixedDeck, promptOf, viewOf } from "./harness.js";
import { online } from "./online.js";
import { CHALLENGE, HERO, stagedEngine } from "./staged.js";

// The Response Delay for local Seats in a Room with a remote Seat
// (TECHNICAL_DESIGN.md §7.4, #25). Every hand below is dealt with
// `handSize: 2`, in Seat order, from the top of a fixed deck. Seat ids are
// s1 (Alice, the Host), s2, s3, …

/** Whether the Host has seen `seat` pass. */
const passed = (game: Awaited<ReturnType<typeof online>>, seat: string) =>
  game.host.of("update").some((u) => u.events.some((e) => e.type === "PASSED" && e.player === seat));

describe("the Response Delay for local Seats in a Room with a remote Seat", () => {
  it("holds back the automatic pass for a local Seat with no usable card in a Challenge Window", async () => {
    // Alice: point_2, point_1. Bob (remote): challenge, point_1. Dan (local): point_1, point_1.
    const game = await online({ seats: ["Bob", "local:Dan"], deck: ["point_2", "point_1", "challenge", "point_1", "point_1", "point_1", "point_1"], random: () => 0 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    expect(passed(game, game.seat("Dan"))).toBe(false);

    await game.wait(499);
    expect(passed(game, game.seat("Dan"))).toBe(false);
    await game.wait(1);
    expect(passed(game, game.seat("Dan"))).toBe(true);
    expect(game.client("Dan").of("passDevice")).toEqual([]);
    expect(game.client("Dan").of("countdown")).toEqual([]);
  });

  it("holds back the automatic pass for a local Seat with no usable card in a Modifier Window", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const relay = new FakeRelay();
    const { roomCode, hostToken } = relay.createRoom();
    const room = new Room<GameState>({ engine: stagedEngine(), clock, timers, random: () => 0, hostName: "Alice", roomCode });
    room.attachRelay(relay.connectHost(roomCode, hostToken));
    const host = new Client(room.hostConnection);
    // Bob (s2, remote) holds the Challenge; Dan (s3, local) holds nothing.
    const bob = new Client(await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob" }));
    await settle();
    host.send({ t: "addLocalSeat", name: "Dan" });
    new Client(room.connectLocalSeat("s3"));
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat" } });
    host.send({ t: "startGame" });
    host.send({ t: "action", seat: "s1", action: { type: "PLAY_HERO", player: "s1", card: HERO }, clientSeq: 0 });
    await settle();
    bob.send({ t: "action", seat: "s2", action: { type: "PLAY_CHALLENGE", player: "s2", card: CHALLENGE }, clientSeq: 0 });
    await settle();
    const window = () => (host.last("update").view as PlayerView).responseWindow;
    expect(window()).toMatchObject({ kind: "modifier" });
    expect(window()!.awaiting).toContain("s3");

    clock.advance(499);
    timers.fireDue();
    expect(window()!.awaiting).toContain("s3");
    clock.advance(1);
    timers.fireDue();
    expect(window()?.awaiting ?? []).not.toContain("s3");
  });

  it("asks a local Seat with a usable card at once, but holds a pass it makes before its delay is up", async () => {
    // Alice: point_2, point_1. Bob (remote): point_1, point_1. Dan (local): challenge, point_1.
    const game = await online({ seats: ["Bob", "local:Dan"], deck: ["point_2", "point_1", "point_1", "point_1", "challenge", "point_1", "point_1"], random: () => 0.5 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    const dan = game.client("Dan");
    expect(dan.of("passDevice")).toEqual([{ t: "passDevice", seat: game.seat("Dan"), name: "Dan" }]);
    await game.confirm("Dan");

    // 500 ms + 0.5 × 2000 ms.
    await game.wait(100);
    await game.act("Dan", { type: "PASS" });
    expect(passed(game, game.seat("Dan"))).toBe(false);
    // Dan has answered, so his prompt is over at once: a fresh update leaves no prompt standing.
    expect(promptOf(dan)).toBeUndefined();
    await game.wait(1_399);
    expect(passed(game, game.seat("Dan"))).toBe(false);
    await game.wait(1);
    expect(passed(game, game.seat("Dan"))).toBe(true);
    expect(dan.of("actionRejected")).toEqual([]);
    expect(dan.of("countdown")).toEqual([]);
  });

  it("applies a local Seat's pass at once when its delay is already up", async () => {
    // Alice: point_2, point_1. Bob (remote): point_1, point_1. Dan (local): challenge, point_1.
    const game = await online({ seats: ["Bob", "local:Dan"], deck: ["point_2", "point_1", "point_1", "point_1", "challenge", "point_1", "point_1"], random: () => 0.5 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    await game.confirm("Dan");
    // Dan is never timed out: nothing is due for him once his delay is up.
    await game.wait(60_000);
    expect(passed(game, game.seat("Dan"))).toBe(false);
    expect(game.timers.size).toBe(0);
    await game.act("Dan", { type: "PASS" });
    expect(passed(game, game.seat("Dan"))).toBe(true);
  });

  it("asks the next local Seat with a usable card while the first one's pass is held", async () => {
    // Alice: point_2, point_1. Bob (remote): point_1, point_1. Dan (local): challenge, point_1. Eve (local): modifier, point_1.
    const deck = ["point_2", "point_1", "point_1", "point_1", "challenge", "point_1", "modifier", "point_1", "point_1"] as const;
    const game = await online({ seats: ["Bob", "local:Dan", "local:Eve"], deck: [...deck], random: () => 0.5 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    expect(game.client("Eve").of("passDevice")).toEqual([]);
    await game.confirm("Dan");
    await game.act("Dan", { type: "PASS" });
    expect(passed(game, game.seat("Dan"))).toBe(false);

    // Eve is asked straight away, without waiting for Dan's pass to land.
    expect(game.client("Eve").of("passDevice")).toEqual([{ t: "passDevice", seat: game.seat("Eve"), name: "Eve" }]);
    await game.confirm("Eve");
    await game.act("Eve", { type: "PASS" });
    await game.wait(1_500);
    expect(passed(game, game.seat("Dan"))).toBe(true);
    expect(passed(game, game.seat("Eve"))).toBe(true);
    expect(game.view().players[0]!.score).toBe(2);
  });

  it("drops a local Seat's pending automatic pass when a response reopens the window, and passes after a new delay", async () => {
    // Alice: point_2, point_1. Bob (remote): modifier, point_1. Dan (local): point_1, point_1.
    const game = await online({ seats: ["Bob", "local:Dan"], deck: ["point_2", "point_1", "modifier", "point_1", "point_1", "point_1", "point_1"], random: () => 0.5 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    await game.wait(100);
    await game.act("Bob", { type: "PLAY_MODIFIER", card: "modifier#0", value: 1 });

    // Dan's first delay would have ended at 1,500 ms; the new one started with Bob's modifier, at 100 ms.
    await game.wait(1_399);
    expect(passed(game, game.seat("Dan"))).toBe(false);
    await game.wait(100);
    expect(passed(game, game.seat("Dan"))).toBe(false);
    await game.wait(1);
    expect(passed(game, game.seat("Dan"))).toBe(true);
  });

  it("drops a local Seat's held pass when a response reopens the window, and asks that Seat again", async () => {
    // Alice: point_2, point_1. Bob (remote): point_1, point_1. Dan (local): modifier, point_1. Eve (local): modifier, point_1.
    const deck = ["point_2", "point_1", "point_1", "point_1", "modifier", "point_1", "modifier", "point_1", "point_1"] as const;
    const game = await online({ seats: ["Bob", "local:Dan", "local:Eve"], deck: [...deck], random: () => 0.5 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    await game.confirm("Dan");
    await game.act("Dan", { type: "PASS" });
    await game.confirm("Eve");
    await game.act("Eve", { type: "PLAY_MODIFIER", card: "modifier#1", value: 1 });

    const dan = game.client("Dan");
    expect(dan.last("actionRejected")).toEqual({ t: "actionRejected", clientSeq: 1, error: expect.stringMatching(/respond again/) });
    expect(dan.of("passDevice")).toHaveLength(2);
    await game.wait(5_000);
    // The dropped pass never lands: Dan is still to answer.
    expect(passed(game, game.seat("Dan"))).toBe(false);
    expect(game.view().responseWindow!.awaiting).toContain(game.seat("Dan"));
  });

  for (const [state, away] of [
    ["held for them", 0],
    ["played by a bot", SEAT_HOLD_MS],
  ] as const) {
    it(`still holds back a local Seat's pass while the remote friend is gone and their Seat is ${state}`, async () => {
      // Alice: point_2, point_1. Bob (remote): point_1, point_1. Dan (local): point_1, point_1.
      const game = await online({ seats: ["Bob", "local:Dan"], deck: ["point_2", "point_1", "point_1", "point_1", "point_1", "point_1", "point_1"], random: () => 0 });
      game.client("Bob").conn.close();
      await game.wait(away);
      await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
      expect(passed(game, game.seat("Dan"))).toBe(false);
      await game.wait(500);
      expect(passed(game, game.seat("Dan"))).toBe(true);
    });
  }

  it("logs a delayed local pass as an ordinary PASS, so the saved game replays to the same state", async () => {
    const store = new MemoryActionLogStore();
    // Alice: point_2, point_1. Bob (remote): point_1, point_1. Dan (local): point_1, point_1.
    const deck: toy.ToyCardDefId[] = ["point_2", "point_1", "point_1", "point_1", "point_1", "point_1", "point_1"];
    const game = await online({ seats: ["Bob", "local:Dan"], deck, store });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    await game.wait(2_500);
    expect(game.view().players[0]!.score).toBe(2);
    await game.room.whenSaved();
    const record = (await store.load(game.roomCode))!;
    expect(record.actions.filter((a) => a.player === game.seat("Dan"))).toEqual([{ type: "PASS", player: game.seat("Dan") }]);

    const clock = new FakeClock();
    const restored = Room.restore({ engine: fixedDeck(deck), clock, timers: new FakeTimers(clock), random: () => 0.5 }, record);
    expect(new Client(restored.hostConnection).last("update")).toEqual({ ...game.host.last("update"), events: [] });
  });

  it("asks a local Seat again after a Host refresh while its pass was held, as the held pass was never saved", async () => {
    const store = new MemoryActionLogStore();
    // Alice: point_2, point_1. Bob (remote): point_1, point_1. Dan (local): challenge, point_1.
    const deck: toy.ToyCardDefId[] = ["point_2", "point_1", "point_1", "point_1", "challenge", "point_1", "point_1"];
    const game = await online({ seats: ["Bob", "local:Dan"], deck, store, random: () => 0.5 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    await game.confirm("Dan");
    await game.act("Dan", { type: "PASS" });
    await game.room.whenSaved();
    const record = (await store.load(game.roomCode))!;
    expect(record.actions.filter((a) => a.player === game.seat("Dan"))).toEqual([]);

    const clock = game.clock;
    const timers = new FakeTimers(clock);
    const room = Room.restore({ engine: fixedDeck(deck), clock, timers, random: () => 0.5, store }, record);
    const host = new Client(room.hostConnection);
    const dan = new Client(room.connectLocalSeat(game.seat("Dan")));
    expect(promptOf(dan)).toEqual({ t: "passDevice", seat: game.seat("Dan"), name: "Dan" });

    // Dan passes again, and the pass waits for a fresh delay from the refresh: 1,500 ms.
    const awaiting = () => viewOf(host.last("update")).responseWindow?.awaiting ?? [];
    dan.send({ t: "confirmPassDevice", seat: game.seat("Dan") });
    dan.send({ t: "action", seat: game.seat("Dan"), action: { type: "PASS", player: "ignored-by-room" }, clientSeq: 0 });
    clock.advance(1_499);
    timers.fireDue();
    expect(awaiting()).toContain(game.seat("Dan"));
    clock.advance(1);
    timers.fireDue();
    expect(dan.of("actionRejected")).toEqual([]);
    expect(awaiting()).not.toContain(game.seat("Dan"));
  });
});
