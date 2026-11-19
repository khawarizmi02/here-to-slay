import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RoomClosedError } from "../src/shell/game.js";
import { FakeConnection } from "./fake-connection.js";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MODIFIER, newGame as game, viewOf } from "./real-game.js";
import { ALICE, BOT, connected, fakeRoom, renderClient, renderInLobby } from "./render.js";

afterEach(cleanup);

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** Alice holds a hero and a Challenge, the bot a hero and a Modifier. */
const newGame = () => game({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO, MODIFIER] } });

describe("the Room pointer", () => {
  it("points at the Room once a game on this device starts", async () => {
    const { pointers, user } = renderClient();
    await user.clear(screen.getByLabelText("Your name"));
    await user.type(screen.getByLabelText("Your name"), "Alice");
    await user.click(screen.getByRole("button", { name: "Play on this device" }));
    expect(pointers.load()).toEqual({ mode: "offline", role: "host", roomCode: "ABCDE", name: "Alice" });
  });
});

describe("loading with a pointer", () => {
  const pointer = { mode: "offline", role: "host", roomCode: "ABCDE", name: "Alice" } as const;

  it("goes straight back into the game, acting from the Seat the Room was resumed with", async () => {
    const connection = new FakeConnection();
    const { resumed } = renderClient({ pointer, resume: () => Promise.resolve(fakeRoom([{ connection, name: "Alice", seatId: "s1" }])) });
    expect(screen.queryByRole("button", { name: "Play on this device" })).toBeNull();
    expect(resumed).toEqual([pointer]);

    await screen.findByText("Connecting…");
    connection.receive({ t: "update", version: 4, events: [], view: viewOf(newGame(), "s1") });
    await connected();
    within(screen.getByRole("region", { name: "Your hand" })).getByRole("button", { name: "Placeholder Bard 1" }).click();
    expect(connection.takeSent()).toEqual([{ t: "action", seat: "s1", action: { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, clientSeq: 0 }]);
  });

  it("lands on the first screen, with the pointer cleared, when the Room has closed", async () => {
    const online = { mode: "online", role: "friend", roomCode: "HJK23", name: "Bob", token: "seat-token" } as const;
    const { pointers } = renderClient({ pointer: online, resume: () => Promise.reject(new RoomClosedError()) });
    expect(await screen.findByRole("alert")).toHaveTextContent("That Room has closed");
    expect(screen.getByRole("button", { name: "Join with a Room Code" })).toBeVisible();
    expect(pointers.load()).toBeNull();
  });

  it("keeps pointing at an online Room it couldn't reach, so a later load tries again", async () => {
    const online = { mode: "online", role: "host", roomCode: "HJK23", name: "Alice", token: "host-token" } as const;
    const { pointers } = renderClient({ pointer: online, resume: () => Promise.reject(new Error("offline")) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach your Room. Reload to try again.");
    expect(pointers.load()).toEqual(online);
  });

  it("lands on the first screen, with the pointer cleared, when the Room can't be resumed", async () => {
    const { pointers } = renderClient({ pointer, resume: () => Promise.reject(new Error("The saved game doesn't replay")) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your game couldn't be resumed");
    expect(screen.getByRole("button", { name: "Play on this device" })).toBeEnabled();
    expect(pointers.load()).toBeNull();
  });
});

describe("Leave Room", () => {
  it("closes the connection, clears the pointer and shows the first screen", async () => {
    const { connection, pointers, user } = await renderInLobby();
    await user.click(screen.getByRole("button", { name: "Leave Room" }));
    expect(connection.closed).toBe(true);
    expect(pointers.load()).toBeNull();
    expect(screen.getByRole("button", { name: "Play on this device" })).toBeEnabled();
  });
});

describe("game over", () => {
  it("clears the pointer, so the next load starts fresh", async () => {
    const state = newGame();
    const { connection, pointers } = await renderInLobby([ALICE, BOT]);
    connection.receive({ t: "update", version: 1, events: [], view: viewOf(state, "s1") });
    expect(pointers.load()).not.toBeNull();

    state.winner = "s1";
    state.winReason = "monsters";
    state.phase = { kind: "gameOver" };
    connection.receive({ t: "update", version: 3, events: [], view: viewOf(state, "s1") });
    expect(screen.getByRole("heading", { name: "Alice wins!" })).toBeInTheDocument();
    expect(pointers.load()).toBeNull();
  });
});
