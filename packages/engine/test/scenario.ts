import { loadCardDefs, type Effect } from "@here-to-slay/cards";
import type { Action, ConfigPatch } from "@here-to-slay/protocol";
import { expect } from "vitest";
import { createRoomEngine, type GameState, type PendingDecision } from "../src/index.js";
import { players, smallSet } from "./cards.js";

/**
 * Hero cards with these effects, one copy each, added to the small set as
 * `hero_<name>`. Each is a wizard needing 7+. Also two plain items,
 * `item_plain#0` and `#1`, and a Mask `item_mask_thief`, then any `extra` card JSON.
 */
export function engineWith(effects: Record<string, Effect> = {}, leaderBonus = 0, extra: unknown[] = []) {
  const heroes = Object.entries(effects).map(([name, effect]) => ({
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
  const items = [
    { id: "item_plain", type: "item", name: "Plain item", text: "", copies: 2 },
    { id: "item_mask_thief", type: "item", name: "Thief mask", text: "", copies: 1, maskClass: "thief" },
  ];
  return createRoomEngine(loadCardDefs([...base, ...heroes, ...items, ...extra]));
}

export type Engine = ReturnType<typeof createRoomEngine>;

export function start(e: Engine, config: ConfigPatch = {}, count = 3): GameState {
  return e.createGame({ players: players(count), seed: "heroes", config: { firstPlayerMethod: "firstSeat", ...config } });
}

/** Moves `card` into `player`'s hand from wherever it is. */
export function give(state: GameState, player: string, ...cards: string[]): GameState {
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
export function inParty(state: GameState, player: string, ...cards: string[]): GameState {
  for (const card of cards) {
    give(state, player, card);
    const p = state.players.find((q) => q.id === player)!;
    p.hand = p.hand.filter((c) => c !== card);
    p.party.push({ instanceId: card, equippedItem: null, rolledThisTurn: false });
  }
  return state;
}

/** Forces the next dice (TECHNICAL_DESIGN.md §13.2). */
export function dice(state: GameState, ...values: number[]): GameState {
  state.rng.forcedDice = values;
  return state;
}

export function act(e: Engine, state: GameState, action: Action) {
  const r = e.applyAction(state, action);
  expect(r.ok, r.error).toBe(true);
  return r;
}

export function decision(state: GameState): PendingDecision {
  if (state.pendingDecision === null) throw new Error("No Decision is pending");
  return state.pendingDecision;
}

export function answer(e: Engine, state: GameState, id: string) {
  const d = decision(state);
  return act(e, state, { type: "RESOLVE_DECISION", player: d.player, decisionId: d.id, answer: { selected: [id] } });
}

export const hand = (state: GameState, player: string) => state.players.find((p) => p.id === player)!.hand;
export const party = (state: GameState, player: string) => state.players.find((p) => p.id === player)!.party;

/** Rolls `name`'s hero for p1 with a 7, so its effect runs. */
export function rollHero(e: Engine, state: GameState, name: string) {
  return act(e, dice(inParty(state, "p1", `hero_${name}#0`), 4, 3), { type: "ROLL_HERO_EFFECT", player: "p1", hero: `hero_${name}#0` });
}

/** Gives `player` the Party Leader of `cls`, swapping leaders with whoever had it. */
export function leader(state: GameState, player: string, cls: string): GameState {
  const card = `leader_${cls}#0`;
  const me = state.players.find((p) => p.id === player)!;
  const holder = state.players.find((p) => p.leader === card);
  if (holder) holder.leader = me.leader;
  else state.leaderPool = [...state.leaderPool.filter((c) => c !== card), me.leader!].sort();
  me.leader = card;
  return state;
}


/** Equips `item` to `hero`, which must already be in a party, taking the item from wherever it is. */
export function equip(state: GameState, hero: string, item: string): GameState {
  state.mainDeck = state.mainDeck.filter((c) => c !== item);
  state.discardPile = state.discardPile.filter((c) => c !== item);
  for (const p of state.players) p.hand = p.hand.filter((c) => c !== item);
  state.players.flatMap((p) => p.party).find((h) => h.instanceId === hero)!.equippedItem = item;
  return state;
}
