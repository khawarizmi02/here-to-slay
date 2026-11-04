/**
 * Seeded, serialisable PRNG (xoshiro128**), TECHNICAL_DESIGN.md §8.1. Its
 * state lives in GameState, so it is saved and restored with the game. Every
 * function is pure: it returns the new RNG state instead of mutating.
 */
export interface RngState {
  seed: string;
  s: [number, number, number, number];
  /**
   * Dice results `rollD6` returns, in order, before it uses the generator.
   * Only the `scenario()` test helper fills this (§13.2); a real game's is always empty.
   */
  forcedDice: number[];
}

/** cyrb128: hashes a string into four 32-bit words. */
export function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function createRng(seed: string): RngState {
  const s = hash128(seed);
  // xoshiro must not start from the all-zero state.
  if (s.every((w) => w === 0)) s[0] = 1;
  return { seed, s, forcedDice: [] };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** Returns a float in [0, 1). Forced dice don't affect it. */
export function nextFloat(rng: RngState): [number, RngState] {
  const [a, b, c, d] = rng.s;
  const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
  const t = b << 9;
  let s2 = c ^ a;
  let s3 = d ^ b;
  const s1 = b ^ s2;
  const s0 = a ^ s3;
  s2 ^= t;
  s3 = rotl(s3, 11);
  return [result / 4294967296, { ...rng, s: [s0 >>> 0, s1 >>> 0, s2 >>> 0, s3 >>> 0] }];
}

/** An integer in [0, n). */
export function nextInt(n: number, rng: RngState): [number, RngState] {
  const [f, next] = nextFloat(rng);
  return [Math.floor(f * n), next];
}

/** One six-sided die: the next forced die if any, otherwise the generator's. */
export function rollD6(rng: RngState): [number, RngState] {
  const [forced, ...rest] = rng.forcedDice;
  if (forced !== undefined) return [forced, { ...rng, forcedDice: rest }];
  const [n, next] = nextInt(6, rng);
  return [n + 1, next];
}

/** Fisher–Yates shuffle. Does not mutate `arr`. */
export function shuffle<T>(arr: readonly T[], rng: RngState): [T[], RngState] {
  const out = arr.slice();
  let state = rng;
  for (let i = out.length - 1; i > 0; i--) {
    let j: number;
    [j, state] = nextInt(i + 1, state);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return [out, state];
}
