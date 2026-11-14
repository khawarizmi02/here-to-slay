import { useStore } from "zustand";
import type { GameComponent } from "./game.js";
import { Lobby } from "./Lobby.js";
import type { DeviceSeat } from "./seat.js";

/** Whatever the Seat on screen should see: the lobby until the game starts, then the game layer. */
export function SeatScreen({
  seat,
  Game,
  onLeave,
  onGameOver,
}: {
  seat: DeviceSeat;
  Game: GameComponent;
  onLeave: () => void;
  onGameOver: () => void;
}) {
  const { lobby, view, responseOptions, error } = useStore(seat.store);
  return (
    <>
      <header className="room-bar">
        <button type="button" onClick={onLeave}>
          Leave Room
        </button>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {view ? (
        <Game view={view} responseOptions={responseOptions} act={seat.act} onGameOver={onGameOver} />
      ) : lobby ? (
        <Lobby seats={lobby} onAddBot={seat.addBot} onStart={seat.startGame} />
      ) : (
        <p>Connecting…</p>
      )}
    </>
  );
}
