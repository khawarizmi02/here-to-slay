import { DEFAULT_CONFIG, type GameEvent, type PlayerView, type RuleConfig } from "@here-to-slay/engine";
import { useState } from "react";
import type { GameLayer, RulesProps } from "../shell/game.js";
import { Board } from "./Board.js";
import { RulesReference } from "./rules.js";

const RESPONSES = new Set(["PASS", "PLAY_CHALLENGE", "PLAY_MODIFIER"]);

/** The rules engine's layer: its board, its rules form, and whom it waits on. */
export const realGame: GameLayer = {
  Board,
  Rules,
  RulesReference,
  seatToAct(payload) {
    const view = payload as unknown as PlayerView;
    if (view.winner !== null || view.responseWindow !== null) return null;
    if (view.pendingDecision !== null) return view.pendingDecision.player;
    return view.phase.kind === "action" ? view.activePlayer : null;
  },
  viewer(payload) {
    const { me } = payload as unknown as PlayerView;
    return me === "spectator" ? null : me;
  },
  responseOptions(payload) {
    const view = payload as unknown as PlayerView;
    // The engine offers a Seat responses only while the open window awaits it.
    if (view.responseWindow === null || view.me === "spectator" || !view.responseWindow.awaiting.includes(view.me)) return null;
    const options = view.legalActions.filter((a) => RESPONSES.has(a.type));
    return options.length > 0 ? options : null;
  },
  sound(payload, viewPayload) {
    const event = payload as unknown as GameEvent;
    const view = viewPayload as unknown as PlayerView;
    switch (event.type) {
      case "DICE_ROLLED":
        return "diceRoll";
      // A Hero, Item or Magic card is played as its Challenge Window opens, or, under a rule that allows no Challenges, as it resolves.
      case "CHALLENGE_WINDOW_OPENED":
      case "MODIFIER_PLAYED":
        return "cardPlayed";
      case "HERO_PLAYED":
      case "ITEM_PLAYED":
      case "MAGIC_PLAYED":
        return view.config.maxChallengesPerPlay === 0 ? "cardPlayed" : null;
      case "CHALLENGE_PLAYED":
        return "challenge";
      case "MONSTER_SLAIN":
        return "monsterSlain";
      case "TURN_STARTED":
        return event.player === view.me ? "yourTurn" : null;
      case "GAME_WON":
        return "gameOver";
      default:
        return null;
    }
  },
};

/** The rules the Host may change in the lobby (§3.9). */
const RULES: { label: string; rule: keyof RuleConfig; min: number; max: number }[] = [
  { label: "Monsters to win", rule: "monstersToWin", min: 1, max: 9 },
  { label: "Classes to win", rule: "classesToWin", min: 1, max: 6 },
  { label: "Hand size", rule: "startingHandSize", min: 0, max: 10 },
  { label: "Action points", rule: "actionPointsPerTurn", min: 1, max: 6 },
];

/**
 * The Host's rules form. The Room doesn't echo the config back, so the form
 * keeps what it sent. It sends only whole numbers in range, which the
 * engine's config accepts.
 */
function Rules({ setConfig }: RulesProps) {
  return (
    <fieldset className="rules">
      <legend>Rules</legend>
      {RULES.map((r) => (
        <RuleInput key={r.rule} {...r} setConfig={setConfig} />
      ))}
    </fieldset>
  );
}

function RuleInput({ label, rule, min, max, setConfig }: (typeof RULES)[number] & RulesProps) {
  const [value, setValue] = useState(String(DEFAULT_CONFIG[rule]));
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isInteger(n) && n >= min && n <= max) setConfig({ [rule]: n });
        }}
      />
    </label>
  );
}
