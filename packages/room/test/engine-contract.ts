import type { Action, PlayerId } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import type { RoomEngine } from "../src/index.js";

/*
 * The RoomEngine contract (ADR-0002): what the Room relies on from any
 * engine. It runs against the toy engine here, and against the real rules
 * engine once it exists, so the toy engine stays a faithful stand-in.
 *
 * The suite plays seeded random games, choosing among every player's legal
 * actions, and checks each property at every state it reaches.
 */

export interface RoomEngineContractOptions<State> {
  engine: RoomEngine<State>;
  /**
   * The ids of every card instance `viewer` must not see in `state`: other
   * players' hands, face-down decks and the like. A spectator sees no hand.
   */
  hiddenCards(state: State, viewer: PlayerId | "spectator"): string[];
  /** Seeds of the random games. Default: three seeds. */
  seeds?: string[];
  /** Player counts to play each seed at. Default: 2 and 4. */
  playerCounts?: number[];
  /** Actions per game before the suite stops playing it. Default: 200. */
  maxSteps?: number;
}

const SPECTATOR = "spectator";

/** The actions remembered from earlier states, to try as illegal actions later. */
const POOL_SIZE = 40;

export function describeRoomEngineContract<State>(name: string, opts: RoomEngineContractOptions<State>): void {
  const { engine, hiddenCards } = opts;
  const seeds = opts.seeds ?? ["contract-a", "contract-b", "contract-c"];
  const playerCounts = opts.playerCounts ?? [2, 4];
  const maxSteps = opts.maxSteps ?? 200;

  const games = seeds.flatMap((seed) => playerCounts.map((count) => ({ seed, count })));

  function newGame(seed: string, count: number): { state: State; players: PlayerId[] } {
    const players = Array.from({ length: count }, (_, i) => ({ id: `s${i + 1}`, name: `Player ${i + 1}`, isBot: false }));
    return { state: engine.createGame({ players, seed, config: {} }), players: players.map((p) => p.id) };
  }

  /** Plays one seeded random game, calling `check` on every state before its action. */
  function play(seed: string, count: number, check: (state: State, players: PlayerId[], pool: Action[]) => void): Action[] {
    const game = newGame(seed, count);
    const { players } = game;
    let { state } = game;
    const pick = seededRandom(`picker:${seed}:${count}`);
    const taken: Action[] = [];
    const pool: Action[] = [];
    for (let step = 0; step < maxSteps; step++) {
      check(state, players, pool);
      const legal = players.flatMap((p) => engine.getLegalActions(state, p));
      if (legal.length === 0) break;
      for (const a of legal) remember(pool, a);
      const action = legal[Math.floor(pick() * legal.length)]!;
      const r = engine.applyAction(state, action);
      expect(r.ok, `${JSON.stringify(action)} was legal but rejected: ${r.error}`).toBe(true);
      state = r.state;
      taken.push(action);
    }
    return taken;
  }

  describe(`RoomEngine contract: ${name}`, () => {
    it.each(games)("leaves the state unchanged when it rejects an action (seed $seed, $count players)", ({ seed, count }) => {
      play(seed, count, (state, players, pool) => {
        for (const player of players) {
          for (const action of illegalFor(engine, state, player, pool)) {
            const before = clone(state);
            const r = engine.applyAction(state, action);
            expect(r.ok, `${JSON.stringify(action)} is not legal but was accepted`).toBe(false);
            expect(r.error, "a rejection says why").toBeTruthy();
            expect(r.events).toEqual([]);
            expect(r.state).toEqual(before);
            expect(state, "a rejected action must not mutate the state").toEqual(before);
          }
        }
      });
    });

    it.each(games)("accepts an action if and only if it is legal (seed $seed, $count players)", ({ seed, count }) => {
      play(seed, count, (state, players, pool) => {
        for (const player of players) {
          for (const action of engine.getLegalActions(state, player)) {
            expect(action.player).toBe(player);
            const before = clone(state);
            const r = engine.applyAction(state, action);
            expect(r.ok, `${JSON.stringify(action)} is legal but was rejected: ${r.error}`).toBe(true);
            expect(state, "applying an action must not mutate the state it was given").toEqual(before);
          }
          for (const action of illegalFor(engine, state, player, pool)) {
            expect(engine.applyAction(state, action).ok, `${JSON.stringify(action)} is not legal but was accepted`).toBe(false);
          }
        }
      });
    });

    it.each(games)("offers only responses beside PASS in a Response Window (seed $seed, $count players)", ({ seed, count }) => {
      let windows = 0;
      play(seed, count, (state, players) => {
        for (const player of players) {
          const legal = engine.getLegalActions(state, player);
          if (!legal.some((a) => a.type === "PASS")) continue;
          windows++;
          for (const action of legal) {
            expect(["PASS", "PLAY_CHALLENGE", "PLAY_MODIFIER"], `${JSON.stringify(action)} beside PASS`).toContain(action.type);
          }
        }
      });
      expect(windows, "the game never opened a Response Window").toBeGreaterThan(0);
    });

    it.each(games)("puts legalActions in every PlayerView (seed $seed, $count players)", ({ seed, count }) => {
      play(seed, count, (state, players) => {
        for (const player of players) {
          const view = engine.getPlayerView(state, player);
          expect(view.legalActions).toEqual(engine.getLegalActions(state, player));
        }
        expect(engine.getPlayerView(state, SPECTATOR).legalActions).toEqual([]);
      });
    });

    it.each(games)("shows no hidden card in filtered events or views (seed $seed, $count players)", ({ seed, count }) => {
      const game = newGame(seed, count);
      const { players } = game;
      let { state } = game;
      const pick = seededRandom(`picker:${seed}:${count}`);
      const viewers: (PlayerId | "spectator")[] = [...players, SPECTATOR];
      let hiddenSeen = 0;
      const expectNoLeak = (viewer: PlayerId | "spectator", what: string, value: unknown) => {
        const json = JSON.stringify(value);
        for (const id of hiddenCards(state, viewer)) {
          hiddenSeen++;
          expect(json.includes(JSON.stringify(id)), `${what} for ${viewer} shows hidden card ${id}`).toBe(false);
        }
      };
      for (const viewer of viewers) expectNoLeak(viewer, "the first view", engine.getPlayerView(state, viewer));
      for (let step = 0; step < maxSteps; step++) {
        const legal = players.flatMap((p) => engine.getLegalActions(state, p));
        if (legal.length === 0) break;
        const r = engine.applyAction(state, legal[Math.floor(pick() * legal.length)]!);
        state = r.state;
        for (const viewer of viewers) {
          expectNoLeak(viewer, "the events", engine.getPlayerEvents(r.events, viewer));
          expectNoLeak(viewer, "the view", engine.getPlayerView(state, viewer));
        }
      }
      expect(hiddenSeen, "hiddenCards never named a card, so nothing was checked").toBeGreaterThan(0);
    });

    it.each(games)("gives the same state for one seed and one action list (seed $seed, $count players)", ({ seed, count }) => {
      const actions = play(seed, count, () => {});
      const replay = () => {
        let { state } = newGame(seed, count);
        const events: unknown[] = [];
        for (const action of actions) {
          const r = engine.applyAction(state, action);
          expect(r.ok).toBe(true);
          state = r.state;
          events.push(r.events);
        }
        return { state, events };
      };
      expect(replay()).toEqual(replay());
    });
  });
}

/**
 * Actions `player` may not take now: every action seen so far, and every
 * action another player may take now, made `player`'s, that is not among
 * `player`'s legal actions.
 */
function illegalFor<State>(engine: RoomEngine<State>, state: State, player: PlayerId, pool: readonly Action[]): Action[] {
  const legal = new Set(engine.getLegalActions(state, player).map(canonical));
  const candidates = [...pool, { type: "END_TURN", player } as const, { type: "PASS", player } as const];
  const out = new Map<string, Action>();
  for (const a of candidates) {
    const mine = { ...a, player };
    const key = canonical(mine);
    if (!legal.has(key)) out.set(key, mine);
  }
  return [...out.values()];
}

function remember(pool: Action[], action: Action): void {
  const key = canonical(action);
  if (pool.some((a) => canonical(a) === key)) return;
  pool.push(action);
  if (pool.length > POOL_SIZE) pool.shift();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Engine states are plain JSON (the Room saves and replays them), so a JSON round-trip is a faithful deep copy. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** mulberry32: the suite's own randomness, independent of any engine's RNG. */
function seededRandom(seed: string): () => number {
  let a = 0;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 2654435761);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
