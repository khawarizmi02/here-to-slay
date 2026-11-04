import { clone } from "./clone.js";
import { getLegalActions } from "./rules.js";
import type { CardInstanceId, CardView, GameEvent, GameState, PlayerId, PlayerView } from "./types.js";

/** The whole Decision for the player who must answer; everyone else learns only who that is. */
function pendingDecisionFor(state: GameState, viewer: PlayerId | "spectator"): PlayerView["pendingDecision"] {
  const decision = state.pendingDecision;
  if (decision === null) return null;
  return decision.player === viewer ? clone(decision) : { player: decision.player };
}

/** One player's redacted view (TECHNICAL_DESIGN.md §9). Shares nothing with `state`. */
export function getPlayerView(state: GameState, viewer: PlayerId | "spectator"): PlayerView {
  const card = (id: CardInstanceId): CardView => ({ id, def: state.cards[id]! });
  const me = state.players.find((p) => p.id === viewer);
  return {
    me: viewer,
    phase: { ...state.phase },
    turnNumber: state.turnNumber,
    activePlayer: state.activePlayer,
    turnOrder: [...state.turnOrder],
    actionPoints: state.actionPoints,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      leader: p.leader === null ? null : card(p.leader),
      handCount: p.hand.length,
      party: p.party.map((h) => ({
        hero: card(h.instanceId),
        item: h.equippedItem === null ? null : card(h.equippedItem),
        rolledThisTurn: h.rolledThisTurn,
      })),
      slainMonsters: p.slainMonsters.map(card),
    })),
    hand: me ? me.hand.map(card) : [],
    mainDeckCount: state.mainDeck.length,
    monsterDeckCount: state.monsterDeck.length,
    discardPile: state.discardPile.map(card),
    activeMonsters: state.activeMonsters.map(card),
    responseWindow: null,
    pendingDecision: pendingDecisionFor(state, viewer),
    firstPlayerRolls: clone(state.firstPlayerRolls),
    winner: state.winner,
    winReason: state.winReason,
    legalActions: me ? getLegalActions(state, me.id) : [],
  };
}

/** Filters events for one player: another player's draw doesn't show the card. */
export function getPlayerEvents(events: readonly GameEvent[], viewer: PlayerId | "spectator"): GameEvent[] {
  return events.map((e) => {
    if (e.type === "CARD_DRAWN" && e.player !== viewer) return { type: "CARD_DRAWN", player: e.player };
    return clone(e);
  });
}
