import { placeholderCardDefs } from "@here-to-slay/cards";
import { createRoomEngine, type GameState, type PlayerView } from "@here-to-slay/engine";
import { describe, expect, it } from "vitest";
import { Room } from "../src/index.js";
import { Client, FakeClock, FakeTimers, seededRandom } from "./harness.js";

/*
 * The Room on the real rules engine (ADR-0002: the Room's own tests stay on
 * the toy engine; these check the two fit together).
 */

function realRoom(extra: string[]) {
  const clock = new FakeClock();
  const room = new Room<GameState>({
    engine: createRoomEngine(placeholderCardDefs),
    clock,
    timers: new FakeTimers(clock),
    random: seededRandom("real-room"),
    hostName: "Alice",
  });
  const host = new Client(room.hostConnection);
  for (const name of extra) host.send({ t: "addLocalSeat", name });
  const lobby = host.last("lobby");
  const hostSeat = lobby.you[0]!;
  const clients = new Map<string, Client>([[hostSeat, host]]);
  for (const seat of lobby.seats) {
    if (seat.id !== hostSeat) clients.set(seat.id, new Client(room.connectLocalSeat(seat.id)));
  }
  return { host, clients, seatIds: lobby.seats.map((s) => s.id) };
}

const viewOf = (client: Client) => client.last("update").view as PlayerView;

describe("a Room on the real engine", () => {
  it("starts a real game, and each Seat's view shows only its own hand", () => {
    const { host, clients, seatIds } = realRoom(["Bob", "Cleo"]);
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat" } });
    host.send({ t: "startGame" });

    const hands = new Map<string, string[]>();
    for (const [seat, client] of clients) {
      const view = viewOf(client);
      expect(view.me).toBe(seat);
      expect(view.hand).toHaveLength(5);
      expect(view.players.map((p) => p.id)).toEqual(seatIds);
      expect(view.players.map((p) => p.handCount)).toEqual([5, 5, 5]);
      expect(view.activeMonsters).toHaveLength(3);
      expect(view.responseWindow).toBeNull();
      // The Host's Seat comes first, so firstSeat makes the Host go first.
      expect(view.activePlayer).toBe(seatIds[0]);
      hands.set(seat, view.hand.map((c) => c.id));
    }

    for (const [seat, client] of clients) {
      const json = JSON.stringify(client.inbox);
      for (const [other, hand] of hands) {
        if (other === seat) continue;
        for (const card of hand) expect(json, `${seat} was shown ${other}'s ${card}`).not.toContain(JSON.stringify(card));
      }
    }
  });

  it("stays in the lobby, naming the key, when the engine rejects the config", () => {
    const { host } = realRoom(["Bob"]);
    host.send({ t: "setConfig", config: { firstPlayerMethod: "firstSeat", handSize: 5 } });
    host.take();
    host.send({ t: "startGame" });
    expect(host.take()).toEqual([{ t: "error", message: expect.stringContaining('unknown key "handSize"') }]);
  });
});
