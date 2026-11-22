import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_SET } from "../src/board/cards.js";
import { FakeConnection } from "./fake-connection.js";
import { ALICE, BOT, connected, fakeRoom, renderClient, renderInLobby } from "./render.js";

afterEach(cleanup);

const FRIEND = { mode: "online", role: "friend", roomCode: "ABCDE", name: "Bob" } as const;

describe("the first screen", () => {
  it("offers all three choices, joining once there's a Room Code", async () => {
    const { user } = renderClient();
    expect(screen.getByRole("button", { name: "Play on this device" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Host online" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Join with a Room Code" })).toBeDisabled();
    await user.type(screen.getByLabelText("Room Code"), "HJK23");
    expect(screen.getByRole("button", { name: "Join with a Room Code" })).toBeEnabled();
  });

  it("starts a Room on this device under the player's name", async () => {
    const { launched, user } = renderClient();
    const name = screen.getByLabelText("Your name");
    await user.clear(name);
    await user.type(name, "Alice");
    await user.click(screen.getByRole("button", { name: "Play on this device" }));
    expect(launched).toEqual(["Alice"]);
  });
});

describe("the lobby", () => {
  it("shows the Seats as the Room reports them", async () => {
    await renderInLobby([ALICE, BOT]);
    const seats = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(seats).toEqual([expect.stringContaining("Alice"), expect.stringContaining("Bot 1")]);
  });

  it("adds a bot and starts the game through the connection", async () => {
    const { connection, user } = await renderInLobby();
    await user.click(screen.getByRole("button", { name: "Add a bot" }));
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(connection.takeSent()).toEqual([{ t: "addBot", difficulty: "easy" }, { t: "startGame" }]);
  });

  it("says which card set is in use", async () => {
    await renderInLobby();
    // The card set test covers which set and label are chosen; this checks the lobby shows it.
    expect(screen.getByText(CARD_SET.label)).toBeInTheDocument();
  });

  it("shows no Room Code for a game on this device", async () => {
    await renderInLobby();
    expect(screen.queryByText(/ABCDE/)).toBeNull();
  });

  it("lets the Host set the rules, starting from the engine's defaults", async () => {
    const { connection, user } = await renderInLobby();
    const monsters = screen.getByLabelText("Monsters to win");
    const handSize = screen.getByLabelText("Hand size");
    expect(monsters).toHaveValue(3);
    expect(screen.getByLabelText("Classes to win")).toHaveValue(6);
    expect(handSize).toHaveValue(5);
    expect(screen.getByLabelText("Action points")).toHaveValue(3);

    await user.clear(monsters);
    await user.type(monsters, "1");
    await user.clear(handSize);
    await user.type(handSize, "4");
    expect(connection.takeSent()).toEqual([
      { t: "setConfig", config: { monstersToWin: 1 } },
      { t: "setConfig", config: { startingHandSize: 4 } },
    ]);
  });

  it("sends no rule the engine would refuse", async () => {
    const { connection, user } = await renderInLobby();
    const monsters = screen.getByLabelText("Monsters to win");
    await user.clear(monsters);
    await user.type(monsters, "0");
    const classes = screen.getByLabelText("Classes to win");
    await user.clear(classes);
    await user.type(classes, "7");
    expect(connection.takeSent()).toEqual([]);
  });

  it("shows the Host's controls to no other Seat", async () => {
    // A Seat that isn't the Host's, as a friend's device will hold.
    const connection = new FakeConnection();
    renderClient({ pointer: FRIEND, resume: () => Promise.resolve(fakeRoom([{ connection, name: "Bob" }])) });
    await screen.findByText("Connecting…");
    connection.receive({ t: "lobby", roomCode: "ABCDE", seats: [ALICE, BOT], you: ["s2"] });
    await connected();
    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.queryByLabelText("Monsters to win")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a bot" })).toBeNull();
  });

  it("shows the Room's error when it refuses a lobby command", async () => {
    const { connection } = await renderInLobby();
    connection.receive({ t: "error", message: "The game needs at least 2 Seats" });
    expect(screen.getByRole("alert")).toHaveTextContent("The game needs at least 2 Seats");
  });
});
