import { useCallback, useState } from "react";
import { useStore } from "zustand";
import { Countdown } from "./Countdown.js";
import type { Device } from "./device.js";
import type { GameLayer, ReplayFile } from "./game.js";
import { Lobby } from "./Lobby.js";
import type { DeviceSettings } from "./settings.js";
import { SettingsButton } from "./SettingsPanel.js";

/**
 * Whatever the Seat on screen should see: the lobby until the game starts,
 * then the game layer. The Pass-Device Step hides it all while the device
 * changes hands, and "Waiting for Host…" shows over it while the Host is away.
 * At game over, the Host can download the game's replay.
 */
export function SeatScreen({
  device,
  game,
  settings,
  onLeave,
  onGameOver,
  saveFile,
}: {
  device: Device;
  game: GameLayer;
  settings: DeviceSettings;
  onLeave: () => void;
  onGameOver: () => void;
  saveFile: (file: ReplayFile) => void;
}) {
  const { onScreen: seat, passTo } = useStore(device.store);
  const [gameIsOver, setGameIsOver] = useState(false);
  const markGameOver = useCallback(() => {
    setGameIsOver(true);
    onGameOver();
  }, [onGameOver]);
  const replayFile = gameIsOver ? device.replayFile : null;
  const { lobby, view, log, playing, responseOptions, deadline, error, hostAway } = useStore(seat.store);
  return (
    <>
      <header className="room-bar">
        <button type="button" onClick={onLeave}>
          Leave Room
        </button>
        {device.hosting && <p className="hosting-notice">Keep this tab open: you are hosting</p>}
        {replayFile && (
          <button
            type="button"
            onClick={() => {
              const file = replayFile();
              if (file) saveFile(file);
            }}
          >
            Download replay
          </button>
        )}
        <SettingsButton settings={settings} />
      </header>
      {hostAway && (
        <p role="status" className="host-away">
          Waiting for Host…
        </p>
      )}
      {passTo ? (
        <PassDeviceStep name={passTo.name} onConfirm={device.confirmPass} />
      ) : (
        <>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {/* A countdown can't wait for the animation: the Room's clock is already running. */}
          {playing && deadline !== null && (
            <p className="countdown-bar">
              Your time to respond: <Countdown deadline={deadline} />
            </p>
          )}
          {view ? (
            <game.Board
              view={view}
              log={log}
              playing={playing}
              responseOptions={playing ? null : seat.remote ? game.responseOptions(view) : responseOptions}
              deadline={playing ? null : deadline}
              act={seat.act}
              onGameOver={markGameOver}
            />
          ) : lobby ? (
            <Lobby
              seats={lobby}
              roomCode={device.roomCode}
              host={seat.host}
              Rules={game.Rules}
              onSetConfig={seat.setConfig}
              onAddPlayer={seat.addLocalSeat}
              onAddBot={seat.addBot}
              onStart={seat.startGame}
            />
          ) : (
            <p>Connecting…</p>
          )}
        </>
      )}
    </>
  );
}

function PassDeviceStep({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  return (
    <main className="pass-device">
      <h2>Pass the device to {name}</h2>
      <button type="button" onClick={onConfirm}>
        I'm {name}
      </button>
    </main>
  );
}
