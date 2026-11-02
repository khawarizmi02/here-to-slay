/**
 * Seeded, serialisable PRNG (xoshiro128**), TECHNICAL_DESIGN.md §8.1.
 * Every function is pure: it returns the new RNG state instead of mutating.
 */
export interface RngState {
  seed: string;
  s: [number, number, number, number];
}

/** cyrb128: hashes a string seed into four 32-bit words. */
function hashSeed(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
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
  const s: [number, number, number, number] = [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  // xoshiro must not start from the all-zero state.
  if (s.every((w) => w === 0)) s[0] = 1;
  return s;
}

export function createRng(seed: string): RngState {
  return { seed, s: hashSeed(seed) };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** Returns a float in [0, 1). */
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
  return [result / 4294967296, { seed: rng.seed, s: [s0 >>> 0, s1 >>> 0, s2 >>> 0, s3 >>> 0] }];
}

/** Fisher–Yates shuffle. Does not mutate `arr`. */
export function shuffle<T>(arr: readonly T[], rng: RngState): [T[], RngState] {
  const out = arr.slice();
  let state = rng;
  for (let i = out.length - 1; i > 0; i--) {
    let f: number;
    [f, state] = nextFloat(state);
    const j = Math.floor(f * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return [out, state];
}
