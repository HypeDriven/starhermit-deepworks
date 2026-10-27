// The save the engine keeps (node --test): js/session.js's checksummed
// profile document through a localStorage shim, as native/platform.ts holds
// it. Signed-in paths cannot run here, so their logic is covered on the
// documents: the browser build's cloud slot (the JS SDK's saveJSON of the
// wrapped document, shown to the engine as a foreign save's text) parses and
// merges; native/platform.ts wrap() seals as saveProfile does; a conflict's
// merge keeps the better of both devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const R = require('../js/rules.js');
const S = require('../js/session.js');
// native/platform.ts wrap(): the payload and its checksum.
const wrap = (p) => { const payload = JSON.stringify(p); return { sum: R.hashString(payload).toString(36), payload }; };

test('saveProfile writes the wrapped document platform.ts seals', () => {
  const p = S.defaultProfile();
  p.journey['journey-1'] = { stars: 2, bestTick: 200 };
  S.saveProfile(p);
  assert.deepEqual(JSON.parse(store.get(S.PROFILE_KEY)), wrap(p));
  assert.deepEqual(S.loadProfile().journey, p.journey);
});

test("the browser build's cloud slot text parses as a profile", () => {
  const old = S.defaultProfile();
  old.displayName = 'Old Hand';
  old.lessons['learn-1'] = true;
  old.settings = { theme: 'glacier', captions: false, volMusic: 0.2 };
  const slotText = JSON.stringify(wrap(old)); // SDK saveJSON(JSON.parse(wrapped))
  const p = S.loadProfileRaw(slotText);
  assert.equal(p.displayName, 'Old Hand');
  assert.equal(p.lessons['learn-1'], true);
  assert.equal(p.settings.theme, 'glacier');
});

test('a tampered or foreign document is refused', () => {
  const w = wrap(S.defaultProfile());
  w.payload = w.payload.replace('Guest', 'Ghost');
  assert.equal(S.loadProfileRaw(JSON.stringify(w)), null);
  assert.equal(S.loadProfileRaw('not json'), null);
});

test('merging two devices keeps the better of each record', () => {
  const a = S.defaultProfile(), b = S.defaultProfile();
  a.journey['journey-1'] = { stars: 3, bestTick: 250 };
  b.journey['journey-1'] = { stars: 2, bestTick: 180 };
  b.journey['journey-2'] = { stars: 1, bestTick: 400 };
  a.daily['2026-10-27'] = { score: 5000, won: false };
  b.daily['2026-10-27'] = { score: 3000, won: true };
  a.practice.miner = 100; b.practice.miner = 900;
  a.achievements.first_completion = 20; b.achievements.first_completion = 10;
  a.mastery.xp = 400; b.mastery.xp = 60;
  a.stats.runsPlayed = 9; b.stats.runsPlayed = 4;
  b.settings = { theme: 'ashen' };
  const m = S.mergeProfiles(a, b);
  assert.deepEqual(m.journey['journey-1'], { stars: 3, bestTick: 180 });
  assert.deepEqual(m.journey['journey-2'], { stars: 1, bestTick: 400 });
  assert.deepEqual(m.daily['2026-10-27'], { score: 5000, won: true });
  assert.equal(m.practice.miner, 900);
  assert.equal(m.achievements.first_completion, 10);
  assert.equal(m.mastery.xp, 400);
  assert.equal(m.mastery.level, S.masteryLevelFor(400).level);
  assert.equal(m.stats.runsPlayed, 9);
  assert.equal(m.settings.theme, 'ashen', "this device's settings stay");
});

test('a saved practice shift resumes with capped away time', () => {
  const C = require('../js/content.js');
  const content = { id: 'practice-miner', name: 'Practice — Miner', seed: 7, overrides: {}, goals: null, limits: null, parSec: 0, endless: true };
  const run = S.createRun(content, 'practice', { buildState: C.buildState });
  S.tick(run, 5000);
  assert.ok(S.saveRun(run));
  const data = S.loadSavedRun();
  data.savedAt -= 3600 * 1000; // an hour away
  const r = S.resumeRun(data, 1800);
  assert.equal(r.away.seconds, 1800);
  assert.equal(r.away.capped, true);
  assert.ok(r.away.earned > 0);
  S.clearSavedRun();
  assert.equal(S.loadSavedRun(), null);
});
