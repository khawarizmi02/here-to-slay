import { describe, expect, it } from "vitest";
import { CARD_FILES, CardLoadError, chooseCardSet, placeholderCardDefs } from "../src/index.js";

const wizard = {
  id: "local_wizard",
  type: "hero",
  name: "Local Wizard",
  class: "wizard",
  rollRequirement: 8,
  copies: 1,
  text: "Roll 8+: DRAW 2 cards.",
  effect: { op: "draw", who: "self", amount: 2 },
};

/** A fixture local set: the seven files, keyed by path as the client's glob finds them. */
function localFiles(heroes: unknown[] = [wizard]): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const name of CARD_FILES) {
    files[`../../../cards/local/${name}`] = name === "heroes.json" ? heroes : [];
  }
  return files;
}

function loadError(files: Record<string, unknown>): CardLoadError {
  try {
    chooseCardSet(files);
  } catch (error) {
    expect(error).toBeInstanceOf(CardLoadError);
    return error as CardLoadError;
  }
  throw new Error("expected chooseCardSet to throw");
}

describe("chooseCardSet", () => {
  it("uses the placeholder cards when there are no local files", () => {
    const set = chooseCardSet({});
    expect(set.label).toBe("Placeholder cards");
    expect(set.defs).toBe(placeholderCardDefs);
  });

  it("uses the local cards when their files exist", () => {
    const set = chooseCardSet(localFiles());
    expect(set.label).toBe("Local cards");
    expect(set.defs.map((def) => def.id)).toEqual(["local_wizard"]);
  });

  it("names the card and the field when a local card is broken", () => {
    const error = loadError(localFiles([{ ...wizard, rollRequirement: "eight" }]));
    expect(error.message).toContain('"local_wizard"');
    expect(error.message).toContain("rollRequirement");
  });

  it("names a local file that is missing", () => {
    const files = localFiles();
    delete files["../../../cards/local/monsters.json"];
    const error = loadError(files);
    expect(error.message).toContain("monsters.json");
  });

  it("names a local file it doesn't know", () => {
    const error = loadError({ ...localFiles(), "../../../cards/local/hero.json": [] });
    expect(error.message).toContain("hero.json");
  });
});
