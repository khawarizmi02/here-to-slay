# Here to Slay Digital — Technical Design Document

**Version:** 1.1 · **Date:** 31 Oct 2026 · **Status:** Personal, non-commercial project

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
8. Use the vocabulary in `GLOSSARY.md` (Room, Host, Room Code, Seat). Architectural decisions are recorded in `docs/adr/`; read them before changing the multiplayer design.

---

## 1. Project Overview

### 1.1 Goal
A playable digital implementation of the *Here to Slay* base game for 2–6 players. It supports hot-seat play, online play with friends, and AI opponents, mixed freely in one Room.

### 1.2 Scope (v1)
- Base game only: 6 classes (Bard, Fighter, Guardian, Ranger, Thief, Wizard).
- All card types: Party Leader, Hero, Item (including Cursed and Mask items), Magic, Modifier, Challenge, Monster.
- Local hot-seat, online private Rooms, and AI bots. One Room can mix local, remote, and bot Seats.
- Desktop browser first, with a responsive layout that works acceptably on tablets.

### 1.3 Non-goals (v1)
- Expansions. The architecture must allow them later; see Section 5.5.
- Accounts, matchmaking, rankings, or monetisation.
- A dedicated game server. The Host's browser runs the game (see ADR-0001).
- Hiding information from the Host. The Host's tab holds the full state and could inspect it with dev tools; this is accepted for a friends-only game.
- Mobile app store builds.
- Public distribution of the official art or text.

### 1.4 Design principles
- **Deterministic engine:** the same seed and the same action list always produce the same game.
- **Host-authoritative:** the Host's Room is the only place outcomes are decided. Other clients only send actions and render their own redacted view.
- **Data-driven cards:** new cards should mostly be JSON, not code.
- **Every pause is a prompt:** whenever the game needs a player's input, it creates an explicit `PendingDecision` object. There are no hidden waits.

---

## 2. Tech Stack & Repository Structure

### 2.1 Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict mode) | Shared types across engine, Room, relay, and client |
| Monorepo | pnpm workspaces | Simple package sharing |
| Engine | Pure TS package | Testable, runs in the Host's browser and in tests |
| Validation | Zod | Validates card JSON and network messages |
| Client | React + Vite | Fast dev loop |
| Client state | Zustand | Lightweight |
| Animation | Framer Motion | Card movement and flips |
| Room | Pure TS package (no DOM) | Owns state, timers, bots, Seats; runs in the Host's browser and in tests |
| Relay | Cloudflare Worker + Durable Objects (WebSocket) | Forwards messages between the Host and friends; no game logic; free tier; `wrangler dev` locally |
| Host persistence | IndexedDB | Action log survives a Host refresh |
| Tests | Vitest | Fast, TS-native |
| E2E tests | Playwright | Full game flows in the browser |

