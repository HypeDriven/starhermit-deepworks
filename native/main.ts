// Deepworks on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), content (js/content.js)
// and session with its replay envelope (js/session.js) are the browser
// build's, unchanged in what they decide; this module is what js/main.js did
// around them — the state machine (title → modes → setup → countdown →
// active ⇄ paused → results), the run lifecycle with the saved practice
// shift and its "while you were away" summary, the command dispatch with its
// sounds, effects, toasts and announcements, the lessons' steps, the
// bottleneck cue, the achievements, the results bookkeeping (stars, bests,
// mastery xp, career counters, the device's casual daily board, posting to
// the high-score board), layer selection by keys, pads, taps on the mine and
// its labels, the drag yaw, hold to repeat, haptics, and the lifecycle (a
// hidden window pauses the shift, as the browser build's visibilitychange
// did). The screens and HUD are drawn by screens.ts (starhermit:ui), the
// mine by render.ts (starhermit:scene), the attract mine behind the menus
// included.
//
// Time is the runtime's fixed steps (60 a second): a shift advances by the
// steps it is active (whole milliseconds, the remainder carried), so pauses,
// a hidden window and slow frames never cost time and play scripts replay
// exactly; the countdown, the lesson checks and the periodic saves count the
// same steps.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindingLabel, buttons, onAction, onPointerButton, onPointerMove, onTouch, pointer, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { C, R, S, type Cmd, type Content, type Lesson, type LessonStep, type Run, type RulesEvent, type SavedRun, type ScoreInfo, type State } from "./classic.ts";
import * as audio from "./audio.ts";
import { N, T, onLocaleChange } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "modes" | "setup" | "journey" | "boards" | "help" | "settings" | "results" | "profile" | "play";
export type SetupMode = "learn" | "learn-go" | "daily" | "practice" | "practice-go" | "challenge" | "challenge-go" | "journey-go";
export interface ResultsData {
  run: Run; content: Content; mode: string; won: boolean; reason: string; score: ScoreInfo; stars: number; newBest: boolean;
  achievements: string[]; nextContent: Content | null;
  leaderboard: { result: { posted: boolean; rank: number | null } | null } | null;
}
export type Modal =
  | { kind: "confirm"; text: string; yes: () => void }
  | { kind: "away"; text: string };

const STEP_MS = 1000 / 60;
export const app = {
  screen: "title" as Screen,
  nav: [] as Screen[],
  openedFrame: 0,
  focusNext: null as string | null,
  setup: { mode: "learn" as SetupMode, content: null as Content | null },
  run: null as Run | null,
  mode: null as string | null,
  content: null as Content | null,
  lesson: null as Lesson | null,
  lessonStepIdx: 0,
  selectedLayer: null as number | null,
  paused: false,
  countdownLeft: 0,
  settingsInPause: false,
  savedRun: null as SavedRun | null,
  results: null as ResultsData | null,
  modal: null as Modal | null,
  modalFrame: 0,
  toasts: [] as { text: string; kind: string; until: number }[],
  caption: null as { text: string; until: number } | null,
  rails: { left: false, right: false },
  boardTab: 0,
  boards: null as { key: string; entries: platform.BoardEntry[] | null; casual: boolean } | null,
  nameDraft: "",
  hold: null as { next: number } | null,
};
export const settings = platform.settings;
const now = (): number => frame().time;
let msCarry = 0;
let hudSteps = 0, saveSteps = 0, lessonSteps = 0;
let coinSoundAccum = 0, lastCoinBucket = 0, blockedMask = 0, blockedSoundAt = -1e9;
let attract: State | null = null;
let runFrameDt = 0;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 600), { politeness: assertive ? "assertive" : "polite" });
}
/** js/ui.js toast(): 2.6 s; `kind` err | good. */
export function toast(text: string, kind = ""): void {
  app.toasts.push({ text, kind, until: now() + 2.6 });
  if (app.toasts.length > 3) app.toasts.shift();
}
export function sfx(name: audio.Cue): void { audio.play(name); }
export function profile(): ReturnType<typeof platform.profile> { return platform.profile(); }
/** The default guest name reads in the game language; chosen names never change. */
export function nameText(n: string): string { return n === "Guest Prospector" ? T("Guest Prospector") : n; }
const ARROWS: Record<string, string> = { "Arrow Up": "Up", "Arrow Down": "Down", "Arrow Left": "Left", "Arrow Right": "Right", Escape: "Esc" };
/** The player's key for an action, as the browser build's keyLabel ("U", "Up", "Esc"). */
export function keyLabel(action: string): string {
  const l = bindingLabel(action, "keyboard");
  return ARROWS[l] ?? l;
}
export function fmtTime(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
  return m + ":" + String(s).padStart(2, "0");
}
export function currentTheme(): ReturnType<typeof C.themeById> { return C.themeById(settings.theme); }

