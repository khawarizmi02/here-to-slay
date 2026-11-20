import { describe, expect, it } from "vitest";
import { openReplay, ReplayError } from "../src/index.js";
import { hotSeat, nextMove, sendMove, toyEngine, viewOf } from "./harness.js";

/** A finished hot-seat game between Alice, Bob and a bot, with its downloaded replay file. */
function finishedGame() {
  const game = hotSeat(["Bob"], { roomCode: "ABC23" });
  game.host.send({ t: "addBot", difficulty: "normal" });
  game.host.send({ t: "startGame" });
  for (let i = 0; nextMove(game.clients); i++) sendMove(game.clients, nextMove(game.clients)!, i);
  expect(viewOf(game.host.last("update")).phase).toBe("gameOver");
  return { ...game, contents: game.room.replayFile()!.contents };
}

describe("openReplay", () => {
  it("played to the end, shows each Seat the same final view as the game", () => {
    const { contents, clients, seatIds } = finishedGame();
    const replay = openReplay(toyEngine, contents);
    for (const seat of [seatIds[0]!, seatIds[1]!]) {
      expect(replay.viewAt(replay.length, seat)).toEqual(clients.get(seat)!.last("update").view);
    }
  });

  it("names the players in Seat order, and shows a spectator's view", () => {
    const { contents } = finishedGame();
    const replay = openReplay(toyEngine, contents);
    expect(replay.players.map((p) => p.name)).toEqual(["Alice", "Bob", "Bot 1"]);
    const view = viewOf({ t: "update", version: 0, events: [], view: replay.viewAt(replay.length, null) });
    expect(view.me).toBe("spectator");
    expect(view.phase).toBe("gameOver");
  });

  it("starts before the first action, and gives the same view at a step however it is reached", () => {
    const { contents, seatIds } = finishedGame();
    const replay = openReplay(toyEngine, contents);
    expect(replay.length).toBeGreaterThan(2);
    const second = replay.viewAt(2, seatIds[0]!);
    expect(replay.viewAt(0, seatIds[0]!)).not.toEqual(second);
    replay.viewAt(replay.length, seatIds[0]!);
    expect(replay.viewAt(2, seatIds[0]!)).toEqual(second);
  });

  it("gives the events up to a step, as that viewer saw them", () => {
    const { contents, seatIds } = finishedGame();
    const replay = openReplay(toyEngine, contents);
    expect(replay.logAt(0, null)).toEqual([]);
    expect(replay.logAt(replay.length, seatIds[0]!).length).toBeGreaterThan(replay.logAt(1, seatIds[0]!).length);
  });

  it("refuses a file that isn't a replay", () => {
    expect(() => openReplay(toyEngine, "not json")).toThrow(new ReplayError("That file isn't a Here to Slay replay."));
    expect(() => openReplay(toyEngine, JSON.stringify({ hello: "world" }))).toThrow(ReplayError);
  });

  it("refuses a replay made with other card definitions", () => {
    const record = JSON.parse(finishedGame().contents) as { cardDefsVersion: string };
    const other = JSON.stringify({ ...record, cardDefsVersion: "toy-0" });
    expect(() => openReplay(toyEngine, other)).toThrow(
      new ReplayError("That replay was made with other card definitions (toy-0), so this version of the game can't play it back."),
    );
  });

  it("refuses a replay whose actions don't play back", () => {
    const record = JSON.parse(finishedGame().contents) as { actions: unknown[] };
    const broken = JSON.stringify({ ...record, actions: [...record.actions, { type: "END_TURN", player: "s1" }] });
    expect(() => openReplay(toyEngine, broken)).toThrow(ReplayError);
  });
});
