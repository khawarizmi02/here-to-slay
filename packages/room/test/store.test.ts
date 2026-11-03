import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbActionLogStore, MemoryActionLogStore, type ActionLogStore, type RoomRecord } from "../src/index.js";

function record(roomCode: string, actions = 0): RoomRecord {
  return {
    roomCode,
    seed: "seed-1",
    config: { targetScore: 7 },
    seats: [
      { id: "s1", name: "Alice", kind: "local" },
      { id: "s2", name: "Bot 1", kind: "bot", difficulty: "easy" },
    ],
    cardDefsVersion: "toy-1",
    actions: Array.from({ length: actions }, () => ({ type: "DRAW_CARD" as const, player: "s1" })),
  };
}

/**
 * Every ActionLogStore must pass these. `makeStore` gives a fresh, empty store
 * each time; `reopen` gives a second handle onto the same storage, as a
 * reloaded tab would get.
 */
export function storeContract(name: string, makeStore: () => { store: ActionLogStore; reopen: () => ActionLogStore }) {
  describe(`${name} (ActionLogStore contract)`, () => {
    it("has no record for a Room Code it has never seen", async () => {
      const { store } = makeStore();
      expect(await store.load("ABC23")).toBeNull();
    });

    it("gives back the record it saved", async () => {
      const { store } = makeStore();
      await store.save(record("ABC23", 2));
      expect(await store.load("ABC23")).toEqual(record("ABC23", 2));
    });

    it("keeps only the latest record for a Room Code", async () => {
      const { store } = makeStore();
      await store.save(record("ABC23", 1));
      await store.save(record("ABC23", 3));
      expect(await store.load("ABC23")).toEqual(record("ABC23", 3));
    });

    it("keeps the records of different Rooms apart", async () => {
      const { store } = makeStore();
      await store.save(record("ABC23", 1));
      await store.save(record("XYZ89", 2));
      expect(await store.load("ABC23")).toEqual(record("ABC23", 1));
      expect(await store.load("XYZ89")).toEqual(record("XYZ89", 2));
    });

    it("lands saves in the order they were made, even without waiting", async () => {
      const { store } = makeStore();
      const saves = [1, 2, 3, 4].map((n) => store.save(record("ABC23", n)));
      await Promise.all(saves);
      expect(await store.load("ABC23")).toEqual(record("ABC23", 4));
    });

    it("is not changed by mutating a saved or loaded record", async () => {
      const { store } = makeStore();
      const saved = record("ABC23", 1);
      await store.save(saved);
      saved.actions.push({ type: "END_TURN", player: "s1" });
      const loaded = (await store.load("ABC23"))!;
      loaded.seats.pop();
      expect(await store.load("ABC23")).toEqual(record("ABC23", 1));
    });

    it("still has the record through a new handle onto the same storage", async () => {
      const { store, reopen } = makeStore();
      await store.save(record("ABC23", 2));
      expect(await reopen().load("ABC23")).toEqual(record("ABC23", 2));
    });
  });
}

storeContract("MemoryActionLogStore", () => {
  const store = new MemoryActionLogStore();
  // Memory doesn't survive a reload; a "new handle" is the same object.
  return { store, reopen: () => store };
});

storeContract("IndexedDbActionLogStore", () => {
  // A fresh factory is a fresh, empty browser profile.
  const indexedDB = new IDBFactory();
  return { store: new IndexedDbActionLogStore(indexedDB), reopen: () => new IndexedDbActionLogStore(indexedDB) };
});
