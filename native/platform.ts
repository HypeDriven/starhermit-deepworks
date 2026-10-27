// The game's data and the StarHermit platform, on the runtime's modules:
// - the profile (journey stars and best times, finished lessons, daily and
//   practice / challenge bests, achievements, mastery xp, career counters,
//   the guest display name) is js/session.js's checksummed document
//   {sum, payload}, unchanged: it is the game's save (starhermit:storage
//   `saves`) on the device and in the player's cloud slot, two devices'
//   copies merged on a conflict (DWSession.mergeProfiles: the better record
//   per stage, every lesson / daily / achievement, the larger counters). The
//   slot the browser build wrote (the JS SDK's saveJSON of the same
//   document) shows as foreign and is merged in and replaced once;
// - js/session.js keeps reading and writing `localStorage`: here a shim
//   whose profile key is that save and whose other keys (the saved practice
//   shift, the device's casual boards) are the device's starhermit:storage,
//   as the browser build kept them on the device;
// - the game's own options (sound captions, mine theme, camera sway, hold to
//   repeat, left-handed layout, haptics, colour palette, timing assistance)
//   are `settings` (game.<key>, synced with the account); the browser
//   build's account settings and the copy its profile document carried are
//   migrated, then the old account keys removed. Volumes, mute, graphics,
//   language, reduced motion, high contrast, text size and key bindings are
//   the runtime's Options;
// - the player (signed in or a guest), the invite link, the platform's clock
//   for the Daily Vein, posting a finished run's credits through
//   score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the
//   rank on the high-score board, and that board's entries.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { R, S, type Profile } from "./classic.ts";

