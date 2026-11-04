import { clone } from "./clone.js";
import { leaderChosen } from "./setup.js";
import type { Action, ApplyResult, GameEvent, GameState, PlayerId } from "./types.js";

/**
 * Every action `player` may take now. Only Decisions exist so far: one
 * RESOLVE_DECISION per option of the player's pending Decision. The turn
 * loop adds the first turn actions.
 */
export function getLegalActions(state: GameState, player: PlayerId): Action[] {
  const decision = state.pendingDecision;
  if (decision?.player !== player) return [];
  return decision.options.map((o) => ({ type: "RESOLVE_DECISION", player, decisionId: decision.id, answer: { selected: [o.id] } }));
}

/** Whether `player`'s pending Decision gives up one of their own cards (§6.4). */
export function isDiscardDecision(state: GameState, player: PlayerId): boolean {
  return state.pendingDecision?.player === player && state.pendingDecision.discard;
}

/** Applies `action`, or rejects it and leaves `state` unchanged (§6.1). */
export function applyAction(state: GameState, action: Action): ApplyResult {
  const error = rejectionReason(state, action);
  if (error !== undefined) return { ok: false, state, error, events: [] };

  const next = clone(state);
  const events: GameEvent[] = [];
  // rejectionReason lets through only a RESOLVE_DECISION for the pending Decision.
  const decision = next.pendingDecision!;
  const [choice] = (action as Extract<Action, { type: "RESOLVE_DECISION" }>).answer.selected;
  next.pendingDecision = null;
  switch (decision.kind) {
    case "chooseLeader":
      leaderChosen(next, decision, choice, events);
      break;
  }
  return { ok: true, state: next, events };
}

function rejectionReason(state: GameState, action: Action): string | undefined {
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
  return `${action.type} is not a legal action right now`;
}
