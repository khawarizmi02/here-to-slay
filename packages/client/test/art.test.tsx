import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALICE_HERO, BOT_HERO, CHALLENGE, newGame, update } from "./real-game.js";
import { ALICE, BOT, renderInLobby } from "./render.js";

/**
 * A local card set on disk: the placeholder cards, where Placeholder Bard 1
 * names an art file that exists and Placeholder Challenge one that doesn't.
 * Only the files are faked; the client reads and validates them as it would
 * a real local set.
 */
vi.mock("../src/board/local-files.js", async () => {
  const { CARD_FILES, placeholderCardDefs } = await import("@here-to-slay/cards");
  const art: Record<string, string> = { hero_bard_01: "bard.png", challenge_01: "missing.png" };
  const defs = placeholderCardDefs.map((d) => (art[d.id] ? { ...d, art: art[d.id] } : d));
  // Every card in the first file and the others empty: the set is read in file order either way.
  const [first, ...rest] = CARD_FILES;
  return {
    LOCAL_CARD_FILES: {
      [`../../../cards/local/${first}`]: defs,
      ...Object.fromEntries(rest.map((f) => [`../../../cards/local/${f}`, []])),
    },
    LOCAL_ART: { "../../../cards/local/art/bard.png": new URL("./fixtures/card-art.png", import.meta.url).href },
  };
});

afterEach(cleanup);

async function inGame() {
  const players = [
    { id: "s1", name: "Alice", isBot: false },
    { id: "s2", name: "Bot 1", isBot: true },
  ];
  const client = await renderInLobby([ALICE, BOT], "s1");
  client.connection.receive(update(newGame({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO] } }), "s1", 1));
  return client;
}

const handCard = (name: string) => within(screen.getByLabelText("Your hand", { selector: "section" })).getByRole("figure", { name });
const artOf = (el: HTMLElement) => el.querySelector("img.card-art");
const zoom = () => screen.getByRole("dialog", { name: "Zoomed card" });

describe("local card art", () => {
  it("shows a card's art over its HTML card, in the hand and in the zoom", async () => {
    const { user } = await inGame();
    const bard = handCard("Placeholder Bard 1");
    expect(artOf(bard)).toHaveAttribute("src", expect.stringContaining("card-art.png"));
    // The card's name and text stay for screen readers, under the art.
    expect(within(bard).getByText("Roll 8+: DRAW 2 cards.")).toBeInTheDocument();

    await user.hover(bard);
    expect(artOf(zoom())).toHaveAttribute("src", expect.stringContaining("card-art.png"));
  });

  it("shows the HTML card alone when the card names no art, or art that isn't there", async () => {
    const { user } = await inGame();
    expect(artOf(handCard("Placeholder Challenge"))).toBeNull();
    await user.hover(handCard("Placeholder Challenge"));
    expect(artOf(zoom())).toBeNull();
  });

  it("falls back to the HTML card when the art fails to load, saying nothing to the player", async () => {
    await inGame();
    const bard = handCard("Placeholder Bard 1");
    fireEvent.error(artOf(bard)!);
    expect(artOf(bard)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
