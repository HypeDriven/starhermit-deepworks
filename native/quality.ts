// The look per graphics level. The engine-owned effects come from the
// frame's level (levelSettings()): shadows on/off and the key light's map
// size (the game sets it; since minor 23 the runtime keeps a game's
// mapSize), ambient occlusion (resolution and samples), bloom resolution,
// the grade, anti-aliasing and the rock's anisotropy. The game's own art is
// the browser build's four presets and budgets (js/gfx.js TABLE / BUDGETS,
// each tuned to hold 60 FPS on the weakest GPU its Auto gave it), keyed by
// the runtime's quality tier (frame().quality); the seam crystals, dust
// motes and particle bursts scale with the level's particle budget over the
// tier's anchor level (at most 4×, within the pools the scene allocates).
// The runtime owns the rest of what the old Graphics panel did: Auto and
// the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the MSAA samples. The
// per-category overrides of the old panel are not offered (the runtime's
// Options choose a level); the frosted panel blur of High and Ultra is left
// out (backdrop blur is costly on the engine's UI).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Seam crystals per open layer (pool 80). */
  crystals: number;
  /** Drifting motes per open layer (pool 36; 0 = none). */
  dust: number;
  /** Multiplier on ore / flare particle bursts (the Particles tier's times the budget's). */
  burst: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  /** The level's ambient occlusion (null = off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** The level's anisotropic filtering on the rock. */
  anisotropy: number;
  /** Image-based lighting from the room environment. */
  reflections: boolean;
  /** Bump-mapped rock, clear-coated crystals, helmet lamps. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, detailed: false },
  balanced: { reflections: true, detailed: true },
  high: { reflections: true, detailed: true },
  ultra: { reflections: true, detailed: true },
};
/** js/gfx.js PARTICLE_MULT by the preset's Particles tier (low, medium, high, high). */
const PARTICLES: Record<Preset, number> = { low: 0.35, balanced: 0.7, high: 1, ultra: 1 };
/** js/gfx.js DUST by the Particles tier: the most motes a layer shows. */
const DUST_TIER: Record<Preset, number> = { low: 0, balanced: 18, high: 36, ultra: 36 };
/** Plain (undetailed) seams show at most this many crystals (js/gfx.js CRYSTALS.plain). */
export const CRYSTALS_PLAIN = 24;
const BUDGETS: Record<Preset, Budget> = {
  low: { crystals: 20, dust: 0, burst: 0.6 },
  balanced: { crystals: 32, dust: 10, burst: 0.8 },
  high: { crystals: 56, dust: 24, burst: 1 },
  ultra: { crystals: 80, dust: 36, burst: 1.2 },
};
export const POOLS = { crystals: 80, dust: 36, burst: 2 };
/** Each tier's first level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a level's settings (the frame's level by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // The level's particle budget over the tier's anchor: counts grow with the
  // level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  const detailed = ART[preset].detailed;
  b.crystals = Math.min(POOLS.crystals, Math.round(b.crystals * k), detailed ? POOLS.crystals : CRYSTALS_PLAIN);
  b.dust = Math.min(POOLS.dust, Math.round(b.dust * k), DUST_TIER[preset]);
  b.burst = Math.min(POOLS.burst, Math.round(b.burst * k * 100) / 100) * PARTICLES[preset];
  return {
    preset, ...ART[preset], budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    anisotropy: s.anisotropy,
  };
}
