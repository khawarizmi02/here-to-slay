import { useState, type FormEvent } from "react";

/** The first screen (TECHNICAL_DESIGN.md §12.3). Hosting and joining online aren't built yet. */
export function Home({ onPlayOnThisDevice }: { onPlayOnThisDevice: (name: string) => void }) {
  const [name, setName] = useState("Player 1");
  const trimmed = name.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (trimmed) onPlayOnThisDevice(trimmed);
  }

  return (
    <main className="home">
      <h1>Here to Slay</h1>
      <form onSubmit={submit}>
        <label>
          Your name
          <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={!trimmed}>
          Play on this device
        </button>
        <button type="button" disabled>
          Host online
        </button>
        <button type="button" disabled>
          Join with a Room Code
        </button>
      </form>
    </main>
  );
}
