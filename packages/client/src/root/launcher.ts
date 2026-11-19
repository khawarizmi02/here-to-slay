import type { RoomCode, RoomMsg, SeatId, SeatToken } from "@here-to-slay/protocol";
import {
  IndexedDbActionLogStore,
  JoinError,
  RelayConnection,
  Room,
  type GameConnection,
  type IdbFactoryLike,
  type RecordSeat,
  type RelaySocket,
  type RoomEngine,
} from "@here-to-slay/room";
import { toyRoomEngine, type GameState } from "@here-to-slay/toy-engine";
import { RoomClosedError, type LaunchedRoom, type LaunchedSeat, type Launcher } from "../shell/game.js";
import { stayAttached, stayJoined } from "./reconnect.js";
import { heldSubscribers } from "./subscribers.js";
import { browserDialer, createRelayRoom, hostSocket, rejoiningDialer, type RelayRoom } from "./relay.js";

/** The toy engine stands in for the rules engine until the board moves to it. */
const engine: RoomEngine<GameState> = toyRoomEngine;

/**
 * The composition root: the only code that touches the Room. It builds Rooms
 * in this tab with the browser's clock, the given randomness and IndexedDB,
 * reaches the relay at `relayUrl` for online Rooms, and hands the shell
 * nothing but connections.
 */
export function browserLauncher(relayUrl: string, random: () => number): Launcher {
  const roomOptions = {
    engine,
    clock: { now: () => Date.now() },
    random,
    // The DOM types its handlers as taking an event, which the store's handlers ignore.
    store: new IndexedDbActionLogStore(indexedDB as unknown as IdbFactoryLike),
  };

  return {
    playOnThisDevice(name) {
      // "Play on this device" never contacts the relay: the Room makes up its own Room Code.
      return onThisDevice(new Room({ ...roomOptions, hostName: name }), { name, host: true });
    },

    async hostOnline(name) {
      let created: RelayRoom;
      let socket: RelaySocket;
      try {
        created = await createRelayRoom(relayUrl);
        socket = await hostSocket(relayUrl, created.roomCode, created.hostToken);
      } catch (e) {
        throw new Error(`Couldn't host online: the relay can't be reached (${e instanceof Error ? e.message : String(e)})`, { cause: e });
      }
      const room = new Room({ ...roomOptions, hostName: name, roomCode: created.roomCode });
      return hostedOnline(room, created.hostToken, socket, { name, host: true });
    },

    async join(roomCode, name) {
      // Rejects with a JoinError, whose message is for the player.
      const connection = await RelayConnection.join({ dialer: browserDialer(relayUrl), roomCode, name });
      return asFriend(connection, name);
    },

    async resume(pointer) {
      if (pointer.mode === "online" && pointer.token === undefined) throw new Error("An online Room's pointer has no token");
      if (pointer.role === "friend") {
        if (pointer.mode !== "online") throw new Error("A friend's Seat is always online");
        return asFriend(await rejoin(pointer.roomCode, pointer.name, pointer.token!), pointer.name);
      }

      // The Room saves nothing before startGame: a refresh in the lobby rebuilds an empty lobby under the same Room Code.
      const record = await roomOptions.store.load(pointer.roomCode);
      const room = record ? Room.restore(roomOptions, record) : new Room({ ...roomOptions, hostName: pointer.name, roomCode: pointer.roomCode });
      // The Host's Seat is always the record's first; a game under way sends no lobby to say so.
      const [hostSeat, ...others] = record?.seats ?? [];
      const host = hostSeat ? { name: hostSeat.name, host: true, seatId: hostSeat.id } : { name: pointer.name, host: true };
      const restored = others.filter((s) => s.kind === "local");
      if (pointer.mode === "offline") return onThisDevice(room, host, restored);
      // A relay that no longer knows the Room rejects with a RoomClosedError: friends were told it closed.
      const socket = await hostSocket(relayUrl, pointer.roomCode, pointer.token!);
      return hostedOnline(room, pointer.token!, socket, host, restored);
    },
  };

  /** Comes back to the Seat `seatToken` holds. Rejects with a `RoomClosedError` when the relay no longer knows the Room. */
  async function rejoin(roomCode: RoomCode, name: string, seatToken: SeatToken): Promise<RelayConnection> {
    try {
      return await RelayConnection.join({ dialer: rejoiningDialer(browserDialer(relayUrl)), roomCode, name, seatToken });
    } catch (e) {
      if (e instanceof JoinError && e.cause instanceof RoomClosedError) throw e.cause;
      throw e;
    }
  }

  /** A friend's one Seat, which joins again by itself whenever its socket drops. */
  function asFriend(connection: RelayConnection, name: string): LaunchedRoom {
    return {
      roomCode: connection.roomCode,
      seats: [{ connection: stayJoined(connection, () => rejoin(connection.roomCode, name, connection.seatToken)), name, remote: true }],
      // Only the Host's device adds local Seats.
      onSeatAdded: () => () => {},
      online: { token: connection.seatToken },
    };
  }

  /**
   * `room` on the relay through `socket`, which is replaced whenever it
   * drops. The Host's tab checks deadlines whenever it is visible again.
   */
  function hostedOnline(
    room: Room<GameState>,
    hostToken: string,
    socket: RelaySocket,
    host: Omit<LaunchedSeat, "connection">,
    restored: RecordSeat[] = [],
  ): LaunchedRoom {
    room.attachRelay(socket);
    const { announceRoomClosed, ...launched } = onThisDevice(room, host, restored);
    const stopRelay = stayAttached(room, socket, () => hostSocket(relayUrl, room.roomCode, hostToken), announceRoomClosed);
    const stopChecking = checkDeadlinesWhenVisible(room, document);
    return {
      ...launched,
      online: { token: hostToken },
      close() {
        stopChecking();
        stopRelay();
      },
    };
  }
}

