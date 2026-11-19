import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GameState } from "@here-to-slay/engine";
import { cardName } from "../src/board/cards.js";
import type { FakeConnection } from "./fake-connection.js";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MODIFIER, engine, newGame as game, play, step, update, type GameSetup } from "./real-game.js";
import { ALICE, BOT, renderInLobby } from "./render.js";

afterEach(cleanup);

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** Alice holds a hero and a Challenge, the bot a hero and a Challenge. The Beast needs 2 heroes; the Slime needs none. */
function newGame(more: Partial<GameSetup> = {}) {
  return game({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO, "challenge_01#1"] }, monsters: ["monster_01#0", "monster_02#0"], ...more });
}

/** Renders the client as Seat `seat`, past the lobby, showing `state`. */
async function inGame(state: GameState, seat = "s1"): Promise<FakeConnection> {
  const { connection } = await renderInLobby([ALICE, BOT], seat);
  connection.receive(update(state, seat, 1));
  connection.takeSent();
  return connection;
}

const hand = () => within(screen.getByRole("region", { name: "Your hand" }));
const sent = (connection: FakeConnection) => connection.takeSent().map((m) => ("action" in m ? m.action : m));

describe("turns", () => {
  it("makes only legal actions clickable, and plays the one clicked", async () => {
    const connection = await inGame(newGame());
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Attack Placeholder Slime" })).toBeEnabled();
    expect(hand().getByRole("button", { name: "Placeholder Bard 1" })).toBeEnabled();
    expect(hand().getByRole("button", { name: "Placeholder Challenge" })).toBeDisabled();

    hand().getByRole("button", { name: "Placeholder Bard 1" }).click();
    expect(connection.takeSent()).toEqual([{ t: "action", seat: "s1", action: { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, clientSeq: 0 }]);
  });

  it("says why a control is disabled, in the engine's words", async () => {
    await inGame(newGame());
    // The Party Leader counts as one hero.
    const beast = screen.getByRole("button", { name: "Attack Placeholder Beast" });
    expect(beast).toBeDisabled();
    expect(beast).toHaveAccessibleDescription("Needs 2 heroes");
    expect(screen.getByText("Needs 2 heroes")).toBeVisible();
    expect(hand().getByRole("button", { name: "Placeholder Challenge" })).toHaveAccessibleDescription("Play it when someone plays a card");
  });

  it("gives the AP a control needs once the player runs short", async () => {
    const state = newGame();
    state.actionPoints = 1;
    await inGame(state);
    expect(screen.getByRole("button", { name: "Attack Placeholder Slime" })).toHaveAccessibleDescription("Needs 2 AP");
    expect(screen.getByRole("button", { name: "Discard and redraw" })).toHaveAccessibleDescription("Needs 3 AP");
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "End turn" })).toBeEnabled();
  });

  it("offers nothing on someone else's turn", async () => {
    await inGame(newGame(), "s2");
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Draw a card" })).toHaveAccessibleDescription("Not your turn");
    for (const card of hand().getAllByRole("button")) expect(card).toBeDisabled();
  });

  it("asks which hero an item goes on when it could go on more than one", async () => {
    const state = newGame({ hands: { s1: ["item_01#0"] } });
    const alice = state.players.find((p) => p.id === "s1")!;
    for (const hero of ["hero_bard_02#0", "hero_ranger_01#0"]) {
      state.mainDeck = state.mainDeck.filter((c) => c !== hero);
      alice.party.push({ instanceId: hero, equippedItem: null, rolledThisTurn: false });
    }
    const connection = await inGame(state);
    hand().getByRole("button", { name: "Placeholder Charm" }).click();
    const targets = within(await screen.findByRole("region", { name: "Equip Placeholder Charm" }));
    targets.getByRole("button", { name: "Placeholder Ranger 1" }).click();
    expect(sent(connection)).toEqual([{ type: "PLAY_ITEM", player: "s1", card: "item_01#0", targetHero: "hero_ranger_01#0" }]);
  });

  it("shows the Room's reason when it rejects an action", async () => {
    const connection = await inGame(newGame());
    connection.receive({ t: "actionRejected", clientSeq: 0, error: "It is not your turn" });
    expect(screen.getByRole("alert")).toHaveTextContent("It is not your turn");
  });

  it("lets the player carry on after a rejection, and drops the reason once they act again", async () => {
    const connection = await inGame(newGame());
    connection.receive({ t: "actionRejected", clientSeq: 0, error: "It is not your turn" });

    screen.getByRole("button", { name: "Draw a card" }).click();
    expect(connection.takeSent()).toEqual([{ t: "action", seat: "s1", action: { type: "DRAW_CARD", player: "s1" }, clientSeq: 0 }]);
    expect(await screen.findByRole("button", { name: "Draw a card" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("response windows", () => {
  const asked = () => play(newGame(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO });

  it("shows response options only once the Room sends respond, even though the view offers them", async () => {
    const connection = await inGame(asked(), "s2");
    expect(engine.getPlayerView(asked(), "s2").legalActions).toContainEqual({ type: "PASS", player: "s2" });
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
    expect(screen.getByText("A Challenge Window is open on Placeholder Bard 1")).toBeInTheDocument();

    connection.receive({
      t: "respond",
      seat: "s2",
      actions: [
        { type: "PASS", player: "s2" },
        { type: "PLAY_CHALLENGE", player: "s2", card: "challenge_01#1" },
      ],
    });
    expect(screen.getByRole("button", { name: "Play Placeholder Challenge" })).toBeEnabled();
    screen.getByRole("button", { name: "Pass" }).click();
    expect(connection.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PASS", player: "s2" }, clientSeq: 0 }]);
  });

  it("labels a Modifier with its value", async () => {
    const rolling = play(newGame({ hands: { s1: [ALICE_HERO], s2: [MODIFIER] } }), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, { type: "PASS", player: "s2" }, {
      type: "ROLL_HERO_EFFECT",
      player: "s1",
      hero: ALICE_HERO,
    });
    const connection = await inGame(rolling, "s2");
    const options = engine.getPlayerView(rolling, "s2").legalActions;
    connection.receive({ t: "respond", seat: "s2", actions: options });
    expect(screen.getByRole("button", { name: "Play Modifier +4 (+4)" })).toBeEnabled();
    expect(screen.getByRole("group", { name: "Dice" })).toHaveTextContent(/Alice's roll: \d+/);
  });

  it("drops the response options once the next update arrives", async () => {
    const connection = await inGame(asked(), "s2");
    connection.receive({ t: "respond", seat: "s2", actions: [{ type: "PASS", player: "s2" }] });
    connection.receive(update(play(asked(), { type: "PASS", player: "s2" }), "s2", 2));
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
  });

  it("with one local Seat, confirms the device straight away and never shows the Pass-Device Step", async () => {
    const connection = await inGame(asked(), "s2");
    connection.receive({ t: "passDevice", seat: "s2", name: "Bot 1" });
    expect(connection.takeSent()).toEqual([{ t: "confirmPassDevice", seat: "s2" }]);
    expect(screen.queryByText(/pass the device/i)).toBeNull();
  });
});

describe("decisions", () => {
  /** A leader draft: the first Decision of the game. */
  const drafting = () => newGame({ config: { leaderSelection: "draft" } });

  it("shows the decider its options and sends the one picked", async () => {
    const state = drafting();
    const decision = state.pendingDecision!;
    const connection = await inGame(state, decision.player);
    const modal = within(screen.getByRole("dialog", { name: decision.prompt }));
    const first = decision.options[0]!;
    modal.getByRole("button", { name: cardName(first.def!) }).click();
    expect(modal.getAllByRole("button")).toHaveLength(decision.options.length);
    expect(sent(connection)).toEqual([{ type: "RESOLVE_DECISION", player: decision.player, decisionId: decision.id, answer: { selected: [first.id] } }]);
  });

  it("tells everyone else who is choosing", async () => {
    const state = drafting();
    const decider = state.pendingDecision!.player;
    await inGame(state, decider === "s1" ? "s2" : "s1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(`Waiting for ${decider === "s1" ? "Alice" : "Bot 1"} to choose…`)).toBeInTheDocument();
  });
});

describe("the game log", () => {
  function logLines() {
    return within(screen.getByRole("list", { name: "Game log" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  }

  it("tells the Seat what happened, update by update, in a log that starts collapsed", async () => {
    const connection = await inGame(newGame());
    expect(screen.getByText("Game log").closest("details")).not.toHaveAttribute("open");

    // What the log holds, not how it plays: the animation queue has its own tests.
    act(() => screen.getByRole("checkbox", { name: "Skip animations" }).click());
    const played = step(newGame(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, "s1", 2);
    connection.receive(played.msg);
    connection.receive(step(played.state, { type: "PASS", player: "s2" }, "s1", 3).msg);
    expect(logLines()).toEqual(["You played Placeholder Bard 1", "Placeholder Bard 1 joined your party"]);
  });

  it("shows only what the Seat may see: a card someone else draws stays hidden", async () => {
    const connection = await inGame(newGame(), "s2");
    connection.receive(step(newGame(), { type: "DRAW_CARD", player: "s1" }, "s2", 2).msg);
    expect(logLines()).toContain("Alice drew a card");

    cleanup();
    const mine = await inGame(newGame(), "s1");
    mine.receive(step(newGame(), { type: "DRAW_CARD", player: "s1" }, "s1", 2).msg);
    expect(logLines().some((l) => l?.startsWith("You drew ") && l !== "You drew a card")).toBe(true);
  });
});

describe("game over", () => {
  it("names the winner and how they won", async () => {
    const won = newGame();
    won.winner = "s1";
    won.winReason = "monsters";
    won.phase = { kind: "gameOver" };
    await inGame(won, "s2");
    expect(screen.getByRole("heading", { name: "Alice wins!" })).toBeInTheDocument();
    expect(screen.getByText("By slaying monsters")).toBeInTheDocument();
  });
});
