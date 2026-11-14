import { useStore } from "zustand";
import type { Device } from "./device.js";
import type { GameLayer } from "./game.js";
import { Lobby } from "./Lobby.js";

/**
 * Whatever the Seat on screen should see: the lobby until the game starts,
 * then the game layer. The Pass-Device Step hides it all while the device
 * changes hands.
 */
export function SeatScreen({
  device,
  game,
  onLeave,
  onGameOver,
}: {
  device: Device;
  game: GameLayer;
  onLeave: () => void;
  onGameOver: () => void;
}) {
  const { onScreen: seat, passTo } = useStore(device.store);
  const { lobby, view, log, responseOptions, error } = useStore(seat.store);
  return (
    <>
      <header className="room-bar">
        <button type="button" onClick={onLeave}>
          Leave Room
        </button>
      </header>
      {passTo ? (
        <PassDeviceStep name={passTo.name} onConfirm={device.confirmPass} />
      ) : (
        <>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {view ? (
            <game.Board view={view} log={log} responseOptions={responseOptions} act={seat.act} onGameOver={onGameOver} />
          ) : lobby ? (
            <Lobby
              seats={lobby}
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
