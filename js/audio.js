/**
 * Deepworks — audio module.
 * Original synthesized audio (no samples): short transients tied to logical
 * events, layered material impacts, quiet ambience, adaptive music stem.
 * Four independent buses: music / effects / ambience / voice (spec §3).
 * Every meaningful sound exposes a caption string for text cues.
 * Variant pitch randomization is seeded per-run for replay consistency.
 */
(function (root) {
  'use strict';

  var ctx = null;
  var buses = {};
  var masterGain = null;
  var started = false;
  var muted = false;
  var volumes = { music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.6 };
  var variantSeed = 1;
  var captionSink = null;
  var musicTimer = null;
  var musicIntensity = 0;   // 0..1 follows game throughput
  var noiseSource = null;

  function ensureCtx() {
    if (ctx) return true;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);
    ['music', 'effects', 'ambience', 'voice'].forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = volumes[name];
      g.connect(masterGain);
      buses[name] = g;
    });
    return true;
  }

  // Resume must happen inside a user gesture (browser autoplay policy).
  function unlock() {
    if (!ensureCtx()) return false;
    if (ctx.state === 'suspended') ctx.resume();
    if (!started) { started = true; startAmbience(); startMusic(); }
    return true;
  }

  function setVolume(bus, v) {
    volumes[bus] = Math.max(0, Math.min(1, v));
    if (buses[bus]) buses[bus].gain.value = volumes[bus];
  }
  function setMuted(m) {
    muted = !!m;
    if (masterGain) masterGain.gain.value = muted ? 0 : 1;
  }
  function setVariantSeed(seed) { variantSeed = seed >>> 0; }
  function nextVariant() { // deterministic small pitch variant
    variantSeed = (variantSeed * 1664525 + 1013904223) >>> 0;
    return 0.94 + (variantSeed % 120) / 1000; // 0.94..1.06
  }
  function onCaption(fn) { captionSink = fn; }
  function caption(text) { if (captionSink) captionSink(text); }

  // ------------------------------------------------------------ primitives ---
  function tone(bus, freq, dur, type, gain, slide) {
    if (!ctx || muted) return;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    var t = ctx.currentTime;
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noiseHit(bus, dur, gain, filterFreq) {
    if (!ctx || muted) return;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterFreq || 1200;
    var g = ctx.createGain();
    g.gain.value = gain || 0.2;
    src.connect(f); f.connect(g); g.connect(buses[bus]);
    src.start();
  }

  // ------------------------------------------------------- event mapping ---
  // Input acknowledgment < legal move < goal < completion (spec §4 hierarchy).
  var SOUNDS = {
    ui_click:      { fn: function () { tone('effects', 660, 0.06, 'triangle', 0.12); }, caption: null },
    ui_back:       { fn: function () { tone('effects', 440, 0.07, 'triangle', 0.1, 0.8); }, caption: null },
    error:         { fn: function () { tone('effects', 180, 0.18, 'square', 0.1, 0.7); }, caption: 'Action not available' },
    assign:        { fn: function () { noiseHit('effects', 0.08, 0.18, 900); tone('effects', 320 * nextVariant(), 0.1, 'triangle', 0.14); }, caption: 'Worker assigned' },
    unassign:      { fn: function () { tone('effects', 260 * nextVariant(), 0.1, 'triangle', 0.12, 0.8); }, caption: 'Worker recalled' },
    hire:          { fn: function () { tone('effects', 520, 0.1, 'triangle', 0.15); tone('effects', 780, 0.12, 'triangle', 0.12); }, caption: 'Worker hired' },
    upgrade:       { fn: function () { noiseHit('effects', 0.12, 0.2, 1600); tone('effects', 440, 0.16, 'sawtooth', 0.08, 1.5); }, caption: 'Upgrade complete' },
    unlock_layer:  { fn: function () { noiseHit('effects', 0.3, 0.28, 500); tone('effects', 220, 0.4, 'sine', 0.2, 2); }, caption: 'New layer opened' },
    claim_flare:   { fn: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { tone('effects', f * nextVariant(), 0.14, 'triangle', 0.14); }, i * 45); }); }, caption: 'Seam flare claimed' },
    flare_started: { fn: function () { tone('effects', 880, 0.5, 'sine', 0.06, 1.4); }, caption: 'A seam is flaring' },
    coin:          { fn: function () { tone('effects', 1200 * nextVariant(), 0.05, 'sine', 0.05, 1.3); }, caption: null },
    foreman:       { fn: function () { tone('effects', 392, 0.12, 'triangle', 0.14); tone('effects', 587, 0.16, 'triangle', 0.12); }, caption: 'Foreman engaged' },
    terminal_win:  { fn: function () { [392, 523, 659, 784].forEach(function (f, i) { setTimeout(function () { tone('effects', f, 0.3, 'triangle', 0.16); }, i * 120); }); }, caption: 'Objective complete' },
    terminal_lose: { fn: function () { tone('effects', 300, 0.5, 'sine', 0.15, 0.5); }, caption: 'Run ended' },
    undo:          { fn: function () { tone('effects', 500, 0.09, 'sine', 0.1, 0.75); }, caption: 'Undone' }
  };

  function play(name) {
    if (!ctx || muted) { var s0 = SOUNDS[name]; if (s0 && s0.caption) caption(s0.caption); return; }
    var s = SOUNDS[name];
    if (!s) return;
    try { s.fn(); } catch (e) {}
    if (s.caption) caption(s.caption);
  }

  // -------------------------------------------------------------- ambience ---
  function startAmbience() {
    if (!ctx || noiseSource) return;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) { // brown-ish noise
      var w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = buf; noiseSource.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 220; f.Q.value = 0.4;
    var g = ctx.createGain(); g.gain.value = 0.5;
    noiseSource.connect(f); f.connect(g); g.connect(buses.ambience);
    noiseSource.start();
    // slow LFO on the filter = distant rumble breathing
    var lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    var lfoG = ctx.createGain(); lfoG.gain.value = 60;
    lfo.connect(lfoG); lfoG.connect(f.frequency); lfo.start();
  }

  // ------------------------------------------------------------------ music ---
  // Adaptive two-voice modal pattern; intensity follows game throughput.
  var MUSIC_SCALE = [0, 3, 5, 7, 10]; // minor pentatonic
  var musicStep = 0;
  function startMusic() {
    if (!ctx || musicTimer) return;
    musicTimer = setInterval(function () {
      if (muted || document.visibilityState !== 'visible') return;
      musicStep++;
      var base = 110; // A2
      // bass note every 4 steps
      if (musicStep % 4 === 0) {
        var deg = MUSIC_SCALE[(musicStep / 4) % MUSIC_SCALE.length | 0];
        tone('music', base * Math.pow(2, deg / 12), 1.4, 'sine', 0.10);
      }
      // sparkle voice appears with intensity
      if (musicIntensity > 0.25 && musicStep % 2 === 1) {
        var idx = (musicStep * 7 + Math.floor(musicIntensity * 10)) % MUSIC_SCALE.length;
        var oct = musicIntensity > 0.6 ? 4 : 2;
        tone('music', base * oct * Math.pow(2, MUSIC_SCALE[idx] / 12) * nextVariant(), 0.5, 'triangle', 0.03 + musicIntensity * 0.05);
      }
    }, 375);
  }
  function setIntensity(v) { musicIntensity = Math.max(0, Math.min(1, v)); }

  // Background behavior: duck everything when hidden (spec §5).
  function handleVisibility(hidden) {
    if (!ctx) return;
    if (masterGain) masterGain.gain.value = (hidden || muted) ? 0 : 1;
  }

  root.DWAudio = {
    unlock: unlock,
    play: play,
    setVolume: setVolume,
    setMuted: setMuted,
    setVariantSeed: setVariantSeed,
    setIntensity: setIntensity,
    onCaption: onCaption,
    handleVisibility: handleVisibility,
    volumes: volumes,
    isUnlocked: function () { return started; }
  };
})(typeof self !== 'undefined' ? self : this);
