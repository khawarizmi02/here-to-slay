import type { Action, ConfigPatch, GameEvent, PlayerViewPayload, RoomCode, SeatId } from "@here-to-slay/protocol";
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
  /** The events of every update so far, oldest first, filtered for this Seat. */
  log: GameEvent[];
  /**
   * The Seat's options in a response window, or null when the Room isn't
   * asking it: from the Room's `respond` for a local Seat, and from the game
   * layer's `responseOptions` for a remote one.
   */
  responseOptions: Action[] | null;
  /** When the Room answers for a remote Seat that hasn't (a `Date.now()` time), from its `countdown`; null when nothing is timed. */
  deadline: number | null;
  act(action: Action): void;
  /** Called once the game layer sees the game is over: nothing is left to resume. */
  onGameOver(): void;
}

export type GameComponent = ComponentType<GameProps>;

/** What the shell hands the game layer's rules form in the lobby, shown only to the Host. */
export interface RulesProps {
  /** Overrides the rules named in `config`; the Room keeps the rest. */
  setConfig(config: ConfigPatch): void;
}

/** Everything the shell needs from the layer that knows the engine. */
export interface GameLayer {
  Board: GameComponent;
  /** The Host's rules form for the lobby. */
  Rules: ComponentType<RulesProps>;
  /**
   * The Seat the game waits on for a turn action or a decision, read from
   * any Seat's view (the Room uses Seat ids as player ids). Null when it
   * waits on nobody that way: in a response window, or at game over.
   */
  seatToAct(view: PlayerViewPayload): SeatId | null;
  /**
   * A remote Seat's options in a response window, read from its own view:
   * the Room sends remote Seats no `respond`. Null when it isn't asked.
   */
  responseOptions(view: PlayerViewPayload): Action[] | null;
}

/** One local Seat's connection to a Room, as the composition root hands it over. */
export interface LaunchedSeat {
  connection: GameConnection;
  /** The player's name, for the Pass-Device Step. */
  name: string;
  /** The Host's own Seat: only it is offered the lobby's Host controls. */
  host?: boolean;
  /**
   * The Seat, when the Room won't send a lobby to say: a game already under
   * way sends only updates. Otherwise the lobby names it.
   */
  seatId?: SeatId;
  /**
   * A friend's Seat behind the relay. The Room asks it to respond through its
   * view, with a `countdown`, and never sends it `respond`.
   */
  remote?: boolean;
}

/** A Room as this device sees it: one connection per local Seat. */
export interface LaunchedRoom {
  roomCode: RoomCode;
  /** The local Seats on this device so far, the Host's first. */
  seats: LaunchedSeat[];
  /** Calls `cb` with each local Seat the Host adds later, in the lobby. Returns a function that unsubscribes. */
  onSeatAdded(cb: (seat: LaunchedSeat) => void): () => void;
  /** Set for a Room reached through the relay: the Host's `hostToken` or a friend's `seatToken`, kept in the pointer. */
  online?: { token: string };
  /** Stops what the Room needs beyond its Seats' connections, such as the Host's own socket to the relay. */
  close?(): void;
}

/** How the shell starts a Room, provided by the composition root. */
export interface Launcher {
  /** Builds a Room on this device, with the player's local Seat. */
  playOnThisDevice(name: string): LaunchedRoom;
  /** Builds a Room the relay knows, with the player's local Seat, for friends to join. Rejects with a message for the player. */
  hostOnline(name: string): Promise<LaunchedRoom>;
  /**
   * Takes a Seat in the Room with `roomCode`, as the player typed it, through
   * the relay. Rejects with a message for the player, such as when there is
   * no such Room.
   */
  join(roomCode: string, name: string): Promise<LaunchedRoom>;
  /** Goes back into the Room `pointer` names, after a refresh, with every local Seat. Rejects when it can't. */
  resume(pointer: RoomPointer): Promise<LaunchedRoom>;
}
