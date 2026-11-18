import type { RoomCode, SeatToken } from "@here-to-slay/protocol";
import { relaySocket, type RelayDialer } from "@here-to-slay/room";
import { RoomClosedError } from "../shell/game.js";
import type { HostSocket } from "./reconnect.js";

/** The close code the relay sends a Host connection that a newer one replaced. */
const CLOSE_REPLACED = 4000;

// The browser's side of the relay's HTTP and WebSocket API (TECHNICAL_DESIGN.md §10.5), at `relayUrl` (http or https).

/** A Room the relay has made, and the token that proves this tab is its Host. */
export interface RelayRoom {
  roomCode: RoomCode;
  hostToken: string;
}

/** `POST /rooms`: a fresh Room Code for a new Room. */
export async function createRelayRoom(relayUrl: string): Promise<RelayRoom> {
  const res = await fetch(new URL("/rooms", relayUrl), { method: "POST" });
  if (!res.ok) throw new Error(`the relay answered HTTP ${res.status}`);
  return (await res.json()) as RelayRoom;
}

/** The Host's WebSocket to its Room, once open. Rejects with a `RoomClosedError` when the relay no longer knows the Room. */
export async function hostSocket(relayUrl: string, roomCode: RoomCode, hostToken: string): Promise<HostSocket> {
  let ws: WebSocket;
  try {
    ws = await openWebSocket(socketUrl(relayUrl, roomCode, { hostToken }));
  } catch (e) {
    // As for friends: ask again plainly to learn why.
    const res = await fetch(roomUrl(relayUrl, roomCode));
    if (res.status === 404) throw roomClosed(roomCode, e);
    throw e;
  }
  let replaced = false;
  // Listening before relaySocket does, so this is known by the time its close is reported.
  ws.addEventListener("close", (event) => {
    replaced = event.code === CLOSE_REPLACED;
  });
  return Object.defineProperty(relaySocket(ws), "replaced", { get: () => replaced });
}

/**
 * Opens friends' WebSockets. A browser can't see the HTTP status a refused
 * WebSocket got, so after a failure the dialer asks the same path again with
 * a plain request: the relay answers 404 for no such Room, and 426 for one
 * that exists.
 */
export function browserDialer(relayUrl: string): RelayDialer {
  return {
    async dial(roomCode: RoomCode, seatToken: SeatToken | null) {
      try {
        return relaySocket(await openWebSocket(socketUrl(relayUrl, roomCode, seatToken === null ? {} : { seatToken })));
      } catch (e) {
        const res = await fetch(roomUrl(relayUrl, roomCode));
        if (res.status !== 426) return { refused: res.status };
        throw e;
      }
    },
  };
}

/**
 * `dialer`, rejecting with a `RoomClosedError` when the relay no longer
 * knows the Room: for coming back to a Seat, where a Room that has gone
 * means it closed, rather than a mistyped Room Code.
 */
export function rejoiningDialer(dialer: RelayDialer): RelayDialer {
  return {
    async dial(roomCode, seatToken) {
      const dialed = await dialer.dial(roomCode, seatToken);
      if ("refused" in dialed && dialed.refused === 404) throw roomClosed(roomCode);
      return dialed;
    },
  };
}

/** What a 404 from the relay means to a tab coming back to its Room. */
function roomClosed(roomCode: RoomCode, cause?: unknown): RoomClosedError {
  return new RoomClosedError(`Room ${roomCode} has closed`, { cause });
}

function roomUrl(relayUrl: string, roomCode: RoomCode): URL {
  return new URL(`/rooms/${roomCode}/ws`, relayUrl);
}

function socketUrl(relayUrl: string, roomCode: RoomCode, query: Record<string, string>): string {
  const url = roomUrl(relayUrl, roomCode);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.href;
}

/** Resolves once the socket is open, or rejects if it closes first. */
function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const failed = () => reject(new Error("the WebSocket closed before it opened"));
    ws.addEventListener("close", failed, { once: true });
    ws.addEventListener(
      "open",
      () => {
        ws.removeEventListener("close", failed);
        resolve(ws);
      },
      { once: true },
    );
  });
}
