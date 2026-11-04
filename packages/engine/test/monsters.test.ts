import { describe, expect, it } from "vitest";
import type { GameState } from "../src/index.js";
import { act, answer, decision, dice, engineWith, equip, hand, inParty, leader, party, start, type Engine } from "./scenario.js";

/** Monsters for these tests, one copy each: `monster_<name>`, slain on 8+, defeated on 4 or less. */
function monster(name: string, requirement: unknown, more: Record<string, unknown> = {}) {
  return {
    id: `monster_${name}`,
    type: "monster",
    name,
    text: "",
    copies: 1,
    requirement,
    slayAt: 8,
    defeatAt: 4,
    penalty: { op: "draw", who: "self", amount: 2 },
    reward: { hook: "modifyRollTotal", condition: { rollKind: "heroEffect" }, value: 3 },
    ...more,
  };
}

const MONSTERS = [
  monster("free", { kind: "none" }),
  monster("pair", { kind: "heroCount", min: 2 }),
  monster("thief", { kind: "classCount", class: "thief", min: 1 }),
  monster("two_thieves", { kind: "classCount", class: "thief", min: 2 }),
  monster("both", { kind: "all", of: [{ kind: "heroCount", min: 2 }, { kind: "classCount", class: "bard", min: 1 }] }),
  monster("draws", { kind: "none" }, { reward: { hook: "onMonsterSlain", effect: { op: "draw", who: "self", amount: 1 } } }),
  monster("sacrifice", { kind: "none" }, { penalty: { op: "sacrifice", who: "self", amount: 1 } }),
  monster("bonus", { kind: "none" }, { reward: { hook: "modifyRollTotal", condition: { rollKind: "monsterAttack" }, value: 1 } }),
];

const engine = () => engineWith({}, 0, MONSTERS);

/** Puts `monsters` face up in the centre, in order, and the rest of the game's monsters in the deck. */
function reveal(state: GameState, ...monsters: string[]): GameState {
  const all = [...state.activeMonsters, ...state.monsterDeck];
  state.activeMonsters = monsters;
  state.monsterDeck = all.filter((m) => !monsters.includes(m)).sort();
  return state;
}

const attacks = (e: Engine, state: GameState, player = "p1") =>
  e.getLegalActions(state, player).flatMap((a) => (a.type === "ATTACK_MONSTER" ? [a.monster] : []));

const attack = (e: Engine, state: GameState, monster: string, player = "p1") => act(e, state, { type: "ATTACK_MONSTER", player, monster });

const slain = (state: GameState, player: string) => state.players.find((p) => p.id === player)!.slainMonsters;

/** A game with p1 as a fighter leader and no free roll, so nothing but the test's own cards counts. */
function game(e: Engine, config: Record<string, unknown> = {}): GameState {
  return leader(start(e, { freeRollOnHeroPlay: false, ...config }), "p1", "fighter");
}

describe("monster requirements", () => {
  it("lists only the monsters the party meets the requirement of", () => {
    const e = engine();
    const state = reveal(game(e), "monster_free#0", "monster_pair#0", "monster_thief#0");
    expect(attacks(e, state)).toEqual(["monster_free#0"]);
    // The leader counts as a hero, so one hero makes two.
    inParty(state, "p1", "hero_wizard#0");
    expect(attacks(e, state)).toEqual(["monster_free#0", "monster_pair#0"]);
    inParty(state, "p1", "hero_thief#0");
    expect(attacks(e, state)).toEqual(["monster_free#0", "monster_pair#0", "monster_thief#0"]);
    expect(e.applyAction(state, { type: "ATTACK_MONSTER", player: "p1", monster: "monster_two_thieves#0" }).ok).toBe(false);
  });

  it("counts the leader's class, and a Mask's class instead of the hero's own", () => {
    const e = engine();
    const state = reveal(game(e), "monster_thief#0", "monster_two_thieves#0");
    leader(state, "p1", "thief");
    expect(attacks(e, state)).toEqual(["monster_thief#0"]);
    inParty(state, "p1", "hero_wizard#0");
    expect(attacks(e, state)).toEqual(["monster_thief#0"]);
    equip(state, "hero_wizard#0", "item_mask_thief#0");
    expect(attacks(e, state)).toEqual(["monster_thief#0", "monster_two_thieves#0"]);
  });

  it("counts no leader with leaderCountsForRequirements off", () => {
    const e = engine();
    const state = reveal(game(e, { leaderCountsForRequirements: false }), "monster_pair#0", "monster_thief#0");
    leader(state, "p1", "thief");
    inParty(state, "p1", "hero_wizard#0");
    expect(attacks(e, state)).toEqual([]);
    inParty(state, "p1", "hero_thief#0");
    expect(attacks(e, state)).toEqual(["monster_pair#0", "monster_thief#0"]);
  });

  it("needs every part of an all requirement", () => {
    const e = engine();
    const state = reveal(game(e), "monster_both#0");
    inParty(state, "p1", "hero_wizard#0");
    expect(attacks(e, state)).toEqual([]);
    inParty(state, "p1", "hero_bard#0");
    expect(attacks(e, state)).toEqual(["monster_both#0"]);
  });

  it("costs 2 AP, so it is not offered with 1 AP left", () => {
    const e = engine();
    const state = reveal(game(e), "monster_free#0");
    const r = attack(e, dice(state, 3, 3), "monster_free#0");
    expect(r.state.actionPoints).toBe(1);
    expect(attacks(e, r.state)).toEqual([]);
  });
});

