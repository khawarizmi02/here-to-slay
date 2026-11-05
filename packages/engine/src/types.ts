import type { CardDef, CardDefId, Effect } from "@here-to-slay/cards";
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
 * A turn's start- and end-of-turn passives run on the stack, so the phase is
 * "resolving" while one waits on a Decision; the end of a turn is its own
 * phase only while a hand-limit discard waits.
 */
export type Phase =
  | { kind: "setup"; step: "leaderSelect" }
  | { kind: "action" }
  /** Something is on the stack: the active player's action is still resolving. */
  | { kind: "resolving" }
  /** The active player is discarding down to the hand limit; `discarded` counts their picks so far. */
  | { kind: "turnEnd"; discarded: number }
  | { kind: "gameOver" };

/** One thing a Decision offers. `id` is the id of the thing chosen: a player id or a card instance id (§6.4). */
export interface DecisionOption {
  id: string;
  /** The card's definition, when the option is a card. */
  def?: CardDefId;
  /** What the option does, when it is neither a player nor a card: "Decline", or a `choice` option's label. */
  label?: string;
}

/** The id of the Decline option, listed first in every "you may" Decision (§6.4). */
export const DECLINE = "decline";
/** The id of the option that takes up a "you may" Decision. */
export const ACCEPT = "accept";

/**
 * One pick the game is waiting on (§6.4, GLOSSARY.md "Decision"). Options
 * list players in turn order, then cards by instance id.
 */
export interface PendingDecision {
  /** From an RNG-free counter. */
  id: string;
  player: PlayerId;
  kind: "chooseLeader" | "chooseCardFromHand" | "choosePlayer" | "chooseHero" | "chooseOption" | "confirmOptional";
  /** What the game does with the answer; `kind` only says what is being chosen. "stack" hands it to the frame on top of the stack. */
  resume: "leaderDraft" | "handLimitDiscard" | "stack";
  prompt: string;
  options: DecisionOption[];
  /** Whether the pick gives up the chooser's own card: the Room picks a random answer for it on a timeout. */
  discard: boolean;
}

/**
 * The answers a stack frame has collected, by name. A null answer means the
 * Decision was skipped for having no option.
 */
export type Bindings = Record<string, string | null>;

/**
 * A running effect (§6.5 Option A). `pc` counts the steps of a `sequence`,
 * the players of a `forEach` or the cards of a `discard` done so far.
 */
export interface EffectFrame {
  kind: "effect";
  effect: Effect;
  pc: number;
  /** The player whose card this is: "you" on the card. */
  controller: PlayerId;
  /** Who "self" means here: the controller, or inside a `forEach`, the player being iterated over (§5.6). */
  self: PlayerId;
  /** The players a `forEach` goes through, fixed when it starts; null before then. */
  players: PlayerId[] | null;
  bindings: Bindings;
  /** The binding the pending Decision answers, if this frame asked one. */
  awaiting: string | null;
  /** The card that caused the effect. */
  source: CardInstanceId;
}

/** A "you may roll for this hero's effect" offer, after the hero is played (`freeRollOnHeroPlay`). */
export interface FreeRollFrame {
  kind: "freeRoll";
  player: PlayerId;
  hero: CardInstanceId;
  bindings: Bindings;
  awaiting: string | null;
}

/**
 * A 2d6 roll: for a hero's effect, to attack a monster, or one side's roll in
 * a Challenge duel. A hero or monster roll opens its own Modifier Window once
 * the dice land, and settles once it closes. A Challenge roll hands its total
 * to its duel, which opens one window on both rolls (§7.2, §7.3).
 */
export type RollFrame = {
  kind: "roll";
  rollId: string;
  roller: PlayerId;
  /**
   * "beforeRoll" until the roller's beforeRoll passives are on the stack,
   * then "dice" until the dice land, then "settle" while its Modifier Window is open above it.
   */
  stage: "beforeRoll" | "dice" | "settle";
  /** The final total, set as its Modifier Window closes; null before then, and always for a Challenge roll. */
  total: number | null;
} & (
  | { rollKind: "heroEffect"; hero: CardInstanceId }
  | { rollKind: "monsterAttack"; monster: CardInstanceId }
  /** `target` is the card being Challenged; the total goes to the challengeDuel frame below. */
  | { rollKind: "challenge"; side: "challenger" | "defender"; target: CardInstanceId }
);

/** The card plays a Challenge Window follows (§3.7). */
export type ChallengeableAction = "PLAY_HERO" | "PLAY_ITEM" | "PLAY_MAGIC";

