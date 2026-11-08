import { ActionSchema } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import {
  applyAction,
  createGame,
  createRng,
  getLegalActions,
  getPlayerEvents,
  getPlayerView,
  nextFloat,
  type Action,
  type GameEvent,
  type GameState,
  type RngState,
} from "../src/index.js";

const twoPlayers = [
  { id: "p1", name: "Alice", isBot: false },
  { id: "p2", name: "Bob", isBot: false },
];

const fourPlayers = [
  ...twoPlayers,
  { id: "p3", name: "Cleo", isBot: true },
  { id: "p4", name: "Dan", isBot: false },
];

function run(state: GameState, actions: Action[]): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  for (const action of actions) {
    const r = applyAction(state, action);
    expect(r.error, `${JSON.stringify(action)} was rejected`).toBeUndefined();
    expect(r.ok).toBe(true);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

/** Whoever has legal actions right now. */
function playersToAct(state: GameState): string[] {
  return state.players.map((p) => p.id).filter((id) => getLegalActions(state, id).length > 0);
}

/** Plays legal actions chosen by a separate seeded RNG until game over; returns the actions taken. */
function playRandomGame(seed: string, players = fourPlayers): { state: GameState; actions: Action[]; events: GameEvent[] } {
  let state = createGame({ players, seed });
  let picker: RngState = createRng(`picker:${seed}`);
  const actions: Action[] = [];
  const events: GameEvent[] = [];
  for (let step = 0; step < 1000 && state.phase !== "gameOver"; step++) {
    const legal = playersToAct(state).flatMap((id) => getLegalActions(state, id));
    let f: number;
    [f, picker] = nextFloat(picker);
    const action = legal[Math.floor(f * legal.length)]!;
    const r = applyAction(state, action);
    expect(r.ok).toBe(true);
    state = r.state;
    actions.push(action);
    events.push(...r.events);
  }
  return { state, actions, events };
}

function totalCards(state: GameState): number {
  return state.deck.length + state.discard.length + state.players.reduce((n, p) => n + p.hand.length, 0) +
    (state.responseWindow ? 1 : 0);
}

describe("determinism", () => {
  it("the same seed produces the same initial state", () => {
    expect(createGame({ players: fourPlayers, seed: "abc" })).toEqual(createGame({ players: fourPlayers, seed: "abc" }));
  });

  it("different seeds deal differently", () => {
    const a = createGame({ players: fourPlayers, seed: "abc" });
    const b = createGame({ players: fourPlayers, seed: "abd" });
    expect(a.deck.map((c) => c.id)).not.toEqual(b.deck.map((c) => c.id));
  });

  it("the same seed and the same actions produce the same state", () => {
    for (const seed of ["s1", "s2", "s3"]) {
      const first = playRandomGame(seed);
      const replayed = run(createGame({ players: fourPlayers, seed }), first.actions);
      expect(replayed.state).toEqual(first.state);
      expect(replayed.events).toEqual(first.events);
    }
  });

  it("applyAction never mutates its input", () => {
    const state = createGame({ players: twoPlayers, seed: "pure" });
    const snapshot = JSON.parse(JSON.stringify(state)) as GameState;
    applyAction(state, getLegalActions(state, "p1")[0]!);
    expect(state).toEqual(snapshot);
  });
});

describe("a scripted game", () => {
  // p1 is dealt point_3, wish, point_2; p2 is dealt challenge, point_1, point_1.
  const deckOrder = [
    "point_3", "wish", "point_2",
    "challenge", "point_1", "point_1",
    "point_3", "point_1", "point_2",
  ] as const;

  it("reaches game over through a response window and a decision", () => {
    const start = createGame({ players: twoPlayers, seed: "script", deckOrder: [...deckOrder] });
    const p1 = (type: "PASS" | "DRAW_CARD") => ({ type, player: "p1" }) as const;
    const p2 = (type: "PASS" | "DRAW_CARD") => ({ type, player: "p2" }) as const;

    // p1 plays a card: a response window opens, and p2 can answer it with a card in hand.
    let r = run(start, [{ type: "PLAY_HERO", player: "p1", card: "point_3#0" }]);
    expect(r.state.phase).toBe("responseWindow");
    expect(getLegalActions(r.state, "p2")).toContainEqual({ type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" });
    expect(getLegalActions(r.state, "p1")).toEqual([]);

    r = run(r.state, [{ type: "PLAY_CHALLENGE", player: "p2", card: "challenge#0" }]);
    expect(r.events.map((e) => e.type)).toEqual(["CHALLENGED", "TURN_STARTED"]);
    expect(r.state.players[0]!.score).toBe(0);

    r = run(r.state, [p2("DRAW_CARD")]);

    // p1 plays a wish: once everyone passes, p1 faces a pending decision.
    r = run(r.state, [{ type: "PLAY_HERO", player: "p1", card: "wish#0" }, p2("PASS")]);
    expect(r.state.phase).toBe("decision");
    const decision = r.state.pendingDecision!;
    expect(decision.player).toBe("p1");
    expect(getLegalActions(r.state, "p2")).toEqual([]);
    r = run(r.state, [
      { type: "RESOLVE_DECISION", player: "p1", decisionId: decision.id, answer: { selected: ["gain2"] } },
    ]);
    expect(r.state.players[0]!.score).toBe(2);

    const rest = run(r.state, [
      { type: "PLAY_HERO", player: "p2", card: "point_3#1" }, p1("PASS"), // p2: 3
      { type: "PLAY_HERO", player: "p1", card: "point_2#0" }, p2("PASS"), // p1: 4
      { type: "PLAY_HERO", player: "p2", card: "point_1#0" }, p1("PASS"), // p2: 4
      p1("DRAW_CARD"),
      { type: "PLAY_HERO", player: "p2", card: "point_1#1" }, p1("PASS"), // p2: 5
    ]);
    expect(rest.state.phase).toBe("gameOver");
    expect(rest.state.winner).toBe("p2");
    expect(rest.events.at(-1)).toEqual({ type: "GAME_OVER", winner: "p2" });
    for (const id of ["p1", "p2"]) expect(getLegalActions(rest.state, id)).toEqual([]);
  });
});

describe("random games", () => {
  it("always reach game over, conserve cards, and only produce protocol-valid actions", () => {
    let sawWindowResponse = false;
    let sawDecision = false;
    for (let i = 0; i < 200; i++) {
      const seed = `fuzz-${i}`;
      const players = i % 2 === 0 ? fourPlayers : twoPlayers;
      const initial = totalCards(createGame({ players, seed }));
      const { state, actions, events } = playRandomGame(seed, players);
      expect(state.phase).toBe("gameOver");
      expect(state.winner).not.toBeNull();
      expect(totalCards(state)).toBe(initial);
      for (const a of actions) expect(ActionSchema.safeParse(a).success).toBe(true);
      sawWindowResponse ||= events.some((e) => e.type === "CHALLENGED");
      sawDecision ||= events.some((e) => e.type === "DECISION_RESOLVED");
    }
    expect(sawWindowResponse).toBe(true);
    expect(sawDecision).toBe(true);
  });
});

describe("rejections", () => {
  it("rejects illegal actions and leaves state unchanged", () => {
    const state = createGame({ players: twoPlayers, seed: "rej" });
    const cases: [Action, string][] = [
      [{ type: "DRAW_CARD", player: "p2" }, "It is not your turn"],
      [{ type: "PASS", player: "p1" }, "PASS is not a legal action right now"],
      [{ type: "PLAY_HERO", player: "p1", card: "not-in-hand#0" }, "PLAY_HERO is not a legal action right now"],
      [{ type: "DRAW_CARD", player: "ghost" }, "Unknown player ghost"],
    ];
    for (const [action, error] of cases) {
      const r = applyAction(state, action);
      expect(r.ok).toBe(false);
      expect(r.error).toBe(error);
      expect(r.state).toBe(state);
      expect(r.events).toEqual([]);
    }
  });
});

describe("hidden information", () => {
  it("a player's view shows their own hand and only the size of other hands", () => {
    const state = createGame({ players: fourPlayers, seed: "views" });
    for (const viewer of state.players) {
      const view = getPlayerView(state, viewer.id);
      expect(view.hand).toEqual(viewer.hand);
      expect(view.players.map((p) => p.handCount)).toEqual(state.players.map((p) => p.hand.length));
      const serialized = JSON.stringify(view);
      for (const other of state.players.filter((p) => p.id !== viewer.id)) {
        for (const card of other.hand) {
          if (!viewer.hand.some((c) => c.id === card.id)) expect(serialized).not.toContain(card.id);
        }
      }
      for (const card of state.deck) expect(serialized).not.toContain(card.id);
      expect(serialized).not.toContain('"rng"');
      expect(serialized).not.toContain('"seed"');
    }
  });

  it("a spectator sees no hand", () => {
    const state = createGame({ players: twoPlayers, seed: "spec" });
    const view = getPlayerView(state, "spectator");
    expect(view.hand).toEqual([]);
    for (const p of state.players) for (const c of p.hand) expect(JSON.stringify(view)).not.toContain(c.id);
  });

  it("only the deciding player sees a pending decision's options", () => {
    const start = createGame({ players: twoPlayers, seed: "dec", deckOrder: ["wish", "point_1", "point_1", "point_1", "point_1", "point_1", "point_2"] });
    const { state } = run(start, [{ type: "PLAY_HERO", player: "p1", card: "wish#0" }, { type: "PASS", player: "p2" }]);
    expect(getPlayerView(state, "p1").pendingDecision).toEqual(state.pendingDecision);
    expect(getPlayerView(state, "p2").pendingDecision).toEqual({ player: "p1" });
  });

  it("draw events reveal the card only to the drawer", () => {
    const start = createGame({ players: twoPlayers, seed: "draw" });
    const { events } = run(start, [{ type: "DRAW_CARD", player: "p1" }]);
    const drawn = events.find((e) => e.type === "CARD_DRAWN")!;
    expect(getPlayerEvents(events, "p1")).toContainEqual(drawn);
    expect(getPlayerEvents(events, "p2")).toContainEqual({ type: "CARD_DRAWN", player: "p1" });
    expect(JSON.stringify(getPlayerEvents(events, "p2"))).not.toContain(start.deck[0]!.id);
  });

  it("a view carries the viewer's legal actions, and none for a spectator", () => {
    const start = createGame({ players: twoPlayers, seed: "legal", config: { handSize: 2 }, deckOrder: ["point_1", "challenge", "point_2", "modifier", "point_3"] });
    expect(getPlayerView(start, "p1").legalActions).toEqual([
      { type: "DRAW_CARD", player: "p1" },
      { type: "PLAY_HERO", player: "p1", card: "point_1#0" },
    ]);
    expect(getPlayerView(start, "p2").legalActions).toEqual([]);
    expect(getPlayerView(start, "spectator").legalActions).toEqual([]);

    const { state } = run(start, [{ type: "PLAY_HERO", player: "p1", card: "point_1#0" }]);
    expect(getPlayerView(state, "p2").legalActions).toEqual([
      { type: "PASS", player: "p2" },
      { type: "PLAY_MODIFIER", player: "p2", card: "modifier#0", value: 1 },
    ]);
    expect(getPlayerView(state, "spectator").legalActions).toEqual([]);
  });

  it("views are copies: changing one doesn't change the game", () => {
    const state = createGame({ players: twoPlayers, seed: "copy" });
    const snapshot = JSON.parse(JSON.stringify(state)) as GameState;
    getPlayerView(state, "p1").hand.pop();
    expect(state).toEqual(snapshot);
  });
});

describe("modifiers", () => {
  // p1: point_2, point_1; p2: modifier, point_1; p3: modifier, challenge.
  const deckOrder = ["point_2", "point_1", "modifier", "point_1", "modifier", "challenge", "point_1", "point_1"] as const;
  const threePlayers = fourPlayers.slice(0, 3);
  const start = () => createGame({ players: threePlayers, seed: "mod", config: { handSize: 2 }, deckOrder: [...deckOrder] });

  it("can be played from hand only in a response window, for +1", () => {
    const state = start();
    expect(getLegalActions(state, "p1").map((a) => a.type)).not.toContain("PLAY_MODIFIER");
    const { state: open } = run(state, [{ type: "PLAY_HERO", player: "p1", card: "point_2#0" }]);
    expect(getLegalActions(open, "p2")).toEqual([
      { type: "PASS", player: "p2" },
      { type: "PLAY_MODIFIER", player: "p2", card: "modifier#0", value: 1 },
    ]);
    for (const action of getLegalActions(open, "p3")) expect(ActionSchema.safeParse(action).success).toBe(true);
  });

  it("reopens the window to everyone, including players who already passed", () => {
    let r = run(start(), [{ type: "PLAY_HERO", player: "p1", card: "point_2#0" }, { type: "PASS", player: "p2" }]);
    expect(r.state.responseWindow!.awaiting).toEqual(["p3"]);
    r = run(r.state, [{ type: "PLAY_MODIFIER", player: "p3", card: "modifier#1", value: 1 }]);
    expect(r.events).toEqual([
      { type: "MODIFIED", player: "p3", card: { id: "modifier#1", def: "modifier" }, target: { id: "point_2#0", def: "point_2" }, bonus: 1, awaiting: ["p2", "p3"] },
    ]);
    expect(r.state.phase).toBe("responseWindow");
    expect(r.state.responseWindow!.awaiting).toEqual(["p2", "p3"]);
    expect(r.state.discard).toContainEqual({ id: "modifier#1", def: "modifier" });
  });

  it("adds a point per modifier to the card's score once everyone passes", () => {
    const { state } = run(start(), [
      { type: "PLAY_HERO", player: "p1", card: "point_2#0" },
      { type: "PLAY_MODIFIER", player: "p2", card: "modifier#0", value: 1 },
      { type: "PLAY_MODIFIER", player: "p3", card: "modifier#1", value: 1 },
      { type: "PASS", player: "p2" },
      { type: "PASS", player: "p3" },
    ]);
    expect(state.players[0]!.score).toBe(4);
    expect(totalCards(state)).toBe(deckOrder.length);
  });

  it("is not offered against a wish, which it can't change", () => {
    const state = createGame({ players: twoPlayers, seed: "wish", config: { handSize: 2 }, deckOrder: ["wish", "point_1", "modifier", "challenge", "point_1"] });
    const { state: open } = run(state, [{ type: "PLAY_HERO", player: "p1", card: "wish#0" }]);
    expect(getLegalActions(open, "p2").map((a) => a.type)).toEqual(["PASS", "PLAY_CHALLENGE"]);
  });

  it("rejects a modifier for any value but +1", () => {
    const { state } = run(start(), [{ type: "PLAY_HERO", player: "p1", card: "point_2#0" }]);
    expect(applyAction(state, { type: "PLAY_MODIFIER", player: "p2", card: "modifier#0", value: 5 }).ok).toBe(false);
  });
});

describe("createGame", () => {
  it("rejects too few or too many players and duplicate ids", () => {
    expect(() => createGame({ players: twoPlayers.slice(0, 1), seed: "x" })).toThrow();
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, isBot: false }));
    expect(() => createGame({ players: seven, seed: "x" })).toThrow();
    expect(() => createGame({ players: [twoPlayers[0]!, twoPlayers[0]!], seed: "x" })).toThrow();
  });
});
