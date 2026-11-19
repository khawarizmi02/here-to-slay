import type { CostedAction, HeroClass, Requirement } from "@here-to-slay/cards";
import { heroDef } from "./heroes.js";
import { heroesMatching } from "./party.js";
import { actionCost } from "./passives.js";
import { playerState } from "./players.js";
import { meetsRequirement, monsterDef } from "./monsters.js";
import { turnActionsOpen } from "./rules.js";
import { canDraw } from "./turns.js";
import type { BlockedAction, CardIndex, CardInstanceId, GameState, PlayerId } from "./types.js";

/** A control the active player sees, and why it can't be used apart from AP, if it can't. */
interface Control {
  type: CostedAction;
  subject?: CardInstanceId;
  problem?: string;
}

/**
 * The turn actions `player` can see as controls but can't take now, each
 * with one reason a player can read (TECHNICAL_DESIGN.md §12.2, ADR-0004).
 * Filled only where `getLegalActions` lists turn actions: for the active
 * player in the action phase with no Decision pending and no Response Window
 * open. Everywhere else it is empty.
 *
 * The controls are Draw, Discard and Redraw, an Attack on each face-up
 * monster, playing each hero, item and Magic card in hand, and rolling each
 * hero in the party. Each one is either legal or listed here, never both.
 * When a control fails for several causes, the reason is the one that isn't
 * about AP, since spending AP elsewhere won't fix it; failing that, the AP
 * it needs.
 *
 * A reason mentions only the player's own hand and public state.
 */
export function getBlockedActions(defs: CardIndex, state: GameState, player: PlayerId): BlockedAction[] {
  if (!turnActionsOpen(state, player)) return [];
  const blocked: BlockedAction[] = [];
  for (const control of controls(defs, state, player)) {
    const cost = actionCost(defs, state, player, control.type);
    const reason = control.problem ?? (cost > state.actionPoints ? `Needs ${cost} AP` : undefined);
    if (reason === undefined) continue;
    blocked.push(control.subject === undefined ? { type: control.type, reason } : { type: control.type, subject: control.subject, reason });
  }
  return blocked;
}

function controls(defs: CardIndex, state: GameState, player: PlayerId): Control[] {
  const me = playerState(state, player);
  const list: Control[] = [{ type: "DRAW_CARD", ...(canDraw(state) ? {} : { problem: "The deck is empty" }) }];
  for (const card of [...me.hand].sort()) {
    const type = defs.get(state.cards[card]!)?.type;
    if (heroDef(defs, state, card) !== undefined) list.push({ type: "PLAY_HERO", subject: card });
    else if (type === "magic") list.push({ type: "PLAY_MAGIC", subject: card });
    else if (type === "item" || type === "cursedItem") {
      const owner = type === "cursedItem" ? "any" : "self";
      const targets = heroesMatching(defs, state, player, { owner, hasItem: false });
      list.push({ type: "PLAY_ITEM", subject: card, ...(targets.length > 0 ? {} : { problem: "Needs a hero with no item" }) });
    }
  }
  for (const hero of me.party) {
    list.push({ type: "ROLL_HERO_EFFECT", subject: hero.instanceId, ...(hero.rolledThisTurn ? { problem: "Already rolled this turn" } : {}) });
  }
  for (const monster of state.activeMonsters) {
    const requirement = monsterDef(defs, state, monster)!.requirement;
    const met = meetsRequirement(defs, state, player, requirement);
    list.push({ type: "ATTACK_MONSTER", subject: monster, ...(met ? {} : { problem: `Needs ${describeRequirement(requirement)}` }) });
  }
  list.push({ type: "DISCARD_AND_REDRAW" });
  return list;
}

/** A requirement in words, as in "2 heroes" or "2 heroes and 1 Bard". */
export function describeRequirement(requirement: Requirement): string {
  switch (requirement.kind) {
    case "none":
      return "nothing";
    case "heroCount":
      return `${requirement.min} ${requirement.min === 1 ? "hero" : "heroes"}`;
    case "classCount":
      return `${requirement.min} ${className(requirement.class, requirement.min)}`;
    case "all":
      return requirement.of.map(describeRequirement).join(" and ");
  }
}

const CLASS_NAMES: Record<HeroClass, [string, string]> = {
  bard: ["Bard", "Bards"],
  fighter: ["Fighter", "Fighters"],
  guardian: ["Guardian", "Guardians"],
  ranger: ["Ranger", "Rangers"],
  thief: ["Thief", "Thieves"],
  wizard: ["Wizard", "Wizards"],
};

function className(cls: HeroClass, count: number): string {
  return CLASS_NAMES[cls][count === 1 ? 0 : 1];
}
