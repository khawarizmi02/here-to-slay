import { z } from "zod";

/**
 * Zod schemas for card definitions (TECHNICAL_DESIGN.md §4.2, §5). Every
 * object is strict, so a misspelt field fails loudly instead of being dropped.
 */

export const HERO_CLASSES = ["bard", "fighter", "guardian", "ranger", "thief", "wizard"] as const;
export const HeroClassSchema = z.enum(HERO_CLASSES);
export type HeroClass = z.infer<typeof HeroClassSchema>;

export const CARD_TYPES = [
  "leader",
  "hero",
  "item",
  "cursedItem",
  "magic",
  "modifier",
  "challenge",
  "monster",
] as const;
export const CardTypeSchema = z.enum(CARD_TYPES);
export type CardType = z.infer<typeof CardTypeSchema>;

/** Card definition ids: lower-case words joined by underscores, e.g. "hero_bard_01". */
export const CardDefIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "must be lower-case letters and digits joined by underscores")
  .max(48);
export type CardDefId = z.infer<typeof CardDefIdSchema>;

// ---------------------------------------------------------------------------
// Effect DSL (§5.2)

/**
 * Which players a `forEach` covers or a `choose` may pick. "withHeroes" and
 * "withCards" include the controller; the "other…" forms exclude them.
 */
export const PLAYER_FILTERS = [
  "any",
  "other",
  "self",
  "withHeroes",
  "withCards",
  "otherWithHeroes",
  "otherWithCards",
] as const;
export const PlayerFilterSchema = z.enum(PLAYER_FILTERS);
export type PlayerFilter = z.infer<typeof PlayerFilterSchema>;

export const PlayerRefSchema = z.union([
  z.literal("self"),
  z.literal("activePlayer"),
  /** Asks the chooser to pick a player. */
  z.strictObject({ choose: PlayerFilterSchema }),
], { error: `must be "self", "activePlayer" or { "choose": ${PLAYER_FILTERS.map((f) => `"${f}"`).join(" | ")} }` });
export type PlayerRef = z.infer<typeof PlayerRefSchema>;

export const HeroFilterSchema = z.strictObject({
  owner: z.enum(["self", "other", "any"]),
  class: HeroClassSchema.exactOptional(),
  hasItem: z.boolean().exactOptional(),
  chosenBy: z.enum(["self", "owner"]),
});
export type HeroFilter = z.infer<typeof HeroFilterSchema>;

export const CardFilterSchema = z.strictObject({
  types: z.array(CardTypeSchema).min(1).exactOptional(),
  class: HeroClassSchema.exactOptional(),
});
export type CardFilter = z.infer<typeof CardFilterSchema>;

export type Effect =
  | { op: "sequence"; steps: Effect[] }
  | { op: "choice"; chooser: PlayerRef; options: { label: string; effect: Effect }[] }
  | { op: "optional"; chooser: PlayerRef; effect: Effect }
  | { op: "forEach"; players: PlayerFilter; effect: Effect }
  | { op: "draw"; who: PlayerRef; amount: number }
  | { op: "discard"; who: PlayerRef; amount: number; chosenBy: PlayerRef }
  | { op: "steal"; from: PlayerRef; target: HeroFilter }
  | { op: "destroy"; target: HeroFilter }
  | { op: "sacrifice"; who: PlayerRef; amount: number }
  | { op: "pull"; from: PlayerRef; amount: number }
  | { op: "searchDiscard"; who: PlayerRef; filter: CardFilter; amount: number }
  | { op: "searchDeck"; who: PlayerRef; filter: CardFilter; amount: number }
  | { op: "lookAtHand"; viewer: PlayerRef; target: PlayerRef }
  | { op: "tradeHands"; a: PlayerRef; b: PlayerRef }
  | { op: "playFromHand"; who: PlayerRef; filter: CardFilter; free: boolean }
  | { op: "gainAP"; amount: number }
  | { op: "custom"; handler: string; params?: Record<string, unknown> };

export type EffectOp = Effect["op"];

const amount = z.number().int().min(1).max(10);
const handlerName = z.string().min(1).max(64);

