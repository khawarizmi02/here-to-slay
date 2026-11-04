import { buildDeck, type CardDef, type CardType } from "@here-to-slay/cards";
import { resolveConfig } from "./config.js";
import { createRng, nextInt, shuffle } from "./rng.js";
import type { CardInstanceId, GameState, PlayerId, PlayerState } from "./types.js";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

const MAIN_DECK_TYPES: readonly CardType[] = ["hero", "item", "cursedItem", "magic", "modifier", "challenge"];

export interface CreateGameOptions {
  players: { id: PlayerId; name: string; isBot: boolean }[];
  seed: string;
  /** Checked against the strict rule-config schema; throws on an unknown key or a wrong type. */
  config?: unknown;
  cardDefs: readonly CardDef[];
}

/** Sets up a new game (TECHNICAL_DESIGN.md §3.2). Throws on players, config or cards it can't start with. */
export function createGame(opts: CreateGameOptions): GameState {
  const { players, seed, cardDefs } = opts;
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`A game needs ${MIN_PLAYERS}–${MAX_PLAYERS} players, got ${players.length}`);
  }
  if (new Set(players.map((p) => p.id)).size !== players.length) throw new Error("Player ids must be unique");

  const config = resolveConfig(opts.config ?? {});
  // These arrive with the first Decisions and the first-player roll.
  if (config.leaderSelection === "draft") throw new Error('leaderSelection "draft" is not supported yet');
  if (config.firstPlayerMethod === "roll") throw new Error('firstPlayerMethod "roll" is not supported yet');

  const instances = buildDeck(cardDefs);
  const typeOf = new Map(cardDefs.map((d) => [d.id, d.type]));
  const cards: Record<CardInstanceId, string> = {};
  for (const c of instances) cards[c.instanceId] = c.defId;
  const ofTypes = (types: readonly CardType[]) =>
    instances.filter((c) => types.includes(typeOf.get(c.defId)!)).map((c) => c.instanceId);

  let rng = createRng(seed);

  // 1. Shuffle the main deck and deal.
  let mainDeck: CardInstanceId[];
  [mainDeck, rng] = shuffle(ofTypes(MAIN_DECK_TYPES), rng);
  const dealt = players.length * config.startingHandSize;
  if (mainDeck.length < dealt) {
    throw new Error(`The main deck has ${mainDeck.length} cards, too few to deal ${config.startingHandSize} to ${players.length} players`);
  }
  const hands = players.map((_, i) => mainDeck.slice(i * config.startingHandSize, (i + 1) * config.startingHandSize));
  mainDeck = mainDeck.slice(dealt);

  // 2. Random Party Leaders, in Seat order.
  let leaderPool: CardInstanceId[];
  [leaderPool, rng] = shuffle(ofTypes(["leader"]), rng);
  if (leaderPool.length < players.length) {
    throw new Error(`There are ${leaderPool.length} Party Leaders, too few for ${players.length} players`);
  }
  const leaders = leaderPool.slice(0, players.length);
  // Unused leaders leave the game; sorted so their order reveals nothing about the shuffle.
  leaderPool = leaderPool.slice(players.length).sort();

  // 3. Shuffle the monster deck and reveal monsters.
  let monsterDeck: CardInstanceId[];
  [monsterDeck, rng] = shuffle(ofTypes(["monster"]), rng);
  const activeMonsters = monsterDeck.slice(0, config.activeMonsterCount);
  monsterDeck = monsterDeck.slice(config.activeMonsterCount);

  // 4. The first player; 5. turn order clockwise (Seat order) from them.
  let first = 0;
  if (config.firstPlayerMethod === "random") [first, rng] = nextInt(players.length, rng);
  const ids = players.map((p) => p.id);
  const turnOrder = [...ids.slice(first), ...ids.slice(0, first)];

  const playerStates: PlayerState[] = players.map((p, i) => ({
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    leader: leaders[i]!,
    hand: hands[i]!,
    party: [],
    slainMonsters: [],
  }));

  return {
    config,
    rng,
    cards,
    players: playerStates,
    turnOrder,
    activePlayer: turnOrder[0]!,
    actionPoints: config.actionPointsPerTurn,
    turnNumber: 1,
    mainDeck,
    discardPile: [],
    monsterDeck,
    activeMonsters,
    leaderPool,
    phase: { kind: "action" },
    winner: null,
    winReason: null,
  };
}
