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

  var H = null;              // handlers
  var navStack = [];
  var current = 'boot';
  var labelEls = [];
  var lastHudSig = '';
  var lastRailSig = '';
  var toastTimer = null;

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
    $('title-identity').textContent = (st.platform.hosted ? 'Signed in as ' : 'Playing as ') +
      p.displayName + (st.platform.hosted ? '' : ' (guest — progress stays on this device)');
    var banner = $('resume-banner');
    var saved = st.savedRun;
    if (saved) {
      banner.classList.remove('hidden');
      banner.innerHTML = '';
      banner.appendChild(el('p', null, 'A previous shift is waiting (' + saved.contentId + ').'));
      var row = el('div', 'action-row');
      row.appendChild(btn('Resume shift', 'primary small', function () { H.resumeSaved(); }));
      row.appendChild(btn('Abandon', 'ghost small', function () { H.discardSaved(); buildTitle(); }));
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
    elx.textContent = '(new in ' + h + 'h ' + m + 'm)';
  }

  // ---------------------------------------------------------------- modes ---
  var MODES = [
    { id: 'learn', name: 'Learn', desc: 'Interactive lessons. One rule at a time — you perform every action.', time: '2–4 min each', ranked: false },
    { id: 'journey', name: 'Journey', desc: '40 authored stages. New mechanics arrive alone, combine, then test mastery.', time: '3–20 min each', ranked: false },
    { id: 'daily', name: 'Daily Vein', desc: 'One shared seed and ruleset per UTC day. Everyone digs the same mine.', time: '15 min cap', ranked: true },
    { id: 'practice', name: 'Practice', desc: 'Free play at your chosen difficulty. Restart and undo allowed. Unranked.', time: 'endless', ranked: false },
    { id: 'challenge', name: 'Challenge', desc: 'Constrained shifts: move limits, speed targets, restricted tools.', time: '10–25 min', ranked: false },
    { id: 'score', name: 'Score Chase', desc: 'Chase the boards — daily and all-time, global or friends.', time: '—', ranked: true }
  ];
  function buildModeGrid() {
    var grid = $('mode-grid');
    grid.innerHTML = '';
    MODES.forEach(function (m) {
      var card = el('button', 'card');
      card.appendChild(el('h3', null, m.name));
      card.appendChild(el('p', null, m.desc));
      var badges = el('p');
      badges.appendChild(el('span', 'badge ' + (m.ranked ? 'ranked' : 'casual'), m.ranked ? 'ranked' : 'casual'));
      badges.appendChild(el('span', 'badge', m.time));
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
  function openSetup(mode, content) {
    var panel = $('setup-panel');
    panel.innerHTML = '';
    var st = H.getState();
    var p = st.profile;

    function setupShell(titleText, contentEntry, extraNode) {
      panel.appendChild(el('h2', null, titleText));
      if (contentEntry) {
        var info = el('div', 'action-group');
        var rs = R.mergeRuleset(contentEntry.overrides || {});
        info.appendChild(kv('Seams', String(rs.layerCount)));
        info.appendChild(kv('Goal', goalText(contentEntry.goals)));
        info.appendChild(kv('Time limit', contentEntry.limits && contentEntry.limits.timeSec ? fmtTime(contentEntry.limits.timeSec) : 'none'));
        info.appendChild(kv('Par', contentEntry.parSec ? fmtTime(contentEntry.parSec) : '—'));
        info.appendChild(kv('Mechanics', mechanicsText(rs.mechanics)));
        info.appendChild(kv('Seed', '#' + (contentEntry.seed >>> 0).toString(36)));
        var ranked = mode === 'daily';
        var badgeRow = el('p');
        badgeRow.appendChild(el('span', 'badge ' + (ranked ? 'ranked' : 'casual'), ranked ? 'ranked — validated replay' : 'casual — unranked'));
        info.appendChild(badgeRow);
        panel.appendChild(info);
      }
      if (extraNode) panel.appendChild(extraNode);
      var row = el('div', 'action-row');
      row.appendChild(btn('Start shift', 'primary', function () { H.startRun(contentEntry, mode); }));
      row.appendChild(btn('Back', 'ghost', function () { H.audio('ui_back'); back(); }));
      panel.appendChild(row);
    }

    if (mode === 'learn') {
      panel.appendChild(el('h2', null, 'Learn'));
      var list = el('div', 'card-grid');
      C.LESSONS.forEach(function (ls, i) {
        var doneL = !!p.lessons[ls.id];
        var locked = i > 0 && !p.lessons[C.LESSONS[i - 1].id] && !st.settings.tutorialAnyOrder;
        var card = el('button', 'card');
        card.appendChild(el('h3', null, (doneL ? '✓ ' : '') + ls.name));
        card.appendChild(el('p', null, ls.intro));
        if (locked) { card.disabled = true; card.appendChild(el('p', 'subtle', 'Complete the previous lesson first.')); }
        card.addEventListener('click', function () { H.audio('ui_click'); openSetup('learn-go', ls); });
        list.appendChild(card);
      });
      panel.appendChild(list);
      panel.appendChild(btn('Back', 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    } else if (mode === 'learn-go') {
      setupShell('Lesson: ' + content.name, lessonToContent(content), el('p', null, content.intro));
    } else if (mode === 'daily') {
      var info = C.dailyInfo(root.DWPlatform.dailyDate());
      var played = p.daily[info.key];
      var extra = el('p', played ? 'subtle' : null,
        played ? ('You already dug today: score ' + R.formatCoins(played.score) + '. You can improve it until the day rolls over.') :
          'Same seed for everyone today. Your input log is validated server-side when hosted.');
      setupShell(info.name, info, extra);
    } else if (mode === 'practice') {
      panel.appendChild(el('h2', null, 'Practice'));
      var grid = el('div', 'card-grid');
      C.PRACTICE_DIFFICULTIES.forEach(function (d) {
        var card = el('button', 'card');
        card.appendChild(el('h3', null, d.name));
        card.appendChild(el('p', null, practiceDesc(d.id)));
        var best = p.practice[d.id];
        if (best) card.appendChild(el('p', 'subtle', 'Best: ' + R.formatCoins(best)));
        card.addEventListener('click', function () {
          H.audio('ui_click');
          openSetup('practice-go', {
            id: 'practice-' + d.id, name: 'Practice — ' + d.name, version: C.CONTENT_VERSION,
            seed: (Math.random() * 0xffffffff) >>> 0, theme: H.getState().settings.theme || 'emberdeep',
            overrides: d.overrides, goals: null, limits: null, parSec: 0, endless: true
          });
        });
        grid.appendChild(card);
      });
      panel.appendChild(grid);
      panel.appendChild(btn('Back', 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    } else if (mode === 'practice-go') {
      setupShell(content.name, content, el('p', 'subtle', 'Endless. Undo allowed (Z). End the shift from the pause menu to bank your score.'));
    } else if (mode === 'challenge') {
      panel.appendChild(el('h2', null, 'Challenges'));
      var clist = el('div', 'card-grid');
      C.CHALLENGES.forEach(function (ch) {
        var card = el('button', 'card');
        card.appendChild(el('h3', null, ch.name));
        card.appendChild(el('p', null, ch.description));
        var bestc = p.challenges[ch.id];
        if (bestc) card.appendChild(el('p', 'subtle', 'Best: ' + R.formatCoins(bestc)));
        card.addEventListener('click', function () { H.audio('ui_click'); openSetup('challenge-go', ch); });
        clist.appendChild(card);
      });
      panel.appendChild(clist);
      panel.appendChild(btn('Back', 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    } else if (mode === 'challenge-go') {
      setupShell('Challenge: ' + content.name, content, el('p', null, content.description));
    } else if (mode === 'journey-go') {
      setupShell('Stage ' + content.n + ': ' + content.name, content,
        el('p', null, content.hint || ''));
    }
    show('setup');
  }

  function lessonToContent(ls) {
    return {
      id: ls.id, name: ls.name, version: ls.version, seed: R.hashString('deepworks.' + ls.id),
      theme: ls.theme, overrides: ls.ruleset, goals: null, limits: null,
      parSec: ls.parSec, endless: false, setup: ls.setup, lesson: ls
    };
  }
  function practiceDesc(id) {
    return {
      prospector: 'Gentle start: extra credits, cheap hires, two open seams.',
      miner: 'The standard ruleset, from scratch.',
      foreman: 'Tighter: pricier labour and unlocks, weaker lift.',
      overseer: 'Brutal: minimal crew, expensive everything, six sealed seams.'
    }[id] || '';
  }
  function goalText(g) {
    if (!g) return 'Endless — bank your score when you like';
    if (g.type === 'earn') return 'Earn ' + R.formatCoins(g.amount) + ' credits';
    if (g.type === 'depth') return 'Unlock ' + g.amount + ' layers';
    if (g.type === 'rate') return 'Reach ' + R.formatOre(g.amount) + ' ore/s extraction';
    return '—';
  }
  function mechanicsText(m) {
    var out = [];
    out.push(m.lift ? 'lift' : 'no lift upgrades');
    if (m.flares) out.push('flares');
    if (m.foreman) out.push('foreman');
    if (!m.shaftUpgrades) out.push('no shaft upgrades');
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
      node.title = s.name + (locked ? ' (complete the previous stage)' : '');
      node.setAttribute('aria-label', 'Stage ' + s.n + ' ' + s.name + (rec ? ', completed, ' + rec.stars + ' stars' : locked ? ', locked' : ''));
      if (!locked) node.addEventListener('click', function () { H.audio('ui_click'); openSetup('journey-go', s); });
      else node.disabled = true;
      grid.appendChild(node);
    });
    $('journey-summary').textContent = done + ' of ' + C.JOURNEY.length + ' stages complete · ' +
      stars + ' of ' + (C.JOURNEY.length * 3) + ' stars';
  }

  // --------------------------------------------------------------- boards ---
  function buildBoards() {
    var panel = $('boards-panel');
    panel.innerHTML = '';
    panel.appendChild(el('h2', null, 'Leaderboards'));
    var st = H.getState();
    var note = el('p', 'subtle', st.platform.hosted ?
      'Validated boards: daily scores are replay-checked server-side.' :
      'Offline mode: boards are local to this device and marked casual.');
    panel.appendChild(note);

    var tabs = el('div', 'action-row');
    var body = el('div');
    ['daily', 'global'].forEach(function (board, i) {
      var t = btn(board === 'daily' ? 'Daily' : 'All-time', i === 0 ? 'selected' : 'ghost', function () {
        tabs.querySelectorAll('.btn').forEach(function (x) { x.className = 'btn ghost'; });
        t.className = 'btn selected';
        loadBoard(board, body);
      });
      tabs.appendChild(t);
    });
    panel.appendChild(tabs);
    panel.appendChild(body);
    panel.appendChild(btn('Back', 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
    loadBoard('daily', body);
  }
  function loadBoard(board, body) {
    body.innerHTML = '';
    body.appendChild(el('p', 'subtle', 'Loading…'));
    root.DWPlatform.getBoard(board).then(function (res) {
      body.innerHTML = '';
      if (res.casual) body.appendChild(el('p', 'subtle', 'Casual board (no server validation).'));
      if (!res.entries || !res.entries.length) { body.appendChild(el('p', null, 'No entries yet. Be the first.')); return; }
      var table = el('table', 'board');
      table.innerHTML = '<thead><tr><th>#</th><th>Prospector</th><th>Score</th><th>Duration</th></tr></thead>';
      var tb = el('tbody');
      var me = H.getState().profile.displayName;
      res.entries.slice(0, 25).forEach(function (e2, i) {
        var tr = el('tr', e2.name === me ? 'me' : null);
        [String(i + 1), e2.name || 'Anonymous', R.formatCoins(e2.score), fmtTime(e2.durationSec || 0)]
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
    var km = st.settings.keys;
    var cards = [
      ['The loop', 'Workers dig ore into bins. The lift hauls ore to the surface and sells it for credits. Credits buy workers, shaft upgrades, lift upgrades and deeper seams. Find the bottleneck, fix it, automate.'],
      ['Workers', 'Assign (' + km.assign + ') moves an idle worker to the selected layer. Unassign (' + km.unassign + ') pulls one back. Hire (' + km.hire + ') adds a new worker — they arrive idle.'],
      ['Shafts', 'Upgrading a layer\'s shaft (' + km.shaft + ') raises its extraction rate and its ore bin capacity.'],
      ['Transport', 'Ore only earns when the lift moves it. Upgrade capacity (' + km.liftCap + ') for bigger loads and speed (' + km.liftSpeed + ') for shorter cycles. A full bin stalls digging — the gauge turns red.'],
      ['Deeper seams', 'Unlock (' + km.unlock + ') the next sealed layer. Deeper ore is richer per worker and sells for more — but it all rides the same lift.'],
      ['Seam flares', 'Occasionally a seam flares bright. Claim it (' + km.flare + ') before it fades for an instant payout. Flare timing comes from the run seed — it is identical for everyone on a daily.'],
      ['The Foreman', 'A one-time purchase that automates routine: assigns idle workers and buys bottleneck fixes on a fixed cadence. You keep strategy; it keeps the floor.'],
      ['Fair play', 'All randomness is seeded and inspectable. No purchases affect power. Practice allows undo (' + km.undo + '); ranked modes never do.'],
      ['Controls', 'Pointer/touch: tap a layer to select, then use the Foreman\'s Panel. Keyboard: ↑/↓ select layer, Enter assign, Esc pause. Gamepad: D-pad select, A confirm, B back, Start pause.']
    ];
    cards.forEach(function (c) {
      var card = el('div', 'card');
      card.style.cursor = 'default';
      card.appendChild(el('h3', null, c[0]));
      card.appendChild(el('p', null, c[1]));
      body.appendChild(card);
    });
    var nar = btn('Describe the current mine aloud', 'ghost small', function () {
      var s = H.getState();
      if (s.run) announce(R.describeState(s.run.state), true);
      else announce('No shift in progress.', true);
    });
    body.appendChild(nar);
  }

  // -------------------------------------------------------------- profile ---
  var ACHIEVEMENTS = [
    { key: 'first_completion', name: 'First Shift Done', desc: 'Complete any stage or lesson.' },
    { key: 'mechanic_mastery', name: 'Every Lever', desc: 'Complete all five lessons.' },
    { key: 'streak_7', name: 'Seven Suns Down', desc: 'Dig the Daily Vein on 7 different days.' },
    { key: 'deep_milestone', name: 'Bottom of the Works', desc: 'Open the sixth seam in any run.' },
    { key: 'long_haul', name: 'The Long Haul', desc: 'Earn 10,000,000 credits across your career.' }
  ];
  function buildProfile() {
    var panel = $('profile-panel');
    panel.innerHTML = '';
    var st = H.getState();
    var p = st.profile;
    panel.appendChild(el('h2', null, 'Profile'));
    var nameRow = el('div', 'set-row');
    var nameInput = el('input');
    nameInput.type = 'text'; nameInput.value = p.displayName; nameInput.maxLength = 24;
    nameInput.setAttribute('aria-label', 'Display name');
    nameRow.appendChild(nameInput);
    nameRow.appendChild(btn('Save', 'small', function () {
      H.setDisplayName(nameInput.value.trim() || 'Guest Prospector');
      toast('Name saved', 'good');
    }));
    panel.appendChild(nameRow);

    var ml = root.DWSession.masteryLevelFor(p.mastery.xp);
    panel.appendChild(el('h3', null, 'Mastery — level ' + ml.level));
    var m = el('div', 'meter big'); var mf = el('div');
    mf.style.width = Math.floor((ml.into / ml.next) * 100) + '%';
    m.appendChild(mf); panel.appendChild(m);
    panel.appendChild(el('p', 'subtle', ml.into + ' / ' + ml.next + ' xp'));

    panel.appendChild(el('h3', null, 'Career'));
    panel.appendChild(kv('Shifts played', String(p.stats.runsPlayed)));
    panel.appendChild(kv('Career earnings', R.formatCoins(p.stats.totalEarned)));
    panel.appendChild(kv('Flares claimed', String(p.stats.flaresClaimed)));
    panel.appendChild(kv('Time underground', fmtTime(p.stats.playtimeSec)));

    panel.appendChild(el('h3', null, 'Achievements'));
    ACHIEVEMENTS.forEach(function (a) {
      var row = el('div', 'set-row');
      var got = !!p.achievements[a.key];
      row.appendChild(el('span', null, (got ? '★ ' : '☆ ') + a.name));
      row.appendChild(el('span', 'subtle', a.desc));
      panel.appendChild(row);
    });

    if (!st.platform.hosted) {
      panel.appendChild(el('p', 'subtle', 'Guest mode: sign-in is offered by the host shell when Deepworks is played hosted.'));
    }
    panel.appendChild(btn('Back', 'ghost back-btn', function () { H.audio('ui_back'); back(); }));
  }

  // -------------------------------------------------------------- settings ---
  function openSettings(inPause) {
    var panel = $('settings-panel');
    panel.innerHTML = '';
    var st = H.getState();
    var s = st.settings;

    panel.appendChild(el('h2', null, inPause ? 'Paused' : 'Settings'));
    if (inPause) {
      var row0 = el('div', 'action-row');
      row0.appendChild(btn('Resume', 'primary', function () { H.resume(); }));
      row0.appendChild(btn('Restart shift', 'ghost', function () {
        confirmModal('Restart this shift from the beginning?', function () { H.restartRun(); });
      }));
      if (st.run && st.run.mode === 'practice') {
        row0.appendChild(btn('End shift & bank score', 'ghost', function () {
          confirmModal('End this shift and bank your score?', function () { H.endRun(); });
        }));
      }
      row0.appendChild(btn('Leave shift', 'ghost', function () {
        confirmModal('Leave the shift? Progress in this run will be lost.', function () { H.leaveRun(); });
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

    var ga = group('Audio');
    slider(ga, 'Music', 'volMusic', 0, 1, 0.05);
    slider(ga, 'Effects', 'volEffects', 0, 1, 0.05);
    slider(ga, 'Ambience', 'volAmbience', 0, 1, 0.05);
    slider(ga, 'Voice cues', 'volVoice', 0, 1, 0.05);
    toggle(ga, 'Mute all', 'muted');
    toggle(ga, 'Text captions for sounds', 'captions');

    var gg = group('Graphics');
    select(gg, 'Quality tier', 'quality', [['low', 'Low (30 fps target)'], ['medium', 'Medium'], ['high', 'High (60 fps target)']]);
    select(gg, 'Mine theme', 'theme', C.THEMES.map(function (t) { return [t.id, t.name]; }));
    toggle(gg, 'Reduced motion', 'reducedMotion');
    toggle(gg, 'Camera sway', 'cameraSway');

    var gc = group('Controls');
    toggle(gc, 'Hold to repeat assign', 'holdRepeat');
    toggle(gc, 'Left-handed layout', 'leftHanded');
    toggle(gc, 'Haptics (vibration)', 'haptics');
    gc.appendChild(el('p', 'subtle', 'Keys: ↑/↓ select layer · Enter assign · ' +
      'U unassign · H hire · Q shaft · W lift capacity · E lift speed · D unlock · F flare · G foreman · Z undo · Esc pause.'));

    var gx = group('Accessibility');
    toggle(gx, 'High contrast', 'highContrast');
    toggle(gx, 'Larger text', 'largeText');
    select(gx, 'Color palette', 'palette', [['default', 'Default'], ['deuter', 'Deuteranopia-safe'], ['protan', 'Protanopia-safe'], ['tritan', 'Tritanopia-safe']]);
    toggle(gx, 'Timing assistance (longer flares — not in the ranked daily)', 'timingAssist');
    var replayRow = el('div', 'set-row');
    replayRow.appendChild(el('label', null, 'Tutorial'));
    replayRow.appendChild(btn('Replay lessons', 'small ghost', function () { openSetup('learn'); }));
    gx.appendChild(replayRow);

    var gd = group('Data');
    toggle(gd, 'Anonymous usage stats (start / round end / errors only)', 'telemetry');
    var wipe = el('div', 'set-row');
    wipe.appendChild(el('label', null, 'Local data'));
    wipe.appendChild(btn('Erase profile', 'small ghost', function () {
      confirmModal('Erase all local progress, settings and unlocks?', function () { H.wipeProfile(); });
    }));
    gd.appendChild(wipe);

    panel.appendChild(btn(inPause ? 'Resume' : 'Back', 'ghost back-btn', function () {
      H.audio('ui_back');
      if (inPause) H.resume(); else back();
    }));
    show('settings');
  }

  // -------------------------------------------------------------- results ---
  function showResults(data) {
    // data: {run, content, mode, won, reason, score, stars, newBest, achievements:[names], awaySummary?}
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
      won ? 'Objective complete' : (data.reason === 'time-up' ? 'Time is up' : data.reason === 'moves-exhausted' ? 'Out of moves' : 'Shift ended'));
    panel.appendChild(head);
    panel.appendChild(el('p', 'subtle', data.content.name || data.content.id));

    if (data.stars) panel.appendChild(el('div', 'stars-big', '★'.repeat(data.stars) + '☆'.repeat(3 - data.stars)));
    panel.appendChild(el('div', 'score-big', R.formatCoins(data.score.total)));
    panel.appendChild(el('p', 'subtle', 'final score'));

    var bd = el('div', 'breakdown');
    bd.appendChild(el('h3', null, 'Score breakdown'));
    var comp = data.score.components;
    bd.appendChild(kv('Ore sold', R.formatCoins(comp.earned)));
    bd.appendChild(kv('Seam flares', R.formatCoins(comp.flares)));
    bd.appendChild(kv('Depth bonus', R.formatCoins(comp.depthBonus)));
    bd.appendChild(kv('Time bonus', R.formatCoins(comp.timeBonus)));
    bd.appendChild(kv('Lift efficiency', (comp.efficiencyPermille / 10).toFixed(1) + '%'));
    bd.appendChild(kv('Elapsed', fmtTime(data.run.result.tick)));
    bd.appendChild(kv('Commands / invalid', data.run.result.moves + ' / ' + data.run.result.invalid));
    panel.appendChild(bd);

    if (data.newBest) panel.appendChild(el('p', null, '★ New personal best!'));
    if (data.achievements && data.achievements.length) {
      panel.appendChild(el('p', null, 'Achievement unlocked: ' + data.achievements.join(', ')));
    }
    if (data.boardResult) {
      panel.appendChild(el('p', 'subtle', data.boardResult));
    }

    var row = el('div', 'action-row');
    if (data.nextContent) {
      row.appendChild(btn('Next: ' + data.nextContent.name, 'primary', function () { H.startRun(data.nextContent, data.mode); }));
    }
    row.appendChild(btn('Retry', data.nextContent ? 'ghost' : 'primary', function () {
      root.DWPlatform.track('retry', { content: data.content.id });
      H.startRun(data.content, data.mode);
    }));
    row.appendChild(btn('Shift select', 'ghost', function () { H.leaveToTitle(); }));
    panel.appendChild(row);

    announce(head.textContent + '. Score ' + R.formatCoins(data.score.total) + '.', true);
    setScreen('results');
  }

  // ------------------------------------------------------------------ HUD ---
  function showPlay() { setScreen('play'); lastHudSig = ''; lastRailSig = ''; }

  function updateHUD(model) {
    // model: {state, content, mode, selectedLayer, lessonStep, legal}
    var st = model.state;
    $('res-credits').textContent = R.formatCoins(st.coins);
    $('res-income').textContent = R.formatCoins(R.incomeRate(st)) + '/s';
    $('res-workers').textContent = st.workers.idle + '/' + st.workers.total;

    var lim = st.ruleset.limits;
    var timeText = fmtTime(st.tick);
    if (lim && lim.timeSec) timeText = fmtTime(Math.max(0, lim.timeSec - st.tick));
    $('hud-timer').textContent = timeText + ((lim && lim.moves) ? ' · ' + Math.max(0, lim.moves - st.stats.playerCommands) + ' moves' : '');

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
    body.appendChild(kv('Elapsed', fmtTime(st.tick)));
    body.appendChild(kv('Depth', R.unlockedCount(st) + ' / ' + st.layers.length + ' seams'));
    body.appendChild(kv('Extraction', R.formatRate(R.totalExtractionRate(st))));
    body.appendChild(kv('Lift capacity', R.formatRate(Math.floor(R.liftRate(st)))));
    body.appendChild(kv('Lifetime earned', R.formatCoins(st.lifetimeEarned)));
    var g = st.ruleset.goals;
    if (g) {
      body.appendChild(el('h3', null, 'Goal'));
      body.appendChild(kv(goalText(g), Math.floor((goalFraction(st, g) || 0) * 100) + '%'));
    }
    if (st.ruleset.parSec) body.appendChild(kv('Par', fmtTime(st.ruleset.parSec)));
    var hint = el('p', 'subtle', bottleneckHint(st));
    body.appendChild(hint);
  }

  // Make the next useful action obvious without solving the game (spec §1).
  function bottleneckHint(st) {
    for (var i = 0; i < st.layers.length; i++) {
      var L = st.layers[i];
      if (L.unlocked && R.isBlocked(st, i)) return 'Layer ' + (i + 1) + ' bin is full — transport is the bottleneck.';
    }
    if (st.workers.idle > 0) return st.workers.idle + ' idle worker' + (st.workers.idle > 1 ? 's' : '') + ' — assign them to a seam.';
    if (st.flare.active) return 'A seam is flaring on Layer ' + (st.flare.active.layer + 1) + ' — claim it!';
    var next = R.nextLockedLayer(st);
    if (next >= 0 && st.coins >= R.unlockCost(st)) return 'You can afford to open Layer ' + (next + 1) + '.';
    return 'Watch the gauges; upgrade whatever lags.';
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
    map[R.REASONS.NO_IDLE_WORKER] = 'No idle workers — hire or unassign first.';
    map[R.REASONS.LAYER_LOCKED] = 'That layer is still sealed.';
    map[R.REASONS.WORKER_CAP] = 'This seam is fully crewed.';
    map[R.REASONS.NO_WORKERS] = 'No workers assigned here.';
    map[R.REASONS.INSUFFICIENT_FUNDS] = 'Not enough credits.';
    map[R.REASONS.ALL_UNLOCKED] = 'Every seam is open.';
    map[R.REASONS.NO_FLARE] = 'No active flare.';
    map[R.REASONS.MECHANIC_DISABLED] = 'Not available in this ruleset.';
    map[R.REASONS.ALREADY_OWNED] = 'Already owned.';
    return map[reason] || reason || '';
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
      gsel.appendChild(el('h3', null, 'Layer ' + (sel + 1)));
      gsel.appendChild(kv('Crew', L.workers + ' / ' + st.ruleset.workerCapPerLayer));
      gsel.appendChild(kv('Rate', R.formatRate(R.layerRate(st, sel))));
      var cap = R.binCapMilli(st, sel);
      gsel.appendChild(kv('Bin', Math.floor((L.milliOre * 100) / cap) + '%' + (R.isBlocked(st, sel) ? ' — BLOCKED' : '')));
      gsel.appendChild(kv('Shaft level', String(L.shaftLevel)));
      var row = el('div', 'action-row');
      row.appendChild(holdable(actionButton({ type: 'assign', layer: sel }, '+ Assign', null, findLegal(model, 'assign', sel))));
      row.appendChild(actionButton({ type: 'unassign', layer: sel }, '− Recall', null, findLegal(model, 'unassign', sel)));
      gsel.appendChild(row);
      var row2 = el('div', 'action-row');
      row2.appendChild(actionButton({ type: 'upgrade_shaft', layer: sel }, 'Upgrade shaft', R.shaftCost(st, sel), findLegal(model, 'upgrade_shaft', sel)));
      gsel.appendChild(row2);
      if (st.flare.active && st.flare.active.layer === sel) {
        var rowF = el('div', 'action-row');
        rowF.appendChild(actionButton({ type: 'claim_flare', layer: sel, id: st.flare.active.id }, '✦ Claim flare', null, findLegal(model, 'claim_flare', sel)));
        gsel.appendChild(rowF);
      }
      body.appendChild(gsel);
    } else {
      body.appendChild(el('p', 'subtle', 'Tap a layer in the mine to crew and upgrade it.'));
    }

    var gg = el('div', 'action-group');
    gg.appendChild(el('h3', null, 'Mine-wide'));
    var r1 = el('div', 'action-row');
    r1.appendChild(actionButton({ type: 'hire' }, 'Hire worker', R.hireCost(st), findLegal(model, 'hire')));
    gg.appendChild(r1);
    var r2 = el('div', 'action-row');
    r2.appendChild(actionButton({ type: 'upgrade_lift_cap' }, 'Lift capacity', R.liftCapCost(st), findLegal(model, 'upgrade_lift_cap')));
    r2.appendChild(actionButton({ type: 'upgrade_lift_speed' }, 'Lift speed', R.liftSpeedCost(st), findLegal(model, 'upgrade_lift_speed')));
    gg.appendChild(r2);
    var nextIdx = R.nextLockedLayer(st);
    if (nextIdx >= 0) {
      var r3 = el('div', 'action-row');
      r3.appendChild(actionButton({ type: 'unlock_layer' }, 'Open Layer ' + (nextIdx + 1), R.unlockCost(st), findLegal(model, 'unlock_layer')));
      gg.appendChild(r3);
    }
    if (st.ruleset.mechanics.foreman) {
      var r4 = el('div', 'action-row');
      if (!st.foreman.unlocked) {
        r4.appendChild(actionButton({ type: 'buy_foreman' }, 'Buy Foreman', st.ruleset.foremanCost, findLegal(model, 'buy_foreman')));
      } else {
        var t = btn('Foreman: ' + (st.foreman.enabled ? 'ON' : 'off'), st.foreman.enabled ? 'selected' : 'ghost',
          function () { H.command({ type: 'toggle_foreman' }); });
        r4.appendChild(t);
      }
      gg.appendChild(r4);
    }
    if (model.mode === 'practice') {
      var r5 = el('div', 'action-row');
      var ub = btn('Undo (Z)', 'ghost', function () { H.undo(); });
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
      tray.appendChild(holdable(actionButton({ type: 'assign', layer: sel }, '+ Assign', null, findLegal(model, 'assign', sel))));
      tray.appendChild(actionButton({ type: 'upgrade_shaft', layer: sel }, 'Shaft', R.shaftCost(st, sel), findLegal(model, 'upgrade_shaft', sel)));
    }
    tray.appendChild(actionButton({ type: 'hire' }, 'Hire', R.hireCost(st), findLegal(model, 'hire')));
    if (R.nextLockedLayer(st) >= 0) {
      tray.appendChild(actionButton({ type: 'unlock_layer' }, 'Open L' + (R.nextLockedLayer(st) + 1), R.unlockCost(st), findLegal(model, 'unlock_layer')));
    }
    if (st.flare.active) {
      tray.appendChild(actionButton({ type: 'claim_flare', layer: st.flare.active.layer, id: st.flare.active.id },
        '✦ Flare L' + (st.flare.active.layer + 1), null, findLegal(model, 'claim_flare', st.flare.active.layer)));
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
      d.style.left = pos.x + 'px';
      d.style.top = pos.y + 'px';
      d.classList.toggle('selected', i === selectedLayer);
      var blocked = L.unlocked && R.isBlocked(st, i);
      d.classList.toggle('blocked', blocked);
      var flare = st.flare.active && st.flare.active.layer === i;
      d.classList.toggle('flare', !!flare);
      var text = 'L' + (i + 1);
      if (!L.unlocked) text += ' 🔒';
      else {
        text += ' ⚒' + L.workers;
        if (blocked) text += ' ▲FULL';
        if (flare) text += ' ✦';
      }
      d.textContent = text;
    }
  }

  // -------------------------------------------------------------- feedback ---
  function toast(msg, kind) {
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    $('toast-root').appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
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
      row.appendChild(btn('Confirm', 'primary', function () { close(); onYes(); }));
      row.appendChild(btn('Cancel', 'ghost', function () { close(); }));
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
    ACHIEVEMENTS: ACHIEVEMENTS
  };
})(typeof self !== 'undefined' ? self : this);
