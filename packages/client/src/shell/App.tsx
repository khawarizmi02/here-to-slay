import { useEffect, useRef, useState } from "react";
import { connectDevice, type Device } from "./device.js";
import { RoomClosedError, type GameLayer, type LaunchedRoom, type Launcher } from "./game.js";
import { Home } from "./Home.js";
import type { PointerStore, RoomPointer } from "./pointer.js";
import { SeatScreen } from "./SeatScreen.js";
import type { DeviceSettings } from "./settings.js";
import type { SoundPlayer } from "./sound.js";

type Screen =
  | { kind: "home"; message?: string }
  | { kind: "resuming"; pointer: RoomPointer }
  | { kind: "connecting" }
  | { kind: "device"; device: Device };

const ROOM_CLOSED = "That Room has closed.";

/**
 * On load, a device with a Room pointer goes straight back into that Room,
 * with no prompt. Otherwise it starts on the first screen, where it also
 * lands, pointing nowhere, when its Room closes. An online Room it can't
 * reach stays pointed at, until a new Room replaces it.
 */
export function App({
  launcher,
  pointers,
  game,
  settings,
  sounds,
}: {
  launcher: Launcher;
  pointers: PointerStore;
  game: GameLayer;
  settings: DeviceSettings;
  sounds: SoundPlayer;
}) {
  const [screen, setScreen] = useState<Screen>(() => {
    const pointer = pointers.load();
    return pointer ? { kind: "resuming", pointer } : { kind: "home" };
  });
  const device = screen.kind === "device" ? screen.device : null;
  /** The Room has gone: nothing is left to resume. */
  const closed = () => {
    pointers.clear();
    setScreen({ kind: "home", message: ROOM_CLOSED });
  };
  useEffect(() => () => device?.close(), [device]);
  useEffect(
    () =>
      device?.store.subscribe(({ roomClosed }) => {
        if (roomClosed) closed();
      }),
    [device, pointers],
  );
  const enter = (room: LaunchedRoom) => setScreen({ kind: "device", device: connectDevice(room, game, settings, sounds) });

  // Resuming builds a Room, so it must happen once: StrictMode runs effects twice, but keeps refs.
  const resumeStarted = useRef(false);
  useEffect(() => {
    if (screen.kind !== "resuming" || resumeStarted.current) return;
    resumeStarted.current = true;
    const { pointer } = screen;
    launcher.resume(pointer).then(enter, (e: unknown) => {
      if (e instanceof RoomClosedError) {
        closed();
        return;
      }
      console.error("Couldn't resume the game", e);
      if (pointer.mode === "online") {
        // Most likely the relay can't be reached: the Room may well still be there, so a later load tries again.
        setScreen({ kind: "home", message: "Couldn't reach your Room. Reload to try again." });
        return;
      }
      pointers.clear();
      setScreen({ kind: "home", message: "Your game couldn't be resumed." });
    });
  }, [screen, launcher, pointers]);

  function playOnThisDevice(name: string) {
    const launched = launcher.playOnThisDevice(name);
    pointers.save({ mode: "offline", role: "host", roomCode: launched.roomCode, name });
    enter(launched);
  }

  /** Opens a Room through the relay, pointing at it once it's open, or lands back on the first screen with the reason. */
  function goOnline(role: RoomPointer["role"], name: string, open: Promise<LaunchedRoom>) {
    setScreen({ kind: "connecting" });
    open.then(
      (launched) => {
        pointers.save({ mode: "online", role, roomCode: launched.roomCode, name, ...(launched.online && { token: launched.online.token }) });
        enter(launched);
      },
      (e: unknown) => setScreen({ kind: "home", message: e instanceof Error ? e.message : String(e) }),
    );
  }

  function leave() {
    pointers.clear();
    setScreen({ kind: "home" });
  }

  switch (screen.kind) {
    case "home":
      return (
        <Home
          message={screen.message}
          RulesReference={game.RulesReference}
          settings={settings}
          onPlayOnThisDevice={playOnThisDevice}
          onHostOnline={(name) => goOnline("host", name, launcher.hostOnline(name))}
          onJoin={(roomCode, name) => goOnline("friend", name, launcher.join(roomCode, name))}
        />
      );
    case "resuming":
      return <p>Resuming your game…</p>;
    case "connecting":
      return <p>Connecting to the relay…</p>;
    case "device":
      return <SeatScreen device={screen.device} game={game} settings={settings} onLeave={leave} onGameOver={pointers.clear} />;
  }
}
