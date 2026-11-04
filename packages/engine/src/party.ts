import type { HeroFilter } from "@here-to-slay/cards";
import { playerState } from "./players.js";
import { heroClass } from "./selectors.js";
import { pushTriggers } from "./stack.js";
import type { CardIndex, CardInstanceId, CardView, GameEvent, GameState, HeroInPlay, PlayerId } from "./types.js";

/** A hero in someone's party. */
export interface OwnedHero {
  owner: PlayerId;
  hero: CardInstanceId;
}

/**
 * Every hero in a party that `filter` allows, seen from `me` (§5.2), in turn
 * order of their owners. Party Leaders are never in a party, so they can
 * never be targeted (§3.8).
 */
export function heroesMatching(defs: CardIndex, state: GameState, me: PlayerId, filter: Omit<HeroFilter, "chosenBy">): OwnedHero[] {
  return state.turnOrder.flatMap((owner) => {
    if (filter.owner === "self" && owner !== me) return [];
    if (filter.owner === "other" && owner === me) return [];
    return playerState(state, owner)
      .party.filter((h) => filter.hasItem === undefined || (h.equippedItem !== null) === filter.hasItem)
      .filter((h) => filter.class === undefined || heroClass(defs, state, h.instanceId) === filter.class)
      .map((h) => ({ owner, hero: h.instanceId }));
  });
}

/**
 * STEAL (§3.8): `hero` leaves `from`'s party for `to`'s, with its item and
 * roll flag as the config says (§3.5, §3.9). `from`'s onHeroLeaveParty
 * passives run, then `to`'s onHeroEnterParty passives.
 */
export function stealHero(defs: CardIndex, state: GameState, to: PlayerId, from: PlayerId, hero: CardInstanceId, events: GameEvent[]): void {
  // The class it left with: its Mask may not come along.
  const ctx = { heroClass: heroClass(defs, state, hero) };
  const moved = removeHero(state, from, hero);
  const item = moved.equippedItem;
  if (item !== null && !state.config.itemFollowsStolenHero) {
    moved.equippedItem = null;
    state.discardPile.push(item);
  }
  if (!state.config.rollFlagFollowsHero) moved.rolledThisTurn = false;
  playerState(state, to).party.push(moved);
  events.push({ type: "HERO_STOLEN", player: to, from, hero: view(state, hero), item: moved.equippedItem === null ? null : view(state, moved.equippedItem) });
  if (item !== null && moved.equippedItem === null) events.push({ type: "ITEM_DISCARDED", player: from, item: view(state, item) });
  pushTriggers(defs, state, to, "onHeroEnterParty", ctx);
  pushTriggers(defs, state, from, "onHeroLeaveParty", ctx);
}

/**
 * DESTROY or SACRIFICE (§3.8): `hero` leaves `owner`'s party for the discard
 * pile, and its item goes too, the item on top. `owner`'s onHeroLeaveParty
 * passives run.
 */
export function discardHero(
  defs: CardIndex,
  state: GameState,
  how: "HERO_DESTROYED" | "HERO_SACRIFICED",
  by: PlayerId,
  owner: PlayerId,
  hero: CardInstanceId,
  events: GameEvent[],
): void {
  const ctx = { heroClass: heroClass(defs, state, hero) };
  const gone = removeHero(state, owner, hero);
  state.discardPile.push(hero);
  if (gone.equippedItem !== null) state.discardPile.push(gone.equippedItem);
  const item = gone.equippedItem === null ? null : view(state, gone.equippedItem);
  if (how === "HERO_DESTROYED") events.push({ type: how, player: by, owner, hero: view(state, hero), item });
  else events.push({ type: how, player: owner, hero: view(state, hero), item });
  pushTriggers(defs, state, owner, "onHeroLeaveParty", ctx);
}

function removeHero(state: GameState, owner: PlayerId, hero: CardInstanceId): HeroInPlay {
  const p = playerState(state, owner);
  const at = p.party.findIndex((h) => h.instanceId === hero);
  if (at < 0) throw new Error(`${hero} is not in ${owner}'s party`);
  return p.party.splice(at, 1)[0]!;
}

function view(state: GameState, card: CardInstanceId): CardView {
  return { id: card, def: state.cards[card]! };
}
