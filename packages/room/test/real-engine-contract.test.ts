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

/** Discards are face up, even when a reshuffle in the same action puts them back in the deck. */
function faceUpInEvents(events: readonly ProtocolEvent[]): string[] {
  return (events as GameEvent[]).flatMap((e) => (e.type === "CARD_DISCARDED" ? [e.card.id] : []));
}

// Response Windows arrive in M3 (#47, #48).
describeRoomEngineContract<GameState>("real engine", { engine, opensResponseWindows: false, hiddenCards, faceUpInEvents });

describeRoomEngineContract<GameState>("real engine, leader draft", {
  engine,
  config: { leaderSelection: "draft" },
  opensResponseWindows: false,
  hiddenCards,
  faceUpInEvents,
});
