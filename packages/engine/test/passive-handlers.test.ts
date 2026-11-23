import { CardLoadError, loadCardDefs, type CardDef } from "@here-to-slay/cards";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSIVE_HANDLERS, PENDING_PASSIVE_HANDLERS, type PassiveHandler } from "../src/handlers.js";
import { createRoomEngine, type GameState } from "../src/index.js";
import { stealHero } from "../src/party.js";
import { players, smallSet } from "./cards.js";
import { act, awaiting, defsWith, dice, give, inParty, party, rollHero } from "./scenario.js";

/** What each fixture handler run saw: who controls it, the card granting it, and its hook's context. */
const runs: { controller: string; source: string; hook: unknown }[] = [];

/** Fixture handlers, added to the engine's own for these tests: no real card data. */
const FIXTURES: Record<string, PassiveHandler> = {
  fixtureRecord: (_defs, state, frame) => {
    state.stack.pop();
    runs.push({ controller: frame.controller, source: state.cards[frame.source]!, hook: frame.hook });
  },
  /** Steals the hero about to be destroyed into the controller's party, if it isn't theirs already. */
  fixtureRescue: (defs, state, frame, events) => {
    state.stack.pop();
    const { target, owner } = frame.hook!;
    if (owner !== frame.controller) stealHero(defs, state, frame.controller, owner!, target!, events);
  },
};

beforeAll(() => {
  Object.assign(PASSIVE_HANDLERS, FIXTURES);
});
afterAll(() => {
  for (const name of Object.keys(FIXTURES)) delete (PASSIVE_HANDLERS as Record<string, PassiveHandler>)[name];
});

/** An engine for `defs` with every Party Leader's passive replaced by `passive`. */
function leadersWith(passive: object, defs: readonly CardDef[] = smallSet()) {
  return createRoomEngine(loadCardDefs(defs.map((d) => (d.type === "leader" ? { ...d, passive } : d))));
}

function begin(e: ReturnType<typeof createRoomEngine>): GameState {
  runs.length = 0;
  return e.createGame({ players: players(2), seed: "handlers", config: { firstPlayerMethod: "firstSeat", leaderSelection: "random" } });
}

describe("a passive with a handler", () => {
  it("runs its handler at its hook, controlled by the passive's owner", () => {
    const e = leadersWith({ hook: "onTurnStart", handler: "fixtureRecord" });
    const state = begin(e);
    // p1's first turn started at setup.
    expect(runs).toEqual([{ controller: "p1", source: state.cards[state.players[0]!.leader!], hook: {} }]);
  });
});

