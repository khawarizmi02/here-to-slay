import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserLauncher } from "./root/launcher.js";
import { roomRandom } from "./root/seed.js";
import { App } from "./shell/App.js";
import { storagePointerStore } from "./shell/pointer.js";
import { deviceSettings } from "./shell/settings.js";
import { webAudioPlayer } from "./shell/sound.js";
import { realGame } from "./board/layer.js";
import "./styles.css";

/** Set at build time (TECHNICAL_DESIGN.md §10.8). Only a dev server falls back to `wrangler dev`'s address. */
function relayUrl(): string {
  const url = import.meta.env.VITE_RELAY_URL ?? (import.meta.env.DEV ? "http://localhost:8787" : undefined);
  if (url === undefined) throw new Error("This build has no relay: set VITE_RELAY_URL when building");
  return url;
}

/** Only the end-to-end runs' build (`vite --mode e2e`) reads a seed from the URL. */
const random = roomRandom(location.search, { seedable: import.meta.env.MODE === "e2e" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App launcher={browserLauncher(relayUrl(), random)} pointers={storagePointerStore(localStorage)} game={realGame} settings={deviceSettings(localStorage)} sounds={webAudioPlayer()} />
  </StrictMode>,
);
