import type { Action, PlayerView, ToyCard, ToyCardDefId, ToyPendingDecision } from "@here-to-slay/toy-engine";
import type { GameProps } from "../shell/game.js";

const CARD_NAMES: Record<ToyCardDefId, string> = {
  point_1: "1 Point",
  point_2: "2 Points",
  point_3: "3 Points",
  wish: "Wish",
  challenge: "Challenge",
  modifier: "Modifier +1",
};

/**
 * The toy engine's board: the only code that reads the toy PlayerView. Turn
 * actions and decisions come from `view.legalActions`; response options
 * only from the Room's `respond`. It holds no game rules.
 */
export function ToyGame({ view: payload, responseOptions, act }: GameProps) {
  const view = payload as unknown as PlayerView;
  const nameOf = (id: string) => view.players.find((p) => p.id === id)?.name ?? id;
  const winner = view.winner;

  if (winner !== null) {
    return (
      <main className="game-over">
        <h2>{nameOf(winner)} wins!</h2>
        <Scores view={view} />
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
    </main>
  );
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