// --- the save and the localStorage shim ----------------------------------------------
const PROFILE_KEY = S.PROFILE_KEY;
/** The wrapped profile document as the save holds it ({sum, payload}). */
let current: JsonValue | null = null;
let live: Profile | null = null;
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProfileMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function persist(): void {
  if (!current) return;
  try { saves.save(current, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
const shim = {
  getItem(key: string): string | null {
    if (key === PROFILE_KEY) return current ? JSON.stringify(current) : null;
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    if (key === PROFILE_KEY) {
      try { current = JSON.parse(value) as JsonValue; } catch { return; }
      persist();
      return;
    }
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    if (key === PROFILE_KEY) { current = null; return; }
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

/** js/session.js saveProfile's wrapping: the payload and its checksum. */
export function wrap(p: Profile): JsonValue {
  const payload = JSON.stringify(p);
  return { sum: R.hashString(payload).toString(36), payload };
}
/** A wrapped document (save data or the old slot's text) as a profile, or null. */
export function parseProfile(data: unknown): Profile | null {
  if (data == null) return null;
  return S.loadProfileRaw(typeof data === "string" ? data : JSON.stringify(data));
}

/** The live profile (the one runs update and save). */
export function profile(): Profile {
  if (!live) live = S.loadProfile();
  return live;
}
/** Saves the live profile (device at once, the account debounced). */
export function saveProfile(): void { S.saveProfile(profile()); }
/** Starts from an empty profile (Settings › Erase profile); the saved shift goes too. */
export function resetProfile(): void {
  shim.removeItem(PROFILE_KEY);
  shim.removeItem(S.RUN_SAVE_KEY);
  const name = live && signedIn() ? live.displayName : null;
  live = S.loadProfile();
  if (name) live.displayName = name;
  saveProfile();
}

/** Merges another copy of the document into the live one (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const remote = parseProfile(other);
  if (!remote) return false;
  const next = S.mergeProfiles(remote, profile());
  if (JSON.stringify(next) === JSON.stringify(profile())) return false;
  live = next;
  adoptSettingsFrom(remote.settings);
  saveProfile();
  return true;
}

saves.onConflict((local, remote) => {
  const a = parseProfile(remote.data), b = parseProfile(local?.data ?? null);
  const m = S.mergeProfiles(a, b);
  live = m;
  current = wrap(m);
  return { merged: current };
});
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});

/** The browser build's cloud save: merged with this device's profile, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const changed = adopt(old.text);
  if (!current) S.saveProfile(profile());
  try { saves.save(current!, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options ---------------------------------------------------------------
export interface Settings {
  captions: boolean; theme: string; cameraSway: boolean; holdRepeat: boolean; leftHanded: boolean; haptics: boolean;
  palette: string; timingAssist: boolean;
}
export const settings: Settings = {
  captions: true, theme: "emberdeep", cameraSway: true, holdRepeat: false, leftHanded: false, haptics: true,
  palette: "default", timingAssist: false,
};
type Key = keyof Settings;
export const KEYS: Key[] = ["captions", "theme", "cameraSway", "holdRepeat", "leftHanded", "haptics", "palette", "timingAssist"];
const PALETTES = ["default", "deuter", "protan", "tritan"];
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
export function checkSetting(key: Key, v: unknown): boolean | string | undefined {
  if (key === "theme") return typeof v === "string" && /^[a-z]{1,24}$/.test(v) ? v : undefined;
  if (key === "palette") return typeof v === "string" && PALETTES.includes(v) ? v : undefined;
  return typeof v === "boolean" ? v : undefined;
}
function readSetting(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = checkSetting(key, v);
  if (ok !== undefined) (settings as unknown as Record<string, unknown>)[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: Key, value: unknown): void {
  const v = checkSetting(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v);
    (settings as unknown as Record<string, unknown>)[key] = v;
    settingsChanged();
  } catch { /* keep the device's */ }
}
/** The options a browser-build profile document carried (its `settings`). */
function adoptSettingsFrom(old: unknown): void {
  if (!old || typeof old !== "object") return;
  const o = old as Record<string, unknown>;
  for (const k of KEYS) if (o[k] !== undefined) adoptSetting(k, o[k]);
}
/** Changes one of the game's options (device and account). */
export function setSetting<K extends Key>(key: K, value: Settings[K]): void {
  if (settings[key] === value) return;
  settings[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's account settings (its settings document, patched key by
// key, the page helpers' sound and frame-rate records and the language
// helper's ui.language): the game's options among them carry over (unless
// this game set them since), then every old key is removed (the rest are the
// runtime's Options now).
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) if ((KEYS as string[]).includes(key)) adoptSetting(key as Key, store.legacy(key));
  for (const key of keys) { try { store.removeLegacy(key); } catch { /* not a legacy key */ } }
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  current = cur?.data ?? null;
  live = S.loadProfile();
  for (const k of KEYS) readSetting(k);
  adoptSettingsFrom(live.settings);
  store.onChange((key) => {
    if (!(KEYS as string[]).includes(key)) return;
    readSetting(key as Key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ----------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
/** The name shown: the account's when signed in, else the profile's guest name. */
export function displayName(): string { return player()?.displayName ?? profile().displayName; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = null;
  const p = player();
  if (!p) return;
  // The account nickname replaces the guest name (as the browser build's fetchProfile did).
  if (live && live.displayName !== p.displayName) { live.displayName = p.displayName.slice(0, 40); saveProfile(); }
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** Whether nowMs() follows the platform's clock. */
export function timeTrusted(): boolean { try { return serverNow() !== null; } catch { return false; } }
/** ms to the next UTC midnight by that clock (the Daily Vein rolls over then). */
export function msUntilNextDaily(): number {
  const now = nowMs();
  const d = new Date(now);
  return Math.max(0, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now);
}

// --- boards -------------------------------------------------------------------------
export interface BoardEntry { name: string; score: number; rank?: number; durationSec?: number; me?: boolean }
const LOCAL_BOARD_KEY = "deepworks.boards.v1";
/** Guests: a finished daily on this device's casual board (js/platform.js submitScore). */
export function submitLocal(board: string, name: string, score: number, durationSec: number): void {
  try {
    const boards = JSON.parse(shim.getItem(LOCAL_BOARD_KEY) || "{}") as Record<string, (BoardEntry & { when: number; casual: boolean })[]>;
    const list = boards[board] ?? [];
    list.push({ name, score, durationSec, when: nowMs(), casual: true });
    list.sort((a, b) => b.score - a.score);
    boards[board] = list.slice(0, 50);
    shim.setItem(LOCAL_BOARD_KEY, JSON.stringify(boards));
  } catch { /* storage full: the run still counts in the profile */ }
}
export function localBoard(board: string): BoardEntry[] {
  try { return (JSON.parse(shim.getItem(LOCAL_BOARD_KEY) || "{}") as Record<string, BoardEntry[]>)[board] ?? []; }
  catch { return []; }
}

let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
/** Signed in: the platform high-score board (scores in whole credits, returned as milli-credits like the local board). */
export async function platformBoard(): Promise<BoardEntry[]> {
  const me = player();
  try {
    const b = await highScoreBoard();
    if (!b) return [];
    const r = await leaderboards.entries(b.id, { pageSize: 25 });
    return r.items.map((i) => ({ name: i.username || "Player " + i.userId.slice(0, 6), score: i.score * 1000, rank: i.rank, me: !!me && i.userId === me.userId }));
  } catch { return []; }
}

/** Signed in only: post a finished run's whole credits through score-script.js; { posted, rank }. Never rejects. */
export async function postHighScore(credits: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(credits));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
