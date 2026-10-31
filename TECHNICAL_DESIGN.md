# Here to Slay Digital — Technical Design Document

**Version:** 1.0 · **Date:** 31 Oct 2026 · **Status:** Personal, non-commercial project

---

## 0. How to Use This Document (Instructions for the Coding Agent)

This document is the single source of truth for building a digital version of the card game *Here to Slay*. The agent must follow these rules:

1. **Build in the milestone order** in Section 14. Do not start a milestone until the previous one's acceptance criteria pass.
2. **The rules engine is pure TypeScript** with no UI, network, `Date.now()`, or `Math.random()` calls. All randomness goes through the seeded RNG (Section 8).
3. **Never hard-code card behaviour in the engine.** Cards are data (Section 5). Only add a custom effect handler when the effect DSL truly cannot express a card.
4. **Every rule that is marked ⚙️ is a config flag** (Section 3.9). Implement it as configurable, with the stated default.
5. **Write tests alongside code** (Section 13). Every effect primitive and every phase transition needs a unit test.
6. When a rule is ambiguous, **do not guess silently**. Implement the default, add it to Section 15's list, and leave a `// RULE-CHECK:` comment in the code.
7. Card names, art, and exact card text come from the owner's physical copy. Use the placeholder cards in Section 5.6 until real card data is added to `/packages/cards/data/`.

---

## 1. Project Overview

### 1.1 Goal
A playable digital implementation of the *Here to Slay* base game for 2–6 players. It supports hot-seat play, online play with friends, and AI opponents.

### 1.2 Scope (v1)
- Base game only: 6 classes (Bard, Fighter, Guardian, Ranger, Thief, Wizard).
- All card types: Party Leader, Hero, Item (including Cursed and Mask items), Magic, Modifier, Challenge, Monster.
- Local hot-seat, online private rooms, and AI bots.
- Desktop browser first, with a responsive layout that works acceptably on tablets.

### 1.3 Non-goals (v1)
- Expansions. The architecture must allow them later; see Section 5.5.
- Accounts, matchmaking, rankings, or monetisation.
- Mobile app store builds.
- Public distribution of the official art or text.

### 1.4 Design principles
- **Deterministic engine:** the same seed and the same action list always produce the same game.
- **Server-authoritative:** clients never decide outcomes.
- **Data-driven cards:** new cards should mostly be JSON, not code.
- **Every pause is a prompt:** whenever the game needs a player's input, it creates an explicit `PendingDecision` object. There are no hidden waits.

---

## 2. Tech Stack & Repository Structure

### 2.1 Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict mode) | Shared types across engine, server, and client |
| Monorepo | pnpm workspaces | Simple package sharing |
| Engine | Pure TS package | Testable, runs on server and client |
| Validation | Zod | Validates card JSON and network messages |
| Client | React + Vite | Fast dev loop |
| Client state | Zustand | Lightweight |
| Animation | Framer Motion | Card movement and flips |
| Server | Node.js + `ws` (WebSocket) | Minimal and transparent; Colyseus is an acceptable alternative |
| Tests | Vitest | Fast, TS-native |
| E2E tests | Playwright | Full game flows in the browser |

> **Alternative:** boardgame.io provides phases, hidden state, and multiplayer out of the box. This design uses a custom engine because Here to Slay's nested interrupts (challenges and modifiers on rolls within effects) need fine control. If the agent uses boardgame.io instead, the domain model and effect DSL in this document still apply.

### 2.2 Repository layout

```
here-to-slay/
├─ packages/
│  ├─ engine/              # Pure rules engine (no I/O)
│  │  ├─ src/
│  │  │  ├─ types/         # Domain types (Section 4)
│  │  │  ├─ state/         # Initial state, setup
│  │  │  ├─ actions/       # Action definitions + validators
│  │  │  ├─ reducer/       # applyAction(state, action) → state
│  │  │  ├─ phases/        # Turn state machine
│  │  │  ├─ effects/       # Effect DSL interpreter + primitives
│  │  │  ├─ stack/         # Response windows & resolution stack
│  │  │  ├─ rng/           # Seeded RNG
│  │  │  ├─ views/         # Per-player redacted views
│  │  │  └─ config/        # Rule flags
│  │  └─ test/
│  ├─ cards/               # Card JSON + Zod schemas + loader
│  │  ├─ data/
│  │  │  ├─ leaders.json
│  │  │  ├─ heroes.json
│  │  │  ├─ items.json
│  │  │  ├─ magic.json
│  │  │  ├─ modifiers.json
│  │  │  ├─ challenges.json
│  │  │  └─ monsters.json
│  │  └─ src/schema.ts
│  ├─ ai/                  # Bot players
│  ├─ server/              # WebSocket game server
│  └─ client/              # React app
├─ docs/
│  └─ TECHNICAL_DESIGN.md  # This document
└─ package.json
```

---

## 3. Game Rules as Implemented

This section is the engine's rules contract. Rules marked ⚙️ are config flags; see 3.9.

### 3.1 Components
- **Main deck:** Hero, Item, Magic, Modifier, Challenge cards.
- **Monster deck:** separate deck.
- **Party Leaders:** separate set; each player gets one.
- **Dice:** two six-sided dice (2d6).
- **Discard pile:** shared, for main deck cards. Slain monsters stay with the player who slew them.

### 3.2 Setup
1. Each player receives a Party Leader. Modes: random, or draft in turn order. ⚙️ `leaderSelection`
2. Shuffle the main deck and deal 5 cards to each player.
3. Shuffle the monster deck and reveal 3 monsters face-up in the centre.
4. Choose the first player. Default: every player rolls 2d6, highest goes first, ties reroll. ⚙️ `firstPlayerMethod`

