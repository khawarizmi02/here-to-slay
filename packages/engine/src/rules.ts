import type { CostedAction } from "@here-to-slay/cards";
import { clone } from "./clone.js";
import { actionCost } from "./passives.js";
import { pass, playChallenge, responseActions } from "./challenges.js";
import { playableHeroes, rollableHeroes, rollHeroEffect } from "./heroes.js";
import { playableItems, playableMagic, playCard } from "./plays.js";
import { attackableMonsters, attackMonster } from "./monsters.js";
import { leaderChosen } from "./setup.js";
import { runStack, stackAnswered } from "./stack.js";
import { canDraw, discardAndRedraw, drawCards, endTurn, handLimitDiscarded, settleTurn } from "./turns.js";
import { checkWin } from "./wins.js";
import type { DecisionResolver } from "./decisions.js";
import type { Action, ApplyResult, CardIndex, GameEvent, GameState, PendingDecision, PlayerId } from "./types.js";

const RESOLVERS: Record<PendingDecision["resume"], DecisionResolver> = {
  leaderDraft: leaderChosen,
  handLimitDiscard: handLimitDiscarded,
  stack: (defs, state, decision, choice, events) => {
    stackAnswered(defs, state, decision, choice, events);
    runStack(defs, state, events);
  },
};

type TurnAction = Extract<Action, { type: CostedAction | "END_TURN" }>;
type ResponseAction = Extract<Action, { type: "PASS" | "PLAY_CHALLENGE" }>;

/**
 * Every action `player` may take now: one RESOLVE_DECISION per option of
 * their pending Decision; in a Challenge Window that waits on them, PASS and
 * their Challenges; or, for the active player in the action phase with
 * nothing pending, the turn actions they can pay for.
 */
export function getLegalActions(defs: CardIndex, state: GameState, player: PlayerId): Action[] {
  const decision = state.pendingDecision;
  if (decision !== null) {
    if (decision.player !== player) return [];
    return decision.options.map((o) => ({ type: "RESOLVE_DECISION", player, decisionId: decision.id, answer: { selected: [o.id] } }));
  }
  const responses = responseActions(defs, state, player);
  if (responses !== undefined) return responses;
  if (state.phase.kind !== "action" || state.activePlayer !== player) return [];
  const actions: TurnAction[] = [];
  const affordable = (type: CostedAction) => actionCost(defs, state, player, type) <= state.actionPoints;
  if (affordable("DRAW_CARD") && canDraw(state)) actions.push({ type: "DRAW_CARD", player });
  if (affordable("PLAY_HERO")) for (const card of playableHeroes(defs, state, player)) actions.push({ type: "PLAY_HERO", player, card });
  if (affordable("PLAY_ITEM")) for (const { card, targetHero } of playableItems(defs, state, player)) actions.push({ type: "PLAY_ITEM", player, card, targetHero });
  if (affordable("PLAY_MAGIC")) for (const card of playableMagic(defs, state, player)) actions.push({ type: "PLAY_MAGIC", player, card });
  if (affordable("ROLL_HERO_EFFECT")) for (const hero of rollableHeroes(state, player)) actions.push({ type: "ROLL_HERO_EFFECT", player, hero });
  if (affordable("ATTACK_MONSTER")) for (const monster of attackableMonsters(defs, state, player)) actions.push({ type: "ATTACK_MONSTER", player, monster });
  if (affordable("DISCARD_AND_REDRAW")) actions.push({ type: "DISCARD_AND_REDRAW", player });
  actions.push({ type: "END_TURN", player });
  return actions;
}

/** Whether `player`'s pending Decision gives up one of their own cards (§6.4). */
export function isDiscardDecision(state: GameState, player: PlayerId): boolean {
  return state.pendingDecision?.player === player && state.pendingDecision.discard;
}

/** Applies `action`, or rejects it and leaves `state` unchanged (§6.1). */
export function applyAction(defs: CardIndex, state: GameState, action: Action): ApplyResult {
  const error = rejectionReason(defs, state, action);
  if (error !== undefined) return { ok: false, state, error, events: [] };

  const next = clone(state);
  const events: GameEvent[] = [];
  if (action.type === "RESOLVE_DECISION") {
    const decision = next.pendingDecision!;
    const [choice] = action.answer.selected;
    next.pendingDecision = null;
    RESOLVERS[decision.resume](defs, next, decision, choice, events);
  } else if (action.type === "PASS" || action.type === "PLAY_CHALLENGE") {
    response(defs, next, action, events);
  } else {
    turnAction(defs, next, action as TurnAction, events);
  }
  // Under "immediate" this catches changes made outside the stack; under "endOfAction" it is the only check, once nothing is left resolving.
  if (next.config.winCheckTiming === "immediate" || (next.stack.length === 0 && next.pendingDecision === null)) checkWin(defs, next, events);
  settleTurn(defs, next, events);
  return { ok: true, state: next, events };
}

/** A turn action: its AP is spent as it is declared (§3.5), then it resolves. */
function turnAction(defs: CardIndex, state: GameState, action: TurnAction, events: GameEvent[]): void {
  if (action.type !== "END_TURN") state.actionPoints -= actionCost(defs, state, action.player, action.type);
  switch (action.type) {
    case "DRAW_CARD":
      drawCards(state, action.player, 1, events);
      break;
    case "PLAY_HERO":
      playCard(defs, state, action.player, action.card, "PLAY_HERO", null, events);
      break;
    case "PLAY_ITEM":
      playCard(defs, state, action.player, action.card, "PLAY_ITEM", action.targetHero, events);
      break;
    case "PLAY_MAGIC":
      playCard(defs, state, action.player, action.card, "PLAY_MAGIC", null, events);
      break;
    case "ROLL_HERO_EFFECT":
      rollHeroEffect(defs, state, action.player, action.hero, events);
      break;
    case "ATTACK_MONSTER":
      attackMonster(defs, state, action.player, action.monster, events);
      break;
    case "DISCARD_AND_REDRAW":
      discardAndRedraw(state, action.player, events);
      break;
    case "END_TURN":
      endTurn(defs, state, events);
      break;
  }
}

/** A response in a Challenge Window: it costs no AP (§3.7). */
function response(defs: CardIndex, state: GameState, action: ResponseAction, events: GameEvent[]): void {
  if (action.type === "PASS") pass(state, action.player);
  else playChallenge(defs, state, action.player, action.card, events);
  runStack(defs, state, events);
}

function rejectionReason(defs: CardIndex, state: GameState, action: Action): string | undefined {
  if (state.phase.kind === "gameOver") return "The game is over";
  if (!state.players.some((p) => p.id === action.player)) return `Unknown player ${action.player}`;
  if (action.type === "RESOLVE_DECISION") {
    const decision = state.pendingDecision;
    if (decision?.player !== action.player) return `${action.player} has no Decision to make`;
    if (decision.id !== action.decisionId) return `Decision ${action.decisionId} is not the one pending`;
    const [choice] = action.answer.selected;
    if (!decision.options.some((o) => o.id === choice)) return `${choice} is not an option`;
    return undefined;
  }
  // A turn action or a response is legal exactly when it is listed, card and all.
  const key = actionKey(action);
  if (getLegalActions(defs, state, action.player).some((a) => actionKey(a) === key)) return undefined;
  return `${action.type} is not a legal action right now`;
}

/** An action as JSON with its keys sorted, so key order doesn't matter when comparing. */
function actionKey(action: Action): string {
  return JSON.stringify(Object.entries(action).sort(([a], [b]) => (a < b ? -1 : 1)));
}
