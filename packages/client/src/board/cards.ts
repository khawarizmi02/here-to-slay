import { placeholderCardDefs, type CardDef, type HeroClass } from "@here-to-slay/cards";
import { describeRequirement, type CardView } from "@here-to-slay/engine";

/**
 * The card set the Room plays with. The board looks up names and text here;
 * it never reads rules from them. The composition root builds the Room's
 * engine from the same set.
 */
export const CARD_DEFS: readonly CardDef[] = placeholderCardDefs;

const BY_ID: ReadonlyMap<string, CardDef> = new Map(CARD_DEFS.map((d) => [d.id, d]));

export function cardDef(card: CardView | string): CardDef | undefined {
  return BY_ID.get(typeof card === "string" ? card : card.def);
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
      return `${TYPE_LABELS.modifier} · ${def.options.map((v) => (v > 0 ? `+${v}` : String(v))).join(" / ")}`;
    case "monster":
      return `Needs ${describeRequirement(def.requirement)} · Slay ${def.slayAt}+ · Defeat ${def.defeatAt}-`;
    default:
      return TYPE_LABELS[def.type];
  }
}