> **Why not boardgame.io or Colyseus:** both assume a framework-owned server and their own state-sync model. Here to Slay's nested interrupts (challenges and modifiers on rolls within effects) need fine control, and the Host-plus-relay topology (Section 10) doesn't fit either framework.

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
│  ├─ protocol/            # Client/Host/relay message types + Zod schemas
│  ├─ room/                # Room: Seats, timers, bots, response windows, action log
│  │  └─ src/connection/   # GameConnection, LocalConnection, RelayConnection
│  ├─ relay/               # Cloudflare Worker + Durable Object (message router only)
│  └─ client/              # React app (also hosts the Room when this tab is the Host)
├─ docs/
│  ├─ adr/                 # Architecture decision records
│  └─ TECHNICAL_DESIGN.md  # This document
├─ GLOSSARY.md
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
1. Shuffle the main deck and deal 5 cards to each player.
2. Each player receives a Party Leader. Modes: random, or draft in Seat order (the order of `createGame`'s `players`), because turn order doesn't exist yet. ⚙️ `leaderSelection`
3. Shuffle the monster deck and reveal 3 monsters face-up in the centre.
4. Choose the first player. Default: every player rolls 2d6 at once, highest goes first, and players tied for highest reroll. The first-player roll never opens a Modifier Window. `"firstSeat"` makes the first player in `players` go first (the Room seats the Host first, so this means the Host goes first). ⚙️ `firstPlayerMethod`
5. Turn order is clockwise from the first player.

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
- When a monster is slain, it moves to the player's slain pile, and a new monster is revealed from the monster deck straight away.
- If the monster deck is empty, the slot stays empty. A class win is still possible.

### 3.6 Modifier cards
- Any player, including the roller, may play Modifier cards on **any roll**: hero effects, monster attacks, and challenge rolls. The first-player roll takes no modifiers.
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
- **Items:** each hero can hold at most one item. When a hero leaves a party (destroyed or sacrificed), its item goes to the discard pile. When a hero is stolen, its item moves with it; with the flag off, the item goes to the discard pile instead. ⚙️ `itemFollowsStolenHero` (default `true`)
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
  firstPlayerMethod: "roll" | "random" | "firstSeat"; // "roll"
  responseWindowMs: number;            // 8000 (remote Seats only; local Seats have no countdown)
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
  leaderPool: CardInstanceId[];          // Party Leaders nobody has; never shown

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

export type PlayerFilter =
  | "any" | "other" | "self"
  | "withHeroes" | "withCards"            // include the controller
  | "otherWithHeroes" | "otherWithCards"; // exclude the controller

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

- An item's passive applies to rolls only when the hero wearing it is the one rolling. At other hooks it applies to the whole party of the hero's owner, including a Cursed item on an opponent's hero.
- A trigger passive runs as an effect on the stack, controlled by the passive's owner. `beforeRoll` runs before the dice, `afterRoll` right after them (before a successful hero's effect), `onHeroEnterParty` and `onHeroLeaveParty` as a hero joins or leaves a party, and `onCardPlayed` once the played card has resolved.

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
      "from": { "choose": "otherWithHeroes" },
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

Note: a `discard` whose `chosenBy` is not the discarding player takes each card at random with the engine's RNG, because a Decision only lists cards its chooser can see (§6.4). The placeholder set always has players choose their own discards.

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

`getLegalActions`, `applyAction` and `getPlayerView` read card definitions (for passives such as `modifyActionCost`), and card definitions never live in `GameState`. So the engine exports only `createGame` and `createRoomEngine`; the bound functions above are the methods of the object `createRoomEngine` returns.

The Room uses the engine through `createRoomEngine(cardDefs)`, which binds the card definitions and returns an object matching the Room's `RoomEngine` interface without importing `packages/room`. Its `cardDefsVersion` is a hash of the card definitions (ADR-0003). `createGame` validates the Room's config patch with a strict schema and throws on an unknown key or a wrong type.

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
  | { type: "PLAY_MODIFIER"; player: PlayerId; card: CardInstanceId; value: number; roll?: string } // roll id; needed when a Modifier Window holds two rolls (a Challenge)
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
  | { kind: "setup"; step: "leaderSelect" }
  | { kind: "action" }
  | { kind: "resolving" }                   // something is on the stack
  | { kind: "turnEnd"; discarded: number } // waiting on hand-limit discards; `discarded` counts picks so far
  | { kind: "gameOver" };
