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
 * The Room has no DOM or network dependencies, and its clock and randomness
 * are passed in so tests can control them (TECHNICAL_DESIGN.md §10.1).
 */
const roomIsolation = {
  "no-restricted-properties": [
    "error",
    { object: "Math", property: "random", message: "The Room takes its source of randomness as an input." },
    { object: "Date", property: "now", message: "The Room takes its clock as an input." },
    { object: "crypto", property: "getRandomValues", message: "The Room takes its source of randomness as an input." },
    { object: "crypto", property: "randomUUID", message: "The Room takes its source of randomness as an input." },
  ],
  "no-restricted-globals": [
    "error",
    ...["performance", "setTimeout", "setInterval"].map((name) => ({ name, message: "The Room takes its clock as an input." })),
    ...["window", "document", "localStorage", "indexedDB", "fetch", "WebSocket", "XMLHttpRequest"].map((name) => ({
      name,
      message: "The Room has no DOM or network dependencies; pass them in.",
    })),
  ],
  "no-restricted-syntax": [
    "error",
    { selector: "NewExpression[callee.name='Date']", message: "The Room takes its clock as an input." },
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