// ------------------------------------------------------------------ navigation
export function show(screen: Screen, focus: string | null = null): void {
  if (screen !== app.screen) { app.nav.push(app.screen); if (app.nav.length > 12) app.nav.shift(); }
  setScreen(screen, focus);
}
function setScreen(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
  if (screen !== "play") app.rails = { left: false, right: false };
  if (screen === "boards") loadBoard(app.boardTab = 0);
  if (screen === "profile") app.nameDraft = profile().displayName;
}
export function back(): void {
  let prev = app.nav.pop() ?? "title";
  if (prev === "play") prev = "title";
  setScreen(prev);
}

// ------------------------------------------------------------------ setup
export function openSetup(mode: SetupMode, content: Content | null = null): void {
  app.setup = { mode, content };
  show("setup");
}
export function lessonToContent(ls: Lesson): Content {
  return {
    id: ls.id, name: ls.name, version: ls.version, seed: R.hashString("deepworks." + ls.id),
    theme: ls.theme, overrides: ls.ruleset, goals: null, limits: null,
    parSec: ls.parSec, endless: false, ...(ls.setup ? { setup: ls.setup } : {}), lesson: ls,
  };
}
export function practiceContent(d: { id: string; name: string; overrides: Record<string, unknown> }): Content {
  return {
    id: "practice-" + d.id, name: "Practice — " + d.name, difficulty: d.name, version: C.CONTENT_VERSION,
    seed: (Math.random() * 0xffffffff) >>> 0, theme: settings.theme || "emberdeep",
    overrides: d.overrides, goals: null, limits: null, parSec: 0, endless: true,
  };
}
export function dailyContent(): Content { return C.dailyInfo(new Date(platform.nowMs())); }
/** Display name of a run's content (journey, lesson, challenge, practice, daily). */
export function contentName(c: Content | null): string {
  if (!c) return "";
  if (c.difficulty) return T("Practice — {difficulty}", { difficulty: T(c.difficulty) });
  if (c.key && /^daily/.test(c.id || "")) return T("Daily Vein — {date}", { date: c.key });
  if (c.n) return T("Stage {n}: {name}", { n: c.n, name: T(c.name) });
  return T(c.name || c.id);
}
export function goalText(g: Content["goals"]): string {
  if (!g) return T("Endless — bank your score when you like");
  if (g.type === "earn") return T("Earn {amount} credits", { amount: R.formatCoins(g.amount) });
  if (g.type === "depth") return T("Unlock {n} layers", { n: g.amount });
  if (g.type === "rate") return T("Reach {rate} ore/s extraction", { rate: R.formatOre(g.amount) });
  return "—";
}
export function objectiveText(g: Content["goals"]): string {
  if (!g) return T("Endless shift");
  if (g.type === "earn") return T("Earn {amount} credits", { amount: R.formatCoins(g.amount) });
  if (g.type === "depth") return T("Unlock {n} layers", { n: g.amount });
  if (g.type === "rate") return T("Reach {rate} ore/s", { rate: R.formatOre(g.amount) });
  return "";
}

