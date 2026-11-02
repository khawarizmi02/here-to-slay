import {
  ClientMsgSchema,
  PlayerNameSchema,
  RoomCodeSchema,
  type ClientMsg,
  type ConfigPatch,
  type GameEvent,
  type LobbySeat,
  type PlayerViewPayload,
  type RoomCode,
  type RoomMsg,
  type SeatId,
  type SeatKind,
} from "@here-to-slay/protocol";
import { LocalConnection, type Deliver, type RoomLink } from "./connection/local-connection.js";
import type { RoomEngine } from "./engine.js";

/** The Room's only source of time. Tests pass a fake one. */
export interface Clock {
  now(): number;
}

/** Returns a float in [0, 1). The Room's only source of randomness outside the engine's seeded RNG. */
export type RandomSource = () => number;

export interface RoomOptions<State, Event extends { type: string }> {
  engine: RoomEngine<State, Event>;
  roomCode: RoomCode;
  /** The Host's name. The Host always has the first Seat, a local one. */
  hostName: string;
  clock: Clock;
  random: RandomSource;
  /** The game seed. Drawn from `random` when omitted. */
  seed?: string;
  /** Starting rule config; the Host can change it in the lobby. */
  config?: ConfigPatch;
}

/** The engine allows at most six players, and so does the lobby message. */
export const MAX_SEATS = 6;
export const MIN_SEATS_TO_START = 2;

interface Seat {
  id: SeatId;
  name: string;
  kind: SeatKind;
}

/** One attached connection, as the Room sees it. */
interface Endpoint {
  /** The Host's own UI: may use lobby controls and act for every local Seat. */
  isHost: boolean;
  /** The Seat whose view and events this connection receives. */
  viewSeat: SeatId;
  deliver: Deliver;
  attached: boolean;
}

/**
 * One game session and its Seats, from the lobby through game over
 * (TECHNICAL_DESIGN.md §10). Runs in the Host's tab and holds the full,
 * unredacted game state. It has no DOM or network dependencies: the clock,
 * the randomness and the engine are passed in.
 *
 * Each connection receives one Seat's view only. The Host's connection gets
 * the Host's view, and can act for any local Seat; a hot-seat UI shows
 * another local player's view through `connectLocalSeat`.
 */
export class Room<State, Event extends { type: string }> {
  readonly roomCode: RoomCode;
  private readonly engine: RoomEngine<State, Event>;
  // Not read yet: response-window deadlines and UI delays (later milestones) use them.
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly seed: string;
  private config: ConfigPatch;

  private readonly seats: Seat[] = [];
  private readonly hostSeat: SeatId;
  private nextSeatNumber = 1;
  private readonly endpoints = new Set<Endpoint>();

  /** Null while in the lobby. */
  private state: State | null = null;
  /** 0 in the lobby; incremented on every game state change. */
  private version = 0;

  // Messages are handled one at a time, and every message a change produces
  // is delivered before the next incoming message is handled, even when a
  // listener sends from inside its callback.
  private readonly inbox: { endpoint: Endpoint; raw: unknown }[] = [];
  private readonly outbox: { endpoint: Endpoint; msg: RoomMsg }[] = [];
  private pumping = false;

  constructor(opts: RoomOptions<State, Event>) {
    this.engine = opts.engine;
    this.roomCode = RoomCodeSchema.parse(opts.roomCode);
    this.clock = opts.clock;
    this.random = opts.random;
    this.seed = opts.seed ?? randomSeed(this.random);
    this.config = { ...opts.config };
    this.hostSeat = this.addSeat(PlayerNameSchema.parse(opts.hostName), "local").id;
  }

  /** A connection for the Host's own UI. */
  connectHost(): LocalConnection {
    return new LocalConnection((deliver) => this.attach({ isHost: true, viewSeat: this.hostSeat, deliver, attached: true }));
  }

