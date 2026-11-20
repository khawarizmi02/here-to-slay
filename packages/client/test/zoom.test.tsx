import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GameState } from "@here-to-slay/engine";
import { cardName } from "../src/board/cards.js";
import { ALICE_HERO, BOT_HERO, CHALLENGE, MAGIC, newGame as game, update, type GameSetup } from "./real-game.js";
import { ALICE, BOT, renderInLobby } from "./render.js";

afterEach(cleanup);

const players = [
  { id: "s1", name: "Alice", isBot: false },
  { id: "s2", name: "Bot 1", isBot: true },
];

/** Alice holds a hero and a Challenge, the bot a hero. The Beast needs 2 heroes; the Slime needs none. */
function newGame(more: Partial<GameSetup> = {}) {
  return game({ players, hands: { s1: [ALICE_HERO, CHALLENGE], s2: [BOT_HERO] }, monsters: ["monster_01#0", "monster_02#0"], ...more });
}

/**
 * A game with a card in every place the board shows one: Alice's Placeholder
 * Fighter 1 holds a Charm and she has slain a monster; the bot's Placeholder
 * Ranger 1 holds a Lucky Coin; Placeholder Insight tops the discard pile.
 */
function busyGame() {
  const state = newGame();
  const take = (card: string) => {
    state.mainDeck = state.mainDeck.filter((c) => c !== card);
    state.monsterDeck = state.monsterDeck.filter((c) => c !== card);
    return card;
  };
  const aliceSlain = state.monsterDeck[0]!;
  const [alice, bot] = state.players;
  alice!.party.push({ instanceId: take("hero_fighter_01#0"), equippedItem: take("item_01#0"), rolledThisTurn: false });
  alice!.slainMonsters.push(take(aliceSlain));
  bot!.party.push({ instanceId: take("hero_ranger_01#0"), equippedItem: take("item_02#0"), rolledThisTurn: false });
  state.discardPile.push(take(MAGIC));
  return { state, aliceSlain: cardName(aliceSlain.split("#")[0]!) };
}

/** Renders the client as Seat `seat`, past the lobby, showing `state`. */
async function inGame(state: GameState, seat = "s1") {
  const client = await renderInLobby([ALICE, BOT], seat);
  client.connection.receive(update(state, seat, 1));
  client.connection.takeSent();
  return client;
}

const zoom = () => screen.queryByRole("dialog", { name: "Zoomed card" });
/** The name of the card zoomed now, if any. */
const zoomedName = () => {
  const z = zoom();
  return z ? within(z).getByRole("heading").textContent : null;
};
const cardIn = (region: string, name: string) =>
  within(screen.getByLabelText(region, { selector: "section, article" })).getByRole("figure", { name });

