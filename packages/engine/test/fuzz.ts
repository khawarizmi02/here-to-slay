import { placeholderCardDefs } from "@here-to-slay/cards";
import type { ConfigPatch } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { createRng, createRoomEngine, nextInt, type Action, type ApplyResult, type CardIndex, type CardInstanceId, type GameState, type RngState } from "../src/index.js";
import { players } from "./cards.js";

/** A game that hasn't ended after this many actions fails (TECHNICAL_DESIGN.md §13.1). The engine has no draw rule. */
export const ACTION_CAP = 5_000;

/** The fuzz policy (§13.1): a random legal action, and END_TURN only when nothing else is legal. */
export function fuzzAction(legal: readonly Action[], rng: RngState): [Action, RngState] {
  const others = legal.filter((a) => a.type !== "END_TURN");
  const pool = others.length > 0 ? others : legal;
  const [i, next] = nextInt(pool.length, rng);
  return [pool[i]!, next];
}

/** Every card instance where it is now, one entry per zone it sits in: a card in two zones appears twice. */
function cardsInZones(state: GameState): CardInstanceId[] {
  const cards = [...state.mainDeck, ...state.discardPile, ...state.monsterDeck, ...state.activeMonsters, ...state.leaderPool];
  for (const p of state.players) {
    if (p.leader !== null) cards.push(p.leader);
    cards.push(...p.hand, ...p.slainMonsters);
    for (const hero of p.party) {
      cards.push(hero.instanceId);
      if (hero.equippedItem !== null) cards.push(hero.equippedItem);
    }
  }
  // A Magic card is in no zone while it resolves: its frame holds it.
  for (const frame of state.stack) if (frame.kind === "magic") cards.push(frame.card);
  return cards;
}

/**
 * The §13.1 invariants about a single state. Returns what is wrong, or an
 * empty list. `cardCount` is the number of cards the game started with. The
 * rest of §13.1 is about play, so `fuzzGame` checks it: every legal action is
 * accepted, and the game ends within the action cap.
 */
export function stateViolations(defs: CardIndex, state: GameState, cardCount: number): string[] {
  const problems: string[] = [];

  const instances = Object.keys(state.cards);
  if (instances.length !== cardCount) problems.push(`the game has ${instances.length} cards, not ${cardCount}`);
  const seen = new Map<CardInstanceId, number>();
  for (const card of cardsInZones(state)) seen.set(card, (seen.get(card) ?? 0) + 1);
  for (const card of instances) {
    const n = seen.get(card) ?? 0;
    if (n !== 1) problems.push(`${card} is in ${n} zones`);
  }
  for (const card of seen.keys()) if (!(card in state.cards)) problems.push(`${card} is in a zone but isn't a card of the game`);

  const max = state.config.actionPointsPerTurn;
  if (!Number.isInteger(state.actionPoints) || state.actionPoints < 0 || state.actionPoints > max) {
    problems.push(`actionPoints is ${state.actionPoints}, outside 0–${max}`);
  }

  // A hero has one item slot, so it holds at most one; the zone count above catches an item on two heroes.
  for (const hero of state.players.flatMap((p) => p.party)) {
    const item = hero.equippedItem;
    const type = item === null ? undefined : defs.get(state.cards[item]!)?.type;
    if (item !== null && type !== "item" && type !== "cursedItem") problems.push(`${hero.instanceId} holds ${item}, which isn't an item`);
  }

  if (state.winner !== null && state.phase.kind !== "gameOver") problems.push(`${state.winner} won but the phase is ${state.phase.kind}`);
  if (state.phase.kind === "gameOver" && state.winner === null) problems.push("the game is over with no winner");
  return problems;
}

export interface FuzzResult {
  seed: string;
  actions: number;
  state: GameState;
  /** Why the game failed, naming its seed; null when it reached a win with every invariant holding. */
  failure: string | null;
}

const FUZZ_DEFS: CardIndex = new Map(placeholderCardDefs.map((d) => [d.id, d]));
const engine = createRoomEngine(placeholderCardDefs);

/**
 * Plays one seeded game of the placeholder set with the fuzz policy for
 * everyone, checking every §13.1 invariant after every action: each player's
 * every legal action is applied, and the one the policy picks is played. A
 * game still going after `cap` actions fails.
 */