// ------------------------------------------------------------------ runs
export function startRun(content: Content, modeIn: string): void {
  app.content = content;
  app.mode = modeIn === "learn-go" ? "learn" : modeIn.replace(/-go$/, "");
  app.lesson = content.lesson ?? null;
  app.lessonStepIdx = 0;
  app.run = S.createRun(content, app.mode, { buildState: C.buildState });
  // Timing assistance (accessibility): longer flare claim windows. Casual
  // shifts only — the ranked daily must replay bit-identically server-side.
  if (settings.timingAssist && app.mode !== "daily") app.run.state.ruleset.flareDurationSec *= 2;
  audio.setVariantSeed(content.seed);
  app.selectedLayer = null;
  app.paused = false;
  app.results = null;
  app.modal = null;
  lastCoinBucket = 0;
  blockedMask = 0;
  msCarry = 0;
  hudSteps = saveSteps = lessonSteps = 0;
  render.setTheme(C.themeById(content.theme || settings.theme));
  render.setPaused(false);
  showPlay();
  announceObjective();
  // The countdown (tutorial mode jumps straight in with the lesson banner).
  if (app.lesson) {
    app.countdownLeft = 0;
    announce(T(app.lesson.intro));
  } else {
    app.countdownLeft = 1800;
    app.paused = true; // hold the sim during the countdown
  }
}
function showPlay(): void { setScreen("play"); }
function announceObjective(): void {
  const g = app.run!.state.ruleset.goals;
  let msg = contentName(app.content) + ". ";
  if (app.lesson) msg += T(app.lesson.intro);
  else if (g) msg += T("Objective: {goal}.", { goal: objectiveText(g) });
  else msg += T("Endless shift. Bank your score from the pause menu.");
  announce(msg);
}
export function restartRun(): void {
  if (!app.content) return;
  app.modal = null;
  startRun(app.content, app.mode!);
}
export function endRun(): void {
  app.modal = null;
  if (app.run && !app.run.closed) S.dispatch(app.run, { type: "end_run" });
  app.paused = false;
}
export function leaveRun(): void {
  app.modal = null;
  finishRunSilently();
  app.nav = [];
  setScreen("title");
}
function finishRunSilently(): void {
  if (app.run && !app.run.closed) S.finalize(app.run);
  app.run = null;
  app.lesson = null;
  app.countdownLeft = 0;
  app.paused = false;
  render.setPaused(false);
}
export function leaveToTitle(): void { finishRunSilently(); app.nav = []; setScreen("title"); }

// ------------------------------------------------------------------ commands
export function doCommand(cmd: Cmd): void {
  const run = app.run;
  if (!run || run.closed) return;
  const res = S.dispatch(run, cmd);
  if (!res.ok) {
    sfx("error");
    toast(invalidText(res.reason ?? ""), "err");
    announce(invalidText(res.reason ?? ""), true);
    render.pulse("error");
    return;
  }
  if (res.deduped) return;
  const soundMap: Record<string, audio.Cue> = {
    assign: "assign", unassign: "unassign", hire: "hire",
    upgrade_shaft: "upgrade", upgrade_lift_cap: "upgrade", upgrade_lift_speed: "upgrade",
    unlock_layer: "unlock_layer", claim_flare: "claim_flare", buy_foreman: "foreman", toggle_foreman: "foreman",
  };
  sfx(soundMap[cmd.type] ?? "ui_click");
  if (cmd.type === "unlock_layer") render.pulse("unlock");
  else if (cmd.type === "claim_flare") render.pulse("coin");
  else if (cmd.type.indexOf("upgrade") === 0) render.pulse("upgrade");
  if (cmd.type === "unlock_layer") {
    announce(T("Layer {n} opened.", { n: (res.events[0]?.layer ?? 0) + 1 }));
    checkAchievement("deep_milestone", R.unlockedCount(run.state) >= 6);
  }
  if (cmd.type === "claim_flare") {
    profile().stats.flaresClaimed++;
    announce(T("Flare claimed: +{credits} credits.", { credits: R.formatCoins(res.events[0]?.credits ?? 0) }));
  }
  if (app.lesson) lessonCheckCommand(cmd);
  if (settings.haptics) { try { vibrate(8); } catch { /* no vibration */ } }
}
export function invalidText(reason: string): string {
  const map: Record<string, string> = {};
  map[R.REASONS.NO_IDLE_WORKER!] = N("No idle workers.");
  map[R.REASONS.LAYER_LOCKED!] = N("That layer is sealed.");
  map[R.REASONS.WORKER_CAP!] = N("Seam fully crewed.");
  map[R.REASONS.NO_WORKERS!] = N("Nobody assigned there.");
  map[R.REASONS.INSUFFICIENT_FUNDS!] = N("Not enough credits.");
  map[R.REASONS.ALL_UNLOCKED!] = N("All seams are open.");
  map[R.REASONS.NO_FLARE!] = N("No active flare.");
  map[R.REASONS.MECHANIC_DISABLED!] = N("Not available here.");
  map[R.REASONS.TERMINAL!] = N("The shift is over.");
  return map[reason] ? T(map[reason]!) : T("Cannot: {reason}", { reason });
}
export function cmdSel(type: string): void {
  if (app.selectedLayer === null) { toast(T("Select a layer first (↑/↓ or tap)"), "err"); return; }
  doCommand({ type, layer: app.selectedLayer });
}
export function claimActiveFlare(): void {
  const f = app.run && app.run.state.flare.active;
  if (f) doCommand({ type: "claim_flare", layer: f.layer, id: f.id });
  else { sfx("error"); toast(T("No active flare."), "err"); }
}
export function doUndo(): void {
  if (!app.run) return;
  const res = S.undo(app.run);
  if (res.ok) { sfx("undo"); toast(T("Undone")); }
  else toast(T("Nothing to undo."), "err");
}
export function foremanCmd(): void {
  if (!app.run) return;
  doCommand({ type: app.run.state.foreman.unlocked ? "toggle_foreman" : "buy_foreman" });
}
export function onLayerPicked(idx: number): void {
  const run = app.run;
  if (!run) return;
  const st = run.state;
  // Tapping a flaring layer claims directly (one-input confidence).
  if (st.flare.active && st.flare.active.layer === idx) {
    doCommand({ type: "claim_flare", layer: idx, id: st.flare.active.id });
    app.selectedLayer = idx;
    return;
  }
  app.selectedLayer = idx;
  sfx("ui_click");
  if (!st.layers[idx]!.unlocked) announce(T("Layer {n} is sealed. Open it from the Foreman's Panel.", { n: idx + 1 }));
}

