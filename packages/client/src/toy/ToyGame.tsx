import { useEffect, useState } from "react";
import { DEFAULT_TOY_CONFIG, WISH_OPTIONS, type Action, type GameEvent, type PlayerView, type ToyCard, type ToyCardDefId, type ToyConfig, type ToyPendingDecision } from "@here-to-slay/toy-engine";
import type { GameLayer, GameProps, RulesProps } from "../shell/game.js";

const CARD_NAMES: Record<ToyCardDefId, string> = {
  point_1: "1 Point",
  point_2: "2 Points",
  point_3: "3 Points",
  wish: "Wish",
  challenge: "Challenge",
  modifier: "Modifier +1",
};

/** The toy engine's layer: its board, and whom it waits on. */
export const toyGame: GameLayer = {
  Board: ToyGame,
  Rules: ToyRules,
  seatToAct(payload) {
    const view = payload as unknown as PlayerView;
    if (view.phase === "decision") return view.pendingDecision?.player ?? null;
    return view.phase === "action" ? view.activePlayer : null;
  },
};

/**
 * The toy engine's board: the only code that reads the toy PlayerView. Turn
 * actions and decisions come from `view.legalActions`; response options
 * only from the Room's `respond`. It holds no game rules.
 */
export function ToyGame({ view: payload, log, responseOptions, act, onGameOver }: GameProps) {
  const view = payload as unknown as PlayerView;
  const events = log as unknown as GameEvent[];
  const nameOf = (id: string) => nameIn(view, id);
  const winner = view.winner;
  useEffect(() => {
    if (winner !== null) onGameOver();
  }, [winner, onGameOver]);

  if (winner !== null) {
    return (
      <main className="game-over">
        <h2>{nameOf(winner)} wins!</h2>
        <Scores view={view} />
        <GameLog view={view} events={events} />
      </main>
    );
  }

  const draw = view.legalActions.find((a) => a.type === "DRAW_CARD");
  const playFor = (card: ToyCard) => view.legalActions.find((a) => a.type === "PLAY_HERO" && a.card === card.id);
  const decision = view.pendingDecision;

  return (
    <main className="board">
      <p>
        Turn {view.turn}: {view.activePlayer === view.me ? "your turn" : `${nameOf(view.activePlayer)}'s turn`} · Deck {view.deckCount}
      </p>
      <Scores view={view} />

      {view.responseWindow && (
        <p>
          {nameOf(view.responseWindow.player)} played {CARD_NAMES[view.responseWindow.card.def]}
          {view.responseWindow.bonus > 0 && ` (+${view.responseWindow.bonus})`}
        </p>
      )}

      {responseOptions && (
        <section aria-label="Respond" className="response-bar">
          {responseOptions.map((action) => (
            <button key={JSON.stringify(action)} type="button" onClick={() => act(action)}>
              {responseLabel(action, view.hand)}
            </button>
          ))}
        </section>
      )}

      {decision && "options" in decision ? (
        <DecisionModal decision={decision} legal={view.legalActions} act={act} />
      ) : (
        decision && <p>Waiting for {nameOf(decision.player)} to choose…</p>
      )}

      <button type="button" disabled={!draw} onClick={() => draw && act(draw)}>
        Draw a card
      </button>

      <section aria-label="Your hand" className="hand">
        {view.hand.map((card) => {
          const play = playFor(card);
          return (
            <button key={card.id} type="button" disabled={!play} onClick={() => play && act(play)}>
              {CARD_NAMES[card.def]}
            </button>
          );
        })}
      </section>

      <GameLog view={view} events={events} />
    </main>
  );
}

/** What happened, one line per event, in the words of the Seat reading it. */
function GameLog({ view, events }: { view: PlayerView; events: GameEvent[] }) {
  const lines = events.map((e) => logLine(e, view)).filter((line) => line !== null);
  return (
    <details className="game-log">
      <summary>Game log</summary>
      <ol aria-label="Game log">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </details>
  );
}

