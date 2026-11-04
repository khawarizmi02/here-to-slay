import type { RelayDialer, RelaySocket } from "../src/index.js";

// The Room package has no DOM or Node types; these globals exist in every runtime the tests use.
declare function queueMicrotask(cb: () => void): void;
declare function setTimeout(cb: () => void, ms: number): unknown;

/*
 * An in-memory stand-in for the relay (packages/relay), for tests at the
 * GameConnection seam. It follows the real relay's rules (TECHNICAL_DESIGN.md
 * §10.5): friends get a seat token in a `welcome` frame, every friend frame
 * reaches the Host stamped with the sender's seat token (whatever `from` the
 * friend wrote), the Host addresses frames to one seat token or "all", and
 * the Host hears peerJoined/peerLeft. Frames are JSON text, delivered
 * asynchronously in order, like a WebSocket.
 */

/** Lets every frame in flight arrive: deliveries are microtasks, so one macrotask drains them all. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** One end of a fake WebSocket, as a tab holds it. */
class FakeSocket implements RelaySocket {
  closed = false;
  #onMessage: ((data: string) => void) | null = null;
  #backlog: string[] = [];
  #onClose: (() => void)[] = [];

  constructor(
    private readonly toRelay: (data: string) => void,
    private readonly onClosedByTab: () => void,
  ) {}

  send(data: string): void {
    if (this.closed) return;
    queueMicrotask(() => this.toRelay(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => {
      this.onClosedByTab();
      for (const cb of this.#onClose) cb();
    });
  }

  onMessage(cb: (data: string) => void): void {
    this.#onMessage = cb;
    for (const data of this.#backlog.splice(0)) cb(data);
  }

  onClose(cb: () => void): void {
    this.#onClose.push(cb);
  }

  /** Relay → tab. */
  push(data: string): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed) return;
      if (this.#onMessage) this.#onMessage(data);
      else this.#backlog.push(data);
    });
  }

  /** The relay hangs up, after the frames it already sent arrive. */
  drop(): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.closed = true;
      for (const cb of this.#onClose) cb();
    });
  }
}

interface FakeRoom {
  hostToken: string;
  host: FakeSocket | null;
  friends: { seatToken: string; socket: FakeSocket }[];
}

export class FakeRelay {
  readonly #rooms = new Map<string, FakeRoom>();
  #nextToken = 1;
  /** Every frame the relay sent each friend, by seat token, exactly as sent. */
  readonly sentToFriend = new Map<string, string[]>();
  /** Every frame the Host sent, exactly as sent. */
  readonly sentByHost: string[] = [];

  createRoom(roomCode = "HXQ7M"): { roomCode: string; hostToken: string } {
    const hostToken = `host-token-${roomCode}`;
    this.#rooms.set(roomCode, { hostToken, host: null, friends: [] });
    return { roomCode, hostToken };
  }

  /** The Host's socket. */
  connectHost(roomCode: string, hostToken: string): RelaySocket {
    const room = this.#rooms.get(roomCode);
    if (!room || room.hostToken !== hostToken) throw new Error("no such Room, or wrong host token");
    room.host?.drop();
    const socket: FakeSocket = new FakeSocket(
      (data) => this.#fromHost(room, socket, data),
      () => {
        if (room.host === socket) room.host = null;
      },
    );
    room.host = socket;
    for (const seatToken of new Set(room.friends.map((f) => f.seatToken))) socket.push(JSON.stringify({ kind: "peerJoined", seatToken }));
    return socket;
  }

  /** How a friend's RelayConnection reaches this relay. */
  readonly dialer: RelayDialer = {
    dial: (roomCode, seatToken) => {
      const room = this.#rooms.get(roomCode);
      if (!room) return Promise.resolve({ refused: 404 });
      const token = seatToken ?? `seat-token-${this.#nextToken++}`;
      const first = !room.friends.some((f) => f.seatToken === token);
      const socket: FakeSocket = new FakeSocket(
        (data) => this.#fromFriend(room, socket, token, data),
        () => this.#friendLeft(room, socket, token),
      );
      room.friends.push({ seatToken: token, socket });
      if (seatToken === null) this.#toFriend(token, socket, JSON.stringify({ kind: "welcome", seatToken: token }));
      if (first) room.host?.push(JSON.stringify({ kind: "peerJoined", seatToken: token }));
      return Promise.resolve(socket);
    },
  };

  /** Ends a Room the way the relay does after the Host has been gone 10 minutes: its code is free again. */
  closeRoom(roomCode: string): void {
    const room = this.#rooms.get(roomCode);
    if (!room) return;
    this.#rooms.delete(roomCode);
    for (const { seatToken, socket } of room.friends) {
      this.#toFriend(seatToken, socket, JSON.stringify({ kind: "roomClosed" }));
      socket.drop();
    }
    room.host?.drop();
  }

  /** The relay's 1-second heartbeat to the Host. */
  tick(roomCode: string): void {
    this.#rooms.get(roomCode)?.host?.push(JSON.stringify({ kind: "tick" }));
  }

  /** The Host's connection drops. */
  dropHost(roomCode: string): void {
    const room = this.#rooms.get(roomCode)!;
    room.host?.drop();
    room.host = null;
    for (const { seatToken, socket } of room.friends) this.#toFriend(seatToken, socket, JSON.stringify({ kind: "hostAway" }));
  }

  #fromFriend(room: FakeRoom, socket: FakeSocket, seatToken: string, data: string): void {
    if (socket.closed) return;
    const frame = parseObject(data);
    if (!frame || frame.payload === undefined) return;
    // Stamped with the seat token this socket connected with; a `from` the friend wrote is ignored.
    room.host?.push(JSON.stringify({ kind: "msg", from: seatToken, payload: frame.payload }));
  }

  #fromHost(room: FakeRoom, socket: FakeSocket, data: string): void {
    if (socket.closed || room.host !== socket) return;
    this.sentByHost.push(data);
    const frame = parseObject(data);
    if (!frame || frame.payload === undefined) return;
    const out = JSON.stringify({ kind: "msg", payload: frame.payload });
    for (const friend of room.friends) {
      if (frame.to === "all" || frame.to === friend.seatToken) this.#toFriend(friend.seatToken, friend.socket, out);
    }
  }

  #friendLeft(room: FakeRoom, socket: FakeSocket, seatToken: string): void {
    room.friends = room.friends.filter((f) => f.socket !== socket);
    if (!room.friends.some((f) => f.seatToken === seatToken)) room.host?.push(JSON.stringify({ kind: "peerLeft", seatToken }));
  }

  #toFriend(seatToken: string, socket: FakeSocket, data: string): void {
    if (socket.closed) return;
    const sent = this.sentToFriend.get(seatToken) ?? [];
    sent.push(data);
    this.sentToFriend.set(seatToken, sent);
    socket.push(data);
  }
}

function parseObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
