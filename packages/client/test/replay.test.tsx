import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { finishedReplay, update, viewOf, type PlayerView } from "./real-game.js";
import { ALICE, BOT, HOST_CARD_SET, renderClient, renderInLobby } from "./render.js";

afterEach(cleanup);

// One game, played once: easy bots take a while to finish one.
const game = finishedReplay();
const finalView = viewOf(game.final, "s1") as unknown as PlayerView;
const winner = finalView.players.find((p) => p.id === finalView.winner)!.name;

/** The client on its first screen, watching the replay file with `contents`. */
async function watching(contents = game.contents) {
  const client = renderClient();
  await client.user.upload(screen.getByLabelText("Watch a replay"), new File([contents], "here-to-slay-ABCDE.json", { type: "application/json" }));
  return client;
}

const board = () => screen.getByRole("main").textContent;
const click = (name: string) => act(() => screen.getByRole("button", { name }).click());

describe("watching a replay", () => {
  it("opens at the start, as a spectator, and plays to the game's end", async () => {
    await watching();
    expect(screen.getByText(/^Step 0 of \d+$/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Your hand" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    click("End");
    expect(await screen.findByRole("heading", { name: `${winner} wins!` })).toBeVisible();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("shows the same final view as the game", async () => {
    const { connection } = await renderInLobby([ALICE, { ...BOT, id: "s2", name: "Bob", kind: "local" }, { ...BOT, id: "s3" }]);
    connection.receive(update(game.final, "s1", 1));
    const inGame = within(await screen.findByRole("table")).getAllByRole("row").map((r) => r.textContent);
    expect(inGame).toHaveLength(3);
    cleanup();

    const { user } = await watching();
    await user.selectOptions(screen.getByLabelText("View as"), "Alice");
    click("End");
    expect(within(await screen.findByRole("table")).getAllByRole("row").map((r) => r.textContent)).toEqual(inGame);
    expect(screen.getByRole("heading", { name: `${winner} wins!` })).toBeVisible();
  });

  it("gives the same view at each step, stepping forward or back", async () => {
    await watching();
    click("Forward");
    click("Forward");
    click("Forward");
    const third = board();
    click("Forward");
    click("Back");
    expect(screen.getByText(/^Step 3 of \d+$/)).toBeVisible();
    expect(board()).toEqual(third);

    click("End");
    expect(board()).not.toEqual(third);
    click("Start");
    expect(board()).not.toEqual(third);
    click("Forward");
    click("Forward");
    click("Forward");
    expect(board()).toEqual(third);
  });

  it("shows one player's view when asked, with their hand", async () => {
    const { user } = await watching();
    expect(screen.getByLabelText("View as")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("View as"), "Alice");
    expect(screen.getByRole("region", { name: "Your hand" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("View as"), "Spectator");
    expect(screen.queryByRole("region", { name: "Your hand" })).toBeNull();
  });

  it("goes back to the first screen", async () => {
    await watching();
    click("Close replay");
    expect(await screen.findByRole("button", { name: "Play on this device" })).toBeVisible();
  });

  it("refuses a file that isn't a replay, with a message", async () => {
    await watching("not a replay");
    expect(await screen.findByRole("alert")).toHaveTextContent("That file isn't a Here to Slay replay.");
    expect(screen.getByRole("button", { name: "Play on this device" })).toBeVisible();
  });

  it("refuses a replay made with other card definitions, with a message", async () => {
    await watching(JSON.stringify({ ...(JSON.parse(game.contents) as object), cardDefsVersion: "older" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That replay was made with other card definitions (older)");
  });
});

describe("downloading a replay", () => {
  it("offers the Host the replay at game over", async () => {
    const { connection, saved, user } = await renderInLobby([ALICE, BOT]);
    expect(screen.queryByRole("button", { name: "Download replay" })).toBeNull();
    connection.receive(update(game.final, "s1", 1));
    await user.click(await screen.findByRole("button", { name: "Download replay" }));
    expect(saved).toEqual([{ filename: "here-to-slay-ABCDE.json", mimeType: "application/json", contents: "the replay" }]);
  });

  it("offers a friend no replay", async () => {
    const { connection, user } = renderClient();
    await user.type(screen.getByLabelText("Room Code"), "ABCDE");
    await user.click(screen.getByRole("button", { name: "Join with a Room Code" }));
    connection.receive(HOST_CARD_SET, { t: "update", version: 1, events: [], view: viewOf(game.final, "s1") });
    expect(await screen.findByRole("heading", { name: `${winner} wins!` })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download replay" })).toBeNull();
  });
});