```

Only phases that can wait on a player are stored. The first-player roll, the start of a turn, and an end of turn with no discard to make need no input, so they run straight through and no state is ever left in them. The phase is `resolving` while anything is on the stack, and goes back to `action` once the stack is empty.

At the end of a turn, end-of-turn hooks run first and then the hand-limit discard, so nobody passes the turn over the limit. Each discard is one Decision ("Discard down to your hand limit of 7 (1 of 2)").

After AP reaches 0, the turn does **not** end until the stack is empty and no decision is pending.

### 6.4 Pending decisions (the prompt system)

Every point where a human must choose becomes a `PendingDecision`: one **Decision** (see `GLOSSARY.md`). Every Decision is exactly one pick. Choosing several cards is a chain of Decisions, one per card ("Choose a card to discard (1 of 3)"), so `getLegalActions` lists one `RESOLVE_DECISION` per option and never has to list combinations. The engine stops and waits for a `RESOLVE_DECISION` action.

```ts
export interface PendingDecision {
  id: string;                 // unique, from RNG-free counter
  player: PlayerId;           // who must answer
  kind:
    | "choosePlayer"
    | "chooseHero"
    | "chooseCardFromHand"
    | "chooseCardFromList"    // e.g. search discard
    | "chooseOption"          // effect choice / modifier option
    | "confirmOptional"       // "you may..."
    | "chooseLeader";
  prompt: string;             // UI text
  options: DecisionOption[];  // legal choices, precomputed by engine
  context: Record<string, unknown>; // for resuming the effect
}
```

**Rules:**
- The engine precomputes **all legal options**. The client only renders them, and bots pick from them.
- An option's id is the id of the thing chosen (a player id or card instance id). Options only ever list things the chooser can see.
- A "you may" Decision has an explicit Decline option.
- **Option order is a rule**, because the Room answers a timed-out remote Seat's Decision with the first legal answer, or a random one when `isDiscardDecision` is true. Decline comes first in every "you may" Decision. Other options are listed players in turn order, then cards by instance id. `isDiscardDecision` is true for any pick that gives up the chooser's own card (discard, hand-limit discard, sacrifice).
- If exactly one legal option exists, auto-resolve it. Make this a user setting; it's on by default for bots.
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
    - Challenger and defender both roll, then one Modifier Window opens on both rolls.
      Each PLAY_MODIFIER names the roll it targets (`roll`). RULE-CHECK: Section 15.
    - When everyone has passed, compare totals. Challenger wins → card to discard, cardPlay marked failed.
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

The rule is chosen **per Seat**, because one Room can mix Seat types:
- **Remote Seat:** always asked. If the player holds no usable card, the Room auto-passes for them after a short, **randomised** delay of 0.5–2.5 seconds so that timing reveals nothing. Players who do hold a usable card get a countdown. ⚙️ `responseWindowMs`
- **Local Seat** (on the Host's device): only interrupted if they hold a usable card. The Room shows a "Pass the device to P3" screen with **no countdown** until P3 confirms. Players at a shared table already see who reaches for the device, so nothing extra leaks.
- **Bot Seat:** decides immediately, but its response is held back by the same randomised delay whenever a remote Seat is in the Room.
- **Rooms with only bots, or only local Seats and bots:** no artificial delays.

Remote players waiting on a local Seat just see "Waiting for responses…".

### 7.5 Ordering when several players respond at once

The Room processes messages one at a time in arrival order, so the **first valid response the Host receives wins** priority. After any response, the window reopens to everyone (step 4 above). Local Seats are asked in turn order starting after the active player, interleaved with remote responses as they arrive.

### 7.6 Edge cases to test
- A modifier played on a challenge roll during a challenge against an item.
- A hero effect that causes another roll (nested roll frames).
- A challenge against a Magic card that would have won the game.
- The deck runs out during a draw-2 (reshuffle mid-effect).
- The hero performing an effect is stolen mid-effect (the effect still completes; the controller stays the same).
- A player is disconnected during their response window (timeout counts as a pass, and is logged as a `PASS` action).
- The Host refreshes mid-response-window (the replayed log restores the window; its deadline restarts).
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

The full `GameState` exists only in the Host's Room and is **never** sent over the network. The Room sends each Seat `getPlayerView(state, playerId)`. The Host's own UI also renders only the Host's `PlayerView`, even though the full state is in the same tab:

| Data | Owner sees | Others see |
|---|---|---|
| Own hand | Full cards | Card count only |
| Other hands | — | Card count only |
| Main deck | Count | Count |
| Monster deck | Count | Count |
| Discard pile | Full (public) | Full (public) |
| Parties, items, leaders | Full | Full |
| Slain monsters | Full | Full |
| RNG state | **Never sent** (in the Host's tab only) | **Never sent** |
| Pending decision | Full if it's theirs | "Waiting for P2 to choose…" |
| Cards seen via LOOK effects | Shown in their decision prompt only | — |
| Legal actions | Full, in `legalActions` | — |

Other players' hands appear **only as a count**, with no card ids, so nobody can track a card instance as it moves around. PULL takes a random card using the engine's RNG, with no Decision; `CARD_PULLED` shows the card only to the two players involved. Cards shown by LOOK or a search appear only in that player's Decision.

Every `PlayerView` carries a public `responseWindow: { kind: "challenge" | "modifier"; awaiting: PlayerId[] } | null`. The engine offers `PASS` to everyone in a window, whatever they hold, and the Room decides whom to interrupt (Section 7.4).

Events are filtered the same way: `CARD_DRAWN` shows the card to the drawer and only "P1 drew a card" to everyone else.

Every `PlayerView` carries `legalActions: Action[]`, filled from `getLegalActions` for that player (`[]` for a spectator). `getLegalActions` needs the full state, which only the Host's tab has, so this is how a client learns what its player may do without containing any game rules.

---

## 10. Multiplayer: Host, Relay & Connections

See ADR-0001 for why there is no dedicated game server.

### 10.1 Architecture

```
 Friend's browser ─┐                                    ┌── Host's browser tab ──────────────────┐
 Friend's browser ─┼── WebSocket ──► Relay ◄── WebSocket┤  Room                                  │
                   │                (Cloudflare Worker, │  ├─ GameState (full, unredacted)       │
                   │                 1 Durable Object   │  ├─ engine                             │
                   │                 per Room Code;     │  ├─ Seats: local / remote / bot        │
                   │                 no game logic)     │  ├─ timers (deadline timestamps)       │
                   │                                    │  ├─ bots                               │
                   │                                    │  └─ action log → IndexedDB             │
                   │                                    │  Host's own UI ◄─ LocalConnection      │
                   │                                    └────────────────────────────────────────┘
