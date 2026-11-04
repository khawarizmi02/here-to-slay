import { loadCardDefs } from "@here-to-slay/cards";
import type { Action, ConfigPatch } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { createRoomEngine, type GameState } from "../src/index.js";
import { players, smallSet } from "./cards.js";

const engine = createRoomEngine(smallSet());

function start(config: ConfigPatch = {}, count = 3): GameState {
  return engine.createGame({ players: players(count), seed: "turns", config: { firstPlayerMethod: "firstSeat", ...config } });
}

function act(state: GameState, action: Action): GameState {
  const r = engine.applyAction(state, action);
  expect(r.ok, r.error).toBe(true);
  return r.state;
}

describe("action points", () => {
  it("starts the first turn with every action point", () => {
    const state = start();
    expect(engine.getActivePlayer(state)).toBe("p1");
    expect(state.phase).toEqual({ kind: "action" });
    expect(engine.getPlayerView(state, "p1").actionPoints).toBe(3);
  });

  it("spends 1 AP to draw the top card of the main deck", () => {
    const before = start();
    const top = before.mainDeck[0]!;
    const r = engine.applyAction(before, { type: "DRAW_CARD", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    expect(r.state.actionPoints).toBe(2);
    expect(r.state.players[0]!.hand).toEqual([...before.players[0]!.hand, top]);
    expect(r.state.mainDeck).toEqual(before.mainDeck.slice(1));
    expect(r.events).toContainEqual({ type: "CARD_DRAWN", player: "p1", card: { id: top, def: before.cards[top] } });
  });

  it("offers turn actions only to the active player", () => {
    const state = start();
    expect(engine.getLegalActions(state, "p1")).toEqual([
      { type: "DRAW_CARD", player: "p1" },
      { type: "DISCARD_AND_REDRAW", player: "p1" },
      { type: "END_TURN", player: "p1" },
    ]);
    expect(engine.getLegalActions(state, "p2")).toEqual([]);
    expect(engine.applyAction(state, { type: "DRAW_CARD", player: "p2" }).ok).toBe(false);
  });
});

describe("passing the turn", () => {
  it("ends the turn on END_TURN, and passes clockwise with fresh AP", () => {
    let state = act(start(), { type: "DRAW_CARD", player: "p1" });
    const r = engine.applyAction(state, { type: "END_TURN", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    state = r.state;
    expect(engine.getActivePlayer(state)).toBe("p2");
    expect(state.actionPoints).toBe(3);
    expect(state.turnNumber).toBe(2);
    expect(state.phase).toEqual({ kind: "action" });
    expect(r.events).toEqual([
      { type: "TURN_ENDED", player: "p1" },
      { type: "TURN_STARTED", player: "p2", turnNumber: 2 },
    ]);
  });

  it("follows turn order from the first player, wrapping around", () => {
    let state = start({ firstPlayerMethod: "random" }, 4);
    const seen = [engine.getActivePlayer(state)];
    for (let i = 0; i < 4; i++) {
      state = act(state, { type: "END_TURN", player: engine.getActivePlayer(state) });
      seen.push(engine.getActivePlayer(state));
    }
    expect(seen).toEqual([...state.turnOrder, state.turnOrder[0]]);
  });

  it("ends the turn once the last AP is spent, and not before", () => {
    let state = start({ handLimit: 10 });
    state = act(state, { type: "DRAW_CARD", player: "p1" });
    state = act(state, { type: "DRAW_CARD", player: "p1" });
    expect(engine.getActivePlayer(state)).toBe("p1");
    expect(state.actionPoints).toBe(1);
    const r = engine.applyAction(state, { type: "DRAW_CARD", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    expect(engine.getActivePlayer(r.state)).toBe("p2");
    expect(r.state.actionPoints).toBe(3);
    expect(r.events.map((e) => e.type)).toEqual(["CARD_DRAWN", "TURN_ENDED", "TURN_STARTED"]);
  });

  it("offers only actions the player can still pay for", () => {
    const state = act(start(), { type: "DRAW_CARD", player: "p1" });
    expect(engine.getLegalActions(state, "p1").map((a) => a.type)).toEqual(["DRAW_CARD", "END_TURN"]);
    expect(engine.applyAction(state, { type: "DISCARD_AND_REDRAW", player: "p1" }).ok).toBe(false);
  });

  it("gives every hero a fresh roll at the start of a turn", () => {
    const state = start();
    const hero = state.players[1]!.hand.find((c) => c.startsWith("hero_"))!;
    state.players[1]!.hand = state.players[1]!.hand.filter((c) => c !== hero);
    state.players[1]!.party.push({ instanceId: hero, equippedItem: null, rolledThisTurn: true });
    const next = act(state, { type: "END_TURN", player: "p1" });
    expect(next.players[1]!.party[0]!.rolledThisTurn).toBe(false);
  });
});

describe("the hand limit", () => {
  /** p1 draws 3 with a hand limit of 6, so ends their turn holding 8. */
  function overLimit(): GameState {
    let state = start({ handLimit: 6 });
    for (let i = 0; i < 3; i++) state = act(state, { type: "DRAW_CARD", player: "p1" });
    return state;
  }

  function discard(state: GameState, card: string): ReturnType<typeof engine.applyAction> {
    const decision = state.pendingDecision!;
    return engine.applyAction(state, { type: "RESOLVE_DECISION", player: "p1", decisionId: decision.id, answer: { selected: [card] } });
  }

  it("holds the turn at its end while the player discards down to the limit, one pick at a time", () => {
    let state = overLimit();
    expect(engine.getActivePlayer(state)).toBe("p1");
    expect(state.phase).toMatchObject({ kind: "turnEnd" });
    const hand = state.players[0]!.hand;
    expect(hand).toHaveLength(8);

    const first = engine.getPlayerView(state, "p1").pendingDecision;
    if (!first || !("options" in first)) throw new Error("p1 was not asked to discard");
    expect(first).toMatchObject({ player: "p1", kind: "chooseCardFromHand", discard: true, prompt: "Discard down to your hand limit of 6 (1 of 2)" });
    expect(first.options.map((o) => o.id)).toEqual([...hand].sort());
    expect(engine.isDiscardDecision(state, "p1")).toBe(true);
    expect(engine.getLegalActions(state, "p1")).toHaveLength(8);
    expect(engine.getLegalActions(state, "p1").every((a) => a.type === "RESOLVE_DECISION")).toBe(true);
    expect(engine.getLegalActions(state, "p2")).toEqual([]);
    expect(engine.getPlayerView(state, "p2").pendingDecision).toEqual({ player: "p1" });

    const r = discard(state, hand[0]!);
    expect(r.ok, r.error).toBe(true);
    expect(r.events).toEqual([{ type: "CARD_DISCARDED", player: "p1", card: { id: hand[0], def: state.cards[hand[0]!] } }]);
    state = r.state;
    expect(state.discardPile).toEqual([hand[0]]);
    expect(state.pendingDecision).toMatchObject({ prompt: "Discard down to your hand limit of 6 (2 of 2)" });
    expect(state.pendingDecision!.options.map((o) => o.id)).not.toContain(hand[0]);
    expect(engine.isDiscardDecision(state, "p1")).toBe(true);

    const last = discard(state, hand[1]!);
    expect(last.ok, last.error).toBe(true);
    state = last.state;
    expect(state.players[0]!.hand).toEqual(hand.slice(2));
    expect(state.discardPile).toEqual([hand[0], hand[1]]);
    expect(engine.getActivePlayer(state)).toBe("p2");
    expect(state.phase).toEqual({ kind: "action" });
    expect(engine.isDiscardDecision(state, "p1")).toBe(false);
    expect(last.events.map((e) => e.type)).toEqual(["CARD_DISCARDED", "TURN_ENDED", "TURN_STARTED"]);
  });

  it("applies on END_TURN too", () => {
    let state = start({ handLimit: 5 });
    state = act(state, { type: "DRAW_CARD", player: "p1" });
    state = act(state, { type: "END_TURN", player: "p1" });
    expect(state.phase).toMatchObject({ kind: "turnEnd" });
    expect(engine.isDiscardDecision(state, "p1")).toBe(true);
    expect(engine.applyAction(state, { type: "END_TURN", player: "p1" }).ok).toBe(false);
  });

  it("asks nothing of a player at or under the limit", () => {
    const state = act(start({ handLimit: 5 }), { type: "END_TURN", player: "p1" });
    expect(engine.getActivePlayer(state)).toBe("p2");
    expect(state.pendingDecision).toBeNull();
  });

  it("goes up or down with modifyHandLimit passives", () => {
    const set = smallSet().map((d) => (d.type === "leader" ? { ...d, passive: { hook: "modifyHandLimit" as const, value: 2 } } : d));
    const bigHands = createRoomEngine(set);
    let state = bigHands.createGame({ players: players(2), seed: "turns", config: { firstPlayerMethod: "firstSeat", handLimit: 5 } });
    for (let i = 0; i < 3; i++) state = bigHands.applyAction(state, { type: "DRAW_CARD", player: "p1" }).state;
    // 8 cards against a limit of 7.
    expect(state.pendingDecision).toMatchObject({ prompt: "Discard down to your hand limit of 7 (1 of 1)" });
  });
});

/** `state` with only its top `n` main-deck cards left in the deck; the rest are moved to the discard pile. */
function thinDeck(state: GameState, n: number): GameState {
  return { ...state, mainDeck: state.mainDeck.slice(0, n), discardPile: [...state.discardPile, ...state.mainDeck.slice(n)] };
}

/** Every main-deck card in the game: decks, discard pile and hands. */
function mainDeckCards(state: GameState): string[] {
  return [...state.mainDeck, ...state.discardPile, ...state.players.flatMap((p) => p.hand)].sort();
}

describe("discard and redraw", () => {
  it("spends 3 AP to discard the whole hand face up and draw 5", () => {
    const before = start();
    const hand = before.players[0]!.hand;
    const r = engine.applyAction(before, { type: "DISCARD_AND_REDRAW", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    expect(r.state.players[0]!.hand).toEqual(before.mainDeck.slice(0, 5));
    expect(r.state.discardPile).toEqual(hand);
    expect(r.events.filter((e) => e.type === "CARD_DISCARDED").map((e) => e.type === "CARD_DISCARDED" && e.card.id)).toEqual(hand);
    expect(r.events.filter((e) => e.type === "CARD_DRAWN")).toHaveLength(5);
    // That was all 3 AP, so the turn has passed.
    expect(engine.getActivePlayer(r.state)).toBe("p2");
  });
});

describe("reshuffling the discard pile", () => {
  it("reshuffles the discard pile into the main deck when a draw finds the deck empty", () => {
    const before = thinDeck(start(), 0);
    expect(engine.getLegalActions(before, "p1").map((a) => a.type)).toContain("DRAW_CARD");
    const r = engine.applyAction(before, { type: "DRAW_CARD", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    expect(r.state.discardPile).toEqual([]);
    expect(r.state.mainDeck).toHaveLength(before.discardPile.length - 1);
    expect(r.state.players[0]!.hand).toHaveLength(6);
    expect(mainDeckCards(r.state)).toEqual(mainDeckCards(before));
    expect(r.events.map((e) => e.type)).toEqual(["DECK_RESHUFFLED", "CARD_DRAWN"]);
    expect(r.events[0]).toEqual({ type: "DECK_RESHUFFLED", cards: before.discardPile.length });
  });

  it("reshuffles in the middle of a draw and finishes it", () => {
    // Two cards left: the redraw takes them, reshuffles the hand it just discarded, and draws 3 more.
    const before = thinDeck(start(), 2);
    const left = before.mainDeck;
    const r = engine.applyAction(before, { type: "DISCARD_AND_REDRAW", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    const hand = r.state.players[0]!.hand;
    expect(hand).toHaveLength(5);
    expect(hand.slice(0, 2)).toEqual(left);
    expect(r.events.map((e) => e.type)).toEqual([
      ...Array<string>(5).fill("CARD_DISCARDED"),
      "CARD_DRAWN",
      "CARD_DRAWN",
      "DECK_RESHUFFLED",
      "CARD_DRAWN",
      "CARD_DRAWN",
      "CARD_DRAWN",
      "TURN_ENDED",
      "TURN_STARTED",
    ]);
    expect(mainDeckCards(r.state)).toEqual(mainDeckCards(before));
  });

  it("shuffles with the seeded RNG, so the same game reshuffles the same way", () => {
    const before = thinDeck(start(), 0);
    const a = engine.applyAction(before, { type: "DRAW_CARD", player: "p1" }).state;
    const b = engine.applyAction(before, { type: "DRAW_CARD", player: "p1" }).state;
    expect(a).toEqual(b);
    expect([...a.players[0]!.hand.slice(5), ...a.mainDeck]).not.toEqual(before.discardPile);
  });

  it("stops a draw short when there is nothing left to draw", () => {
    const before = thinDeck(start({ reshuffleDiscardWhenDeckEmpty: false }), 2);
    const r = engine.applyAction(before, { type: "DISCARD_AND_REDRAW", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    expect(r.state.players[0]!.hand).toEqual(before.mainDeck);
    expect(r.state.mainDeck).toEqual([]);
    expect(r.events.map((e) => e.type)).not.toContain("DECK_RESHUFFLED");
  });

  it("offers no DRAW_CARD when there is nothing to draw", () => {
    expect(engine.getLegalActions(thinDeck(start({ reshuffleDiscardWhenDeckEmpty: false }), 0), "p1").map((a) => a.type)).toEqual([
      "DISCARD_AND_REDRAW",
      "END_TURN",
    ]);
    const empty = { ...thinDeck(start(), 0), discardPile: [] };
    expect(engine.getLegalActions(empty, "p1").map((a) => a.type)).toEqual(["DISCARD_AND_REDRAW", "END_TURN"]);
  });
});

describe("start-of-turn and end-of-turn hooks", () => {
  /** An engine whose every Party Leader has `passive`. */
  function leadersWith(passive: object) {
    return createRoomEngine(loadCardDefs(smallSet().map((d) => (d.type === "leader" ? { ...d, passive } : d))));
  }

  function begin(e: ReturnType<typeof createRoomEngine>, config: ConfigPatch = {}): GameState {
    return e.createGame({ players: players(2), seed: "turns", config: { firstPlayerMethod: "firstSeat", ...config } });
  }

  it("runs a start-of-turn passive for the player whose turn starts", () => {
    const e = leadersWith({ hook: "onTurnStart", effect: { op: "draw", who: "self", amount: 2 } });
    const state = begin(e);
    // p1's first turn started at setup.
    expect(state.players[0]!.hand).toHaveLength(7);
    const r = e.applyAction(state, { type: "END_TURN", player: "p1" });
    expect(r.state.players.map((p) => p.hand.length)).toEqual([7, 7]);
    expect(r.events.map((e) => e.type)).toEqual(["TURN_ENDED", "TURN_STARTED", "CARD_DRAWN", "CARD_DRAWN"]);
    expect(r.state.actionPoints).toBe(3);
  });

  it("reshuffles in the middle of a start-of-turn draw-2 and finishes it", () => {
    const e = leadersWith({ hook: "onTurnStart", effect: { op: "draw", who: "self", amount: 2 } });
    const state = thinDeck(begin(e), 1);
    const r = e.applyAction(state, { type: "END_TURN", player: "p1" });
    expect(r.ok, r.error).toBe(true);
    expect(r.state.players[1]!.hand).toHaveLength(7);
    expect(r.state.players[1]!.hand[5]).toBe(state.mainDeck[0]);
    expect(r.events.map((e) => e.type)).toEqual(["TURN_ENDED", "TURN_STARTED", "CARD_DRAWN", "DECK_RESHUFFLED", "CARD_DRAWN"]);
    expect(mainDeckCards(r.state)).toEqual(mainDeckCards(state));
  });

  it("runs an end-of-turn passive before the hand limit", () => {
    const e = leadersWith({ hook: "onTurnEnd", effect: { op: "draw", who: "self", amount: 1 } });
    const r = e.applyAction(begin(e, { handLimit: 5 }), { type: "END_TURN", player: "p1" });
    expect(r.events[0]).toMatchObject({ type: "CARD_DRAWN", player: "p1" });
    // Drawing put p1 over the limit, so they discard before the turn passes.
    expect(r.state.phase).toMatchObject({ kind: "turnEnd" });
    expect(e.isDiscardDecision(r.state, "p1")).toBe(true);
  });

  it("draws a free card at the start of a turn with drawAtStartOfTurn", () => {
    const state = start({ drawAtStartOfTurn: true });
    expect(state.players[0]!.hand).toHaveLength(6);
    const r = engine.applyAction(state, { type: "END_TURN", player: "p1" });
    expect(r.state.players[1]!.hand).toHaveLength(6);
    expect(r.state.actionPoints).toBe(3);
  });

  it("changes what an action costs with modifyActionCost, when its condition matches", () => {
    const dear = leadersWith({ hook: "modifyActionCost", condition: { action: "DRAW_CARD" }, value: 1 });
    let state = act2(dear, begin(dear), { type: "DRAW_CARD", player: "p1" });
    expect(state.actionPoints).toBe(1);
    expect(dear.getLegalActions(state, "p1").map((a) => a.type)).toEqual(["END_TURN"]);

    const other = leadersWith({ hook: "modifyActionCost", condition: { action: "ROLL_HERO_EFFECT" }, value: 1 });
    state = act2(other, begin(other), { type: "DRAW_CARD", player: "p1" });
    expect(state.actionPoints).toBe(2);

    const free = leadersWith({ hook: "modifyActionCost", condition: { action: "DISCARD_AND_REDRAW" }, value: -1 });
    state = act2(free, begin(free), { type: "DRAW_CARD", player: "p1" });
    expect(free.getLegalActions(state, "p1").map((a) => a.type)).toEqual(["DRAW_CARD", "DISCARD_AND_REDRAW", "END_TURN"]);
  });

  function act2(e: ReturnType<typeof createRoomEngine>, state: GameState, action: Action): GameState {
    const r = e.applyAction(state, action);
    expect(r.ok, r.error).toBe(true);
    return r.state;
  }
});
