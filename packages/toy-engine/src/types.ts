import type { Action, CardInstanceId, PlayerId } from "@here-to-slay/protocol";
import type { RngState } from "./rng.js";

export type { Action, CardInstanceId, PlayerId };

/**
 * Toy card definitions.
 * - `point_N`: play it; if nobody challenges it, score N points.
 * - `wish`: play it; if nobody challenges it, choose to gain 2 points or draw 2 cards (a pending decision).
 * - `challenge`: only playable from hand in a response window; cancels the card being played.
 * - `modifier`: only playable from hand in a response window on a `point_N` card, which then
 *   scores 1 more point. The window reopens to every responder, passed or not.
 */
export const TOY_CARD_DEFS = ["point_1", "point_2", "point_3", "wish", "challenge", "modifier"] as const;

/** Cards that can only be played in a response window, never on your own turn. */
export const TOY_RESPONSE_CARDS: readonly ToyCardDefId[] = ["challenge", "modifier"];
export type ToyCardDefId = (typeof TOY_CARD_DEFS)[number];

export interface ToyCard {
  id: CardInstanceId;
  def: ToyCardDefId;
}

export interface ToyConfig {
  /** First player to reach this score wins. */
  targetScore: number;
  /** Cards dealt to each player at the start. */
  handSize: number;
}

export const DEFAULT_TOY_CONFIG: ToyConfig = { targetScore: 5, handSize: 3 };

export interface ToyPlayer {
  id: PlayerId;
  name: string;
  isBot: boolean;
  hand: ToyCard[];
  score: number;
}

export interface ToyDecisionOption {
  id: string;
  label: string;
}

export interface ToyPendingDecision {
  id: string;
  player: PlayerId;
  kind: "chooseOption";
  prompt: string;
  /** Answered with exactly one option id: every Decision is one pick. */
  options: ToyDecisionOption[];
}

export interface ToyResponseWindow {
  /** The player whose card is waiting to resolve. */
  player: PlayerId;
  card: ToyCard;
  /** Players who have not yet passed, in turn order after `player`. */
  awaiting: PlayerId[];
  /** Extra points from modifiers played on the card. */
  bonus: number;
}

export type ToyPhase = "action" | "responseWindow" | "decision" | "gameOver";

export interface GameState {
  rng: RngState;
  config: ToyConfig;
  players: ToyPlayer[];
  deck: ToyCard[];
  discard: ToyCard[];
  activePlayer: PlayerId;
  turn: number;
  phase: ToyPhase;
  responseWindow: ToyResponseWindow | null;
  pendingDecision: ToyPendingDecision | null;
  /** RNG-free counter for decision ids. */
  nextDecisionId: number;
  winner: PlayerId | null;
}

export type GameEvent =
  | { type: "TURN_STARTED"; player: PlayerId; turn: number }
  /** `card` is present only in the drawer's copy of the event. */
  | { type: "CARD_DRAWN"; player: PlayerId; card?: ToyCard }
  | { type: "CARD_PLAYED"; player: PlayerId; card: ToyCard }
  | { type: "RESPONSE_WINDOW_OPENED"; player: PlayerId; card: ToyCard; awaiting: PlayerId[] }
  | { type: "PASSED"; player: PlayerId }
  | { type: "CHALLENGED"; player: PlayerId; card: ToyCard; target: ToyCard }
  | { type: "MODIFIED"; player: PlayerId; card: ToyCard; target: ToyCard; bonus: number; awaiting: PlayerId[] }
  | { type: "POINTS_SCORED"; player: PlayerId; points: number; total: number }
  | { type: "DECISION_OPENED"; player: PlayerId; decisionId: string }
  | { type: "DECISION_RESOLVED"; player: PlayerId; decisionId: string; selected: string[] }
  | { type: "GAME_OVER"; winner: PlayerId };

export interface ApplyResult {
  ok: boolean;
  /** Unchanged (the same object) when `ok` is false. */
  state: GameState;
  error?: string;
  /** Unfiltered events; send each player `getPlayerEvents(events, player)`. */
  events: GameEvent[];
}

export interface PlayerView {
  me: PlayerId | "spectator";
  turn: number;
  phase: ToyPhase;
  activePlayer: PlayerId;
  players: { id: PlayerId; name: string; isBot: boolean; score: number; handCount: number }[];
  /** The viewer's own hand; empty for a spectator. */
  hand: ToyCard[];
  deckCount: number;
  discard: ToyCard[];
  responseWindow: ToyResponseWindow | null;
  /** Full if the decision is the viewer's; otherwise only who is deciding. */
  pendingDecision: ToyPendingDecision | { player: PlayerId } | null;
  winner: PlayerId | null;
  /** Everything the viewer may do now (TECHNICAL_DESIGN.md §9); empty for a spectator. */
  legalActions: Action[];
}

export interface CreateGameOptions {
  players: { id: PlayerId; name: string; isBot: boolean }[];
  seed: string;
  config?: Partial<ToyConfig>;
  /**
   * Test hook: the exact deck, top card first, instead of a seeded shuffle of
   * the default deck. Hands are dealt from the top, `handSize` cards to each
   * player in seat order.
   */
  deckOrder?: ToyCardDefId[];
}
