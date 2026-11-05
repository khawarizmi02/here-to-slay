import { awaitingChallenges, challengeActions } from "./challenges.js";
import { awaitingModifiers, modifierActions } from "./modifiers.js";
import type { Action, CardIndex, ChallengeWindowFrame, GameState, ModifierWindowFrame, PlayerId } from "./types.js";

/*
 * Response Windows (GLOSSARY.md): a Challenge Window or a Modifier Window,
 * always the top frame of the stack while it waits on responses.
 */

export type WindowFrame = ChallengeWindowFrame | ModifierWindowFrame;

/** The Response Window waiting on responses, if one is open: always the top frame. */
export function openWindow(state: GameState): WindowFrame | undefined {
  const top = state.stack.at(-1);
  if (top?.kind !== "challengeWindow" && top?.kind !== "modifierWindow") return undefined;
  return awaitingResponses(state, top).length > 0 ? top : undefined;
}

/** Who a window still waits on, in turn order: everyone in it who hasn't passed since the last response. */
export function awaitingResponses(state: GameState, frame: WindowFrame): PlayerId[] {
  return frame.kind === "challengeWindow" ? awaitingChallenges(state, frame) : awaitingModifiers(state, frame);
}

/** In an open window: PASS, whatever the player holds, then the responses their hand allows. Undefined when no window is open. */
export function responseActions(defs: CardIndex, state: GameState, player: PlayerId): Action[] | undefined {
  const window = openWindow(state);
  if (window === undefined) return undefined;
  if (!awaitingResponses(state, window).includes(player)) return [];
  const responses = window.kind === "challengeWindow" ? challengeActions(defs, state, player) : modifierActions(defs, state, window, player);
  return [{ type: "PASS", player }, ...responses];
}

/** PASS: the player is done with this window until someone responds. It closes once everyone in it has passed. */
export function pass(state: GameState, player: PlayerId): void {
  openWindow(state)!.passed.push(player);
}
