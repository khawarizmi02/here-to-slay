import { describe, expect, it } from "vitest";
import {
  buildDeck,
  CARD_TYPES,
  HERO_CLASSES,
  HOOK_POINTS,
  loadCardDefs,
  placeholderCardDefs,
  placeholderCardJson,
  type CardDef,
  type Effect,
  type PassiveAbility,
  type Requirement,
} from "../src/index.js";

/** The effect ops the engine runs in M2 and M3 (TECHNICAL_DESIGN.md §14, issue #36). */
const M2_M3_OPS = [
  "sequence",
  "choice",
  "optional",
  "forEach",
  "draw",
  "discard",
  "steal",
  "destroy",
  "sacrifice",
  "pull",
] as const;

function effectsOf(def: CardDef): Effect[] {
  const effects: Effect[] = [];
  if (def.type === "hero" || def.type === "magic") effects.push(def.effect);
  if (def.type === "monster") effects.push(def.penalty);
  for (const passive of passivesOf(def)) if (passive.effect) effects.push(passive.effect);
  return effects;
}

function opsIn(effect: Effect): string[] {
  switch (effect.op) {
    case "sequence":
      return [effect.op, ...effect.steps.flatMap(opsIn)];
    case "choice":
      return [effect.op, ...effect.options.flatMap((option) => opsIn(option.effect))];
    case "optional":
    case "forEach":
      return [effect.op, ...opsIn(effect.effect)];
    default:
      return [effect.op];
  }
}

function passivesOf(def: CardDef): PassiveAbility[] {
  if (def.type === "leader") return [def.passive];
  if (def.type === "monster") return [def.reward];
  if ((def.type === "item" || def.type === "cursedItem") && def.passive) return [def.passive];
  return [];
}

function requirementKinds(requirement: Requirement): string[] {
  return requirement.kind === "all"
    ? [requirement.kind, ...requirement.of.flatMap(requirementKinds)]
    : [requirement.kind];
}

const defs = placeholderCardDefs;
const deck = buildDeck(defs);
const copiesOf = (filter: (def: CardDef) => boolean) =>
  defs.filter(filter).reduce((total, def) => total + def.copies, 0);

describe("the placeholder play set", () => {
  it("is valid card JSON", () => {
    expect(loadCardDefs(placeholderCardJson)).toEqual(defs);
  });

  it("has every card type", () => {
    const types = new Set(defs.map((def) => def.type));
    expect([...types].sort()).toEqual([...CARD_TYPES].sort());
  });

  it("has a Mask item", () => {
    expect(defs.some((def) => (def.type === "item" || def.type === "cursedItem") && def.maskClass)).toBe(true);
  });

  it("has a leader for each class", () => {
    for (const heroClass of HERO_CLASSES) {
      expect(defs.some((def) => def.type === "leader" && def.class === heroClass), heroClass).toBe(true);
    }
  });

  it("uses every M2/M3 effect op, and no other op", () => {
    const used = new Set(defs.flatMap(effectsOf).flatMap(opsIn));
    expect([...used].sort()).toEqual([...M2_M3_OPS].sort());
  });

  it("uses every passive hook point", () => {
    const used = new Set(defs.flatMap(passivesOf).map((passive) => passive.hook));
    expect([...used].sort()).toEqual([...HOOK_POINTS].sort());
  });

  it("uses every monster requirement kind", () => {
    const used = new Set(defs.flatMap((def) => (def.type === "monster" ? requirementKinds(def.requirement) : [])));
    expect([...used].sort()).toEqual(["all", "classCount", "heroCount", "none"]);
  });

  it("has enough heroes in every class for a class win", () => {
    for (const heroClass of HERO_CLASSES) {
      const heroes = copiesOf((def) => def.type === "hero" && def.class === heroClass);
      expect(heroes, heroClass).toBeGreaterThanOrEqual(4);
    }
  });

  it("has enough monsters for a monster win even with a full monster row", () => {
    // Three face-up monsters plus at least three more to slay behind them (§3.2, §3.3).
    expect(copiesOf((def) => def.type === "monster")).toBeGreaterThanOrEqual(8);
  });

  it("deals six players a starting hand with plenty left to draw", () => {
    const mainDeck = deck.filter(({ defId }) => {
      const type = defs.find((def) => def.id === defId)?.type;
      return type !== "leader" && type !== "monster";
    });
    expect(mainDeck.length).toBeGreaterThanOrEqual(6 * 5 * 2);
  });
});
