import { CardLoadError, type CardDef, type PassiveAbility } from "@here-to-slay/cards";
import type { CardIndex, EffectFrame, GameEvent, GameState } from "./types.js";

/*
 * Passive handlers (TECHNICAL_DESIGN.md §5.4): what a passive runs when the
 * effect DSL can't say what its card does. A handler runs as an effect on
 * the stack, so it may ask Decisions, and reads its hook's context from
 * `frame.hook`.
 */

/**
 * Steps a passive handler's frame, the top of the stack, like any effect
 * op: it pops the frame once done, and may ask a Decision first.
 */
export type PassiveHandler = (defs: CardIndex, state: GameState, frame: EffectFrame, events: GameEvent[]) => void;

/** The passive handlers the engine runs, by name. */
export const PASSIVE_HANDLERS: Readonly<Record<string, PassiveHandler>> = {};

/**
 * Handlers the local card data already names, each waiting on its own
 * issue. They load, so the cards naming them still play, but throw if they
 * ever run. Until then those cards keep them on a `modifyRollTotal` passive
 * with no value, which adds nothing.
 */
export const PENDING_PASSIVE_HANDLERS: Readonly<Record<string, string>> = {
  discardOnHeroSuccess: "#138",
  bonusWhenOthersModifyYourRoll: "#139",
  mayDrawOnHeroSuccess: "#140",
  challengerDiscards: "#141",
  stealInsteadOfDestroy: "#142",
  mayDrawOnAnyModifier: "#143",
  mayDrawWhenHeroDestroyed: "#144",
  mayPlayDrawnItem: "#145",
  mayPlayDrawnMagic: "#146",
  revealDrawnModifierToDraw: "#147",
  heroesCannotBeDestroyed: "#148",
  itemsCannotBeChallenged: "#149",
};

/** The passive handler named `name`. Throws for a pending handler, or one the engine doesn't know. */
export function passiveHandler(name: string): PassiveHandler {
  if (Object.hasOwn(PASSIVE_HANDLERS, name)) return PASSIVE_HANDLERS[name]!;
  if (Object.hasOwn(PENDING_PASSIVE_HANDLERS, name)) {
    throw new Error(`The passive handler "${name}" isn't built yet (${PENDING_PASSIVE_HANDLERS[name]})`);
  }
  throw new Error(`Unknown passive handler "${name}"`);
}

/**
 * Fails loudly, as the cards load, when a passive names a handler the
 * engine doesn't know: a CardLoadError naming each card and field.
 */
export function checkPassiveHandlers(defs: readonly CardDef[]): void {
  const problems: string[] = [];
  for (const def of defs) {
    const [field, passive] = passiveOf(def);
    const name = passive?.handler;
    if (name === undefined || Object.hasOwn(PASSIVE_HANDLERS, name) || Object.hasOwn(PENDING_PASSIVE_HANDLERS, name)) continue;
    problems.push(`card "${def.id}": field "${field}.handler": unknown passive handler "${name}"`);
  }
  if (problems.length > 0) throw new CardLoadError(problems);
}

function passiveOf(def: CardDef): [string, PassiveAbility | undefined] {
  if (def.type === "monster") return ["reward", def.reward];
  if ("passive" in def) return ["passive", def.passive];
  return ["passive", undefined];
}
