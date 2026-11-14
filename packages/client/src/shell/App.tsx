import { useEffect, useRef, useState } from "react";
import { connectDevice, type Device } from "./device.js";
import type { GameLayer, LaunchedRoom, Launcher } from "./game.js";
import { Home } from "./Home.js";
import type { PointerStore, RoomPointer } from "./pointer.js";
import { SeatScreen } from "./SeatScreen.js";

type Screen = { kind: "home"; message?: string } | { kind: "resuming"; pointer: RoomPointer } | { kind: "device"; device: Device };

/**
 * On load, a device with a Room pointer goes straight back into that Room,
 * with no prompt. Otherwise it starts on the first screen.
 */
export function App({ launcher, pointers, game }: { launcher: Launcher; pointers: PointerStore; game: GameLayer }) {
  const [screen, setScreen] = useState<Screen>(() => {
    const pointer = pointers.load();
    return pointer ? { kind: "resuming", pointer } : { kind: "home" };
  });
  const device = screen.kind === "device" ? screen.device : null;
  useEffect(() => () => device?.close(), [device]);
  const enter = (room: LaunchedRoom) => setScreen({ kind: "device", device: connectDevice(room, game.seatToAct) });

  // Resuming builds a Room, so it must happen once: StrictMode runs effects twice, but keeps refs.
  const resumeStarted = useRef(false);
  useEffect(() => {
    if (screen.kind !== "resuming" || resumeStarted.current) return;
    resumeStarted.current = true;
    launcher.resume(screen.pointer).then(enter, (e: unknown) => {
      console.error("Couldn't resume the game", e);
      pointers.clear();
      setScreen({ kind: "home", message: "Your game couldn't be resumed." });
    });
  }, [screen, launcher, pointers]);

  function playOnThisDevice(name: string) {
    const launched = launcher.playOnThisDevice(name);
    pointers.save({ mode: "offline", role: "host", roomCode: launched.roomCode, name });
    enter(launched);
  }

  function leave() {
    pointers.clear();
    setScreen({ kind: "home" });
  }

  switch (screen.kind) {
    case "home":
      return <Home message={screen.message} onPlayOnThisDevice={playOnThisDevice} />;
    case "resuming":
      return <p>Resuming your game…</p>;
    case "device":
      return <SeatScreen device={screen.device} game={game} onLeave={leave} onGameOver={pointers.clear} />;
  }
}
