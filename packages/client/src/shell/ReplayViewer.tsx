import type { SeatId } from "@here-to-slay/protocol";
import type { Replay } from "@here-to-slay/room";
import { useMemo, useState } from "react";
import type { GameLayer } from "./game.js";

/** A replay shows the board as it was: nothing on it can be played. */
const ignore = () => {};

/**
 * Plays back a replay file one action at a time (TECHNICAL_DESIGN.md §8.3),
 * forward and back, or straight to the start or the end. It shows a
 * spectator's view unless the player picks one player's.
 */
export function ReplayViewer({ replay, game, onClose }: { replay: Replay; game: Pick<GameLayer, "Board">; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [viewer, setViewer] = useState<SeatId | null>(null);
  const view = useMemo(() => replay.viewAt(step, viewer), [replay, step, viewer]);
  const log = useMemo(() => replay.logAt(step, viewer), [replay, step, viewer]);
  const atStart = step === 0;
  const atEnd = step === replay.length;

  return (
    <>
      <header className="room-bar replay-bar">
        <button type="button" onClick={onClose}>
          Close replay
        </button>
        <div role="group" aria-label="Replay controls" className="replay-controls">
          <button type="button" disabled={atStart} onClick={() => setStep(0)}>
            Start
          </button>
          <button type="button" disabled={atStart} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </button>
          <button type="button" disabled={atEnd} onClick={() => setStep((s) => Math.min(replay.length, s + 1))}>
            Forward
          </button>
          <button type="button" disabled={atEnd} onClick={() => setStep(replay.length)}>
            End
          </button>
        </div>
        <p aria-live="polite">
          Step {step} of {replay.length}
        </p>
        <label>
          View as
          <select value={viewer ?? ""} onChange={(e) => setViewer(e.target.value === "" ? null : e.target.value)}>
            <option value="">Spectator</option>
            {replay.players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      <game.Board view={view} log={log} playing={null} responseOptions={null} deadline={null} act={ignore} onGameOver={ignore} />
    </>
  );
}
