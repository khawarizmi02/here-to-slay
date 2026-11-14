import type { LobbySeat } from "@here-to-slay/protocol";
import { useState, type ComponentType, type FormEvent } from "react";
import type { RulesProps } from "./game.js";

/**
 * The Seats so far, and, for the Host only, the controls: the game layer's
 * rules, adding Seats and starting. An offline Room shows no Room Code:
 * nobody can use it.
 */
export function Lobby({
  seats,
  host,
  Rules,
  onSetConfig,
  onAddPlayer,
  onAddBot,
  onStart,
}: {
  seats: LobbySeat[];
  host: boolean;
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
