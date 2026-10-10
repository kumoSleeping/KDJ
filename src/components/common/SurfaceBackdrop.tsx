import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import "./SurfaceBackdrop.css";

/**
 * A backdrop is a layer a floating surface (a task bubble, the drawer's panel, the lyrics
 * block) lets its owner put under its content: the surface keeps its size, its edge, its
 * shadow and its clip, and whatever is given is drawn inside them, behind everything the
 * surface holds. The surface does not know what the layer is.
 *
 * A layer that changes what can be read on the surface says so with `useBackdropInk`: the
 * surface then takes its text colours from the layer (scoped custom properties on the surface
 * itself — never on the document), and gets its own back when the layer says null or goes.
 */
export interface BackdropInk {
  /** Titles and what is selected. */
  text: string;
  /** Running text. */
  body: string;
  /** Secondary text and controls at rest. */
  muted: string;
  /** The quietest line. */
  faint: string;
  /** What the ink sits on, for marks that are cut out of it. */
  base: string;
}

const BackdropInkContext = createContext<((ink: BackdropInk | null) => void) | null>(null);
const noInk = () => undefined;

/** For a backdrop layer: tell the surface what ink reads on the layer; null takes it back. */
export function useBackdropInk(): (ink: BackdropInk | null) => void {
  return useContext(BackdropInkContext) ?? noInk;
}

/**
 * For a surface: the slot for `backdrop`. `attributes` and `style` go on the surface's own
 * element, `layer` is its first child. Without a backdrop all three are empty.
 */
export function useSurfaceBackdrop(backdrop: ReactNode): {
  attributes: { "data-backdrop"?: "true"; "data-backdrop-ink"?: "true" };
  style: CSSProperties | undefined;
  layer: ReactNode;
} {
  const [ink, setInk] = useState<BackdropInk | null>(null);
  if (backdrop == null) return { attributes: {}, style: undefined, layer: null };
  return {
    attributes: { "data-backdrop": "true", "data-backdrop-ink": ink ? "true" : undefined },
    style: ink ? {
      "--kd-backdrop-text": ink.text,
      "--kd-backdrop-body": ink.body,
      "--kd-backdrop-muted": ink.muted,
      "--kd-backdrop-faint": ink.faint,
      "--kd-backdrop-base": ink.base,
    } as CSSProperties : undefined,
    layer: <div className="kd-backdrop" aria-hidden="true">
      <BackdropInkContext.Provider value={setInk}>{backdrop}</BackdropInkContext.Provider>
    </div>,
  };
}
