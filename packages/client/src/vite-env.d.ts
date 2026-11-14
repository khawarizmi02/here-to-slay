interface ImportMetaEnv {
  /** Where friends and Hosts reach the relay, set at build time (TECHNICAL_DESIGN.md §10.8). */
  readonly VITE_RELAY_URL?: string;
  /** Whether this is the dev server rather than a build. */
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
