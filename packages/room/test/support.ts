import { RoomMsgSchema, type Action, type RoomMsg, type SeatId } from "@here-to-slay/protocol";
import * as toy from "@here-to-slay/toy-engine";
import { createRng, nextFloat, type GameEvent, type GameState, type PlayerView, type ToyConfig } from "@here-to-slay/toy-engine";
import { expect } from "vitest";
import { Room, type Clock, type GameConnection, type RandomSource, type RoomEngine, type RoomOptions } from "../src/index.js";

/** The toy engine, adapted to the Room's engine interface. */
export const toyEngine: RoomEngine<GameState, GameEvent> = {
  createGame: ({ players, seed, config }) => toy.createGame({ players, seed, config: config as Partial<ToyConfig> }),
  applyAction: toy.applyAction,
  getPlayerView: toy.getPlayerView,
  getPlayerEvents: toy.getPlayerEvents,
};

export class FakeClock implements Clock {
  constructor(private time = 1_000_000) {}
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

export function seededRandom(seed: string): RandomSource {
  let rng = createRng(seed);
  return () => {
    let f: number;
    [f, rng] = nextFloat(rng);
    return f;
  };
}

export function makeRoom(overrides: Partial<RoomOptions<GameState, GameEvent>> = {}): Room<GameState, GameEvent> {
  return new Room({
    engine: toyEngine,
    roomCode: "ABC23",
    hostName: "Alice",
    clock: new FakeClock(),
    random: seededRandom("room"),
    seed: "game-seed",
    ...overrides,
  });
}

/** Records everything a connection receives, and checks it against the protocol schema. */
export class Recorder {
  readonly messages: RoomMsg[] = [];

  constructor(readonly conn: GameConnection) {
    conn.onMessage((msg) => {
      expect(RoomMsgSchema.safeParse(msg).success, `invalid RoomMsg ${JSON.stringify(msg)}`).toBe(true);
      this.messages.push(msg);
    });
  }

  of<T extends RoomMsg["t"]>(t: T): Extract<RoomMsg, { t: T }>[] {
    return this.messages.filter((m): m is Extract<RoomMsg, { t: T }> => m.t === t);
  }

  get updates() {
    return this.of("update");
  }

  get lastUpdate() {
    return this.updates.at(-1);
  }

  get view(): PlayerView {
    const last = this.lastUpdate;
    if (!last) throw new Error("No update received yet");
    return last.view as unknown as PlayerView;
  }

  get lastLobby() {
    return this.of("lobby").at(-1);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/**
 * A simple hot-seat player: decides from its own view only. Returns the
 * action for `seat`, or undefined if that Seat has nothing to do.
 */
export function chooseAction(view: PlayerView, seat: SeatId): Action | undefined {
  switch (view.phase) {
    case "action": {
      if (view.activePlayer !== seat) return undefined;
      const card = view.hand.find((c) => c.def !== "challenge");
      if (card) return { type: "PLAY_HERO", player: seat, card: card.id };
      return { type: "DRAW_CARD", player: seat };
    }
    case "responseWindow":
      return view.responseWindow?.awaiting.includes(seat) ? { type: "PASS", player: seat } : undefined;
    case "decision": {
      const d = view.pendingDecision;
      if (!d || !("id" in d) || d.player !== seat) return undefined;
      return { type: "RESOLVE_DECISION", player: seat, decisionId: d.id, answer: { selected: [d.options[0]!.id] } };
    }
    case "gameOver":
      return undefined;
  }
}
