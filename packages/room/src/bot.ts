import type { Action, PlayerViewPayload, SeatId } from "@here-to-slay/protocol";

export type BotDifficulty = "easy" | "normal";

/**
 * A bot player (TECHNICAL_DESIGN.md §11). The Room calls it whenever its Seat
 * has something to do. It sees only its own redacted view, never the full
 * state, and must return one of `legal`. `legal` is never empty.
 */
export interface Bot {
  chooseAction(view: PlayerViewPayload, legal: Action[]): Action;
}

/** Makes the bot for a new bot Seat. */
export type BotFactory = (seat: { id: SeatId; difficulty: BotDifficulty }) => Bot;

/** Picks a uniformly random legal action. `random` works like Math.random. */
export function randomBot(random: () => number): Bot {
  return {
    chooseAction(_view, legal) {
      return legal[Math.floor(random() * legal.length)] ?? legal[0]!;
    },
  };
}
