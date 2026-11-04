import type { Effect, PlayerFilter, PlayerRef } from "@here-to-slay/cards";
import { decisionOptions, openDecision, type DecisionResolver } from "./decisions.js";
import { heroDef, startHeroRoll } from "./heroes.js";
import { rollBonus } from "./passives.js";
import { fromPlayer, playerState } from "./players.js";
import { nextInt, rollD6 } from "./rng.js";
import { heroClass } from "./selectors.js";
import { discardFromHand, drawCards } from "./turns.js";
import { checkWin } from "./wins.js";
import {
  ACCEPT,
  DECLINE,
  type CardIndex,
  type CardInstanceId,
  type EffectFrame,
  type FreeRollFrame,
  type GameEvent,
  type GameState,
  type PendingDecision,
  type PlayerId,
  type RollFrame,
} from "./types.js";

/**
 * The resumable effect interpreter (TECHNICAL_DESIGN.md §6.5 Option A).
 * Steps the frame on top of the stack until the stack is empty, a Decision
 * is pending or the game is over. Each step is atomic: under
 * `winCheckTiming: "immediate"` the game can end after any of them.
 * While anything is on the stack the phase is "resolving".
 */
export function runStack(defs: CardIndex, state: GameState, events: GameEvent[]): void {
  // Whatever pushed onto the stack may itself have changed the state, as a hero entering a party does.
  if (state.config.winCheckTiming === "immediate") checkWin(defs, state, events);
  while (state.stack.length > 0 && state.pendingDecision === null && state.phase.kind !== "gameOver") {
    if (state.phase.kind === "action") state.phase = { kind: "resolving" };
    step(defs, state, events);
    if (state.config.winCheckTiming === "immediate") checkWin(defs, state, events);
  }
  if (state.stack.length === 0 && state.phase.kind === "resolving") state.phase = { kind: "action" };
}

/** Hands a Decision's answer to the frame that asked it; `runStack` carries on from there. */
export const stackAnswered: DecisionResolver = (_defs, state, _decision, choice) => {
  const frame = state.stack.at(-1);
  if (frame === undefined || frame.kind === "roll" || frame.awaiting === null) throw new Error("No frame is waiting on a Decision");
  frame.bindings[frame.awaiting] = choice;
  frame.awaiting = null;
};

function step(defs: CardIndex, state: GameState, events: GameEvent[]): void {
  const frame = state.stack.at(-1)!;
  switch (frame.kind) {
    case "freeRoll":
      return freeRoll(defs, state, frame, events);
    case "roll":
      return roll(defs, state, frame, events);
    case "effect":
      return effectStep(defs, state, frame, events);
  }
}

/**
 * Asks `spec.player` one pick for `frame`, stored as `frame.bindings[key]`.
 * A Decision with one option or none resolves straight away (§6.4), so the
 * caller returns either way and is stepped again.
 */
function ask(
  defs: CardIndex,
  state: GameState,
  frame: EffectFrame | FreeRollFrame,
  key: string,
  spec: Omit<PendingDecision, "id" | "resume">,
  events: GameEvent[],
): void {
  frame.awaiting = key;
  openDecision(defs, state, { ...spec, resume: "stack" }, events, stackAnswered);
}

/** The options of a "you may" Decision: Decline always comes first (§6.4). */
const YOU_MAY = [
  { id: DECLINE, label: "Decline" },
  { id: ACCEPT, label: "Accept" },
];

function freeRoll(defs: CardIndex, state: GameState, frame: FreeRollFrame, events: GameEvent[]): void {
  if (!("roll" in frame.bindings)) {
    const name = heroDef(defs, state, frame.hero)!.name;
    ask(defs, state, frame, "roll", { player: frame.player, kind: "confirmOptional", prompt: `Roll for ${name}'s effect?`, options: YOU_MAY, discard: false }, events);
    return;
  }
  state.stack.pop();
  const stillThere = playerState(state, frame.player).party.some((h) => h.instanceId === frame.hero && !h.rolledThisTurn);
  if (frame.bindings.roll === ACCEPT && stillThere) startHeroRoll(state, frame.player, frame.hero);
}

