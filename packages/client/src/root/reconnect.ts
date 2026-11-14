import type { ClientMsg } from "@here-to-slay/protocol";
import type { GameConnection, RelayConnection, RelaySocket, Room } from "@here-to-slay/room";
import { RoomClosedError } from "../shell/game.js";
import { heldSubscribers } from "./subscribers.js";

// A dropped relay socket is a short hiccup (TECHNICAL_DESIGN.md §10.7): the
// tab dials again by itself, with no reload, until the relay says the Room
// has closed or the player leaves.

/** How long to wait before each attempt to dial again; the last repeats. */
const RETRY_MS = [500, 1_000, 2_000, 5_000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls `dial` until it succeeds, waiting longer each time, and resolves
 * with what it dialed. Resolves with null once `stopped` says so, or once
 * `dial` rejects with a `RoomClosedError`, after calling `onClosed`.
 */
async function redial<T>(dial: () => Promise<T>, stopped: () => boolean, onClosed: () => void): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    await wait(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
    if (stopped()) return null;
    try {
      return await dial();
    } catch (e) {
      if (e instanceof RoomClosedError) {
        onClosed();
        return null;
      }
      console.warn("Couldn't reach the relay; trying again", e);
    }
  }
}

/**
 * A friend's connection that outlives its socket: when `first` loses its
 * socket, `rejoin` (which joins again with the same seat token) stands in
 * for it. The player sees no error for the lost socket, and `roomClosed`
 * if `rejoin` finds the Room has closed. It holds messages for the first
 * subscriber.
 */
export function stayJoined(first: RelayConnection, rejoin: () => Promise<RelayConnection>): GameConnection {
  const { deliver, add } = heldSubscribers();
  let current = first;
  let stopped = false;

  function follow(connection: RelayConnection): void {
    current = connection;
    connection.onMessage((msg) => {
      // An error from a connection that has closed is its lost socket, not the Room's refusal.
      if (msg.t === "error" && connection.closed) {
        void reconnect();
        return;
      }
      deliver(msg);
    });
  }

  async function reconnect(): Promise<void> {
    const next = await redial(rejoin, () => stopped, () => {
      stopped = true;
      deliver({ t: "roomClosed" });
    });
    if (!next) return;
    if (stopped) next.close();
    else follow(next);
  }

  follow(first);
  return {
    send: (msg: ClientMsg) => current.send(msg),
    onMessage: add,
    close() {
      stopped = true;
      current.close();
    },
  };
}

/** The Host's socket to the relay. */
export interface HostSocket extends RelaySocket {
  /** Set, once it has closed, when the relay closed it for a newer Host connection, such as another tab. */
  readonly replaced?: boolean;
}

/**
 * Keeps the Host's Room on the relay: whenever its socket closes, `dial`
 * (which opens a new one with the `hostToken`) replaces it, and the Room
 * takes the new socket. Calls `onClosed` if `dial` finds the Room has
 * closed. A socket replaced by a newer Host connection is not dialed
 * again: two tabs would take the Room from each other for ever. Returns a
 * function that stops it and closes the socket.
 */
export function stayAttached(
  room: Pick<Room<unknown>, "attachRelay">,
  first: HostSocket,
  dial: () => Promise<HostSocket>,
  onClosed: () => void,
): () => void {
  let current = first;
  let stopped = false;

  function follow(socket: HostSocket): void {
    current = socket;
    socket.onClose(() => {
      if (!stopped && !socket.replaced) void reconnect();
    });
  }

  async function reconnect(): Promise<void> {
    const next = await redial(dial, () => stopped, () => {
      stopped = true;
      onClosed();
    });
    if (!next) return;
    if (stopped) {
      next.close();
      return;
    }
    room.attachRelay(next);
    follow(next);
  }

  follow(first);
  return () => {
    stopped = true;
    current.close();
  };
}
