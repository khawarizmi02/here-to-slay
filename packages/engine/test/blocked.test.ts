import { describe, expect, it } from "vitest";
import { describeRequirement, type Action, type BlockedAction, type GameState, type PlayerView } from "../src/index.js";
import { act, decision, engineWith, equip, give, inParty, leader, start, type Engine } from "./scenario.js";

function monster(name: string, requirement: unknown) {
  return {
    id: `monster_${name}`,
    type: "monster",
    name,
    text: "",
    copies: 1,
    requirement,
    slayAt: 8,
    defeatAt: 4,
    penalty: { op: "draw", who: "self", amount: 1 },
    reward: { hook: "modifyRollTotal", value: 1 },
  };
}

const EXTRA = [
  monster("free", { kind: "none" }),
  monster("pair", { kind: "heroCount", min: 2 }),
  monster("thieves", { kind: "classCount", class: "thief", min: 2 }),
  monster("both", { kind: "all", of: [{ kind: "heroCount", min: 3 }, { kind: "classCount", class: "bard", min: 1 }] }),
  { id: "magic_draw", type: "magic", name: "Draw", text: "", copies: 1, effect: { op: "draw", who: "self", amount: 1 } },
  { id: "cursed_plain", type: "cursedItem", name: "Curse", text: "", copies: 1 },
];

const engine = () => engineWith({}, 0, EXTRA);

/** p1, a fighter leader, starts their turn with an empty hand and party, and only `monsters` face up. */
function game(e: Engine, ...monsters: string[]): GameState {
  const state = leader(start(e, { freeRollOnHeroPlay: false }), "p1", "fighter");
  for (const p of state.players) {
    state.mainDeck.push(...p.hand);
    p.hand = [];
  }
  const all = [...state.activeMonsters, ...state.monsterDeck];
  state.activeMonsters = monsters;
  state.monsterDeck = all.filter((m) => !monsters.includes(m)).sort();
  return state;
}

const blocked = (e: Engine, state: GameState, player = "p1") => e.getPlayerView(state, player).blockedActions;
const reasonFor = (e: Engine, state: GameState, type: BlockedAction["type"], subject?: string) =>
  blocked(e, state).find((b) => b.type === type && b.subject === subject)?.reason;

/** The card, monster or hero an action is about, as a blocked action's `subject`. */
function subjectOf(action: Action): string | undefined {
  if ("card" in action) return action.card;
  if ("monster" in action) return action.monster;
  if ("hero" in action) return action.hero;
  return undefined;
}

/** Every (type, subject) pair a view offers, legal or blocked, with which it is; fails on one that is both. */
function controls(view: PlayerView): Map<string, "legal" | "blocked"> {
  const map = new Map<string, "legal" | "blocked">();
  for (const a of view.legalActions) if (a.type !== "END_TURN") map.set(`${a.type} ${subjectOf(a) ?? ""}`, "legal");
  for (const b of view.blockedActions) {
    const key = `${b.type} ${b.subject ?? ""}`;
    expect(map.get(key), `${key} is both legal and blocked`).toBeUndefined();
    map.set(key, "blocked");
  }
  return map;
}

