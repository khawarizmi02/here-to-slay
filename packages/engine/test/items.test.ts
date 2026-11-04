import { describe, expect, it } from "vitest";
import { act, decision, dice, engineWith, equip, give, hand, inParty, leader, party, start } from "./scenario.js";

/** Extra items for these tests: a +2 charm, a -2 curse and a plain curse. */
const ITEMS = [
  {
    id: "item_charm",
    type: "item",
    name: "Charm",
    text: "+2 to this hero's rolls.",
    copies: 1,
    passive: { hook: "modifyRollTotal", condition: { rollKind: "heroEffect" }, value: 2 },
  },
  {
    id: "cursed_minus",
    type: "cursedItem",
    name: "Curse",
    text: "-2 to this hero's rolls.",
    copies: 1,
    passive: { hook: "modifyRollTotal", condition: { rollKind: "heroEffect" }, value: -2 },
  },
  {
    id: "item_coin",
    type: "item",
    name: "Coin",
    text: "After you roll for this hero, DRAW a card.",
    copies: 1,
    passive: { hook: "afterRoll", condition: { rollKind: "heroEffect" }, effect: { op: "draw", who: "self", amount: 1 } },
  },
  {
    id: "item_scroll",
    type: "item",
    name: "Scroll",
    text: "Each time you play a Magic card, DRAW a card.",
    copies: 1,
    passive: { hook: "onCardPlayed", condition: { action: "PLAY_MAGIC" }, effect: { op: "draw", who: "self", amount: 1 } },
  },
  {
    id: "item_banner",
    type: "item",
    name: "Banner",
    text: "Each time a hero enters your party, DRAW a card.",
    copies: 1,
    passive: { hook: "onHeroEnterParty", effect: { op: "draw", who: "self", amount: 1 } },
  },
  { id: "magic_draw", type: "magic", name: "Insight", text: "DRAW 2 cards.", copies: 1, effect: { op: "draw", who: "self", amount: 2 } },
];

const engine = () => engineWith({}, 0, ITEMS);