### 3.3 Win conditions
Checked immediately after any state change, not just at end of turn:
- **Monster win:** a player has slain 3 monsters. ⚙️ `monstersToWin` (default 3)
- **Class win:** a player's party contains 6 distinct classes. The Party Leader's class counts, and Mask items change a hero's class. ⚙️ `classesToWin` (default 6)

If a win condition is met in the middle of a resolution, finish the current atomic effect and then end the game. ⚙️ `winCheckTiming` (default `"immediate"`)

### 3.4 Turn structure
1. **Start of turn:** trigger "start of turn" passives. Optional free draw. ⚙️ `drawAtStartOfTurn` (default `false`)
2. **Action phase:** the player has 3 action points (AP). ⚙️ `actionPointsPerTurn`
3. **End of turn:** if the player has more than 7 cards in hand, they discard down to 7. ⚙️ `handLimit`
4. Pass to the next player clockwise.

### 3.5 Actions

| Action | Cost | Rules |
|---|---|---|
| `DRAW_CARD` | 1 AP | Draw 1 from the main deck |
| `PLAY_HERO` | 1 AP | Put a Hero into own party. Can be Challenged. After resolving, the player may immediately attempt the hero's roll for free. ⚙️ `freeRollOnHeroPlay` (default `true`) |
| `PLAY_ITEM` | 1 AP | Equip to a hero with no item. Cursed items go on any player's hero. Can be Challenged |
| `PLAY_MAGIC` | 1 AP | Resolve effect, then discard. Can be Challenged |
| `ROLL_HERO_EFFECT` | 1 AP | Roll 2d6 for a hero in own party that hasn't attempted a roll this turn. Success if the total, after modifiers, is at least the hero's requirement |
| `ATTACK_MONSTER` | 2 AP | The party must meet the monster's requirements. Roll 2d6. Total ≥ slay value: slain. Total ≤ defeat value: apply the monster's penalty. Otherwise nothing happens |
| `DISCARD_AND_REDRAW` | 3 AP | Discard the whole hand, draw 5 |
| `END_TURN` | 0 AP | Ends the turn early |

Additional rules:
- Each hero can attempt its roll **once per turn**, whether or not it succeeded. Track this with `hero.rolledThisTurn`.
- A hero that is stolen or moved keeps its per-turn roll flag for that turn. ⚙️ `rollFlagFollowsHero` (default `true`)
- **AP is spent when an action is declared.** If the action is Challenged successfully, the AP is not refunded.
- When a monster is slain, it moves to the player's slain pile, and a new monster is revealed from the monster deck.

### 3.6 Modifier cards
- Any player, including the roller, may play Modifier cards on **any roll**: hero effects, monster attacks, challenge rolls, and the first-player roll if that flag is enabled.
- Each Modifier card offers one or more options, such as `+2` or `−2`. The player who plays it picks one option.
- Multiple modifiers can be played on the same roll by any players.
- Playing a Modifier costs no AP, including on your own turn.
- The final total is the dice total plus all chosen modifier values.

### 3.7 Challenge cards
- When a player plays a Hero, Item, or Magic card from hand, a **challenge window** opens.
- Only **one** challenge can be made against a single card play. ⚙️ `maxChallengesPerPlay` (default 1)
- The challenger discards the Challenge card. The challenger and the challenged player each roll 2d6, and modifiers can be played on both rolls.
- If the challenger's total meets the threshold, the challenged card goes to the discard pile with no effect. ⚙️ `challengeTieWinner` (default `"challenger"`; **verify**, see Section 15)
- Challenge cards and Modifier cards cannot themselves be challenged.
- Playing a Challenge costs no AP.

### 3.8 Card-specific mechanics
- **Items:** each hero can hold at most one item. When a hero leaves a party (destroyed or sacrificed), its item goes to the discard pile. When a hero is stolen, its item moves with it. ⚙️ `itemFollowsStolenHero` (default `true`)
- **Cursed items:** these are items with a negative effect and are usually equipped to an opponent's hero.
- **Mask items:** the equipped hero counts as the mask's class for all purposes, including the class win condition and monster requirements.
- **Party Leaders:** cannot be stolen, destroyed, or sacrificed. Their passive ability is always active.
- **Monsters (slain):** grant a permanent passive ability to the owner.

Common effect verbs, which map to DSL primitives in Section 5:

| Verb | Meaning |
|---|---|
| DRAW | Take cards from the top of the main deck |
| DISCARD | Move cards from hand to the discard pile |
| STEAL | Take a hero from another player's party into your own |
| DESTROY | Move another player's hero to the discard pile |
| SACRIFICE | Discard one of your own heroes |
| PULL | Take a random card from another player's hand |
| SEARCH | Take a card from the discard pile or deck |
| TRADE | Swap hands, or swap specific cards |
| LOOK | View another player's hand |

### 3.9 Rule flags (config)

```ts
export interface RuleConfig {
  actionPointsPerTurn: number;         // 3
  handLimit: number;                   // 7
  startingHandSize: number;            // 5
  activeMonsterCount: number;          // 3
  monstersToWin: number;               // 3
  classesToWin: number;                // 6
  drawAtStartOfTurn: boolean;          // false
  freeRollOnHeroPlay: boolean;         // true
  maxChallengesPerPlay: number;        // 1
  challengeTieWinner: "challenger" | "challenged"; // "challenger" — VERIFY
  rollFlagFollowsHero: boolean;        // true
  itemFollowsStolenHero: boolean;      // true
  leaderCountsForRequirements: boolean; // true — VERIFY
  winCheckTiming: "immediate" | "endOfAction"; // "immediate"
  leaderSelection: "random" | "draft"; // "random"
  firstPlayerMethod: "roll" | "random" | "host"; // "roll"
  responseWindowMs: number;            // 8000 (online only)
  reshuffleDiscardWhenDeckEmpty: boolean; // true
}
```

