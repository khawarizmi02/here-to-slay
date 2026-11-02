import type { ClientMsg, RoomMsg, SeatId } from "@here-to-slay/protocol";
import type { PlayerView } from "@here-to-slay/toy-engine";
import { describe, expect, it } from "vitest";
import type { GameConnection } from "../src/index.js";
import { chooseAction, makeRoom, Recorder } from "./support.js";

/** A Room with the Host (s1) and `extra` more local Seats, each with its own connection, in the lobby. */
function hotSeat(extra = 1, opts: Parameters<typeof makeRoom>[0] = {}) {
  const room = makeRoom(opts);
  const host = new Recorder(room.connectHost());
  const names = ["Bob", "Cleo", "Dan", "Eve", "Finn"];
  for (let i = 0; i < extra; i++) host.conn.send({ t: "addLocalSeat", name: names[i]! });
  const seats: Record<SeatId, Recorder> = { s1: host };
  for (let i = 0; i < extra; i++) {
    const id = `s${i + 2}`;
    seats[id] = new Recorder(room.connectLocalSeat(id));
  }
  return { room, host, seats };
}

function started(extra = 1, opts: Parameters<typeof makeRoom>[0] = {}) {
  const t = hotSeat(extra, opts);
  t.host.conn.send({ t: "startGame" });
  return t;
}

/** Sends `msg` and returns what each recorder received because of it. */
function exchange(conn: GameConnection, msg: ClientMsg, recorders: Recorder[]): RoomMsg[][] {
  for (const r of recorders) r.clear();
  conn.send(msg);
  return recorders.map((r) => [...r.messages]);
}

describe("hot-seat game through LocalConnection", () => {
  it.each([2, 3, 4])("plays a %i-Seat game from the lobby to game over", (count) => {
    const { host, seats } = started(count - 1);
    const all = Object.values(seats);
    const seatIds = Object.keys(seats);

    for (const [id, r] of Object.entries(seats)) {
      expect(r.updates).toHaveLength(1);
      expect(r.lastUpdate).toMatchObject({ version: 1, events: [] });
      expect(r.view.me).toBe(id);
    }

    let clientSeq = 0;
    let version = 1;
    for (let step = 0; step < 500 && host.view.phase !== "gameOver"; step++) {
      // Each player decides from their own view only.
      const next = seatIds.map((id) => ({ id, action: chooseAction(seats[id]!.view, id) })).find((x) => x.action);
      expect(next, "someone must be able to act").toBeDefined();
      const { id, action } = next!;
      // The Host's UI acts for the Host and for every other local Seat on
      // odd turns; the other Seats' own connections act on even turns.
      const conn = id === "s1" || step % 2 === 1 ? host.conn : seats[id]!.conn;

      const received = exchange(conn, { t: "action", seat: id, action: action!, clientSeq: clientSeq++ }, all);
      version += 1;
      for (const [i, msgs] of received.entries()) {
        // Exactly one update per Seat per change, and nothing else.
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toMatchObject({ t: "update", version });
        expect((msgs[0] as Extract<RoomMsg, { t: "update" }>).view.me).toBe(seatIds[i]);
      }
    }

    expect(host.view.phase).toBe("gameOver");
    const winner = host.view.winner;
    expect(seatIds).toContain(winner);
    for (const r of all) expect(r.view.winner).toBe(winner);
  });

  it("a hot-seat UI can play every local Seat through the Host's connection", () => {
    const { host, seats } = started(1);
    let seq = 0;
    for (let step = 0; step < 500 && host.view.phase !== "gameOver"; step++) {
      const id = ["s1", "s2"].find((s) => chooseAction(seats[s]!.view, s))!;
      host.conn.send({ t: "action", seat: id, action: chooseAction(seats[id]!.view, id)!, clientSeq: seq++ });
    }
    expect(host.view.phase).toBe("gameOver");
    expect(host.of("actionRejected")).toEqual([]);
    expect(host.updates.map((u) => u.version)).toEqual(Array.from({ length: seq + 1 }, (_, i) => i + 1));
  });
});

