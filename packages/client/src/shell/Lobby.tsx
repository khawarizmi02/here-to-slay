import type { LobbySeat } from "@here-to-slay/protocol";
import { useState, type ComponentType, type FormEvent } from "react";
import type { RulesProps } from "./game.js";

/**
 * The Seats so far, and, for the Host only, the controls: the game layer's
 * rules, adding Seats and starting. Only a Room friends can join shows its
 * Room Code: nobody can use an offline Room's.
 */
export function Lobby({
  seats,
  roomCode,
  host,
  cardSetLabel,
  Rules,
  onSetConfig,
  onAddPlayer,
  onAddBot,
  onStart,
}: {
  seats: LobbySeat[];
  roomCode: string | null;
  host: boolean;
  /** The game layer's name for the card set in play. */
  cardSetLabel: string;
  Rules: ComponentType<RulesProps>;
  onSetConfig: RulesProps["setConfig"];
  onAddPlayer: (name: string) => void;
  onAddBot: () => void;
  onStart: () => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();

  function addPlayer(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    onAddPlayer(trimmed);
    setName("");
  }

  return (
    <main className="lobby">
      <h2>Lobby</h2>
      <p className="card-set">{cardSetLabel}</p>
      {roomCode && (
        <p>
          Room Code <strong className="room-code">{roomCode}</strong>
        </p>
      )}
      <ul>
        {seats.map((s) => (
          <li key={s.id}>
            {s.name} <small>({s.kind})</small>
          </li>
        ))}
      </ul>
      {host && (
        <>
          <Rules setConfig={onSetConfig} />
          <form onSubmit={addPlayer}>
            <label>
              Player name
              <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="submit" disabled={!trimmed}>
              Add a player on this device
            </button>
          </form>
          <button type="button" onClick={onAddBot}>
            Add a bot
          </button>
          <button type="button" onClick={onStart}>
            Start game
          </button>
        </>
      )}
    </main>
  );
}