---

## 4. Domain Model

All types live in `packages/engine/src/types/`.

### 4.1 Identifiers

```ts
export type PlayerId = string;      // "p1", "p2", ...
export type CardDefId = string;     // card definition id, e.g. "hero_bard_01"
export type CardInstanceId = string; // unique per physical card in this game, e.g. "c_042"
export type HeroClass = "bard" | "fighter" | "guardian" | "ranger" | "thief" | "wizard";
```

**Important distinction:** a `CardDef` is the static definition from JSON. A `CardInstance` is one physical copy in a game. Some cards have several copies, so state always refers to **instance IDs**.

### 4.2 Card definitions

```ts
export type CardType =
  | "leader" | "hero" | "item" | "cursedItem" | "magic"
  | "modifier" | "challenge" | "monster";

interface BaseCardDef {
  id: CardDefId;
  type: CardType;
  name: string;
  text: string;         // display text
  copies: number;       // how many in the deck
  art?: string;         // asset path
}

export interface LeaderDef extends BaseCardDef {
  type: "leader";
  class: HeroClass;
  passive: PassiveAbility;
}

export interface HeroDef extends BaseCardDef {
  type: "hero";
  class: HeroClass;
  rollRequirement: number;   // e.g. 8 means 8+ on 2d6
  effect: Effect;            // runs on successful roll
}

export interface ItemDef extends BaseCardDef {
  type: "item" | "cursedItem";
  passive?: PassiveAbility;  // continuous effect on equipped hero/party
  maskClass?: HeroClass;     // set for Mask items
}

export interface MagicDef extends BaseCardDef {
  type: "magic";
  effect: Effect;
}

export interface ModifierDef extends BaseCardDef {
  type: "modifier";
  options: number[];         // e.g. [2, -2] or [4]
}

export interface ChallengeDef extends BaseCardDef {
  type: "challenge";
}

export interface MonsterDef extends BaseCardDef {
  type: "monster";
  requirement: Requirement;  // to be allowed to attack
  slayAt: number;            // total ≥ slayAt  → slain
  defeatAt: number;          // total ≤ defeatAt → penalty
  penalty: Effect;
  reward: PassiveAbility;    // permanent once slain
}

export type CardDef =
  | LeaderDef | HeroDef | ItemDef | MagicDef
  | ModifierDef | ChallengeDef | MonsterDef;
```

### 4.3 Game state

```ts
export interface HeroInPlay {
  instanceId: CardInstanceId;
  equippedItem: CardInstanceId | null;
  rolledThisTurn: boolean;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  isBot: boolean;
  leader: CardInstanceId;
  hand: CardInstanceId[];
  party: HeroInPlay[];
  slainMonsters: CardInstanceId[];
}

export interface GameState {
  id: string;
  config: RuleConfig;
  rng: RngState;                         // Section 8
  cards: Record<CardInstanceId, CardDefId>; // instance → definition
  players: PlayerState[];
  turnOrder: PlayerId[];
  activePlayer: PlayerId;
  actionPoints: number;
  turnNumber: number;

  mainDeck: CardInstanceId[];            // index 0 = top
  discardPile: CardInstanceId[];
  monsterDeck: CardInstanceId[];
  activeMonsters: CardInstanceId[];

  phase: Phase;                          // Section 6.3
  stack: StackFrame[];                   // Section 7
  pendingDecision: PendingDecision | null; // Section 6.4

  log: LogEntry[];                       // human-readable history
  winner: PlayerId | null;
  winReason: "monsters" | "classes" | null;
}
```

### 4.4 Derived values (computed, never stored)

Write these as pure functions in `engine/src/state/selectors.ts`:

```ts
getHeroClass(state, heroInstanceId): HeroClass       // applies Mask items
getPartyClasses(state, playerId): Set<HeroClass>     // includes leader
canAttackMonster(state, playerId, monsterId): boolean
getActivePassives(state, playerId): PassiveAbility[] // leader + items + slain monsters
getRollBonus(state, playerId, rollKind): number      // passive bonuses to rolls
```

**Rule:** never cache derived values in state. They go stale when cards move.

---

## 5. Card Data Format & Effect DSL

### 5.1 Why a DSL
Most card effects are combinations of a few operations: choose a target, then move cards between zones. A small declarative language covers about 90% of cards. The remaining cards use named custom handlers.

### 5.2 Effect structure

```ts
export type Effect =
  | { op: "sequence"; steps: Effect[] }
  | { op: "choice"; chooser: PlayerRef; options: { label: string; effect: Effect }[] }
  | { op: "optional"; chooser: PlayerRef; effect: Effect }   // "you may..."
  | { op: "forEach"; players: PlayerFilter; effect: Effect }  // "each other player..."
  | { op: "draw"; who: PlayerRef; amount: number }
  | { op: "discard"; who: PlayerRef; amount: number; chosenBy: PlayerRef }
  | { op: "steal"; from: PlayerRef; target: HeroFilter }      // hero to own party
  | { op: "destroy"; target: HeroFilter }                     // to discard
  | { op: "sacrifice"; who: PlayerRef; amount: number }
  | { op: "pull"; from: PlayerRef; amount: number }           // random from hand
  | { op: "searchDiscard"; who: PlayerRef; filter: CardFilter; amount: number }
  | { op: "searchDeck"; who: PlayerRef; filter: CardFilter; amount: number }
  | { op: "lookAtHand"; viewer: PlayerRef; target: PlayerRef }
  | { op: "tradeHands"; a: PlayerRef; b: PlayerRef }
  | { op: "playFromHand"; who: PlayerRef; filter: CardFilter; free: boolean }
  | { op: "gainAP"; amount: number }
  | { op: "custom"; handler: string; params?: Record<string, unknown> };

export type PlayerRef =
  | "self" | "activePlayer"
  | { choose: PlayerFilter };   // prompts the chooser to pick a player

export type PlayerFilter = "any" | "other" | "self" | "withHeroes" | "withCards";

export interface HeroFilter {
  owner: "self" | "other" | "any";
  class?: HeroClass;
  hasItem?: boolean;
  chosenBy: "self" | "owner";
}

export interface CardFilter {
  types?: CardType[];
  class?: HeroClass;
}
```

