// The browser build's pure game scripts, shared unchanged with the node tests:
// the string tables (js/locales/*.js, js/i18n.js), the deterministic rules
// engine (js/rules.js: fixed-point sim, seeded flares, legal actions,
// scoring, serialization), the content (js/content.js: themes, lessons, the
// 40 Journey stages, challenges, practice difficulties, the self-calibrating
// daily) and the session (js/session.js: runs with idempotent command ids,
// the replay envelope, undo, the saved practice run with its capped away
// simulation, the checksummed profile document and its merge), evaluated as
// classic scripts so their globals are this module's exports. js/session.js
// keeps its documents in `localStorage`: platform.ts puts a shim there
// (nothing reads it while the scripts load).
import { loadClassic } from "starhermit:script";

for (const f of [
  "js/locales/en-GB.js", "js/locales/es.js", "js/locales/de.js", "js/locales/fr.js", "js/locales/pt.js", "js/locales/it.js",
  "js/i18n.js", "js/rules.js", "js/content.js", "js/session.js",
]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export interface Mechanics { lift: boolean; flares: boolean; foreman: boolean; shaftUpgrades: boolean }
export interface Goal { type: "earn" | "depth" | "rate"; amount: number }
export interface Ruleset {
  layerCount: number; workerCapPerLayer: number; foremanCost: number; flareDurationSec: number; parSec: number;
  goals: Goal | null; limits: { timeSec?: number; moves?: number } | null; mechanics: Mechanics; awayCapSec?: number;
  [k: string]: unknown;
}
export interface Layer { unlocked: boolean; workers: number; shaftLevel: number; milliOre: number }
export interface Flare { layer: number; id: number; expiresTick: number }
export interface State {
  version: number; seed: number; tick: number; tickMs: number; coins: number; lifetimeEarned: number; hires: number;
  ruleset: Ruleset; layers: Layer[]; workers: { total: number; idle: number };
  lift: { capLevel: number; speedLevel: number }; foreman: { unlocked: boolean; enabled: boolean };
  flare: { active: Flare | null }; stats: { playerCommands: number; invalidActions: number; maxRateMilliOreSec: number };
  terminal: { reason: string; won: boolean } | null;
}
export interface Cmd { type: string; layer?: number; id?: unknown }
export interface RulesEvent { type: string; layer?: number; credits?: number }
export interface Legal { type: string; layer?: number; enabled: boolean; reason?: string; cost?: number; id?: number }
export interface ScoreInfo {
  total: number;
  components: { earned: number; flares: number; depthBonus: number; timeBonus: number; efficiencyPermille: number };
}
export interface Theme {
  id: string; name: string; rock: number; rockDark: number; seam: number; seamHot: number; fog: number; key: number;
  fill: number; accent: number; lift: number; ambience: string;
}
export interface LessonStep { text: string; require: { type: string; layer?: number; amount?: number } }
export interface Lesson {
  id: string; name: string; version: number; theme: string; intro: string; ruleset: Record<string, unknown>;
  setup?: (s: State) => void; steps: LessonStep[]; goals: Goal | null; parSec: number;
}
/** A content entry a run starts from (journey stage, lesson, challenge, practice, daily). */
export interface Content {
  id: string; name: string; version?: number; seed: number; theme?: string; overrides?: Record<string, unknown>;
  goals: Goal | null; limits: { timeSec?: number; moves?: number } | null; parSec: number; endless?: boolean;
  n?: number; hint?: string; description?: string; key?: string; difficulty?: string; lesson?: Lesson;
  setup?: (s: State) => void;
}
export interface Run {
  id: string; mode: string; contentId: string; contentVersion: number; seed: number; state: State; log: unknown[];
  pendingAdvanceMs: number; undoStack: string[]; hashes: unknown[]; startedAt: number; lastSavedAt: number;
  closed: boolean; result: { terminal: { reason: string; won: boolean }; score: ScoreInfo; tick: number; moves: number; invalid: number } | null;
}
export interface SavedRun { v: number; runId: string; mode: string; contentId: string; contentVersion: number; seed: number; state: string; log: unknown[]; savedAt: number }
export interface Profile {
  v: number; playerId: string; displayName: string;
  journey: Record<string, { stars: number; bestTick: number; bestScore?: number }>;
  lessons: Record<string, boolean>; daily: Record<string, { score: number; won: boolean }>;
  practice: Record<string, number>; challenges: Record<string, number>; achievements: Record<string, number>;
  mastery: { xp: number; level: number };
  stats: { runsPlayed: number; totalEarned: number; flaresClaimed: number; playtimeSec: number };
  settings: Record<string, unknown> | null;
}

interface RulesApi {
  COIN_SCALE: number; ORE_SCALE: number;
  REASONS: Record<string, string>;
  hashString(s: string): number;
  mergeRuleset(o: Record<string, unknown>): Ruleset;
  can(s: State, c: Cmd): { ok: boolean; reason: string };
  legalActions(s: State): Legal[];
  advance(s: State, ms: number): RulesEvent[];
  score(s: State): ScoreInfo;
  isBlocked(s: State, i: number): boolean;
  layerRate(s: State, i: number): number;
  liftRate(s: State): number;
  liftCapacity(s: State): number;
  liftCycleMs(s: State): number;
  binCapMilli(s: State, i: number): number;
  totalExtractionRate(s: State): number;
  incomeRate(s: State): number;
  hireCost(s: State): number;
  shaftCost(s: State, i: number): number;
  liftCapCost(s: State): number;
  liftSpeedCost(s: State): number;
  unlockCost(s: State): number;
  nextLockedLayer(s: State): number;
  unlockedCount(s: State): number;
  describeState(s: State, tr: (k: string, v?: Record<string, string | number>) => string): string;
  formatCoins(m: number): string;
  formatOre(m: number): string;
  formatRate(m: number): string;
}
interface ContentApi {
  CONTENT_VERSION: number; THEMES: Theme[]; LESSONS: Lesson[]; JOURNEY: Content[]; CHALLENGES: Content[];
  PRACTICE_DIFFICULTIES: { id: string; name: string; overrides: Record<string, unknown> }[];
  themeById(id: string | undefined): Theme;
  dailyInfo(d: Date): Content;
  buildState(c: Content): State;
  journeyByIndex(i: number): Content | null;
}
interface SessionApi {
  createRun(c: Content, mode: string, opts?: { buildState?: (c: Content) => State }): Run;
  tick(r: Run, ms: number): RulesEvent[];
  dispatch(r: Run, c: Cmd): { ok: boolean; reason?: string; deduped?: boolean; events: RulesEvent[] };
  canUndo(r: Run): boolean;
  undo(r: Run): { ok: boolean };
  finalize(r: Run): void;
  envelope(r: Run): unknown;
  saveRun(r: Run): boolean;
  loadSavedRun(): SavedRun | null;
  clearSavedRun(): void;
  resumeRun(d: SavedRun, cap?: number): { state: State; away: { seconds: number; capped: boolean; earned: number } } | null;
  defaultProfile(): Profile;
  loadProfile(): Profile;
  loadProfileRaw(raw: string): Profile | null;
  mergeProfiles(remote: Profile | null, local: Profile | null): Profile;
  saveProfile(p: Profile): boolean;
  starsFor(c: Content, tick: number): number;
  masteryXpFor(r: NonNullable<Run["result"]>): number;
  masteryLevelFor(xp: number): { level: number; into: number; next: number };
  RUN_SAVE_KEY: string; PROFILE_KEY: string;
}
interface I18nApi {
  T(key: string, vars?: Record<string, string | number> | null): string;
  setLocale(tag: string): void;
  readonly lang: string;
  LOCALES: string[];
  DICTS: Record<string, Record<string, string>>;
}

const g = globalThis as unknown as { DWRules: RulesApi; DWContent: ContentApi; DWSession: SessionApi; DWI18n: I18nApi };
export const R = g.DWRules;
export const C = g.DWContent;
export const S = g.DWSession;
export const I18n = g.DWI18n;
