import type { Action, PlayerViewPayload, RoomCode, SeatId } from "@here-to-slay/protocol";
import type { GameConnection } from "@here-to-slay/room";
import type { ComponentType } from "react";
import type { RoomPointer } from "./pointer.js";

/**
 * What the shell hands the game layer for the Seat on screen. The game layer
 * is the only code that reads inside `view`; the shell can't tell which
 * engine it came from.
 */
export interface GameProps {
  view: PlayerViewPayload;
  /** Response options from the Room's `respond`, or null when the Room isn't asking this Seat. */
  responseOptions: Action[] | null;
  act(action: Action): void;
  /** Called once the game layer sees the game is over: nothing is left to resume. */
  onGameOver(): void;
}

export type GameComponent = ComponentType<GameProps>;

/** Everything the shell needs from the layer that knows the engine. */
export interface GameLayer {
  Board: GameComponent;
  /**
   * The Seat the game waits on for a turn action or a decision, read from
   * any Seat's view (the Room uses Seat ids as player ids). Null when it
   * waits on nobody that way: in a response window, or at game over.
   */
  seatToAct(view: PlayerViewPayload): SeatId | null;
}

/** One local Seat's connection to a Room, as the composition root hands it over. */
export interface LaunchedSeat {
  connection: GameConnection;
  /** The player's name, for the Pass-Device Step. */
  name: string;
  /**
   * The Seat, when the Room won't send a lobby to say: a game already under
   * way sends only updates. Otherwise the lobby names it.
   */
  seatId?: SeatId;
}

/** A Room as this device sees it: one connection per local Seat. */
export interface LaunchedRoom {
  roomCode: RoomCode;
  /** The local Seats on this device so far, the Host's first. */
  seats: LaunchedSeat[];
  /** Calls `cb` with each local Seat the Host adds later, in the lobby. Returns a function that unsubscribes. */
  onSeatAdded(cb: (seat: LaunchedSeat) => void): () => void;
}

/** How the shell starts a Room, provided by the composition root. */
export interface Launcher {
  /** Builds a Room on this device, with the player's local Seat. */
  playOnThisDevice(name: string): LaunchedRoom;
  /** Goes back into the Room `pointer` names, after a refresh, with every local Seat. Rejects when it can't. */
  resume(pointer: RoomPointer): Promise<LaunchedRoom>;
}
