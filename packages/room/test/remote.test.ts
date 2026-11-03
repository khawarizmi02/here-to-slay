import type { ClientMsg } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { JoinError, MemoryActionLogStore, RelayConnection, Room, relaySocket, type WebSocketLike } from "../src/index.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, makeRoom, nextMove, toyEngine, viewOf, type Update } from "./harness.js";

/** A Host whose Room is attached to a fake relay, still in the lobby. */
function hostedRoom(overrides: Parameters<typeof makeRoom>[0] = {}) {
  const relay = new FakeRelay();
  const { roomCode, hostToken } = relay.createRoom();
  const room = makeRoom({ roomCode, ...overrides });
  room.attachRelay(relay.connectHost(roomCode, hostToken));
  const host = new Client(room.hostConnection);
  return { relay, room, roomCode, host, hostSeat: host.last("lobby").you[0]! };
}

async function join(relay: FakeRelay, roomCode: string, name: string) {
  const connection = await RelayConnection.join({ dialer: relay.dialer, roomCode, name });
  const client = new Client(connection);
  await settle();
  return { connection, client, seat: client.last("lobby").you[0]! };
}

describe("joining over the relay", () => {
  it("seats a friend who joins with the Room Code and a name, and every Seat sees them in the lobby", async () => {
    const { relay, roomCode, host } = hostedRoom();
    const bob = await join(relay, roomCode, "Bob");

    const lobby = bob.client.last("lobby");
    expect(lobby.roomCode).toBe(roomCode);
    expect(lobby.seats.map((s) => [s.name, s.kind, s.connected])).toEqual([
      ["Alice", "local", true],
      ["Bob", "remote", true],
    ]);
    expect(lobby.you).toEqual([lobby.seats[1]!.id]);
    expect(host.last("lobby").seats.map((s) => s.name)).toEqual(["Alice", "Bob"]);
    expect(bob.connection.seatToken).toMatch(/^seat-token-/);
  });

  it("seats several friends, each knowing only their own Seat", async () => {
    const { relay, roomCode, host } = hostedRoom();
    const bob = await join(relay, roomCode, "Bob");
    const cara = await join(relay, roomCode, "Cara");
    await settle();

    expect(bob.seat).not.toBe(cara.seat);
    expect(bob.client.last("lobby").seats.map((s) => s.name)).toEqual(["Alice", "Bob", "Cara"]);
    expect(cara.client.last("lobby").you).toEqual([cara.seat]);
    expect(host.last("lobby").seats.map((s) => s.kind)).toEqual(["local", "remote", "remote"]);
  });

  it("frees the Seat of a friend who leaves the lobby, and seats them again when they come back", async () => {
    const { relay, roomCode, host } = hostedRoom();
    const bob = await join(relay, roomCode, "Bob");
    bob.connection.close();
    await settle();
    expect(host.last("lobby").seats.map((s) => s.name)).toEqual(["Alice"]);

    const again = await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob", seatToken: bob.connection.seatToken });
    const client = new Client(again);
    await settle();
    expect(host.last("lobby").seats.map((s) => [s.name, s.connected])).toEqual([
      ["Alice", true],
      ["Bob", true],
    ]);
    expect(client.last("lobby").you).toEqual([host.last("lobby").seats[1]!.id]);
  });

  it("refuses an unknown Room Code with a clear error", async () => {
    const relay = new FakeRelay();
    const joining = RelayConnection.join({ dialer: relay.dialer, roomCode: "ZZZZZ", name: "Bob" });
    await expect(joining).rejects.toThrow(JoinError);
    await expect(joining).rejects.toThrow("There is no Room ZZZZZ. It may have closed; ask the Host for a new Room Code.");
  });

  it("refuses the code of a Room that has closed", async () => {
    const { relay, roomCode } = hostedRoom();
    relay.closeRoom(roomCode);
    await expect(RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob" })).rejects.toThrow(`There is no Room ${roomCode}`);
  });

  it("refuses something that isn't a Room Code without dialing, and accepts a code typed in lower case", async () => {
    const { relay, roomCode } = hostedRoom();
    await expect(RelayConnection.join({ dialer: relay.dialer, roomCode: "AB0", name: "Bob" })).rejects.toThrow('"AB0" is not a Room Code');
    const bob = await RelayConnection.join({ dialer: relay.dialer, roomCode: ` ${roomCode.toLowerCase()} `, name: "Bob" });
    expect(bob.roomCode).toBe(roomCode);
  });

  it("tells a friend in the Room when it closes", async () => {
    const { relay, roomCode } = hostedRoom();
    const bob = await join(relay, roomCode, "Bob");
    relay.closeRoom(roomCode);
    await settle();
    expect(bob.client.last("error").message).toBe(`Room ${roomCode} has closed: the Host was away too long`);
    expect(bob.connection.closed).toBe(true);
  });

  it("tells friends when the Host is away", async () => {
    const { relay, roomCode } = hostedRoom();
    const bob = await join(relay, roomCode, "Bob");
    relay.dropHost(roomCode);
    await settle();
    expect(bob.client.of("hostAway")).toHaveLength(1);
  });

  it("refuses to seat a friend once the game has started, or when the Room is full", async () => {
    const started = hostedRoom();
    started.host.send({ t: "addBot", difficulty: "easy" });
    started.host.send({ t: "startGame" });
    const late = await RelayConnection.join({ dialer: started.relay.dialer, roomCode: started.roomCode, name: "Late" });
    const lateClient = new Client(late);
    await settle();
    expect(lateClient.last("error").message).toBe("The game has already started");
    expect(viewOf(started.host.last("update")).players).toHaveLength(2);

    const full = hostedRoom();
    for (let i = 0; i < 5; i++) full.host.send({ t: "addBot", difficulty: "easy" });
    const extra = new Client(await RelayConnection.join({ dialer: full.relay.dialer, roomCode: full.roomCode, name: "Extra" }));
    await settle();
    expect(extra.last("error").message).toBe("The Room is full: it has at most 6 Seats");
    expect(full.host.last("lobby").seats).toHaveLength(6);
  });

  it("answers a seat token without a Seat that sends anything but joinRoom", async () => {
    const { relay, roomCode, host } = hostedRoom();
    const socket = await relay.dialer.dial(roomCode, "seat-token-stranger");
    if ("refused" in socket) throw new Error("refused");
    const received: string[] = [];
    socket.onMessage((data) => received.push(data));
    socket.send(JSON.stringify({ payload: { t: "startGame" } }));
    socket.send(JSON.stringify({ payload: { t: "action", seat: "s1", clientSeq: 4, action: { type: "DRAW_CARD", player: "s1" } } }));
    await settle();

    expect(received.map((r) => JSON.parse(r).payload)).toEqual([
      { t: "error", message: "Join the Room first" },
      { t: "actionRejected", clientSeq: 4, error: "Join the Room first" },
    ]);
    expect(host.of("update")).toHaveLength(0);
  });
});

/** A Room with a Host, a second local Seat, a bot and two friends, still in the lobby. */
async function mixedRoom(overrides: Parameters<typeof makeRoom>[0] = {}) {
  const hosted = hostedRoom(overrides);
  const { relay, room, roomCode, host, hostSeat } = hosted;
  host.send({ t: "addLocalSeat", name: "Dee" });
  host.send({ t: "addBot", difficulty: "easy" });
  const bob = await join(relay, roomCode, "Bob");
  const cara = await join(relay, roomCode, "Cara");
  const dee = host.last("lobby").seats.find((s) => s.name === "Dee")!.id;
  const clients = new Map<string, Client>([
    [hostSeat, host],
    [dee, new Client(room.connectLocalSeat(dee))],
    [bob.seat, bob.client],
    [cara.seat, cara.client],
  ]);
  return { ...hosted, bob, cara, clients };
}

/** Plays until game over, each human Seat choosing from its own latest view, like a UI would. */
async function playToGameOver(clients: Map<string, Client>): Promise<void> {
  for (let clientSeq = 0; ; clientSeq++) {
    await settle();
    const move = nextMove(clients);
    if (!move) return;
    clients.get(move.seat)!.send({ t: "action", seat: move.seat, action: move.action, clientSeq });
    if (clientSeq > 500) throw new Error("the game did not end");
  }
}

describe("playing with remote Seats", () => {
  it("plays a toy game with local, bot and remote Seats from the lobby to game over", async () => {
    const store = new MemoryActionLogStore();
    const { room, roomCode, host, clients, bob } = await mixedRoom({ store });
    host.send({ t: "startGame" });
    await playToGameOver(clients);

    const final = viewOf(host.last("update"));
    expect(final.phase).toBe("gameOver");
    expect(final.players.map((p) => p.name)).toEqual(["Alice", "Dee", "Bot 1", "Bob", "Cara"]);
    for (const client of clients.values()) {
      expect(client.of("actionRejected")).toEqual([]);
      expect(client.last("update").version).toBe(host.last("update").version);
      expect(viewOf(client.last("update")).winner).toBe(final.winner);
    }
    expect(viewOf(bob.client.last("update")).me).toBe(bob.seat);

    // The saved record holds the remote Seats and replays to the same game.
    await room.whenSaved();
    const record = (await store.load(roomCode))!;
    expect(record.seats.filter((s) => s.kind === "remote").map((s) => s.name)).toEqual(["Bob", "Cara"]);
    const restored = Room.restore({ engine: toyEngine, clock: { now: () => 0 }, random: () => 0 }, record);
    expect(new Client(restored.hostConnection).last("update").view).toEqual(host.last("update").view);

    // The downloadable replay leaves out the friends' seat tokens, and still replays.
    const replay = room.replayFile()!.contents;
    expect(replay).not.toContain(bob.connection.seatToken);
    const fromFile = Room.restore({ engine: toyEngine, clock: { now: () => 0 }, random: () => 0 }, JSON.parse(replay));
    expect(new Client(fromFile.hostConnection).last("update").view).toEqual(host.last("update").view);
  });

  it("acts for the friend's own Seat, whatever player the action claims", async () => {
    const { host, clients, bob, hostSeat } = await mixedRoom();
    host.send({ t: "startGame" });
    await settle();
    // Play until it is Bob's turn.
    for (let clientSeq = 0; viewOf(bob.client.last("update")).activePlayer !== bob.seat || viewOf(bob.client.last("update")).phase !== "action"; clientSeq++) {
      const move = nextMove(clients)!;
      clients.get(move.seat)!.send({ t: "action", seat: move.seat, action: move.action, clientSeq });
      await settle();
    }
    bob.client.send({ t: "action", seat: bob.seat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 99 });
    await settle();
    const drawn = bob.client.last("update").events.find((e) => e.type === "CARD_DRAWN");
    expect(drawn).toMatchObject({ player: bob.seat });
    expect(bob.client.of("actionRejected")).toEqual([]);
  });
});

describe("identity", () => {
  it("rejects a friend's action for another Seat and changes nothing", async () => {
    const { host, bob, cara, hostSeat } = await mixedRoom();
    host.send({ t: "startGame" });
    await settle();
    const before = host.last("update");

    // It is the Host's turn: Bob tries to play it, then tries Cara's Seat.
    bob.client.send({ t: "action", seat: hostSeat, action: { type: "DRAW_CARD", player: hostSeat }, clientSeq: 1 });
    bob.client.send({ t: "action", seat: cara.seat, action: { type: "DRAW_CARD", player: cara.seat }, clientSeq: 2 });
    await settle();

    expect(bob.client.of("actionRejected")).toEqual([
      { t: "actionRejected", clientSeq: 1, error: `You don't control Seat ${hostSeat}` },
      { t: "actionRejected", clientSeq: 2, error: `You don't control Seat ${cara.seat}` },
    ]);
    expect(host.last("update")).toBe(before);
    expect(cara.client.of("actionRejected")).toEqual([]);
  });

  it("ignores a `from` a friend writes into the frame", async () => {
    const { relay, roomCode, host, bob, cara } = await mixedRoom();
    // A hand-made frame, as a malicious client could send, claiming to be Cara.
    const socket = await relay.dialer.dial(roomCode, bob.connection.seatToken);
    if ("refused" in socket) throw new Error("refused");
    socket.send(JSON.stringify({ from: cara.connection.seatToken, payload: { t: "joinRoom", name: "Mallory" } }));
    await settle();
    expect(host.last("lobby").seats.map((s) => s.name)).toEqual(["Alice", "Dee", "Bot 1", "Bob", "Cara"]);
  });

  it("reserves lobby commands for the Host", async () => {
    const { host, bob } = await mixedRoom();
    const commands: ClientMsg[] = [
      { t: "addBot", difficulty: "easy" },
      { t: "addLocalSeat", name: "Eve" },
      { t: "setConfig", config: { targetScore: 1 } },
      { t: "startGame" },
    ];
    for (const msg of commands) bob.client.send(msg);
    await settle();
    expect(bob.client.of("error").map((e) => e.message)).toEqual(commands.map((c) => `Only the Host can ${c.t}`));
    expect(host.last("lobby").seats).toHaveLength(5);
    expect(host.of("update")).toHaveLength(0);
  });
});

describe("validation", () => {
  it("rejects malformed remote messages without changing the game", async () => {
    const { host, bob } = await mixedRoom();
    host.send({ t: "startGame" });
    await settle();
    const before = host.last("update");

    bob.connection.send({ t: "nonsense" } as unknown as ClientMsg);
    bob.connection.send({ t: "action", seat: bob.seat, clientSeq: 7, action: { type: "DRAW_CARD" } } as unknown as ClientMsg);
    bob.connection.send({ t: "chat", text: "x".repeat(501) });
    await settle();

    const replies = bob.client.inbox.filter((m) => m.t === "error" || m.t === "actionRejected");
    expect(replies.map((m) => m.t)).toEqual(["error", "actionRejected", "error"]);
    expect(replies[1]).toMatchObject({ clientSeq: 7 });
    expect(host.last("update")).toBe(before);
  });

  it("passes a friend's UI only Room messages that fit the protocol", async () => {
    // A bare Host socket with no Room behind it, sending what a buggy Host could.
    const relay = new FakeRelay();
    const { roomCode, hostToken } = relay.createRoom();
    const hostSocket = relay.connectHost(roomCode, hostToken);
    const bob = await RelayConnection.join({ dialer: relay.dialer, roomCode, name: "Bob" });
    const client = new Client(bob);
    for (const payload of [{ t: "bogus" }, { t: "update", version: -1, events: [], view: {} }, { t: "error", message: "fine" }]) {
      hostSocket.send(JSON.stringify({ to: bob.seatToken, payload }));
    }
    await settle();
    expect(client.inbox).toEqual([{ t: "error", message: "fine" }]);
  });
});

describe("hidden information", () => {
  it("never sends a remote Seat another Seat's hand, in views or events", async () => {
    const { relay, host, clients, bob, cara } = await mixedRoom();
    host.send({ t: "startGame" });
    await playToGameOver(clients);

    for (const friend of [bob, cara]) {
      const updates = friend.client.of("update");
      expect(updates.length).toBeGreaterThan(5);
      for (const update of updates) {
        const view = viewOf(update);
        expect(view.me).toBe(friend.seat);
        // Every other player's hand shows only as a count.
        expect(Object.keys(view.players[0]!)).not.toContain("hand");
        for (const event of update.events) {
          if (event.type === "CARD_DRAWN" && event.player !== friend.seat) expect(event).not.toHaveProperty("card");
        }
      }
      // Every frame the relay carried to this friend was addressed to them alone.
      const frames = relay.sentToFriend.get(friend.connection.seatToken)!;
      expect(frames.length).toBeGreaterThan(updates.length);
    }
    // The Host never broadcasts: each Seat's messages go to its own seat token.
    expect(relay.sentByHost.every((f) => JSON.parse(f).to !== "all")).toBe(true);
    // And a friend's hand cards never show up in another friend's frames.
    const bobCards = new Set(bob.client.of("update").flatMap((u) => viewOf(u as Update).hand.map((c) => c.id)));
    const caraFrames = relay.sentToFriend.get(cara.connection.seatToken)!.join("\n");
    const caraOwn = new Set(cara.client.of("update").flatMap((u) => [...viewOf(u).hand.map((c) => c.id), ...viewOf(u).discard.map((c) => c.id)]));
    const played = new Set(cara.client.of("update").flatMap((u) => u.events.flatMap((e) => ("card" in e && e.card ? [(e.card as { id: string }).id] : []))));
    for (const id of bobCards) {
      if (caraOwn.has(id) || played.has(id)) continue; // public once played or discarded
      expect(caraFrames).not.toContain(`"${id}"`);
    }
  });
});

describe("relaySocket", () => {
  /** A WebSocket that throws on use once closed, as the Workers runtime's does. */
  function strictSocket() {
    const listeners: Record<string, ((e: { data: unknown }) => void)[]> = { message: [], close: [] };
    let closed = false;
    const ws = {
      send() {
        if (closed) throw new Error("WebSocket is closed");
      },
      close() {
        if (closed) throw new Error("WebSocket is closed");
        closed = true;
      },
      addEventListener(type: string, cb: (e: { data: unknown }) => void) {
        listeners[type]!.push(cb);
      },
    } as unknown as WebSocketLike;
    const fire = (type: "message" | "close", data?: unknown) => {
      if (type === "close") closed = true;
      for (const cb of listeners[type]!) cb({ data });
    };
    return { ws, fire };
  }

  it("keeps frames and the close that arrive before anyone listens", () => {
    const { ws, fire } = strictSocket();
    const socket = relaySocket(ws);
    fire("message", "one");
    fire("message", new ArrayBuffer(1));
    fire("close");
    const got: string[] = [];
    let closes = 0;
    socket.onMessage((d) => got.push(d));
    socket.onClose(() => closes++);
    expect(got).toEqual(["one"]);
    expect(closes).toBe(1);
  });

  it("does nothing when used after the socket closed", () => {
    const { ws, fire } = strictSocket();
    const socket = relaySocket(ws);
    fire("close");
    expect(() => socket.send("x")).not.toThrow();
    expect(() => socket.close()).not.toThrow();
  });

  it("lets a Room whose relay socket already closed show remote Seats as gone", async () => {
    const { relay, roomCode, room, host } = hostedRoom();
    await join(relay, roomCode, "Bob");
    const { ws, fire } = strictSocket();
    fire("close");
    room.attachRelay(relaySocket(ws));
    expect(host.last("lobby").seats[1]).toMatchObject({ name: "Bob", connected: false });
  });
});
