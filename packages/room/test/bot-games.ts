import { placeholderCardDefs } from "@here-to-slay/cards";
import { botFactory, createEasyBot, createRoomEngine, type GameState, type PlayerView } from "@here-to-slay/engine";
import type { Action, RoomMsg } from "@here-to-slay/protocol";
import { describe, expect, inject, it } from "vitest";
import { Room, type BotFactory } from "../src/index.js";
import { FakeClock, FakeTimers, latestPrompt, seededRandom } from "./harness.js";

/*
 * Games through the Room on the real engine, with easy bots in every Seat but
 * the Host's (TECHNICAL_DESIGN.md §14, M6). Whatever plays the Host's Seat
 * sends its actions through the Host's connection, as the UI would.
 */

/**
 * A game that hasn't ended after this many actions fails. As in the engine's
 * fuzz games (TECHNICAL_DESIGN.md §13.1), PASSes don't count: every roll opens
 * a Modifier Window that every Seat passes. Easy bots sometimes stalemate:
 * over 1,000 games the longest takes over 5,000 actions.
 */
export const ACTION_CAP = 10_000;

/** How the Host's Seat picks its action from its own view. */
export type HostPolicy = (view: PlayerView, legal: Action[]) => Action;

const engine = createRoomEngine(placeholderCardDefs);

/** The last message of type `t` in `msgs`. */
function lastOf<T extends RoomMsg["t"]>(msgs: readonly RoomMsg[], t: T): Extract<RoomMsg, { t: T }> | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.t === t) return msgs[i] as Extract<RoomMsg, { t: T }>;
  return undefined;
}

/**
 * Plays the game `seed` makes to game over: the Host's Seat by `host`, and
 * three bot Seats by easy bots. `actions` counts every Seat's actions but
 * PASSes. Throws, naming the seed, if it stalls or reaches `ACTION_CAP`. A
 * bot that fails throws out of the Room.
 */
export function playBotGame(seed: string, host: HostPolicy): { view: PlayerView; actions: number; botMoves: number } {
  const clock = new FakeClock();
  const easyBots = botFactory(placeholderCardDefs, seededRandom(`bots-${seed}`));
  let botMoves = 0;
  let actions = 0;
  const bot: BotFactory = (seat) => {
    const easy = easyBots(seat);
    return {
      chooseAction: (view, legal) => {
        botMoves++;
        const action = easy.chooseAction(view, legal);
        if (action.type !== "PASS") actions++;
        // The bots may play on among themselves without the Host's Seat ever moving: the Room reports this error.
        if (actions > ACTION_CAP) throw new Error(`Game ${seed} didn't end within ${ACTION_CAP} actions`);
        return action;
      },
    };
  };
  const room = new Room<GameState>({ engine, clock, timers: new FakeTimers(clock), random: seededRandom(`room-${seed}`), hostName: "Alice", bot });

  const inbox: RoomMsg[] = [];
  room.hostConnection.onMessage((msg) => inbox.push(msg));
  const take = () => inbox.splice(0);
  const send = room.hostConnection.send.bind(room.hostConnection);
  for (let i = 0; i < 3; i++) send({ t: "addBot", difficulty: "easy" });
  const alice = lastOf(inbox, "lobby")!.you[0]!;
  send({ t: "startGame" });

  let msgs = take();
  let view = lastOf(msgs, "update")!.view as PlayerView;
  let prompt = latestPrompt(msgs);
  let clientSeq = 0;
  while (view.phase.kind !== "gameOver") {
    if (actions >= ACTION_CAP) throw new Error(`Game ${seed} didn't end within ${ACTION_CAP} actions`);
    // Bots move straight away, so whenever the Room settles, the Host's Seat has something to do.
    if (view.legalActions.length === 0) throw new Error(`Game ${seed} stalled in ${view.phase.kind} on ${view.activePlayer}'s turn`);
    // Asked to respond with a Challenge in hand, the Host first confirms they have the device.
    if (prompt?.t === "passDevice") send({ t: "confirmPassDevice", seat: alice });
    take();
    const action = host(view, view.legalActions);
    if (action.type !== "PASS") actions++;
    send({ t: "action", seat: alice, action, clientSeq: clientSeq++ });
    msgs = take();
    const update = lastOf(msgs, "update");
    if (!update) throw new Error(`Game ${seed}: the Host's action didn't change the game: ${JSON.stringify(msgs)}`);
    view = update.view as PlayerView;
    prompt = latestPrompt(msgs);
  }
  return { view, actions, botMoves };
}

/** The Host's Seat played by an easy bot too: an all-bot game. */
export function easyHost(seed: string): HostPolicy {
  const bot = createEasyBot(placeholderCardDefs, seededRandom(`host-${seed}`));
  return (view, legal) => bot.chooseAction(view, legal);
}

declare module "vitest" {
  export interface ProvidedContext {
    /** How many seeded all-bot games to play: a sample in `pnpm test`, 1,000 in `pnpm bot-games`. */
    botGames: number;
  }
}

/** The all-bot games are split across this many test files, so they run in parallel. */
export const BOT_GAME_SHARDS = 4;

/** Shard `shard` of the seeded all-bot games: each must reach game over with no errors. */
export function describeBotGameShard(shard: number): void {
  if (!Number.isInteger(shard) || shard < 0 || shard >= BOT_GAME_SHARDS) throw new Error(`There is no all-bot game shard ${shard} of ${BOT_GAME_SHARDS}`);
  const games = inject("botGames");
  if (!Number.isInteger(games) || games < 1) throw new Error(`The Vitest config must provide botGames, the number of games to play, not ${String(games)}`);
  const seeds = Array.from({ length: games }, (_, i) => i).filter((i) => i % BOT_GAME_SHARDS === shard);
  describe(`all-bot games through the Room, shard ${shard + 1} of ${BOT_GAME_SHARDS}`, () => {
    it(`${seeds.length} seeded games of an easy-bot Host and three easy bots each end in a win within ${ACTION_CAP} actions`, { timeout: 600_000 }, () => {
      const failures: string[] = [];
      for (const i of seeds) {
        const seed = `all-bots-${i}`;
        try {
          playBotGame(seed, easyHost(seed));
        } catch (e) {
          failures.push(e instanceof Error && e.message.includes(seed) ? e.message : `Game ${seed}: ${String(e)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  });
}
