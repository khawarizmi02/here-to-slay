import type { LobbySeat } from "@here-to-slay/protocol";
import * as toy from "@here-to-slay/toy-engine";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FakeConnection } from "./fake-connection.js";
import { ALICE, fakeRoom, renderClient, renderInLobby } from "./render.js";

afterEach(cleanup);

const BOB: LobbySeat = { id: "s2", name: "Bob", kind: "local", connected: true };
const BOT: LobbySeat = { id: "s3", name: "Bot 1", kind: "bot", connected: true };

describe("the lobby", () => {
  it("lets the Host add a player on this device", async () => {
    const { connection, user } = await renderInLobby();
    await user.type(screen.getByLabelText("Player name"), "Bob");
    await user.click(screen.getByRole("button", { name: "Add a player on this device" }));
    expect(connection.takeSent()).toEqual([{ t: "addLocalSeat", name: "Bob" }]);
  });
});

/** Alice holds point_1 and wish, Bob point_2 and challenge, the bot point_3 and modifier. */
function newGame() {
  return toy.createGame({
    players: [
      { id: "s1", name: "Alice", isBot: false },
      { id: "s2", name: "Bob", isBot: false },
      { id: "s3", name: "Bot 1", isBot: true },
    ],
    seed: "hot-seat",
    config: { handSize: 2, targetScore: 9 },
    deckOrder: ["point_1", "wish", "point_2", "challenge", "point_3", "modifier", "point_1", "point_2", "point_3", "point_1", "point_2"],
  });
}

function play(state: toy.GameState, ...actions: toy.Action[]): toy.GameState {
  for (const action of actions) {
    const result = toy.applyAction(state, action);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  }
  return state;
}

/** Alice and Bob on this device, with a bot, in a game that has just started. */
async function aliceAndBob() {
  const client = renderClient();
  await client.user.clear(screen.getByLabelText("Your name"));
  await client.user.type(screen.getByLabelText("Your name"), "Alice");
  await client.user.click(screen.getByRole("button", { name: "Play on this device" }));
  client.connection.receive({ t: "lobby", roomCode: "ABCDE", seats: [ALICE, BOB, BOT], you: ["s1"] });
  const bob = new FakeConnection();
  client.addSeat({ connection: bob, name: "Bob", seatId: "s2" });
  bob.receive({ t: "lobby", roomCode: "ABCDE", seats: [ALICE, BOB, BOT], you: ["s2"] });
  const alice = client.connection;
  let version = 1;
  /** Sends both Seats their view of `state`, as the Room does after every change. */
  const show = (state: toy.GameState) => {
    for (const [connection, seat] of [[alice, "s1"], [bob, "s2"]] as const) {
      connection.receive({ t: "update", version, events: [], view: toy.getPlayerView(state, seat) as unknown as Record<string, unknown> });
    }
    version++;
  };
  return { ...client, alice, bob, show };
}

const hand = () => within(screen.getByRole("region", { name: "Your hand" }));
const handHidden = () => expect(screen.queryByRole("region", { name: "Your hand" })).toBeNull();

