import { ActionSchema, ConfigPatchSchema, PlayerNameSchema, RoomCodeSchema, SeatIdSchema, SeatTokenSchema } from "@here-to-slay/protocol";
import { z } from "zod";

/**
 * Everything needed to rebuild a game by replaying it (TECHNICAL_DESIGN.md
 * §8.3, §10.7). The Room saves one after every applied action, and the same
 * record is the replay file the Host can download at game over.
 *
 * `actions` holds every applied action in order, with `player` set to the
 * Seat that acted. Rejected actions are never in it.
 */
export const RoomRecordSchema = z.strictObject({
  roomCode: RoomCodeSchema,
  seed: z.string().min(1).max(128),
  config: ConfigPatchSchema,
  /** In Seat order; the first Seat is the Host's. */
  seats: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ id: SeatIdSchema, name: PlayerNameSchema, kind: z.literal("local") }),
        z.strictObject({
          id: SeatIdSchema,
          name: PlayerNameSchema,
          kind: z.literal("bot"),
          difficulty: z.enum(["easy", "normal"]),
        }),
        /**
         * A friend's Seat. Their seat token lets them reclaim it after the Host
         * refreshes; the downloadable replay leaves it out.
         */
        z.strictObject({ id: SeatIdSchema, name: PlayerNameSchema, kind: z.literal("remote"), seatToken: SeatTokenSchema.optional() }),
      ]),
    )
    .min(1)
    .max(6),
  /** The engine's card-definitions version; a replay only reproduces the game under the same one. */
  cardDefsVersion: z.string().min(1).max(64),
  actions: z.array(ActionSchema),
});
export type RoomRecord = z.infer<typeof RoomRecordSchema>;
export type RecordSeat = RoomRecord["seats"][number];

/**
 * Where the Room keeps its record. Production uses IndexedDB; tests use
 * memory. Saves must land in the order they were made.
 */
export interface ActionLogStore {
  /** Replaces any earlier record for the same Room Code. */
  save(record: RoomRecord): Promise<void>;
  /** The latest record saved for `roomCode`, or null if there is none. */
  load(roomCode: string): Promise<RoomRecord | null>;
}

/** Keeps records in memory, for tests. */
export class MemoryActionLogStore implements ActionLogStore {
  readonly #records = new Map<string, string>();

  save(record: RoomRecord): Promise<void> {
    this.#records.set(record.roomCode, JSON.stringify(record));
    return Promise.resolve();
  }

  load(roomCode: string): Promise<RoomRecord | null> {
    const json = this.#records.get(roomCode);
    return Promise.resolve(json === undefined ? null : (JSON.parse(json) as RoomRecord));
  }
}
