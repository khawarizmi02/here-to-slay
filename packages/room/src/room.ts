import {
  ClientMsgSchema,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type Action,
  type ClientMsg,
  type ConfigPatch,
  type GameEvent,
  type LobbySeat,
  type PlayerId,
  type PlayerViewPayload,
  type RoomCode,
  type RoomMsg,
  type SeatId,
} from "@here-to-slay/protocol";
import { z } from "zod";
import { LocalConnection } from "./connection.js";

/**
 * The rules engine as the Room uses it (TECHNICAL_DESIGN.md §6.1). Seat ids
 * double as engine player ids.
 */
export interface RoomEngine<State> {
  /** May throw, for example on a config the engine doesn't accept. */
  createGame(opts: { players: { id: PlayerId; name: string; isBot: boolean }[]; seed: string; config: ConfigPatch }): State;
  /** On `ok: false` the state must be left unchanged. */
  applyAction(state: State, action: Action): { ok: boolean; state: State; error?: string; events: GameEvent[] };
  getPlayerView(state: State, player: PlayerId): PlayerViewPayload;
  getPlayerEvents(events: readonly GameEvent[], player: PlayerId): GameEvent[];
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface RoomOptions<State> {
  engine: RoomEngine<State>;
  /** The Room's only source of time. Not read yet: deadlines arrive with response-window timers. */
  clock: Clock;
  /** The Room's only source of randomness, like Math.random: a float in [0, 1). */
  random: () => number;
  /** The Host's name, for the Host's own Seat. */
  hostName: string;
  /** The relay's Room Code. Without one, the Room makes one up from `random`. */
  roomCode?: RoomCode;
}

export const MAX_SEATS = 6;
export const MIN_SEATS_TO_START = 2;

interface Seat {
  id: SeatId;
  name: string;
  kind: "local";
  connection: LocalConnection | null;
}

type Game<State> = { state: State; version: number };

/**
 * One game session, from the lobby through game over, running in the Host's
 * tab (TECHNICAL_DESIGN.md §10). It holds the full game state and talks to
 * every Seat only through connections. It has no DOM or network dependencies.
 */
export class Room<State> {
  readonly roomCode: RoomCode;

  readonly #engine: RoomEngine<State>;
  readonly #random: () => number;
  readonly #seats: Seat[] = [];
  readonly #hostSeat: SeatId;
  #nextSeatNumber = 1;
  #config: ConfigPatch = {};
  #game: Game<State> | null = null;

  /** Incoming messages wait here so a UI that sends while handling a message doesn't re-enter the Room. */
  readonly #inbox: { seat: Seat; connection: LocalConnection; raw: unknown }[] = [];
  #processing = false;
  readonly #errors: unknown[] = [];

  constructor(opts: RoomOptions<State>) {
    this.#engine = opts.engine;
    this.#random = opts.random;
    this.roomCode = opts.roomCode ?? this.#makeRoomCode();
    const host = this.#addSeat(opts.hostName);
    this.#hostSeat = host.id;
    this.#connect(host);
  }

  /**
   * The Host's own UI connection; it sees only the Host's view. If the
   * previous one was closed, a fresh one takes its place.
   */
  get hostConnection(): LocalConnection {
    const host = this.#seats.find((s) => s.id === this.#hostSeat)!;
    return host.connection && !host.connection.closed ? host.connection : this.#connect(host);
  }

  /**
   * A connection for a local Seat, for hot-seat play on the Host's device.
   * Throws if the Seat doesn't exist, isn't local, or is already connected.
   */
  connectLocalSeat(seatId: SeatId): LocalConnection {
    const seat = this.#seats.find((s) => s.id === seatId);
    if (!seat) throw new Error(`No Seat ${seatId}`);
    if (seat.connection && !seat.connection.closed) throw new Error(`Seat ${seatId} is already connected`);
    return this.#connect(seat);
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  #connect(seat: Seat): LocalConnection {
    const connection: LocalConnection = new LocalConnection(
      (raw) => this.#receive(seat, connection, raw),
      () => this.#disconnect(seat, connection),
    );
    seat.connection = connection;
    if (this.#game) {
      this.#sendCurrentUpdate(seat);
    } else {
      this.#broadcastLobby();
    }
    this.#rethrowErrors();
    return connection;
  }

  #disconnect(seat: Seat, connection: LocalConnection): void {
    if (seat.connection !== connection) return;
    seat.connection = null;
    if (!this.#game) this.#broadcastLobby();
    this.#rethrowErrors();
  }

  #receive(seat: Seat, connection: LocalConnection, raw: unknown): void {
    this.#inbox.push({ seat, connection, raw });
    if (this.#processing) return;
    this.#processing = true;
    try {
      for (let next = this.#inbox.shift(); next; next = this.#inbox.shift()) {
        // A message from a connection that has since been replaced or closed is dropped.
        if (next.seat.connection !== next.connection) continue;
        try {
          this.#handle(next.seat, next.raw);
        } catch (e) {
          this.#errors.push(e);
        }
      }
    } finally {
      this.#processing = false;
    }
    this.#rethrowErrors();
  }

  /**
   * Delivers to one Seat. A UI listener that throws must not stop the other
   * Seats getting their message, so its error is kept and rethrown once the
   * Room has finished its work.
   */
  #send(seat: Seat, msg: RoomMsg): void {
    try {
      seat.connection?.deliver(msg);
    } catch (e) {
      this.#errors.push(e);
    }
  }

