import type { PlayerViewPayload, SeatId } from "@here-to-slay/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { LaunchedRoom } from "./game.js";
import { connectSeat, type DeviceSeat } from "./seat.js";

/** Which of this device's Seats is on screen, and whether the screen is hidden while the device changes hands. */
export interface DeviceState {
  /** One per local Seat on this device, the Host's first. */
  seats: DeviceSeat[];
  /** The Seat shown, and the one every action is sent from. */
  onScreen: DeviceSeat;
  /** The Pass-Device Step: every hand is hidden until the player of this Seat says they have the device. */
  passTo: DeviceSeat | null;
}

/** Every local Seat on this device, one connection each, shown one at a time. */
export interface Device {
  readonly store: StoreApi<DeviceState>;
  /** The player the Pass-Device Step names has the device. */
  confirmPass(): void;
  close(): void;
}

/**
 * Holds one Seat per local Seat in `room`, and works out which is on screen.
 * The Room asks for the Pass-Device Step in response windows (`passDevice`);
 * for turns and decisions the device works it out, from `seatToAct`: when
 * the game starts waiting on one of its Seats, that Seat's player is asked
 * for. With one local Seat there is nobody to pass to, so the step never shows.
 */
export function connectDevice(room: LaunchedRoom, seatToAct: (view: PlayerViewPayload) => SeatId | null): Device {
  const first = connectSeat(room.seats[0]!);
  const store = createStore<DeviceState>()(() => ({ seats: [first, ...room.seats.slice(1).map(connectSeat)], onScreen: first, passTo: null }));
  /** The Seat the game last waited on, from the latest update. */
  let toAct: SeatId | null = null;
  /** Whether the Room asked for the step on show: confirming it then tells the Room. */
  let askedByRoom = false;

  function askFor(seat: DeviceSeat, byRoom: boolean): void {
    const { seats, passTo } = store.getState();
    if (seats.length < 2) {
      if (byRoom) seat.confirmPassDevice();
      return;
    }
    askedByRoom = byRoom || (askedByRoom && passTo === seat);
    store.setState({ passTo: seat });
  }

  function listen(seat: DeviceSeat): void {
    seat.listen({
      passDevice: () => askFor(seat, true),
      update(view) {
        // Every Seat gets the same update: only the first to report a change acts on it.
        const next = seatToAct(view);
        if (next === toAct) return;
        toAct = next;
        const nextSeat = store.getState().seats.find((s) => s.store.getState().seatId === next);
        if (nextSeat) askFor(nextSeat, false);
      },
    });
  }

  // Every Seat is in the list before any listens, so a message waiting on the first knows how many there are.
  for (const seat of store.getState().seats) listen(seat);
  const stopAdding = room.onSeatAdded((launched) => {
    const seat = connectSeat(launched);
    store.setState((s) => ({ seats: [...s.seats, seat] }));
    listen(seat);
  });

  return {
    store,
    confirmPass() {
      const seat = store.getState().passTo;
      if (!seat) return;
      if (askedByRoom) seat.confirmPassDevice();
      askedByRoom = false;
      store.setState({ onScreen: seat, passTo: null });
    },
    close() {
      stopAdding();
      for (const seat of store.getState().seats) seat.close();
    },
  };
}