### 5.3 Requirements (monsters)

```ts
export type Requirement =
  | { kind: "heroCount"; min: number }
  | { kind: "classCount"; class: HeroClass; min: number }
  | { kind: "all"; of: Requirement[] }
  | { kind: "none" };
```

The Party Leader counts as a hero of its class for requirements. ⚙️ `leaderCountsForRequirements` (default `true`; see Section 15).

### 5.4 Passive abilities

Passives are continuous modifiers checked by the engine at specific **hook points**:

```ts
export type HookPoint =
  | "onTurnStart" | "onTurnEnd"
  | "beforeRoll" | "afterRoll"
  | "onCardPlayed" | "onHeroEnterParty" | "onHeroLeaveParty"
  | "onChallenged" | "onMonsterSlain"
  | "modifyRollTotal" | "modifyActionCost" | "modifyHandLimit";

export interface PassiveAbility {
  hook: HookPoint;
  condition?: Condition;     // e.g. { rollKind: "heroEffect", heroClass: "wizard" }
  effect?: Effect;           // for trigger hooks
  value?: number;            // for "modify*" hooks
  handler?: string;          // custom handler name
}
```

The engine calls `runHooks(state, hookPoint, context)` at each hook point and gathers every passive from leaders, items, and slain monsters.

### 5.5 Extensibility for expansions
- New classes: extend `HeroClass` and update `classesToWin`.
- New card types: add to `CardType`, add a Zod schema, and add an action if the card is played differently.
- New mechanics: add hook points or effect ops. Avoid special-case `if (card.id === ...)` code.

### 5.6 Placeholder card examples

Use these until the real data is entered. Names and numbers are illustrative only.

```json
// heroes.json
[
  {
    "id": "hero_wizard_01",
    "type": "hero",
    "name": "Placeholder Wizard",
    "class": "wizard",
    "rollRequirement": 8,
    "copies": 1,
    "text": "Roll 8+: DRAW 2 cards.",
    "effect": { "op": "draw", "who": "self", "amount": 2 }
  },
  {
    "id": "hero_thief_01",
    "type": "hero",
    "name": "Placeholder Thief",
    "class": "thief",
    "rollRequirement": 10,
    "copies": 1,
    "text": "Roll 10+: STEAL a Hero card.",
    "effect": {
      "op": "steal",
      "from": { "choose": "withHeroes" },
      "target": { "owner": "other", "chosenBy": "self" }
    }
  },
  {
    "id": "hero_fighter_01",
    "type": "hero",
    "name": "Placeholder Fighter",
    "class": "fighter",
    "rollRequirement": 7,
    "copies": 1,
    "text": "Roll 7+: Each other player must DISCARD a card.",
    "effect": {
      "op": "forEach",
      "players": "other",
      "effect": { "op": "discard", "who": "self", "amount": 1, "chosenBy": "self" }
    }
  }
]
```

```json
// modifiers.json
[
  { "id": "mod_01", "type": "modifier", "name": "Modifier +2/-2",
    "copies": 9, "options": [2, -2], "text": "+2 or -2 to any roll." },
  { "id": "mod_02", "type": "modifier", "name": "Modifier +4",
    "copies": 4, "options": [4], "text": "+4 to any roll." }
]
```

```json
// monsters.json
[
  {
    "id": "monster_01",
    "type": "monster",
    "name": "Placeholder Beast",
    "copies": 1,
    "requirement": { "kind": "heroCount", "min": 2 },
    "slayAt": 8,
    "defeatAt": 4,
    "penalty": { "op": "sacrifice", "who": "self", "amount": 1 },
    "reward": { "hook": "modifyRollTotal", "condition": { "rollKind": "heroEffect" }, "value": 1 },
    "text": "Requires 2 heroes. 8+ to slay. 4- : SACRIFICE a hero. Reward: +1 to hero rolls."
  }
]
```

Note: inside a `forEach`, `"self"` refers to the player being iterated over. The interpreter must bind `self` per iteration.

### 5.7 Card loading
- `packages/cards/src/schema.ts` defines Zod schemas for every card type.
- On startup, the loader validates all JSON files and **fails loudly** on any error.
- `buildDeck(defs)` expands `copies` into instances with unique `CardInstanceId`s.

---

## 6. Rules Engine Architecture

### 6.1 Core API

```ts
// packages/engine/src/index.ts
export function createGame(opts: {
  players: { id: PlayerId; name: string; isBot: boolean }[];
  seed: string;
  config?: Partial<RuleConfig>;
  cardDefs: CardDef[];
}): GameState;

export function getLegalActions(state: GameState, playerId: PlayerId): Action[];

export function applyAction(state: GameState, action: Action): ApplyResult;

export interface ApplyResult {
  ok: boolean;
  state: GameState;          // unchanged if !ok
  error?: string;
  events: GameEvent[];       // for animations and logs
}

export function getPlayerView(state: GameState, playerId: PlayerId | "spectator"): PlayerView;
```

