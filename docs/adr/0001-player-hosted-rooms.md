# Player-hosted rooms with a message relay

The game runs in the Host's browser, not on a dedicated game server. The Host's copy of the game state is the one that counts. Other players reach the Host through a small relay: a WebSocket service that forwards messages and knows nothing about the game. It has no game state, no engine and no rules. We chose this so the only thing deployed online is a tiny relay that rarely needs to change. This is a personal game played with friends, so we accept the costs: the Host can technically see every hand and the RNG state (for example with browser dev tools), and the Room ends if the Host leaves for good.

## Considered Options

- **Dedicated game server** (the original TECHNICAL_DESIGN.md §10): hides cards even from the Host, but means running a stateful server.
- **WebRTC through PeerJS**: no relay to deploy, but some home and mobile networks block direct connections, and fixing that needs a relay server ("TURN") anyway.

## Consequences

- This overrides the "server-authoritative" principle in TECHNICAL_DESIGN.md §1.4 and §10. The Host's browser does the server's job.
- Hiding information (§9) still matters for everyone except the Host, so per-player views and event filtering stay.
- Every client talks to its Room through a single connection interface. The Host's own UI uses an in-tab connection; remote players use the relay.
- The Host saves the action log locally after every action, so a refresh rebuilds the Room. The game never moves to a different Host.
- The relay is a Cloudflare Worker with one Durable Object per Room Code. Its only jobs are to send each message to the right player, to stamp messages with the sender's seat token, and to tell the real Host apart from anyone else using a host token. It closes a Room after the Host has been gone for 10 minutes.
