import { z } from "zod";
import { SeatTokenSchema } from "./common.js";

/*
 * The relay's outer frames (TECHNICAL_DESIGN.md §10.5).
 *
 * The relay reads only the outer fields and never parses `payload`, so every
 * frame schema here types `payload` as unknown. Whoever receives the payload
 * (the Room for ClientMsg, a friend's client for RoomMsg) validates it with
 * ClientMsgSchema / RoomMsgSchema.
 */

const payload = z.unknown().refine((v) => v !== undefined, "payload is required");

/** Friend → relay: always routed to the Host. The relay adds `from`. */
export const FriendToRelayFrameSchema = z.strictObject({ payload });
export type FriendToRelayFrame = z.infer<typeof FriendToRelayFrameSchema>;

/** Relay → Host. */
export const RelayToHostFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("msg"), from: SeatTokenSchema, payload }),
  z.strictObject({ kind: z.literal("peerJoined"), seatToken: SeatTokenSchema }),
  z.strictObject({ kind: z.literal("peerLeft"), seatToken: SeatTokenSchema }),
  /** Every second while the Room has friends connected. */
  z.strictObject({ kind: z.literal("tick") }),
]);
export type RelayToHostFrame = z.infer<typeof RelayToHostFrameSchema>;

/** Host → relay: addressed to one friend or to everyone. */
export const HostToRelayFrameSchema = z.strictObject({
  to: z.union([z.literal("all"), SeatTokenSchema]),
  payload,
});
export type HostToRelayFrame = z.infer<typeof HostToRelayFrameSchema>;

/** Relay → friend. */
export const RelayToFriendFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("msg"), payload }),
  /** First frame to a friend who connected without a seat token. */
  z.strictObject({ kind: z.literal("welcome"), seatToken: SeatTokenSchema }),
  z.strictObject({ kind: z.literal("hostAway") }),
  z.strictObject({ kind: z.literal("hostBack") }),
  z.strictObject({ kind: z.literal("roomClosed") }),
]);
export type RelayToFriendFrame = z.infer<typeof RelayToFriendFrameSchema>;
