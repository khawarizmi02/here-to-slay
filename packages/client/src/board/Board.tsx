import type { Action, BlockedAction, CardView as Card, GameEvent, PendingDecision, PlayerView } from "@here-to-slay/engine";
import { motion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { Countdown } from "../shell/Countdown.js";
import type { GameProps } from "../shell/game.js";
import { cardDef, cardName, cardSubtitle } from "./cards.js";
import { logLine, nameIn } from "./log.js";
import { ZoomProvider, useZoomable } from "./zoom.js";

type Player = PlayerView["players"][number];

/** The card, monster or hero an action is about: what a blocked action calls its `subject`. */
export function subjectOf(action: Action): string | undefined {
  if ("card" in action) return action.card;
  if ("monster" in action) return action.monster;
  if ("hero" in action) return action.hero;
  return undefined;
}

/** What one control can do now: the legal actions behind it, or why it can't be used. */
interface Control {
  actions: Action[];
  /** Why it is disabled, when the engine says (§12.2, ADR-0004); null when it is enabled or nobody's reason applies. */
  reason: string | null;
}

/**
 * The rules engine's board (TECHNICAL_DESIGN.md §12): the only code that
 * reads the real PlayerView. Turn actions and decisions come from
 * `legalActions`, the reasons on disabled controls from `blockedActions`,
 * and response options from the shell. It holds no game rules.
 */
export function Board({ view: payload, log, playing, responseOptions, deadline, act, onGameOver }: GameProps) {
  const view = payload as unknown as PlayerView;
  const events = log as unknown as GameEvent[];
  // While an event plays the view is out of date: what it offers may no longer be legal.
  const legal = playing ? [] : view.legalActions;
  const blocked = playing ? [] : view.blockedActions;
  const myTurn = view.me === view.activePlayer;
  const turnIdle = view.phase.kind === "action" && view.pendingDecision === null && view.responseWindow === null;
  const control = (type: Action["type"], subject?: string): Control => {
    const actions = legal.filter((a) => a.type === type && subjectOf(a) === subject);
    if (actions.length > 0) return { actions, reason: null };
    const why = blocked.find((b: BlockedAction) => b.type === type && b.subject === subject);
    return { actions, reason: why?.reason ?? null };
  };
  // Only the action bar says so: on every card it would be noise.
  const notYourTurn = !playing && turnIdle && !myTurn && view.me !== "spectator";

  const winner = view.winner;
  useEffect(() => {
    if (winner !== null) onGameOver();
  }, [winner, onGameOver]);

  if (winner !== null) return <GameOverScreen view={view} events={events} />;

  const me = view.players.find((p) => p.id === view.me);
  const opponents = view.players.filter((p) => p.id !== view.me);

  return (
    <ZoomProvider>
      <main className="board">
        <p className="turn-line">
          Turn {view.turnNumber}: {myTurn ? "your turn" : `${nameIn(view, view.activePlayer)}'s turn`}
        </p>

        <section aria-label="Opponents" className="opponents">
          {opponents.map((p) => (
            <OpponentArea key={p.id} player={p} active={p.id === view.activePlayer} />
          ))}
        </section>

        <section aria-label="Centre" className="centre">
          <MonsterRow view={view} control={control} act={act} />
          <div className="piles">
            <DeckPile view={view} />
            <DiscardPile view={view} />
            <DiceTray view={view} />
          </div>
        </section>

        {playing && (
          <section aria-label="Now playing" className="now-playing">
            {/* Keyed by the event's place in the log, so each one plays its own highlight. */}
            <motion.p key={events.length} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
              {logLine(playing as unknown as GameEvent, view) ?? " "}
            </motion.p>
          </section>
        )}

        <ResponseBar view={view} responseOptions={responseOptions} deadline={deadline} act={act} />

        {view.pendingDecision && "options" in view.pendingDecision ? (
          <DecisionModal view={view} decision={view.pendingDecision} legal={legal} deadline={deadline} act={act} />
        ) : (
          view.pendingDecision && <p>Waiting for {nameIn(view, view.pendingDecision.player)} to choose…</p>
        )}

        {me && (
          <section aria-label="Your area" className="player-area">
            <Party player={me} control={control} act={act} />
            <ActionBar view={view} control={control} act={act} notYourTurn={notYourTurn} />
            <Hand view={view} control={control} act={act} />
          </section>
        )}

        <GameLog view={view} events={events} />
      </main>
    </ZoomProvider>
  );
}

type ControlFn = (type: Action["type"], subject?: string) => Control;

/** A single card, drawn with HTML and CSS (§12.4). Hover, focus or a long press zooms it to be read. */
export function CardView({ card, children, className }: { card: Card; children?: ReactNode; className?: string }) {
  const def = cardDef(card);
  const zoomable = useZoomable(card);
  return (
    <div {...zoomable} className={`card card-${def?.type ?? "unknown"}${className ? ` ${className}` : ""}`} data-card={card.id}>
      <strong className="card-name">{cardName(card)}</strong>
      {def && <span className="card-subtitle">{cardSubtitle(def)}</span>}
      {def?.text && <span className="card-text">{def.text}</span>}
      {children}
    </div>
  );
}

/** A card shown by name alone, as an equipped item or a slain monster: it zooms like a whole card. */
function CardChip({ card }: { card: Card }) {
  const zoomable = useZoomable(card);
  return (
    <span {...zoomable} className="card-chip" data-card={card.id}>
      {cardName(card)}
    </span>
  );
}

/** A player's slain monsters, each zoomable. */
function SlainPile({ monsters }: { monsters: Card[] }) {
  if (monsters.length === 0) return null;
  return (
    <p className="slain">
      Slain:{" "}
      {monsters.map((m, i) => (
        <span key={m.id}>
          {i > 0 && ", "}
          <CardChip card={m} />
        </span>
      ))}
    </p>
  );
}

/** A button for a control: enabled with a legal action, or disabled with its reason shown and as a tooltip. */
function ControlButton({ label, control, onPick, children }: { label: string; control: Control; onPick(actions: Action[]): void; children?: ReactNode }) {
  const enabled = control.actions.length > 0;
  return (
    <span className="control">
      <button type="button" aria-label={label} disabled={!enabled} title={control.reason ?? undefined} onClick={() => enabled && onPick(control.actions)}>
        {children ?? label}
      </button>
      {control.reason && (
        <span className="reason" aria-hidden="true">
          {control.reason}
        </span>
      )}
    </span>
  );
}

function OpponentArea({ player, active }: { player: Player; active: boolean }) {
  return (
    <article aria-label={player.name} className={`opponent${active ? " active" : ""}`}>
      <h3>
        {player.name}
        {player.isBot && " (bot)"}
      </h3>
      <p>
        {player.handCount} {player.handCount === 1 ? "card" : "cards"} in hand · {player.slainMonsters.length} slain
      </p>
      <div className="party">
        {player.leader && <CardView card={player.leader} className="leader" />}
        {player.party.map((h) => (
          <CardView key={h.hero.id} card={h.hero}>
            {h.item && (
              <span className="equipped">
                + <CardChip card={h.item} />
              </span>
            )}
          </CardView>
        ))}
      </div>
    </article>
  );
}

function MonsterRow({ view, control, act }: { view: PlayerView; control: ControlFn; act(a: Action): void }) {
  return (
    <section aria-label="Monsters" className="monsters">
      {view.activeMonsters.map((m) => (
        <CardView key={m.id} card={m}>
          <ControlButton label={`Attack ${cardName(m)}`} control={control("ATTACK_MONSTER", m.id)} onPick={([a]) => act(a!)}>
            Attack
          </ControlButton>
        </CardView>
      ))}
    </section>
  );
}

function DeckPile({ view }: { view: PlayerView }) {
  return (
    <div className="pile deck" aria-label="Decks">
      <span>Deck ({view.mainDeckCount})</span>
      <span>Monster deck ({view.monsterDeckCount})</span>
    </div>
  );
}

function DiscardPile({ view }: { view: PlayerView }) {
  const top = view.discardPile.at(-1);
  return (
    <section aria-label="Discard" className="pile discard">
      {top && <CardView card={top} />}
      <details>
        <summary>Discard pile ({view.discardPile.length})</summary>
        {top ? (
          <ol aria-label="Discard pile">
            {[...view.discardPile].reverse().map((c) => (
              <li key={c.id}>{cardName(c)}</li>
            ))}
          </ol>
        ) : (
          <p>Empty</p>
        )}
      </details>
    </section>
  );
}

/**
 * The rolls a Modifier Window is open on, with their totals so far. Read
 * from the view alone, so a refresh shows the same: the dice themselves
 * play in "Now playing" and stay in the game log.
 */
function DiceTray({ view }: { view: PlayerView }) {
  if (view.responseWindow?.kind !== "modifier") return null;
  return (
    <div role="group" aria-label="Dice" className="dice-tray">
      {view.responseWindow.rolls.map((r) => (
        <span key={r.roll}>
          {nameIn(view, r.player)}'s roll: <span className="die">{r.total}</span>
        </span>
      ))}
    </div>
  );
}

/** The open Response Window, the Seat's options in it when asked, and "Waiting for responses…" when not. */
function ResponseBar({
  view,
  responseOptions,
  deadline,
  act,
}: {
  view: PlayerView;
  responseOptions: Action[] | null;
  deadline: number | null;
  act(a: Action): void;
}) {
  const window = view.responseWindow;
  const handCard = (id: string) => view.hand.find((c) => c.id === id);
  return (
    <>
      {window?.kind === "challenge" && <p className="window">A Challenge Window is open on {cardName(window.card)}</p>}
      {window?.kind === "modifier" && (
        <p className="window">A Modifier Window is open on {window.rolls.map((r) => `${nameIn(view, r.player)}'s roll (${r.total})`).join(" and ")}</p>
      )}
      {/* Names nobody: who is still awaited would hint at who holds a usable card. */}
      {window && view.me !== "spectator" && !window.awaiting.includes(view.me) && (
        <p role="status" className="waiting-responses">
          Waiting for responses…
        </p>
      )}
      {responseOptions && (
        <section aria-label="Respond" className="response-bar">
          {responseOptions.map((action) => (
            <button key={JSON.stringify(action)} type="button" onClick={() => act(action)}>
              {responseLabel(action, view, handCard)}
            </button>
          ))}
          {deadline !== null && <Countdown deadline={deadline} />}
        </section>
      )}
    </>
  );
}

function responseLabel(action: Action, view: PlayerView, handCard: (id: string) => Card | undefined): string {
  if (action.type === "PASS") return "Pass";
  if (action.type === "PLAY_CHALLENGE") return `Play ${cardName(handCard(action.card) ?? action.card)}`;
  if (action.type === "PLAY_MODIFIER") {
    const name = cardName(handCard(action.card) ?? action.card);
    const value = action.value > 0 ? `+${action.value}` : String(action.value);
    const rolls = view.responseWindow?.kind === "modifier" ? view.responseWindow.rolls : [];
    const roll = rolls.length > 1 ? rolls.find((r) => r.roll === action.roll) : undefined;
    return `Play ${name} (${value})${roll ? ` on ${nameIn(view, roll.player)}'s roll` : ""}`;
  }
  return action.type;
}

function DecisionModal({
  view,
  decision,
  legal,
  deadline,
  act,
}: {
  view: PlayerView;
  decision: PendingDecision;
  legal: Action[];
  deadline: number | null;
  act(a: Action): void;
}) {
  return (
    <div role="dialog" aria-label={decision.prompt} className="decision">
      <h3>{decision.prompt}</h3>
      {decision.options.map((option) => {
        const answer = legal.find((a) => a.type === "RESOLVE_DECISION" && a.answer.selected[0] === option.id);
        return (
          <button key={option.id} type="button" disabled={!answer} onClick={() => answer && act(answer)}>
            {optionLabel(view, option)}
          </button>
        );
      })}
      {deadline !== null && <Countdown deadline={deadline} />}
    </div>
  );
}

function optionLabel(view: PlayerView, option: PendingDecision["options"][number]): string {
  if (option.label) return option.label;
  if (option.def) {
    const name = cardName(option.def);
    const owner = view.players.find((p) => p.party.some((h) => h.hero.id === option.id));
    return owner && owner.id !== view.me ? `${name} (${owner.name})` : name;
  }
  return nameIn(view, option.id);
}

function Party({ player, control, act }: { player: Player; control: ControlFn; act(a: Action): void }) {
  return (
    <section aria-label="Your party" className="party">
      {player.leader && <CardView card={player.leader} className="leader" />}
      {player.party.map((h) => (
        <CardView key={h.hero.id} card={h.hero} {...(h.rolledThisTurn ? { className: "rolled" } : {})}>
          {h.item && (
              <span className="equipped">
                + <CardChip card={h.item} />
              </span>
            )}
          <ControlButton label={`Roll for ${cardName(h.hero)}`} control={control("ROLL_HERO_EFFECT", h.hero.id)} onPick={([a]) => act(a!)}>
            Roll
          </ControlButton>
        </CardView>
      ))}
      <SlainPile monsters={player.slainMonsters} />
    </section>
  );
}

function ActionBar({ view, control: given, act, notYourTurn }: { view: PlayerView; control: ControlFn; act(a: Action): void; notYourTurn: boolean }) {
  const myTurn = view.me === view.activePlayer;
  const pick = ([a]: Action[]) => act(a!);
  const control: ControlFn = (type, subject) => {
    const c = given(type, subject);
    return notYourTurn ? { ...c, reason: "Not your turn" } : c;
  };
  const maxAp = Math.max(view.actionPoints, 3);
  return (
    <section aria-label="Actions" className="action-bar">
      <span className="ap" aria-label={`${myTurn ? view.actionPoints : 0} action points`}>
        AP {Array.from({ length: maxAp }, (_, i) => (myTurn && i < view.actionPoints ? "●" : "○")).join("")}
      </span>
      <ControlButton label="Draw a card" control={control("DRAW_CARD")} onPick={pick} />
      <ControlButton label="Discard and redraw" control={control("DISCARD_AND_REDRAW")} onPick={pick} />
      <ControlButton label="End turn" control={control("END_TURN")} onPick={pick} />
    </section>
  );
}

/** The turn action that plays a card of this type from the hand, if any: responses are played from the Respond bar. */
function playType(card: Card): "PLAY_HERO" | "PLAY_ITEM" | "PLAY_MAGIC" | null {
  switch (cardDef(card)?.type) {
    case "hero":
      return "PLAY_HERO";
    case "item":
    case "cursedItem":
      return "PLAY_ITEM";
    case "magic":
      return "PLAY_MAGIC";
    default:
      return null;
  }
}

/** The hint on a hand card that is only played in answer to something. */
function responseHint(card: Card): string | null {
  const type = cardDef(card)?.type;
  if (type === "challenge") return "Play it when someone plays a card";
  if (type === "modifier") return "Play it on a roll";
  return null;
}

function Hand({ view, control, act }: { view: PlayerView; control: ControlFn; act(a: Action): void }) {
  const [choosing, setChoosing] = useState<string | null>(null);
  const playsFor = (card: Card): Control => {
    const type = playType(card);
    return type ? control(type, card.id) : { actions: [], reason: responseHint(card) };
  };
  const targets = choosing ? playsFor({ id: choosing, def: view.hand.find((c) => c.id === choosing)?.def ?? "" }).actions : [];
  return (
    <>
      <section aria-label="Your hand" className="hand">
        {view.hand.map((card) => (
          <CardView key={card.id} card={card}>
            <ControlButton
              label={cardName(card)}
              control={playsFor(card)}
              onPick={(actions) => {
                if (actions.length === 1) act(actions[0]!);
                else setChoosing(card.id);
              }}
            >
              Play
            </ControlButton>
          </CardView>
        ))}
      </section>
      {choosing && targets.length > 1 && (
        <section aria-label={`Equip ${cardName(view.hand.find((c) => c.id === choosing) ?? choosing)}`} className="targets">
          <p>Which hero?</p>
          {targets.map((a) => {
            const hero = a.type === "PLAY_ITEM" ? a.targetHero : "";
            const owner = view.players.find((p) => p.party.some((h) => h.hero.id === hero));
            const heroCard = owner?.party.find((h) => h.hero.id === hero)?.hero;
            return (
              <button
                key={hero}
                type="button"
                onClick={() => {
                  setChoosing(null);
                  act(a);
                }}
              >
                {heroCard ? cardName(heroCard) : hero}
                {owner && owner.id !== view.me ? ` (${owner.name})` : ""}
              </button>
            );
          })}
          <button type="button" onClick={() => setChoosing(null)}>
            Cancel
          </button>
        </section>
      )}
    </>
  );
}

/** What happened, one line per event, in the words of the Seat reading it. It starts collapsed. */
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

function GameOverScreen({ view, events }: { view: PlayerView; events: GameEvent[] }) {
  return (
    <main className="game-over">
      <h2>{nameIn(view, view.winner!)} wins!</h2>
      {view.winReason && <p>{view.winReason === "monsters" ? "By slaying monsters" : "With a full set of classes"}</p>}
      <table className="scores">
        <tbody>
          {view.players.map((p) => (
            <tr key={p.id}>
              <th scope="row">{p.name}</th>
              <td>
                {p.slainMonsters.length} {p.slainMonsters.length === 1 ? "monster" : "monsters"}
              </td>
              <td>
                {p.party.length} {p.party.length === 1 ? "hero" : "heroes"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <GameLog view={view} events={events} />
    </main>
  );
}
