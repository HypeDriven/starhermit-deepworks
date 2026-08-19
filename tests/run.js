/**
 * Deepworks — test suite (spec §9).
 * Run: node tests/run.js
 * Covers: legal actions, invalid-action reasons, scoring components,
 * terminal states, serialization/migration, deterministic replay
 * (property test), command fuzzing, content validation, and golden sessions.
 */
'use strict';
const R = require('../js/rules.js');
const C = require('../js/content.js');
const S = require('../js/session.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, name + ` (got ${a}, want ${b})`); }
function section(s) { console.log('—', s); }

const CS = R.COIN_SCALE;

// ---------------------------------------------------------- legal actions ---
section('legal actions & invalid reasons');
{
  const st = R.createState(1234, { layerCount: 3, startUnlocked: 1, startWorkers: 2, startCoins: 1000 * CS });

  // assign: valid then capped (createState crews everyone; free one first)
  R.applyCommand(st, { type: 'unassign', layer: 0 });
  eq(R.can(st, { type: 'assign', layer: 0 }).ok, true, 'assign legal');
  eq(R.can(st, { type: 'assign', layer: 1 }).reason, R.REASONS.LAYER_LOCKED, 'assign locked layer rejected');
  st.workers.idle = 0;
  eq(R.can(st, { type: 'assign', layer: 0 }).reason, R.REASONS.NO_IDLE_WORKER, 'assign with no idle rejected');
  st.workers.idle = 1;
  st.layers[0].workers = st.ruleset.workerCapPerLayer;
  eq(R.can(st, { type: 'assign', layer: 0 }).reason, R.REASONS.WORKER_CAP, 'assign past cap rejected');
  st.layers[0].workers = 1;

  // unassign
  eq(R.can(st, { type: 'unassign', layer: 0 }).ok, true, 'unassign legal');
  eq(R.can(st, { type: 'unassign', layer: 2 }).reason, R.REASONS.LAYER_LOCKED, 'unassign locked rejected');
  st.layers[0].workers = 0;
  eq(R.can(st, { type: 'unassign', layer: 0 }).reason, R.REASONS.NO_WORKERS, 'unassign empty rejected');
  st.layers[0].workers = 1;

  // funds
  st.coins = 0;
  eq(R.can(st, { type: 'hire' }).reason, R.REASONS.INSUFFICIENT_FUNDS, 'hire without funds rejected');
  eq(R.can(st, { type: 'upgrade_shaft', layer: 0 }).reason, R.REASONS.INSUFFICIENT_FUNDS, 'shaft without funds rejected');
  eq(R.can(st, { type: 'unlock_layer' }).reason, R.REASONS.INSUFFICIENT_FUNDS, 'unlock without funds rejected');

  // unlock path
  st.coins = 1e9;
  eq(R.can(st, { type: 'unlock_layer' }).ok, true, 'unlock legal with funds');
  R.applyCommand(st, { type: 'unlock_layer' });
  R.applyCommand(st, { type: 'unlock_layer' });
  eq(R.can(st, { type: 'unlock_layer' }).reason, R.REASONS.ALL_UNLOCKED, 'all unlocked reason');

  // foreman
  eq(R.can(st, { type: 'toggle_foreman' }).reason, R.REASONS.MECHANIC_DISABLED, 'toggle before owning rejected');
  R.applyCommand(st, { type: 'buy_foreman' });
  eq(st.foreman.unlocked, true, 'foreman owned');
  eq(R.can(st, { type: 'buy_foreman' }).reason, R.REASONS.ALREADY_OWNED, 'rebuy rejected');
  eq(R.can(st, { type: 'toggle_foreman' }).ok, true, 'toggle legal once owned');

  // mechanic gating
  const st2 = R.createState(7, { mechanics: { lift: false, flares: false, foreman: false } });
  eq(R.can(st2, { type: 'upgrade_lift_cap' }).reason, R.REASONS.MECHANIC_DISABLED, 'lift disabled in ruleset');
  eq(R.can(st2, { type: 'claim_flare', layer: 0, id: 1 }).reason, R.REASONS.MECHANIC_DISABLED, 'flare disabled in ruleset');

  // legalActions list shape
  const list = R.legalActions(st);
  ok(list.length > 0, 'legalActions non-empty');
  ok(list.every(a => typeof a.enabled === 'boolean' && typeof a.reason === 'string'), 'legalActions well-formed');

  // malformed
  const st3 = R.createState(1);
  const before = st3.stats.invalidActions;
  const res = R.applyCommand(st3, { type: 'nonsense' });
  ok(!res.ok, 'unknown command rejected');
  eq(st3.stats.invalidActions, before + 1, 'invalid action counted');
  ok(!R.applyCommand(st3, null).ok, 'null command rejected');
}

// -------------------------------------------------------------- simulation ---
section('simulation & economy');
{
  const st = R.createState(42, { layerCount: 2, startUnlocked: 1, startWorkers: 2, startCoins: 0 });
  R.advance(st, 10000);
  ok(st.tick >= 9 && st.tick <= 10, 'tick advanced ~10s, got ' + st.tick);
  ok(st.coins > 0, 'coins earned from extraction+transport+sale');
  ok(st.lifetimeEarned > 0, 'lifetimeEarned tracked');
  ok(st.stats.soldMilliOre > 0, 'ore sold tracked');

  // monotonic tick
  const t1 = st.tick;
  R.advance(st, 5000);
  ok(st.tick > t1, 'tick monotonic');

  // bin blocking: huge crew, tiny lift
  const stB = R.createState(42, {
    layerCount: 1, startUnlocked: 1, startWorkers: 5,
    liftCapBase: 100, liftCycleBase: 10000, binCap: [5000], startCoins: 0,
    mechanics: { flares: false }
  });
  R.advance(stB, 60000);
  ok(R.isBlocked(stB, 0), 'bin fills when lift lags');

  // upgrade effects
  const stU = R.createState(9, { layerCount: 2, startCoins: 1e9 });
  const rate0 = R.layerRate(stU, 0);
  R.applyCommand(stU, { type: 'upgrade_shaft', layer: 0 });
  ok(R.layerRate(stU, 0) > rate0, 'shaft upgrade raises rate');
  const cap0 = R.liftCapacity(stU);
  R.applyCommand(stU, { type: 'upgrade_lift_cap' });
  ok(R.liftCapacity(stU) > cap0, 'lift cap upgrade raises capacity');
  const cyc0 = R.liftCycleMs(stU);
  R.applyCommand(stU, { type: 'upgrade_lift_speed' });
  ok(R.liftCycleMs(stU) < cyc0, 'lift speed upgrade shortens cycle');

  // flares: seeded schedule + claim
  const stF = R.createState(77, { flareEveryMinSec: 3, flareEveryMaxSec: 4, flareDurationSec: 10 });
  let sawFlare = false, claimed = false;
  for (let i = 0; i < 40 && !claimed; i++) {
    const evs = R.advance(stF, 1000);
    if (stF.flare.active && !sawFlare) {
      sawFlare = true;
      const f = stF.flare.active;
      eq(R.can(stF, { type: 'claim_flare', layer: f.layer, id: f.id }).ok, true, 'flare claim legal while active');
      eq(R.can(stF, { type: 'claim_flare', layer: (f.layer + 1) % 2, id: f.id }).reason, R.REASONS.FLARE_MISMATCH, 'wrong layer rejected');
      const coinsBefore = stF.coins;
      const r = R.applyCommand(stF, { type: 'claim_flare', layer: f.layer, id: f.id });
      ok(r.ok, 'flare claimed');
      ok(stF.coins > coinsBefore, 'flare pays credits');
      claimed = true;
    }
  }
  ok(sawFlare, 'flare appeared on schedule');
  ok(claimed, 'flare claim flow completed');
  eq(R.can(stF, { type: 'claim_flare', layer: 0, id: 999 }).reason, R.REASONS.NO_FLARE, 'stale flare id rejected');

  // foreman automation acts on its own
  const stA = R.createState(5, { startCoins: 1e9, foremanCost: 1 });
  R.applyCommand(stA, { type: 'buy_foreman' });
  stA.workers.idle = 2; stA.workers.total += 2;
  R.advance(stA, 5000);
  eq(stA.layers[0].workers, stA.ruleset.workerCapPerLayer, 'foreman crews seams to cap');
}

// ---------------------------------------------------------------- terminal ---
section('terminal states');
{
  // earn goal
  const st = R.createState(1, { startCoins: 0, goals: { type: 'earn', amount: 1 } });
  R.advance(st, 20000);
  ok(st.terminal && st.terminal.reason === 'goal-complete' && st.terminal.won, 'earn goal terminates with win');
  // commands after terminal
  eq(R.can(st, { type: 'hire' }).reason, R.REASONS.TERMINAL, 'no commands after terminal');
  // time limit
  const st2 = R.createState(1, { goals: { type: 'earn', amount: 1e15 }, limits: { timeSec: 5 } });
  R.advance(st2, 10000);
  eq(st2.terminal.reason, 'time-up', 'time limit terminates');
  ok(!st2.terminal.won, 'time-up with goal unmet is a loss');
  // moves limit
  const st3 = R.createState(1, { limits: { moves: 2 }, startCoins: 1e9 });
  R.applyCommand(st3, { type: 'hire' });
  R.applyCommand(st3, { type: 'hire' });
  R.advance(st3, 200);
  eq(st3.terminal.reason, 'moves-exhausted', 'move limit terminates');
  // end_run
  const st4 = R.createState(1);
  R.applyCommand(st4, { type: 'end_run' });
  eq(st4.terminal.reason, 'player-ended', 'player end terminates');
  ok(st4.terminal.won, 'endless end_run is a win');
  const st5 = R.createState(1, { goals: { type: 'earn', amount: 1e15 } });
  R.applyCommand(st5, { type: 'end_run' });
  ok(!st5.terminal.won, 'end_run with unmet goal is a loss');
}

// ----------------------------------------------------------------- scoring ---
section('scoring');
{
  const st = R.createState(3, { layerCount: 2, startCoins: 0, parSec: 600 });
  R.advance(st, 30000);
  const sc = R.score(st);
  ok(sc.total === sc.components.earned + sc.components.flares + sc.components.depthBonus + sc.components.timeBonus,
    'score is exact sum of components');
  ok(Number.isInteger(sc.total), 'score integer');
  ok(sc.components.depthBonus === R.unlockedCount(st) * 250 * CS, 'depth bonus formula');
  // tie-break
  const a = R.createState(3); const b = R.createState(3);
  R.advance(a, 1000); R.advance(b, 2000);
  const cmp = R.compareRuns(a, b);
  ok(typeof cmp === 'number', 'compareRuns returns number');
}

// ---------------------------------------------------------- serialization ---
section('serialization & migration');
{
  const st = R.createState(99);
  R.advance(st, 5000);
  R.applyCommand(st, { type: 'hire' });
  const json = R.serialize(st);
  const back = R.deserialize(json);
  eq(R.hashState(back), R.hashState(st), 'round-trip preserves hash');
  // migration chain: pretend a v0 doc exists
  const old = JSON.parse(json);
  old.version = 0;
  const mig = R.migrate(old);
  eq(mig.version, R.VERSION, 'migration reaches current version');
  // corrupted
  let threw = false;
  try { R.deserialize('{"nope":1}'); } catch (e) { threw = true; }
  ok(threw, 'corrupt state rejected');
}

// ------------------------------------------- determinism property testing ---
section('deterministic replay (property test)');
{
  function randomCommands(seedStr, n) {
    let s = R.hashString(seedStr);
    const cmds = [];
    const types = ['assign', 'unassign', 'hire', 'upgrade_shaft', 'upgrade_lift_cap', 'upgrade_lift_speed', 'unlock_layer'];
    for (let i = 0; i < n; i++) {
      let r = R.rngNext(s); s = r.state;
      const t = types[Math.floor(r.value * types.length)];
      const cmd = { type: t };
      if (t === 'assign' || t === 'unassign' || t === 'upgrade_shaft') {
        r = R.rngNext(s); s = r.state;
        cmd.layer = Math.floor(r.value * 3);
      }
      cmds.push(cmd);
      cmds.push({ type: 'advance', ms: 100 + Math.floor(r.value * 2000) });
    }
    return cmds;
  }
  for (let iter = 0; iter < 25; iter++) {
    const content = C.JOURNEY[iter % C.JOURNEY.length];
    const cmds = randomCommands('prop-' + iter, 30);
    function runOnce() {
      const st = C.buildState(content);
      for (const c of cmds) {
        if (c.type === 'advance') R.advance(st, c.ms);
        else R.applyCommand(st, c);
      }
      return R.hashState(st);
    }
    eq(runOnce(), runOnce(), `replay identical hash (iter ${iter})`);
  }
}

// ------------------------------------------------------------ fuzz testing ---
section('fuzz malformed commands');
{
  const st = R.createState(2024);
  let s = 12345;
  let hung = false;
  const start = Date.now();
  for (let i = 0; i < 5000; i++) {
    const r = R.rngNext(s); s = r.state;
    const weird = [
      { type: 'assign', layer: -1 }, { type: 'assign', layer: 1e9 }, { type: 'assign', layer: NaN },
      { type: 'assign', layer: 'x' }, { type: '' }, { type: null }, 42, 'str', [], {},
      { type: 'claim_flare', layer: {}, id: [] }, { type: 'hire', extra: 'x'.repeat(1000) },
      { type: 'unlock_layer', layer: undefined }
    ][Math.floor(r.value * 12)];
    try { R.applyCommand(st, weird); } catch (e) { ok(false, 'fuzz threw on ' + JSON.stringify(weird)); }
    if (i % 500 === 0) R.advance(st, 1000);
    // no NaN anywhere
    ok(!Number.isNaN(st.coins), 'coins never NaN');
  }
  ok(Date.now() - start < 5000, 'fuzz completes quickly (no hangs)');
  ok(Number.isFinite(st.coins) && st.coins >= 0, 'state stays sane under fuzz');
}

// ------------------------------------------------------ content validation ---
section('content validation');
{
  for (const st of C.JOURNEY) {
    const problems = C.validateContent(st);
    ok(problems.length === 0, `journey ${st.n} (${st.name}) valid: ${problems.join('; ')}`);
  }
  for (const ch of C.CHALLENGES) {
    const problems = C.validateContent(ch);
    ok(problems.length === 0, `challenge ${ch.id} valid: ${problems.join('; ')}`);
  }
  for (const ls of C.LESSONS) {
    const content = { id: ls.id, seed: R.hashString('deepworks.' + ls.id), theme: ls.theme, overrides: ls.ruleset, setup: ls.setup, endless: true };
    const problems = C.validateContent(content);
    ok(problems.length === 0, `lesson ${ls.id} valid: ${problems.join('; ')}`);
  }
  // daily: 30 days must all validate + be winnable by reference player
  for (let d = 0; d < 30; d++) {
    const date = new Date(Date.UTC(2026, 0, 1 + d));
    const info = C.dailyInfo(date);
    const problems = C.validateContent(info);
    ok(problems.length === 0, `daily ${info.key} valid: ${problems.join('; ')}`);
    const st = C.buildState(info);
    let t = 0;
    while (!st.terminal && t < 905) { R.advance(st, 2000); t += 2; C.greedy(st); }
    ok(st.terminal && st.terminal.won, `daily ${info.key} winnable (${st.terminal && st.terminal.reason})`);
  }
  // daily immutability
  const d1 = C.dailyInfo(new Date(Date.UTC(2026, 5, 15)));
  const d2 = C.dailyInfo(new Date(Date.UTC(2026, 5, 15)));
  eq(JSON.stringify(d1), JSON.stringify(d2), 'daily generation deterministic');
  ok(C.dailyInfo(new Date(Date.UTC(2026, 5, 16))).seed !== d1.seed, 'daily seed changes per day');
}

// ------------------------------------------------------- golden sessions ---
section('golden sessions (easy/medium/hard/interrupted/resumed/terminal)');
{
  function playGolden(content, maxSec) {
    const st = C.buildState(content);
    let t = 0;
    while (!st.terminal && t < maxSec) { R.advance(st, 2000); t += 2; C.greedy(st); }
    return st;
  }
  const easy = playGolden(C.JOURNEY[0], 1200);
  ok(easy.terminal && easy.terminal.won, 'golden easy completes');
  const mid = playGolden(C.JOURNEY[14], 2400);
  ok(mid.terminal && mid.terminal.won, 'golden medium completes');
  const hard = playGolden(C.JOURNEY[29], 4000);
  ok(hard.terminal && hard.terminal.won, 'golden hard completes');

  // interrupted + resumed via serialization
  const content = C.JOURNEY[4];
  const st = C.buildState(content);
  R.advance(st, 30000); C.greedy(st);
  const snapshot = R.serialize(st);
  const hashBefore = R.hashState(st);
  const resumed = R.deserialize(snapshot);
  R.advance(resumed, 30000);
  R.advance(st, 30000);
  eq(R.hashState(resumed), R.hashState(st), 'interrupted+resumed session matches uninterrupted');
  ok(hashBefore !== R.hashState(st), 'state actually advanced after resume');

  // full session-module replay through the log
  const run = S.createRun(C.JOURNEY[1], 'journey', { buildState: C.buildState });
  for (let i = 0; i < 40 && !run.closed; i++) {
    S.tick(run, 2000);
    const st2 = run.state;
    // greedy through the session API
    const acts = R.legalActions(st2).filter(a => a.enabled && (a.type === 'hire' || a.type === 'upgrade_lift_cap'));
    if (acts.length) S.dispatch(run, { type: acts[0].type, layer: acts[0].layer, id: acts[0].id });
    // a couple of invalid attempts must survive replay identically
    if (i === 5) S.dispatch(run, { type: 'assign', layer: 99 });
  }
  // duplicate command ids are idempotent
  const dup = { type: 'hire', id: 'fixed-id-1' };
  S.dispatch(run, dup);
  const hashAfterFirst = R.hashState(run.state);
  const r2 = S.dispatch(run, dup);
  ok(r2.deduped === true, 'duplicate command id deduped');
  eq(R.hashState(run.state), hashAfterFirst, 'dedupe does not double-apply');

  S.flush(run);
  const rep = S.replay(C.JOURNEY[1], run.log, { buildState: C.buildState });
  ok(rep.ok, 'session log replays ok');
  eq(rep.hash, R.hashState(run.state), 'replay hash matches live run (with invalid actions)');
}

// ---------------------------------------------------------------- undo ---
section('undo (practice only)');
{
  const run = S.createRun(C.PRACTICE_DIFFICULTIES ? { id: 'p', seed: 5, version: 1, overrides: {}, endless: true } : null, 'practice', { buildState: C.buildState });
  const h0 = R.hashState(run.state);
  S.dispatch(run, { type: 'hire' });
  ok(R.hashState(run.state) !== h0, 'hire changes state');
  const res = S.undo(run);
  ok(res.ok, 'undo works in practice');
  eq(R.hashState(run.state), h0, 'undo restores exact state');
  const runJ = S.createRun(C.JOURNEY[0], 'journey', { buildState: C.buildState });
  S.dispatch(runJ, { type: 'hire' });
  ok(!S.undo(runJ).ok, 'undo not permitted in journey');
}

// ------------------------------------------------------------- away sim ---
section('away simulation');
{
  const st = R.createState(11, { startCoins: 0 });
  R.advance(st, 60000);
  const before = st.lifetimeEarned;
  // simulate 2 hours away in chunks (like resumeRun)
  let remaining = 7200 * 1000;
  while (remaining > 0) { const c = Math.min(remaining, 60000); R.advance(st, c); remaining -= c; }
  ok(st.lifetimeEarned > before, 'away sim earns credits');
  ok(st.tick >= 7260, 'away sim advances tick');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