/**
 * The Host's Seat in `room`, and a connection for every other local Seat:
 * `restored` ones now, and each new one as soon as a lobby names it.
 * `announceRoomClosed` tells the Host's Seat the Room has closed.
 */
function onThisDevice(
  room: Room<GameState>,
  host: Omit<LaunchedSeat, "connection">,
  restored: RecordSeat[] = [],
): LaunchedRoom & { announceRoomClosed(): void } {
  const listeners = new Set<(seat: LaunchedSeat) => void>();
  const connected = new Set<SeatId>();
  const connect = (seatId: SeatId, name: string): LaunchedSeat => {
    connected.add(seatId);
    return { connection: room.connectLocalSeat(seatId), name, seatId };
  };

  const hostConnection = watched(room.hostConnection, (msg) => {
    if (msg.t !== "lobby") return;
    for (const seat of msg.seats) {
      if (seat.kind !== "local" || msg.you.includes(seat.id) || connected.has(seat.id)) continue;
      const launched = connect(seat.id, seat.name);
      for (const cb of [...listeners]) cb(launched);
    }
  });

  return {
    roomCode: room.roomCode,
    seats: [{ ...host, connection: hostConnection }, ...restored.map((s) => connect(s.id, s.name))],
    announceRoomClosed: () => hostConnection.deliver({ t: "roomClosed" }),
    onSeatAdded(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/**
 * `connection`, with `watch` seeing each message once the Room has finished
 * delivering it: connecting a Seat sends a newer lobby, which must not
 * overtake the one still on its way to the other Seats. It holds messages
 * for the first subscriber. `deliver` hands
 * subscribers a message the Room didn't send, such as `roomClosed`.
 */
function watched(connection: GameConnection, watch: (msg: RoomMsg) => void): GameConnection & { deliver(msg: RoomMsg): void } {
  const { deliver, add } = heldSubscribers();
  const unsubscribe = connection.onMessage((msg) => {
    deliver(msg);
    queueMicrotask(() => watch(msg));
  });

  return {
    deliver,
    send: (msg) => connection.send(msg),
    onMessage: add,
    close() {
      unsubscribe();
      connection.close();
    },
  };
}

/**
 * Browsers slow down timers in background tabs, so the Host's tab has the
 * Room check its deadlines whenever it becomes visible again
 * (TECHNICAL_DESIGN.md §10.6). Returns a function that stops it.
 */
export function checkDeadlinesWhenVisible(room: Pick<Room<unknown>, "checkDeadlines">, doc: Document): () => void {
  const check = () => {
    if (doc.visibilityState === "visible") room.checkDeadlines();
  };
  doc.addEventListener("visibilitychange", check);
  return () => doc.removeEventListener("visibilitychange", check);
}
