import { createStore, type StoreApi } from "zustand/vanilla";

export type AnimationSpeed = "slow" | "normal" | "fast";

/** How long each event plays before the next, in ms, at each animation speed. */
export const EVENT_MS: Record<AnimationSpeed, number> = { slow: 600, normal: 300, fast: 150 };

/** The player's settings for this device. */
export interface Settings {
  animationSpeed: AnimationSpeed;
  /** Every view shows as soon as it arrives, with no animation. */
  skipAnimations: boolean;
  sound: boolean;
  /** From 0 to 1. */
  volume: number;
}

export const DEFAULT_SETTINGS: Settings = { animationSpeed: "normal", skipAnimations: false, sound: true, volume: 0.8 };

/** The settings, saved per device. */
export interface DeviceSettings {
  readonly store: StoreApi<Settings>;
  change(patch: Partial<Settings>): void;
}

const KEY = "here-to-slay.settings";

/**
 * Keeps the settings in `storage` (the browser's localStorage), or only in
 * memory without one. Storage can be blocked, full or edited by hand: a
 * missing or broken saved value reads as its default.
 */
export function deviceSettings(storage: Pick<Storage, "getItem" | "setItem"> | null = null): DeviceSettings {
  const store = createStore<Settings>()(() => load(storage));
  return {
    store,
    change(patch) {
      store.setState(patch);
      try {
        storage?.setItem(KEY, JSON.stringify(store.getState()));
      } catch {
        // Without storage, the settings last until the page is closed.
      }
    },
  };
}

function load(storage: Pick<Storage, "getItem"> | null): Settings {
  let saved: unknown;
  try {
    const raw = storage?.getItem(KEY);
    saved = raw == null ? null : JSON.parse(raw);
  } catch {
    saved = null;
  }
  const s = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  return {
    animationSpeed: typeof s.animationSpeed === "string" && Object.hasOwn(EVENT_MS, s.animationSpeed) ? (s.animationSpeed as AnimationSpeed) : d.animationSpeed,
    skipAnimations: typeof s.skipAnimations === "boolean" ? s.skipAnimations : d.skipAnimations,
    sound: typeof s.sound === "boolean" ? s.sound : d.sound,
    volume: typeof s.volume === "number" && s.volume >= 0 && s.volume <= 1 ? s.volume : d.volume,
  };
}
