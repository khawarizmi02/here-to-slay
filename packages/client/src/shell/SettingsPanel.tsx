import { useState } from "react";
import { useStore } from "zustand";
import { Dialog } from "./Dialog.js";
import type { AnimationSpeed, DeviceSettings } from "./settings.js";

const SPEEDS: { speed: AnimationSpeed; label: string }[] = [
  { speed: "slow", label: "Slow" },
  { speed: "normal", label: "Normal" },
  { speed: "fast", label: "Fast" },
];

/** This device's settings, over the first screen or the board. Each change is saved as it is made. */
export function SettingsPanel({ settings, onClose }: { settings: DeviceSettings; onClose(): void }) {
  const { animationSpeed, skipAnimations, sound, volume } = useStore(settings.store);
  return (
    <Dialog title="Settings" className="settings" onClose={onClose}>
      <fieldset>
        <legend>Animation speed</legend>
        {SPEEDS.map(({ speed, label }) => (
          <label key={speed}>
            <input
              type="radio"
              name="animation-speed"
              checked={animationSpeed === speed}
              disabled={skipAnimations}
              onChange={() => settings.change({ animationSpeed: speed })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <label>
        <input type="checkbox" checked={skipAnimations} onChange={(e) => settings.change({ skipAnimations: e.target.checked })} />
        Skip animations
      </label>
      <label>
        <input type="checkbox" checked={sound} onChange={(e) => settings.change({ sound: e.target.checked })} />
        Sound
      </label>
      <label>
        Volume
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(volume * 100)}
          disabled={!sound}
          onChange={(e) => settings.change({ volume: Number(e.target.value) / 100 })}
        />
      </label>
    </Dialog>
  );
}

/** The button that opens the settings panel, and the panel while it's open. */
export function SettingsButton({ settings }: { settings: DeviceSettings }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Settings
      </button>
      {open && <SettingsPanel settings={settings} onClose={() => setOpen(false)} />}
    </>
  );
}
