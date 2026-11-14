import { RoomCodeSchema } from "@here-to-slay/protocol";
import type { Env } from "./env.js";
import { newHostToken, newRoomCode } from "./tokens.js";
export { RoomRelay } from "./room-relay.js";

/** Attempts at finding a free Room Code before giving up. */
const MAX_CODE_ATTEMPTS = 10;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** `response`, readable by a browser tab on another origin. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

async function createRoom(env: Env): Promise<Response> {
  const hostToken = newHostToken();
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const roomCode = newRoomCode();
    const room = env.ROOMS.get(env.ROOMS.idFromName(roomCode));
    if (await room.create(hostToken)) return json({ roomCode, hostToken }, 201);
  }
  return json({ error: "No free Room Code; try again" }, 503);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === "/rooms" && request.method === "POST") return createRoom(env);

    const ws = /^\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (ws && request.method === "GET") {
      const roomCode = ws[1]!.toUpperCase();
      if (!RoomCodeSchema.safeParse(roomCode).success) return json({ error: "No such Room" }, 404);
      const response = await env.ROOMS.get(env.ROOMS.idFromName(roomCode)).fetch(request);
      // A browser can't read why its WebSocket was refused, so a tab asks again with a plain request and reads this.
      return response.status === 101 ? response : withCors(response);
    }
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
