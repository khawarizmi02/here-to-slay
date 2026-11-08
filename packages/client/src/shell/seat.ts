import type { Action, ClientMsg, LobbySeat, PlayerViewPayload, RoomMsg, SeatId } from "@here-to-slay/protocol";
import type { GameConnection } from "@here-to-slay/room";
import { createStore, type StoreApi } from "zustand/vanilla";

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

/** One Seat on this device: its state, and everything it can ask of the Room. */
export interface DeviceSeat {
  readonly store: StoreApi<SeatState>;
  addBot(): void;
  startGame(): void;
  act(action: Action): void;
  close(): void;
}

/**
 * Wraps one Seat's connection. `soleLocalSeat` is true when the device has
 * no other local Seat: the Pass-Device Step would pass the device to the
 * same person, so the Seat confirms it has the device straight away.
 */
export function connectSeat(connection: GameConnection, { soleLocalSeat }: { soleLocalSeat: boolean }): DeviceSeat {
  const store = createStore<SeatState>()(() => ({ seatId: null, lobby: null, view: null, responseOptions: null, error: null }));
  let clientSeq = 0;
  const send = (msg: ClientMsg) => connection.send(msg);

  const unsubscribe = connection.onMessage((msg: RoomMsg) => {
    switch (msg.t) {
      case "lobby":
        store.setState({ seatId: msg.you[0] ?? null, lobby: msg.seats, error: null });
        return;
      case "update":
        store.setState({ view: msg.view, responseOptions: null, error: null });
        return;
      case "passDevice":
        if (soleLocalSeat) send({ t: "confirmPassDevice", seat: msg.seat });
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
  });

  return {
    store,
    addBot: () => send({ t: "addBot", difficulty: "easy" }),
    startGame: () => send({ t: "startGame" }),
    act(action) {
      const seat = store.getState().seatId;
      if (seat === null) return;
      send({ t: "action", seat, action, clientSeq: clientSeq++ });
    },
    close() {
      unsubscribe();
      connection.close();
    },
  };
}
