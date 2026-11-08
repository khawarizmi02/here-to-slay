import type { ClientMsg, RoomMsg } from "@here-to-slay/protocol";
import type { GameConnection } from "@here-to-slay/room";
import { act } from "@testing-library/react";

/** A GameConnection a test drives by hand: it feeds RoomMsgs in and reads what the client sent. */
export class FakeConnection implements GameConnection {
  readonly sent: ClientMsg[] = [];
  closed = false;
  readonly #listeners = new Set<(msg: RoomMsg) => void>();

  send(msg: ClientMsg): void {
    this.sent.push(msg);
  }

  onMessage(cb: (msg: RoomMsg) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers messages from the Room, as the client would receive them. */
  receive(...msgs: RoomMsg[]): void {
    act(() => {
      for (const msg of msgs) for (const cb of [...this.#listeners]) cb(structuredClone(msg));
    });
  }

  /** The messages sent since the last call. */
  takeSent(): ClientMsg[] {
    return this.sent.splice(0);
  }
}
