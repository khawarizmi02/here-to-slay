import { useEffect, useState } from "react";
import type { GameComponent, Launcher } from "./game.js";
import { Home } from "./Home.js";
import { SeatScreen } from "./SeatScreen.js";
import { connectSeat, type DeviceSeat } from "./seat.js";

export function App({ launcher, Game }: { launcher: Launcher; Game: GameComponent }) {
  const [seat, setSeat] = useState<DeviceSeat | null>(null);
  useEffect(() => () => seat?.close(), [seat]);

  if (!seat) {
    // The device has one local Seat until Hot-Seat with several is built.
    return <Home onPlayOnThisDevice={(name) => setSeat(connectSeat(launcher.playOnThisDevice(name), { soleLocalSeat: true }))} />;
  }
  return <SeatScreen seat={seat} Game={Game} />;
}
