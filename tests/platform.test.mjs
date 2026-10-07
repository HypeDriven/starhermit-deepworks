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
  const store = { save: null, settings: {} };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/v1/users/u-12345678/profile')) return json({ nickname: 'Pip' });
    if (url.includes('/api/v1/me/cloud-saves/')) {
      if (method === 'PUT') { store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return new Response(null, { status: 204 }); }
      return store.save ? new Response(store.save, { status: 200 }) : new Response('', { status: 404 });
    }
    if (url.endsWith(`/api/v1/games/${SLUG}/settings`)) {
      if (method === 'PATCH') { Object.assign(store.settings, JSON.parse(init.body).settings); return json({ settings: store.settings }); }
      return json({ settings: store.settings });
    }
    if (url === '/api/v1/time') return json({ now: Date.now() });
    if (url === '/api/v1/scores/daily') return json({ ok: true, rank: 1 });
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

test('settings patch, bindings, invite link and own-server time/scores', async () => {
  const { P, calls, store } = boot('#game_token=' + JWT);
  P.init();
  await Promise.all([P.patchSettings({ theme: 'x' }), P.patchSettings({ muted: true })]);
  assert.deepEqual(J(store.settings), { theme: 'x', muted: true });
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'patches are debounced into one');
  assert.deepEqual(J(await P.loadBindings({ serve: ['KeyS'], hint: ['KeyH'] })), { serve: ['KeyX'], hint: ['KeyH'] });
  assert.match(P.inviteLink(), /game-invite\/u-12345678\/deepworks$/);
  assert.equal(await P.syncTime(), true);
  const res = await P.submitScore('daily', { scoreTotal: 5 });
  assert.equal(res.rank, 1);
  const post = calls.find((c) => c.url === '/api/v1/scores/daily');
  assert.equal(post.init.headers.Authorization, 'Bearer ' + JWT);
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
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0);
});
