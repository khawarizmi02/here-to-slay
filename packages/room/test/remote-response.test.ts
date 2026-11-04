import type { RoomMsg } from "@here-to-slay/protocol";
import type * as toy from "@here-to-slay/toy-engine";
import { describe, expect, it } from "vitest";
import { MemoryActionLogStore, Room, type Bot, type RoomEngine } from "../src/index.js";
import { settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, fixedDeck, viewOf } from "./harness.js";
import { online, player } from "./online.js";

// Response windows and timers for remote Seats (TECHNICAL_DESIGN.md §7.4,
// §10.6). Every hand below is dealt with `handSize: 2`, in Seat order, from
// the top of a fixed deck. Seat ids are s1 (Alice, the Host), s2, s3, …

describe("timers for remote Seats", () => {
  it("resolves an expired deadline on the next relay tick, even when the Room's own timer never fires", async () => {
    const store = new MemoryActionLogStore();
    // Alice: point_2, point_1. Bob: challenge, point_1.
    const game = await online({ seats: ["Bob"], deck: ["point_2", "point_1", "challenge", "point_1", "point_1"], config: { responseWindowMs: 5_000 }, store });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });

    game.elapse(4_999);
    await game.tick();
    expect(game.view().responseWindow!.awaiting).toEqual([game.seat("Bob")]);

    game.elapse(1);
    await game.tick();
    expect(game.view().responseWindow).toBeNull();
    expect(game.view().players[0]!.score).toBe(2);
    await game.room.whenSaved();
    expect((await store.load(game.roomCode))!.actions.at(-1)).toEqual({ type: "PASS", player: game.seat("Bob") });
  });

  it("shows other friends no difference between a Seat that passes quickly with a usable card and a Seat holding nothing", async () => {
    /** Everything Cara receives, stamped with the time it arrived. */
    const timeline = async (bobsHand: toy.ToyCardDefId[], bobPasses: boolean) => {
      // Alice: point_2, point_1. Bob: as given. Cara: point_1, point_1.
      const game = await online({ seats: ["Bob", "Cara"], deck: ["point_2", "point_1", ...bobsHand, "point_1", "point_1", "point_1"], random: () => 0.25 });
      const seen: [number, RoomMsg][] = [];
      game.client("Cara").conn.onMessage((m) => seen.push([game.clock.now(), m]));
      await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
      await game.act("Cara", { type: "PASS" });
      if (bobPasses) await game.act("Bob", { type: "PASS" });
      for (let i = 0; i < 30; i++) await game.wait(100);
      expect(game.client("Bob").of("actionRejected")).toEqual([]);
      expect(game.view().players[0]!.score).toBe(2);
      return seen;
    };

    const quickPass = await timeline(["modifier", "point_3"], true);
    const nothing = await timeline(["point_3", "point_3"], false);
    expect(quickPass).toEqual(nothing);
    // Both passes landed at the random delay, not at once: 500 ms + 0.25 × 2000 ms.
    const passedAt = (seen: [number, RoomMsg][]) =>
      seen.find(([, m]) => m.t === "update" && m.events.some((e) => e.type === "PASSED" && e.player === "s2"))![0];
    expect(passedAt(quickPass)).toBe(1_000 + 1_000);
  });

  it("holds a bot's response back by the random delay when a remote Seat is in the Room", async () => {
    const challenger: Bot = { chooseAction: (_view, legal) => legal.find((a) => a.type === "PLAY_CHALLENGE") ?? legal[0]! };
    // Alice: point_2, point_1. Bot: challenge, point_1. Bob: point_1, point_1.
    const game = await online({ seats: ["bot", "Bob"], deck: ["point_2", "point_1", "challenge", "point_1", "point_1", "point_1", "point_1"], bot: challenger, random: () => 0 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    expect(game.view().responseWindow!.awaiting).toContain("s2");

    await game.wait(499);
    expect(game.view().responseWindow!.awaiting).toContain("s2");
    await game.wait(1);
    expect(game.view().responseWindow).toBeNull();
    expect(game.host.of("update").flatMap((u) => u.events)).toContainEqual(expect.objectContaining({ type: "CHALLENGED", player: "s2" }));
  });

  it("lets a bot respond at once when no remote Seat is in the Room", async () => {
    const challenger: Bot = { chooseAction: (_view, legal) => legal.find((a) => a.type === "PLAY_CHALLENGE") ?? legal[0]! };
    // Alice: point_2, point_1. Bot: challenge, point_1.
    const game = await online({ seats: ["bot"], deck: ["point_2", "point_1", "challenge", "point_1", "point_1"], bot: challenger, random: () => 0 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    expect(game.host.of("update").flatMap((u) => u.events)).toContainEqual(expect.objectContaining({ type: "CHALLENGED", player: "s2" }));
    expect(game.timers.size).toBe(0);
  });

  it("gives priority to the first response the Host receives when two arrive close together", async () => {
    // Alice: point_2, point_1. Bob: challenge, point_1. Cara: challenge, point_1.
    const game = await online({ seats: ["Bob", "Cara"], deck: ["point_2", "point_1", "challenge", "point_1", "challenge", "point_1", "point_1"] });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    game.client("Cara").send({ t: "action", seat: game.seat("Cara"), action: { type: "PLAY_CHALLENGE", player, card: "challenge#1" }, clientSeq: 1 });
    game.client("Bob").send({ t: "action", seat: game.seat("Bob"), action: { type: "PLAY_CHALLENGE", player, card: "challenge#0" }, clientSeq: 1 });
    await settle();

    const challenges = game.host.of("update").flatMap((u) => u.events).filter((e) => e.type === "CHALLENGED");
    expect(challenges).toEqual([expect.objectContaining({ player: game.seat("Cara") })]);
    expect(game.client("Cara").of("actionRejected")).toEqual([]);
    expect(game.client("Bob").of("actionRejected")).toEqual([{ t: "actionRejected", clientSeq: 1, error: expect.any(String) }]);
  });

  it("reopens the window to everyone after a response, so a pass still waiting must be made again", async () => {
    // Alice: point_2, point_1. Bob: modifier, point_1. Cara: modifier, point_1.
    const game = await online({ seats: ["Bob", "Cara"], deck: ["point_2", "point_1", "modifier", "point_1", "modifier", "point_1", "point_1"], random: () => 1 });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    // Bob passes at once; his pass waits for his delay. Cara's modifier comes first.
    await game.act("Bob", { type: "PASS" });
    await game.act("Cara", { type: "PLAY_MODIFIER", card: "modifier#1", value: 1 });
    expect(game.client("Bob").last("actionRejected")).toEqual({ t: "actionRejected", clientSeq: 1, error: expect.stringMatching(/respond again/) });
    expect(game.view().responseWindow!.awaiting).toEqual([game.seat("Bob"), game.seat("Cara")]);

    // Each gets a fresh countdown from the modifier: the default 8 seconds.
    await game.wait(7_999);
    expect(game.view().responseWindow!.awaiting).toEqual([game.seat("Bob")]);
    await game.wait(1);
    expect(game.view().players[0]!.score).toBe(3);
  });

  it("logs timeouts like any other action, so the saved log rebuilds a Room with identical views", async () => {
    const store = new MemoryActionLogStore();
    // Alice: point_1, point_1. Bob: wish, challenge.
    const deck: toy.ToyCardDefId[] = ["point_1", "point_1", "wish", "challenge", "point_1", "point_1", "point_1", "point_1"];
    const game = await online({ seats: ["Bob"], deck, store });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_1#0" });
    // Bob holds a challenge and lets his time run out: the Room passes for him.
    await game.wait(8_000);
    // Bob plays a wish; nobody can answer it, and Bob lets the decision time out too.
    await game.act("Bob", { type: "PLAY_HERO", card: "wish#0" });
    expect(game.view().pendingDecision).toEqual({ player: game.seat("Bob") });
    await game.wait(7_999);
    expect(game.view().phase).toBe("decision");
    await game.wait(1);
    expect(game.view().players[1]!.score).toBe(2);

    await game.room.whenSaved();
    const record = (await store.load(game.roomCode))!;
    expect(record.actions).toEqual([
      { type: "PLAY_HERO", player: "s1", card: "point_1#0" },
      { type: "PASS", player: "s2" },
      { type: "PLAY_HERO", player: "s2", card: "wish#0" },
      { type: "PASS", player: "s1" },
      // The first option: gain 2 points.
      { type: "RESOLVE_DECISION", player: "s2", decisionId: "d1", answer: { selected: ["gain2"] } },
    ]);
    const restored = Room.restore({ engine: fixedDeck(deck), clock: new FakeClock(), timers: new FakeTimers(new FakeClock()), random: () => 0 }, record);
    expect(new Client(restored.hostConnection).last("update")).toEqual({ ...game.host.last("update"), events: [] });
  });

  it("answers a timed-out discard with a random card rather than the first", async () => {
    // The toy wish stands in for a discard: its second option is the random pick.
    const deck: toy.ToyCardDefId[] = ["point_1", "point_1", "wish", "point_1", "point_1", "point_1", "point_1", "point_1"];
    const discarding: RoomEngine<toy.GameState> = { ...fixedDeck(deck), isDiscardDecision: () => true };
    const store = new MemoryActionLogStore();
    // Alice: point_1, point_1. Bob: wish, point_1.
    const game = await online({ seats: ["Bob"], deck, engine: discarding, random: () => 0.9, store });
    await game.act("Alice", { type: "DRAW_CARD" });
    await game.act("Bob", { type: "PLAY_HERO", card: "wish#0" });
    await game.wait(8_000);
    await game.room.whenSaved();
    expect((await store.load(game.roomCode))!.actions.at(-1)).toEqual({
      type: "RESOLVE_DECISION",
      player: "s2",
      decisionId: "d1",
      answer: { selected: ["draw2"] },
    });
  });

  it("answers an expired deadline when the Host's UI checks on visibilitychange", async () => {
    // Alice: point_2, point_1. Bob: challenge, point_1.
    const game = await online({ seats: ["Bob"], deck: ["point_2", "point_1", "challenge", "point_1", "point_1"] });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    game.elapse(8_000);
    game.room.checkDeadlines();
    expect(game.view().players[0]!.score).toBe(2);
  });

  it("restarts open deadlines from their full duration after a Host refresh", async () => {
    const store = new MemoryActionLogStore();
    const deck: toy.ToyCardDefId[] = ["point_2", "point_1", "challenge", "point_1", "point_1"];
    // Alice: point_2, point_1. Bob: challenge, point_1.
    const game = await online({ seats: ["Bob"], deck, store });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    game.elapse(7_000);
    await game.room.whenSaved();

    const clock = game.clock;
    const timers = new FakeTimers(clock);
    const room = Room.restore({ engine: fixedDeck(deck), clock, timers, random: () => 0.5, store }, (await store.load(game.roomCode))!);
    const host = new Client(room.hostConnection);
    clock.advance(7_999);
    timers.fireDue();
    expect(viewOf(host.last("update")).responseWindow!.awaiting).toEqual(["s2"]);
    clock.advance(1);
    timers.fireDue();
    expect(viewOf(host.last("update")).players[0]!.score).toBe(2);
  });

  it("sends a countdown only to a remote Seat with a usable card, again after every update while it stands", async () => {
    // Alice: point_2, point_1. Bob: modifier, modifier. Cara: point_1, point_1.
    const game = await online({ seats: ["Bob", "Cara"], deck: ["point_2", "point_1", "modifier", "modifier", "point_1", "point_1", "point_1"] });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    const bob = game.client("Bob");
    expect(bob.inbox.at(-1)).toEqual({ t: "countdown", seat: "s2", ms: 8_000 });

    // Cara holds nothing: she is asked, but with no countdown, and is passed for after her delay.
    await game.wait(2_500);
    expect(game.client("Cara").of("countdown")).toEqual([]);
    expect(bob.inbox.slice(-2)).toEqual([expect.objectContaining({ t: "update" }), { t: "countdown", seat: "s2", ms: 5_500 }]);

    // A resync gets the countdown too.
    bob.send({ t: "resync" });
    await settle();
    expect(bob.inbox.at(-1)).toEqual({ t: "countdown", seat: "s2", ms: 5_500 });

    // Once Bob answers, it is over.
    await game.act("Bob", { type: "PASS" });
    expect(bob.inbox.at(-1)).toMatchObject({ t: "update" });
  });

  it("answers a waiting pass when the Seat changes its mind and responds instead", async () => {
    // Alice: point_2, point_1. Bob: challenge, point_1.
    const game = await online({ seats: ["Bob"], deck: ["point_2", "point_1", "challenge", "point_1", "point_1"] });
    await game.act("Alice", { type: "PLAY_HERO", card: "point_2#0" });
    await game.act("Bob", { type: "PASS" });
    await game.act("Bob", { type: "PLAY_CHALLENGE", card: "challenge#0" });
    expect(game.view().players[0]!.score).toBe(0);
    expect(game.client("Bob").of("actionRejected")).toEqual([{ t: "actionRejected", clientSeq: 1, error: expect.any(String) }]);
  });
});
