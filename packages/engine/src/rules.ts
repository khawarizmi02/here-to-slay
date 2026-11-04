import type { Action, ApplyResult, GameState, PlayerId } from "./types.js";

/**
 * Every action `player` may take now. Setup is the only part of the game
 * built so far, so nobody can act yet; the turn loop adds the first actions.
 */
export function getLegalActions(state: GameState, player: PlayerId): Action[] {
  void state;
  void player;
  return [];
}

/** Applies `action`, or rejects it and leaves `state` unchanged (§6.1). */
export function applyAction(state: GameState, action: Action): ApplyResult {
  return { ok: false, state, error: rejectionReason(state, action), events: [] };
}

function rejectionReason(state: GameState, action: Action): string {
  if (state.phase.kind === "gameOver") return "The game is over";
  if (!state.players.some((p) => p.id === action.player)) return `Unknown player ${action.player}`;
  return `${action.type} is not a legal action right now`;
}
