import type { Action, ConfigPatch, PlayerId } from "@here-to-slay/protocol";

/**
 * The parts of the rules engine's API (TECHNICAL_DESIGN.md §6.1) the Room
 * uses. The real engine and the toy engine both fit it, through a thin
 * adapter where their option types differ.
 *
 * The engine never sees the clock: only the Room owns time.
 */
export interface RoomEngine<State, Event extends { type: string }> {
  /** May throw if the players or config are invalid; the Room reports the message to the Host. */
  createGame(opts: { players: EnginePlayer[]; seed: string; config: ConfigPatch }): State;
  /** Must not mutate `state`. When `ok` is false, `state` is unchanged. */
  applyAction(state: State, action: Action): EngineApplyResult<State, Event>;
  /** The player's redacted view; plain JSON. */
  getPlayerView(state: State, player: PlayerId): object;
  /** Events filtered for one player; plain JSON. */
  getPlayerEvents(events: readonly Event[], player: PlayerId): Event[];
}

export interface EnginePlayer {
  id: PlayerId;
  name: string;
  isBot: boolean;
}

export interface EngineApplyResult<State, Event> {
  ok: boolean;
  state: State;
  error?: string;
  events: Event[];
}
