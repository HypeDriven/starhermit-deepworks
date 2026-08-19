/**
 * Deepworks — rules engine.
 * Pure, deterministic, rendering-independent game rules.
 *
 * Contract (spec §2):
 *  - legal-action queries independent of rendering
 *  - deterministic resolution with a monotonically increasing tick
 *  - serializable state (JSON-safe, integers for score and simulation units)
 *  - terminal-state reason
 *  - seeded, inspectable randomness (rules stream kept in state)
 *
 * Fixed point conventions:
 *  - ore is stored in milli-ore (1 ore = 1000 milli-ore)
 *  - currency ("credits") is stored in milli-credits
 *  - time advances in integer milliseconds; state.tick is whole seconds
 *
 * UMD: exposes `DWRules` in the browser, module.exports in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DWRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var ORE_SCALE = 1000;          // milli-ore per ore
  var COIN_SCALE = 1000;         // milli-credits per credit
  var STEP_MS = 100;             // fixed simulation step

  // ---------------------------------------------------------------- RNG ---
  // mulberry32 with explicit, serializable state.
  function rngNext(s) {
    s = (s + 0x6D2B79F5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return { state: s, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
  }
  function rngInt(s, lo, hi) { // inclusive [lo, hi]
    var r = rngNext(s);
    return { state: r.state, value: lo + Math.floor(r.value * (hi - lo + 1)) };
  }
  function hashString(str) { // FNV-1a 32-bit
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ------------------------------------------------------- default tuning ---
  function defaultRuleset() {
    return {
      name: 'standard',
      layerCount: 6,                 // total seams that exist in the mine
      startUnlocked: 1,
      startWorkers: 2,
      startCoins: 50 * COIN_SCALE,
      workerCapPerLayer: 5,
      // per-layer base extraction richness (milli-ore / worker / second)
      layerRich: [1200, 2200, 3800, 6200, 9800, 15000],
      // per-layer ore value (milli-credits per ore)
      layerValue: [1000, 1600, 2600, 4200, 6800, 11000],
      // per-layer bin capacity in milli-ore
      binCap: [40000, 60000, 90000, 130000, 190000, 270000],
      // lift: capacity (milli-ore per trip), cycle time (ms)
      liftCapBase: 8000,
      liftCapGrowth: 1.65,
      liftCycleBase: 4000,
      liftCycleGrowth: 0.86,
      // shaft upgrade: multiplies layer rate and bin cap
      shaftRateMult: 1.30,
      shaftBinMult: 1.45,
      // costs in milli-credits
      hireBase: 40 * COIN_SCALE,
      hireGrowth: 1.35,
      shaftBase: 60 * COIN_SCALE,
      shaftGrowth: 1.75,
      liftCapCostBase: 80 * COIN_SCALE,
      liftCapCostGrowth: 1.8,
      liftSpeedCostBase: 70 * COIN_SCALE,
      liftSpeedCostGrowth: 1.85,
      unlockBase: 150 * COIN_SCALE,
      unlockGrowth: 2.6,
      foremanCost: 900 * COIN_SCALE,
      // seams flares (active-play bonus events)
      flareEveryMinSec: 35,
      flareEveryMaxSec: 70,
      flareDurationSec: 14,
      flareBonusMult: 30,            // bonus = layer 1-sec rate * mult
      // automation
      foremanIntervalSec: 2,
      // session shape
      goals: null,                   // {type:'earn'|'depth'|'rate', amount}
      limits: null,                  // {timeSec?, moves?}
      parSec: 600,
      awayCapSec: 8 * 3600,
      endless: true,
      mechanics: { flares: true, foreman: true, lift: true, shaftUpgrades: true }
    };
  }

  function mergeRuleset(overrides) {
    var r = defaultRuleset();
    if (!overrides) return r;
    for (var k in overrides) {
      if (k === 'mechanics' && overrides.mechanics) {
        for (var m in overrides.mechanics) r.mechanics[m] = overrides.mechanics[m];
      } else if (k === 'goals' && overrides.goals) {
        r.goals = {}; for (var g in overrides.goals) r.goals[g] = overrides.goals[g];
      } else if (k === 'limits' && overrides.limits) {
        r.limits = {}; for (var l in overrides.limits) r.limits[l] = overrides.limits[l];
      } else {
        r[k] = overrides[k];
      }
    }
    return r;
  }

  // ------------------------------------------------------------- creation ---
  function createState(seed, rulesetOverrides) {
    var rs = mergeRuleset(rulesetOverrides);
    var layers = [];
    for (var i = 0; i < rs.layerCount; i++) {
      layers.push({
        unlocked: i < rs.startUnlocked,
        workers: 0,
        shaftLevel: 0,
        milliOre: 0,
        carry: 0,          // sub-milli-ore extraction remainder (milli-ore*ms)
        haulCarry: 0       // sub-milli-ore transport remainder
      });
    }
    var state = {
      version: VERSION,
      seed: seed >>> 0,
      rngState: (seed ^ 0x9e3779b9) >>> 0,
      ruleset: rs,
      tick: 0,                     // whole seconds, monotonically increasing
      tickMs: 0,                   // sub-second accumulator [0,1000)
      coins: rs.startCoins,
      lifetimeEarned: 0,           // milli-credits ever earned from sales
      flareEarned: 0,              // milli-credits from claimed flares
      workers: { total: rs.startWorkers, idle: rs.startWorkers },
      layers: layers,
      lift: { capLevel: 0, speedLevel: 0, transitMilliOre: 0 },
      foreman: { unlocked: false, enabled: false, cooldownMs: 0 },
      flare: { active: null, nextAt: 0, counter: 0 },
      hires: 0,
      stats: {
        soldMilliOre: 0,
        flaresClaimed: 0,
        invalidActions: 0,
        playerCommands: 0,
        maxRateMilliOreSec: 0
      },
      terminal: null               // {reason, tick, won}
    };
    // initial assignment: all workers on layer 0
    state.layers[0].workers = rs.startWorkers;
    state.workers.idle = 0;
    scheduleNextFlare(state, true);
    return state;
  }

  // --------------------------------------------------------- derived rates ---
  function shaftMult(state, i) {
    return Math.pow(state.ruleset.shaftRateMult, state.layers[i].shaftLevel);
  }
  function binCapMilli(state, i) {
    return Math.floor(state.ruleset.binCap[i] * Math.pow(state.ruleset.shaftBinMult, state.layers[i].shaftLevel));
  }
  function layerRate(state, i) { // milli-ore per second
    var L = state.layers[i];
    if (!L.unlocked) return 0;
    return Math.floor(L.workers * state.ruleset.layerRich[i] * shaftMult(state, i));
  }
  function layerValuePerMilliOre(state, i) { // milli-credits per milli-ore
    return state.ruleset.layerValue[i] / ORE_SCALE;
  }
  function liftCapacity(state) { // milli-ore per trip
    return Math.floor(state.ruleset.liftCapBase * Math.pow(state.ruleset.liftCapGrowth, state.lift.capLevel));
  }
  function liftCycleMs(state) {
    return Math.max(600, Math.floor(state.ruleset.liftCycleBase * Math.pow(state.ruleset.liftCycleGrowth, state.lift.speedLevel)));
  }
  function liftRate(state) { // milli-ore per second transport capacity
    return (liftCapacity(state) * 1000) / liftCycleMs(state);
  }
  function totalExtractionRate(state) {
    var t = 0;
    for (var i = 0; i < state.layers.length; i++) t += layerRate(state, i);
    return t;
  }
  // effective income rate in milli-credits/sec if nothing is bin-blocked
  function incomeRate(state) {
    var income = 0;
    var haulLeft = liftRate(state);
    for (var i = state.layers.length - 1; i >= 0; i--) {
      var r = layerRate(state, i);
      if (r <= 0) continue;
      var hauled = Math.min(r, haulLeft);
      haulLeft -= hauled;
      income += hauled * layerValuePerMilliOre(state, i);
    }
    return Math.floor(income);
  }

  // ---------------------------------------------------------------- costs ---
  function hireCost(state) {
    return Math.floor(state.ruleset.hireBase * Math.pow(state.ruleset.hireGrowth, state.hires));
  }
  function shaftCost(state, i) {
    var L = state.layers[i];
    return Math.floor(state.ruleset.shaftBase * (i + 1) * Math.pow(state.ruleset.shaftGrowth, L.shaftLevel));
  }
  function liftCapCost(state) {
    return Math.floor(state.ruleset.liftCapCostBase * Math.pow(state.ruleset.liftCapCostGrowth, state.lift.capLevel));
  }
  function liftSpeedCost(state) {
    return Math.floor(state.ruleset.liftSpeedCostBase * Math.pow(state.ruleset.liftSpeedCostGrowth, state.lift.speedLevel));
  }
  function unlockCost(state) {
    var idx = nextLockedLayer(state);
    if (idx < 0) return Infinity;
    return Math.floor(state.ruleset.unlockBase * Math.pow(state.ruleset.unlockGrowth, idx - state.ruleset.startUnlocked));
  }
  function nextLockedLayer(state) {
    for (var i = 0; i < state.layers.length; i++) if (!state.layers[i].unlocked) return i;
    return -1;
  }

  // ---------------------------------------------------------------- flares ---
  function scheduleNextFlare(state, initial) {
    if (!state.ruleset.mechanics.flares) { state.flare.nextAt = Infinity; return; }
    var r = rngInt(state.rngState, state.ruleset.flareEveryMinSec, state.ruleset.flareEveryMaxSec);
    state.rngState = r.state;
    state.flare.nextAt = state.tick + r.value;
    if (initial) state.flare.nextAt = Math.max(8, r.value >> 1);
  }
  function flareBonus(state, layerIdx) {
    var base = Math.max(state.ruleset.layerRich[layerIdx], layerRate(state, layerIdx));
    return base * state.ruleset.flareBonusMult; // milli-ore
  }

  // ------------------------------------------------------------- legality ---
  // Every reason is a stable string code; UI and tutorials consume this list.
  var REASONS = {
    OK: 'ok',
    TERMINAL: 'run-ended',
    NO_IDLE_WORKER: 'no-idle-worker',
    LAYER_LOCKED: 'layer-locked',
    WORKER_CAP: 'worker-cap-reached',
    NO_WORKERS: 'no-workers-assigned',
    INSUFFICIENT_FUNDS: 'insufficient-credits',
    ALL_UNLOCKED: 'all-layers-unlocked',
    NO_FLARE: 'no-active-flare',
    FLARE_MISMATCH: 'flare-elsewhere',
    MECHANIC_DISABLED: 'mechanic-unavailable',
    ALREADY_OWNED: 'already-owned',
    NOT_ENDLESS: 'run-has-objective'
  };

  function can(state, cmd) {
    if (state.terminal) return { ok: false, reason: REASONS.TERMINAL };
    var m = state.ruleset.mechanics;
    switch (cmd.type) {
      case 'assign': {
        var L = state.layers[cmd.layer];
        if (!L || !L.unlocked) return { ok: false, reason: REASONS.LAYER_LOCKED };
        if (state.workers.idle <= 0) return { ok: false, reason: REASONS.NO_IDLE_WORKER };
        if (L.workers >= state.ruleset.workerCapPerLayer) return { ok: false, reason: REASONS.WORKER_CAP };
        return { ok: true, reason: REASONS.OK };
      }
      case 'unassign': {
        var L2 = state.layers[cmd.layer];
        if (!L2 || !L2.unlocked) return { ok: false, reason: REASONS.LAYER_LOCKED };
        if (L2.workers <= 0) return { ok: false, reason: REASONS.NO_WORKERS };
        return { ok: true, reason: REASONS.OK };
      }
      case 'hire':
        if (state.coins < hireCost(state)) return { ok: false, reason: REASONS.INSUFFICIENT_FUNDS, cost: hireCost(state) };
        return { ok: true, reason: REASONS.OK, cost: hireCost(state) };
      case 'upgrade_shaft': {
        if (!m.shaftUpgrades) return { ok: false, reason: REASONS.MECHANIC_DISABLED };
        var L3 = state.layers[cmd.layer];
        if (!L3 || !L3.unlocked) return { ok: false, reason: REASONS.LAYER_LOCKED };
        var c = shaftCost(state, cmd.layer);
        if (state.coins < c) return { ok: false, reason: REASONS.INSUFFICIENT_FUNDS, cost: c };
        return { ok: true, reason: REASONS.OK, cost: c };
      }
      case 'upgrade_lift_cap': {
        if (!m.lift) return { ok: false, reason: REASONS.MECHANIC_DISABLED };
        var c2 = liftCapCost(state);
        if (state.coins < c2) return { ok: false, reason: REASONS.INSUFFICIENT_FUNDS, cost: c2 };
        return { ok: true, reason: REASONS.OK, cost: c2 };
      }
      case 'upgrade_lift_speed': {
        if (!m.lift) return { ok: false, reason: REASONS.MECHANIC_DISABLED };
        var c3 = liftSpeedCost(state);
        if (state.coins < c3) return { ok: false, reason: REASONS.INSUFFICIENT_FUNDS, cost: c3 };
        return { ok: true, reason: REASONS.OK, cost: c3 };
      }
      case 'unlock_layer': {
        var idx = nextLockedLayer(state);
        if (idx < 0) return { ok: false, reason: REASONS.ALL_UNLOCKED };
        var c4 = unlockCost(state);
        if (state.coins < c4) return { ok: false, reason: REASONS.INSUFFICIENT_FUNDS, cost: c4 };
        return { ok: true, reason: REASONS.OK, cost: c4, layer: idx };
      }
      case 'claim_flare': {
        if (!m.flares) return { ok: false, reason: REASONS.MECHANIC_DISABLED };
        var f = state.flare.active;
        if (!f || f.expiresTick <= state.tick) return { ok: false, reason: REASONS.NO_FLARE };
        if (f.layer !== cmd.layer || f.id !== cmd.id) return { ok: false, reason: REASONS.FLARE_MISMATCH };
        return { ok: true, reason: REASONS.OK };
      }
      case 'buy_foreman': {
        if (!m.foreman) return { ok: false, reason: REASONS.MECHANIC_DISABLED };
        if (state.foreman.unlocked) return { ok: false, reason: REASONS.ALREADY_OWNED };
        var c5 = state.ruleset.foremanCost;
        if (state.coins < c5) return { ok: false, reason: REASONS.INSUFFICIENT_FUNDS, cost: c5 };
        return { ok: true, reason: REASONS.OK, cost: c5 };
      }
      case 'toggle_foreman':
        if (!state.foreman.unlocked) return { ok: false, reason: REASONS.MECHANIC_DISABLED };
        return { ok: true, reason: REASONS.OK };
      case 'end_run':
        return { ok: true, reason: REASONS.OK };
      default:
        return { ok: false, reason: 'unknown-command' };
    }
  }

  // Full legal-action list for UI, hints and tutorials. One entry per action
  // family, with enabled flag, reason code and cost where relevant.
  function legalActions(state) {
    var list = [];
    var families = ['hire', 'upgrade_lift_cap', 'upgrade_lift_speed', 'unlock_layer', 'buy_foreman', 'toggle_foreman', 'end_run'];
    for (var i = 0; i < state.layers.length; i++) {
      list.push(withCmd(state, { type: 'assign', layer: i }));
      list.push(withCmd(state, { type: 'unassign', layer: i }));
      list.push(withCmd(state, { type: 'upgrade_shaft', layer: i }));
      if (state.flare.active && state.flare.active.layer === i && state.flare.active.expiresTick > state.tick) {
        list.push(withCmd(state, { type: 'claim_flare', layer: i, id: state.flare.active.id }));
      }
    }
    for (var f = 0; f < families.length; f++) list.push(withCmd(state, { type: families[f] }));
    return list;
  }
  function withCmd(state, cmd) {
    var r = can(state, cmd);
    var out = { type: cmd.type, enabled: r.ok, reason: r.reason };
    if (cmd.layer !== undefined) out.layer = cmd.layer;
    if (cmd.id !== undefined) out.id = cmd.id;
    if (r.cost !== undefined) out.cost = r.cost;
    if (r.layer !== undefined) out.layer = r.layer;
    return out;
  }

  // --------------------------------------------------------------- commands ---
  // Mutates state in place (session clones before dispatch for undo/replay).
  // Returns {ok, reason, events?}. Never throws on bad input.
  function applyCommand(state, cmd) {
    if (!cmd || typeof cmd.type !== 'string') {
      state.stats.invalidActions++;
      return { ok: false, reason: 'malformed-command' };
    }
    var check = can(state, cmd);
    if (!check.ok) {
      state.stats.invalidActions++;
      return { ok: false, reason: check.reason };
    }
    state.stats.playerCommands++;
    var events = [];
    switch (cmd.type) {
      case 'assign':
        state.layers[cmd.layer].workers++;
        state.workers.idle--;
        events.push({ type: 'assign', layer: cmd.layer });
        break;
      case 'unassign':
        state.layers[cmd.layer].workers--;
        state.workers.idle++;
        events.push({ type: 'unassign', layer: cmd.layer });
        break;
      case 'hire':
        state.coins -= hireCost(state);
        state.hires++;
        state.workers.total++;
        state.workers.idle++;
        events.push({ type: 'hire' });
        break;
      case 'upgrade_shaft':
        state.coins -= shaftCost(state, cmd.layer);
        state.layers[cmd.layer].shaftLevel++;
        events.push({ type: 'upgrade_shaft', layer: cmd.layer });
        break;
      case 'upgrade_lift_cap':
        state.coins -= liftCapCost(state);
        state.lift.capLevel++;
        events.push({ type: 'upgrade_lift_cap' });
        break;
      case 'upgrade_lift_speed':
        state.coins -= liftSpeedCost(state);
        state.lift.speedLevel++;
        events.push({ type: 'upgrade_lift_speed' });
        break;
      case 'unlock_layer': {
        var idx = nextLockedLayer(state);
        state.coins -= unlockCost(state);
        state.layers[idx].unlocked = true;
        events.push({ type: 'unlock_layer', layer: idx });
        break;
      }
      case 'claim_flare': {
        var f = state.flare.active;
        var bonus = flareBonus(state, f.layer);
        var credits = Math.floor(bonus * layerValuePerMilliOre(state, f.layer));
        state.coins += credits;
        state.flareEarned += credits;
        state.lifetimeEarned += credits;
        state.stats.flaresClaimed++;
        state.layers[f.layer].flaresClaimed = (state.layers[f.layer].flaresClaimed || 0) + 1;
        events.push({ type: 'claim_flare', layer: f.layer, credits: credits, id: f.id });
        state.flare.active = null;
        scheduleNextFlare(state, false);
        break;
      }
      case 'buy_foreman':
        state.coins -= state.ruleset.foremanCost;
        state.foreman.unlocked = true;
        state.foreman.enabled = true;
        events.push({ type: 'buy_foreman' });
        break;
      case 'toggle_foreman':
        state.foreman.enabled = !state.foreman.enabled;
        events.push({ type: 'toggle_foreman', enabled: state.foreman.enabled });
        break;
      case 'end_run':
        // quitting counts as a win only in objective-free (endless) runs
        state.terminal = { reason: 'player-ended', tick: state.tick, won: !state.ruleset.goals };
        events.push({ type: 'terminal', reason: 'player-ended' });
        break;
    }
    checkTerminal(state, events);
    return { ok: true, reason: REASONS.OK, events: events };
  }

  // -------------------------------------------------------------- advance ---
  // Advance simulation by whole milliseconds (quantized by session to STEP_MS).
  function advance(state, ms) {
    if (state.terminal || ms <= 0) return [];
    var events = [];
    var remaining = ms;
    while (remaining > 0 && !state.terminal) {
      var step = Math.min(remaining, STEP_MS - (state.tickMs % STEP_MS) || STEP_MS);
      step = Math.min(step, remaining);
      simulateStep(state, step, events);
      remaining -= step;
    }
    return events;
  }

  function simulateStep(state, dtMs, events) {
    state.tickMs += dtMs;
    while (state.tickMs >= 1000) { state.tickMs -= 1000; state.tick++; }

    var rs = state.ruleset;

    // 1. extraction
    for (var i = 0; i < state.layers.length; i++) {
      var L = state.layers[i];
      if (!L.unlocked || L.workers <= 0) continue;
      var rate = layerRate(state, i); // milli-ore/sec
      var produced = rate * dtMs + L.carry;
      L.milliOre += Math.floor(produced / 1000);
      L.carry = produced % 1000;
      var cap = binCapMilli(state, i);
      if (L.milliOre > cap) { L.milliOre = cap; } // bin full: overflow stalls extraction
    }

    // 2. transport + sale (deepest-first priority, continuous approximation)
    if (rs.mechanics.lift) {
      var haulBudget = liftRate(state) * dtMs; // milli-ore*ms scaled: rate is milli-ore/sec
      for (var j = state.layers.length - 1; j >= 0; j--) {
        if (haulBudget <= 0) break;
        var Lj = state.layers[j];
        if (!Lj.unlocked || Lj.milliOre <= 0) continue;
        var want = haulBudget + Lj.haulCarry;
        var take = Math.min(Lj.milliOre, Math.floor(want / 1000));
        Lj.haulCarry = want % 1000;
        if (take > 0) {
          Lj.milliOre -= take;
          var credits = Math.floor(take * layerValuePerMilliOre(state, j));
          state.coins += credits;
          state.lifetimeEarned += credits;
          state.stats.soldMilliOre += take;
          state.lift.transitMilliOre = take; // cosmetic hint for renderer
          haulBudget -= take * 1000;
        }
      }
    }

    // 3. flare schedule
    if (rs.mechanics.flares) {
      if (state.flare.active && state.flare.active.expiresTick <= state.tick) {
        events.push({ type: 'flare_expired', layer: state.flare.active.layer, id: state.flare.active.id });
        state.flare.active = null;
        scheduleNextFlare(state, false);
      }
      if (!state.flare.active && state.tick >= state.flare.nextAt) {
        var unlockedIdxs = [];
        for (var u = 0; u < state.layers.length; u++) if (state.layers[u].unlocked) unlockedIdxs.push(u);
        if (unlockedIdxs.length) {
          var r = rngInt(state.rngState, 0, unlockedIdxs.length - 1);
          state.rngState = r.state;
          state.flare.counter++;
          state.flare.active = {
            layer: unlockedIdxs[r.value],
            id: state.flare.counter,
            expiresTick: state.tick + rs.flareDurationSec
          };
          events.push({ type: 'flare_started', layer: state.flare.active.layer, id: state.flare.counter });
        } else {
          scheduleNextFlare(state, false);
        }
      }
    }

    // 4. foreman automation
    if (state.foreman.unlocked && state.foreman.enabled) {
      state.foreman.cooldownMs -= dtMs;
      if (state.foreman.cooldownMs <= 0) {
        state.foreman.cooldownMs += Math.floor(rs.foremanIntervalSec * 1000);
        foremanAct(state, events);
      }
    }

    // 5. stats + terminal
    var rate = totalExtractionRate(state);
    if (rate > state.stats.maxRateMilliOreSec) state.stats.maxRateMilliOreSec = rate;
    checkTerminal(state, events);
  }

  // A bin counts as blocked at 98% full: transport skims a little each step,
  // so the equilibrium sits a hair under the hard cap.
  function isBlocked(state, i) {
    return state.layers[i].milliOre >= binCapMilli(state, i) * 0.98;
  }

  // Deterministic automation: assign idle workers to the highest-value
  // non-blocked layer, then buy the most pressing upgrade if affordable.
  function foremanAct(state, events) {
    // assign idle workers
    while (state.workers.idle > 0) {
      var best = -1, bestScore = 0;
      for (var i = 0; i < state.layers.length; i++) {
        var L = state.layers[i];
        if (!L.unlocked || L.workers >= state.ruleset.workerCapPerLayer) continue;
        var blocked = isBlocked(state, i);
        var score = state.ruleset.layerRich[i] * shaftMult(state, i) * state.ruleset.layerValue[i];
        if (blocked) score = Math.floor(score / 4);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) break;
      state.layers[best].workers++;
      state.workers.idle--;
      events.push({ type: 'assign', layer: best, auto: true });
    }
    // bottleneck logic: if any bin is blocked, upgrade lift; else hire/work deeper
    var anyBlocked = false;
    for (var b = 0; b < state.layers.length; b++) {
      if (state.layers[b].unlocked && isBlocked(state, b)) { anyBlocked = true; break; }
    }
    var tries = [
      anyBlocked ? { type: 'upgrade_lift_cap' } : { type: 'hire' },
      anyBlocked ? { type: 'upgrade_lift_speed' } : { type: 'unlock_layer' },
      { type: 'hire' }
    ];
    for (var t = 0; t < tries.length; t++) {
      var c = can(state, tries[t]);
      if (c.ok) {
        applyCommand(state, tries[t]);
        events.push({ type: 'foreman_buy', action: tries[t].type });
        break;
      }
    }
  }

  // -------------------------------------------------------------- terminal ---
  function checkTerminal(state, events) {
    if (state.terminal) return;
    var g = state.ruleset.goals;
    var lim = state.ruleset.limits;
    if (g) {
      var done = false;
      if (g.type === 'earn') done = state.lifetimeEarned >= g.amount;
      else if (g.type === 'depth') done = nextLockedLayer(state) === -1 || unlockedCount(state) >= g.amount;
      else if (g.type === 'rate') done = totalExtractionRate(state) >= g.amount;
      if (done) {
        state.terminal = { reason: 'goal-complete', tick: state.tick, won: true };
        events.push({ type: 'terminal', reason: 'goal-complete' });
        return;
      }
    }
    if (lim) {
      if (lim.timeSec && state.tick >= lim.timeSec) {
        state.terminal = { reason: 'time-up', tick: state.tick, won: !g };
        events.push({ type: 'terminal', reason: 'time-up' });
        return;
      }
      if (lim.moves && state.stats.playerCommands >= lim.moves && !state.terminal) {
        state.terminal = { reason: 'moves-exhausted', tick: state.tick, won: !g };
        events.push({ type: 'terminal', reason: 'moves-exhausted' });
      }
    }
  }
  function unlockedCount(state) {
    var n = 0;
    for (var i = 0; i < state.layers.length; i++) if (state.layers[i].unlocked) n++;
    return n;
  }

  // --------------------------------------------------------------- scoring ---
  // Transparent component breakdown (spec §2). All integers.
  function score(state) {
    var earned = state.lifetimeEarned;                       // milli-credits
    var depthBonus = unlockedCount(state) * 250 * COIN_SCALE;
    var flareBonus = state.flareEarned;
    var par = state.ruleset.parSec || 0;
    var timeBonus = 0;
    if (state.terminal && state.terminal.won && state.ruleset.goals && par > 0 && state.tick < par) {
      timeBonus = Math.floor((par - state.tick) * 50 * (COIN_SCALE / 10)); // 5 credits/sec under par
    }
    var efficiency = 0;
    if (state.tick > 0 && state.stats.soldMilliOre > 0) {
      // share of extracted ore that actually sold (never below 0)
      var extracted = state.stats.soldMilliOre;
      for (var i = 0; i < state.layers.length; i++) extracted += state.layers[i].milliOre;
      efficiency = extracted > 0 ? Math.floor((state.stats.soldMilliOre * 1000) / extracted) : 0;
    }
    var total = earned + depthBonus + flareBonus + timeBonus;
    return {
      total: total,
      components: {
        earned: earned,
        flares: flareBonus,
        depthBonus: depthBonus,
        timeBonus: timeBonus,
        efficiencyPermille: efficiency
      }
    };
  }

  // Tie-break comparison (spec §2): primary completion, fewer invalid actions,
  // lower elapsed time, then stable session id. Returns <0 if a ranks higher.
  function compareRuns(a, b) {
    if (!!a.terminal !== !!b.terminal) return a.terminal ? -1 : 1;
    if (a.terminal && b.terminal && a.terminal.won !== b.terminal.won) return a.terminal.won ? -1 : 1;
    var sa = score(a).total, sb = score(b).total;
    if (sa !== sb) return sb - sa;
    if (a.stats.invalidActions !== b.stats.invalidActions) return a.stats.invalidActions - b.stats.invalidActions;
    if (a.tick !== b.tick) return a.tick - b.tick;
    return 0;
  }

  // -------------------------------------------------------- serialization ---
  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (typeof s !== 'object' || s === null || typeof s.version !== 'number') throw new Error('bad-state');
    return migrate(s);
  }
  // Versioned migrations. v1 is current; kept as an explicit chain for tests.
  function migrate(s) {
    while (s.version < VERSION) {
      // future migrations go here, one step at a time
      s.version++;
    }
    return s;
  }

  function canonical(v) { // deterministic stringify with sorted keys
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    var keys = Object.keys(v).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) parts.push(JSON.stringify(keys[i]) + ':' + canonical(v[keys[i]]));
    return '{' + parts.join(',') + '}';
  }
  function hashState(state) { return hashString(canonical(state)) >>> 0; }
  function clone(state) { return JSON.parse(JSON.stringify(state)); }

  // ------------------------------------------------------------- inspection ---
  // Concise board model for screen readers / debug views (spec §3).
  function describeState(state) {
    var lines = [];
    lines.push('Credits: ' + formatCoins(state.coins) + ', income about ' + formatCoins(incomeRate(state)) + ' per second.');
    lines.push('Workers: ' + state.workers.total + ' total, ' + state.workers.idle + ' idle.');
    for (var i = 0; i < state.layers.length; i++) {
      var L = state.layers[i];
      if (!L.unlocked) { lines.push('Layer ' + (i + 1) + ': sealed.'); continue; }
      var blocked = isBlocked(state, i);
      lines.push('Layer ' + (i + 1) + ': ' + L.workers + ' workers, shaft level ' + L.shaftLevel +
        ', bin ' + Math.floor((L.milliOre * 100) / binCapMilli(state, i)) + '% full' + (blocked ? ' (blocked — upgrade transport)' : '') +
        (state.flare.active && state.flare.active.layer === i ? ', seam flare active' : '') + '.');
    }
    lines.push('Lift: capacity level ' + state.lift.capLevel + ', speed level ' + state.lift.speedLevel +
      ', moves ' + Math.floor(liftRate(state)) + ' milli-ore per second.');
    if (state.terminal) lines.push('Run ended: ' + state.terminal.reason + '.');
    return lines.join('\n');
  }

  // Presentation helpers (formatting lives here so all UIs agree)
  function formatCoins(milli) {
    var c = Math.floor(milli / COIN_SCALE);
    if (c >= 1e6) return (c / 1e6).toFixed(2) + 'M';
    if (c >= 1e4) return (c / 1e3).toFixed(1) + 'k';
    return c.toLocaleString('en-US');
  }
  function formatOre(milli) { return (milli / ORE_SCALE).toFixed(1); }
  function formatRate(milliPerSec) { return (milliPerSec / ORE_SCALE).toFixed(1) + '/s'; }

  return {
    VERSION: VERSION,
    ORE_SCALE: ORE_SCALE,
    COIN_SCALE: COIN_SCALE,
    STEP_MS: STEP_MS,
    REASONS: REASONS,
    rngNext: rngNext,
    rngInt: rngInt,
    hashString: hashString,
    defaultRuleset: defaultRuleset,
    mergeRuleset: mergeRuleset,
    createState: createState,
    can: can,
    legalActions: legalActions,
    applyCommand: applyCommand,
    advance: advance,
    score: score,
    compareRuns: compareRuns,
    serialize: serialize,
    deserialize: deserialize,
    migrate: migrate,
    hashState: hashState,
    clone: clone,
    isBlocked: isBlocked,
    layerRate: layerRate,
    liftRate: liftRate,
    liftCapacity: liftCapacity,
    liftCycleMs: liftCycleMs,
    binCapMilli: binCapMilli,
    totalExtractionRate: totalExtractionRate,
    incomeRate: incomeRate,
    hireCost: hireCost,
    shaftCost: shaftCost,
    liftCapCost: liftCapCost,
    liftSpeedCost: liftSpeedCost,
    unlockCost: unlockCost,
    nextLockedLayer: nextLockedLayer,
    unlockedCount: unlockedCount,
    flareBonus: flareBonus,
    describeState: describeState,
    formatCoins: formatCoins,
    formatOre: formatOre,
    formatRate: formatRate
  };
});
