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
  /**
   * Local Seats only: the player the Room asked to respond (`passDevice`)
   * has the device and is ready to see their response options.
   */
  z.strictObject({ t: z.literal("confirmPassDevice"), seat: SeatIdSchema }),
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
    /** The recipient's Seat. Each connection belongs to one Seat, so a hot-seat device holds one connection per local Seat. */
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
  /** The Host is disconnected: show "Waiting for Host…". Nothing happens until `hostBack`. */
  z.strictObject({ t: z.literal("hostAway") }),
  /** The Host is back. A fresh `update` follows, rebuilt from the Host's saved log. */
  z.strictObject({ t: z.literal("hostBack") }),
  /** The Host was away too long and the Room has closed; the connection is closed after this. */
  z.strictObject({ t: z.literal("roomClosed") }),
  z.strictObject({ t: z.literal("error"), message: z.string().min(1) }),
  /**
   * To a local Seat the Room interrupts in a response window: show "Pass the
   * device to <name>", with no countdown, until the player sends `confirmPassDevice`.
   */
  z.strictObject({ t: z.literal("passDevice"), seat: SeatIdSchema, name: PlayerNameSchema }),
  /** To a local Seat that confirmed it has the device: its response options, PASS among them. */
  z.strictObject({ t: z.literal("respond"), seat: SeatIdSchema, actions: z.array(ActionSchema).min(1).max(64) }),
  /**
   * To a remote Seat asked to respond that holds a usable card, or that has a
   * decision to answer: show a countdown of `ms` milliseconds, after which
   * the Room passes or answers for it. Sent again after every update while
   * it stands. A remote Seat holding nothing usable gets none: the Room
   * passes for it after a short random delay.
   */
  z.strictObject({ t: z.literal("countdown"), seat: SeatIdSchema, ms: z.number().int().nonnegative() }),
]);
export type RoomMsg = z.infer<typeof RoomMsgSchema>;
export type RoomMsgType = RoomMsg["t"];
