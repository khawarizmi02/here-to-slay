import type { CardDef, CardDefId } from "./schema.js";

/** One physical copy of a card in a game (TECHNICAL_DESIGN.md §4.1). */
export interface CardInstance {
  /** `<defId>#<n>`, e.g. "hero_thief_01#0". Unique within one deck. */
  instanceId: string;
  defId: CardDefId;
}

/**
 * Expands each definition's `copies` into card instances with unique ids
 * (§5.7). The order is fixed: definitions as given, then copy number. The
 * engine shuffles with its own seeded RNG.
 */
export function buildDeck(defs: readonly CardDef[]): CardInstance[] {
  const seen = new Set<CardDefId>();
  const deck: CardInstance[] = [];
  for (const def of defs) {
    if (seen.has(def.id)) throw new Error(`Duplicate card definition id "${def.id}"`);
    seen.add(def.id);
    for (let n = 0; n < def.copies; n++) deck.push({ instanceId: `${def.id}#${n}`, defId: def.id });
  }
  return deck;
}
