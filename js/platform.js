/**
 * Deepworks — platform module (StarHermit integration, spec §12).
 *
 * A thin layer over window.StarHermit (starhermit-sdk.js, loaded first): the
 * SDK reads the launch token (#game_token= / #access_token=), strips it,
 * renews it and makes every authenticated call. This module keeps the game's
 * API: the profile nickname (never /api/v1/me), the cloud-save mirror of the
 * checksummed profile document at /api/v1/me/cloud-saves/game:<slug> (remote
 * wins on boot; debounced saves with a pagehide flush), the settings KV,
 * key bindings, sign-in and invite link. The own-server score boards
 * (/scores/*, server.js) and /time are its backend, called through
 * StarHermit.api with graceful offline fallback. Achievements stay local;
 * presence/activity/telemetry have no launch-token endpoints and are inert.
 * Standalone: everything degrades to local offline mode with no network calls.
 */
(function (root) {
  'use strict';

  var SAVE_DEBOUNCE_MS = 2000;
  var PATCH_DEBOUNCE_MS = 400;

  var state = {
    hosted: false,
    timeOffsetMs: 0,       // serverNow = Date.now() + offset
    timeSynced: false,
    online: true,
    consent: { telemetry: false },
    profile: { displayName: 'Guest Prospector', avatar: null, guest: true },
    sync: 'offline',       // offline | saving | synced (cloud mirror)
    syncListeners: [],
    authListeners: []
  };
  Object.defineProperty(state, 'userId', { get: function () { var s = sdk(); return s ? s.userId : null; } });
  Object.defineProperty(state, 'scope', { get: function () { var s = sdk(); return s ? s.slug : null; } });
  Object.defineProperty(state, 'launchToken', { get: function () { var s = sdk(); return s ? s.token : null; } });

  function sdk() { return root.StarHermit || null; }

  function setSync(v) {
    if (state.sync === v) return;
    state.sync = v;
    for (var i = 0; i < state.syncListeners.length; i++) {
      try { state.syncListeners[i](v); } catch (e) { /* listener errors never break */ }
    }
  }

  var started = false;
  function init() {
    var s = sdk();
    if (s && !started) {
      started = true;
      s.init();
      s.on('saved', function (ok) { if (state.hosted) setSync(ok ? 'synced' : 'offline'); });
      s.on('auth', function (a) {
        var was = state.hosted;
        state.hosted = !!(a && a.signedIn && s.slug);
        if (!state.hosted) {
          state.profile = { displayName: 'Guest Prospector', avatar: null, guest: true };
          state.timeSynced = false;
          setSync('offline');
        }
        if (was !== state.hosted) state.authListeners.forEach(function (fn) { try { fn(state.hosted); } catch (e) { /* ignore */ } });
      });
      try {
        root.addEventListener('pagehide', function () { flushSave(true); });
        root.document.addEventListener('visibilitychange', function () { if (root.document.hidden) flushSave(true); });
      } catch (e) { /* no window events available */ }
    }
    state.hosted = !!(s && s.signedIn && s.slug);
    if (state.hosted) fetchProfile().catch(function () {});
    try {
      root.addEventListener('online', function () { state.online = true; });
      root.addEventListener('offline', function () { state.online = false; });
    } catch (e) { /* no window events available */ }
    return state;
  }

  function refreshToken() { var s = sdk(); return s ? s.refresh().then(function (t) { return !!t; }) : Promise.resolve(false); }

  // Own-backend call (/api/v1 + path) through the SDK. Structured {"error"}
  // bodies and 429s surface as recoverable errors.
  function api(path, opts) {
    var s = sdk();
    if (!s || !state.hosted) return Promise.reject(new Error('not-hosted'));
    opts = opts || {};
    return s.api('/api/v1' + path, { method: opts.method || 'GET', body: opts.body }).then(function (body) {
      if (body && body.error) { var e1 = new Error(body.error); e1.recoverable = true; throw e1; }
      return body;
    }, function (e) {
      var err = new Error(e && e.status === 429 ? 'rate-limited' : (e && e.message) || 'network');
      err.recoverable = true; err.status = e && e.status;
      throw err;
    });
  }

  // Nickname via StarHermit.profile (nickname, then "Player <id>").
  function profileFor(userId) {
    var s = sdk();
    if (!s || !state.hosted || !userId) return Promise.resolve('player');
    return s.profile(String(userId)).then(function (p) { return p ? p.displayName : 'Player ' + String(userId).slice(0, 6); });
  }
  function fetchProfile() {
    if (!state.hosted) return Promise.resolve(null);
    return profileFor(state.userId).then(function (n) {
      state.profile.displayName = String(n).slice(0, 40);
      state.profile.guest = false;
      return state.profile;
    });
  }

  /* Cloud save: the SDK slot holds the wrapped profile document. Remote wins
   * on boot (validated by DWSession.loadProfileRaw); localStorage stays the
   * offline cache. */
  // Saves made before the cloud load settles (boot settings, nickname) are
  // held, not queued: a queued stale doc would be PUT by the debounce or a
  // pagehide flush over a newer cloud save. When the slot holds a doc the
  // held copy is dropped (main.js adopts and re-saves the remote doc);
  // otherwise it is pushed.
  var cloudLoaded = false;
  var heldSave = null;
  function loadCloud() {
    var s = sdk();
    if (!s || !state.hosted) return Promise.resolve(null);
    cloudLoaded = false;
    var settle = function (obj) {
      cloudLoaded = true;
      var held = heldSave;
      heldSave = null;
      if (!obj && held) onSave(held); // empty slot (or load error): push the local doc
      return obj ? JSON.stringify(obj) : null;
    };
    return s.loadJSON().then(function (obj) {
      if (state.sync === 'offline') setSync('synced');
      return settle(obj);
    }, function () { return settle(null); });
  }
  function onSave(wrapped) {
    var s = sdk();
    if (!s || !state.hosted) return;
    if (!cloudLoaded) { heldSave = wrapped; return; }
    try { s.saveJSON(JSON.parse(wrapped), SAVE_DEBOUNCE_MS); } catch (e) { return; }
    setSync('saving');
  }
  function flushSave(keepalive) {
    var s = sdk();
    if (!s || !state.hosted) return Promise.resolve(false);
    return s.flushSave(keepalive === true);
  }
  function onSync(fn) { if (typeof fn === 'function') state.syncListeners.push(fn); }
  function onAuth(fn) { if (typeof fn === 'function') state.authListeners.push(fn); }

  // ------------------------------------------------- settings KV / controls ---
  function getSettings() {
    var s = sdk();
    return s && state.hosted ? s.getSettings().catch(function () { return {}; }) : Promise.resolve({});
  }
  var patchPending = null, patchTimer = null, patchWaiters = [];
  function patchSettings(obj) {
    var s = sdk();
    if (!s || !state.hosted) return Promise.resolve(null);
    patchPending = Object.assign(patchPending || {}, obj);
    if (patchTimer) clearTimeout(patchTimer);
    return new Promise(function (resolve) {
      patchWaiters.push(resolve);
      patchTimer = setTimeout(function () {
        var body = patchPending, waiters = patchWaiters;
        patchPending = null; patchTimer = null; patchWaiters = [];
        var done = function (v) { waiters.forEach(function (w) { w(v); }); };
        s.patchSettings(body).then(done, function () { done(null); });
      }, PATCH_DEBOUNCE_MS);
    });
  }
  function loadBindings(defaults) {
    var copy = function () { var o = {}; Object.keys(defaults || {}).forEach(function (k) { o[k] = defaults[k].slice(); }); return o; };
    var s = sdk();
    if (!s || !state.hosted) return Promise.resolve(copy());
    return s.loadBindings(defaults).catch(copy);
  }
  function canSignIn() { var s = sdk(); return !!(s && s.canSignIn()); }
  function signIn() { var s = sdk(); return !!(s && s.signIn()); }
  function inviteLink() { var s = sdk(); return s && state.hosted ? s.inviteLink() : null; }

  function syncTime() {
    if (!state.hosted) { state.timeSynced = false; return Promise.resolve(false); }
    var t0 = Date.now();
    return api('/time').then(function (body) {
      var t1 = Date.now();
      var rtt = t1 - t0;
      state.timeOffsetMs = (body.now + rtt / 2) - t1;
      state.timeSynced = true;
      return true;
    }).catch(function () { state.timeSynced = false; return false; });
  }
  function now() { return Date.now() + (state.timeSynced ? state.timeOffsetMs : 0); }
  function nowDate() { return new Date(now()); }

  // Daily boundary synced to platform time (UTC day of the adjusted clock).
  function dailyDate() { return nowDate(); }
  function msUntilNextDaily() {
    var d = nowDate();
    var next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    return Math.max(0, next - now());
  }

  // -------------------------------------------------------- activity/social ---
  // No per-game presence/activity endpoints exist for launch tokens (wiki);
  // these are inert no-ops — calling them would only surface console errors.
  function activityStart() { /* no hosted endpoint */ }
  function activityEnd() { /* no hosted endpoint */ }

  // ------------------------------------------------- scores (own backend) ---
  var LOCAL_BOARD_KEY = 'deepworks.boards.v1';

  // Signed in: post a finished run's score (whole credits) to the platform
  // high-score board through score-script.js. Resolves { posted, rank }.
  function postHighScore(credits) {
    var s = sdk();
    if (!s || !state.hosted) return Promise.resolve({ posted: false, rank: null });
    return s.submitScores({ 'high-score': credits }).then(function (keys) {
      if (keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      return s.leaderboard('high-score', { pageSize: 100 }).then(function (r) {
        var me = (r.items || []).filter(function (i) { return i.userId === s.userId; })[0];
        return { posted: true, rank: me ? me.rank : null };
      }, function () { return { posted: true, rank: null }; });
    }, function () { return { posted: false, rank: null }; });
  }

  // Signed in: the platform high-score board (scores in whole credits,
  // returned as milli-credits like the local board), names from profiles.
  function platformBoard() {
    var s = sdk();
    return s.leaderboard('high-score', { pageSize: 25 }).then(function (r) {
      var items = r.items || [];
      return Promise.all(items.map(function (i) {
        return profileFor(i.userId).catch(function () { return 'Player ' + String(i.userId).slice(0, 6); });
      })).then(function (names) {
        return { entries: items.map(function (i, k) { return { name: names[k], score: i.score * 1000, rank: i.rank, me: i.userId === s.userId }; }) };
      });
    }).catch(function () { return { entries: [] }; });
  }

  function submitScore(board, entry) {
    // Local casual board only (offline); signed-in runs use postHighScore.
    if (state.hosted) return Promise.resolve({ ok: false, local: false });
    try {
      var boards = JSON.parse(localStorage.getItem(LOCAL_BOARD_KEY) || '{}');
      boards[board] = boards[board] || [];
      // callers send the ranked payload shape ({scoreTotal}); accept either
      var score = (typeof entry.score === 'number') ? entry.score : entry.scoreTotal;
      boards[board].push({
        name: entry.name || state.profile.displayName, score: score,
        durationSec: entry.durationSec, when: Date.now(), casual: true
      });
      boards[board].sort(function (a, b) { return b.score - a.score; });
      boards[board] = boards[board].slice(0, 50);
      localStorage.setItem(LOCAL_BOARD_KEY, JSON.stringify(boards));
      return Promise.resolve({ ok: true, local: true });
    } catch (e) { return Promise.resolve({ ok: false, error: 'storage' }); }
  }

  function getBoard(board) {
    if (state.hosted) return platformBoard();
    try {
      var boards = JSON.parse(localStorage.getItem(LOCAL_BOARD_KEY) || '{}');
      return Promise.resolve({ entries: boards[board] || [], casual: true });
    } catch (e) { return Promise.resolve({ entries: [], casual: true }); }
  }

  // Achievements stay local: the old POST /achievements/{key} route never
  // existed server-side and is gone. Unlock bookkeeping lives in the profile.
  function unlockAchievement(key) {
    if (!/^[a-z0-9_]+$/.test(key)) return Promise.resolve({ ok: false });
    return Promise.resolve({ ok: true, local: true });
  }

  // ------------------------------------------------------------- telemetry ---
  // Consent-gated funnel events stay in a local buffer; no client telemetry
  // endpoint exists for launch tokens (wiki), so nothing is transmitted.
  var TELEMETRY_KEY = 'deepworks.telemetry.v1';
  function setConsent(v) { state.consent.telemetry = !!v; }
  function track(event, data) {
    if (!state.consent.telemetry) return;
    var allowed = { start: 1, tutorial_step: 1, round_end: 1, retry: 1, settings_change: 1, error: 1 };
    if (!allowed[event]) return;
    var payload = { e: event, d: data || {}, t: Math.floor(now() / 1000), s: sessionId() };
    try {
      var buf = JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]');
      buf.push(payload);
      if (buf.length > 200) buf = buf.slice(-200);
      localStorage.setItem(TELEMETRY_KEY, JSON.stringify(buf));
    } catch (e) {}
  }
  var _sid = null;
  function sessionId() {
    if (!_sid) _sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return _sid;
  }

  root.DWPlatform = {
    init: init,
    state: state,
    syncTime: syncTime,
    now: now,
    nowDate: nowDate,
    dailyDate: dailyDate,
    msUntilNextDaily: msUntilNextDaily,
    activityStart: activityStart,
    activityEnd: activityEnd,
    submitScore: submitScore,
    postHighScore: postHighScore,
    getBoard: getBoard,
    unlockAchievement: unlockAchievement,
    fetchProfile: fetchProfile,
    profileFor: profileFor,
    refreshToken: refreshToken,
    loadCloud: loadCloud,
    onSave: onSave,
    flushSave: flushSave,
    onSync: onSync,
    onAuth: onAuth,
    getSettings: getSettings,
    patchSettings: patchSettings,
    loadBindings: loadBindings,
    canSignIn: canSignIn,
    signIn: signIn,
    inviteLink: inviteLink,
    setConsent: setConsent,
    track: track
  };
})(typeof self !== 'undefined' ? self : this);
