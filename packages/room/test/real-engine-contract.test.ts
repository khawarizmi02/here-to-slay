import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameState } from "@here-to-slay/engine";
import type { RoomEngine } from "../src/index.js";
import { describeRoomEngineContract } from "./engine-contract.js";

// Checks at compile time that the real engine fits the Room's interface by shape.
const engine: RoomEngine<GameState> = createRoomEngine(placeholderCardDefs);

describeRoomEngineContract<GameState>("real engine", {
  engine,
  // The default first-player roll isn't built yet (#40).
  config: { firstPlayerMethod: "random" },
  // Response Windows arrive in M3 (#47, #48).
  opensResponseWindows: false,
  hiddenCards: (state, viewer) => [
    ...state.mainDeck,
    ...state.monsterDeck,
    ...state.leaderPool,
    ...state.players.filter((p) => p.id !== viewer).flatMap((p) => p.hand),
  ],
});
