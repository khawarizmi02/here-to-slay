import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["packages/relay/**", "packages/client/**", "**/node_modules/**"],
        },
      },
      // The relay runs inside the Workers runtime (wrangler's local test environment).
      "packages/relay/vitest.config.ts",
      // The client renders React components in jsdom.
      "packages/client/vitest.config.ts",
    ],
  },
});