  /**
   * A connection for another player at the Host's device. It receives that
   * Seat's view, may act only for that Seat, and can't use lobby controls.
   */
  connectLocalSeat(seat: SeatId): LocalConnection {
    const found = this.seats.find((s) => s.id === seat);
    if (!found || found.kind !== "local") throw new Error(`${seat} is not a local Seat`);
    if (seat === this.hostSeat) throw new Error("Use connectHost() for the Host's Seat");
    return new LocalConnection((deliver) => this.attach({ isHost: false, viewSeat: seat, deliver, attached: true }));
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private attach(endpoint: Endpoint): RoomLink {
    this.endpoints.add(endpoint);
    return {
      receive: (raw) => {
        if (!endpoint.attached) return;
        this.inbox.push({ endpoint, raw });
        this.pump();
      },
      detach: () => {
        endpoint.attached = false;
        this.endpoints.delete(endpoint);
      },
    };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const out = this.outbox.shift();
        if (out) {
          if (out.endpoint.attached) out.endpoint.deliver(out.msg);
          continue;
        }
        const incoming = this.inbox.shift();
        if (!incoming) break;
        this.handle(incoming.endpoint, incoming.raw);
      }
    } finally {
      this.pumping = false;
    }
  }

  private handle(from: Endpoint, raw: unknown): void {
    const parsed = ClientMsgSchema.safeParse(raw);
    if (!parsed.success) {
      const error = `Malformed message: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
      const clientSeq = actionClientSeq(raw);
      this.send(from, clientSeq === undefined ? { t: "error", message: error } : { t: "actionRejected", clientSeq, error });
      return;
    }
    const msg = parsed.data;
    switch (msg.t) {
      case "joinRoom":
        // Remote players join through the relay (a later milestone). A local
        // connection is already seated.
        return this.send(from, { t: "error", message: "This connection already has a Seat" });
      case "addBot":
        if (!this.checkLobbyCommand(from, msg)) return;
        return this.send(from, { t: "error", message: "Bot Seats are not supported yet" });
      case "addLocalSeat":
        if (!this.checkLobbyCommand(from, msg)) return;
        if (this.seats.length >= MAX_SEATS) {
          return this.send(from, { t: "error", message: `A Room has at most ${MAX_SEATS} Seats` });
        }
        this.addSeat(msg.name, "local");
        return this.broadcastLobby();
      case "setConfig":
        if (!this.checkLobbyCommand(from, msg)) return;
        this.config = { ...this.config, ...msg.config };
        return;
      case "startGame":
        if (!this.checkLobbyCommand(from, msg)) return;
        return this.startGame(from);
      case "action":
        return this.handleAction(from, msg);
      case "resync":
        this.send(from, this.lobbyMsg(from));
        if (this.state !== null) this.send(from, this.updateMsg(from.viewSeat, []));
        return;
      case "chat":
        // Chat has no Room → Seat message yet.
        return;
    }
  }

  /** Lobby controls are Host-only and only work before the game starts. */
  private checkLobbyCommand(from: Endpoint, msg: ClientMsg): boolean {
    if (!from.isHost) {
      this.send(from, { t: "error", message: `Only the Host can use ${msg.t}` });
      return false;
    }
    if (this.state !== null) {
      this.send(from, { t: "error", message: `${msg.t} is only allowed in the lobby` });
      return false;
    }
    return true;
  }

  private startGame(from: Endpoint): void {
    if (this.seats.length < MIN_SEATS_TO_START) {
      return this.send(from, { t: "error", message: `At least ${MIN_SEATS_TO_START} Seats are needed to start` });
    }
    try {
      this.state = this.engine.createGame({
        players: this.seats.map((s) => ({ id: s.id, name: s.name, isBot: s.kind === "bot" })),
        seed: this.seed,
        config: { ...this.config },
      });
    } catch (e) {
      return this.send(from, { t: "error", message: `Could not start the game: ${e instanceof Error ? e.message : String(e)}` });
    }
    this.version = 1;
    this.broadcastUpdate([]);
  }

  private handleAction(from: Endpoint, msg: Extract<ClientMsg, { t: "action" }>): void {
    const reject = (error: string) => this.send(from, { t: "actionRejected", clientSeq: msg.clientSeq, error });
    if (this.state === null) return reject("The game has not started");
    if (!this.owns(from, msg.seat)) return reject(`This connection can't act for Seat ${msg.seat}`);

    // The acting player comes from the Seat, never from the client's claim.
    const action = { ...msg.action, player: msg.seat };
    const result = this.engine.applyAction(this.state, action);
    if (!result.ok) return reject(result.error ?? "Illegal action");

    this.state = result.state;
    this.version += 1;
    this.broadcastUpdate(result.events);
  }

  private owns(endpoint: Endpoint, seatId: SeatId): boolean {
    const seat = this.seats.find((s) => s.id === seatId);
    if (!seat) return false;
    if (endpoint.isHost) return seat.kind === "local";
    return seat.id === endpoint.viewSeat;
  }

  // -------------------------------------------------------------------------
  // Outgoing messages
  // -------------------------------------------------------------------------

  private send(to: Endpoint, msg: RoomMsg): void {
    this.outbox.push({ endpoint: to, msg });
  }

  private broadcastLobby(): void {
    for (const endpoint of this.endpoints) this.send(endpoint, this.lobbyMsg(endpoint));
  }

  /** Every attached connection gets exactly one update, for its own Seat. */
  private broadcastUpdate(events: readonly Event[]): void {
    const perSeat = new Map<SeatId, RoomMsg>();
    for (const endpoint of this.endpoints) {
      let msg = perSeat.get(endpoint.viewSeat);
      if (!msg) {
        msg = this.updateMsg(endpoint.viewSeat, events);
        perSeat.set(endpoint.viewSeat, msg);
      }
      this.send(endpoint, msg);
    }
  }

  private updateMsg(seat: SeatId, events: readonly Event[]): RoomMsg {
    const state = this.state as State;
    return {
      t: "update",
      version: this.version,
      events: this.engine.getPlayerEvents(events, seat) as unknown as GameEvent[],
      view: this.engine.getPlayerView(state, seat) as PlayerViewPayload,
    };
  }

  private lobbyMsg(endpoint: Endpoint): RoomMsg {
    const seats: LobbySeat[] = this.seats.map((s) => ({ id: s.id, name: s.name, kind: s.kind, connected: true }));
    return {
      t: "lobby",
      roomCode: this.roomCode,
      seats,
      you: this.seats.filter((s) => this.owns(endpoint, s.id)).map((s) => s.id),
    };
  }

  private addSeat(name: string, kind: SeatKind): Seat {
    const seat = { id: `s${this.nextSeatNumber++}`, name, kind };
    this.seats.push(seat);
    return seat;
  }
}

/** The clientSeq of a malformed `action` message, if it has a usable one. */
function actionClientSeq(raw: unknown): number | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const { t, clientSeq } = raw as { t?: unknown; clientSeq?: unknown };
  if (t !== "action") return undefined;
  return typeof clientSeq === "number" && Number.isInteger(clientSeq) && clientSeq >= 0 ? clientSeq : undefined;
}

function randomSeed(random: RandomSource): string {
  let seed = "";
  for (let i = 0; i < 16; i++) seed += Math.floor(random() * 36).toString(36);
  return seed;
}
