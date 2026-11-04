/**
 * The pure rules engine (TECHNICAL_DESIGN.md §6): no I/O, no clock, and all
 * randomness through the seeded RNG. The Room uses it through `createRoomEngine`.
 */
export { createRoomEngine, cardDefsVersion, type BoundEngine } from "./room-engine.js";
export { createGame, MIN_PLAYERS, MAX_PLAYERS, type CreateGameOptions } from "./setup.js";
export { applyAction, getLegalActions, isDiscardDecision } from "./rules.js";
export { getPlayerEvents, getPlayerView } from "./views.js";
export { DEFAULT_CONFIG, RuleConfigSchema, resolveConfig, type RuleConfig } from "./config.js";
export { createRng, nextFloat, nextInt, rollD6, shuffle, type RngState } from "./rng.js";
export * from "./types.js";
