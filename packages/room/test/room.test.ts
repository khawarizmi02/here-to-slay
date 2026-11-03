import { RoomMsgSchema, type Action, type ClientMsg, type ConfigPatch, type RoomMsg } from "@here-to-slay/protocol";
import * as toy from "@here-to-slay/toy-engine";
import { describe, expect, it } from "vitest";
import { Room, type GameConnection, type RoomEngine, type RoomOptions } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test harness: everything goes through the GameConnection seam.
// ---------------------------------------------------------------------------

/** The toy engine behind the Room's engine interface. Config values must be positive integers. */
const toyEngine: RoomEngine<toy.GameState> = {
  createGame({ players, seed, config }) {
    const parsed: Partial<toy.ToyConfig> = {};
    for (const [key, value] of Object.entries(config)) {
      if (key !== "targetScore" && key !== "handSize") throw new Error(`Unknown config flag ${key}`);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`${key} must be a positive integer`);
      }
      parsed[key] = value;
    }
    return toy.createGame({ players, seed, config: parsed });
  },
  applyAction: toy.applyAction,
  getPlayerView: (state, player) => toy.getPlayerView(state, player) as unknown as Record<string, unknown>,
  getPlayerEvents: toy.getPlayerEvents,
};

/** A seeded stand-in for Math.random. */
function seededRandom(seed: string): () => number {
  let rng = toy.createRng(seed);
  return () => {
    let f: number;
    [f, rng] = toy.nextFloat(rng);
    return f;
  };
}

function makeRoom(overrides: Partial<RoomOptions<toy.GameState>> = {}): Room<toy.GameState> {
  return new Room({
    engine: toyEngine,
    clock: { now: () => 1_000 },
    random: seededRandom("room"),
    hostName: "Alice",
    ...overrides,
  });
}

/** A UI stand-in: records every message, checking each against the protocol schema. */
class Client {
  readonly inbox: RoomMsg[] = [];
  readonly unsubscribe: () => void;

  constructor(readonly conn: GameConnection) {
    this.unsubscribe = conn.onMessage((msg) => {
      expect(RoomMsgSchema.safeParse(msg).success, `invalid RoomMsg ${JSON.stringify(msg)}`).toBe(true);
      this.inbox.push(msg);
    });
  }

  send(msg: ClientMsg): void {
    this.conn.send(msg);
  }

  /** Sends something that is not a valid ClientMsg, as a buggy or malicious client could. */
  sendRaw(msg: unknown): void {
    this.conn.send(msg as ClientMsg);
  }

  take(): RoomMsg[] {
    return this.inbox.splice(0);
  }

  of<T extends RoomMsg["t"]>(t: T): Extract<RoomMsg, { t: T }>[] {
    return this.inbox.filter((m): m is Extract<RoomMsg, { t: T }> => m.t === t);
  }

  last<T extends RoomMsg["t"]>(t: T): Extract<RoomMsg, { t: T }> {
    const all = this.of(t);
    const msg = all[all.length - 1];
    if (!msg) throw new Error(`no ${t} message received`);
    return msg;
  }
}

type View = toy.PlayerView;
type Update = Extract<RoomMsg, { t: "update" }>;

function viewOf(update: Update): View {
  return update.view as unknown as View;
}

/** A Host with `extra` additional local Seats, all connected, still in the lobby. */
function hotSeat(extra: string[], overrides: Partial<RoomOptions<toy.GameState>> = {}) {
  const room = makeRoom(overrides);
  const host = new Client(room.hostConnection);
  for (const name of extra) host.send({ t: "addLocalSeat", name });
  const seats = host.last("lobby").seats;
  const hostSeat = host.last("lobby").you[0]!;
  const clients = new Map<string, Client>([[hostSeat, host]]);
  for (const seat of seats) {
    if (seat.id !== hostSeat) clients.set(seat.id, new Client(room.connectLocalSeat(seat.id)));
  }
  return { room, host, hostSeat, clients, seatIds: seats.map((s) => s.id) };
}

/**
 * Chooses the next move using only what each Seat can see in its own latest
 * view, the way a hot-seat UI would pick whose turn or prompt is showing.
 */
