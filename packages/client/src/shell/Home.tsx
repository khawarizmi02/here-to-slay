import { useState, type ComponentType, type FormEvent } from "react";

/**
 * The first screen (TECHNICAL_DESIGN.md §12.3): play here, host a Room
 * friends join through the relay, or join one with its Room Code. The
 * game layer's rules reference opens over it.
 */
export function Home({
  message,
  RulesReference,
  onPlayOnThisDevice,
  onHostOnline,
  onJoin,
}: {
  message?: string | undefined;
  RulesReference: ComponentType<{ onClose(): void }>;
  onPlayOnThisDevice: (name: string) => void;
  onHostOnline: (name: string) => void;
  /** `roomCode` as the player typed it: the launcher forgives case and stray spaces. */
  onJoin: (roomCode: string, name: string) => void;
}) {
  const [name, setName] = useState("Player 1");
  const [roomCode, setRoomCode] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const trimmed = name.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (trimmed) onPlayOnThisDevice(trimmed);
  }

  function join(e: FormEvent) {
    e.preventDefault();
    if (trimmed && roomCode.trim()) onJoin(roomCode, trimmed);
  }

  return (
    <main className="home">
      <h1>Here to Slay</h1>
      {message && (
        <p role="alert" className="error">
          {message}
        </p>
      )}
      <form onSubmit={submit}>
        <label>
          Your name
          <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={!trimmed}>
          Play on this device
        </button>
        <button type="button" disabled={!trimmed} onClick={() => onHostOnline(trimmed)}>
          Host online
        </button>
      </form>
      <form onSubmit={join}>
        <label>
          Room Code
          <input value={roomCode} maxLength={16} autoCapitalize="characters" onChange={(e) => setRoomCode(e.target.value)} />
        </label>
        <button type="submit" disabled={!trimmed || !roomCode.trim()}>
          Join with a Room Code
        </button>
      </form>
      <button type="button" onClick={() => setRulesOpen(true)}>
        Rules
      </button>
      {rulesOpen && <RulesReference onClose={() => setRulesOpen(false)} />}
    </main>
  );
}