/**
 * A Hero, Item or Magic card that has been played (§7.1, §7.2). Its AP is
 * spent and it has left the hand, but it is in limbo, in no zone, while its
 * Challenge Windows are open. Then it resolves as the action it was, or, if a
 * Challenge succeeded, it has gone to the discard pile with no effect.
 */
export interface CardPlayFrame {
  kind: "cardPlay";
  player: PlayerId;
  card: CardInstanceId;
  action: ChallengeableAction;
  /** The hero an item goes on; null for a Hero or Magic card. */
  targetHero: CardInstanceId | null;
  /** Whether its first Challenge Window has been opened. */
  opened: boolean;
  /** Challenges made against it so far, up to `maxChallengesPerPlay`. */
  challenges: number;
  /** Whether a Challenge succeeded: the card is in the discard pile and does nothing. */
  challenged: boolean;
}

/**
 * A Challenge Window on the card play below it (GLOSSARY.md "Response
 * Window"): open to every player but the one who played the card, whatever
 * they hold. It closes once all of them have passed.
 */
export interface ChallengeWindowFrame {
  kind: "challengeWindow";
  /** The player who played the card. */
  player: PlayerId;
  card: CardInstanceId;
  passed: PlayerId[];
}

/**
 * A Challenge against the card play below it (§7.2): the challenger rolls,
 * then the defender, then one Modifier Window opens on both rolls, then the
 * totals are compared. Ties go to `challengeTieWinner`.
 */
export interface ChallengeDuelFrame {
  kind: "challengeDuel";
  challenger: PlayerId;
  defender: PlayerId;
  /** The card being Challenged. */
  target: CardInstanceId;
  /** Each side's roll id and total: the dice and passives, then, once the Modifier Window closes, the final total. */
  challengerRoll: string | null;
  defenderRoll: string | null;
  challengerTotal: number | null;
  defenderTotal: number | null;
  /** Whether the Modifier Window on both rolls has been opened. */
  modified: boolean;
}

/** A Modifier played on a roll, with the option its player chose (§3.6, §7.1). */
export interface AppliedModifier {
  player: PlayerId;
  card: CardInstanceId;
  value: number;
}

/** One roll in a Modifier Window: `total` is its dice, passive bonus and every Modifier played on it so far. */
export interface WindowRoll {
  roll: string;
  player: PlayerId;
  total: number;
  modifiers: AppliedModifier[];
}

/**
 * A Modifier Window (GLOSSARY.md "Response Window") on the roll or Challenge
 * duel below it: one roll, or a Challenge's two. Open to every player, the
 * roller included, whatever they hold. Any Modifier reopens it to everyone;
 * it closes once all of them have passed since the last one.
 */
export interface ModifierWindowFrame {
  kind: "modifierWindow";
  rolls: WindowRoll[];
  passed: PlayerId[];
}

/**
 * A Magic card being played (§3.5). While it resolves the card is in no
 * zone; once its effect is done it goes to the discard pile, and if the game
 * ends first, it goes there then.
 */
export interface MagicFrame {
  kind: "magic";
  player: PlayerId;
  card: CardInstanceId;
  /** Whether the card's effect is on the stack yet. */
  started: boolean;
}

/**
 * The rest of a turn's start or end, under that hook's trigger passives: the
 * free draw (`drawAtStartOfTurn`), or the hand-limit discard and passing the turn.
 */
export interface TurnFrame {
  kind: "turn";
  step: "startDraw" | "end";
}

