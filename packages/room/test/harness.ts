import { RoomMsgSchema, type Action, type ClientMsg, type RoomMsg } from "@here-to-slay/protocol";
import * as toy from "@here-to-slay/toy-engine";
import { expect } from "vitest";
import { Room, type GameConnection, type RoomEngine, type RoomOptions } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test harness: everything goes through the GameConnection seam.
// ---------------------------------------------------------------------------

/** The toy engine behind the Room's engine interface. Config values must be positive integers. */
export const toyEngine: RoomEngine<toy.GameState> = {
  cardDefsVersion: "toy-1",
  createGame({ players, seed, config }) {
    const parsed: Partial<toy.ToyConfig> = {};
    for (const [key, value] of Object.entries(config)) {
      if (key !== "targetScore" && key !== "handSize") throw new Error(`Unknown config flag ${key}`);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`${key} must be a positive integer`);
      }
      parsed[key] = value;
    }
    return toy.createGame({ players, seed, config: parsed });
  },
  applyAction: toy.applyAction,
  getLegalActions: toy.getLegalActions,
  getPlayerView: (state, player) => toy.getPlayerView(state, player) as unknown as Record<string, unknown>,
  getPlayerEvents: toy.getPlayerEvents,
};

/** A seeded stand-in for Math.random. */
export function seededRandom(seed: string): () => number {
  let rng = toy.createRng(seed);
  return () => {
    let f: number;
    [f, rng] = toy.nextFloat(rng);
    return f;
  };
}

export function makeRoom(overrides: Partial<RoomOptions<toy.GameState>> = {}): Room<toy.GameState> {
  return new Room({
    engine: toyEngine,
    clock: { now: () => 1_000 },
    random: seededRandom("room"),
    hostName: "Alice",
    ...overrides,
  });
}

/** A UI stand-in: records every message, checking each against the protocol schema. */
export class Client {
  readonly inbox: RoomMsg[] = [];
  readonly unsubscribe: () => void;

  constructor(readonly conn: GameConnection) {
    this.unsubscribe = conn.onMessage((msg) => {
      expect(RoomMsgSchema.safeParse(msg).success, `invalid RoomMsg ${JSON.stringify(msg)}`).toBe(true);
      this.inbox.push(msg);
    });
  }

  send(msg: ClientMsg): void {
    this.conn.send(msg);
  }

  /** Sends something that is not a valid ClientMsg, as a buggy or malicious client could. */
  sendRaw(msg: unknown): void {
    this.conn.send(msg as ClientMsg);
  }

  take(): RoomMsg[] {
    return this.inbox.splice(0);
  }

  of<T extends RoomMsg["t"]>(t: T): Extract<RoomMsg, { t: T }>[] {
    return this.inbox.filter((m): m is Extract<RoomMsg, { t: T }> => m.t === t);
  }

  last<T extends RoomMsg["t"]>(t: T): Extract<RoomMsg, { t: T }> {
    const all = this.of(t);
    const msg = all[all.length - 1];
    if (!msg) throw new Error(`no ${t} message received`);
    return msg;
  }
}

export type View = toy.PlayerView;
export type Update = Extract<RoomMsg, { t: "update" }>;

export function viewOf(update: Update): View {
  return update.view as unknown as View;
}

/** A Host with `extra` additional local Seats, all connected, still in the lobby. */
export function hotSeat(extra: string[], overrides: Partial<RoomOptions<toy.GameState>> = {}) {
  const room = makeRoom(overrides);
  const host = new Client(room.hostConnection);
  for (const name of extra) host.send({ t: "addLocalSeat", name });
  const seats = host.last("lobby").seats;
  const hostSeat = host.last("lobby").you[0]!;
  const clients = new Map<string, Client>([[hostSeat, host]]);
  for (const seat of seats) {
    if (seat.id !== hostSeat) clients.set(seat.id, new Client(room.connectLocalSeat(seat.id)));
  }
  return { room, host, hostSeat, clients, seatIds: seats.map((s) => s.id) };
}

/**
 * Chooses the next move using only what each Seat can see in its own latest
 * view, the way a hot-seat UI would pick whose turn or prompt is showing.
 */
export function nextMove(clients: Map<string, Client>): { seat: string; action: Action } | undefined {
  for (const [seat, client] of clients) {
    const view = viewOf(client.last("update"));
    if (view.phase === "gameOver") return undefined;
    const player = "ignored-by-room";
    if (view.phase === "action" && view.activePlayer === seat) {
      const playable = view.hand.find((c) => c.def !== "challenge");
      if (playable) return { seat, action: { type: "PLAY_HERO", player, card: playable.id } };
      return { seat, action: { type: "DRAW_CARD", player } };
    }
    if (view.phase === "responseWindow" && view.responseWindow?.awaiting.includes(seat)) {
      return { seat, action: { type: "PASS", player } };
    }
    if (view.phase === "decision" && view.pendingDecision && "id" in view.pendingDecision) {
      const decision = view.pendingDecision;
      return {
        seat,
        action: { type: "RESOLVE_DECISION", player, decisionId: decision.id, answer: { selected: [decision.options[0]!.id] } },
      };
    }
  }
  throw new Error("nobody can act, but the game is not over");
}