describe("attacking a monster", () => {
  it("slays the monster at or above its slay value, and fills its slot from the monster deck", () => {
    const e = engine();
    const state = reveal(game(e), "monster_free#0", "monster_pair#0", "monster_thief#0");
    const top = state.monsterDeck[0]!;
    const r = attack(e, dice(state, 4, 4), "monster_free#0");
    expect(r.events).toEqual([
      { type: "DICE_ROLLED", roll: expect.any(String), player: "p1", rollKind: "monsterAttack", monster: { id: "monster_free#0", def: "monster_free" }, dice: [4, 4], bonus: 0, total: 8, outcome: "slain" },
      { type: "MONSTER_SLAIN", player: "p1", monster: { id: "monster_free#0", def: "monster_free" } },
      { type: "MONSTER_REVEALED", monster: { id: top, def: r.state.cards[top] } },
    ]);
    expect(slain(r.state, "p1")).toEqual(["monster_free#0"]);
    expect(r.state.activeMonsters).toEqual([top, "monster_pair#0", "monster_thief#0"]);
    expect(r.state.monsterDeck).not.toContain(top);
  });

  it("applies the penalty at or below the defeat value, run by the attacker", () => {
    const e = engine();
    const state = reveal(game(e), "monster_free#0");
    const before = hand(state, "p1").length;
    const r = attack(e, dice(state, 2, 2), "monster_free#0");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "CARD_DRAWN", "CARD_DRAWN"]);
    expect(r.events[0]).toMatchObject({ total: 4, outcome: "defeated" });
    expect(hand(r.state, "p1")).toHaveLength(before + 2);
    expect(r.state.activeMonsters).toEqual(["monster_free#0"]);
    expect(slain(r.state, "p1")).toEqual([]);
  });

  it("does nothing between the two values", () => {
    const e = engine();
    const state = reveal(game(e), "monster_free#0");
    const r = attack(e, dice(state, 3, 4), "monster_free#0");
    expect(r.events).toEqual([expect.objectContaining({ type: "DICE_ROLLED", total: 7, outcome: "nothing" })]);
    expect(r.state.activeMonsters).toEqual(["monster_free#0"]);
    expect(r.state.phase).toEqual({ kind: "action" });
  });

  it("asks the attacker for a penalty that needs a Decision", () => {
    const e = engine();
    const state = inParty(reveal(game(e), "monster_sacrifice#0"), "p1", "hero_bard#0", "hero_thief#0");
    const r = attack(e, dice(state, 1, 1), "monster_sacrifice#0");
    expect(decision(r.state)).toMatchObject({ player: "p1", kind: "chooseHero", discard: true });
    const done = answer(e, r.state, "hero_thief#0");
    expect(party(done.state, "p1").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
    expect(done.state.phase).toEqual({ kind: "action" });
  });

  it("adds monster-attack bonuses from passives", () => {
    const e = engine();
    const state = reveal(game(e), "monster_free#0");
    slain(state, "p1").push("monster_bonus#0");
    state.monsterDeck = state.monsterDeck.filter((m) => m !== "monster_bonus#0");
    const r = attack(e, dice(state, 4, 3), "monster_free#0");
    expect(r.events[0]).toMatchObject({ dice: [4, 3], bonus: 1, total: 8, outcome: "slain" });
  });
});

