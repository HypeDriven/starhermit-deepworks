/**
 * Deepworks — content module.
 * Versioned, data-driven content: themes, tutorial lessons, journey stages,
 * challenge variants, and the daily ruleset generator (spec §2, §7).
 *
 * Every content entry carries: id, version, seed, ruleset overrides, goals,
 * allowed mechanics, par values, tutorial flags and presentation theme.
 *
 * UMD: exposes `DWContent` in the browser, module.exports in Node.
 */
(function (root, factory) {
  var R = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.DWRules;
  if (typeof module === 'object' && module.exports) module.exports = factory(R);
  else root.DWContent = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var CONTENT_VERSION = 1;

  // --------------------------------------------------------------- themes ---
  // Five visual themes; cosmetic only (spec §7: cosmetics never affect rules).
  var THEMES = [
    {
      id: 'emberdeep', name: 'Emberdeep',
      rock: 0x2b1d18, rockDark: 0x191009, seam: 0xff9a3c, seamHot: 0xffd28a,
      fog: 0x140b06, key: 0xffc890, fill: 0x3a4a66, accent: 0xffb35c, lift: 0x8a97a8,
      ambience: 'warm'
    },
    {
      id: 'glacier', name: 'Glacier Vault',
      rock: 0x1d2733, rockDark: 0x0e141d, seam: 0x6fd6ff, seamHot: 0xd6f4ff,
      fog: 0x0a121a, key: 0xbfe6ff, fill: 0x24455e, accent: 0x8fe0ff, lift: 0x7f93a6,
      ambience: 'cold'
    },
    {
      id: 'verdant', name: 'Verdant Hollow',
      rock: 0x1e2a1c, rockDark: 0x0f160e, seam: 0x7dff9e, seamHot: 0xd8ffd8,
      fog: 0x0b130a, key: 0xd2ffc8, fill: 0x2e4a3a, accent: 0x9dffb4, lift: 0x8898a0,
      ambience: 'organic'
    },
    {
      id: 'amethyst', name: 'Amethyst Rift',
      rock: 0x241d2e, rockDark: 0x120d19, seam: 0xc07dff, seamHot: 0xecd8ff,
      fog: 0x100a16, key: 0xe0c8ff, fill: 0x3a2e4e, accent: 0xd09aff, lift: 0x8d8a9e,
      ambience: 'mystic'
    },
    {
      id: 'ashen', name: 'Ashen Gallery',
      rock: 0x26262a, rockDark: 0x131316, seam: 0xffe066, seamHot: 0xfff4c2,
      fog: 0x0d0d0f, key: 0xfff0c0, fill: 0x3c3c44, accent: 0xffe066, lift: 0x9099a4,
      ambience: 'neutral'
    }
  ];
  function themeById(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }

  // ------------------------------------------------------------ tutorials ---
  // Learn mode: one rule at a time, each lesson requires performing the action.
  // `require` matches against dispatched commands / events.
  var LESSONS = [
    {
      id: 'learn-1', name: 'Hands in the Dark', version: CONTENT_VERSION,
      theme: 'emberdeep',
      intro: 'Workers dig on their own seam. Assign your idle worker to Layer 1.',
      ruleset: { startWorkers: 3, startCoins: 0, layerCount: 2, startUnlocked: 1, mechanics: { flares: false, foreman: false } },
      setup: function (state) { state.layers[0].workers = 2; state.workers.idle = 1; },
      steps: [
        { text: 'You have 1 idle worker. Assign them to Layer 1 (tap the layer, then Assign — or press {assign}).', require: { type: 'assign', layer: 0 } },
        { text: 'Ore is flowing into the bin and the lift sells it. Wait until you have earned 10 credits.', require: { type: 'earn', amount: 10 * R.COIN_SCALE } }
      ],
      goals: null, parSec: 120
    },
    {
      id: 'learn-2', name: 'Deeper Pockets', version: CONTENT_VERSION,
      theme: 'emberdeep',
      intro: 'Credits buy progress. Hire a worker, then upgrade the shaft.',
      ruleset: { startWorkers: 2, startCoins: 200 * R.COIN_SCALE, layerCount: 2, startUnlocked: 1, mechanics: { flares: false, foreman: false } },
      steps: [
        { text: 'Hire a worker. New hands arrive idle — assign them.', require: { type: 'hire' } },
        { text: 'Assign the idle worker to Layer 1.', require: { type: 'assign', layer: 0 } },
        { text: 'Upgrade the Layer 1 shaft: faster digging and a bigger ore bin.', require: { type: 'upgrade_shaft', layer: 0 } }
      ],
      goals: null, parSec: 120
    },
    {
      id: 'learn-3', name: 'The Lift Is the Limit', version: CONTENT_VERSION,
      theme: 'glacier',
      intro: 'Ore only pays when the lift moves it. A full bin means stalled digging.',
      ruleset: { startWorkers: 5, startCoins: 300 * R.COIN_SCALE, layerCount: 2, startUnlocked: 1, liftCapBase: 2500, liftCycleBase: 6000, mechanics: { flares: false, foreman: false } },
      steps: [
        { text: 'This crew out-digs the lift — watch the bin fill. Upgrade lift capacity.', require: { type: 'upgrade_lift_cap' } },
        { text: 'Now shorten the lift cycle: upgrade lift speed.', require: { type: 'upgrade_lift_speed' } }
      ],
      goals: null, parSec: 150
    },
    {
      id: 'learn-4', name: 'Seam Flares', version: CONTENT_VERSION,
      theme: 'amethyst',
      intro: 'Seams sometimes flare bright. Tap a flaring seam before it fades for an instant payout.',
      ruleset: { startWorkers: 3, startCoins: 100 * R.COIN_SCALE, layerCount: 2, startUnlocked: 1, flareEveryMinSec: 6, flareEveryMaxSec: 8, flareDurationSec: 25, mechanics: { foreman: false } },
      steps: [
        { text: 'A seam will flare any moment. When it glows, claim it (tap it, or press {flare}).', require: { type: 'claim_flare' } }
      ],
      goals: null, parSec: 120
    },
    {
      id: 'learn-5', name: 'Going Deep', version: CONTENT_VERSION,
      theme: 'verdant',
      intro: 'Deeper seams are richer. Unlock Layer 2, crew it, and buy the Foreman to automate assignments.',
      ruleset: { startWorkers: 3, startCoins: 1200 * R.COIN_SCALE, layerCount: 3, startUnlocked: 1, foremanCost: 300 * R.COIN_SCALE },
      steps: [
        { text: 'Unlock Layer 2. Deeper seams are richer per worker.', require: { type: 'unlock_layer' } },
        { text: 'Assign a worker to Layer 2.', require: { type: 'assign', layer: 1 } },
        { text: 'Buy the Foreman — it assigns idle workers and fixes bottlenecks automatically.', require: { type: 'buy_foreman' } }
      ],
      goals: null, parSec: 180
    }
  ];

  // ------------------------------------------------------------- journey ---
  // 40 authored stages. Each is an explicit param block over the standard
  // ruleset; every 5th stage is a mastery stage combining recent mechanics.
  // Fields: name, theme, ov (ruleset overrides), goal, parSec, hint.
  var J = [];
  function stage(n, name, theme, ov, goal, parSec, hint) {
    J.push({
      id: 'journey-' + n, n: n, name: name, version: CONTENT_VERSION,
      seed: R.hashString('deepworks.journey.' + n),
      theme: theme, overrides: ov, goals: goal, parSec: parSec, hint: hint || ''
    });
  }

  // Block 1 (1–5): extraction fundamentals
  stage(1, 'First Shift', 'emberdeep',
    { startCoins: 80e3, startWorkers: 2, layerCount: 2, mechanics: { flares: false, foreman: false } },
    { type: 'earn', amount: 500e3 }, 220, 'Assign workers, hire when you can.');
  stage(2, 'Full Crew', 'emberdeep',
    { startCoins: 120e3, startWorkers: 3, layerCount: 2, mechanics: { flares: false, foreman: false } },
    { type: 'earn', amount: 1200e3 }, 380, 'Hiring compounds — idle hands earn nothing.');
  stage(3, 'Sharp Picks', 'emberdeep',
    { startCoins: 200e3, startWorkers: 3, layerCount: 2, mechanics: { flares: false, foreman: false } },
    { type: 'earn', amount: 2500e3 }, 460, 'Shaft upgrades raise rate and bin size.');
  stage(4, 'Rich Vein', 'glacier',
    { startCoins: 150e3, startWorkers: 3, layerCount: 3, startUnlocked: 2, unlockBase: 250e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 4000e3 }, 300, 'Flares are free money — do not miss them.');
  stage(5, 'Mastery: Extraction', 'emberdeep',
    { startCoins: 100e3, startWorkers: 2, layerCount: 3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 8000e3 }, 460, 'Everything so far, together.');

  // Block 2 (6–10): transport pressure
  stage(6, 'Narrow Cage', 'glacier',
    { startCoins: 200e3, startWorkers: 4, layerCount: 3, liftCapBase: 5000, mechanics: { flares: false, foreman: false } },
    { type: 'earn', amount: 6000e3 }, 750, 'A weak lift caps your income.');
  stage(7, 'Slow Winch', 'glacier',
    { startCoins: 200e3, startWorkers: 4, layerCount: 3, liftCycleBase: 7000, mechanics: { flares: false, foreman: false } },
    { type: 'earn', amount: 6000e3 }, 820, 'Cycle time is the other half of transport.');
  stage(8, 'Overflow', 'glacier',
    { startCoins: 250e3, startWorkers: 5, layerCount: 3, liftCapBase: 4000, binCap: [20000, 30000, 45000, 130000, 190000, 270000], mechanics: { flares: false, foreman: false } },
    { type: 'earn', amount: 9000e3 }, 950, 'Full bins stall digging. Watch the gauges.');
  stage(9, 'Two Deep', 'verdant',
    { startCoins: 300e3, startWorkers: 4, layerCount: 4, startUnlocked: 2, unlockBase: 200e3, mechanics: { flares: true, foreman: false } },
    { type: 'depth', amount: 4 }, 300, 'Depth pays more per worker — if the lift keeps up.');
  stage(10, 'Mastery: Transport', 'glacier',
    { startCoins: 250e3, startWorkers: 4, layerCount: 4, liftCapBase: 6000, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 20000e3 }, 560, 'Balance crews against the cage.');

  // Block 3 (11–15): depth economics
  stage(11, 'Second Cut', 'verdant',
    { startCoins: 400e3, startWorkers: 4, layerCount: 4, startUnlocked: 2, unlockBase: 300e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 30000e3 }, 480, 'Unlock early; deeper ore sells higher.');
  stage(12, 'Heavy Boots', 'verdant',
    { startCoins: 350e3, startWorkers: 3, layerCount: 4, startUnlocked: 3, hireBase: 80e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 40000e3 }, 380, 'Labour is expensive here — upgrade what you have.');
  stage(13, 'Thin Air', 'amethyst',
    { startCoins: 400e3, startWorkers: 4, layerCount: 5, startUnlocked: 3, unlockBase: 350e3, mechanics: { flares: true, foreman: false } },
    { type: 'depth', amount: 5 }, 320, 'The fifth seam is worth the dig.');
  stage(14, 'Flare Country', 'amethyst',
    { startCoins: 400e3, startWorkers: 4, layerCount: 4, startUnlocked: 2, flareEveryMinSec: 20, flareEveryMaxSec: 35, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 60000e3 }, 480, 'Frequent flares. Stay alert.');
  stage(15, 'Mastery: Depth', 'verdant',
    { startCoins: 300e3, startWorkers: 3, layerCount: 5, startUnlocked: 2, unlockBase: 300e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 100000e3 }, 760, 'Deep seams, thin lift. Prioritize.');

  // Block 4 (16–20): automation
  stage(16, 'Hired Help', 'ashen',
    { startCoins: 1500e3, startWorkers: 4, layerCount: 4, startUnlocked: 2, foremanCost: 500e3, mechanics: { flares: true, foreman: true } },
    { type: 'earn', amount: 120000e3 }, 640, 'The Foreman handles routine. You handle strategy.');
  stage(17, 'Hands Off', 'ashen',
    { startCoins: 2000e3, startWorkers: 3, layerCount: 4, startUnlocked: 2, foremanCost: 400e3, mechanics: { flares: true, foreman: true } },
    { type: 'earn', amount: 180000e3 }, 760, 'Automate early, then out-plan the machine.');
  stage(18, 'Six Seams', 'amethyst',
    { startCoins: 1500e3, startWorkers: 5, layerCount: 6, startUnlocked: 3, unlockBase: 500e3, mechanics: { flares: true, foreman: true } },
    { type: 'depth', amount: 6 }, 420, 'The bottom seam glows brightest.');
  stage(19, 'Pressure Valve', 'glacier',
    { startCoins: 2000e3, startWorkers: 6, layerCount: 5, startUnlocked: 3, liftCapBase: 8000, mechanics: { flares: true, foreman: true } },
    { type: 'rate', amount: 300000 }, 650, 'Sustain 300 ore per second extraction.');
  stage(20, 'Mastery: Automation', 'ashen',
    { startCoins: 1800e3, startWorkers: 4, layerCount: 5, startUnlocked: 2, foremanCost: 450e3, mechanics: { flares: true, foreman: true } },
    { type: 'earn', amount: 400000e3 }, 860, 'Let the Foreman grind; spend on leverage.');

  // Block 5 (21–25): constrained budgets
  stage(21, 'Shoestring', 'emberdeep',
    { startCoins: 60e3, startWorkers: 2, layerCount: 3, hireBase: 60e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 15000e3 }, 580, 'Every credit matters. No waste.');
  stage(22, 'Skeleton Crew', 'glacier',
    { startCoins: 500e3, startWorkers: 2, layerCount: 4, startUnlocked: 2, hireBase: 300e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 80000e3 }, 520, 'Hiring hurts. Shafts and lift carry you.');
  stage(23, 'Single Seam', 'verdant',
    { startCoins: 300e3, startWorkers: 4, layerCount: 3, startUnlocked: 1, unlockBase: 400e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 60000e3 }, 820, 'One rich seam or many poor ones?');
  stage(24, 'Rust Belt', 'ashen',
    { startCoins: 400e3, startWorkers: 4, layerCount: 4, startUnlocked: 2, liftCycleBase: 8000, liftSpeedCostBase: 150e3, mechanics: { flares: true, foreman: true }, foremanCost: 600e3 },
    { type: 'earn', amount: 150000e3 }, 900, 'The winch is ancient. Budget for speed.');
  stage(25, 'Mastery: Scarcity', 'emberdeep',
    { startCoins: 150e3, startWorkers: 2, layerCount: 4, startUnlocked: 1, unlockBase: 350e3, hireBase: 70e3, mechanics: { flares: true, foreman: false } },
    { type: 'earn', amount: 200000e3 }, 1250, 'From nothing to a fortune.');

  // Block 6 (26–30): rate targets
  stage(26, 'Quota', 'glacier',
    { startCoins: 600e3, startWorkers: 5, layerCount: 4, startUnlocked: 2, mechanics: { flares: true, foreman: true }, foremanCost: 500e3 },
    { type: 'rate', amount: 150000 }, 700, 'Reach 150 ore per second.');
  stage(27, 'Double Time', 'verdant',
    { startCoins: 800e3, startWorkers: 6, layerCount: 5, startUnlocked: 3, mechanics: { flares: true, foreman: true }, foremanCost: 500e3 },
    { type: 'rate', amount: 300000 }, 700, 'Reach 300 ore per second.');
  stage(28, 'White Line', 'amethyst',
    { startCoins: 1000e3, startWorkers: 6, layerCount: 5, startUnlocked: 3, liftCapBase: 12000, mechanics: { flares: true, foreman: true }, foremanCost: 550e3 },
    { type: 'rate', amount: 400000 }, 800, '500 per second — the lift must not lag.');
  stage(29, 'Full Saturation', 'ashen',
    { startCoins: 1200e3, startWorkers: 8, layerCount: 6, startUnlocked: 4, workerCapPerLayer: 6, mechanics: { flares: true, foreman: true }, foremanCost: 600e3 },
    { type: 'rate', amount: 800000 }, 1000, '800 per second. Crew every seam.');
  stage(30, 'Mastery: Throughput', 'glacier',
    { startCoins: 700e3, startWorkers: 5, layerCount: 6, startUnlocked: 3, mechanics: { flares: true, foreman: true }, foremanCost: 550e3 },
    { type: 'rate', amount: 700000 }, 1000, '1200 per second. Balance everything.');

  // Block 7 (31–35): long hauls
  stage(31, 'Night Shift', 'amethyst',
    { startCoins: 900e3, startWorkers: 5, layerCount: 5, startUnlocked: 3, flareEveryMinSec: 50, flareEveryMaxSec: 90, mechanics: { flares: true, foreman: true }, foremanCost: 500e3 },
    { type: 'earn', amount: 800000e3 }, 1180, 'A long, quiet grind.');
  stage(32, 'The Deep Ledger', 'verdant',
    { startCoins: 1000e3, startWorkers: 5, layerCount: 6, startUnlocked: 3, unlockBase: 600e3, mechanics: { flares: true, foreman: true }, foremanCost: 550e3 },
    { type: 'earn', amount: 1500000e3 }, 1220, 'A million and a half. Compound patiently.');
  stage(33, 'Old Money', 'ashen',
    { startCoins: 2000e3, startWorkers: 6, layerCount: 6, startUnlocked: 4, hireBase: 100e3, mechanics: { flares: true, foreman: true }, foremanCost: 600e3 },
    { type: 'earn', amount: 1500000e3 }, 1000, 'Rich start, rich target.');
  stage(34, 'Blackout', 'emberdeep',
    { startCoins: 800e3, startWorkers: 4, layerCount: 5, startUnlocked: 2, mechanics: { flares: false, foreman: true }, foremanCost: 500e3 },
    { type: 'earn', amount: 800000e3 }, 1300, 'No flares. Pure engineering.');
  stage(35, 'Mastery: Endurance', 'amethyst',
    { startCoins: 700e3, startWorkers: 4, layerCount: 6, startUnlocked: 2, unlockBase: 500e3, mechanics: { flares: true, foreman: true }, foremanCost: 550e3 },
    { type: 'earn', amount: 2000000e3 }, 1700, 'Four million. The long game.');

  // Block 8 (36–40): combined mastery
  stage(36, 'Deep Works', 'glacier',
    { startCoins: 1500e3, startWorkers: 6, layerCount: 6, startUnlocked: 3, liftCapBase: 10000, mechanics: { flares: true, foreman: true }, foremanCost: 500e3 },
    { type: 'rate', amount: 800000 }, 900, '1500 per second from a running start.');
  stage(37, 'The Quiet Mile', 'verdant',
    { startCoins: 500e3, startWorkers: 3, layerCount: 6, startUnlocked: 2, unlockBase: 450e3, hireBase: 90e3, mechanics: { flares: true, foreman: true }, foremanCost: 500e3 },
    { type: 'earn', amount: 1500000e3 }, 1450, 'Slow start, deep finish.');
  stage(38, 'Six Bells', 'amethyst',
    { startCoins: 1200e3, startWorkers: 7, layerCount: 6, startUnlocked: 4, workerCapPerLayer: 7, mechanics: { flares: true, foreman: true }, foremanCost: 600e3 },
    { type: 'depth', amount: 6 }, 200, 'Ring every seam open, fast.');
  stage(39, 'Overseer Exam', 'ashen',
    { startCoins: 1000e3, startWorkers: 4, layerCount: 6, startUnlocked: 2, unlockBase: 500e3, liftCapBase: 9000, mechanics: { flares: true, foreman: true }, foremanCost: 450e3 },
    { type: 'earn', amount: 2500000e3 }, 2000, 'Six million. Show mastery of every lever.');
  stage(40, 'Mastery: The Deepworks', 'emberdeep',
    { startCoins: 800e3, startWorkers: 4, layerCount: 6, startUnlocked: 2, unlockBase: 550e3, liftCapBase: 8000, hireBase: 80e3, flareEveryMinSec: 40, flareEveryMaxSec: 80, mechanics: { flares: true, foreman: true }, foremanCost: 500e3 },
    { type: 'earn', amount: 4000000e3 }, 2900, 'Ten million credits. The full works.');

  // ----------------------------------------------------------- challenges ---
  var CHALLENGES = [
    {
      id: 'ch-sprint', name: 'Ten-Minute Sprint', version: CONTENT_VERSION,
      theme: 'emberdeep', seed: R.hashString('deepworks.ch.sprint'),
      description: 'Earn as much as possible in 10 minutes. Score is final earnings.',
      overrides: { startCoins: 200e3, startWorkers: 3, layerCount: 4, startUnlocked: 2 },
      goals: null, limits: { timeSec: 600 }, parSec: 600, endless: false
    },
    {
      id: 'ch-hundred-moves', name: 'Hundred Moves', version: CONTENT_VERSION,
      theme: 'glacier', seed: R.hashString('deepworks.ch.moves'),
      description: 'Reach 100k credits in at most 100 commands. Every click counts.',
      overrides: { startCoins: 400e3, startWorkers: 4, layerCount: 5, startUnlocked: 2, mechanics: { flares: true, foreman: false } },
      goals: { type: 'earn', amount: 100000e3 }, limits: { moves: 100 }, parSec: 900, endless: false
    },
    {
      id: 'ch-no-lift', name: 'Muscle and Bone', version: CONTENT_VERSION,
      theme: 'ashen', seed: R.hashString('deepworks.ch.nolift'),
      description: 'The lift cannot be upgraded. Work within its limits.',
      overrides: { startCoins: 300e3, startWorkers: 4, layerCount: 4, startUnlocked: 2, liftCapBase: 30000, mechanics: { lift: false, flares: true, foreman: false } },
      goals: { type: 'earn', amount: 12000e3 }, limits: { timeSec: 1800 }, parSec: 1300, endless: false
    },
    {
      id: 'ch-half-crew', name: 'Half Crew', version: CONTENT_VERSION,
      theme: 'verdant', seed: R.hashString('deepworks.ch.halfcrew'),
      description: 'Worker cap is halved. Shafts matter more than hands.',
      overrides: { startCoins: 350e3, startWorkers: 3, layerCount: 5, startUnlocked: 2, workerCapPerLayer: 2, mechanics: { flares: true, foreman: false } },
      goals: { type: 'earn', amount: 80000e3 }, limits: { timeSec: 1500 }, parSec: 1000, endless: false
    },
    {
      id: 'ch-deep-start', name: 'Dropped at Depth', version: CONTENT_VERSION,
      theme: 'amethyst', seed: R.hashString('deepworks.ch.deepstart'),
      description: 'Start at Layer 4 with a tiny lift. Climb the value chain.',
      overrides: { startCoins: 500e3, startWorkers: 3, layerCount: 6, startUnlocked: 4, liftCapBase: 4000, liftCycleBase: 7000, mechanics: { flares: true, foreman: true }, foremanCost: 500e3 },
      goals: { type: 'earn', amount: 500000e3 }, limits: { timeSec: 1500 }, parSec: 1000, endless: false
    },
    {
      id: 'ch-flare-frenzy', name: 'Flare Frenzy', version: CONTENT_VERSION,
      theme: 'emberdeep', seed: R.hashString('deepworks.ch.frenzy'),
      description: 'Constant flares, tiny bins. Reflexes over planning.',
      overrides: { startCoins: 150e3, startWorkers: 3, layerCount: 3, startUnlocked: 2, flareEveryMinSec: 8, flareEveryMaxSec: 14, flareBonusMult: 60, binCap: [15000, 20000, 30000, 130000, 190000, 270000], mechanics: { flares: true, foreman: false } },
      goals: { type: 'earn', amount: 60000e3 }, limits: { timeSec: 900 }, parSec: 600, endless: false
    }
  ];

  // ------------------------------------------------------------ practice ---
  var PRACTICE_DIFFICULTIES = [
    { id: 'prospector', name: 'Prospector', overrides: { startCoins: 150e3, startWorkers: 3, layerCount: 3, startUnlocked: 2, hireGrowth: 1.3 } },
    { id: 'miner', name: 'Miner', overrides: {} },
    { id: 'foreman', name: 'Foreman', overrides: { startCoins: 60e3, startWorkers: 2, hireBase: 60e3, unlockBase: 200e3, liftCapBase: 6000 } },
    { id: 'overseer', name: 'Overseer', overrides: { startCoins: 40e3, startWorkers: 2, hireBase: 80e3, unlockBase: 300e3, liftCapBase: 4500, liftCycleBase: 6000, layerCount: 6, startUnlocked: 1 } }
  ];

  // --------------------------------------------------------------- daily ---
  // One shared seed + ruleset per UTC day (spec §2). Immutable after
  // publication: derived purely from the date string.
  function dailyInfo(date) {
    var d = date || new Date();
    var key = d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
    var seed = R.hashString('deepworks.daily.' + key);
    var s = seed;
    function next() { var r = R.rngNext(s); s = r.state; return r.value; }
    function pick(arr) { return arr[Math.floor(next() * arr.length)]; }
    function range(lo, hi) { return lo + Math.floor(next() * (hi - lo + 1)); }

    var layerCount = range(4, 6);
    var overrides = {
      layerCount: layerCount,
      startUnlocked: range(1, 2),
      startWorkers: range(2, 4),
      startCoins: range(100, 400) * R.COIN_SCALE,
      liftCapBase: range(5, 10) * 1000,
      liftCycleBase: range(35, 60) * 100,
      hireBase: range(40, 90) * R.COIN_SCALE,
      unlockBase: range(150, 400) * R.COIN_SCALE,
      flareEveryMinSec: range(25, 45),
      flareEveryMaxSec: range(50, 90)
    };
    var goalType = pick(['earn', 'earn', 'rate', 'depth']);
    var base = {
      id: 'daily-' + key, key: key, version: CONTENT_VERSION, seed: seed,
      theme: pick(THEMES).id,
      overrides: overrides, goals: null,
      limits: { timeSec: 900 },
      parSec: 720, endless: false,
      name: 'Daily Vein — ' + key
    };
    // Self-calibrating goal (spec §2: reachable goals, proven by validator):
    // simulate the deterministic reference player on this exact ruleset and
    // set the goal at a fraction of what it demonstrably achieves.
    var probe = buildState(base);
    var t = 0;
    while (!probe.terminal && t < 900) { R.advance(probe, 2000); t += 2; greedy(probe); R.advance(probe, 0); }
    var goals;
    if (goalType === 'earn') {
      var got = Math.max(probe.lifetimeEarned, 20000 * R.COIN_SCALE / 1000);
      goals = { type: 'earn', amount: Math.floor(got * 0.65) };
    } else if (goalType === 'rate') {
      var maxR = Math.max(probe.stats.maxRateMilliOreSec, 20000);
      goals = { type: 'rate', amount: Math.floor(maxR * 0.8) };
    } else {
      var depth = R.unlockedCount(probe);
      if (depth > overrides.startUnlocked) {
        goals = { type: 'depth', amount: Math.min(layerCount, depth) };
      } else {
        // reference player never dug deeper — fall back to an earn goal
        var got2 = Math.max(probe.lifetimeEarned, 20000 * R.COIN_SCALE / 1000);
        goals = { type: 'earn', amount: Math.floor(got2 * 0.65) };
      }
    }
    base.goals = goals;
    return base;
  }

  // ------------------------------------------------------- content → state ---
  // Build a fresh rules state for any content entry.
  function buildState(content) {
    var ov = {};
    for (var k in (content.overrides || {})) ov[k] = content.overrides[k];
    ov.goals = content.goals || null;
    ov.limits = content.limits || null;
    ov.parSec = (content.parSec !== undefined) ? content.parSec : 600;
    if (content.endless !== undefined) ov.endless = content.endless;
    var state = R.createState(content.seed, ov);
    if (content.setup) content.setup(state);
    return state;
  }

  function journeyByIndex(i) { return J[i] || null; }

  // ------------------------------------------------------------ validators ---
  // Offline content validation (spec §2): legality, reachable goals,
  // bounded duration, absence of soft locks. Heuristic but strict.
  function validateContent(content) {
    var problems = [];
    if (!content.id || typeof content.seed !== 'number') problems.push('missing id/seed');
    if (!themeById(content.theme)) problems.push('unknown theme');
    var state;
    try { state = buildState(content); } catch (e) { problems.push('state build failed: ' + e.message); return problems; }

    // legality: at least one legal action at start
    var legal = R.legalActions(state).filter(function (a) { return a.enabled; });
    if (!legal.length) problems.push('no legal action at start');

    // bounded duration: a run must end by goal, by limit, or be declared endless
    var lim = content.limits || null;
    var isEndless = content.endless === true || (content.overrides && content.overrides.endless === true) ||
      (content.endless === undefined && !content.goals && !(content.overrides && content.overrides.goals));
    if (!content.goals && !(lim && lim.timeSec) && !isEndless) {
      problems.push('unbounded: no goal, no time limit, not endless');
    }

    // reachable goal: rough analytic bound — assume all coins funnel into the
    // best strategy; goal must be achievable within limit by max plausible rate.
    if (content.goals) {
      var g = content.goals;
      var horizon = (lim && lim.timeSec) || content.parSec * 3 || 3600;
      if (g.type === 'earn') {
        // upper bound income: fully crewed deepest unlocked layer with
        // infinite lift, plus starting coins
        var maxRate = 0;
        var rs = state.ruleset;
        for (var i = 0; i < rs.layerCount; i++) {
          maxRate = Math.max(maxRate, rs.layerRich[i] * rs.workerCapPerLayer * (rs.layerValue[i] / R.ORE_SCALE) * 4);
        }
        var bound = state.coins + maxRate * horizon;
        if (bound < g.amount) problems.push('earn goal likely unreachable (' + bound + ' < ' + g.amount + ')');
      } else if (g.type === 'depth') {
        if (g.amount > state.ruleset.layerCount) problems.push('depth goal exceeds layer count');
      } else if (g.type === 'rate') {
        var rs2 = state.ruleset;
        var maxExtract = 0;
        for (var j = 0; j < rs2.layerCount; j++) maxExtract += rs2.layerRich[j] * rs2.workerCapPerLayer * 100; // shaft upgrades multiply base
        if (maxExtract < g.amount) problems.push('rate goal unreachable');
      }
    }

    // soft-lock probe: simulate 5 minutes with a greedy auto-player; the run
    // must keep having legal actions and must make progress.
    var probe = R.clone(state);
    var t = 0;
    while (t < 300 && !probe.terminal) {
      R.advance(probe, 5000);
      t += 5;
      greedy(probe);
    }
    var after = R.legalActions(probe).filter(function (a) { return a.enabled; });
    if (!after.length && !probe.terminal) problems.push('soft lock: no legal actions after 5 min');
    if (probe.lifetimeEarned <= 0 && !probe.terminal) problems.push('no progress possible in 5 min');
    return problems;
  }

  // Greedy reference player used by validators and tests: claims flares,
  // crews idle workers deepest-first, then buys the cheapest available
  // upgrades (including shafts on the fullest layer).
  function greedy(state) {
    function find(type, layer) {
      var actions = R.legalActions(state);
      for (var i = 0; i < actions.length; i++) {
        if (actions[i].type === type && actions[i].enabled &&
          (layer === undefined || actions[i].layer === layer)) return actions[i];
      }
      return null;
    }
    var a;
    while ((a = find('claim_flare'))) R.applyCommand(state, { type: 'claim_flare', layer: a.layer, id: a.id });
    var guard = 20;
    while (guard-- > 0) {
      var acted = false;
      for (var L = state.layers.length - 1; L >= 0; L--) {
        var aa = find('assign', L);
        if (aa) { R.applyCommand(state, { type: 'assign', layer: L }); acted = true; break; }
      }
      if (!acted) break;
    }
    // buy cheapest beneficial upgrades, a few per call
    var buys = 4;
    while (buys-- > 0) {
      var bestLayer = 0, bestWorkers = -1;
      for (var i = 0; i < state.layers.length; i++) {
        if (state.layers[i].unlocked && state.layers[i].workers > bestWorkers) {
          bestWorkers = state.layers[i].workers; bestLayer = i;
        }
      }
      var candidates = [];
      var types = ['upgrade_lift_cap', 'upgrade_lift_speed', 'hire', 'unlock_layer', 'buy_foreman'];
      for (var t = 0; t < types.length; t++) {
        var c = find(types[t]);
        if (c) candidates.push(c);
      }
      var sh = find('upgrade_shaft', bestLayer);
      if (sh) candidates.push(sh);
      if (!candidates.length) break;
      candidates.sort(function (x, y) { return (x.cost || 0) - (y.cost || 0); });
      var pickAction = candidates[0];
      // don't buy upgrades we cannot meaningfully afford to follow up on
      if (pickAction.cost !== undefined && pickAction.cost > state.coins) break;
      var cmd = { type: pickAction.type };
      if (pickAction.layer !== undefined) cmd.layer = pickAction.layer;
      if (pickAction.id !== undefined) cmd.id = pickAction.id;
      var res = R.applyCommand(state, cmd);
      if (!res.ok) break;
      // re-crew after hiring
      var g2 = 10;
      while (g2-- > 0) {
        var acted2 = false;
        for (var L2 = state.layers.length - 1; L2 >= 0; L2--) {
          var aa2 = find('assign', L2);
          if (aa2) { R.applyCommand(state, { type: 'assign', layer: L2 }); acted2 = true; break; }
        }
        if (!acted2) break;
      }
    }
  }

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    THEMES: THEMES,
    themeById: themeById,
    LESSONS: LESSONS,
    JOURNEY: J,
    CHALLENGES: CHALLENGES,
    PRACTICE_DIFFICULTIES: PRACTICE_DIFFICULTIES,
    dailyInfo: dailyInfo,
    buildState: buildState,
    journeyByIndex: journeyByIndex,
    validateContent: validateContent,
    greedy: greedy
  };
});
