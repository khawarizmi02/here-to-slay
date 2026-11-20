import type { CardDef, Effect, HeroClass, PassiveAbility, RollKind } from "@here-to-slay/cards";
import type { Action, PlayerViewPayload } from "@here-to-slay/protocol";
import { DEFAULT_CONFIG } from "./config.js";
import { ACCEPT, DECLINE, type CardDefId, type PlayerView, type WindowRoll } from "./types.js";

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
/** How often it Challenges a player who isn't close to winning (§11.1). */
const CHALLENGE_CHANCE = 0.2;

/**
 * The easy bot (TECHNICAL_DESIGN.md §11.1). On its own turn it takes the
 * first legal action of its priority list. It Challenges a player close to
 * winning (or at random), plays a Modifier only when it turns a roll its
 * way, and answers a Decision against the player closest to winning, giving
 * up its least useful card. Anything else, such as a leader draft, is a
 * random legal action. It reads only its own view and `legal`. `random`
 * works like Math.random, so the engine never calls it.
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

  /** One class or one monster away from winning. */
  const nearWin = (p: PlayerInView): boolean =>
    partyClasses(p).size >= DEFAULT_CONFIG.classesToWin - 1 || p.slainMonsters.length >= DEFAULT_CONFIG.monstersToWin - 1;

  /** In a Challenge Window: Challenge a player close to winning, or at random 20% of the time; otherwise pass (§11.1). */
  const challengeResponse = (view: PlayerView, legal: Action[]): Action | undefined => {
    const window = view.responseWindow;
    if (window?.kind !== "challenge") return undefined;
    const challenge = legal.find((a) => a.type === "PLAY_CHALLENGE");
    const pass = legal.find((a) => a.type === "PASS");
    if (challenge === undefined) return pass;
    const player = view.players.find((p) => p.id === window.player);
    return (player !== undefined && nearWin(player)) || random() < CHALLENGE_CHANCE ? challenge : pass;
  };

  /** The opponent closer to winning than every other opponent; none while two or more tie for it. */
  const leadingOpponent = (view: PlayerView, me: PlayerInView): PlayerInView | undefined => {
    const opponents = view.players.filter((p) => p.id !== me.id);
    const best = Math.max(...opponents.map(winScore));
    const leaders = opponents.filter((p) => winScore(p) === best);
    return leaders.length === 1 ? leaders[0] : undefined;
  };

  /**
   * In a Modifier Window: play a Modifier that turns its rolls the way `me`
   * wants, lifting its own roll to what it needs or dropping the leading
   * opponent's under it; otherwise pass (§11.1).
   */
  const modifierResponse = (view: PlayerView, me: PlayerInView, legal: Action[]): Action | undefined => {
    const window = view.responseWindow;
    if (window?.kind !== "modifier") return undefined;
    const leader = leadingOpponent(view, me)?.id;
    /** Whether the rolls, at these totals, favour `me`; undefined when it has no stake in them. */
    const favoursMe = (rolls: WindowRoll[]): boolean | undefined => {
      /** A roll made (or a Challenge won) favours `me` when it is its own, and not when it is the leader's. */
      const goes = (roller: string, made: boolean) => (roller === me.id ? made : roller === leader ? !made : undefined);
      const [first] = rolls;
      if (first === undefined) return undefined;
      if (first.rollKind !== "challenge") return goes(first.player, first.total >= first.needs);
      const challenger = rolls.find((r) => r.rollKind === "challenge" && r.side === "challenger");
      const defender = rolls.find((r) => r.rollKind === "challenge" && r.side === "defender");
      if (challenger === undefined || defender === undefined) return undefined;
      const succeeds = DEFAULT_CONFIG.challengeTieWinner === "challenger" ? challenger.total >= defender.total : challenger.total > defender.total;
      return goes(challenger.player, succeeds) ?? goes(defender.player, !succeeds);
    };
    const pass = legal.find((a) => a.type === "PASS");
    if (favoursMe(window.rolls) !== false) return pass;
    const modifier = legal.find(
      (a) => a.type === "PLAY_MODIFIER" && favoursMe(window.rolls.map((r) => (r.roll === a.roll ? { ...r, total: r.total + a.value } : r))) === true,
    );
    return modifier ?? pass;
  };

  /** Whether `effect` makes `me` give up a card it has: discarding from its hand, or sacrificing a hero. */
  const costsMe = (effect: Effect, view: PlayerView, me: PlayerInView): boolean => {
    switch (effect.op) {
      case "sequence":
        return effect.steps.some((step) => costsMe(step, view, me));
      case "discard":
        return effect.who === "self" && view.hand.length > 0;
      case "sacrifice":
        return effect.who === "self" && me.party.length > 0;
      default:
        return false;
    }
  };

  /** How much `me` would miss a card in its hand: a hero of a new class most, one of a class it has least. */
  const handValue = (view: PlayerView, me: PlayerInView, card: string): number => {
    const d = handDef(view, card);
    if (d?.type !== "hero") return 2;
    return partyClasses(me).has(d.class) ? 1 : 3;
  };

  /** How much `me` would miss a hero in its party: one whose class it would lose most, then the likeliest to roll. */
  const heroValue = (me: PlayerInView, h: HeroInView): number => {
    const others = { ...me, party: me.party.filter((o) => o.hero.id !== h.hero.id) };
    return (partyClasses(others).size < partyClasses(me).size ? 2 : 0) + heroChance(me, h);
  };

  /**
   * Answers a Decision (§11.1): hurt the player closest to winning, give up
   * its least useful card, and decline a "you may" that costs it a card.
   * Undefined when the Decision isn't one of these, such as a leader draft.
   */
  const decisionAnswer = (view: PlayerView, me: PlayerInView, legal: Action[]): Action | undefined => {
    const d = view.pendingDecision;
    if (d === null || !("options" in d) || d.player !== me.id) return undefined;
    const answer = (id: string) => legal.find((a) => a.type === "RESOLVE_DECISION" && a.answer.selected[0] === id);
    if (d.kind === "confirmOptional") return answer(d.effect !== undefined && costsMe(d.effect, view, me) ? DECLINE : ACCEPT);
    const owner = (hero: string) => view.players.find((p) => p.party.some((h) => h.hero.id === hero));
    const score = (id: string): number | undefined => {
      switch (d.kind) {
        case "choosePlayer": {
          const p = view.players.find((q) => q.id === id);
          return p === undefined ? undefined : p.id === me.id ? -1 : winScore(p);
        }
        case "chooseHero": {
          const p = owner(id);
          const h = p?.party.find((x) => x.hero.id === id);
          if (p === undefined || h === undefined) return undefined;
          if (p.id !== me.id) return winScore(p);
          return d.discard ? -heroValue(me, h) : heroChance(me, h);
        }
        case "chooseCardFromHand":
          return d.discard ? -handValue(view, me, id) : undefined;
        default:
          return undefined;
      }
    };
    return bestBy(legal, (a) => (a.type === "RESOLVE_DECISION" ? score(a.answer.selected[0]) : undefined));
  };

  const handDef = (view: PlayerView, card: string): CardDef | undefined => {
    const c = view.hand.find((h) => h.id === card);
    return c === undefined ? undefined : def(c.def);
  };

  return {
    chooseAction(payload, legal) {
      const view = payload as unknown as PlayerView;
      const me = view.players.find((p) => p.id === view.me);
      if (me !== undefined) {
        const rules = legal.some((a) => a.type === "END_TURN")
          ? turnRules(view, me, legal)
          : [() => challengeResponse(view, legal), () => modifierResponse(view, me, legal), () => decisionAnswer(view, me, legal)];
        for (const rule of rules) {
          const action = rule();
          if (action !== undefined) return action;
        }
      }
      return legal[Math.floor(random() * legal.length)] ?? legal[0]!;
    },
  };
}

/**
 * Makes the bot for a bot Seat, or for a remote Seat a bot takes over.
 * Matches the Room's `BotFactory` by shape. Every difficulty gets
 * the easy bot until the normal bot exists. The bots share `random`.
 */
export function botFactory(cardDefs: readonly CardDef[], random: () => number): (seat: { id: string; difficulty: "easy" | "normal" }) => EasyBot {
  return () => createEasyBot(cardDefs, random);
}
