import type { RoomMsg } from "@here-to-slay/protocol";

/**
 * Subscribers to a connection the composition root wraps. Like the Room's
 * own connections, it holds messages for the first subscriber, so the UI
 * doesn't miss the opening `lobby` or `update`.
 */
export function heldSubscribers() {
  const listeners = new Set<(msg: RoomMsg) => void>();
  let backlog: RoomMsg[] | null = [];
  return {
    deliver(msg: RoomMsg): void {
      if (backlog) backlog.push(msg);
      else for (const cb of [...listeners]) cb(msg);
    },
    /** Returns a function that unsubscribes `cb`. */
    add(cb: (msg: RoomMsg) => void): () => void {
      listeners.add(cb);
      const held = backlog;
      backlog = null;
      for (const msg of held ?? []) cb(msg);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
