import { z } from "zod";

/**
 * Rule flags (TECHNICAL_DESIGN.md §3.9). The schema is strict, so the
 * Room's config patch fails loudly on an unknown key or a wrong type.
 */
const count = (min: number) => z.number().int().min(min);

export const RuleConfigSchema = z.strictObject({
  actionPointsPerTurn: count(1),
  handLimit: count(0),
  startingHandSize: count(0),
  activeMonsterCount: count(1),
  monstersToWin: count(1),
  classesToWin: count(1),
  drawAtStartOfTurn: z.boolean(),
  freeRollOnHeroPlay: z.boolean(),
  maxChallengesPerPlay: count(0),
  challengeTieWinner: z.enum(["challenger", "challenged"]),
  rollFlagFollowsHero: z.boolean(),
  itemFollowsStolenHero: z.boolean(),
  leaderCountsForRequirements: z.boolean(),
  winCheckTiming: z.enum(["immediate", "endOfAction"]),
  leaderSelection: z.enum(["random", "draft"]),
  firstPlayerMethod: z.enum(["roll", "random", "firstSeat"]),
  /** A Room setting (remote Seats only); the engine accepts it but never reads it. */
  responseWindowMs: count(1),
  reshuffleDiscardWhenDeckEmpty: z.boolean(),
});
export type RuleConfig = z.infer<typeof RuleConfigSchema>;

export const DEFAULT_CONFIG: RuleConfig = {
  actionPointsPerTurn: 3,
  handLimit: 7,
  startingHandSize: 5,
  activeMonsterCount: 3,
  monstersToWin: 3,
  classesToWin: 6,
  drawAtStartOfTurn: false, // RULE-CHECK: §15 item 3
  freeRollOnHeroPlay: true, // RULE-CHECK: §15 item 2
  maxChallengesPerPlay: 1,
  challengeTieWinner: "challenger", // RULE-CHECK: §15 item 1
  rollFlagFollowsHero: true, // RULE-CHECK: §15 item 5
  itemFollowsStolenHero: true, // RULE-CHECK: §15 item 6
  leaderCountsForRequirements: true, // RULE-CHECK: §15 item 4
  winCheckTiming: "immediate", // RULE-CHECK: §15 item 8
  leaderSelection: "random",
  firstPlayerMethod: "roll",
  responseWindowMs: 8000,
  reshuffleDiscardWhenDeckEmpty: true,
};

const RuleConfigPatchSchema = RuleConfigSchema.partial();

/** Applies `patch` over the defaults, or throws an error naming each bad key. */
export function resolveConfig(patch: unknown): RuleConfig {
  const result = RuleConfigPatchSchema.safeParse(patch);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      if (issue.code === "unrecognized_keys") return `unknown ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
      return `"${issue.path.join(".")}": ${issue.message}`;
    });
    throw new Error(`Invalid config: ${problems.join("; ")}`);
  }
  // exactOptionalPropertyTypes: drop keys the patch left undefined.
  const defined = Object.fromEntries(Object.entries(result.data).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_CONFIG, ...defined };
}
