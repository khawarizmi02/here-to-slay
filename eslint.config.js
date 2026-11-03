// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Engine code must be deterministic (TECHNICAL_DESIGN.md §0.2, §8):
 * all randomness goes through the seeded RNG, and only the Room touches time.
 */
const engineDeterminism = {
  "no-restricted-properties": [
    "error",
    { object: "Math", property: "random", message: "Engine code must use the seeded RNG, not Math.random()." },
    { object: "Date", property: "now", message: "Engine code must not read the clock; only the Room owns time." },
    { object: "crypto", property: "getRandomValues", message: "Engine code must use the seeded RNG." },
    { object: "crypto", property: "randomUUID", message: "Engine code must use the seeded RNG." },
  ],
  "no-restricted-globals": [
    "error",
    { name: "performance", message: "Engine code must not read the clock; only the Room owns time." },
  ],
  "no-restricted-syntax": [
    "error",
    { selector: "NewExpression[callee.name='Date']", message: "Engine code must not read the clock; only the Room owns time." },
  ],
};

/**
 * The Room runs in the Host's tab but must stay testable without a browser
 * (TECHNICAL_DESIGN.md §10.1): no DOM, no network, and only the protocol and
 * zod from outside. Its clock and randomness are passed in.
 */
const roomIsolation = {
  "no-restricted-imports": [
    "error",
    { patterns: [{ regex: "^(?!\\.{1,2}/|@here-to-slay/protocol$|zod$)", message: "The Room may import only the protocol, zod and its own files." }] },
  ],
  "no-restricted-globals": [
    "error",
    ...["window", "document", "navigator", "localStorage", "sessionStorage", "indexedDB", "WebSocket", "fetch", "XMLHttpRequest", "EventSource"].map(
      (name) => ({ name, message: "The Room has no DOM or network dependencies." }),
    ),
  ],
  "no-restricted-properties": [
    "error",
    { object: "Math", property: "random", message: "Use the Room's injected randomness." },
    { object: "Date", property: "now", message: "Use the Room's injected clock." },
  ],
  "no-restricted-syntax": [
    "error",
    { selector: "NewExpression[callee.name='Date']", message: "Use the Room's injected clock." },
  ],
};

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.wrangler/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["packages/engine/src/**/*.ts", "packages/toy-engine/src/**/*.ts"],
    rules: engineDeterminism,
  },
  {
    files: ["packages/room/src/**/*.ts"],
    rules: roomIsolation,
  },
);
