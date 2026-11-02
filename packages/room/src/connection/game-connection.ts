import type { ClientMsg, RoomMsg } from "@here-to-slay/protocol";

/**
 * How every UI talks to its Room (TECHNICAL_DESIGN.md §10.3). The UI never
 * knows whether the Room is in the same tab (`LocalConnection`) or behind
 * the relay (`RelayConnection`).
 */
export interface GameConnection {
  send(msg: ClientMsg): void;
  /** Returns an unsubscribe function. */
  onMessage(cb: (msg: RoomMsg) => void): () => void;
  close(): void;
}
