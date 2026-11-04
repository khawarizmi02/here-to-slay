import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ActionSchema,
  ClientMsgSchema,
  FriendToRelayFrameSchema,
  HostToRelayFrameSchema,
  RelayToFriendFrameSchema,
  RelayToHostFrameSchema,
  ROOM_CODE_ALPHABET,
  RoomCodeSchema,
  RoomMsgSchema,
  type Action,
  type ClientMsg,
  type RoomMsg,
} from "../src/index.js";

const TOKEN = "tok_abcdef123456";
const TOKEN2 = "tok_zyxwvu654321";

function expectAccepts(schema: z.ZodType, examples: readonly unknown[]) {
  for (const example of examples) {
    const result = schema.safeParse(example);
    expect(result.success, `expected to accept ${JSON.stringify(example)}`).toBe(true);
  }
}

function expectRejects(schema: z.ZodType, examples: readonly unknown[]) {
  for (const example of examples) {
    const result = schema.safeParse(example);
    expect(result.success, `expected to reject ${JSON.stringify(example)}`).toBe(false);
  }
}

const validActions: Action[] = [
  { type: "DRAW_CARD", player: "p1" },
  { type: "PLAY_HERO", player: "p1", card: "hero_thief_01#0" },
  { type: "PLAY_ITEM", player: "p1", card: "item_01#0", targetHero: "hero_thief_01#0" },
  { type: "PLAY_MAGIC", player: "p1", card: "magic_01#0" },
  { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_thief_01#0" },
  { type: "ATTACK_MONSTER", player: "p1", monster: "monster_01#0" },
  { type: "DISCARD_AND_REDRAW", player: "p1" },
  { type: "END_TURN", player: "p1" },
  { type: "PLAY_CHALLENGE", player: "p2", card: "challenge_01#0" },
  { type: "PLAY_MODIFIER", player: "p2", card: "mod_01#0", value: -2 },
  { type: "PASS", player: "p2" },
  { type: "RESOLVE_DECISION", player: "p1", decisionId: "d1", answer: { selected: ["opt_a"] } },
];

describe("ActionSchema", () => {
  it("accepts every action type", () => {
    expectAccepts(ActionSchema, validActions);
    const types = new Set(validActions.map((a) => a.type));
    expect(types.size).toBe(12);
  });

  it("rejects malformed actions", () => {
    expectRejects(ActionSchema, [
      null,
      "DRAW_CARD",
      { type: "DRAW_CARD" },
      { type: "FLY_AWAY", player: "p1" },
      { type: "PLAY_HERO", player: "p1" },
      { type: "PLAY_HERO", player: "p1", card: 7 },
      { type: "PLAY_MODIFIER", player: "p1", card: "m#0", value: 1.5 },
      { type: "RESOLVE_DECISION", player: "p1", decisionId: "d1", answer: "opt_a" },
      { type: "DRAW_CARD", player: "p1", extra: true },
      { type: "PASS", player: "" },
    ]);
  });
});

describe("ClientMsgSchema (Seat → Room)", () => {
  const valid: ClientMsg[] = [
    { t: "joinRoom", name: "Alice" },
    { t: "addBot", difficulty: "easy" },
    { t: "addBot", difficulty: "normal" },
    { t: "addLocalSeat", name: "Bob" },
    { t: "setConfig", config: { handLimit: 7, allowStealing: true, variant: "house" } },
    { t: "startGame" },
    { t: "action", seat: "s1", action: { type: "PASS", player: "p1" }, clientSeq: 0 },
    { t: "resync" },
    { t: "chat", text: "gg" },
    { t: "confirmPassDevice", seat: "s2" },
  ];

  it("accepts a well-formed example of every message", () => {
    expectAccepts(ClientMsgSchema, valid);
    expect(new Set(valid.map((m) => m.t))).toEqual(
      new Set(["joinRoom", "addBot", "addLocalSeat", "setConfig", "startGame", "action", "resync", "chat", "confirmPassDevice"]),
    );
  });

  it("rejects malformed messages", () => {
    expectRejects(ClientMsgSchema, [
      undefined,
      {},
      { t: "nope" },
      { t: "joinRoom" },
      { t: "joinRoom", name: "" },
      { t: "joinRoom", name: "   " },
      { t: "joinRoom", name: "x".repeat(25) },
      { t: "addBot", difficulty: "impossible" },
      { t: "addLocalSeat", name: 3 },
      { t: "setConfig", config: { handLimit: { nested: true } } },
      { t: "setConfig" },
      { t: "startGame", force: true },
      { t: "action", seat: "s1", action: { type: "PASS", player: "p1" } },
      { t: "action", seat: "s1", action: { type: "PASS", player: "p1" }, clientSeq: -1 },
      { t: "action", seat: "s1", action: { type: "CHEAT", player: "p1" }, clientSeq: 1 },
      { t: "action", action: { type: "PASS", player: "p1" }, clientSeq: 1 },
      { t: "chat", text: "" },
      { t: "chat", text: "x".repeat(501) },
      { t: "confirmPassDevice" },
      { t: "confirmPassDevice", seat: "" },
    ]);
  });
});

describe("RoomMsgSchema (Room → Seat)", () => {
  const valid: RoomMsg[] = [
    {
      t: "lobby",
      roomCode: "ABC23",
      seats: [
        { id: "s1", name: "Host", kind: "local", connected: true },
        { id: "s2", name: "Friend", kind: "remote", connected: false },
        { id: "s3", name: "Bot", kind: "bot", connected: true },
      ],
      you: ["s1"],
    },
    {
      t: "update",
      version: 3,
      events: [{ type: "CARD_DRAWN", player: "p1" }],
      view: { me: "p1", hand: [] },
    },
    { t: "actionRejected", clientSeq: 4, error: "Not your turn" },
    { t: "hostAway" },
    { t: "hostBack" },
    { t: "roomClosed" },
    { t: "error", message: "Room is full" },
    { t: "passDevice", seat: "s2", name: "Bob" },
    { t: "respond", seat: "s2", actions: [{ type: "PASS", player: "s2" }, { type: "PLAY_CHALLENGE", player: "s2", card: "challenge#0" }] },
    { t: "countdown", seat: "s2", ms: 8000 },
  ];

  it("accepts a well-formed example of every message", () => {
    expectAccepts(RoomMsgSchema, valid);
    expect(new Set(valid.map((m) => m.t))).toEqual(
      new Set(["lobby", "update", "actionRejected", "hostAway", "hostBack", "roomClosed", "error", "passDevice", "respond", "countdown"]),
    );
  });

  it("rejects malformed messages", () => {
    expectRejects(RoomMsgSchema, [
      { t: "lobby", roomCode: "ABC23", seats: [], you: "s1" },
      { t: "lobby", roomCode: "AB0O1", seats: [], you: [] },
      { t: "lobby", roomCode: "ABC23", seats: [{ id: "s1", name: "x", kind: "ghost", connected: true }], you: [] },
      { t: "update", version: -1, events: [], view: {} },
      { t: "update", version: 1, events: [{ player: "p1" }], view: {} },
      { t: "update", version: 1, events: [] },
      { t: "actionRejected", clientSeq: 1 },
      { t: "error" },
      { t: "hostBack", extra: 1 },
      { t: "roomClosed", reason: "gone" },
      { t: "passDevice", seat: "s2" },
      { t: "respond", seat: "s2", actions: [{ type: "CHEAT", player: "s2" }] },
      { t: "respond", seat: "s2" },
      { t: "countdown", seat: "s2", ms: -1 },
      { t: "countdown", seat: "s2", ms: 1.5 },
      { t: "countdown", seat: "s2" },
    ]);
  });
});

describe("RoomCodeSchema", () => {
  it("accepts 5 readable characters and rejects confusable ones", () => {
    expectAccepts(RoomCodeSchema, ["ABCDE", "Z9X8W", "HJKMN"]);
    expectRejects(RoomCodeSchema, ["ABCD", "ABCDEF", "abcde", "ABCD0", "ABCDO", "ABCD1", "ABCDI"]);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[0O1I]/);
  });
});

