// The browser build's DOM shell (index.html + js/ui.js + css/styles.css) as
// starhermit:ui, built every frame over the mine: the title (key art, the
// DEEPWORKS logo, the saved-shift banner, Play, Daily Vein with its
// countdown, Journey with its progress, Profile, How to play, Leaderboards,
// Settings, sign-in / invite, the identity line), the mode cards, the mode
// setups (lesson, practice and challenge lists; the rules sheet with Start
// shift), the Journey grid, the boards, Help, Profile, Settings (the pause
// menu with Resume, Restart, End & bank, Leave) and the results; the play
// HUD (the top bar with the objective and its meter, credits, income,
// workers and the clock with Pause; the Shift Report and the Foreman's Panel
// rails, drawers on narrower windows; the phone's thumb-zone tray; the
// lesson card; the countdown; the layer labels over the mine), the confirm
// and "while you were away" dialogs, the toasts and the captions. The
// browser's media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: rails beside the mine), drawers (narrower: the rails
// open from toggles), phone (≤ 640 px, or a touch screen ≤ 900 px: the tray
// and a two-row top bar), short landscape (≤ 500 px tall: no art, compact
// rails and a docked lesson card); the left-handed setting swaps the rails.
import { frame, openMenu } from "starhermit:engine";
import { primaryPointer, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { C, R, S, type Content, type Legal, type State } from "./classic.ts";
import { N, T } from "./i18n.ts";
import { glyph, type Glyph } from "./glyphs.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  ACHIEVEMENTS, app, back, blockers, claimActiveFlare, confirm, contentName, dailyContent, describeMine, discardSaved,
  doCommand, doUndo, endRun, fmtTime, foremanCmd, goalText, holdRects, inviteFriend, keyLabel, leaveRun, leaveToTitle,
  lessonBanner, lessonToContent, loadBoard, nameText, objectiveText, onLayerPicked, openSettings, openSetup, pauseGame, practiceContent,
  profile, restartRun, resultsHeadline, resumeGame, resumeSaved, setDisplayName, settings, sfx, show, signIn, startRun, wipeProfile,
  type SetupMode,
} from "./main.ts";
import { tok } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; phone: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 500;
  const phone = lw <= 640 || (primaryPointer() === "coarse" && lw <= 900);
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, wide: lw >= 1024, phone, shortLand };
}
const lastSize = new Map<string, { w: number; h: number }>();
const pr = (): ui.UiPreferences => ui.preferences();
function textWidth(text: string, style: string | readonly string[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / pr().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 4;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; width?: number; back?: boolean }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected) opts.selected = true;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 24);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) { sfx(b.back ? "ui_back" : "ui_click"); b.act(); }
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "start", gap = 6): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, b.width ?? (buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null));
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / pr().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
/** A key/value row (.kv): the key at the start, the bold value at the end. */
function kv(id: string, k: string, v: string, w: number): void {
  ui.row(id, () => {
    para(k, Math.max(40, w - textWidth(v, "kv-v") - 10), "kv-k");
    ui.spacer();
    ui.style("kv-v").label(v);
  }, { style: "kv", width: w, align: "center", spacing: 0 });
}
function starsText(n: number): string { return "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n)); }
/** A picture cover-fitted into a box (decorative; the fallback colour shows while it loads). */
function art(id: string, path: string, w: number, h: number): void {
  ui.id(id).widget("", {
    role: "none", size: { width: w, height: h },
    draw: (r, s) => draw.box(r.x, r.y, r.width, r.height, { background: [{ image: path, size: "cover" }, "#000000"], radius: 10 * s.scale, border: { width: 1, color: tok("line") } }),
  });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  if (app.screen === "play" && app.run) playHud(L);
  else {
    render.setView(0, 0, frame().width, frame().height, frame().width, frame().height);
    switch (app.screen) {
      case "title": titleScreen(L); break;
      case "modes": modesScreen(L); break;
      case "setup": setupScreen(L); break;
      case "journey": journeyScreen(L); break;
      case "boards": boardsScreen(L); break;
      case "help": helpScreen(L); break;
      case "settings": settingsScreen(L); break;
      case "results": resultsScreen(L); break;
      case "profile": profileScreen(L); break;
      default: titleScreen(L);
    }
  }
  modal(L);
  toasts(L);
  if (app.focusNext) {
    const age = frame().frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A screen's panel (.screen > .panel): centred, `maxW` wide, scrolling when taller than the window. */
function page(key: string, L: Layout, maxW: number, build: (w: number) => void, center = false): void {
  const pad = 16;
  const tight = L.phone || L.shortLand;
  const padX = tight ? 18 : 32;
  const pw = Math.min(maxW, L.lw - 2 * pad);
  const avail = Math.max(80, L.lh - 2 * pad);
  const h = lastSize.get(key)?.h ?? 0;
  const scroll = h > avail;
  const inner = pw - 2 * padX - (scroll ? 12 : 0);
  const body = (): void => {
    const r = ui.column(`${key}-col`, () => build(inner), { style: tight ? "panel-tight" : "panel", width: pw - (scroll ? 12 : 0), spacing: 10, align: center ? "center" : "start" });
    lastSize.set(key, { w: r.width / L.sc, h: r.height / L.sc });
  };
  const y = scroll ? pad : Math.max(pad, (L.lh - h) / 2);
  const placed = ui.place(`page-${key}`, { anchor: "top-start", x: 0, y }, () => {
    const fresh = frame().frame - app.openedFrame <= 5;
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: L.lw, height: L.lh - 2 * pad }, () => ui.column(`${key}-sc`, body, { width: L.lw - 12, align: "center" }), fresh ? { scrollTo: { top: 0 } } : undefined);
    else ui.column(`${key}-center`, body, { width: L.lw, align: "center" });
  }, { width: L.lw });
  void placed;
}
function heading(text: string, w: number, cls = "h2", id?: string): void { para(text, w, cls, id); }
function backBtn(w: number, label = T("← Back"), act: () => void = back): void {
  flow("back-row", [{ id: "btn-back", text: label, style: ["btn", "btn-ghost"], act, back: true }], w);
}

// ------------------------------------------------------------------ title
function titleScreen(L: Layout): void {
  const p = profile();
  page("title", L, 480, (w) => {
    // Short windows keep the menu in view: the key art shrinks first.
    if (!L.shortLand) art("title-art", "assets/key-art.webp", w, Math.min(190, w * 0.46, Math.max(80, L.lh - 470)));
    ui.row("logo", () => {
      ui.style("logo-a").label("DEEP");
      ui.style("logo-b").label("WORKS");
    }, { spacing: 0, align: "center" });
    para(T("Assign. Upgrade. Optimize. The seams are glowing."), w, "tagline", "tagline", true);
    const saved = app.savedRun;
    if (saved) {
      ui.column("resume-banner", () => {
        para(T("A previous shift is waiting ({id}).", { id: saved.contentId }), w - 26, "body");
        flow("resume-row", [
          { id: "btn-resume-saved", text: T("Resume shift"), style: ["btn", "btn-primary", "btn-small"], act: resumeSaved },
          { id: "btn-abandon-saved", text: T("Abandon"), style: ["btn", "btn-ghost", "btn-small"], act: discardSaved },
        ], w - 26);
      }, { style: "resume-banner", width: w, spacing: 6 });
    }
    const ms = platform.msUntilNextDaily();
    const s = Math.floor(ms / 1000);
    const countdown = T("(new in {h}h {m}m)", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
    const done = Object.keys(p.journey).length;
    ui.column("title-buttons", () => {
      button({ id: "btn-play", text: T("Play"), style: ["btn", "btn-primary", "btn-big"], act: () => show("modes", "mode-learn") }, w);
      sub("btn-daily", T("Daily Vein"), countdown, w, () => openSetup("daily"));
      sub("btn-journey", T("Journey"), done ? `(${done}/${C.JOURNEY.length})` : "", w, () => show("journey", "jnode-1"));
      button({ id: "btn-profile", text: T("Profile"), style: ["btn", "btn-ghost"], act: () => show("profile") }, w);
    }, { spacing: 10, width: w });
    flow("title-links", [
      { id: "btn-help", text: T("How to play"), style: ["btn", "btn-link"], act: () => show("help") },
      { id: "btn-boards", text: T("Leaderboards"), style: ["btn", "btn-link"], act: () => show("boards") },
      { id: "btn-settings", text: T("Settings"), style: ["btn", "btn-link"], act: openSettings },
    ], w, "center", 16);
    const plat: Btn[] = [];
    if (!platform.signedIn()) plat.push({ id: "btn-signin", text: T("Sign in with StarHermit"), style: ["btn", "btn-ghost"], act: signIn });
    if (platform.inviteLink()) plat.push({ id: "btn-invite", text: T("Invite a friend"), style: ["btn", "btn-ghost"], act: inviteFriend });
    if (plat.length) flow("title-platform", plat, w, "center", 16);
    const st = platform.syncState();
    const ident = platform.signedIn()
      ? T("Playing as {name}", { name: nameText(platform.displayName()) }) + " · " + (st === "synced" ? T("progress synced") : st === "saving" ? T("saving…") : T("cloud sync unavailable"))
      : T("Playing as {name} (guest — progress stays on this device)", { name: nameText(p.displayName) });
    para(ident, w, "dim", "title-identity", true);
  }, true);
}
/** A button with a subtle second part (Daily Vein's countdown, Journey's progress). */
function sub(id: string, text: string, extra: string, w: number, act: () => void): void {
  if (ui.style("btn", { width: w }).id(id).button(text + (extra ? " " + extra : ""), {
    content: () => ui.row(`${id}-face`, () => { ui.style("body").label(text); if (extra) ui.style("dim").label(extra); }, { spacing: 8, align: "center" }),
  })) { sfx("ui_click"); act(); }
}

// ------------------------------------------------------------------ cards
interface Card { id: string; title: string; lines: { text: string; cls: string }[]; badges?: { text: string; ranked?: boolean }[]; disabled?: boolean; act: () => void }
/** Cards in rows (CSS grid auto-fit minmax(220px, 1fr)), each row as tall as its tallest card. */
function cardGrid(id: string, cards: Card[], w: number, minW = 220): void {
  const gap = 13;
  const cols = Math.max(1, Math.floor((w + gap) / (minW + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  const inner = cw - 34;
  ui.column(id, () => {
    for (let i = 0; i < cards.length; i += cols) {
      ui.row(`${id}-r${i}`, () => {
        for (const c of cards.slice(i, i + cols)) {
          const label = [c.title, ...c.lines.map((l) => l.text)].join(". ");
          if (ui.style("card", { width: cw }).id(c.id).button(label, {
            disabled: !!c.disabled,
            content: () => ui.column(`${c.id}-face`, () => {
              para(c.title, inner, "card-h");
              for (const l of c.lines) para(l.text, inner, l.cls);
              if (c.badges) ui.row(`${c.id}-badges`, () => {
                for (const [bi, b] of c.badges!.entries()) ui.row(`${c.id}-b${bi}`, () => ui.style(b.ranked ? "badge-ranked-t" : "badge-t").label(b.text), { style: b.ranked ? "badge-ranked" : "badge" });
              }, { spacing: 4 });
            }, { spacing: 4, align: "start", width: inner }),
          })) { sfx("ui_click"); c.act(); }
        }
      }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}

// ------------------------------------------------------------------ modes
const MODES = [
  { id: "learn", name: N("Learn"), desc: N("Interactive lessons. One rule at a time — you perform every action."), time: N("2–4 min each"), ranked: false },
  { id: "journey", name: N("Journey"), desc: N("40 authored stages. New mechanics arrive alone, combine, then test mastery."), time: N("3–20 min each"), ranked: false },
  { id: "daily", name: N("Daily Vein"), desc: N("One shared seed and ruleset per UTC day. Everyone digs the same mine."), time: N("15 min cap"), ranked: true },
  { id: "practice", name: N("Practice"), desc: N("Free play at your chosen difficulty. Restart and undo allowed. Unranked."), time: N("endless"), ranked: false },
  { id: "challenge", name: N("Challenge"), desc: N("Constrained shifts: move limits, speed targets, restricted tools."), time: N("10–25 min"), ranked: false },
  { id: "score", name: N("Score Chase"), desc: N("Chase the boards — daily and all-time, global or friends."), time: "—", ranked: true },
];
function modesScreen(L: Layout): void {
  page("modes", L, 900, (w) => {
    heading(T("Choose your shift"), w);
    cardGrid("mode-grid", MODES.map((m) => ({
      id: `mode-${m.id}`, title: T(m.name), lines: [{ text: T(m.desc), cls: "card-p" }],
      badges: [{ text: m.ranked ? T("ranked") : T("casual"), ranked: m.ranked }, { text: T(m.time) }],
      act: () => {
        if (m.id === "score") show("boards");
        else if (m.id === "journey") show("journey", "jnode-1");
        else openSetup(m.id as SetupMode);
      },
    })), w);
    backBtn(w);
  });
}

// ------------------------------------------------------------------ setup
function mechanicsText(m: { lift: boolean; flares: boolean; foreman: boolean; shaftUpgrades: boolean }): string {
  const out: string[] = [];
  out.push(m.lift ? T("lift") : T("no lift upgrades"));
  if (m.flares) out.push(T("flares"));
  if (m.foreman) out.push(T("foreman"));
  if (!m.shaftUpgrades) out.push(T("no shaft upgrades"));
  return out.join(" · ");
}
function practiceDesc(id: string): string {
  const d: Record<string, string> = {
    prospector: N("Gentle start: extra credits, cheap hires, two open seams."),
    miner: N("The standard ruleset, from scratch."),
    foreman: N("Tighter: pricier labour and unlocks, weaker lift."),
    overseer: N("Brutal: minimal crew, expensive everything, six sealed seams."),
  };
  return d[id] ? T(d[id]!) : "";
}
function setupShell(w: number, title: string, entry: Content, mode: SetupMode, extra: string, extraCls = "body"): void {
  heading(title, w, "h2", "setup-h");
  const rs = R.mergeRuleset(entry.overrides || {});
  ui.column("setup-info", () => {
    kv("kv-seams", T("Seams"), String(rs.layerCount), w);
    kv("kv-goal", T("Goal"), goalText(entry.goals), w);
    kv("kv-limit", T("Time limit"), entry.limits && entry.limits.timeSec ? fmtTime(entry.limits.timeSec) : T("none"), w);
    kv("kv-par", T("Par"), entry.parSec ? fmtTime(entry.parSec) : "—", w);
    kv("kv-mech", T("Mechanics"), mechanicsText(rs.mechanics), w);
    kv("kv-seed", T("Seed"), "#" + (entry.seed >>> 0).toString(36), w);
    const ranked = mode === "daily";
    ui.row("setup-badge", () => ui.style(ranked ? "badge-ranked-t" : "badge-t").label(ranked ? T("ranked — same seed for everyone") : T("casual — unranked")), { style: ranked ? "badge-ranked" : "badge" });
  }, { spacing: 2, width: w });
  para(extra, w, extraCls, "setup-extra");
  flow("setup-row", [
    { id: "btn-start", text: T("Start shift"), style: ["btn", "btn-primary"], act: () => startRun(entry, mode) },
    { id: "btn-setup-back", text: T("Back"), style: ["btn", "btn-ghost"], act: back, back: true },
  ], w);
}
function setupScreen(L: Layout): void {
  const { mode, content } = app.setup;
  const p = profile();
  const wide = mode === "learn" || mode === "practice" || mode === "challenge";
  page(`setup-${mode}`, L, wide ? 900 : 640, (w) => {
    if (mode === "learn") {
      heading(T("Learn"), w);
      cardGrid("lesson-list", C.LESSONS.map((ls, i) => {
        const doneL = !!p.lessons[ls.id];
        const locked = i > 0 && !p.lessons[C.LESSONS[i - 1]!.id];
        const lines = [{ text: T(ls.intro), cls: "card-p" }];
        if (locked) lines.push({ text: T("Complete the previous lesson first."), cls: "dim" });
        return { id: `lesson-${i + 1}`, title: (doneL ? "✓ " : "") + T(ls.name), lines, disabled: locked, act: () => openSetup("learn-go", lessonToContent(ls)) };
      }), w);
      backBtn(w, T("Back"));
    } else if (mode === "practice") {
      heading(T("Practice"), w);
      cardGrid("practice-list", C.PRACTICE_DIFFICULTIES.map((d) => {
        const lines = [{ text: practiceDesc(d.id), cls: "card-p" }];
        const best = p.practice[d.id];
        if (best) lines.push({ text: T("Best: {score}", { score: R.formatCoins(best) }), cls: "dim" });
        return { id: `practice-${d.id}`, title: T(d.name), lines, act: () => openSetup("practice-go", practiceContent(d)) };
      }), w);
      backBtn(w, T("Back"));
    } else if (mode === "challenge") {
      heading(T("Challenges"), w);
      cardGrid("challenge-list", C.CHALLENGES.map((ch) => {
        const lines = [{ text: T(ch.description ?? ""), cls: "card-p" }];
        const best = p.challenges[ch.id];
        if (best) lines.push({ text: T("Best: {score}", { score: R.formatCoins(best) }), cls: "dim" });
        return { id: `challenge-${ch.id}`, title: T(ch.name), lines, act: () => openSetup("challenge-go", ch) };
      }), w);
      backBtn(w, T("Back"));
    } else if (mode === "learn-go" && content) {
      setupShell(w, T("Lesson: {name}", { name: T(content.name) }), content, mode, T(content.lesson!.intro));
    } else if (mode === "daily") {
      const info = dailyContent();
      const played = p.daily[info.key!];
      setupShell(w, T("Daily Vein — {date}", { date: info.key! }), info, mode,
        played ? T("You already dug today: score {score}. You can improve it until the day rolls over.", { score: R.formatCoins(played.score) })
          : T("Same seed for everyone today. Your input log is validated server-side when hosted."), played ? "dim" : "body");
    } else if (mode === "practice-go" && content) {
      setupShell(w, contentName(content), content, mode, T("Endless. Undo allowed (Z). End the shift from the pause menu to bank your score."), "dim");
    } else if (mode === "challenge-go" && content) {
      setupShell(w, T("Challenge: {name}", { name: T(content.name) }), content, mode, T(content.description ?? ""));
    } else if (mode === "journey-go" && content) {
      setupShell(w, T("Stage {n}: {name}", { n: content.n!, name: T(content.name) }), content, mode, content.hint ? T(content.hint) : "");
    }
  });
}

// ------------------------------------------------------------------ journey
function journeyScreen(L: Layout): void {
  const p = profile();
  page("journey", L, 900, (w) => {
    heading(T("Journey"), w);
    let done = 0, stars = 0, firstIncomplete = -1;
    C.JOURNEY.forEach((s, i) => { const rec = p.journey[s.id]; if (rec) { done++; stars += rec.stars; } else if (firstIncomplete < 0) firstIncomplete = i; });
    para(T("{done} of {total} stages complete · {stars} of {maxStars} stars", { done, total: C.JOURNEY.length, stars, maxStars: C.JOURNEY.length * 3 }), w, "dim", "journey-summary");
    const gap = 6;
    const cols = Math.max(1, Math.floor((w + gap) / (64 + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.column("journey-grid", () => {
      for (let i = 0; i < C.JOURNEY.length; i += cols) {
        ui.row(`jg-${i}`, () => {
          for (let j = i; j < Math.min(C.JOURNEY.length, i + cols); j++) {
            const s = C.JOURNEY[j]!;
            const rec = p.journey[s.id];
            const locked = j > 0 && !p.journey[C.JOURNEY[j - 1]!.id] && !rec;
            const label = rec ? T("Stage {n} {name}, completed, {stars} stars", { n: s.n!, name: T(s.name), stars: rec.stars })
              : locked ? T("Stage {n} {name}, locked", { n: s.n!, name: T(s.name) }) : T("Stage {n} {name}", { n: s.n!, name: T(s.name) });
            const cls = ["jnode", rec ? "jnode-done" : "", j === firstIncomplete ? "jnode-current" : ""].filter(Boolean);
            if (ui.style(...cls, { width: cw, height: cw }).id(`jnode-${s.n}`).tooltip(T(s.name) + (locked ? " " + T("(complete the previous stage)") : "")).button(label, {
              disabled: locked,
              content: () => ui.column(`jn-${s.n}`, () => {
                ui.style("jnode-n").label(String(s.n));
                if (rec) ui.style("jnode-stars").label(starsText(rec.stars));
              }, { spacing: 0, align: "center" }),
            })) { sfx("ui_click"); openSetup("journey-go", s); }
          }
        }, { spacing: gap });
      }
    }, { spacing: gap, width: w });
    backBtn(w);
  });
}

// ------------------------------------------------------------------ boards
function boardsScreen(L: Layout): void {
  page("boards", L, 640, (w) => {
    heading(T("Leaderboards"), w);
    const hosted = platform.signedIn();
    para(hosted ? T("StarHermit high-score board: Journey, Daily and Challenge run scores.") : T("Offline mode: boards are local to this device and marked casual."), w, "dim");
    const tabs = hosted ? [T("High score")] : [T("Daily"), T("All-time")];
    flow("board-tabs", tabs.map((t, i) => ({ id: `tab-${i}`, text: t, style: i === app.boardTab ? ["btn"] : ["btn", "btn-ghost"], selected: i === app.boardTab, act: () => loadBoard(i) })), w);
    const b = app.boards;
    if (!b || !b.entries) para(T("Loading…"), w, "dim");
    else {
      if (b.casual) para(T("Casual board (no server validation)."), w, "dim");
      if (!b.entries.length) para(T("No entries yet. Be the first."), w, "body", "board-empty");
      else {
        const me = profile().displayName;
        const c0 = 36, c2 = Math.min(110, w * 0.24), c3 = Math.min(90, w * 0.2), c1 = w - c0 - c2 - c3;
        const row = (id: string, cells: string[], cls: string, mine = false): void => {
          ui.row(id, () => cells.forEach((c, i) => ui.column(`${id}-${i}`, () => para(c, [c0, c1, c2, c3][i]! - 8, mine ? "board-me" : cls), { width: [c0, c1, c2, c3][i]! })), { style: "board-row", width: w, align: "center" });
        };
        row("board-head", ["#", T("Prospector"), T("Score"), T("Duration")], "board-head");
        b.entries.slice(0, 25).forEach((e, i) => row(`board-${i}`, [String(e.rank || i + 1), e.name || T("Anonymous"), R.formatCoins(e.score), e.durationSec != null ? fmtTime(e.durationSec) : "—"], "board-cell", e.me != null ? e.me : e.name === me));
      }
    }
    backBtn(w, T("Back"));
  });
}

// ------------------------------------------------------------------ help
function helpScreen(L: Layout): void {
  page("help", L, 900, (w) => {
    heading(T("How to play"), w);
    const km: Record<string, string> = {};
    for (const a of ["assign", "unassign", "hire", "shaft", "liftCap", "liftSpeed", "unlock", "flare", "foreman", "undo", "up", "down", "pause"]) km[a] = keyLabel(a.toLowerCase());
    const cards: [string, string][] = [
      [T("The loop"), T("Workers dig ore into bins. The lift hauls ore to the surface and sells it for credits. Credits buy workers, shaft upgrades, lift upgrades and deeper seams. Find the bottleneck, fix it, automate.")],
      [T("Workers"), T("Assign ({assign}) moves an idle worker to the selected layer. Unassign ({unassign}) pulls one back. Hire ({hire}) adds a new worker — they arrive idle.", km)],
      [T("Shafts"), T("Upgrading a layer's shaft ({shaft}) raises its extraction rate and its ore bin capacity.", km)],
      [T("Transport"), T("Ore only earns when the lift moves it. Upgrade capacity ({liftCap}) for bigger loads and speed ({liftSpeed}) for shorter cycles. A full bin stalls digging — the gauge turns red.", km)],
      [T("Deeper seams"), T("Unlock ({unlock}) the next sealed layer. Deeper ore is richer per worker and sells for more — but it all rides the same lift.", km)],
      [T("Seam flares"), T("Occasionally a seam flares bright. Claim it ({flare}) before it fades for an instant payout. Flare timing comes from the run seed — it is identical for everyone on a daily.", km)],
      [T("The Foreman"), T("A one-time purchase that automates routine: assigns idle workers and buys bottleneck fixes on a fixed cadence. You keep strategy; it keeps the floor.")],
      [T("Fair play"), T("All randomness is seeded and inspectable. No purchases affect power. Practice allows undo ({undo}); ranked modes never do.", km)],
      [T("Controls"), T("Pointer/touch: tap a layer to select, then use the Foreman's Panel. Keyboard: {up}/{down} select layer, {assign} assign, {pause} pause. Gamepad: D-pad select, A confirm, B back, Start pause.", km)],
    ];
    ui.column("help-cards", () => {
      cards.forEach(([h, t], i) => ui.column(`help-${i}`, () => {
        para(h, w - 34, "card-h");
        para(t, w - 34, "card-p");
      }, { style: "card", width: w, spacing: 4 }));
    }, { spacing: 10, width: w });
    flow("help-narrate", [{ id: "btn-narrate", text: T("Describe the current mine aloud"), style: ["btn", "btn-ghost", "btn-small"], act: describeMine }], w);
    backBtn(w);
  });
}

// ------------------------------------------------------------------ profile
function profileScreen(L: Layout): void {
  const p = profile();
  page("profile", L, 640, (w) => {
    heading(T("Profile"), w);
    ui.row("name-row", () => {
      if (platform.signedIn()) ui.style("body").label(nameText(platform.displayName()));
      else {
        app.nameDraft = ui.textField("display-name", app.nameDraft, { maxChars: 24, width: Math.min(280, w - 100), placeholder: T("Display name") });
        button({ id: "btn-name-save", text: T("Save"), style: ["btn", "btn-small"], act: () => setDisplayName(app.nameDraft) });
      }
    }, { style: "set-row", width: w, spacing: 12, align: "center" });
    const ml = S.masteryLevelFor(p.mastery.xp);
    heading(T("Mastery — level {n}", { n: ml.level }), w, "h3");
    ui.progress(ml.into / ml.next, w);
    para(T("{into} / {next} xp", { into: ml.into, next: ml.next }), w, "dim");
    heading(T("Career"), w, "h3");
    kv("kv-runs", T("Shifts played"), String(p.stats.runsPlayed), w);
    kv("kv-earned", T("Career earnings"), R.formatCoins(p.stats.totalEarned), w);
    kv("kv-flares", T("Flares claimed"), String(p.stats.flaresClaimed), w);
    kv("kv-time", T("Time underground"), fmtTime(p.stats.playtimeSec), w);
    heading(T("Achievements"), w, "h3");
    for (const a of ACHIEVEMENTS) {
      const got = !!p.achievements[a.key];
      ui.row(`ach-${a.key}`, () => {
        const nw = Math.min(w * 0.45, textWidth((got ? "★ " : "☆ ") + T(a.name), "body") + 4);
        para((got ? "★ " : "☆ ") + T(a.name), nw, "body");
        ui.spacer();
        para(T(a.desc), w - nw - 24, "dim");
      }, { style: "set-row", width: w, spacing: 0, align: "center" });
    }
    if (!platform.signedIn()) para(T("Guest mode: sign-in is offered by the host shell when Deepworks is played hosted."), w, "dim");
    backBtn(w, T("Back"));
  });
}

// ------------------------------------------------------------------ settings
function group(id: string, title: string, w: number, build: () => void): void {
  ui.column(id, () => { para(title, w, "group-h"); build(); }, { spacing: 2, width: w });
}
function toggle(key: "captions" | "cameraSway" | "holdRepeat" | "leftHanded" | "haptics" | "timingAssist", label: string, w: number): void {
  ui.row(`row-${key}`, () => {
    const cur = settings[key];
    const next = ui.id(`set-${key}`).style({ width: w }).checkbox(label, cur);
    if (next !== cur) { sfx("ui_click"); platform.setSetting(key, next); }
  }, { style: "set-row", width: w });
}
function selectRow(id: string, label: string, w: number, options: [string, string][], cur: string, set: (v: string) => void): void {
  ui.row(`row-${id}`, () => {
    para(label, Math.max(80, w * 0.45), "body");
    ui.spacer();
    const idx = Math.max(0, options.findIndex((o) => o[0] === cur));
    const next = ui.style({ width: Math.min(240, w * 0.5) }).id(`set-${id}`).select(label, idx, options.map((o) => o[1]));
    if (next !== idx) set(options[next]![0]);
  }, { style: "set-row", width: w, align: "center", spacing: 10 });
}
function settingsScreen(L: Layout): void {
  const inPause = app.settingsInPause && !!app.run;
  page("settings", L, 640, (w) => {
    heading(inPause ? T("Paused") : T("Settings"), w, "h2", "settings-h");
    if (inPause) {
      const list: Btn[] = [
        { id: "btn-resume", text: T("Resume"), style: ["btn", "btn-primary"], act: resumeGame },
        { id: "btn-restart", text: T("Restart shift"), style: ["btn", "btn-ghost"], act: () => confirm(T("Restart this shift from the beginning?"), restartRun) },
      ];
      if (app.run!.mode === "practice") list.push({ id: "btn-bank", text: T("End shift & bank score"), style: ["btn", "btn-ghost"], act: () => confirm(T("End this shift and bank your score?"), endRun) });
      list.push({ id: "btn-leave", text: T("Leave shift"), style: ["btn", "btn-ghost"], act: () => confirm(T("Leave the shift? Progress in this run will be lost."), leaveRun) });
      flow("pause-row", list, w);
    }
    group("g-audio", T("Audio"), w, () => {
      para(T("Music, effects and voice volumes and mute are in the StarHermit Options."), w, "dim");
      flow("audio-opts", [{ id: "btn-options-audio", text: T("Open Options"), style: ["btn", "btn-small"], act: () => openMenu() }], w);
      toggle("captions", T("Text captions for sounds"), w);
    });
    group("g-gfx", T("Graphics"), w, () => {
      para(T("Graphics quality, render scale and frame rate are in the StarHermit Options."), w, "dim");
      selectRow("theme", T("Mine theme"), w, C.THEMES.map((t) => [t.id, T(t.name)]), settings.theme, (v) => platform.setSetting("theme", v));
      toggle("cameraSway", T("Camera sway"), w);
    });
    group("g-controls", T("Controls"), w, () => {
      toggle("holdRepeat", T("Hold to repeat assign"), w);
      toggle("leftHanded", T("Left-handed layout"), w);
      toggle("haptics", T("Haptics (vibration)"), w);
      para(T("Keys: ↑/↓ select layer · Enter assign · U unassign · H hire · Q shaft · W lift capacity · E lift speed · D unlock · F flare · G foreman · Z undo · Esc pause."), w, "dim");
      flow("rebind", [{ id: "btn-rebind", text: T("Change keys and buttons"), style: ["btn", "btn-small"], act: () => requestRebind() }], w);
    });
    group("g-a11y", T("Accessibility"), w, () => {
      para(T("Reduced motion, high contrast and text size are in the StarHermit Options."), w, "dim");
      selectRow("palette", T("Color palette"), w, [["default", T("Default")], ["deuter", T("Deuteranopia-safe")], ["protan", T("Protanopia-safe")], ["tritan", T("Tritanopia-safe")]], settings.palette, (v) => platform.setSetting("palette", v));
      toggle("timingAssist", T("Timing assistance (longer flares — not in the ranked daily)"), w);
      ui.row("row-tutorial", () => {
        para(T("Tutorial"), w * 0.4, "body");
        ui.spacer();
        button({ id: "btn-replay-lessons", text: T("Replay lessons"), style: ["btn", "btn-small", "btn-ghost"], act: () => openSetup("learn") });
      }, { style: "set-row", width: w, align: "center" });
    });
    group("g-data", T("Data"), w, () => {
      ui.row("row-wipe", () => {
        para(T("Local data"), w * 0.4, "body");
        ui.spacer();
        button({ id: "btn-wipe", text: T("Erase profile"), style: ["btn", "btn-small", "btn-ghost"], act: () => confirm(T("Erase all local progress, settings and unlocks?"), wipeProfile) });
      }, { style: "set-row", width: w, align: "center" });
    });
    backBtn(w, inPause ? T("Resume") : T("Back"), inPause ? resumeGame : back);
  });
}

// ------------------------------------------------------------------ results
function resultsScreen(L: Layout): void {
  const d = app.results;
  if (!d) { show("title"); return; }
  page("results", L, 640, (w) => {
    const won = d.won && d.reason !== "player-ended";
    if (!L.shortLand) art("result-art", won ? "assets/shift-complete.webp" : "assets/shift-over.webp", w, Math.min(150, w * 0.36));
    heading(resultsHeadline(d), w, won ? "result-win" : "result-lose", "results-headline");
    para(contentName(d.content), w, "dim");
    if (d.stars) ui.style("stars-big").id("results-stars").label(starsText(d.stars));
    ui.style("score-big").id("results-score").label(R.formatCoins(d.score.total));
    para(T("final score"), w, "dim");
    heading(T("Score breakdown"), w, "h3");
    const comp = d.score.components;
    kv("res-ore", T("Ore sold"), R.formatCoins(comp.earned), w);
    kv("res-flares", T("Seam flares"), R.formatCoins(comp.flares), w);
    kv("res-depth", T("Depth bonus"), R.formatCoins(comp.depthBonus), w);
    kv("res-time", T("Time bonus"), R.formatCoins(comp.timeBonus), w);
    kv("res-eff", T("Lift efficiency"), (comp.efficiencyPermille / 10).toFixed(1) + "%", w);
    kv("res-elapsed", T("Elapsed"), fmtTime(d.run.result!.tick), w);
    kv("res-cmds", T("Commands / invalid"), d.run.result!.moves + " / " + d.run.result!.invalid, w);
    if (d.newBest) para(T("★ New personal best!"), w, "body", "results-best");
    if (d.achievements.length) para(T("Achievement unlocked: {name}", { name: d.achievements.map((n) => T(n)).join(", ") }), w, "body", "results-ach");
    if (d.leaderboard) {
      const r = d.leaderboard.result;
      para(!r ? T("Posting score to the leaderboard…") : !r.posted ? T("Score not posted to the leaderboard.")
        : r.rank ? T("Leaderboard rank: #{rank}", { rank: r.rank }) : T("Score posted to the leaderboard."), w, "dim", "results-lb");
    }
    const btns: Btn[] = [];
    if (d.nextContent) btns.push({ id: "", text: T("Next: {name}", { name: T(d.nextContent.name) }), style: ["btn", "btn-primary"], act: () => startRun(d.nextContent!, d.mode) });
    btns.push({ id: "", text: T("Retry"), style: d.nextContent ? ["btn", "btn-ghost"] : ["btn", "btn-primary"], act: () => startRun(d.content, d.mode) });
    btns.push({ id: "", text: T("Shift select"), style: ["btn", "btn-ghost"], act: leaveToTitle });
    btns.forEach((b, i) => { b.id = `btn-results-${i}`; });
    flow("results-row", btns, w);
  });
}

// ------------------------------------------------------------------ the play HUD
function findLegal(legal: Legal[], type: string, layer?: number): Legal {
  return legal.find((a) => a.type === type && (layer === undefined || a.layer === layer)) ?? { type, enabled: false, reason: "unavailable" };
}
function reasonText(reason: string | undefined): string {
  const map: Record<string, string> = {};
  map[R.REASONS.NO_IDLE_WORKER!] = N("No idle workers — hire or unassign first.");
  map[R.REASONS.LAYER_LOCKED!] = N("That layer is still sealed.");
  map[R.REASONS.WORKER_CAP!] = N("This seam is fully crewed.");
  map[R.REASONS.NO_WORKERS!] = N("No workers assigned here.");
  map[R.REASONS.INSUFFICIENT_FUNDS!] = N("Not enough credits.");
  map[R.REASONS.ALL_UNLOCKED!] = N("Every seam is open.");
  map[R.REASONS.NO_FLARE!] = N("No active flare.");
  map[R.REASONS.MECHANIC_DISABLED!] = N("Not available in this ruleset.");
  map[R.REASONS.ALREADY_OWNED!] = N("Already owned.");
  const k = map[reason ?? ""];
  return k ? T(k) : reason ?? "";
}
/** js/ui.js actionButton: the label, its cost (red while unaffordable), disabled with the reason as a tooltip. */
function actionButton(id: string, label: string, cost: number | null, legal: Legal, width: number, act: () => void, hold = false): void {
  const cant = !legal.enabled && legal.reason === R.REASONS.INSUFFICIENT_FUNDS;
  const costText = cost != null ? R.formatCoins(cost) : "";
  const inner = Math.max(20, width - 20);
  const both = textWidth(label, "body") + (costText ? 8 + textWidth(costText, "cost") : 0);
  const opts: ui.ButtonOptions = {
    disabled: !legal.enabled,
    content: () => {
      if (both <= inner) ui.row(`${id}-face`, () => { ui.style("body").label(label); if (costText) ui.style(cant ? "cost-cant" : "cost").label(costText); }, { spacing: 8, align: "center" });
      else ui.column(`${id}-face`, () => { ui.style("body", { text: { align: "center" } }).paragraph(label, inner); if (costText) ui.style(cant ? "cost-cant" : "cost").label(costText); }, { spacing: 0, align: "center" });
    },
  };
  let u = ui.style("btn", { width }).id(id);
  if (!legal.enabled) u = u.tooltip(reasonText(legal.reason));
  let pressed = false;
  const r = ui.row(`${id}-wrap`, () => { pressed = u.button(label + (costText ? " " + costText : ""), opts); }, { spacing: 0 });
  if (hold) holdRects.push(r);
  if (pressed) act();
}
function bottleneckHint(st: State): string {
  for (let i = 0; i < st.layers.length; i++) if (st.layers[i]!.unlocked && R.isBlocked(st, i)) return T("Layer {n} bin is full — transport is the bottleneck.", { n: i + 1 });
  if (st.workers.idle > 0) return st.workers.idle > 1 ? T("{n} idle workers — assign them to a seam.", { n: st.workers.idle }) : T("1 idle worker — assign them to a seam.");
  if (st.flare.active) return T("A seam is flaring on Layer {n} — claim it!", { n: st.flare.active.layer + 1 });
  const next = R.nextLockedLayer(st);
  if (next >= 0 && st.coins >= R.unlockCost(st)) return T("You can afford to open Layer {n}.", { n: next + 1 });
  return T("Watch the gauges; upgrade whatever lags.");
}
function goalFraction(st: State): number | null {
  const g = st.ruleset.goals;
  if (!g) return null;
  if (g.type === "earn") return st.lifetimeEarned / g.amount;
  if (g.type === "depth") return R.unlockedCount(st) / g.amount;
  if (g.type === "rate") return R.totalExtractionRate(st) / g.amount;
  return null;
}
function leftRail(st: State, w: number): void {
  para(T("Shift Report"), w, "rail-title");
  ui.column("rail-rule-l", () => undefined, { style: "rail-rule", width: w });
  kv("sr-elapsed", T("Elapsed"), fmtTime(st.tick), w);
  kv("sr-depth", T("Depth"), T("{n} / {total} seams", { n: R.unlockedCount(st), total: st.layers.length }), w);
  kv("sr-extract", T("Extraction"), R.formatRate(R.totalExtractionRate(st)), w);
  kv("sr-lift", T("Lift capacity"), R.formatRate(Math.floor(R.liftRate(st))), w);
  kv("sr-earned", T("Lifetime earned"), R.formatCoins(st.lifetimeEarned), w);
  const g = st.ruleset.goals;
  if (g) {
    para(T("Goal"), w, "h3-accent");
    kv("sr-goal", goalText(g), Math.floor((goalFraction(st) || 0) * 100) + "%", w);
  }
  if (st.ruleset.parSec) kv("sr-par", T("Par"), fmtTime(st.ruleset.parSec), w);
  para(bottleneckHint(st), w, "dim", "bottleneck-hint");
}
function rightRail(st: State, w: number): void {
  const legal = R.legalActions(st);
  const sel = app.selectedLayer;
  para(T("Foreman's Panel"), w, "rail-title");
  ui.column("rail-rule-r", () => undefined, { style: "rail-rule", width: w });
  const half = (w - 6) / 2;
  if (sel !== null && st.layers[sel] && st.layers[sel]!.unlocked) {
    const L = st.layers[sel]!;
    para(T("Layer {n}", { n: sel + 1 }), w, "h3-accent", "panel-layer");
    kv("fp-crew", T("Crew"), L.workers + " / " + st.ruleset.workerCapPerLayer, w);
    kv("fp-rate", T("Rate"), R.formatRate(R.layerRate(st, sel)), w);
    const cap = R.binCapMilli(st, sel);
    kv("fp-bin", T("Bin"), Math.floor((L.milliOre * 100) / cap) + "%" + (R.isBlocked(st, sel) ? " — " + T("BLOCKED") : ""), w);
    kv("fp-shaft", T("Shaft level"), String(L.shaftLevel), w);
    ui.row("fp-crew-row", () => {
      actionButton("act-assign", T("+ Assign"), null, findLegal(legal, "assign", sel), half, () => doCommand({ type: "assign", layer: sel }), true);
      actionButton("act-recall", T("− Recall"), null, findLegal(legal, "unassign", sel), half, () => doCommand({ type: "unassign", layer: sel }));
    }, { spacing: 6 });
    actionButton("act-shaft", T("Upgrade shaft"), R.shaftCost(st, sel), findLegal(legal, "upgrade_shaft", sel), w, () => doCommand({ type: "upgrade_shaft", layer: sel }));
    if (st.flare.active && st.flare.active.layer === sel) {
      const f = st.flare.active;
      actionButton("act-claim", T("✦ Claim flare"), null, findLegal(legal, "claim_flare", sel), w, () => doCommand({ type: "claim_flare", layer: sel, id: f.id }));
    }
  } else para(T("Tap a layer in the mine to crew and upgrade it."), w, "dim");
  para(T("Mine-wide"), w, "h3-accent");
  actionButton("act-hire", T("Hire worker"), R.hireCost(st), findLegal(legal, "hire"), w, () => doCommand({ type: "hire" }));
  ui.row("fp-lift-row", () => {
    actionButton("act-liftcap", T("Lift capacity"), R.liftCapCost(st), findLegal(legal, "upgrade_lift_cap"), half, () => doCommand({ type: "upgrade_lift_cap" }));
    actionButton("act-liftspeed", T("Lift speed"), R.liftSpeedCost(st), findLegal(legal, "upgrade_lift_speed"), half, () => doCommand({ type: "upgrade_lift_speed" }));
  }, { spacing: 6, align: "stretch" });
  const nextIdx = R.nextLockedLayer(st);
  if (nextIdx >= 0) actionButton("act-unlock", T("Open Layer {n}", { n: nextIdx + 1 }), R.unlockCost(st), findLegal(legal, "unlock_layer"), w, () => doCommand({ type: "unlock_layer" }));
  if (st.ruleset.mechanics.foreman) {
    if (!st.foreman.unlocked) actionButton("act-foreman", T("Buy Foreman"), st.ruleset.foremanCost, findLegal(legal, "buy_foreman"), w, foremanCmd);
    else button({ id: "act-foreman-toggle", text: st.foreman.enabled ? T("Foreman: ON") : T("Foreman: off"), style: st.foreman.enabled ? ["btn"] : ["btn", "btn-ghost"], selected: st.foreman.enabled, act: () => doCommand({ type: "toggle_foreman" }) }, w);
  }
  if (app.mode === "practice") button({ id: "act-undo", text: T("Undo (Z)"), style: ["btn", "btn-ghost"], disabled: !S.canUndo(app.run!), act: doUndo }, w);
}
function tray(st: State, L: Layout): number {
  const legal = R.legalActions(st);
  const sel = app.selectedLayer;
  const items: { id: string; label: string; cost: number | null; legal: Legal; act: () => void; hold?: boolean }[] = [];
  if (sel !== null && st.layers[sel] && st.layers[sel]!.unlocked) {
    items.push({ id: "tray-assign", label: T("+ Assign"), cost: null, legal: findLegal(legal, "assign", sel), act: () => doCommand({ type: "assign", layer: sel }), hold: true });
    items.push({ id: "tray-shaft", label: T("Shaft"), cost: R.shaftCost(st, sel), legal: findLegal(legal, "upgrade_shaft", sel), act: () => doCommand({ type: "upgrade_shaft", layer: sel }) });
  }
  items.push({ id: "tray-hire", label: T("Hire"), cost: R.hireCost(st), legal: findLegal(legal, "hire"), act: () => doCommand({ type: "hire" }) });
  const next = R.nextLockedLayer(st);
  if (next >= 0) items.push({ id: "tray-unlock", label: T("Open L{n}", { n: next + 1 }), cost: R.unlockCost(st), legal: findLegal(legal, "unlock_layer"), act: () => doCommand({ type: "unlock_layer" }) });
  if (st.flare.active) {
    const f = st.flare.active;
    items.push({ id: "tray-flare", label: T("✦ Flare L{n}", { n: f.layer + 1 }), cost: null, legal: findLegal(legal, "claim_flare", f.layer), act: claimActiveFlare });
  }
  if (settings.leftHanded) items.reverse();
  const gap = 6;
  const inner = L.lw - 20;
  const bw = (inner - gap * (items.length - 1)) / items.length;
  const r = ui.place("tray", { anchor: "bottom-start", x: 0, y: 0 }, () => {
    ui.row("tray-row", () => { for (const it of items) actionButton(it.id, it.label, it.cost, it.legal, bw, it.act, it.hold); }, { style: "tray", width: L.lw, spacing: gap, align: "stretch" });
  }, { width: L.lw });
  blockers.push(r);
  return r.height / L.sc;
}
function resChip(g: Glyph, text: string, id: string, title: string): void {
  ui.tooltip(title).row(id, () => { glyph(g, 15, tok("accent")); ui.style("res").id(`${id}-v`).label(text); }, { spacing: 5, align: "center" });
}
function topBar(st: State, L: Layout): number {
  const lim = st.ruleset.limits;
  let timeText = fmtTime(st.tick);
  if (lim && lim.timeSec) timeText = fmtTime(Math.max(0, lim.timeSec - st.tick));
  if (lim && lim.moves) timeText += " · " + T("{n} moves", { n: Math.max(0, lim.moves - st.stats.playerCommands) });
  const obj = app.lesson ? T(app.lesson.name) : objectiveText(st.ruleset.goals);
  const frac = goalFraction(st);
  const two = L.phone;
  const pad = 10;
  const w = L.lw - 2 * pad;
  const clockW = textWidth(timeText, "res") + 28 + 56 + 10;
  const resources = (): void => {
    resChip("credits", R.formatCoins(st.coins), "res-credits", T("Credits"));
    resChip("income", T("{n}/s", { n: R.formatCoins(R.incomeRate(st)) }), "res-income", T("Income per second"));
    resChip("workers", st.workers.idle + "/" + st.workers.total, "res-workers", T("Workers (idle/total)"));
  };
  const resW = 3 * 20 + textWidth(R.formatCoins(st.coins) + T("{n}/s", { n: R.formatCoins(R.incomeRate(st)) }) + st.workers.idle + "/" + st.workers.total, "res") + 2 * 12 + 28 + 10;
  const r = ui.place("hud-top", { anchor: "top-start", x: pad, y: L.shortLand ? 4 : 8 }, () => {
    ui.column("hud-top-col", () => {
      ui.row("hud-top-row", () => {
        const objW = Math.max(80, w - clockW - (two ? 0 : resW) - (two ? 8 : 16));
        ui.column("hud-objective", () => {
          ui.row("obj-row", () => {
            if (!two) ui.style("hud-label").label(T("Objective"));
            para(obj, objW - 28 - (two ? 0 : textWidth(T("Objective"), "hud-label") + 12), "hud-text", "objective-text");
          }, { spacing: 12, align: "center" });
          if (frac !== null) ui.progress(Math.min(1, frac), objW - 30);
        }, { style: "hud-cell", width: objW, spacing: 4 });
        if (!two) ui.row("hud-resources", resources, { style: "hud-cell", spacing: 12, align: "center" });
        ui.row("hud-clock", () => {
          ui.style("res").id("hud-timer").label(timeText);
          if (ui.style("btn", "btn-icon", { width: 44 }).id("btn-pause").button(T("Pause (Esc)"), {
            content: () => glyph("pause", 16, tok("text")),
          })) { sfx("ui_click"); pauseGame(); }
        }, { style: "hud-cell", spacing: 12, align: "center" });
      }, { spacing: 8, align: "stretch", width: w });
      if (two) {
        ui.row("hud-res-row", () => {
          if (!L.wide) railToggle("left", L);
          ui.row("hud-resources", resources, { style: "hud-cell", spacing: 12, align: "center", justify: "space-around", grow: 1 });
          if (!L.wide) railToggle("right", L);
        }, { spacing: 8, align: "stretch", width: w });
      }
    }, { spacing: 8, width: w });
  }, { width: w });
  blockers.push(r);
  return (r.y + r.height) / L.sc - L.oy;
}
function railToggle(side: "left" | "right", L: Layout): void {
  void L;
  const open = app.rails[side];
  const label = side === "left" ? T("Toggle shift report") : T("Toggle actions");
  if (ui.style("btn", "btn-icon", { width: 44, minHeight: 44 }).id(`rail-toggle-${side}`).button(label, {
    selected: open,
    content: () => ui.widget("", {
      role: "none", size: { width: 18, height: 18 },
      draw: (r) => {
        const c = tok("text");
        draw.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2, c, Math.max(1, r.height * 0.1));
        draw.rect(side === "left" ? r.x + 1 : r.x + r.width / 2, r.y + 1, r.width / 2 - 1, r.height - 2, c);
      },
    }),
  })) {
    sfx("ui_click");
    app.rails[side] = !open;
    if (!open) app.rails[side === "left" ? "right" : "left"] = false;
  }
}
function layerLabels(st: State, L: Layout): void {
  const n = st.layers.length;
  const t = frame().time;
  for (let i = 0; i < n; i++) {
    const pos = render.screenPosForLayer(i);
    if (!pos) continue;
    const Ly = st.layers[i]!;
    const blockedL = Ly.unlocked && R.isBlocked(st, i);
    const flare = !!(st.flare.active && st.flare.active.layer === i);
    const sz = lastSize.get(`lbl-${i}`) ?? { w: 64, h: 32 };
    const x = pos.x / L.sc - L.ox - sz.w / 2, y = pos.y / L.sc - L.oy - sz.h / 2;
    if (y < -sz.h || y > L.lh + sz.h) continue;
    const cls = ["layer-label", blockedL ? "layer-blocked" : "", flare ? "layer-flare" : ""].filter(Boolean);
    const pulse = flare && !ui.preferences().reducedMotion ? { opacity: 0.775 + 0.225 * Math.cos(t * Math.PI * 2 / 0.8) } : {};
    const textCls = blockedL ? "label-blocked" : flare ? "label-flare" : "label-text";
    const color = blockedL ? tok("bad") : flare ? tok("warn") : tok("text");
    const name = T("L{n}", { n: i + 1 });
    const desc = !Ly.unlocked ? T("Layer {n} — sealed", { n: i + 1 }) : T("Layer {n} — crew {crew}, bin {bin}%", { n: i + 1, crew: Ly.workers, bin: Math.floor((Ly.milliOre * 100) / R.binCapMilli(st, i)) }) + (blockedL ? " " + T("BLOCKED") : "") + (flare ? " " + T("FLARE") : "");
    const r = ui.place(`lbl-${i}`, { anchor: "top-start", x, y }, () => {
      if (ui.style(...cls, pulse).id(`layer-${i + 1}`).button(name, {
        selected: i === app.selectedLayer,
        tooltip: desc,
        content: () => ui.row(`lbl-${i}-face`, () => {
          ui.style(textCls).label(name);
          if (!Ly.unlocked) glyph("lock", 12, color);
          else {
            glyph("workers", 12, color);
            ui.style(textCls).label(String(Ly.workers));
            if (blockedL) { glyph("warn", 10, color); ui.style(textCls).label(T("FULL")); }
            if (flare) glyph("flare", 12, color);
          }
        }, { spacing: 3, align: "center" }),
      })) onLayerPicked(i);
    });
    lastSize.set(`lbl-${i}`, { w: r.width / L.sc, h: r.height / L.sc });
    blockers.push(r);
  }
}
function playHud(L: Layout): void {
  const st = app.run!.state;
  const f = frame();
  const top = topBar(st, L);
  let bottom = L.lh;
  if (L.phone) bottom = L.lh - tray(st, L);
  // The rails: beside the mine when wide; drawers from the toggles otherwise.
  const railTop = top + 8;
  const railBottom = L.phone ? bottom - 8 : L.lh - (L.shortLand ? 8 : 70);
  const railH = Math.max(120, railBottom - railTop);
  const lw = L.shortLand ? 220 : L.phone ? Math.min(300, L.lw * 0.84) : 260;
  const rw = L.shortLand ? 220 : L.phone ? Math.min(300, L.lw * 0.84) : 280;
  const leftX = 10, rightX = L.lw - 10;
  const showL = L.wide || app.rails.left, showR = L.wide || app.rails.right;
  const swap = settings.leftHanded;
  if (!L.wide && !L.phone) {
    // Drawer toggles under the top bar.
    const tl = ui.place("toggle-l", { anchor: "top-start", x: swap ? L.lw - 52 : 8, y: top + 2 }, () => railToggle("left", L));
    const tr = ui.place("toggle-r", { anchor: "top-start", x: swap ? 8 : L.lw - 52, y: top + 2 }, () => railToggle("right", L));
    blockers.push(tl, tr);
  }
  const drawerTop = !L.wide && !L.phone ? top + 54 : railTop;
  const drawerH = !L.wide && !L.phone ? Math.max(120, railBottom - drawerTop) : railH;
  if (showL) railPanel("rail-left", swap ? rightX - lw : leftX, drawerTop, lw, drawerH, (w) => leftRail(st, w));
  if (showR) railPanel("rail-right", swap ? leftX : rightX - rw, drawerTop, rw, drawerH, (w) => rightRail(st, w));
  // The lesson card under the top bar (docked left on short landscape screens).
  const banner = lessonBanner();
  let viewTop = top;
  if (banner) {
    const bw = L.shortLand ? Math.min(L.lw * 0.4, 300) : Math.min(L.lw * 0.92, 520);
    const r = ui.place("lesson-banner", { anchor: "top-start", x: L.shortLand ? 60 : (L.lw - bw) / 2, y: top + 8 }, () => {
      ui.column("lesson-col", () => para(banner, bw - 36, L.shortLand ? "dim-body" : "body", "lesson-text", !L.shortLand), { style: "lesson-banner", width: bw, align: L.shortLand ? "start" : "center" });
    });
    blockers.push(r);
    if (!L.shortLand && bw > L.lw * 0.5) viewTop = (r.y + r.height) / L.sc - L.oy;
  }
  // The mine framed into the band between the HUD's top and bottom chrome.
  const y0 = (L.oy + viewTop + 6) * L.sc, y1 = (L.oy + bottom - 6) * L.sc;
  render.setView(0, y0, f.width, Math.max(60 * L.sc, y1 - y0), f.width, f.height);
  if (!app.modal) layerLabels(st, L);
  // The 'complete' flash over the view.
  const fa = render.flashAlpha();
  if (fa > 0.01) draw.rect(0, 0, f.width, f.height, `rgba(255,255,255,${fa.toFixed(3)})`, { blend: "add" });
  if (app.countdownLeft > 0) {
    ui.place("countdown", { anchor: "top", y: L.lh * 0.4 - 40 }, () => ui.style("countdown").id("countdown").label(String(Math.ceil(app.countdownLeft / 600))));
  }
}
/** A rail panel of fixed height whose content scrolls when taller (.rail { overflow-y: auto }). */
function railPanel(id: string, x: number, y: number, w: number, h: number, build: (w: number) => void): void {
  const ch = lastSize.get(id)?.h ?? 0;
  const innerW = w - 28;
  const r = ui.place(id, { anchor: "top-start", x, y }, () => {
    ui.column(`${id}-col`, () => {
      const inner = (): void => {
        const c = ui.column(`${id}-in`, () => build(innerW - (ch > h - 28 ? 12 : 0)), { spacing: 6, width: innerW - (ch > h - 28 ? 12 : 0) });
        lastSize.set(id, { w, h: c.height / ui.preferences().scale });
      };
      if (ch > h - 28) ui.scrollArea(`${id}-scroll`, { width: innerW, height: h - 28 }, inner);
      else inner();
    }, { style: "rail", width: w, height: h });
  }, { width: w });
  blockers.push(r);
}

// ------------------------------------------------------------------ dialogs
function modal(L: Layout): void {
  const m = app.modal;
  if (!m) return;
  const w = Math.min(480, L.lw - 32) - 44;
  const fresh = frame().frame === app.modalFrame;
  const open = ui.dialog(m.kind === "away" ? T("While you were away") : m.text, "", true, () => {
    ui.column("modal-col", () => {
      if (m.kind === "away") {
        if (!L.shortLand) art("away-art", "assets/crew-at-night.webp", w, Math.min(150, w * 0.36));
        para(T("While you were away"), w, "h3", "away-h");
        para(m.text, w, "body", "away-text");
        flow("away-row", [{ id: "btn-away-ok", text: T("Back to work"), style: ["btn", "btn-primary"], act: () => { app.modal = null; } }], w);
      } else {
        para(m.text, w, "body", "confirm-text");
        flow("confirm-row", [
          { id: "btn-confirm", text: T("Confirm"), style: ["btn", "btn-primary"], act: () => { app.modal = null; m.yes(); } },
          { id: "btn-cancel", text: T("Cancel"), style: ["btn", "btn-ghost"], act: () => { app.modal = null; }, back: true },
        ], w);
      }
    }, { spacing: 12, width: w });
  });
  if (fresh) ui.setFocus(m.kind === "away" ? "btn-away-ok" : "btn-confirm");
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && !fresh && app.modal === m) app.modal = null;
}

// ------------------------------------------------------------------ toasts and captions
function toasts(L: Layout): void {
  const play = app.screen === "play" && !!app.run;
  if (app.toasts.length) {
    const w = Math.min(L.lw - 24, 520);
    ui.place("toasts", play ? { anchor: "bottom", y: (L.phone ? 90 : 90) } : { anchor: "top", y: 8 }, () => {
      ui.column("toast-col", () => {
        app.toasts.forEach((t, i) => {
          const cls = t.kind === "err" ? "toast-err" : t.kind === "good" ? "toast-good" : "toast";
          if (textWidth(t.text, cls) + 40 <= w) ui.style(cls).id(`toast-${i}`).label(t.text);
          else ui.style(cls).id(`toast-${i}`).paragraph(t.text, w - 40);
        });
      }, { spacing: 6, align: "center" });
    });
  }
  if (app.caption && settings.captions) {
    const text = app.caption.text;
    ui.place("captions", { anchor: "bottom", y: L.phone && play ? 70 : 8 }, () => para(text, Math.min(L.lw - 40, 520), "captions", "caption-text", true));
  }
}
