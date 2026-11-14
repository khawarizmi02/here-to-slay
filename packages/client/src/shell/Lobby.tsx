import type { LobbySeat } from "@here-to-slay/protocol";
import { useState, type FormEvent } from "react";

/** The Seats so far, and the Host's controls. An offline Room shows no Room Code: nobody can use it. */
export function Lobby({
  seats,
  onAddPlayer,
  onAddBot,
  onStart,
}: {
  seats: LobbySeat[];
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
      <ul>
        {seats.map((s) => (
          <li key={s.id}>
            {s.name} <small>({s.kind})</small>
          </li>
        ))}
      </ul>
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
    </main>
  );
}
