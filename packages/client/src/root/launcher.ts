import type { RoomMsg, SeatId } from "@here-to-slay/protocol";
import { IndexedDbActionLogStore, Room, type GameConnection, type IdbFactoryLike, type RecordSeat, type RoomEngine } from "@here-to-slay/room";
import { toyRoomEngine, type GameState } from "@here-to-slay/toy-engine";
import type { LaunchedRoom, LaunchedSeat, Launcher } from "../shell/game.js";

/** The toy engine stands in for the rules engine until the board moves to it. */
const engine: RoomEngine<GameState> = toyRoomEngine;

/**
 * The composition root: the only code that touches the Room. It builds Rooms
 * in this tab with the browser's clock, randomness and IndexedDB, and hands
 * the shell nothing but connections.
 */
export function browserLauncher(): Launcher {
  const roomOptions = {
    engine,
    clock: { now: () => Date.now() },
    random: Math.random,
    // The DOM types its handlers as taking an event, which the store's handlers ignore.
    store: new IndexedDbActionLogStore(indexedDB as unknown as IdbFactoryLike),
  };

  return {
    playOnThisDevice(name) {
      // "Play on this device" never contacts the relay: the Room makes up its own Room Code.
      return onThisDevice(new Room({ ...roomOptions, hostName: name }), { name });
    },

    async resume(pointer) {
      if (pointer.mode !== "offline" || pointer.role !== "host") throw new Error("Only games on this device can be resumed so far");
      const record = await roomOptions.store.load(pointer.roomCode);
      if (!record) {
        // The Room saves nothing before startGame: a refresh in the lobby rebuilds an empty lobby under the same Room Code.
        return onThisDevice(new Room({ ...roomOptions, hostName: pointer.name, roomCode: pointer.roomCode }), { name: pointer.name });
      }
      // The Host's Seat is always the record's first; a game under way sends no lobby to say so.
      const [host, ...others] = record.seats;
      return onThisDevice(
        Room.restore(roomOptions, record),
        { name: host!.name, seatId: host!.id },
        others.filter((s) => s.kind === "local"),
      );
    },
  };
}

/**
 * The Host's Seat in `room`, and a connection for every other local Seat:
 * `restored` ones now, and each new one as soon as a lobby names it.
 */
function onThisDevice(room: Room<GameState>, host: Omit<LaunchedSeat, "connection">, restored: RecordSeat[] = []): LaunchedRoom {
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
 * overtake the one still on its way to the other Seats. Like the Room's own
 * connections, it holds messages for the first subscriber.
 */
function watched(connection: GameConnection, watch: (msg: RoomMsg) => void): GameConnection {
  const listeners = new Set<(msg: RoomMsg) => void>();
  let backlog: RoomMsg[] | null = [];
  const unsubscribe = connection.onMessage((msg) => {
    if (backlog) backlog.push(msg);
    else for (const cb of [...listeners]) cb(msg);
    queueMicrotask(() => watch(msg));
  });

  return {
    send: (msg) => connection.send(msg),
    onMessage(cb) {
      listeners.add(cb);
      const held = backlog;
      backlog = null;
      for (const msg of held ?? []) cb(msg);
      return () => {
        listeners.delete(cb);
      };
    },
    close() {
      unsubscribe();
      connection.close();
    },
  };
}
