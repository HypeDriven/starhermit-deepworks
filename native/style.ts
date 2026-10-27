// The look of the menus, HUD and dialogs: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (checkboxes, selects, text
// fields, dialogs, scroll bars) take. The browser build's body classes are
// token sets laid over the sheet's: the mine theme's accents
// (body[data-theme]), high contrast while the runtime's option is on
// (body.hc), then the colour-blind palette (body.pal-*), in the old
// cascade's order.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
const THEMES: Record<string, Tokens> = {
  emberdeep: {},
  glacier: { accent: "#8fe0ff", "accent-strong": "#6fd6ff", bg: "#0a152b", panel: "#0d1c34f0", "panel-solid": "#192f50", line: "#365978" },
  verdant: { accent: "#9dffb4", "accent-strong": "#7dff9e", bg: "#081d22", panel: "#0b2021f0", "panel-solid": "#163b39", line: "#35665d" },
  amethyst: { accent: "#d09aff", "accent-strong": "#c07dff", bg: "#14102c", panel: "#1d1430f0", "panel-solid": "#352446", line: "#66507c" },
  ashen: { accent: "#ffe066", "accent-strong": "#ffd23c", bg: "#10192b", panel: "#121b2cf0", "panel-solid": "#26354b", line: "#4a5e76" },
};
const HIGH_CONTRAST: Tokens = {
  bg: "#000000", panel: "#000000f5", "panel-solid": "#000000", text: "#ffffff", "text-dim": "#e8e8e8", line: "#ffffff",
  accent: "#ffff00", "accent-strong": "#ffff00", focus: "#00ffff",
};
const PALETTES: Record<string, Tokens> = {
  default: {},
  deuter: { accent: "#4cc9f0", "accent-strong": "#4cc9f0", good: "#f5d90a", bad: "#f72585" },
  protan: { accent: "#4cc9f0", "accent-strong": "#4cc9f0", good: "#f5d90a", bad: "#f72585" },
  tritan: { accent: "#ff8fa3", "accent-strong": "#ff8fa3", good: "#06d6a0", bad: "#ffd166" },
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: "#f3eee4", muted: "#adc2cd", panel: "#132d40", control: "#132d40", hovered: "#1a3a52",
    pressed: "#0f2433", field: "#0c1b28", accent: "#ff9a3c", focus: "#8fd6ff", outline: "#315267",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$text" }, minHeight: 44,
      parts: { box: { background: "$panel-solid", border: { width: 2, color: "$line" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$text" }, background: "$panel-solid", border: { width: 1, color: "$line" }, radius: 8, minHeight: 44 },
    textField: { text: { color: "$text" }, background: "$panel-solid", border: { width: 1, color: "$line" }, radius: 8, minHeight: 44 },
    progress: { parts: { track: { background: "#000000", border: { width: 1, color: "$line" }, radius: 99 }, fill: { background: "$accent-strong", radius: 99 } } },
    dialog: {
      background: "$panel-solid", radius: 14, padding: 22, border: { width: 1, color: "$line" },
      parts: { backdrop: { background: "#00000099" } },
    },
    scrollArea: { parts: { bar: { background: "$line", radius: 4 } } },
    tooltip: { background: "$panel-solid", text: { color: "$text" }, radius: 6, padding: 6 },
  });
}

let key = "";
let tokens: Tokens = {};
/** The theme's, high contrast's and the palette's tokens over the sheet's. */
export function applyTokens(theme: string, highContrast: boolean, palette: string): void {
  const k = `${theme}|${highContrast}|${palette}`;
  if (k === key) return;
  key = k;
  tokens = { ...base, ...(THEMES[theme] ?? {}), ...(highContrast ? HIGH_CONTRAST : {}), ...(PALETTES[palette] ?? {}) };
  ui.setTokens(tokens);
}
/** A token's colour now (for drawn glyphs and the page around the scene). */
export function tok(name: string): string { return String(tokens[name] ?? base[name] ?? "#ffffff"); }