describe("the Pass-Device Step for turns", () => {
  it("hides every hand until the first player says they have the device", async () => {
    const { show, user } = await aliceAndBob();
    show(newGame());
    expect(screen.getByRole("heading", { name: "Pass the device to Alice" })).toBeInTheDocument();
    handHidden();

    await user.click(screen.getByRole("button", { name: "I'm Alice" }));
    expect(hand().getByRole("button", { name: "1 Point" })).toBeEnabled();
  });

  it("passes to the next local player on their turn, and acts from their Seat", async () => {
    const { alice, bob, show, user } = await aliceAndBob();
    show(newGame());
    await user.click(screen.getByRole("button", { name: "I'm Alice" }));

    // Alice draws: her turn ends, and Bob's begins.
    const drawn = play(newGame(), { type: "DRAW_CARD", player: "s1" });
    expect(drawn.activePlayer).toBe("s2");
    show(drawn);
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    handHidden();

    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    hand().getByRole("button", { name: "2 Points" }).click();
    expect(bob.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PLAY_HERO", player: "s2", card: "point_2#0" }, clientSeq: 0 }]);
    expect(alice.takeSent()).toEqual([]);
  });

  it("asks again for the same player when the game waits on them twice in a row", async () => {
    const { show, user } = await aliceAndBob();
    show(newGame());
    await user.click(screen.getByRole("button", { name: "I'm Alice" }));

    // Alice's wish opens a response window; once everyone passes, she decides.
    const wished = play(newGame(), { type: "PLAY_HERO", player: "s1", card: "wish#0" });
    show(wished);
    expect(screen.queryByRole("heading", { name: /pass the device/i })).toBeNull();
    show(play(wished, { type: "PASS", player: "s2" }, { type: "PASS", player: "s3" }));
    expect(screen.getByRole("heading", { name: "Pass the device to Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "I'm Alice" }));
    expect(screen.getByRole("dialog", { name: "Make a wish" })).toBeInTheDocument();
  });

  it("stays on screen while the game waits on a Seat that isn't on this device", async () => {
    const { show, user } = await aliceAndBob();
    show(newGame());
    await user.click(screen.getByRole("button", { name: "I'm Alice" }));
    const bobsTurn = play(newGame(), { type: "DRAW_CARD", player: "s1" });
    show(bobsTurn);
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));

    const botsTurn = play(bobsTurn, { type: "DRAW_CARD", player: "s2" });
    expect(botsTurn.activePlayer).toBe("s3");
    show(botsTurn);
    expect(hand().getByRole("button", { name: "Challenge" })).toBeDisabled();

    show(play(botsTurn, { type: "DRAW_CARD", player: "s3" }));
    expect(screen.getByRole("heading", { name: "Pass the device to Alice" })).toBeInTheDocument();
  });
});

describe("the Pass-Device Step for response windows", () => {
  /** Alice has played her 1 Point, and Bob, holding a Challenge, is asked to respond. */
  async function bobAsked() {
    const client = await aliceAndBob();
    client.show(newGame());
    await client.user.click(screen.getByRole("button", { name: "I'm Alice" }));
    const played = play(newGame(), { type: "PLAY_HERO", player: "s1", card: "point_1#0" });
    client.show(played);
    client.bob.receive({ t: "passDevice", seat: "s2", name: "Bob" });
    return { ...client, played };
  }

  it("hides Alice's hand until Bob says he has the device, and only then tells the Room", async () => {
    const { alice, bob, user } = await bobAsked();
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    handHidden();
    expect(bob.takeSent()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    expect(bob.takeSent()).toEqual([{ t: "confirmPassDevice", seat: "s2" }]);
    expect(alice.takeSent()).toEqual([]);
  });

  it("shows Bob the options the Room sends, and responds from his Seat", async () => {
    const { bob, user } = await bobAsked();
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    bob.takeSent();
    bob.receive({
      t: "respond",
      seat: "s2",
      actions: [
        { type: "PASS", player: "s2" },
        { type: "PLAY_CHALLENGE", player: "s2", card: "challenge#0" },
      ],
    });
    expect(hand().getByRole("button", { name: "Challenge" })).toBeInTheDocument();
    screen.getByRole("button", { name: "Pass" }).click();
    expect(bob.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PASS", player: "s2" }, clientSeq: 0 }]);
  });

  it("shows the step every time the Room asks, even for the player already holding the device", async () => {
    const { bob, user } = await bobAsked();
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    bob.takeSent();

    bob.receive({ t: "passDevice", seat: "s2", name: "Bob" });
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    handHidden();
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    expect(bob.takeSent()).toEqual([{ t: "confirmPassDevice", seat: "s2" }]);
  });

  it("keeps the step up when the Room repeats its ask after an update", async () => {
    const { bob, played, show, user } = await bobAsked();
    show(played);
    bob.receive({ t: "passDevice", seat: "s2", name: "Bob" });
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    expect(bob.takeSent()).toEqual([{ t: "confirmPassDevice", seat: "s2" }]);
  });
});

describe("a refresh mid-game", () => {
  const pointer = { mode: "offline", role: "host", roomCode: "ABCDE", name: "Alice" } as const;

  /** Reloads into a Room with Alice and Bob on this device, as the composition root restores it. */
  async function resumed(state: toy.GameState) {
    const alice = new FakeConnection();
    const bob = new FakeConnection();
    const client = renderClient({
      pointer,
      resume: () =>
        Promise.resolve(
          fakeRoom([
            { connection: alice, name: "Alice", seatId: "s1" },
            { connection: bob, name: "Bob", seatId: "s2" },
          ]),
        ),
    });
    await screen.findByText("Connecting…");
    alice.receive({ t: "update", version: 7, events: [], view: toy.getPlayerView(state, "s1") as unknown as Record<string, unknown> });
    bob.receive({ t: "update", version: 7, events: [], view: toy.getPlayerView(state, "s2") as unknown as Record<string, unknown> });
    return { ...client, alice, bob };
  }

  it("restores every local Seat, and hides the hands until whoever's turn it is has the device", async () => {
    const { bob, user } = await resumed(play(newGame(), { type: "DRAW_CARD", player: "s1" }));
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    hand().getByRole("button", { name: "2 Points" }).click();
    expect(bob.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PLAY_HERO", player: "s2", card: "point_2#0" }, clientSeq: 0 }]);
  });

  it("picks an open response window back up with the Room's ask", async () => {
    const { bob, user } = await resumed(play(newGame(), { type: "PLAY_HERO", player: "s1", card: "point_1#0" }));
    bob.receive({ t: "passDevice", seat: "s2", name: "Bob" });
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    expect(bob.takeSent()).toEqual([{ t: "confirmPassDevice", seat: "s2" }]);
  });
});