/** The log line for `event`, or null for one the board already shows (a window or decision opening). */
function logLine(event: GameEvent, view: PlayerView): string | null {
  const who = (id: string) => (id === view.me ? "You" : nameIn(view, id));
  const whose = (id: string) => (id === view.me ? "your" : `${who(id)}'s`);
  switch (event.type) {
    case "TURN_STARTED":
      return `Turn ${event.turn}: ${whose(event.player)} turn`;
    case "CARD_DRAWN":
      // The engine leaves the card out of every copy but the drawer's.
      return event.card ? `${who(event.player)} drew ${CARD_NAMES[event.card.def]}` : `${who(event.player)} drew a card`;
    case "CARD_PLAYED":
      return `${who(event.player)} played ${CARD_NAMES[event.card.def]}`;
    case "PASSED":
      return `${who(event.player)} passed`;
    case "CHALLENGED":
      return `${who(event.player)} challenged the ${CARD_NAMES[event.target.def]}`;
    case "MODIFIED":
      return `${who(event.player)} played Modifier +1 on the ${CARD_NAMES[event.target.def]}`;
    case "POINTS_SCORED":
      return `${who(event.player)} scored ${event.points} ${event.points === 1 ? "point" : "points"} (${event.total} in all)`;
    case "DECISION_RESOLVED":
      return `${who(event.player)} chose ${event.selected.map((id) => WISH_OPTIONS.find((o) => o.id === id)?.label ?? id).join(", ")}`;
    case "GAME_OVER":
      return `${who(event.winner)} won`;
    case "RESPONSE_WINDOW_OPENED":
    case "DECISION_OPENED":
      return null;
  }
}

function nameIn(view: PlayerView, id: string): string {
  return view.players.find((p) => p.id === id)?.name ?? id;
}

function Scores({ view }: { view: PlayerView }) {
  return (
    <table className="scores">
      <tbody>
        {view.players.map((p) => (
          <tr key={p.id}>
            <th scope="row">{p.name}</th>
            <td>{p.score} points</td>
            <td>{p.handCount} cards</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DecisionModal({ decision, legal, act }: { decision: ToyPendingDecision; legal: Action[]; act: (a: Action) => void }) {
  return (
    <div role="dialog" aria-label={decision.prompt} className="decision">
      <h3>{decision.prompt}</h3>
      {decision.options.map((option) => {
        const answer = legal.find((a) => a.type === "RESOLVE_DECISION" && a.answer.selected[0] === option.id);
        return (
          <button key={option.id} type="button" disabled={!answer} onClick={() => answer && act(answer)}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function responseLabel(action: Action, hand: ToyCard[]): string {
  if (action.type === "PASS") return "Pass";
  if ("card" in action) {
    const card = hand.find((c) => c.id === action.card);
    return `Play ${card ? CARD_NAMES[card.def] : action.card}`;
  }
  return action.type;
}

/**
 * The toy's rules: the score that wins and the cards dealt to each player.
 * The Room doesn't echo the config back, so the form keeps what it sent.
 * It sends only whole numbers of 1 or more, which the toy engine accepts.
 */
function ToyRules({ setConfig }: RulesProps) {
  return (
    <fieldset className="rules">
      <legend>Rules</legend>
      <RuleInput label="Target score" rule="targetScore" setConfig={setConfig} />
      <RuleInput label="Hand size" rule="handSize" setConfig={setConfig} />
    </fieldset>
  );
}

function RuleInput({ label, rule, setConfig }: { label: string; rule: keyof ToyConfig } & RulesProps) {
  const [value, setValue] = useState(String(DEFAULT_TOY_CONFIG[rule]));
  return (
    <label>
      {label}
      <input
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isInteger(n) && n >= 1) setConfig({ [rule]: n });
        }}
      />
    </label>
  );
}
