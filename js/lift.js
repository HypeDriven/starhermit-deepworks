/**
 * Deepworks — the lift's cosmetic itinerary (pure, no rendering): the trips
 * the scene animates, summarising the continuous economy into deepest-first
 * loads. Each trip keeps its route and capacity until unloading, even
 * during upgrades. Shared by native/render.ts and the node tests.
 * UMD: exposes `DWLift` in the engine, module.exports in Node.
 */
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var R = isNode ? require('./rules.js') : root.DWRules;
  if (isNode) module.exports = factory(R);
  else root.DWLift = factory(R);
})(typeof self !== 'undefined' ? self : this, function (RULES) {
  'use strict';

  // The scene's measures the trips dock to (native/render.ts CONFIG).
  var CONFIG = { surfaceY: 1.2, firstLayerY: -2.0, spacing: 3.2, layerHeight: 2.1, maxLayers: 6 };

  function smooth01(t) { return t * t * (3 - 2 * t); }

  // Cosmetic trips summarize the continuous economy into deepest-first loads.
  // Each trip keeps its route and capacity until unloading, even during upgrades.
  function planLiftTrip(state) {
    if (!state.ruleset.mechanics.lift) return null;
    var capacity = RULES.liftCapacity(state);
    var cycle = RULES.liftCycleMs(state) / 1000;
    var stops = [], carried = 0;
    for (var i = Math.min(state.layers.length, CONFIG.maxLayers) - 1; i >= 0; i--) {
      var layer = state.layers[i];
      if (!layer.unlocked) continue;
      var available = layer.milliOre + RULES.layerRate(state, i) * cycle;
      var amount = Math.min(Math.max(0, available), capacity - carried);
      if (amount <= 0) continue;
      stops.push({ layer: i, before: carried / capacity, after: (carried + amount) / capacity });
      carried += amount;
      if (carried >= capacity) break;
    }
    if (!stops.length) return null;
    var loadSeconds = 0.45, unloadSeconds = 0.35;
    var travelSeconds = Math.max(0.6, cycle - stops.length * loadSeconds - unloadSeconds);
    var surface = CONFIG.surfaceY - 0.09;
    function floor(i) { return CONFIG.firstLayerY - i * CONFIG.spacing - CONFIG.layerHeight / 2 - 0.09; }
    var distance = 2 * (surface - floor(stops[0].layer));
    var segments = [], elapsed = 0, from = -1, fill = 0;
    function add(kind, to, seconds, nextFill) {
      segments.push({ kind: kind, from: from, to: to, start: elapsed, duration: seconds, before: fill, after: nextFill });
      elapsed += seconds; from = to; fill = nextFill;
    }
    stops.forEach(function (stop) {
      var fromY = from < 0 ? surface : floor(from);
      add('travel', stop.layer, travelSeconds * Math.abs(fromY - floor(stop.layer)) / distance, fill);
      add('load', stop.layer, loadSeconds, stop.after);
    });
    add('travel', -1, travelSeconds * (surface - floor(from)) / distance, fill);
    add('unload', -1, unloadSeconds, 0);
    return { segments: segments, duration: elapsed };
  }

  function sampleLiftTrip(trip, elapsed, floorYs) {
    var surface = CONFIG.surfaceY - 0.09;
    if (!trip) return { y: surface, fill: 0, phase: 'idle' };
    var segments = trip.segments;
    var seg = segments[segments.length - 1];
    for (var i = 0; i < segments.length; i++) {
      if (elapsed < segments[i].start + segments[i].duration) { seg = segments[i]; break; }
    }
    var t = smooth01(Math.max(0, Math.min(1, (elapsed - seg.start) / seg.duration)));
    function y(index) { return index < 0 ? surface : floorYs[index] - 0.09; }
    return {
      y: y(seg.from) + (y(seg.to) - y(seg.from)) * t,
      fill: seg.before + (seg.after - seg.before) * t,
      phase: seg.kind
    };
  }

  return { CONFIG: CONFIG, planLiftTrip: planLiftTrip, sampleLiftTrip: sampleLiftTrip };
});
