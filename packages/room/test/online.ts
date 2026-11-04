import type { Action } from "@here-to-slay/protocol";
import type * as toy from "@here-to-slay/toy-engine";
import { MemoryActionLogStore, RelayConnection, Room, type Bot, type RoomEngine, type RoomOptions } from "../src/index.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, fixedDeck, viewOf } from "./harness.js";

// A started game with remote Seats over a fake relay. Hands are dealt with
// `handSize: 2`, in Seat order, from the top of a fixed deck. Seat ids are
// s1 (Alice, the Host), s2, s3, …

/** What a test writes as an action's `player`: the Room ignores it. */
export const player = "ignored-by-room";

export interface Options {
  /** Names of the Seats after the Host's, in Seat order: "bot" adds a bot, anything else a friend. */
  seats: string[];
  deck: toy.ToyCardDefId[];
  config?: Record<string, number>;
  random?: () => number;
  bot?: Bot;
  store?: MemoryActionLogStore;
  engine?: RoomEngine<toy.GameState>;
}

/** A started game with remote Seats over a fake relay, on a fake clock whose timers fire only when asked. */
export async function online(opts: Options) {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const relay = new FakeRelay();
  const { roomCode, hostToken } = relay.createRoom();
  const roomOptions: RoomOptions<toy.GameState> = {
    engine: opts.engine ?? fixedDeck(opts.deck),
    clock,
    timers,
    random: opts.random ?? (() => 0.5),
    hostName: "Alice",
    roomCode,
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.bot ? { bot: () => opts.bot! } : {}),
  };
  const room = new Room(roomOptions);
  room.attachRelay(relay.connectHost(roomCode, hostToken));
  const host = new Client(room.hostConnection);
  const clients = new Map<string, Client>([["Alice", host]]);
  for (const name of opts.seats) {
    if (name === "bot") {
      host.send({ t: "addBot", difficulty: "easy" });
      continue;
    }
    clients.set(name, new Client(await RelayConnection.join({ dialer: relay.dialer, roomCode, name })));
    await settle();
  }
  host.send({ t: "setConfig", config: { handSize: 2, ...opts.config } });
  host.send({ t: "startGame" });
  await settle();

  const seat = (name: string) => `s${["Alice", ...opts.seats].indexOf(name) + 1}`;
  const client = (name: string) => clients.get(name)!;
  let clientSeq = 0;
  const act = async (name: string, action: { type: Action["type"]; [field: string]: unknown }) => {
    client(name).send({ t: "action", seat: seat(name), action: { ...action, player } as Action, clientSeq: clientSeq++ });
    await settle();
  };
  /** The game as the Host sees it. */
  const view = () => viewOf(host.last("update"));
  /** Time passes, but the Room's own timers don't fire: a background tab. */
  const elapse = (ms: number) => clock.advance(ms);
  /** Time passes and the Room's own timers fire. */
  const wait = async (ms: number) => {
    clock.advance(ms);
    timers.fireDue();
    await settle();
  };
  const tick = async () => {
    relay.tick(roomCode);
    await settle();
  };
  return { room, relay, roomCode, clock, timers, host, seat, client, act, view, elapse, wait, tick };
}
