import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeConnection } from "./fake-connection.js";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MODIFIER, newGame as game, step, viewOf } from "./real-game.js";
import { ALICE, BOT, renderInLobby } from "./render.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** Alice holds a hero and a Challenge, the bot a hero and a Modifier. */
const newGame = () => game({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO, MODIFIER] } });

const playHero = { type: "PLAY_HERO", player: "s1", card: ALICE_HERO } as const;
const botPasses = { type: "PASS", player: "s2" } as const;
const endTurn = { type: "END_TURN", player: "s1" } as const;

/**
 * The client as Seat `seat`, showing a new game at version 1, with the
 * clock under the test's control from then on.
 */
async function inGame(seat = "s1"): Promise<FakeConnection> {
  const { connection } = await renderInLobby([ALICE, BOT], seat);
  connection.receive({ t: "update", version: 1, events: [], view: viewOf(newGame(), seat) });
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

const HERO = "Placeholder Bard 1";
const turnLine = () => document.querySelector(".turn-line");
const holdsHero = () => within(screen.getByRole("region", { name: "Your hand" })).queryByRole("button", { name: HERO }) !== null;
const heroInParty = () => within(screen.getByRole("region", { name: "Your party" })).queryByText(HERO) !== null;

describe("the animation queue", () => {
  it("plays an update's events in order, one slot each, and shows its view after them", async () => {
    const connection = await inGame();
    const played = step(newGame(), playHero, "s1", 2);
    connection.receive(played.msg);
    expect(logLines()).toEqual(["You played Placeholder Bard 1"]);
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("You played Placeholder Bard 1");
    expect(holdsHero()).toBe(true);
    wait(300);
    expect(holdsHero()).toBe(false);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();

    const joined = step(played.state, botPasses, "s1", 3);
    connection.receive(joined.msg);
    expect(logLines()).toEqual(["You played Placeholder Bard 1", "Placeholder Bard 1 joined your party"]);
    expect(heroInParty()).toBe(false);
    wait(300);
    expect(heroInParty()).toBe(true);

    // Ending the turn has two events: TURN_ENDED, which has no line, then TURN_STARTED.
    connection.receive(step(joined.state, endTurn, "s1", 4).msg);
    expect(logLines()).toHaveLength(2);
    wait(300);
    expect(logLines().at(-1)).toBe("Turn 2: Bot 1's turn");
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("Turn 2: Bot 1's turn");
    expect(turnLine()).toHaveTextContent("Turn 1: your turn");
    wait(300);
    expect(turnLine()).toHaveTextContent("Turn 2: Bot 1's turn");
  });

  it("offers no actions while an event plays: the view on screen is out of date", async () => {
    const connection = await inGame();
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeEnabled();
    connection.receive(step(newGame(), playHero, "s1", 2).msg);
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeDisabled();
    for (const card of within(screen.getByRole("region", { name: "Your hand" })).getAllByRole("button")) expect(card).toBeDisabled();
  });

  it("shows a countdown at once, while the update before it is still playing", async () => {
    const connection = await inGame("s2");
    connection.receive(step(newGame(), playHero, "s2", 2).msg, { t: "countdown", seat: "s2", ms: 15_000 });
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("Alice played Placeholder Bard 1");
    expect(screen.getByRole("timer")).toHaveTextContent("15s left");
  });

  it("shows the latest view at once when a version is skipped", async () => {
    const connection = await inGame();
    connection.receive(step(newGame(), playHero, "s1", 3).msg);
    expect(holdsHero()).toBe(false);
    expect(logLines()).toEqual(["You played Placeholder Bard 1"]);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });

  it("shows the latest view at once, every event logged, when a lower version arrives mid-animation", async () => {
    const connection = await inGame();
    const played = step(newGame(), playHero, "s1", 2);
    connection.receive(played.msg);
    connection.receive(step(played.state, botPasses, "s1", 1).msg);
    expect(heroInParty()).toBe(true);
    expect(logLines()).toEqual(["You played Placeholder Bard 1", "Placeholder Bard 1 joined your party"]);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });

  it("jumps to the latest view when updates pile up", async () => {
    const connection = await inGame();
    const played = step(newGame(), playHero, "s1", 2);
    connection.receive(played.msg, { ...played.msg, version: 3 }, { ...played.msg, version: 4 });
    expect(screen.getByRole("region", { name: "Now playing" })).toBeInTheDocument();
    expect(holdsHero()).toBe(true);

    connection.receive(step(played.state, botPasses, "s1", 5).msg);
    expect(heroInParty()).toBe(true);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    expect(logLines()).toHaveLength(3 + 1);
  });

  it("shows views at once when the player skips animations, including the one playing", async () => {
    const connection = await inGame();
    const played = step(newGame(), playHero, "s1", 2);
    connection.receive(played.msg);
    act(() => screen.getByRole("checkbox", { name: "Skip animations" }).click());
    expect(holdsHero()).toBe(false);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();

    connection.receive(step(played.state, botPasses, "s1", 3).msg);
    expect(heroInParty()).toBe(true);
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });
});

describe("Waiting for responses…", () => {
  const status = () => screen.queryByText("Waiting for responses…");

  it("shows once the player has nothing left to answer in a response window, naming nobody", async () => {
    const connection = await inGame("s1");
    expect(status()).toBeNull();
    connection.receive(step(newGame(), playHero, "s1", 2).msg);
    wait(300);
    expect(status()).toHaveTextContent(/^Waiting for responses…$/);
  });

  it("doesn't show while the window awaits the player", async () => {
    const connection = await inGame("s2");
    const played = step(newGame(), playHero, "s2", 2);
    connection.receive(played.msg);
    wait(300);
    expect(status()).toBeNull();

    connection.receive(step(played.state, botPasses, "s2", 3).msg);
    wait(300);
    expect(status()).toBeNull();
  });
});