// ------------------------------------------------------------------ lessons
function lessonCheckCommand(cmd: Cmd): void {
  const step = app.lesson!.steps[app.lessonStepIdx];
  if (!step) return;
  const req = step.require;
  if (req.type === cmd.type && (req.layer === undefined || req.layer === cmd.layer)) advanceLesson();
}
function lessonCheckEarn(): void {
  if (!app.lesson || !app.run) return;
  const step = app.lesson.steps[app.lessonStepIdx];
  if (step && step.require.type === "earn" && app.run.state.lifetimeEarned >= (step.require.amount ?? 0)) advanceLesson();
}
function advanceLesson(): void {
  const lesson = app.lesson!;
  app.lessonStepIdx++;
  sfx("lesson_step");
  if (app.lessonStepIdx >= lesson.steps.length) {
    profile().lessons[lesson.id] = true;
    platform.saveProfile();
    toast(T("Lesson complete!"), "good");
    S.dispatch(app.run!, { type: "end_run" });
  } else announce(lessonStepText(lesson.steps[app.lessonStepIdx]!));
}
/** Shortcut placeholders ({assign}, {hire}, …) resolve to the player's real bindings. */
export function lessonStepText(step: LessonStep): string {
  return T(step.text).replace(/\{(\w+)\}/g, (m, k: string) => keyLabel(k.toLowerCase()) || m);
}
export function lessonBanner(): string | null {
  if (!app.lesson) return null;
  const step = app.lesson.steps[app.lessonStepIdx];
  if (!step) return null;
  return T("Lesson {n}/{total}: {text}", { n: app.lessonStepIdx + 1, total: app.lesson.steps.length, text: lessonStepText(step) });
}

