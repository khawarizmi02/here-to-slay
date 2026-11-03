import { DurableObject } from "cloudflare:workers";
import { SeatTokenSchema } from "@here-to-slay/protocol";
import type { Env } from "./env.js";
import { fieldValue, readOuterFields } from "./frames.js";
import { newSeatToken, sameSecret } from "./tokens.js";

/** How long a Room survives without its Host before it closes. */
export const HOST_GRACE_MS = 10 * 60 * 1000;
/** Gap between the Host's heartbeat ticks while friends are connected. */
export const TICK_MS = 1000;

/** Close code sent to a Host connection that a newer Host connection replaced. */
const CLOSE_REPLACED = 4000;
/** Close code sent to friends when the Room closes. */
const CLOSE_ROOM_CLOSED = 4004;

interface RoomState {
  hostToken: string;
  /** When the Host was last seen leaving (or the Room's creation, before the Host first connects). Null while the Host is connected. */
  hostGoneAt: number | null;
}

type Attachment = { role: "host" } | { role: "friend"; seatToken: string };

const HOST_TAG = "host";
const FRIEND_TAG = "friend";
const seatTag = (seatToken: string) => `seat:${seatToken}`;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * One Room's relay: holds the WebSockets of the Host and its friends, routes
 * frames between them, stamps friends' frames with their seat token, and
 * closes the Room when the Host has been gone too long. Knows nothing of the game.
 *
 * Uses the WebSocket Hibernation API, so an idle Room costs nothing.
 */
export class RoomRelay extends DurableObject<Env> {
  /** Sockets whose departure was already handled (close and error can both fire). */
  private readonly departed = new WeakSet<WebSocket>();

  /** Claims this Room Code for a new Room. False if the code is in use. */
  async create(hostToken: string): Promise<boolean> {
    if (await this.room()) return false;
    const now = Date.now();
    await this.ctx.storage.put<RoomState>("room", { hostToken, hostGoneAt: now });
    // A Room whose Host never connects is freed like any other.
    await this.ctx.storage.setAlarm(now + HOST_GRACE_MS);
    return true;
  }

  override async fetch(request: Request): Promise<Response> {
    const room = await this.room();
    if (!room) return jsonResponse({ error: "No such Room" }, 404);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected a WebSocket upgrade" }, 426);
    }

    const params = new URL(request.url).searchParams;
    const hostToken = params.get("hostToken");
    const pair = new WebSocketPair();
    if (hostToken !== null) {
      if (!sameSecret(hostToken, room.hostToken)) return jsonResponse({ error: "Wrong host token" }, 403);
      await this.acceptHost(pair[1], room);
    } else {
      const claimed = params.get("seatToken");
      if (claimed !== null && !SeatTokenSchema.safeParse(claimed).success) {
        return jsonResponse({ error: "Malformed seat token" }, 400);
      }
      await this.acceptFriend(pair[1], claimed, room);
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async acceptHost(ws: WebSocket, room: RoomState): Promise<void> {
    const previous = this.openSockets(HOST_TAG);
    this.ctx.acceptWebSocket(ws, [HOST_TAG]);
    ws.serializeAttachment({ role: "host" } satisfies Attachment);
    // A refreshed Host takes the role back from a connection that hasn't closed yet.
    for (const old of previous) {
      this.departed.add(old);
      old.close(CLOSE_REPLACED, "Replaced by a newer Host connection");
    }

    for (const seatToken of this.connectedSeatTokens()) send(ws, { kind: "peerJoined", seatToken });
    if (room.hostGoneAt !== null) {
      room.hostGoneAt = null;
      await this.ctx.storage.put("room", room);
      this.broadcast({ kind: "hostBack" });
    }
    await this.reschedule(room);
  }

  private async acceptFriend(ws: WebSocket, claimed: string | null, room: RoomState): Promise<void> {
    const seatToken = claimed ?? newSeatToken();
    const firstForSeat = this.openSockets(seatTag(seatToken)).length === 0;
    this.ctx.acceptWebSocket(ws, [FRIEND_TAG, seatTag(seatToken)]);
    ws.serializeAttachment({ role: "friend", seatToken } satisfies Attachment);

    if (claimed === null) send(ws, { kind: "welcome", seatToken });
    if (room.hostGoneAt !== null) send(ws, { kind: "hostAway" });
    if (firstForSeat) this.toHost(JSON.stringify({ kind: "peerJoined", seatToken }));
    await this.reschedule(room);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // A replaced Host connection, or a socket of a closed Room, no longer speaks for anyone.
    if (typeof message !== "string" || this.departed.has(ws)) return;
    const fields = readOuterFields(message);
    const payload = fields?.get("payload");
    if (!fields || payload === undefined) return;

    const who = ws.deserializeAttachment() as Attachment;
    if (who.role === "friend") {
      // Stamp with the seat token this socket connected with; any `from` the friend wrote is ignored.
      this.toHost(`{"kind":"msg","from":${JSON.stringify(who.seatToken)},"payload":${payload}}`);
      return;
    }

    const to = fieldValue(fields, "to");
    const frame = `{"kind":"msg","payload":${payload}}`;
    if (to === "all") for (const friend of this.openSockets(FRIEND_TAG)) friend.send(frame);
    else if (typeof to === "string") for (const friend of this.openSockets(seatTag(to))) friend.send(frame);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "Closing");
    } catch {
      // Already closed.
    }
    await this.depart(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.depart(ws);
  }