export function fuzzGame(seed: string, playerCount: number, config: ConfigPatch = {}, cap = ACTION_CAP): FuzzResult {
  let state = engine.createGame({ players: players(playerCount), seed, config });
  const cardCount = Object.keys(state.cards).length;
  let rng = createRng(`fuzz-policy:${seed}`);
  let actions = 0;
  const fail = (why: string): FuzzResult => ({ seed, actions, state, failure: `seed "${seed}", after ${actions} actions: ${why}` });

  try {
    for (let last: Action | null = null; ; actions++) {
      const problems = stateViolations(FUZZ_DEFS, state, cardCount);
      if (problems.length > 0) return fail(`${last ? `after ${JSON.stringify(last)}: ` : ""}${problems.join("; ")}`);

      const results = new Map<Action, ApplyResult>();
      for (const p of state.players) {
        for (const action of engine.getLegalActions(state, p.id)) {
          const r = engine.applyAction(state, action);
          if (!r.ok) return fail(`legal ${JSON.stringify(action)} was rejected: ${r.error}`);
          results.set(action, r);
        }
      }

      if (state.phase.kind === "gameOver") return { seed, actions, state, failure: null };
      if (actions >= cap) return fail(`no winner within ${cap} actions`);
      // Without Response Windows (M3), one player at a time has something to do.
      const legal = [...results.keys()];
      const actors = new Set(legal.map((a) => a.player));
      if (actors.size === 0) return fail("nobody has a legal action");
      if (actors.size > 1) return fail(`${[...actors].join(", ")} all have legal actions at once`);
      [last, rng] = fuzzAction(legal, rng);
      state = results.get(last)!.state;
    }
  } catch (error) {
    return fail(`the engine threw: ${error instanceof Error ? error.stack : String(error)}`);
  }
}

/** M2 acceptance (§14): this many seeded games, every one ending in a win with every invariant holding. */
export const FUZZ_GAMES = 1_000;
/** The games are split over this many test files, fuzz-games-1 to -N, so the test runner plays them in parallel. Change both together. */
export const FUZZ_SHARDS = 4;

/**
 * The rules game `i` is played under: rule flags drawn from its own seed, so
 * the invariants are checked away from the defaults too. The discard pile is
 * always reshuffled: without that, once the deck and every hand run dry,
 * players can only end their turns and the game never ends.
 */
export function fuzzConfig(i: number): ConfigPatch {
  let rng = createRng(`fuzz-config:${i}`);
  const pick = <T>(options: readonly T[]): T => {
    let n: number;
    [n, rng] = nextInt(options.length, rng);
    return options[n]!;
  };
  return {
    leaderSelection: pick(["random", "draft"] as const),
    firstPlayerMethod: pick(["roll", "random", "firstSeat"] as const),
    winCheckTiming: pick(["immediate", "endOfAction"] as const),
    drawAtStartOfTurn: pick([false, true]),
    freeRollOnHeroPlay: pick([true, false]),
    rollFlagFollowsHero: pick([true, false]),
    itemFollowsStolenHero: pick([true, false]),
    leaderCountsForRequirements: pick([true, false]),
  };
}

/** Defines the test for shard `shard` of the fuzz games: every seed `fuzz-<i>` with `i % FUZZ_SHARDS === shard`. */
export function describeFuzzShard(shard: number): void {
  if (!Number.isInteger(shard) || shard < 0 || shard >= FUZZ_SHARDS) throw new Error(`There is no fuzz shard ${shard} of ${FUZZ_SHARDS}`);
  const seeds = Array.from({ length: FUZZ_GAMES }, (_, i) => i).filter((i) => i % FUZZ_SHARDS === shard);
  describe(`fuzz games, shard ${shard + 1} of ${FUZZ_SHARDS}`, () => {
    it(`${seeds.length} seeded games of 2–6 players each end in a win within ${ACTION_CAP} actions, every invariant holding`, { timeout: 600_000 }, () => {
      const failures: string[] = [];
      const reasons = new Set<string>();
      for (const i of seeds) {
        // Every player count in every shard.
        const result = fuzzGame(`fuzz-${i}`, 2 + (Math.floor(i / FUZZ_SHARDS) % 5), fuzzConfig(i));
        if (result.failure !== null) failures.push(result.failure);
        else reasons.add(result.state.winReason!);
      }
      expect(failures).toEqual([]);
      // Random play reaches both kinds of win, so neither went untested.
      expect([...reasons].sort()).toEqual(["classes", "monsters"]);
    });
  });
}
