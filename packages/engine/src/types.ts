import type { CardDef, CardDefId } from "@here-to-slay/cards";
import type { Action, CardInstanceId, PlayerId } from "@here-to-slay/protocol";
import type { RuleConfig } from "./config.js";
import type { RngState } from "./rng.js";

export type { Action, CardInstanceId, CardDefId, PlayerId };

/** The game's card definitions by id. The engine binds them once, in `createRoomEngine`; they never live in GameState. */
export type CardIndex = ReadonlyMap<CardDefId, CardDef>;

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
  /** Null only while a leader draft has yet to reach this player. */
  leader: CardInstanceId | null;
  hand: CardInstanceId[];
  party: HeroInPlay[];
  slainMonsters: CardInstanceId[];
}

/**
 * §6.3. The only setup step a player sees is the leader draft: the
 * first-player roll needs no input, so it happens as soon as it is reached.
 * Likewise the start of a turn needs no input, so no state is ever in it,
 * and the end of a turn is a phase only while a hand-limit discard waits.
 */
export type Phase =
  | { kind: "setup"; step: "leaderSelect" }
  | { kind: "action" }
  /** The active player is discarding down to the hand limit; `discarded` counts their picks so far. */
  | { kind: "turnEnd"; discarded: number }
  | { kind: "gameOver" };

/** One thing a Decision offers. `id` is the id of the thing chosen: a player id or a card instance id (§6.4). */
export interface DecisionOption {
  id: string;
  /** The card's definition, when the option is a card. */
  def?: CardDefId;
}

/**
 * One pick the game is waiting on (§6.4, GLOSSARY.md "Decision"). Options
 * list players in turn order, then cards by instance id.
 */
export interface PendingDecision {
  /** From an RNG-free counter. */
  id: string;
  player: PlayerId;
  kind: "chooseLeader" | "chooseCardFromHand";
  /** What the game does with the answer; `kind` only says what is being chosen. */
  resume: "leaderDraft" | "handLimitDiscard";
  prompt: string;
  options: DecisionOption[];
  /** Whether the pick gives up the chooser's own card: the Room picks a random answer for it on a timeout. */
  discard: boolean;
}

/** One player's 2d6 in a first-player roll. */
export interface FirstPlayerRoll {
  player: PlayerId;
  dice: [number, number];
}

export interface GameState {
  config: RuleConfig;
  rng: RngState;
  /** Instance → definition, for every card in the game. */
  cards: Record<CardInstanceId, CardDefId>;
  /** In Seat order: the order of `createGame`'s `players`. */
  players: PlayerState[];
  /** Clockwise from the first player. Empty during the leader draft: turn order doesn't exist until setup ends (§3.2). */
  turnOrder: PlayerId[];
  activePlayer: PlayerId;
  actionPoints: number;
  turnNumber: number;

  /** Index 0 is the top. */
  mainDeck: CardInstanceId[];
  discardPile: CardInstanceId[];
  monsterDeck: CardInstanceId[];
  activeMonsters: CardInstanceId[];
  /**
   * Party Leaders nobody has. During a draft these are on offer, and only the
   * drafter sees them, in their Decision; after setup they are out of the game and never shown.
   */
  leaderPool: CardInstanceId[];

  phase: Phase;
  pendingDecision: PendingDecision | null;
  /** Counts Decisions opened, for their ids. */
  nextDecisionId: number;
  /**
   * The first-player roll, one round per entry: everyone, then only those
   * tied for highest. Null when the first player wasn't rolled for, or not yet.
   */
  firstPlayerRolls: FirstPlayerRoll[][] | null;
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
  | { type: "CARD_DRAWN"; player: PlayerId; card?: CardView }
  | { type: "LEADER_CHOSEN"; player: PlayerId; leader: CardView }
  | { type: "FIRST_PLAYER_ROLLED"; rounds: FirstPlayerRoll[][]; firstPlayer: PlayerId }
  | { type: "TURN_STARTED"; player: PlayerId; turnNumber: number }
  | { type: "TURN_ENDED"; player: PlayerId }
  | { type: "CARD_DISCARDED"; player: PlayerId; card: CardView }
  /** The discard pile was shuffled into a new main deck of `cards` cards. */
  | { type: "DECK_RESHUFFLED"; cards: number };

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
    /** Null only while a leader draft has yet to reach this player. */
    leader: CardView | null;
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
  /** In full for the player who must answer; everyone else sees only who that is. */
  pendingDecision: PendingDecision | { player: PlayerId } | null;
  firstPlayerRolls: FirstPlayerRoll[][] | null;
  winner: PlayerId | null;
  winReason: "monsters" | "classes" | null;
  /** Everything the viewer may do now; empty for a spectator. */
  legalActions: Action[];
};