describe("loading a passive's handler", () => {
  it("fails loudly for a handler the engine doesn't know, naming the card and the field", () => {
    const defs = loadCardDefs(
      smallSet().map((d) =>
        d.type === "leader" ? { ...d, passive: { hook: "onTurnStart", handler: "noSuchHandler" } }
        : d.id === "monster_1" ? { ...d, reward: { hook: "afterRoll", handler: "toString" } }
        : d,
      ),
    );
    expect(() => createRoomEngine(defs)).toThrow(CardLoadError);
    expect(() => createRoomEngine(defs)).toThrow(/card "leader_bard": field "passive.handler": unknown passive handler "noSuchHandler"/);
    expect(() => createRoomEngine(defs)).toThrow(/card "monster_1": field "reward.handler": unknown passive handler "toString"/);
  });

  const [pending] = Object.keys(PENDING_PASSIVE_HANDLERS);
  it.skipIf(pending === undefined)("loads a handler still waiting on its issue, and throws if it ever runs", () => {
    const e = leadersWith({ hook: "onTurnStart", handler: pending });
    expect(() => begin(e)).toThrow(/isn't built yet/);
  });
});

describe("hook points for handlers", () => {
  it("onCardDrawn fires for the drawer once per card, in the order drawn", () => {
    const e = leadersWith({ hook: "onCardDrawn", handler: "fixtureRecord" });
    let state = begin(e);
    const first = state.mainDeck[0];
    state = act(e, state, { type: "DRAW_CARD", player: "p1" }).state;
    expect(runs.map((r) => [r.controller, r.hook])).toEqual([["p1", { card: first }]]);

    runs.length = 0;
    state.actionPoints = 3;
    const next = state.mainDeck.slice(0, 5);
    state = act(e, state, { type: "DISCARD_AND_REDRAW", player: "p1" }).state;
    expect(runs.map((r) => r.hook)).toEqual(next.map((card) => ({ card })));
    expect(state.stack).toEqual([]);
  });

  it("onCardDrawn fires for a draw by a card's effect too", () => {
    const e = leadersWith({ hook: "onCardDrawn", handler: "fixtureRecord" }, defsWith({ drawer: { op: "draw", who: "self", amount: 2 } }));
    const state = inParty(begin(e), "p1", "hero_drawer#0");
    const next = state.mainDeck.slice(0, 2);
    rollHero(e, state, "drawer");
    expect(runs.map((r) => [r.controller, r.hook])).toEqual(next.map((card) => ["p1", { card }]));
  });

  it("onModifierPlayed fires for every player, from whoever played it, and the window stays open", () => {
    const e = leadersWith({ hook: "onModifierPlayed", handler: "fixtureRecord" });
    let state = give(dice(inParty(begin(e), "p1", "hero_bard#0"), 4, 3), "p2", "mod#0");
    const rolled = act(e, state, { type: "ROLL_HERO_EFFECT", player: "p1", hero: "hero_bard#0" });
    const roll = rolled.events.flatMap((ev) => (ev.type === "DICE_ROLLED" ? [ev.roll] : []))[0]!;
    state = act(e, rolled.state, { type: "PLAY_MODIFIER", player: "p2", card: "mod#0", value: 2, roll }).state;
    const hook = { card: "mod#0", by: "p2", roll, roller: "p1" };
    expect(runs.map((r) => [r.controller, r.hook])).toEqual([["p2", hook], ["p1", hook]]);
    expect(awaiting(e, state)).toEqual(["p1", "p2"]);
  });

  describe("beforeHeroDestroyed", () => {
    const DESTROY = { op: "destroy", target: { owner: "other", chosenBy: "self" } } as const;

    it("fires for the destroyer, then the owner, before the hero leaves", () => {
      const e = leadersWith({ hook: "beforeHeroDestroyed", handler: "fixtureRecord" }, defsWith({ destroyer: DESTROY }));
      const state = rollHero(e, inParty(begin(e), "p2", "hero_bard#0"), "destroyer").state;
      const hook = { target: "hero_bard#0", owner: "p2", by: "p1" };
      expect(runs.map((r) => [r.controller, r.hook])).toEqual([["p1", hook], ["p2", hook]]);
      expect(state.discardPile).toContain("hero_bard#0");
    });

    it("destroys nothing when a handler has taken the hero out of its owner's party", () => {
      const e = leadersWith({ hook: "beforeHeroDestroyed", handler: "fixtureRescue" }, defsWith({ destroyer: DESTROY }));
      const r = rollHero(e, inParty(begin(e), "p2", "hero_bard#0"), "destroyer");
      expect(party(r.state, "p1").map((h) => h.instanceId)).toContain("hero_bard#0");
      expect(r.events.some((ev) => ev.type === "HERO_DESTROYED")).toBe(false);
    });
  });

  describe("tell a handler more at the existing hooks", () => {
    it("afterRoll says whether a hero roll succeeded", () => {
      const e = leadersWith({ hook: "afterRoll", handler: "fixtureRecord" }, defsWith({ plain: { op: "draw", who: "self", amount: 1 } }));
      rollHero(e, begin(e), "plain");
      expect(runs.map((r) => r.hook)).toEqual([{ rollKind: "heroEffect", heroClass: "wizard", hero: "hero_plain#0", succeeded: true }]);
    });

    it("onChallenged says who challenged", () => {
      const e = leadersWith({ hook: "onChallenged", handler: "fixtureRecord" });
      let state = give(give(begin(e), "p1", "hero_bard#0"), "p2", "challenge#0");
      state = act(e, state, { type: "PLAY_HERO", player: "p1", card: "hero_bard#0" }).state;
      act(e, state, { type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
      expect(runs.map((r) => [r.controller, r.hook])).toEqual([["p1", { action: "PLAY_HERO", by: "p2" }]]);
    });

    it("onHeroLeaveParty says which hero left whose party, and how", () => {
      const e = leadersWith(
        { hook: "onHeroLeaveParty", handler: "fixtureRecord" },
        defsWith({
          destroyer: { op: "destroy", target: { owner: "other", chosenBy: "self" } },
          sacrificer: { op: "sacrifice", who: { choose: "other" }, amount: 1 },
          robber: { op: "steal", from: { choose: "other" }, target: { owner: "other", chosenBy: "self" } },
        }),
      );
      rollHero(e, inParty(begin(e), "p2", "hero_bard#0"), "destroyer");
      expect(runs.map((r) => [r.controller, r.hook])).toEqual([["p2", { heroClass: "bard", target: "hero_bard#0", owner: "p2", how: "destroyed" }]]);
      runs.length = 0;
      rollHero(e, inParty(begin(e), "p2", "hero_bard#0"), "sacrificer");
      expect(runs.map((r) => [r.controller, r.hook])).toEqual([["p2", { heroClass: "bard", target: "hero_bard#0", owner: "p2", how: "sacrificed" }]]);
      runs.length = 0;
      rollHero(e, inParty(begin(e), "p2", "hero_bard#0"), "robber");
      expect(runs.map((r) => [r.controller, r.hook])).toEqual([["p2", { heroClass: "bard", target: "hero_bard#0", owner: "p2", how: "stolen" }]]);
    });
  });
});
