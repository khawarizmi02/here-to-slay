import type { CostedAction, HeroClass, PassiveAbility, RollKind } from "@here-to-slay/cards";
import { playerState } from "./players.js";
import type { CardIndex, CardInstanceId, GameState, PlayerId } from "./types.js";

/** What a hook point knows when it runs; a passive's condition must match every field it names. */
export interface HookContext {
  action?: CostedAction;
  rollKind?: RollKind;
  heroClass?: HeroClass;
  /** The hero a roll is for. An item's passive applies only to its own hero's rolls. */
  hero?: CardInstanceId;
}

/** A passive, with the card that grants it. */
export interface SourcedPassive {
  passive: PassiveAbility;
  source: CardInstanceId;
}

/**
 * Every passive `player` has at `hook` (TECHNICAL_DESIGN.md §5.4), with the
 * card it comes from: their Party Leader's, then the items on their heroes in
 * party order, then their slain monsters' rewards in the order they were
 * slain. An item counts for a roll only when its hero is the one rolling.
 */
export function passiveSourcesAt(
  defs: CardIndex,
  state: GameState,
  player: PlayerId,
  hook: PassiveAbility["hook"],
  ctx: HookContext = {},
): SourcedPassive[] {
  const p = playerState(state, player);
  const found: SourcedPassive[] = [];
  const add = (source: CardInstanceId | null) => {
    if (source === null) return;
    const def = defs.get(state.cards[source]!)!;
    const passive = def.type === "monster" ? def.reward : "passive" in def ? def.passive : undefined;
    if (passive?.hook === hook && matches(passive, ctx)) found.push({ passive, source });
  };
  add(p.leader);
  for (const hero of p.party) if (ctx.hero === undefined || ctx.hero === hero.instanceId) add(hero.equippedItem);
  for (const monster of p.slainMonsters) add(monster);
  return found;
}

/** The passives of `passiveSourcesAt`, without their cards. */
export function passivesAt(
  defs: CardIndex,
  state: GameState,
  player: PlayerId,
  hook: PassiveAbility["hook"],
  ctx: HookContext = {},
): PassiveAbility[] {
  return passiveSourcesAt(defs, state, player, hook, ctx).map((s) => s.passive);
}

function matches(passive: PassiveAbility, ctx: HookContext): boolean {
  const condition = passive.condition ?? {};
  return Object.entries(condition).every(([key, value]) => ctx[key as keyof HookContext] === value);
}

/** The sum of `value` over every passive at a "modify" hook. */
function modifierTotal(defs: CardIndex, state: GameState, player: PlayerId, hook: PassiveAbility["hook"], ctx: HookContext = {}): number {
  return passivesAt(defs, state, player, hook, ctx).reduce((sum, p) => sum + (p.value ?? 0), 0);
}

/** The AP `action` costs `player` (§3.5), after `modifyActionCost` passives. Never below 0. */
export function actionCost(defs: CardIndex, state: GameState, player: PlayerId, action: CostedAction): number {
  return Math.max(0, BASE_COST[action] + modifierTotal(defs, state, player, "modifyActionCost", { action }));
}

const BASE_COST: Record<CostedAction, number> = {
  DRAW_CARD: 1,
  PLAY_HERO: 1,
  PLAY_ITEM: 1,
  PLAY_MAGIC: 1,
  ROLL_HERO_EFFECT: 1,
  ATTACK_MONSTER: 2,
  DISCARD_AND_REDRAW: 3,
};

/** What passives add to `player`'s roll (§4.4 `getRollBonus`): the sum of their matching `modifyRollTotal` values. */
export function rollBonus(defs: CardIndex, state: GameState, player: PlayerId, ctx: HookContext): number {
  return modifierTotal(defs, state, player, "modifyRollTotal", ctx);
}

/** `player`'s hand limit (§3.4), after `modifyHandLimit` passives. Never below 0. */
export function handLimit(defs: CardIndex, state: GameState, player: PlayerId): number {
  return Math.max(0, state.config.handLimit + modifierTotal(defs, state, player, "modifyHandLimit"));
}
