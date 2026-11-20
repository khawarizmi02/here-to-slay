import type { GameEvent, PlayerViewPayload, SeatId } from "@here-to-slay/protocol";
import { RoomRecordSchema } from "./record.js";
import type { RoomEngine } from "./room.js";

/** A replay file refused, with a message for the player. */
export class ReplayError extends Error {
  override readonly name = "ReplayError";
}

/**
 * A replay file played back on this device (TECHNICAL_DESIGN.md §8.3): the
 * game at every step, from before the first action (step 0) to after the
 * last (step `length`). It never contacts the relay.
 */
export interface Replay {
  /** The players, in Seat order. */
  readonly players: readonly { id: SeatId; name: string }[];
  /** How many actions the game took. */
  readonly length: number;
  /** What `viewer` saw after `step` actions; a null viewer is a spectator. */
  viewAt(step: number, viewer: SeatId | null): PlayerViewPayload;
  /** The events of the first `step` actions, oldest first, as `viewer` saw them. */
  logAt(step: number, viewer: SeatId | null): GameEvent[];
}

/**
 * Opens the contents of a replay file, the Room's `replayFile()`, by playing
 * every action through `engine`. Throws a `ReplayError` if the contents
 * aren't a replay, were made with other card definitions, or don't play back.
 */
export function openReplay<State>(engine: RoomEngine<State>, contents: string): Replay {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    throw notAReplay();
  }
  const parsed = RoomRecordSchema.safeParse(json);
  if (!parsed.success) throw notAReplay();
  const record = parsed.data;
  if (record.cardDefsVersion !== engine.cardDefsVersion) {
    throw new ReplayError(
      `That replay was made with other card definitions (${record.cardDefsVersion}), so this version of the game can't play it back.`,
    );
  }

  const states: State[] = [];
  const events: GameEvent[][] = [];
  try {
    states.push(
      engine.createGame({
        players: record.seats.map((s) => ({ id: s.id, name: s.name, isBot: s.kind === "bot" })),
        seed: record.seed,
        config: { ...record.config },
      }),
    );
  } catch {
    throw new ReplayError("That replay doesn't play back: its game can't be set up.");
  }
  record.actions.forEach((action, i) => {
    const result = engine.applyAction(states[i]!, action);
    if (!result.ok) throw new ReplayError(`That replay doesn't play back: its action ${i + 1} is illegal.`);
    states.push(result.state);
    events.push(result.events);
  });

  const at = (step: number) => Math.max(0, Math.min(record.actions.length, Math.trunc(step)));
  return {
    players: record.seats.map((s) => ({ id: s.id, name: s.name })),
    length: record.actions.length,
    viewAt: (step, viewer) => engine.getPlayerView(states[at(step)]!, viewer ?? "spectator"),
    logAt: (step, viewer) => engine.getPlayerEvents(events.slice(0, at(step)).flat(), viewer ?? "spectator"),
  };
}

function notAReplay(): ReplayError {
  return new ReplayError("That file isn't a Here to Slay replay.");
}
