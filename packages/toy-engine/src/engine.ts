import { createRng, shuffle } from "./rng.js";
import {
  DEFAULT_TOY_CONFIG,
  TOY_CARD_DEFS,
  type Action,
  type ApplyResult,
  type CreateGameOptions,
  type GameEvent,
  type GameState,
  type PlayerId,
  type PlayerView,
  type ToyCard,
  type ToyCardDefId,
  type ToyPlayer,
} from "./types.js";

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const POINTS: Partial<Record<ToyCardDefId, number>> = { point_1: 1, point_2: 2, point_3: 3 };

const WISH_OPTIONS = [
  { id: "gain2", label: "Gain 2 points" },
  { id: "draw2", label: "Draw 2 cards" },
];

// ---------------------------------------------------------------------------
// createGame
// ---------------------------------------------------------------------------

export function createGame(opts: CreateGameOptions): GameState {
  const { players, seed } = opts;
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`The toy engine needs ${MIN_PLAYERS}–${MAX_PLAYERS} players, got ${players.length}`);
  }
  if (new Set(players.map((p) => p.id)).size !== players.length) {
    throw new Error("Player ids must be unique");
  }
  const config = { ...DEFAULT_TOY_CONFIG, ...opts.config };

  let rng = createRng(seed);
  let deck: ToyCard[];
  if (opts.deckOrder) {
    deck = instantiate(opts.deckOrder);
  } else {
    const copies = players.length + 2;
    const defs = TOY_CARD_DEFS.flatMap((def) => Array<ToyCardDefId>(copies).fill(def));
    [deck, rng] = shuffle(instantiate(defs), rng);
  }

  const toyPlayers: ToyPlayer[] = players.map((p) => ({ ...p, hand: [], score: 0 }));
  for (const p of toyPlayers) {
    p.hand = deck.splice(0, config.handSize);
  }

  const first = toyPlayers[0] as ToyPlayer;
  return {
    rng,
    config,
    players: toyPlayers,
    deck,
    discard: [],
    activePlayer: first.id,
    turn: 1,
    phase: "action",
    responseWindow: null,
    pendingDecision: null,
    nextDecisionId: 1,
    winner: null,
  };
}

function instantiate(defs: readonly ToyCardDefId[]): ToyCard[] {
  const counters = new Map<ToyCardDefId, number>();
  return defs.map((def) => {
    if (!TOY_CARD_DEFS.includes(def)) throw new Error(`Unknown toy card: ${String(def)}`);
    const n = counters.get(def) ?? 0;
    counters.set(def, n + 1);
    return { id: `${def}#${n}`, def };
  });
}

// ---------------------------------------------------------------------------
// getLegalActions
// ---------------------------------------------------------------------------

