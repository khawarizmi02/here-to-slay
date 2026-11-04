import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameEvent, type GameState } from "@here-to-slay/engine";
import type { PlayerId, GameEvent as ProtocolEvent } from "@here-to-slay/protocol";
import type { RoomEngine } from "../src/index.js";
import { describeRoomEngineContract } from "./engine-contract.js";

// Checks at compile time that the real engine fits the Room's interface by shape.
const engine: RoomEngine<GameState> = createRoomEngine(placeholderCardDefs);

function hiddenCards(state: GameState, viewer: PlayerId | "spectator"): string[] {
  // The drafter sees the leaders still on offer, in their Decision.
  const drafting = state.pendingDecision?.kind === "chooseLeader" && state.pendingDecision.player === viewer;
  return [
    ...state.mainDeck,
    ...state.monsterDeck,
    ...(drafting ? [] : state.leaderPool),
    ...state.players.filter((p) => p.id !== viewer).flatMap((p) => p.hand),
  ];
}

/**
 * Discards are face up, even when a reshuffle in the same action puts them
 * back in the deck. A pulled card is known to the player it was pulled from.
 */
function faceUpInEvents(events: readonly ProtocolEvent[], viewer: PlayerId | "spectator"): string[] {
  return (events as GameEvent[]).flatMap((e) => {
    switch (e.type) {
      case "CARD_DISCARDED":
        return [e.card.id];
      case "ITEM_DISCARDED":
        return [e.item.id];
      case "HERO_DESTROYED":
      case "HERO_SACRIFICED":
        return [e.hero.id, ...(e.item ? [e.item.id] : [])];
      // A Challenge card, and a card Challenged away, are face up as they go to the discard pile.
      case "CHALLENGE_PLAYED":
        return [e.card.id, e.target.id];
      case "CHALLENGE_RESOLVED":
        return [e.target.id];
      case "CARD_PULLED":
        return e.from === viewer && e.card ? [e.card.id] : [];
      default:
        return [];
    }
  });
}

describeRoomEngineContract<GameState>("real engine", { engine, hiddenCards, faceUpInEvents });

describeRoomEngineContract<GameState>("real engine, leader draft", {
  engine,
  config: { leaderSelection: "draft" },
  hiddenCards,
  faceUpInEvents,
});
