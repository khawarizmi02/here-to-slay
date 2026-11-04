import type { ItemDef } from "@here-to-slay/cards";
import { heroesMatching } from "./party.js";
import { playerState } from "./players.js";
import { pushTriggers, runStack } from "./stack.js";
import type { CardIndex, CardInstanceId, GameEvent, GameState, PlayerId } from "./types.js";

/** The item definition of a card instance, Cursed or not, or undefined when it isn't an item. */
function itemDef(defs: CardIndex, state: GameState, card: CardInstanceId): ItemDef | undefined {
  const def = defs.get(state.cards[card] ?? "");
  return def?.type === "item" || def?.type === "cursedItem" ? def : undefined;
}

/**
 * Every item `player` can play now, with each hero it can go on (§3.5, §3.8):
 * an item goes on one of their own heroes with no item, a Cursed item on any
 * player's hero with no item. Items by instance id, heroes in turn order of
 * their owners, then party order.
 */
export function playableItems(defs: CardIndex, state: GameState, player: PlayerId): { card: CardInstanceId; targetHero: CardInstanceId }[] {
  return [...playerState(state, player).hand].sort().flatMap((card) => {
    const def = itemDef(defs, state, card);
    if (def === undefined) return [];
    const owner = def.type === "cursedItem" ? "any" : "self";
    return heroesMatching(defs, state, player, { owner, hasItem: false }).map((h) => ({ card, targetHero: h.hero }));
  });
}

/** PLAY_ITEM (§3.5): the item goes from the hand onto `hero` (no Challenge Window until #47). */
export function playItem(defs: CardIndex, state: GameState, player: PlayerId, card: CardInstanceId, hero: CardInstanceId, events: GameEvent[]): void {
  const p = playerState(state, player);
  p.hand = p.hand.filter((c) => c !== card);
  const owner = state.players.find((q) => q.party.some((h) => h.instanceId === hero))!;
  owner.party.find((h) => h.instanceId === hero)!.equippedItem = card;
  events.push({ type: "ITEM_PLAYED", player, card: { id: card, def: state.cards[card]! }, owner: owner.id, hero: { id: hero, def: state.cards[hero]! } });
  pushTriggers(defs, state, player, "onCardPlayed", { action: "PLAY_ITEM" });
  runStack(defs, state, events);
}

/** The Magic cards in `player`'s hand, by instance id. */
export function playableMagic(defs: CardIndex, state: GameState, player: PlayerId): CardInstanceId[] {
  return playerState(state, player)
    .hand.filter((c) => defs.get(state.cards[c]!)?.type === "magic")
    .sort();
}

/**
 * PLAY_MAGIC (§3.5): the card leaves the hand, its effect resolves, then it
 * goes to the discard pile (no Challenge Window until #47). The player's
 * onCardPlayed passives run after that.
 */
export function playMagic(defs: CardIndex, state: GameState, player: PlayerId, card: CardInstanceId, events: GameEvent[]): void {
  const p = playerState(state, player);
  p.hand = p.hand.filter((c) => c !== card);
  events.push({ type: "MAGIC_PLAYED", player, card: { id: card, def: state.cards[card]! } });
  pushTriggers(defs, state, player, "onCardPlayed", { action: "PLAY_MAGIC" });
  state.stack.push({ kind: "magic", player, card, started: false });
  runStack(defs, state, events);
}