describe("updates", () => {
  it("each Seat's view and events are filtered for that Seat", () => {
    const { host, seats } = started(1);
    const bob = seats.s2!;
    host.conn.send({ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 0 });

    const hostDraw = host.lastUpdate!.events.find((e) => e.type === "CARD_DRAWN");
    const bobDraw = bob.lastUpdate!.events.find((e) => e.type === "CARD_DRAWN");
    expect(hostDraw).toMatchObject({ player: "s1", card: { id: expect.any(String) } });
    expect(bobDraw).toEqual({ type: "CARD_DRAWN", player: "s1" });

    // Views show only the recipient's hand.
    const drawnId = (hostDraw as unknown as { card: { id: string } }).card.id;
    const hostView = host.view;
    const bobView = bob.view;
    expect(hostView.me).toBe("s1");
    expect(bobView.me).toBe("s2");
    expect(hostView.hand.map((c) => c.id)).toContain(drawnId);
    expect(bobView.hand.map((c) => c.id)).not.toContain(drawnId);
    expect(hostView.players.find((p) => p.id === "s2")!.handCount).toBe(bobView.hand.length);
  });

  it("the Host's own UI receives only the Host's view", () => {
    const { host } = started(2);
    host.conn.send({ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 0 });
    expect(host.updates).toHaveLength(2);
    for (const u of host.updates) expect((u.view as unknown as PlayerView).me).toBe("s1");
  });

  it("a listener that acts from inside its callback doesn't reorder anyone's updates", () => {
    const { host, seats } = started(2);
    // Every Seat answers as soon as an update asks something of it.
    let seq = 100;
    for (const [id, r] of Object.entries(seats)) {
      r.conn.onMessage((msg) => {
        if (msg.t !== "update") return;
        const action = chooseAction(msg.view as unknown as PlayerView, id);
        if (action) r.conn.send({ t: "action", seat: id, action, clientSeq: seq++ });
      });
    }
    // Kick it off: the Host's first move drives the whole game.
    host.conn.send({ t: "action", seat: "s1", action: chooseAction(host.view, "s1")!, clientSeq: 0 });

    expect(host.view.phase).toBe("gameOver");
    const versions = host.updates.map((u) => u.version);
    for (const r of Object.values(seats)) {
      expect(r.updates.map((u) => u.version)).toEqual(versions);
    }
    // Some answers go stale (another Seat's queued action got there first);
    // those are rejected without a version bump, as checked above.
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
  });

  it("resync sends the lobby and the current view without bumping the version", () => {
    const { host, seats } = started(1);
    host.conn.send({ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 0 });
    const bob = seats.s2!;
    const before = bob.lastUpdate!;

    const [msgs] = exchange(bob.conn, { t: "resync" }, [bob]);
    expect(msgs!.map((m) => m.t)).toEqual(["lobby", "update"]);
    expect(msgs![1]).toEqual({ ...before, events: [] });
  });

  it("a closed connection receives nothing and can't send", () => {
    const { host, seats } = started(1);
    const bob = seats.s2!;
    bob.conn.close();
    host.conn.send({ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 0 });
    expect(bob.updates).toHaveLength(1);
    expect(host.updates).toHaveLength(2);
    expect(() => bob.conn.send({ t: "resync" })).toThrow();
  });

  it("an unsubscribed listener stops receiving", () => {
    const room = makeRoom();
    const conn = room.connectHost();
    const got: RoomMsg[] = [];
    const off = conn.onMessage((m) => got.push(m));
    conn.send({ t: "resync" });
    off();
    conn.send({ t: "resync" });
    expect(got).toHaveLength(1);
  });
});

