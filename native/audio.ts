// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.txt) per game event, the mine's rumble
// (brown noise through a low-pass whose cutoff breathes slowly) looping
// underneath, and the adaptive music (a sine bass note on a minor
// pentatonic every fourth 375 ms step, a triangle sparkle voice joining as
// the mine's extraction rate climbs). Each captioned cue also reports its
// caption key (main.ts shows it when Sound captions is on).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// the ambience → "effects", the menu click and back → "interface", the
// unused voice bus is gone; the old default bus levels (music 50 %, effects
// 80 %, ambience 40 %) are folded into each sound's gain. The rumble and the
// music's notes are rendered once into clips by the engine
// (OfflineAudioContext, one context a stem) with the old oscillator envelopes,
// the sparkle's seeded pitch variants as playback pitch; the procedural
// stand-ins the browser build played while a clip decoded are not ported, so
// a clip still loading is silent. Every clip
// loads at once in onStart (the engine hands each loaded clip to the mixer,
// natively and on the web); the rumble, the notes and the music start once
// the mixer runs (in a browser, after the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

/** Marks an English caption key (translated where it is shown). */
const N = (s: string): string => s;
const LEVEL = { music: 0.5, effects: 0.8, ambience: 0.4 };
export type Cue =
  | "ui_click" | "ui_back" | "error" | "assign" | "unassign" | "hire" | "upgrade" | "unlock_layer" | "claim_flare"
  | "flare_started" | "coin" | "foreman" | "terminal_win" | "terminal_lose" | "undo" | "bin_blocked" | "flare_expired"
  | "lesson_step" | "shift_start" | "achievement" | "away_return";
const SAMPLES: Record<Cue, string> = {
  ui_click: "ui-click", ui_back: "ui-back", error: "error-denied", assign: "worker-assign", unassign: "worker-recall",
  hire: "worker-hire", upgrade: "upgrade-complete", unlock_layer: "layer-unlock", claim_flare: "flare-claim",
  flare_started: "flare-warning", coin: "coin-clink", foreman: "foreman-whistle", terminal_win: "shift-victory",
  terminal_lose: "shift-defeat", undo: "undo-swipe", bin_blocked: "bin-blocked", flare_expired: "flare-fizzle",
  lesson_step: "lesson-chime", shift_start: "shift-start", achievement: "achievement-star", away_return: "away-return",
};
/** js/audio.js's captions. */
const CAPTIONS: Partial<Record<Cue, string>> = {
  error: N("Action not available"), assign: N("Worker assigned"), unassign: N("Worker recalled"), hire: N("Worker hired"),
  upgrade: N("Upgrade complete"), unlock_layer: N("New layer opened"), claim_flare: N("Seam flare claimed"),
  flare_started: N("A seam is flaring"), foreman: N("Foreman engaged"), terminal_win: N("Objective complete"),
  terminal_lose: N("Run ended"), undo: N("Undone"), bin_blocked: N("Bin full — transport is the bottleneck"),
  flare_expired: N("Seam flare faded"), lesson_step: N("Lesson step complete"), shift_start: N("Shift started"),
  achievement: N("Achievement unlocked"), away_return: N("Welcome back"),
};
const INTERFACE = new Set<Cue>(["ui_click", "ui_back"]);

const clips = new Map<string, AudioClip>();
let onCaption: ((key: string) => void) | null = null;
let suspended = false;

/** Loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  renderBeds();
}
/** cb(captionKey) for each captioned cue (an English key). */
export function setOnCaption(cb: (key: string) => void): void { onCaption = cb; }
/** A hidden window: everything holds (js/audio.js handleVisibility). */
export function setSuspended(on: boolean): void {
  suspended = on;
  if (rumble) { try { rumble.fade(on ? 0 : RUMBLE_GAIN, 0.2); } catch { /* gone */ } }
}