function nextMove(clients: Map<string, Client>): { seat: string; action: Action } | undefined {
  for (const [seat, client] of clients) {
    const view = viewOf(client.last("update"));
    if (view.phase === "gameOver") return undefined;
    const player = "ignored-by-room";
    if (view.phase === "action" && view.activePlayer === seat) {
      const playable = view.hand.find((c) => c.def !== "challenge");
      if (playable) return { seat, action: { type: "PLAY_HERO", player, card: playable.id } };
      return { seat, action: { type: "DRAW_CARD", player } };
    }
    if (view.phase === "responseWindow" && view.responseWindow?.awaiting.includes(seat)) {
      return { seat, action: { type: "PASS", player } };
    }
    if (view.phase === "decision" && view.pendingDecision && "id" in view.pendingDecision) {
      const decision = view.pendingDecision;
      return {
        seat,
        action: { type: "RESOLVE_DECISION", player, decisionId: decision.id, answer: { selected: [decision.options[0]!.id] } },
      };
    }
  }
  throw new Error("nobody can act, but the game is not over");
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

describe("lobby", () => {
  it("gives the Host a lobby with their own Seat and a readable Room Code", () => {
    const room = makeRoom();
    const host = new Client(room.hostConnection);
    const lobby = host.last("lobby");
    expect(lobby.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(lobby.seats).toEqual([{ id: lobby.you[0], name: "Alice", kind: "local", connected: true }]);
    expect(lobby.you).toHaveLength(1);
  });

  it("uses the Room Code it is given", () => {
    const host = new Client(makeRoom({ roomCode: "ABC23" }).hostConnection);
    expect(host.last("lobby").roomCode).toBe("ABC23");
  });

  it("derives the Room Code from the injected randomness", () => {
    const a = new Client(makeRoom({ random: seededRandom("x") }).hostConnection).last("lobby").roomCode;
    const b = new Client(makeRoom({ random: seededRandom("x") }).hostConnection).last("lobby").roomCode;
    const c = new Client(makeRoom({ random: seededRandom("y") }).hostConnection).last("lobby").roomCode;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("lets the Host add local Seats, and tells every connected Seat", () => {
    const { host, clients, seatIds, hostSeat } = hotSeat(["Bob"]);
    host.send({ t: "addLocalSeat", name: "Cleo" });
    const lobby = host.last("lobby");
    expect(lobby.seats.map((s) => [s.name, s.kind])).toEqual([
      ["Alice", "local"],
      ["Bob", "local"],
      ["Cleo", "local"],
    ]);
    expect(lobby.you).toEqual([hostSeat]);

    const bob = clients.get(seatIds[1]!)!;
    expect(bob.last("lobby").seats).toHaveLength(3);
    expect(bob.last("lobby").you).toEqual([seatIds[1]]);
  });

  it("marks a local Seat connected once its LocalConnection exists", () => {
    const room = makeRoom();
    const host = new Client(room.hostConnection);
    host.send({ t: "addLocalSeat", name: "Bob" });
    const bobSeat = host.last("lobby").seats[1]!;
    expect(bobSeat.connected).toBe(false);
    new Client(room.connectLocalSeat(bobSeat.id));
    expect(host.last("lobby").seats[1]!.connected).toBe(true);
  });

  it("delivers messages sent before the UI subscribed", () => {
    const room = makeRoom();
    const conn = room.hostConnection;
    const client = new Client(conn);
    expect(client.of("lobby")).toHaveLength(1);
  });

  it("refuses to hand out a connection for an unknown or already-connected Seat", () => {
    const { room, seatIds } = hotSeat(["Bob"]);
    expect(() => room.connectLocalSeat("nope")).toThrow();
    expect(() => room.connectLocalSeat(seatIds[1]!)).toThrow();
  });

  it("allows at most 6 Seats", () => {
    const { host } = hotSeat(["B", "C", "D", "E", "F"]);
    host.take();
    host.send({ t: "addLocalSeat", name: "G" });
    expect(host.take()).toEqual([{ t: "error", message: expect.any(String) }]);
  });

  it("rejects lobby commands from a Seat that is not the Host", () => {
    const { host, clients, seatIds } = hotSeat(["Bob"]);
    const bob = clients.get(seatIds[1]!)!;
    host.take();
    bob.take();
    bob.send({ t: "addLocalSeat", name: "Mallory" });
    bob.send({ t: "setConfig", config: { targetScore: 1 } });
    bob.send({ t: "startGame" });
    const replies = bob.take();
    expect(replies).toHaveLength(3);
    for (const reply of replies) expect(reply.t).toBe("error");
    // Nothing changed for anyone else.
    expect(host.take()).toEqual([]);
  });

  it("does not start with fewer than 2 Seats", () => {
    const host = new Client(makeRoom().hostConnection);
    host.take();
    host.send({ t: "startGame" });
    expect(host.take()).toEqual([{ t: "error", message: expect.any(String) }]);
  });

  it("applies the Host's config when the game starts", () => {
    const { host, clients } = hotSeat(["Bob"]);
    host.send({ t: "setConfig", config: { handSize: 5 } });
    host.send({ t: "setConfig", config: { targetScore: 9 } });
    host.send({ t: "startGame" });
    for (const client of clients.values()) {
      expect(viewOf(client.last("update")).hand).toHaveLength(5);
    }
  });

  it("stays in the lobby when the engine rejects the config", () => {
    const { host } = hotSeat(["Bob"]);
    host.send({ t: "setConfig", config: { handSize: "lots" } as ConfigPatch });
    host.take();
    host.send({ t: "startGame" });
    expect(host.take()).toEqual([{ t: "error", message: expect.stringContaining("handSize") }]);

    host.send({ t: "setConfig", config: { handSize: 2 } });
    host.send({ t: "startGame" });
    expect(host.last("update").version).toBe(1);
  });

  it("rejects setConfig, addLocalSeat and startGame once the game has started", () => {
    const { host } = hotSeat(["Bob"]);
    host.send({ t: "startGame" });
    host.take();
    host.send({ t: "setConfig", config: { targetScore: 1 } });
    host.send({ t: "addLocalSeat", name: "Late" });
    host.send({ t: "startGame" });
    const replies = host.take();
    expect(replies).toHaveLength(3);
    for (const reply of replies) expect(reply.t).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

describe("playing", () => {
  it("plays a hot-seat game with 3 local Seats from the lobby to game over", () => {
    const { host, clients, seatIds } = hotSeat(["Bob", "Cleo"]);
    host.send({ t: "startGame" });

    let expectedVersion = 1;
    for (const client of clients.values()) {
      const updates = client.of("update");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.version).toBe(1);
    }

    let clientSeq = 0;
    for (let step = 0; step < 500; step++) {
      const move = nextMove(clients);
      if (!move) break;
      for (const client of clients.values()) client.take();
      clients.get(move.seat)!.send({ t: "action", seat: move.seat, action: move.action, clientSeq: clientSeq++ });
      expectedVersion++;

      // Exactly one update per Seat, one version higher, filtered for that Seat.
      for (const [seat, client] of clients) {
        const msgs = client.take();
        expect(msgs, `seat ${seat} at step ${step}`).toHaveLength(1);
        const update = msgs[0] as Update;
        expect(update.t).toBe("update");
        expect(update.version).toBe(expectedVersion);
        expect(viewOf(update).me).toBe(seat);
        client.inbox.push(update);
      }
    }

    const final = seatIds.map((seat) => viewOf(clients.get(seat)!.last("update")));
    for (const view of final) {
      expect(view.phase).toBe("gameOver");
      expect(view.winner).toBe(final[0]!.winner);
    }
    expect(seatIds).toContain(final[0]!.winner);
  });

  it("filters events and views per Seat", () => {
    const { host, clients, seatIds } = hotSeat(["Bob"], {});
    host.send({ t: "startGame" });
    const [aliceSeat, bobSeat] = seatIds as [string, string];
    const alice = clients.get(aliceSeat)!;
    const bob = clients.get(bobSeat)!;

    // Alice's and Bob's views show only their own hands.
    const aliceView = viewOf(alice.last("update"));
    const bobView = viewOf(bob.last("update"));
    expect(aliceView.hand).toHaveLength(3);
    expect(bobView.hand).toHaveLength(3);
    const ids = new Set([...aliceView.hand, ...bobView.hand].map((c) => c.id));
    expect(ids.size).toBe(6);

    // The drawn card is shown only to the drawer.
    alice.send({ t: "action", seat: aliceSeat, action: { type: "DRAW_CARD", player: aliceSeat }, clientSeq: 1 });
    const aliceDraw = alice.last("update").events.find((e) => e.type === "CARD_DRAWN");
    const bobDraw = bob.last("update").events.find((e) => e.type === "CARD_DRAWN");
    expect(aliceDraw).toMatchObject({ player: aliceSeat, card: { id: expect.any(String) } });
    expect(bobDraw).toEqual({ type: "CARD_DRAWN", player: aliceSeat });
  });

  it("sends the Host's UI only the Host's view", () => {
    const { host, hostSeat } = hotSeat(["Bob", "Cleo"]);
    host.send({ t: "startGame" });
    const updates = host.of("update");
    expect(updates).toHaveLength(1);
    expect(viewOf(updates[0]!).me).toBe(hostSeat);
  });

  it("acts for the Seat the UI names, ignoring the action's player claim", () => {
    const { host, clients, hostSeat, seatIds } = hotSeat(["Bob"]);
    host.send({ t: "startGame" });
    host.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: seatIds[1]! }, clientSeq: 4 });
    const update = clients.get(seatIds[1]!)!.last("update");
    expect(update.version).toBe(2);
    expect(update.events).toContainEqual({ type: "CARD_DRAWN", player: hostSeat });
  });

  it("rejects an action for a Seat the connection does not own", () => {
    const { host, clients, seatIds } = hotSeat(["Bob"]);
    host.send({ t: "startGame" });
    const bob = clients.get(seatIds[1]!)!;
    host.take();
    bob.take();
    // It is Alice's turn, but Bob's connection tries to act as Alice.
    bob.send({ t: "action", seat: seatIds[0]!, action: { type: "DRAW_CARD", player: seatIds[0]! }, clientSeq: 7 });
    expect(bob.take()).toEqual([{ t: "actionRejected", clientSeq: 7, error: expect.any(String) }]);
    expect(host.take()).toEqual([]);
  });

  it("rejects an illegal action without changing the version", () => {
    const { host, clients, seatIds } = hotSeat(["Bob"]);
    host.send({ t: "startGame" });
    const bob = clients.get(seatIds[1]!)!;
    host.take();
    bob.take();
    bob.send({ t: "action", seat: seatIds[1]!, action: { type: "DRAW_CARD", player: seatIds[1]! }, clientSeq: 3 });
    expect(bob.take()).toEqual([{ t: "actionRejected", clientSeq: 3, error: "It is not your turn" }]);
    expect(host.take()).toEqual([]);

    // The next legal action is version 2: the rejection did not bump it.
    host.send({ t: "action", seat: seatIds[0]!, action: { type: "DRAW_CARD", player: seatIds[0]! }, clientSeq: 0 });
    expect(host.last("update").version).toBe(2);
  });

  it("rejects an action before the game has started", () => {
    const { host, hostSeat } = hotSeat(["Bob"]);
    host.take();
    host.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 0 });
    expect(host.take()).toEqual([{ t: "actionRejected", clientSeq: 0, error: expect.any(String) }]);
  });

  it("rejects malformed messages without changing the game", () => {
    const { host, clients, hostSeat } = hotSeat(["Bob"]);
    host.send({ t: "startGame" });
    for (const client of clients.values()) client.take();

    host.sendRaw({ t: "action", seat: hostSeat, action: { type: "TELEPORT", player: hostSeat }, clientSeq: 11 });
    host.sendRaw({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 12, extra: 1 });
    expect(host.take()).toEqual([
      { t: "actionRejected", clientSeq: 11, error: expect.any(String) },
      { t: "actionRejected", clientSeq: 12, error: expect.any(String) },
    ]);

    // No usable clientSeq: a plain error instead.
    for (const garbage of [null, 42, "hi", {}, { t: "nope" }, { t: "action", clientSeq: -1 }]) {
      host.sendRaw(garbage);
      expect(host.take()).toEqual([{ t: "error", message: expect.any(String) }]);
    }

    for (const client of clients.values()) expect(client.take()).toEqual([]);
    host.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 13 });
    expect(host.last("update").version).toBe(2);
  });

  it("answers resync with the current lobby or update, without a new version", () => {
    const { host } = hotSeat(["Bob"]);
    host.take();
    host.send({ t: "resync" });
    expect(host.take().map((m) => m.t)).toEqual(["lobby"]);

    host.send({ t: "startGame" });
    const started = host.last("update");
    host.take();
    host.send({ t: "resync" });
    expect(host.take()).toEqual([{ ...started, events: [] }]);
  });

  it("brings a Seat connected after the start up to date", () => {
    const room = makeRoom();
    const host = new Client(room.hostConnection);
    host.send({ t: "addLocalSeat", name: "Bob" });
    const bobSeat = host.last("lobby").seats[1]!.id;
    host.send({ t: "startGame" });
    const bob = new Client(room.connectLocalSeat(bobSeat));
    const update = bob.last("update");
    expect(update.version).toBe(1);
    expect(viewOf(update).me).toBe(bobSeat);
  });

  it("does not let a UI change the Room's state by mutating a received message", () => {
    const { host, clients, seatIds } = hotSeat(["Bob"]);
    host.send({ t: "startGame" });
    viewOf(host.last("update")).hand.length = 0;
    host.send({ t: "resync" });
    expect(viewOf(host.last("update")).hand).toHaveLength(3);
    expect(viewOf(clients.get(seatIds[1]!)!.last("update")).hand).toHaveLength(3);
  });

  it("handles a message a UI sends from inside its update handler after the current one", () => {
    const { host, clients, hostSeat, seatIds } = hotSeat(["Bob"]);
    const bob = clients.get(seatIds[1]!)!;
    const versionsSeenByBob: number[] = [];
    let sent = false;
    host.conn.onMessage((msg) => {
      if (msg.t === "update" && msg.version === 1 && !sent) {
        sent = true;
        host.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 0 });
      }
    });
    bob.conn.onMessage((msg) => {
      if (msg.t === "update") versionsSeenByBob.push(msg.version);
    });
    host.send({ t: "startGame" });
    expect(versionsSeenByBob).toEqual([1, 2]);
  });
});

