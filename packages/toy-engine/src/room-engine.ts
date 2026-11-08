import type { ConfigPatch } from "@here-to-slay/protocol";
import { applyAction, createGame, getLegalActions, getPlayerEvents, getPlayerView } from "./engine.js";
import type { GameState, PlayerId, ToyConfig } from "./types.js";

/**
 * The toy engine behind the Room's engine interface (`RoomEngine` in
 * @here-to-slay/room), for the Room's tests and the client. Config values
 * must be positive integers.
 */
export const toyRoomEngine = {
  cardDefsVersion: "toy-2",
  createGame({ players, seed, config }: { players: { id: PlayerId; name: string; isBot: boolean }[]; seed: string; config: ConfigPatch }): GameState {
    const parsed: Partial<ToyConfig> = {};
    for (const [key, value] of Object.entries(config)) {
      // A Room setting, not a rule the toy engine knows.
      if (key === "responseWindowMs") continue;
      if (key !== "targetScore" && key !== "handSize") throw new Error(`Unknown config flag ${key}`);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`${key} must be a positive integer`);
      }
      parsed[key] = value;
    }
    return createGame({ players, seed, config: parsed });
  },
  applyAction,
  getLegalActions,
  getActivePlayer: (state: GameState): PlayerId => state.activePlayer,
  getPlayerView: (state: GameState, player: PlayerId) => getPlayerView(state, player) as unknown as Record<string, unknown>,
  getPlayerEvents,
};
