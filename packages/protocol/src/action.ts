import { z } from "zod";
import { CardInstanceIdSchema, PlayerIdSchema } from "./common.js";

/**
 * The answer to a PendingDecision: the id of the one chosen option. Every
 * Decision is exactly one pick (GLOSSARY.md); choosing several cards is a
 * chain of Decisions, and a "you may" Decision offers an explicit Decline option.
 */
export const DecisionAnswerSchema = z.strictObject({
  selected: z.tuple([z.string().min(1).max(64)]),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

const player = PlayerIdSchema;
const card = CardInstanceIdSchema;

/** Engine actions, TECHNICAL_DESIGN.md §6.2. */
export const ActionSchema = z.discriminatedUnion("type", [
  // Turn actions
  z.strictObject({ type: z.literal("DRAW_CARD"), player }),
  z.strictObject({ type: z.literal("PLAY_HERO"), player, card }),
  z.strictObject({ type: z.literal("PLAY_ITEM"), player, card, targetHero: card }),
  z.strictObject({ type: z.literal("PLAY_MAGIC"), player, card }),
  z.strictObject({ type: z.literal("ROLL_HERO_EFFECT"), player, hero: card }),
  z.strictObject({ type: z.literal("ATTACK_MONSTER"), player, monster: card }),
  z.strictObject({ type: z.literal("DISCARD_AND_REDRAW"), player }),
  z.strictObject({ type: z.literal("END_TURN"), player }),
  // Responses
  z.strictObject({ type: z.literal("PLAY_CHALLENGE"), player, card }),
  z.strictObject({
    type: z.literal("PLAY_MODIFIER"),
    player,
    card,
    value: z.number().int(),
    /** The roll it modifies. Engines may leave it out when the Modifier Window holds one roll. */
    roll: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({ type: z.literal("PASS"), player }),
  // Answers to prompts
  z.strictObject({
    type: z.literal("RESOLVE_DECISION"),
    player,
    decisionId: z.string().min(1).max(64),
    answer: DecisionAnswerSchema,
  }),
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action["type"];
