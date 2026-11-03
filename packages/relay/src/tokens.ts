import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@here-to-slay/protocol";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** A secret only the Host's tab knows (256 bits). */
export const newHostToken = (): string => randomToken(32);

/** Identifies one friend's Seat to the Host (128 bits). */
export const newSeatToken = (): string => randomToken(16);

/** A fresh Room Code: 5 characters, no 0/O/1/I. */
export function newRoomCode(): string {
  // 256 is a multiple of the 32-character alphabet, so `% length` is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join("");
}

/** Compares two secrets without leaking where they first differ. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
