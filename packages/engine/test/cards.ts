import { HERO_CLASSES, loadCardDefs, type CardDef } from "@here-to-slay/cards";

/**
 * A small card set for engine tests, independent of the placeholder play
 * set: one leader per class, `heroCopies` of one hero per class, one
 * Challenge, one Modifier and `monsters` monsters.
 */
export function smallSet(opts: { heroCopies?: number; monsters?: number } = {}): CardDef[] {
  const { heroCopies = 4, monsters = 5 } = opts;
  return loadCardDefs([
    ...HERO_CLASSES.map((cls) => ({
      id: `leader_${cls}`,
      type: "leader",
      name: `${cls} leader`,
      text: "",
      copies: 1,
      class: cls,
      passive: { hook: "modifyRollTotal", value: 1 },
    })),
    ...HERO_CLASSES.map((cls) => ({
      id: `hero_${cls}`,
      type: "hero",
      name: `${cls} hero`,
      text: "",
      copies: heroCopies,
      class: cls,
      rollRequirement: 7,
      effect: { op: "draw", who: "self", amount: 1 },
    })),
    { id: "challenge", type: "challenge", name: "Challenge", text: "", copies: 2 },
    { id: "mod", type: "modifier", name: "Modifier", text: "", copies: 2, options: [2, -2] },
    ...Array.from({ length: monsters }, (_, i) => ({
      id: `monster_${i + 1}`,
      type: "monster",
      name: `Monster ${i + 1}`,
      text: "",
      copies: 1,
      requirement: { kind: "none" },
      slayAt: 8,
      defeatAt: 4,
      penalty: { op: "discard", who: "self", amount: 1, chosenBy: "self" },
      reward: { hook: "modifyRollTotal", value: 1 },
    })),
  ]);
}

export function players(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, isBot: false }));
}
