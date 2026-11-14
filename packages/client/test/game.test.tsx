import * as toy from "@here-to-slay/toy-engine";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeConnection } from "./fake-connection.js";
import { ALICE, BOT, renderInLobby } from "./render.js";

afterEach(cleanup);

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** Hands of two: Alice holds point_1 and challenge, the bot point_2 and modifier, and one card is left to draw. */
function newGame(deckOrder: toy.ToyCardDefId[] = ["point_1", "challenge", "point_2", "modifier", "point_3"], targetScore = 5) {
  return toy.createGame({ players, seed: "client", config: { handSize: 2, targetScore }, deckOrder });
}

function play(state: toy.GameState, ...actions: toy.Action[]): toy.GameState {
  for (const action of actions) {
    const result = toy.applyAction(state, action);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  }
  return state;
}

let version = 1;

function update(state: toy.GameState, seat: string) {
  return { t: "update" as const, version: version++, events: [], view: toy.getPlayerView(state, seat) as unknown as Record<string, unknown> };
}

/** Renders the client as Seat `seat`, past the lobby, showing `state`. */
async function inGame(state: toy.GameState, seat = "s1"): Promise<FakeConnection> {
  const { connection } = await renderInLobby([ALICE, BOT], seat);
  connection.receive(update(state, seat));
  connection.takeSent();
  return connection;
}

function hand() {
  return within(screen.getByRole("region", { name: "Your hand" }));
}

describe("turns", () => {
  it("makes only legal actions clickable, and plays the one clicked", async () => {
    const connection = await inGame(newGame());
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeEnabled();
    expect(hand().getByRole("button", { name: "1 Point" })).toBeEnabled();
    expect(hand().getByRole("button", { name: "Challenge" })).toBeDisabled();

    hand().getByRole("button", { name: "1 Point" }).click();
    expect(connection.takeSent()).toEqual([
      { t: "action", seat: "s1", action: { type: "PLAY_HERO", player: "s1", card: "point_1#0" }, clientSeq: 0 },
    ]);
  });

  it("offers nothing on someone else's turn", async () => {
    await inGame(newGame(), "s2");
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeDisabled();
    for (const card of hand().getAllByRole("button")) expect(card).toBeDisabled();
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
  const asked = () => play(newGame(), { type: "PLAY_HERO", player: "s1", card: "point_1#0" });

  it("shows response options only once the Room sends respond, even though the view offers them", async () => {
    const connection = await inGame(asked(), "s2");
    expect(toy.getPlayerView(asked(), "s2").legalActions).toContainEqual({ type: "PASS", player: "s2" });
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();

    connection.receive({
      t: "respond",
      seat: "s2",
      actions: [
        { type: "PASS", player: "s2" },
        { type: "PLAY_MODIFIER", player: "s2", card: "modifier#0", value: 1 },
      ],
    });
    expect(screen.getByRole("button", { name: "Play Modifier +1" })).toBeEnabled();
    screen.getByRole("button", { name: "Pass" }).click();
    expect(connection.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PASS", player: "s2" }, clientSeq: 0 }]);
  });

  it("drops the response options once the next update arrives", async () => {
    const connection = await inGame(asked(), "s2");
    connection.receive({ t: "respond", seat: "s2", actions: [{ type: "PASS", player: "s2" }] });
    connection.receive(update(play(asked(), { type: "PASS", player: "s2" }), "s2"));
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
  const wished = () =>
    play(newGame(["wish", "challenge", "point_2", "modifier", "point_3"]), { type: "PLAY_HERO", player: "s1", card: "wish#0" }, { type: "PASS", player: "s2" });

  it("shows the decider its options and sends the one picked", async () => {
    const connection = await inGame(wished());
    const modal = within(screen.getByRole("dialog", { name: "Make a wish" }));
    modal.getByRole("button", { name: "Draw 2 cards" }).click();
    expect(connection.takeSent()).toEqual([
      { t: "action", seat: "s1", action: { type: "RESOLVE_DECISION", player: "s1", decisionId: "d1", answer: { selected: ["draw2"] } }, clientSeq: 0 },
    ]);
  });

  it("tells everyone else who is choosing", async () => {
    await inGame(wished(), "s2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Waiting for Alice to choose…")).toBeInTheDocument();
  });
});

describe("the game log", () => {
  /** Applies `action` to `state`, and the update `seat` gets for it, events and all. */
  function step(state: toy.GameState, action: toy.Action, seat: string) {
    const result = toy.applyAction(state, action);
    if (!result.ok) throw new Error(result.error);
    return { state: result.state, msg: { ...update(result.state, seat), events: toy.getPlayerEvents(result.events, seat) } };
  }

  function logLines() {
    return within(screen.getByRole("list", { name: "Game log" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  }

  it("tells the Seat what happened, update by update, in a log that starts collapsed", async () => {
    const connection = await inGame(newGame());
    expect(screen.getByText("Game log").closest("details")).not.toHaveAttribute("open");

    const played = step(newGame(), { type: "PLAY_HERO", player: "s1", card: "point_1#0" }, "s1");
    connection.receive(played.msg);
    connection.receive(step(played.state, { type: "PASS", player: "s2" }, "s1").msg);
    expect(logLines()).toEqual(["You played 1 Point", "Bot 1 passed", "You scored 1 point (1 in all)", "Turn 2: Bot 1's turn"]);
  });

  it("shows only what the Seat may see: a card someone else draws stays hidden", async () => {
    const drawn = step(newGame(), { type: "DRAW_CARD", player: "s1" }, "s2");
    const connection = await inGame(newGame(), "s2");
    connection.receive(drawn.msg);
    expect(logLines()).toContain("Alice drew a card");
    expect(logLines().join()).not.toContain("3 Points");

    cleanup();
    const mine = await inGame(newGame(), "s1");
    mine.receive(step(newGame(), { type: "DRAW_CARD", player: "s1" }, "s1").msg);
    expect(logLines()).toContain("You drew 3 Points");
  });
});

describe("game over", () => {
  it("names the winner", async () => {
    const won = play(newGame(["point_1", "challenge", "point_2", "modifier", "point_3"], 1), { type: "PLAY_HERO", player: "s1", card: "point_1#0" }, {
      type: "PASS",
      player: "s2",
    });
    await inGame(won, "s2");
    expect(screen.getByRole("heading", { name: "Alice wins!" })).toBeInTheDocument();
  });
});