describe("card zoom", () => {
  it("opens a large view of a hand card on hover, with its class, roll number and full text", async () => {
    const { user } = await inGame(newGame());
    expect(zoom()).toBeNull();

    await user.hover(cardIn("Your hand", "Placeholder Bard 1"));
    const zoomed = within(zoom()!);
    expect(zoomed.getByRole("heading", { name: "Placeholder Bard 1" })).toBeInTheDocument();
    expect(zoomed.getByText("Bard")).toBeInTheDocument();
    expect(zoomed.getByText("Roll 8+")).toBeInTheDocument();
    expect(zoomed.getByText("Roll 8+: DRAW 2 cards.")).toBeInTheDocument();
  });

  it("zooms a card in every place the board shows one", async () => {
    const { state, aliceSlain } = busyGame();
    const { user } = await inGame(state);
    const places: [region: string, card: string][] = [
      ["Your hand", "Placeholder Challenge"],
      ["Your party", "Placeholder Fighter 1"],
      ["Your party", "Placeholder Charm"],
      ["Your party", aliceSlain],
      ["Bot 1", "Placeholder Ranger 1"],
      ["Bot 1", "Placeholder Lucky Coin"],
      ["Monsters", "Placeholder Beast"],
      ["Discard", "Placeholder Insight"],
    ];
    for (const [region, card] of places) {
      await user.hover(cardIn(region, card));
      expect(zoomedName(), `${card} in ${region}`).toBe(card);
    }
  });

  it("shows a monster's requirement and numbers", async () => {
    const { user } = await inGame(newGame());
    await user.hover(cardIn("Monsters", "Placeholder Beast"));
    const zoomed = within(zoom()!);
    expect(zoomed.getByText("2 heroes")).toBeInTheDocument();
    expect(zoomed.getByText("8+")).toBeInTheDocument();
    expect(zoomed.getByText("4-")).toBeInTheDocument();
  });

  it("never zooms another player's hidden card to its face", async () => {
    const { user } = await inGame(newGame());
    const bot = screen.getByRole("article", { name: "Bot 1" });
    expect(bot).toHaveTextContent("1 card in hand");
    // Everything in the bot's area that can be pointed at or focused.
    for (const el of [bot, ...bot.querySelectorAll<HTMLElement>("*")]) {
      await user.hover(el);
      el.focus();
      expect(zoomedName() ?? "").not.toBe("Placeholder Wizard 1");
    }
    expect(screen.queryByText("Placeholder Wizard 1")).toBeNull();
  });

  it("zooms with keyboard focus, on the card or a control in it, and closes when focus leaves", async () => {
    const { user } = await inGame(newGame());
    await user.tab();
    while (document.activeElement !== cardIn("Your hand", "Placeholder Bard 1")) await user.tab();
    expect(zoomedName()).toBe("Placeholder Bard 1");

    await user.tab();
    expect(document.activeElement).toBe(within(cardIn("Your hand", "Placeholder Bard 1")).getByRole("button", { name: "Placeholder Bard 1" }));
    expect(zoomedName()).toBe("Placeholder Bard 1");

    await user.tab();
    expect(zoomedName()).toBe("Placeholder Challenge");
  });

  it("closes on Escape, when the pointer moves away, and on a tap outside", async () => {
    const { user } = await inGame(newGame());
    const bard = cardIn("Your hand", "Placeholder Bard 1");

    await user.hover(bard);
    await user.keyboard("{Escape}");
    expect(zoom()).toBeNull();

    await user.hover(bard);
    await user.unhover(bard);
    expect(zoom()).toBeNull();

    await user.hover(bard);
    fireEvent.pointerDown(screen.getByText(/^Turn 1/));
    expect(zoom()).toBeNull();
  });

  it("zooms on a long press, and the press neither plays the card nor sends anything", async () => {
    const { connection } = await inGame(newGame());
    const bard = cardIn("Your hand", "Placeholder Bard 1");
    const play = within(bard).getByRole("button", { name: "Placeholder Bard 1" });

    fireEvent.pointerDown(play, { pointerType: "touch", clientX: 10, clientY: 10 });
    await waitFor(() => expect(zoomedName()).toBe("Placeholder Bard 1"));
    fireEvent.pointerUp(play, { pointerType: "touch" });
    fireEvent.click(play);
    expect(connection.takeSent()).toEqual([]);

    // A tap elsewhere closes it; the next tap on the card plays it as usual.
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(zoom()).toBeNull();
    fireEvent.click(play);
    expect(connection.takeSent()).toHaveLength(1);
  });

  it("closes a long-pressed card's zoom when another card is tapped", async () => {
    await inGame(newGame());
    const bard = cardIn("Your hand", "Placeholder Bard 1");
    fireEvent.pointerDown(bard, { pointerType: "touch" });
    await waitFor(() => expect(zoomedName()).toBe("Placeholder Bard 1"));
    fireEvent.pointerUp(bard, { pointerType: "touch" });

    fireEvent.pointerDown(cardIn("Your hand", "Placeholder Challenge"), { pointerType: "touch" });
    expect(zoom()).toBeNull();
  });

  it("long-presses an item on its own, not the hero it is on", async () => {
    await inGame(busyGame().state);
    const charm = cardIn("Your party", "Placeholder Charm");
    fireEvent.pointerDown(charm, { pointerType: "touch" });
    await waitFor(() => expect(zoomedName()).toBe("Placeholder Charm"));
    await new Promise((r) => setTimeout(r, 50));
    expect(zoomedName()).toBe("Placeholder Charm");
  });

  it("does not zoom on a plain tap, even though the tap focuses the card", async () => {
    const { connection } = await inGame(newGame());
    const play = within(cardIn("Your hand", "Placeholder Bard 1")).getByRole("button", { name: "Placeholder Bard 1" });
    fireEvent.pointerDown(play, { pointerType: "touch" });
    play.focus();
    fireEvent.pointerUp(play, { pointerType: "touch" });
    fireEvent.click(play);
    expect(zoom()).toBeNull();
    expect(connection.takeSent()).toHaveLength(1);
  });

  it("lets a later click through when no click followed the long press", async () => {
    const { connection } = await inGame(newGame());
    const play = within(cardIn("Your hand", "Placeholder Bard 1")).getByRole("button", { name: "Placeholder Bard 1" });
    fireEvent.pointerDown(play, { pointerType: "touch" });
    await waitFor(() => expect(zoomedName()).toBe("Placeholder Bard 1"));
    fireEvent.pointerUp(play, { pointerType: "touch" });
    // The browser sent no click for the press. A while later, a mouse click on the card plays it.
    await new Promise((r) => setTimeout(r, 1000));
    fireEvent.click(play);
    expect(connection.takeSent()).toHaveLength(1);
  });

  it("never sends an action when zooming by hover or focus", async () => {
    const { state } = busyGame();
    const { user, connection } = await inGame(state);
    for (const card of screen.getAllByRole("figure")) {
      await user.hover(card);
      card.focus();
    }
    await user.keyboard("{Escape}");
    expect(connection.takeSent()).toEqual([]);
  });
});
