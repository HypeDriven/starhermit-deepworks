/**
 * Deepworks — platform module (StarHermit integration, spec §6).
 *
 * When hosted: reads the short-lived launch token from the URL, syncs clock
 * against same-origin /api/v1/time with round-trip adjustment, submits
 * scores/achievements, sends presence heartbeats and activity start/end.
 * When standalone (file:// or plain static host): everything degrades to a
 * local offline mode. Tokens are never persisted to storage.
 */
(function (root) {
  'use strict';

  var state = {
    hosted: false,
    launchToken: null,
    scope: null,          // game scope from launch token (never hard-coded)
    timeOffsetMs: 0,      // serverNow = Date.now() + offset
    timeSynced: false,
    online: true,
    activityStarted: false,
    consent: { telemetry: false },
    profile: { displayName: 'Guest Prospector', avatar: null, guest: true },
    heartbeatTimer: null
  };

  function init() {
    // launch token: ?launch=... (short-lived, single-use, never stored)
    try {
      var q = new URLSearchParams(root.location.search);
      state.launchToken = q.get('launch') || q.get('token') || null;
    } catch (e) { state.launchToken = null; }
    state.hosted = !!state.launchToken && root.location.protocol.indexOf('http') === 0;
    if (state.launchToken) {
      // token shape: base64url JSON payload before first '.' (unsigned claims
      // are display-only; the server remains authoritative)
      try {
        var payload = state.launchToken.split('.')[0];
        var json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
        state.scope = json.scope || null;
        if (json.name) { state.profile.displayName = json.name; state.profile.guest = false; }
        if (json.avatar) state.profile.avatar = json.avatar;
      } catch (e) { /* malformed token: stay in guest mode */ }
    }
    root.addEventListener('online', function () { state.online = true; });
    root.addEventListener('offline', function () { state.online = false; });
    return state;
  }

  // Same-origin API with token; structured errors are recoverable (spec §6).
  function api(path, opts) {
    if (!state.hosted) return Promise.reject(new Error('not-hosted'));
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.launchToken) opts.headers['Authorization'] = 'Bearer ' + state.launchToken;
    return fetch('/api/v1' + path, opts).then(function (res) {
      if (res.status === 429) {
        var err = new Error('rate-limited'); err.recoverable = true; err.status = 429;
        throw err;
      }
      return res.json().then(function (body) {
        if (body && body.error) {
          var e2 = new Error(body.error); e2.recoverable = true; e2.status = res.status;
          throw e2;
        }
        return body;
      });
    });
  }

  // Round-trip-adjusted server time sync (spec §6).
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
  function activityStart() {
    if (!state.hosted || state.activityStarted) return;
    state.activityStarted = true;
    api('/activity/start', { method: 'POST', body: '{}' }).catch(function () {});
    startHeartbeat();
  }
  function activityEnd() {
    if (!state.hosted || !state.activityStarted) return;
    state.activityStarted = false;
    api('/activity/end', { method: 'POST', body: '{}' }).catch(function () {});
    stopHeartbeat();
  }
  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatTimer = setInterval(function () {
      if (document.visibilityState === 'visible') {
        api('/presence/heartbeat', { method: 'POST', body: '{}' }).catch(function () {});
      }
    }, 60000);
  }
  function stopHeartbeat() {
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
  }

  // ------------------------------------------------- scores / achievements ---
  var LOCAL_BOARD_KEY = 'deepworks.boards.v1';

  function submitScore(board, entry) {
    // entry: {score, ruleset, contentVersion, seed, assists, durationSec, envelope?}
    if (state.hosted) {
      return api('/scores/' + encodeURIComponent(board), {
        method: 'POST', body: JSON.stringify(entry)
      }).catch(function (e) { return { ok: false, error: e.message, local: true }; });
    }
    // offline: local board, labelled casual (no authoritative validation)
    try {
      var boards = JSON.parse(localStorage.getItem(LOCAL_BOARD_KEY) || '{}');
      boards[board] = boards[board] || [];
      boards[board].push({
        name: state.profile.displayName, score: entry.score,
        durationSec: entry.durationSec, when: Date.now(), casual: true
      });
      boards[board].sort(function (a, b) { return b.score - a.score; });
      boards[board] = boards[board].slice(0, 50);
      localStorage.setItem(LOCAL_BOARD_KEY, JSON.stringify(boards));
      return Promise.resolve({ ok: true, local: true });
    } catch (e) { return Promise.resolve({ ok: false, error: 'storage' }); }
  }

  function getBoard(board, friendsOnly) {
    if (state.hosted) {
      return api('/scores/' + encodeURIComponent(board) + (friendsOnly ? '?friends=1' : ''))
        .catch(function () { return { entries: [], casual: true }; });
    }
    try {
      var boards = JSON.parse(localStorage.getItem(LOCAL_BOARD_KEY) || '{}');
      return Promise.resolve({ entries: boards[board] || [], casual: true });
    } catch (e) { return Promise.resolve({ entries: [], casual: true }); }
  }

  function unlockAchievement(key) {
    if (!/^[a-z0-9_]+$/.test(key)) return Promise.resolve({ ok: false });
    if (state.hosted) {
      return api('/achievements/' + key, { method: 'POST', body: '{}' })
        .catch(function () { return { ok: false }; });
    }
    return Promise.resolve({ ok: true, local: true });
  }

  // ------------------------------------------------------------- telemetry ---
  // Anonymous funnel events only: start, tutorial step, round end, retry,
  // settings change, error category (spec §6, §8). Consent-gated.
  var TELEMETRY_KEY = 'deepworks.telemetry.v1';
  function setConsent(v) { state.consent.telemetry = !!v; }
  function track(event, data) {
    if (!state.consent.telemetry) return;
    var allowed = { start: 1, tutorial_step: 1, round_end: 1, retry: 1, settings_change: 1, error: 1 };
    if (!allowed[event]) return;
    var payload = { e: event, d: data || {}, t: Math.floor(now() / 1000), s: sessionId() };
    if (state.hosted) {
      api('/telemetry', { method: 'POST', body: JSON.stringify(payload) }).catch(function () {});
    } else {
      try {
        var buf = JSON.parse(localStorage.getItem(TELEMETRY_KEY) || '[]');
        buf.push(payload);
        if (buf.length > 200) buf = buf.slice(-200);
        localStorage.setItem(TELEMETRY_KEY, JSON.stringify(buf));
      } catch (e) {}
    }
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
    getBoard: getBoard,
    unlockAchievement: unlockAchievement,
    setConsent: setConsent,
    track: track
  };
})(typeof self !== 'undefined' ? self : this);
