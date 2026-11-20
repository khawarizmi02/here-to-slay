import { describe, expect, it } from "vitest";
import type { Action, ConfigPatch } from "@here-to-slay/protocol";
import { placeholderCardDefs } from "@here-to-slay/cards";
import { botFactory, createEasyBot, createRng, createRoomEngine, nextFloat, type GameState } from "../src/index.js";
import { players } from "./cards.js";
import { act, decision, defsWith, dice, engineWith, equip, give, inParty, leader, play, start, type Engine } from "./scenario.js";

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

/** A Magic card `magic_<name>` with `effect`. */
function magic(name: string, effect: unknown) {
  return { id: `magic_${name}`, type: "magic", name, text: "", copies: 1, effect };
}

const EXTRA = [
  monster("eight", 8),
  monster("nine", 9),
  monster("plus_one", 12, 1),
  { id: "cursed", type: "cursedItem", name: "Cursed", text: "", copies: 1, passive: { hook: "modifyRollTotal", value: -1 } },
  { id: "magic_draw", type: "magic", name: "Magic", text: "", copies: 1, effect: { op: "draw", who: "self", amount: 1 } },
  magic("pull", { op: "pull", from: { choose: "otherWithCards" }, amount: 1 }),
  magic("discard", { op: "discard", who: "self", amount: 1, chosenBy: "self" }),
  magic("sacrifice", { op: "sacrifice", who: "self", amount: 1 }),
  magic("may_draw", { op: "optional", chooser: "self", effect: { op: "draw", who: "self", amount: 2 } }),
  magic("offering", {
    op: "optional",
    chooser: "self",
    effect: { op: "sequence", steps: [{ op: "draw", who: "self", amount: 3 }, { op: "sacrifice", who: "self", amount: 1 }] },
  }),
  { id: "hero_hard", type: "hero", name: "Hard", text: "", copies: 1, class: "bard", rollRequirement: 12, effect: { op: "draw", who: "self", amount: 1 } },
];

const engine = () => engineWith({}, 0, EXTRA);
const defs = defsWith({}, 0, EXTRA);

