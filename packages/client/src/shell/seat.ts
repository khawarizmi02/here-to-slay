import type { Action, ClientMsg, ConfigPatch, GameEvent, LobbySeat, PlayerViewPayload, RoomMsg, SeatId } from "@here-to-slay/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { LaunchedSeat } from "./game.js";
import { createPlayback } from "./playback.js";

/** What one Seat on this device knows, built only from the messages its connection receives. */
export interface SeatState {
  /** The Seat this connection belongs to, once a lobby or a view has said. */
  seatId: SeatId | null;
  /** The lobby's Seats, until the game starts. */
  lobby: LobbySeat[] | null;
  /** The PlayerView on show: the latest, once the animation queue has played what came before it. The shell never reads inside it. */
  view: PlayerViewPayload | null;
  /** Every event played or shown since this connection opened, oldest first, as the Room filtered them for this Seat. */
  log: GameEvent[];
  /** The event the animation queue is playing now, the last in `log`, or null when nothing is playing. */
  playing: GameEvent | null;
  /** The Seat's options in a response window, from the Room's `respond`. Cleared by the next update. */
  responseOptions: Action[] | null;
  /** When the Room answers for this remote Seat (a `Date.now()` time), from its latest `countdown`. Cleared by the next update. */
  deadline: number | null;
  /** The Room's latest refusal, cleared by the next lobby or update, or when the player asks for something else. */
  error: string | null;
  /** Whether the relay says the Host is away: nothing happens until it is back. */
  hostAway: boolean;
}

/** What the device hears from one of its Seats. */
export interface SeatListener {
  /** The Room asks this Seat to respond, once its player has the device. */
  passDevice(): void;
  /** The Seat has a new view. */
  update(view: PlayerViewPayload): void;
  /** The Room has closed: nothing more will come. */
  roomClosed(): void;
}

/** One Seat on this device: its state, and everything it can ask of the Room. */
export interface DeviceSeat {
  readonly name: string;
  /** Whether this is the Host's own Seat. */
  readonly host: boolean;
  /** Whether this is a friend's Seat behind the relay, asked to respond through its view. */
  readonly remote: boolean;
  readonly store: StoreApi<SeatState>;
  /**
   * Starts handling the Room's messages, including any that arrived
   * before, and tells `listener` about the ones the device acts on.
   */
  listen(listener: SeatListener): void;
  addLocalSeat(name: string): void;
  addBot(): void;
  setConfig(config: ConfigPatch): void;
  startGame(): void;
  act(action: Action): void;
  /** Tells the Room the player it asked to respond has the device. */
  confirmPassDevice(): void;
  /** Whether updates animate, as they do only for the Seat on screen. Turning it off shows the latest view at once. */
  setAnimated(animated: boolean): void;
  /** How long each of its events plays before the next, in ms. */
  setEventMs(ms: number): void;
  close(): void;
}

/** Wraps one local Seat's connection. `viewer` names the Seat a view belongs to. */
export function connectSeat(
  { connection, name, host = false, seatId, remote = false }: LaunchedSeat,
  viewer: (view: PlayerViewPayload) => SeatId | null,
): DeviceSeat {
  const store = createStore<SeatState>()(() => ({
    seatId: seatId ?? null,
    lobby: null,
    view: null,
    log: [],
    playing: null,
    responseOptions: null,
    deadline: null,
    error: null,
    hostAway: false,
  }));
  const playback = createPlayback((shown) => store.setState(shown), () => store.getState());
  let clientSeq = 0;
  let unsubscribe = () => {};
  /** Sends what the player asked for. A refusal of their last request no longer applies, so its reason goes. */
  const send = (msg: ClientMsg) => {
    store.setState({ error: null });
    connection.send(msg);
  };
  const withSeat = (cb: (seat: SeatId) => void) => {
    const seat = store.getState().seatId;
    if (seat !== null) cb(seat);
  };

  function handle(msg: RoomMsg, listener: SeatListener): void {
    switch (msg.t) {
      case "lobby":
        store.setState({ seatId: msg.you[0] ?? null, lobby: msg.seats, error: null });
        return;
      case "update":
        // What the update replaces goes now: a countdown or respond after it mustn't wait behind its animation.
        store.setState((s) => ({ seatId: s.seatId ?? viewer(msg.view), responseOptions: null, deadline: null, error: null }));
        playback.receive(msg);
        listener.update(msg.view);
        return;
      case "passDevice":
        listener.passDevice();
        return;
      case "respond":
        store.setState({ responseOptions: msg.actions });
        return;
      case "countdown":
        store.setState({ deadline: Date.now() + msg.ms });
        return;
      case "actionRejected":
        store.setState({ error: msg.error });
        return;
      case "error":
        store.setState({ error: msg.message });
        return;
      case "hostAway":
        store.setState({ hostAway: true });
        return;
      case "hostBack":
        store.setState({ hostAway: false });
        return;
      case "roomClosed":
        listener.roomClosed();
        return;
    }
  }

  return {
    name,
    host,
    remote,
    store,
    listen(listener) {
      unsubscribe = connection.onMessage((msg) => handle(msg, listener));
    },
    addLocalSeat: (name) => send({ t: "addLocalSeat", name }),
    addBot: () => send({ t: "addBot", difficulty: "easy" }),
    setConfig: (config) => send({ t: "setConfig", config }),
    startGame: () => send({ t: "startGame" }),
    act(action) {
      withSeat((seat) => send({ t: "action", seat, action, clientSeq: clientSeq++ }));
    },
    confirmPassDevice() {
      withSeat((seat) => send({ t: "confirmPassDevice", seat }));
    },
    setAnimated: (animated) => playback.setAnimated(animated),
    setEventMs: (ms) => playback.setEventMs(ms),
    close() {
      playback.stop();
      unsubscribe();
      connection.close();
    },
  };
}
