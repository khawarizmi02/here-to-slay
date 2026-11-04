import type { CardDef } from "@here-to-slay/cards";
import type { Action, ConfigPatch, PlayerId } from "@here-to-slay/protocol";
import { clone } from "./clone.js";
import { hash128 } from "./rng.js";
import { applyAction, getLegalActions, isDiscardDecision } from "./rules.js";
import { createGame } from "./setup.js";
import type { ApplyResult, GameEvent, GameState, PlayerView } from "./types.js";
import { getPlayerEvents, getPlayerView } from "./views.js";

/**
 * The engine bound to one set of card definitions. It matches the Room's
 * `RoomEngine<GameState>` by shape without importing the Room
 * (TECHNICAL_DESIGN.md §6.1, ADR-0003).
 */
export interface BoundEngine {
  /** A hash of the card definitions: any change to card data changes it (ADR-0003). */
  readonly cardDefsVersion: string;
  /** Throws on an unknown config key, a wrong config type, or players or cards it can't start with. */
  createGame(opts: { players: { id: PlayerId; name: string; isBot: boolean }[]; seed: string; config: ConfigPatch }): GameState;
  applyAction(state: GameState, action: Action): ApplyResult;
  getLegalActions(state: GameState, player: PlayerId): Action[];
  /** The current drafter during a leader draft; after setup, the player whose turn it is. */
  getActivePlayer(state: GameState): PlayerId;
  isDiscardDecision(state: GameState, player: PlayerId): boolean;
  getPlayerView(state: GameState, player: PlayerId | "spectator"): PlayerView;
  getPlayerEvents(events: readonly GameEvent[], player: PlayerId | "spectator"): GameEvent[];
}

export function createRoomEngine(cardDefs: readonly CardDef[]): BoundEngine {
  const defs = clone([...cardDefs]);
  return {
    cardDefsVersion: cardDefsVersion(defs),
    createGame: ({ players, seed, config }) => createGame({ players, seed, config, cardDefs: defs }),
    applyAction,
    getLegalActions,
    getActivePlayer: (state) => state.activePlayer,
    isDiscardDecision,
    getPlayerView,
    getPlayerEvents,
  };
}

/** A short hash of every field of every definition, sorted by id, so the order they were given in doesn't matter. */
export function cardDefsVersion(cardDefs: readonly CardDef[]): string {
  const sorted = [...cardDefs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const [a, b] = hash128(canonical(sorted));
  return `cards-${hex(a)}${hex(b)}`;
}

function hex(word: number): string {
  return word.toString(16).padStart(8, "0");
}

/** JSON with object keys sorted, so key order in the card JSON doesn't change the hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
