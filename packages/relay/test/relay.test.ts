import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, connectHost, createRoom, createRoomWithCode, joinAsNewFriend, upgrade } from "./client.js";

describe("creating a Room", () => {
  it("returns a 5-character Room Code without 0/O/1/I and a secret host token", async () => {
    const a = await createRoom();
    const b = await createRoom();
    expect(a.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(a.hostToken.length).toBeGreaterThanOrEqual(32);
    expect(b.roomCode).not.toBe(a.roomCode);
    expect(b.hostToken).not.toBe(a.hostToken);
  });
});

describe("friends", () => {
  it("get a seat token in a welcome frame, and the Host hears they joined", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const { seatToken } = await joinAsNewFriend(roomCode);
    expect(seatToken.length).toBeGreaterThanOrEqual(8);
    expect(await host.next()).toEqual({ kind: "peerJoined", seatToken });
  });

  it("send frames that reach the Host stamped with their seat token", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    await host.next(); // peerJoined

    friend.socket.send({ payload: { t: "chat", text: "hi" } });
    expect(await host.next()).toEqual({ kind: "msg", from: friend.seatToken, payload: { t: "chat", text: "hi" } });
  });

  it("can't fake their own `from`", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const alice = await joinAsNewFriend(roomCode);
    const bob = await joinAsNewFriend(roomCode);
    await host.next();
    await host.next();

    bob.socket.send({ from: alice.seatToken, payload: { t: "chat", text: "I am Alice" } });
    const frame = await host.next();
    expect(frame.from).toBe(bob.seatToken);
  });

  it("reconnect with their seat token and get no new welcome", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const first = await joinAsNewFriend(roomCode);
    await host.next();
    first.socket.close();
    expect(await host.next()).toEqual({ kind: "peerLeft", seatToken: first.seatToken });

    const again = await connect(roomCode, { seatToken: first.seatToken });
    expect(await host.next()).toEqual({ kind: "peerJoined", seatToken: first.seatToken });
    again.send({ payload: 1 });
    expect(await host.next()).toEqual({ kind: "msg", from: first.seatToken, payload: 1 });
    expect(await again.drain(50)).toEqual([]);
  });
});

describe("the Host", () => {
  it("sends frames to one Seat that reach only that Seat", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const alice = await joinAsNewFriend(roomCode);
    const bob = await joinAsNewFriend(roomCode);

    host.send({ to: alice.seatToken, payload: { t: "error", message: "for Alice" } });
    expect(await alice.socket.next()).toEqual({ kind: "msg", payload: { t: "error", message: "for Alice" } });
    expect(await bob.socket.drain(100)).toEqual([]);
  });

  it("sends frames to all that reach every friend", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const alice = await joinAsNewFriend(roomCode);
    const bob = await joinAsNewFriend(roomCode);

    host.send({ to: "all", payload: { t: "hostAway" } });
    expect(await alice.socket.next()).toEqual({ kind: "msg", payload: { t: "hostAway" } });
    expect(await bob.socket.next()).toEqual({ kind: "msg", payload: { t: "hostAway" } });
  });

  it("hears about friends already connected when it connects", async () => {
    const { roomCode, hostToken } = await createRoom();
    const alice = await joinAsNewFriend(roomCode);
    const host = await connectHost(roomCode, hostToken);
    expect(await host.next()).toEqual({ kind: "peerJoined", seatToken: alice.seatToken });
  });

  it("can't be claimed without the right host token", async () => {
    const { roomCode, hostToken } = await createRoom();
    const other = await createRoom();
    expect((await upgrade(roomCode, { hostToken: "not-the-token" })).status).toBe(403);
    expect((await upgrade(roomCode, { hostToken: other.hostToken })).status).toBe(403);

    // A friend can't receive the Host's traffic either: their frames still go to the real Host.
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    await host.next();
    friend.socket.send({ to: "all", payload: "pretend Host" });
    expect(await host.next()).toEqual({ kind: "msg", from: friend.seatToken, payload: "pretend Host" });
    expect(await friend.socket.drain(100)).toEqual([]);
  });

  it("takes the role back after a refresh, and friends see hostAway then hostBack", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);

    host.close();
    expect(await friend.socket.next()).toEqual({ kind: "hostAway" });

    const refreshed = await connectHost(roomCode, hostToken);
    expect(await friend.socket.next()).toEqual({ kind: "hostBack" });
    expect(await refreshed.next()).toEqual({ kind: "peerJoined", seatToken: friend.seatToken });

    friend.socket.send({ payload: "still here" });
    expect(await refreshed.next()).toEqual({ kind: "msg", from: friend.seatToken, payload: "still here" });
  });

  it("replaces an older Host connection that hasn't closed yet", async () => {
    const { roomCode, hostToken } = await createRoom();
    const stale = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    await stale.next();

    const fresh = await connectHost(roomCode, hostToken);
    await fresh.next(); // peerJoined
    friend.socket.send({ payload: "hello" });
    expect(await fresh.next()).toEqual({ kind: "msg", from: friend.seatToken, payload: "hello" });
    expect((await stale.drain(100)).filter((f) => f.kind === "msg")).toEqual([]);
    // The friend never saw the Host leave.
    expect(await friend.socket.drain(100)).toEqual([]);
  });

  it("is reported away to friends who join while it is gone", async () => {
    const { roomCode } = await createRoom();
    const socket = await connect(roomCode);
    await socket.next(); // welcome
    expect(await socket.next()).toEqual({ kind: "hostAway" });
  });
});

