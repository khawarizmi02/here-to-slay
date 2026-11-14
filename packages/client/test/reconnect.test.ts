import type { RoomMsg } from "@here-to-slay/protocol";
import { RelayConnection, Room, type RelaySocket } from "@here-to-slay/room";
import { toyRoomEngine } from "@here-to-slay/toy-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stayAttached, stayJoined } from "../src/root/reconnect.js";
import { RoomClosedError } from "../src/shell/game.js";

/** One end of a relay WebSocket, as the tab holds it, driven by hand. */
class FakeSocket implements RelaySocket {
  readonly sent: unknown[] = [];
  closed = false;
  /** Whether a newer Host connection took this one's place. */
  replaced = false;
  #onMessage: ((data: string) => void) | null = null;
  #onClose: (() => void)[] = [];

  send(data: string): void {
    if (!this.closed) this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.drop();
  }
  onMessage(cb: (data: string) => void): void {
    this.#onMessage = cb;
  }
  onClose(cb: () => void): void {
    this.#onClose.push(cb);
  }
  /** Relay → tab. */
  push(frame: object): void {
    this.#onMessage?.(JSON.stringify(frame));
  }
  /** The socket closes, whoever closed it. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.#onClose.splice(0)) cb();
  }
}

const LOBBY: RoomMsg = { t: "lobby", roomCode: "HJK23", seats: [], you: ["s2"] };

/** A friend's connection to Room HJK23 as Bob, through `sockets` in order, each a fresh socket the relay accepted. */
async function friend(attempts: (FakeSocket | Error)[]) {
  const sockets: FakeSocket[] = [];
  const dial = () => {
    const next = attempts.shift() ?? new Error("no more attempts in this test");
    if (next instanceof Error) return Promise.reject(next);
    sockets.push(next);
    return RelayConnection.join({ dialer: { dial: () => Promise.resolve(next) }, roomCode: "HJK23", name: "Bob", seatToken: "seat-token-1" });
  };
  const connection = stayJoined(await dial(), dial);
  const received: RoomMsg[] = [];
  connection.onMessage((msg) => received.push(msg));
  return { connection, received, sockets };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a friend's dropped socket", () => {
  it("joins again with the seat token, without telling the player the connection was lost", async () => {
    const { connection, received, sockets } = await friend([new FakeSocket(), new FakeSocket()]);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent).toEqual([{ payload: { t: "joinRoom", name: "Bob" } }]);
    sockets[1]!.push({ kind: "msg", payload: LOBBY });
    expect(received).toEqual([LOBBY]);

    connection.send({ t: "resync" });
    expect(sockets[1]!.sent.at(-1)).toEqual({ payload: { t: "resync" } });
  });

  it("keeps trying while the relay can't be reached", async () => {
    const { received, sockets } = await friend([new FakeSocket(), new Error("offline"), new Error("offline"), new FakeSocket()]);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sockets).toHaveLength(2);
    sockets[1]!.push({ kind: "msg", payload: LOBBY });
    expect(received).toEqual([LOBBY]);
  });

  it("tells the player the Room has closed when the relay no longer knows it", async () => {
    const { received, sockets } = await friend([new FakeSocket(), new RoomClosedError()]);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(received).toEqual([{ t: "roomClosed" }]);
  });

  it("doesn't join again once the Room has closed", async () => {
    const { received, sockets } = await friend([new FakeSocket(), new FakeSocket()]);
    sockets[0]!.push({ kind: "roomClosed" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(received).toEqual([{ t: "roomClosed" }]);
    expect(sockets).toHaveLength(1);
  });

  it("doesn't join again once the player has left", async () => {
    const { connection, sockets } = await friend([new FakeSocket(), new FakeSocket()]);
    connection.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(1);
  });
});

/** A Host's Room on the relay, attached through `sockets` in order, each a fresh socket the relay accepted. */
function host(attempts: (FakeSocket | Error)[]) {
  const sockets: FakeSocket[] = [];
  const dial = () => {
    const next = attempts.shift() ?? new Error("no more attempts in this test");
    if (next instanceof Error) return Promise.reject(next);
    sockets.push(next);
    return Promise.resolve(next);
  };
  const room = new Room({ engine: toyRoomEngine, clock: { now: () => Date.now() }, random: () => 0.5, hostName: "Alice", roomCode: "HJK23" });
  const first = attempts.shift() as FakeSocket;
  sockets.push(first);
  room.attachRelay(first);
  let closed = 0;
  const stop = stayAttached(room, first, dial, () => closed++);
  /** Bob joins through the latest socket; returns what the Room sent him. */
  const bobJoins = () => {
    const socket = sockets.at(-1)!;
    socket.push({ kind: "msg", from: "seat-token-1", payload: { t: "joinRoom", name: "Bob" } });
    return socket.sent.filter((f) => (f as { to?: string }).to === "seat-token-1");
  };
  return { sockets, stop, bobJoins, closed: () => closed };
}

describe("the Host's dropped socket", () => {
  it("dials the relay again and attaches the new socket to the Room", async () => {
    const { sockets, bobJoins } = host([new FakeSocket(), new Error("offline"), new FakeSocket()]);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sockets).toHaveLength(2);
    expect(bobJoins()).toContainEqual({ to: "seat-token-1", payload: expect.objectContaining({ t: "lobby" }) });
  });

  it("reports the Room closed when the relay no longer knows it", async () => {
    const { sockets, closed } = host([new FakeSocket(), new RoomClosedError()]);
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(closed()).toBe(1);
  });

  it("leaves the Room to a newer Host connection that replaced it", async () => {
    const { sockets } = host([new FakeSocket(), new FakeSocket()]);
    sockets[0]!.replaced = true;
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);
  });

  it("doesn't dial again once stopped", async () => {
    const { sockets, stop } = host([new FakeSocket(), new FakeSocket()]);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(1);
  });
});
