/*
 * The relay reads only a frame's outer fields (TECHNICAL_DESIGN.md §10.5).
 * The game message in `payload` is never interpreted: the relay cuts its
 * exact source text out of the incoming frame and splices that text into the
 * outgoing frame, so the payload is forwarded byte-for-byte.
 */

/** Source text of each top-level field of a frame, by field name. */
export type OuterFields = ReadonlyMap<string, string>;

/**
 * Splits a frame into the source text of its top-level fields. Returns null
 * unless the frame is a well-formed JSON object, so the relay never forwards
 * malformed JSON.
 */
export function readOuterFields(frame: string): OuterFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return scanObject(frame);
}

/** Field values that aren't the payload are small and safe to parse. */
export function fieldValue(fields: OuterFields, name: string): unknown {
  const raw = fields.get(name);
  return raw === undefined ? undefined : JSON.parse(raw);
}

// The scanner below assumes `text` is already known to be a valid JSON object.

const WHITESPACE = " \t\n\r";

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && WHITESPACE.includes(text[i]!)) i++;
  return i;
}

/** Index just past the string literal starting at `i`. */
function endOfString(text: string, i: number): number {
  let j = i + 1;
  while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** Index just past the JSON value starting at `i`. */
function endOfValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return endOfString(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    do {
      const ch = text[j];
      if (ch === '"') {
        j = endOfString(text, j);
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      j++;
    } while (depth > 0);
    return j;
  }
  let j = i;
  while (j < text.length && !",}] \t\n\r".includes(text[j]!)) j++;
  return j;
}

function scanObject(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  let i = skipWhitespace(text, 0) + 1; // past "{"
  for (;;) {
    i = skipWhitespace(text, i);
    if (text[i] === "}") return fields;
    const keyEnd = endOfString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipWhitespace(text, keyEnd) + 1; // past ":"
    const valueStart = skipWhitespace(text, i);
    const valueEnd = endOfValue(text, valueStart);
    fields.set(key, text.slice(valueStart, valueEnd)); // last duplicate wins, as in JSON.parse
    i = skipWhitespace(text, valueEnd);
    if (text[i] === ",") i++;
  }
}
