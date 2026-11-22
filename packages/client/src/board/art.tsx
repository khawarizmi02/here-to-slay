import type { CardView as Card } from "@here-to-slay/engine";
import { useState } from "react";
import { cardArt } from "./cards.js";

/**
 * A card's art, as an image layer over its HTML card (§12.4): nothing when
 * the card has none, or when its image fails to load. The HTML card under it
 * keeps the name and text for screen readers, so the image itself is
 * decorative.
 */
export function CardArt({ card }: { card: Card }) {
  const src = cardArt(card);
  const [failed, setFailed] = useState<string | null>(null);
  if (src === undefined || failed === src) return null;
  return <img className="card-art" src={src} alt="" draggable={false} onError={() => setFailed(src)} />;
}
