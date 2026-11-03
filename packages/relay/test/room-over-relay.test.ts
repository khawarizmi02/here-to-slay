import { RoomMsgSchema, type Action, type RoomMsg } from "@here-to-slay/protocol";
import { JoinError, RelayConnection, Room, relaySocket, type GameConnection, type RelayDialer, type RoomEngine } from "@here-to-slay/room";
import * as toy from "@here-to-slay/toy-engine";
import { describe, expect, it } from "vitest";
import { createRoom, upgrade } from "./client.js";

/*
 * The Room and RelayConnection against the real relay: a Host tab holding the
 * Room, and friends' tabs, each with a real WebSocket through the Worker and
 * its Durable Object.
 */

const toyEngine: RoomEngine<toy.GameState> = {
  cardDefsVersion: "toy-2",
  createGame: ({ players, seed }) => toy.createGame({ players, seed }),
  applyAction: toy.applyAction,
  getLegalActions: toy.getLegalActions,
  getActivePlayer: (state) => state.activePlayer,
  getPlayerView: (state, player) => toy.getPlayerView(state, player) as unknown as Record<string, unknown>,
  getPlayerEvents: toy.getPlayerEvents,
};

function seededRandom(seed: string): () => number {
  let rng = toy.createRng(seed);
  return () => {
    let f: number;
    [f, rng] = toy.nextFloat(rng);
    return f;
  };
}

/** Opens a WebSocket to the relay the way a browser tab would. */
async function open(roomCode: string, query: Record<string, string>) {
  const res = await upgrade(roomCode, query);
  if (res.status !== 101) return { refused: res.status };
  const ws = res.webSocket!;
  ws.accept();
  return relaySocket(ws);
}

const dialer: RelayDialer = {
  dial: (roomCode, seatToken) => open(roomCode, seatToken === null ? {} : { seatToken }),
};

class Tab {
  readonly inbox: RoomMsg[] = [];
  constructor(readonly conn: GameConnection) {
    conn.onMessage((msg) => {
      expect(RoomMsgSchema.safeParse(msg).success).toBe(true);
      this.inbox.push(msg);
    });
  }
  last<T extends RoomMsg["t"]>(t: T): Extract<RoomMsg, { t: T }> | undefined {
    return this.inbox.filter((m): m is Extract<RoomMsg, { t: T }> => m.t === t).at(-1);
  }
  view(): toy.PlayerView | undefined {
    return this.last("update")?.view as unknown as toy.PlayerView | undefined;
  }
  /** The response prompt the Room sent after the latest update, if it still stands. */
  prompt(): RoomMsg["t"] | undefined {
    let prompt: RoomMsg["t"] | undefined;
    for (const msg of this.inbox) {
      if (msg.t === "update") prompt = undefined;
      else if (msg.t === "passDevice" || msg.t === "respond") prompt = msg.t;
    }
    return prompt;
  }
}

/** Waits until `check` holds, as messages cross the relay. */
async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The move a player's UI would make from its own view, if it is their move.
 * A local Seat responds only when the Room asks it to, after confirming it has the device.
 */
function moveFor(seat: string, tab: Tab, local: boolean): Action | "confirm" | undefined {
  const view = tab.view()!;
  const player = "ignored-by-room";
  if (view.phase === "action" && view.activePlayer === seat) {
    const card = view.hand.find((c) => !toy.TOY_RESPONSE_CARDS.includes(c.def));
    return card ? { type: "PLAY_HERO", player, card: card.id } : { type: "DRAW_CARD", player };
  }
  if (view.phase === "responseWindow" && view.responseWindow?.awaiting.includes(seat)) {
    if (!local) return { type: "PASS", player };
    const prompt = tab.prompt();
    if (prompt === "passDevice") return "confirm";
    return prompt === "respond" ? { type: "PASS", player } : undefined;
  }
  if (view.phase === "decision" && view.pendingDecision && "id" in view.pendingDecision) {
    const decision = view.pendingDecision;
    return { type: "RESOLVE_DECISION", player, decisionId: decision.id, answer: { selected: [decision.options[0]!.id] } };
  }
  return undefined;
}

describe("a Room over the real relay", () => {
  it("seats two friends and a bot, and plays a toy game to game over", async () => {
    const { roomCode, hostToken } = await createRoom();
    const room = new Room({ engine: toyEngine, clock: { now: () => 0 }, random: seededRandom("relay"), hostName: "Alice", roomCode });
    const hostSocket = await open(roomCode, { hostToken });
    if ("refused" in hostSocket) throw new Error(`Host refused: ${hostSocket.refused}`);
    room.attachRelay(hostSocket);
    const host = new Tab(room.hostConnection);
    host.conn.send({ t: "addBot", difficulty: "easy" });

    const bob = new Tab(await RelayConnection.join({ dialer, roomCode: roomCode.toLowerCase(), name: "Bob" }));
    await until(() => host.last("lobby")?.seats.length === 3, "Bob in the Host's lobby");
    const cara = new Tab(await RelayConnection.join({ dialer, roomCode, name: "Cara" }));
    await until(() => [bob, cara].every((t) => t.last("lobby")?.seats.length === 4), "Cara in every friend's lobby");
    expect(bob.last("lobby")!.seats.map((s) => [s.name, s.kind])).toEqual([
      ["Alice", "local"],
      ["Bot 1", "bot"],
      ["Bob", "remote"],
      ["Cara", "remote"],
    ]);

    host.conn.send({ t: "startGame" });
    const tabs = new Map<string, Tab>([
      [host.last("lobby")!.you[0]!, host],
      [bob.last("lobby")!.you[0]!, bob],
      [cara.last("lobby")!.you[0]!, cara],
    ]);
    await until(() => [...tabs.values()].every((t) => t.view()), "the first update");

    for (let clientSeq = 0; host.view()!.phase !== "gameOver"; clientSeq++) {
      expect(clientSeq).toBeLessThan(300);
      const version = host.last("update")!.version;
      // Every tab must have caught up before anyone picks a move from their view.
      await until(() => [...tabs.values()].every((t) => t.last("update")!.version === version), `everyone at version ${version}`);
      const [seat, tab] = [...tabs].find(([seat, tab]) => moveFor(seat, tab, tab === host))!;
      const move = moveFor(seat, tab, tab === host)!;
      if (move === "confirm") {
        tab.conn.send({ t: "confirmPassDevice", seat });
        await until(() => tab.prompt() === "respond", "the response options");
        continue;
      }
      tab.conn.send({ t: "action", seat, action: move, clientSeq });
      await until(() => host.last("update")!.version > version, `the move after version ${version}`);
    }

    const final = host.last("update")!;
    await until(() => [bob, cara].every((t) => t.last("update")!.version === final.version), "the final update");
    for (const [seat, tab] of tabs) {
      expect(tab.view()!.phase).toBe("gameOver");
      expect(tab.view()!.me).toBe(seat);
      expect(tab.view()!.winner).toBe(host.view()!.winner);
      expect(tab.inbox.filter((m) => m.t === "actionRejected" || m.t === "error")).toEqual([]);
    }
  });

  it("refuses an unknown Room Code with a clear error", async () => {
    await expect(RelayConnection.join({ dialer, roomCode: "ZZZZ9", name: "Bob" })).rejects.toThrow(
      new JoinError("There is no Room ZZZZ9. It may have closed; ask the Host for a new Room Code."),
    );
  });
});
