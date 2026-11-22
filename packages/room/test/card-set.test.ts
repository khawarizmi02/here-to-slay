import { describe, expect, it } from "vitest";
import { MemoryActionLogStore, RelayConnection, Room, type CardSetOption } from "../src/index.js";
import { FakeRelay, settle } from "./fake-relay.js";
import { Client, FakeClock, FakeTimers, makeRoom, toyEngine } from "./harness.js";

// The Host sends its Card Set to friends, without art (ADR-0005). The Room
// never reads inside the cards, so these are made-up fixture cards.

const LOCAL_SET: CardSetOption = {
  name: "Local cards",
  cards: [
    { id: "fixture_hero", type: "hero", name: "Fixture Hero", art: "fixture-hero.png" },
    { id: "fixture_magic", type: "magic", name: "Fixture Magic" },
  ],
};

/** What a friend receives: the same cards, with no `art` field. */
const SENT = {
  t: "cardSet",
  name: "Local cards",
  cards: [
    { id: "fixture_hero", type: "hero", name: "Fixture Hero" },
    { id: "fixture_magic", type: "magic", name: "Fixture Magic" },
  ],
};

function hostedRoom(cardSet: CardSetOption = LOCAL_SET, store?: MemoryActionLogStore) {
  const relay = new FakeRelay();
  const { roomCode, hostToken } = relay.createRoom();
  const clock = new FakeClock();
  const room = makeRoom({ roomCode, clock, timers: new FakeTimers(clock), cardSet, ...(store ? { store } : {}) });
  room.attachRelay(relay.connectHost(roomCode, hostToken));
  const host = new Client(room.hostConnection);
  return { relay, room, roomCode, clock, host };
}

async function join(relay: FakeRelay, roomCode: string, name: string, seatToken?: string) {
  const connection = await RelayConnection.join({ dialer: relay.dialer, roomCode, name, ...(seatToken ? { seatToken } : {}) });
  const client = new Client(connection);
  await settle();
  return { connection, client };
}

describe("the Host's Card Set", () => {
  it("is sent to a friend who joins the lobby, before the lobby, without any art", async () => {
    const { relay, roomCode } = hostedRoom();
    const bob = await join(relay, roomCode, "Bob");

    expect(bob.client.inbox[0]).toEqual(SENT);
    expect(bob.client.inbox[1]?.t).toBe("lobby");
    const sent = bob.client.last("cardSet").cards as Record<string, unknown>[];
    expect(sent.some((card) => "art" in card)).toBe(false);
    expect(JSON.stringify(bob.client.inbox)).not.toContain("fixture-hero.png");
  });

  it("is sent when the Host plays the placeholder set too", async () => {
    const { relay, roomCode } = hostedRoom({ name: "Placeholder cards", cards: [{ id: "fixture_magic", name: "Fixture Magic" }] });
    const bob = await join(relay, roomCode, "Bob");

    expect(bob.client.last("cardSet")).toEqual({ t: "cardSet", name: "Placeholder cards", cards: [{ id: "fixture_magic", name: "Fixture Magic" }] });
  });

  it("is never sent to the Host's own Seat or its local Seats", async () => {
    const { relay, roomCode, room, host } = hostedRoom();
    host.send({ t: "addLocalSeat", name: "Cara" });
    const cara = new Client(room.connectLocalSeat(host.last("lobby").seats.at(-1)!.id));
    await join(relay, roomCode, "Bob");

    expect(host.of("cardSet")).toEqual([]);
    expect(cara.of("cardSet")).toEqual([]);
  });

  it("is sent again when a friend asks to resync, and when they join again after a refresh", async () => {
    const { relay, roomCode, host } = hostedRoom();
    const bob = await join(relay, roomCode, "Bob");
    host.send({ t: "startGame" });
    await settle();
    bob.client.take();

    bob.client.send({ t: "resync" });
    await settle();
    expect(bob.client.take().map((m) => m.t)).toEqual(["cardSet", "update"]);

    bob.connection.close();
    await settle();
    const again = await join(relay, roomCode, "Bob", bob.connection.seatToken);
    expect(again.client.inbox[0]).toEqual(SENT);
    expect(again.client.of("update")).not.toHaveLength(0);
  });

  it("is sent again once the Host is back from a refresh", async () => {
    const store = new MemoryActionLogStore();
    const { relay, roomCode, room, clock, host } = hostedRoom(LOCAL_SET, store);
    const bob = await join(relay, roomCode, "Bob");
    host.send({ t: "startGame" });
    await settle();
    await room.whenSaved();

    relay.dropHost(roomCode);
    await settle();
    bob.client.take();

    const restored = Room.restore({ engine: toyEngine, clock, timers: new FakeTimers(clock), random: () => 0.5, store, cardSet: LOCAL_SET }, (await store.load(roomCode))!);
    restored.attachRelay(relay.connectHost(roomCode, `host-token-${roomCode}`));
    await settle();

    const after = bob.client.take();
    expect(after[0]).toEqual({ t: "hostBack" });
    expect(after.filter((m) => m.t === "cardSet")).toContainEqual(SENT);
    // The Card Set comes before the update that needs it.
    expect(after.findIndex((m) => m.t === "cardSet")).toBeLessThan(after.findIndex((m) => m.t === "update"));
  });
});
