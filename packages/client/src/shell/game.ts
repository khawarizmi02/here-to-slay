import type { Action, PlayerViewPayload } from "@here-to-slay/protocol";
import type { GameConnection } from "@here-to-slay/room";
import type { ComponentType } from "react";

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
}

export type GameComponent = ComponentType<GameProps>;

/** How the shell starts a Room, provided by the composition root. */
export interface Launcher {
  /** Builds a Room on this device, with the player's local Seat, and returns that Seat's connection. */
  playOnThisDevice(name: string): GameConnection;
}
