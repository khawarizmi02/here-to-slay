import { fromPlayer, playerState } from "./players.js";
import { partyClasses } from "./selectors.js";
import type { CardIndex, GameEvent, GameState, PlayerId } from "./types.js";

/**
 * Ends the game if anyone has won (§3.3): the monster win, `monstersToWin`
 * slain monsters, or the class win, a party of `classesToWin` distinct
 * classes counting the Party Leader. The active player is checked first, then
 * the others in turn order; a player who has both wins by monsters. A win
 * clears the stack, discarding any Magic card still resolving, and any
 * pending Decision. A card still in limbo goes there too, unless a
 * successful Challenge already put it there.
 */
export function checkWin(defs: CardIndex, state: GameState, events: GameEvent[]): void {
  if (state.phase.kind === "gameOver" || state.turnOrder.length === 0) return;
  for (const id of fromPlayer(state, state.activePlayer)) {
    if (playerState(state, id).slainMonsters.length >= state.config.monstersToWin) return win(state, id, "monsters", events);
    if (partyClasses(defs, state, id).size >= state.config.classesToWin) return win(state, id, "classes", events);
  }
}

function win(state: GameState, player: PlayerId, reason: "monsters" | "classes", events: GameEvent[]): void {
  state.winner = player;
  state.winReason = reason;
  state.phase = { kind: "gameOver" };
  // A Magic card still resolving, or a card waiting on its Challenge Window, would otherwise be in no zone.
  for (const frame of state.stack) {
    if (frame.kind === "magic") {
      state.discardPile.push(frame.card);
      events.push({ type: "MAGIC_DISCARDED", player: frame.player, card: { id: frame.card, def: state.cards[frame.card]! } });
    }
    if (frame.kind === "cardPlay" && !frame.challenged) {
      state.discardPile.push(frame.card);
      events.push({ type: "CARD_DISCARDED", player: frame.player, card: { id: frame.card, def: state.cards[frame.card]! } });
    }
  }
  state.stack = [];
  state.pendingDecision = null;
  events.push({ type: "GAME_WON", player, reason });
}
