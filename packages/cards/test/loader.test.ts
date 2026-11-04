import { describe, expect, it } from "vitest";
import { CardLoadError, loadCardDefs, type HeroDef } from "../src/index.js";

const wizard = {
  id: "hero_wizard_01",
  type: "hero",
  name: "Placeholder Wizard",
  class: "wizard",
  rollRequirement: 8,
  copies: 1,
  text: "Roll 8+: DRAW 2 cards.",
  effect: { op: "draw", who: "self", amount: 2 },
};

describe("loadCardDefs", () => {
  it("loads valid card JSON into typed definitions", () => {
    const defs = loadCardDefs([wizard]);

    expect(defs).toHaveLength(1);
    const hero = defs[0] as HeroDef;
    expect(hero.type).toBe("hero");
    expect(hero.class).toBe("wizard");
    expect(hero.effect).toEqual({ op: "draw", who: "self", amount: 2 });
  });

  function loadError(json: unknown): CardLoadError {
    try {
      loadCardDefs(json);
    } catch (error) {
      expect(error).toBeInstanceOf(CardLoadError);
      return error as CardLoadError;
    }
    throw new Error("expected loadCardDefs to throw");
  }

  it("names the card and the field when a field has the wrong type", () => {
    const error = loadError([wizard, { ...wizard, id: "hero_wizard_02", rollRequirement: "eight" }]);

    expect(error.message).toContain('"hero_wizard_02"');
    expect(error.message).toContain("rollRequirement");
    expect(error.message).not.toContain('"hero_wizard_01"');
  });

  it("names the nested field inside an effect", () => {
    const error = loadError([
      {
        ...wizard,
        effect: { op: "sequence", steps: [{ op: "draw", who: "self", amount: 1 }, { op: "draw", who: "self", amount: 0 }] },
      },
    ]);

    expect(error.message).toContain('"hero_wizard_01"');
    expect(error.message).toContain("effect.steps[1].amount");
  });

  it("names a misspelt field instead of dropping it", () => {
    const { rollRequirement, ...rest } = wizard;
    const error = loadError([{ ...rest, rollRequirment: rollRequirement }]);

    expect(error.message).toContain('"hero_wizard_01"');
    expect(error.message).toContain("rollRequirment");
    expect(error.message).toContain("rollRequirement");
  });

  it("names a card by its position when it has no usable id", () => {
    const error = loadError([wizard, { type: "challenge", name: "No id", text: "", copies: 1 }]);

    expect(error.message).toContain("card at index 1");
    expect(error.message).toContain("id");
  });

  it("rejects an unknown card type", () => {
    const error = loadError([{ ...wizard, type: "spell" }]);

    expect(error.message).toContain('"hero_wizard_01"');
    expect(error.message).toContain("type");
  });

  it("rejects two cards with the same id", () => {
    const error = loadError([wizard, { ...wizard, name: "Another Wizard" }]);

    expect(error.message).toContain('"hero_wizard_01"');
    expect(error.message).toMatch(/duplicate/i);
  });

  it("rejects input that is not an array of cards", () => {
    expect(loadError({ cards: [wizard] }).message).toMatch(/array/i);
  });

  it("rejects a passive that has no value on a modify hook", () => {
    const error = loadError([
      {
        id: "leader_bard",
        type: "leader",
        name: "Placeholder Bard Leader",
        class: "bard",
        copies: 1,
        text: "",
        passive: { hook: "modifyHandLimit" },
      },
    ]);

    expect(error.message).toContain('"leader_bard"');
    expect(error.message).toContain("passive.value");
  });

  it("rejects a passive that has both a handler and an effect", () => {
    const error = loadError([
      {
        id: "leader_bard",
        type: "leader",
        name: "Placeholder Bard Leader",
        class: "bard",
        copies: 1,
        text: "",
        passive: { hook: "onTurnStart", handler: "bardSong", effect: { op: "draw", who: "self", amount: 1 } },
      },
    ]);

    expect(error.message).toContain('"leader_bard"');
    expect(error.message).toContain("passive.handler");
  });

  it("rejects a monster that is slain at or below its defeat value", () => {
    const error = loadError([
      {
        id: "monster_01",
        type: "monster",
        name: "Placeholder Beast",
        copies: 1,
        text: "",
        requirement: { kind: "none" },
        slayAt: 6,
        defeatAt: 6,
        penalty: { op: "sacrifice", who: "self", amount: 1 },
        reward: { hook: "modifyRollTotal", value: 1 },
      },
    ]);

    expect(error.message).toContain('"monster_01"');
    expect(error.message).toContain("defeatAt");
  });
});