export const EffectSchema: z.ZodType<Effect> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("sequence"), steps: z.array(EffectSchema).min(1) }),
    z.strictObject({
      op: z.literal("choice"),
      chooser: PlayerRefSchema,
      options: z.array(z.strictObject({ label: z.string().min(1), effect: EffectSchema })).min(2),
    }),
    z.strictObject({ op: z.literal("optional"), chooser: PlayerRefSchema, effect: EffectSchema }),
    z.strictObject({ op: z.literal("forEach"), players: PlayerFilterSchema, effect: EffectSchema }),
    z.strictObject({ op: z.literal("draw"), who: PlayerRefSchema, amount }),
    z.strictObject({ op: z.literal("discard"), who: PlayerRefSchema, amount, chosenBy: PlayerRefSchema }),
    z.strictObject({ op: z.literal("steal"), from: PlayerRefSchema, target: HeroFilterSchema }),
    z.strictObject({ op: z.literal("destroy"), target: HeroFilterSchema }),
    z.strictObject({ op: z.literal("sacrifice"), who: PlayerRefSchema, amount }),
    z.strictObject({ op: z.literal("pull"), from: PlayerRefSchema, amount }),
    z.strictObject({ op: z.literal("searchDiscard"), who: PlayerRefSchema, filter: CardFilterSchema, amount }),
    z.strictObject({ op: z.literal("searchDeck"), who: PlayerRefSchema, filter: CardFilterSchema, amount }),
    z.strictObject({ op: z.literal("lookAtHand"), viewer: PlayerRefSchema, target: PlayerRefSchema }),
    z.strictObject({ op: z.literal("tradeHands"), a: PlayerRefSchema, b: PlayerRefSchema }),
    z.strictObject({ op: z.literal("playFromHand"), who: PlayerRefSchema, filter: CardFilterSchema, free: z.boolean() }),
    z.strictObject({ op: z.literal("gainAP"), amount }),
    z.strictObject({
      op: z.literal("custom"),
      handler: handlerName,
      params: z.record(z.string(), z.unknown()).exactOptional(),
    }),
  ]),
);

// ---------------------------------------------------------------------------
// Requirements (§5.3)

export type Requirement =
  | { kind: "heroCount"; min: number }
  | { kind: "classCount"; class: HeroClass; min: number }
  | { kind: "all"; of: Requirement[] }
  | { kind: "none" };

export const RequirementSchema: z.ZodType<Requirement> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("heroCount"), min: z.number().int().min(1).max(12) }),
    z.strictObject({ kind: z.literal("classCount"), class: HeroClassSchema, min: z.number().int().min(1).max(12) }),
    z.strictObject({ kind: z.literal("all"), of: z.array(RequirementSchema).min(1) }),
    z.strictObject({ kind: z.literal("none") }),
  ]),
);

// ---------------------------------------------------------------------------
// Passive abilities (§5.4)

/** Hook points that run an effect when they fire. */
export const TRIGGER_HOOKS = [
  "onTurnStart",
  "onTurnEnd",
  "beforeRoll",
  "afterRoll",
  "onCardPlayed",
  "onHeroEnterParty",
  "onHeroLeaveParty",
  "onChallenged",
  "onMonsterSlain",
] as const;
/** Hook points that change a number by `value`. */
export const MODIFY_HOOKS = ["modifyRollTotal", "modifyActionCost", "modifyHandLimit"] as const;
export const HOOK_POINTS = [...TRIGGER_HOOKS, ...MODIFY_HOOKS] as const;
export const HookPointSchema = z.enum(HOOK_POINTS);
export type HookPoint = z.infer<typeof HookPointSchema>;

export const ROLL_KINDS = ["heroEffect", "monsterAttack", "challenge"] as const;
export const RollKindSchema = z.enum(ROLL_KINDS);
export type RollKind = z.infer<typeof RollKindSchema>;

/** The turn actions that cost AP (§3.5), for `modifyActionCost`. */
export const COSTED_ACTIONS = [
  "DRAW_CARD",
  "PLAY_HERO",
  "PLAY_ITEM",
  "PLAY_MAGIC",
  "ROLL_HERO_EFFECT",
  "ATTACK_MONSTER",
  "DISCARD_AND_REDRAW",
] as const;
export const CostedActionSchema = z.enum(COSTED_ACTIONS);
export type CostedAction = z.infer<typeof CostedActionSchema>;

