import challenges from "../data/challenges.json" with { type: "json" };
import heroes from "../data/heroes.json" with { type: "json" };
import items from "../data/items.json" with { type: "json" };
import leaders from "../data/leaders.json" with { type: "json" };
import magic from "../data/magic.json" with { type: "json" };
import modifiers from "../data/modifiers.json" with { type: "json" };
import monsters from "../data/monsters.json" with { type: "json" };
import { loadCardDefs } from "./loader.js";
import type { CardDef } from "./schema.js";

/**
 * The raw JSON of the placeholder play set, every file in a fixed order.
 * Names and numbers are placeholders until the real cards arrive in M8.
 */
export const placeholderCardJson: readonly unknown[] = [
  ...leaders,
  ...heroes,
  ...items,
  ...magic,
  ...modifiers,
  ...challenges,
  ...monsters,
];

/**
 * The placeholder play set, validated when this module loads so bad data
 * fails at startup (TECHNICAL_DESIGN.md §5.7). It covers every card type and
 * every M2/M3 effect op and hook point. Tests that depend on specific cards
 * should build their own small set instead of using this one.
 */
export const placeholderCardDefs: readonly CardDef[] = loadCardDefs(placeholderCardJson);
