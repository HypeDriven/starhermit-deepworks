/**
 * Deepworks — UI module. Semantic HTML shell: screens, HUD, rails, toasts,
 * modals, accessibility mirror, settings, help, results, boards, profile.
 * UI state is fully separate from simulation state (spec §5).
 * Reads game state through the handlers' getState(); never touches rules
 * state directly except through handler commands.
 */
(function (root) {
  'use strict';
  var R = root.DWRules;
  var C = root.DWContent;
  var GFX = root.DWGfx;

  var H = null;              // handlers
  var navStack = [];
  var current = 'boot';
  var labelEls = [];
  var lastHudSig = '';
  var lastRailSig = '';
  var toastTimer = null;

  // Every player-facing string follows the game language (js/i18n.js, keyed
  // by the US-English text).
  function T(key, vars) { return root.DWI18n ? root.DWI18n.T(key, vars) : String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? vars[k] : m; }); }
  function N(key) { return key; }
  // The default guest name reads in the game language; chosen names never change.
  function nameText(n) { return n === 'Guest Prospector' ? T('Guest Prospector') : n; }
  function gfxLocale() { return root.DWI18n ? root.DWI18n.lang : GFX.pickLocale(navigator.language); }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function btn(label, cls, onClick, title) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', function (ev) { ev.preventDefault(); H.audio('ui_click'); onClick(ev); });
    return b;
  }

  // ------------------------------------------------------------ lifecycle ---
  function init(handlers) {
    H = handlers;
    // static wiring
    $('btn-play').addEventListener('click', function () { H.audio('ui_click'); show('modes'); });
    $('btn-daily').addEventListener('click', function () { H.audio('ui_click'); openSetup('daily'); });
    $('btn-journey').addEventListener('click', function () { H.audio('ui_click'); show('journey'); });
    $('btn-profile').addEventListener('click', function () { H.audio('ui_click'); show('profile'); });
    $('btn-signin').addEventListener('click', function () { H.audio('ui_click'); H.signIn(); });
    $('btn-invite').addEventListener('click', function () { H.audio('ui_click'); H.invite(); });
    $('btn-help').addEventListener('click', function () { H.audio('ui_click'); show('help'); });
    $('btn-boards').addEventListener('click', function () { H.audio('ui_click'); show('boards'); });
    $('btn-settings').addEventListener('click', function () { H.audio('ui_click'); openSettings(false); });
    $('btn-pause').addEventListener('click', function () { H.audio('ui_click'); H.pause(); });
    $('rail-toggle-left').addEventListener('click', function () { toggleRail('hud-left', 'rail-toggle-left'); });
    $('rail-toggle-right').addEventListener('click', function () { toggleRail('hud-right', 'rail-toggle-right'); });
    document.querySelectorAll('[data-back]').forEach(function (b) {
      b.addEventListener('click', function () { H.audio('ui_back'); back(); });
    });
    buildModeGrid();
    setInterval(tickDailyCountdown, 1000);
    show('boot');
  }

  function toggleRail(railId, toggleId) {
    var r = $(railId), t = $(toggleId);
    var open = r.classList.toggle('open');
    t.setAttribute('aria-expanded', String(open));
  }

  // ------------------------------------------------------------ navigation ---
  function show(name) {
    if (name !== current) { navStack.push(current); if (navStack.length > 12) navStack.shift(); }
    setScreen(name);
  }
  function setScreen(name) {
    current = name;
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', s.id === 'screen-' + name);
    });
    $('hud').classList.toggle('hidden', !(name === 'play'));
    $('layer-labels').style.visibility = (name === 'play') ? 'visible' : 'hidden';
    if (name !== 'play') { $('hud-left').classList.remove('open'); $('hud-right').classList.remove('open'); }
    var builder = SCREEN_BUILDERS[name];
    if (builder) builder();
    // focus management: move focus into the newly shown screen
    var sec = $('screen-' + name);
    if (sec) {
      var f = sec.querySelector('.btn.primary, .btn, button, [tabindex]');
      if (f) setTimeout(function () { f.focus({ preventScroll: true }); }, 30);
    }
  }
  function back() {
    var prev = navStack.pop() || 'title';
    if (prev === 'play' || prev === 'boot') prev = 'title';
    setScreen(prev);
  }
  function currentScreen() { return current; }

  var SCREEN_BUILDERS = {
    title: buildTitle,
    journey: buildJourney,
    boards: buildBoards,
    help: buildHelp,
    profile: buildProfile
  };

  // ---------------------------------------------------------------- title ---
  function buildTitle() {
    var st = H.getState();
    var p = st.profile;
    var done = Object.keys(p.journey).length;
    $('journey-progress-label').textContent = done ? '(' + done + '/' + C.JOURNEY.length + ')' : '';
    var canSign = !!st.platform.canSignIn, canInvite = !!(st.platform.hosted && st.platform.inviteLink);
    $('btn-signin').classList.toggle('hidden', !canSign);
    $('btn-invite').classList.toggle('hidden', !canInvite);
    $('title-platform').classList.toggle('hidden', !canSign && !canInvite);
    if (st.platform.hosted) {
      var syncTxt = st.platform.sync === 'synced' ? T('progress synced') : st.platform.sync === 'saving' ? T('saving…') : T('cloud sync unavailable');
      $('title-identity').textContent = T('Playing as {name}', { name: nameText(p.displayName) }) + ' · ' + syncTxt;
    } else {
      $('title-identity').textContent = T('Playing as {name} (guest — progress stays on this device)', { name: nameText(p.displayName) });
    }
    var banner = $('resume-banner');
    var saved = st.savedRun;
    if (saved) {
      banner.classList.remove('hidden');
      banner.innerHTML = '';
      banner.appendChild(el('p', null, T('A previous shift is waiting ({id}).', { id: saved.contentId })));
      var row = el('div', 'action-row');
      row.appendChild(btn(T('Resume shift'), 'primary small', function () { H.resumeSaved(); }));
      row.appendChild(btn(T('Abandon'), 'ghost small', function () { H.discardSaved(); buildTitle(); }));
      banner.appendChild(row);
    } else {
      banner.classList.add('hidden');
    }
    tickDailyCountdown();
  }

  function tickDailyCountdown() {
    var elx = $('daily-countdown');
    if (!elx) return;
    var ms = 0;
    try { ms = root.DWPlatform.msUntilNextDaily(); } catch (e) { return; }
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    elx.textContent = T('(new in {h}h {m}m)', { h: h, m: m });
  }

  // ---------------------------------------------------------------- modes ---
  var MODES = [
    { id: 'learn', name: N('Learn'), desc: N('Interactive lessons. One rule at a time — you perform every action.'), time: N('2–4 min each'), ranked: false },
    { id: 'journey', name: N('Journey'), desc: N('40 authored stages. New mechanics arrive alone, combine, then test mastery.'), time: N('3–20 min each'), ranked: false },
    { id: 'daily', name: N('Daily Vein'), desc: N('One shared seed and ruleset per UTC day. Everyone digs the same mine.'), time: N('15 min cap'), ranked: true },
    { id: 'practice', name: N('Practice'), desc: N('Free play at your chosen difficulty. Restart and undo allowed. Unranked.'), time: N('endless'), ranked: false },
    { id: 'challenge', name: N('Challenge'), desc: N('Constrained shifts: move limits, speed targets, restricted tools.'), time: N('10–25 min'), ranked: false },
    { id: 'score', name: N('Score Chase'), desc: N('Chase the boards — daily and all-time, global or friends.'), time: '—', ranked: true }
  ];
  function buildModeGrid() {
    var grid = $('mode-grid');
    grid.innerHTML = '';
    MODES.forEach(function (m) {
      var card = el('button', 'card');
      card.appendChild(el('h3', null, T(m.name)));
      card.appendChild(el('p', null, T(m.desc)));
      var badges = el('p');
      badges.appendChild(el('span', 'badge ' + (m.ranked ? 'ranked' : 'casual'), m.ranked ? T('ranked') : T('casual')));
      badges.appendChild(el('span', 'badge', T(m.time)));
      card.appendChild(badges);
      card.addEventListener('click', function () {
        H.audio('ui_click');
        if (m.id === 'score') show('boards');
        else if (m.id === 'journey') show('journey');
        else openSetup(m.id);
      });
      grid.appendChild(card);
    });
  }

  // ---------------------------------------------------------------- setup ---
  // Mode setup shows rules, expected duration, ranked status before commitment.
  var lastSetup = null;
  // refresh: re-render the open setup screen (language change) without navigating.
  function openSetup(mode, content, refresh) {
    lastSetup = { mode: mode, content: content };
    var panel = $('setup-panel');
    panel.innerHTML = '';
    var st = H.getState();
    var p = st.profile;

    function setupShell(titleText, contentEntry, extraNode) {
      panel.appendChild(el('h2', null, titleText));
      if (contentEntry) {
        var info = el('div', 'action-group');
        var rs = R.mergeRuleset(contentEntry.overrides || {});
        info.appendChild(kv(T('Seams'), String(rs.layerCount)));
        info.appendChild(kv(T('Goal'), goalText(contentEntry.goals)));
        info.appendChild(kv(T('Time limit'), contentEntry.limits && contentEntry.limits.timeSec ? fmtTime(contentEntry.limits.timeSec) : T('none')));
        info.appendChild(kv(T('Par'), contentEntry.parSec ? fmtTime(contentEntry.parSec) : '—'));
        info.appendChild(kv(T('Mechanics'), mechanicsText(rs.mechanics)));
        info.appendChild(kv(T('Seed'), '#' + (contentEntry.seed >>> 0).toString(36)));
        var ranked = mode === 'daily';
        var badgeRow = el('p');
        badgeRow.appendChild(el('span', 'badge ' + (ranked ? 'ranked' : 'casual'), ranked ? T('ranked — same seed for everyone') : T('casual — unranked')));
        info.appendChild(badgeRow);
        panel.appendChild(info);
      }
      if (extraNode) panel.appendChild(extraNode);
      var row = el('div', 'action-row');
      row.appendChild(btn(T('Start shift'), 'primary', function () { H.startRun(contentEntry, mode); }));
      row.appendChild(btn(T('Back'), 'ghost', function () { H.audio('ui_back'); back(); }));
      panel.appendChild(row);
    }

    if (mode === 'learn') {
      panel.appendChild(el('h2', null, T('Learn')));
      var list = el('div', 'card-grid');
      C.LESSONS.forEach(function (ls, i) {
        var doneL = !!p.lessons[ls.id];
        var locked = i > 0 && !p.lessons[C.LESSONS[i - 1].id] && !st.settings.tutorialAnyOrder;
        var card = el('button', 'card');
        card.appendChild(el('h3', null, (doneL ? '✓ ' : '') + T(ls.name)));
        card.appendChild(el('p', null, T(ls.intro)));
        if (locked) { card.disabled = true; card.appendChild(el('p', 'subtle', T('Complete the previous lesson first.'))); }
        card.addEventListener('click', function () { H.audio('ui_click'); openSetup('learn-go', ls); });
        list.appendChild(card);
      });
      panel.appendChild(list);
      panel.appendChild(btn(T('Back'), 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    } else if (mode === 'learn-go') {
      setupShell(T('Lesson: {name}', { name: T(content.name) }), lessonToContent(content), el('p', null, T(content.intro)));
    } else if (mode === 'daily') {
      var info = C.dailyInfo(root.DWPlatform.dailyDate());
      var played = p.daily[info.key];
      var extra = el('p', played ? 'subtle' : null,
        played ? T('You already dug today: score {score}. You can improve it until the day rolls over.', { score: R.formatCoins(played.score) }) :
          T('Same seed for everyone today. Your input log is validated server-side when hosted.'));
      setupShell(T('Daily Vein — {date}', { date: info.key }), info, extra);
    } else if (mode === 'practice') {
      panel.appendChild(el('h2', null, T('Practice')));
      var grid = el('div', 'card-grid');
      C.PRACTICE_DIFFICULTIES.forEach(function (d) {
        var card = el('button', 'card');
        card.appendChild(el('h3', null, T(d.name)));
        card.appendChild(el('p', null, practiceDesc(d.id)));
        var best = p.practice[d.id];
        if (best) card.appendChild(el('p', 'subtle', T('Best: {score}', { score: R.formatCoins(best) })));
        card.addEventListener('click', function () {
          H.audio('ui_click');
          openSetup('practice-go', {
            id: 'practice-' + d.id, name: 'Practice — ' + d.name, difficulty: d.name, version: C.CONTENT_VERSION,
            seed: (Math.random() * 0xffffffff) >>> 0, theme: H.getState().settings.theme || 'emberdeep',
            overrides: d.overrides, goals: null, limits: null, parSec: 0, endless: true
          });
        });
        grid.appendChild(card);
      });
      panel.appendChild(grid);
      panel.appendChild(btn(T('Back'), 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    } else if (mode === 'practice-go') {
      setupShell(contentName(content), content, el('p', 'subtle', T('Endless. Undo allowed (Z). End the shift from the pause menu to bank your score.')));
    } else if (mode === 'challenge') {
      panel.appendChild(el('h2', null, T('Challenges')));
      var clist = el('div', 'card-grid');
      C.CHALLENGES.forEach(function (ch) {
        var card = el('button', 'card');
        card.appendChild(el('h3', null, T(ch.name)));
        card.appendChild(el('p', null, T(ch.description)));
        var bestc = p.challenges[ch.id];
        if (bestc) card.appendChild(el('p', 'subtle', T('Best: {score}', { score: R.formatCoins(bestc) })));
        card.addEventListener('click', function () { H.audio('ui_click'); openSetup('challenge-go', ch); });
        clist.appendChild(card);
      });
      panel.appendChild(clist);
      panel.appendChild(btn(T('Back'), 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    } else if (mode === 'challenge-go') {
      setupShell(T('Challenge: {name}', { name: T(content.name) }), content, el('p', null, T(content.description)));
    } else if (mode === 'journey-go') {
      setupShell(T('Stage {n}: {name}', { n: content.n, name: T(content.name) }), content,
        el('p', null, content.hint ? T(content.hint) : ''));
    }
    if (!refresh) show('setup');
  }

  /** Display name of a run's content (journey, lesson, challenge, practice, daily). */
  function contentName(c) {
    if (!c) return '';
    if (c.difficulty) return T('Practice — {difficulty}', { difficulty: T(c.difficulty) });
    if (c.key && /^daily/.test(c.id || '')) return T('Daily Vein — {date}', { date: c.key });
    if (c.n) return T('Stage {n}: {name}', { n: c.n, name: T(c.name) });
    return T(c.name || c.id);
  }

  function lessonToContent(ls) {
    return {
      id: ls.id, name: ls.name, version: ls.version, seed: R.hashString('deepworks.' + ls.id),
      theme: ls.theme, overrides: ls.ruleset, goals: null, limits: null,
      parSec: ls.parSec, endless: false, setup: ls.setup, lesson: ls
    };
  }
  function practiceDesc(id) {
    return T({
      prospector: N('Gentle start: extra credits, cheap hires, two open seams.'),
      miner: N('The standard ruleset, from scratch.'),
      foreman: N('Tighter: pricier labour and unlocks, weaker lift.'),
      overseer: N('Brutal: minimal crew, expensive everything, six sealed seams.')
    }[id] || '');
  }
  function goalText(g) {
    if (!g) return T('Endless — bank your score when you like');
    if (g.type === 'earn') return T('Earn {amount} credits', { amount: R.formatCoins(g.amount) });
    if (g.type === 'depth') return T('Unlock {n} layers', { n: g.amount });
    if (g.type === 'rate') return T('Reach {rate} ore/s extraction', { rate: R.formatOre(g.amount) });
    return '—';
  }
  function mechanicsText(m) {
    var out = [];
    out.push(m.lift ? T('lift') : T('no lift upgrades'));
    if (m.flares) out.push(T('flares'));
    if (m.foreman) out.push(T('foreman'));
    if (!m.shaftUpgrades) out.push(T('no shaft upgrades'));
    return out.join(' · ');
  }

  // -------------------------------------------------------------- journey ---
  function buildJourney() {
    var st = H.getState();
    var p = st.profile;
    var grid = $('journey-grid');
    grid.innerHTML = '';
    var done = 0, stars = 0;
    var firstIncomplete = -1;
    C.JOURNEY.forEach(function (s, i) {
      var rec = p.journey[s.id];
      if (rec) { done++; stars += rec.stars; } else if (firstIncomplete < 0) firstIncomplete = i;
      var node = el('button', 'jnode');
      var locked = i > 0 && !p.journey[C.JOURNEY[i - 1].id] && !rec;
      node.classList.toggle('locked', locked);
      node.classList.toggle('done', !!rec);
      node.classList.toggle('current', i === firstIncomplete);
      node.appendChild(el('span', null, String(s.n)));
      node.appendChild(el('span', 'stars', rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : ''));
      node.title = T(s.name) + (locked ? ' ' + T('(complete the previous stage)') : '');
      node.setAttribute('aria-label', rec ? T('Stage {n} {name}, completed, {stars} stars', { n: s.n, name: T(s.name), stars: rec.stars })
        : T(locked ? 'Stage {n} {name}, locked' : 'Stage {n} {name}', { n: s.n, name: T(s.name) }));
      if (!locked) node.addEventListener('click', function () { H.audio('ui_click'); openSetup('journey-go', s); });
      else node.disabled = true;
      grid.appendChild(node);
    });
    $('journey-summary').textContent = T('{done} of {total} stages complete · {stars} of {maxStars} stars', {
      done: done, total: C.JOURNEY.length, stars: stars, maxStars: C.JOURNEY.length * 3 });
  }

  // --------------------------------------------------------------- boards ---
  function buildBoards() {
    var panel = $('boards-panel');
    panel.innerHTML = '';
    panel.appendChild(el('h2', null, T('Leaderboards')));
    var st = H.getState();
    var note = el('p', 'subtle', st.platform.hosted ?
      T('StarHermit high-score board: Journey, Daily and Challenge run scores.') :
      T('Offline mode: boards are local to this device and marked casual.'));
    panel.appendChild(note);

    var tabs = el('div', 'action-row');
    var body = el('div');
    (st.platform.hosted ? ['high-score'] : ['daily', 'global']).forEach(function (board, i) {
      var t = btn(board === 'daily' ? T('Daily') : board === 'global' ? T('All-time') : T('High score'), i === 0 ? 'selected' : 'ghost', function () {
        tabs.querySelectorAll('.btn').forEach(function (x) { x.className = 'btn ghost'; });
        t.className = 'btn selected';
        loadBoard(board, body);
      });
      tabs.appendChild(t);
    });
    panel.appendChild(tabs);
    panel.appendChild(body);
    panel.appendChild(btn(T('Back'), 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    loadBoard(st.platform.hosted ? 'high-score' : 'daily', body);
  }
  function loadBoard(board, body) {
    body.innerHTML = '';
    body.appendChild(el('p', 'subtle', T('Loading…')));
    root.DWPlatform.getBoard(board).then(function (res) {
      body.innerHTML = '';
      if (res.casual) body.appendChild(el('p', 'subtle', T('Casual board (no server validation).')));
      if (!res.entries || !res.entries.length) { body.appendChild(el('p', null, T('No entries yet. Be the first.'))); return; }
      var table = el('table', 'board');
      var head = el('thead'), hr = el('tr');
      ['#', T('Prospector'), T('Score'), T('Duration')].forEach(function (h) { hr.appendChild(el('th', null, h)); });
      head.appendChild(hr); table.appendChild(head);
      var tb = el('tbody');
      var me = H.getState().profile.displayName;
      res.entries.slice(0, 25).forEach(function (e2, i) {
        var tr = el('tr', (e2.me != null ? e2.me : e2.name === me) ? 'me' : null);
        [String(e2.rank || i + 1), e2.name || T('Anonymous'), R.formatCoins(e2.score), e2.durationSec != null ? fmtTime(e2.durationSec) : '—']
          .forEach(function (v) { tr.appendChild(el('td', null, v)); });
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      body.appendChild(table);
    });
  }

  // ----------------------------------------------------------------- help ---
  // Rule cards generated from current control mappings and legal states.
  function buildHelp() {
    var body = $('help-body');
    body.innerHTML = '';
    var st = H.getState();
    var km = {};
    ['assign', 'unassign', 'hire', 'shaft', 'liftCap', 'liftSpeed', 'unlock', 'flare', 'foreman', 'undo', 'up', 'down', 'pause'].forEach(function (a) { km[a] = st.keyLabel(a); });
    var cards = [
      [T('The loop'), T('Workers dig ore into bins. The lift hauls ore to the surface and sells it for credits. Credits buy workers, shaft upgrades, lift upgrades and deeper seams. Find the bottleneck, fix it, automate.')],
      [T('Workers'), T('Assign ({assign}) moves an idle worker to the selected layer. Unassign ({unassign}) pulls one back. Hire ({hire}) adds a new worker — they arrive idle.', km)],
      [T('Shafts'), T("Upgrading a layer's shaft ({shaft}) raises its extraction rate and its ore bin capacity.", km)],
      [T('Transport'), T('Ore only earns when the lift moves it. Upgrade capacity ({liftCap}) for bigger loads and speed ({liftSpeed}) for shorter cycles. A full bin stalls digging — the gauge turns red.', km)],
      [T('Deeper seams'), T('Unlock ({unlock}) the next sealed layer. Deeper ore is richer per worker and sells for more — but it all rides the same lift.', km)],
      [T('Seam flares'), T('Occasionally a seam flares bright. Claim it ({flare}) before it fades for an instant payout. Flare timing comes from the run seed — it is identical for everyone on a daily.', km)],
      [T('The Foreman'), T('A one-time purchase that automates routine: assigns idle workers and buys bottleneck fixes on a fixed cadence. You keep strategy; it keeps the floor.')],
      [T('Fair play'), T('All randomness is seeded and inspectable. No purchases affect power. Practice allows undo ({undo}); ranked modes never do.', km)],
      [T('Controls'), T("Pointer/touch: tap a layer to select, then use the Foreman's Panel. Keyboard: {up}/{down} select layer, {assign} assign, {pause} pause. Gamepad: D-pad select, A confirm, B back, Start pause.", km)]
    ];
    cards.forEach(function (c) {
      var card = el('div', 'card');
      card.style.cursor = 'default';
      card.appendChild(el('h3', null, c[0]));
      card.appendChild(el('p', null, c[1]));
      body.appendChild(card);
    });
    var nar = btn(T('Describe the current mine aloud'), 'ghost small', function () {
      var s = H.getState();
      if (s.run) announce(R.describeState(s.run.state, T), true);
      else announce(T('No shift in progress.'), true);
    });
    body.appendChild(nar);
  }

  // -------------------------------------------------------------- profile ---
  var ACHIEVEMENTS = [
    { key: 'first_completion', name: N('First Shift Done'), desc: N('Complete any stage or lesson.') },
    { key: 'mechanic_mastery', name: N('Every Lever'), desc: N('Complete all five lessons.') },
    { key: 'streak_7', name: N('Seven Suns Down'), desc: N('Dig the Daily Vein on 7 different days.') },
    { key: 'deep_milestone', name: N('Bottom of the Works'), desc: N('Open the sixth seam in any run.') },
    { key: 'long_haul', name: N('The Long Haul'), desc: N('Earn 10,000,000 credits across your career.') }
  ];
  function buildProfile() {
    var panel = $('profile-panel');
    panel.innerHTML = '';
    var st = H.getState();
    var p = st.profile;
    panel.appendChild(el('h2', null, T('Profile')));
    var nameRow = el('div', 'set-row');
    var nameInput = el('input');
    nameInput.type = 'text'; nameInput.value = p.displayName; nameInput.maxLength = 24;
    nameInput.setAttribute('aria-label', T('Display name'));
    if (st.platform.hosted) nameInput.disabled = true; // account nickname; offline fallback stays editable
    nameRow.appendChild(nameInput);
    nameRow.appendChild(btn(T('Save'), 'small', function () {
      H.setDisplayName(nameInput.value.trim() || 'Guest Prospector');
      toast(T('Name saved'), 'good');
    }));
    panel.appendChild(nameRow);

    var ml = root.DWSession.masteryLevelFor(p.mastery.xp);
    panel.appendChild(el('h3', null, T('Mastery — level {n}', { n: ml.level })));
    var m = el('div', 'meter big'); var mf = el('div');
    mf.style.width = Math.floor((ml.into / ml.next) * 100) + '%';
    m.appendChild(mf); panel.appendChild(m);
    panel.appendChild(el('p', 'subtle', T('{into} / {next} xp', { into: ml.into, next: ml.next })));

    panel.appendChild(el('h3', null, T('Career')));
    panel.appendChild(kv(T('Shifts played'), String(p.stats.runsPlayed)));
    panel.appendChild(kv(T('Career earnings'), R.formatCoins(p.stats.totalEarned)));
    panel.appendChild(kv(T('Flares claimed'), String(p.stats.flaresClaimed)));
    panel.appendChild(kv(T('Time underground'), fmtTime(p.stats.playtimeSec)));

    panel.appendChild(el('h3', null, T('Achievements')));
    ACHIEVEMENTS.forEach(function (a) {
      var row = el('div', 'set-row');
      var got = !!p.achievements[a.key];
      row.appendChild(el('span', null, (got ? '★ ' : '☆ ') + T(a.name)));
      row.appendChild(el('span', 'subtle', T(a.desc)));
      panel.appendChild(row);
    });

    if (!st.platform.hosted) {
      panel.appendChild(el('p', 'subtle', T('Guest mode: sign-in is offered by the host shell when Deepworks is played hosted.')));
    }
    panel.appendChild(btn(T('Back'), 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
  }

  // -------------------------------------------------------------- settings ---
  var settingsInPause = false;
  // refresh: rebuild the game's own panel (language change) without navigating.
  // Only #settings-panel is rebuilt; the shared Language / Sound / Report
  // sections that game-options.js appends to the settings screen stay.
  function openSettings(inPause, refresh) {
    settingsInPause = !!inPause;
    var panel = $('settings-panel');
    panel.innerHTML = '';
    var st = H.getState();
    var s = st.settings;

    panel.appendChild(el('h2', null, inPause ? T('Paused') : T('Settings')));
    if (inPause) {
      var row0 = el('div', 'action-row');
      row0.appendChild(btn(T('Resume'), 'primary', function () { H.resume(); }));
      row0.appendChild(btn(T('Restart shift'), 'ghost', function () {
        confirmModal(T('Restart this shift from the beginning?'), function () { H.restartRun(); });
      }));
      if (st.run && st.run.mode === 'practice') {
        row0.appendChild(btn(T('End shift & bank score'), 'ghost', function () {
          confirmModal(T('End this shift and bank your score?'), function () { H.endRun(); });
        }));
      }
      row0.appendChild(btn(T('Leave shift'), 'ghost', function () {
        confirmModal(T('Leave the shift? Progress in this run will be lost.'), function () { H.leaveRun(); });
      }));
      panel.appendChild(row0);
    }

    function group(title) { var g = el('div', 'set-group'); g.appendChild(el('h3', null, title)); panel.appendChild(g); return g; }
    function slider(g, label, key, min, max, step) {
      var row = el('div', 'set-row');
      var lab = el('label', null, label);
      var input = el('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = s[key];
      input.setAttribute('aria-label', label);
      input.addEventListener('input', function () { s[key] = parseFloat(input.value); H.settingsChanged(); });
      row.appendChild(lab); row.appendChild(input);
      g.appendChild(row);
    }
    function toggle(g, label, key) {
      var row = el('div', 'set-row');
      var lab = el('label', null, label);
      var input = el('input');
      input.type = 'checkbox'; input.checked = !!s[key];
      input.setAttribute('aria-label', label);
      input.addEventListener('change', function () { s[key] = input.checked; H.settingsChanged(); });
      row.appendChild(lab); row.appendChild(input);
      g.appendChild(row);
    }
    function select(g, label, key, options) {
      var row = el('div', 'set-row');
      var lab = el('label', null, label);
      var input = el('select');
      input.setAttribute('aria-label', label);
      options.forEach(function (o) {
        var op = el('option', null, o[1]); op.value = o[0];
        if (s[key] === o[0]) op.selected = true;
        input.appendChild(op);
      });
      input.addEventListener('change', function () { s[key] = input.value; H.settingsChanged(); });
      row.appendChild(lab); row.appendChild(input);
      g.appendChild(row);
    }

    var ga = group(T('Audio'));
    slider(ga, T('Music'), 'volMusic', 0, 1, 0.05);
    slider(ga, T('Effects'), 'volEffects', 0, 1, 0.05);
    slider(ga, T('Ambience'), 'volAmbience', 0, 1, 0.05);
    slider(ga, T('Voice cues'), 'volVoice', 0, 1, 0.05);
    toggle(ga, T('Mute all'), 'muted');
    toggle(ga, T('Text captions for sounds'), 'captions');

    var gg = group(GFX.t(gfxLocale(), 'graphics'));
    gg.id = 'gfx-section';
    buildGraphics(gg, s);
    select(gg, T('Mine theme'), 'theme', C.THEMES.map(function (t) { return [t.id, T(t.name)]; }));
    toggle(gg, T('Reduced motion'), 'reducedMotion');
    toggle(gg, T('Camera sway'), 'cameraSway');

    var gc = group(T('Controls'));
    toggle(gc, T('Hold to repeat assign'), 'holdRepeat');
    toggle(gc, T('Left-handed layout'), 'leftHanded');
    toggle(gc, T('Haptics (vibration)'), 'haptics');
    gc.appendChild(el('p', 'subtle', T('Keys: ↑/↓ select layer · Enter assign · U unassign · H hire · Q shaft · W lift capacity · E lift speed · D unlock · F flare · G foreman · Z undo · Esc pause.')));

    var gx = group(T('Accessibility'));
    toggle(gx, T('High contrast'), 'highContrast');
    toggle(gx, T('Larger text'), 'largeText');
    select(gx, T('Color palette'), 'palette', [['default', T('Default')], ['deuter', T('Deuteranopia-safe')], ['protan', T('Protanopia-safe')], ['tritan', T('Tritanopia-safe')]]);
    toggle(gx, T('Timing assistance (longer flares — not in the ranked daily)'), 'timingAssist');
    var replayRow = el('div', 'set-row');
    replayRow.appendChild(el('label', null, T('Tutorial')));
    replayRow.appendChild(btn(T('Replay lessons'), 'small ghost', function () { openSetup('learn'); }));
    gx.appendChild(replayRow);

    var gd = group(T('Data'));
    toggle(gd, T('Anonymous usage stats (start / round end / errors only)'), 'telemetry');
    var wipe = el('div', 'set-row');
    wipe.appendChild(el('label', null, T('Local data')));
    wipe.appendChild(btn(T('Erase profile'), 'small ghost', function () {
      confirmModal(T('Erase all local progress, settings and unlocks?'), function () { H.wipeProfile(); });
    }));
    gd.appendChild(wipe);

    panel.appendChild(btn(inPause ? T('Resume') : T('Back'), 'ghost back-btn', function () {
      H.audio('ui_back');
      if (inPause) H.resume(); else back();
    }));
    if (!refresh) show('settings');
  }

  // Graphics section: quality preset, render scale, per-effect overrides,
  // adaptive resolution, frame-rate readout and a cost summary. Strings follow
  // the game language (js/gfx.js STRINGS, locale from js/i18n.js).
  function buildGraphics(host, s) {
    var loc = gfxLocale();
    var G = function (k, v) { return GFX.t(loc, k, v); };
    var box = el('div', 'gfx-box');
    host.appendChild(box);
    var summary, note;

    function commit() { H.graphicsChanged(); updateSummary(); }
    function updateSummary() {
      var info = H.graphicsInfo && H.graphicsInfo();
      if (!summary) return;
      if (!info) { summary.textContent = G('post_unavailable'); return; }
      summary.textContent = (info.gpu || G('unknown_gpu')) + ' · ' + GFX.describe(info.resolved, info.pixels, loc);
      note.hidden = !(info.resolved.post && info.postError);
    }
    function row(label, id, control, extra) {
      var r = el('div', 'set-row');
      var lab = el('label', null, label);
      lab.htmlFor = id;
      control.id = id;
      control.setAttribute('aria-label', label);
      r.appendChild(lab); r.appendChild(control);
      if (extra) r.appendChild(extra);
      box.appendChild(r);
      return control;
    }
    function selectEl(options, value) {
      var sel = el('select');
      options.forEach(function (o) {
        var op = el('option', null, o[1]); op.value = o[0];
        if (o[0] === value) op.selected = true;
        sel.appendChild(op);
      });
      return sel;
    }
    function checkEl(v) { var c = el('input'); c.type = 'checkbox'; c.checked = !!v; return c; }

    function render() {
      box.innerHTML = '';
      var gs = s.gfx || (s.gfx = { preset: 'auto' });
      var info = H.graphicsInfo && H.graphicsInfo();
      var detected = info ? info.detected : 'balanced';
      var r = GFX.resolve(gs, detected);

      var presetSel = row(G('quality'), 'gfx-preset', selectEl(
        [['auto', G('auto', { t: G('p_' + detected) })]].concat(GFX.PRESETS.map(function (p) { return [p, G('p_' + p)]; })),
        r.auto ? 'auto' : r.preset));
      presetSel.addEventListener('change', function () {
        s.gfx = GFX.choosePreset(s.gfx, presetSel.value); // clears overrides
        commit();
        render();
        var again = $('gfx-preset'); if (again) again.focus();
      });

      var scale = el('input');
      scale.type = 'range'; scale.min = 50; scale.max = 200; scale.step = 5;
      scale.value = Math.round(r.renderScale * 100);
      var val = el('span', 'gfx-val', scale.value + '%');
      val.id = 'gfx-scale-val';
      row(G('render_scale'), 'gfx-scale', scale, val).parentNode.classList.add('gfx-range');
      scale.addEventListener('input', function () {
        val.textContent = scale.value + '%';
        s.gfx.render_scale = Number(scale.value) / 100;
        commit();
      });

      GFX.CATEGORY_ORDER.forEach(function (cat) {
        var own = GFX.presetTier(r.preset, cat);
        var opts = [['preset', G('from_preset', { t: G('t_' + own) })]].concat(
          GFX.CATEGORIES[cat].map(function (tier) { return [tier, G('t_' + tier)]; }));
        var sel = row(G('c_' + cat), 'gfx-cat-' + cat, selectEl(opts, gs[cat] && GFX.CATEGORIES[cat].indexOf(gs[cat]) >= 0 ? gs[cat] : 'preset'));
        sel.dataset.gfxCat = cat;
        sel.addEventListener('change', function () {
          if (sel.value === 'preset') delete s.gfx[cat]; else s.gfx[cat] = sel.value;
          commit();
        });
      });

      var adaptive = row(G('adaptive'), 'gfx-adaptive', checkEl(r.adaptive));
      adaptive.addEventListener('change', function () { s.gfx.adaptive = adaptive.checked; commit(); });
      var fps = row(G('show_fps'), 'gfx-show-fps', checkEl(r.showFps));
      fps.addEventListener('change', function () { s.gfx.show_fps = fps.checked; commit(); });

      summary = el('p', 'subtle gfx-summary');
      summary.id = 'gfx-summary';
      summary.setAttribute('aria-live', 'polite');
      box.appendChild(summary);
      note = el('p', 'subtle gfx-note', G('post_unavailable'));
      note.id = 'gfx-note';
      note.hidden = true;
      box.appendChild(note);
      updateSummary();
    }
    render();
    // adaptive resolution changes the pixel count while the panel is open
    var timer = setInterval(function () {
      if (!document.body.contains(box)) { clearInterval(timer); return; }
      updateSummary();
    }, 1000);
  }

  // -------------------------------------------------------------- results ---
  var lastResults = null;
  // refresh: re-render the open results screen (language change) without
  // re-announcing or re-posting anything.
  function showResults(data, refresh) {
    // data: {run, content, mode, won, reason, score, stars, newBest, achievements:[names], awaySummary?}
    lastResults = data;
    var panel = $('results-panel');
    panel.innerHTML = '';
    var won = data.won && data.reason !== 'player-ended';
    // outcome illustration (decorative; hidden if the asset fails to load)
    var art = el('img', 'result-art');
    art.alt = '';
    art.src = won ? 'assets/shift-complete.webp' : 'assets/shift-over.webp';
    art.addEventListener('error', function () { art.style.display = 'none'; });
    panel.appendChild(art);
    var head = el('h2', won ? 'result-head-win' : 'result-head-lose',
      won ? T('Objective complete') : (data.reason === 'time-up' ? T('Time is up') : data.reason === 'moves-exhausted' ? T('Out of moves') : T('Shift ended')));
    panel.appendChild(head);
    panel.appendChild(el('p', 'subtle', contentName(data.content)));

    if (data.stars) panel.appendChild(el('div', 'stars-big', '★'.repeat(data.stars) + '☆'.repeat(3 - data.stars)));
    panel.appendChild(el('div', 'score-big', R.formatCoins(data.score.total)));
    panel.appendChild(el('p', 'subtle', T('final score')));

    var bd = el('div', 'breakdown');
    bd.appendChild(el('h3', null, T('Score breakdown')));
    var comp = data.score.components;
    bd.appendChild(kv(T('Ore sold'), R.formatCoins(comp.earned)));
    bd.appendChild(kv(T('Seam flares'), R.formatCoins(comp.flares)));
    bd.appendChild(kv(T('Depth bonus'), R.formatCoins(comp.depthBonus)));
    bd.appendChild(kv(T('Time bonus'), R.formatCoins(comp.timeBonus)));
    bd.appendChild(kv(T('Lift efficiency'), (comp.efficiencyPermille / 10).toFixed(1) + '%'));
    bd.appendChild(kv(T('Elapsed'), fmtTime(data.run.result.tick)));
    bd.appendChild(kv(T('Commands / invalid'), data.run.result.moves + ' / ' + data.run.result.invalid));
    panel.appendChild(bd);

    if (data.newBest) panel.appendChild(el('p', null, T('★ New personal best!')));
    if (data.achievements && data.achievements.length) {
      panel.appendChild(el('p', null, T('Achievement unlocked: {name}', { name: data.achievements.map(function (n) { return T(n); }).join(', ') })));
    }
    if (data.boardResult) {
      panel.appendChild(el('p', 'subtle', T(data.boardResult)));
    }
    if (data.leaderboard) {
      var lb = el('p', 'subtle');
      lb.id = 'results-lb';
      lb.setAttribute('aria-live', 'polite');
      var lbText = function () {
        var r = data.leaderboard.result;
        lb.textContent = !r ? T('Posting score to the leaderboard…') : !r.posted ? T('Score not posted to the leaderboard.')
          : r.rank ? T('Leaderboard rank: #{rank}', { rank: r.rank }) : T('Score posted to the leaderboard.');
      };
      lbText();
      panel.appendChild(lb);
      if (!refresh) data.leaderboard.promise.then(function (r) { data.leaderboard.result = r; var cur = $('results-lb'); if (cur) { lb = cur; lbText(); } });
    }

    var row = el('div', 'action-row');
    if (data.nextContent) {
      row.appendChild(btn(T('Next: {name}', { name: T(data.nextContent.name) }), 'primary', function () { H.startRun(data.nextContent, data.mode); }));
    }
    row.appendChild(btn(T('Retry'), data.nextContent ? 'ghost' : 'primary', function () {
      root.DWPlatform.track('retry', { content: data.content.id });
      H.startRun(data.content, data.mode);
    }));
    row.appendChild(btn(T('Shift select'), 'ghost', function () { H.leaveToTitle(); }));
    panel.appendChild(row);

    if (refresh) return;
    announce(T('{headline}. Score {score}.', { headline: head.textContent, score: R.formatCoins(data.score.total) }), true);
    setScreen('results');
  }

  // ------------------------------------------------------------------ HUD ---
  function showPlay() { setScreen('play'); lastHudSig = ''; lastRailSig = ''; }

  function updateHUD(model) {
    // model: {state, content, mode, selectedLayer, lessonStep, legal}
    var st = model.state;
    $('res-credits').textContent = R.formatCoins(st.coins);
    $('res-income').textContent = T('{n}/s', { n: R.formatCoins(R.incomeRate(st)) });
    $('res-workers').textContent = st.workers.idle + '/' + st.workers.total;

    var lim = st.ruleset.limits;
    var timeText = fmtTime(st.tick);
    if (lim && lim.timeSec) timeText = fmtTime(Math.max(0, lim.timeSec - st.tick));
    $('hud-timer').textContent = timeText + ((lim && lim.moves) ? ' · ' + T('{n} moves', { n: Math.max(0, lim.moves - st.stats.playerCommands) }) : '');

    // objective
    var g = st.ruleset.goals;
    var objText = model.objectiveText || goalText(g);
    $('objective-text').textContent = objText;
    var bar = $('objective-bar'), fill = $('objective-fill');
    var frac = goalFraction(st, g);
    if (frac !== null) {
      bar.hidden = false;
      fill.style.width = Math.min(100, Math.floor(frac * 100)) + '%';
    } else bar.hidden = true;

    // lesson banner
    var banner = $('lesson-banner');
    if (model.lessonStep) {
      banner.classList.remove('hidden');
      banner.textContent = model.lessonStep;
    } else banner.classList.add('hidden');

    // rails — rebuild only when signature changes (protects focus)
    var railSig = JSON.stringify([
      st.coins, st.workers.idle, st.workers.total, model.selectedLayer,
      st.hires, st.lift.capLevel, st.lift.speedLevel, st.foreman,
      st.layers.map(function (L) { return [L.unlocked, L.workers, L.shaftLevel, L.milliOre >> 10]; }),
      st.flare.active ? st.flare.active.id : 0, st.tick >> 2, model.mode
    ]);
    if (railSig !== lastRailSig) {
      lastRailSig = railSig;
      buildLeftRail(model);
      buildRightRail(model);
      buildBottomTray(model);
    }
  }

  function goalFraction(st, g) {
    if (!g) return null;
    if (g.type === 'earn') return st.lifetimeEarned / g.amount;
    if (g.type === 'depth') return R.unlockedCount(st) / g.amount;
    if (g.type === 'rate') return R.totalExtractionRate(st) / g.amount;
    return null;
  }

  function buildLeftRail(model) {
    var body = $('left-rail-body');
    body.innerHTML = '';
    var st = model.state;
    body.appendChild(kv(T('Elapsed'), fmtTime(st.tick)));
    body.appendChild(kv(T('Depth'), T('{n} / {total} seams', { n: R.unlockedCount(st), total: st.layers.length })));
    body.appendChild(kv(T('Extraction'), R.formatRate(R.totalExtractionRate(st))));
    body.appendChild(kv(T('Lift capacity'), R.formatRate(Math.floor(R.liftRate(st)))));
    body.appendChild(kv(T('Lifetime earned'), R.formatCoins(st.lifetimeEarned)));
    var g = st.ruleset.goals;
    if (g) {
      body.appendChild(el('h3', null, T('Goal')));
      body.appendChild(kv(goalText(g), Math.floor((goalFraction(st, g) || 0) * 100) + '%'));
    }
    if (st.ruleset.parSec) body.appendChild(kv(T('Par'), fmtTime(st.ruleset.parSec)));
    var hint = el('p', 'subtle', bottleneckHint(st));
    body.appendChild(hint);
  }

  // Make the next useful action obvious without solving the game (spec §1).
  function bottleneckHint(st) {
    for (var i = 0; i < st.layers.length; i++) {
      var L = st.layers[i];
      if (L.unlocked && R.isBlocked(st, i)) return T('Layer {n} bin is full — transport is the bottleneck.', { n: i + 1 });
    }
    if (st.workers.idle > 0) return st.workers.idle > 1 ? T('{n} idle workers — assign them to a seam.', { n: st.workers.idle }) : T('1 idle worker — assign them to a seam.');
    if (st.flare.active) return T('A seam is flaring on Layer {n} — claim it!', { n: st.flare.active.layer + 1 });
    var next = R.nextLockedLayer(st);
    if (next >= 0 && st.coins >= R.unlockCost(st)) return T('You can afford to open Layer {n}.', { n: next + 1 });
    return T('Watch the gauges; upgrade whatever lags.');
  }

  function actionButton(cmd, label, cost, legal, extra) {
    var b = btn('', null, function () { H.command(cmd); });
    var span = el('span', null, label);
    b.appendChild(span);
    if (cost !== undefined && cost !== null) {
      var c = el('span', 'cost', ' ' + R.formatCoins(cost));
      b.appendChild(c);
    }
    if (extra) b.appendChild(el('span', 'reason', extra));
    var enabled = legal.enabled;
    b.disabled = !enabled;
    if (!enabled) {
      b.title = reasonText(legal.reason);
      var cEl = b.querySelector('.cost');
      if (cEl && legal.reason === R.REASONS.INSUFFICIENT_FUNDS) cEl.classList.add('cant');
    }
    return b;
  }
  function reasonText(reason) {
    var map = {};
    map[R.REASONS.NO_IDLE_WORKER] = N('No idle workers — hire or unassign first.');
    map[R.REASONS.LAYER_LOCKED] = N('That layer is still sealed.');
    map[R.REASONS.WORKER_CAP] = N('This seam is fully crewed.');
    map[R.REASONS.NO_WORKERS] = N('No workers assigned here.');
    map[R.REASONS.INSUFFICIENT_FUNDS] = N('Not enough credits.');
    map[R.REASONS.ALL_UNLOCKED] = N('Every seam is open.');
    map[R.REASONS.NO_FLARE] = N('No active flare.');
    map[R.REASONS.MECHANIC_DISABLED] = N('Not available in this ruleset.');
    map[R.REASONS.ALREADY_OWNED] = N('Already owned.');
    return T(map[reason] || reason || '');
  }

  function findLegal(model, type, layer) {
    for (var i = 0; i < model.legal.length; i++) {
      var a = model.legal[i];
      if (a.type === type && (layer === undefined || a.layer === layer)) return a;
    }
    return { enabled: false, reason: 'unavailable' };
  }

  function buildRightRail(model) {
    var body = $('right-rail-body');
    body.innerHTML = '';
    var st = model.state;
    var sel = model.selectedLayer;

    if (sel !== null && st.layers[sel] && st.layers[sel].unlocked) {
      var L = st.layers[sel];
      var gsel = el('div', 'action-group');
      gsel.appendChild(el('h3', null, T('Layer {n}', { n: sel + 1 })));
      gsel.appendChild(kv(T('Crew'), L.workers + ' / ' + st.ruleset.workerCapPerLayer));
      gsel.appendChild(kv(T('Rate'), R.formatRate(R.layerRate(st, sel))));
      var cap = R.binCapMilli(st, sel);
      gsel.appendChild(kv(T('Bin'), Math.floor((L.milliOre * 100) / cap) + '%' + (R.isBlocked(st, sel) ? ' — ' + T('BLOCKED') : '')));
      gsel.appendChild(kv(T('Shaft level'), String(L.shaftLevel)));
      var row = el('div', 'action-row');
      row.appendChild(holdable(actionButton({ type: 'assign', layer: sel }, T('+ Assign'), null, findLegal(model, 'assign', sel))));
      row.appendChild(actionButton({ type: 'unassign', layer: sel }, T('− Recall'), null, findLegal(model, 'unassign', sel)));
      gsel.appendChild(row);
      var row2 = el('div', 'action-row');
      row2.appendChild(actionButton({ type: 'upgrade_shaft', layer: sel }, T('Upgrade shaft'), R.shaftCost(st, sel), findLegal(model, 'upgrade_shaft', sel)));
      gsel.appendChild(row2);
      if (st.flare.active && st.flare.active.layer === sel) {
        var rowF = el('div', 'action-row');
        rowF.appendChild(actionButton({ type: 'claim_flare', layer: sel, id: st.flare.active.id }, T('✦ Claim flare'), null, findLegal(model, 'claim_flare', sel)));
        gsel.appendChild(rowF);
      }
      body.appendChild(gsel);
    } else {
      body.appendChild(el('p', 'subtle', T('Tap a layer in the mine to crew and upgrade it.')));
    }

    var gg = el('div', 'action-group');
    gg.appendChild(el('h3', null, T('Mine-wide')));
    var r1 = el('div', 'action-row');
    r1.appendChild(actionButton({ type: 'hire' }, T('Hire worker'), R.hireCost(st), findLegal(model, 'hire')));
    gg.appendChild(r1);
    var r2 = el('div', 'action-row');
    r2.appendChild(actionButton({ type: 'upgrade_lift_cap' }, T('Lift capacity'), R.liftCapCost(st), findLegal(model, 'upgrade_lift_cap')));
    r2.appendChild(actionButton({ type: 'upgrade_lift_speed' }, T('Lift speed'), R.liftSpeedCost(st), findLegal(model, 'upgrade_lift_speed')));
    gg.appendChild(r2);
    var nextIdx = R.nextLockedLayer(st);
    if (nextIdx >= 0) {
      var r3 = el('div', 'action-row');
      r3.appendChild(actionButton({ type: 'unlock_layer' }, T('Open Layer {n}', { n: nextIdx + 1 }), R.unlockCost(st), findLegal(model, 'unlock_layer')));
      gg.appendChild(r3);
    }
    if (st.ruleset.mechanics.foreman) {
      var r4 = el('div', 'action-row');
      if (!st.foreman.unlocked) {
        r4.appendChild(actionButton({ type: 'buy_foreman' }, T('Buy Foreman'), st.ruleset.foremanCost, findLegal(model, 'buy_foreman')));
      } else {
        var t = btn(st.foreman.enabled ? T('Foreman: ON') : T('Foreman: off'), st.foreman.enabled ? 'selected' : 'ghost',
          function () { H.command({ type: 'toggle_foreman' }); });
        r4.appendChild(t);
      }
      gg.appendChild(r4);
    }
    if (model.mode === 'practice') {
      var r5 = el('div', 'action-row');
      var ub = btn(T('Undo (Z)'), 'ghost', function () { H.undo(); });
      ub.disabled = !model.canUndo;
      r5.appendChild(ub);
      gg.appendChild(r5);
    }
    body.appendChild(gg);
  }

  function buildBottomTray(model) {
    var tray = $('hud-bottom');
    tray.innerHTML = '';
    var st = model.state;
    var sel = model.selectedLayer;
    if (sel !== null && st.layers[sel] && st.layers[sel].unlocked) {
      tray.appendChild(holdable(actionButton({ type: 'assign', layer: sel }, T('+ Assign'), null, findLegal(model, 'assign', sel))));
      tray.appendChild(actionButton({ type: 'upgrade_shaft', layer: sel }, T('Shaft'), R.shaftCost(st, sel), findLegal(model, 'upgrade_shaft', sel)));
    }
    tray.appendChild(actionButton({ type: 'hire' }, T('Hire'), R.hireCost(st), findLegal(model, 'hire')));
    if (R.nextLockedLayer(st) >= 0) {
      tray.appendChild(actionButton({ type: 'unlock_layer' }, T('Open L{n}', { n: R.nextLockedLayer(st) + 1 }), R.unlockCost(st), findLegal(model, 'unlock_layer')));
    }
    if (st.flare.active) {
      tray.appendChild(actionButton({ type: 'claim_flare', layer: st.flare.active.layer, id: st.flare.active.id },
        T('✦ Flare L{n}', { n: st.flare.active.layer + 1 }), null, findLegal(model, 'claim_flare', st.flare.active.layer)));
    }
  }

  // hold-to-repeat wrapper (accessibility setting: hold vs toggle)
  function holdable(b) {
    var st = H.getState();
    if (!st.settings.holdRepeat) return b;
    var timer = null;
    b.addEventListener('pointerdown', function () {
      timer = setInterval(function () { if (!b.disabled) b.click(); }, 260);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      b.addEventListener(ev, function () { if (timer) { clearInterval(timer); timer = null; } });
    });
    return b;
  }

  // ---------------------------------------------------------- layer labels ---
  function positionLabels(renderer, st, selectedLayer) {
    var host = $('layer-labels');
    var n = st.layers.length;
    while (labelEls.length < n) {
      (function (idx) {
        var d = el('button', 'layer-label');
        d.addEventListener('click', function () { H.selectLayer(idx); });
        labelEls.push(d);
        host.appendChild(d);
      })(labelEls.length);
    }
    while (labelEls.length > n) { host.removeChild(labelEls.pop()); }
    for (var i = 0; i < n; i++) {
      var L = st.layers[i];
      var d = labelEls[i];
      var pos = renderer.screenPosForLayer(i);
      if (!pos) { d.style.display = 'none'; continue; }
      d.style.display = '';
      // pos is in viewport px; #layer-labels is zoomed by UIScale
      var z = (root.UIScale && root.UIScale.value) || 1;
      d.style.left = (pos.x / z) + 'px';
      d.style.top = (pos.y / z) + 'px';
      d.classList.toggle('selected', i === selectedLayer);
      var blocked = L.unlocked && R.isBlocked(st, i);
      d.classList.toggle('blocked', blocked);
      var flare = st.flare.active && st.flare.active.layer === i;
      d.classList.toggle('flare', !!flare);
      var text = T('L{n}', { n: i + 1 });
      if (!L.unlocked) text += ' 🔒';
      else {
        text += ' ⚒' + L.workers;
        if (blocked) text += ' ▲' + T('FULL');
        if (flare) text += ' ✦';
      }
      d.textContent = text;
    }
  }

  // -------------------------------------------------------------- feedback ---
  function toast(msg, kind) {
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    var root = $('toast-root');
    root.appendChild(t);
    syncToastH();
    setTimeout(function () { t.remove(); syncToastH(); }, 2600);
  }
  // Toast stack height (layout px) so short landscape screens can keep their
  // panel clear of the toasts that float at the top while a screen is up.
  function syncToastH() {
    var root = $('toast-root');
    document.documentElement.style.setProperty('--toast-h', (root.childElementCount ? root.offsetHeight + 8 : 0) + 'px');
  }
  function announce(msg, assertive) {
    $(assertive ? 'live-assertive' : 'live-polite').textContent = msg;
  }
  function caption(text) {
    if (!H.getState().settings.captions) return;
    var c = $('caption-root');
    c.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { c.textContent = ''; }, 2200);
  }

  function confirmModal(msg, onYes) {
    openModal(function (close) {
      var m = el('div', 'modal');
      m.setAttribute('role', 'alertdialog');
      m.setAttribute('aria-label', msg);
      m.appendChild(el('p', null, msg));
      var row = el('div', 'action-row');
      row.appendChild(btn(T('Confirm'), 'primary', function () { close(); onYes(); }));
      row.appendChild(btn(T('Cancel'), 'ghost', function () { close(); }));
      m.appendChild(row);
      return m;
    });
  }

  function openModal(buildFn) {
    var rootEl = $('modal-root');
    var prevFocus = document.activeElement;
    function close() {
      rootEl.innerHTML = '';
      document.removeEventListener('keydown', escHandler, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    }
    function escHandler(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
      // simple focus trap
      if (ev.key === 'Tab') {
        var focusables = rootEl.querySelectorAll('button, input, select, [tabindex]');
        if (!focusables.length) return;
        var first = focusables[0], last = focusables[focusables.length - 1];
        if (ev.shiftKey && document.activeElement === first) { last.focus(); ev.preventDefault(); }
        else if (!ev.shiftKey && document.activeElement === last) { first.focus(); ev.preventDefault(); }
      }
    }
    document.addEventListener('keydown', escHandler, true);
    rootEl.appendChild(buildFn(close));
    var f = rootEl.querySelector('button, input');
    if (f) f.focus();
  }
  function closeModal() { $('modal-root').innerHTML = ''; }

  function showCountdown(text) {
    var c = $('countdown');
    if (text === null) { c.classList.add('hidden'); return; }
    c.classList.remove('hidden');
    c.textContent = text;
  }

  // The game language changed: re-render whatever is on screen in place.
  // Navigation history, the run and its HUD state are untouched.
  function relabel() {
    buildModeGrid();
    tickDailyCountdown();
    var builder = SCREEN_BUILDERS[current];
    if (builder) builder();
    if (current === 'setup' && lastSetup) openSetup(lastSetup.mode, lastSetup.content, true);
    if (current === 'settings') openSettings(settingsInPause, true);
    if (current === 'results' && lastResults) showResults(lastResults, true);
    lastRailSig = '';
  }

  function setBootProgress(frac, msg) {
    $('boot-fill').style.width = Math.floor(frac * 100) + '%';
    if (msg) $('boot-status').textContent = msg;
  }

  // --------------------------------------------------------------- helpers ---
  function kv(k, v) {
    var row = el('div', 'kv');
    row.appendChild(el('span', null, k));
    row.appendChild(el('b', null, v));
    return row;
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return m + ':' + String(s).padStart(2, '0');
  }

  root.DWUI = {
    init: init,
    show: show,
    refreshIdentity: function () { show(current); },
    back: back,
    currentScreen: currentScreen,
    openSetup: openSetup,
    openSettings: openSettings,
    showPlay: showPlay,
    showResults: showResults,
    updateHUD: updateHUD,
    positionLabels: positionLabels,
    toast: toast,
    announce: announce,
    caption: caption,
    confirmModal: confirmModal,
    openModal: openModal,
    closeModal: closeModal,
    showCountdown: showCountdown,
    setBootProgress: setBootProgress,
    relabel: relabel,
    contentName: contentName,
    ACHIEVEMENTS: ACHIEVEMENTS
  };
})(typeof self !== 'undefined' ? self : this);
