import type { GameState } from "./types.js";

/**
 * A deep copy of plain JSON data: engine state, cards, views and events are
 * all JSON. It copies as a JSON round-trip would, dropping object keys whose
 * value is undefined, but several times faster, and the engine copies its
 * state on every action.
 */
export function clone<T>(value: T): T {
  return copy(value) as T;
}

function copy(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) out[i] = copy(value[i]);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const key in value) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = copy(v);
  }
  return out;
}

/**
 * A deep copy of `state` that shares its `cards` and `config` with it: both
 * are fixed once the game is set up (`createGame` freezes them), and they are
 * most of the state, so copying them on every action would be wasted work.
 */
export function cloneState(state: GameState): GameState {
  const { cards, config, ...rest } = state;
  return { ...clone(rest), cards, config };
}