describe("blocked actions in the PlayerView", () => {
  it("names the requirement a monster's Attack is missing", () => {
    const e = engine();
    const state = game(e, "monster_free#0", "monster_pair#0", "monster_thieves#0", "monster_both#0");
    expect(reasonFor(e, state, "ATTACK_MONSTER", "monster_free#0")).toBeUndefined();
    // The leader counts as one hero.
    expect(reasonFor(e, state, "ATTACK_MONSTER", "monster_pair#0")).toBe("Needs 2 heroes");
    expect(reasonFor(e, state, "ATTACK_MONSTER", "monster_thieves#0")).toBe("Needs 2 Thieves");
    expect(reasonFor(e, state, "ATTACK_MONSTER", "monster_both#0")).toBe("Needs 3 heroes and 1 Bard");
    inParty(state, "p1", "hero_wizard#0");
    expect(reasonFor(e, state, "ATTACK_MONSTER", "monster_pair#0")).toBeUndefined();
  });

  it("gives the requirement before the AP when both are missing", () => {
    const e = engine();
    const state = game(e, "monster_free#0", "monster_pair#0");
    state.actionPoints = 1;
    expect(reasonFor(e, state, "ATTACK_MONSTER", "monster_pair#0")).toBe("Needs 2 heroes");
    expect(reasonFor(e, state, "ATTACK_MONSTER", "monster_free#0")).toBe("Needs 2 AP");
  });

  it("blocks Draw on an empty deck and Discard and Redraw on too little AP", () => {
    const e = engine();
    const state = game(e);
    expect(reasonFor(e, state, "DRAW_CARD")).toBeUndefined();
    expect(reasonFor(e, state, "DISCARD_AND_REDRAW")).toBeUndefined();
    state.actionPoints = 2;
    expect(reasonFor(e, state, "DISCARD_AND_REDRAW")).toBe("Needs 3 AP");
    state.discardPile.push(...state.mainDeck);
    state.mainDeck = [];
    expect(reasonFor(e, state, "DRAW_CARD")).toBeUndefined(); // the discard pile is reshuffled
    state.discardPile = [];
    expect(reasonFor(e, state, "DRAW_CARD")).toBe("The deck is empty");
  });

  it("blocks an item with no hero to go on, and a hero that has rolled", () => {
    const e = engine();
    const state = game(e);
    give(state, "p1", "item_plain#0", "cursed_plain#0");
    expect(reasonFor(e, state, "PLAY_ITEM", "item_plain#0")).toBe("Needs a hero with no item");
    expect(reasonFor(e, state, "PLAY_ITEM", "cursed_plain#0")).toBe("Needs a hero with no item");
    // A Cursed item may go on another player's hero.
    inParty(state, "p2", "hero_bard#0");
    expect(reasonFor(e, state, "PLAY_ITEM", "cursed_plain#0")).toBeUndefined();
    inParty(state, "p1", "hero_wizard#0");
    expect(reasonFor(e, state, "PLAY_ITEM", "item_plain#0")).toBeUndefined();
    equip(state, "hero_wizard#0", "item_plain#1");
    expect(reasonFor(e, state, "PLAY_ITEM", "item_plain#0")).toBe("Needs a hero with no item");

    expect(reasonFor(e, state, "ROLL_HERO_EFFECT", "hero_wizard#0")).toBeUndefined();
    state.players[0]!.party[0]!.rolledThisTurn = true;
    expect(reasonFor(e, state, "ROLL_HERO_EFFECT", "hero_wizard#0")).toBe("Already rolled this turn");
  });

  it("blocks every play on AP once it runs out", () => {
    const e = engine();
    const state = game(e, "monster_free#0");
    give(state, "p1", "hero_bard#0", "magic_draw#0");
    inParty(state, "p1", "hero_wizard#0");
    state.actionPoints = 0;
    const view = e.getPlayerView(state, "p1");
    expect(view.legalActions).toEqual([{ type: "END_TURN", player: "p1" }]);
    expect(view.blockedActions).toEqual([
      { type: "DRAW_CARD", reason: "Needs 1 AP" },
      { type: "PLAY_HERO", subject: "hero_bard#0", reason: "Needs 1 AP" },
      { type: "PLAY_MAGIC", subject: "magic_draw#0", reason: "Needs 1 AP" },
      { type: "ROLL_HERO_EFFECT", subject: "hero_wizard#0", reason: "Needs 1 AP" },
      { type: "ATTACK_MONSTER", subject: "monster_free#0", reason: "Needs 2 AP" },
      { type: "DISCARD_AND_REDRAW", reason: "Needs 3 AP" },
    ]);
  });

  it("puts every control in exactly one of legalActions and blockedActions", () => {
    const e = engine();
    const state = game(e, "monster_free#0", "monster_thieves#0");
    give(state, "p1", "hero_bard#0", "magic_draw#0", "item_plain#0", "challenge#0", "mod#0");
    inParty(state, "p1", "hero_wizard#0");
    const view = e.getPlayerView(state, "p1");
    expect([...controls(view).entries()]).toEqual(
      expect.arrayContaining([
        ["DRAW_CARD ", "legal"],
        ["PLAY_HERO hero_bard#0", "legal"],
        ["PLAY_MAGIC magic_draw#0", "legal"],
        ["PLAY_ITEM item_plain#0", "legal"],
        ["ROLL_HERO_EFFECT hero_wizard#0", "legal"],
        ["ATTACK_MONSTER monster_free#0", "legal"],
        ["ATTACK_MONSTER monster_thieves#0", "blocked"],
        ["DISCARD_AND_REDRAW ", "legal"],
      ]),
    );
    // Challenges and Modifiers are responses, not turn actions.
    expect(controls(view).size).toBe(8);
  });

  it("is empty for other players, spectators, Response Windows and Decisions", () => {
    const e = engine();
    let state = game(e, "monster_pair#0");
    expect(blocked(e, state, "p2")).toEqual([]);
    expect(e.getPlayerView(state, "spectator").blockedActions).toEqual([]);

    give(state, "p1", "hero_bard#0");
    state = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).state;
    expect(e.getPlayerView(state, "spectator").responseWindow).not.toBeNull();
    expect(blocked(e, state)).toEqual([]);

    state = game(e);
    state.actionPoints = 3;
    give(state, "p1", ...state.mainDeck.slice(0, 12));
    state = act(e, state, { type: "END_TURN", player: "p1" }).state;
    expect(decision(state).player).toBe("p1");
    expect(blocked(e, state)).toEqual([]);
  });
});

describe("describeRequirement", () => {
  it("puts a requirement in words", () => {
    expect(describeRequirement({ kind: "heroCount", min: 1 })).toBe("1 hero");
    expect(describeRequirement({ kind: "classCount", class: "guardian", min: 1 })).toBe("1 Guardian");
    expect(describeRequirement({ kind: "classCount", class: "thief", min: 3 })).toBe("3 Thieves");
  });
});
