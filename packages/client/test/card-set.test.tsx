import "@testing-library/jest-dom/vitest";
import { placeholderCardDefs } from "@here-to-slay/cards";
import type { RoomMsg } from "@here-to-slay/protocol";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE_HERO, BOB_HERO, CHALLENGE, newGame, step, update } from "./real-game.js";
import { ALICE, renderClient, skipAnimations } from "./render.js";

// A friend's page has only the placeholder cards; the Host sends its own
// Card Set (ADR-0005). The fixture "local" set is the placeholder cards
// renamed, so the engine's card ids still match.

afterEach(cleanup);

const BOB = { id: "s2", name: "Bob", kind: "remote", connected: true } as const;

/** The Host's fixture local set, as the Room sends it: no art. */
const LOCAL_SET: Extract<RoomMsg, { t: "cardSet" }> = {
  t: "cardSet",
  name: "Local cards",
  cards: placeholderCardDefs.map((d) => ({ ...d, name: `Fixture ${d.id}` })),
};

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bob", isBot: false },
];
const aliceToPlay = () => newGame({ players, hands: { s1: [ALICE_HERO], s2: [BOB_HERO, CHALLENGE] } });

async function joinAsBob() {
  const client = renderClient();
  await client.user.clear(screen.getByLabelText("Your name"));
  await client.user.type(screen.getByLabelText("Your name"), "Bob");
  await client.user.type(screen.getByLabelText("Room Code"), "HJK23");
  await client.user.click(screen.getByRole("button", { name: "Join with a Room Code" }));
  return client;
}

const lobbyCardSet = () => document.querySelector(".lobby .card-set");

describe("a friend and the Host's Card Set", () => {
  it("names the Host's Card Set in the lobby, and nothing until it arrives", async () => {
    const { connection } = await joinAsBob();
    connection.receive({ t: "lobby", roomCode: "HJK23", seats: [ALICE, BOB], you: ["s2"] });
    expect(lobbyCardSet()).toHaveTextContent(/^$/);
    expect(screen.queryByText("Placeholder cards")).toBeNull();

    connection.receive(LOCAL_SET);
    expect(lobbyCardSet()).toHaveTextContent("Local cards");
  });

  it("draws every card from the Host's Card Set: hand, Spotlight, log and zoom", async () => {
    const { connection, user } = await joinAsBob();
    connection.receive(LOCAL_SET, { t: "lobby", roomCode: "HJK23", seats: [ALICE, BOB], you: ["s2"] });
    connection.receive(update(aliceToPlay(), "s2", 1));
    skipAnimations();
    connection.receive(step(aliceToPlay(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, "s2", 2).msg);

    const hand = within(screen.getByLabelText("Your hand", { selector: "section" }));
    expect(hand.getByRole("figure", { name: "Fixture hero_fighter_01" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Spotlight" })).getByRole("figure", { name: "Fixture hero_bard_01" })).toBeInTheDocument();
    expect(screen.getAllByText(/Fixture hero_bard_01/).length).toBeGreaterThan(1);

    await user.click(hand.getByRole("figure", { name: "Fixture hero_fighter_01" }));
    expect(within(screen.getByRole("dialog", { name: "Zoomed card" })).getByRole("heading", { name: "Fixture hero_fighter_01" })).toBeInTheDocument();
    // Nothing is drawn from the page's own placeholder cards.
    expect(document.body.textContent).not.toMatch(/Placeholder/);
  });

  it("shows no board until the Host's Card Set arrives", async () => {
    const { connection } = await joinAsBob();
    connection.receive({ t: "lobby", roomCode: "HJK23", seats: [ALICE, BOB], you: ["s2"] }, update(aliceToPlay(), "s2", 1));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.queryByText("Lobby")).toBeNull();

    connection.receive(LOCAL_SET);
    expect(within(screen.getByLabelText("Your hand", { selector: "section" })).getByRole("figure", { name: "Fixture hero_fighter_01" })).toBeInTheDocument();
  });

  it("shows the load error and doesn't enter the game when the Host's cards fail validation", async () => {
    const { connection } = await joinAsBob();
    connection.receive(
      { t: "cardSet", name: "Local cards", cards: [{ id: "fixture_broken", type: "hero", name: "Fixture Broken" }] },
      { t: "lobby", roomCode: "HJK23", seats: [ALICE, BOB], you: ["s2"] },
      update(aliceToPlay(), "s2", 1),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the Host's cards");
    expect(screen.queryByText("Lobby")).toBeNull();
    expect(screen.queryByLabelText("Your hand", { selector: "section" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Placeholder/);
  });
});
