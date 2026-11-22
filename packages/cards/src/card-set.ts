import { CardLoadError, loadCardDefs } from "./loader.js";
import { placeholderCardDefs } from "./placeholder.js";
import type { CardDef } from "./schema.js";

/** The seven card files of a set, in the order their cards are loaded. */
export const CARD_FILES = [
  "leaders.json",
  "heroes.json",
  "items.json",
  "magic.json",
  "modifiers.json",
  "challenges.json",
  "monsters.json",
] as const;

/** A validated card set and the name the lobby gives it. */
export interface CardSet {
  readonly label: "Placeholder cards" | "Local cards";
  readonly defs: readonly CardDef[];
}

/**
 * Picks the card set to play with: the private local set (its files are
 * `localFiles`) when any of its files exist, and the placeholder set
 * otherwise. `localFiles` maps each file's path (only its file name is read)
 * to its parsed JSON. A local set must have all seven files and
 * no others, and is validated like any card JSON: any mistake throws a
 * CardLoadError naming the file, or the card and the field.
 */
export function chooseCardSet(localFiles: Readonly<Record<string, unknown>>): CardSet {
  const byName = new Map(Object.entries(localFiles).map(([path, json]) => [fileName(path), json]));
  if (byName.size === 0) return { label: "Placeholder cards", defs: placeholderCardDefs };

  const problems: string[] = [];
  for (const name of CARD_FILES) {
    if (!byName.has(name)) problems.push(`local card file "${name}" is missing`);
    else if (!Array.isArray(byName.get(name))) problems.push(`local card file "${name}" must be an array of cards`);
  }
  const known = new Set<string>(CARD_FILES);
  for (const name of byName.keys()) {
    if (!known.has(name)) problems.push(`local card file "${name}" isn't one of ${CARD_FILES.join(", ")}`);
  }
  if (problems.length > 0) throw new CardLoadError(problems);

  return { label: "Local cards", defs: loadCardDefs(CARD_FILES.flatMap((name) => byName.get(name) as unknown[])) };
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
