import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GameState, ModifierWindowFrame } from "@here-to-slay/engine";
import { DEVICE_CARDS } from "../src/board/cards.js";
import type { FakeConnection } from "./fake-connection.js";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MODIFIER, engine, newGame as game, play, step, update, type GameSetup } from "./real-game.js";
import { ALICE, BOT, renderInLobby, skipAnimations } from "./render.js";

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
const logLines = () =>
  within(screen.getByRole("list", { name: "Game log" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

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
    expect(screen.getByRole("button", { name: /^Play Modifier \+4 \(\+4\) → \d+/ })).toBeEnabled();
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

describe("a Modifier Window", () => {
  /** Sets the open Modifier Window's rolls to `totals`, in order, as if the dice had landed there. */
  function atTotals(state: GameState, ...totals: number[]): GameState {
    const window = state.stack.at(-1) as ModifierWindowFrame;
    window.rolls.forEach((r, i) => (r.total = totals[i]!));
    return state;
  }

  /** Renders `state` as Seat `seat`, asked for its response. */
  async function asked(state: GameState, seat: string) {
    const connection = await inGame(state, seat);
    connection.receive({ t: "respond", seat, actions: engine.getPlayerView(state, seat).legalActions });
  }

  it("on a hero's roll, says who rolls for which hero, the total and what it needs, and what each Modifier leads to", async () => {
    const rolling = play(newGame({ hands: { s1: [ALICE_HERO], s2: [MODIFIER] } }), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, { type: "PASS", player: "s2" }, {
      type: "ROLL_HERO_EFFECT",
      player: "s1",
      hero: ALICE_HERO,
    });
    await asked(atTotals(rolling, 5), "s2");
    expect(screen.getByText("Alice rolls for Placeholder Bard 1's effect: 5, needs 8+")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play Modifier +4 (+4) → 9 (succeeds)" })).toBeEnabled();
  });

  it("on a monster attack, names the monster, the total and both its slay and defeat values", async () => {
    const attacking = play(newGame({ hands: { s1: [], s2: [MODIFIER] } }), { type: "ATTACK_MONSTER", player: "s1", monster: "monster_02#0" });
    await asked(atTotals(attacking, 2), "s2");
    expect(screen.getByText("Alice attacks Placeholder Slime: 2, slays on 7+, defeated on 3 or less")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play Modifier +4 (+4) → 6 (no effect)" })).toBeEnabled();
  });

  /** Alice plays her hero, holding a Modifier; the bot Challenges it. */
  const challenged = (config = {}) =>
    play(
      newGame({ hands: { s1: [ALICE_HERO, MODIFIER], s2: ["challenge_01#1"] }, config }),
      { type: "PLAY_HERO", player: "s1", card: ALICE_HERO },
      { type: "PLAY_CHALLENGE", player: "s2", card: "challenge_01#1" },
    );

  it("on a Challenge, names the challenged card, both totals and who is winning, and which roll each Modifier is on", async () => {
    await asked(atTotals(challenged(), 7, 5), "s1");
    expect(screen.getByText("Bot 1 challenges Alice's Placeholder Bard 1: 7 vs 5, Bot 1 is winning")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play Modifier +4 (+4) on Bot 1's roll → 11 (Challenge succeeds)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Play Modifier +4 (+4) on Alice's roll → 9 (Challenge fails)" })).toBeEnabled();
  });

  it("gives a tied Challenge to the side challengeTieWinner names", async () => {
    await asked(atTotals(challenged({ challengeTieWinner: "challenger" }), 6, 6), "s1");
    expect(screen.getByText("Bot 1 challenges Alice's Placeholder Bard 1: 6 vs 6, Bot 1 is winning")).toBeInTheDocument();
    cleanup();
    await asked(atTotals(challenged({ challengeTieWinner: "challenged" }), 6, 6), "s1");
    expect(screen.getByText("Bot 1 challenges Alice's Placeholder Bard 1: 6 vs 6, Alice is winning")).toBeInTheDocument();
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
    modal.getByRole("button", { name: DEVICE_CARDS.name(first.def!) }).click();
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
  it("tells the Seat what happened, update by update, newest first, in a log that starts collapsed", async () => {
    const connection = await inGame(newGame());
    expect(screen.getByText("Game log").closest("details")).not.toHaveAttribute("open");

    // What the log holds, not how it plays: the animation queue has its own tests.
    skipAnimations();
    const played = step(newGame(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, "s1", 2);
    connection.receive(played.msg);
    expect(logLines()).toEqual(["You played Placeholder Bard 1"]);
    connection.receive(step(played.state, { type: "PASS", player: "s2" }, "s1", 3).msg);
    expect(logLines()).toEqual(["Placeholder Bard 1 joined your party", "You played Placeholder Bard 1"]);
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

  it("keeps the game log, newest first, on the game-over screen", async () => {
    const connection = await inGame(newGame());
    skipAnimations();
    const played = step(newGame(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }, "s1", 2);
    connection.receive(played.msg);
    const joined = step(played.state, { type: "PASS", player: "s2" }, "s1", 3);
    connection.receive(joined.msg);
    const won = structuredClone(joined.state);
    won.winner = "s1";
    won.winReason = "monsters";
    won.phase = { kind: "gameOver" };
    connection.receive(update(won, "s1", 4));
    expect(screen.getByRole("heading", { name: /wins!/ })).toBeInTheDocument();
    expect(logLines()).toEqual(["Placeholder Bard 1 joined your party", "You played Placeholder Bard 1"]);
  });
});