export function getLegalActions(state: GameState, playerId: PlayerId): Action[] {
  const player = findPlayer(state, playerId);
  if (!player) return [];

  switch (state.phase) {
    case "gameOver":
      return [];

    case "action": {
      if (state.activePlayer !== playerId) return [];
      const actions: Action[] = [];
      if (state.deck.length > 0) actions.push({ type: "DRAW_CARD", player: playerId });
      for (const card of player.hand) {
        if (card.def !== "challenge") actions.push({ type: "PLAY_HERO", player: playerId, card: card.id });
      }
      return actions;
    }

    case "responseWindow": {
      const window = state.responseWindow;
      if (!window?.awaiting.includes(playerId)) return [];
      const actions: Action[] = [{ type: "PASS", player: playerId }];
      for (const card of player.hand) {
        if (card.def === "challenge") actions.push({ type: "PLAY_CHALLENGE", player: playerId, card: card.id });
      }
      return actions;
    }

    case "decision": {
      const decision = state.pendingDecision;
      if (decision?.player !== playerId) return [];
      return decision.options.map((o) => ({
        type: "RESOLVE_DECISION" as const,
        player: playerId,
        decisionId: decision.id,
        answer: { selected: [o.id] },
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------

export function applyAction(state: GameState, action: Action): ApplyResult {
  const legal = getLegalActions(state, action.player);
  if (!legal.some((a) => sameAction(a, action))) {
    return { ok: false, state, error: rejectionReason(state, action, legal), events: [] };
  }

  const next = clone(state);
  const events: GameEvent[] = [];
  const player = findPlayer(next, action.player) as ToyPlayer;

  switch (action.type) {
    case "DRAW_CARD": {
      const card = next.deck.shift() as ToyCard;
      player.hand.push(card);
      events.push({ type: "CARD_DRAWN", player: player.id, card });
      endTurn(next, events);
      break;
    }

    case "PLAY_HERO": {
      const card = takeFromHand(player, action.card);
      events.push({ type: "CARD_PLAYED", player: player.id, card });
      const awaiting = playersAfter(next, player.id).map((p) => p.id);
      next.responseWindow = { player: player.id, card, awaiting };
      next.phase = "responseWindow";
      events.push({ type: "RESPONSE_WINDOW_OPENED", player: player.id, card, awaiting: [...awaiting] });
      break;
    }

    case "PASS": {
      const window = next.responseWindow!;
      window.awaiting = window.awaiting.filter((id: PlayerId) => id !== player.id);
      events.push({ type: "PASSED", player: player.id });
      if (window.awaiting.length === 0) resolveCard(next, events);
      break;
    }

    case "PLAY_CHALLENGE": {
      const window = next.responseWindow!;
      const challenge = takeFromHand(player, action.card);
      events.push({ type: "CHALLENGED", player: player.id, card: challenge, target: window.card });
      next.discard.push(window.card, challenge);
      next.responseWindow = null;
      endTurn(next, events);
      break;
    }

    case "RESOLVE_DECISION": {
      const decision = next.pendingDecision!;
      const [choice] = action.answer.selected;
      events.push({ type: "DECISION_RESOLVED", player: player.id, decisionId: decision.id, selected: [...action.answer.selected] });
      next.pendingDecision = null;
      if (choice === "gain2") {
        score(next, player, 2, events);
      } else {
        for (let i = 0; i < 2 && next.deck.length > 0; i++) {
          const card = next.deck.shift() as ToyCard;
          player.hand.push(card);
          events.push({ type: "CARD_DRAWN", player: player.id, card });
        }
      }
      endTurn(next, events);
      break;
    }

    default:
      // getLegalActions never produces other action types.
      throw new Error(`Unhandled toy action ${action.type}`);
  }

  return { ok: true, state: next, events };
}

/** All responders passed: the played card takes effect. */
function resolveCard(state: GameState, events: GameEvent[]): void {
  const window = state.responseWindow!;
  state.responseWindow = null;
  const owner = findPlayer(state, window.player) as ToyPlayer;
  state.discard.push(window.card);

  const points = POINTS[window.card.def];
  if (points !== undefined) {
    score(state, owner, points, events);
    endTurn(state, events);
    return;
  }

  // wish
  const id = `d${state.nextDecisionId++}`;
  state.pendingDecision = {
    id,
    player: owner.id,
    kind: "chooseOption",
    prompt: "Make a wish",
    options: WISH_OPTIONS.map((o) => ({ ...o })),
    min: 1,
    max: 1,
  };
  state.phase = "decision";
  events.push({ type: "DECISION_OPENED", player: owner.id, decisionId: id });
}

function score(state: GameState, player: ToyPlayer, points: number, events: GameEvent[]): void {
  player.score += points;
  events.push({ type: "POINTS_SCORED", player: player.id, points, total: player.score });
}

function endTurn(state: GameState, events: GameEvent[]): void {
  const reached = state.players.find((p) => p.score >= state.config.targetScore);
  if (reached) return gameOver(state, reached.id, events);
  if (state.deck.length === 0) {
    // Highest score wins; ties go to the earliest Seat.
    const best = state.players.reduce((a, b) => (b.score > a.score ? b : a));
    return gameOver(state, best.id, events);
  }
  const nextPlayer = playersAfter(state, state.activePlayer)[0] as ToyPlayer;
  state.activePlayer = nextPlayer.id;
  state.turn += 1;
  state.phase = "action";
  events.push({ type: "TURN_STARTED", player: nextPlayer.id, turn: state.turn });
}

function gameOver(state: GameState, winner: PlayerId, events: GameEvent[]): void {
  state.phase = "gameOver";
  state.winner = winner;
  events.push({ type: "GAME_OVER", winner });
}

// ---------------------------------------------------------------------------
// Views and event filtering (hidden information, TECHNICAL_DESIGN.md §9)
// ---------------------------------------------------------------------------

export function getPlayerView(state: GameState, playerId: PlayerId | "spectator"): PlayerView {
  const me = playerId === "spectator" ? undefined : findPlayer(state, playerId);
  const decision = state.pendingDecision;
  return clone({
    me: playerId,
    turn: state.turn,
    phase: state.phase,
    activePlayer: state.activePlayer,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      score: p.score,
      handCount: p.hand.length,
    })),
    hand: me ? me.hand : [],
    deckCount: state.deck.length,
    discard: state.discard,
    responseWindow: state.responseWindow,
    pendingDecision: decision === null ? null : decision.player === playerId ? decision : { player: decision.player },
    winner: state.winner,
  });
}

/** Filters events for one player: other players' draws don't reveal the card. */
export function getPlayerEvents(events: readonly GameEvent[], playerId: PlayerId | "spectator"): GameEvent[] {
  return events.map((e) => {
    if (e.type === "CARD_DRAWN" && e.player !== playerId) return { type: "CARD_DRAWN", player: e.player };
    return clone(e);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPlayer(state: GameState, id: PlayerId): ToyPlayer | undefined {
  return state.players.find((p) => p.id === id);
}

/** Every other player, in turn order starting after `id`. */
function playersAfter(state: GameState, id: PlayerId): ToyPlayer[] {
  const i = state.players.findIndex((p) => p.id === id);
  return [...state.players.slice(i + 1), ...state.players.slice(0, i)];
}

function takeFromHand(player: ToyPlayer, cardId: string): ToyCard {
  const i = player.hand.findIndex((c) => c.id === cardId);
  return player.hand.splice(i, 1)[0] as ToyCard;
}

function sameAction(a: Action, b: Action): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rejectionReason(state: GameState, action: Action, legal: Action[]): string {
  if (state.phase === "gameOver") return "The game is over";
  if (!findPlayer(state, action.player)) return `Unknown player ${action.player}`;
  if (legal.length === 0) {
    switch (state.phase) {
      case "action":
        return "It is not your turn";
      case "responseWindow":
        return "You are not being asked to respond";
      case "decision":
        return "It is not your decision";
    }
  }
  return `${action.type} is not a legal action right now`;
}

/** Game state, views and events are plain JSON, so a JSON round-trip is a faithful deep copy. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
