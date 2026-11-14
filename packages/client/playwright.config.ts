import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;
const RELAY_PORT = 8799;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"] },
  webServer: [
    {
      // The relay, as `wrangler dev` runs it: online games reach it from the client.
      command: `npx wrangler dev --port ${RELAY_PORT}`,
      cwd: "../relay",
      port: RELAY_PORT,
      env: { WRANGLER_SEND_METRICS: "false" },
      reuseExistingServer: false,
    },
    {
      command: `vite --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      env: { VITE_RELAY_URL: `http://localhost:${RELAY_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
