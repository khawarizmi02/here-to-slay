# Reasons for disabled controls come from the engine

TECHNICAL_DESIGN.md §12.2 asks for disabled controls with a tooltip that says why ("Needs 2 heroes"). `legalActions` (§9) only says what is allowed. The engine adds a second list to `PlayerView`, `blockedActions`: the turn actions the viewer can see as controls but can't take now, each with a reason a player can read. The client shows those controls disabled, with their reason, and works out nothing itself.

An entry is `{ type, subject?, reason }`. `type` is a turn action that costs AP. `subject` is the hand card, face-up monster or party hero the control belongs to; Draw and Discard and Redraw have none. The list is filled only where `legalActions` lists turn actions: for the active player in the action phase, with no Decision pending and no Response Window open. Everywhere else it is empty, and the client can tell "Not your turn" from `activePlayer` alone. Each control is either legal or blocked, never both. When it fails for several causes, the reason given is the one that isn't about AP, since spending AP elsewhere won't fix it.

## Considered Options

- **The client works out the reasons from the view.** Rejected because it puts game rules in the UI, against §12.2, and the reasons could drift from `legalActions` whenever a rule or a §15 default changed.
- **No reasons for now**, with disabled controls left unexplained. Rejected because the requirement on a monster is the most common thing a new player asks about.

## Consequences

- The engine works out the reasons from the same checks `getLegalActions` uses (AP costs after passives, monster requirements, item targets, heroes that have rolled), and the fuzz suite asserts that no action is both legal and blocked.
- The reasons are English strings made by the engine. If the game is ever translated, they become reason codes with arguments.
- Reasons cover turn actions only. Decision options, Challenges and Modifiers get none.
- The toy engine follows the `PlayerView` contract (ADR-0002) with an always-empty `blockedActions`.
