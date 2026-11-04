import { buildDeck, type CardDef, type CardType } from "@here-to-slay/cards";
import { resolveConfig } from "./config.js";
import { decisionOptions, openDecision, type DecisionResolver } from "./decisions.js";
import { createRng, nextInt, rollD6, shuffle, type RngState } from "./rng.js";
import type { CardInstanceId, FirstPlayerRoll, GameEvent, GameState, PlayerId, PlayerState } from "./types.js";

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

  // 2. Party Leaders: dealt at random in Seat order here, or drafted once setup is built.
  let leaderPool = ofTypes(["leader"]);
  if (leaderPool.length < players.length) {
    throw new Error(`There are ${leaderPool.length} Party Leaders, too few for ${players.length} players`);
  }
  let leaders: (CardInstanceId | null)[] = players.map(() => null);
  if (config.leaderSelection === "random") {
    [leaderPool, rng] = shuffle(leaderPool, rng);
    leaders = leaderPool.slice(0, players.length);
    leaderPool = leaderPool.slice(players.length);
  }
  // Leaders nobody has are out of the game; sorted so their order reveals nothing about the shuffle.
  leaderPool.sort();

  // 3. Shuffle the monster deck and reveal monsters.
  let monsterDeck: CardInstanceId[];
  [monsterDeck, rng] = shuffle(ofTypes(["monster"]), rng);
  const activeMonsters = monsterDeck.slice(0, config.activeMonsterCount);
  monsterDeck = monsterDeck.slice(config.activeMonsterCount);

  const playerStates: PlayerState[] = players.map((p, i) => ({
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    leader: leaders[i]!,
    hand: hands[i]!,
    party: [],
    slainMonsters: [],
  }));

  const state: GameState = {
    config,
    rng,
    cards,
    players: playerStates,
    turnOrder: [],
    activePlayer: players[0]!.id,
    actionPoints: config.actionPointsPerTurn,
    turnNumber: 1,
    mainDeck,
    discardPile: [],
    monsterDeck,
    activeMonsters,
    leaderPool,
    phase: { kind: "setup", step: "leaderSelect" },
    pendingDecision: null,
    nextDecisionId: 1,
    firstPlayerRolls: null,
    winner: null,
    winReason: null,
  };
  // createGame reports no events: the opening view shows everything they would.
  continueSetup(state, []);
  return state;
}

/**
 * Runs setup on from the leader draft: asks the next drafter, or, once every
 * player has a leader, chooses the first player and starts the first turn.
 */
export function continueSetup(state: GameState, events: GameEvent[]): void {
  const drafter = state.players.find((p) => p.leader === null);
  if (drafter) {
    state.activePlayer = drafter.id;
    openDecision(
      state,
      {
        player: drafter.id,
        kind: "chooseLeader",
        prompt: "Choose your Party Leader",
        options: decisionOptions(state, { cards: state.leaderPool }),
        discard: false,
      },
      events,
      leaderChosen,
    );
    return;
  }

  // 4. The first player; 5. turn order clockwise (Seat order) from them.
  const ids = state.players.map((p) => p.id);
  let first = 0;
  if (state.config.firstPlayerMethod === "random") {
    [first, state.rng] = nextInt(ids.length, state.rng);
  } else if (state.config.firstPlayerMethod === "roll") {
    let rounds: FirstPlayerRoll[][];
    let winner: PlayerId;
    [rounds, winner, state.rng] = rollForFirstPlayer(ids, state.rng);
    first = ids.indexOf(winner);
    state.firstPlayerRolls = rounds;
    events.push({ type: "FIRST_PLAYER_ROLLED", rounds, firstPlayer: winner });
  }
  state.turnOrder = [...ids.slice(first), ...ids.slice(0, first)];
  state.activePlayer = state.turnOrder[0]!;
  state.phase = { kind: "action" };
}

/** A drafter's pick: the leader leaves the pool, and setup runs on. */
export const leaderChosen: DecisionResolver = (state, decision, choice, events) => {
  // The draft never opens with an empty pool: createGame checks there are enough leaders.
  if (choice === null) throw new Error("No Party Leader left to draft");
  state.players.find((p) => p.id === decision.player)!.leader = choice;
  state.leaderPool = state.leaderPool.filter((id) => id !== choice);
  events.push({ type: "LEADER_CHOSEN", player: decision.player, leader: { id: choice, def: state.cards[choice]! } });
  continueSetup(state, events);
};

/**
 * Everyone rolls 2d6 at once, in Seat order; players tied for highest roll
 * again, until one is highest. Returns every round and who goes first. It
 * never opens a Modifier Window (§3.2).
 */
function rollForFirstPlayer(players: readonly PlayerId[], rng: RngState): [FirstPlayerRoll[][], PlayerId, RngState] {
  const rounds: FirstPlayerRoll[][] = [];
  let rolling = [...players];
  for (;;) {
    const round: FirstPlayerRoll[] = [];
    for (const player of rolling) {
      let a: number;
      let b: number;
      [a, rng] = rollD6(rng);
      [b, rng] = rollD6(rng);
      round.push({ player, dice: [a, b] });
    }
    rounds.push(round);
    const total = (r: FirstPlayerRoll) => r.dice[0] + r.dice[1];
    const best = Math.max(...round.map(total));
    rolling = round.filter((r) => total(r) === best).map((r) => r.player);
    if (rolling.length === 1) return [rounds, rolling[0]!, rng];
  }
}
