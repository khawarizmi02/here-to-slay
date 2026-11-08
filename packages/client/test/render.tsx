import type { LobbySeat } from "@here-to-slay/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/shell/App.js";
import { ToyGame } from "../src/toy/ToyGame.js";
import { FakeConnection } from "./fake-connection.js";

/** The whole client, shell and toy layer, with a fake connection where the composition root's Room would be. */
export function renderClient() {
  const connection = new FakeConnection();
  const launched: string[] = [];
  const launcher = {
    playOnThisDevice(name: string) {
      launched.push(name);
      return connection;
    },
  };
  const user = userEvent.setup();
  render(<App launcher={launcher} Game={ToyGame} />);
  return { connection, launched, user };
}

export const ALICE: LobbySeat = { id: "s1", name: "Alice", kind: "local", connected: true };
export const BOT: LobbySeat = { id: "s2", name: "Bot 1", kind: "bot", connected: true };

/** The client in the lobby of a Room on this device, as Seat `you`, with `seats` so far. */
export async function renderInLobby(seats: LobbySeat[] = [ALICE], you = "s1") {
  const client = renderClient();
  await client.user.click(screen.getByRole("button", { name: "Play on this device" }));
  client.connection.receive({ t: "lobby", roomCode: "ABCDE", seats, you: [you] });
  return client;
}
