import type { Effect, HeroFilter, PlayerRef } from "@here-to-slay/cards";
import { describe, expect, it } from "vitest";
import { answer, decision, engineWith, equip, hand, inParty, leader, party, rollHero, start } from "./scenario.js";

const steal = (target: Partial<HeroFilter> = {}, from: PlayerRef = { choose: "otherWithHeroes" }): Effect => ({
  op: "steal",
  from,
  target: { owner: "other", chosenBy: "self", ...target },
});

describe("steal", () => {
  it("the controller picks a player, then one of their heroes, which joins the controller's party", () => {
    const e = engineWith({ snatch: steal() });
    const state = inParty(inParty(start(e), "p2", "hero_bard#0", "hero_fighter#0"), "p3", "hero_ranger#0");
    let s = rollHero(e, state, "snatch").state;
    expect(decision(s)).toMatchObject({ player: "p1", kind: "choosePlayer" });
    expect(decision(s).options).toEqual([{ id: "p2" }, { id: "p3" }]);

    s = answer(e, s, "p2").state;
    const d = decision(s);
    expect(d).toMatchObject({ player: "p1", kind: "chooseHero", prompt: "Choose a hero to steal", discard: false });
    expect(d.options).toEqual([
      { id: "hero_bard#0", def: "hero_bard" },
      { id: "hero_fighter#0", def: "hero_fighter" },
    ]);

    const r = answer(e, s, "hero_fighter#0");
    expect(party(r.state, "p2").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
    expect(party(r.state, "p1").map((h) => h.instanceId)).toEqual(["hero_snatch#0", "hero_fighter#0"]);
    expect(r.events).toEqual([
      { type: "HERO_STOLEN", player: "p1", from: "p2", hero: { id: "hero_fighter#0", def: "hero_fighter" }, item: null },
    ]);
    expect(r.state.phase).toEqual({ kind: "action" });
  });

  it("the item moves with the stolen hero, and so does its roll flag", () => {
    const e = engineWith({ snatch: steal() });
    const state = equip(inParty(start(e), "p2", "hero_bard#0"), "hero_bard#0", "item_plain#0");
    party(state, "p2")[0]!.rolledThisTurn = true;
    const r = rollHero(e, state, "snatch");
    expect(r.events.at(-1)).toEqual({
      type: "HERO_STOLEN",
      player: "p1",
      from: "p2",
      hero: { id: "hero_bard#0", def: "hero_bard" },
      item: { id: "item_plain#0", def: "item_plain" },
    });
    expect(party(r.state, "p1")[1]).toEqual({ instanceId: "hero_bard#0", equippedItem: "item_plain#0", rolledThisTurn: true });
    expect(e.getLegalActions(r.state, "p1")).not.toContainEqual({ type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
  });

  it("with itemFollowsStolenHero off, the item goes to the discard pile instead", () => {
    const e = engineWith({ snatch: steal() });
    const state = equip(inParty(start(e, { itemFollowsStolenHero: false }), "p2", "hero_bard#0"), "hero_bard#0", "item_plain#0");
    const r = rollHero(e, state, "snatch");
    expect(r.events.slice(-2)).toEqual([
      { type: "HERO_STOLEN", player: "p1", from: "p2", hero: { id: "hero_bard#0", def: "hero_bard" }, item: null },
      { type: "ITEM_DISCARDED", player: "p2", item: { id: "item_plain#0", def: "item_plain" } },
    ]);
    expect(party(r.state, "p1")[1]!.equippedItem).toBeNull();
    expect(r.state.discardPile.at(-1)).toBe("item_plain#0");
  });

  it("with rollFlagFollowsHero off, the new owner may roll the stolen hero this turn", () => {
    const e = engineWith({ snatch: steal() });
    const state = inParty(start(e, { rollFlagFollowsHero: false }), "p2", "hero_bard#0");
    party(state, "p2")[0]!.rolledThisTurn = true;
    const r = rollHero(e, state, "snatch");
    expect(party(r.state, "p1")[1]!.rolledThisTurn).toBe(false);
    expect(e.getLegalActions(r.state, "p1")).toContainEqual({ type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
  });

  it("only offers heroes the filter allows, the Mask's class counting", () => {
    const e = engineWith({ snatch: steal({ class: "thief" }) });
    const state = equip(inParty(start(e), "p2", "hero_bard#0", "hero_fighter#0", "hero_thief#0"), "hero_bard#0", "item_mask_thief#0");
    const d = decision(rollHero(e, state, "snatch").state);
    expect(d.options.map((o) => o.id)).toEqual(["hero_bard#0", "hero_thief#0"]);

    const withItem = engineWith({ snatch: steal({ hasItem: true }) });
    const s2 = equip(inParty(start(withItem), "p2", "hero_bard#0", "hero_fighter#0"), "hero_fighter#0", "item_plain#0");
    const r = rollHero(withItem, s2, "snatch");
    // One hero fits, so it is taken without asking.
    expect(r.events.at(-1)).toMatchObject({ type: "HERO_STOLEN", hero: { id: "hero_fighter#0" } });
  });

  it("with chosenBy owner, the hero's owner picks which one they lose, as a discard Decision", () => {
    // Each other player steals from the active player, p1.
    const all = engineWith({ snatch: { op: "forEach", players: "other", effect: steal({ chosenBy: "owner" }, "activePlayer") } });
    const state = inParty(start(all), "p1", "hero_bard#0");
    let s = rollHero(all, state, "snatch").state;
    const d = decision(s);
    expect(d).toMatchObject({ player: "p1", kind: "chooseHero", discard: true });
    expect(d.options.map((o) => o.id)).toEqual(["hero_bard#0", "hero_snatch#0"]);
    s = answer(all, s, "hero_bard#0").state;
    // p3 takes the last one: one option, so p1 isn't asked.
    expect(party(s, "p2").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
    expect(party(s, "p3").map((h) => h.instanceId)).toEqual(["hero_snatch#0"]);
    expect(party(s, "p1")).toEqual([]);
    expect(s.pendingDecision).toBeNull();
  });

  it("only offers players who have a hero the filter allows", () => {
    const e = engineWith({ snatch: steal({ hasItem: true }) });
    const state = inParty(inParty(start(e, {}, 4), "p2", "hero_bard#0"), "p3", "hero_fighter#0", "hero_ranger#0");
    inParty(state, "p4", "hero_guardian#0");
    equip(equip(state, "hero_fighter#0", "item_plain#0"), "hero_guardian#0", "item_plain#1");
    const d = decision(rollHero(e, state, "snatch").state);
    expect(d).toMatchObject({ kind: "choosePlayer", options: [{ id: "p3" }, { id: "p4" }] });

    // With one such player, nobody is asked whom.
    party(state, "p4")[0]!.equippedItem = null;
    state.discardPile.push("item_plain#1");
    const r = rollHero(e, state, "snatch");
    expect(r.events.at(-1)).toMatchObject({ type: "HERO_STOLEN", from: "p3", hero: { id: "hero_fighter#0" } });
  });

  it("does nothing when there is no hero to steal", () => {
    const e = engineWith({ snatch: steal() });
    const r = rollHero(e, start(e), "snatch");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(r.state.pendingDecision).toBeNull();
    expect(r.state.phase).toEqual({ kind: "action" });

    // A chosen player whose heroes don't fit the filter is no target either.
    const picky = engineWith({ snatch: steal({ class: "ranger" }) });
    const s = rollHero(picky, inParty(start(picky), "p2", "hero_bard#0"), "snatch");
    expect(s.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(party(s.state, "p2")).toHaveLength(1);
  });

  it("never steals the stealer's own hero, or a Party Leader", () => {
    const e = engineWith({ snatch: steal({ owner: "any" }, "self") });
    const r = rollHero(e, start(e), "snatch");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(r.state.players.map((p) => p.leader)).toEqual(start(e).players.map((p) => p.leader));
  });
});


const destroy = (target: Partial<HeroFilter> = {}): Effect => ({ op: "destroy", target: { owner: "other", chosenBy: "self", ...target } });

describe("destroy", () => {
  it("the controller picks any other player's hero; it and its item go to the discard pile", () => {
    const e = engineWith({ smash: destroy() });
    const state = equip(inParty(inParty(start(e), "p2", "hero_bard#0"), "p3", "hero_fighter#0"), "hero_fighter#0", "item_plain#0");
    const s = rollHero(e, state, "smash").state;
    const d = decision(s);
    expect(d).toMatchObject({ player: "p1", kind: "chooseHero", prompt: "Choose a hero to destroy", discard: false });
    expect(d.options.map((o) => o.id)).toEqual(["hero_bard#0", "hero_fighter#0"]);

    const r = answer(e, s, "hero_fighter#0");
    expect(r.events).toEqual([
      { type: "HERO_DESTROYED", player: "p1", owner: "p3", hero: { id: "hero_fighter#0", def: "hero_fighter" }, item: { id: "item_plain#0", def: "item_plain" } },
    ]);
    expect(party(r.state, "p3")).toEqual([]);
    expect(r.state.discardPile.slice(-2)).toEqual(["hero_fighter#0", "item_plain#0"]);
    expect(e.getPlayerView(r.state, "p2").discardPile.slice(-2).map((c) => c.id)).toEqual(["hero_fighter#0", "item_plain#0"]);
  });

  it("does nothing when no hero fits; Party Leaders are never a target", () => {
    const e = engineWith({ smash: destroy({ owner: "any" }) });
    const before = start(e);
    // p1's only hero is the one rolling, and owner "any" includes it.
    const r = rollHero(e, before, "smash");
    expect(r.events.at(-1)).toMatchObject({ type: "HERO_DESTROYED", hero: { id: "hero_smash#0" } });
    expect(r.state.players.every((p) => p.leader !== null && !r.state.discardPile.includes(p.leader))).toBe(true);

    const others = engineWith({ smash: destroy() });
    const none = rollHero(others, start(others), "smash");
    expect(none.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(none.state.pendingDecision).toBeNull();
  });

  it("with chosenBy owner, the controller picks whose hero, then its owner picks which", () => {
    const e = engineWith({ smash: destroy({ chosenBy: "owner" }) });
    const state = inParty(inParty(start(e), "p2", "hero_bard#0", "hero_ranger#0"), "p3", "hero_fighter#0");
    let s = rollHero(e, state, "smash").state;
    expect(decision(s)).toMatchObject({ player: "p1", kind: "choosePlayer", prompt: "smash: choose whose hero", options: [{ id: "p2" }, { id: "p3" }] });
    s = answer(e, s, "p2").state;
    expect(decision(s)).toMatchObject({ player: "p2", kind: "chooseHero", discard: true });
    expect(decision(s).options.map((o) => o.id)).toEqual(["hero_bard#0", "hero_ranger#0"]);
    const r = answer(e, s, "hero_ranger#0");
    expect(r.events).toEqual([{ type: "HERO_DESTROYED", player: "p1", owner: "p2", hero: { id: "hero_ranger#0", def: "hero_ranger" }, item: null }]);
  });
});

describe("sacrifice", () => {
  const sacrifice = (amount: number): Effect => ({ op: "sacrifice", who: "self", amount });

  it("the player gives up their own heroes, one discard Decision each", () => {
    const e = engineWith({ offer: sacrifice(2) });
    const state = equip(inParty(start(e), "p1", "hero_bard#0", "hero_fighter#0"), "hero_bard#0", "item_plain#0");
    let s = rollHero(e, state, "offer").state;
    let d = decision(s);
    expect(d).toMatchObject({ player: "p1", kind: "chooseHero", prompt: "Choose a hero to sacrifice (1 of 2)", discard: true });
    expect(d.options.map((o) => o.id)).toEqual(["hero_bard#0", "hero_fighter#0", "hero_offer#0"]);
    expect(e.isDiscardDecision(s, "p1")).toBe(true);

    const first = answer(e, s, "hero_bard#0");
    expect(first.events).toEqual([
      { type: "HERO_SACRIFICED", player: "p1", hero: { id: "hero_bard#0", def: "hero_bard" }, item: { id: "item_plain#0", def: "item_plain" } },
    ]);
    s = first.state;
    d = decision(s);
    expect(d.prompt).toBe("Choose a hero to sacrifice (2 of 2)");
    expect(d.options.map((o) => o.id)).toEqual(["hero_fighter#0", "hero_offer#0"]);
    const r = answer(e, s, "hero_offer#0");
    expect(party(r.state, "p1").map((h) => h.instanceId)).toEqual(["hero_fighter#0"]);
    expect(r.state.discardPile.slice(-3)).toEqual(["hero_bard#0", "item_plain#0", "hero_offer#0"]);
    expect(r.state.phase).toEqual({ kind: "action" });
  });

  it("sacrifices the whole party when it is smaller than the amount, and does nothing with no heroes", () => {
    const e = engineWith({ offer: sacrifice(3) });
    const r = rollHero(e, start(e), "offer");
    // The rolling hero is the only one: one option, so it goes without asking.
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "HERO_SACRIFICED"]);
    expect(party(r.state, "p1")).toEqual([]);

    const each = engineWith({ offer: { op: "forEach", players: "other", effect: sacrifice(1) } });
    const none = rollHero(each, start(each), "offer");
    expect(none.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(none.state.pendingDecision).toBeNull();
  });
});

describe("pull", () => {
  const pull = (amount: number): Effect => ({ op: "pull", from: { choose: "otherWithCards" }, amount });

  it("takes random cards from the chosen player's hand with no Decision for which", () => {
    const e = engineWith({ grab: pull(2) });
    let s = rollHero(e, start(e), "grab").state;
    expect(decision(s)).toMatchObject({ player: "p1", kind: "choosePlayer", options: [{ id: "p2" }, { id: "p3" }] });
    const theirs = [...hand(s, "p3")];
    const mine = [...hand(s, "p1")];
    const r = answer(e, s, "p3");
    s = r.state;
    expect(s.pendingDecision).toBeNull();
    const pulled = r.events.map((ev) => (ev.type === "CARD_PULLED" ? ev.card!.id : ""));
    expect(r.events.map((ev) => ev.type)).toEqual(["CARD_PULLED", "CARD_PULLED"]);
    expect(r.events[0]).toMatchObject({ player: "p1", from: "p3" });
    expect(new Set(pulled).size).toBe(2);
    for (const card of pulled) expect(theirs).toContain(card);
    expect(hand(s, "p1")).toEqual([...mine, ...pulled]);
    expect(hand(s, "p3")).toEqual(theirs.filter((c) => !pulled.includes(c)));
  });

  it("is the same pull every time from the same seed", () => {
    const e = engineWith({ grab: pull(1) });
    const once = () => answer(e, rollHero(e, start(e), "grab").state, "p2").events;
    expect(once()).toEqual(once());
  });

  it("shows the pulled card only to the two players involved", () => {
    const e = engineWith({ grab: pull(1) });
    const r = answer(e, rollHero(e, start(e), "grab").state, "p2");
    const card = (r.events[0] as { card?: unknown }).card;
    expect(card).toBeDefined();
    expect(e.getPlayerEvents(r.events, "p1")).toEqual([{ type: "CARD_PULLED", player: "p1", from: "p2", card }]);
    expect(e.getPlayerEvents(r.events, "p2")).toEqual([{ type: "CARD_PULLED", player: "p1", from: "p2", card }]);
    expect(e.getPlayerEvents(r.events, "p3")).toEqual([{ type: "CARD_PULLED", player: "p1", from: "p2" }]);
    expect(e.getPlayerEvents(r.events, "spectator")).toEqual([{ type: "CARD_PULLED", player: "p1", from: "p2" }]);
    expect(JSON.stringify(e.getPlayerView(r.state, "p3"))).not.toContain((card as { id: string }).id);
  });

  it("takes the whole hand when it is smaller than the amount, and does nothing when nobody has cards", () => {
    const e = engineWith({ grab: pull(3) });
    const state = start(e, {}, 2);
    state.discardPile.push(...hand(state, "p2").slice(1));
    state.players[1]!.hand = hand(state, "p2").slice(0, 1);
    const r = rollHero(e, state, "grab");
    // Only p2 has cards to pull, so p1 isn't asked whom.
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "CARD_PULLED"]);
    expect(hand(r.state, "p2")).toEqual([]);

    const empty = start(e, {}, 2);
    empty.discardPile.push(...hand(empty, "p2"));
    empty.players[1]!.hand = [];
    const none = rollHero(e, empty, "grab");
    expect(none.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
    expect(none.state.pendingDecision).toBeNull();
  });

  it("never pulls from the puller's own hand", () => {
    const e = engineWith({ grab: { op: "pull", from: "self", amount: 1 } });
    const r = rollHero(e, start(e), "grab");
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED"]);
  });
});

describe("edge cases (TECHNICAL_DESIGN.md §7.6)", () => {
  it("an effect finishes when its hero is stolen partway through, and its controller stays the same", () => {
    // p1's hero: p2 steals one of p1's heroes, then "you" draw 1 and pull 1 from p2.
    const e = engineWith({
      bait: {
        op: "sequence",
        steps: [
          { op: "forEach", players: "other", effect: { op: "optional", chooser: "self", effect: steal({ owner: "any" }, "activePlayer") } },
          { op: "draw", who: "self", amount: 1 },
          { op: "pull", from: { choose: "otherWithHeroes" }, amount: 1 },
        ],
      },
    });
    const state = start(e);
    const top = state.mainDeck[0]!;
    let s = rollHero(e, state, "bait").state;
    expect(decision(s)).toMatchObject({ player: "p2", kind: "confirmOptional" });
    // p2 steals the hero whose effect this is: p1's only hero, so nobody is asked which.
    const stolen = answer(e, s, "accept");
    expect(stolen.events).toEqual([{ type: "HERO_STOLEN", player: "p2", from: "p1", hero: { id: "hero_bait#0", def: "hero_bait" }, item: null }]);
    s = stolen.state;
    expect(party(s, "p2").map((h) => h.instanceId)).toEqual(["hero_bait#0"]);
    expect(decision(s)).toMatchObject({ player: "p3", kind: "confirmOptional" });

    // p3 has nothing left to steal; the effect carries on for p1.
    const r = answer(e, s, "accept");
    expect(r.events.map((ev) => ev.type)).toEqual(["CARD_DRAWN", "CARD_PULLED"]);
    expect(r.events[0]).toMatchObject({ player: "p1", card: { id: top } });
    expect(r.events[1]).toMatchObject({ player: "p1", from: "p2" });
    expect(hand(r.state, "p1")).toContain(top);
    expect(r.state.stack).toEqual([]);
    expect(r.state.phase).toEqual({ kind: "action" });
    expect(e.getActivePlayer(r.state)).toBe("p1");
  });

  it("a steal that wins the game during another player's turn ends the game", () => {
    // p1's hero lets every other player steal from them; p2 is one class away.
    const e = engineWith({ gift: { op: "forEach", players: "other", effect: steal({}, "activePlayer") } });
    let state = inParty(start(e), "p2", "hero_fighter#0", "hero_guardian#0", "hero_ranger#0", "hero_thief#0");
    state = leader(inParty(state, "p1", "hero_bard#0"), "p2", "wizard");
    expect(e.getActivePlayer(state)).toBe("p1");
    let s = rollHero(e, state, "gift").state;
    expect(decision(s)).toMatchObject({ player: "p2", kind: "chooseHero" });
    const r = answer(e, s, "hero_bard#0");
    expect(r.events).toEqual([
      { type: "HERO_STOLEN", player: "p2", from: "p1", hero: { id: "hero_bard#0", def: "hero_bard" }, item: null },
      { type: "GAME_WON", player: "p2", reason: "classes" },
    ]);
    // p3's steal never happens.
    expect(r.state).toMatchObject({ winner: "p2", winReason: "classes", phase: { kind: "gameOver" }, stack: [], pendingDecision: null });
    s = r.state;
    expect(party(s, "p3")).toEqual([]);
  });
});
