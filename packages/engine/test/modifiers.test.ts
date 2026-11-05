import { describe, expect, it } from "vitest";
import type { ConfigPatch } from "@here-to-slay/protocol";
import { loadCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameState } from "../src/index.js";
import { smallSet } from "./cards.js";
import { act, awaiting, dice, engineWith, give, hand, inParty, passAll, passWindow, start, type Engine } from "./scenario.js";

/*
 * Modifier Windows and nested rolls (TECHNICAL_DESIGN.md §3.6, §7.3).
 * The small set's Modifier, `mod`, offers +2 or −2; it has two copies.
 */

/** A 3-player game with every hand empty, so each test gives out exactly the cards it needs. */
function table(e: Engine, config: ConfigPatch = {}): GameState {
  const state = start(e, { freeRollOnHeroPlay: false, ...config });
  for (const p of state.players) {
    state.discardPile.push(...p.hand);
    p.hand = [];
  }
  return state;
}

const BARD = { id: "hero_bard#0", def: "hero_bard" };
const ROLL = { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" } as const;

/** p1 rolls the bard (needs 7, draws 1 card) with the dice `a`, `b`. */
function rolled(e: Engine, state: GameState, a: number, b: number) {
  return act(e, dice(inParty(state, "p1", "hero_bard#0"), a, b), ROLL);
}

describe("a Modifier Window", () => {
  it("opens after a hero roll and offers PASS to every player, the roller included, whatever they hold", () => {
    const e = engineWith();
    const r = rolled(e, table(e), 3, 3);
    expect(r.events).toEqual([
      { type: "DICE_ROLLED", roll: "r1", player: "p1", rollKind: "heroEffect", hero: BARD, dice: [3, 3], bonus: 0, total: 6 },
    ]);
    expect(r.state.phase).toEqual({ kind: "resolving" });
    expect(awaiting(e, r.state)).toEqual(["p1", "p2", "p3"]);
    expect(e.getPlayerView(r.state, "p2").responseWindow).toEqual({
      kind: "modifier",
      awaiting: ["p1", "p2", "p3"],
      rolls: [{ roll: "r1", player: "p1", total: 6, modifiers: [] }],
    });
    for (const p of ["p1", "p2", "p3"]) expect(e.getLegalActions(r.state, p)).toEqual([{ type: "PASS", player: p }]);
    expect(e.applyAction(r.state, { type: "END_TURN", player: "p1" }).ok).toBe(false);
  });

  it("closes once everyone has passed; the total is final then", () => {
    const e = engineWith();
    const r = passAll(e, rolled(e, table(e), 3, 3).state);
    expect(r.events).toEqual([{ type: "ROLL_RESOLVED", roll: "r1", player: "p1", rollKind: "heroEffect", hero: BARD, total: 6, succeeded: false }]);
    expect(r.state.phase).toEqual({ kind: "action" });
    expect(e.getPlayerView(r.state, "p1").responseWindow).toBeNull();
  });

  it("offers a PLAY_MODIFIER per option of each Modifier in hand, naming the roll, at no AP cost", () => {
    const e = engineWith();
    const state = give(give(table(e), "p1", "mod#0"), "p3", "mod#1");
    const r = rolled(e, state, 3, 3);
    expect(e.getLegalActions(r.state, "p3")).toEqual([
      { type: "PASS", player: "p3" },
      { type: "PLAY_MODIFIER", player: "p3", card: "mod#1", value: 2, roll: "r1" },
      { type: "PLAY_MODIFIER", player: "p3", card: "mod#1", value: -2, roll: "r1" },
    ]);
    // The roller may modify their own roll.
    expect(e.getLegalActions(r.state, "p1")).toContainEqual({ type: "PLAY_MODIFIER", player: "p1", card: "mod#0", value: 2, roll: "r1" });
    expect(e.applyAction(r.state, { type: "PLAY_MODIFIER", player: "p3", card: "mod#1", value: 4, roll: "r1" }).ok).toBe(false);
    expect(e.applyAction(r.state, { type: "PLAY_MODIFIER", player: "p3", card: "mod#0", value: 2, roll: "r1" }).ok).toBe(false);
    expect(e.applyAction(r.state, { type: "PLAY_MODIFIER", player: "p3", card: "mod#1", value: 2, roll: "r9" }).ok).toBe(false);

    const played = act(e, r.state, { type: "PLAY_MODIFIER", player: "p3", card: "mod#1", value: 2, roll: "r1" });
    expect(played.events).toEqual([{ type: "MODIFIER_PLAYED", player: "p3", card: { id: "mod#1", def: "mod" }, roll: "r1", value: 2, total: 8 }]);
    expect(hand(played.state, "p3")).toEqual([]);
    expect(played.state.discardPile.at(-1)).toBe("mod#1");
    expect(played.state.actionPoints).toBe(2);

    const done = passAll(e, played.state);
    expect(done.events.map((ev) => ev.type)).toEqual(["ROLL_RESOLVED", "CARD_DRAWN"]);
    expect(done.events[0]).toMatchObject({ total: 8, succeeded: true });
  });

  it("takes a PLAY_MODIFIER with no roll id when it holds one roll", () => {
    const e = engineWith();
    const r = rolled(e, give(table(e), "p2", "mod#0"), 3, 3);
    const played = act(e, r.state, { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: -2 });
    expect(played.events[0]).toMatchObject({ type: "MODIFIER_PLAYED", roll: "r1", total: 4 });
  });

  it("reopens to everyone after a response, so the last player to respond can be answered", () => {
    const e = engineWith();
    const r = rolled(e, give(give(table(e), "p2", "mod#0"), "p3", "mod#1"), 4, 3);
    let s = act(e, r.state, { type: "PASS", player: "p1" }).state;
    s = act(e, s, { type: "PASS", player: "p2" }).state;
    expect(awaiting(e, s)).toEqual(["p3"]);
    s = act(e, s, { type: "PLAY_MODIFIER", player: "p3", card: "mod#1", value: -2, roll: "r1" }).state;
    // p3 is asked again too, and p2 can answer p3.
    expect(awaiting(e, s)).toEqual(["p1", "p2", "p3"]);
    s = act(e, s, { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2, roll: "r1" }).state;
    expect(e.getPlayerView(s, "p1").responseWindow).toMatchObject({
      rolls: [{ roll: "r1", total: 7, modifiers: [{ player: "p3", card: "mod#1", value: -2 }, { player: "p2", card: "mod#0", value: 2 }] }],
    });
    const done = passAll(e, s);
    expect(done.events[0]).toMatchObject({ type: "ROLL_RESOLVED", total: 7, succeeded: true });
  });

  it("opens after a monster attack, whose outcome uses the modified total", () => {
    const e = engineWith();
    const state = give(table(e), "p2", "mod#0");
    const monster = state.activeMonsters[0]!;
    const r = act(e, dice(state, 3, 3), { type: "ATTACK_MONSTER", player: "p1", monster });
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(awaiting(e, r.state)).toEqual(["p1", "p2", "p3"]);
    // 6 does nothing; p2's −2 makes it a defeat (4 or less).
    const played = act(e, r.state, { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: -2, roll: "r1" });
    const done = passAll(e, played.state);
    expect(done.events[0]).toMatchObject({ type: "ROLL_RESOLVED", rollKind: "monsterAttack", total: 4, outcome: "defeated" });
  });

  it("holds the turn open when the roll used the last AP, until it closes", () => {
    const e = engineWith();
    const state = table(e);
    state.actionPoints = 1;
    const r = rolled(e, state, 1, 1);
    expect(e.getActivePlayer(r.state)).toBe("p1");
    expect(e.getActivePlayer(passAll(e, r.state).state)).toBe("p2");
  });
});

describe("a Modifier Window in a Challenge", () => {
  /** p1 plays the bard; p3 Challenges it. Both roll, then one window covers both rolls. */
  function duel(e: Engine, state: GameState, ...rolls: number[]) {
    give(give(state, "p1", "hero_bard#0"), "p3", "challenge#0");
    const played = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).state;
    return act(e, dice(played, ...rolls), { type: "PLAY_CHALLENGE", player: "p3", card: "challenge#0" });
  }

  it("opens once both have rolled, covering both rolls, and offers modifiers on either", () => {
    const e = engineWith();
    const r = duel(e, give(table(e), "p2", "mod#0"), 4, 3, 3, 3);
    expect(r.events.map((ev) => ev.type)).toEqual(["CHALLENGE_PLAYED", "DICE_ROLLED", "DICE_ROLLED"]);
    expect(e.getPlayerView(r.state, "p1").responseWindow).toEqual({
      kind: "modifier",
      awaiting: ["p3", "p1", "p2"],
      rolls: [
        { roll: "r1", player: "p3", total: 7, modifiers: [] },
        { roll: "r2", player: "p1", total: 6, modifiers: [] },
      ],
    });
    expect(e.getLegalActions(r.state, "p2")).toEqual([
      { type: "PASS", player: "p2" },
      { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2, roll: "r1" },
      { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: -2, roll: "r1" },
      { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2, roll: "r2" },
      { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: -2, roll: "r2" },
    ]);
    // With two rolls, a PLAY_MODIFIER must name one.
    expect(e.applyAction(r.state, { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2 }).ok).toBe(false);
  });

  it("lets a modifier on the defender's roll turn the Challenge", () => {
    const e = engineWith();
    const r = duel(e, give(table(e), "p2", "mod#0"), 4, 3, 3, 3);
    const played = act(e, r.state, { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2, roll: "r2" });
    const done = passAll(e, played.state);
    expect(done.events[0]).toMatchObject({ type: "CHALLENGE_RESOLVED", challengerTotal: 7, defenderTotal: 8, succeeded: false });
    expect(done.state.players[0]!.party.map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
  });

  it("lets a modifier on the challenger's roll turn the Challenge", () => {
    const e = engineWith();
    const r = duel(e, give(table(e), "p1", "mod#0"), 4, 3, 3, 3);
    const played = act(e, r.state, { type: "PLAY_MODIFIER", player: "p1", card: "mod#0", value: -2, roll: "r1" });
    const done = passAll(e, played.state);
    expect(done.events[0]).toMatchObject({ type: "CHALLENGE_RESOLVED", challengerTotal: 5, defenderTotal: 6, succeeded: false });
  });

  it("works on a Challenge against an Item", () => {
    const e = engineWith();
    const state = give(give(inParty(table(e), "p1", "hero_bard#0"), "p1", "item_plain#0", "mod#0"), "p2", "challenge#0");
    const played = act(e, state, { type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_bard#0" }).state;
    const r = act(e, dice(played, 5, 5, 4, 4), { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
    // 10 against 8: p1's +2 on their own roll ties it, which goes to the challenger; nothing else changes that.
    const modified = act(e, r.state, { type: "PLAY_MODIFIER", player: "p1", card: "mod#0", value: 2, roll: "r2" });
    expect(modified.events[0]).toMatchObject({ type: "MODIFIER_PLAYED", roll: "r2", total: 10 });
    const done = passAll(e, modified.state);
    expect(done.events.map((ev) => ev.type)).toEqual(["CHALLENGE_RESOLVED"]);
    expect(done.events[0]).toMatchObject({ challengerTotal: 10, defenderTotal: 10, succeeded: true });
    expect(done.state.players[0]!.party[0]!.equippedItem).toBeNull();
    expect(done.state.discardPile.slice(-1)).toEqual(["item_plain#0"]);
  });
});

/** Rolls for one of your heroes that hasn't rolled this turn: a nested roll. */
const ROLL_HERO = { op: "custom", handler: "rollHero" } as const;

describe("a nested roll", () => {
  it("in a hero's effect gets its own window, which closes before the rest of the effect runs", () => {
    const e = engineWith({ nester: { op: "sequence", steps: [ROLL_HERO, { op: "draw", who: "self", amount: 2 }] } });
    const state = inParty(table(e), "p1", "hero_nester#0", "hero_bard#0");
    const outer = act(e, dice(state, 4, 3, 5, 5), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_nester#0" });
    const inner = passWindow(e, outer.state);
    // The bard is the only hero left to roll, so it is rolled with no Decision; its window is open.
    expect(inner.events.map((ev) => ev.type)).toEqual(["ROLL_RESOLVED", "DICE_ROLLED"]);
    expect(inner.events[1]).toMatchObject({ roll: "r2", hero: BARD });
    expect(e.getPlayerView(inner.state, "p1").responseWindow).toMatchObject({ kind: "modifier", rolls: [{ roll: "r2", total: 10 }] });
    expect(hand(inner.state, "p1")).toEqual([]);

    const done = passAll(e, inner.state);
    // The bard's draw, then the rest of the nester's effect.
    expect(done.events.map((ev) => ev.type)).toEqual(["ROLL_RESOLVED", "CARD_DRAWN", "CARD_DRAWN", "CARD_DRAWN"]);
    expect(done.state.players[0]!.party.every((h) => h.rolledThisTurn)).toBe(true);
  });

  it("in a beforeRoll passive closes its window before the outer roll's dice are rolled", () => {
    const passive = { hook: "beforeRoll", condition: { rollKind: "monsterAttack" }, effect: ROLL_HERO };
    const e = createRoomEngine(loadCardDefs(smallSet().map((d) => (d.type === "leader" ? { ...d, passive } : d))));
    const state = dice(inParty(table(e), "p1", "hero_bard#0"), 3, 3, 6, 6);
    const monster = state.activeMonsters[0]!;
    const r = act(e, state, { type: "ATTACK_MONSTER", player: "p1", monster });
    expect(r.events).toEqual([expect.objectContaining({ type: "DICE_ROLLED", roll: "r2", rollKind: "heroEffect", total: 6 })]);
    const outer = passWindow(e, r.state);
    expect(outer.events.map((ev) => ev.type)).toEqual(["ROLL_RESOLVED", "DICE_ROLLED"]);
    expect(outer.events[1]).toMatchObject({ roll: "r1", rollKind: "monsterAttack", total: 12 });
    const done = passAll(e, outer.state);
    expect(done.events.map((ev) => ev.type)).toEqual(["ROLL_RESOLVED", "MONSTER_SLAIN", "MONSTER_REVEALED"]);
  });

  it("asks which hero to roll when several haven't rolled, and does nothing when none is left", () => {
    const e = engineWith({ nester: ROLL_HERO });
    const state = inParty(table(e), "p1", "hero_nester#0", "hero_bard#0", "hero_fighter#0");
    const r = passAll(e, act(e, dice(state, 4, 3), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_nester#0" }).state);
    expect(r.state.pendingDecision).toMatchObject({ player: "p1", kind: "chooseHero", discard: false, options: [{ id: "hero_bard#0" }, { id: "hero_fighter#0" }] });

    const alone = inParty(table(e), "p1", "hero_nester#0");
    const none = passAll(e, act(e, dice(alone, 4, 3), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_nester#0" }).state);
    expect(none.events.map((ev) => ev.type)).toEqual(["ROLL_RESOLVED"]);
    expect(none.state.phase).toEqual({ kind: "action" });
  });
});
