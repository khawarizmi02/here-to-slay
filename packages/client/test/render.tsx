import type { LobbySeat } from "@here-to-slay/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/shell/App.js";
import type { Launcher } from "../src/shell/game.js";
import { memoryPointerStore, type RoomPointer } from "../src/shell/pointer.js";
import { ToyGame } from "../src/toy/ToyGame.js";
import { FakeConnection } from "./fake-connection.js";

/** The whole client, shell and toy layer, with a fake connection where the composition root's Room would be. */
export function renderClient({ pointer = null, resume }: { pointer?: RoomPointer | null; resume?: Launcher["resume"] } = {}) {
  const connection = new FakeConnection();
  const launched: string[] = [];
  const resumed: RoomPointer[] = [];
  const launcher: Launcher = {
    playOnThisDevice(name) {
      launched.push(name);
      return { connection, roomCode: "ABCDE" };
    },
    resume(p) {
      resumed.push(p);
      return resume ? resume(p) : Promise.resolve({ connection, roomCode: p.roomCode });
    },
  };
  const pointers = memoryPointerStore(pointer);
  const user = userEvent.setup();
  render(<App launcher={launcher} pointers={pointers} Game={ToyGame} />);
  return { connection, launched, resumed, pointers, user };
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
