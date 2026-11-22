import type { CardView, GameEvent, PlayerId, PlayerView } from "@here-to-slay/engine";

/** The Spotlight (GLOSSARY.md): the card the latest play or roll is about, and who it belongs to. */
export interface Spotlight {
  card: CardView;
  player: PlayerId;
  /** What `player` did with `card`. */
  did: "played" | "attacked" | "rolled for";
}

/** What `event` puts in the Spotlight, or null when it is no play or roll. */
function spotlightOf(event: GameEvent): Spotlight | null {
  switch (event.type) {
    // A card played from a hand. Most wait in a Challenge Window first; those that don't, or whose window was answered, show here.
    case "CHALLENGE_WINDOW_OPENED":
    case "HERO_PLAYED":
    case "ITEM_PLAYED":
    case "MAGIC_PLAYED":
    case "MODIFIER_PLAYED":
    case "CHALLENGE_PLAYED":
      return { card: event.card, player: event.player, did: "played" };
    case "DICE_ROLLED":
      if (event.rollKind === "monsterAttack") return { card: event.monster, player: event.player, did: "attacked" };
      if (event.rollKind === "heroEffect") return { card: event.hero, player: event.player, did: "rolled for" };
      return null;
    default:
      return null;
  }
}

/**
 * The Spotlight after `events`, or null before anything has been played or
 * rolled. With no play or roll among them, as after a refresh, an open
 * Challenge Window still names its card.
 */
export function spotlight(events: readonly GameEvent[], view: PlayerView): Spotlight | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const found = spotlightOf(events[i]!);
    if (found) return found;
  }
  const responseWindow = view.responseWindow;
  return responseWindow?.kind === "challenge" ? { card: responseWindow.card, player: responseWindow.player, did: "played" } : null;
}
