import { fromPlayer, playerState } from "./players.js";
import { pushTriggers } from "./stack.js";
import type {
  Action,
  CardIndex,
  CardInstanceId,
  CardPlayFrame,
  ChallengeDuelFrame,
  ChallengeWindowFrame,
  GameEvent,
  GameState,
  PlayerId,
} from "./types.js";

/*
 * Challenge Windows and Challenge duels (TECHNICAL_DESIGN.md §3.7, §7.2).
 * The stack holds a card play, and above it either a Challenge Window that
 * waits on the players' responses or a duel being rolled.
 */

/** The Challenge Window waiting on responses, if one is open: always the top frame. */
export function openChallengeWindow(state: GameState): ChallengeWindowFrame | undefined {
  const top = state.stack.at(-1);
  return top?.kind === "challengeWindow" && awaitingResponses(state, top).length > 0 ? top : undefined;
}

/** Who a Challenge Window still waits on: everyone but the player who played the card, in turn order after them, who hasn't passed. */
export function awaitingResponses(state: GameState, frame: ChallengeWindowFrame): PlayerId[] {
  return fromPlayer(state, frame.player)
    .slice(1)
    .filter((id) => !frame.passed.includes(id));
}

/** The Challenge cards in `player`'s hand, by instance id. */
function challengeCards(defs: CardIndex, state: GameState, player: PlayerId): CardInstanceId[] {
  return playerState(state, player)
    .hand.filter((c) => defs.get(state.cards[c]!)?.type === "challenge")
    .sort();
}

/** In an open Challenge Window: PASS, whatever the player holds, then a PLAY_CHALLENGE per Challenge card in hand. */
export function responseActions(defs: CardIndex, state: GameState, player: PlayerId): Action[] | undefined {
  const window = openChallengeWindow(state);
  if (window === undefined) return undefined;
  if (!awaitingResponses(state, window).includes(player)) return [];
  return [{ type: "PASS", player }, ...challengeCards(defs, state, player).map((card) => ({ type: "PLAY_CHALLENGE" as const, player, card }))];
}

/** PASS: the player is done with this window. It closes once everyone in it has passed. */
export function pass(state: GameState, player: PlayerId): void {
  openChallengeWindow(state)!.passed.push(player);
}

/**
 * PLAY_CHALLENGE (§3.7): costs no AP. The Challenge card goes to the discard
 * pile, the window closes, and the duel starts, after the defender's
 * onChallenged passives.
 */
export function playChallenge(defs: CardIndex, state: GameState, player: PlayerId, card: CardInstanceId, events: GameEvent[]): void {
  const window = state.stack.pop() as ChallengeWindowFrame;
  const play = state.stack.at(-1) as CardPlayFrame;
  play.challenges++;
  const p = playerState(state, player);
  p.hand = p.hand.filter((c) => c !== card);
  state.discardPile.push(card);
  events.push({ type: "CHALLENGE_PLAYED", player, card: view(state, card), defender: window.player, target: view(state, window.card) });
  state.stack.push({ kind: "challengeDuel", challenger: player, defender: window.player, target: window.card, challengerTotal: null, defenderTotal: null });
  pushTriggers(defs, state, window.player, "onChallenged", { action: play.action });
}

/** Opens a Challenge Window on `play`, unless `maxChallengesPerPlay` allows no more Challenges. */
export function pushChallengeWindow(state: GameState, play: CardPlayFrame, events: GameEvent[]): void {
  if (play.challenges >= state.config.maxChallengesPerPlay) return;
  state.stack.push({ kind: "challengeWindow", player: play.player, card: play.card, passed: [] });
  events.push({ type: "CHALLENGE_WINDOW_OPENED", player: play.player, card: view(state, play.card) });
}

/**
 * Steps a duel: the challenger's roll, then the defender's, then the
 * verdict. A successful Challenge sends the card to the discard pile with no
 * effect; the AP spent on it stays spent. A failed one lets the card resolve,
 * after another Challenge Window if `maxChallengesPerPlay` allows one.
 */
export function challengeDuelStep(state: GameState, duel: ChallengeDuelFrame, events: GameEvent[]): void {
  if (duel.challengerTotal === null || duel.defenderTotal === null) {
    const side = duel.challengerTotal === null ? "challenger" : "defender";
    state.stack.push({ kind: "roll", rollId: `r${state.nextRollId++}`, roller: duel[side], rollKind: "challenge", side, target: duel.target, stage: "beforeRoll" });
    return;
  }
  state.stack.pop();
  const play = state.stack.at(-1) as CardPlayFrame;
  const { challengerTotal, defenderTotal } = duel;
  const succeeded = state.config.challengeTieWinner === "challenger" ? challengerTotal >= defenderTotal : challengerTotal > defenderTotal;
  events.push({
    type: "CHALLENGE_RESOLVED",
    challenger: duel.challenger,
    defender: duel.defender,
    target: view(state, duel.target),
    challengerTotal,
    defenderTotal,
    succeeded,
  });
  if (succeeded) {
    play.challenged = true;
    state.discardPile.push(play.card);
  } else {
    pushChallengeWindow(state, play, events);
  }
}

/** Stores a Challenge roll's total in the duel it belongs to, which is on top of the stack once the roll is popped. */
export function challengeRolled(state: GameState, side: "challenger" | "defender", total: number): void {
  const duel = state.stack.at(-1);
  if (duel?.kind !== "challengeDuel") throw new Error("A Challenge roll with no duel under it");
  if (side === "challenger") duel.challengerTotal = total;
  else duel.defenderTotal = total;
}

function view(state: GameState, card: CardInstanceId) {
  return { id: card, def: state.cards[card]! };
}