// ------------------------------------------------------------------ the end of a run
export const ACHIEVEMENTS = [
  { key: "first_completion", name: N("First Shift Done"), desc: N("Complete any stage or lesson.") },
  { key: "mechanic_mastery", name: N("Every Lever"), desc: N("Complete all five lessons.") },
  { key: "streak_7", name: N("Seven Suns Down"), desc: N("Dig the Daily Vein on 7 different days.") },
  { key: "deep_milestone", name: N("Bottom of the Works"), desc: N("Open the sixth seam in any run.") },
  { key: "long_haul", name: N("The Long Haul"), desc: N("Earn 10,000,000 credits across your career.") },
];
function unlockAch(key: string, condition: boolean): string[] {
  const p = profile();
  if (!condition || p.achievements[key]) return [];
  p.achievements[key] = Date.now();
  const def = ACHIEVEMENTS.find((a) => a.key === key);
  return [def ? def.name : key];
}
function checkAchievement(key: string, condition: boolean): void {
  const names = unlockAch(key, condition);
  if (names.length) { sfx("achievement"); toast(T("Achievement: {name}", { name: T(names[0]!) }), "good"); platform.saveProfile(); }
}
let achievementCueAt = -1;
function onRunClosed(): void {
  const run = app.run!;
  const st = run.state;
  const won = !!st.terminal?.won;
  sfx(won ? "terminal_win" : "terminal_lose");
  render.pulse(won ? "complete" : "error");
  const p = profile();
  const result = run.result!;
  p.stats.runsPlayed++;
  p.stats.totalEarned += Math.floor(st.lifetimeEarned / R.COIN_SCALE);
  let newBest = false, stars = 0, nextContent: Content | null = null;
  const content = app.content!;
  if (app.mode === "journey" && won) {
    stars = S.starsFor(content, st.tick);
    const prev = p.journey[content.id];
    if (!prev || stars > prev.stars || st.tick < prev.bestTick) {
      p.journey[content.id] = { stars: Math.max(stars, prev ? prev.stars : 0), bestTick: prev ? Math.min(prev.bestTick, st.tick) : st.tick };
      newBest = true;
    }
    nextContent = C.journeyByIndex(content.n ?? 0); // n is 1-based
  }
  if (app.mode === "daily") {
    const key = content.key!;
    const total = result.score.total;
    if (!p.daily[key] || total > p.daily[key]!.score) { p.daily[key] = { score: total, won }; newBest = true; }
    // Offline: the device's casual board (signed in, the platform board).
    if (!platform.signedIn()) platform.submitLocal("daily", p.displayName, total, st.tick);
  }
  if (app.mode === "practice") {
    const diff = content.id.replace("practice-", "");
    if (!p.practice[diff] || result.score.total > p.practice[diff]!) { p.practice[diff] = result.score.total; newBest = true; }
    S.clearSavedRun();
    app.savedRun = null;
  }
  if (app.mode === "challenge") {
    if (!p.challenges[content.id] || result.score.total > p.challenges[content.id]!) { p.challenges[content.id] = result.score.total; newBest = true; }
  }
  p.mastery.xp += S.masteryXpFor(result);
  const achieved: string[] = [];
  const completed = (won && !!st.ruleset.goals) || (!!app.lesson && app.lessonStepIdx >= app.lesson.steps.length);
  achieved.push(...unlockAch("first_completion", completed));
  achieved.push(...unlockAch("mechanic_mastery", C.LESSONS.every((l) => p.lessons[l.id])));
  achieved.push(...unlockAch("streak_7", Object.keys(p.daily).length >= 7));
  achieved.push(...unlockAch("long_haul", p.stats.totalEarned >= 10000000));
  if (achieved.length) achievementCueAt = now() + 0.6;
  platform.saveProfile();
  // Signed in: Journey, Daily and Challenge runs post their score (whole
  // credits) to the platform high-score board; the results show the rank.
  let leaderboard: ResultsData["leaderboard"] = null;
  if (platform.signedIn() && (app.mode === "journey" || app.mode === "daily" || app.mode === "challenge")) {
    const lb: NonNullable<ResultsData["leaderboard"]> = { result: null };
    leaderboard = lb;
    void platform.postHighScore(Math.floor(result.score.total / R.COIN_SCALE)).then((r) => { lb.result = r; });
  }
  app.results = {
    run, content, mode: app.mode!, won, reason: st.terminal!.reason, score: result.score, stars, newBest,
    achievements: achieved, nextContent, leaderboard,
  };
  const head = resultsHeadline(app.results);
  announce(T("{headline}. Score {score}.", { headline: head, score: R.formatCoins(result.score.total) }), true);
  setScreen("results", "btn-results-0");
}
export function resultsHeadline(d: ResultsData): string {
  const won = d.won && d.reason !== "player-ended";
  return won ? T("Objective complete") : d.reason === "time-up" ? T("Time is up") : d.reason === "moves-exhausted" ? T("Out of moves") : T("Shift ended");
}

// ------------------------------------------------------------------ pause
export function pauseGame(): void {
  if (!app.run || app.run.closed) return;
  app.paused = true;
  render.setPaused(true);
  app.settingsInPause = true;
  show("settings", "btn-resume");
  announce(T("Paused."));
}
export function resumeGame(): void {
  app.paused = app.countdownLeft > 0;
  render.setPaused(false);
  if (app.run) {
    app.settingsInPause = false;
    app.nav = ["title"];
    setScreen("play");
    announce(T("Resumed."));
  }
}
export function openSettings(): void {
  app.settingsInPause = false;
  show("settings", null);
}