  #rethrowErrors(): void {
    if (this.#processing || this.#errors.length === 0) return;
    const errors = this.#errors.splice(0);
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Several UI listeners threw");
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  #handle(from: Seat, raw: unknown): void {
    const parsed = ClientMsgSchema.safeParse(raw);
    if (!parsed.success) {
      const error = `Malformed message: ${z.prettifyError(parsed.error)}`;
      const clientSeq = actionClientSeq(raw);
      this.#send(from, clientSeq === undefined ? { t: "error", message: error } : { t: "actionRejected", clientSeq, error });
      return;
    }
    const msg = parsed.data;

    switch (msg.t) {
      case "addLocalSeat":
      case "setConfig":
      case "startGame": {
        const error = this.#lobbyCommand(from, msg);
        if (error) this.#send(from, { t: "error", message: error });
        return;
      }
      case "action": {
        const error = this.#action(from, msg);
        if (error) this.#send(from, { t: "actionRejected", clientSeq: msg.clientSeq, error });
        return;
      }
      case "resync":
        if (this.#game) this.#sendCurrentUpdate(from);
        else this.#sendLobby(from);
        return;
      case "joinRoom":
        this.#send(from, { t: "error", message: "This Seat is already in the Room" });
        return;
      case "addBot":
        this.#send(from, { t: "error", message: "Bot Seats are not supported yet" });
        return;
      case "chat":
        // Chat has no Room → Seat message yet.
        return;
    }
  }

  /** Returns an error message, or undefined on success. */
  #lobbyCommand(from: Seat, msg: Extract<ClientMsg, { t: "addLocalSeat" | "setConfig" | "startGame" }>): string | undefined {
    if (from.id !== this.#hostSeat) return `Only the Host can ${msg.t}`;
    if (this.#game) return "The game has already started";

    switch (msg.t) {
      case "addLocalSeat":
        if (this.#seats.length >= MAX_SEATS) return `A Room has at most ${MAX_SEATS} Seats`;
        this.#addSeat(msg.name);
        this.#broadcastLobby();
        return undefined;

      case "setConfig":
        this.#config = { ...this.#config, ...msg.config };
        return undefined;

      case "startGame": {
        if (this.#seats.length < MIN_SEATS_TO_START) return `The game needs at least ${MIN_SEATS_TO_START} Seats`;
        try {
          const state = this.#engine.createGame({
            players: this.#seats.map((s) => ({ id: s.id, name: s.name, isBot: false })),
            seed: this.#makeSeed(),
            config: { ...this.#config },
          });
          this.#commit(state, [], 0);
        } catch (e) {
          return `Could not start the game: ${errorMessage(e)}`;
        }
        return undefined;
      }
    }
  }

  /** Returns an error message, or undefined on success. */
  #action(from: Seat, msg: Extract<ClientMsg, { t: "action" }>): string | undefined {
    if (msg.seat !== from.id) return `You don't control Seat ${msg.seat}`;
    const game = this.#game;
    if (!game) return "The game has not started";

    // The Seat, not the message, decides who is acting.
    const action = { ...msg.action, player: from.id };
    try {
      const result = this.#engine.applyAction(game.state, action);
      if (!result.ok) return result.error ?? `${action.type} is not a legal action right now`;
      this.#commit(result.state, result.events, game.version);
    } catch (e) {
      return `The engine failed on ${action.type}: ${errorMessage(e)}`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Updates and lobby
  // -------------------------------------------------------------------------

  /**
   * One state change: bump the version and send every connected Seat exactly
   * one update. Every update is built before anything changes, so an engine
   * that throws while building views leaves the Room as it was.
   */
  #commit(state: State, events: GameEvent[], previousVersion: number): void {
    const version = previousVersion + 1;
    const outbox = this.#seats
      .filter((seat) => seat.connection)
      .map((seat) => [seat, this.#update(state, version, seat, this.#engine.getPlayerEvents(events, seat.id))] as const);
    this.#game = { state, version };
    for (const [seat, msg] of outbox) this.#send(seat, msg);
  }

  #sendCurrentUpdate(seat: Seat): void {
    const game = this.#game!;
    this.#send(seat, this.#update(game.state, game.version, seat, []));
  }

  #update(state: State, version: number, seat: Seat, events: GameEvent[]): RoomMsg {
    return { t: "update", version, events, view: this.#engine.getPlayerView(state, seat.id) };
  }

  #broadcastLobby(): void {
    for (const seat of this.#seats) this.#sendLobby(seat);
  }

  #sendLobby(seat: Seat): void {
    const seats: LobbySeat[] = this.#seats.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      connected: s.connection !== null && !s.connection.closed,
    }));
    this.#send(seat, { t: "lobby", roomCode: this.roomCode, seats, you: [seat.id] });
  }

  #addSeat(name: string): Seat {
    const seat: Seat = { id: `s${this.#nextSeatNumber++}`, name, kind: "local", connection: null };
    this.#seats.push(seat);
    return seat;
  }

  // -------------------------------------------------------------------------
  // Randomness
  // -------------------------------------------------------------------------

  #pick(alphabet: string): string {
    return alphabet[Math.floor(this.#random() * alphabet.length)] ?? alphabet[0]!;
  }

  #makeRoomCode(): RoomCode {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += this.#pick(ROOM_CODE_ALPHABET);
    return code;
  }

  #makeSeed(): string {
    let seed = "";
    for (let i = 0; i < 16; i++) seed += this.#pick("0123456789abcdefghijklmnopqrstuvwxyz");
    return seed;
  }
}

/** The clientSeq of something shaped like an action message, so a malformed action can still be answered with actionRejected. */
function actionClientSeq(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { t, clientSeq } = raw as { t?: unknown; clientSeq?: unknown };
  if (t !== "action") return undefined;
  return typeof clientSeq === "number" && Number.isSafeInteger(clientSeq) && clientSeq >= 0 ? clientSeq : undefined;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
