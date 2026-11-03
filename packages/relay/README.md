# @here-to-slay/relay

The relay between a Room's Host and its friends (ADR-0001, `TECHNICAL_DESIGN.md` §10.5): a Cloudflare Worker with one Durable Object per Room Code. It routes frames, stamps friends' frames with their seat token, decides who the Host is, and never reads the game message inside a frame.

- `POST /rooms` → `{ roomCode, hostToken }`
- `GET /rooms/:code/ws?hostToken=…` → the Host's WebSocket
- `GET /rooms/:code/ws[?seatToken=…]` → a friend's WebSocket (no token: one arrives in a `welcome` frame)

```bash
pnpm --filter @here-to-slay/relay dev      # wrangler dev, on http://localhost:8787
pnpm --filter @here-to-slay/relay deploy   # wrangler deploy
```

Tests run inside the Workers runtime through `@cloudflare/vitest-plugin`, as part of the root `pnpm test`.
