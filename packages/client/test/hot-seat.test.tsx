import type { LobbySeat } from "@here-to-slay/protocol";
import type { GameState } from "@here-to-slay/engine";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FakeConnection } from "./fake-connection.js";
import { ALICE_HERO, BOB_HERO, BOT_HERO, CHALLENGE, MAGIC, MODIFIER, newGame as game, play, step, viewOf } from "./real-game.js";
import { ALICE, connected, fakeRoom, renderClient, renderInLobby } from "./render.js";

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

/** Alice holds a hero and a Magic card, Bob a hero and a Challenge, the bot a hero and a Modifier. */
function newGame(config = {}) {
  return game({
    players: [
      { id: "s1", name: "Alice", isBot: false },
      { id: "s2", name: "Bob", isBot: false },
      { id: "s3", name: "Bot 1", isBot: true },
    ],
    hands: { s1: [ALICE_HERO, MAGIC], s2: [BOB_HERO, CHALLENGE], s3: [BOT_HERO, MODIFIER] },
    config,
  });
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
  const show = (state: GameState) => {
    for (const [connection, seat] of [[alice, "s1"], [bob, "s2"]] as const) {
      connection.receive({ t: "update", version, events: [], view: viewOf(state, seat) });
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
    expect(hand().getByRole("button", { name: "Placeholder Bard 1" })).toBeEnabled();
  });

  it("passes to the next local player on their turn, and acts from their Seat", async () => {
    const { alice, bob, show, user } = await aliceAndBob();
    show(newGame());
    await user.click(screen.getByRole("button", { name: "I'm Alice" }));

    // Alice ends her turn, and Bob's begins.
    const drawn = play(newGame(), { type: "END_TURN", player: "s1" });
    expect(drawn.activePlayer).toBe("s2");
    show(drawn);
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    handHidden();

    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    hand().getByRole("button", { name: "Placeholder Fighter 1" }).click();
    expect(bob.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PLAY_HERO", player: "s2", card: BOB_HERO }, clientSeq: 0 }]);
    expect(alice.takeSent()).toEqual([]);
  });

  it("asks again for the same player when the game waits on them twice in a row", async () => {
    const { show, user } = await aliceAndBob();
    show(newGame());
    await user.click(screen.getByRole("button", { name: "I'm Alice" }));

    // Alice's hero opens a response window; once everyone passes, she decides whether to roll for free.
    const played = play(newGame({ freeRollOnHeroPlay: true }), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO });
    show(played);
    expect(screen.queryByRole("heading", { name: /pass the device/i })).toBeNull();
    const deciding = play(played, { type: "PASS", player: "s2" }, { type: "PASS", player: "s3" });
    expect(deciding.pendingDecision?.player).toBe("s1");
    show(deciding);
    expect(screen.getByRole("heading", { name: "Pass the device to Alice" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "I'm Alice" }));
    expect(screen.getByRole("dialog", { name: deciding.pendingDecision!.prompt })).toBeInTheDocument();
  });

  it("stays on screen while the game waits on a Seat that isn't on this device", async () => {
    const { show, user } = await aliceAndBob();
    show(newGame());
    await user.click(screen.getByRole("button", { name: "I'm Alice" }));
    const bobsTurn = play(newGame(), { type: "END_TURN", player: "s1" });
    show(bobsTurn);
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));

    const botsTurn = play(bobsTurn, { type: "END_TURN", player: "s2" });
    expect(botsTurn.activePlayer).toBe("s3");
    show(botsTurn);
    expect(hand().getByRole("button", { name: "Placeholder Challenge" })).toBeDisabled();

    show(play(botsTurn, { type: "END_TURN", player: "s3" }));
    expect(screen.getByRole("heading", { name: "Pass the device to Alice" })).toBeInTheDocument();
  });
});

describe("the Pass-Device Step for response windows", () => {
  /** Alice has played her hero, and Bob, holding a Challenge, is asked to respond. */
  async function bobAsked() {
    const client = await aliceAndBob();
    client.show(newGame());
    await client.user.click(screen.getByRole("button", { name: "I'm Alice" }));
    const played = play(newGame(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO });
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
        { type: "PLAY_CHALLENGE", player: "s2", card: CHALLENGE },
      ],
    });
    expect(hand().getByRole("button", { name: "Placeholder Challenge" })).toBeInTheDocument();
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
  async function resumed(state: GameState) {
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
    alice.receive({ t: "update", version: 7, events: [], view: viewOf(state, "s1") });
    bob.receive({ t: "update", version: 7, events: [], view: viewOf(state, "s2") });
    await connected();
    return { ...client, alice, bob };
  }

  it("restores every local Seat, and hides the hands until whoever's turn it is has the device", async () => {
    const { bob, user } = await resumed(play(newGame(), { type: "END_TURN", player: "s1" }));
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    hand().getByRole("button", { name: "Placeholder Fighter 1" }).click();
    expect(bob.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PLAY_HERO", player: "s2", card: BOB_HERO }, clientSeq: 0 }]);
  });

  it("picks an open response window back up with the Room's ask", async () => {
    const { bob, user } = await resumed(play(newGame(), { type: "PLAY_HERO", player: "s1", card: ALICE_HERO }));
    bob.receive({ t: "passDevice", seat: "s2", name: "Bob" });
    expect(screen.getByRole("heading", { name: "Pass the device to Bob" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    expect(bob.takeSent()).toEqual([{ t: "confirmPassDevice", seat: "s2" }]);
  });
});

describe("animation with several Seats", () => {
  it("animates only the Seat on screen: the next player sees their latest view at once", async () => {
    const { alice, bob, show, user } = await aliceAndBob();
    show(newGame());
    await user.click(screen.getByRole("button", { name: "I'm Alice" }));

    const playHero = { type: "PLAY_HERO", player: "s1", card: ALICE_HERO } as const;
    for (const [connection, seat] of [[alice, "s1"], [bob, "s2"]] as const) connection.receive(step(newGame(), playHero, seat, 2).msg);
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("You played Placeholder Bard 1");

    bob.receive({ t: "passDevice", seat: "s2", name: "Bob" });
    await user.click(screen.getByRole("button", { name: "I'm Bob" }));
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Game log" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Alice played Placeholder Bard 1"]);
  });
});
