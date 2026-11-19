import { describe, expect, it } from "vitest";
import { roomRandom } from "../src/root/seed.js";

const draws = (random: () => number, n = 5) => Array.from({ length: n }, () => random());

describe("the Room's random", () => {
  it("in a test build, follows the seed in the URL: the same seed gives the same draws", () => {
    const a = draws(roomRandom("?seed=e2e", { seedable: true }));
    const b = draws(roomRandom("?seed=e2e", { seedable: true }));
    expect(a).toEqual(b);
    expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(draws(roomRandom("?seed=other", { seedable: true }))).not.toEqual(a);
  });

  it("in a test build with no seed in the URL, is the browser's", () => {
    expect(roomRandom("", { seedable: true })).toBe(Math.random);
  });

  it("in a production build, ignores the seed in the URL", () => {
    expect(roomRandom("?seed=e2e", { seedable: false })).toBe(Math.random);
  });
});
