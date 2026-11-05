import type { HeroDef } from "@here-to-slay/cards";
import { playerState } from "./players.js";
import { heroClass } from "./selectors.js";
import { pushTriggers, runStack } from "./stack.js";
import type { CardIndex, CardInstanceId, GameEvent, GameState, PlayerId } from "./types.js";

/** The hero definition of a card instance, or undefined when it isn't a hero. */
export function heroDef(defs: CardIndex, state: GameState, card: CardInstanceId): HeroDef | undefined {
  const def = defs.get(state.cards[card] ?? "");
  return def?.type === "hero" ? def : undefined;
}

/** The heroes in `player`'s hand they can play, by instance id. */
export function playableHeroes(defs: CardIndex, state: GameState, player: PlayerId): CardInstanceId[] {
  return playerState(state, player)
    .hand.filter((c) => heroDef(defs, state, c) !== undefined)
    .sort();
}

/** The heroes in `player`'s party that haven't attempted a roll this turn (§3.5), in party order. */
export function rollableHeroes(state: GameState, player: PlayerId): CardInstanceId[] {
  return playerState(state, player)
    .party.filter((h) => !h.rolledThisTurn)
    .map((h) => h.instanceId);
}

/**
 * A played hero that got through its Challenge Window enters the party
 * (§3.5), and the player's onHeroEnterParty passives run. With
 * `freeRollOnHeroPlay`, the player is then offered the hero's roll for
 * free. Their onCardPlayed passives run last.
 */
export function heroEntersParty(defs: CardIndex, state: GameState, player: PlayerId, card: CardInstanceId, events: GameEvent[]): void {
  playerState(state, player).party.push({ instanceId: card, equippedItem: null, rolledThisTurn: false });
  events.push({ type: "HERO_PLAYED", player, card: { id: card, def: state.cards[card]! } });
  pushTriggers(defs, state, player, "onCardPlayed", { action: "PLAY_HERO" });
  if (state.config.freeRollOnHeroPlay) {
    state.stack.push({ kind: "freeRoll", player, hero: card, bindings: {}, awaiting: null });
  }
  pushTriggers(defs, state, player, "onHeroEnterParty", { heroClass: heroClass(defs, state, card) });
}

/** ROLL_HERO_EFFECT (§3.5): uses up the hero's roll for this turn, then rolls. */
export function rollHeroEffect(defs: CardIndex, state: GameState, player: PlayerId, hero: CardInstanceId, events: GameEvent[]): void {
  startHeroRoll(state, player, hero);
  runStack(defs, state, events);
}

/** Marks `hero`'s roll used and pushes the roll. */
export function startHeroRoll(state: GameState, player: PlayerId, hero: CardInstanceId): void {
  const inParty = playerState(state, player).party.find((h) => h.instanceId === hero);
  if (inParty) inParty.rolledThisTurn = true;
  state.stack.push({ kind: "roll", rollId: `r${state.nextRollId++}`, roller: player, rollKind: "heroEffect", hero, stage: "beforeRoll" });
}
