import type { HeroClass } from "@here-to-slay/cards";
import { playerState } from "./players.js";
import type { CardIndex, CardInstanceId, GameState, PlayerId } from "./types.js";

/** The class `hero` counts as (§4.4 `getHeroClass`): its Mask item's class if it wears one, otherwise its own. */
export function heroClass(defs: CardIndex, state: GameState, hero: CardInstanceId): HeroClass {
  const item = state.players.flatMap((p) => p.party).find((h) => h.instanceId === hero)?.equippedItem;
  const itemDef = item ? defs.get(state.cards[item]!) : undefined;
  if (itemDef && "maskClass" in itemDef && itemDef.maskClass !== undefined) return itemDef.maskClass;
  const def = defs.get(state.cards[hero]!);
  if (def?.type !== "hero") throw new Error(`${hero} is not a hero`);
  return def.class;
}

/** The distinct classes in `player`'s party, their Party Leader's included (§4.4 `getPartyClasses`). */
export function partyClasses(defs: CardIndex, state: GameState, player: PlayerId): Set<HeroClass> {
  const p = playerState(state, player);
  const classes = new Set<HeroClass>();
  const leader = p.leader === null ? undefined : defs.get(state.cards[p.leader]!);
  if (leader?.type === "leader") classes.add(leader.class);
  for (const hero of p.party) classes.add(heroClass(defs, state, hero.instanceId));
  return classes;
}
