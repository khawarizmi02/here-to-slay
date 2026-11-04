# The card definitions version is a hash of the card data

The engine package exports `createRoomEngine(cardDefs)`. It returns a plain object that matches the Room's `RoomEngine` interface without importing `packages/room`. Its `cardDefsVersion` is a short hash of the validated card definitions, taken in a fixed order. The Room saves this version with the action log and refuses to restore a game whose version differs (TECHNICAL_DESIGN.md §8.3). So any change to the card JSON stops old saves from loading, instead of letting them replay into a different game.

## Considered Options

- **A version bumped by hand** in `packages/cards`. Rejected because it gets forgotten when card data changes (for example while entering real cards in M8), and a stale save then replays wrongly with no error.
- **The engine imports the card data at build time**, with no factory. Rejected because tests and the `scenario()` helper (§13.2) need to pass in a small set of cards.

## Consequences

- The hash covers every field, display text included, so fixing a typo in card text also stops old saves from loading. We accept this for a game played with friends.
