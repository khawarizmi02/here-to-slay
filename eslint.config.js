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

/**
 * The client's layers: only the composition root touches the Room, and
 * only the toy layer knows the toy engine, so moving to the real engine
 * replaces the toy layer and nothing else. The shell knows no engine at all.
 */
const roomOnlyInRoot = {
  paths: [{ name: "@here-to-slay/room", allowTypeImports: true, message: "Only the composition root (src/root) touches the Room." }],
};
const clientLayers = {
  "@typescript-eslint/no-restricted-imports": ["error", roomOnlyInRoot],
};
const shellLayer = {
  "@typescript-eslint/no-restricted-imports": [
    "error",
    {
      ...roomOnlyInRoot,
      patterns: [
        { group: ["@here-to-slay/toy-engine", "@here-to-slay/engine", "@here-to-slay/cards"], message: "The shell is engine-agnostic." },
        { group: ["../toy", "../toy/*", "../root", "../root/*"], message: "The shell is engine-agnostic: the composition root hands it the game layer." },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.wrangler/**", "**/test-results/**", "**/playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["packages/engine/src/**/*.ts", "packages/cards/src/**/*.ts", "packages/toy-engine/src/**/*.ts"],
    rules: engineDeterminism,
  },
  {
    files: ["packages/room/src/**/*.ts"],
    rules: roomIsolation,
  },
  {
    files: ["packages/client/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["packages/client/src/**/*.{ts,tsx}"],
    ignores: ["packages/client/src/root/**", "packages/client/src/shell/**"],
    rules: clientLayers,
  },
  {
    files: ["packages/client/src/shell/**/*.{ts,tsx}"],
    rules: shellLayer,
  },
);
