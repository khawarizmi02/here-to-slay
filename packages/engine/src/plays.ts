import type { ItemDef } from "@here-to-slay/cards";
import { heroesMatching } from "./party.js";
import { playerState } from "./players.js";
import { pushChallengeWindow } from "./challenges.js";
import { heroEntersParty } from "./heroes.js";
import { pushTriggers, runStack } from "./stack.js";
import type { CardIndex, CardInstanceId, CardPlayFrame, ChallengeableAction, GameEvent, GameState, PlayerId } from "./types.js";

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

/** The Magic cards in `player`'s hand, by instance id. */
export function playableMagic(defs: CardIndex, state: GameState, player: PlayerId): CardInstanceId[] {
  return playerState(state, player)
    .hand.filter((c) => defs.get(state.cards[c]!)?.type === "magic")
    .sort();
}

/**
 * PLAY_HERO, PLAY_ITEM or PLAY_MAGIC (§3.5, §7.2), its AP already spent: the
 * card leaves the hand for limbo and a Challenge Window opens on it. It
 * resolves once the window closes, unless a Challenge succeeds.
 */
export function playCard(
  defs: CardIndex,
  state: GameState,
  player: PlayerId,
  card: CardInstanceId,
  action: ChallengeableAction,
  targetHero: CardInstanceId | null,
  events: GameEvent[],
): void {
  const p = playerState(state, player);
  p.hand = p.hand.filter((c) => c !== card);
  state.stack.push({ kind: "cardPlay", player, card, action, targetHero, opened: false, challenges: 0, challenged: false });
  runStack(defs, state, events);
}

/** Steps a card play: opens its Challenge Window, then, once no window or duel is left above it, resolves it. */
export function cardPlayStep(defs: CardIndex, state: GameState, frame: CardPlayFrame, events: GameEvent[]): void {
  if (!frame.opened) {
    frame.opened = true;
    pushChallengeWindow(state, frame, events);
    return;
  }
  state.stack.pop();
  // A successful Challenge already sent it to the discard pile.
  if (frame.challenged) return;
  switch (frame.action) {
    case "PLAY_HERO":
      return heroEntersParty(defs, state, frame.player, frame.card, events);
    case "PLAY_ITEM":
      return equipItem(defs, state, frame.player, frame.card, frame.targetHero!, events);
    case "PLAY_MAGIC":
      return startMagic(defs, state, frame.player, frame.card, events);
  }
}

/**
 * The item goes onto `hero` (§3.5), and the player's onCardPlayed passives
 * run. If the hero has left play or gained an item while the item was in
 * limbo, the item goes to the discard pile instead.
 */
function equipItem(defs: CardIndex, state: GameState, player: PlayerId, card: CardInstanceId, hero: CardInstanceId, events: GameEvent[]): void {
  const owner = state.players.find((q) => q.party.some((h) => h.instanceId === hero));
  const slot = owner?.party.find((h) => h.instanceId === hero);
  if (owner === undefined || slot === undefined || slot.equippedItem !== null) {
    state.discardPile.push(card);
    events.push({ type: "ITEM_DISCARDED", player, item: { id: card, def: state.cards[card]! } });
    return;
  }
  slot.equippedItem = card;
  events.push({ type: "ITEM_PLAYED", player, card: { id: card, def: state.cards[card]! }, owner: owner.id, hero: { id: hero, def: state.cards[hero]! } });
  pushTriggers(defs, state, player, "onCardPlayed", { action: "PLAY_ITEM" });
}

/**
 * The Magic card's effect resolves, then the card goes to the discard pile.
 * The player's onCardPlayed passives run after that.
 */
function startMagic(defs: CardIndex, state: GameState, player: PlayerId, card: CardInstanceId, events: GameEvent[]): void {
  events.push({ type: "MAGIC_PLAYED", player, card: { id: card, def: state.cards[card]! } });
  pushTriggers(defs, state, player, "onCardPlayed", { action: "PLAY_MAGIC" });
  state.stack.push({ kind: "magic", player, card, started: false });
}
