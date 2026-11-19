import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type Action, type GameState, type PlayerView } from "@here-to-slay/engine";
import type { ConfigPatch, RoomMsg } from "@here-to-slay/protocol";

/** The rules engine with the card set the board shows, as the composition root builds it. */
export const engine = createRoomEngine(placeholderCardDefs);

export const ALICE_HERO = "hero_bard_01#0"; // Placeholder Bard 1
export const BOB_HERO = "hero_fighter_01#0"; // Placeholder Fighter 1
export const BOT_HERO = "hero_wizard_01#0"; // Placeholder Wizard 1
export const CHALLENGE = "challenge_01#0"; // Placeholder Challenge
export const MODIFIER = "mod_02#0"; // Modifier +4
export const MAGIC = "magic_01#0"; // Placeholder Insight

export interface GameSetup {
  players: { id: string; name: string; isBot: boolean }[];
  /** Each player's hand, by card instance id, taken from the deck. Everyone else's hand is empty. */
  hands: Record<string, string[]>;
  /** The face-up monsters, by instance id. Default: the game's own. */
  monsters?: string[];
  config?: ConfigPatch;
}

/**
 * A game at the first player's first action, with the hands it names: the
 * first Seat goes first, leaders are dealt at random, and nobody rolls for
 * free on playing a hero, so a play is one Challenge Window and no more.
 */
export function newGame({ players, hands, monsters, config = {} }: GameSetup): GameState {
  const state = engine.createGame({
    players,
    seed: "client",
    config: { firstPlayerMethod: "firstSeat", startingHandSize: 0, freeRollOnHeroPlay: false, ...config },
  });
  for (const [player, cards] of Object.entries(hands)) {
    state.mainDeck = state.mainDeck.filter((c) => !cards.includes(c));
    state.players.find((p) => p.id === player)!.hand.push(...cards);
  }
  if (monsters) {
    const all = [...state.activeMonsters, ...state.monsterDeck];
    state.activeMonsters = monsters;
    state.monsterDeck = all.filter((m) => !monsters.includes(m)).sort();
  }
  return state;
}

/** Applies `actions` in order, failing on any the engine rejects. */
export function play(state: GameState, ...actions: Action[]): GameState {
  for (const action of actions) {
    const result = engine.applyAction(state, action);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  }
  return state;
}

export function viewOf(state: GameState, seat: string): Record<string, unknown> {
  return engine.getPlayerView(state, seat) as unknown as Record<string, unknown>;
}

/** The update Seat `seat` gets for `state`, with no events. */
export function update(state: GameState, seat: string, version: number): Extract<RoomMsg, { t: "update" }> {
  return { t: "update", version, events: [], view: viewOf(state, seat) };
}

/** Applies `action` to `state`, with the update Seat `seat` gets for it, events and all. */
export function step(state: GameState, action: Action, seat: string, version: number) {
  const result = engine.applyAction(state, action);
  if (!result.ok) throw new Error(result.error);
  const msg: Extract<RoomMsg, { t: "update" }> = {
    t: "update",
    version,
    events: engine.getPlayerEvents(result.events, seat) as unknown as Extract<RoomMsg, { t: "update" }>["events"],
    view: viewOf(result.state, seat),
  };
  return { state: result.state, msg };
}

export type { PlayerView };
