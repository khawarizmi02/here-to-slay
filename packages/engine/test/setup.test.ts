import { describe, expect, it } from "vitest";
import { createRoomEngine, type GameState } from "../src/index.js";
import { players, smallSet } from "./cards.js";

const engine = createRoomEngine(smallSet());

function start(seed = "seed", count = 3, config: Record<string, string | number | boolean> = { firstPlayerMethod: "random" }): GameState {
  return engine.createGame({ players: players(count), seed, config });
}

/** Every card instance in the game, from every zone. */
function allZones(state: GameState): string[] {
  return [
    ...state.mainDeck,
    ...state.discardPile,
    ...state.monsterDeck,
    ...state.activeMonsters,
    ...state.leaderPool,
    ...state.players.flatMap((p) => [p.leader!, ...p.hand, ...p.party.map((h) => h.instanceId), ...p.slainMonsters]),
  ];
}

describe("createGame setup", () => {
  it("gives an identical initial state for the same seed", () => {
    expect(start("same")).toEqual(start("same"));
  });

  it("shuffles differently for a different seed", () => {
    expect(start("one").mainDeck).not.toEqual(start("two").mainDeck);
  });

  it("deals 5 cards to each player from the main deck only", () => {
    const state = start();
    for (const p of state.players) {
      expect(p.hand).toHaveLength(5);
      for (const card of p.hand) expect(state.cards[card]).toMatch(/^(hero_|challenge|mod)/);
    }
  });

  it("gives each player one random Party Leader", () => {
    const state = start();
    const leaders = state.players.map((p) => p.leader);
    expect(new Set(leaders).size).toBe(3);
    for (const leader of leaders) expect(state.cards[leader!]).toMatch(/^leader_/);
    // Over several seeds, the first Seat doesn't always get the same leader.
    const firstLeaders = new Set(["a", "b", "c", "d", "e", "f"].map((seed) => start(seed).players[0]!.leader));
    expect(firstLeaders.size).toBeGreaterThan(1);
  });

  it("reveals 3 monsters face up and keeps the rest in the monster deck", () => {
    const state = start();
    expect(state.activeMonsters).toHaveLength(3);
    expect(state.monsterDeck).toHaveLength(2);
    for (const m of [...state.activeMonsters, ...state.monsterDeck]) expect(state.cards[m]).toMatch(/^monster_/);
  });

  it("puts every card in exactly one zone", () => {
    const state = start();
    const zones = allZones(state);
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones.sort()).toEqual(Object.keys(state.cards).sort());
  });

  it("starts with empty parties, slain piles and discard pile, and no forced dice", () => {
    const state = start();
    expect(state.discardPile).toEqual([]);
    for (const p of state.players) {
      expect(p.party).toEqual([]);
      expect(p.slainMonsters).toEqual([]);
    }
    expect(state.rng.forcedDice).toEqual([]);
  });

  it("follows the config for hand size and monster count", () => {
    const state = start("seed", 2, { firstPlayerMethod: "random", startingHandSize: 2, activeMonsterCount: 1 });
    for (const p of state.players) expect(p.hand).toHaveLength(2);
    expect(state.activeMonsters).toHaveLength(1);
  });
});

describe("first player and turn order", () => {
  it("lets the first entry in players go first with firstSeat", () => {
    for (const seed of ["a", "b", "c"]) {
      const state = start(seed, 4, { firstPlayerMethod: "firstSeat" });
      expect(state.turnOrder).toEqual(["p1", "p2", "p3", "p4"]);
      expect(engine.getActivePlayer(state)).toBe("p1");
    }
  });

  it("picks a random first player and runs clockwise from them", () => {
    const firsts = new Set<string>();
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const state = start(seed, 4);
      const first = engine.getActivePlayer(state);
      firsts.add(first);
      const i = ["p1", "p2", "p3", "p4"].indexOf(first);
      expect(state.turnOrder).toEqual([...["p1", "p2", "p3", "p4"].slice(i), ...["p1", "p2", "p3", "p4"].slice(0, i)]);
    }
    expect(firsts.size).toBeGreaterThan(1);
  });
});
