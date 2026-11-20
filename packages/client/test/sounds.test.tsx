import type { GameEvent } from "@here-to-slay/engine";
import type { RoomMsg } from "@here-to-slay/protocol";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MODIFIER, newGame as game, step, viewOf } from "./real-game.js";
import { FakeConnection } from "./fake-connection.js";
import { ALICE, BOT, renderClient, renderInLobby, skipAnimations } from "./render.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];
const newGame = () => game({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO, MODIFIER] } });
const card = (id: string) => ({ id, def: id.split("#")[0]! });
const monster = () => card(newGame().activeMonsters[0]!);

/** One of each event that makes a sound, and one that doesn't, in an update for Alice (s1). */
const EVENTS: GameEvent[] = [
  { type: "CHALLENGE_WINDOW_OPENED", player: "s2", card: card(BOT_HERO) },
  { type: "CHALLENGE_PLAYED", player: "s1", card: card(CHALLENGE), defender: "s2", target: card(BOT_HERO) },
  { type: "DICE_ROLLED", roll: "r1", player: "s1", dice: [3, 4], bonus: 0, total: 7, rollKind: "challenge", side: "challenger", target: card(BOT_HERO) },
  { type: "MODIFIER_PLAYED", player: "s2", card: card(MODIFIER), roll: "r1", value: 4, total: 11 },
  { type: "TURN_ENDED", player: "s2" },
  { type: "MONSTER_SLAIN", player: "s1", monster: monster() },
  { type: "TURN_STARTED", player: "s2", turnNumber: 2 },
  { type: "TURN_STARTED", player: "s1", turnNumber: 3 },
  { type: "GAME_WON", player: "s1", reason: "monsters" },
];
const SOUNDS = ["cardPlayed", "challenge", "diceRoll", "cardPlayed", "monsterSlain", "yourTurn", "gameOver"];

const events = (): RoomMsg => ({ t: "update", version: 2, events: EVENTS as unknown as Extract<RoomMsg, { t: "update" }>["events"], view: viewOf(newGame(), "s1") });

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** In a game at version 1 as Seat `seat`, with the clock under the test's control. */
async function inGame(seat = "s1") {
  const client = await renderInLobby([ALICE, BOT], seat);
  client.connection.receive({ t: "update", version: 1, events: [], view: viewOf(newGame(), seat) });
  client.sounds.take();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return client;
}

/** The Bot (s2) is asked to respond to Alice's hero, as the Room asks a local Seat. */
function askBot(connection: Awaited<ReturnType<typeof inGame>>["connection"]) {
  connection.receive(step(newGame(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, "s2", 2).msg, {
    t: "respond",
    seat: "s2",
    actions: [{ type: "PASS", player: "s2" }],
  });
}

function openSettings() {
  act(() => screen.getByRole("button", { name: "Settings" }).click());
  return screen.getByRole("dialog", { name: "Settings" });
}

function mute() {
  const panel = openSettings();
  act(() => within(panel).getByRole("checkbox", { name: "Sound" }).click());
}

describe("sounds", () => {
  it("plays each event's sound as the animation queue plays it", async () => {
    const { connection, sounds } = await inGame();
    connection.receive(events());
    expect(sounds.take()).toEqual(["cardPlayed"]);
    wait(300);
    expect(sounds.take()).toEqual(["challenge"]);
    wait(300 * EVENTS.length);
    expect(sounds.take()).toEqual(SOUNDS.slice(2));
  });

  it("plays a sound when a Response Window asks the Seat, once the event before it has played", async () => {
    const { connection, sounds } = await inGame("s2");
    askBot(connection);
    expect(sounds.take()).toEqual(["cardPlayed"]);
    wait(300);
    expect(sounds.take()).toEqual(["respond"]);
  });

  it("with animations skipped, plays only 'your turn' and 'respond'", async () => {
    const { connection, sounds } = await inGame();
    skipAnimations();
    connection.receive(events());
    expect(sounds.take()).toEqual(["yourTurn"]);
    cleanup();
    vi.useRealTimers();

    const bot = await inGame("s2");
    skipAnimations();
    askBot(bot.connection);
    expect(bot.sounds.take()).toEqual(["respond"]);
  });

  it("plays at the volume set", async () => {
    const { connection, sounds } = await inGame();
    fireEvent.change(within(openSettings()).getByRole("slider", { name: "Volume" }), { target: { value: "40" } });
    connection.receive(events());
    expect(sounds.played).toEqual([{ sound: "cardPlayed", volume: 0.4 }]);
  });

  it("plays nothing muted", async () => {
    const { connection, sounds } = await inGame();
    mute();
    connection.receive(events());
    wait(300 * EVENTS.length);
    expect(sounds.take()).toEqual([]);
    cleanup();
    vi.useRealTimers();

    const bot = await inGame("s2");
    mute();
    askBot(bot.connection);
    wait(300);
    expect(bot.sounds.take()).toEqual([]);
  });

  it("plays 'card played' for a card played with no Challenge Window", async () => {
    const { connection, sounds } = await inGame();
    const noChallenges = game({ players, hands: { s1: [ALICE_HERO] }, config: { maxChallengesPerPlay: 0 } });
    connection.receive({ t: "update", version: 2, events: [], view: viewOf(noChallenges, "s1") });
    connection.receive(step(noChallenges, { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, "s1", 3).msg);
    wait(300 * 5);
    expect(sounds.take()).toContain("cardPlayed");
  });

  it("plays 'your turn' for the next player on this device once they have it", async () => {
    const client = renderClient();
    await client.user.click(screen.getByRole("button", { name: "Play on this device" }));
    const bob = { id: "s2", name: "Bob", kind: "local", connected: true } as const;
    client.connection.receive({ t: "lobby", roomCode: "ABCDE", seats: [ALICE, bob], you: ["s1"] });
    const bobConnection = new FakeConnection();
    client.addSeat({ connection: bobConnection, name: "Bob", seatId: "s2" });
    bobConnection.receive({ t: "lobby", roomCode: "ABCDE", seats: [ALICE, bob], you: ["s2"] });
    const both = game({ players: [players[0]!, { id: "s2", name: "Bob", isBot: false }], hands: {} });
    client.connection.receive({ t: "update", version: 1, events: [], view: viewOf(both, "s1") });
    bobConnection.receive({ t: "update", version: 1, events: [], view: viewOf(both, "s2") });
    await client.user.click(screen.getByRole("button", { name: "I'm Player 1" }));
    client.sounds.take();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const endTurn = { type: "END_TURN", player: "s1" } as const;
    client.connection.receive(step(both, endTurn, "s1", 2).msg);
    bobConnection.receive(step(both, endTurn, "s2", 2).msg);
    wait(300 * 5);
    expect(client.sounds.take()).toEqual([]);
    act(() => screen.getByRole("button", { name: "I'm Bob" }).click());
    expect(client.sounds.take()).toEqual(["yourTurn"]);
  });
});
