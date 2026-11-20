import type { StoreApi } from "zustand/vanilla";
import type { DeviceState } from "./device.js";
import type { GameLayer } from "./game.js";
import type { DeviceSeat, SeatState } from "./seat.js";
import type { Settings } from "./settings.js";

/** The sounds the client plays, each for a moment in the game. */
export type Sound = "diceRoll" | "cardPlayed" | "challenge" | "monsterSlain" | "yourTurn" | "respond" | "gameOver";

/** Plays sounds, as the composition root provides it. */
export interface SoundPlayer {
  /** Plays `sound` at `volume`, from 0 to 1. */
  play(sound: Sound, volume: number): void;
}

/** One tone: its pitch in Hz, when it starts and how long it lasts in seconds, and its wave. */
interface Tone {
  hz: number;
  at: number;
  for: number;
  wave?: OscillatorType;
}

const TONES: Record<Sound, Tone[]> = {
  // Quick clicks, as of dice on a table.
  diceRoll: [0, 0.05, 0.1, 0.16, 0.24].map((at, i) => ({ hz: 300 + i * 70, at, for: 0.03, wave: "square" })),
  cardPlayed: [{ hz: 520, at: 0, for: 0.08, wave: "triangle" }],
  challenge: [
    { hz: 330, at: 0, for: 0.12, wave: "sawtooth" },
    { hz: 247, at: 0.12, for: 0.18, wave: "sawtooth" },
  ],
  monsterSlain: [
    { hz: 392, at: 0, for: 0.1 },
    { hz: 523, at: 0.1, for: 0.1 },
    { hz: 784, at: 0.2, for: 0.25 },
  ],
  yourTurn: [
    { hz: 660, at: 0, for: 0.12 },
    { hz: 880, at: 0.14, for: 0.2 },
  ],
  respond: [
    { hz: 880, at: 0, for: 0.08, wave: "triangle" },
    { hz: 880, at: 0.12, for: 0.08, wave: "triangle" },
  ],
  gameOver: [523, 659, 784, 1047].map((hz, i) => ({ hz, at: i * 0.15, for: i === 3 ? 0.5 : 0.14 })),
};

/**
 * Makes each sound from tones with the Web Audio API: no audio files. The
 * audio context starts on the first sound. A browser keeps it silent until
 * the player first clicks, so each sound asks it to resume. Without Web
 * Audio, nothing plays.
 */
export function webAudioPlayer(): SoundPlayer {
  let context: AudioContext | null = null;
  return {
    play(sound, volume) {
      if (typeof AudioContext === "undefined" || volume <= 0) return;
      context ??= new AudioContext();
      if (context.state === "suspended") void context.resume();
      const start = context.currentTime;
      for (const tone of TONES[sound]) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = tone.wave ?? "sine";
        osc.frequency.value = tone.hz;
        const from = start + tone.at;
        const to = from + tone.for;
        // A short fade in and out, so tones don't click.
        gain.gain.setValueAtTime(0, from);
        gain.gain.linearRampToValueAtTime(0.25 * volume, from + 0.01);
        gain.gain.linearRampToValueAtTime(0, to);
        osc.connect(gain).connect(context.destination);
        osc.start(from);
        osc.stop(to);
      }
    },
  };
}

/**
 * Plays the sounds of the Seat on screen: each event's as the animation
 * queue plays it, and "respond" when a Response Window starts asking the
 * Seat. Events shown at once (animations skipped, the queue jumping ahead,
 * or a Seat's events while another was on screen) play only "your turn".
 * Muted, nothing plays. Returns a function that stops.
 */
export function playDeviceSounds(
  device: StoreApi<DeviceState>,
  game: Pick<GameLayer, "sound" | "responseOptions">,
  settings: () => Settings,
  player: SoundPlayer,
): () => void {
  const play = (sound: Sound) => {
    const { sound: on, volume } = settings();
    if (on) player.play(sound, volume);
  };
  /** Whether the Seat is asked to respond, as its screen offers it. */
  const asked = (seat: DeviceSeat, { view, playing, responseOptions }: SeatState) =>
    playing === null && view !== null && (seat.remote ? game.responseOptions(view) : responseOptions) !== null;
  /** How many of each Seat's logged events have had their sound, or been passed over. */
  const heard = new WeakMap<DeviceSeat, number>();

  /** Plays what `seat` has added to its log since it was last heard. */
  function hear(seat: DeviceSeat, { log, playing, view }: SeatState): void {
    const added = log.slice(heard.get(seat) ?? 0);
    heard.set(seat, log.length);
    if (view === null) return;
    const played = added.length === 1 && added[0] === playing;
    const sounds = added.map((event) => game.sound(event, view)).filter((s) => s !== null);
    // Several turns may have passed: one "your turn" says it.
    for (const sound of new Set(played ? sounds : sounds.filter((s) => s === "yourTurn"))) play(sound);
  }

  let stopSeat = () => {};
  function watch(seat: DeviceSeat): void {
    stopSeat();
    let before = seat.store.getState();
    hear(seat, before);
    if (asked(seat, before)) play("respond");
    stopSeat = seat.store.subscribe((now) => {
      if (now.log !== before.log) hear(seat, now);
      if (asked(seat, now) && !asked(seat, before)) play("respond");
      before = now;
    });
  }
  // What the first Seat already shows when the device starts is no news.
  const first = device.getState().onScreen;
  heard.set(first, first.store.getState().log.length);
  watch(first);
  const stopDevice = device.subscribe(({ onScreen }, prev) => {
    if (onScreen !== prev.onScreen) watch(onScreen);
  });
  return () => {
    stopDevice();
    stopSeat();
  };
}