describe("a slain monster", () => {
  it("grants its reward passive to later rolls", () => {
    const e = engine();
    const state = inParty(reveal(game(e), "monster_free#0"), "p1", "hero_wizard#0");
    const slew = attack(e, dice(state, 4, 4), "monster_free#0");
    // +3 to hero rolls: 2 + 2 makes 7, enough for the wizard's 7+.
    const r = act(e, dice(slew.state, 2, 2), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_wizard#0" });
    expect(r.events[0]).toMatchObject({ rollKind: "heroEffect", dice: [2, 2], bonus: 3, total: 7, succeeded: true });
  });

  it("runs onMonsterSlain passives, its own included", () => {
    const e = engine();
    const state = reveal(game(e), "monster_draws#0");
    const r = attack(e, dice(state, 4, 4), "monster_draws#0");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "MONSTER_SLAIN", "MONSTER_REVEALED", "CARD_DRAWN"]);
  });

  it("leaves its slot empty when the monster deck is empty, and the game goes on", () => {
    const e = engine();
    const state = reveal(game(e), "monster_free#0", "monster_pair#0");
    state.monsterDeck = [];
    const r = attack(e, dice(state, 4, 4), "monster_free#0");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "MONSTER_SLAIN"]);
    expect(r.state.activeMonsters).toEqual(["monster_pair#0"]);
    expect(r.state.phase).toEqual({ kind: "action" });
    const next = act(e, r.state, { type: "END_TURN", player: "p1" });
    expect(next.state.activePlayer).toBe("p2");
    expect(e.getPlayerView(next.state, "p2").activeMonsters.map((m) => m.id)).toEqual(["monster_pair#0"]);
  });
});

describe("the monster win", () => {
  it("is won by slaying monstersToWin monsters, even mid-turn with AP left", () => {
    const e = engine();
    const state = reveal(game(e, { actionPointsPerTurn: 6 }), "monster_free#0", "monster_bonus#0", "monster_draws#0");
    let s = attack(e, dice(state, 6, 6), "monster_free#0").state;
    s = attack(e, dice(s, 6, 6), "monster_bonus#0").state;
    expect(s.winner).toBeNull();
    const r = attack(e, dice(s, 6, 6), "monster_draws#0");
    // The win comes once the slay is done, before the slain monster's onMonsterSlain draw.
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "MONSTER_SLAIN", "MONSTER_REVEALED", "GAME_WON"]);
    expect(r.events.at(-1)).toEqual({ type: "GAME_WON", player: "p1", reason: "monsters" });
    expect(r.state).toMatchObject({ winner: "p1", winReason: "monsters", phase: { kind: "gameOver" }, stack: [] });
    expect(e.getLegalActions(r.state, "p1")).toEqual([]);
  });

  it("is reached over several turns of a game", () => {
    const e = engine();
    let s = reveal(game(e), "monster_free#0", "monster_bonus#0", "monster_draws#0");
    for (const monster of ["monster_free#0", "monster_bonus#0", "monster_draws#0"]) {
      expect(s.activePlayer).toBe("p1");
      s = attack(e, dice(s, 5, 5), monster).state;
      if (s.winner !== null) break;
      for (const p of ["p1", "p2", "p3"]) s = act(e, s, { type: "END_TURN", player: p }).state;
    }
    expect(slain(s, "p1")).toEqual(["monster_free#0", "monster_bonus#0", "monster_draws#0"]);
    expect(s).toMatchObject({ winner: "p1", winReason: "monsters", turnNumber: 7 });
    expect(e.getPlayerView(s, "p2")).toMatchObject({ winner: "p1", winReason: "monsters" });
  });

  it("follows monstersToWin", () => {
    const e = engine();
    const state = reveal(game(e, { monstersToWin: 1 }), "monster_free#0");
    const r = attack(e, dice(state, 6, 6), "monster_free#0");
    expect(r.state).toMatchObject({ winner: "p1", winReason: "monsters" });
  });
});
