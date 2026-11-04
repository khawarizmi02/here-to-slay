import { decisionOptions, openDecision, type DecisionResolver } from "./decisions.js";
import { fromPlayer, playerState } from "./players.js";
import { handLimit, passivesAt } from "./passives.js";
import { shuffle } from "./rng.js";
import type { CardIndex, GameEvent, GameState, PlayerId } from "./types.js";

/** Cards a Discard and Redraw draws (§3.5). */
export const REDRAW_COUNT = 5;

/**
 * Draws up to `count` cards from the top of the main deck into `player`'s
 * hand, announcing each to the drawer only. When the deck runs out, even in
 * the middle, the discard pile is shuffled to make a new one
 * (`reshuffleDiscardWhenDeckEmpty`); with nothing left to draw, it stops short.
 */
export function drawCards(state: GameState, player: PlayerId, count: number, events: GameEvent[]): void {
  const p = playerState(state, player);
  for (let i = 0; i < count; i++) {
    if (state.mainDeck.length === 0) reshuffleDiscardPile(state, events);
    const card = state.mainDeck.shift();
    if (card === undefined) return;
    p.hand.push(card);
    events.push({ type: "CARD_DRAWN", player, card: { id: card, def: state.cards[card]! } });
  }
}

/** Whether a draw would get a card: the deck has one, or the discard pile can be reshuffled into it. */
export function canDraw(state: GameState): boolean {
  return state.mainDeck.length > 0 || (state.config.reshuffleDiscardWhenDeckEmpty && state.discardPile.length > 0);
}

function reshuffleDiscardPile(state: GameState, events: GameEvent[]): void {
  if (!state.config.reshuffleDiscardWhenDeckEmpty || state.discardPile.length === 0) return;
  [state.mainDeck, state.rng] = shuffle(state.discardPile, state.rng);
  state.discardPile = [];
  events.push({ type: "DECK_RESHUFFLED", cards: state.mainDeck.length });
}

/** Discard and Redraw (§3.5): the whole hand goes face up to the discard pile, then the player draws 5. */
export function discardAndRedraw(state: GameState, player: PlayerId, events: GameEvent[]): void {
  for (const card of [...playerState(state, player).hand]) discardFromHand(state, player, card, events);
  drawCards(state, player, REDRAW_COUNT, events);
}

/**
 * Starts `player`'s turn (§3.4, §6.3): fresh AP and a fresh roll for every
 * hero in play, then start-of-turn passives, then the optional free draw
 * (`drawAtStartOfTurn`). A hero rolls only on its owner's turn, so resetting
 * them all leaves a hero stolen mid-turn with the flag it had for that turn.
 */
export function startTurn(defs: CardIndex, state: GameState, player: PlayerId, events: GameEvent[]): void {
  state.activePlayer = player;
  state.actionPoints = state.config.actionPointsPerTurn;
  for (const p of state.players) for (const hero of p.party) hero.rolledThisTurn = false;
  state.phase = { kind: "action" };
  events.push({ type: "TURN_STARTED", player, turnNumber: state.turnNumber });
  runTriggers(defs, state, player, "onTurnStart", events);
  if (state.config.drawAtStartOfTurn) drawCards(state, player, 1, events);
}

/**
 * Runs `player`'s passives at a trigger hook. The only effect a passive can
 * have here is a draw for now: a trigger that could pause on a Decision
 * would have to put the rest of the turn's start or end on the stack too.
 */
function runTriggers(defs: CardIndex, state: GameState, player: PlayerId, hook: "onTurnStart" | "onTurnEnd", events: GameEvent[]): void {
  for (const passive of passivesAt(defs, state, player, hook)) {
    const effect = passive.effect;
    if (effect?.op !== "draw" || typeof effect.who !== "string") {
      throw new Error(`A ${hook} passive can only draw for now, not ${JSON.stringify(passive)}`);
    }
    drawCards(state, effect.who === "self" ? player : state.activePlayer, effect.amount, events);
  }
}

/**
 * Ends the turn once nothing is left to do in it (§6.3): its AP is spent and
 * nothing is resolving. Call it after every action.
 */
export function settleTurn(defs: CardIndex, state: GameState, events: GameEvent[]): void {
  if (state.phase.kind === "action" && state.actionPoints <= 0 && state.pendingDecision === null) endTurn(defs, state, events);
}

/**
 * Ends the active player's turn (§3.4, §6.3): end-of-turn passives, then the
 * hand-limit discard, so nobody passes the turn over the limit, then the next
 * player's turn, clockwise.
 */
export function endTurn(defs: CardIndex, state: GameState, events: GameEvent[]): void {
  runTriggers(defs, state, state.activePlayer, "onTurnEnd", events);
  state.phase = { kind: "turnEnd", discarded: 0 };
  continueTurnEnd(defs, state, events);
}

/**
 * Runs the end of the turn on: asks for the next hand-limit discard, one
 * card per Decision, or, once the hand is within the limit, passes the turn.
 */
function continueTurnEnd(defs: CardIndex, state: GameState, events: GameEvent[]): void {
  if (state.phase.kind !== "turnEnd") throw new Error("Not at the end of a turn");
  const player = state.activePlayer;
  const hand = playerState(state, player).hand;
  const limit = handLimit(defs, state, player);
  if (hand.length > limit) {
    const { discarded } = state.phase;
    openDecision(
      defs,
      state,
      {
        player,
        kind: "chooseCardFromHand",
        resume: "handLimitDiscard",
        prompt: `Discard down to your hand limit of ${limit} (${discarded + 1} of ${discarded + hand.length - limit})`,
        options: decisionOptions(state, { cards: hand }),
        discard: true,
      },
      events,
      handLimitDiscarded,
    );
    return;
  }

  events.push({ type: "TURN_ENDED", player });
  const next = fromPlayer(state, player)[1 % state.turnOrder.length]!;
  state.turnNumber++;
  startTurn(defs, state, next, events);
}

/** One hand-limit discard: the card goes face up to the discard pile, and the end of the turn runs on. */
export const handLimitDiscarded: DecisionResolver = (defs, state, decision, choice, events) => {
  // The hand is over the limit, so it is never empty.
  if (choice === null || state.phase.kind !== "turnEnd") throw new Error("No card to discard for the hand limit");
  discardFromHand(state, decision.player, choice, events);
  state.phase.discarded++;
  continueTurnEnd(defs, state, events);
};

/** Moves `card` from `player`'s hand to the top of the discard pile. */
export function discardFromHand(state: GameState, player: PlayerId, card: string, events: GameEvent[]): void {
  const p = playerState(state, player);
  p.hand = p.hand.filter((c) => c !== card);
  state.discardPile.push(card);
  events.push({ type: "CARD_DISCARDED", player, card: { id: card, def: state.cards[card]! } });
}
