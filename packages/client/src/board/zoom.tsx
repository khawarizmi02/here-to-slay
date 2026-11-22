import type { CardView as Card } from "@here-to-slay/engine";
import { createContext, useContext, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type SyntheticEvent } from "react";
import { CardArt } from "./art.js";
import { cardDef, cardFacts, cardName } from "./cards.js";

/** How long a finger rests on a card before it zooms. */
const LONG_PRESS_MS = 500;
/** How far a finger may drift during a long press before it counts as a scroll. */
const LONG_PRESS_SLOP_PX = 10;
/** How long after a long press ends its click may still arrive, to be swallowed. */
const LONG_PRESS_CLICK_MS = 600;

interface Zoomed {
  card: Card;
  /** The card on the board it was zoomed from: the zoom closes once it is gone. */
  anchor: HTMLElement;
}

interface ZoomControls {
  open(card: Card, anchor: HTMLElement): void;
  close(anchor?: HTMLElement): void;
  /** Whether the last input was a pointer: focus that a tap or click gave a card doesn't zoom it. */
  pointerFocus(): boolean;
}

const ZoomContext = createContext<ZoomControls | null>(null);

/**
 * Card zoom (§12.3 `<CardView/>`): hovering a card, a long press on it or
 * keyboard focus opens a large view of it, and Escape, the pointer leaving
 * it, focus leaving it or a tap elsewhere closes it. Only cards the view
 * shows face up can be zoomed, so a hidden card never is. Zooming never
 * sends an action.
 */
export function ZoomProvider({ children }: { children: ReactNode }) {
  const [zoomed, setZoomed] = useState<Zoomed | null>(null);
  const lastInput = useRef<"pointer" | "keyboard" | null>(null);
  const controls = useRef<ZoomControls>({
    open: (card, anchor) => setZoomed({ card, anchor }),
    close: (anchor) => setZoomed((z) => (anchor === undefined || z?.anchor === anchor ? null : z)),
    pointerFocus: () => lastInput.current === "pointer",
  }).current;

  useEffect(() => {
    const onPointer = () => (lastInput.current = "pointer");
    const onKey = () => (lastInput.current = "keyboard");
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") controls.close();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !zoomed.anchor.contains(e.target)) controls.close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [zoomed, controls]);

  // A card that leaves the board (played, stolen, discarded) takes its zoom with it.
  useEffect(() => {
    if (zoomed && !zoomed.anchor.isConnected) setZoomed(null);
  });

  return (
    <ZoomContext.Provider value={controls}>
      {children}
      {zoomed && <CardZoom card={zoomed.card} />}
    </ZoomContext.Provider>
  );
}

/** Whether `e` is about this card rather than a card nested in it, such as an item on a hero. */
function forThisCard(e: SyntheticEvent<HTMLElement>): boolean {
  return e.target instanceof Element && e.target.closest("[data-zoomable]") === e.currentTarget;
}

/**
 * The props that make an element a zoomable card: a figure named after the
 * card, in the tab order, that zooms on hover, keyboard focus (its own or a
 * control's inside it) and long press. The innermost card wins, so an item
 * on a hero zooms on its own.
 */
export function useZoomable(card: Card): HTMLAttributes<HTMLElement> & { "data-zoomable": true } {
  const zoom = useContext(ZoomContext);
  const pendingPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressFired = useRef(false);
  /** Until when a click is the end of a long press, not a tap. */
  const swallowClickUntil = useRef(0);
  const cancelPress = () => {
    if (pendingPress.current) clearTimeout(pendingPress.current.timer);
    pendingPress.current = null;
  };
  const endPress = () => {
    cancelPress();
    if (longPressFired.current) swallowClickUntil.current = Date.now() + LONG_PRESS_CLICK_MS;
    longPressFired.current = false;
  };
  useEffect(() => cancelPress, []);
  if (!zoom) return { "data-zoomable": true };

  return {
    "data-zoomable": true,
    role: "figure",
    "aria-label": cardName(card),
    tabIndex: 0,
    onPointerOver(e) {
      if (e.pointerType !== "touch" && forThisCard(e)) zoom.open(card, e.currentTarget);
    },
    onPointerOut(e) {
      if (e.pointerType === "touch") return;
      if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) zoom.close(e.currentTarget);
    },
    onFocus(e) {
      if (forThisCard(e) && !zoom.pointerFocus()) zoom.open(card, e.currentTarget);
    },
    onBlur(e) {
      if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) zoom.close(e.currentTarget);
    },
    onPointerDown(e) {
      if (e.pointerType !== "touch" || !forThisCard(e)) return;
      cancelPress();
      longPressFired.current = false;
      const anchor = e.currentTarget;
      pendingPress.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          pendingPress.current = null;
          longPressFired.current = true;
          zoom.open(card, anchor);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove(e) {
      const p = pendingPress.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancelPress();
    },
    onPointerUp: endPress,
    onPointerCancel: endPress,
    // The click that ends a long press only zoomed: it must not play the card under the finger.
    onClickCapture(e) {
      if (Date.now() >= swallowClickUntil.current) return;
      swallowClickUntil.current = 0;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu(e) {
      if (pendingPress.current || longPressFired.current) e.preventDefault();
    },
  };
}

/** The large view of a card: everything printed on it. */
function CardZoom({ card }: { card: Card }) {
  const def = cardDef(card);
  return (
    <div role="dialog" aria-label="Zoomed card" className={`card-zoom card card-${def?.type ?? "unknown"}`}>
      <h2 className="card-name">{cardName(card)}</h2>
      {def && (
        <dl>
          {cardFacts(def).map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {def?.text && <p className="card-text">{def.text}</p>}
      <CardArt card={card} />
    </div>
  );
}
