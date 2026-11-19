import { describe, expect, it } from "vitest";
import type { Action } from "@here-to-slay/protocol";
import { placeholderCardDefs } from "@here-to-slay/cards";
import { createEasyBot, createRng, createRoomEngine, nextFloat, type GameState } from "../src/index.js";
import { players } from "./cards.js";
import { act, defsWith, engineWith, equip, give, inParty, leader, start, type Engine } from "./scenario.js";

/** A monster with no requirement, slain on `slayAt`+, `monster_<name>`. Its reward adds `bonus` to monster attacks. */
function monster(name: string, slayAt: number, bonus = 0) {
  return {
    id: `monster_${name}`,
    type: "monster",
    name,
    text: "",
    copies: 1,
    requirement: { kind: "none" },
    slayAt,
    defeatAt: 2,
    penalty: { op: "draw", who: "self", amount: 1 },
    reward: { hook: "modifyRollTotal", condition: { rollKind: "monsterAttack" }, value: bonus },
  };
}

const EXTRA = [
  monster("eight", 8),
  monster("nine", 9),
  monster("plus_one", 12, 1),
  { id: "cursed", type: "cursedItem", name: "Cursed", text: "", copies: 1, passive: { hook: "modifyRollTotal", value: -1 } },
  { id: "magic_draw", type: "magic", name: "Magic", text: "", copies: 1, effect: { op: "draw", who: "self", amount: 1 } },
  { id: "hero_hard", type: "hero", name: "Hard", text: "", copies: 1, class: "bard", rollRequirement: 12, effect: { op: "draw", who: "self", amount: 1 } },
];

const engine = () => engineWith({}, 0, EXTRA);
const defs = defsWith({}, 0, EXTRA);

/** p1's turn as a fighter leader, with an empty hand and no monsters face up. */
function game(e: Engine): GameState {
  const state = leader(start(e, { freeRollOnHeroPlay: false }), "p1", "fighter");
  const p1 = state.players.find((p) => p.id === "p1")!;
  state.discardPile.push(...p1.hand);
  p1.hand = [];
  state.monsterDeck.push(...state.activeMonsters);
  state.activeMonsters = [];
  return state;
}

/** Puts `monsters` face up in the centre. */
function reveal(state: GameState, ...monsters: string[]): GameState {
  state.monsterDeck = state.monsterDeck.filter((m) => !monsters.includes(m));
  state.activeMonsters.push(...monsters);
  return state;
}

/** Gives `player` the slain monster `card`. */
function slay(state: GameState, player: string, card: string): GameState {
  state.monsterDeck = state.monsterDeck.filter((m) => m !== card);
  state.activeMonsters = state.activeMonsters.filter((m) => m !== card);
  state.players.find((p) => p.id === player)!.slainMonsters.push(card);
  return state;
}

/** Marks every hero in `player`'s party as rolled this turn, so none is worth rolling. */
function rolled(state: GameState, player = "p1"): GameState {
  for (const h of state.players.find((p) => p.id === player)!.party) h.rolledThisTurn = true;
  return state;
}

/** What the easy bot does as `player`, from that player's own view and legal actions. */
function choose(e: Engine, state: GameState, player = "p1", random = () => 0): Action {
  const bot = createEasyBot(defs, random);
  const legal = e.getLegalActions(state, player);
  const action = bot.chooseAction(e.getPlayerView(state, player), legal);
  expect(legal).toContainEqual(action);
  return action;
}

