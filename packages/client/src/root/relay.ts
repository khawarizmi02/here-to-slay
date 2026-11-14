import type { RoomCode, SeatToken } from "@here-to-slay/protocol";
import { relaySocket, type RelayDialer, type RelaySocket } from "@here-to-slay/room";

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

/** The Host's WebSocket to its Room, once open. */
export async function hostSocket(relayUrl: string, roomCode: RoomCode, hostToken: string): Promise<RelaySocket> {
  return relaySocket(await openWebSocket(socketUrl(relayUrl, roomCode, { hostToken })));
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
