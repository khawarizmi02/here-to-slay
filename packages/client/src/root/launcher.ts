import { IndexedDbActionLogStore, Room, type IdbFactoryLike, type RoomEngine } from "@here-to-slay/room";
import { toyRoomEngine, type GameState } from "@here-to-slay/toy-engine";
import type { Launcher } from "../shell/game.js";

/** The toy engine stands in for the rules engine until the board moves to it. */
const engine: RoomEngine<GameState> = toyRoomEngine;

/**
 * The composition root: the only code that touches the Room. It builds Rooms
 * in this tab with the browser's clock, randomness and IndexedDB, and hands
 * the shell nothing but connections.
 */
export function browserLauncher(): Launcher {
  return {
    playOnThisDevice(name) {
      // "Play on this device" never contacts the relay: the Room makes up its own Room Code.
      const room = new Room({
        engine,
        clock: { now: () => Date.now() },
        random: Math.random,
        hostName: name,
        // The DOM types its handlers as taking an event, which the store's handlers ignore.
        store: new IndexedDbActionLogStore(indexedDB as unknown as IdbFactoryLike),
      });
      return room.hostConnection;
    },
  };
}
