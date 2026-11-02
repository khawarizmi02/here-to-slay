import type { ClientMsg, RoomMsg } from "@here-to-slay/protocol";
import type { GameConnection } from "./game-connection.js";

/** The Room's side of an attached connection. */
export interface RoomLink {
  /** Hands an incoming message to the Room. The Room validates it. */
  receive(raw: unknown): void;
  /** Detaches the connection: the Room stops delivering to it. */
  detach(): void;
}

/** Called by the Room for every message addressed to this connection. */
export type Deliver = (msg: RoomMsg) => void;

/**
 * A connection to a Room in the same tab. The Host's own UI and hot-seat
 * players use it. Get one from `Room.connectHost()` or
 * `Room.connectLocalSeat()`.
 *
 * Messages are copied in both directions, as if they had crossed the network,
 * so neither side can mutate the other's objects.
 *
 * Messages are delivered synchronously. A new subscriber sees only messages
 * sent after it subscribed; send `resync` to get the current lobby and view.
 */
export class LocalConnection implements GameConnection {
  private readonly listeners = new Set<(msg: RoomMsg) => void>();
  private readonly link: RoomLink;
  private closed = false;

  constructor(attach: (deliver: Deliver) => RoomLink) {
    this.link = attach((msg) => this.deliver(msg));
  }

  send(msg: ClientMsg): void {
    if (this.closed) throw new Error("This connection is closed");
    this.link.receive(copy(msg));
  }

  onMessage(cb: (msg: RoomMsg) => void): () => void {
    // Wrap so the same callback can subscribe twice and unsubscribe independently.
    const listener = (msg: RoomMsg) => cb(msg);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.link.detach();
  }

  private deliver(msg: RoomMsg): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(copy(msg));
  }
}

/** Messages are plain JSON, so a JSON round-trip is a faithful deep copy. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