Properties of `applyAction`:
- **Pure:** never mutates its input. Use Immer (`produce`) internally for convenience.
- **Validating:** rejects illegal actions with an error and leaves state unchanged.
- **Event-producing:** returns semantic events such as `CARD_DRAWN`, `DICE_ROLLED`, `HERO_STOLEN`, and `MONSTER_SLAIN`. The client animates these events; it does not diff states.

### 6.2 Actions

```ts
export type Action =
  // Turn actions (active player, phase = "action")
  | { type: "DRAW_CARD"; player: PlayerId }
  | { type: "PLAY_HERO"; player: PlayerId; card: CardInstanceId }
  | { type: "PLAY_ITEM"; player: PlayerId; card: CardInstanceId; targetHero: CardInstanceId }
  | { type: "PLAY_MAGIC"; player: PlayerId; card: CardInstanceId }
  | { type: "ROLL_HERO_EFFECT"; player: PlayerId; hero: CardInstanceId }
  | { type: "ATTACK_MONSTER"; player: PlayerId; monster: CardInstanceId }
  | { type: "DISCARD_AND_REDRAW"; player: PlayerId }
  | { type: "END_TURN"; player: PlayerId }
  // Responses (any player, during a response window)
  | { type: "PLAY_CHALLENGE"; player: PlayerId; card: CardInstanceId }
  | { type: "PLAY_MODIFIER"; player: PlayerId; card: CardInstanceId; value: number }
  | { type: "PASS"; player: PlayerId }
  // Answers to prompts
  | { type: "RESOLVE_DECISION"; player: PlayerId; decisionId: string; answer: DecisionAnswer };
```

### 6.3 Phase state machine

```
            ┌──────────┐
            │  SETUP   │  leader selection, deal, first player
            └────┬─────┘
                 ▼
          ┌─────────────┐
   ┌─────►│ TURN_START  │  start-of-turn hooks, reset AP & roll flags
   │      └──────┬──────┘
   │             ▼
   │      ┌─────────────┐   action declared   ┌──────────────┐
   │      │   ACTION    │────────────────────►│  RESOLVING   │
   │      │ (await act) │◄────────────────────│ (stack non-  │
   │      └──────┬──────┘   stack empty       │   empty)     │
   │             │ AP = 0 or END_TURN         └──────────────┘
   │             ▼
   │      ┌─────────────┐
   │      │  TURN_END   │  hand limit discard, end-of-turn hooks
   │      └──────┬──────┘
   └─────────────┘
                 │ win condition met (checked after every step)
                 ▼
            ┌──────────┐
            │ GAME_OVER│
            └──────────┘
```

```ts
export type Phase =
  | { kind: "setup"; step: "leaderSelect" | "firstPlayerRoll" }
  | { kind: "turnStart" }
  | { kind: "action" }
  | { kind: "resolving" }   // stack is processing
  | { kind: "turnEnd" }
  | { kind: "gameOver" };
```

After AP reaches 0, the turn does **not** end until the stack is empty and no decision is pending.

### 6.4 Pending decisions (the prompt system)

Every point where a human must choose becomes a `PendingDecision`. The engine stops and waits for a `RESOLVE_DECISION` action.

```ts
export interface PendingDecision {
  id: string;                 // unique, from RNG-free counter
  player: PlayerId;           // who must answer
  kind:
    | "choosePlayer"
    | "chooseHero"
    | "chooseCardsFromHand"
    | "chooseCardsFromList"   // e.g. search discard
    | "chooseOption"          // effect choice / modifier option
    | "confirmOptional"       // "you may..."
    | "chooseLeader";
  prompt: string;             // UI text
  options: DecisionOption[];  // legal choices, precomputed by engine
  min: number;                // number of selections
  max: number;
  context: Record<string, unknown>; // for resuming the effect
}
```

**Rules:**
- The engine precomputes **all legal options**. The client only renders them, and bots pick from them.
- If exactly one legal option exists and `min === max === 1`, auto-resolve it. Make this a user setting; it's on by default for bots.
- If no legal options exist, skip the step. For example, "steal a hero" when nobody has heroes does nothing.

### 6.5 Effect interpreter

Effects can pause in the middle for decisions and for modifier windows on rolls. The interpreter must therefore be **resumable**. Two acceptable designs:

**Option A: explicit continuation stack (recommended).** Each `StackFrame` stores the effect node and a program counter. The interpreter steps frames until one needs input, then sets `pendingDecision` and returns. `RESOLVE_DECISION` stores the answer in the frame and continues.

**Option B: generator functions.** Effects are `function*` that `yield` decision requests. This is elegant, but generators **cannot be serialised**, which breaks save/load, reconnection, and replays. Only use it if state is rebuilt by replaying actions (Section 8.3).

Use Option A unless there is a strong reason not to.

```ts
export interface EffectFrame {
  kind: "effect";
  effect: Effect;
  pc: number;                         // step index within sequence
  controller: PlayerId;               // who "you" is
  bindings: Record<string, unknown>;  // chosen players/cards so far
  source: CardInstanceId;             // card that caused this effect
}
```

---

## 7. Response Windows, Challenges, Modifiers & the Stack

This is the most complex part of the game. Build it carefully, with many tests.

### 7.1 Stack frame types

```ts
export type StackFrame =
  | EffectFrame
  | { kind: "cardPlay"; card: CardInstanceId; player: PlayerId; action: Action; challenged: boolean }
  | { kind: "challengeWindow"; cardPlayFrameIndex: number; passed: PlayerId[] }
  | { kind: "challengeDuel"; challenger: PlayerId; defender: PlayerId;
      challengerRoll?: RollFrameRef; defenderRoll?: RollFrameRef }
  | { kind: "roll"; rollId: string; roller: PlayerId; rollKind: RollKind;
      dice: [number, number] | null; modifiers: AppliedModifier[];
      passed: PlayerId[]; onComplete: RollCompletion }
  | { kind: "monsterAttack"; player: PlayerId; monster: CardInstanceId };

export type RollKind = "heroEffect" | "monsterAttack" | "challenge" | "firstPlayer";

export interface AppliedModifier { player: PlayerId; card: CardInstanceId; value: number }
```

