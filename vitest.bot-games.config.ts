import { defineConfig } from "vitest/config";

/** All 1,000 seeded all-bot games through the Room (TECHNICAL_DESIGN.md §14, M6). Too slow for `pnpm test`, which plays a sample. */
export default defineConfig({
  test: {
    include: ["packages/room/test/bot-games-*.test.ts"],
    provide: { botGames: 1_000 },
  },
});
