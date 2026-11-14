import type { Action, ClientMsg, LobbySeat, PlayerViewPayload, RoomMsg, SeatId } from "@here-to-slay/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { LaunchedSeat } from "./game.js";

/** What one Seat on this device knows, built only from the messages its connection receives. */
export interface SeatState {
  /** The Seat this connection belongs to, once the Room has said. */
  seatId: SeatId | null;
  /** The lobby's Seats, until the game starts. */
  lobby: LobbySeat[] | null;
  /** The Seat's latest PlayerView. The shell never reads inside it. */
  view: PlayerViewPayload | null;
  /** The Seat's options in a response window, from the Room's `respond`. Cleared by the next update. */
  responseOptions: Action[] | null;
  /** The Room's latest refusal, cleared by the next lobby or update. */
  error: string | null;
}

/** What the device hears from one of its Seats. */
export interface SeatListener {
  /** The Room asks this Seat to respond, once its player has the device. */
  passDevice(): void;
  /** The Seat has a new view. */
  update(view: PlayerViewPayload): void;
}

/** One Seat on this device: its state, and everything it can ask of the Room. */
export interface DeviceSeat {
  readonly name: string;
  readonly store: StoreApi<SeatState>;
  /**
   * Starts handling the Room's messages, including any that arrived
   * before, and tells `listener` about the ones the device acts on.
   */
  listen(listener: SeatListener): void;
  addLocalSeat(name: string): void;
  addBot(): void;
  startGame(): void;
  act(action: Action): void;
  /** Tells the Room the player it asked to respond has the device. */
  confirmPassDevice(): void;
  close(): void;
}

/** Wraps one local Seat's connection. */
export function connectSeat({ connection, name, seatId }: LaunchedSeat): DeviceSeat {
  const store = createStore<SeatState>()(() => ({ seatId: seatId ?? null, lobby: null, view: null, responseOptions: null, error: null }));
  let clientSeq = 0;
  let unsubscribe = () => {};
  const send = (msg: ClientMsg) => connection.send(msg);
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
        store.setState({ view: msg.view, responseOptions: null, error: null });
        listener.update(msg.view);
        return;
      case "passDevice":
        listener.passDevice();
        return;
      case "respond":
        store.setState({ responseOptions: msg.actions });
        return;
      case "actionRejected":
        store.setState({ error: msg.error });
        return;
      case "error":
        store.setState({ error: msg.message });
        return;
      default:
        // Messages for remote Seats (countdown, host away and back) aren't shown yet.
        return;
    }
  }

  return {
    name,
    store,
    listen(listener) {
      unsubscribe = connection.onMessage((msg) => handle(msg, listener));
    },
    addLocalSeat: (name) => send({ t: "addLocalSeat", name }),
    addBot: () => send({ t: "addBot", difficulty: "easy" }),
    startGame: () => send({ t: "startGame" }),
    act(action) {
      withSeat((seat) => send({ t: "action", seat, action, clientSeq: clientSeq++ }));
    },
    confirmPassDevice() {
      withSeat((seat) => send({ t: "confirmPassDevice", seat }));
    },
    close() {
      unsubscribe();
      connection.close();
    },
  };
}
