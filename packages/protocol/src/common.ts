import { z } from "zod";

/**
 * Room Codes are 5 characters, easy to read aloud: upper-case letters and
 * digits without the confusable 0/O/1/I (TECHNICAL_DESIGN.md §10.5).
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 5;
export const RoomCodeSchema = z
  .string()
  .regex(/^[A-HJ-NP-Z2-9]{5}$/, "Room Code must be 5 characters without 0, O, 1 or I");
export type RoomCode = z.infer<typeof RoomCodeSchema>;

/** Identifies a Seat within one Room. Chosen by the Room. */
export const SeatIdSchema = z.string().min(1).max(64);
export type SeatId = z.infer<typeof SeatIdSchema>;

/** Identifies a player inside the engine's game state. */
export const PlayerIdSchema = z.string().min(1).max(64);
export type PlayerId = z.infer<typeof PlayerIdSchema>;

/** Issued by the relay to a friend; stamped by the relay on every frame the friend sends. */
export const SeatTokenSchema = z.string().min(8).max(128);
export type SeatToken = z.infer<typeof SeatTokenSchema>;

export const CardInstanceIdSchema = z.string().min(1).max(64);
export type CardInstanceId = z.infer<typeof CardInstanceIdSchema>;

export const PlayerNameSchema = z.string().trim().min(1).max(24);

export const SeatKindSchema = z.enum(["local", "remote", "bot"]);
export type SeatKind = z.infer<typeof SeatKindSchema>;
