import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GameState } from "@here-to-slay/engine";
import type { FakeConnection } from "./fake-connection.js";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MODIFIER, engine, newGame as game, play, step, update } from "./real-game.js";
import { ALICE, BOT, renderInLobby, skipAnimations } from "./render.js";

afterEach(cleanup);

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** The bot's turn: it holds a hero, Alice a Challenge. The Slime needs no heroes. */
const botsTurn = () =>
  play(game({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO] }, monsters: ["monster_01#0", "monster_02#0"] }), { type: "END_TURN", player: "s1" });

/** Renders the client as Seat `seat`, past the lobby, showing `state`, with animations skipped. */
async function inGame(state: GameState, seat = "s1"): Promise<FakeConnection> {
  const { connection } = await renderInLobby([ALICE, BOT], seat);
  connection.receive(update(state, seat, 1));
  connection.takeSent();
  skipAnimations();
  return connection;
}

const spotlight = () => within(screen.getByRole("region", { name: "Spotlight" }));

describe("the Spotlight", () => {
  it("shows the card a bot plays face-up, with its text, and who played it", async () => {
    const connection = await inGame(botsTurn());
    connection.receive(step(botsTurn(), { type: "PLAY_HERO", player: "s2", card: BOT_HERO }, "s1", 2).msg);

    const card = spotlight().getByRole("figure", { name: "Placeholder Wizard 1" });
    expect(card).toHaveTextContent(/Wizard · Roll \d+\+/);
    expect(spotlight().getByText("Bot 1 played")).toBeInTheDocument();
  });

  it("shows the monster a bot attacks, with its numbers, and who attacked it", async () => {
    const connection = await inGame(botsTurn());
    connection.receive(step(botsTurn(), { type: "ATTACK_MONSTER", player: "s2", monster: "monster_02#0" }, "s1", 2).msg);

    expect(spotlight().getByRole("figure", { name: "Placeholder Slime" })).toHaveTextContent(/Slay \d+\+ · Defeat \d+-/);
    expect(spotlight().getByText("Bot 1 attacked")).toBeInTheDocument();
  });

  it("shows the hero a bot rolls for", async () => {
    const heroIn = play(botsTurn(), { type: "PLAY_HERO", player: "s2", card: BOT_HERO }, { type: "PASS", player: "s1" });
    const connection = await inGame(heroIn);
    connection.receive(step(heroIn, { type: "ROLL_HERO_EFFECT", player: "s2", hero: BOT_HERO }, "s1", 2).msg);

    expect(spotlight().getByRole("figure", { name: "Placeholder Wizard 1" })).toBeInTheDocument();
    expect(spotlight().getByText("Bot 1 rolled for")).toBeInTheDocument();
  });

  it("shows the card in a Challenge Window even with no events to go on, as after a refresh", async () => {
    await inGame(play(botsTurn(), { type: "PLAY_HERO", player: "s2", card: BOT_HERO }));

    expect(spotlight().getByRole("figure", { name: "Placeholder Wizard 1" })).toBeInTheDocument();
    expect(spotlight().getByText("Bot 1 played")).toBeInTheDocument();
  });

  /** Alice's turn: she holds a hero, the bot `cards`. */
  const aliceHolds = (cards: string[]) => game({ players, hands: { s1: [ALICE_HERO], s2: cards } });

  it("moves from the player's own card to a Challenge a bot plays on it", async () => {
    const connection = await inGame(aliceHolds(["challenge_01#1"]));
    const heroPlayed = step(aliceHolds(["challenge_01#1"]), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, "s1", 2);
    connection.receive(heroPlayed.msg);
    expect(spotlight().getByText("You played")).toBeInTheDocument();

    connection.receive(step(heroPlayed.state, { type: "PLAY_CHALLENGE", player: "s2", card: "challenge_01#1" }, "s1", 3).msg);
    expect(spotlight().getByRole("figure", { name: "Placeholder Challenge" })).toBeInTheDocument();
    expect(spotlight().getByText("Bot 1 played")).toBeInTheDocument();
  });

  it("moves to a Modifier a bot plays on the player's roll", async () => {
    const rolling = play(aliceHolds([MODIFIER]), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, { type: "PASS", player: "s2" }, { type: "ROLL_HERO_EFFECT", player: "s1", hero: ALICE_HERO });
    const connection = await inGame(rolling);
    const modifier = engine.getLegalActions(rolling, "s2").find((a) => a.type === "PLAY_MODIFIER")!;
    connection.receive(step(rolling, modifier, "s1", 2).msg);
    expect(spotlight().getByRole("figure", { name: "Modifier +4" })).toBeInTheDocument();
    expect(spotlight().getByText("Bot 1 played")).toBeInTheDocument();
  });
});
