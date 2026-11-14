import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FakeConnection } from "./fake-connection.js";
import { ALICE, BOT, fakeRoom, renderClient, renderInLobby } from "./render.js";

afterEach(cleanup);

const FRIEND = { mode: "online", role: "friend", roomCode: "ABCDE", name: "Bob" } as const;

describe("the first screen", () => {
  it("offers all three choices, with only Play on this device built so far", () => {
    renderClient();
    expect(screen.getByRole("button", { name: "Play on this device" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Host online" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Join with a Room Code" })).toBeDisabled();
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

  it("shows no Room Code for a game on this device", async () => {
    await renderInLobby();
    expect(screen.queryByText(/ABCDE/)).toBeNull();
  });

  it("lets the Host set the target score and hand size, starting from the toy's defaults", async () => {
    const { connection, user } = await renderInLobby();
    const target = screen.getByLabelText("Target score");
    const handSize = screen.getByLabelText("Hand size");
    expect(target).toHaveValue(5);
    expect(handSize).toHaveValue(3);

    await user.clear(target);
    await user.type(target, "8");
    await user.clear(handSize);
    await user.type(handSize, "4");
    expect(connection.takeSent()).toEqual([
      { t: "setConfig", config: { targetScore: 8 } },
      { t: "setConfig", config: { handSize: 4 } },
    ]);
  });

  it("sends no rule the toy engine would refuse", async () => {
    const { connection, user } = await renderInLobby();
    const target = screen.getByLabelText("Target score");
    await user.clear(target);
    await user.type(target, "0");
    expect(connection.takeSent()).toEqual([]);
  });

  it("shows the Host's controls to no other Seat", async () => {
    // A Seat that isn't the Host's, as a friend's device will hold.
    const connection = new FakeConnection();
    renderClient({ pointer: FRIEND, resume: () => Promise.resolve(fakeRoom([{ connection, name: "Bob" }])) });
    await screen.findByText("Connecting…");
    connection.receive({ t: "lobby", roomCode: "ABCDE", seats: [ALICE, BOT], you: ["s2"] });
    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.queryByLabelText("Target score")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a bot" })).toBeNull();
  });

  it("shows the Room's error when it refuses a lobby command", async () => {
    const { connection } = await renderInLobby();
    connection.receive({ t: "error", message: "The game needs at least 2 Seats" });
    expect(screen.getByRole("alert")).toHaveTextContent("The game needs at least 2 Seats");
  });
});
