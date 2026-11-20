import type { Action, ConfigPatch, GameEvent, PlayerViewPayload, RoomCode, SeatId } from "@here-to-slay/protocol";
import type { GameConnection, Replay } from "@here-to-slay/room";
import type { ComponentType } from "react";
import type { RoomPointer } from "./pointer.js";
import type { Sound } from "./sound.js";

/**
 * What the shell hands the game layer for the Seat on screen. The game layer
 * is the only code that reads inside `view`; the shell can't tell which
 * engine it came from.
 */
export interface GameProps {
  view: PlayerViewPayload;
  /** The events played or shown so far, oldest first, filtered for this Seat. */
  log: GameEvent[];
  /**
   * The event the animation queue is playing now, the last in `log`, or null.
   * `view` is still the one from before its update: it shows once the
   * update's events have played. Until then the shell passes no
   * `responseOptions`, and the game layer offers no actions from the view,
   * because they may no longer be legal.
   */
  playing: GameEvent | null;
  /**
   * The Seat's options in a response window, or null when the Room isn't
   * asking it: from the Room's `respond` for a local Seat, and from the game
   * layer's `responseOptions` for a remote one.
   */
  responseOptions: Action[] | null;
  /**
   * When the Room answers for a remote Seat that hasn't (a `Date.now()` time),
   * from its `countdown`; null when nothing is timed. While an event plays the
   * shell shows the countdown itself, and this is null.
   */
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
  /** The rules reference, shown over the first screen with the default rules. The board opens its own, with the game's. */
  RulesReference: ComponentType<{ onClose(): void }>;
  /**
   * The Seat the game waits on for a turn action or a decision, read from
   * any Seat's view (the Room uses Seat ids as player ids). Null when it
   * waits on nobody that way: in a response window, or at game over.
   */
  seatToAct(view: PlayerViewPayload): SeatId | null;
  /**
   * The Seat whose view this is (the Room uses Seat ids as player ids), or
   * null for a spectator. A friend back from a refresh mid-game learns their
   * Seat only from this: a game under way sends no lobby.
   */
  viewer(view: PlayerViewPayload): SeatId | null;
  /**
   * A remote Seat's options in a response window, read from its own view:
   * the Room sends remote Seats no `respond`. Null when it isn't asked.
   */
  responseOptions(view: PlayerViewPayload): Action[] | null;
  /**
   * The sound `event` makes for the Seat whose view `view` is, or null for
   * one that makes none. "respond" is the shell's own: no event makes it.
   */
  sound(event: GameEvent, view: PlayerViewPayload): Exclude<Sound, "respond"> | null;
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
  /** The game's replay file, null before the game starts. Only a Room this device hosts has one. */
  replayFile?(): ReplayFile | null;
}

/** A game's replay as a file for the player to save, from the Room's `replayFile()`. */
export interface ReplayFile {
  filename: string;
  mimeType: string;
  contents: string;
}

/** The Room a pointer names is gone: the relay no longer knows its Room Code. */
export class RoomClosedError extends Error {
  override readonly name = "RoomClosedError";
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
  /**
   * Goes back into the Room `pointer` names, after a refresh, with every
   * local Seat. Rejects with a `RoomClosedError` when the Room has closed,
   * and otherwise when it can't.
   */
  resume(pointer: RoomPointer): Promise<LaunchedRoom>;
  /**
   * Plays back the contents of a replay file on this device, never
   * contacting the relay. Throws with a message for the player when the
   * contents aren't a replay, were made with other card definitions, or
   * don't play back.
   */
  openReplay(contents: string): Replay;
}
