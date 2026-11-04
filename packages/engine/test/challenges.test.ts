import { describe, expect, it } from "vitest";
import type { ConfigPatch } from "@here-to-slay/protocol";
import { loadCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameState } from "../src/index.js";
import { smallSet } from "./cards.js";
import { act, awaiting, decision, dice, engineWith, give, hand, inParty, leader, party, passAll, start, type Engine } from "./scenario.js";

/*
 * Challenge Windows and Challenge duels (TECHNICAL_DESIGN.md §3.7, §7.1,
 * §7.2, §7.4). No Modifier Windows yet: a roll's total is final at once.
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

describe("a Challenge Window", () => {
  it("opens when a Hero is played: the hero waits in limbo and every other player is offered PASS", () => {
    const e = engineWith();
    const state = give(table(e), "p1", "hero_bard#0");
    const r = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" });

    expect(r.state.actionPoints).toBe(2);
    expect(hand(r.state, "p1")).not.toContain("hero_bard#0");
    expect(party(r.state, "p1")).toEqual([]);
    expect(r.state.phase).toEqual({ kind: "resolving" });
    expect(r.events).toEqual([{ type: "CHALLENGE_WINDOW_OPENED", player: "p1", card: { id: "hero_bard#0", def: "hero_bard" } }]);
    // Turn order after the player who played it; nobody here holds a Challenge.
    expect(awaiting(e, r.state)).toEqual(["p2", "p3"]);
    expect(e.getPlayerView(r.state, "p2").responseWindow).toEqual({ kind: "challenge", awaiting: ["p2", "p3"], card: { id: "hero_bard#0", def: "hero_bard" } });
    expect(e.getLegalActions(r.state, "p1")).toEqual([]);
    expect(e.getLegalActions(r.state, "p2")).toEqual([{ type: "PASS", player: "p2" }]);
    expect(e.getLegalActions(r.state, "p3")).toEqual([{ type: "PASS", player: "p3" }]);
    expect(e.applyAction(r.state, { type: "PASS", player: "p1" }).ok).toBe(false);
    expect(e.applyAction(r.state, { type: "END_TURN", player: "p1" }).ok).toBe(false);
  });
});

const LURE = {
  id: "magic_lure",
  type: "magic",
  name: "Lure",
  text: "STEAL a hero.",
  copies: 1,
  effect: { op: "steal", from: { choose: "otherWithHeroes" }, target: { owner: "other", chosenBy: "self" } },
};
const INSIGHT = { id: "magic_draw", type: "magic", name: "Insight", text: "DRAW 2 cards.", copies: 1, effect: { op: "draw", who: "self", amount: 2 } };
const engine = (leaderBonus = 0, extra: unknown[] = []) => engineWith({}, leaderBonus, [LURE, INSIGHT, ...extra]);

const HERO = { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" } as const;
const BARD = { id: "hero_bard#0", def: "hero_bard" };

describe("a Challenge Window", () => {
  it("closes once everyone in it has passed, and the hero enters the party", () => {
    const e = engine();
    const played = act(e, give(table(e), "p1", "hero_bard#0"), HERO).state;
    const p2 = act(e, played, { type: "PASS", player: "p2" });
    expect(p2.events).toEqual([]);
    expect(awaiting(e, p2.state)).toEqual(["p3"]);
    expect(e.getLegalActions(p2.state, "p2")).toEqual([]);
    expect(e.applyAction(p2.state, { type: "PASS", player: "p2" }).ok).toBe(false);

    const p3 = act(e, p2.state, { type: "PASS", player: "p3" });
    expect(p3.events).toEqual([{ type: "HERO_PLAYED", player: "p1", card: BARD }]);
    expect(party(p3.state, "p1").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
    expect(p3.state.phase).toEqual({ kind: "action" });
    expect(e.getPlayerView(p3.state, "p1").responseWindow).toBeNull();
    expect(p3.state.actionPoints).toBe(2);
  });

  it("offers PASS whatever a player holds, and PLAY_CHALLENGE for each Challenge in hand; never to the player who played the card", () => {
    const e = engine();
    const state = give(give(table(e), "p1", "hero_bard#0", "challenge#1"), "p3", "challenge#0");
    const played = act(e, state, HERO).state;
    expect(e.getLegalActions(played, "p1")).toEqual([]);
    expect(e.getLegalActions(played, "p2")).toEqual([{ type: "PASS", player: "p2" }]);
    expect(e.getLegalActions(played, "p3")).toEqual([
      { type: "PASS", player: "p3" },
      { type: "PLAY_CHALLENGE", player: "p3", card: "challenge#0" },
    ]);
    expect(e.applyAction(played, { type: "PLAY_CHALLENGE", player: "p1", card: "challenge#1" }).ok).toBe(false);
    expect(e.applyAction(played, { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" }).ok).toBe(false);
  });

  it("is never offered outside a window", () => {
    const e = engine();
    const state = give(table(e), "p2", "challenge#0");
    expect(e.getLegalActions(state, "p2")).toEqual([]);
    expect(e.applyAction(state, { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" }).ok).toBe(false);
    expect(e.applyAction(state, { type: "PASS", player: "p2" }).ok).toBe(false);
  });

  it("opens on an Item, which goes on its hero only once the window closes", () => {
    const e = engine();
    const state = give(inParty(table(e), "p1", "hero_bard#0"), "p1", "item_plain#0");
    const played = act(e, state, { type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_bard#0" });
    expect(played.events.map((ev) => ev.type)).toEqual(["CHALLENGE_WINDOW_OPENED"]);
    expect(party(played.state, "p1")[0]!.equippedItem).toBeNull();
    const r = passAll(e, played.state);
    expect(r.events.map((ev) => ev.type)).toEqual(["ITEM_PLAYED"]);
    expect(party(r.state, "p1")[0]!.equippedItem).toBe("item_plain#0");
  });

  it("opens on a Magic card, whose effect resolves only once the window closes", () => {
    const e = engine();
    const played = act(e, give(table(e), "p1", "magic_draw#0"), { type: "PLAY_MAGIC", player: "p1", card: "magic_draw#0" });
    expect(played.events.map((ev) => ev.type)).toEqual(["CHALLENGE_WINDOW_OPENED"]);
    expect(hand(played.state, "p1")).toEqual([]);
    const r = passAll(e, played.state);
    expect(r.events.map((ev) => ev.type)).toEqual(["MAGIC_PLAYED", "CARD_DRAWN", "CARD_DRAWN", "MAGIC_DISCARDED"]);
    expect(hand(r.state, "p1")).toHaveLength(2);
  });

  it("holds the turn open when the card used the last AP, until the window closes", () => {
    const e = engine();
    const state = give(table(e), "p1", "hero_bard#0");
    state.actionPoints = 1;
    const played = act(e, state, HERO).state;
    expect(played.actionPoints).toBe(0);
    expect(e.getActivePlayer(played)).toBe("p1");
    expect(e.getActivePlayer(passAll(e, played).state)).toBe("p2");
  });

  it("doesn't open with maxChallengesPerPlay 0: the card resolves at once", () => {
    const e = engine();
    const r = act(e, give(give(table(e, { maxChallengesPerPlay: 0 }), "p1", "hero_bard#0"), "p2", "challenge#0"), HERO);
    expect(r.events).toEqual([{ type: "HERO_PLAYED", player: "p1", card: BARD }]);
    expect(e.getPlayerView(r.state, "p2").responseWindow).toBeNull();
  });
});

describe("a Challenge", () => {
  /** p1 plays the bard; p3 holds a Challenge. */
  function challengeable(e: Engine, config: ConfigPatch = {}) {
    const state = give(give(table(e, config), "p1", "hero_bard#0"), "p3", "challenge#0");
    return act(e, state, HERO).state;
  }
  const CHALLENGE = { type: "PLAY_CHALLENGE", player: "p3", card: "challenge#0" } as const;

  it("costs no AP, discards the Challenge, and both players roll: a higher challenger sends the card to the discard pile with no effect", () => {
    const e = engine();
    const played = challengeable(e, { freeRollOnHeroPlay: true });
    const r = act(e, dice(played, 5, 4, 2, 3), CHALLENGE);

    expect(r.events).toEqual([
      { type: "CHALLENGE_PLAYED", player: "p3", card: { id: "challenge#0", def: "challenge" }, defender: "p1", target: BARD },
      { type: "DICE_ROLLED", roll: "r1", player: "p3", rollKind: "challenge", side: "challenger", target: BARD, dice: [5, 4], bonus: 0, total: 9 },
      { type: "DICE_ROLLED", roll: "r2", player: "p1", rollKind: "challenge", side: "defender", target: BARD, dice: [2, 3], bonus: 0, total: 5 },
      { type: "CHALLENGE_RESOLVED", challenger: "p3", defender: "p1", target: BARD, challengerTotal: 9, defenderTotal: 5, succeeded: true },
    ]);
    expect(hand(r.state, "p3")).toEqual([]);
    expect(r.state.discardPile.slice(-2)).toEqual(["challenge#0", "hero_bard#0"]);
    expect(party(r.state, "p1")).toEqual([]);
    // No free roll for a hero that never entered the party, and the AP stays spent.
    expect(r.state.pendingDecision).toBeNull();
    expect(r.state.actionPoints).toBe(2);
    expect(r.state.phase).toEqual({ kind: "action" });
    expect(e.getPlayerView(r.state, "p2").responseWindow).toBeNull();
  });

  it("that fails lets the card resolve normally", () => {
    const e = engine();
    const r = act(e, dice(challengeable(e, { freeRollOnHeroPlay: true }), 1, 2, 6, 6), CHALLENGE);
    expect(r.events.map((ev) => ev.type)).toEqual(["CHALLENGE_PLAYED", "DICE_ROLLED", "DICE_ROLLED", "CHALLENGE_RESOLVED", "HERO_PLAYED"]);
    expect(r.events[3]).toMatchObject({ challengerTotal: 3, defenderTotal: 12, succeeded: false });
    expect(party(r.state, "p1").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
    expect(decision(r.state)).toMatchObject({ player: "p1", kind: "confirmOptional" });
  });

  it("ties go to the challenger by default", () => {
    const e = engine();
    const r = act(e, dice(challengeable(e), 3, 4, 5, 2), CHALLENGE);
    expect(r.events.at(-1)).toMatchObject({ type: "CHALLENGE_RESOLVED", challengerTotal: 7, defenderTotal: 7, succeeded: true });
    expect(party(r.state, "p1")).toEqual([]);
  });

  it("ties go to the player Challenged with challengeTieWinner \"challenged\"", () => {
    const e = engine();
    const r = act(e, dice(challengeable(e, { challengeTieWinner: "challenged" }), 3, 4, 5, 2), CHALLENGE);
    expect(r.events.find((ev) => ev.type === "CHALLENGE_RESOLVED")).toMatchObject({ challengerTotal: 7, defenderTotal: 7, succeeded: false });
    expect(party(r.state, "p1").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
  });

  it("adds each roller's passive bonuses to their roll", () => {
    const e = engine(1);
    const r = act(e, dice(challengeable(e), 3, 3, 3, 3), CHALLENGE);
    expect(r.events.filter((ev) => ev.type === "DICE_ROLLED").map((ev) => ev.type === "DICE_ROLLED" && [ev.bonus, ev.total])).toEqual([
      [1, 7],
      [1, 7],
    ]);
  });

  it("is only one per card play by default: a failed Challenge closes the window for good", () => {
    const e = engine();
    const played = give(challengeable(e), "p2", "challenge#1");
    const r = act(e, dice(played, 1, 1, 6, 6), CHALLENGE);
    expect(r.events.some((ev) => ev.type === "CHALLENGE_WINDOW_OPENED")).toBe(false);
    expect(party(r.state, "p1").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
    expect(e.getLegalActions(r.state, "p2")).toEqual([]);
  });

  it("can follow a failed one with maxChallengesPerPlay 2, in a fresh window open to everyone", () => {
    const e = engine();
    const played = give(challengeable(e, { maxChallengesPerPlay: 2 }), "p2", "challenge#1");
    const first = act(e, dice(act(e, played, { type: "PASS", player: "p2" }).state, 1, 1, 6, 6), CHALLENGE);
    expect(first.events.at(-1)).toEqual({ type: "CHALLENGE_WINDOW_OPENED", player: "p1", card: BARD });
    // p2 passed in the first window, and is asked again in the second.
    expect(awaiting(e, first.state)).toEqual(["p2", "p3"]);
    const second = act(e, dice(first.state, 6, 6, 1, 1), { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#1" });
    expect(second.events.at(-1)).toMatchObject({ type: "CHALLENGE_RESOLVED", challenger: "p2", succeeded: true });
    expect(second.state.discardPile.at(-1)).toBe("hero_bard#0");
    expect(party(second.state, "p1")).toEqual([]);
  });

  it("against an Item sends it to the discard pile, and its hero keeps no item", () => {
    const e = engine();
    const state = give(give(inParty(table(e), "p1", "hero_bard#0"), "p1", "item_plain#0"), "p2", "challenge#0");
    const played = act(e, state, { type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_bard#0" }).state;
    const r = act(e, dice(played, 6, 6, 1, 1), { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
    expect(r.events.map((ev) => ev.type)).not.toContain("ITEM_PLAYED");
    expect(party(r.state, "p1")[0]!.equippedItem).toBeNull();
    expect(r.state.discardPile.at(-1)).toBe("item_plain#0");
  });

  it("against a Magic card that would have won the game stops the win", () => {
    const e = engine();
    const state = leader(table(e), "p1", "bard");
    inParty(state, "p1", "hero_fighter#0", "hero_guardian#0", "hero_ranger#0", "hero_wizard#0");
    inParty(state, "p2", "hero_thief#0");
    give(give(state, "p1", "magic_lure#0"), "p2", "challenge#0");
    const played = act(e, state, { type: "PLAY_MAGIC", player: "p1", card: "magic_lure#0" }).state;

    const r = act(e, dice(played, 6, 6, 1, 1), { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
    expect(r.state.winner).toBeNull();
    expect(r.events.map((ev) => ev.type)).toEqual(["CHALLENGE_PLAYED", "DICE_ROLLED", "DICE_ROLLED", "CHALLENGE_RESOLVED"]);
    expect(party(r.state, "p2").map((h) => h.instanceId)).toEqual(["hero_thief#0"]);
    expect(r.state.discardPile.at(-1)).toBe("magic_lure#0");

    // Unchallenged, the same card wins.
    const won = passAll(e, played);
    expect(won.state).toMatchObject({ winner: "p1", winReason: "classes" });
  });

  it("runs the defender's onChallenged passives before the duel", () => {
    const e = createEngineWithLeaders({ hook: "onChallenged", effect: { op: "draw", who: "self", amount: 1 } });
    const r = act(e, dice(challengeable(e), 6, 6, 1, 1), CHALLENGE);
    expect(r.events.map((ev) => ev.type)).toEqual(["CHALLENGE_PLAYED", "CARD_DRAWN", "DICE_ROLLED", "DICE_ROLLED", "CHALLENGE_RESOLVED"]);
    expect(r.events[1]).toMatchObject({ player: "p1" });
  });
});

describe("a Challenge roll and passives", () => {
  it("counts no item's roll bonus, since no hero is rolling", () => {
    const charm = { id: "item_charm", type: "item", name: "Charm", text: "+3 to this hero's rolls.", copies: 1, passive: { hook: "modifyRollTotal", value: 3 } };
    const e = engine(0, [charm]);
    const state = give(give(inParty(table(e), "p1", "hero_fighter#0"), "p1", "hero_bard#0"), "p3", "challenge#0");
    state.players[0]!.party[0]!.equippedItem = "item_charm#0";
    const played = act(e, state, HERO).state;
    const r = act(e, dice(played, 3, 3, 3, 3), { type: "PLAY_CHALLENGE", player: "p3", card: "challenge#0" });
    expect(r.events.find((ev) => ev.type === "DICE_ROLLED" && ev.rollKind === "challenge" && ev.side === "defender")).toMatchObject({ bonus: 0, total: 6 });
  });

  it("onChallenged passives see which card play was Challenged", () => {
    const e = createEngineWithLeaders({ hook: "onChallenged", condition: { action: "PLAY_MAGIC" }, effect: { op: "draw", who: "self", amount: 1 } });
    const hero = act(e, give(give(table(e), "p1", "hero_bard#0"), "p3", "challenge#0"), HERO).state;
    const onHero = act(e, dice(hero, 1, 1, 6, 6), { type: "PLAY_CHALLENGE", player: "p3", card: "challenge#0" });
    expect(onHero.events.some((ev) => ev.type === "CARD_DRAWN")).toBe(false);
  });

  it("a win during the duel sends the card still in limbo to the discard pile", () => {
    // p1 is one class short; being Challenged steals p2's thief and wins at once.
    const e = createEngineWithLeaders({
      hook: "onChallenged",
      effect: { op: "steal", from: { choose: "otherWithHeroes" }, target: { owner: "other", chosenBy: "self" } },
    });
    const state = leader(table(e), "p1", "bard");
    inParty(state, "p1", "hero_fighter#0", "hero_guardian#0", "hero_ranger#0", "hero_wizard#0");
    inParty(state, "p2", "hero_thief#0");
    give(give(state, "p1", "hero_fighter#1"), "p3", "challenge#0");
    const played = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_fighter#1" }).state;
    const r = act(e, played, { type: "PLAY_CHALLENGE", player: "p3", card: "challenge#0" });
    expect(r.state).toMatchObject({ winner: "p1", winReason: "classes", stack: [] });
    expect(r.state.discardPile.slice(-2)).toEqual(["challenge#0", "hero_fighter#1"]);
    expect(r.events.map((ev) => ev.type)).toEqual(["CHALLENGE_PLAYED", "HERO_STOLEN", "CARD_DISCARDED", "GAME_WON"]);
  });
});

/** The scenario engine, with every Party Leader's passive replaced by `passive`. */
function createEngineWithLeaders(passive: unknown): Engine {
  return createRoomEngine(loadCardDefs(smallSet().map((d) => (d.type === "leader" ? { ...d, passive } : d))));
}
