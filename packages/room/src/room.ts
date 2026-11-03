import {
  ClientMsgSchema,
  RelayToHostFrameSchema,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type Action,
  type ClientMsg,
  type ConfigPatch,
  type GameEvent,
  type HostToRelayFrame,
  type LobbySeat,
  type PlayerId,
  type PlayerViewPayload,
  type RoomCode,
  type RoomMsg,
  type SeatId,
  type SeatKind,
  type SeatToken,
} from "@here-to-slay/protocol";
import { z } from "zod";
import { randomBot, type Bot, type BotDifficulty, type BotFactory } from "./bot.js";
import { LocalConnection } from "./connection.js";
import { RoomRecordSchema, type ActionLogStore, type RecordSeat, type RoomRecord } from "./record.js";
import type { RelaySocket } from "./relay-connection.js";

/**
 * The rules engine as the Room uses it (TECHNICAL_DESIGN.md §6.1). Seat ids
 * double as engine player ids.
 */
export interface RoomEngine<State> {
  /** Saved with the action log: a replay reproduces the game only under the same card definitions. */
  readonly cardDefsVersion: string;
  /** May throw, for example on a config the engine doesn't accept. */
  createGame(opts: { players: { id: PlayerId; name: string; isBot: boolean }[]; seed: string; config: ConfigPatch }): State;
  /** On `ok: false` the state must be left unchanged. */
  applyAction(state: State, action: Action): { ok: boolean; state: State; error?: string; events: GameEvent[] };
  /** Every action `player` may take now, including answers to its pending decision. Bots choose from these. */
  getLegalActions(state: State, player: PlayerId): Action[];
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
  /** Makes the bot for each bot Seat. Without one, every bot picks a random legal action using `random`. */
  bot?: BotFactory;
  /**
   * Where the Room saves its record after every applied action, so a Host
   * refresh can rebuild the game with `Room.restore`. Without one, nothing is saved.
   */
  store?: ActionLogStore;
}

export const MAX_SEATS = 6;
export const MIN_SEATS_TO_START = 2;

/**
 * The Host's WebSocket to the relay (TECHNICAL_DESIGN.md §10.5). Replaced as
 * a whole when the Host attaches a new one; a detached one is never used again.
 */
class HostRelay {
  detached = false;

  constructor(readonly socket: RelaySocket) {}

  send(to: SeatToken, msg: RoomMsg): void {
    if (this.detached) return;
    // Always addressed to one seat token, never "all": every Seat's messages are its own (§9).
    this.socket.send(JSON.stringify({ to, payload: msg } satisfies HostToRelayFrame));
  }
}

/** A remote Seat's link to its friend, through one relay attachment. */
class RemotePeer {
  #closed = false;

  constructor(
    readonly relay: HostRelay,
    readonly seatToken: SeatToken,
  ) {}

  get closed(): boolean {
    return this.#closed || this.relay.detached;
  }

  close(): void {
    this.#closed = true;
  }

  deliver(msg: RoomMsg): void {
    if (!this.closed) this.relay.send(this.seatToken, msg);
  }
}

interface Seat {
  id: SeatId;
  name: string;
  kind: SeatKind;
  /** Always null for a bot Seat: the Room calls its bot directly. */
  connection: LocalConnection | RemotePeer | null;
  /** Set only for a bot Seat. */
  bot: Bot | null;
  difficulty: BotDifficulty | null;
  /** Set only for a remote Seat: the relay stamps it on every message from that Seat's friend. */
  seatToken: SeatToken | null;
}

type InboxItem =
  | { from: "seat"; seat: Seat; connection: LocalConnection | RemotePeer; raw: unknown }
  | { from: "relay"; relay: HostRelay; frame: string }
  | { from: "relayClosed"; relay: HostRelay };

interface Game<State> {
  state: State;
  version: number;
  seed: string;
  config: ConfigPatch;
  /** Every applied action since the start, in order: version is always `actions.length + 1`. */
  actions: Action[];
}

/**
 * One game session, from the lobby through game over, running in the Host's
 * tab (TECHNICAL_DESIGN.md §10). It holds the full game state and talks to
 * every Seat only through connections. It has no DOM or network dependencies.
 */
export class Room<State> {
  readonly roomCode: RoomCode;

  readonly #engine: RoomEngine<State>;
  readonly #random: () => number;
  readonly #makeBot: BotFactory;
  readonly #store: ActionLogStore | null;
  /** Settles once every save made so far has settled. */
  #saving: Promise<void> = Promise.resolve();
  #saveError: unknown = null;
  readonly #seats: Seat[] = [];
  /** The first Seat is always the Host's. */
  readonly #hostSeat: SeatId;
  #nextSeatNumber = 1;
  #botCount = 0;
  #config: ConfigPatch = {};
  #game: Game<State> | null = null;

