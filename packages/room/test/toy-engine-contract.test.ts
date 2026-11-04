import type * as toy from "@here-to-slay/toy-engine";
import { describeRoomEngineContract } from "./engine-contract.js";
import { toyEngine } from "./harness.js";

describeRoomEngineContract<toy.GameState>("toy engine", {
  engine: toyEngine,
  hiddenCards: (state, viewer) => [
    ...state.deck.map((c) => c.id),
    ...state.players.filter((p) => p.id !== viewer).flatMap((p) => p.hand.map((c) => c.id)),
  ],
});
