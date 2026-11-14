import "@testing-library/jest-dom/vitest";
import * as toy from "@here-to-slay/toy-engine";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE, renderClient } from "./render.js";

const BOB = { id: "s2", name: "Bob", kind: "remote", connected: true } as const;

afterEach(cleanup);

async function hostOnline(name = "Alice") {
  const client = renderClient();
  await client.user.clear(screen.getByLabelText("Your name"));
  await client.user.type(screen.getByLabelText("Your name"), name);
  await client.user.click(screen.getByRole("button", { name: "Host online" }));
  return client;
}

describe("hosting online", () => {
  it("builds an online Room under the player's name and shows its Room Code in the lobby", async () => {
    const { connection, hosted } = await hostOnline();
    expect(hosted).toEqual(["Alice"]);
    connection.receive({ t: "lobby", roomCode: "HJK23", seats: [ALICE], you: ["s1"] });
    expect(screen.getByText("HJK23")).toBeInTheDocument();
  });

  it("points at the Room with the Host's token", async () => {
    const { pointers } = await hostOnline();
    expect(pointers.load()).toEqual({ mode: "online", role: "host", roomCode: "HJK23", name: "Alice", token: "host-token" });
  });

  it("reminds the Host to keep the tab open", async () => {
    await hostOnline();
    expect(screen.getByText(/you are hosting/i)).toHaveTextContent("Keep this tab open: you are hosting");
  });

  it("stays on the first screen with the reason when the relay can't be reached", async () => {
    const client = renderClient({ hostOnline: () => Promise.reject(new Error("Couldn't reach the relay")) });
    await client.user.click(screen.getByRole("button", { name: "Host online" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the relay");
    expect(screen.getByRole("button", { name: "Host online" })).toBeEnabled();
    expect(client.pointers.load()).toBeNull();
  });
});

async function join(roomCode: string, opts: Parameters<typeof renderClient>[0] = {}) {
  const client = renderClient(opts);
  await client.user.clear(screen.getByLabelText("Your name"));
  await client.user.type(screen.getByLabelText("Your name"), "Bob");
  await client.user.type(screen.getByLabelText("Room Code"), roomCode);
  await client.user.click(screen.getByRole("button", { name: "Join with a Room Code" }));
  return client;
}

describe("joining with a Room Code", () => {
  it("joins under the player's name with the Room Code as typed, and points at the Room with the seat token", async () => {
    const { joined, pointers } = await join(" hjk23 ");
    expect(joined).toEqual([{ roomCode: " hjk23 ", name: "Bob" }]);
    expect(pointers.load()).toEqual({ mode: "online", role: "friend", roomCode: "HJK23", name: "Bob", token: "seat-token" });
  });

  it("shows the friend the lobby and its Room Code, but none of the Host's controls and no hosting notice", async () => {
    const { connection } = await join("HJK23");
    connection.receive({ t: "lobby", roomCode: "HJK23", seats: [ALICE, BOB], you: ["s2"] });
    expect(screen.getByText("HJK23")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("Alice"), expect.stringContaining("Bob")]);
    expect(screen.queryByLabelText("Target score")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a bot" })).toBeNull();
    expect(screen.queryByText(/you are hosting/i)).toBeNull();
  });

  it("stays on the first screen with the reason when joining fails", async () => {
    const reason = "There is no Room ZZZZZ. It may have closed; ask the Host for a new Room Code.";
    const { pointers } = await join("zzzzz", { join: () => Promise.reject(new Error(reason)) });
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(screen.getByRole("button", { name: "Join with a Room Code" })).toBeVisible();
    expect(pointers.load()).toBeNull();
  });
});

/** Alice has played 1 Point, and Bob, holding a Challenge, is asked to respond. */
function bobAskedToRespond(): Record<string, unknown> {
  const game = toy.createGame({
    players: [
      { id: "s1", name: "Alice", isBot: false },
      { id: "s2", name: "Bob", isBot: false },
    ],
    seed: "online",
    config: { handSize: 2 },
    deckOrder: ["point_1", "point_2", "challenge", "point_3", "point_1"],
  });
  const played = toy.applyAction(game, { type: "PLAY_HERO", player: "s1", card: "point_1#0" });
  if (!played.ok) throw new Error(played.error);
  return toy.getPlayerView(played.state, "s2") as unknown as Record<string, unknown>;
}

describe("a friend in a response window", () => {
  it("is offered its responses from its view, with no respond from the Room", async () => {
    const { connection, user } = await join("HJK23");
    connection.receive({ t: "lobby", roomCode: "HJK23", seats: [ALICE, BOB], you: ["s2"] });
    connection.receive({ t: "update", version: 2, events: [], view: bobAskedToRespond() });
    const bar = screen.getByRole("region", { name: "Respond" });
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Pass", "Play Challenge"]);

    connection.takeSent();
    await user.click(within(bar).getByRole("button", { name: "Pass" }));
    expect(connection.takeSent()).toEqual([{ t: "action", seat: "s2", action: { type: "PASS", player: "s2" }, clientSeq: 0 }]);
  });

  it("sees how long it has, from the Room's countdown, until the next update", async () => {
    const { connection } = await join("HJK23");
    connection.receive({ t: "lobby", roomCode: "HJK23", seats: [ALICE, BOB], you: ["s2"] });
    connection.receive({ t: "update", version: 2, events: [], view: bobAskedToRespond() }, { t: "countdown", seat: "s2", ms: 15_000 });
    expect(within(screen.getByRole("region", { name: "Respond" })).getByRole("timer")).toHaveTextContent("15s left");

    connection.receive({ t: "update", version: 3, events: [], view: bobAskedToRespond() });
    expect(screen.queryByRole("timer")).toBeNull();
  });
});
