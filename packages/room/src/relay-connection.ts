import {
  PlayerNameSchema,
  RelayToFriendFrameSchema,
  RoomCodeSchema,
  RoomMsgSchema,
  type ClientMsg,
  type FriendToRelayFrame,
  type RoomCode,
  type RoomMsg,
  type SeatToken,
} from "@here-to-slay/protocol";
import { Subscribers, type GameConnection } from "./connection.js";

/**
 * One WebSocket to the relay, carrying JSON text frames (TECHNICAL_DESIGN.md
 * §10.5). The Room package has no network code of its own: the caller opens
 * the socket and wraps it with `relaySocket`, or provides a stand-in in tests.
 */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  /** Frames that arrive before this is called are kept and handed to `cb`. */
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

/** What `relaySocket` needs of a WebSocket. Browser and Workers WebSockets both fit. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

/**
 * Wraps an open WebSocket. Binary frames are ignored: the relay speaks only
 * text. Sending on or closing a socket that has already closed does nothing
 * (some runtimes throw): the socket's close is reported through `onClose`,
 * even to a callback registered after it happened.
 */
export function relaySocket(ws: WebSocketLike): RelaySocket {
  let onMessage: ((data: string) => void) | null = null;
  const backlog: string[] = [];
  const onClose: (() => void)[] = [];
  let closed = false;
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    if (onMessage) onMessage(event.data);
    else backlog.push(event.data);
  });
  ws.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    for (const cb of onClose.splice(0)) cb();
  });
  return {
    send(data) {
      if (closed) return;
      try {
        ws.send(data);
      } catch {
        // The socket is closing; its close event follows.
      }
    },
    close() {
      try {
        ws.close(1000, "Closing");
      } catch {
        // Already closed.
      }
    },
    onMessage(cb) {
      onMessage = cb;
      for (const data of backlog.splice(0)) cb(data);
    },
    onClose(cb) {
      if (closed) cb();
      else onClose.push(cb);
    },
  };
}

/** How a friend's tab reaches the relay. */
export interface RelayDialer {
  /**
   * Opens a friend's WebSocket to the relay (`GET /rooms/:roomCode/ws`, with
   * `?seatToken=` when one is given). Resolves to the open socket, or to the
   * HTTP status the relay refused it with: 404 means there is no such Room.
   * Rejects if the relay can't be reached at all.
   */
  dial(roomCode: RoomCode, seatToken: SeatToken | null): Promise<RelaySocket | { refused: number }>;
}

/** Why joining a Room failed, in words a player can act on. */
export class JoinError extends Error {
  override readonly name = "JoinError";
}

export interface JoinOptions {
  dialer: RelayDialer;
  /** As the player typed it: case and surrounding spaces don't matter. */
  roomCode: string;
  name: string;
  /** The seat token from an earlier join, to come back to the same Seat. */
  seatToken?: SeatToken;
}

/**
 * A friend's connection to a Room through the relay (TECHNICAL_DESIGN.md
 * §10.3). Get one with `RelayConnection.join`. The UI uses it exactly like a
 * `LocalConnection`.
 *
 * Besides the Room's messages, it reports what the relay says about the Room:
 * `hostAway` while the Host is disconnected, and an `error` when the Room
 * closes or the connection is lost, after which it is closed.
 */
export class RelayConnection implements GameConnection {
  readonly roomCode: RoomCode;
  readonly #socket: RelaySocket;
  readonly #subscribers = new Subscribers();
  #seatToken: SeatToken | null;
  #closed = false;
  /** Why the relay ended the connection, once it has. */
  #endReason: string | null = null;
  #welcomed: (() => void) | null = null;
  #lost: ((reason: string) => void) | null = null;

