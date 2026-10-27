// The browser build's text symbols drawn as shapes (the engine's fonts lack
// some of them in browsers): ◈ credits, ↻ income, ⚒ workers, 🔒 sealed,
// ✦ flare, ▲ a full bin, ⏸ pause. Each draws centred at (x, y), `s` window
// pixels tall, and is a ui.widget of role "none" sized in logical pixels.
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";

export type Glyph = "credits" | "income" | "workers" | "lock" | "flare" | "warn" | "pause";

export function drawGlyph(g: Glyph, x: number, y: number, s: number, color: string): void {
  const h = s / 2;
  const lw = Math.max(1, s * 0.12);
  switch (g) {
    case "credits":
      draw.polygon([[x, y - h], [x + h, y], [x, y + h], [x - h, y]], color);
      draw.polygon([[x, y - h * 0.62], [x + h * 0.62, y], [x, y + h * 0.62], [x - h * 0.62, y]], "#00000088");
      draw.polygon([[x, y - h * 0.34], [x + h * 0.34, y], [x, y + h * 0.34], [x - h * 0.34, y]], color);
      break;
    case "income": {
      const r = h * 0.72;
      draw.strokeArc(x, y, r, -Math.PI * 0.35, Math.PI * 1.35, color, lw);
      const ax = x + Math.cos(-Math.PI * 0.35) * r, ay = y + Math.sin(-Math.PI * 0.35) * r;
      draw.polygon([[ax - h * 0.42, ay - h * 0.12], [ax + h * 0.22, ay - h * 0.32], [ax + h * 0.05, ay + h * 0.32]], color);
      break;
    }
    case "workers":
      // A pick: a curved head over a handle.
      draw.line(x - h * 0.75, y + h * 0.8, x + h * 0.55, y - h * 0.5, color, lw * 1.2);
      draw.strokeArc(x + h * 0.25, y - h * 0.2, h * 0.75, -Math.PI * 0.95, -Math.PI * 0.05, color, lw * 1.3);
      break;
    case "lock":
      draw.strokeArc(x, y - h * 0.15, h * 0.4, Math.PI, Math.PI * 2, color, lw);
      draw.line(x - h * 0.4, y - h * 0.15, x - h * 0.4, y + h * 0.05, color, lw);
      draw.line(x + h * 0.4, y - h * 0.15, x + h * 0.4, y + h * 0.05, color, lw);
      draw.roundRect(x - h * 0.62, y, h * 1.24, h * 0.92, h * 0.12, color);
      break;
    case "flare":
      draw.polygon([[x, y - h], [x + h * 0.22, y - h * 0.22], [x + h, y], [x + h * 0.22, y + h * 0.22], [x, y + h], [x - h * 0.22, y + h * 0.22], [x - h, y], [x - h * 0.22, y - h * 0.22]], color);
      break;
    case "warn":
      draw.polygon([[x, y - h * 0.85], [x + h * 0.9, y + h * 0.75], [x - h * 0.9, y + h * 0.75]], color);
      break;
    case "pause":
      draw.rect(x - h * 0.55, y - h * 0.7, h * 0.38, h * 1.4, color);
      draw.rect(x + h * 0.17, y - h * 0.7, h * 0.38, h * 1.4, color);
      break;
  }
}

/** A glyph in the layout, `size` logical pixels square. */
export function glyph(g: Glyph, size: number, color: string): void {
  ui.widget("", { role: "none", size: { width: size, height: size }, draw: (r) => drawGlyph(g, r.x + r.width / 2, r.y + r.height / 2, r.height, color) });
}
