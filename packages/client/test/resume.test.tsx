import * as toy from "@here-to-slay/toy-engine";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FakeConnection } from "./fake-connection.js";
import { ALICE, BOT, renderClient, renderInLobby } from "./render.js";

afterEach(cleanup);

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** Hands of two: Alice holds point_1 and challenge, the bot point_2 and modifier. */
function newGame(targetScore = 5) {
  return toy.createGame({
    players,
    seed: "client",
    config: { handSize: 2, targetScore },
    deckOrder: ["point_1", "challenge", "point_2", "modifier", "point_3"],
  });
}

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
    const { resumed } = renderClient({ pointer, resume: () => Promise.resolve({ connection, roomCode: "ABCDE", seatId: "s1" }) });
    expect(screen.queryByRole("button", { name: "Play on this device" })).toBeNull();
    expect(resumed).toEqual([pointer]);

    await screen.findByText("Connecting…");
    connection.receive({ t: "update", version: 4, events: [], view: toy.getPlayerView(newGame(), "s1") as unknown as Record<string, unknown> });
    within(screen.getByRole("region", { name: "Your hand" })).getByRole("button", { name: "1 Point" }).click();
    expect(connection.takeSent()).toEqual([
      { t: "action", seat: "s1", action: { type: "PLAY_HERO", player: "s1", card: "point_1#0" }, clientSeq: 0 },
    ]);
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
    let state = newGame(1);
    const { connection, pointers } = await renderInLobby([ALICE, BOT]);
    connection.receive({ t: "update", version: 1, events: [], view: toy.getPlayerView(state, "s1") as unknown as Record<string, unknown> });
    expect(pointers.load()).not.toBeNull();

    for (const action of [{ type: "PLAY_HERO", player: "s1", card: "point_1#0" }, { type: "PASS", player: "s2" }] as const) {
      const result = toy.applyAction(state, action);
      if (!result.ok) throw new Error(result.error);
      state = result.state;
    }
    connection.receive({ t: "update", version: 3, events: [], view: toy.getPlayerView(state, "s1") as unknown as Record<string, unknown> });
    expect(screen.getByRole("heading", { name: "Alice wins!" })).toBeInTheDocument();
    expect(pointers.load()).toBeNull();
  });
});