/** Narrows when a passive applies. Every field given must match. */
export const ConditionSchema = z.strictObject({
  rollKind: RollKindSchema.exactOptional(),
  heroClass: HeroClassSchema.exactOptional(),
  action: CostedActionSchema.exactOptional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const PassiveAbilitySchema = z
  .strictObject({
    hook: HookPointSchema,
    condition: ConditionSchema.exactOptional(),
    effect: EffectSchema.exactOptional(),
    value: z.number().int().min(-10).max(10).exactOptional(),
    handler: handlerName.exactOptional(),
  })
  .superRefine((passive, ctx) => {
    if (passive.handler !== undefined && (passive.effect !== undefined || passive.value !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["handler"], message: "a passive with a handler takes no effect or value" });
    }
    const isModify = (MODIFY_HOOKS as readonly string[]).includes(passive.hook);
    if (isModify) {
      if (passive.value === undefined && passive.handler === undefined) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `a "${passive.hook}" passive needs a value` });
      }
      if (passive.effect !== undefined) {
        ctx.addIssue({ code: "custom", path: ["effect"], message: `a "${passive.hook}" passive takes a value, not an effect` });
      }
    } else {
      if (passive.effect === undefined && passive.handler === undefined) {
        ctx.addIssue({ code: "custom", path: ["effect"], message: `a "${passive.hook}" passive needs an effect` });
      }
      if (passive.value !== undefined) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `a "${passive.hook}" passive takes an effect, not a value` });
      }
    }
  });
export type PassiveAbility = z.infer<typeof PassiveAbilitySchema>;

// ---------------------------------------------------------------------------
// Card definitions (§4.2)

const base = {
  id: CardDefIdSchema,
  name: z.string().trim().min(1).max(48),
  text: z.string().max(400),
  copies: z.number().int().min(1).max(20),
  art: z.string().min(1).exactOptional(),
};

const dieTotal = z.number().int().min(2).max(12);

export const LeaderDefSchema = z.strictObject({
  ...base,
  type: z.literal("leader"),
  class: HeroClassSchema,
  passive: PassiveAbilitySchema,
});
export type LeaderDef = z.infer<typeof LeaderDefSchema>;

export const HeroDefSchema = z.strictObject({
  ...base,
  type: z.literal("hero"),
  class: HeroClassSchema,
  rollRequirement: dieTotal,
  effect: EffectSchema,
});
export type HeroDef = z.infer<typeof HeroDefSchema>;

const itemFields = {
  ...base,
  passive: PassiveAbilitySchema.exactOptional(),
  /** Set for Mask items: the equipped hero counts as this class (§3.8). */
  maskClass: HeroClassSchema.exactOptional(),
};

export const ItemDefSchema = z.strictObject({ ...itemFields, type: z.literal("item") });
export const CursedItemDefSchema = z.strictObject({ ...itemFields, type: z.literal("cursedItem") });
export type ItemDef = z.infer<typeof ItemDefSchema> | z.infer<typeof CursedItemDefSchema>;

export const MagicDefSchema = z.strictObject({
  ...base,
  type: z.literal("magic"),
  effect: EffectSchema,
});
export type MagicDef = z.infer<typeof MagicDefSchema>;

export const ModifierDefSchema = z.strictObject({
  ...base,
  type: z.literal("modifier"),
  options: z
    .array(z.number().int().min(-10).max(10).refine((n) => n !== 0, "a modifier option cannot be 0"))
    .min(1)
    .refine((options) => new Set(options).size === options.length, "modifier options must be distinct"),
});
export type ModifierDef = z.infer<typeof ModifierDefSchema>;

export const ChallengeDefSchema = z.strictObject({
  ...base,
  type: z.literal("challenge"),
});
export type ChallengeDef = z.infer<typeof ChallengeDefSchema>;

export const MonsterDefSchema = z
  .strictObject({
    ...base,
    type: z.literal("monster"),
    requirement: RequirementSchema,
    slayAt: dieTotal,
    defeatAt: dieTotal,
    penalty: EffectSchema,
    reward: PassiveAbilitySchema,
  })
  .refine((monster) => monster.defeatAt < monster.slayAt, {
    path: ["defeatAt"],
    message: "defeatAt must be lower than slayAt",
  });
export type MonsterDef = z.infer<typeof MonsterDefSchema>;

export const CardDefSchema = z.discriminatedUnion("type", [
  LeaderDefSchema,
  HeroDefSchema,
  ItemDefSchema,
  CursedItemDefSchema,
  MagicDefSchema,
  ModifierDefSchema,
  ChallengeDefSchema,
  MonsterDefSchema,
]);
export type CardDef = z.infer<typeof CardDefSchema>;
