// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the seam crystals, dust motes and particle bursts scaled within the
// tier by the level (frame().levelIndex), as the browser build scaled them
// by its hardware level (at most 4×, never below the tier's floor, within
// the pools the scene allocates). The runtime owns the rest of what the old
// Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout,
// and the shadow-map size and MSAA samples it holds to the level. The
// per-category overrides of the old panel are not offered (the runtime's
// Options choose a level); the frosted panel blur of High and Ultra is left
// out (backdrop blur is costly on the engine's UI).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Seam crystals per open layer (pool 80). */
  crystals: number;
  /** Drifting motes per open layer (pool 36; 0 = none). */
  dust: number;
  /** Multiplier on ore / flare particle bursts (the Particles tier's times the budget's). */
  burst: number;
  bloomRes: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting from the room environment. */
  reflections: boolean;
  /** Bump-mapped rock, clear-coated crystals, helmet lamps. */
  detailed: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true },
};
/** js/gfx.js PARTICLE_MULT by the preset's Particles tier (low, medium, high, high). */
const PARTICLES: Record<Preset, number> = { low: 0.35, balanced: 0.7, high: 1, ultra: 1 };
/** js/gfx.js DUST by the Particles tier: the most motes a layer shows. */
const DUST_TIER: Record<Preset, number> = { low: 0, balanced: 18, high: 36, ultra: 36 };
/** Plain (undetailed) seams show at most this many crystals (js/gfx.js CRYSTALS.plain). */
export const CRYSTALS_PLAIN = 24;
const BUDGETS: Record<Preset, Budget> = {
  low: { crystals: 20, dust: 0, burst: 0.6, bloomRes: 0.5 },
  balanced: { crystals: 32, dust: 10, burst: 0.8, bloomRes: 0.5 },
  high: { crystals: 56, dust: 24, burst: 1, bloomRes: 0.5 },
  ultra: { crystals: 80, dust: 36, burst: 1.2, bloomRes: 1 },
};
export const POOLS = { crystals: 80, dust: 36, burst: 2 };
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  const detailed = TABLE[preset].detailed;
  b.crystals = Math.min(POOLS.crystals, Math.round(b.crystals * k), detailed ? POOLS.crystals : CRYSTALS_PLAIN);
  b.dust = Math.min(POOLS.dust, Math.round(b.dust * k), DUST_TIER[preset]);
  b.burst = Math.min(POOLS.burst, Math.round(b.burst * k * 100) / 100) * PARTICLES[preset];
  return { preset, ...TABLE[preset], budget: b };
}
