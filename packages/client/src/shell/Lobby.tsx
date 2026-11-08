import type { LobbySeat } from "@here-to-slay/protocol";

/** The Seats so far, and the Host's controls. An offline Room shows no Room Code: nobody can use it. */
export function Lobby({ seats, onAddBot, onStart }: { seats: LobbySeat[]; onAddBot: () => void; onStart: () => void }) {
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
      <button type="button" onClick={onAddBot}>
        Add a bot
      </button>
      <button type="button" onClick={onStart}>
        Start game
      </button>
    </main>
  );
}