describe("payloads", () => {
  it("are forwarded byte-for-byte in both directions", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    await host.next();

    // Odd spacing, key order, escapes, unicode and number formats a re-serialiser would change.
    const payload = '{ "z" :1.50, "a":[ 1e3 ,"\\u00e9\\"}" ,{"n":null} ], "emoji":"🃏" }';
    friend.socket.send(`{"from":"x","payload":${payload}  }`);
    expect(await host.nextRaw()).toBe(`{"kind":"msg","from":${JSON.stringify(friend.seatToken)},"payload":${payload}}`);

    host.send(`{ "payload" : ${payload}, "to":"all"}`);
    expect(await friend.socket.nextRaw()).toBe(`{"kind":"msg","payload":${payload}}`);
  });

  it("are dropped when the frame isn't a JSON object with a payload", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    await host.next();

    friend.socket.send("not json");
    friend.socket.send("[1,2]");
    friend.socket.send({ nope: 1 });
    friend.socket.send({ payload: "ok" });
    expect(await host.next()).toEqual({ kind: "msg", from: friend.seatToken, payload: "ok" });
  });
});

describe("unknown Rooms", () => {
  it("refuse connections", async () => {
    expect((await upgrade("ZZZZZ")).status).toBe(404);
    expect((await upgrade("bad")).status).toBe(404);
    expect((await upgrade("%E0")).status).toBe(404);
  });
});

describe("heartbeat ticks", () => {
  it("arrive at about 1 Hz while friends are connected, and stop when none are", async () => {
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    expect(await host.drain(1300)).toEqual([]); // no friends, no ticks

    const friend = await joinAsNewFriend(roomCode);
    const withFriend = await host.drain(3500);
    const ticks = withFriend.filter((f) => f.kind === "tick");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ticks[0]).toEqual({ kind: "tick" });

    friend.socket.close();
    await host.drain(1200); // peerLeft, and perhaps one tick already in flight
    expect(await host.drain(2200)).toEqual([]);
  }, 15_000);
});

describe("a Room whose Host is gone for 10 minutes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function roomAlarm(roomCode: string): Promise<void> {
    await runDurableObjectAlarm(env.ROOMS.get(env.ROOMS.idFromName(roomCode)));
  }

  it("stays open just before 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    host.close();
    expect(await friend.socket.next()).toEqual({ kind: "hostAway" });

    vi.setSystemTime(Date.parse("2026-01-01T12:09:59Z"));
    await roomAlarm(roomCode);
    expect(await friend.socket.drain(100)).toEqual([]);
    expect((await upgrade(roomCode, { hostToken })).status).toBe(101);
  });

  it("sends friends roomClosed and frees its Room Code", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    host.close();
    expect(await friend.socket.next()).toEqual({ kind: "hostAway" });

    vi.setSystemTime(Date.parse("2026-01-01T12:10:00Z"));
    await roomAlarm(roomCode);
    expect(await friend.socket.next()).toEqual({ kind: "roomClosed" });
    await vi.waitFor(() => expect(friend.socket.closed).toBe(true));

    // The Room is gone: its host token no longer works, and its code can be issued again.
    expect((await upgrade(roomCode, { hostToken })).status).toBe(404);
    expect((await upgrade(roomCode)).status).toBe(404);
    const reissued = await createRoomWithCode(roomCode);
    expect(reissued.roomCode).toBe(roomCode);
    expect(reissued.hostToken).not.toBe(hostToken);
  });

  it("is kept when the Host comes back in time", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
    const { roomCode, hostToken } = await createRoom();
    const host = await connectHost(roomCode, hostToken);
    const friend = await joinAsNewFriend(roomCode);
    host.close();
    await friend.socket.next(); // hostAway

    vi.setSystemTime(Date.parse("2026-01-01T12:09:00Z"));
    await connectHost(roomCode, hostToken);
    expect(await friend.socket.next()).toEqual({ kind: "hostBack" });

    vi.setSystemTime(Date.parse("2026-01-01T12:30:00Z"));
    await roomAlarm(roomCode);
    expect((await friend.socket.drain(100)).filter((f) => f.kind === "roomClosed")).toEqual([]);
  });

  it("applies to a Room whose Host never connected", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
    const { roomCode, hostToken } = await createRoom();
    vi.setSystemTime(Date.parse("2026-01-01T12:10:00Z"));
    await roomAlarm(roomCode);
    expect((await upgrade(roomCode, { hostToken })).status).toBe(404);
  });
});

describe("Room Codes", () => {
  it("are never handed out while in use", async () => {
    const taken = await createRoom();
    const next = await createRoomWithCode(taken.roomCode);
    expect(next.roomCode).not.toBe(taken.roomCode);
  });
});
