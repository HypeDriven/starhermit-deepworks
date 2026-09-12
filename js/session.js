/**
 * Deepworks — session module.
 * Owns runs: command dispatch with idempotent command ids, fixed-step
 * advance, input log (replay envelope), undo (practice), autosave,
 * capped away simulation with a "while you were away" summary.
 *
 * No module mutates rules state except through here (spec §5).
 * UMD: exposes `DWSession` in the browser, module.exports in Node.
 */
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var R = isNode ? require('./rules.js') : root.DWRules;
  if (isNode) module.exports = factory(R);
  else root.DWSession = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var RUN_SAVE_KEY = 'deepworks.run.v1';
  var PROFILE_KEY = 'deepworks.profile.v1';
  var cmdCounter = 0;

  function newCmdId(runId) {
    cmdCounter++;
    return runId + '-' + cmdCounter.toString(36) + '-' + Date.now().toString(36);
  }
  function newRunId(seed) {
    return 'r' + (seed >>> 0).toString(36) + Date.now().toString(36);
  }

  // ------------------------------------------------------------- run open ---
  // content: a DWContent entry. mode: 'learn'|'journey'|'daily'|'practice'|'challenge'
  function createRun(content, mode, opts) {
    opts = opts || {};
    var state = (opts.buildState || defaultBuild)(content);
    var run = {
      id: newRunId(content.seed),
      mode: mode,
      contentId: content.id,
      contentVersion: content.version || 1,
      seed: content.seed,
      state: state,
      log: [],                 // ordered commands (advance steps coalesced)
      pendingAdvanceMs: 0,     // accumulated sim time not yet flushed to log
      undoStack: [],           // practice only: serialized prior states
      hashes: [],              // periodic state hashes for replay validation
      startedAt: Date.now(),
      lastSavedAt: Date.now(),
      closed: false,
      result: null
    };
    return run;
  }
  function defaultBuild(content) {
    // browser: DWContent global; node: injected via opts.buildState
    if (typeof DWContent !== 'undefined') return DWContent.buildState(content);
    throw new Error('createRun needs opts.buildState in Node');
  }

  // ----------------------------------------------------------- time advance ---
  // Called from the rAF loop with real elapsed ms; quantized to fixed steps.
  function tick(run, elapsedMs) {
    if (run.closed || run.state.terminal) return [];
    var ms = Math.floor(elapsedMs);
    if (ms <= 0) return [];
    run.pendingAdvanceMs += ms;
    var events = R.advance(run.state, ms);
    for (var i = 0; i < events.length; i++) {
      if (events[i].type === 'terminal') run.pendingAdvanceMs = 0;
    }
    if (run.pendingAdvanceMs >= 5000 || run.state.terminal) flushAdvance(run);
    if (run.state.terminal) finalize(run);
    return events;
  }
  function flushAdvance(run) {
    if (run.pendingAdvanceMs > 0) {
      run.log.push({ id: newCmdId(run.id), type: 'advance', ms: run.pendingAdvanceMs });
      run.pendingAdvanceMs = 0;
      if (run.log.length % 20 === 0) run.hashes.push({ n: run.log.length, hash: R.hashState(run.state) });
    }
  }

  // ------------------------------------------------------------ dispatch ---
  // Player command entry point. Validates via rules, dedupes by command id,
  // records undo snapshot (practice), appends to the replay log.
  function dispatch(run, cmd) {
    if (run.closed) return { ok: false, reason: 'run-closed' };
    if (!cmd.id) cmd.id = newCmdId(run.id);
    for (var i = run.log.length - 1; i >= 0 && i >= run.log.length - 50; i--) {
      if (run.log[i].id === cmd.id) return { ok: true, reason: 'duplicate', deduped: true, events: [] };
    }
    flushAdvance(run);
    var check = R.can(run.state, cmd);
    if (check.ok && run.mode === 'practice') {
      run.undoStack.push(R.serialize(run.state));
      if (run.undoStack.length > 50) run.undoStack.shift();
    }
    var res = R.applyCommand(run.state, cmd);
    run.log.push(cmd); // valid and invalid alike: invalid attempts affect state
    if (run.state.terminal) finalize(run);
    return res;
  }

  function canUndo(run) { return run.mode === 'practice' && run.undoStack.length > 0; }
  function undo(run) {
    if (!canUndo(run)) return { ok: false, reason: 'nothing-to-undo' };
    run.state = R.deserialize(run.undoStack.pop());
    run.log.push({ id: newCmdId(run.id), type: 'undo_marker' });
    return { ok: true };
  }

  // ------------------------------------------------------------- finalize ---
  function finalize(run) {
    if (run.closed) return;
    flushAdvance(run);
    run.hashes.push({ n: run.log.length, hash: R.hashState(run.state) });
    run.result = {
      terminal: run.state.terminal,
      score: R.score(run.state),
      tick: run.state.tick,
      moves: run.state.stats.playerCommands,
      invalid: run.state.stats.invalidActions,
      finalHash: R.hashState(run.state)
    };
    run.closed = true;
  }

  // --------------------------------------------------------------- replay ---
  // Rebuild terminal state from the envelope. Used by tests and server-side
  // validation (spec §5, §6).
  function replay(content, log, opts) {
    var build = (opts && opts.buildState) || defaultBuild;
    var state = build(content);
    for (var i = 0; i < log.length; i++) {
      var cmd = log[i];
      if (cmd.type === 'advance') { R.advance(state, cmd.ms); continue; }
      if (cmd.type === 'undo_marker') return { ok: false, reason: 'replay-with-undo-unsupported' };
      // apply unconditionally: invalid attempts are deterministic no-ops that
      // still advance the invalid-action counter, so replay stays faithful.
      R.applyCommand(state, cmd);
    }
    return { ok: true, state: state, hash: R.hashState(state), score: R.score(state) };
  }

  function envelope(run) {
    return {
      schema: 1,
      contentVersion: run.contentVersion,
      contentId: run.contentId,
      mode: run.mode,
      seed: run.seed,
      startedAt: run.startedAt,
      initialHash: null,
      log: run.log,
      hashes: run.hashes,
      result: run.result
    };
  }

  // ---------------------------------------------------------- persistence ---
  function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; }
    catch (e) { return null; }
  }
  function checksum(str) {
    return R.hashString(str).toString(36);
  }

  function saveRun(run) {
    var st = storage();
    if (!st) return false;
    try {
    var payload = JSON.stringify({
      v: 1, runId: run.id, mode: run.mode, contentId: run.contentId,
      contentVersion: run.contentVersion, seed: run.seed,
      state: R.serialize(run.state), log: run.log,
      savedAt: Date.now()
    });
    st.setItem(RUN_SAVE_KEY, JSON.stringify({ sum: checksum(payload), payload: payload }));
    run.lastSavedAt = Date.now();
    return true;
    } catch (e) {
      // quota/security errors: persistence unavailable, not a thrown crash
      return false;
    }
  }
  function loadSavedRun() {
    var st = storage();
    if (!st) return null;
    var raw = st.getItem(RUN_SAVE_KEY);
    if (!raw) return null;
    try {
      var wrap = JSON.parse(raw);
      if (checksum(wrap.payload) !== wrap.sum) return null;
      var data = JSON.parse(wrap.payload);
      if (data.v !== 1) return null;
      return data;
    } catch (e) { return null; }
  }
  function clearSavedRun() {
    var st = storage();
    if (!st) return;
    try { st.removeItem(RUN_SAVE_KEY); } catch (e) { /* persistence unavailable */ }
  }

  // Resume a saved endless run with capped away simulation.
  // Returns {state, away:{seconds, earned, capped}} or null.
  function resumeRun(data, awayCapSec) {
    var state;
    try { state = R.deserialize(data.state); } catch (e) { return null; }
    var elapsedSec = Math.max(0, Math.floor((Date.now() - data.savedAt) / 1000));
    var cap = awayCapSec || state.ruleset.awayCapSec || 28800;
    var simSec = Math.min(elapsedSec, cap);
    var earnedBefore = state.lifetimeEarned;
    if (simSec > 5 && !state.terminal) {
      // away sim: no flare claims possible; advance in 1s chunks
      var remaining = simSec * 1000;
      while (remaining > 0) {
        var chunk = Math.min(remaining, 60000);
        R.advance(state, chunk);
        remaining -= chunk;
      }
    }
    return {
      state: state,
      away: {
        seconds: simSec,
        capped: elapsedSec > cap,
        earned: state.lifetimeEarned - earnedBefore
      },
      meta: data
    };
  }

  // ------------------------------------------------------------ profile ---
  function defaultProfile() {
    return {
      v: 1,
      playerId: 'p' + String(Math.floor(Math.random() * 0xffffffff)).padStart(10, '0') +
        String(Date.now() % 1000).padStart(3, '0'),
      displayName: 'Guest Prospector',
      journey: {},             // stageId -> {stars, bestTick, bestScore}
      lessons: {},             // lessonId -> true
      daily: {},               // key -> {score, won}
      practice: {},            // difficulty -> best score
      challenges: {},          // id -> best score
      achievements: {},        // key -> unlockedAt
      mastery: { xp: 0, level: 1 },
      stats: { runsPlayed: 0, totalEarned: 0, flaresClaimed: 0, playtimeSec: 0 },
      settings: null           // owned by ui module; stored here for durability
    };
  }
  function loadProfile() {
    var st = storage();
    if (!st) return defaultProfile();
    var raw = st.getItem(PROFILE_KEY);
    if (!raw) return defaultProfile();
    return parseProfileWrapped(raw) || defaultProfile();
  }
  // Validates a wrapped profile document (local cache or cloud slot); null on
  // bad shape or checksum. Remote-preferred cloud loads go through here.
  function parseProfileWrapped(raw) {
    var st = storage();
    if (!st) return null;
    try {
      var wrap = JSON.parse(raw);
      if (checksum(wrap.payload) !== wrap.sum) return null;
      var p = JSON.parse(wrap.payload);
      if (p.v !== 1) return null;
      var d = defaultProfile();
      for (var k in d) if (p[k] === undefined) p[k] = d[k];
      return p;
    } catch (e) { return null; }
  }
  function saveProfile(profile) {
    var st = storage();
    if (!st) return false;
    try {
      var payload = JSON.stringify(profile);
      var wrapped = JSON.stringify({ sum: checksum(payload), payload: payload });
      st.setItem(PROFILE_KEY, wrapped);
      if (root.DWPlatform && typeof root.DWPlatform.onSave === 'function')
        root.DWPlatform.onSave(wrapped); // mirror to the cloud slot
      return true;
    } catch (e) {
      // quota/security errors: persistence unavailable, not a thrown crash
      return false;
    }
  }

  // Journey stars: 3 = at/under par, 2 = under 1.5x par, 1 = completion.
  function starsFor(content, tick) {
    if (!content.parSec) return 1;
    if (tick <= content.parSec) return 3;
    if (tick <= content.parSec * 1.5) return 2;
    return 1;
  }

  // Mastery track: xp from completed runs; level thresholds are transparent.
  function masteryXpFor(result) {
    var xp = 10;
    if (result.terminal && result.terminal.won) xp += 15;
    xp += Math.min(25, Math.floor(result.score.total / (5000 * 1000))); // 1 xp per 5k credits, capped
    return xp;
  }
  function masteryLevelFor(xp) {
    var level = 1, need = 50, total = 0;
    while (xp >= total + need && level < 50) { total += need; level++; need = Math.floor(need * 1.25); }
    return { level: level, into: xp - total, next: need };
  }

  return {
    createRun: createRun,
    tick: tick,
    flush: flushAdvance,
    dispatch: dispatch,
    canUndo: canUndo,
    undo: undo,
    finalize: finalize,
    replay: replay,
    envelope: envelope,
    saveRun: saveRun,
    loadSavedRun: loadSavedRun,
    clearSavedRun: clearSavedRun,
    resumeRun: resumeRun,
    defaultProfile: defaultProfile,
    loadProfile: loadProfile, loadProfileRaw: parseProfileWrapped,
    saveProfile: saveProfile,
    starsFor: starsFor,
    masteryXpFor: masteryXpFor,
    masteryLevelFor: masteryLevelFor,
    RUN_SAVE_KEY: RUN_SAVE_KEY,
    PROFILE_KEY: PROFILE_KEY
  };
});