// ------------------------------------------------------------------ saved shift
export function resumeSaved(): void {
  const data = app.savedRun;
  if (!data) return;
  const resumed = S.resumeRun(data);
  if (!resumed) { toast(T("Saved shift could not be restored."), "err"); return; }
  const content: Content = { id: data.contentId, name: N("Practice (resumed)"), version: data.contentVersion, seed: data.seed, theme: settings.theme, goals: null, limits: null, parSec: 0 };
  app.content = content;
  app.mode = data.mode || "practice";
  app.run = {
    id: data.runId, mode: app.mode, contentId: data.contentId, contentVersion: data.contentVersion, seed: data.seed,
    state: resumed.state, log: data.log || [], pendingAdvanceMs: 0, undoStack: [], hashes: [], startedAt: Date.now(),
    lastSavedAt: Date.now(), closed: false, result: null,
  };
  app.lesson = null;
  app.savedRun = null;
  app.paused = false;
  app.countdownLeft = 0;
  app.selectedLayer = null;
  app.results = null;
  msCarry = 0;
  render.setTheme(C.themeById(settings.theme));
  render.setPaused(false);
  showPlay();
  if (resumed.away.seconds > 30) {
    const mins = Math.floor(resumed.away.seconds / 60);
    sfx("away_return");
    app.modal = {
      kind: "away",
      text: (() => {
        const vars = { time: mins >= 60 ? Math.floor(mins / 60) + "h " + (mins % 60) + "m" : T("{n} min", { n: mins }), credits: R.formatCoins(resumed.away.earned) };
        return resumed.away.capped ? T("The crew kept digging for {time} (capped) and earned {credits} credits.", vars) : T("The crew kept digging for {time} and earned {credits} credits.", vars);
      })(),
    };
    app.modalFrame = frame().frame;
  }
  announce(T("Shift resumed."));
}
export function discardSaved(): void { S.clearSavedRun(); app.savedRun = null; }
export function confirm(text: string, yes: () => void): void {
  app.modal = { kind: "confirm", text, yes };
  app.modalFrame = frame().frame;
}

// ------------------------------------------------------------------ boards, profile, platform
export function loadBoard(tab: number): void {
  app.boardTab = tab;
  const key = platform.signedIn() ? "high-score" : tab === 0 ? "daily" : "global";
  if (platform.signedIn()) {
    const b = { key, entries: null as platform.BoardEntry[] | null, casual: false };
    app.boards = b;
    void platform.platformBoard().then((e) => { b.entries = e; });
  } else app.boards = { key, entries: platform.localBoard(key), casual: true };
}
export function setDisplayName(name: string): void {
  profile().displayName = (name.trim() || "Guest Prospector").slice(0, 24);
  platform.saveProfile();
  toast(T("Name saved"), "good");
}
export function wipeProfile(): void {
  platform.resetProfile();
  app.savedRun = null;
  toast(T("Local profile erased."), "good");
  app.nav = [];
  setScreen("title");
}
export function inviteFriend(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(T("Invite link copied to the clipboard.")); }
  catch { toast(T("Could not copy — invite link: {link}", { link })); }
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function describeMine(): void {
  if (app.run) announce(R.describeState(app.run.state, T), true);
  else announce(T("No shift in progress."), true);
}

// ------------------------------------------------------------------ input
function stepLayer(dir: number): void {
  const st = app.run!.state;
  const cur = app.selectedLayer === null ? (dir > 0 ? -1 : st.layers.length) : app.selectedLayer;
  onLayerPicked(Math.max(0, Math.min(st.layers.length - 1, cur + dir)));
}
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  if (app.modal) return; // the dialog takes its own keys
  if (e.action === "pause") {
    if (!fresh || ui.capturingKeys()) return;
    if (app.screen === "play") { if (app.paused && app.countdownLeft <= 0) resumeGame(); else pauseGame(); }
    else if (app.screen === "settings" && app.run && app.settingsInPause) resumeGame();
    else if (app.screen !== "title" && app.screen !== "results") { sfx("ui_back"); back(); }
    return;
  }
  if (app.screen !== "play" || !app.run || app.run.closed) return;
  const pad = e.source === "gamepad";
  switch (e.action) {
    case "up": ui.setFocus(null); stepLayer(-1); break;
    case "down": ui.setFocus(null); stepLayer(1); break;
    case "assign": {
      if (ui.focused()) break; // a focused button acts by itself
      const f = app.run.state.flare.active;
      if (pad && f && f.layer === app.selectedLayer) claimActiveFlare();
      else cmdSel("assign");
      break;
    }
    case "unassign": if (!(pad && ui.focused())) cmdSel("unassign"); break;
    case "hire": doCommand({ type: "hire" }); break;
    case "shaft": cmdSel("upgrade_shaft"); break;
    case "liftcap": doCommand({ type: "upgrade_lift_cap" }); break;
    case "liftspeed": doCommand({ type: "upgrade_lift_speed" }); break;
    case "unlock": doCommand({ type: "unlock_layer" }); break;
    case "flare": claimActiveFlare(); break;
    case "foreman": foremanCmd(); break;
    case "undo": doUndo(); break;
  }
});

