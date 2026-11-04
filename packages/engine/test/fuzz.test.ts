import { placeholderCardDefs } from "@here-to-slay/cards";
import { describe, expect, it } from "vitest";
import { createRng, createRoomEngine, type Action, type CardIndex, type GameState } from "../src/index.js";
import { players } from "./cards.js";
import { fuzzAction, fuzzConfig, fuzzGame, stateViolations } from "./fuzz.js";

/*
 * The fuzz harness itself (TECHNICAL_DESIGN.md §13.1): its policy, its
 * invariant check and its action cap. The games are in fuzz-games-*.test.ts.
 */

describe("the fuzz policy", () => {
  const end: Action = { type: "END_TURN", player: "p1" };
  const draw: Action = { type: "DRAW_CARD", player: "p1" };
  const redraw: Action = { type: "DISCARD_AND_REDRAW", player: "p1" };

  it("ends the turn only when nothing else is legal", () => {
    let rng = createRng("policy");
    for (let i = 0; i < 50; i++) {
      let action: Action;
      [action, rng] = fuzzAction([draw, end, redraw], rng);
      expect(action).not.toEqual(end);
    }
    expect(fuzzAction([end], rng)[0]).toEqual(end);
  });

  it("picks among every other legal action", () => {
    let rng = createRng("policy");
    const picked = new Set<string>();
    for (let i = 0; i < 50; i++) {
      let action: Action;
      [action, rng] = fuzzAction([draw, end, redraw], rng);
      picked.add(action.type);
    }
    expect([...picked].sort()).toEqual(["DISCARD_AND_REDRAW", "DRAW_CARD"]);
  });
});

describe("the invariant check", () => {
  const engine = createRoomEngine(placeholderCardDefs);
  const defs: CardIndex = new Map(placeholderCardDefs.map((d) => [d.id, d]));
  const fresh = () => engine.createGame({ players: players(3), seed: "invariants", config: { firstPlayerMethod: "firstSeat" } });
  const count = (s: GameState) => Object.keys(s.cards).length;

  it("passes a freshly set-up game", () => {
    const s = fresh();
    expect(stateViolations(defs, s, count(s))).toEqual([]);
  });

  it("catches a lost card, a duplicated card and a changed card count", () => {
    const s = fresh();
    const n = count(s);
    const lost = s.mainDeck.shift()!;
    s.players[0]!.hand.push(s.players[1]!.hand[0]!);
    expect(stateViolations(defs, s, n)).toEqual(expect.arrayContaining([`${lost} is in 0 zones`, `${s.players[1]!.hand[0]} is in 2 zones`]));
    expect(stateViolations(defs, fresh(), n + 1)).toContain(`the game has ${n} cards, not ${n + 1}`);
  });

  it("catches AP out of range, a non-item equipped, and a winner with the game going on", () => {
    const s = fresh();
    s.actionPoints = 4;
    const hero = s.mainDeck.find((c) => defs.get(s.cards[c]!)?.type === "hero")!;
    const notItem = s.mainDeck.find((c) => defs.get(s.cards[c]!)?.type === "magic")!;
    s.mainDeck = s.mainDeck.filter((c) => c !== hero && c !== notItem);
    s.players[0]!.party.push({ instanceId: hero, equippedItem: notItem, rolledThisTurn: false });
    s.winner = "p2";
    expect(stateViolations(defs, s, count(s))).toEqual([
      "actionPoints is 4, outside 0–3",
      `${hero} holds ${notItem}, which isn't an item`,
      "p2 won but the phase is action",
    ]);
  });
});

describe("a fuzz game", () => {
  it("fails at the action cap, naming its seed, when nobody can win", () => {
    const r = fuzzGame("endless", 2, { monstersToWin: 99, classesToWin: 99 }, 200);
    expect(r.failure).toBe('seed "endless", after 200 actions: no winner within 200 actions');
    expect(r.state.winner).toBeNull();
  });
});

describe("the fuzz games", () => {
  it("are played under the defaults and away from them", () => {
    const configs = Array.from({ length: 50 }, (_, i) => fuzzConfig(i));
    for (const key of Object.keys(configs[0]!)) {
      expect(new Set(configs.map((c) => c[key])).size, `${key} never varies`).toBeGreaterThan(1);
    }
  });
});