  private constructor(socket: RelaySocket, roomCode: RoomCode, seatToken: SeatToken | null) {
    this.#socket = socket;
    this.roomCode = roomCode;
    this.#seatToken = seatToken;
    socket.onMessage((data) => this.#frame(data));
    socket.onClose(() => this.#end(`Lost the connection to Room ${roomCode}`));
  }

  /**
   * Joins the Room with `roomCode` as `name`, or with `seatToken` comes back
   * to an earlier Seat. Resolves once the relay has accepted the connection;
   * the Room's `lobby` (or `update`) follows through `onMessage`. Rejects
   * with a `JoinError` when the Room Code is malformed, unknown or closed.
   */
  static async join(opts: JoinOptions): Promise<RelayConnection> {
    const code = opts.roomCode.trim().toUpperCase();
    if (!RoomCodeSchema.safeParse(code).success) {
      throw new JoinError(`"${opts.roomCode}" is not a Room Code: Room Codes have 5 letters and digits`);
    }
    const name = PlayerNameSchema.safeParse(opts.name);
    if (!name.success) throw new JoinError("Your name must be 1 to 24 characters");

    let dialed: RelaySocket | { refused: number };
    try {
      dialed = await opts.dialer.dial(code, opts.seatToken ?? null);
    } catch (e) {
      throw new JoinError(`Could not reach the relay: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ("refused" in dialed) {
      throw new JoinError(
        dialed.refused === 404
          ? `There is no Room ${code}. It may have closed; ask the Host for a new Room Code.`
          : `The relay refused to join Room ${code} (HTTP ${dialed.refused})`,
      );
    }

    const connection = new RelayConnection(dialed, code, opts.seatToken ?? null);
    if (connection.#seatToken === null) await connection.#welcome();
    // Joining again with a seat token is harmless: the Room just sends the Seat its current state.
    connection.send({ t: "joinRoom", name: name.data });
    return connection;
  }

  /** The relay's token for this Seat. Keep it to come back to the same Seat after a refresh. */
  get seatToken(): SeatToken {
    return this.#seatToken!;
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(msg: ClientMsg): void {
    if (this.#closed) return;
    let frame: string;
    try {
      frame = JSON.stringify({ payload: msg } satisfies FriendToRelayFrame);
    } catch {
      // Something JSON can't carry is malformed; the Room answers it like any other bad message.
      frame = JSON.stringify({ payload: { unserialisable: true } });
    }
    this.#socket.send(frame);
  }

  onMessage(cb: (msg: RoomMsg) => void): () => void {
    return this.#subscribers.add(cb);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscribers.clear();
    this.#socket.close();
  }

  /** Waits for the relay's `welcome`, which carries a new friend's seat token. */
  #welcome(): Promise<void> {
    if (this.#endReason !== null) return Promise.reject(new JoinError(this.#endReason));
    return new Promise((resolve, reject) => {
      this.#welcomed = resolve;
      this.#lost = (reason) => reject(new JoinError(reason));
    });
  }

  #frame(data: string): void {
    if (this.#closed) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = RelayToFriendFrameSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.kind) {
      case "welcome":
        this.#seatToken ??= frame.seatToken;
        this.#welcomed?.();
        this.#welcomed = this.#lost = null;
        return;
      case "msg": {
        // The Room is trusted, but the frame crossed the network: pass on only well-formed messages.
        const msg = RoomMsgSchema.safeParse(frame.payload);
        if (msg.success) this.#subscribers.deliver(msg.data);
        return;
      }
      case "hostAway":
        this.#subscribers.deliver({ t: "hostAway" });
        return;
      case "hostBack":
        // The Host may have refreshed: ask for the current state rather than wait for it.
        this.send({ t: "resync" });
        return;
      case "roomClosed":
        this.#end(`Room ${this.roomCode} has closed: the Host was away too long`);
        return;
    }
  }

  /** The relay ended the connection: tell the UI once, then close. */
  #end(reason: string): void {
    if (this.#closed) return;
    this.#endReason = reason;
    if (this.#lost) {
      this.#lost(reason);
    } else {
      this.#subscribers.deliver({ t: "error", message: reason });
    }
    this.#welcomed = this.#lost = null;
    // Subscribers are kept, so a UI that subscribes late still gets the reason from the backlog.
    this.#closed = true;
    this.#socket.close();
  }
}
