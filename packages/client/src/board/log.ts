import type { GameEvent, PlayerView } from "@here-to-slay/engine";
import { cardName } from "./cards.js";

export function nameIn(view: PlayerView, id: string): string {
  return view.players.find((p) => p.id === id)?.name ?? id;
}

/** A player as the Seat reading `view` calls them: "You" for itself, otherwise by name. */
export function whoIn(view: PlayerView, id: string): string {
  return id === view.me ? "You" : nameIn(view, id);
}

/** The log line for `event`, in the words of the Seat reading it, or null for one the board already shows. */
export function logLine(event: GameEvent, view: PlayerView): string | null {
  const who = (id: string) => whoIn(view, id);
  const whose = (id: string) => (id === view.me ? "your" : `${nameIn(view, id)}'s`);
  const plus = (n: number) => (n > 0 ? `+${n}` : String(n));
  switch (event.type) {
    case "TURN_STARTED":
      return `Turn ${event.turnNumber}: ${whose(event.player)} turn`;
    case "TURN_ENDED":
      return null;
    case "CARD_DRAWN":
      // The engine leaves the card out of every copy but the drawer's.
      return event.card ? `${who(event.player)} drew ${cardName(event.card)}` : `${who(event.player)} drew a card`;
    case "LEADER_CHOSEN":
      return `${who(event.player)} leads with ${cardName(event.leader)}`;
    case "FIRST_PLAYER_ROLLED":
      return `${who(event.firstPlayer)} rolled highest and goes first`;
    case "CARD_DISCARDED":
      return `${who(event.player)} discarded ${cardName(event.card)}`;
    case "HERO_PLAYED":
      return `${cardName(event.card)} joined ${whose(event.player)} party`;
    case "ITEM_PLAYED":
      return `${who(event.player)} equipped ${cardName(event.card)} to ${whose(event.owner)} ${cardName(event.hero)}`;
    case "MAGIC_PLAYED":
      return `${who(event.player)} cast ${cardName(event.card)}`;
    case "MAGIC_DISCARDED":
      return null;
    case "HERO_STOLEN":
      return `${who(event.player)} stole ${cardName(event.hero)} from ${nameIn(view, event.from)}`;
    case "HERO_DESTROYED":
      return `${who(event.player)} destroyed ${whose(event.owner)} ${cardName(event.hero)}`;
    case "HERO_SACRIFICED":
      return `${who(event.player)} sacrificed ${cardName(event.hero)}`;
    case "ITEM_DISCARDED":
      return `${who(event.player)} discarded ${cardName(event.item)}`;
    case "CARD_PULLED":
      return event.card ? `${who(event.player)} pulled ${cardName(event.card)} from ${nameIn(view, event.from)}` : `${who(event.player)} pulled a card from ${nameIn(view, event.from)}`;
    case "DICE_ROLLED": {
      const what =
        event.rollKind === "heroEffect" ? `for ${cardName(event.hero)}` : event.rollKind === "monsterAttack" ? `against ${cardName(event.monster)}` : `in the Challenge on ${cardName(event.target)}`;
      const bonus = event.bonus === 0 ? "" : ` ${plus(event.bonus)}`;
      return `${who(event.player)} rolled ${event.dice[0]} and ${event.dice[1]}${bonus} ${what}: ${event.total}`;
    }
    case "MODIFIER_PLAYED":
      return `${who(event.player)} played ${cardName(event.card)} ${plus(event.value)}: the roll is now ${event.total}`;
    case "ROLL_RESOLVED":
      if (event.rollKind === "heroEffect") return `${cardName(event.hero)}'s roll of ${event.total} ${event.succeeded ? "succeeded" : "failed"}`;
      return {
        slain: `${who(event.player)} slew ${cardName(event.monster)} with ${event.total}`,
        defeated: `${cardName(event.monster)} defeated ${who(event.player) === "You" ? "you" : who(event.player)} with ${event.total}`,
        nothing: `The attack on ${cardName(event.monster)} did nothing (${event.total})`,
      }[event.outcome];
    case "CHALLENGE_WINDOW_OPENED":
      return `${who(event.player)} played ${cardName(event.card)}`;
    case "CHALLENGE_PLAYED":
      return `${who(event.player)} challenged ${whose(event.defender)} ${cardName(event.target)}`;
    case "CHALLENGE_RESOLVED":
      return `The Challenge on ${cardName(event.target)} ${event.succeeded ? "succeeded" : "failed"} (${event.challengerTotal} against ${event.defenderTotal})`;
    case "MONSTER_SLAIN":
      return null;
    case "MONSTER_REVEALED":
      return `${cardName(event.monster)} appeared`;
    case "GAME_WON":
      return `${who(event.player)} won with ${event.reason === "monsters" ? "slain monsters" : "a full set of classes"}`;
    case "DECK_RESHUFFLED":
      return `The discard pile was shuffled into a new deck of ${event.cards}`;
  }
}