describe("easy bot, its own turn", () => {
  it("attacks a monster it slays on 8+ (41.7%) before playing a hero of a new class", () => {
    const e = engine();
    const state = reveal(give(game(e), "p1", "hero_wizard#0"), "monster_eight#0");
    expect(choose(e, state)).toEqual({ type: "ATTACK_MONSTER", player: "p1", monster: "monster_eight#0" });
  });

  it("skips a monster it slays on 9+ (27.8%), but attacks it with a +1 bonus from a slain monster (41.7%)", () => {
    const e = engine();
    const state = reveal(game(e), "monster_nine#0");
    expect(choose(e, state).type).not.toBe("ATTACK_MONSTER");
    slay(state, "p1", "monster_plus_one#0");
    expect(choose(e, state)).toEqual({ type: "ATTACK_MONSTER", player: "p1", monster: "monster_nine#0" });
  });

  it("counts the items in its party against the 40% line", () => {
    const e = engine();
    const state = reveal(inParty(game(e), "p1", "hero_wizard#0"), "monster_eight#0");
    // A -1 Cursed Item drops 8+ to 9+.
    equip(state, "hero_wizard#0", "cursed#0");
    expect(choose(e, state).type).not.toBe("ATTACK_MONSTER");
  });

  it("plays a hero of a class it lacks before rolling a hero", () => {
    const e = engine();
    const state = inParty(give(game(e), "p1", "hero_fighter#0", "hero_wizard#0"), "p1", "hero_thief#0");
    expect(choose(e, state)).toEqual({ type: "PLAY_HERO", player: "p1", card: "hero_wizard#0" });
  });

  it("rolls a hero whose roll number it can reach before playing an item", () => {
    const e = engine();
    const state = inParty(give(game(e), "p1", "item_plain#0"), "p1", "hero_thief#0");
    expect(choose(e, state)).toEqual({ type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_thief#0" });
  });

  it("doesn't roll a hero it can't reach: 12+ with a -1 Cursed Item", () => {
    const e = engine();
    const state = equip(inParty(game(e), "p1", "hero_hard#0"), "hero_hard#0", "cursed#0");
    expect(choose(e, state).type).not.toBe("ROLL_HERO_EFFECT");
  });

  it("plays an item on its best hero, the easiest to roll, before playing Magic", () => {
    const e = engine();
    const state = rolled(inParty(give(game(e), "p1", "magic_draw#0", "item_plain#0"), "p1", "hero_hard#0", "hero_thief#0"));
    expect(choose(e, state)).toEqual({ type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_thief#0" });
  });

  it("plays a Cursed Item on a hero of the player closest to winning, never its own", () => {
    const e = engine();
    const state = rolled(inParty(give(game(e), "p1", "magic_draw#0", "cursed#0"), "p1", "hero_thief#0"));
    inParty(state, "p2", "hero_wizard#0", "hero_ranger#0"); // 3 classes of 6: 1/2
    inParty(state, "p3", "hero_bard#0");
    slay(slay(state, "p3", "monster_eight#0"), "p3", "monster_nine#0"); // 2 monsters of 3: 2/3
    expect(choose(e, state)).toEqual({ type: "PLAY_ITEM", player: "p1", card: "cursed#0", targetHero: "hero_bard#0" });
  });

  it("plays Magic before drawing", () => {
    const e = engine();
    const state = give(game(e), "p1", "magic_draw#0");
    expect(choose(e, state, "p1", () => 0.999)).toEqual({ type: "PLAY_MAGIC", player: "p1", card: "magic_draw#0" });
  });

  it("draws rather than play a hero of a class it already has", () => {
    const e = engine();
    const state = give(game(e), "p1", "hero_fighter#0");
    expect(choose(e, state, "p1", () => 0.999)).toEqual({ type: "DRAW_CARD", player: "p1" });
  });

  it("ends the turn when it has nothing better to do", () => {
    const e = engine();
    const state = give(game(e), "p1", "hero_fighter#0");
    state.actionPoints = 1;
    // Nothing to draw: no deck, and no discard pile to shuffle into one.
    state.mainDeck = [];
    state.discardPile = [];
    const legal = e.getLegalActions(state, "p1").map((a) => a.type);
    expect(legal).not.toContain("DRAW_CARD");
    expect(legal).toContain("PLAY_HERO");
    expect(choose(e, state, "p1", () => 0)).toEqual({ type: "END_TURN", player: "p1" });
  });
});

describe("easy bot, everything else", () => {
  it("answers a Response Window with a random legal action", () => {
    const e = engine();
    const state = give(game(e), "p1", "hero_wizard#0");
    give(state, "p2", "challenge#0");
    const played = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_wizard#0" }).state;
    const legal = e.getLegalActions(played, "p2");
    expect(legal.map((a) => a.type).sort()).toEqual(["PASS", "PLAY_CHALLENGE"]);
    expect(choose(e, played, "p2", () => 0)).toEqual(legal[0]);
    expect(choose(e, played, "p2", () => 0.999)).toEqual(legal[1]);
  });

  it("works from its own view, which shows other hands only as counts", () => {
    const e = engine();
    const state = reveal(game(e), "monster_eight#0");
    const view = e.getPlayerView(state, "p1");
    for (const p of view.players) expect(Object.keys(p)).not.toContain("hand");
    expect(view.players[1]!.handCount).toBeGreaterThan(0);
    // A copy, as a Room sends it: nothing in it is the engine's.
    const copy = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
    const action = createEasyBot(defs, () => 0).chooseAction(copy, e.getLegalActions(state, "p1"));
    expect(action).toEqual({ type: "ATTACK_MONSTER", player: "p1", monster: "monster_eight#0" });
  });

  it("only ever takes a legal action, through whole games of four easy bots", () => {
    const cards = placeholderCardDefs;
    const e = createRoomEngine(cards);
    for (let seed = 0; seed < 10; seed++) {
      // The engine's seeded RNG stands in for Math.random, so a failure replays.
      let rng = createRng(`bot-${seed}`);
      const random = () => {
        const [x, next] = nextFloat(rng);
        rng = next;
        return x;
      };
      const bot = createEasyBot(cards, random);
      let state = e.createGame({ players: players(4), seed: `easy-${seed}`, config: {} });
      for (let n = 0; state.winner === null; n++) {
        expect(n, `seed ${seed} ran past 5,000 actions`).toBeLessThan(5_000);
        const actor = state.players.find((p) => e.getLegalActions(state, p.id).length > 0)!;
        const legal = e.getLegalActions(state, actor.id);
        const action = bot.chooseAction(e.getPlayerView(state, actor.id), legal);
        expect(legal).toContainEqual(action);
        const r = e.applyAction(state, action);
        expect(r.ok, r.error).toBe(true);
        state = r.state;
      }
    }
  });
});