describe("relay frames", () => {
  const clientPayload: ClientMsg = { t: "chat", text: "hi" };
  const roomPayload: RoomMsg = { t: "hostAway" };

  it("friend → relay", () => {
    expectAccepts(FriendToRelayFrameSchema, [{ payload: clientPayload }]);
    expectRejects(FriendToRelayFrameSchema, [
      {},
      // A friend cannot claim an identity; the relay stamps it.
      { payload: clientPayload, from: TOKEN },
      "payload",
    ]);
  });

  it("relay → Host", () => {
    expectAccepts(RelayToHostFrameSchema, [
      { kind: "msg", from: TOKEN, payload: clientPayload },
      { kind: "peerJoined", seatToken: TOKEN },
      { kind: "peerLeft", seatToken: TOKEN },
      { kind: "tick" },
    ]);
    expectRejects(RelayToHostFrameSchema, [
      { kind: "msg", payload: clientPayload },
      { kind: "msg", from: "short", payload: clientPayload },
      { kind: "msg", from: TOKEN },
      { kind: "peerJoined" },
      { kind: "tock" },
    ]);
  });

  it("Host → relay", () => {
    expectAccepts(HostToRelayFrameSchema, [
      { to: "all", payload: roomPayload },
      { to: TOKEN2, payload: roomPayload },
    ]);
    expectRejects(HostToRelayFrameSchema, [
      { payload: roomPayload },
      { to: "all" },
      { to: 5, payload: roomPayload },
      { to: "all", payload: roomPayload, kind: "msg" },
    ]);
  });

  it("relay → friend", () => {
    expectAccepts(RelayToFriendFrameSchema, [
      { kind: "msg", payload: roomPayload },
      { kind: "welcome", seatToken: TOKEN },
      { kind: "hostAway" },
      { kind: "hostBack" },
      { kind: "roomClosed" },
    ]);
    expectRejects(RelayToFriendFrameSchema, [
      { kind: "msg" },
      { kind: "welcome" },
      { kind: "roomOpened" },
      { kind: "hostBack", extra: 1 },
    ]);
  });

  it("passes payloads through without parsing them", () => {
    // The relay must forward payloads it doesn't understand (protocol can change without a redeploy).
    const opaque = { t: "someFutureMessage", data: [1, 2, 3] };
    const parsed = HostToRelayFrameSchema.parse({ to: "all", payload: opaque });
    expect(parsed.payload).toEqual(opaque);
  });
});
