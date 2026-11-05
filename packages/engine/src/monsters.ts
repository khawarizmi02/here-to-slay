import type { MonsterDef, Requirement } from "@here-to-slay/cards";
import { playerState } from "./players.js";
import { heroClass } from "./selectors.js";
import { effectFrame, pushTriggers, runStack } from "./stack.js";
import type { CardIndex, CardInstanceId, GameEvent, GameState, PlayerId } from "./types.js";

/** The monster definition of a card instance, or undefined when it isn't a monster. */
export function monsterDef(defs: CardIndex, state: GameState, card: CardInstanceId): MonsterDef | undefined {
  const def = defs.get(state.cards[card] ?? "");
  return def?.type === "monster" ? def : undefined;
}

/**
 * Whether `player`'s party meets `requirement` (§5.3). Heroes count as their
 * Mask's class if they wear one, and the Party Leader counts as a hero of its
 * class (`leaderCountsForRequirements`).
 */
export function meetsRequirement(defs: CardIndex, state: GameState, player: PlayerId, requirement: Requirement): boolean {
  const p = playerState(state, player);
  const classes = p.party.map((h) => heroClass(defs, state, h.instanceId));
  const leader = p.leader === null ? undefined : defs.get(state.cards[p.leader]!);
  if (state.config.leaderCountsForRequirements && leader?.type === "leader") classes.push(leader.class);
  const meets = (r: Requirement): boolean => {
    switch (r.kind) {
      case "none":
        return true;
      case "heroCount":
        return classes.length >= r.min;
      case "classCount":
        return classes.filter((c) => c === r.class).length >= r.min;
      case "all":
        return r.of.every(meets);
    }
  };
  return meets(requirement);
}

/** The face-up monsters `player`'s party meets the requirement of, in slot order. */
export function attackableMonsters(defs: CardIndex, state: GameState, player: PlayerId): CardInstanceId[] {
  return state.activeMonsters.filter((m) => meetsRequirement(defs, state, player, monsterDef(defs, state, m)!.requirement));
}

/** ATTACK_MONSTER (§3.5): rolls 2d6 against `monster`. */
export function attackMonster(defs: CardIndex, state: GameState, player: PlayerId, monster: CardInstanceId, events: GameEvent[]): void {
  state.stack.push({ kind: "roll", rollId: `r${state.nextRollId++}`, roller: player, rollKind: "monsterAttack", monster, stage: "beforeRoll", total: null });
  runStack(defs, state, events);
}

/**
 * What a monster attack's final `total` does (§3.5): at or above the slay
 * value the monster is slain; at or below the defeat value its penalty goes
 * on the stack, run by the attacker; otherwise nothing.
 */
export function monsterAttackOutcome(def: MonsterDef, total: number): "slain" | "defeated" | "nothing" {
  if (total >= def.slayAt) return "slain";
  if (total <= def.defeatAt) return "defeated";
  return "nothing";
}

/** Pushes `monster`'s penalty, run as an effect controlled by `player`. */
export function pushPenalty(defs: CardIndex, state: GameState, player: PlayerId, monster: CardInstanceId): void {
  state.stack.push(effectFrame(monsterDef(defs, state, monster)!.penalty, player, player, monster));
}

/**
 * `player` slays `monster` (§3.5): it goes to their slain pile, so its reward
 * passive is theirs from now on, and the top of the monster deck takes its
 * slot. With the monster deck empty the slot stays empty. Then the player's
 * onMonsterSlain passives run, the new monster's included.
 */
export function slayMonster(defs: CardIndex, state: GameState, player: PlayerId, monster: CardInstanceId, events: GameEvent[]): void {
  const slot = state.activeMonsters.indexOf(monster);
  if (slot < 0) return;
  const next = state.monsterDeck.shift();
  if (next === undefined) state.activeMonsters.splice(slot, 1);
  else state.activeMonsters[slot] = next;
  playerState(state, player).slainMonsters.push(monster);
  events.push({ type: "MONSTER_SLAIN", player, monster: { id: monster, def: state.cards[monster]! } });
  if (next !== undefined) events.push({ type: "MONSTER_REVEALED", monster: { id: next, def: state.cards[next]! } });
  pushTriggers(defs, state, player, "onMonsterSlain");
}
