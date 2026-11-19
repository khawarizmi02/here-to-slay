import { createRng, nextFloat } from "@here-to-slay/engine";

/**
 * The Room's `random`. A test build that is `seedable` seeds it from the
 * URL's `seed`, so an end-to-end run plays a known game; every other build
 * ignores the URL and uses the browser's.
 */
export function roomRandom(search: string, { seedable }: { seedable: boolean }): () => number {
  const seed = seedable ? new URLSearchParams(search).get("seed") : null;
  if (!seed) return Math.random;
  let rng = createRng(seed);
  return () => {
    const [x, next] = nextFloat(rng);
    rng = next;
    return x;
  };
}
