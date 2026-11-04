import { describe, expect, it } from "vitest";
import { createRng, nextFloat, rollD6, shuffle } from "../src/index.js";

describe("seeded RNG", () => {
  it("gives the same sequence for the same seed, and a different one for another seed", () => {
    const floats = (seed: string) => {
      let rng = createRng(seed);
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        let f: number;
        [f, rng] = nextFloat(rng);
        out.push(f);
      }
      return out;
    };
    expect(floats("a")).toEqual(floats("a"));
    expect(floats("a")).not.toEqual(floats("b"));
    for (const f of floats("a")) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it("starts with no forced dice", () => {
    expect(createRng("x").forcedDice).toEqual([]);
  });

  it("rolls each face from 1 to 6, and nothing else", () => {
    let rng = createRng("dice");
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      let d: number;
      [d, rng] = rollD6(rng);
      seen.add(d);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses forced dice first, in order, without advancing the generator", () => {
    const seeded = createRng("forced");
    const rng = { ...seeded, forcedDice: [6, 1] };
    const [a, r1] = rollD6(rng);
    const [b, r2] = rollD6(r1);
    expect([a, b]).toEqual([6, 1]);
    expect(r2.forcedDice).toEqual([]);
    // Once the queue is empty, the generator carries on as if no dice had been forced.
    expect(rollD6(r2)[0]).toBe(rollD6(seeded)[0]);
    expect(rng.forcedDice, "rolling must not mutate the RNG state").toEqual([6, 1]);
  });

  it("shuffles without mutating its input, keeping every element", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const [out] = shuffle(input, createRng("s"));
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort()).toEqual(input);
    expect(out).not.toEqual(input);
  });
});
