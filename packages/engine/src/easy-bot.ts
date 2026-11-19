import type { CardDef, HeroClass, PassiveAbility, RollKind } from "@here-to-slay/cards";
import type { Action, PlayerViewPayload } from "@here-to-slay/protocol";
import { DEFAULT_CONFIG } from "./config.js";
import type { CardDefId, PlayerView } from "./types.js";

/** Matches the Room's `Bot` by shape, without importing the Room (ADR-0002). */
export interface EasyBot {
  chooseAction(view: PlayerViewPayload, legal: Action[]): Action;
}

type PlayerInView = PlayerView["players"][number];
type HeroInView = PlayerInView["party"][number];

/** Ways out of 36 that 2d6 totals at least n, for n = 2…12 (TECHNICAL_DESIGN.md §11.4). */
const WAYS_AT_LEAST = [36, 35, 33, 30, 26, 21, 15, 10, 6, 3, 1];

/** The chance that 2d6 plus `bonus` totals at least `target`. */
function chanceToReach(target: number, bonus: number): number {
  const n = target - bonus;
  if (n <= 2) return 1;
  if (n > 12) return 0;
  return WAYS_AT_LEAST[n - 2]! / 36;
}

/** The action with the highest score, the first on a tie; actions scored `undefined` don't count. */
function bestBy(legal: readonly Action[], score: (a: Action) => number | undefined): Action | undefined {
  let best: { action: Action; score: number } | undefined;
  for (const action of legal) {
    const value = score(action);
    if (value !== undefined && (best === undefined || value > best.score)) best = { action, score: value };
  }
  return best?.action;
}

/** An attack needs at least this chance to slay (§11.1). */
const ATTACK_CHANCE = 0.4;

/**
 * The easy bot (TECHNICAL_DESIGN.md §11.1). On its own turn it takes the
 * first legal action of its priority list; anything else (responses,
 * Decisions) is a random legal action. It reads only its own view and
 * `legal`. `random` works like Math.random, so the engine never calls it.
 */
