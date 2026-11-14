import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserLauncher } from "./root/launcher.js";
import { App } from "./shell/App.js";
import { storagePointerStore } from "./shell/pointer.js";
import { toyGame } from "./toy/ToyGame.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App launcher={browserLauncher()} pointers={storagePointerStore(localStorage)} game={toyGame} />
  </StrictMode>,
);
