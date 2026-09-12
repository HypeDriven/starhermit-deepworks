/**
 * Deepworks — platform module (StarHermit integration, spec §6).
 *
 * Hosted contract (wiki): the platform opens the game as
 * index.html#game_token=<jwt> (optional &session_id=), stripped after the
 * read. The JWT carries sub = user id and game_scope = this game's slug —
 * never hard-coded. Same-origin /api calls send Authorization: Bearer; the
 * token re-mints every 45 min via POST /api/v1/games/{slug}/launch-token.
 * The display name is the profile nickname from GET /api/v1/users/{sub}/profile
 * — never a JWT name claim, never /api/v1/me, never usernames. Cloud save is
 * ONE zip+base64 slot at GET/PUT /api/v1/me/cloud-saves/{slug} for the
 * checksummed profile document (remote wins on boot; debounced saves with a
 * pagehide flush). The own-server score boards (/scores/*) are its backend
 * (declared server=server.js) with graceful offline fallback. Achievements
 * stay local — the old POST /achievements/{key} route never existed server-
 * side and is gone. Presence/activity/telemetry have no launch-token
 * endpoints (wiki) and are inert. Standalone: everything degrades to local
 * offline mode. Tokens are never persisted to storage.
 */
(function (root) {
  'use strict';

  var REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
  var RETRY_MS = 60 * 1000;
  var SAVE_DEBOUNCE_MS = 2000;

  var state = {
    hosted: false,
    launchToken: null,
    userId: null,          // JWT sub
    scope: null,           // JWT game_scope — never hard-coded
    timeOffsetMs: 0,       // serverNow = Date.now() + offset
    timeSynced: false,
    online: true,
    consent: { telemetry: false },
    profile: { displayName: 'Guest Prospector', avatar: null, guest: true },
    sync: 'offline',       // offline | saving | synced (cloud mirror)
    refreshTimer: null,
    retryTimer: null,
    saveTimer: null,
    pendingSave: null,
    profileNames: {},
    syncListeners: []
  };

  // Fragment first (platform contract); query forms are local-dev only.
  function readLaunchToken() {
    try {
      var h = new URLSearchParams(String(root.location.hash || '').replace(/^#/, ''));
      var t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        var rest = h.toString();
        root.history.replaceState(null, '',
          root.location.pathname + root.location.search + (rest ? '#' + rest : ''));
        return t;
      }
      var q = new URLSearchParams(root.location.search);
      return q.get('game_token') || q.get('launch') || q.get('token') || null;
    } catch (e) { return null; }
  }

  function decodeJwt(token) {
    try {
      var seg = String(token).split('.')[1]; // the PAYLOAD segment (index 1)
      if (!seg) return null;
      var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }

  function setSync(s) {
    if (state.sync === s) return;
    state.sync = s;
    for (var i = 0; i < state.syncListeners.length; i++) {
      try { state.syncListeners[i](s); } catch (e) { /* listener errors never break */ }
    }
  }

  // Minimal ZIP writer/reader (stored entries only, no compression).
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(name, dataBytes) {
    var enc = new TextEncoder();
    var nameB = enc.encode(name);
    var crc = crc32(dataBytes);
    var out = [];
    var u16 = function (v) { out.push(v & 0xff, (v >> 8) & 0xff); };
    var u32 = function (v) { out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(crc); u32(dataBytes.length); u32(dataBytes.length);
    u16(nameB.length); u16(0);
    var head = new Uint8Array(out);
    var cd = [];
    var c16 = function (v) { cd.push(v & 0xff, (v >> 8) & 0xff); };
    var c32 = function (v) { cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
    c32(crc); c32(dataBytes.length); c32(dataBytes.length);
    c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
    var cdHead = new Uint8Array(cd);
    var cdOff = head.length + nameB.length + dataBytes.length;
    var parts = [head, nameB, dataBytes, cdHead, nameB];
    var eocd = [];
    var e32 = function (v) { eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); };
    var e16 = function (v) { eocd.push(v & 0xff, (v >> 8) & 0xff); };
    e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
    e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
    parts.push(new Uint8Array(eocd));
    var total = 0, o = 0;
    for (var pi = 0; pi < parts.length; pi++) total += parts[pi].length;
    var buf = new Uint8Array(total);
    for (var pj = 0; pj < parts.length; pj++) { buf.set(parts[pj], o); o += parts[pj].length; }
    return buf;
  }
  function unzipFirstEntry(zipBytes) {
    var dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    var off = 0;
    while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
      var method = dv.getUint16(off + 8, true);
      var size = dv.getUint32(off + 18, true);
      var nameLen = dv.getUint16(off + 26, true);
      var extraLen = dv.getUint16(off + 28, true);
      var dataOff = off + 30 + nameLen + extraLen;
      if (method !== 0) throw new Error('unsupported zip entry');
      return zipBytes.slice(dataOff, dataOff + size);
    }
    throw new Error('bad zip');
  }
  function bytesToBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function init() {
    state.launchToken = readLaunchToken();
    if (state.launchToken) {
      var claims = decodeJwt(state.launchToken);
      if (!claims) state.launchToken = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) state.userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) state.scope = claims.game_scope;
        if (!state.userId || !state.scope) state.launchToken = null; // unusable token
      }
    }
    state.hosted = !!state.launchToken;
    if (state.hosted) {
      state.refreshTimer = setInterval(refreshToken, REFRESH_MS);
      try {
        root.addEventListener('pagehide', flushSave);
        root.document.addEventListener('visibilitychange', function () { if (root.document.hidden) flushSave(); });
      } catch (e) { /* no window events available */ }
      fetchProfile().catch(function () {});
    }
    root.addEventListener('online', function () { state.online = true; });
    root.addEventListener('offline', function () { state.online = false; });
    return state;
  }

  // Token refresh: scoped tokens may re-mint via the game's launch-token
  // route. Retry a failed re-mint after ~60 s.
  function refreshToken() {
    if (!state.launchToken || !state.scope) return Promise.resolve(false);
    return fetch('/api/v1/games/' + encodeURIComponent(state.scope) + '/launch-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.launchToken }, body: '{}'
    }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (j) {
      if (j && typeof j.token === 'string' && j.token) {
        state.launchToken = j.token; // memory only
        var claims = decodeJwt(state.launchToken);
        if (claims && claims.sub) state.userId = claims.sub;
        if (claims && claims.game_scope) state.scope = claims.game_scope;
        return true;
      }
      retryRefresh();
      return false;
    }).catch(function () { retryRefresh(); return false; });
  }
  function retryRefresh() {
    if (state.retryTimer || !state.launchToken) return;
    state.retryTimer = setTimeout(function () { state.retryTimer = null; refreshToken(); }, RETRY_MS);
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

  // Display name: the profile nickname is the only profile read a game-scoped
  // token may make. Never a JWT name claim, never /api/v1/me, never usernames.
  function profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    if (state.profileNames[userId]) return state.profileNames[userId];
    var p = fetch('/api/v1/users/' + encodeURIComponent(userId) + '/profile', {
      headers: state.launchToken ? { Authorization: 'Bearer ' + state.launchToken } : {}
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var n = j && typeof j.nickname === 'string' && j.nickname ? j.nickname : null;
        return n || ('Player ' + userId.slice(0, 8));
      })
      .catch(function () { return 'Player ' + userId.slice(0, 8); });
    state.profileNames[userId] = p;
    return p;
  }
  function fetchProfile() {
    if (!state.userId) return Promise.resolve(null);
    return profileFor(state.userId).then(function (n) {
      state.profile.displayName = n.slice(0, 40);
      state.profile.guest = false;
      return state.profile;
    });
  }

  /* Cloud save: ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug} holding
   * the wrapped profile document string. Remote wins on boot (validated by
   * DWSession.loadProfileRaw); saves debounce ~2 s and flush on pagehide/
   * hidden with keepalive; localStorage stays the offline cache. */
  function loadCloud() {
    if (!state.hosted || !state.scope) return Promise.resolve(null);
    return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(state.scope), {
      headers: state.launchToken ? { Authorization: 'Bearer ' + state.launchToken } : {}
    }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('http-' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      if (!buf || !buf.byteLength) return null;
      return new TextDecoder().decode(unzipFirstEntry(new Uint8Array(buf)));
    }).catch(function () { return null; });
  }
  function onSave(wrapped) {
    if (!state.hosted || !state.scope) return;
    state.pendingSave = wrapped;
    setSync('saving');
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  function flushSave() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (!state.hosted || !state.scope || state.pendingSave == null) return Promise.resolve(false);
    var wrapped = state.pendingSave;
    state.pendingSave = null;
    var body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(wrapped))) };
    } catch (e) { return Promise.resolve(false); }
    return fetch('/api/v1/me/cloud-saves/' + encodeURIComponent(state.scope), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.launchToken },
      body: JSON.stringify(body),
      keepalive: true
    }).then(function (res) {
      if (res.ok) { setSync('synced'); return true; }
      state.pendingSave = state.pendingSave == null ? wrapped : state.pendingSave;
      setSync('offline');
      return false;
    }).catch(function () {
      state.pendingSave = state.pendingSave == null ? wrapped : state.pendingSave;
      setSync('offline');
      return false;
    });
  }
  function onSync(fn) { if (typeof fn === 'function') state.syncListeners.push(fn); }

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
  // No per-game presence/activity endpoints exist for launch tokens (wiki);
  // these are inert no-ops — calling them would only surface console errors.
  function activityStart() { /* no hosted endpoint */ }
  function activityEnd() { /* no hosted endpoint */ }

  // ------------------------------------------------- scores (own backend) ---
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
    getBoard: getBoard,
    unlockAchievement: unlockAchievement,
    fetchProfile: fetchProfile,
    profileFor: profileFor,
    refreshToken: refreshToken,
    loadCloud: loadCloud,
    onSave: onSave,
    flushSave: flushSave,
    onSync: onSync,
    setConsent: setConsent,
    track: track
  };
})(typeof self !== 'undefined' ? self : this);
