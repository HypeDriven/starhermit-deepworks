// The browser build's text symbols: ◈ credits, ↻ income, ⚒ workers,
// 🔒 sealed, ✦ flare, ▲ a full bin, ⏸ pause. They draw as font characters,
// as the browser build did, in the engine's StarHermit Emoji on every system
// (it covers all seven: 🔒 in its own colours, the rest text style in the
// given colour). Each draws centred on its
// measured ink box at (x, y), `s` window pixels tall, and is a ui.widget of
// role "none" sized in logical pixels.
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { fonts, OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";

export type Glyph = "credits" | "income" | "workers" | "lock" | "flare" | "warn" | "pause";
const CHARS: Record<Glyph, string> = { credits: "◈", income: "↻", workers: "⚒", lock: "🔒", flare: "✦", warn: "▲", pause: "⏸" };
const REF = 100;
const FONT = "StarHermit Emoji";
const CANVAS_FONT = `${REF}px '${FONT}', sans-serif`;
/** The glyph's ink box fills this share of `s` (the old drawn shapes' size). */
const FILL = 0.9;

// Ask for the faces now (the emoji font loads only when text first needs it);
// until they are in, a glyph's ink box is measured again each draw.
fonts.load(CANVAS_FONT, Object.values(CHARS).join("")).catch(() => undefined);

interface Ink { scale: number; dx: number; dy: number; asc: number }
const inks = new Map<Glyph, Ink>();
let probe: OffscreenCanvasRenderingContext2D | null = null;
/** A glyph's ink box at REF px: font size per pixel of `s`, and its centre's offset from (align center, baseline). */
function ink(g: Glyph): Ink {
  let m = inks.get(g);
  if (m) return m;
  probe ??= new OffscreenCanvas(4, 4).getContext("2d")!;
  probe.font = CANVAS_FONT;
  probe.textAlign = "center";
  probe.textBaseline = "alphabetic";
  const t = probe.measureText(CHARS[g]);
  const w = t.actualBoundingBoxLeft + t.actualBoundingBoxRight, h = t.actualBoundingBoxAscent + t.actualBoundingBoxDescent;
  m = { scale: (FILL * REF) / Math.max(1, w, h), dx: (t.actualBoundingBoxRight - t.actualBoundingBoxLeft) / 2 / REF, dy: (t.actualBoundingBoxDescent - t.actualBoundingBoxAscent) / 2 / REF, asc: t.fontBoundingBoxAscent / REF };
  if (fonts.check(CANVAS_FONT, CHARS[g])) inks.set(g, m);
  return m;
}

export function drawGlyph(g: Glyph, x: number, y: number, s: number, color: string): void {
  const m = ink(g), size = m.scale * s;
  // draw.text's y is the line box's top: the baseline sits the font's ascent below it.
  draw.text(CHARS[g], x - m.dx * size, y - (m.dy + m.asc) * size, { size, font: FONT, color, align: "center" });
}

/** A glyph in the layout, `size` logical pixels square. */
export function glyph(g: Glyph, size: number, color: string): void {
  ui.widget("", { role: "none", size: { width: size, height: size }, draw: (r) => drawGlyph(g, r.x + r.width / 2, r.y + r.height / 2, r.height, color) });
}