describe("lobby", () => {
  it("adding a local Seat sends every connection the lobby, with the Seats it owns", () => {
    const { host, seats } = hotSeat(2);
    expect(host.lastLobby).toEqual({
      t: "lobby",
      roomCode: "ABC23",
      seats: [
        { id: "s1", name: "Alice", kind: "local", connected: true },
        { id: "s2", name: "Bob", kind: "local", connected: true },
        { id: "s3", name: "Cleo", kind: "local", connected: true },
      ],
      you: ["s1", "s2", "s3"],
    });

    seats.s2!.conn.send({ t: "resync" });
    expect(seats.s2!.lastLobby!.you).toEqual(["s2"]);
    expect(seats.s2!.lastLobby!.seats).toHaveLength(3);
  });

  it("setConfig in the lobby changes the game's rules", () => {
    const { host } = hotSeat(1);
    host.conn.send({ t: "setConfig", config: { handSize: 2 } });
    host.conn.send({ t: "startGame" });
    expect(host.of("error")).toEqual([]);
    expect(host.view.hand).toHaveLength(2);
  });

  it("the Room's starting config is used, and setConfig overrides it", () => {
    const { host } = hotSeat(1, { config: { handSize: 1, targetScore: 9 } });
    host.conn.send({ t: "setConfig", config: { handSize: 4 } });
    host.conn.send({ t: "startGame" });
    expect(host.view.hand).toHaveLength(4);
  });

  it("can't start with fewer than two Seats", () => {
    const { host } = hotSeat(0);
    host.conn.send({ t: "startGame" });
    expect(host.of("error")).toHaveLength(1);
    expect(host.updates).toEqual([]);
  });

  it("refuses a seventh Seat", () => {
    const { host } = hotSeat(5);
    host.clear();
    host.conn.send({ t: "addLocalSeat", name: "Gus" });
    expect(host.messages.map((m) => m.t)).toEqual(["error"]);
  });

  it("a local connection can't join again", () => {
    const { seats } = hotSeat(1);
    const [msgs] = exchange(seats.s2!.conn, { t: "joinRoom", name: "Bob" }, [seats.s2!]);
    expect(msgs!.map((m) => m.t)).toEqual(["error"]);
  });

  it("only connects other local Seats with connectLocalSeat", () => {
    const { room } = hotSeat(1);
    expect(() => room.connectLocalSeat("s1")).toThrow();
    expect(() => room.connectLocalSeat("s9")).toThrow();
  });
});

describe("Host-only and lobby-only commands", () => {
  const lobbyCommands: ClientMsg[] = [
    { t: "addLocalSeat", name: "Mallory" },
    { t: "addBot", difficulty: "easy" },
    { t: "setConfig", config: { handSize: 6 } },
    { t: "startGame" },
  ];

  it.each(lobbyCommands)("a non-Host connection can't use $t", (msg) => {
    const { host, seats } = hotSeat(1);
    const bob = seats.s2!;
    const [hostMsgs, bobMsgs] = exchange(bob.conn, msg, [host, bob]);
    expect(hostMsgs).toEqual([]);
    expect(bobMsgs).toEqual([{ t: "error", message: `Only the Host can use ${msg.t}` }]);

    // Nothing changed: the lobby still has two Seats and the default config.
    host.conn.send({ t: "startGame" });
    expect(host.lastUpdate!.version).toBe(1);
    expect(host.view.players).toHaveLength(2);
    expect(host.view.hand).toHaveLength(3);
  });

  it.each(lobbyCommands)("the Host can't use $t after the game has started", (msg) => {
    const { host, seats } = started(1);
    const before = host.view;
    const [hostMsgs, bobMsgs] = exchange(host.conn, msg, [host, seats.s2!]);
    expect(hostMsgs).toEqual([{ t: "error", message: `${msg.t} is only allowed in the lobby` }]);
    expect(bobMsgs).toEqual([]);

    host.conn.send({ t: "resync" });
    expect(host.lastUpdate!.version).toBe(1);
    expect(host.view).toEqual(before);
  });
});

