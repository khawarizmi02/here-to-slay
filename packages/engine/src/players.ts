import type { GameState, PlayerId, PlayerState } from "./types.js";

/** `id`'s PlayerState. The engine only looks up players it has already checked exist. */
export function playerState(state: GameState, id: PlayerId): PlayerState {
  return state.players.find((p) => p.id === id)!;
}
