import type { GameState, PlayerId, PlayerState } from "./types.js";

/** `id`'s PlayerState. The engine only looks up players it has already checked exist. */
export function playerState(state: GameState, id: PlayerId): PlayerState {
  return state.players.find((p) => p.id === id)!;
}

/** Turn order starting from `player`: them first, then everyone after them, wrapping round. */
export function fromPlayer(state: GameState, player: PlayerId): PlayerId[] {
  const at = Math.max(0, state.turnOrder.indexOf(player));
  return [...state.turnOrder.slice(at), ...state.turnOrder.slice(0, at)];
}
