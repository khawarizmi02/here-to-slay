import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserLauncher } from "./root/launcher.js";
import { App } from "./shell/App.js";
import { ToyGame } from "./toy/ToyGame.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App launcher={browserLauncher()} Game={ToyGame} />
  </StrictMode>,
);
