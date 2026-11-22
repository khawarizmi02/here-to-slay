/**
 * The private local files in `packages/cards/local/` (gitignored), found at
 * build time: none in a fresh clone. The unit tests (Vite's `test` mode)
 * never see them, so they pass with or without a local set.
 */
const testMode = import.meta.env.MODE === "test";

/** The local card set's JSON files, parsed, by path. */
export const LOCAL_CARD_FILES: Readonly<Record<string, unknown>> = testMode
  ? {}
  : import.meta.glob("../../../cards/local/*.json", { eager: true, import: "default" });

/** The local card art (`packages/cards/local/art/`): each image's URL, by path. */
export const LOCAL_ART: Readonly<Record<string, string>> = testMode
  ? {}
  : (import.meta.glob("../../../cards/local/art/*.{png,jpg,jpeg,webp,avif,gif,svg,PNG,JPG,JPEG,WEBP,AVIF,GIF,SVG}", {
      eager: true,
      import: "default",
      query: "?url",
    }) as Record<string, string>);
