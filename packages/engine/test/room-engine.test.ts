import { loadCardDefs, placeholderCardDefs } from "@here-to-slay/cards";
import type { ConfigPatch } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { createRoomEngine, type GameEvent } from "../src/index.js";
import { players, smallSet } from "./cards.js";

const engine = createRoomEngine(smallSet());
const start = (config: ConfigPatch) => engine.createGame({ players: players(3), seed: "s", config });

describe("cardDefsVersion", () => {
  it("is the same for the same card data, in any order", () => {
    const defs = smallSet();
    expect(createRoomEngine(defs).cardDefsVersion).toBe(createRoomEngine([...defs].reverse()).cardDefsVersion);
    expect(createRoomEngine(defs).cardDefsVersion).toMatch(/^cards-[0-9a-f]{16}$/);
  });

  it("changes with any change to the card data, display text included", () => {
    const base = createRoomEngine(smallSet()).cardDefsVersion;
    expect(createRoomEngine(smallSet({ heroCopies: 5 })).cardDefsVersion).not.toBe(base);
    const retexted = smallSet().map((d) => (d.id === "challenge" ? { ...d, text: "Typo fixed" } : d));
    expect(createRoomEngine(retexted).cardDefsVersion).not.toBe(base);
    expect(createRoomEngine(placeholderCardDefs).cardDefsVersion).not.toBe(base);
  });

  it("is not changed by the caller mutating the card definitions afterwards", () => {
    const defs = smallSet({ heroCopies: 1 });
    const bound = createRoomEngine(defs);
    defs.splice(0, defs.length);
    expect(bound.createGame({ players: players(2), seed: "s", config: { firstPlayerMethod: "firstSeat", startingHandSize: 1 } }).players).toHaveLength(2);
  });
});

describe("createGame config", () => {
  it("applies the §3.9 defaults under the patch", () => {
    const state = start({ firstPlayerMethod: "firstSeat", handLimit: 9 });
    expect(state.config).toMatchObject({ handLimit: 9, actionPointsPerTurn: 3, startingHandSize: 5, firstPlayerMethod: "firstSeat" });
    expect(state.actionPoints).toBe(3);
  });

  it("accepts the Room's responseWindowMs", () => {
    expect(() => start({ firstPlayerMethod: "firstSeat", responseWindowMs: 5000 })).not.toThrow();
  });

  it("throws a clear error on an unknown key", () => {
    expect(() => start({ firstPlayerMethod: "firstSeat", handSize: 5 })).toThrow(/Invalid config: unknown key "handSize"/);
  });

  it("throws a clear error on a wrong type", () => {
    expect(() => start({ firstPlayerMethod: "firstSeat", handLimit: "seven" })).toThrow(/"handLimit"/);
    expect(() => start({ firstPlayerMethod: "firstSeat", drawAtStartOfTurn: 1 })).toThrow(/"drawAtStartOfTurn"/);
    expect(() => start({ firstPlayerMethod: "everyone" })).toThrow(/"firstPlayerMethod"/);
    expect(() => start({ firstPlayerMethod: "firstSeat", actionPointsPerTurn: 2.5 })).toThrow(/"actionPointsPerTurn"/);
  });

  it("refuses too few or too many players, and duplicate ids", () => {
    const config = { firstPlayerMethod: "firstSeat" };
    expect(() => engine.createGame({ players: players(1), seed: "s", config })).toThrow(/2–6 players/);
    expect(() => engine.createGame({ players: players(7), seed: "s", config })).toThrow(/2–6 players/);
    expect(() => engine.createGame({ players: [players(1)[0]!, players(1)[0]!], seed: "s", config })).toThrow(/unique/);
  });

  it("refuses card data it can't set up with", () => {
    const config = { firstPlayerMethod: "firstSeat" };
    const noLeaders = smallSet().filter((d) => d.type !== "leader");
    expect(() => createRoomEngine(noLeaders).createGame({ players: players(2), seed: "s", config })).toThrow(/Party Leaders/);
    const tiny = loadCardDefs([
      ...smallSet().filter((d) => d.type === "leader"),
      { id: "challenge", type: "challenge", name: "C", text: "", copies: 3 },
    ]);
    expect(() => createRoomEngine(tiny).createGame({ players: players(2), seed: "s", config })).toThrow(/too few to deal/);
  });
});

describe("player views", () => {
  const state = start({ firstPlayerMethod: "firstSeat" });

  it("shows a player their own hand, and other hands only as counts", () => {
    const view = engine.getPlayerView(state, "p2");
    expect(view.me).toBe("p2");
    expect(view.hand.map((c) => c.id)).toEqual(state.players[1]!.hand);
    expect(view.hand[0]!.def).toBe(state.cards[state.players[1]!.hand[0]!]);
    expect(view.players.map((p) => p.handCount)).toEqual([5, 5, 5]);
    const json = JSON.stringify(view);
    for (const other of [state.players[0]!, state.players[2]!]) {
      for (const card of other.hand) expect(json).not.toContain(JSON.stringify(card));
    }
  });

  it("shows no hand, and no legal actions, to a spectator", () => {
    const view = engine.getPlayerView(state, "spectator");
    expect(view.hand).toEqual([]);
    expect(view.legalActions).toEqual([]);
  });

  it("shows public information to everyone", () => {
    const view = engine.getPlayerView(state, "p1");
    expect(view.players.map((p) => p.leader?.id)).toEqual(state.players.map((p) => p.leader));
    expect(view.activeMonsters.map((m) => m.id)).toEqual(state.activeMonsters);
    expect(view.mainDeckCount).toBe(state.mainDeck.length);
    expect(view.monsterDeckCount).toBe(state.monsterDeck.length);
    expect(view.activePlayer).toBe("p1");
    expect(view.turnOrder).toEqual(["p1", "p2", "p3"]);
  });

  it("never shows the decks, unused leaders or the RNG", () => {
    const json = JSON.stringify(engine.getPlayerView(state, "p1"));
    for (const card of [...state.mainDeck, ...state.monsterDeck, ...state.leaderPool]) {
      expect(json).not.toContain(JSON.stringify(card));
    }
    expect(json).not.toContain("forcedDice");
    expect(json).not.toContain(JSON.stringify(state.rng.s));
  });

  it("has no Response Window and carries the legal actions", () => {
    const view = engine.getPlayerView(state, "p1");
    expect(view.responseWindow).toBeNull();
    expect(view.legalActions).toEqual(engine.getLegalActions(state, "p1"));
  });
});

describe("actions and events", () => {
  const state = start({ firstPlayerMethod: "firstSeat" });

  it("rejects actions before the turn loop exists, leaving the state alone", () => {
    const r = engine.applyAction(state, { type: "END_TURN", player: "p1" });
    expect(r).toMatchObject({ ok: false, state, events: [] });
    expect(r.error).toBeTruthy();
  });

  it("shows a drawn card only to the drawer", () => {
    const events: GameEvent[] = [{ type: "CARD_DRAWN", player: "p1", card: { id: "hero_bard#0", def: "hero_bard" } }];
    expect(engine.getPlayerEvents(events, "p1")).toEqual(events);
    expect(engine.getPlayerEvents(events, "p2")).toEqual([{ type: "CARD_DRAWN", player: "p1" }]);
    expect(engine.getPlayerEvents(events, "spectator")).toEqual([{ type: "CARD_DRAWN", player: "p1" }]);
  });
});
