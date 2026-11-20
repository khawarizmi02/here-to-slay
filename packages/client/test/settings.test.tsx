import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MODIFIER, newGame as game, step, viewOf } from "./real-game.js";
import { ALICE, BOT, memoryStorage, renderClient, renderInLobby } from "./render.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];
const newGame = () => game({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO, MODIFIER] } });
const playHero = { type: "PLAY_HERO", player: "s1", card: ALICE_HERO } as const;

const nowPlaying = () => screen.queryByRole("region", { name: "Now playing" });
const settings = () => screen.getByRole("dialog", { name: "Settings" });

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** In a game at version 1, with the clock under the test's control. */
async function inGame(storage = memoryStorage()) {
  const client = await renderInLobby([ALICE, BOT], "s1", { storage });
  client.connection.receive({ t: "update", version: 1, events: [], view: viewOf(newGame(), "s1") });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return client;
}

/** Opens the settings panel from the room bar, makes a change, and closes it. */
function change(set: () => void) {
  act(() => screen.getByRole("button", { name: "Settings" }).click());
  act(set);
  act(() => within(settings()).getByRole("button", { name: "Close" }).click());
}

describe("the settings panel", () => {
  it("opens from the first screen", async () => {
    const { user } = renderClient();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(settings()).toBeInTheDocument();
    await user.click(within(settings()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["Slow", 600],
    ["Normal", 300],
    ["Fast", 150],
  ])("plays each event for a %s slot", async (speed, ms) => {
    const { connection } = await inGame();
    change(() => within(settings()).getByRole("radio", { name: speed }).click());
    connection.receive(step(newGame(), playHero, "s1", 2).msg);
    wait(ms - 1);
    expect(nowPlaying()).toBeInTheDocument();
    wait(1);
    expect(nowPlaying()).toBeNull();
  });

  it("skips animations: views show as soon as they arrive", async () => {
    const { connection } = await inGame();
    change(() => within(settings()).getByRole("checkbox", { name: "Skip animations" }).click());
    connection.receive(step(newGame(), playHero, "s1", 2).msg);
    expect(nowPlaying()).toBeNull();
  });

  it("keeps settings through a reload", async () => {
    const storage = memoryStorage();
    await inGame(storage);
    change(() => {
      within(settings()).getByRole("radio", { name: "Fast" }).click();
      within(settings()).getByRole("checkbox", { name: "Skip animations" }).click();
      fireEvent.change(within(settings()).getByRole("slider", { name: "Volume" }), { target: { value: "40" } });
      within(settings()).getByRole("checkbox", { name: "Sound" }).click();
    });
    cleanup();
    vi.useRealTimers();

    await inGame(storage);
    act(() => screen.getByRole("button", { name: "Settings" }).click());
    expect(within(settings()).getByRole("radio", { name: "Fast" })).toBeChecked();
    expect(within(settings()).getByRole("checkbox", { name: "Skip animations" })).toBeChecked();
    expect(within(settings()).getByRole("checkbox", { name: "Sound" })).not.toBeChecked();
    expect(within(settings()).getByRole("slider", { name: "Volume" })).toHaveValue("40");
  });

  it.each(["not json", JSON.stringify({ animationSpeed: "warp", skipAnimations: "yes", sound: 1, volume: 7 }), "null"])(
    "falls back to the defaults when the saved settings are %s",
    async (saved) => {
      const storage = memoryStorage({ "here-to-slay.settings": saved });
      await inGame(storage);
      act(() => screen.getByRole("button", { name: "Settings" }).click());
      expect(within(settings()).getByRole("radio", { name: "Normal" })).toBeChecked();
      expect(within(settings()).getByRole("checkbox", { name: "Skip animations" })).not.toBeChecked();
      expect(within(settings()).getByRole("checkbox", { name: "Sound" })).toBeChecked();
      expect(within(settings()).getByRole("slider", { name: "Volume" })).toHaveValue("80");
    },
  );
});
