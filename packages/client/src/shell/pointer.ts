import type { RoomCode } from "@here-to-slay/protocol";

/**
 * Which Room this device should go back into on load. One per device: a new
 * Room replaces it, and game over and "Leave Room" clear it. The online
 * fields are there for hosting and joining, which aren't built yet.
 */
export interface RoomPointer {
  mode: "offline" | "online";
  role: "host" | "friend";
  roomCode: RoomCode;
  /** The player's name on this device: the Host's name for a Room this device runs. */
  name: string;
  /** The Host's `hostToken` or a friend's `seatToken`. Online only. */
  token?: string;
}

export interface PointerStore {
  load(): RoomPointer | null;
  save(pointer: RoomPointer): void;
  clear(): void;
}

const KEY = "here-to-slay.room";

/**
 * Keeps the pointer in `storage` (the browser's localStorage). Storage can
 * be blocked, full or edited by hand, so failures read as no pointer.
 */
export function storagePointerStore(storage: Storage): PointerStore {
  return {
    load() {
      try {
        const raw = storage.getItem(KEY);
        return raw === null ? null : parsePointer(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    save(pointer) {
      try {
        storage.setItem(KEY, JSON.stringify(pointer));
      } catch {
        // Without storage, a refresh lands on the first screen: the game itself carries on.
      }
    },
    clear() {
      try {
        storage.removeItem(KEY);
      } catch {
        // As above.
      }
    },
  };
}

/** Keeps the pointer in memory, for tests. */
export function memoryPointerStore(initial: RoomPointer | null = null): PointerStore {
  let pointer = initial;
  return {
    load: () => pointer,
    save(p) {
      pointer = { ...p };
    },
    clear() {
      pointer = null;
    },
  };
}

function parsePointer(value: unknown): RoomPointer | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (p.mode !== "offline" && p.mode !== "online") return null;
  if (p.role !== "host" && p.role !== "friend") return null;
  if (typeof p.roomCode !== "string" || typeof p.name !== "string") return null;
  if (p.token !== undefined && typeof p.token !== "string") return null;
  return { mode: p.mode, role: p.role, roomCode: p.roomCode, name: p.name, ...(p.token !== undefined && { token: p.token }) };
}
