import { fromPlayer } from "./players.js";
import { partyClasses } from "./selectors.js";
import type { CardIndex, GameEvent, GameState, PlayerId } from "./types.js";

/**
 * Ends the game if anyone has won (§3.3): the class win, a party of
 * `classesToWin` distinct classes counting the Party Leader. The active
 * player is checked first, then the others in turn order. A win clears the
 * stack, discarding any Magic card still resolving, and any pending Decision.
 */
export function checkWin(defs: CardIndex, state: GameState, events: GameEvent[]): void {
  if (state.phase.kind === "gameOver" || state.turnOrder.length === 0) return;
  const winner = fromPlayer(state, state.activePlayer).find((id) => partyClasses(defs, state, id).size >= state.config.classesToWin);
  if (winner !== undefined) win(state, winner, "classes", events);
}

function win(state: GameState, player: PlayerId, reason: "monsters" | "classes", events: GameEvent[]): void {
  state.winner = player;
  state.winReason = reason;
  state.phase = { kind: "gameOver" };
  // A Magic card still resolving would otherwise be in no zone.
  for (const frame of state.stack) {
    if (frame.kind !== "magic") continue;
    state.discardPile.push(frame.card);
    events.push({ type: "MAGIC_DISCARDED", player: frame.player, card: { id: frame.card, def: state.cards[frame.card]! } });
  }
  state.stack = [];
  state.pendingDecision = null;
  events.push({ type: "GAME_WON", player, reason });
}