  /** The Host's current connection to the relay, if any. */
  #relay: HostRelay | null = null;

  /** Incoming messages wait here so a UI that sends while handling a message doesn't re-enter the Room. */
  readonly #inbox: InboxItem[] = [];
  #processing = false;
  readonly #errors: unknown[] = [];

  constructor(opts: RoomOptions<State>);
  /** @internal Used by `Room.restore`. */
  constructor(opts: RoomOptions<State>, restoring: RoomRecord);
  constructor(opts: RoomOptions<State>, restoring?: RoomRecord) {
    this.#engine = opts.engine;
    this.#random = opts.random;
    this.#makeBot = opts.bot ?? (() => randomBot(this.#random));
    this.#store = opts.store ?? null;
    this.roomCode = opts.roomCode ?? this.#makeRoomCode();
    if (restoring) {
      this.#replay(restoring);
    } else {
      this.#addSeat(opts.hostName);
    }
    const host = this.#seats[0]!;
    this.#hostSeat = host.id;
    this.#connect(host);
    // The log may stop on a bot's move, if the tab died before the bot's reply was saved.
    if (restoring) this.#run();
  }

  /**
   * Rebuilds a Room from its saved record after the Host's tab reloads
   * (TECHNICAL_DESIGN.md §10.7): the same Room Code and Seats, and the game
   * state reached by replaying every logged action. Each Seat gets a fresh
   * `update` when it connects, and the Room keeps saving to `opts.store`.
   *
   * Throws if the record is malformed, was made with other card
   * definitions, or doesn't replay.
   */
  static restore<State>(opts: Omit<RoomOptions<State>, "hostName" | "roomCode">, record: RoomRecord): Room<State> {
    const parsed = RoomRecordSchema.parse(record);
    return new Room({ ...opts, hostName: parsed.seats[0]!.name, roomCode: parsed.roomCode }, parsed);
  }

  /** Recreates the Seats and replays the game from a record. Called only from the constructor. */
  #replay(record: RoomRecord): void {
    if (record.cardDefsVersion !== this.#engine.cardDefsVersion) {
      throw new Error(
        `This game was saved with card definitions ${record.cardDefsVersion}, but the engine has ${this.#engine.cardDefsVersion}`,
      );
    }
    for (const seat of record.seats) {
      // No Seat can be added once the game has started, so the Seat counters needn't be restored.
      this.#seats.push(
        seat.kind === "bot"
          ? { ...seat, connection: null, bot: this.#makeBot({ id: seat.id, difficulty: seat.difficulty }), seatToken: null }
          : seat.kind === "remote"
            ? { ...seat, connection: null, bot: null, difficulty: null, seatToken: seat.seatToken ?? null }
            : { ...seat, connection: null, bot: null, difficulty: null, seatToken: null },
      );
    }

