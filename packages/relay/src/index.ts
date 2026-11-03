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
      return env.ROOMS.get(env.ROOMS.idFromName(roomCode)).fetch(request);
    }
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
