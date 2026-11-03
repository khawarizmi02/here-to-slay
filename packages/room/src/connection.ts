import type { ClientMsg, RoomMsg } from "@here-to-slay/protocol";

/**
 * How every UI talks to its Room (TECHNICAL_DESIGN.md §10.3). The UI never
 * knows whether the Room is in the same tab or behind the relay.
 */
export interface GameConnection {
  send(msg: ClientMsg): void;
  /** Returns a function that unsubscribes `cb`. */
  onMessage(cb: (msg: RoomMsg) => void): () => void;
  close(): void;
}

/**
 * A connection to a Room in the same tab, for the Host's UI and hot-seat
 * players. Get one from `Room.hostConnection` or `Room.connectLocalSeat`.
 *
 * Messages that arrive before anyone subscribes are kept and handed to the
 * first subscriber, so the UI doesn't miss the opening `lobby` or `update`.
 */
/**
 * A connection's subscribers. Messages that arrive before anyone subscribes
 * are kept and handed to the first subscriber, so the UI doesn't miss the
 * opening `lobby` or `update`. Each subscriber gets its own copy: messages
 * are plain JSON, and a UI must not share objects with the Room or another UI.
 */
export class Subscribers {
  readonly #listeners = new Set<(msg: RoomMsg) => void>();
  #backlog: RoomMsg[] | null = [];

  add(cb: (msg: RoomMsg) => void): () => void {
    this.#listeners.add(cb);
    const backlog = this.#backlog;
    if (backlog) {
      this.#backlog = null;
      for (const msg of backlog) cb(copy(msg));
    }
    return () => {
      this.#listeners.delete(cb);
    };
  }

  deliver(msg: RoomMsg): void {
    if (this.#backlog) {
      this.#backlog.push(msg);
      return;
    }
    for (const cb of [...this.#listeners]) cb(copy(msg));
  }

  clear(): void {
    this.#listeners.clear();
    this.#backlog = null;
  }
}

/**
 * A connection to a Room in the same tab, for the Host's UI and hot-seat
 * players. Get one from `Room.hostConnection` or `Room.connectLocalSeat`.
 *
 * Messages that arrive before anyone subscribes are kept and handed to the
 * first subscriber, so the UI doesn't miss the opening `lobby` or `update`.
 */
export class LocalConnection implements GameConnection {
  readonly #subscribers = new Subscribers();
  #closed = false;

  /** @internal Used by the Room; UI code gets connections from the Room. */
  constructor(
    private readonly toRoom: (msg: unknown) => void,
    private readonly onClose: () => void,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  send(msg: ClientMsg): void {
    if (this.#closed) return;
    // Copy, so the UI can't reach into the Room through a shared object.
    // Something JSON can't carry is malformed; the Room answers it like any other bad message.
    let copied: unknown;
    try {
      copied = copy(msg);
    } catch {
      copied = { unserialisable: true };
    }
    this.toRoom(copied);
  }

  onMessage(cb: (msg: RoomMsg) => void): () => void {
    return this.#subscribers.add(cb);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscribers.clear();
    this.onClose();
  }

  /** @internal Called by the Room to deliver a message to the UI. */
  deliver(msg: RoomMsg): void {
    if (this.#closed) return;
    this.#subscribers.deliver(msg);
  }
}

function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