  override async alarm(): Promise<void> {
    const room = await this.room();
    if (!room) return;
    const now = Date.now();
    if (room.hostGoneAt !== null && now >= room.hostGoneAt + HOST_GRACE_MS) {
      await this.closeRoom();
      return;
    }
    if (this.openSockets(FRIEND_TAG).length > 0) this.toHost(`{"kind":"tick"}`);
    await this.ctx.storage.deleteAlarm();
    await this.reschedule(room);
  }

  private async depart(ws: WebSocket): Promise<void> {
    if (this.departed.has(ws)) return;
    this.departed.add(ws);
    const room = await this.room();
    if (!room) return;

    const who = ws.deserializeAttachment() as Attachment;
    if (who.role === "host") {
      if (this.openSockets(HOST_TAG, ws).length > 0) return;
      room.hostGoneAt = Date.now();
      await this.ctx.storage.put("room", room);
      this.broadcast({ kind: "hostAway" });
    } else if (this.openSockets(seatTag(who.seatToken), ws).length === 0) {
      this.toHost(JSON.stringify({ kind: "peerLeft", seatToken: who.seatToken }));
    }
    await this.reschedule(room);
  }

  /** Tells friends the Room closed, then forgets the Room so its code is free again. */
  private async closeRoom(): Promise<void> {
    for (const friend of this.openSockets(FRIEND_TAG)) {
      this.departed.add(friend);
      send(friend, { kind: "roomClosed" });
      friend.close(CLOSE_ROOM_CLOSED, "Room closed");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Brings the alarm forward to the next thing due: a tick (Host and friends
   * both connected) or the Room's expiry (Host gone). Never pushes it back;
   * an alarm that fires early just reschedules.
   */
  private async reschedule(room: RoomState): Promise<void> {
    const now = Date.now();
    let due = Infinity;
    const hostHere = this.openSockets(HOST_TAG).length > 0;
    if (hostHere && this.openSockets(FRIEND_TAG).length > 0) due = now + TICK_MS;
    if (room.hostGoneAt !== null) due = Math.min(due, room.hostGoneAt + HOST_GRACE_MS);
    if (due === Infinity) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || due < current) await this.ctx.storage.setAlarm(due);
  }

  private room(): Promise<RoomState | undefined> {
    return this.ctx.storage.get<RoomState>("room");
  }

  private openSockets(tag: string, except?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets(tag)
      .filter((ws) => ws !== except && !this.departed.has(ws) && ws.readyState === WebSocket.OPEN);
  }

  private connectedSeatTokens(): Set<string> {
    const tokens = new Set<string>();
    for (const ws of this.openSockets(FRIEND_TAG)) {
      const who = ws.deserializeAttachment() as Attachment;
      if (who.role === "friend") tokens.add(who.seatToken);
    }
    return tokens;
  }

  private toHost(frame: string): void {
    for (const host of this.openSockets(HOST_TAG)) host.send(frame);
  }

  private broadcast(frame: { kind: string }): void {
    for (const friend of this.openSockets(FRIEND_TAG)) send(friend, frame);
  }
}

function send(ws: WebSocket, frame: object): void {
  ws.send(JSON.stringify(frame));
}
