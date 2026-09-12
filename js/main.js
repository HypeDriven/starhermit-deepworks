/**
 * Deepworks — bootstrap + game controller.
 * Owns the state machine (boot → title → modes → preparing → countdown →
 * active ↔ paused → results → progression), the frame loop, input mapping
 * (pointer/keyboard/gamepad), persistence glue, achievements, and the
 * renderer/audio/UI wiring. Simulation state lives only in the session run.
 */
(function () {
  'use strict';
  var R = DWRules, C = DWContent, S = DWSession, P = DWPlatform, A = DWAudio, UI = DWUI;

  // ------------------------------------------------------------ app state ---
  var app = {
    screen: 'boot',
    run: null,
    mode: null,
    content: null,
    lesson: null, lessonStepIdx: 0,
    selectedLayer: null,
    paused: false,
    countdownEnd: 0,
    profile: null,
    settings: null,
    renderer: null,
    savedRun: null,
    lastFrame: 0,
    hudAccum: 0,
    saveAccum: 0,
    coinSoundAccum: 0,
    lastCoinBucket: 0,
    webgl: true,
    awayInfo: null,
    blockedMask: 0,        // bit per layer currently at the blocked threshold
    blockedSoundAt: 0      // last bin_blocked cue time (rate-limited)
  };

  var DEFAULT_SETTINGS = {
    volMusic: 0.5, volEffects: 0.8, volAmbience: 0.4, volVoice: 0.6, muted: false,
    captions: true, quality: 'high', theme: 'emberdeep', reducedMotion: false,
    cameraSway: true, holdRepeat: false, leftHanded: false, haptics: true,
    highContrast: false, largeText: false, palette: 'default', timingAssist: false,
    telemetry: false,
    keys: { assign: 'Enter', unassign: 'U', hire: 'H', shaft: 'Q', liftCap: 'W', liftSpeed: 'E', unlock: 'D', flare: 'F', foreman: 'G', undo: 'Z' },
    pad: { confirm: 0, cancel: 1, pause: 9, up: 12, down: 13 }
  };

  // ------------------------------------------------------------------ boot ---
  function boot() {
    P.init();
    app.profile = S.loadProfile();
    app.settings = Object.assign({}, DEFAULT_SETTINGS, app.profile.settings || {});
    app.profile.settings = app.settings;
    applySettings();

    // Hosted: the account nickname replaces the guest name and the remote
    // save wins over the local cache before anything renders.
    if (P.state.hosted) {
      P.fetchProfile().then(function () {
        app.profile.displayName = P.state.profile.displayName;
        S.saveProfile(app.profile);
        UI.refreshIdentity && UI.refreshIdentity();
      }).catch(function () {});
      P.onSync(function () { UI.refreshIdentity && UI.refreshIdentity(); });
      P.loadCloud().then(function (remoteRaw) {
        var remote = remoteRaw ? S.loadProfileRaw(remoteRaw) : null;
        if (remote) {
          app.profile = remote;
          app.settings = Object.assign({}, DEFAULT_SETTINGS, remote.settings || {});
          app.profile.settings = app.settings;
          S.saveProfile(app.profile); // local cache mirrors the remote doc
          applySettings();
        }
        UI.refreshIdentity && UI.refreshIdentity();
      }).catch(function () {});
    }

    UI.init(handlers);
    UI.setBootProgress(0.2, 'Checking the cage…');

    // renderer (optional; game remains fully playable via DOM)
    try {
      app.renderer = DWRender.create(document.getElementById('scene-host'), {
        onSelect: onLayerPicked,
        theme: currentTheme(),
        reducedMotion: app.settings.reducedMotion,
        quality: app.settings.quality
      });
    } catch (e) { app.renderer = null; }
    if (!app.renderer) {
      app.webgl = false;
      UI.toast('3D unavailable — playing with the simplified board. Progress is preserved.', 'err');
      buildFallbackBoard();
    }
    UI.setBootProgress(0.55, 'Charting seams…');

    // saved endless run?
    app.savedRun = S.loadSavedRun();

    P.syncTime().finally(function () {
      UI.setBootProgress(0.9, 'Lighting the lamps…');
      bindInput();
      bindLifecycle();
      setTimeout(function () {
        UI.setBootProgress(1, 'Ready.');
        UI.show('title');
        P.track('start', { hosted: P.state.hosted });
      }, 250);
    });

    requestAnimationFrame(frame);
  }

  function currentTheme() { return C.themeById(app.settings.theme); }

  // DOM fallback board when WebGL is missing (spec §5: compatibility path).
  function buildFallbackBoard() {
    var host = document.getElementById('scene-host');
    host.innerHTML = '';
    var board = document.createElement('div');
    board.id = 'fallback-board';
    board.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:6px;padding:80px 12px;';
    // key art stands in for the 3D mine (decorative; buttons stay on top)
    host.style.backgroundImage = 'url(assets/key-art.webp)';
    host.style.backgroundSize = 'cover';
    host.style.backgroundPosition = 'center';
    host.appendChild(board);
  }
  function updateFallbackBoard() {
    if (app.webgl) return;
    var board = document.getElementById('fallback-board');
    if (!board) return;
    var st = app.run ? app.run.state : null;
    board.innerHTML = '';
    if (!st) { board.appendChild(document.createElement('div')); return; }
    for (var i = 0; i < st.layers.length; i++) {
      (function (idx) {
        var L = st.layers[idx];
        var b = document.createElement('button');
        b.className = 'btn';
        b.style.minHeight = '52px';
        var cap = R.binCapMilli(st, idx);
        b.textContent = 'Layer ' + (idx + 1) + (L.unlocked ?
          ' — crew ' + L.workers + ', bin ' + Math.floor(L.milliOre * 100 / cap) + '%' + (R.isBlocked(st, idx) ? ' BLOCKED' : '') +
          (st.flare.active && st.flare.active.layer === idx ? ' ✦ FLARE' : '') : ' — sealed');
        b.addEventListener('click', function () { onLayerPicked(idx); });
        board.appendChild(b);
      })(i);
    }
  }

  // -------------------------------------------------------------- settings ---
  function applySettings() {
    var s = app.settings;
    document.body.dataset.theme = s.theme;
    document.body.classList.toggle('hc', !!s.highContrast);
    document.body.classList.toggle('large-text', !!s.largeText);
    document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
    document.body.classList.toggle('left-handed', !!s.leftHanded);
    document.body.classList.toggle('no-captions', !s.captions);
    document.body.classList.toggle('pal-deuter', s.palette === 'deuter');
    document.body.classList.toggle('pal-protan', s.palette === 'protan');
    document.body.classList.toggle('pal-tritan', s.palette === 'tritan');
    if (A.isUnlocked()) {
      A.setVolume('music', s.volMusic); A.setVolume('effects', s.volEffects);
      A.setVolume('ambience', s.volAmbience); A.setVolume('voice', s.volVoice);
      A.setMuted(!!s.muted);
    }
    if (app.renderer) {
      app.renderer.setQuality(s.quality);
      app.renderer.setReducedMotion(!!s.reducedMotion || !s.cameraSway);
      app.renderer.setTheme(currentTheme());
    }
    P.setConsent(!!s.telemetry);
    app.profile.settings = app.settings;
    S.saveProfile(app.profile);
  }

  // ------------------------------------------------------------- run setup ---
  function startRun(content, mode) {
    A.unlock();
    app.content = content;
    app.mode = mode === 'learn-go' ? 'learn' : mode.replace(/-go$/, '');
    if (content.lesson) { app.lesson = content.lesson; app.lessonStepIdx = 0; }
    else { app.lesson = null; app.lessonStepIdx = 0; }

    app.run = S.createRun(content, app.mode, { buildState: C.buildState });
    // Timing assistance (accessibility): longer flare claim windows. Casual
    // shifts only — the ranked daily must replay bit-identically server-side.
    if (app.settings.timingAssist && app.mode !== 'daily') {
      app.run.state.ruleset.flareDurationSec *= 2;
    }
    A.setVariantSeed(content.seed);
    app.selectedLayer = null;
    app.paused = false;
    app.lastCoinBucket = 0;
    app.blockedMask = 0;

    if (app.renderer) app.renderer.setTheme(C.themeById(content.theme || app.settings.theme));
    UI.closeModal();
    UI.showPlay();
    announceObjective();

    // countdown (tutorial mode jumps straight in with the lesson banner)
    if (app.lesson) {
      UI.showCountdown(null);
      app.countdownEnd = 0;
      UI.announce(app.lesson.intro, false);
    } else {
      app.countdownEnd = performance.now() + 1800;
      app.paused = true; // hold sim during countdown
    }
    P.activityStart();
    P.track('start', { mode: app.mode, content: content.id });
    UI.updateHUD(hudModel());
  }

  function announceObjective() {
    var g = app.run.state.ruleset.goals;
    var msg = app.content.name + '. ';
    if (app.lesson) msg += app.lesson.intro;
    else if (g) msg += 'Objective: ' + objectiveText(g) + '.';
    else msg += 'Endless shift. Bank your score from the pause menu.';
    UI.announce(msg, false);
  }
  function objectiveText(g) {
    if (!g) return 'Endless shift';
    if (g.type === 'earn') return 'Earn ' + R.formatCoins(g.amount) + ' credits';
    if (g.type === 'depth') return 'Unlock ' + g.amount + ' layers';
    if (g.type === 'rate') return 'Reach ' + R.formatOre(g.amount) + ' ore/s';
    return '';
  }

  function restartRun() {
    if (!app.content) return;
    UI.closeModal();
    startRun(app.content, app.mode);
  }

  function endRun() {
    UI.closeModal();
    if (app.run && !app.run.closed) S.dispatch(app.run, { type: 'end_run' });
  }

  function leaveRun() {
    UI.closeModal();
    finishRunSilently();
    UI.show('title');
  }
  function finishRunSilently() {
    if (app.run && !app.run.closed) S.finalize(app.run);
    app.run = null;
    app.lesson = null;
    UI.showCountdown(null);
    P.activityEnd();
  }

  // ------------------------------------------------------------ frame loop ---
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(250, now - (app.lastFrame || now));
    app.lastFrame = now;

    // countdown gate
    if (app.run && app.countdownEnd) {
      var left = app.countdownEnd - now;
      if (left > 0) {
        UI.showCountdown(String(Math.ceil(left / 600)));
        renderOnly(dt / 1000);
        return;
      }
      app.countdownEnd = 0;
      // stay paused if the player opened the pause menu during the countdown
      app.paused = UI.currentScreen() !== 'play';
      UI.showCountdown(null);
      if (!app.paused) A.play('shift_start');
    }

    if (app.run && !app.paused && !app.run.closed) {
      var events = S.tick(app.run, dt);
      handleEvents(events);
      app.hudAccum += dt;
      app.saveAccum += dt;
      if (app.hudAccum > 200) {
        app.hudAccum = 0;
        UI.updateHUD(hudModel());
        updateFallbackBoard();
        updateAudioIntensity();
        checkBottleneck(now);
      }
      if (app.saveAccum > 10000) {
        app.saveAccum = 0;
        if (app.mode === 'practice') S.saveRun(app.run);
        app.profile.stats.playtimeSec += 10;
        S.saveProfile(app.profile);
      }
    }
    if (app.run && app.run.closed && !app.run._resultsShown) {
      app.run._resultsShown = true;
      onRunClosed();
    }
    renderOnly(dt / 1000);
  }

  function renderOnly(dtSec) {
    if (app.run) {
      if (app.renderer) {
        app.renderer.setSnapshot(app.run.state, dtSec);
        app.renderer.setSelectedLayer(app.selectedLayer);
        app.renderer.setFlareActive(app.run.state.flare.active ? app.run.state.flare.active.layer : null);
        app.renderer.setPaused(app.paused);
        UI.positionLabels(app.renderer, app.run.state, app.selectedLayer);
      }
    } else if (app.renderer) {
      // idle attract scene: show a demo mine behind the title
      if (!app.attractState) app.attractState = C.buildState(C.JOURNEY[0]);
      R.advance(app.attractState, Math.floor(dtSec * 1000));
      if (app.attractState.tick > 300) app.attractState = C.buildState(C.JOURNEY[0]);
      app.renderer.setSnapshot(app.attractState, dtSec);
      app.renderer.setSelectedLayer(null);
      app.renderer.setFlareActive(null);
      app.renderer.setPaused(false);
      UI.positionLabels(app.renderer, { layers: [] }, null);
    }
  }

  // Bottleneck cue: fires once when a layer's bin first reaches the blocked
  // threshold (rules.isBlocked), rate-limited so a saturated mine stays quiet.
  function checkBottleneck(now) {
    var st = app.run.state;
    var mask = 0;
    for (var i = 0; i < st.layers.length; i++) {
      if (st.layers[i].unlocked && R.isBlocked(st, i)) mask |= (1 << i);
    }
    var fresh = mask & ~app.blockedMask;
    app.blockedMask = mask;
    if (fresh && now - app.blockedSoundAt > 8000) {
      app.blockedSoundAt = now;
      var idx = 0;
      while (!(fresh & (1 << idx))) idx++;
      A.play('bin_blocked');
      UI.announce('Layer ' + (idx + 1) + ' bin is full — transport is the bottleneck.', false);
    }
  }

  function updateAudioIntensity() {
    if (!app.run) { A.setIntensity(0); return; }
    var rate = R.totalExtractionRate(app.run.state);
    A.setIntensity(Math.min(1, rate / 400000));
  }

  // -------------------------------------------------------------- events ---
  function handleEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      switch (e.type) {
        case 'flare_started':
          A.play('flare_started');
          UI.announce('Seam flare on Layer ' + (e.layer + 1), false);
          break;
        case 'flare_expired':
          A.play('flare_expired');
          UI.announce('The flare on Layer ' + (e.layer + 1) + ' faded.', false);
          break;
        case 'terminal':
          break; // handled via run.closed
      }
    }
    // coin trickle sound, bucketed
    if (app.run) {
      var bucket = Math.floor(app.run.state.lifetimeEarned / (100 * R.COIN_SCALE));
      if (bucket !== app.lastCoinBucket) {
        app.lastCoinBucket = bucket;
        app.coinSoundAccum++;
        if (app.coinSoundAccum % 3 === 0) A.play('coin');
      }
    }
  }

  // ------------------------------------------------------------- commands ---
  function doCommand(cmd) {
    if (!app.run || app.run.closed) return;
    A.unlock();
    var res = S.dispatch(app.run, cmd);
    if (!res.ok) {
      A.play('error');
      UI.toast(invalidText(res.reason), 'err');
      UI.announce(invalidText(res.reason), true);
      if (app.renderer) app.renderer.pulse('error');
      return;
    }
    if (res.deduped) return;
    // audio + vfx per command
    var soundMap = {
      assign: 'assign', unassign: 'unassign', hire: 'hire',
      upgrade_shaft: 'upgrade', upgrade_lift_cap: 'upgrade', upgrade_lift_speed: 'upgrade',
      unlock_layer: 'unlock_layer', claim_flare: 'claim_flare',
      buy_foreman: 'foreman', toggle_foreman: 'foreman'
    };
    var snd = soundMap[cmd.type] || 'ui_click';
    A.play(snd);
    if (app.renderer) {
      if (cmd.type === 'unlock_layer') app.renderer.pulse('unlock');
      else if (cmd.type === 'claim_flare') app.renderer.pulse('coin');
      else if (cmd.type.indexOf('upgrade') === 0) app.renderer.pulse('upgrade');
    }
    if (cmd.type === 'unlock_layer') {
      UI.announce('Layer ' + (res.events[0].layer + 1) + ' opened.', false);
      checkAchievement('deep_milestone', R.unlockedCount(app.run.state) >= 6);
    }
    if (cmd.type === 'claim_flare') {
      app.profile.stats.flaresClaimed++;
      UI.announce('Flare claimed: +' + R.formatCoins(res.events[0].credits) + ' credits.', false);
    }
    // lesson progression
    if (app.lesson) lessonCheckCommand(cmd);
    UI.updateHUD(hudModel());
    updateFallbackBoard();
    if (app.settings.haptics && navigator.vibrate) navigator.vibrate(8);
  }

  function invalidText(reason) {
    var map = {};
    map[R.REASONS.NO_IDLE_WORKER] = 'No idle workers.';
    map[R.REASONS.LAYER_LOCKED] = 'That layer is sealed.';
    map[R.REASONS.WORKER_CAP] = 'Seam fully crewed.';
    map[R.REASONS.NO_WORKERS] = 'Nobody assigned there.';
    map[R.REASONS.INSUFFICIENT_FUNDS] = 'Not enough credits.';
    map[R.REASONS.ALL_UNLOCKED] = 'All seams are open.';
    map[R.REASONS.NO_FLARE] = 'No active flare.';
    map[R.REASONS.MECHANIC_DISABLED] = 'Not available here.';
    map[R.REASONS.TERMINAL] = 'The shift is over.';
    return map[reason] || ('Cannot: ' + reason);
  }

  // --------------------------------------------------------------- lessons ---
  function lessonCheckCommand(cmd) {
    var step = app.lesson.steps[app.lessonStepIdx];
    if (!step) return;
    var req = step.require;
    if (req.type === cmd.type && (req.layer === undefined || req.layer === cmd.layer)) {
      advanceLesson();
    }
  }
  function lessonCheckEarn() {
    if (!app.lesson) return;
    var step = app.lesson.steps[app.lessonStepIdx];
    if (step && step.require.type === 'earn' &&
      app.run.state.lifetimeEarned >= step.require.amount) advanceLesson();
  }
  function advanceLesson() {
    P.track('tutorial_step', { lesson: app.lesson.id, step: app.lessonStepIdx });
    app.lessonStepIdx++;
    A.play('lesson_step');
    if (app.lessonStepIdx >= app.lesson.steps.length) {
      app.profile.lessons[app.lesson.id] = true;
      S.saveProfile(app.profile);
      UI.toast('Lesson complete!', 'good');
      S.dispatch(app.run, { type: 'end_run' });
    } else {
      UI.announce(app.lesson.steps[app.lessonStepIdx].text, false);
    }
  }

  // ----------------------------------------------------------- run closed ---
  function onRunClosed() {
    var run = app.run;
    var st = run.state;
    var won = st.terminal.won;
    A.play(won ? 'terminal_win' : 'terminal_lose');
    if (app.renderer) app.renderer.pulse(won ? 'complete' : 'error');

    // persistence + progression
    var p = app.profile;
    p.stats.runsPlayed++;
    p.stats.totalEarned += Math.floor(st.lifetimeEarned / R.COIN_SCALE);
    var newBest = false, stars = 0, nextContent = null, boardResult = '';
    var achieved = [];

    if (app.mode === 'journey' && won) {
      stars = S.starsFor(app.content, st.tick);
      var prev = p.journey[app.content.id];
      if (!prev || stars > prev.stars || st.tick < prev.bestTick) {
        p.journey[app.content.id] = { stars: Math.max(stars, prev ? prev.stars : 0), bestTick: prev ? Math.min(prev.bestTick, st.tick) : st.tick };
        newBest = true;
      }
      var nxt = C.journeyByIndex(app.content.n); // n is 1-based
      if (nxt) nextContent = nxt;
    }
    if (app.mode === 'daily') {
      var key = app.content.key;
      var total = run.result.score.total;
      if (!p.daily[key] || total > p.daily[key].score) { p.daily[key] = { score: total, won: won }; newBest = true; }
      // submit for validation (hosted) or local board
      var env = S.envelope(run);
      P.submitScore('daily', {
        dayKey: app.content.id, contentVersion: app.content.version, seed: app.content.seed,
        name: p.displayName, scoreTotal: total, durationSec: st.tick,
        playerId: p.playerId,
        clientHash: run.result.finalHash, log: env.log
      }).then(function (res) {
        if (res && res.ok && res.authoritative) boardResult = 'Board rank #' + res.rank + ' (validated).';
        else if (res && res.ok) boardResult = 'Saved to the local casual board.';
        else if (res && res.error) boardResult = 'Submission: ' + res.error;
        S.saveProfile(p);
      });
    }
    if (app.mode === 'practice') {
      var diff = app.content.id.replace('practice-', '');
      if (!p.practice[diff] || run.result.score.total > p.practice[diff]) { p.practice[diff] = run.result.score.total; newBest = true; }
      S.clearSavedRun();
      app.savedRun = null;
    }
    if (app.mode === 'challenge') {
      if (!p.challenges[app.content.id] || run.result.score.total > p.challenges[app.content.id]) {
        p.challenges[app.content.id] = run.result.score.total; newBest = true;
      }
    }

    // mastery xp
    p.mastery.xp += S.masteryXpFor(run.result);

    // achievements
    var completed = (won && st.ruleset.goals) || (app.lesson && app.lessonStepIdx >= app.lesson.steps.length);
    achieved.push.apply(achieved, unlockAch('first_completion', completed));
    achieved.push.apply(achieved, unlockAch('mechanic_mastery', C.LESSONS.every(function (l) { return p.lessons[l.id]; })));
    achieved.push.apply(achieved, unlockAch('streak_7', Object.keys(p.daily).length >= 7));
    achieved.push.apply(achieved, unlockAch('long_haul', p.stats.totalEarned >= 10000000));
    if (achieved.length) setTimeout(function () { A.play('achievement'); }, 600);

    S.saveProfile(p);
    P.track('round_end', { mode: app.mode, content: app.content.id, won: won, score: run.result.score.total });
    P.activityEnd();

    UI.showResults({
      run: run, content: app.content, mode: app.mode,
      won: won, reason: st.terminal.reason, score: run.result.score,
      stars: stars, newBest: newBest, achievements: achieved,
      nextContent: nextContent, boardResult: boardResult
    });
  }

  function unlockAch(key, condition) {
    if (!condition || app.profile.achievements[key]) return [];
    app.profile.achievements[key] = Date.now();
    P.unlockAchievement(key);
    var def = null;
    UI.ACHIEVEMENTS.forEach(function (a) { if (a.key === key) def = a; });
    return [def ? def.name : key];
  }
  function checkAchievement(key, condition) {
    var names = unlockAch(key, condition);
    if (names.length) { A.play('achievement'); UI.toast('Achievement: ' + names[0], 'good'); S.saveProfile(app.profile); }
  }

  // ----------------------------------------------------------------- input ---
  function onLayerPicked(idx) {
    A.unlock();
    if (!app.run) return;
    var st = app.run.state;
    // tapping a flaring layer claims directly (one-input confidence)
    if (st.flare.active && st.flare.active.layer === idx) {
      doCommand({ type: 'claim_flare', layer: idx, id: st.flare.active.id });
      app.selectedLayer = idx;
      UI.updateHUD(hudModel());
      return;
    }
    app.selectedLayer = idx;
    A.play('ui_click');
    if (!st.layers[idx].unlocked) {
      UI.announce('Layer ' + (idx + 1) + ' is sealed. Open it from the Foreman\'s Panel.', false);
    }
    UI.updateHUD(hudModel());
    if (app.renderer) app.renderer.setSelectedLayer(idx);
  }

  function bindInput() {
    // audio unlock on first gesture
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, function once() { A.unlock(); }, { once: true, passive: true });
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT')) return;
      var k = ev.key;
      if (k === 'Escape') {
        ev.preventDefault();
        var scr = UI.currentScreen();
        if (scr === 'play') (app.paused && !app.countdownEnd) ? resumeGame() : pauseGame();
        else if (scr === 'settings' && app.run && app.paused) resumeGame();
        else if (scr !== 'title') UI.back();
        return;
      }
      if (UI.currentScreen() !== 'play' || !app.run) return;
      var keys = app.settings.keys;
      var st = app.run.state;
      var handled = true;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        var dir = k === 'ArrowDown' ? 1 : -1;
        var cur = app.selectedLayer === null ? (dir > 0 ? -1 : st.layers.length) : app.selectedLayer;
        var next = Math.max(0, Math.min(st.layers.length - 1, cur + dir));
        onLayerPicked(next);
      }
      else if (k === keys.assign || k === 'Enter') cmdSel('assign');
      else if (k.toUpperCase() === keys.unassign) cmdSel('unassign');
      else if (k.toUpperCase() === keys.hire) doCommand({ type: 'hire' });
      else if (k.toUpperCase() === keys.shaft) cmdSel('upgrade_shaft');
      else if (k.toUpperCase() === keys.liftCap) doCommand({ type: 'upgrade_lift_cap' });
      else if (k.toUpperCase() === keys.liftSpeed) doCommand({ type: 'upgrade_lift_speed' });
      else if (k.toUpperCase() === keys.unlock) doCommand({ type: 'unlock_layer' });
      else if (k.toUpperCase() === keys.flare) claimActiveFlare();
      else if (k.toUpperCase() === keys.foreman) doCommand({ type: app.run.state.foreman.unlocked ? 'toggle_foreman' : 'buy_foreman' });
      else if (k.toUpperCase() === keys.undo) doUndo();
      else handled = false;
      if (handled) ev.preventDefault();
    });

    // gamepad polling
    pollGamepad();
  }
  function cmdSel(type) {
    if (app.selectedLayer === null) { UI.toast('Select a layer first (↑/↓ or tap)', 'err'); return; }
    doCommand({ type: type, layer: app.selectedLayer });
  }
  function claimActiveFlare() {
    var f = app.run && app.run.state.flare.active;
    if (f) doCommand({ type: 'claim_flare', layer: f.layer, id: f.id });
    else { A.play('error'); UI.toast('No active flare.', 'err'); }
  }
  function doUndo() {
    var res = S.undo(app.run);
    if (res.ok) { A.play('undo'); UI.toast('Undone'); UI.updateHUD(hudModel()); }
    else UI.toast('Nothing to undo.', 'err');
  }

  var padState = {};
  function pollGamepad() {
    requestAnimationFrame(pollGamepad);
    if (!navigator.getGamepads) return;
    var pads = navigator.getGamepads();
    var pad = null;
    for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
    if (!pad) return;
    var map = app.settings.pad;
    function pressed(b) {
      if (b === undefined || !pad.buttons[b]) return false;
      var down = pad.buttons[b].pressed;
      var was = padState[b];
      padState[b] = down;
      return down && !was;
    }
    if (pressed(map.pause)) {
      var scr = UI.currentScreen();
      if (scr === 'play') (app.paused && !app.countdownEnd) ? resumeGame() : pauseGame();
      else if (scr === 'settings' && app.run && app.paused) resumeGame();
    }
    if (UI.currentScreen() !== 'play' || !app.run) return;
    if (pressed(map.up)) onLayerPicked(Math.max(0, (app.selectedLayer === null ? 0 : app.selectedLayer) - 1));
    if (pressed(map.down)) onLayerPicked(Math.min(app.run.state.layers.length - 1, (app.selectedLayer === null ? -1 : app.selectedLayer) + 1));
    if (pressed(map.confirm)) {
      var f = app.run.state.flare.active;
      if (f && f.layer === app.selectedLayer) claimActiveFlare();
      else cmdSel('assign');
    }
    if (pressed(map.cancel)) cmdSel('unassign');
  }

  // ------------------------------------------------------------ pause/resume ---
  function pauseGame() {
    if (!app.run || app.run.closed) return;
    app.paused = true;
    UI.openSettings(true);
    UI.announce('Paused.', false);
  }
  function resumeGame() {
    app.paused = false;
    if (app.run) {
      app.lastFrame = performance.now(); // discard away time while paused
      UI.showPlay();
      UI.announce('Resumed.', false);
    }
  }

  function bindLifecycle() {
    document.addEventListener('visibilitychange', function () {
      var hidden = document.visibilityState !== 'visible';
      A.handleVisibility(hidden);
      if (hidden) {
        if (app.run && !app.run.closed && !app.paused) {
          // backgrounding pauses solo simulation; save a safe snapshot and
          // surface the pause panel so the frozen state is obvious on return
          if (app.mode === 'practice') S.saveRun(app.run);
          pauseGame();
        }
      } else {
        app.lastFrame = performance.now();
      }
    });
    window.addEventListener('beforeunload', function () {
      if (app.run && !app.run.closed && app.mode === 'practice') S.saveRun(app.run);
      S.saveProfile(app.profile);
      P.activityEnd();
    });
    window.addEventListener('resize', function () {
      if (app.renderer) app.renderer.resize();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { if (app.renderer) app.renderer.resize(); }, 120);
    });
    // HUD chrome changes size without a window resize (lesson card, wrapped
    // top bar): keep the banner below the top bar and re-frame the mine.
    var hudTop = document.getElementById('hud-top');
    var syncHud = function () {
      if (hudTop) document.documentElement.style.setProperty('--hud-top-h', Math.ceil(hudTop.getBoundingClientRect().bottom) + 'px');
      if (app.renderer) app.renderer.resize();
    };
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(syncHud);
      if (hudTop) ro.observe(hudTop);
      var banner = document.getElementById('lesson-banner');
      if (banner) ro.observe(banner);
    }
    syncHud();
  }

  // ------------------------------------------------------------ HUD model ---
  function hudModel() {
    var lessonText = null;
    if (app.lesson && app.lesson.steps[app.lessonStepIdx]) {
      // Shortcut placeholders ({assign}, {hire}, …) resolve to the player's real bindings.
      var keys = (app.settings && app.settings.keys) || {};
      lessonText = 'Lesson ' + (app.lessonStepIdx + 1) + '/' + app.lesson.steps.length + ': ' +
        app.lesson.steps[app.lessonStepIdx].text.replace(/\{(\w+)\}/g, function (m, k) { return keys[k] || m; });
    }
    return {
      state: app.run.state,
      content: app.content,
      mode: app.mode,
      selectedLayer: app.selectedLayer,
      lessonStep: lessonText,
      legal: R.legalActions(app.run.state),
      canUndo: S.canUndo(app.run),
      objectiveText: app.lesson ? app.lesson.name : objectiveText(app.run.state.ruleset.goals)
    };
  }

  // ------------------------------------------------------------- handlers ---
  var handlers = {
    getState: function () {
      return {
        profile: app.profile, settings: app.settings, run: app.run,
        mode: app.mode, content: app.content, selectedLayer: app.selectedLayer,
        platform: { hosted: P.state.hosted }, savedRun: app.savedRun
      };
    },
    audio: function (name) { A.unlock(); A.play(name); },
    startRun: startRun,
    restartRun: restartRun,
    pause: pauseGame,
    resume: resumeGame,
    endRun: endRun,
    leaveRun: leaveRun,
    leaveToTitle: function () { finishRunSilently(); UI.show('title'); },
    command: doCommand,
    selectLayer: onLayerPicked,
    undo: doUndo,
    settingsChanged: function () {
      applySettings();
      P.track('settings_change', {});
    },
    setDisplayName: function (name) {
      app.profile.displayName = name.slice(0, 24);
      S.saveProfile(app.profile);
    },
    wipeProfile: function () {
      try { localStorage.removeItem(S.PROFILE_KEY); localStorage.removeItem(S.RUN_SAVE_KEY); } catch (e) {}
      app.profile = S.loadProfile();
      app.profile.settings = app.settings;
      S.saveProfile(app.profile);
      UI.toast('Local profile erased.', 'good');
      UI.show('title');
    },
    resumeSaved: function () {
      var data = app.savedRun;
      if (!data) return;
      var resumed = S.resumeRun(data);
      if (!resumed) { UI.toast('Saved shift could not be restored.', 'err'); return; }
      A.unlock();
      var content = { id: data.contentId, name: 'Practice (resumed)', version: data.contentVersion, seed: data.seed, theme: app.settings.theme };
      app.content = content;
      app.mode = data.mode || 'practice';
      app.run = {
        id: data.runId, mode: app.mode, contentId: data.contentId,
        contentVersion: data.contentVersion, seed: data.seed,
        state: resumed.state, log: data.log || [], pendingAdvanceMs: 0,
        undoStack: [], hashes: [], startedAt: Date.now(), lastSavedAt: Date.now(),
        closed: false, result: null
      };
      app.savedRun = null;
      app.paused = false;
      app.countdownEnd = 0;
      UI.showPlay();
      if (resumed.away.seconds > 30) {
        var mins = Math.floor(resumed.away.seconds / 60);
        A.play('away_return');
        UI.openModal(function (close) {
          var m = document.createElement('div');
          m.className = 'modal';
          m.innerHTML = '<h3>While you were away</h3>' +
            '<p>The crew kept digging for ' + (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + ' min') +
            (resumed.away.capped ? ' (capped)' : '') + ' and earned <b>' + R.formatCoins(resumed.away.earned) + '</b> credits.</p>';
          var art = document.createElement('img');
          art.className = 'modal-art'; art.alt = ''; art.src = 'assets/crew-at-night.webp';
          art.addEventListener('error', function () { art.style.display = 'none'; });
          m.insertBefore(art, m.firstChild);
          var b = document.createElement('button');
          b.className = 'btn primary'; b.textContent = 'Back to work';
          b.addEventListener('click', close);
          m.appendChild(b);
          return m;
        });
      }
      UI.announce('Shift resumed.', false);
    },
    discardSaved: function () {
      S.clearSavedRun();
      app.savedRun = null;
    }
  };

  // audio captions → UI
  A.onCaption(function (text) { UI.caption(text); });

  // periodic lesson earn checks
  setInterval(function () { if (app.run && !app.paused) lessonCheckEarn(); }, 500);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
