interface ImportMetaEnv {
  /** Where friends and Hosts reach the relay, set at build time (TECHNICAL_DESIGN.md §10.8). */
  readonly VITE_RELAY_URL?: string;
  /** Whether this is the dev server rather than a build. */
  readonly DEV: boolean;
  /** Vite's mode: `e2e` for the end-to-end runs, which seed the Room from the URL; `test` for the unit tests. */
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** Vite's glob import: each matching file's default export, by path. Matches nothing when no file does. */
  glob(pattern: string, options: { eager: true; import: "default" }): Record<string, unknown>;
}
