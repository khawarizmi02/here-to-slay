import type { Action, ConfigPatch } from "@here-to-slay/protocol";
import { describe, expect, it } from "vitest";
import { createRoomEngine, type GameState, type PlayerView } from "../src/index.js";
import { players, smallSet } from "./cards.js";

const engine = createRoomEngine(smallSet());

function draft(count = 3, config: ConfigPatch = {}): GameState {
  return engine.createGame({ players: players(count), seed: "draft", config: { leaderSelection: "draft", firstPlayerMethod: "firstSeat", ...config } });
}

type Decision = Extract<PlayerView["pendingDecision"], { options: unknown }>;

function decisionOf(state: GameState, player: string): Decision {
  const decision = engine.getPlayerView(state, player).pendingDecision;
  if (!decision || !("options" in decision)) throw new Error(`${player} has no Decision`);
  return decision;
}

function pick(state: GameState, player: string, option: string): GameState {
  const r = engine.applyAction(state, { type: "RESOLVE_DECISION", player, decisionId: decisionOf(state, player).id, answer: { selected: [option] } });
  expect(r.ok, r.error).toBe(true);
  return r.state;
}

describe("leader draft", () => {
  it("asks the first Seat to pick first, from every leader, by instance id", () => {
    const state = draft();
    expect(state.phase).toEqual({ kind: "setup", step: "leaderSelect" });
    expect(engine.getActivePlayer(state)).toBe("p1");
    const decision = decisionOf(state, "p1");
    expect(decision.kind).toBe("chooseLeader");
    expect(decision.options.map((o) => o.id)).toEqual([
      "leader_bard#0",
      "leader_fighter#0",
      "leader_guardian#0",
      "leader_ranger#0",
      "leader_thief#0",
      "leader_wizard#0",
    ]);
    expect(engine.getLegalActions(state, "p1")).toEqual(
      decision.options.map((o) => ({ type: "RESOLVE_DECISION", player: "p1", decisionId: decision.id, answer: { selected: [o.id] } })),
    );
    expect(engine.isDiscardDecision(state, "p1")).toBe(false);
  });

  it("deals before the draft, so drafters see their hands", () => {
    const state = draft();
    for (const p of state.players) expect(p.hand).toHaveLength(5);
    expect(engine.getPlayerView(state, "p1").hand).toHaveLength(5);
  });

  it("shows only who is picking to everyone else, and asks nothing of them", () => {
    const state = draft();
    for (const other of ["p2", "p3", "spectator"] as const) {
      expect(engine.getPlayerView(state, other).pendingDecision).toEqual({ player: "p1" });
    }
    expect(engine.getLegalActions(state, "p2")).toEqual([]);
    const json = JSON.stringify(engine.getPlayerView(state, "p2"));
    for (const leader of state.leaderPool) expect(json).not.toContain(JSON.stringify(leader));
  });

  it("gives every player one leader, picked in Seat order", () => {
    let state = draft();
    state = pick(state, "p1", "leader_thief#0");
    expect(engine.getActivePlayer(state)).toBe("p2");
    expect(decisionOf(state, "p2").options.map((o) => o.id)).not.toContain("leader_thief#0");
    state = pick(state, "p2", "leader_bard#0");
    expect(engine.getActivePlayer(state)).toBe("p3");
    state = pick(state, "p3", "leader_wizard#0");

    expect(state.players.map((p) => p.leader)).toEqual(["leader_thief#0", "leader_bard#0", "leader_wizard#0"]);
    expect(state.phase).toEqual({ kind: "action" });
    expect(engine.getPlayerView(state, "p1").pendingDecision).toBeNull();
    expect(state.leaderPool).toEqual(["leader_fighter#0", "leader_guardian#0", "leader_ranger#0"]);
    expect(engine.getActivePlayer(state)).toBe("p1");
    expect(state.turnOrder).toEqual(["p1", "p2", "p3"]);
  });

  it("shows a picked leader to everyone, and no leader before the pick", () => {
    let state = draft();
    expect(engine.getPlayerView(state, "p2").players.map((p) => p.leader)).toEqual([null, null, null]);
    state = pick(state, "p1", "leader_thief#0");
    expect(engine.getPlayerView(state, "p3").players[0]!.leader).toEqual({ id: "leader_thief#0", def: "leader_thief" });
  });

  it("picks the last leader on its own when only one is left", () => {
    let state = draft(6, { startingHandSize: 2 });
    for (const p of ["p1", "p2", "p3", "p4", "p5"]) state = pick(state, p, decisionOf(state, p).options[0]!.id);
    expect(state.players[5]!.leader).toBe("leader_wizard#0");
    expect(state.phase).toEqual({ kind: "action" });
  });

  it("rejects a pick from the wrong player, for a stale Decision, or of a leader on offer to nobody", () => {
    const state = draft();
    const { id } = decisionOf(state, "p1");
    const bad: Action[] = [
      { type: "RESOLVE_DECISION", player: "p2", decisionId: id, answer: { selected: ["leader_bard#0"] } },
      { type: "RESOLVE_DECISION", player: "p1", decisionId: "nope", answer: { selected: ["leader_bard#0"] } },
      { type: "RESOLVE_DECISION", player: "p1", decisionId: id, answer: { selected: ["hero_bard#0"] } },
      { type: "END_TURN", player: "p1" },
    ];
    for (const action of bad) {
      const r = engine.applyAction(state, action);
      expect(r.ok, JSON.stringify(action)).toBe(false);
      expect(r.state).toBe(state);
      expect(r.error).toBeTruthy();
    }
  });

  it("announces each pick", () => {
    const state = draft();
    const r = engine.applyAction(state, { type: "RESOLVE_DECISION", player: "p1", decisionId: decisionOf(state, "p1").id, answer: { selected: ["leader_ranger#0"] } });
    expect(r.events).toContainEqual({ type: "LEADER_CHOSEN", player: "p1", leader: { id: "leader_ranger#0", def: "leader_ranger" } });
  });
});
