/**
 * A stand-in game with the same API as the real rules engine
 * (TECHNICAL_DESIGN.md §6.1). The Room is developed and tested against it:
 * it has hidden hands, a response window that a card in hand can answer,
 * a pending decision, and a reachable game over.
 */
export { createGame, getLegalActions, applyAction, getPlayerView, getPlayerEvents } from "./engine.js";
export { createRng, nextFloat, shuffle, type RngState } from "./rng.js";
export * from "./types.js";