/** Rolls 2d6 and adds passive bonuses; on a success the hero's effect goes on the stack. */
function roll(defs: CardIndex, state: GameState, frame: RollFrame, events: GameEvent[]): void {
  state.stack.pop();
  let a: number;
  let b: number;
  [a, state.rng] = rollD6(state.rng);
  [b, state.rng] = rollD6(state.rng);
  const def = heroDef(defs, state, frame.hero)!;
  const bonus = rollBonus(defs, state, frame.roller, { rollKind: frame.rollKind, heroClass: heroClass(defs, state, frame.hero) });
  const total = a + b + bonus;
  const succeeded = total >= def.rollRequirement;
  events.push({
    type: "DICE_ROLLED",
    roll: frame.rollId,
    player: frame.roller,
    rollKind: frame.rollKind,
    hero: { id: frame.hero, def: def.id },
    dice: [a, b],
    bonus,
    total,
    succeeded,
  });
  if (succeeded) state.stack.push(effectFrame(def.effect, frame.roller, frame.roller, frame.hero));
}

export function effectFrame(effect: Effect, controller: PlayerId, self: PlayerId, source: CardInstanceId): EffectFrame {
  return { kind: "effect", effect, pc: 0, controller, self, players: null, bindings: {}, awaiting: null, source };
}

/** Replaces `frame` on top of the stack with `effect`, run with the same controller and `self`. */
function become(state: GameState, frame: EffectFrame, effect: Effect): void {
  state.stack.pop();
  state.stack.push(effectFrame(effect, frame.controller, frame.self, frame.source));
}

function effectStep(defs: CardIndex, state: GameState, frame: EffectFrame, events: GameEvent[]): void {
  const effect = frame.effect;
  switch (effect.op) {
    case "sequence": {
      const next = effect.steps[frame.pc++];
      if (next === undefined) state.stack.pop();
      else state.stack.push(effectFrame(next, frame.controller, frame.self, frame.source));
      return;
    }
    case "choice": {
      const chooser = playerRef(defs, state, frame, "chooser", effect.chooser, "Choose who decides", events);
      if (chooser === undefined) return;
      if (chooser === null) {
        state.stack.pop();
        return;
      }
      if (!("option" in frame.bindings)) {
        const options = effect.options.map((o, i) => ({ id: String(i), label: o.label }));
        ask(defs, state, frame, "option", { player: chooser, kind: "chooseOption", prompt: `${sourceName(defs, state, frame)}: choose one`, options, discard: false }, events);
        return;
      }
      const chosen = effect.options[Number(frame.bindings.option)];
      if (chosen === undefined) state.stack.pop();
      else become(state, frame, chosen.effect);
      return;
    }
    case "optional": {
      const chooser = playerRef(defs, state, frame, "chooser", effect.chooser, "Choose who decides", events);
      if (chooser === undefined) return;
      if (chooser === null) {
        state.stack.pop();
        return;
      }
      if (!("accept" in frame.bindings)) {
        const prompt = `${sourceName(defs, state, frame)}: you may do this`;
        ask(defs, state, frame, "accept", { player: chooser, kind: "confirmOptional", prompt, options: YOU_MAY, discard: false }, events);
        return;
      }
      if (frame.bindings.accept === ACCEPT) become(state, frame, effect.effect);
      else state.stack.pop();
      return;
    }
    case "forEach": {
      // Each player in turn order after the controller (§6.4), with `self` bound to them in turn.
      const [me, ...after] = fromPlayer(state, frame.self);
      frame.players ??= [...after, me!].filter((id) => matchesFilter(state, frame.self, id, effect.players));
      const next = frame.players[frame.pc++];
      if (next === undefined) state.stack.pop();
      else state.stack.push(effectFrame(effect.effect, frame.controller, next, frame.source));
      return;
    }
    case "draw": {
      const who = playerRef(defs, state, frame, "who", effect.who, `Choose a player to draw ${cards(effect.amount)}`, events);
      if (who === undefined) return;
      state.stack.pop();
      if (who !== null) drawCards(state, who, effect.amount, events);
      return;
    }
    case "discard":
      return discardStep(defs, state, frame, effect, events);
    default:
      // Steal, destroy, sacrifice and pull arrive in #43; the other ops with the cards that need them.
      state.stack.pop();
      return;
  }
}

