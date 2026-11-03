import { exports } from "cloudflare:workers";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@here-to-slay/protocol";
import { expect, vi } from "vitest";

export const BASE = "https://relay.test";

export async function createRoom(): Promise<{ roomCode: string; hostToken: string }> {
  const res = await exports.default.fetch(`${BASE}/rooms`, { method: "POST" });
  expect(res.status).toBe(201);
  return res.json();
}

export function upgrade(roomCode: string, query: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  return exports.default.fetch(`${BASE}/rooms/${roomCode}/ws${qs ? `?${qs}` : ""}`, {
    headers: { Upgrade: "websocket" },
  });
}

/** One end of a WebSocket to the relay, as a browser tab would hold it. */
export class TestSocket {
  private readonly frames: string[] = [];
  private readonly waiters: ((raw: string) => void)[] = [];
  closed = false;

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
      const waiter = this.waiters.shift();
      if (waiter) waiter(raw);
      else this.frames.push(raw);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** The next frame exactly as the relay sent it. */
  nextRaw(timeoutMs = 2000): Promise<string> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("timed out waiting for a frame"));
      }, timeoutMs);
      const waiter = (raw: string) => {
        clearTimeout(timer);
        resolve(raw);
      };
      this.waiters.push(waiter);
    });
  }

  async next(timeoutMs?: number): Promise<Record<string, unknown>> {
    return JSON.parse(await this.nextRaw(timeoutMs));
  }

  /** Frames that arrive within `ms`, parsed. */
  async drain(ms: number): Promise<Record<string, unknown>[]> {
    await new Promise((r) => setTimeout(r, ms));
    return this.frames.splice(0).map((raw) => JSON.parse(raw));
  }

  close(): void {
    this.ws.close(1000, "bye");
  }
}

export async function connect(roomCode: string, query: Record<string, string> = {}): Promise<TestSocket> {
  const res = await upgrade(roomCode, query);
  expect(res.status).toBe(101);
  return new TestSocket(res.webSocket!);
}

export const connectHost = (roomCode: string, hostToken: string) => connect(roomCode, { hostToken });

/** A friend who joins with no seat token and receives one in `welcome`. */
export async function joinAsNewFriend(roomCode: string): Promise<{ socket: TestSocket; seatToken: string }> {
  const socket = await connect(roomCode);
  const welcome = await socket.next();
  expect(welcome.kind).toBe("welcome");
  return { socket, seatToken: welcome.seatToken as string };
}

/**
 * Creates a Room while the relay's randomness first picks `wanted` as the Room
 * Code, then falls back to real randomness. Shows whether a code is free.
 */
export async function createRoomWithCode(wanted: string): Promise<{ roomCode: string; hostToken: string }> {
  const real = crypto.getRandomValues.bind(crypto);
  let forced = false;
  const spy = vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (!forced && array instanceof Uint8Array && array.length === ROOM_CODE_LENGTH) {
      forced = true;
      array.set(Array.from(wanted, (c) => ROOM_CODE_ALPHABET.indexOf(c)));
      return array;
    }
    return real(array as never) as T;
  });
  try {
    return await createRoom();
  } finally {
    spy.mockRestore();
  }
}