/** The top of the stack is the last element (§7.1). */
export type StackFrame =
  | EffectFrame
  | FreeRollFrame
  | RollFrame
  | MagicFrame
  | TurnFrame
  | CardPlayFrame
  | ChallengeWindowFrame
  | ChallengeDuelFrame
  | ModifierWindowFrame;

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
  /** What is resolving (§6.5, §7.1); the top is the last element. */
  stack: StackFrame[];
  pendingDecision: PendingDecision | null;
  /** Counts Decisions opened, for their ids. */
  nextDecisionId: number;
  /** Counts rolls made, for their ids. */
  nextRollId: number;
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
  | { type: "HERO_PLAYED"; player: PlayerId; card: CardView }
  /** `player` put `card` on `owner`'s `hero`. */
  | { type: "ITEM_PLAYED"; player: PlayerId; card: CardView; owner: PlayerId; hero: CardView }
  /** `player` played a Magic card; its effect resolves next. */
  | { type: "MAGIC_PLAYED"; player: PlayerId; card: CardView }
  /** A Magic card's effect is done and the card went to the discard pile. */
  | { type: "MAGIC_DISCARDED"; player: PlayerId; card: CardView }
  /** `player` took `hero` from `from`'s party into their own; `item` is the item that came with it. */
  | { type: "HERO_STOLEN"; player: PlayerId; from: PlayerId; hero: CardView; item: CardView | null }
  /** `player` destroyed `owner`'s hero: it and its `item` went to the discard pile. */
  | { type: "HERO_DESTROYED"; player: PlayerId; owner: PlayerId; hero: CardView; item: CardView | null }
  /** `player` sacrificed their own hero: it and its `item` went to the discard pile. */
  | { type: "HERO_SACRIFICED"; player: PlayerId; hero: CardView; item: CardView | null }
  /** A stolen hero's item went to the discard pile instead of moving with it (`itemFollowsStolenHero` off). */
  | { type: "ITEM_DISCARDED"; player: PlayerId; item: CardView }
  /** `player` took a random card from `from`'s hand. `card` is present only in their two copies of the event. */
  | { type: "CARD_PULLED"; player: PlayerId; from: PlayerId; card?: CardView }
  /** The dice of a roll landed: `bonus` is from passives, and `total` is before any Modifier. A Modifier Window opens on it. */
  | ({ type: "DICE_ROLLED"; roll: string; player: PlayerId; dice: [number, number]; bonus: number; total: number } & (
      | { rollKind: "heroEffect"; hero: CardView }
      | { rollKind: "monsterAttack"; monster: CardView }
      /** One side's roll in a Challenge against `target`. */
      | { rollKind: "challenge"; side: "challenger" | "defender"; target: CardView }
    ))
  /** `player` discarded `card`, a Modifier, adding `value` to `roll`, which now totals `total`. */
  | { type: "MODIFIER_PLAYED"; player: PlayerId; card: CardView; roll: string; value: number; total: number }
  /**
   * A hero or monster roll's Modifier Window closed at its final `total`. A
   * hero's effect roll succeeds when it is at least the hero's requirement. A
   * monster attack slays the monster at or above its slay value, is defeated
   * at or below its defeat value, and otherwise does nothing. A Challenge's
   * rolls settle in CHALLENGE_RESOLVED instead.
   */
  | ({ type: "ROLL_RESOLVED"; roll: string; player: PlayerId; total: number } & (
      | { rollKind: "heroEffect"; hero: CardView; succeeded: boolean }
      | { rollKind: "monsterAttack"; monster: CardView; outcome: "slain" | "defeated" | "nothing" }
    ))
  /** `player` played `card`, which waits in limbo while a Challenge Window is open on it. */
  | { type: "CHALLENGE_WINDOW_OPENED"; player: PlayerId; card: CardView }
  /** `player` discarded `card`, a Challenge, to Challenge `defender`'s `target`. */
  | { type: "CHALLENGE_PLAYED"; player: PlayerId; card: CardView; defender: PlayerId; target: CardView }
  /** A Challenge was settled. When it `succeeded`, `target` went to the discard pile with no effect. */
  | {
      type: "CHALLENGE_RESOLVED";
      challenger: PlayerId;
      defender: PlayerId;
      target: CardView;
      challengerTotal: number;
      defenderTotal: number;
      succeeded: boolean;
    }
  /** `player` slew `monster`: it went to their slain pile. */
  | { type: "MONSTER_SLAIN"; player: PlayerId; monster: CardView }
  /** `monster` was revealed from the monster deck to fill an empty slot. */
  | { type: "MONSTER_REVEALED"; monster: CardView }
  | { type: "GAME_WON"; player: PlayerId; reason: "monsters" | "classes" }
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
  /**
   * The open Response Window and who it still waits on, in turn order. A
   * Challenge Window names the card in limbo; a Modifier Window lists its
   * rolls (one, or a Challenge's two) with their totals so far.
   */
  responseWindow:
    | { kind: "challenge"; awaiting: PlayerId[]; card: CardView }
    | { kind: "modifier"; awaiting: PlayerId[]; rolls: WindowRoll[] }
    | null;
  /** In full for the player who must answer; everyone else sees only who that is. */
  pendingDecision: PendingDecision | { player: PlayerId } | null;
  firstPlayerRolls: FirstPlayerRoll[][] | null;
  winner: PlayerId | null;
  winReason: "monsters" | "classes" | null;
  /** Everything the viewer may do now; empty for a spectator. */
  legalActions: Action[];
};