```

- One **Room** per game. It runs in the **Host's** browser tab and holds the authoritative `GameState`.
- The Room is the **only** place where `applyAction` runs for real.
- Bots and timers run inside the Room.
- The **relay** forwards messages and stamps each one with the sender's identity. It never reads the game messages it forwards.
- The `Room` class has no DOM or network dependencies, so tests run it directly (Section 13).

### 10.2 Seats

Each Seat in a Room has one kind:

| Seat kind | Where the player is | Connection |
|---|---|---|
| `local` | At the Host's device (hot-seat) | `LocalConnection` |
| `remote` | In another browser | `RelayConnection` via the relay |
| `bot` | Inside the Room | None; the Room calls the bot directly |

The Host is always a `local` Seat. A Room can mix all three kinds. Pure hot-seat and pure online games are just special cases.

### 10.3 Client connection interface

Every UI, whether it's the Host's or a friend's, talks to its Room through one interface:

```ts
export interface GameConnection {
  send(msg: ClientMsg): void;
  onMessage(cb: (msg: RoomMsg) => void): () => void; // returns unsubscribe
  close(): void;
}
```

- `LocalConnection`: calls the Room in the same tab directly. The Host's UI and hot-seat play use it.
- `RelayConnection`: a WebSocket to the relay. Friends use it.

The client UI never knows which one it has.

### 10.4 Game protocol (Seat ↔ Room, validated with Zod in the Room)

The Room validates every incoming message, because a friend's client could send anything.

Seat to Room:

```ts
type ClientMsg =
  | { t: "joinRoom"; name: string }
  | { t: "addBot"; difficulty: "easy" | "normal" }        // Host only
  | { t: "addLocalSeat"; name: string }                   // Host only
  | { t: "setConfig"; config: Partial<RuleConfig> }       // Host only, lobby only
  | { t: "startGame" }                                    // Host only
  | { t: "action"; seat: SeatId; action: Action; clientSeq: number }
  | { t: "resync" }
  | { t: "chat"; text: string }
  | { t: "confirmPassDevice"; seat: SeatId };            // local Seats: "I have the device"
