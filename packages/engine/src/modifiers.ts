import { fromPlayer, playerState } from "./players.js";
import { pushTriggers } from "./stack.js";
import type { RuleConfig } from "./config.js";
import type { Action, CardIndex, CardInstanceId, GameEvent, GameState, ModifierWindowFrame, PlayerId, WindowRoll } from "./types.js";

/*
 * Modifier Windows (TECHNICAL_DESIGN.md §3.6, §7.3). One opens after every
 * hero roll and monster attack, and once on both rolls of a Challenge. It is
 * open to every player, the roller included, and any Modifier reopens it to
 * everyone. When it closes, the frame below it gets the final totals.
 */

/** A roll as a Modifier Window opens on it, before any Modifier: WindowRoll without `modifiers`, kept a union (a plain Omit would merge its variants). */
type NewWindowRoll = WindowRoll extends infer R ? (R extends unknown ? Omit<R, "modifiers"> : never) : never;

/** Opens a Modifier Window on `rolls`, each at its total so far. */
export function pushModifierWindow(state: GameState, rolls: NewWindowRoll[]): void {
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
 * Every player's onModifierPlayed passives run, in turn order from `player`,
 * while the window waits below them.
 */
export function playModifier(defs: CardIndex, state: GameState, player: PlayerId, card: CardInstanceId, value: number, rollId: string, events: GameEvent[]): void {
  const frame = state.stack.at(-1) as ModifierWindowFrame;
  const roll = frame.rolls.find((r) => r.roll === rollId)!;
  const p = playerState(state, player);
  p.hand = p.hand.filter((c) => c !== card);
  state.discardPile.push(card);
  roll.modifiers.push({ player, card, value });
  roll.total += value;
  frame.passed = [];
  events.push({ type: "MODIFIER_PLAYED", player, card: { id: card, def: state.cards[card]! }, roll: rollId, value, total: roll.total });
  const ctx = { card, by: player, roll: rollId, roller: roll.player };
  for (const id of fromPlayer(state, player).reverse()) pushTriggers(defs, state, id, "onModifierPlayed", ctx);
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

/** What a roll in a Modifier Window leads to at its total: a hero's effect, a monster attack, or the Challenge it is one side of. */
export type RollOutcome = "succeeds" | "fails" | "slain" | "nothing" | "defeated" | "challengeSucceeds" | "challengeFails";

/**
 * What each roll in a Modifier Window leads to at its current total (§3.5,
 * §3.7): a hero roll succeeds at or above what it needs; a monster attack
 * slays at or above the slay value, is defeated at or below the defeat value,
 * and does nothing between; both rolls of a Challenge say whether it succeeds,
 * a tie going to `challengeTieWinner`. In the order of `rolls`.
 */
export function rollOutcomes(rolls: readonly WindowRoll[], config: Pick<RuleConfig, "challengeTieWinner">): RollOutcome[] {
  return rolls.map((r) => {
    if (r.rollKind === "heroEffect") return r.total >= r.needs ? "succeeds" : "fails";
    if (r.rollKind === "monsterAttack") return attackOutcome(r.total, r.needs, r.defeatAt);
    const side = (s: "challenger" | "defender") => rolls.find((o) => o.rollKind === "challenge" && o.side === s);
    const challenger = side("challenger");
    const defender = side("defender");
    if (challenger === undefined || defender === undefined) throw new Error("A Challenge roll without the other side's");
    return challengeSucceeds(config, challenger.total, defender.total) ? "challengeSucceeds" : "challengeFails";
  });
}

/** The rolls as they would be after a Modifier of `value` on the roll `rollId` (§3.6): its value is added to that roll's total. */
export function withModifier(rolls: readonly WindowRoll[], rollId: string, value: number): WindowRoll[] {
  return rolls.map((r) => (r.roll === rollId ? { ...r, total: r.total + value } : r));
}

/** A monster attack at `total` against these values (§3.5). */
export function attackOutcome(total: number, slayAt: number, defeatAt: number): "slain" | "nothing" | "defeated" {
  if (total >= slayAt) return "slain";
  if (total <= defeatAt) return "defeated";
  return "nothing";
}

/** Whether a Challenge succeeds at these totals: the challenger wins outright, or ties when `challengeTieWinner` gives ties to them (§3.7). */
export function challengeSucceeds(config: Pick<RuleConfig, "challengeTieWinner">, challengerTotal: number, defenderTotal: number): boolean {
  return config.challengeTieWinner === "challenger" ? challengerTotal >= defenderTotal : challengerTotal > defenderTotal;
}