describe("failures", () => {
  it("still updates every other Seat when one UI's listener throws, then reports the error", () => {
    const { host, clients, hostSeat, seatIds } = hotSeat(["Bob", "Cleo"]);
    host.send({ t: "startGame" });
    const bob = clients.get(seatIds[1]!)!;
    const cleo = clients.get(seatIds[2]!)!;
    const stopThrowing = bob.conn.onMessage(() => {
      throw new Error("Bob's UI broke");
    });
    expect(() =>
      host.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 0 }),
    ).toThrow("Bob's UI broke");
    expect(cleo.last("update").version).toBe(2);
    expect(bob.last("update").version).toBe(2);

    // The Room keeps working.
    stopThrowing();
    bob.take();
    bob.conn.send({ t: "resync" });
    expect(bob.take()).toEqual([expect.objectContaining({ t: "update", version: 2 })]);
  });

  it("leaves the game unchanged when the engine throws while building views", () => {
    let explode = false;
    const engine: RoomEngine<toy.GameState> = {
      ...toyEngine,
      getPlayerView: (state, player) => {
        if (explode) throw new Error("view bug");
        return toyEngine.getPlayerView(state, player);
      },
    };
    const { host, clients, hostSeat } = hotSeat(["Bob"], { engine });
    host.send({ t: "startGame" });
    for (const client of clients.values()) client.take();

    explode = true;
    host.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 5 });
    expect(host.take()).toEqual([{ t: "actionRejected", clientSeq: 5, error: expect.stringContaining("view bug") }]);
    for (const client of clients.values()) expect(client.take()).toEqual([]);

    explode = false;
    host.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 6 });
    expect(host.last("update").version).toBe(2);
  });

  it("answers a message JSON can't carry with an error", () => {
    const host = new Client(makeRoom().hostConnection);
    host.take();
    host.sendRaw({ t: "action", clientSeq: 1n });
    expect(host.take()).toEqual([{ t: "error", message: expect.any(String) }]);
  });
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe("LocalConnection", () => {
  it("gives the Host a fresh connection after the old one was closed", () => {
    const room = makeRoom();
    const first = new Client(room.hostConnection);
    const hostSeat = first.last("lobby").you[0]!;
    expect(room.hostConnection).toBe(first.conn);
    first.conn.close();
    const second = new Client(room.hostConnection);
    expect(second.conn).not.toBe(first.conn);
    expect(second.last("lobby").you).toEqual([hostSeat]);
    second.send({ t: "addLocalSeat", name: "Bob" });
    expect(second.last("lobby").seats).toHaveLength(2);
  });

  it("stops delivering after unsubscribe", () => {
    const { host, clients, seatIds } = hotSeat(["Bob"]);
    const bob = clients.get(seatIds[1]!)!;
    bob.unsubscribe();
    bob.take();
    host.send({ t: "startGame" });
    expect(bob.take()).toEqual([]);
  });

  it("frees the Seat on close, so it can be connected again", () => {
    const { room, host, clients, seatIds } = hotSeat(["Bob"]);
    const bob = clients.get(seatIds[1]!)!;
    bob.conn.close();
    expect(host.last("lobby").seats[1]!.connected).toBe(false);
    bob.take();
    bob.conn.send({ t: "resync" });
    expect(bob.take()).toEqual([]);

    const again = new Client(room.connectLocalSeat(seatIds[1]!));
    expect(again.last("lobby").you).toEqual([seatIds[1]]);
  });
});