The top of the stack is the last element. The engine always processes the top frame.

### 7.2 Flow: playing a Hero card

```
1. P1 declares PLAY_HERO (AP −1). Card moves hand → "limbo" (not in party yet).
2. Push cardPlay frame.
3. Push challengeWindow frame. Every other player with a Challenge card in hand
   gets a response opportunity (Section 7.4).
4a. All pass → pop window → resolve cardPlay: hero enters party.
    If freeRollOnHeroPlay, offer P1 confirmOptional "Roll for this hero's effect?"
4b. P2 plays Challenge → pop window → push challengeDuel.
    - Push roll frame for challenger (modifier window opens after dice).
    - Push roll frame for defender.
    - Compare totals. Challenger wins → card to discard, cardPlay marked failed.
      Defender wins → resolve cardPlay normally.
5. Check win conditions.
```

### 7.3 Flow: any roll

```
1. Push roll frame. Engine rolls 2d6 using RNG → dice set; LOG + DICE_ROLLED event.
2. Add passive bonuses (getRollBonus).
3. Open modifier window: every player who holds a Modifier card may respond.
4. Any player plays a Modifier → append to modifiers, discard the card,
   RESET the passed list (everyone gets to respond again to the new total).
5. When all eligible players have passed consecutively → total is final.
6. Pop frame, call onComplete with final total:
   - heroEffect:     total ≥ requirement → push EffectFrame for hero's effect
   - monsterAttack:  slay / penalty / nothing
   - challenge:      store result in challengeDuel frame
```

**Step 4 matters.** Without resetting the passed list, the last player to respond could never be answered.

### 7.4 Who gets asked in a response window?

Modes, set by the user:
- **Only players who hold a usable card get asked.** This is faster, but **it leaks information**: if the game pauses for P3, everyone knows P3 holds a Challenge.
- **Everyone gets asked every time, with a timer.** This hides information but is slower.

Recommended default:
- **Online:** ask everyone. Players who hold no usable card auto-pass after a short, **randomised** delay of 0.5–2.5 seconds so that timing reveals nothing. ⚙️ `responseWindowMs` for real players.
- **Hot-seat:** ask only players who hold usable cards, since nothing is hidden at a shared screen anyway.
- **Bot-only games:** resolve instantly.

### 7.5 Ordering when several players respond at once

On the server, the **first valid message received wins** priority. After any response, the window reopens to everyone (step 4 above). For hot-seat play, ask players in turn order starting after the active player.

### 7.6 Edge cases to test
- A modifier played on a challenge roll during a challenge against an item.
- A hero effect that causes another roll (nested roll frames).
- A challenge against a Magic card that would have won the game.
- The deck runs out during a draw-2 (reshuffle mid-effect).
- The hero performing an effect is stolen mid-effect (the effect still completes; the controller stays the same).
- A player is disconnected during their response window (timeout counts as a pass).
- A win condition is reached during an opponent's turn, for example by stealing a hero back.

---

## 8. Randomness, Determinism & Replays

### 8.1 Seeded RNG
Use a small serialisable PRNG such as **mulberry32** or **xoshiro128\*\***. Its state lives inside `GameState.rng`, so it is saved and restored with the game.

```ts
export interface RngState { seed: string; s: [number, number, number, number] }
export function nextFloat(rng: RngState): [number, RngState];
export function rollD6(rng: RngState): [number, RngState];
export function shuffle<T>(arr: T[], rng: RngState): [T[], RngState]; // Fisher–Yates
```

All of these return a new RNG state (pure functions). **Never** call `Math.random()` inside the engine. Add a lint rule to enforce this.

### 8.2 Determinism contract
`createGame(seed) + [action1, action2, ...] → identical final state, every time, on every machine.`

### 8.3 Replays and save/load
- Store `{ seed, config, players, cardDefsVersion, actions[] }`. This is a full replay in a few kilobytes.
- Save/load can serialise the `GameState` JSON directly, or replay the action list.
- Use replays to debug: when a bug appears, export the action log and write a failing test from it.

---

## 9. Hidden Information & Per-Player Views

The full `GameState` is **never** sent to clients. The server sends `getPlayerView(state, playerId)`:

| Data | Owner sees | Others see |
|---|---|---|
| Own hand | Full cards | Card count only |
| Other hands | — | Card count only |
| Main deck | Count | Count |
| Monster deck | Count | Count |
| Discard pile | Full (public) | Full (public) |
| Parties, items, leaders | Full | Full |
| Slain monsters | Full | Full |
| RNG state | **Never sent** | **Never sent** |
| Pending decision | Full if it's theirs | "Waiting for P2 to choose…" |
| Cards seen via LOOK effects | Shown in their decision prompt only | — |

Card instances in hands are **redacted**. Other players get placeholder IDs, so they cannot track a specific card instance as it moves around.

Events are filtered the same way: `CARD_DRAWN` shows the card to the drawer and only "P1 drew a card" to everyone else.

---

## 10. Multiplayer Server

### 10.1 Architecture

```
 Browser A ─┐                         ┌──────────────────────┐
 Browser B ─┼── WebSocket (JSON) ───► │  Node game server     │
 Browser C ─┘                         │  ├─ RoomManager       │
                                      │  ├─ Room (per game)   │
                                      │  │   ├─ GameState     │
                                      │  │   ├─ engine        │
                                      │  │   ├─ timers        │
                                      │  │   └─ bots          │
                                      │  └─ persistence (opt) │
                                      └──────────────────────┘
```

