import type { CardDefId } from "@here-to-slay/cards";
import type { Action, CardInstanceId, PlayerId } from "@here-to-slay/protocol";
import type { RuleConfig } from "./config.js";
import type { RngState } from "./rng.js";

export type { Action, CardInstanceId, CardDefId, PlayerId };

/** TECHNICAL_DESIGN.md §4.3. */
export interface HeroInPlay {
  instanceId: CardInstanceId;
  equippedItem: CardInstanceId | null;
  rolledThisTurn: boolean;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  isBot: boolean;
  leader: CardInstanceId;
  hand: CardInstanceId[];
  party: HeroInPlay[];
  slainMonsters: CardInstanceId[];
}

/** §6.3. Setup steps arrive with the leader draft and first-player roll. */
export type Phase = { kind: "action" } | { kind: "gameOver" };

export interface GameState {
  config: RuleConfig;
  rng: RngState;
  /** Instance → definition, for every card in the game. */
  cards: Record<CardInstanceId, CardDefId>;
  /** In Seat order: the order of `createGame`'s `players`. */
  players: PlayerState[];
  /** Clockwise from the first player. */
  turnOrder: PlayerId[];
  activePlayer: PlayerId;
  actionPoints: number;
  turnNumber: number;

  /** Index 0 is the top. */
  mainDeck: CardInstanceId[];
  discardPile: CardInstanceId[];
  monsterDeck: CardInstanceId[];
  activeMonsters: CardInstanceId[];
  /** Party Leaders nobody has: out of the game, and never shown. */
  leaderPool: CardInstanceId[];

  phase: Phase;
  winner: PlayerId | null;
  winReason: "monsters" | "classes" | null;
}

/** A face-up card as a view shows it. */
export interface CardView {
  id: CardInstanceId;
  def: CardDefId;
}

export type GameEvent =
  /** `card` is present only in the drawer's copy of the event. */
  { type: "CARD_DRAWN"; player: PlayerId; card?: CardView };

export interface ApplyResult {
  ok: boolean;
  /** The same object when `ok` is false. */
  state: GameState;
  error?: string;
  /** Unfiltered; send each player `getPlayerEvents(events, player)`. */
  events: GameEvent[];
}

/**
 * One player's redacted view of the game (§9). A type alias, not an
 * interface, so it fits the Room's plain-record payload.
 */
export type PlayerView = {
  me: PlayerId | "spectator";
  phase: Phase;
  turnNumber: number;
  activePlayer: PlayerId;
  turnOrder: PlayerId[];
  actionPoints: number;
  players: {
    id: PlayerId;
    name: string;
    isBot: boolean;
    leader: CardView;
    /** Other players' hands appear only as this count. */
    handCount: number;
    party: { hero: CardView; item: CardView | null; rolledThisTurn: boolean }[];
    slainMonsters: CardView[];
  }[];
  /** The viewer's own hand; empty for a spectator. */
  hand: CardView[];
  mainDeckCount: number;
  monsterDeckCount: number;
  discardPile: CardView[];
  activeMonsters: CardView[];
  responseWindow: { kind: "challenge" | "modifier"; awaiting: PlayerId[] } | null;
  pendingDecision: null;
  winner: PlayerId | null;
  winReason: "monsters" | "classes" | null;
  /** Everything the viewer may do now; empty for a spectator. */
  legalActions: Action[];
};