// Taps on the mine select a layer (short and stationary: within 8 px); a
// longer drag turns the mine. Presses on the HUD's panels are theirs (the
// rects screens.ts placed this frame); presses are queued and decided after
// the frame's UI is built, when those rects are this frame's.
export const blockers: ui.Rect[] = [];
let down: { x: number; y: number; yaw: number; dragging: boolean } | null = null;
let lastTouch = -1e9;
const queued: { kind: "down" | "move" | "up"; x: number; y: number }[] = [];
function blocked(x: number, y: number): boolean {
  return blockers.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
}
function sceneInput(): void {
  for (const q of queued.splice(0)) {
    if (q.kind === "down") {
      down = app.screen === "play" && app.run && !app.modal && !blocked(q.x, q.y) ? { x: q.x, y: q.y, yaw: render.currentYawTarget(), dragging: false } : null;
    } else if (q.kind === "move") {
      if (!down) continue;
      const dx = q.x - down.x, dy = q.y - down.y;
      if (!down.dragging && Math.hypot(dx, dy) > 8 * frame().scale) down.dragging = true;
      if (down.dragging) render.dragYaw(down.yaw, dx, frame().scale);
    } else {
      const d = down;
      down = null;
      if (!d || d.dragging || !app.run || app.screen !== "play") continue;
      const idx = render.pick(q.x, q.y);
      if (idx !== null) { ui.setFocus(null); onLayerPicked(idx); }
    }
  }
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  queued.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) queued.push({ kind: "move", x, y }); });
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = now();
  if (e.phase === "start") queued.push({ kind: "down", x: e.x, y: e.y });
  else if (e.phase === "move") queued.push({ kind: "move", x: e.x, y: e.y });
  else if (e.phase === "end") queued.push({ kind: "up", x: e.x, y: e.y });
  else { queued.length = 0; down = null; }
});
/** Hold to repeat (Settings › Controls): a held Assign button repeats every
 * 260 ms (the rects of this frame's Assign buttons, from screens.ts). */
export const holdRects: ui.Rect[] = [];
let touchDown = false;
onTouch((e) => { if (e.primary) touchDown = e.phase === "start" || e.phase === "move"; });
function holdRepeat(): void {
  const p = pointer();
  const held = settings.holdRepeat && app.screen === "play" && !!app.run && !app.modal && ((buttons() & 1) !== 0 || touchDown) && !!p;
  const inside = held && holdRects.some((r) => p!.x >= r.x && p!.y >= r.y && p!.x <= r.x + r.width && p!.y <= r.y + r.height);
  if (!inside) { app.hold = null; return; }
  if (!app.hold) { app.hold = { next: now() + 0.26 }; return; }
  if (now() >= app.hold.next) { app.hold.next = now() + 0.26; cmdSel("assign"); }
}

// ------------------------------------------------------------------ lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyMotion(): void { render.setReducedMotion(preferences().reducedMotion || !settings.cameraSway); }

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.setOnCaption((key) => {
    if (!settings.captions) return;
    app.caption = { text: T(key), until: now() + 2.2 };
  });
  app.savedRun = S.loadSavedRun();
  applyMotion();
  applyLook();
  render.setTheme(currentTheme());
  render.setActive(true);
  setScreen("title", "btn-play");
});
platform.onSettingsChange(() => {
  applyMotion();
  if (!app.run) render.setTheme(currentTheme());
});
platform.onProfileMerged(() => toast(T("progress synced")));
onPreferencesChange(() => applyMotion());
onSessionEnded(() => toast(T("cloud sync unavailable")));
onLocaleChange(() => undefined);
let hidden = false;
onSuspend(() => {
  hidden = true;
  audio.setSuspended(true);
  // Backgrounding pauses the shift; save a safe snapshot and show the pause panel.
  if (app.run && !app.run.closed && !app.paused && app.screen === "play") {
    if (app.mode === "practice") S.saveRun(app.run);
    pauseGame();
  }
  if (app.run && !app.run.closed && app.mode === "practice") S.saveRun(app.run);
  platform.saveProfile();
  platform.flush();
});
onResume(() => { hidden = false; audio.setSuspended(false); });

