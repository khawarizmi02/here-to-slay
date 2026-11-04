import { describe, expect, it } from "vitest";
import { createRoomEngine, type GameState } from "../src/index.js";
import { players, smallSet } from "./cards.js";

const engine = createRoomEngine(smallSet());

/**
 * A three-player draft whose last pick triggers the first-player roll, with
 * `dice` forced (TECHNICAL_DESIGN.md §13.2), so the roll's outcome is known.
 */
function rollAfterDraft(dice: number[]): { before: GameState; after: GameState; events: unknown[] } {
  let state = engine.createGame({ players: players(3), seed: "roll", config: { leaderSelection: "draft" } });
  for (const p of ["p1", "p2"]) {
    const [first] = engine.getLegalActions(state, p);
    state = engine.applyAction(state, first!).state;
  }
  const before: GameState = { ...state, rng: { ...state.rng, forcedDice: dice } };
  const r = engine.applyAction(before, engine.getLegalActions(before, "p3")[0]!);
  expect(r.ok, r.error).toBe(true);
  return { before, after: r.state, events: r.events };
}

describe("first-player roll", () => {
  it("lets the highest 2d6 go first, with turn order clockwise from them", () => {
    // p1 rolls 3, p2 rolls 9, p3 rolls 7.
    const { after } = rollAfterDraft([1, 2, 4, 5, 3, 4]);
    expect(engine.getActivePlayer(after)).toBe("p2");
    expect(after.turnOrder).toEqual(["p2", "p3", "p1"]);
    expect(after.phase).toEqual({ kind: "action" });
    expect(after.firstPlayerRolls).toEqual([
      [
        { player: "p1", dice: [1, 2] },
        { player: "p2", dice: [4, 5] },
        { player: "p3", dice: [3, 4] },
      ],
    ]);
  });

  it("rerolls only the players tied for highest", () => {
    // p1 and p3 tie on 8 over p2's 4; then p1 rolls 5 and p3 rolls 6.
    const { after, events } = rollAfterDraft([6, 2, 2, 2, 4, 4, 1, 4, 3, 3]);
    const rounds = [
      [
        { player: "p1", dice: [6, 2] },
        { player: "p2", dice: [2, 2] },
        { player: "p3", dice: [4, 4] },
      ],
      [
        { player: "p1", dice: [1, 4] },
        { player: "p3", dice: [3, 3] },
      ],
    ];
    expect(after.firstPlayerRolls).toEqual(rounds);
    expect(engine.getActivePlayer(after)).toBe("p3");
    expect(after.turnOrder).toEqual(["p3", "p1", "p2"]);
    expect(after.rng.forcedDice, "every forced die was used, and no more").toEqual([]);
    expect(events).toContainEqual({ type: "FIRST_PLAYER_ROLLED", rounds, firstPlayer: "p3" });
    expect(engine.getPlayerView(after, "spectator").firstPlayerRolls).toEqual(rounds);
  });

  it("keeps rerolling while the tie holds", () => {
    // Round 1: p2 and p3 tie on 10. Round 2: tie again on 6. Round 3: p2 wins 7 to 2.
    const { after } = rollAfterDraft([1, 1, 5, 5, 6, 4, 3, 3, 2, 4, 3, 4, 1, 1]);
    expect(after.firstPlayerRolls!.map((round) => round.map((r) => r.player))).toEqual([["p1", "p2", "p3"], ["p2", "p3"], ["p2", "p3"]]);
    expect(engine.getActivePlayer(after)).toBe("p2");
  });

  it("is the default, needs nobody to act, and never opens a Response Window", () => {
    const state = engine.createGame({ players: players(4), seed: "default", config: {} });
    expect(state.phase).toEqual({ kind: "action" });
    expect(state.pendingDecision).toBeNull();
    const [last] = state.firstPlayerRolls!.slice(-1);
    const total = (dice: [number, number]) => dice[0] + dice[1];
    const best = Math.max(...last!.map((r) => total(r.dice)));
    const winners = last!.filter((r) => total(r.dice) === best);
    expect(winners.map((w) => w.player)).toEqual([engine.getActivePlayer(state)]);
    expect(state.turnOrder[0]).toBe(engine.getActivePlayer(state));
    expect(engine.getPlayerView(state, "p1").responseWindow).toBeNull();
    for (const p of ["p1", "p2", "p3", "p4"]) expect(engine.getLegalActions(state, p).map((a) => a.type)).not.toContain("PASS");
  });

  it("gives the same rolls for the same seed, and differs across seeds", () => {
    const rolls = (seed: string) => engine.createGame({ players: players(4), seed, config: {} }).firstPlayerRolls;
    expect(rolls("x")).toEqual(rolls("x"));
    const firsts = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) => engine.createGame({ players: players(4), seed, config: {} }).activePlayer));
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("records no roll when the first player isn't rolled for", () => {
    expect(engine.createGame({ players: players(2), seed: "s", config: { firstPlayerMethod: "random" } }).firstPlayerRolls).toBeNull();
  });
});
