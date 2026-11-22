import { placeholderCardDefs } from "@here-to-slay/cards";
import type { LobbySeat, RoomMsg } from "@here-to-slay/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { App } from "../src/shell/App.js";
import type { LaunchedRoom, LaunchedSeat, Launcher } from "../src/shell/game.js";
import { memoryPointerStore, type RoomPointer } from "../src/shell/pointer.js";
import { deviceSettings } from "../src/shell/settings.js";
import type { Sound, SoundPlayer } from "../src/shell/sound.js";
import { realGame } from "../src/board/layer.js";
import { watchReplay } from "../src/root/launcher.js";
import type { ReplayFile } from "../src/shell/game.js";
import { FakeConnection } from "./fake-connection.js";

/** A Room on this device as the composition root would hand it over, with `addSeat` standing in for a lobby naming a new local Seat. */
export function fakeRoom(seats: LaunchedSeat[], roomCode = "ABCDE"): LaunchedRoom & { addSeat(seat: LaunchedSeat): void } {
  const listeners = new Set<(seat: LaunchedSeat) => void>();
  return {
    roomCode,
    seats,
    replayFile: () => ({ filename: `here-to-slay-${roomCode}.json`, mimeType: "application/json", contents: "the replay" }),
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
  storage = memoryStorage(),
}: {
  pointer?: RoomPointer | null;
  resume?: Launcher["resume"];
  hostOnline?: Launcher["hostOnline"];
  join?: Launcher["join"];
  /** Where the device's settings are saved. */
  storage?: Storage;
} = {}) {
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
    // The composition root's own, on the board's card set: a replay never reaches a Room.
    openReplay: watchReplay,
  };
  const saved: ReplayFile[] = [];
  const pointers = memoryPointerStore(pointer);
  const user = userEvent.setup();
  const sounds = new FakeSoundPlayer();
  render(<App launcher={launcher} pointers={pointers} game={realGame} settings={deviceSettings(storage)} sounds={sounds} saveFile={(file) => saved.push(file)} />);
  return {
    connection,
    launched,
    hosted,
    joined,
    resumed,
    pointers,
    user,
    sounds,
    /** The files the device was asked to save. */
    saved,
    /** Connects another local Seat, as the composition root does when a lobby names one. */
    addSeat(seat: LaunchedSeat) {
      room.addSeat(seat);
    },
  };
}

/** The Host's Card Set as the Room sends it to every friend before anything else: here, the placeholder cards. */
export const HOST_CARD_SET: Extract<RoomMsg, { t: "cardSet" }> = { t: "cardSet", name: "Placeholder cards", cards: [...placeholderCardDefs] };

export const ALICE: LobbySeat = { id: "s1", name: "Alice", kind: "local", connected: true };
export const BOT: LobbySeat = { id: "s2", name: "Bot 1", kind: "bot", connected: true };

/** The client in the lobby of a Room on this device, as Seat `you`, with `seats` so far. */
export async function renderInLobby(seats: LobbySeat[] = [ALICE], you = "s1", options: Parameters<typeof renderClient>[0] = {}) {
  const client = renderClient(options);
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

/** A sound player that records what it is asked to play. */
export class FakeSoundPlayer implements SoundPlayer {
  readonly played: { sound: Sound; volume: number }[] = [];

  play(sound: Sound, volume: number): void {
    this.played.push({ sound, volume });
  }

  /** The sounds played since the last call. */
  take(): Sound[] {
    return this.played.splice(0).map((p) => p.sound);
  }
}

/** A Storage held in memory, starting with `items`. */
export function memoryStorage(items: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(items));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

/** Ticks "Skip animations" in the settings panel, opened from the room bar, and closes it. */
export function skipAnimations() {
  act(() => screen.getByRole("button", { name: "Settings" }).click());
  const panel = screen.getByRole("dialog", { name: "Settings" });
  act(() => within(panel).getByRole("checkbox", { name: "Skip animations" }).click());
  act(() => within(panel).getByRole("button", { name: "Close" }).click());
}
