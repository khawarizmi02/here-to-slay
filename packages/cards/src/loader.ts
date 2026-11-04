import type { z } from "zod";
import { CardDefSchema, type CardDef } from "./schema.js";

/**
 * Thrown when card JSON is invalid. The message lists every problem found,
 * each naming the card (by id, or by position when it has no usable id) and
 * the field.
 */
export class CardLoadError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid card data:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CardLoadError";
    this.problems = problems;
  }
}

/**
 * Validates card JSON (TECHNICAL_DESIGN.md §5.7) and returns typed
 * definitions in the order given. Fails loudly with a CardLoadError on any
 * problem, including two cards that share an id.
 */
export function loadCardDefs(json: unknown): CardDef[] {
  if (!Array.isArray(json)) {
    throw new CardLoadError(["card data must be an array of cards"]);
  }

  const defs: CardDef[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  json.forEach((raw: unknown, index) => {
    const label = cardLabel(raw, index);
    const result = CardDefSchema.safeParse(raw);
    if (!result.success) {
      problems.push(...result.error.issues.map((issue) => `${label}: ${describeIssue(issue)}`));
      return;
    }
    if (seen.has(result.data.id)) {
      problems.push(`${label}: duplicate card id; every definition needs its own id`);
      return;
    }
    seen.add(result.data.id);
    defs.push(result.data);
  });

  if (problems.length > 0) throw new CardLoadError(problems);
  return defs;
}

function cardLabel(raw: unknown, index: number): string {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const { id } = raw;
    if (typeof id === "string" && id.length > 0) return `card "${id}"`;
  }
  return `card at index ${index}`;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const field = formatPath(issue.path);
  const where = field === "" ? "" : `field "${field}"`;
  let message = issue.message;
  if (issue.code === "unrecognized_keys") {
    message = `unknown ${issue.keys.length === 1 ? "field" : "fields"} ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
  }
  return where === "" ? message : `${where}: ${message}`;
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out === "" ? String(key) : `.${String(key)}`;
  }
  return out;
}
