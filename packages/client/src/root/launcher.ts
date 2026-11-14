import { IndexedDbActionLogStore, Room, type IdbFactoryLike, type RoomEngine } from "@here-to-slay/room";
import { toyRoomEngine, type GameState } from "@here-to-slay/toy-engine";
import type { LaunchedSeat, Launcher } from "../shell/game.js";

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
      return hostSeat(new Room({ ...roomOptions, hostName: name }));
    },

    async resume(pointer) {
      if (pointer.mode !== "offline" || pointer.role !== "host") throw new Error("Only games on this device can be resumed so far");
      const record = await roomOptions.store.load(pointer.roomCode);
      if (!record) {
        // The Room saves nothing before startGame: a refresh in the lobby rebuilds an empty lobby under the same Room Code.
        return hostSeat(new Room({ ...roomOptions, hostName: pointer.name, roomCode: pointer.roomCode }));
      }
      // The Host's Seat is always the record's first; a game under way sends no lobby to say so.
      return { ...hostSeat(Room.restore(roomOptions, record)), seatId: record.seats[0]!.id };
    },
  };
}

function hostSeat(room: Room<GameState>): LaunchedSeat {
  return { connection: room.hostConnection, roomCode: room.roomCode };
}
