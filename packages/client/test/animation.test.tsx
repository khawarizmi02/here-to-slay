import * as toy from "@here-to-slay/toy-engine";
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeConnection } from "./fake-connection.js";
import { ALICE, BOT, renderInLobby } from "./render.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** Hands of two: Alice holds point_1 and challenge, the bot point_2 and modifier. */
const newGame = () =>
  toy.createGame({ players, seed: "client", config: { handSize: 2, targetScore: 5 }, deckOrder: ["point_1", "challenge", "point_2", "modifier", "point_3"] });

/** Applies `action` to `state`, with the update Seat `seat` gets for it, events and all. */
function step(state: toy.GameState, action: toy.Action, seat: string, version: number) {
  const result = toy.applyAction(state, action);
  if (!result.ok) throw new Error(result.error);
  return {
    state: result.state,
    msg: {
      t: "update" as const,
      version,
      events: toy.getPlayerEvents(result.events, seat),
      view: toy.getPlayerView(result.state, seat) as unknown as Record<string, unknown>,
    },
  };
}

const playPoint = { type: "PLAY_HERO", player: "s1", card: "point_1#0" } as const;
const botPasses = { type: "PASS", player: "s2" } as const;

/**
 * The client as Seat `seat`, showing a new game at version 1, with the
 * clock under the test's control from then on.
 */
async function inGame(seat = "s1"): Promise<FakeConnection> {
  const { connection } = await renderInLobby([ALICE, BOT], seat);
  connection.receive({ t: "update", version: 1, events: [], view: toy.getPlayerView(newGame(), seat) as unknown as Record<string, unknown> });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return connection;
}

/** Lets `ms` of animation play. */
function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function logLines() {
  return within(screen.getByRole("list", { name: "Game log" }))
    .queryAllByRole("listitem")
    .map((li) => li.textContent);
}

const holdsPoint = () => within(screen.getByRole("region", { name: "Your hand" })).queryByRole("button", { name: "1 Point" }) !== null;

describe("the animation queue", () => {
  it("plays an update's events in order, one slot each, and shows its view after them", async () => {
    const connection = await inGame();
    // The bot's pass has three events: PASSED, POINTS_SCORED, TURN_STARTED.
    const played = step(newGame(), playPoint, "s1", 2);
    connection.receive(played.msg);
    expect(logLines()).toEqual(["You played 1 Point"]);
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("You played 1 Point");
    expect(holdsPoint()).toBe(true);

    wait(300); // RESPONSE_WINDOW_OPENED: the board shows it, so no line.
    expect(holdsPoint()).toBe(true);
    wait(300);
    expect(holdsPoint()).toBe(false);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();

    connection.receive(step(played.state, botPasses, "s1", 3).msg);
    expect(logLines()).toEqual(["You played 1 Point", "Bot 1 passed"]);
    wait(300);
    expect(logLines()).toEqual(["You played 1 Point", "Bot 1 passed", "You scored 1 point (1 in all)"]);
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("You scored 1 point (1 in all)");
    expect(screen.getByRole("row", { name: /Alice/ })).toHaveTextContent("0 points");
    wait(600);
    expect(screen.getByRole("row", { name: /Alice/ })).toHaveTextContent("1 points");
  });

  it("offers no actions while an event plays: the view on screen is out of date", async () => {
    const connection = await inGame();
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeEnabled();
    connection.receive(step(newGame(), playPoint, "s1", 2).msg);
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeDisabled();
    for (const card of within(screen.getByRole("region", { name: "Your hand" })).getAllByRole("button")) expect(card).toBeDisabled();
  });

  it("shows a countdown at once, while the update before it is still playing", async () => {
    const connection = await inGame("s2");
    connection.receive(step(newGame(), playPoint, "s2", 2).msg, { t: "countdown", seat: "s2", ms: 15_000 });
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("Alice played 1 Point");
    expect(screen.getByRole("timer")).toHaveTextContent("15s left");
  });

  it("shows the latest view at once when a version is skipped", async () => {
    const connection = await inGame();
    connection.receive(step(newGame(), playPoint, "s1", 3).msg);
    expect(holdsPoint()).toBe(false);
    expect(logLines()).toEqual(["You played 1 Point"]);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });

  it("shows the latest view at once, every event logged, when a lower version arrives mid-animation", async () => {
    const connection = await inGame();
    const played = step(newGame(), playPoint, "s1", 2);
    connection.receive(played.msg);
    connection.receive(step(played.state, botPasses, "s1", 1).msg);
    expect(screen.getByRole("row", { name: /Alice/ })).toHaveTextContent("1 points");
    expect(logLines()).toEqual(["You played 1 Point", "Bot 1 passed", "You scored 1 point (1 in all)", "Turn 2: Bot 1's turn"]);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });

  it("jumps to the latest view when updates pile up", async () => {
    const connection = await inGame();
    const played = step(newGame(), playPoint, "s1", 2);
    connection.receive(played.msg, { ...played.msg, version: 3 }, { ...played.msg, version: 4 });
    expect(screen.getByRole("region", { name: "Now playing" })).toBeInTheDocument();
    expect(holdsPoint()).toBe(true);

    connection.receive(step(played.state, botPasses, "s1", 5).msg);
    expect(screen.getByRole("row", { name: /Alice/ })).toHaveTextContent("1 points");
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    expect(logLines()).toHaveLength(3 + 3);
  });

  it("shows views at once when the player skips animations, including the one playing", async () => {
    const connection = await inGame();
    const played = step(newGame(), playPoint, "s1", 2);
    connection.receive(played.msg);
    act(() => screen.getByRole("checkbox", { name: "Skip animations" }).click());
    expect(holdsPoint()).toBe(false);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();

    connection.receive(step(played.state, botPasses, "s1", 3).msg);
    expect(screen.getByRole("row", { name: /Alice/ })).toHaveTextContent("1 points");
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });
});

describe("Waiting for responses…", () => {
  const status = () => screen.queryByText("Waiting for responses…");

  it("shows once the player has nothing left to answer in a response window, naming nobody", async () => {
    const connection = await inGame("s1");
    expect(status()).toBeNull();
    connection.receive(step(newGame(), playPoint, "s1", 2).msg);
    wait(600);
    expect(status()).toHaveTextContent(/^Waiting for responses…$/);
  });

  it("doesn't show while the window awaits the player", async () => {
    const connection = await inGame("s2");
    const played = step(newGame(), playPoint, "s2", 2);
    connection.receive(played.msg);
    wait(600);
    expect(status()).toBeNull();

    connection.receive(step(played.state, botPasses, "s2", 3).msg);
    wait(900);
    expect(status()).toBeNull();
  });
});
