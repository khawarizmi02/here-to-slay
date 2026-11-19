import type { LobbySeat } from "@here-to-slay/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { App } from "../src/shell/App.js";
import type { LaunchedRoom, LaunchedSeat, Launcher } from "../src/shell/game.js";
import { memoryPointerStore, type RoomPointer } from "../src/shell/pointer.js";
import { realGame } from "../src/board/layer.js";
import { FakeConnection } from "./fake-connection.js";

/** A Room on this device as the composition root would hand it over, with `addSeat` standing in for a lobby naming a new local Seat. */
export function fakeRoom(seats: LaunchedSeat[], roomCode = "ABCDE"): LaunchedRoom & { addSeat(seat: LaunchedSeat): void } {
  const listeners = new Set<(seat: LaunchedSeat) => void>();
  return {
    roomCode,
    seats,
    onSeatAdded(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    addSeat(seat) {
      act(() => {
        for (const cb of [...listeners]) cb(seat);
      });
    },
  };
}

/** The whole client, shell and board layer, with fake connections where the composition root's Room would be. */
export function renderClient({
  pointer = null,
  resume,
  hostOnline,
  join,
}: { pointer?: RoomPointer | null; resume?: Launcher["resume"]; hostOnline?: Launcher["hostOnline"]; join?: Launcher["join"] } = {}) {
  const connection = new FakeConnection();
  let room = fakeRoom([{ connection, name: "Alice", host: true }]);
  const launched: string[] = [];
  const hosted: string[] = [];
  const joined: { roomCode: string; name: string }[] = [];
  const resumed: RoomPointer[] = [];
  const launcher: Launcher = {
    playOnThisDevice(name) {
      launched.push(name);
      room = fakeRoom([{ connection, name, host: true }]);
      return room;
    },
    hostOnline(name) {
      hosted.push(name);
      if (hostOnline) return hostOnline(name);
      room = { ...fakeRoom([{ connection, name, host: true }], "HJK23"), online: { token: "host-token" } };
      return Promise.resolve(room);
    },
    join(roomCode, name) {
      joined.push({ roomCode, name });
      if (join) return join(roomCode, name);
      return Promise.resolve({ ...fakeRoom([{ connection, name, remote: true }], roomCode.trim().toUpperCase()), online: { token: "seat-token" } });
    },
    resume(p) {
      resumed.push(p);
      return resume ? resume(p) : Promise.resolve(fakeRoom([{ connection, name: p.name, host: true }], p.roomCode));
    },
  };
  const pointers = memoryPointerStore(pointer);
  const user = userEvent.setup();
  render(<App launcher={launcher} pointers={pointers} game={realGame} />);
  return {
    connection,
    launched,
    hosted,
    joined,
    resumed,
    pointers,
    user,
    /** Connects another local Seat, as the composition root does when a lobby names one. */
    addSeat(seat: LaunchedSeat) {
      room.addSeat(seat);
    },
  };
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

/**
 * Waits until a resumed Room's screen shows what its first messages said.
 * The screen subscribes to its Seat in an effect, which React can run a tick
 * after "Connecting…" is painted: a message delivered in between shows only
 * once it does.
 */
export async function connected() {
  await waitFor(() => expect(screen.queryByText("Connecting…")).toBeNull());
}