/**
 * `who` discards `amount` cards, or their whole hand if it has fewer: one
 * Decision per card, "Choose a card to discard (1 of 2)". A chooser can only
 * pick cards they can see, so when someone else chooses, each card is taken
 * at random from the hand instead.
 */
function discardStep(defs: CardIndex, state: GameState, frame: EffectFrame, effect: Extract<Effect, { op: "discard" }>, events: GameEvent[]): void {
  const who = playerRef(defs, state, frame, "who", effect.who, `Choose a player to discard ${cards(effect.amount)}`, events);
  if (who === undefined) return;
  const hand = who === null ? [] : playerState(state, who).hand;
  const left = Math.min(effect.amount - frame.pc, hand.length);
  if (who === null || left <= 0) {
    state.stack.pop();
    return;
  }
  const chooser = playerRef(defs, state, frame, "chosenBy", effect.chosenBy, "Choose who picks the discards", events);
  if (chooser === undefined) return;
  if (chooser === null) {
    state.stack.pop();
    return;
  }
  let card: string;
  if (chooser === who) {
    const key = `card${frame.pc}`;
    if (!(key in frame.bindings)) {
      const prompt = `Choose a card to discard (${frame.pc + 1} of ${frame.pc + left})`;
      ask(defs, state, frame, key, { player: who, kind: "chooseCardFromHand", prompt, options: decisionOptions(state, { cards: hand }), discard: true }, events);
      return;
    }
    card = frame.bindings[key]!;
  } else {
    let i: number;
    [i, state.rng] = nextInt(hand.length, state.rng);
    card = hand[i]!;
  }
  discardFromHand(state, who, card, events);
  frame.pc++;
}

/**
 * The player `ref` names: `self`, the active player, or one `frame.self`
 * picks, asked as a Decision stored under `key`. Undefined while that
 * Decision is being asked; null when nobody fits the filter, so the op does nothing.
 */
function playerRef(
  defs: CardIndex,
  state: GameState,
  frame: EffectFrame,
  key: string,
  ref: PlayerRef,
  prompt: string,
  events: GameEvent[],
): PlayerId | null | undefined {
  if (ref === "self") return frame.self;
  if (ref === "activePlayer") return state.activePlayer;
  if (key in frame.bindings) return frame.bindings[key];
  const players = state.turnOrder.filter((id) => matchesFilter(state, frame.self, id, ref.choose));
  ask(defs, state, frame, key, { player: frame.self, kind: "choosePlayer", prompt, options: decisionOptions(state, { players }), discard: false }, events);
  return undefined;
}

/** Whether `id` passes `filter`, seen from `me` (§5.2): the "other…" filters leave `me` out. */
function matchesFilter(state: GameState, me: PlayerId, id: PlayerId, filter: PlayerFilter): boolean {
  const p = playerState(state, id);
  switch (filter) {
    case "any":
      return true;
    case "self":
      return id === me;
    case "other":
      return id !== me;
    case "withHeroes":
      return p.party.length > 0;
    case "withCards":
      return p.hand.length > 0;
    case "otherWithHeroes":
      return id !== me && p.party.length > 0;
    case "otherWithCards":
      return id !== me && p.hand.length > 0;
  }
}

function sourceName(defs: CardIndex, state: GameState, frame: EffectFrame): string {
  return defs.get(state.cards[frame.source]!)?.name ?? "Effect";
}

function cards(n: number): string {
  return n === 1 ? "1 card" : `${n} cards`;
}