/** Plays a cue's sample (once loaded) and reports its caption. */
export function play(name: Cue): void {
  if (onCaption && CAPTIONS[name]) onCaption(CAPTIONS[name]!);
  const file = SAMPLES[name];
  const clip = clips.get(file);
  if (!clip || suspended) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered ambience and music -------------------------------------------------------------
const RATE = 22050;
/** js/audio.js tone(): attack to `gain` in 8 ms, exponential decay to 0.0001 by `dur`. */
async function renderTone(freq: number, dur: number, type: "sine" | "triangle"): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round((dur + 0.02) * RATE), RATE);
  const osc = off.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const env = off.createGain();
  env.gain.setValueAtTime(0.0001, 0);
  env.gain.exponentialRampToValueAtTime(1, 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, dur);
  env.gain.setValueAtTime(0, dur);
  osc.connect(env).connect(off.destination);
  osc.start();
  return createClip(await off.startRendering());
}
/** Level of the engine's brown noise to the old rumble's, by measured rms. */
const RUMBLE_MAKEUP = 0.871;
/** js/audio.js startAmbience(): brown noise, low-pass at 220 Hz ± 60 Hz breathing at 0.07 Hz (one period, looped). */
async function renderRumble(): Promise<AudioClip> {
  const seconds = 1 / 0.07;
  const off = new OfflineAudioContext(1, Math.round(seconds * RATE), RATE);
  const noise = off.createNoise({ color: "brown", seed: 0x5eed, seconds });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 220;
  const lfo = off.createOscillator();
  lfo.frequency.value = 0.07;
  const depth = off.createGain();
  depth.gain.value = 60;
  lfo.connect(depth);
  depth.connect(lp.frequency);
  // Fade the loop's seam over 50 ms.
  const seam = off.createGain();
  seam.gain.setValueAtTime(0, 0);
  seam.gain.linearRampToValueAtTime(RUMBLE_MAKEUP, 0.05);
  seam.gain.setValueAtTime(RUMBLE_MAKEUP, seconds - 0.05);
  seam.gain.linearRampToValueAtTime(0, seconds);
  noise.connect(lp).connect(seam).connect(off.destination);
  noise.start();
  lfo.start();
  return createClip(await off.startRendering());
}
const MUSIC_SCALE = [0, 3, 5, 7, 10]; // minor pentatonic
const BASE = 110; // A2
const RUMBLE_GAIN = 0.5 * LEVEL.ambience;
const notes = new Map<string, AudioClip>();
let rumbleBed: AudioClip | null = null;
let rumble: Sound | null = null;
let musicStep = 0;
let nextStep = 0;
let intensity = 0;
let variantSeed = 1;

/** Renders the rumble and the notes once (onStart); the music waits on each clip. */
function renderBeds(): void {
  renderRumble().then((c) => { rumbleBed = c; }, (e: unknown) => console.warn(`rumble: ${String(e)}`));
  for (const deg of MUSIC_SCALE) {
    for (const [k, freq, dur, type] of [
      [`b${deg}`, BASE * Math.pow(2, deg / 12), 1.4, "sine"],
      [`s${deg}`, BASE * 2 * Math.pow(2, deg / 12), 0.5, "triangle"],
    ] as [string, number, number, "sine" | "triangle"][]) {
      renderTone(freq, dur, type).then((c) => { notes.set(k, c); }, (e: unknown) => console.warn(`music: ${String(e)}`));
    }
  }
}

/** The run's seed for the sparkle's pitch variants (js/audio.js setVariantSeed). */
export function setVariantSeed(seed: number): void { variantSeed = seed >>> 0; }
function nextVariant(): number {
  variantSeed = (variantSeed * 1664525 + 1013904223) >>> 0;
  return 0.94 + (variantSeed % 120) / 1000;
}
/** 0..1, from the mine's extraction rate. */
export function setIntensity(v: number): void { intensity = Math.max(0, Math.min(1, v)); }

/** Each frame once the mixer runs: the rumble, then the music's steps by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  try {
    if (rumbleBed && !rumble) rumble = playClip(rumbleBed, { bus: "effects", gain: suspended ? 0 : RUMBLE_GAIN, loop: true });
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (suspended) return;
  const now = context.currentTime;
  if (now < nextStep) return;
  nextStep = Math.max(now, nextStep) + 0.375;
  musicStep++;
  try {
    if (musicStep % 4 === 0) {
      const deg = MUSIC_SCALE[((musicStep / 4) % MUSIC_SCALE.length) | 0]!;
      const n = notes.get(`b${deg}`);
      if (n) playClip(n, { bus: "music", gain: 0.1 * LEVEL.music });
    }
    if (intensity > 0.25 && musicStep % 2 === 1) {
      const idx = (musicStep * 7 + Math.floor(intensity * 10)) % MUSIC_SCALE.length;
      const n = notes.get(`s${MUSIC_SCALE[idx]!}`);
      // The octave-4 voice is the octave-2 clip an octave up.
      if (n) playClip(n, { bus: "music", gain: (0.03 + intensity * 0.05) * LEVEL.music, pitch: (intensity > 0.6 ? 2 : 1) * nextVariant() });
    }
  } catch { /* the mixer is full */ }
}
