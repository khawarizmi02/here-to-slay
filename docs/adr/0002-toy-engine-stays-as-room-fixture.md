# The toy engine stays as the Room's test fixture

The real rules engine (TECHNICAL_DESIGN.md §14, M1–M3) replaces the toy engine as the engine the Room and the client ship with. It does not replace it in the Room's own tests. `packages/toy-engine` stays as a small fixture with no game rules, and the Room tests keep using it. The Room tests are about Seats, timers, response windows and the action log, not card rules. If they ran on the real engine, they would break every time card data or a §15 default changed.

## Considered Options

- **Delete the toy engine at the end of M3** and move every Room test onto the real engine. Rejected because it ties Room tests to card rules.
- **Delete it in #24**, together with the client's toy layer. Rejected for the same reason. #24 still removes the client's dependency on the toy engine.

## Consequences

- One shared `RoomEngine` test suite runs against both engines, so the toy engine stays a faithful stand-in for the contract the Room depends on.
- M3 is done only when the Room also plays a full game on the real engine in an integration test.
- The toy engine must follow any later change to `RoomEngine` or to the `PlayerView` contract (for example `legalActions`, §9).