    let state = this.#engine.createGame({
      players: this.#seats.map((s) => ({ id: s.id, name: s.name, isBot: s.kind === "bot" })),
      seed: record.seed,
      config: { ...record.config },
    });
    record.actions.forEach((action, i) => {
      const result = this.#engine.applyAction(state, action);
      if (!result.ok) {
        throw new Error(`The saved game doesn't replay: action ${i + 1} (${action.type}) was rejected: ${result.error ?? "illegal"}`);
      }
      state = result.state;
    });
    this.#game = { state, version: record.actions.length + 1, seed: record.seed, config: record.config, actions: [...record.actions] };
  }

  /**
   * The Host's own UI connection; it sees only the Host's view. If the
   * previous one was closed, a fresh one takes its place.
   */
  get hostConnection(): LocalConnection {
    const host = this.#seats.find((s) => s.id === this.#hostSeat)!;
    return host.connection instanceof LocalConnection && !host.connection.closed ? host.connection : this.#connect(host);
  }

  /**
   * A connection for a local Seat, for hot-seat play on the Host's device.
   * Throws if the Seat doesn't exist, isn't local, or is already connected.
   */
  connectLocalSeat(seatId: SeatId): LocalConnection {
    const seat = this.#seats.find((s) => s.id === seatId);
    if (!seat) throw new Error(`No Seat ${seatId}`);
    if (seat.kind !== "local") throw new Error(`Seat ${seatId} is not a local Seat`);
    if (seat.connection && !seat.connection.closed) throw new Error(`Seat ${seatId} is already connected`);
    return this.#connect(seat);
  }

  /**
   * Connects the Room to the relay through the Host's WebSocket, so friends
   * can join and play remote Seats (TECHNICAL_DESIGN.md §10.2). The Room
   * trusts only the seat token the relay stamps on each message: it maps the
   * token to a Seat, and a token without a Seat may only `joinRoom`.
   * Attaching a new socket (after the old one dropped) replaces the old one.
   */
  attachRelay(socket: RelaySocket): void {
    if (this.#relay) this.#detachRelay(this.#relay);
    const relay = new HostRelay(socket);
    this.#relay = relay;
    socket.onMessage((frame) => {
      this.#inbox.push({ from: "relay", relay, frame });
      this.#run();
    });
    socket.onClose(() => {
      this.#inbox.push({ from: "relayClosed", relay });
      this.#run();
    });
    this.#rethrowErrors();
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

  #disconnect(seat: Seat, connection: LocalConnection | RemotePeer): void {
    if (seat.connection !== connection) return;
    if (connection instanceof RemotePeer) connection.close();
    seat.connection = null;
    if (!this.#game) this.#broadcastLobby();
    this.#rethrowErrors();
  }

  #receive(seat: Seat, connection: LocalConnection, raw: unknown): void {
    this.#inbox.push({ from: "seat", seat, connection, raw });
    this.#run();
  }

  #connectRemote(seat: Seat, relay: HostRelay): void {
    seat.connection = new RemotePeer(relay, seat.seatToken!);
    if (this.#game) this.#sendCurrentUpdate(seat);
    else this.#broadcastLobby();
  }

  /** Every remote Seat loses its friend along with the relay. */
  #detachRelay(relay: HostRelay): void {
    relay.detached = true;
    if (this.#relay === relay) this.#relay = null;
    for (const seat of this.#seats) {
      if (seat.connection instanceof RemotePeer && seat.connection.relay === relay) seat.connection = null;
    }
    if (!this.#game) this.#broadcastLobby();
  }

  /** One frame from the relay. Frames from a relay socket that has since been replaced are dropped. */
  #relayFrame(relay: HostRelay, data: string): void {
    if (relay !== this.#relay) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    // The relay is ours, so a frame it would never send is ignored rather than answered.
    const parsed = RelayToHostFrameSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;

    switch (frame.kind) {
      case "peerJoined": {
        const seat = this.#remoteSeat(frame.seatToken);
        if (seat) this.#connectRemote(seat, relay);
        return;
      }
      case "peerLeft": {
        const seat = this.#remoteSeat(frame.seatToken);
        if (!seat) return;
        if (!this.#game) {
          // In the lobby a friend who leaves gives up their Seat, so it can't block the table.
          // Coming back is just joining again: RelayConnection always sends joinRoom.
          this.#seats.splice(this.#seats.indexOf(seat), 1);
          this.#broadcastLobby();
        } else if (seat.connection) {
          this.#disconnect(seat, seat.connection);
        }
        return;
      }
      case "tick":
        return;
      case "msg": {
        const seat = this.#remoteSeat(frame.from);
        if (!seat) {
          this.#stranger(relay, frame.from, frame.payload);
          return;
        }
        if (!(seat.connection instanceof RemotePeer) || seat.connection.closed) this.#connectRemote(seat, relay);
        this.#handle(seat, frame.payload);
        return;
      }
    }
  }

  #remoteSeat(seatToken: SeatToken): Seat | undefined {
    return this.#seats.find((s) => s.kind === "remote" && s.seatToken === seatToken);
  }

  /** A message from a seat token with no Seat yet: only `joinRoom` is accepted. */
  #stranger(relay: HostRelay, seatToken: SeatToken, raw: unknown): void {
    const reply = (msg: RoomMsg) => relay.send(seatToken, msg);
    const parsed = ClientMsgSchema.safeParse(raw);
    if (!parsed.success) {
      reply(malformed(raw, parsed.error));
      return;
    }
    const msg = parsed.data;
    if (msg.t !== "joinRoom") {
      const error = "Join the Room first";
      reply(msg.t === "action" ? { t: "actionRejected", clientSeq: msg.clientSeq, error } : { t: "error", message: error });
      return;
    }
    if (this.#game) return reply({ t: "error", message: "The game has already started" });
    if (this.#seats.length >= MAX_SEATS) return reply({ t: "error", message: `The Room is full: it has at most ${MAX_SEATS} Seats` });
    this.#connectRemote(this.#addSeat(msg.name, "remote", seatToken), relay);
  }

  /** Works through the inbox and the bots until nothing is left to do. */
  #run(): void {
    if (this.#processing) return;
    this.#processing = true;
    try {
      // Messages first, in arrival order; once none are waiting, one bot move, then look again.
      for (;;) {
        const next = this.#inbox.shift();
        if (!next) {
          if (this.#stepBot()) continue;
          break;
        }
        try {
          if (next.from === "relay") this.#relayFrame(next.relay, next.frame);
          else if (next.from === "relayClosed") this.#detachRelay(next.relay);
          // A message from a connection that has since been replaced or closed is dropped.
          else if (next.seat.connection === next.connection) this.#handle(next.seat, next.raw);
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
      this.#send(from, malformed(raw, parsed.error));
      return;
    }
    const msg = parsed.data;

    switch (msg.t) {
      case "addLocalSeat":
      case "addBot":
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
        this.#sendCurrent(from);
        return;
      case "joinRoom":
        // A friend joining again (say, after a refresh) just gets the Seat's current state.
        if (from.kind === "remote") this.#sendCurrent(from);
        else this.#send(from, { t: "error", message: "This Seat is already in the Room" });
        return;
      case "chat":
        // Chat has no Room → Seat message yet.
        return;
    }
  }

  /** Returns an error message, or undefined on success. */
  #lobbyCommand(from: Seat, msg: Extract<ClientMsg, { t: "addLocalSeat" | "addBot" | "setConfig" | "startGame" }>): string | undefined {
    if (from.id !== this.#hostSeat) return `Only the Host can ${msg.t}`;
    if (this.#game) return "The game has already started";

    switch (msg.t) {
      case "addLocalSeat":
        if (this.#seats.length >= MAX_SEATS) return `A Room has at most ${MAX_SEATS} Seats`;
        this.#addSeat(msg.name);
        this.#broadcastLobby();
        return undefined;

      case "addBot":
        if (this.#seats.length >= MAX_SEATS) return `A Room has at most ${MAX_SEATS} Seats`;
        this.#addBotSeat(msg.difficulty);
        this.#broadcastLobby();
        return undefined;

      case "setConfig":
        this.#config = { ...this.#config, ...msg.config };
        return undefined;

      case "startGame": {
        if (this.#seats.length < MIN_SEATS_TO_START) return `The game needs at least ${MIN_SEATS_TO_START} Seats`;
        try {
          const seed = this.#makeSeed();
          const config = { ...this.#config };
          const state = this.#engine.createGame({
            players: this.#seats.map((s) => ({ id: s.id, name: s.name, isBot: s.kind === "bot" })),
            seed,
            config: { ...config },
          });
          this.#commit({ state, version: 1, seed, config, actions: [] }, [], null);
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
    return this.#apply(game, { ...msg.action, player: from.id });
  }

  /** Applies an action and commits the result. Returns an error message, or undefined on success. */
  #apply(game: Game<State>, action: Action): string | undefined {
    try {
      const result = this.#engine.applyAction(game.state, action);
      if (!result.ok) return result.error ?? `${action.type} is not a legal action right now`;
      this.#commit({ ...game, state: result.state, version: game.version + 1 }, result.events, copy(action));
    } catch (e) {
      return `The engine failed on ${action.type}: ${errorMessage(e)}`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Bots
  // -------------------------------------------------------------------------

  /**
   * Makes one move for the first bot Seat, in Seat order, that has something
   * to do. Returns whether a bot moved. A bot that fails, or picks an action
   * that isn't legal, is a bug: its error is reported and the bots stop
   * until the next message, so a broken bot can't loop forever.
   */
  #stepBot(): boolean {
    const game = this.#game;
    if (!game) return false;
    for (const seat of this.#seats) {
      if (!seat.bot) continue;
      try {
        const legal = this.#engine.getLegalActions(game.state, seat.id);
        if (legal.length === 0) continue;
        // Copies, so a bot can't reach into the game state.
        const view = copy(this.#engine.getPlayerView(game.state, seat.id));
        const choice = seat.bot.chooseAction(view, copy(legal));
        if (!legal.some((a) => canonical(a) === canonical(choice))) {
          throw new Error(`${seat.name} chose an action that isn't legal: ${JSON.stringify(choice)}`);
        }
        const error = this.#apply(game, { ...choice, player: seat.id });
        if (error) throw new Error(`${seat.name}'s ${choice.type} was rejected: ${error}`);
        return true;
      } catch (e) {
        this.#errors.push(e);
        return false;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Action log
  // -------------------------------------------------------------------------

  /**
   * Resolves once every save made so far has landed in the store. Rejects
   * with the first failed save since the last call; the game carries on
   * either way, and the next save writes the whole record again.
   */
  async whenSaved(): Promise<void> {
    await this.#saving;
    const error = this.#saveError;
    this.#saveError = null;
    if (error !== null) throw error;
  }

  /**
   * The game's replay as a JSON file, for the Host to download at game over
   * (TECHNICAL_DESIGN.md §10.7). Its contents are the saved record, so
   * `Room.restore` replays it. The Room has no DOM: the Host's UI turns this
   * into a download. Null before the game starts.
   */
  replayFile(): { filename: string; mimeType: "application/json"; contents: string } | null {
    if (!this.#game) return null;
    return {
      filename: `here-to-slay-${this.roomCode}.json`,
      mimeType: "application/json",
      // Without seat tokens: the file may be shared, and a token would let its reader act for that friend.
      contents: JSON.stringify(withoutSeatTokens(this.#recordOf(this.#game)), null, 2),
    };
  }

  #recordOf(game: Game<State>): RoomRecord {
    return {
      roomCode: this.roomCode,
      seed: game.seed,
      config: game.config,
      seats: this.#seats.map((s): RecordSeat => {
        switch (s.kind) {
          case "bot":
            return { id: s.id, name: s.name, kind: "bot", difficulty: s.difficulty! };
          case "remote":
            return { id: s.id, name: s.name, kind: "remote", seatToken: s.seatToken! };
          case "local":
            return { id: s.id, name: s.name, kind: "local" };
        }
      }),
      cardDefsVersion: this.#engine.cardDefsVersion,
      actions: game.actions,
    };
  }

  #save(game: Game<State>): void {
    const store = this.#store;
    if (!store) return;
    let saved: Promise<void>;
    try {
      // The store copies the record before save returns, so the live action list is safe to hand over.
      saved = store.save(this.#recordOf(game));
    } catch (e) {
      saved = Promise.reject(e);
    }
    this.#saving = Promise.all([this.#saving, saved.catch((e: unknown) => {
      this.#saveError ??= e;
    })]).then(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Updates and lobby
  // -------------------------------------------------------------------------

  /**
   * One state change: log `action`, save, and send every connected Seat
   * exactly one update for the new version. Every update is built before
   * anything changes, so an engine that throws while building views leaves
   * the Room as it was.
   */
  #commit(next: Game<State>, events: GameEvent[], action: Action | null): void {
    const outbox = this.#seats
      .filter((seat) => seat.connection)
      .map((seat) => [seat, this.#update(next.state, next.version, seat, this.#engine.getPlayerEvents(events, seat.id))] as const);
    if (action) next.actions.push(action);
    this.#game = next;
    this.#save(next);
    for (const [seat, msg] of outbox) this.#send(seat, msg);
  }

  #sendCurrent(seat: Seat): void {
    if (this.#game) this.#sendCurrentUpdate(seat);
    else this.#sendLobby(seat);
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
      // A bot is always present: it lives inside the Room.
      connected: s.kind === "bot" || (s.connection !== null && !s.connection.closed),
    }));
    this.#send(seat, { t: "lobby", roomCode: this.roomCode, seats, you: [seat.id] });
  }

  #addSeat(name: string, kind: "local" | "remote" = "local", seatToken: SeatToken | null = null): Seat {
    const seat: Seat = { id: `s${this.#nextSeatNumber++}`, name, kind, connection: null, bot: null, difficulty: null, seatToken };
    this.#seats.push(seat);
    return seat;
  }

  #addBotSeat(difficulty: BotDifficulty): void {
    const id = `s${this.#nextSeatNumber++}`;
    const bot = this.#makeBot({ id, difficulty });
    this.#seats.push({ id, name: `Bot ${++this.#botCount}`, kind: "bot", connection: null, bot, difficulty, seatToken: null });
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

function withoutSeatTokens(record: RoomRecord): RoomRecord {
  return { ...record, seats: record.seats.map((s) => (s.kind === "remote" ? { id: s.id, name: s.name, kind: s.kind } : s)) };
}

/** The answer to a message that isn't a valid ClientMsg. */
function malformed(raw: unknown, error: z.ZodError): RoomMsg {
  const message = `Malformed message: ${z.prettifyError(error)}`;
  const clientSeq = actionClientSeq(raw);
  return clientSeq === undefined ? { t: "error", message } : { t: "actionRejected", clientSeq, error: message };
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

/** A key-order-independent encoding, for comparing a bot's choice with the legal actions. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
