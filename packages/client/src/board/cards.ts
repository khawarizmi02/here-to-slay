import { chooseCardSet, type CardDef, type CardSet, type HeroClass } from "@here-to-slay/cards";
import { describeRequirement, type CardView } from "@here-to-slay/engine";
import { LOCAL_ART, LOCAL_CARD_FILES } from "./local-files.js";

/**
 * The card set the Room plays with: the private local set in
 * `packages/cards/local/` when its files exist, the placeholder set
 * otherwise. A broken local set throws here, at startup, naming the card and
 * the field.
 */
export const CARD_SET: CardSet = chooseCardSet(LOCAL_CARD_FILES);

/**
 * The cards of that set. The board looks up names and text here; it never
 * reads rules from them. The composition root builds the Room's engine from
 * the same set.
 */
export const CARD_DEFS: readonly CardDef[] = CARD_SET.defs;

const BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((d) => [d.id, d]));

export function cardDef(card: CardView | string): CardDef | undefined {
  return BY_ID.get(typeof card === "string" ? card : card.def);
}

/** Each local art file's URL, by file name. */
const ART_BY_FILE: ReadonlyMap<string, string> = new Map(
  Object.entries(LOCAL_ART).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]),
);

/**
 * The URL of a card's art (§12.4): the file its `art` field names in
 * `packages/cards/local/art/`. None when the card names no art or its file
 * isn't there, and the card is drawn with HTML alone.
 */
export function cardArt(card: CardView | string): string | undefined {
  const art = cardDef(card)?.art;
  return art === undefined ? undefined : ART_BY_FILE.get(art);
}

export function cardName(card: CardView | string): string {
  return cardDef(card)?.name ?? (typeof card === "string" ? card : card.def);
}

export const CLASS_LABELS: Record<HeroClass, string> = {
  bard: "Bard",
  fighter: "Fighter",
  guardian: "Guardian",
  ranger: "Ranger",
  thief: "Thief",
  wizard: "Wizard",
};

const TYPE_LABELS: Record<CardDef["type"], string> = {
  leader: "Party Leader",
  hero: "Hero",
  item: "Item",
  cursedItem: "Cursed Item",
  magic: "Magic",
  modifier: "Modifier",
  challenge: "Challenge",
  monster: "Monster",
};

/** The line under a card's name: its type, class and numbers, as printed on the card. */
export function cardSubtitle(def: CardDef): string {
  switch (def.type) {
    case "leader":
      return `${TYPE_LABELS.leader} · ${CLASS_LABELS[def.class]}`;
    case "hero":
      return `${CLASS_LABELS[def.class]} · Roll ${def.rollRequirement}+`;
    case "item":
    case "cursedItem":
      return def.maskClass ? `${TYPE_LABELS[def.type]} · ${CLASS_LABELS[def.maskClass]} Mask` : TYPE_LABELS[def.type];
    case "modifier":
      return `${TYPE_LABELS.modifier} · ${modifierOptions(def.options)}`;
    case "monster":
      return `Needs ${describeRequirement(def.requirement)} · Slay ${def.slayAt}+ · Defeat ${def.defeatAt}-`;
    default:
      return TYPE_LABELS[def.type];
  }
}

function modifierOptions(options: readonly number[]): string {
  return options.map((v) => (v > 0 ? `+${v}` : String(v))).join(" / ");
}

/** Everything printed on a card besides its name and text, as label and value: what a zoomed card lists. */
export function cardFacts(def: CardDef): [label: string, value: string][] {
  const facts: [string, string][] = [["Type", TYPE_LABELS[def.type]]];
  switch (def.type) {
    case "leader":
      facts.push(["Class", CLASS_LABELS[def.class]]);
      break;
    case "hero":
      facts.push(["Class", CLASS_LABELS[def.class]], ["Roll", `Roll ${def.rollRequirement}+`]);
      break;
    case "item":
    case "cursedItem":
      if (def.maskClass) facts.push(["Mask", `${CLASS_LABELS[def.maskClass]} Mask`]);
      break;
    case "modifier":
      facts.push(["Options", modifierOptions(def.options)]);
      break;
    case "monster":
      facts.push(["Needs", describeRequirement(def.requirement)], ["Slay", `${def.slayAt}+`], ["Defeat", `${def.defeatAt}-`]);
      break;
  }
  return facts;
}
