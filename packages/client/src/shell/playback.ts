import type { GameEvent, PlayerViewPayload, RoomMsg } from "@here-to-slay/protocol";
import { EVENT_MS } from "./settings.js";

/** More updates than this waiting to show, the one playing included, and the Seat jumps to the latest. */
export const MAX_WAITING_UPDATES = 3;

/** What a Seat shows of its updates: the view and log so far, and the event playing now. */
export interface Shown {
  view: PlayerViewPayload;
  log: GameEvent[];
  /** The event playing now, already in `log`, or null when nothing is playing. */
  playing: GameEvent | null;
}

/** What the queue needs of the Room's `update`. */
type Update = Pick<Extract<RoomMsg, { t: "update" }>, "version" | "view" | "events">;

/** One Seat's animation queue: what it shows of the updates it receives. */
export interface Playback {
  /** Queues an update, or shows it at once when the Seat isn't animating, after a version gap, or behind too many others. */
  receive(update: Update): void;
  /** Whether updates animate. Turning it off shows the latest at once. */
  setAnimated(animated: boolean): void;
  /** How long each event plays before the next, in ms, from the next event on. */
  setEventMs(ms: number): void;
  stop(): void;
}

/**
 * Each update's events play in order, one slot each, and its view shows once
 * they have. Anything that would leave the Seat watching the past (a version
 * that isn't the last plus 1, a backlog, or animations switched off) drops
 * what's waiting and shows the latest view, with every event in the log.
 */
export function createPlayback(show: (shown: Partial<Shown>) => void, current: () => { log: GameEvent[] }): Playback {
  let animated = false;
  let eventMs = EVENT_MS.normal;
  let lastVersion: number | null = null;
  /** Updates received but not yet shown, oldest first: the first is the one playing. */
  const waiting: Update[] = [];
  /** How many of the first waiting update's events have played. */
  let played = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Plays the next waiting event, or shows the first waiting update once all of its events have played. */
  function next(): void {
    timer = null;
    while (waiting.length > 0) {
      const head = waiting[0]!;
      const event = head.events[played];
      if (event !== undefined) {
        played++;
        show({ log: [...current().log, event], playing: event });
        timer = setTimeout(next, eventMs);
        return;
      }
      waiting.shift();
      played = 0;
      show({ view: head.view, playing: null });
    }
  }

  function stop(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Drops what's waiting and shows the latest update, with every event not yet played added to the log. */
  function jump(): void {
    stop();
    const latest = waiting.at(-1);
    if (!latest) return;
    const unplayed = waiting.flatMap((w, i) => (i === 0 ? w.events.slice(played) : w.events));
    waiting.length = 0;
    played = 0;
    show({ view: latest.view, log: [...current().log, ...unplayed], playing: null });
  }

  return {
    receive(update) {
      const inOrder = lastVersion !== null && update.version === lastVersion + 1;
      lastVersion = update.version;
      waiting.push(update);
      if (!animated || !inOrder || waiting.length > MAX_WAITING_UPDATES) jump();
      else if (timer === null) next();
    },
    setAnimated(on) {
      animated = on;
      if (!on) jump();
    },
    setEventMs(ms) {
      eventMs = ms;
    },
    stop,
  };
}
