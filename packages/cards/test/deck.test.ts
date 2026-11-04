import { describe, expect, it } from "vitest";
import { buildDeck, loadCardDefs } from "../src/index.js";

const defs = loadCardDefs([
  { id: "challenge_01", type: "challenge", name: "Challenge", text: "", copies: 3 },
  { id: "mod_01", type: "modifier", name: "Modifier +2/-2", text: "", copies: 2, options: [2, -2] },
  { id: "item_01", type: "item", name: "Item", text: "", copies: 1 },
]);

describe("buildDeck", () => {
  it("makes `copies` instances of each definition, in definition order", () => {
    expect(buildDeck(defs)).toEqual([
      { instanceId: "challenge_01#0", defId: "challenge_01" },
      { instanceId: "challenge_01#1", defId: "challenge_01" },
      { instanceId: "challenge_01#2", defId: "challenge_01" },
      { instanceId: "mod_01#0", defId: "mod_01" },
      { instanceId: "mod_01#1", defId: "mod_01" },
      { instanceId: "item_01#0", defId: "item_01" },
    ]);
  });

  it("gives every instance a unique id", () => {
    const ids = buildDeck(defs).map((card) => card.instanceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses definitions that share an id, since their instances would collide", () => {
    const [challenge] = defs;
    expect(() => buildDeck([challenge!, challenge!])).toThrow(/duplicate.*challenge_01/i);
  });
});