describe("rejected actions", () => {
  /** Checks the version is still `version` without changing it. */
  function expectVersion(r: Recorder, version: number) {
    r.conn.send({ t: "resync" });
    expect(r.lastUpdate!.version).toBe(version);
  }

  it("an illegal action is rejected with its clientSeq and changes nothing", () => {
    const { host, seats } = started(1);
    const bob = seats.s2!;
    // It's the Host's turn, not Bob's.
    const [hostMsgs, bobMsgs] = exchange(bob.conn, { t: "action", seat: "s2", action: { type: "DRAW_CARD", player: "s2" }, clientSeq: 7 }, [host, bob]);
    expect(hostMsgs).toEqual([]);
    expect(bobMsgs).toEqual([{ t: "actionRejected", clientSeq: 7, error: "It is not your turn" }]);
    expectVersion(host, 1);

    // The next legal action is version 2.
    host.conn.send({ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 0 });
    expect(bob.lastUpdate!.version).toBe(2);
  });

  it("an action before the game starts is rejected", () => {
    const { host } = hotSeat(1);
    host.conn.send({ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 3 });
    expect(host.of("actionRejected")).toEqual([{ t: "actionRejected", clientSeq: 3, error: "The game has not started" }]);
  });

  it("a connection can't act for a Seat it doesn't own", () => {
    const { host, seats } = started(2);
    const bob = seats.s2!;
    const [msgs] = exchange(bob.conn, { t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 4 }, [bob]);
    expect(msgs).toEqual([{ t: "actionRejected", clientSeq: 4, error: "This connection can't act for Seat s1" }]);

    const [hostMsgs] = exchange(host.conn, { t: "action", seat: "s9", action: { type: "DRAW_CARD", player: "s9" }, clientSeq: 5 }, [host]);
    expect(hostMsgs).toEqual([{ t: "actionRejected", clientSeq: 5, error: "This connection can't act for Seat s9" }]);
    expectVersion(host, 1);
  });

  it("the acting player comes from the Seat, not from the action", () => {
    const { host, seats } = started(1);
    const bob = seats.s2!;
    // Bob owns s2 but claims to be s1, whose turn it is.
    const [msgs] = exchange(bob.conn, { t: "action", seat: "s2", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 1 }, [bob]);
    expect(msgs).toEqual([{ t: "actionRejected", clientSeq: 1, error: "It is not your turn" }]);
    expectVersion(host, 1);

    // The Host names its Seat but a wrong player; the Seat wins.
    host.conn.send({ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s2" }, clientSeq: 2 });
    expect(host.lastUpdate!.version).toBe(2);
    expect(host.lastUpdate!.events[0]).toMatchObject({ type: "CARD_DRAWN", player: "s1" });
  });

  it("a malformed action is rejected with its clientSeq", () => {
    const { host } = started(1);
    const bad = [
      { t: "action", seat: "s1", action: { type: "TELEPORT", player: "s1" }, clientSeq: 11 },
      { t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1", extra: true }, clientSeq: 12 },
      { t: "action", seat: "", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 13 },
    ];
    for (const msg of bad) host.conn.send(msg as unknown as ClientMsg);
    expect(host.of("actionRejected").map((m) => m.clientSeq)).toEqual([11, 12, 13]);
    for (const m of host.of("actionRejected")) expect(m.error).toMatch(/^Malformed message/);
    expectVersion(host, 1);
  });

  it("other malformed messages get an error", () => {
    const { host } = started(1);
    const bad: unknown[] = [
      null,
      "startGame",
      42,
      { t: "nope" },
      { t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: -1 },
      { t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" } },
      { t: "addLocalSeat", name: "" },
      { t: "startGame", now: true },
    ];
    host.clear();
    for (const msg of bad) host.conn.send(msg as ClientMsg);
    const errors = host.messages;
    expect(errors.map((m) => m.t)).toEqual(bad.map(() => "error"));
    expectVersion(host, 1);
  });
});
