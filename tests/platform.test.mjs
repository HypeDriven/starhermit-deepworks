/** Deepworks — StarHermit adapter unit tests (node --test).
 * Loads starhermit-sdk.js + js/platform.js into a vm sandbox with a stubbed
 * fetch and launch hash. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'deepworks';
const J = (o) => JSON.parse(JSON.stringify(o));
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64u({ alg: 'none' })}.${b64u({ sub: 'u-12345678', game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

function boot(hash) {
  const calls = [];
  const store = { save: null, settings: {}, version: 0, etag: null };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/v1/users/u-12345678/profile')) return json({ nickname: 'Pip' });
    if (url.includes('/api/v1/me/cloud-saves/')) {
      // Conditional writes: the SDK sends If-Match with the ETag it last saw;
      // a newer save from "another device" (store.etag bumped) answers 412.
      if (url.endsWith('/info')) return json({ exists: !!store.save, etag: store.etag });
      if (method === 'PUT') {
        const ifMatch = init.headers && init.headers['If-Match'];
        if (ifMatch && ifMatch !== store.etag) return json({ error: 'precondition_failed', etag: store.etag }, 412);
        store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        store.etag = '"v' + (++store.version) + '"';
        return json({ etag: store.etag });
      }
      return store.save ? new Response(store.save, { status: 200 }) : new Response('', { status: 404 });
    }
    if (url.endsWith(`/api/v1/games/${SLUG}/settings`)) {
      if (method === 'PATCH') { Object.assign(store.settings, JSON.parse(init.body).settings); return json({ settings: store.settings }); }
      return json({ settings: store.settings });
    }
    if (url === '/api/v1/time') return json({ now: Date.now() });
    if (url.endsWith(`/api/v1/games/${SLUG}/controls`)) return json({ actions: [{ action: 'serve', codes: ['KeyX'] }] });
    return new Response('', { status: 404 });
  };
  const listeners = {};
  const location = { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' };
  const win = {
    location,
    history: { state: null, replaceState(_s, _t, url) { const i = url.indexOf('#'); location.hash = i >= 0 ? url.slice(i) : ''; } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    document: { hidden: false, addEventListener() {} },
    fetch, Response, localStorage: { getItem() { return null; }, setItem() {} }, Blob, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Uint8Array, DataView, Map, Promise, JSON,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 20)); t.unref(); return t; },
    clearTimeout,
  };
  win.window = win; win.self = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(path.join(ROOT, 'starhermit-sdk.js'), 'utf8'), win);
  vm.runInContext(readFileSync(path.join(ROOT, 'js', 'platform.js'), 'utf8'), win);
  win.DWPlatform = win.DWPlatform || win.self.DWPlatform;
  return { win, P: win.DWPlatform, calls, store, listeners };
}

test('launch token: read from the fragment, stripped, slug from claims', async () => {
  const { P, win } = boot('#game_token=' + JWT + '&session_id=abc');
  assert.equal(P.init().hosted, true);
  assert.equal(P.state.scope, SLUG);
  assert.equal(P.state.userId, 'u-12345678');
  assert.equal(win.location.hash, '');
  assert.equal(P.state.launchToken, JWT);
});

test('profile name comes from the profile nickname', async () => {
  const { P } = boot('#game_token=' + JWT);
  P.init();
  const prof = await P.fetchProfile();
  assert.equal(prof.displayName, 'Pip');
  assert.equal(prof.guest, false);
});

test('cloud save round-trips through /api/v1/me/cloud-saves/game:<slug>', async () => {
  const { P, calls } = boot('#game_token=' + JWT);
  P.init();
  const wrapped = JSON.stringify({ sum: 'abc', payload: '{"v":1}' });
  P.onSave(wrapped); // held until the boot cloud load settles
  assert.equal(await P.loadCloud(), null); // empty slot: the held save is pushed
  assert.equal(P.state.sync, 'saving');
  assert.equal(await P.flushSave(true), true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG)), put.url);
  assert.equal(put.init.keepalive, true);
  assert.equal(P.state.sync, 'synced');
  assert.equal(await P.loadCloud(), wrapped);
});

test('a lost cloud write (412) is reported as a save conflict and cleared by a reload', async () => {
  const { P, store } = boot('#game_token=' + JWT);
  P.init();
  let conflicts = 0;
  P.onSaveConflict(() => conflicts++);
  assert.equal(await P.loadCloud(), null);
  P.onSave(JSON.stringify({ sum: 'a', payload: '{}' }));
  assert.equal(await P.flushSave(true), true);
  store.etag = '"elsewhere"'; // another device saved since
  P.onSave(JSON.stringify({ sum: 'b', payload: '{}' }));
  assert.equal(await P.flushSave(true), false);
  assert.equal(conflicts, 1);
  assert.equal(P.saveConflicted(), true);
  await P.loadCloud();
  assert.equal(P.saveConflicted(), false);
});

test('mergeProfiles keeps the better side of every record', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const S = require('../js/session.js');
  const remote = Object.assign(S.defaultProfile(), {
    journey: { 'journey-1': { stars: 3, bestTick: 400 }, 'journey-2': { stars: 1, bestTick: 900 } },
    lessons: { 'learn-1': true }, daily: { '2026-10-01': { score: 500, won: true } },
    practice: { miner: 1000 }, challenges: { 'ch-sprint': 50 }, achievements: { first_completion: 100 },
    mastery: { xp: 120, level: 3 }, stats: { runsPlayed: 4, totalEarned: 900, flaresClaimed: 2, playtimeSec: 600 } });
  const local = Object.assign(S.defaultProfile(), {
    displayName: 'Pip', journey: { 'journey-2': { stars: 2, bestTick: 1200 }, 'journey-3': { stars: 1, bestTick: 50 } },
    lessons: { 'learn-2': true }, daily: { '2026-10-01': { score: 700, won: false }, '2026-10-02': { score: 10, won: false } },
    practice: { miner: 600, foreman: 30 }, challenges: { 'ch-sprint': 90 }, achievements: { first_completion: 50, streak_7: 60 },
    mastery: { xp: 80, level: 2 }, stats: { runsPlayed: 7, totalEarned: 500, flaresClaimed: 5, playtimeSec: 100 } });
  const m = S.mergeProfiles(remote, local);
  assert.equal(m.displayName, 'Pip');
  assert.deepEqual(J(m.journey), { 'journey-1': { stars: 3, bestTick: 400 }, 'journey-2': { stars: 2, bestTick: 900 }, 'journey-3': { stars: 1, bestTick: 50 } });
  assert.deepEqual(Object.keys(m.lessons).sort(), ['learn-1', 'learn-2']);
  assert.deepEqual(J(m.daily['2026-10-01']), { score: 700, won: true });
  assert.ok(m.daily['2026-10-02']);
  assert.deepEqual(J(m.practice), { miner: 1000, foreman: 30 });
  assert.equal(m.challenges['ch-sprint'], 90);
  assert.deepEqual(J(m.achievements), { first_completion: 50, streak_7: 60 });
  assert.equal(m.mastery.xp, 120);
  assert.deepEqual(J(m.stats), { runsPlayed: 7, totalEarned: 900, flaresClaimed: 5, playtimeSec: 600 });
});

test('settings patch, bindings, invite link, time and platform scores', async () => {
  const { P, calls, store } = boot('#game_token=' + JWT);
  P.init();
  await Promise.all([P.patchSettings({ theme: 'x' }), P.patchSettings({ muted: true })]);
  assert.deepEqual(J(store.settings), { theme: 'x', muted: true });
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'patches are debounced into one');
  assert.deepEqual(J(await P.loadBindings({ serve: ['KeyS'], hint: ['KeyH'] })), { serve: ['KeyX'], hint: ['KeyH'] });
  assert.match(P.inviteLink(), /game-invite\/u-12345678\/deepworks$/);
  assert.equal(await P.syncTime(), true);
  // signed in, runs never touch the old own-server score routes
  assert.deepEqual(J(await P.submitScore('daily', { scoreTotal: 5 })), { ok: false, local: false });
  assert.equal(calls.filter((c) => /\/scores\//.test(c.url)).length, 0);
});

test('standalone: no token means no fetch at all', async () => {
  const { P, calls } = boot('');
  assert.equal(P.init().hosted, false);
  assert.equal(P.canSignIn(), false);
  assert.equal(P.inviteLink(), null);
  assert.equal(await P.fetchProfile(), null);
  assert.equal(await P.loadCloud(), null);
  P.onSave(JSON.stringify({ sum: 'x', payload: '{}' }));
  await P.flushSave(true);
  await P.patchSettings({ a: 1 });
  assert.deepEqual(J(await P.getSettings()), {});
  assert.deepEqual(J(await P.loadBindings({ hint: ['KeyH'] })), { hint: ['KeyH'] });
  assert.equal(await P.syncTime(), false);
  await P.submitScore('daily', { scoreTotal: 5, name: 'Guest' });
  assert.deepEqual(J(await P.postHighScore(5)), { posted: false, rank: null });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0);
});
