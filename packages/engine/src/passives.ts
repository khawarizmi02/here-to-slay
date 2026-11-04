import type { CostedAction, PassiveAbility } from "@here-to-slay/cards";
import { playerState } from "./players.js";
import type { CardIndex, GameState, PlayerId } from "./types.js";

/** What a hook point knows when it runs; a passive's condition must match every field it names. */
export interface HookContext {
  action?: CostedAction;
}

/**
 * Every passive `player` has at `hook` (TECHNICAL_DESIGN.md §5.4): their
 * Party Leader's, then the items on their heroes in party order, then their
 * slain monsters' rewards in the order they were slain.
 */
export function passivesAt(
  defs: CardIndex,
  state: GameState,
  player: PlayerId,
  hook: PassiveAbility["hook"],
  ctx: HookContext = {},
): PassiveAbility[] {
  const p = playerState(state, player);
  const found: PassiveAbility[] = [];
  const add = (instance: string | null) => {
    if (instance === null) return;
    const def = defs.get(state.cards[instance]!)!;
    const passive = def.type === "monster" ? def.reward : "passive" in def ? def.passive : undefined;
    if (passive?.hook === hook && matches(passive, ctx)) found.push(passive);
  };
  add(p.leader);
  for (const hero of p.party) add(hero.equippedItem);
  for (const monster of p.slainMonsters) add(monster);
  return found;
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

/** `player`'s hand limit (§3.4), after `modifyHandLimit` passives. Never below 0. */
export function handLimit(defs: CardIndex, state: GameState, player: PlayerId): number {
  return Math.max(0, state.config.handLimit + modifierTotal(defs, state, player, "modifyHandLimit"));
}