onFixedUpdate(() => {
  if (hidden) return;
  const run = app.run;
  if (!run) {
    // The idle attract mine behind the title.
    if (!attract) attract = C.buildState(C.JOURNEY[0]!);
    msCarry += STEP_MS;
    const ms = Math.floor(msCarry);
    msCarry -= ms;
    R.advance(attract, ms);
    if (attract.tick > 300) attract = C.buildState(C.JOURNEY[0]!);
    return;
  }
  if (run.closed) { if (app.results?.run !== run) onRunClosed(); return; }
  if (app.countdownLeft > 0) {
    if (app.screen !== "play") return; // the pause panel holds the countdown too
    app.countdownLeft -= STEP_MS;
    if (app.countdownLeft <= 0) {
      app.countdownLeft = 0;
      app.paused = false;
      sfx("shift_start");
    }
    return;
  }
  if (app.paused) return;
  msCarry += STEP_MS;
  const ms = Math.floor(msCarry);
  msCarry -= ms;
  const events = S.tick(run, ms);
  handleEvents(events);
  if (++hudSteps >= 12) { hudSteps = 0; updateAudioIntensity(); checkBottleneck(); }
  if (++lessonSteps >= 30) { lessonSteps = 0; lessonCheckEarn(); }
  if (++saveSteps >= 600) {
    saveSteps = 0;
    if (app.mode === "practice") S.saveRun(run);
    profile().stats.playtimeSec += 10;
    platform.saveProfile();
  }
  if (run.closed && app.run === run && app.results?.run !== run) onRunClosed();
});
function handleEvents(events: RulesEvent[]): void {
  for (const e of events) {
    if (e.type === "flare_started") { sfx("flare_started"); announce(T("Seam flare on Layer {n}", { n: (e.layer ?? 0) + 1 })); }
    else if (e.type === "flare_expired") { sfx("flare_expired"); announce(T("The flare on Layer {n} faded.", { n: (e.layer ?? 0) + 1 })); }
  }
  if (app.run) {
    const bucket = Math.floor(app.run.state.lifetimeEarned / (100 * R.COIN_SCALE));
    if (bucket !== lastCoinBucket) {
      lastCoinBucket = bucket;
      coinSoundAccum++;
      if (coinSoundAccum % 3 === 0) sfx("coin");
    }
  }
}
/** The bottleneck cue: once when a layer's bin first reaches the blocked threshold, at most every 8 s. */
function checkBottleneck(): void {
  const st = app.run!.state;
  let mask = 0;
  for (let i = 0; i < st.layers.length; i++) if (st.layers[i]!.unlocked && R.isBlocked(st, i)) mask |= 1 << i;
  const freshMask = mask & ~blockedMask;
  blockedMask = mask;
  const t = st.tick + st.tickMs / 1000;
  if (freshMask && t - blockedSoundAt > 8) {
    blockedSoundAt = t;
    let idx = 0;
    while (!(freshMask & (1 << idx))) idx++;
    sfx("bin_blocked");
    announce(T("Layer {n} bin is full — transport is the bottleneck.", { n: idx + 1 }));
  }
}
function updateAudioIntensity(): void {
  if (!app.run) { audio.setIntensity(0); return; }
  audio.setIntensity(Math.min(1, R.totalExtractionRate(app.run.state) / 400000));
}

onUpdate((dt) => {
  runFrameDt = dt;
  applyLook();
  audio.update();
  applyTokens(settings.theme, ui.preferences().highContrast, settings.palette);
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until > t);
  if (app.caption && app.caption.until < t) app.caption = null;
  if (achievementCueAt > 0 && t >= achievementCueAt) { achievementCueAt = -1; sfx("achievement"); }
  holdRepeat();
});
onRender(() => {
  blockers.length = 0;
  holdRects.length = 0;
  drawScreens();
  sceneInput();
  const st = app.run ? app.run.state : attract;
  if (!st) return;
  render.setSelectedLayer(app.run ? app.selectedLayer : null);
  render.setPaused(!!app.run && app.paused);
  render.setFlareActive(app.run && app.run.state.flare.active ? app.run.state.flare.active.layer : null);
  render.setSnapshot(st, runFrameDt);
});
