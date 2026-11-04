import type { CostedAction } from "@here-to-slay/cards";
import { clone } from "./clone.js";
import { actionCost } from "./passives.js";
import { leaderChosen } from "./setup.js";
import { canDraw, discardAndRedraw, drawCards, endTurn, handLimitDiscarded, settleTurn } from "./turns.js";
import type { DecisionResolver } from "./decisions.js";
import type { Action, ApplyResult, CardIndex, GameEvent, GameState, PendingDecision, PlayerId } from "./types.js";

const RESOLVERS: Record<PendingDecision["resume"], DecisionResolver> = {
  leaderDraft: leaderChosen,
  handLimitDiscard: handLimitDiscarded,
};

type TurnAction = Extract<Action, { type: CostedAction | "END_TURN" }>;

/**
 * Every action `player` may take now: one RESOLVE_DECISION per option of
 * their pending Decision, or, for the active player in the action phase
 * with nothing pending, the turn actions they can pay for.
 */
export function getLegalActions(defs: CardIndex, state: GameState, player: PlayerId): Action[] {
  const decision = state.pendingDecision;
  if (decision !== null) {
    if (decision.player !== player) return [];
    return decision.options.map((o) => ({ type: "RESOLVE_DECISION", player, decisionId: decision.id, answer: { selected: [o.id] } }));
  }
  if (state.phase.kind !== "action" || state.activePlayer !== player) return [];
  const actions: TurnAction[] = [];
  const affordable = (type: CostedAction) => actionCost(defs, state, player, type) <= state.actionPoints;
  if (affordable("DRAW_CARD") && canDraw(state)) actions.push({ type: "DRAW_CARD", player });
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
  } else {
    turnAction(defs, next, action as TurnAction, events);
  }
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
    case "DISCARD_AND_REDRAW":
      discardAndRedraw(state, action.player, events);
      break;
    case "END_TURN":
      endTurn(defs, state, events);
      break;
  }
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
  // Turn actions carry no card or target yet, so legal means listed.
  if (getLegalActions(defs, state, action.player).some((a) => a.type === action.type)) return undefined;
  return `${action.type} is not a legal action right now`;
}