export function createEasyBot(cardDefs: readonly CardDef[], random: () => number): EasyBot {
  const defs = new Map(cardDefs.map((d) => [d.id, d]));
  const def = (id: CardDefId): CardDef => {
    const d = defs.get(id);
    if (d === undefined) throw new Error(`Unknown card ${id}`);
    return d;
  };
  const passiveOf = (id: CardDefId): PassiveAbility | undefined => {
    const d = def(id);
    return d.type === "monster" ? d.reward : "passive" in d ? d.passive : undefined;
  };

  /** The class a hero in play counts as: its Mask's, or its own. */
  const heroClass = (h: HeroInView): HeroClass | undefined => {
    const item = h.item === null ? undefined : def(h.item.def);
    if (item !== undefined && "maskClass" in item && item.maskClass !== undefined) return item.maskClass;
    const hero = def(h.hero.def);
    return hero.type === "hero" ? hero.class : undefined;
  };

  /** The classes in a party, its Party Leader's included. */
  const partyClasses = (p: PlayerInView): Set<HeroClass> => {
    const classes = new Set<HeroClass>();
    const leader = p.leader === null ? undefined : def(p.leader.def);
    if (leader?.type === "leader") classes.add(leader.class);
    for (const h of p.party) {
      const c = heroClass(h);
      if (c !== undefined) classes.add(c);
    }
    return classes;
  };

  /**
   * What `me`'s passives add to a roll, as the engine counts them: the
   * leader's and slain monsters' always, and an item's only when its hero
   * rolls (`hero`), or for a monster attack, which is the whole party's roll.
   */
  const rollBonus = (me: PlayerInView, rollKind: RollKind, hero?: HeroInView): number => {
    const heroClassNow = hero === undefined ? undefined : heroClass(hero);
    const sources: CardDefId[] = [];
    if (me.leader !== null) sources.push(me.leader.def);
    for (const h of me.party) if (h.item !== null && (hero === undefined || h.hero.id === hero.hero.id)) sources.push(h.item.def);
    for (const m of me.slainMonsters) sources.push(m.def);
    let bonus = 0;
    for (const source of sources) {
      const p = passiveOf(source);
      if (p?.hook !== "modifyRollTotal") continue;
      const c = p.condition ?? {};
      if (c.rollKind !== undefined && c.rollKind !== rollKind) continue;
      if (c.heroClass !== undefined && c.heroClass !== heroClassNow) continue;
      if (c.action !== undefined) continue;
      bonus += p.value ?? 0;
    }
    return bonus;
  };

  /**
   * How close a player is to winning: the larger of classes owned out of
   * `classesToWin` and monsters slain out of `monstersToWin`. The view holds
   * no rule config, so this uses the defaults.
   */
  const winScore = (p: PlayerInView): number =>
    Math.max(partyClasses(p).size / DEFAULT_CONFIG.classesToWin, p.slainMonsters.length / DEFAULT_CONFIG.monstersToWin);

  /** The chance `me` rolls `h`'s effect. */
  const heroChance = (me: PlayerInView, h: HeroInView): number => {
    const hero = def(h.hero.def);
    return hero.type === "hero" ? chanceToReach(hero.rollRequirement, rollBonus(me, "heroEffect", h)) : 0;
  };

  /** The own-turn priority rules (§11.1), each the action it would take, if legal. */
  const turnRules = (view: PlayerView, me: PlayerInView, legal: Action[]): (() => Action | undefined)[] => [
    // 1. Attack a monster with at least a 40% chance to slay it, the best chance first.
    () => {
      const bonus = rollBonus(me, "monsterAttack");
      return bestBy(legal, (a) => {
        if (a.type !== "ATTACK_MONSTER") return undefined;
        const card = view.activeMonsters.find((c) => c.id === a.monster);
        const monster = card === undefined ? undefined : def(card.def);
        if (monster?.type !== "monster") return undefined;
        const chance = chanceToReach(monster.slayAt, bonus);
        return chance >= ATTACK_CHANCE ? chance : undefined;
      });
    },
    // 2. Play a hero of a class it doesn't have yet.
    () => {
      const owned = partyClasses(me);
      return legal.find((a) => {
        if (a.type !== "PLAY_HERO") return false;
        const hero = handDef(view, a.card);
        return hero?.type === "hero" && !owned.has(hero.class);
      });
    },
    // 3. Roll an unused hero whose roll number it can reach, the best chance first.
    () =>
      bestBy(legal, (a) => {
        if (a.type !== "ROLL_HERO_EFFECT") return undefined;
        const h = me.party.find((p) => p.hero.id === a.hero);
        const chance = h === undefined ? 0 : heroChance(me, h);
        return chance > 0 ? chance : undefined;
      }),
    // 4. Play an item on its best hero (the likeliest to roll), or a Cursed Item on a hero of the opponent closest to winning.
    () =>
      bestBy(legal, (a) => {
        if (a.type !== "PLAY_ITEM" || handDef(view, a.card)?.type !== "item") return undefined;
        const h = me.party.find((p) => p.hero.id === a.targetHero);
        return h === undefined ? undefined : heroChance(me, h);
      }) ??
      bestBy(legal, (a) => {
        if (a.type !== "PLAY_ITEM" || handDef(view, a.card)?.type !== "cursedItem") return undefined;
        const leading = view.players.find((p) => p.id !== me.id && p.party.some((h) => h.hero.id === a.targetHero));
        return leading === undefined ? undefined : winScore(leading);
      }),
    // 5. Play Magic.
    () => legal.find((a) => a.type === "PLAY_MAGIC"),
    // 6. Draw.
    () => legal.find((a) => a.type === "DRAW_CARD"),
    // 7. End the turn.
    () => legal.find((a) => a.type === "END_TURN"),
  ];

  const handDef = (view: PlayerView, card: string): CardDef | undefined => {
    const c = view.hand.find((h) => h.id === card);
    return c === undefined ? undefined : def(c.def);
  };

  return {
    chooseAction(payload, legal) {
      const view = payload as unknown as PlayerView;
      const me = view.players.find((p) => p.id === view.me);
      if (me !== undefined && legal.some((a) => a.type === "END_TURN")) {
        for (const rule of turnRules(view, me, legal)) {
          const action = rule();
          if (action !== undefined) return action;
        }
      }
      return legal[Math.floor(random() * legal.length)] ?? legal[0]!;
    },
  };
}
