import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameState } from "@here-to-slay/engine";
import type { RoomEngine } from "../src/index.js";

/*
 * The real engine staged for a Challenge through the Room (TECHNICAL_DESIGN.md
 * §7.2): s1 (the Host's Seat) holds a hero and s2 a Challenge.
 */

export const HERO = `${placeholderCardDefs.find((d) => d.type === "hero")!.id}#0`;
export const CHALLENGE = `${placeholderCardDefs.find((d) => d.type === "challenge")!.id}#0`;

/**
 * The real engine with every hand emptied at the start, then s1 given a
 * hero and s2 a Challenge, and the next dice forced so the challenger wins.
 * The Room replays its log through `createGame`, so this is the same on every replay.
 */
export function stagedEngine(): RoomEngine<GameState> {
  const base = createRoomEngine(placeholderCardDefs);
  return {
    ...base,
    createGame(opts) {
      const state = base.createGame(opts);
      for (const p of state.players) {
        state.mainDeck.push(...p.hand);
        p.hand = [];
      }
      state.mainDeck = state.mainDeck.filter((c) => c !== HERO && c !== CHALLENGE);
      state.players[0]!.hand.push(HERO);
      state.players[1]!.hand.push(CHALLENGE);
      // The challenger rolls 12, the defender 2.
      state.rng.forcedDice = [6, 6, 1, 1];
      return state;
    },
  };
}

/**
 * `engine`, keeping the latest state it handed the Room in `seen.state`: the
 * one `createGame` returned, or the one an accepted action led to.
 */
export function watched<State>(engine: RoomEngine<State>): { engine: RoomEngine<State>; seen: { state: State | null } } {
  const seen: { state: State | null } = { state: null };
  return {
    seen,
    engine: {
      ...engine,
      createGame(opts) {
        seen.state = engine.createGame(opts);
        return seen.state;
      },
      applyAction(state, action) {
        const result = engine.applyAction(state, action);
        if (result.ok) seen.state = result.state;
        return result;
      },
    },
  };
}