- One `Room` per game. The room holds the authoritative `GameState`.
- The server is the **only** place where `applyAction` runs for real. Clients may run it locally for optimistic previews, but this is not required in v1.
- Bots run on the server inside the room.

### 10.2 Protocol (validated with Zod on both ends)

Client to server:

```ts
type ClientMsg =
  | { t: "createRoom"; name: string; config?: Partial<RuleConfig> }
  | { t: "joinRoom"; roomCode: string; name: string }
  | { t: "addBot"; difficulty: "easy" | "normal" }
  | { t: "startGame" }
  | { t: "action"; action: Action; clientSeq: number }
  | { t: "reconnect"; roomCode: string; token: string }
  | { t: "chat"; text: string };
```

Server to client:

```ts
type ServerMsg =
  | { t: "roomState"; roomCode: string; players: LobbyPlayer[]; you: PlayerId; token: string }
  | { t: "gameView"; view: PlayerView; version: number }
  | { t: "events"; events: GameEvent[]; version: number }
  | { t: "actionRejected"; clientSeq: number; error: string }
  | { t: "error"; message: string };
```

### 10.3 Key behaviours
- **Versioning:** every state change increments `version`. A client that misses a version requests a full `gameView`.
- **Identity:** the server, not the client, sets `action.player` from the socket's identity, so a client cannot act as another player.
- **Timers:** response windows and decisions have server-side timeouts. On timeout, response windows auto-pass and decisions pick a default (the first legal option, or a random one for discards).
- **Reconnection:** `token` identifies a returning player. Their seat is held for 2 minutes; after that, a bot takes over.
- **Room codes:** 5 characters, easy to read aloud (no 0/O/1/I).

### 10.4 Hosting for a personal project
- Run the server locally and share it with friends via a tunnel (Cloudflare Tunnel, ngrok), or deploy to a small free or cheap Node host such as Fly.io, Render, or Railway.
- Keep rooms in memory. Persistence is optional: write replays to disk when a game ends.

---

## 11. AI Opponents

All bots implement one interface and only ever choose from `getLegalActions` or `pendingDecision.options`:

```ts
export interface Bot {
  chooseAction(view: PlayerView, legal: Action[]): Action;
  // view = the bot's own redacted view; bots must not cheat
}
```

### 11.1 Easy bot (Milestone 6)
Rules in priority order:
1. If it can attack a monster and has a decent chance (at least 40% after bonuses), attack.
2. Play a Hero of a class it doesn't have yet.
3. Roll unused heroes whose requirement is achievable.
4. Play an Item on its best hero, or a Cursed item on the leading opponent's hero.
5. Play Magic.
6. Draw.

Responses:
- Challenge a card if the player who played it is close to winning, or randomly 20% of the time.
- Play modifiers to push its own rolls over the threshold, or push the leader's rolls under it.

Decisions: target the player closest to winning.

### 11.2 Normal bot (later)
- Heuristic scoring: give each state a score based on classes owned, monsters slain, hand size, and the opponents' progress. Simulate each legal action one step ahead and pick the best.
- Use exact 2d6 probabilities from a precomputed table (below).

### 11.3 Hard bot (stretch)
- **Information-set Monte Carlo Tree Search (IS-MCTS).** Sample possible hidden hands consistent with what the bot knows, run simulated playouts with the easy bot's policy, and choose the action with the best average result. This works well with the deterministic engine, because playouts call `applyAction` directly.

### 11.4 2d6 probability table (P(total ≥ n))

| n | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| % | 100 | 97.2 | 91.7 | 83.3 | 72.2 | 58.3 | 41.7 | 27.8 | 16.7 | 8.3 | 2.8 |

---

## 12. Client UI Architecture

### 12.1 Layout (desktop)

```
┌────────────────────────────────────────────────────────────┐
│  Opponent 1 (party + hand count)   Opponent 2   Opponent 3 │
├────────────────────────────────────────────────────────────┤
│                                                            │
│   [Monster] [Monster] [Monster]     Deck(42)  Discard      │
│                                                            │
│   ── Prompt / response bar: "P2 may Challenge (6s)" ──     │
├────────────────────────────────────────────────────────────┤
│  Your Party: [Leader] [Hero+Item] [Hero] ...               │
│  AP: ●●○   [Draw] [Attack] [Redraw] [End Turn]             │
│  Your Hand: [card][card][card][card][card]                 │
├────────────────────────────────────────────────────────────┤
│  Game log (collapsible)                                    │
└────────────────────────────────────────────────────────────┘
```

### 12.2 Principles
- **The UI only renders `PlayerView` and sends `Action`s.** It contains no game rules.
- **Drive interaction from legal actions:** highlight only playable cards, valid targets, and attackable monsters. Disabled elements show a tooltip explaining why ("Needs 2 heroes").
- **Render `pendingDecision`** as a modal or inline selection with its options.
- **Queue animations:** incoming `GameEvent`s go into an animation queue and play in order (dice roll, card fly, flip). Update the view after each event's animation, or use a "skip animations" toggle.
- **Response windows** show a large, clear bar with a countdown, the eligible cards, and a Pass button.
- **Hot-seat mode** shows a "Pass the device to P2" screen that hides the hand between players.

### 12.3 Component list

```
<App>
 ├ <Lobby/>                  create/join room, add bots, rules config
 └ <GameScreen>
    ├ <OpponentArea/> ×N
    ├ <CenterArea>  <MonsterRow/> <DeckPile/> <DiscardPile/> <DiceTray/>
    ├ <ResponseBar/>          challenge/modifier window + countdown
    ├ <DecisionModal/>        renders pendingDecision
    ├ <PlayerArea>  <Party/> <ActionBar/> <Hand/>
    ├ <CardView/>             single card; zoom on hover/long-press
    ├ <GameLog/>
    └ <GameOverScreen/>
```

