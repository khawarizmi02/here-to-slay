import { loadCardDefs, type Effect, type PlayerRef } from "@here-to-slay/cards";
import type { Action, ConfigPatch } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { createRoomEngine, type GameState, type PendingDecision } from "../src/index.js";
import { players, smallSet } from "./cards.js";

/**
 * Hero cards with these effects, one copy each, added to the small set as
 * `hero_<name>`. Each is a wizard needing 7+.
 */
function engineWith(effects: Record<string, Effect> = {}, leaderBonus = 0) {
  const extra = Object.entries(effects).map(([name, effect]) => ({
    id: `hero_${name}`,
    type: "hero",
    name,
    text: `${name} text`,
    copies: 1,
    class: "wizard",
    rollRequirement: 7,
    effect,
  }));
  const base = smallSet().map((d) => (d.type === "leader" ? { ...d, passive: { hook: "modifyRollTotal" as const, value: leaderBonus } } : d));
  return createRoomEngine(loadCardDefs([...base, ...extra]));
}

type Engine = ReturnType<typeof createRoomEngine>;

function start(e: Engine, config: ConfigPatch = {}, count = 3): GameState {
  return e.createGame({ players: players(count), seed: "heroes", config: { firstPlayerMethod: "firstSeat", ...config } });
}

/** Moves `card` into `player`'s hand from wherever it is. */
function give(state: GameState, player: string, ...cards: string[]): GameState {
  for (const card of cards) {
    state.mainDeck = state.mainDeck.filter((c) => c !== card);
    state.discardPile = state.discardPile.filter((c) => c !== card);
    for (const p of state.players) {
      p.hand = p.hand.filter((c) => c !== card);
      p.party = p.party.filter((h) => h.instanceId !== card);
    }
    state.players.find((p) => p.id === player)!.hand.push(card);
  }
  return state;
}

/** Moves `card` into `player`'s party, unrolled this turn. */
function inParty(state: GameState, player: string, ...cards: string[]): GameState {
  for (const card of cards) {
    give(state, player, card);
    const p = state.players.find((q) => q.id === player)!;
    p.hand = p.hand.filter((c) => c !== card);
    p.party.push({ instanceId: card, equippedItem: null, rolledThisTurn: false });
  }
  return state;
}

/** Forces the next dice (TECHNICAL_DESIGN.md §13.2). */
function dice(state: GameState, ...values: number[]): GameState {
  state.rng.forcedDice = values;
  return state;
}

function act(e: Engine, state: GameState, action: Action) {
  const r = e.applyAction(state, action);
  expect(r.ok, r.error).toBe(true);
  return r;
}

function decision(state: GameState): PendingDecision {
  if (state.pendingDecision === null) throw new Error("No Decision is pending");
  return state.pendingDecision;
}

function answer(e: Engine, state: GameState, id: string) {
  const d = decision(state);
  return act(e, state, { type: "RESOLVE_DECISION", player: d.player, decisionId: d.id, answer: { selected: [id] } });
}

const hand = (state: GameState, player: string) => state.players.find((p) => p.id === player)!.hand;
const party = (state: GameState, player: string) => state.players.find((p) => p.id === player)!.party;

