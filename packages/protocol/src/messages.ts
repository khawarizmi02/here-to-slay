import { z } from "zod";
import { ActionSchema } from "./action.js";
import { PlayerNameSchema, RoomCodeSchema, SeatIdSchema, SeatKindSchema } from "./common.js";

// ---------------------------------------------------------------------------
// Seat → Room (TECHNICAL_DESIGN.md §10.4). The Room validates every one.
// ---------------------------------------------------------------------------

/** A rule-config override. RuleConfig is not built yet, so values are JSON primitives keyed by flag name. */
export const ConfigPatchSchema = z.record(
  z.string().min(1).max(64),
  z.union([z.boolean(), z.number(), z.string().max(64)]),
);
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

export const ClientMsgSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("joinRoom"), name: PlayerNameSchema }),
  /** Host only. */
  z.strictObject({ t: z.literal("addBot"), difficulty: z.enum(["easy", "normal"]) }),
  /** Host only. */
  z.strictObject({ t: z.literal("addLocalSeat"), name: PlayerNameSchema }),
  /** Host only, lobby only. */
  z.strictObject({ t: z.literal("setConfig"), config: ConfigPatchSchema }),
  /** Host only. */
  z.strictObject({ t: z.literal("startGame") }),
  /**
   * `action.player` is a claim the Room ignores: it sets the acting player
   * from `seat`, after checking the sender owns that Seat.
   */
  z.strictObject({
    t: z.literal("action"),
    seat: SeatIdSchema,
    action: ActionSchema,
    clientSeq: z.number().int().nonnegative(),
  }),
  z.strictObject({ t: z.literal("resync") }),
  z.strictObject({ t: z.literal("chat"), text: z.string().trim().min(1).max(500) }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;
export type ClientMsgType = ClientMsg["t"];

// ---------------------------------------------------------------------------
// Room → Seat
// ---------------------------------------------------------------------------

export const LobbySeatSchema = z.strictObject({
  id: SeatIdSchema,
  name: PlayerNameSchema,
  kind: SeatKindSchema,
  connected: z.boolean(),
});
export type LobbySeat = z.infer<typeof LobbySeatSchema>;

/**
 * A semantic engine event (CARD_DRAWN, DICE_ROLLED, …), already filtered for
 * the recipient. Only `type` is fixed here; the engine owns the rest.
 */
export const GameEventSchema = z.looseObject({ type: z.string().min(1) });
export type GameEvent = z.infer<typeof GameEventSchema>;

/** The recipient's redacted PlayerView. The engine owns its shape. */
export const PlayerViewSchema = z.record(z.string(), z.unknown());
export type PlayerViewPayload = z.infer<typeof PlayerViewSchema>;

export const RoomMsgSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("lobby"),
    roomCode: RoomCodeSchema,
    seats: z.array(LobbySeatSchema).max(6),
    /** The Seats that belong to the recipient (several for a hot-seat device). */
    you: z.array(SeatIdSchema),
  }),
  z.strictObject({
    t: z.literal("update"),
    /** Incremented on every state change; `events` describe `version - 1` → `version`. */
    version: z.number().int().nonnegative(),
    events: z.array(GameEventSchema),
    view: PlayerViewSchema,
  }),
  z.strictObject({
    t: z.literal("actionRejected"),
    clientSeq: z.number().int().nonnegative(),
    error: z.string().min(1),
  }),
  z.strictObject({ t: z.literal("hostAway") }),
  z.strictObject({ t: z.literal("error"), message: z.string().min(1) }),
]);
export type RoomMsg = z.infer<typeof RoomMsgSchema>;
export type RoomMsgType = RoomMsg["t"];
