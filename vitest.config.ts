import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["packages/relay/**", "packages/client/**", "**/node_modules/**"],
          // A sample of the seeded all-bot games; `pnpm bot-games` plays all 1,000 (TECHNICAL_DESIGN.md §14, M6).
          provide: { botGames: 100 },
        },
      },
      // The relay runs inside the Workers runtime (wrangler's local test environment).
      "packages/relay/vitest.config.ts",
      // The client renders React components in jsdom.
      "packages/client/vitest.config.ts",
    ],
  },
});
