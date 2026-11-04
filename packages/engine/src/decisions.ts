import type { DecisionOption, GameEvent, GameState, PendingDecision, PlayerId } from "./types.js";

/** Carries on from a Decision with the chosen option's id, or null when the Decision was skipped for having no option. */
export type DecisionResolver = (state: GameState, decision: PendingDecision, choice: string | null, events: GameEvent[]) => void;

/**
 * The options for a Decision over `players` and `cards`, in the order the
 * Room relies on (§6.4): players in turn order, then cards by instance id.
 * Before turn order exists, players are listed in Seat order.
 */
export function decisionOptions(state: GameState, opts: { players?: readonly PlayerId[]; cards?: readonly string[] }): DecisionOption[] {
  const order = state.turnOrder.length > 0 ? state.turnOrder : state.players.map((p) => p.id);
  const players = order.filter((id) => opts.players?.includes(id)).map((id) => ({ id }));
  const cards = [...(opts.cards ?? [])].sort().map((id) => ({ id, def: state.cards[id]! }));
  return [...players, ...cards];
}

/**
 * Asks `decision.player` for one pick. A Decision with no option is skipped
 * and one with exactly one option resolves on its own; either way `resolve`
 * runs straight away. Otherwise the game waits for a RESOLVE_DECISION.
 */
export function openDecision(
  state: GameState,
  spec: Omit<PendingDecision, "id">,
  events: GameEvent[],
  resolve: DecisionResolver,
): void {
  const decision: PendingDecision = { id: `d${state.nextDecisionId++}`, ...spec };
  if (decision.options.length > 1) {
    state.pendingDecision = decision;
    return;
  }
  resolve(state, decision, decision.options[0]?.id ?? null, events);
}