describe("playing a hero", () => {
  it("spends 1 AP and puts the hero straight into the party", () => {
    const e = engineWith();
    const before = give(start(e, { freeRollOnHeroPlay: false }), "p1", "hero_bard#0");
    expect(e.getLegalActions(before, "p1")).toContainEqual({ type: "PLAY_HERO", player: "p1", card: "hero_bard#0" });

    const r = act(e, before, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" });
    expect(r.state.actionPoints).toBe(2);
    expect(hand(r.state, "p1")).not.toContain("hero_bard#0");
    expect(party(r.state, "p1")).toEqual([{ instanceId: "hero_bard#0", equippedItem: null, rolledThisTurn: false }]);
    expect(r.state.phase).toEqual({ kind: "action" });
    expect(r.state.pendingDecision).toBeNull();
    expect(r.events).toEqual([{ type: "HERO_PLAYED", player: "p1", card: { id: "hero_bard#0", def: "hero_bard" } }]);
  });

  it("offers only heroes in the player's own hand", () => {
    const e = engineWith();
    const state = give(start(e), "p2", "hero_bard#0");
    expect(e.getLegalActions(state, "p1")).not.toContainEqual({ type: "PLAY_HERO", player: "p1", card: "hero_bard#0" });
    expect(e.applyAction(state, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).ok).toBe(false);
    const challenge = give(state, "p1", "challenge#0");
    expect(e.applyAction(challenge, { type: "PLAY_HERO", player: "p1", card: "challenge#0" }).ok).toBe(false);
  });
});

describe("the free roll after playing a hero", () => {
  it("asks a \"you may\" Decision with Decline first", () => {
    const e = engineWith();
    const r = act(e, give(start(e), "p1", "hero_bard#0"), { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" });
    expect(r.state.phase).toEqual({ kind: "resolving" });
    const d = decision(r.state);
    expect(d).toMatchObject({ player: "p1", kind: "confirmOptional", prompt: "Roll for bard hero's effect?", discard: false });
    expect(d.options.map((o) => o.id)).toEqual(["decline", "accept"]);
    expect(d.options[0]!.label).toBe("Decline");
    expect(e.getLegalActions(r.state, "p1").map((a) => a.type)).toEqual(["RESOLVE_DECISION", "RESOLVE_DECISION"]);
    // The turn can't end, or anything else be done, until it is answered.
    expect(e.applyAction(r.state, { type: "END_TURN", player: "p1" }).ok).toBe(false);
  });

  it("declining leaves the hero's roll for later in the turn", () => {
    const e = engineWith();
    const played = act(e, give(start(e), "p1", "hero_bard#0"), { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).state;
    const r = answer(e, played, "decline");
    expect(r.state.phase).toEqual({ kind: "action" });
    expect(r.state.actionPoints).toBe(2);
    expect(party(r.state, "p1")[0]!.rolledThisTurn).toBe(false);
    expect(e.getLegalActions(r.state, "p1")).toContainEqual({ type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
  });

  it("taking it rolls for free and uses up the hero's roll for the turn", () => {
    const e = engineWith();
    const played = act(e, give(start(e), "p1", "hero_bard#0"), { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).state;
    const before = hand(played, "p1").length;
    const r = answer(e, dice(played, 4, 3), "accept");
    expect(r.events[0]).toEqual({
      type: "DICE_ROLLED",
      roll: "r1",
      player: "p1",
      rollKind: "heroEffect",
      hero: { id: "hero_bard#0", def: "hero_bard" },
      dice: [4, 3],
      bonus: 0,
      total: 7,
      succeeded: true,
    });
    // hero_bard draws 1 on a 7+.
    expect(hand(r.state, "p1")).toHaveLength(before + 1);
    expect(r.state.actionPoints).toBe(2);
    expect(party(r.state, "p1")[0]!.rolledThisTurn).toBe(true);
    expect(e.getLegalActions(r.state, "p1")).not.toContainEqual({ type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(e.applyAction(r.state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" }).ok).toBe(false);
  });

  it("isn't offered with freeRollOnHeroPlay off", () => {
    const e = engineWith();
    const r = act(e, give(start(e, { freeRollOnHeroPlay: false }), "p1", "hero_bard#0"), { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" });
    expect(r.state.pendingDecision).toBeNull();
  });

  it("holds the turn open when the hero used the last AP, until the offer is answered", () => {
    const e = engineWith();
    const state = give(start(e), "p1", "hero_bard#0");
    state.actionPoints = 1;
    const played = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).state;
    expect(played.actionPoints).toBe(0);
    expect(e.getActivePlayer(played)).toBe("p1");
    const r = answer(e, played, "decline");
    expect(e.getActivePlayer(r.state)).toBe("p2");
  });
});

describe("rolling for a hero's effect", () => {
  it("spends 1 AP, and runs the effect on a total at or over the requirement", () => {
    const e = engineWith();
    const state = dice(inParty(start(e), "p1", "hero_bard#0"), 5, 2);
    const before = hand(state, "p1").length;
    const r = act(e, state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(r.state.actionPoints).toBe(2);
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "CARD_DRAWN"]);
    expect(hand(r.state, "p1")).toHaveLength(before + 1);
    expect(r.state.phase).toEqual({ kind: "action" });
  });

  it("does nothing more on a total under the requirement, and the roll is still used", () => {
    const e = engineWith();
    const r = act(e, dice(inParty(start(e), "p1", "hero_bard#0"), 3, 3), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(r.events).toEqual([expect.objectContaining({ type: "DICE_ROLLED", total: 6, succeeded: false })]);
    expect(party(r.state, "p1")[0]!.rolledThisTurn).toBe(true);
  });

  it("allows each hero one roll per turn, and a fresh one next turn", () => {
    const e = engineWith();
    let state = dice(inParty(start(e), "p1", "hero_bard#0", "hero_fighter#0"), 1, 1, 1, 1);
    state = act(e, state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" }).state;
    expect(e.getLegalActions(state, "p1").filter((a) => a.type === "ROLL_HERO_EFFECT")).toEqual([
      { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_fighter#0" },
    ]);
    expect(e.applyAction(state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" }).ok).toBe(false);
    state = act(e, state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_fighter#0" }).state;
    expect(e.getLegalActions(state, "p1").filter((a) => a.type === "ROLL_HERO_EFFECT")).toEqual([]);

    for (const p of ["p1", "p2", "p3"]) state = act(e, state, { type: "END_TURN", player: p }).state;
    expect(e.getLegalActions(state, "p1").filter((a) => a.type === "ROLL_HERO_EFFECT")).toHaveLength(2);
  });

  it("can't roll another player's hero", () => {
    const e = engineWith();
    const state = inParty(start(e), "p2", "hero_bard#0");
    expect(e.applyAction(state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" }).ok).toBe(false);
  });

  it("adds passive roll bonuses whose condition matches", () => {
    // Every leader gives +1 to rolls here, so a 3+3 makes 7.
    const e = engineWith({}, 1);
    const r = act(e, dice(inParty(start(e), "p1", "hero_bard#0"), 3, 3), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(r.events[0]).toMatchObject({ type: "DICE_ROLLED", dice: [3, 3], bonus: 1, total: 7, succeeded: true });

    const wizardsOnly = createRoomEngine(
      loadCardDefs(
        smallSet().map((d) =>
          d.type === "leader" ? { ...d, passive: { hook: "modifyRollTotal" as const, condition: { rollKind: "heroEffect" as const, heroClass: "wizard" as const }, value: 2 } } : d,
        ),
      ),
    );
    let state = dice(inParty(start(wizardsOnly), "p1", "hero_bard#0", "hero_wizard#0"), 3, 3, 3, 3);
    let roll = act(wizardsOnly, state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(roll.events[0]).toMatchObject({ bonus: 0, total: 6 });
    state = roll.state;
    roll = act(wizardsOnly, state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_wizard#0" });
    expect(roll.events[0]).toMatchObject({ bonus: 2, total: 8 });
  });
});

/** Rolls `name`'s hero for p1 with a 7, so its effect runs. */
function rollHero(e: Engine, state: GameState, name: string) {
  return act(e, dice(inParty(state, "p1", `hero_${name}#0`), 4, 3), { type: "ROLL_HERO_EFFECT", player: "p1", hero: `hero_${name}#0` });
}

const draw = (amount: number, who: PlayerRef = "self"): Effect => ({ op: "draw", who, amount });
const discardOwn = (amount: number): Effect => ({ op: "discard", who: "self", amount, chosenBy: "self" });

describe("effect ops", () => {
  it("draw: the player draws, reshuffling the discard pile if the deck runs out partway", () => {
    const e = engineWith({ draw3: draw(3) });
    const state = start(e);
    state.discardPile = state.mainDeck.slice(1);
    state.mainDeck = state.mainDeck.slice(0, 1);
    const before = hand(state, "p1").length;
    const r = rollHero(e, state, "draw3");
    expect(hand(r.state, "p1")).toHaveLength(before + 3);
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "CARD_DRAWN", "DECK_RESHUFFLED", "CARD_DRAWN", "CARD_DRAWN"]);
  });

  it("draw with a chosen player: the controller picks among the players the filter allows", () => {
    const e = engineWith({ gift: draw(2, { choose: "other" }) });
    const r = rollHero(e, start(e), "gift");
    const d = decision(r.state);
    expect(d).toMatchObject({ player: "p1", kind: "choosePlayer", discard: false });
    expect(d.options).toEqual([{ id: "p2" }, { id: "p3" }]);
    const after = answer(e, r.state, "p3");
    expect(after.state.players.map((p) => p.hand.length)).toEqual([hand(r.state, "p1").length, 5, 7]);
  });

  it("discard: one Decision per card, from the player's own hand, each a discard Decision", () => {
    const e = engineWith({ purge: discardOwn(2) });
    let state = rollHero(e, start(e), "purge").state;
    const own = [...hand(state, "p1")];
    let d = decision(state);
    expect(d).toMatchObject({ player: "p1", kind: "chooseCardFromHand", prompt: "Choose a card to discard (1 of 2)", discard: true });
    expect(d.options.map((o) => o.id)).toEqual([...own].sort());
    expect(e.isDiscardDecision(state, "p1")).toBe(true);

    state = answer(e, state, own[0]!).state;
    d = decision(state);
    expect(d.prompt).toBe("Choose a card to discard (2 of 2)");
    expect(d.options.map((o) => o.id)).not.toContain(own[0]);
    const r = answer(e, state, own[1]!);
    expect(r.events).toEqual([{ type: "CARD_DISCARDED", player: "p1", card: { id: own[1], def: state.cards[own[1]!] } }]);
    expect(r.state.discardPile.slice(-2)).toEqual([own[0], own[1]]);
    expect(r.state.pendingDecision).toBeNull();
    expect(r.state.phase).toEqual({ kind: "action" });
  });

  it("discard: a hand smaller than the amount is discarded whole, the last card on its own", () => {
    const e = engineWith({ purge: discardOwn(3) });
    const state = start(e);
    const p1 = state.players[0]!;
    state.discardPile.push(...p1.hand.slice(2));
    p1.hand = p1.hand.slice(0, 2);
    let s = rollHero(e, state, "purge").state;
    expect(decision(s).prompt).toBe("Choose a card to discard (1 of 2)");
    s = answer(e, s, hand(s, "p1")[0]!).state;
    // One card left is one option, so it goes without asking.
    expect(hand(s, "p1")).toEqual([]);
    expect(s.pendingDecision).toBeNull();
  });

  it("sequence: runs each step in order, pausing on a Decision and resuming after the answer", () => {
    const e = engineWith({ cycle: { op: "sequence", steps: [draw(1), discardOwn(1), draw(2)] } });
    const before = start(e);
    const top = before.mainDeck[0]!;
    const paused = rollHero(e, before, "cycle");
    expect(paused.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "CARD_DRAWN"]);
    expect(hand(paused.state, "p1")).toContain(top);
    expect(decision(paused.state).kind).toBe("chooseCardFromHand");

    const r = answer(e, paused.state, top);
    expect(r.events.map((ev) => ev.type)).toEqual(["CARD_DISCARDED", "CARD_DRAWN", "CARD_DRAWN"]);
    expect(hand(r.state, "p1")).toHaveLength(hand(paused.state, "p1").length + 1);
    expect(r.state.phase).toEqual({ kind: "action" });
  });

  it("choice: the chooser picks one option by its label, and only that effect runs", () => {
    const e = engineWith({ pick: { op: "choice", chooser: "self", options: [{ label: "Draw 1", effect: draw(1) }, { label: "Draw 3", effect: draw(3) }] } });
    const s = rollHero(e, start(e), "pick").state;
    const d = decision(s);
    expect(d).toMatchObject({ player: "p1", kind: "chooseOption", prompt: "pick: choose one", discard: false });
    expect(d.options).toEqual([{ id: "0", label: "Draw 1" }, { id: "1", label: "Draw 3" }]);
    const r = answer(e, s, "1");
    expect(hand(r.state, "p1")).toHaveLength(hand(s, "p1").length + 3);
  });

  it("optional: a \"you may\" Decision with Decline first; Decline does nothing, Accept runs the effect", () => {
    const e = engineWith({ maybe: { op: "optional", chooser: "self", effect: draw(2) } });
    const s = rollHero(e, start(e), "maybe").state;
    const d = decision(s);
    expect(d).toMatchObject({ player: "p1", kind: "confirmOptional", discard: false });
    expect(d.options).toEqual([{ id: "decline", label: "Decline" }, { id: "accept", label: "Accept" }]);

    const declined = answer(e, s, "decline");
    expect(declined.events).toEqual([]);
    expect(hand(declined.state, "p1")).toEqual(hand(s, "p1"));
    const accepted = answer(e, s, "accept");
    expect(hand(accepted.state, "p1")).toHaveLength(hand(s, "p1").length + 2);
  });

  it("forEach: each matching player in turn order after the controller, with self bound to each", () => {
    const e = engineWith({ all: { op: "forEach", players: "any", effect: draw(1) } });
    const state = dice(inParty(start(e, {}, 4), "p3", "hero_all#0"), 4, 3);
    // It is p3's turn, in turn order p3, p4, p1, p2, so the controller p3 comes last.
    state.turnOrder = ["p3", "p4", "p1", "p2"];
    state.activePlayer = "p3";
    const r = act(e, state, { type: "ROLL_HERO_EFFECT", player: "p3", hero: "hero_all#0" });
    expect(r.events.filter((ev) => ev.type === "CARD_DRAWN").map((ev) => ev.player)).toEqual(["p4", "p1", "p2", "p3"]);
  });

  it("forEach: each other player discards from their own hand, one player's chain after another", () => {
    const e = engineWith({ tax: { op: "forEach", players: "other", effect: discardOwn(1) } });
    let s = rollHero(e, start(e), "tax").state;
    expect(s.phase).toEqual({ kind: "resolving" });
    let d = decision(s);
    expect(d).toMatchObject({ player: "p2", kind: "chooseCardFromHand", discard: true });
    expect(d.options.map((o) => o.id)).toEqual([...hand(s, "p2")].sort());
    // Only p2 may act now, and only to answer.
    expect(e.getLegalActions(s, "p1")).toEqual([]);
    expect(e.getPlayerView(s, "p1").pendingDecision).toEqual({ player: "p2" });

    s = answer(e, s, hand(s, "p2")[0]!).state;
    d = decision(s);
    expect(d.player).toBe("p3");
    s = answer(e, s, hand(s, "p3")[0]!).state;
    expect(s.players.map((p) => p.hand.length)).toEqual([hand(s, "p1").length, 4, 4]);
    expect(s.phase).toEqual({ kind: "action" });
    expect(e.getActivePlayer(s)).toBe("p1");
  });

  it("forEach with nobody matching does nothing", () => {
    const e = engineWith({ none: { op: "forEach", players: "otherWithHeroes", effect: draw(1) } });
    const r = rollHero(e, start(e), "none");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
  });

  it("a chosen player with nobody to choose skips the op", () => {
    const e = engineWith({ none: draw(1, { choose: "otherWithHeroes" }) });
    const r = rollHero(e, start(e), "none");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(r.state.pendingDecision).toBeNull();
  });

  it("nests: an optional inside a choice inside a sequence resumes at each level", () => {
    const e = engineWith({
      deep: {
        op: "sequence",
        steps: [
          { op: "choice", chooser: "self", options: [{ label: "Maybe draw", effect: { op: "optional", chooser: "self", effect: draw(2) } }, { label: "Nothing", effect: draw(1, { choose: "otherWithHeroes" }) }] },
          draw(1),
        ],
      },
    });
    let s = rollHero(e, start(e), "deep").state;
    const before = hand(s, "p1").length;
    s = answer(e, s, "0").state;
    expect(decision(s).kind).toBe("confirmOptional");
    const r = answer(e, s, "accept");
    expect(hand(r.state, "p1")).toHaveLength(before + 3);
    expect(r.state.stack).toEqual([]);
  });
});

/** Gives `player` the Party Leader of `cls`, swapping leaders with whoever had it. */
function leader(state: GameState, player: string, cls: string): GameState {
  const card = `leader_${cls}#0`;
  const me = state.players.find((p) => p.id === player)!;
  const holder = state.players.find((p) => p.leader === card);
  if (holder) holder.leader = me.leader;
  else state.leaderPool = [...state.leaderPool.filter((c) => c !== card), me.leader!].sort();
  me.leader = card;
  return state;
}

describe("the class win", () => {
  /** p1 leads the bards, with a fighter, guardian, ranger and thief in their party and a wizard in hand. */
  function oneAway(e: Engine, config: ConfigPatch = {}): GameState {
    const state = inParty(start(e, config), "p1", "hero_fighter#0", "hero_guardian#0", "hero_ranger#0", "hero_thief#0");
    return give(leader(state, "p1", "bard"), "p1", "hero_wizard#0");
  }

  it("wins the moment the party, Party Leader included, has 6 distinct classes", () => {
    const e = engineWith();
    const r = act(e, oneAway(e), { type: "PLAY_HERO", player: "p1", card: "hero_wizard#0" });
    expect(r.events.map((ev) => ev.type)).toEqual(["HERO_PLAYED", "GAME_WON"]);
    expect(r.events[1]).toEqual({ type: "GAME_WON", player: "p1", reason: "classes" });
    expect(r.state).toMatchObject({ winner: "p1", winReason: "classes", phase: { kind: "gameOver" }, pendingDecision: null, stack: [] });
    for (const p of ["p1", "p2", "p3"]) expect(e.getLegalActions(r.state, p)).toEqual([]);
    expect(e.getPlayerView(r.state, "p2")).toMatchObject({ winner: "p1", winReason: "classes" });
    expect(e.applyAction(r.state, { type: "END_TURN", player: "p1" }).ok).toBe(false);
  });

  it("doesn't count a class twice, or the leader's class again", () => {
    const e = engineWith();
    const state = oneAway(e);
    give(state, "p1", "hero_bard#0", "hero_fighter#1");
    let s = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).state;
    s = answer(e, s, "decline").state;
    s = act(e, s, { type: "PLAY_HERO", player: "p1", card: "hero_fighter#1" }).state;
    s = answer(e, s, "decline").state;
    expect(s.winner).toBeNull();
    expect(party(s, "p1")).toHaveLength(6);
  });

  it("follows classesToWin", () => {
    const e = engineWith();
    const state = leader(give(start(e, { classesToWin: 2 }), "p1", "hero_wizard#0"), "p1", "bard");
    const r = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_wizard#0" });
    expect(r.state.winner).toBe("p1");
  });

  it("with winCheckTiming endOfAction, waits for the action to finish resolving", () => {
    const e = engineWith();
    const played = act(e, oneAway(e, { winCheckTiming: "endOfAction" }), { type: "PLAY_HERO", player: "p1", card: "hero_wizard#0" });
    expect(played.state.winner).toBeNull();
    expect(decision(played.state).kind).toBe("confirmOptional");
    const r = answer(e, dice(played.state, 4, 3), "accept");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "CARD_DRAWN", "GAME_WON"]);
    expect(r.state.phase).toEqual({ kind: "gameOver" });
  });
});

describe("a scenario to a class win", () => {
  it("plays heroes over two turns until the party has every class", () => {
    const e = engineWith();
    let state = leader(start(e), "p1", "wizard");
    state.players[0]!.hand = [];
    give(state, "p1", "hero_bard#0", "hero_fighter#0", "hero_guardian#0", "hero_ranger#0", "hero_thief#0");
    // Free rolls: take the first and miss it; decline the rest.
    state.rng.forcedDice = [1, 1];

    const run = (actions: ((s: GameState) => Action)[]) => {
      for (const next of actions) state = act(e, state, next(state)).state;
    };
    const play = (card: string) => () => ({ type: "PLAY_HERO", player: "p1", card }) as Action;
    const reply = (id: string) => (s: GameState) => ({ type: "RESOLVE_DECISION", player: "p1", decisionId: decision(s).id, answer: { selected: [id] } }) as Action;
    const end = (player: string) => () => ({ type: "END_TURN", player }) as Action;

    run([play("hero_bard#0"), reply("accept"), play("hero_fighter#0"), reply("decline")]);
    expect(party(state, "p1").map((h) => h.rolledThisTurn)).toEqual([true, false]);
    run([play("hero_guardian#0"), reply("decline")]);
    // Three AP spent: the turn has passed, and p1's heroes have their rolls back for next time.
    expect(e.getActivePlayer(state)).toBe("p2");
    expect(party(state, "p1").map((h) => h.rolledThisTurn)).toEqual([false, false, false]);
    run([end("p2"), end("p3")]);
    run([play("hero_ranger#0"), reply("decline")]);
    expect(state.winner).toBeNull();
    const last = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_thief#0" });
    expect(last.state).toMatchObject({ winner: "p1", winReason: "classes", phase: { kind: "gameOver" } });
    expect(last.events.at(-1)).toEqual({ type: "GAME_WON", player: "p1", reason: "classes" });
  });
});
