// starhermit:engine's levelSettings() for node tests of native/quality.ts: the
// engine's level table (starhermit-gpu levels.rs, engine 1.36), the fields the
// game reads.
const ao = (resolution, samples) => ({ resolution, samples, denoiseSamples: samples });
const row = (level, quality, antialias, shadows, shadowMapSize, aoq, bloom, grade, maxTextureSize, anisotropy, particles) =>
  Object.freeze({ level, quality, antialias, shadows, shadowMapSize, ao: aoq, bloom: bloom === null ? null : { resolution: bloom }, grade, maxTextureSize, anisotropy, particles });
const LEVELS = [
  row('quantum', 'low', 'off', false, 512, null, null, false, 1024, 1, 1000),
  row('atomic', 'low', 'fxaa', false, 1024, null, null, true, 2048, 2, 2000),
  row('molecular', 'balanced', 'fxaa', true, 1024, null, 0.5, true, 2048, 4, 4000),
  row('cellular', 'balanced', 'smaa', true, 2048, null, 0.5, true, 4096, 8, 8000),
  row('terrestrial', 'high', 'smaa', true, 2048, ao(0.5, 8), 0.5, true, 4096, 8, 16000),
  row('planetary', 'high', 'smaa', true, 4096, ao(0.5, 12), 0.5, true, 4096, 16, 32000),
  row('stellar', 'high', 'smaa', true, 4096, ao(1, 16), 1, true, 4096, 16, 64000),
  row('galactic', 'ultra', 'msaa', true, 4096, ao(1, 16), 1, true, 4096, 16, 128000),
  row('cosmic', 'ultra', 'msaa', true, 4096, ao(1, 24), 1, true, 4096, 16, 256000),
  row('infinite', 'ultra', 'msaa', true, 4096, ao(1, 32), 1, true, 4096, 16, 512000),
].map((s, index) => Object.freeze({ ...s, index }));
export const LEVEL_NAMES = LEVELS.map((s) => s.level);
export function levelSettings(level = 'molecular') {
  const s = LEVELS.find((x) => x.level === level);
  if (!s) throw new RangeError(`not a level: ${level}`);
  return s;
}