describe("playing an item", () => {
  it("lists exactly the player's own heroes with no item as targets", () => {
    const e = engine();
    const state = inParty(inParty(start(e, { freeRollOnHeroPlay: false }), "p1", "hero_bard#0", "hero_fighter#0", "hero_ranger#0"), "p2", "hero_thief#0");
    equip(state, "hero_fighter#0", "item_plain#1");
    give(state, "p1", "item_plain#0");
    const plays = e.getLegalActions(state, "p1").filter((a) => a.type === "PLAY_ITEM" && a.card === "item_plain#0");
    expect(plays).toEqual([
      { type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_bard#0" },
      { type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_ranger#0" },
    ]);
    expect(e.applyAction(state, { type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_fighter#0" }).ok).toBe(false);
    expect(e.applyAction(state, { type: "PLAY_ITEM", player: "p1", card: "item_plain#0", targetHero: "hero_thief#0" }).ok).toBe(false);
  });

  it("lists every player's heroes with no item as targets for a Cursed item", () => {
    const e = engine();
    const state = inParty(inParty(inParty(start(e), "p1", "hero_bard#0"), "p2", "hero_thief#0", "hero_wizard#0"), "p3", "hero_ranger#0");
    equip(state, "hero_wizard#0", "item_plain#0");
    give(state, "p1", "cursed_minus#0");
    const targets = e
      .getLegalActions(state, "p1")
      .flatMap((a) => (a.type === "PLAY_ITEM" && a.card === "cursed_minus#0" ? [a.targetHero] : []));
    expect(targets).toEqual(["hero_bard#0", "hero_thief#0", "hero_ranger#0"]);
  });

  it("offers no item play with no hero to put it on", () => {
    const e = engine();
    const state = give(start(e), "p1", "item_plain#0");
    expect(e.getLegalActions(state, "p1").some((a) => a.type === "PLAY_ITEM")).toBe(false);
  });

  it("spends 1 AP and equips the item to the hero", () => {
    const e = engine();
    const state = give(inParty(start(e), "p2", "hero_thief#0"), "p1", "cursed_minus#0");
    const r = act(e, state, { type: "PLAY_ITEM", player: "p1", card: "cursed_minus#0", targetHero: "hero_thief#0" });
    expect(r.state.actionPoints).toBe(2);
    expect(hand(r.state, "p1")).not.toContain("cursed_minus#0");
    expect(party(r.state, "p2")).toEqual([{ instanceId: "hero_thief#0", equippedItem: "cursed_minus#0", rolledThisTurn: false }]);
    expect(r.events).toEqual([
      { type: "ITEM_PLAYED", player: "p1", card: { id: "cursed_minus#0", def: "cursed_minus" }, owner: "p2", hero: { id: "hero_thief#0", def: "hero_thief" } },
    ]);
    expect(e.getPlayerView(r.state, "p3").players[1]!.party[0]!.item).toEqual({ id: "cursed_minus#0", def: "cursed_minus" });
  });
});

describe("Mask items", () => {
  it("can complete a class win", () => {
    const e = engine();
    const state = leader(start(e), "p1", "bard");
    inParty(state, "p1", "hero_fighter#0", "hero_guardian#0", "hero_ranger#0", "hero_wizard#0", "hero_fighter#1");
    give(state, "p1", "item_mask_thief#0");
    expect(state.winner).toBeNull();
    const r = act(e, state, { type: "PLAY_ITEM", player: "p1", card: "item_mask_thief#0", targetHero: "hero_fighter#1" });
    expect(r.state.winner).toBe("p1");
    expect(r.state.winReason).toBe("classes");
    expect(r.events.at(-1)).toEqual({ type: "GAME_WON", player: "p1", reason: "classes" });
  });
});

describe("item passives", () => {
  it("add to the rolls of the hero wearing the item", () => {
    const e = engine();
    const state = inParty(start(e), "p1", "hero_bard#0");
    give(state, "p1", "item_charm#0");
    const equipped = act(e, state, { type: "PLAY_ITEM", player: "p1", card: "item_charm#0", targetHero: "hero_bard#0" }).state;
    const r = act(e, dice(equipped, 3, 2), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(r.events[0]).toMatchObject({ type: "DICE_ROLLED", dice: [3, 2], bonus: 2, total: 7, succeeded: true });
  });

  it("leave the rolls of the owner's other heroes alone", () => {
    const e = engine();
    const state = equip(inParty(start(e), "p1", "hero_bard#0", "hero_fighter#0"), "hero_bard#0", "item_charm#0");
    const r = act(e, dice(state, 3, 2), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_fighter#0" });
    expect(r.events[0]).toMatchObject({ type: "DICE_ROLLED", bonus: 0, total: 5, succeeded: false });
  });

  it("from a Cursed item take away from the hero's owner's roll", () => {
    const e = engine();
    const state = equip(inParty(start(e), "p1", "hero_bard#0"), "hero_bard#0", "cursed_minus#0");
    const r = act(e, dice(state, 4, 4), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(r.events[0]).toMatchObject({ type: "DICE_ROLLED", bonus: -2, total: 6, succeeded: false });
  });

  it("run at a trigger hook: an afterRoll draw", () => {
    const e = engine();
    const state = equip(inParty(start(e), "p1", "hero_bard#0"), "hero_bard#0", "item_coin#0");
    const before = hand(state, "p1").length;
    // A failed roll: only the Coin draws.
    const r = act(e, dice(state, 1, 1), { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    expect(r.events.map((ev) => ev.type)).toEqual(["DICE_ROLLED", "CARD_DRAWN"]);
    expect(hand(r.state, "p1")).toHaveLength(before + 1);
  });

  it("run at a trigger hook: onCardPlayed, after the Magic card resolves", () => {
    const e = engine();
    const state = give(equip(inParty(start(e), "p1", "hero_bard#0"), "hero_bard#0", "item_scroll#0"), "p1", "magic_draw#0");
    const r = act(e, state, { type: "PLAY_MAGIC", player: "p1", card: "magic_draw#0" });
    expect(r.events.map((ev) => ev.type)).toEqual(["MAGIC_PLAYED", "CARD_DRAWN", "CARD_DRAWN", "MAGIC_DISCARDED", "CARD_DRAWN"]);
  });

  it("run at a trigger hook: onHeroEnterParty", () => {
    const e = engine();
    const state = give(equip(inParty(start(e, { freeRollOnHeroPlay: false }), "p1", "hero_bard#0"), "hero_bard#0", "item_banner#0"), "p1", "hero_fighter#0");
    const r = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_fighter#0" });
    expect(r.events.map((ev) => ev.type)).toEqual(["HERO_PLAYED", "CARD_DRAWN"]);
  });
});

describe("playing a Magic card", () => {
  const MAGIC = [
    { id: "magic_draw", type: "magic", name: "Insight", text: "DRAW 2 cards.", copies: 1, effect: { op: "draw", who: "self", amount: 2 } },
    {
      id: "magic_bolt",
      type: "magic",
      name: "Bolt",
      text: "DESTROY a hero.",
      copies: 1,
      effect: { op: "destroy", target: { owner: "other", chosenBy: "self" } },
    },
  ];
  const magicEngine = () => engineWith({}, 0, MAGIC);

  it("that wins the game mid-effect still ends up in the discard pile", () => {
    const lure = {
      id: "magic_lure",
      type: "magic",
      name: "Lure",
      text: "STEAL a hero, then DRAW a card.",
      copies: 1,
      effect: {
        op: "sequence",
        steps: [
          { op: "steal", from: { choose: "otherWithHeroes" }, target: { owner: "other", chosenBy: "self" } },
          { op: "draw", who: "self", amount: 1 },
        ],
      },
    };
    const e = engineWith({}, 0, [lure]);
    const state = leader(start(e), "p1", "bard");
    inParty(state, "p1", "hero_fighter#0", "hero_guardian#0", "hero_ranger#0", "hero_wizard#0");
    inParty(state, "p2", "hero_thief#0");
    give(state, "p1", "magic_lure#0");
    const r = act(e, state, { type: "PLAY_MAGIC", player: "p1", card: "magic_lure#0" });
    expect(r.state.winner).toBe("p1");
    expect(r.state.stack).toEqual([]);
    expect(r.state.discardPile.at(-1)).toBe("magic_lure#0");
    expect(r.events.map((ev) => ev.type)).toEqual(["MAGIC_PLAYED", "HERO_STOLEN", "MAGIC_DISCARDED", "GAME_WON"]);
  });

  it("is legal for every Magic card in hand", () => {
    const e = magicEngine();
    const state = give(start(e), "p1", "magic_draw#0");
    expect(e.getLegalActions(state, "p1")).toContainEqual({ type: "PLAY_MAGIC", player: "p1", card: "magic_draw#0" });
    expect(e.applyAction(give(state, "p2", "magic_bolt#0"), { type: "PLAY_MAGIC", player: "p1", card: "magic_bolt#0" }).ok).toBe(false);
  });

  it("spends 1 AP, resolves the effect, then discards the card", () => {
    const e = magicEngine();
    const state = give(start(e), "p1", "magic_draw#0");
    const before = hand(state, "p1").length;
    const r = act(e, state, { type: "PLAY_MAGIC", player: "p1", card: "magic_draw#0" });
    expect(r.state.actionPoints).toBe(2);
    expect(hand(r.state, "p1")).toHaveLength(before - 1 + 2);
    expect(r.state.discardPile.at(-1)).toBe("magic_draw#0");
    expect(r.events.map((ev) => ev.type)).toEqual(["MAGIC_PLAYED", "CARD_DRAWN", "CARD_DRAWN", "MAGIC_DISCARDED"]);
    expect(r.events[0]).toEqual({ type: "MAGIC_PLAYED", player: "p1", card: { id: "magic_draw#0", def: "magic_draw" } });
    expect(r.state.phase).toEqual({ kind: "action" });
  });

  it("stays out of the discard pile until its Decisions are answered", () => {
    const e = magicEngine();
    const state = give(inParty(start(e), "p2", "hero_bard#0", "hero_fighter#0"), "p1", "magic_bolt#0");
    const played = act(e, state, { type: "PLAY_MAGIC", player: "p1", card: "magic_bolt#0" }).state;
    expect(decision(played)).toMatchObject({ player: "p1", kind: "chooseHero" });
    expect(played.discardPile).not.toContain("magic_bolt#0");
    expect(hand(played, "p1")).not.toContain("magic_bolt#0");
    const d = decision(played);
    const r = act(e, played, { type: "RESOLVE_DECISION", player: "p1", decisionId: d.id, answer: { selected: ["hero_fighter#0"] } });
    expect(r.state.discardPile.slice(-2)).toEqual(["hero_fighter#0", "magic_bolt#0"]);
    expect(party(r.state, "p2").map((h) => h.instanceId)).toEqual(["hero_bard#0"]);
  });
});
