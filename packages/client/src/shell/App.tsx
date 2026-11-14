import { useEffect, useRef, useState } from "react";
import type { GameComponent, Launcher } from "./game.js";
import { Home } from "./Home.js";
import type { PointerStore, RoomPointer } from "./pointer.js";
import { SeatScreen } from "./SeatScreen.js";
import { connectSeat, type DeviceSeat } from "./seat.js";

type Screen = { kind: "home"; message?: string } | { kind: "resuming"; pointer: RoomPointer } | { kind: "seat"; seat: DeviceSeat };

/**
 * On load, a device with a Room pointer goes straight back into that Room,
 * with no prompt. Otherwise it starts on the first screen.
 */
export function App({ launcher, pointers, Game }: { launcher: Launcher; pointers: PointerStore; Game: GameComponent }) {
  const [screen, setScreen] = useState<Screen>(() => {
    const pointer = pointers.load();
    return pointer ? { kind: "resuming", pointer } : { kind: "home" };
  });
  const seat = screen.kind === "seat" ? screen.seat : null;
  useEffect(() => () => seat?.close(), [seat]);

  // Resuming builds a Room, so it must happen once: StrictMode runs effects twice, but keeps refs.
  const resumeStarted = useRef(false);
  useEffect(() => {
    if (screen.kind !== "resuming" || resumeStarted.current) return;
    resumeStarted.current = true;
    launcher.resume(screen.pointer).then(
      (launched) => setScreen({ kind: "seat", seat: connectSeat(launched.connection, { soleLocalSeat: true, seatId: launched.seatId }) }),
      (e: unknown) => {
        console.error("Couldn't resume the game", e);
        pointers.clear();
        setScreen({ kind: "home", message: "Your game couldn't be resumed." });
      },
    );
  }, [screen, launcher, pointers]);

  function playOnThisDevice(name: string) {
    const launched = launcher.playOnThisDevice(name);
    pointers.save({ mode: "offline", role: "host", roomCode: launched.roomCode, name });
    // The device has one local Seat until Hot-Seat with several is built.
    setScreen({ kind: "seat", seat: connectSeat(launched.connection, { soleLocalSeat: true }) });
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
    case "seat":
      return <SeatScreen seat={screen.seat} Game={Game} onLeave={leave} onGameOver={pointers.clear} />;
  }
}