### 12.4 Card rendering
Render cards with HTML/CSS (title, class icon, roll number, text) so placeholder data looks reasonable before any art exists. Art, if added, is an optional image layer on top.

---

## 13. Testing Strategy

| Level | What | Tool |
|---|---|---|
| Unit | Every effect primitive, selector, requirement check, RNG function | Vitest |
| Phase | Every phase transition; AP accounting; hand limit | Vitest |
| Stack | All flows in Sections 7.2, 7.3, and every edge case in 7.6 | Vitest |
| Scenario | Hand-built states plus action lists with an expected outcome | Vitest |
| Property / fuzz | Random bots play 10,000 seeded games; assert invariants | Vitest |
| Replay | Saved replays of past bugs, kept as regression tests | Vitest |
| E2E | Create a room, two browser clients, play to game over | Playwright |

### 13.1 Invariants (checked after every action in fuzz tests)
- Total card count across all zones never changes. No card is duplicated or lost.
- Each card instance is in exactly one zone.
- `actionPoints` is between 0 and the maximum.
- Each hero holds at most one item.
- A player with `winner` set means the phase is `gameOver`.
- `getLegalActions` never returns an action that `applyAction` rejects.
- Every game ends within N actions (no infinite loops).

### 13.2 Scenario test helper

```ts
const s = scenario()
  .players(2)
  .hand("p1", ["hero_thief_01", "mod_01"])
  .party("p2", ["hero_wizard_01"])
  .nextDice([6, 5])            // force RNG outcome for the test
  .build();

const r = run(s, [
  { type: "PLAY_HERO", player: "p1", card: "hero_thief_01#0" },
  { type: "PASS", player: "p2" },
  // ...
]);
expect(r.state.players[0].party).toHaveLength(2);
```

The `nextDice` helper requires an RNG override hook that is only available in tests.

---

## 14. Milestones & Acceptance Criteria

**M0: Project skeleton**
- Monorepo, TypeScript strict mode, Vitest, ESLint (no `Math.random` in engine), CI script.
- ✅ `pnpm test` runs and passes an empty test.

**M1: Cards & state**
- Zod schemas, JSON loader, placeholder card data, `createGame`, seeded RNG, setup phase.
- ✅ The same seed produces an identical initial state. Invalid card JSON fails with a clear error.

**M2: Basic turn loop, no interrupts**
- AP system and the actions DRAW, PLAY_HERO, PLAY_ITEM, PLAY_MAGIC, ROLL_HERO_EFFECT, ATTACK_MONSTER, DISCARD_AND_REDRAW, END_TURN. Hand limit. Win conditions. Deck reshuffle.
- Effect interpreter with the primitives draw, discard, steal, destroy, sacrifice, pull, and the pending decision system.
- ✅ Two scripted players can play a full game to a win in a test. Fuzz invariants hold over 1,000 random games.

**M3: Interrupts**
- Stack, challenge windows, challenge duels, modifier windows, nested rolls.
- ✅ All flows in Section 7 and the edge cases in 7.6 have passing tests. Fuzz holds over 10,000 games.

**M4: Hot-seat client**
- React UI rendering `PlayerView`, the legal-action highlighting, decision modal, response bar, game log, pass-device screen. The engine runs in the browser.
- ✅ Two to four people can finish a game on one computer without consulting the code.

**M5: Online multiplayer**
- WebSocket server, rooms, per-player views, timers, reconnection.
- ✅ Three browsers on different machines finish a game. Refreshing a page mid-game reconnects to the same seat.

**M6: Bots**
- Easy bot. Bots fill empty seats in local and online games.
- ✅ A human versus three easy bots finishes without stalls. 1,000 all-bot games finish with no errors.

**M7: Polish**
- Animations, sounds, card zoom, rules reference screen, settings (animation speed, auto-resolve), replay export and import.
- ✅ A playtest with friends produces no blocking confusion.

**M8 (optional): Real card data and art**
- The owner enters real card data from their physical copy. Card art stays local and private.

---

## 15. Rules to Verify Against the Physical Rulebook

Defaults are in place, but the owner should check these against the printed rules and update the config:

1. **Challenge tie:** does the challenger or the challenged player win on equal totals? (`challengeTieWinner`)
2. **Free roll on hero play:** does playing a Hero let you immediately roll its effect within the same action? (`freeRollOnHeroPlay`)
3. **Start-of-turn draw:** is there a free draw at the start of each turn? (`drawAtStartOfTurn`)
4. **Leader for monster requirements:** does the Party Leader count toward requirements such as "2 heroes" or "1 Fighter"? (`leaderCountsForRequirements`)
5. **AP refund:** is AP lost when a played card is successfully challenged? (Assumed lost.)
6. **Stolen hero's roll flag:** can a stolen hero be rolled again by its new owner in the same turn? (`rollFlagFollowsHero`)
7. **Stolen hero's item:** does the item move with a stolen hero? (`itemFollowsStolenHero`)
8. **Modifier timing:** can modifiers be played after other modifiers in any order until everyone passes? (Assumed yes.)
9. **Monster replacement timing:** is a new monster revealed immediately after a slay, or at end of turn? (Assumed immediately.)
10. **Empty monster deck:** what happens? (Assumed: the slot stays empty.)
11. **Mid-effect win:** does the game end the instant a win condition is met, even on another player's turn? (`winCheckTiming`)
12. **Hand-limit discard:** chosen by the player? (Assumed yes.)

When a rule is confirmed, update the default value in `config/defaults.ts` and remove it from this list.

---

**End of document.**
