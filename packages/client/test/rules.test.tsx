import "@testing-library/jest-dom/vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE_HERO, CHALLENGE, newGame, play, update } from "./real-game.js";
import { ALICE, BOT, HOST_CARD_SET, renderClient, renderInLobby } from "./render.js";

afterEach(cleanup);

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

const reference = () => screen.queryByRole("dialog", { name: "Rules" });

describe("the rules reference", () => {
  it("opens from the first screen, covers the whole game, and closes back to it", async () => {
    const { user } = renderClient();
    await user.click(screen.getByRole("button", { name: "Rules" }));

    const dialog = reference()!;
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Setup",
      "Your turn",
      "Cards",
      "Challenges",
      "Modifiers",
      "Monsters",
      "Winning",
    ]);
    expect(dialog).toHaveTextContent("3 action points");
    // Outside a game there are no settings of its own to list.
    expect(within(dialog).queryByRole("table", { name: "This game's rules" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(reference()).toBeNull();
    expect(screen.getByRole("button", { name: "Play on this device" })).toBeInTheDocument();
  });

  it("opens from the board with the game's own rule settings, and closes back to the game as it was, sending nothing", async () => {
    const state = newGame({ players, hands: { s1: [ALICE_HERO] }, config: { monstersToWin: 4, challengeTieWinner: "challenged" } });
    const { connection, user } = await renderInLobby([ALICE, BOT]);
    connection.receive(update(state, "s1", 1));
    connection.takeSent();
    await user.click(screen.getByText("Game log"));
    expect(screen.getByText("Game log").closest("details")).toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Rules" }));
    const settings = within(reference()!).getByRole("table", { name: "This game's rules" });
    expect(within(settings).getByRole("row", { name: "Monsters to win 4" })).toBeInTheDocument();
    expect(within(settings).getByRole("row", { name: "A tied Challenge goes to The challenged player" })).toBeInTheDocument();
    expect(within(settings).getByRole("row", { name: "Action points per turn 3" })).toBeInTheDocument();
    expect(reference()).toHaveTextContent("You have slain 4 monsters");

    await user.keyboard("{Escape}");
    expect(reference()).toBeNull();
    expect(screen.getByText("Game log").closest("details")).toHaveAttribute("open");
    expect(within(screen.getByRole("region", { name: "Your hand" })).getByRole("button", { name: "Placeholder Bard 1" })).toBeEnabled();
    expect(connection.takeSent()).toEqual([]);
  });

  it("leaves a response countdown running while it is open", async () => {
    // Bob, a friend online, is asked whether to Challenge Alice's hero, against the Room's clock.
    const state = newGame({ players: [players[0]!, { id: "s2", name: "Bob", isBot: false }], hands: { s1: [ALICE_HERO], s2: [CHALLENGE] } });
    const { connection, user } = renderClient();
    await user.type(screen.getByLabelText("Room Code"), "HJK23");
    await user.click(screen.getByRole("button", { name: "Join with a Room Code" }));
    connection.receive(
      HOST_CARD_SET,
      { t: "lobby", roomCode: "HJK23", seats: [ALICE, { id: "s2", name: "Bob", kind: "remote", connected: true }], you: ["s2"] },
      update(play(state, { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }), "s2", 2),
      { t: "countdown", seat: "s2", ms: 15_000 },
    );
    connection.takeSent();

    await user.click(screen.getByRole("button", { name: "Rules" }));
    expect(reference()).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Respond" })).getByRole("timer")).toHaveTextContent(/^1[45]s left$/);
    expect(connection.takeSent()).toEqual([]);

    await user.click(within(reference()!).getByRole("button", { name: "Close" }));
    expect(within(screen.getByRole("region", { name: "Respond" })).getByRole("button", { name: "Pass" })).toBeEnabled();
  });
});
