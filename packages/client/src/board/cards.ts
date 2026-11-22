import { chooseCardSet, loadCardDefs, type CardDef, type CardSet, type HeroClass } from "@here-to-slay/cards";
import { createContext, useContext } from "react";
import { describeRequirement, type CardView } from "@here-to-slay/engine";
import { LOCAL_ART, LOCAL_CARD_FILES } from "./local-files.js";

/**
 * The card set this device plays with: the private local set in
 * `packages/cards/local/` when its files exist, the placeholder set
 * otherwise. A broken local set throws here, at startup, naming the card and
 * the field. The Host's Room plays with it, and sends it to friends.
 */
export const CARD_SET: CardSet = chooseCardSet(LOCAL_CARD_FILES);

/** Each local art file's URL, by file name. */
const ART_BY_FILE: ReadonlyMap<string, string> = new Map(
  Object.entries(LOCAL_ART).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]),
);

/**
 * The cards of one Room's Card Set, as the board looks them up: names, text
 * and art. The board never reads rules from them.
 */
export class CardLookup {
  readonly #byId: ReadonlyMap<string, CardDef>;

  constructor(
    defs: readonly CardDef[],
    /** Each art file's URL, by file name. */
    readonly artByFile: ReadonlyMap<string, string> = new Map(),
  ) {
    this.#byId = new Map(defs.map((d) => [d.id, d]));
  }

  def(card: CardView | string): CardDef | undefined {
    return this.#byId.get(typeof card === "string" ? card : card.def);
  }

  name(card: CardView | string): string {
    return this.def(card)?.name ?? (typeof card === "string" ? card : card.def);
  }

  /**
   * The URL of a card's art (§12.4): the file its `art` field names in
   * `packages/cards/local/art/`. None when the card names no art or its file
   * isn't there, and the card is drawn with HTML alone.
   */
  art(card: CardView | string): string | undefined {
    const art = this.def(card)?.art;
    return art === undefined ? undefined : this.artByFile.get(art);
  }
}

/** This device's own cards, with its local art: what the Host, its local Seats and a replay draw. */
export const DEVICE_CARDS = new CardLookup(CARD_SET.defs, ART_BY_FILE);

/**
 * The Host's Card Set as a friend received it (ADR-0005), validated like
 * local card files. It has no art. Throws a CardLoadError when the cards are invalid.
 */
export function receivedCards(cards: unknown): CardLookup {
  return new CardLookup(loadCardDefs(cards));
}

/** The cards the board on screen draws: the device's own unless a friend's Room says otherwise. */
export const CardsContext = createContext<CardLookup>(DEVICE_CARDS);

export function useCards(): CardLookup {
  return useContext(CardsContext);
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
