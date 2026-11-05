import { placeholderCardDefs } from "@here-to-slay/cards";
import { describe, expect, it } from "vitest";
import { createRoomEngine, type Action, type GameState, type PlayerId } from "../src/index.js";
import { players } from "./cards.js";

/*
 * M2 acceptance (TECHNICAL_DESIGN.md §14): two scripted players play the
 * placeholder set to a win, through the engine's public interface only.
 */

const engine = createRoomEngine(placeholderCardDefs);

/** Who must act now: the player with something to answer, else the first player a Challenge Window waits on, else the player whose turn it is. */
function actor(state: GameState): PlayerId {
  return state.pendingDecision?.player ?? engine.getPlayerView(state, "spectator").responseWindow?.awaiting[0] ?? state.activePlayer;
}

/**
 * A fixed, greedy script: attack a monster, else play a hero, else roll a
 * hero, else play an item or Magic, else draw, else end the turn. A Decision
 * takes its first option. In a Challenge Window, Challenge if possible, else pass.
 */
const PREFERENCE: Action["type"][] = ["RESOLVE_DECISION", "PLAY_CHALLENGE", "PASS", "ATTACK_MONSTER", "PLAY_HERO", "ROLL_HERO_EFFECT", "PLAY_ITEM", "PLAY_MAGIC", "DRAW_CARD", "END_TURN"];

function scripted(legal: Action[]): Action {
  for (const type of PREFERENCE) {
    const action = legal.find((a) => a.type === type);
    if (action) return action;
  }
  throw new Error(`The script has no move among ${legal.map((a) => a.type).join(", ")}`);
}

describe("a full game", () => {
  it("two scripted players play to a win", () => {
    let state = engine.createGame({ players: players(2), seed: "scripted", config: {} });
    let actions = 0;
    while (state.phase.kind !== "gameOver") {
      expect(actions, "the game didn't end within 5,000 actions").toBeLessThan(5_000);
      const legal = engine.getLegalActions(state, actor(state));
      expect(legal, `${actor(state)} has nothing to do`).not.toEqual([]);
      const r = engine.applyAction(state, scripted(legal));
      expect(r.ok, r.error).toBe(true);
      state = r.state;
      actions++;
    }

    expect(state.winner).toMatch(/^p[12]$/);
    expect(["monsters", "classes"]).toContain(state.winReason);
    const winner = state.players.find((p) => p.id === state.winner)!;
    if (state.winReason === "monsters") expect(winner.slainMonsters.length).toBeGreaterThanOrEqual(state.config.monstersToWin);
    // Nothing more is legal once the game is over.
    for (const p of state.players) expect(engine.getLegalActions(state, p.id)).toEqual([]);
    expect(engine.applyAction(state, { type: "END_TURN", player: state.activePlayer }).ok).toBe(false);
  });
});