```

Room to Seat:

```ts
type RoomMsg =
  | { t: "lobby"; roomCode: string; seats: LobbySeat[]; you: SeatId[] }
  | { t: "update"; version: number; events: GameEvent[]; view: PlayerView }
  | { t: "actionRejected"; clientSeq: number; error: string }
  | { t: "hostAway" }                // the relay sends this when the Host disconnects
  | { t: "hostBack" }                // ...and this when it returns; a fresh `update` follows
  | { t: "roomClosed" }              // ...and this if the Host stayed away 10 minutes
  | { t: "error"; message: string }
  | { t: "passDevice"; seat: SeatId; name: string }      // local Seat asked to respond (§7.4)
  | { t: "respond"; seat: SeatId; actions: Action[] }    // its options, once it confirms
  | { t: "countdown"; seat: SeatId; ms: number };        // remote Seat: time left before the Room answers for it
```

**One update message.** Every state change increments `version`. The Room sends each Seat one `update`. Its `events` are filtered for that Seat (Section 9) and describe the change from `version - 1` to `version`. Its `view` is the resulting state. The client animates the events and then applies the view. If the client sees a version gap (it missed messages), it skips the animations and applies the view directly. No separate resync is needed, but a client may send `resync` after it reconnects.

**Response prompts for local Seats.** The Room passes, with an ordinary logged `PASS`, for a local Seat that is asked to respond but holds no usable card. It asks the others one at a time, in turn order after the active player: first `passDevice`, then, after `confirmPassDevice`, `respond` with the Seat's options. It rejects a local Seat's response before then. While a prompt stands, the Room sends it again after every `update`, so a UI knows a prompt is current if one follows the latest update.

**Response windows for remote Seats.** A remote Seat is always asked; it reads its options from its view and answers with `action`. A pass, whether the friend sends it or the Room makes it for a Seat that holds no usable card, takes effect no sooner than the Seat's random 0.5–2.5 s delay, so other players can't tell the two apart. A Seat with a usable card, or with a decision to answer, gets `countdown` with the milliseconds left, again after every update while it stands. When it runs out, the Room applies the default action (Section 10.6). A pass still waiting when another response reopens the window is answered with `actionRejected`, and the Seat is asked afresh.

**Identity.** The Room ignores any identity claim in a remote message. It uses the `from` token the relay stamps on the message (Section 10.5) to find that player's Seat, sets `action.player` from that Seat, and rejects an action whose `seat` isn't owned by that token. A `local` Seat's actions come from `LocalConnection`, and the UI picks the Seat according to whose turn it is or whose prompt is showing.

### 10.5 Relay protocol

The relay is a Cloudflare Worker. Each Room Code maps to one Durable Object, which holds the open WebSockets for that Room. Locally, `wrangler dev` runs the same code.

HTTP:
- `POST /rooms` → `{ roomCode, hostToken }`. The relay creates a Durable Object for a fresh Room Code. The Host's tab stores `hostToken` in localStorage.
- `GET /rooms/:code/ws?hostToken=…` → the Host's WebSocket.
- `GET /rooms/:code/ws?seatToken=…` → a friend's WebSocket. With no `seatToken`, the relay issues a new one in its first frame, and the friend stores it in localStorage.

Frames (JSON). The relay reads only the outer fields and passes `payload` through untouched:

```ts
// Friend → relay: always routed to the Host. The relay adds `from`.
{ payload: ClientMsg }
// Relay → Host
{ kind: "msg"; from: SeatToken; payload: ClientMsg }
{ kind: "peerJoined" | "peerLeft"; seatToken: SeatToken }
{ kind: "tick" }                                  // every 1s while the Room has peers
// Host → relay
{ to: SeatToken | "all"; payload: RoomMsg }
// Relay → friend
{ kind: "msg"; payload: RoomMsg }
{ kind: "welcome"; seatToken: SeatToken }
{ kind: "hostAway" | "hostBack" | "roomClosed" }
```

Rules:
- A connection only counts as the Host if it presents the `hostToken`. After a refresh, the Host reconnects with the token and takes the Host role back.
- If the Host has been disconnected for **10 minutes**, the relay sends `roomClosed` to every friend, deletes the Durable Object's state, and frees the Room Code.
- Room Codes are 5 characters and easy to read aloud (no 0/O/1/I).
- The relay never parses or stores `payload`. The game protocol can change without redeploying the relay.

### 10.6 Timers

- Response windows and decisions have timeouts, but only for remote Seats (Section 7.4). On timeout, the Room creates a normal `PASS` or `RESOLVE_DECISION` action (the first legal option, or a random one for discards) and applies it like any other action. **Every timeout is recorded in the action log**, so a replay takes exactly the same path.
- Timers live in the Room, never in the engine. The engine stays free of `Date.now()`.
- Each timer is stored as a **deadline timestamp**. The Room checks for expired deadlines on every incoming message, on the relay's 1-second `tick`, on its own `setTimeout`, and on `visibilitychange` (the Host's UI calls `room.checkDeadlines()`). Browsers slow down `setTimeout` in background tabs; the relay's ticks keep deadlines on time even then.
- The Host's UI shows a "Keep this tab open: you are hosting" notice.

### 10.7 Persistence & reconnection

- **Host refresh:** after every applied action, the Room saves `{ roomCode, seed, config, seats, cardDefsVersion, actions[] }` to IndexedDB. On reload, the Host reconnects to the relay with `hostToken`, rebuilds the state by replaying the log (Section 8.3), and sends every Seat a fresh `update`. Any open deadlines restart from their full duration.
- **Host refresh in the lobby:** nothing is saved until the game starts, so there is no log to replay. The Host's tab rebuilds an empty lobby under the same Room Code, friends' clients send `joinRoom` again on `hostBack` to retake their Seats, and the Host adds local and bot Seats again.
- **Host leaves for good:** the Room ends. The game never moves to another device, because that device would need the full state.
- **Friend reconnects:** the friend's `seatToken` from localStorage reclaims their Seat, and the Room sends them a fresh `update`. A disconnected friend's Seat is held for 2 minutes. After that, a bot takes over the Seat, and a friend who returns takes it back at the next turn boundary (when the active player changes), never mid-turn. Until then they see updates, but their actions are rejected. Holds are not saved: after a Host refresh, every absent friend's hold restarts from the full 2 minutes.
- Optionally, when a game ends, the Host can download the replay as a JSON file.

### 10.8 Deployment
- **Relay:** `wrangler deploy` to Cloudflare's free tier. This is the only thing hosted online.
- **Client:** a static site, for example Cloudflare Pages. The relay URL is set at build time.

---

## 11. AI Opponents

Bots run inside the Room, in the Host's tab. All bots implement one interface and only ever choose from `getLegalActions` or `pendingDecision.options`:

```ts
export interface Bot {
  chooseAction(view: PlayerView, legal: Action[]): Action;
  // view = the bot's own redacted view; bots must not cheat, even though the Room holds the full state
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
- **The UI only renders `PlayerView` and sends `Action`s through a `GameConnection`** (Section 10.3). It contains no game rules and doesn't know whether it is local or remote.
- **Drive interaction from legal actions** (`PlayerView.legalActions`, Section 9): highlight only playable cards, valid targets, and attackable monsters. Disabled elements show a tooltip explaining why ("Needs 2 heroes").
- **Render `pendingDecision`** as a modal or inline selection with its options.
- **Queue animations:** incoming `GameEvent`s go into an animation queue and play in order (dice roll, card fly, flip). Update the view after each event's animation, or use a "skip animations" toggle.
- **Response windows** show a large, clear bar with a countdown, the eligible cards, and a Pass button.
- **Local Seats** get a "Pass the device to P2" screen that hides the hand between players, for both turns and response windows (Section 7.4). The Room asks for it in response windows with `passDevice`; the client works it out for turns. A device with only one local Seat skips the screen: the client answers `passDevice` with `confirmPassDevice` straight away, because there is nobody to pass to. A local Seat's response options come from `respond`, never from `legalActions`, because the Room rejects a response sent before it asks.
- **Host status:** the Host sees a "you are hosting, keep this tab open" notice. Friends see a "Waiting for Host…" overlay on `hostAway`, and a "Waiting for responses…" status while a response window is open and they have nothing left to answer. It names nobody, so it reveals nothing about any hand.

### 12.3 Component list

```
<App>
 ├ <Home/>                   Play on this device / Host online / Join with a Room Code
 ├ <Lobby/>                  Seats, add local/bot Seats, rules config
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

"Play on this device" never contacts the relay. The choice comes first because a Room's code is fixed when it is built, and the relay only knows codes it issued.

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
| Room | Mixed-Seat Rooms driven through `LocalConnection` and a fake relay; timeouts logged as actions; Host refresh rebuilds an identical state | Vitest |
| Relay | Routing, `from` stamping, Host token check, 10-minute expiry | Vitest + `wrangler` local test pool |
| E2E | Host tab + two friend tabs against a local relay, play to game over | Playwright |

### 13.1 Invariants (checked after every action in fuzz tests)
- Total card count across all zones never changes. No card is duplicated or lost.
- Each card instance is in exactly one zone.
- `actionPoints` is between 0 and the maximum.
- Each hero holds at most one item.
- A player with `winner` set means the phase is `gameOver`.
- `getLegalActions` never returns an action that `applyAction` rejects.
- Every game ends within 5,000 actions. Fuzz bots pick a random legal action and only `END_TURN` when nothing else is legal. A game that hits the cap fails and reports its seed. The engine has no draw rule.

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

`nextDice` fills a queue of forced dice in the RNG state, used before the seeded generator. Only `scenario()` fills it; `createGame` leaves it empty.

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

**M4: Room + hot-seat client**
- `packages/room` with local and bot Seats, timers as deadlines, the action log in IndexedDB, and `GameConnection` + `LocalConnection`.
- React UI rendering `PlayerView` through `LocalConnection`: legal-action highlighting, decision modal, response bar, game log, pass-device screen for turns and response windows.
- ✅ Two to four people can finish a game on one computer without consulting the code. Refreshing the tab mid-game restores the same state.

**M5: Online multiplayer**
- `packages/relay` (Worker + Durable Object), `RelayConnection`, remote Seats, the per-Seat response-window rules, relay ticks, Host and seat tokens.
- ✅ A Host and two friends on different machines finish a game, including a Room that mixes local, remote, and bot Seats. Refreshing a friend's tab reconnects them to the same Seat. Refreshing the Host's tab resumes the game for everyone. The Host's tab running in the background doesn't stall the timers.

**M6: Bots**
- Easy bot. Bots fill empty Seats and take over abandoned remote Seats.
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
5. **Stolen hero's roll flag:** can a stolen hero be rolled again by its new owner in the same turn? (`rollFlagFollowsHero`)
6. **Stolen hero's item:** does the item move with a stolen hero? (`itemFollowsStolenHero`)
7. **Modifier timing:** can modifiers be played after other modifiers in any order until everyone passes? (Assumed yes.)
8. **Mid-effect win:** does the game end the instant a win condition is met, even on another player's turn? (`winCheckTiming`)
9. **Hand-limit discard:** chosen by the player? (Assumed yes.)
10. **Modifiers in a Challenge:** do both players roll first, with one Modifier Window in which any player may modify either roll? (Assumed yes. `PLAY_MODIFIER` names its target roll.)

When a rule is confirmed, update the default value in `config/defaults.ts` and remove it from this list.

---

**End of document.**
