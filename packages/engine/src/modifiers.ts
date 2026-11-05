import { fromPlayer, playerState } from "./players.js";
import type { Action, CardIndex, CardInstanceId, GameEvent, GameState, ModifierWindowFrame, PlayerId, WindowRoll } from "./types.js";

/*
 * Modifier Windows (TECHNICAL_DESIGN.md §3.6, §7.3). One opens after every
 * hero roll and monster attack, and once on both rolls of a Challenge. It is
 * open to every player, the roller included, and any Modifier reopens it to
 * everyone. When it closes, the frame below it gets the final totals.
 */

/** Opens a Modifier Window on `rolls`, each at its total so far. */
export function pushModifierWindow(state: GameState, rolls: Omit<WindowRoll, "modifiers">[]): void {
  state.stack.push({ kind: "modifierWindow", rolls: rolls.map((r) => ({ ...r, modifiers: [] })), passed: [] });
}

/** Who a Modifier Window still waits on: every player, in turn order from the first roller, who hasn't passed since the last Modifier. */
export function awaitingModifiers(state: GameState, frame: ModifierWindowFrame): PlayerId[] {
  return fromPlayer(state, frame.rolls[0]!.player).filter((id) => !frame.passed.includes(id));
}

/** One PLAY_MODIFIER per Modifier card in `player`'s hand (by instance id), per roll in the window, per option of the card. */
export function modifierActions(defs: CardIndex, state: GameState, frame: ModifierWindowFrame, player: PlayerId): Action[] {
  return [...playerState(state, player).hand].sort().flatMap((card) => {
    const def = defs.get(state.cards[card]!);
    if (def?.type !== "modifier") return [];
    return frame.rolls.flatMap((r) => def.options.map((value) => ({ type: "PLAY_MODIFIER" as const, player, card, value, roll: r.roll })));
  });
}

/** A PLAY_MODIFIER that leaves out its roll names the only roll in the open window, if it holds just one. */
export function withRoll(state: GameState, action: Action): Action {
  if (action.type !== "PLAY_MODIFIER" || action.roll !== undefined) return action;
  const top = state.stack.at(-1);
  if (top?.kind !== "modifierWindow" || top.rolls.length !== 1) return action;
  return { ...action, roll: top.rolls[0]!.roll };
}

/**
 * PLAY_MODIFIER (§3.6): costs no AP. The card goes to the discard pile, its
 * chosen value is added to the roll, and the window reopens to everyone.
 */
export function playModifier(state: GameState, player: PlayerId, card: CardInstanceId, value: number, rollId: string, events: GameEvent[]): void {
  const frame = state.stack.at(-1) as ModifierWindowFrame;
  const roll = frame.rolls.find((r) => r.roll === rollId)!;
  const p = playerState(state, player);
  p.hand = p.hand.filter((c) => c !== card);
  state.discardPile.push(card);
  roll.modifiers.push({ player, card, value });
  roll.total += value;
  frame.passed = [];
  events.push({ type: "MODIFIER_PLAYED", player, card: { id: card, def: state.cards[card]! }, roll: rollId, value, total: roll.total });
}

/** Closes a window everyone has passed: it pops, and the roll or Challenge duel below it takes the final totals. */
export function closeModifierWindow(state: GameState): void {
  const frame = state.stack.pop() as ModifierWindowFrame;
  const below = state.stack.at(-1);
  const total = (id: string | null) => frame.rolls.find((r) => r.roll === id)!.total;
  if (below?.kind === "roll") below.total = total(below.rollId);
  else if (below?.kind === "challengeDuel") {
    below.challengerTotal = total(below.challengerRoll);
    below.defenderTotal = total(below.defenderRoll);
  } else throw new Error("A Modifier Window with no roll or duel under it");
}