/** p1's turn as a fighter leader, with an empty hand and no monsters face up, under the default rules or `config`. */
function game(e: Engine, config: ConfigPatch = {}): GameState {
  const state = leader(start(e, { freeRollOnHeroPlay: false, ...config }), "p1", "fighter");
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

describe("the bot for a Seat", () => {
  it("is the easy bot at either difficulty: there is no normal bot yet", () => {
    const e = engine();
    const state = reveal(give(game(e), "p1", "hero_wizard#0"), "monster_eight#0");
    const legal = e.getLegalActions(state, "p1");
    for (const difficulty of ["easy", "normal"] as const) {
      for (const r of [0, 0.999]) {
        const bot = botFactory(defs, () => r)({ id: "p1", difficulty });
        expect(bot.chooseAction(e.getPlayerView(state, "p1"), legal)).toEqual({ type: "ATTACK_MONSTER", player: "p1", monster: "monster_eight#0" });
      }
    }
  });
});

/** p1 plays a wizard hero, which p2 may Challenge, holding a Challenge. */
function challengeWindow(e: Engine, state: GameState): GameState {
  give(give(state, "p1", "hero_wizard#0"), "p2", "challenge#0");
  return act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_wizard#0" }).state;
}

describe("easy bot, a Challenge Window", () => {
  it("Challenges a player one class away from winning, whatever the dice of chance say", () => {
    const e = engine();
    // A fighter leader and four more classes: 5 of 6.
    const state = challengeWindow(e, inParty(game(e), "p1", "hero_thief#0", "hero_bard#0", "hero_ranger#0", "hero_guardian#0"));
    expect(choose(e, state, "p2", () => 0.99)).toEqual({ type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
  });

  it("Challenges a player one monster away from winning", () => {
    const e = engine();
    const state = challengeWindow(e, slay(slay(game(e), "p1", "monster_eight#0"), "p1", "monster_nine#0"));
    expect(choose(e, state, "p2", () => 0.99)).toEqual({ type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
  });

  it("counts how close a player is to winning by the game's own rules", () => {
    const e = engine();
    // One monster slain is far from 3, but one away from 2.
    const oneSlain = (config: ConfigPatch) => challengeWindow(e, slay(game(e, config), "p1", "monster_eight#0"));
    expect(choose(e, oneSlain({}), "p2", () => 0.99)).toEqual({ type: "PASS", player: "p2" });
    expect(choose(e, oneSlain({ monstersToWin: 2 }), "p2", () => 0.99)).toEqual({ type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
  });

  it("passes on a player far from winning, except 20% of the time", () => {
    const e = engine();
    const state = challengeWindow(e, inParty(game(e), "p1", "hero_thief#0"));
    expect(choose(e, state, "p2", () => 0.2)).toEqual({ type: "PASS", player: "p2" });
    expect(choose(e, state, "p2", () => 0.99)).toEqual({ type: "PASS", player: "p2" });
    expect(choose(e, state, "p2", () => 0.19)).toEqual({ type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
  });
});

/** `player` rolls their thief (7+ to roll) with the dice `a`, `b`, holding a ±2 Modifier; the Modifier Window is open. */
function heroRoll(e: Engine, state: GameState, player: string, a: number, b: number): GameState {
  state.activePlayer = player;
  give(inParty(state, player, "hero_thief#0"), player === "p1" ? "p2" : "p1", "mod#0");
  give(state, player, "mod#1");
  return act(e, dice(state, a, b), { type: "ROLL_HERO_EFFECT", player, hero: "hero_thief#0" }).state;
}

describe("easy bot, a Modifier Window", () => {
  it("lifts its own roll to its roll number: 6 + 2 makes 7", () => {
    const e = engine();
    const state = heroRoll(e, game(e), "p1", 3, 3);
    expect(choose(e, state, "p1")).toMatchObject({ type: "PLAY_MODIFIER", player: "p1", card: "mod#1", value: 2 });
  });

  it("passes when a Modifier wouldn't change how its own roll turns out", () => {
    const e = engine();
    expect(choose(e, heroRoll(e, game(e), "p1", 4, 3), "p1")).toEqual({ type: "PASS", player: "p1" }); // 7 already
    expect(choose(e, heroRoll(e, game(e), "p1", 2, 2), "p1")).toEqual({ type: "PASS", player: "p1" }); // 4 + 2 is still short
  });

  it("drops the leading player's roll under its roll number: 7 - 2 makes 5", () => {
    const e = engine();
    const state = heroRoll(e, game(e), "p2", 4, 3);
    inParty(state, "p2", "hero_wizard#0", "hero_bard#0"); // p2 leads on 3 classes
    expect(choose(e, state, "p1")).toMatchObject({ type: "PLAY_MODIFIER", player: "p1", card: "mod#0", value: -2 });
  });

  it("turns a Challenge its way: the challenger's 6 + 2 beats the defender's 7", () => {
    const e = engine();
    const state = challengeWindow(e, game(e));
    give(state, "p2", "mod#0");
    // The challenger rolls 3 + 3, then the defender 4 + 3.
    const duel = act(e, dice(state, 3, 3, 4, 3), { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" }).state;
    const window = e.getPlayerView(duel, "p2").responseWindow;
    expect(window).toMatchObject({ kind: "modifier", rolls: [{ player: "p2", total: 6 }, { player: "p1", total: 7 }] });
    const mine = window?.kind === "modifier" ? window.rolls[0]!.roll : "";
    expect(choose(e, duel, "p2")).toEqual({ type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2, roll: mine });
  });

  it("settles a tied Challenge by the game's own rules: 5 + 2 ties the defender's 7", () => {
    const tiedDuel = (tieWinner: "challenger" | "challenged") => {
      const e = engine();
      const state = challengeWindow(e, game(e, { challengeTieWinner: tieWinner }));
      give(state, "p2", "mod#0");
      // The challenger rolls 2 + 3, then the defender 4 + 3.
      return { e, duel: act(e, dice(state, 2, 3, 4, 3), { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" }).state };
    };
    const won = tiedDuel("challenger");
    expect(choose(won.e, won.duel, "p2")).toMatchObject({ type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2 });
    const lost = tiedDuel("challenged");
    expect(choose(lost.e, lost.duel, "p2")).toEqual({ type: "PASS", player: "p2" });
  });

  it("lifts its own monster attack to the monster's slay value: 6 + 2 makes 8", () => {
    const e = engine();
    const state = give(reveal(game(e), "monster_eight#0"), "p1", "mod#1");
    const attack = act(e, dice(state, 3, 3), { type: "ATTACK_MONSTER", player: "p1", monster: "monster_eight#0" }).state;
    expect(choose(e, attack, "p1")).toMatchObject({ type: "PLAY_MODIFIER", player: "p1", card: "mod#1", value: 2 });
  });

  it("drops nobody's roll while no one opponent leads", () => {
    const e = engine();
    const state = heroRoll(e, game(e), "p2", 4, 3);
    inParty(state, "p3", "hero_wizard#0"); // p2 and p3 both have 2 classes
    expect(choose(e, state, "p1")).toEqual({ type: "PASS", player: "p1" });
  });

  it("leaves alone the roll of a player who isn't leading", () => {
    const e = engine();
    const state = heroRoll(e, game(e), "p2", 4, 3);
    inParty(state, "p3", "hero_wizard#0", "hero_bard#0", "hero_ranger#0"); // p3 leads, not p2
    expect(choose(e, state, "p1")).toEqual({ type: "PASS", player: "p1" });
  });
});

/** p1 plays `magic_<name>` and nobody Challenges it, so its effect starts; p2 and p3 hold a card each, to be pulled. */
function cast(e: Engine, state: GameState, name: string): GameState {
  give(give(give(state, "p1", `magic_${name}#0`), "p2", "item_plain#0"), "p3", "item_plain#1");
  return play(e, state, { type: "PLAY_MAGIC", player: "p1", card: `magic_${name}#0` }).state;
}

describe("easy bot, Decisions", () => {
  it("picks the player closest to winning", () => {
    const e = engine();
    const state = game(e);
    inParty(state, "p2", "hero_wizard#0", "hero_bard#0"); // 3 classes of 6: 1/2
    slay(slay(state, "p3", "monster_eight#0"), "p3", "monster_nine#0"); // 2 monsters of 3: 2/3
    const asked = cast(e, state, "pull");
    expect(decision(asked)).toMatchObject({ player: "p1", kind: "choosePlayer" });
    expect(choose(e, asked)).toMatchObject({ type: "RESOLVE_DECISION", answer: { selected: ["p3"] } });
    // Once p2 is a class away, p2 leads.
    inParty(asked, "p2", "hero_ranger#0", "hero_guardian#0");
    expect(choose(e, asked)).toMatchObject({ type: "RESOLVE_DECISION", answer: { selected: ["p2"] } });
  });

  it("discards its least useful card: a hero of a class it already has", () => {
    const e = engine();
    const state = give(game(e), "p1", "hero_wizard#0", "hero_fighter#0", "mod#0");
    const asked = cast(e, state, "discard");
    expect(decision(asked)).toMatchObject({ player: "p1", kind: "chooseCardFromHand", discard: true });
    expect(choose(e, asked, "p1", () => 0.999)).toMatchObject({ type: "RESOLVE_DECISION", answer: { selected: ["hero_fighter#0"] } });
  });

  it("sacrifices a hero whose class it keeps without it", () => {
    const e = engine();
    const state = inParty(game(e), "p1", "hero_wizard#0", "hero_thief#0", "hero_wizard#1");
    const asked = cast(e, state, "sacrifice");
    expect(decision(asked)).toMatchObject({ player: "p1", kind: "chooseHero", discard: true });
    expect(choose(e, asked)).toMatchObject({ type: "RESOLVE_DECISION", answer: { selected: [expect.stringMatching(/^hero_wizard/)] } });
  });

  it("takes up a 'you may' that only helps it", () => {
    const e = engine();
    const asked = cast(e, game(e), "may_draw");
    expect(decision(asked)).toMatchObject({ player: "p1", kind: "confirmOptional" });
    expect(choose(e, asked)).toMatchObject({ type: "RESOLVE_DECISION", answer: { selected: ["accept"] } });
  });

  it("declines a 'you may' that costs it a hero, but not when it has none to lose", () => {
    const e = engine();
    const asked = cast(e, inParty(game(e), "p1", "hero_thief#0"), "offering");
    expect(choose(e, asked)).toMatchObject({ type: "RESOLVE_DECISION", answer: { selected: ["decline"] } });
    const empty = cast(e, game(e), "offering");
    expect(choose(e, empty)).toMatchObject({ type: "RESOLVE_DECISION", answer: { selected: ["accept"] } });
  });
});

describe("easy bot, everything else", () => {
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
  }, 30_000);
});

