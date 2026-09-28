/**
 * Deepworks — Three.js presentation layer.
 *
 * Classic script (no modules): uses the global `THREE` (r128 UMD) and the
 * global `DWRules` for read-only derived values. Exposes `DWRender`.
 *
 * The renderer NEVER mutates rules state; `setSnapshot` only reads it.
 * All decorative motion is a pure function of (state, accumulated time);
 * the only smoothed quantities are critically-damped springs (camera yaw,
 * selection lift), so there is no cumulative lerp drift.
 *
 * Scene: a vertical mine cross-section framed like a tabletop diorama.
 * No external assets; the few textures (sky gradient, sealed-rock cracks)
 * are generated on a canvas at runtime.
 *
 * Graphics quality (`setGraphics`, model in js/gfx.js): shadows, SSAO,
 * HDR bloom, a tone-map + colour-grade output pass, FXAA/SMAA/MSAA,
 * RoomEnvironment reflections, surface detail (bump-mapped rock, clearcoat
 * crystals, helmet lamps), particle density with drifting dust motes,
 * render scale and adaptive resolution. Post-processing uses the r128
 * examples/js passes vendored in vendor/three-r128-addons/.
 */
(function (root) {
  'use strict';

  var THREE = root.THREE;
  var RULES = root.DWRules;
  var GFX = root.DWGfx;

  // -------------------------------------------------------------- config ---
  var CONFIG = {
    seed: 0x5eed1234, // fixed decoration seed (stable across loads)
    fov: 30,
    near: 1.0,               // the nearest geometry is ~25 units away; keeps depth precise for SSAO
    far: 220,
    camPos: { x: 0, y: -6.0, z: 37.0 },
    camTarget: { x: 0, y: -7.2, z: 0 },
    spacing: 3.2,            // vertical distance between layer centers
    firstLayerY: -2.0,       // clear the ground slab, including selection lift
    maxLayers: 6,
    layerWidth: 15,
    layerHeight: 2.1,
    layerDepth: 3.0,
    surfaceY: 1.2,           // top of the ground slab
    shaftWidth: 2.6,
    swayAmp: 0.35,           // idle camera sway, world units (0 in reduced motion)
    swaySpeed: 0.32,
    maxYaw: 0.349,           // drag orbit clamp, radians (±20°)
    tapSlopPx: 8,            // pointer travel that turns a tap into a drag
    yawPerPixel: 0.0035,
    selectLift: 0.32,        // how far a selected layer group rises
    springW: 7.0,            // critically-damped spring frequency
    shakeDecay: 3.0,
    shakeMax: 0.55,
    binX: 5.9,               // ore-bin gauge x inside the cavern
    binZ: 0.9,
    binHeight: 1.5,
    anchorX: 6.8,            // world anchor projected by screenPosForLayer
    anchorZ: 1.2,
    workerSlots: 8,
    crystalMax: 80,          // instances allocated per layer seam
    particleMax: 512,        // pooled cosmetic particles
    dustMax: 36,             // drifting motes allocated per layer
    exposure: 1.15,
    fogNear: 62,
    fogFar: 130
  };

  var DEFAULT_THEME = {
    id: '_fallback', name: 'Fallback',
    rock: 0x754639, rockDark: 0x152d3b, seam: 0xff751f, seamHot: 0xffdfa0,
    fog: 0x091622, key: 0xffd4ab, fill: 0x65b9de, accent: 0xffb653, lift: 0x72b7c6
  };

  // ----------------------------------------------------------------- PRNG ---
  // Local mulberry32 for deterministic decoration only (rules keep their own).
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------- helpers ---
  // Palette swatches are sRGB; lit materials expect linear values.
  function pigment(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }

  function cssColor(hex, mul) {
    var r = Math.min(255, Math.round(((hex >> 16) & 255) * mul));
    var g = Math.min(255, Math.round(((hex >> 8) & 255) * mul));
    var b = Math.min(255, Math.round((hex & 255) * mul));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // Critically-damped spring integrator (semi-implicit Euler). `s` is {v, w}
  // where v = value, w = velocity. Time-based; no drift toward stale targets.
  function springStep(s, target, dt, omega) {
    var x = s.v - target;
    var accel = -omega * omega * x - 2 * omega * s.w;
    s.w += accel * dt;
    s.v += s.w * dt;
  }

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

  // ---------------------------------------------------------------- factory ---
  function create(container, opts) {
    if (!THREE || !container) return null;
    opts = opts || {};
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};
    var theme = opts.theme || DEFAULT_THEME;
    var reducedMotion = !!opts.reducedMotion;
    var gfxSaved = opts.graphics || {};
    var g = GFX.resolve(gfxSaved, 'low'); // replaced once the GPU is known

    var renderer;
    try {
      // antialias is a creation-time flag; quality tiers never change it
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (e) {
      return null; // WebGL unavailable
    }
    if (!renderer.getContext()) return null;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CONFIG.exposure;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // GPU name (unmasked when the browser exposes it) picks the Auto preset.
    var gpuName = '';
    try {
      var gl = renderer.getContext();
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    } catch (e) { gpuName = ''; }
    var mobile = !!opts.mobile;
    var detected = GFX.detectPreset(gpuName, mobile);
    g = GFX.resolve(gfxSaved, detected);

    var canvas = renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '0'; // below DOM UI
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    try {
      if (root.getComputedStyle && root.getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
    } catch (e) { /* non-critical */ }
    container.appendChild(canvas);

    // ------------------------------------------------------- camera rig ---
    // scene → camShake (pulse shake offset) → camYaw (drag orbit) → camera.
    // Shake never touches the projection, so raycast truth is preserved.
    var scene = new THREE.Scene();
    var camShake = new THREE.Group();
    var camYaw = new THREE.Group();
    var camera = new THREE.PerspectiveCamera(CONFIG.fov, 1, CONFIG.near, CONFIG.far);
    camShake.add(camYaw);
    camYaw.add(camera);
    scene.add(camShake);
    camera.position.set(CONFIG.camPos.x, CONFIG.camPos.y, CONFIG.camPos.z);
    camera.lookAt(CONFIG.camTarget.x, CONFIG.camTarget.y, CONFIG.camTarget.z);

    // ---------------------------------------------- generated textures ---
    function makeSkyTexture(th) {
      var c = document.createElement('canvas');
      c.width = 4; c.height = 256;
      var g = c.getContext('2d');
      var grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, cssColor(th.fill, 0.45));
      grad.addColorStop(0.4, cssColor(th.fog, 1.4));
      grad.addColorStop(1, cssColor(th.fog, 0.7));
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 256);
      var tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      return tex;
    }

    function makeCrackTexture(th, sealed) {
      var c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      var g = c.getContext('2d');
      g.fillStyle = cssColor(th.rock, sealed ? 0.6 : 1);
      g.fillRect(0, 0, 256, 128);
      var rnd = mulberry32(CONFIG.seed ^ 0xc4ac);
      // Broad, irregular sediment bands give the cut faces readable structure.
      for (var band = 0; band < 7; band++) {
        var yBand = band * 20;
        g.fillStyle = cssColor(th.rock, (sealed ? 0.42 : 0.72) + rnd() * 0.22);
        g.beginPath(); g.moveTo(0, yBand);
        for (var bx = 0; bx <= 256; bx += 16) g.lineTo(bx, yBand + rnd() * 10);
        g.lineTo(256, yBand + 15); g.lineTo(0, yBand + 15); g.fill();
      }
      g.strokeStyle = cssColor(th.rockDark, 0.7);
      g.lineWidth = 1;
      for (var i = 0; i < 10; i++) {
        var x = rnd() * 256, y = rnd() * 128;
        g.beginPath();
        g.moveTo(x, y);
        var segs = 3 + Math.floor(rnd() * 4);
        for (var s2 = 0; s2 < segs; s2++) {
          x += (rnd() - 0.5) * 42;
          y += (rnd() - 0.5) * 42;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      // Fine grain so flat faces read as stone (and give the bump map relief).
      var img = g.getImageData(0, 0, 256, 128);
      for (var px = 0; px < img.data.length; px += 4) {
        var n = (rnd() - 0.5) * 14;
        img.data[px] = Math.max(0, Math.min(255, img.data[px] + n));
        img.data[px + 1] = Math.max(0, Math.min(255, img.data[px + 1] + n));
        img.data[px + 2] = Math.max(0, Math.min(255, img.data[px + 2] + n));
      }
      g.putImageData(img, 0, 0);
      var tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(3, 1);
      return tex;
    }

    function makeGlowTexture() {
      var c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      var g = c.getContext('2d');
      var grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    }

    var skyTex = makeSkyTexture(theme);
    var crackTex = makeCrackTexture(theme, true);
    var rockTex = makeCrackTexture(theme, false);
    var glowTex = makeGlowTexture();
    scene.background = skyTex;
    scene.fog = new THREE.Fog(theme.fog, CONFIG.fogNear, CONFIG.fogFar);

    // -------------------------------------------------------------- lights ---
    var keyLight = new THREE.DirectionalLight(theme.key, 1.25);
    keyLight.position.set(14, 16, 22);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -18;
    keyLight.shadow.camera.right = 18;
    keyLight.shadow.camera.top = 10;
    keyLight.shadow.camera.bottom = -24;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 90;
    keyLight.target.position.set(0, -7, 0);
    scene.add(keyLight);
    scene.add(keyLight.target);
    var hemiLight = new THREE.HemisphereLight(theme.fill, theme.rockDark, 1.3);
    scene.add(hemiLight);
    var rimLight = new THREE.DirectionalLight(theme.fill, 1.1);
    rimLight.position.set(-12, 2, 8);
    scene.add(rimLight);

    // ----------------------------------------------------------- materials ---
    var rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: rockTex, roughness: 0.95, metalness: 0.02, bumpScale: 0.035, envMapIntensity: 0.18 });
    var rockDarkMat = new THREE.MeshStandardMaterial({ color: pigment(theme.rockDark), emissive: pigment(theme.rockDark), emissiveIntensity: 0.5, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.1 });
    var lockedMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: crackTex, roughness: 1.0, metalness: 0.0, bumpScale: 0.05, envMapIntensity: 0.15 });
    var liftMat = new THREE.MeshStandardMaterial({ color: pigment(theme.lift), roughness: 0.32, metalness: 0.75, envMapIntensity: 0.9 });
    var depotMat = new THREE.MeshStandardMaterial({ color: pigment(theme.accent), roughness: 0.8, metalness: 0.05, envMapIntensity: 0.3 });
    var oreMat = new THREE.MeshStandardMaterial({ color: pigment(theme.seam), emissive: pigment(theme.seam), emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.5 });
    var flareMat = new THREE.MeshStandardMaterial({ color: pigment(theme.seamHot), emissive: pigment(theme.seamHot), emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.1, envMapIntensity: 0.5 });
    var rimMat = new THREE.LineBasicMaterial({ color: pigment(theme.accent), transparent: true, opacity: 0.9 });
    var ringMat = new THREE.MeshBasicMaterial({ color: pigment(theme.accent), transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    var hitMat = new THREE.MeshBasicMaterial({ visible: false }); // raycast-only
    var beamMat = new THREE.MeshStandardMaterial({ color: pigment(theme.lift), roughness: 0.55, metalness: 0.45, envMapIntensity: 0.3 });
    // Detail tier: warm helmet lamps on every worker (they bloom when bloom is on).
    var helmetMat = new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffe2a8, emissiveIntensity: 2.4, roughness: 0.4 });
    // Drifting dust motes, lit by the seam glow (particle tier).
    var dustMat = new THREE.PointsMaterial({
      size: 0.16, map: glowTex, color: pigment(theme.seamHot), transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });

    // ---------------------------------------------------------- geometries ---
    var W = CONFIG.layerWidth, H = CONFIG.layerHeight, D = CONFIG.layerDepth;
    var slabGeo = new THREE.BoxGeometry(W, 0.45, D);
    var capGeo = new THREE.BoxGeometry(0.5, H + 0.9, D);
    var backGeo = new THREE.PlaneGeometry((W - CONFIG.shaftWidth) / 2 - 0.1, H);
    var lockedGeo = new THREE.BoxGeometry(W, CONFIG.spacing * 0.98, D);
    var hitGeo = new THREE.BoxGeometry(W + 2, CONFIG.spacing, D + 2);
    var crystalGeo = new THREE.OctahedronGeometry(0.3, 0);
    crystalGeo.scale(0.55, 1.7, 0.55); // elongated shard
    var workerGeo = new THREE.ConeGeometry(0.16, 0.52, 6);
    workerGeo.translate(0, 0.26, 0); // base at y=0
    var helmetGeo = new THREE.SphereGeometry(0.075, 8, 6);
    helmetGeo.translate(0.05, 0.5, 0.1); // lamp on the brow, facing the viewer
    var binFrameGeo = new THREE.BoxGeometry(0.85, CONFIG.binHeight + 0.25, 0.55);
    var binFillGeo = new THREE.BoxGeometry(0.58, 1, 0.36);
    binFillGeo.translate(0, 0.5, 0); // grows upward from its base
    var warnGeo = new THREE.ConeGeometry(0.26, 0.42, 4);
    var rimGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(W + 0.2, H + 1.0, D + 0.2));
    var ringGeo = new THREE.RingGeometry(0.9, 1.18, 40);
    var unitBeamGeo = new THREE.BoxGeometry(0.3, 1, 0.3);
    var markerGeo = new THREE.OctahedronGeometry(0.42, 0);

    // ------------------------------------------------------------- surface ---
    var surface = new THREE.Group();
    scene.add(surface);
    var ground = new THREE.Mesh(new THREE.BoxGeometry(60, 1.2, 14), rockMat);
    ground.position.set(0, CONFIG.surfaceY - 0.6, 0);
    ground.receiveShadow = true;
    surface.add(ground);
    // depot: original low-poly hut + hopper beside the shaft head
    var hut = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.1, 1.5), depotMat);
    hut.position.set(4.4, CONFIG.surfaceY + 0.55, 0);
    hut.castShadow = true;
    surface.add(hut);
    var roof = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.85, 4), rockDarkMat);
    roof.position.set(4.4, CONFIG.surfaceY + 1.5, 0);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    surface.add(roof);
    var hopper = new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.95, 4), liftMat);
    hopper.position.set(2.5, CONFIG.surfaceY + 1.05, 0.2);
    hopper.rotation.x = Math.PI; // funnel point down
    hopper.castShadow = true;
    surface.add(hopper);
    // headframe over the shaft mouth
    var hfL = new THREE.Mesh(unitBeamGeo, beamMat);
    hfL.scale.set(1, 2.4, 1);
    hfL.position.set(-1.15, CONFIG.surfaceY + 1.2, 0.4);
    surface.add(hfL);
    var hfR = hfL.clone();
    hfR.position.x = 1.15;
    surface.add(hfR);
    var wheel = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.09, 8, 20), liftMat);
    wheel.position.set(0, CONFIG.surfaceY + 2.3, 0.4);
    surface.add(wheel);

    // --------------------------------------------------------------- shaft ---
    var shaftLen = -CONFIG.firstLayerY + (CONFIG.maxLayers - 1) * CONFIG.spacing + H + 2.5;
    var shaft = new THREE.Group();
    scene.add(shaft);
    var shaftBack = new THREE.Mesh(
      new THREE.PlaneGeometry(CONFIG.shaftWidth + 0.8, shaftLen),
      rockDarkMat
    );
    shaftBack.position.set(0, CONFIG.surfaceY - shaftLen / 2 + 0.5, -D / 2 - 0.35);
    shaft.add(shaftBack);
    var beamL = new THREE.Mesh(unitBeamGeo, beamMat);
    beamL.scale.set(1, shaftLen, 1);
    beamL.position.set(-CONFIG.shaftWidth / 2, CONFIG.surfaceY - shaftLen / 2 + 0.5, -0.2);
    shaft.add(beamL);
    var beamR = beamL.clone();
    beamR.position.x = CONFIG.shaftWidth / 2;
    shaft.add(beamR);

    // -------------------------------------------------------------- layers ---
    // Prebuilt up to CONFIG.maxLayers; visibility follows ruleset.layerCount.
    var layers = [];
    var hitBoxes = [];
    var halfBack = (W - CONFIG.shaftWidth) / 2;

    for (var li = 0; li < CONFIG.maxLayers; li++) {
      (function (i) {
        var g = new THREE.Group();
        var baseY = CONFIG.firstLayerY - i * CONFIG.spacing;
        g.position.y = baseY;
        scene.add(g);

        // The sealed block replaces the entire cavern. Its front and side
        // faces share the shell's depth, so drawing both causes z-fighting.
        var interior = new THREE.Group();
        g.add(interior);

        var ceil = new THREE.Mesh(slabGeo, rockMat);
        ceil.position.y = H / 2 + 0.225;
        ceil.castShadow = true;
        ceil.receiveShadow = true;
        interior.add(ceil);
        var floor = new THREE.Mesh(slabGeo, rockMat);
        floor.position.y = -H / 2 - 0.225;
        floor.receiveShadow = true;
        interior.add(floor);
        var capL = new THREE.Mesh(capGeo, rockMat);
        capL.position.x = -(W / 2 - 0.25);
        interior.add(capL);
        var capR = new THREE.Mesh(capGeo, rockMat);
        capR.position.x = W / 2 - 0.25;
        interior.add(capR);

        // interior (visible when unlocked)
        var backL = new THREE.Mesh(backGeo, rockDarkMat);
        backL.position.set(-(CONFIG.shaftWidth / 2 + halfBack / 2), 0, -D / 2 + 0.06);
        backL.receiveShadow = true;
        interior.add(backL);
        var backR2 = new THREE.Mesh(backGeo, rockDarkMat);
        backR2.position.set(CONFIG.shaftWidth / 2 + halfBack / 2, 0, -D / 2 + 0.06);
        backR2.receiveShadow = true;
        interior.add(backR2);

        // glowing mineral seam: instanced elongated crystals on the back wall
        var seamPlain = new THREE.MeshStandardMaterial({
          color: pigment(theme.seam), emissive: pigment(theme.seam), emissiveIntensity: 0.5,
          roughness: 0.22, metalness: 0.25
        });
        // Detailed seams: clearcoated gem faces that catch the environment.
        var seamGloss = new THREE.MeshPhysicalMaterial({
          color: pigment(theme.seam), emissive: pigment(theme.seam), emissiveIntensity: 0.5,
          roughness: 0.3, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.12,
          envMapIntensity: 0.35
        });
        var seamMat = seamPlain;
        var crystals = new THREE.InstancedMesh(crystalGeo, seamMat, CONFIG.crystalMax);
        crystals.frustumCulled = false; // instances spread beyond base bounds
        crystals.castShadow = true;
        var rnd = mulberry32(CONFIG.seed + i * 7919);
        var tmpM = new THREE.Matrix4();
        var tmpQ = new THREE.Quaternion();
        var tmpE = new THREE.Euler();
        var tmpV = new THREE.Vector3();
        var tmpS = new THREE.Vector3();
        for (var ci = 0; ci < CONFIG.crystalMax; ci++) {
          var cx = (rnd() < 0.5 ? -1 : 1) * (CONFIG.shaftWidth / 2 + 0.5 + rnd() * (halfBack - 1.0));
          var cy = -H / 2 + 0.25 + rnd() * (H - 0.6);
          var cz = -D / 2 + 0.15 + rnd() * 0.55;
          tmpE.set((rnd() - 0.5) * 0.7, rnd() * Math.PI, (rnd() - 0.5) * 0.9);
          tmpQ.setFromEuler(tmpE);
          var cs = 0.55 + rnd() * 0.95;
          tmpS.set(cs, cs, cs);
          tmpV.set(cx, cy, cz);
          tmpM.compose(tmpV, tmpQ, tmpS);
          crystals.setMatrixAt(ci, tmpM);
          crystals.setColorAt(ci, new THREE.Color().setHSL(0.06 + (ci % 5) * 0.025, 0.15, 0.58 + (ci % 4) * 0.12));
        }
        crystals.count = GFX.CRYSTALS.plain;
        crystals.instanceMatrix.needsUpdate = true;
        interior.add(crystals);

        // ore bin gauge (right side of the cavern)
        var binFrame = new THREE.Mesh(binFrameGeo, rockDarkMat);
        binFrame.position.set(CONFIG.binX, -H / 2 + (CONFIG.binHeight + 0.25) / 2 + 0.05, CONFIG.binZ);
        interior.add(binFrame);
        var binFillMat = new THREE.MeshStandardMaterial({
          color: pigment(theme.seam), emissive: pigment(theme.seam), emissiveIntensity: 0.55,
          roughness: 0.5, metalness: 0.1
        });
        var binFill = new THREE.Mesh(binFillGeo, binFillMat);
        binFill.position.set(CONFIG.binX, -H / 2 + 0.14, CONFIG.binZ);
        interior.add(binFill);
        var warnMat = new THREE.MeshStandardMaterial({
          color: 0xff5522, emissive: 0xff3311, emissiveIntensity: 0.9, roughness: 0.5
        });
        var warnCap = new THREE.Mesh(warnGeo, warnMat);
        warnCap.rotation.z = Math.PI; // point down: "blocked" marker shape
        warnCap.position.set(CONFIG.binX, -H / 2 + CONFIG.binHeight + 0.55, CONFIG.binZ);
        warnCap.visible = false;
        interior.add(warnCap);

        // worker figures: instanced cones with deterministic offsets
        var workerMat = new THREE.MeshStandardMaterial({ color: pigment(theme.accent), roughness: 0.7, metalness: 0.2 });
        var workers = new THREE.InstancedMesh(workerGeo, workerMat, CONFIG.workerSlots);
        workers.frustumCulled = false;
        workers.castShadow = true;
        workers.count = 0;
        workers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        var offsets = [];
        for (var wi = 0; wi < CONFIG.workerSlots; wi++) {
          var wx = -W / 2 + 1.6 + (wi + 0.5) * ((W - 3.2) / CONFIG.workerSlots) + (rnd() - 0.5) * 0.9;
          if (Math.abs(wx) < CONFIG.shaftWidth / 2 + 0.5) wx += CONFIG.shaftWidth / 2 + 0.8; // keep out of the shaft gap
          offsets.push({ x: wx, z: 0.3 + rnd() * 0.9, phase: rnd() * Math.PI * 2 });
        }
        interior.add(workers);
        var helmets = new THREE.InstancedMesh(helmetGeo, helmetMat, CONFIG.workerSlots);
        helmets.frustumCulled = false;
        helmets.count = 0;
        helmets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        helmets.visible = false;
        interior.add(helmets);

        // dust motes: deterministic drift paths inside the cavern
        var dustPos = new Float32Array(CONFIG.dustMax * 3);
        var dustSeed = [];
        for (var di = 0; di < CONFIG.dustMax; di++) {
          dustSeed.push({
            x: (rnd() - 0.5) * (W - 1.5), z: -D / 2 + 0.4 + rnd() * (D - 0.6),
            y: rnd(), speed: 0.04 + rnd() * 0.08, phase: rnd() * Math.PI * 2, amp: 0.2 + rnd() * 0.5
          });
        }
        var dustGeo = new THREE.BufferGeometry();
        dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3).setUsage(THREE.DynamicDrawUsage));
        dustGeo.setDrawRange(0, 0);
        var dust = new THREE.Points(dustGeo, dustMat);
        dust.frustumCulled = false;
        interior.add(dust);

        // locked look: one dark sealed block with faint crack texture
        var sealed = new THREE.Mesh(lockedGeo, lockedMat);
        sealed.visible = false;
        g.add(sealed);

        // seam-colored lamp makes unlocked interiors readable (readability pillar)
        var lamp = new THREE.PointLight(theme.seam, 1.2, 14, 2);
        lamp.position.set(0, 0.2, 1.1);
        lamp.visible = false;
        g.add(lamp);

        // picking hit-box (never rendered; raycast targets these only)
        var hit = new THREE.Mesh(hitGeo, hitMat);
        hit.userData.layerIndex = i;
        g.add(hit);
        hitBoxes.push(hit);

        layers.push({
          index: i,
          group: g,
          baseY: baseY,
          interior: interior,
          sealed: sealed,
          seamMat: seamMat,
          seamPlain: seamPlain,
          seamGloss: seamGloss,
          crystals: crystals,
          workers: workers,
          helmets: helmets,
          dust: dust,
          dustPos: dustPos,
          dustSeed: dustSeed,
          workerOffsets: offsets,
          binFill: binFill,
          binFillMat: binFillMat,
          warnCap: warnCap,
          lamp: lamp,
          selLift: { v: 0, w: 0 }
        });
      })(li);
    }

    // ------------------------------------------------- selection treatment ---
    // Shared rim + grounded ring, moved onto the selected layer each frame.
    var selRim = new THREE.LineSegments(rimGeo, rimMat);
    selRim.visible = false;
    scene.add(selRim);
    var selRing = new THREE.Mesh(ringGeo, ringMat);
    selRing.rotation.x = -Math.PI / 2; // grounded on the cavern floor
    selRing.visible = false;
    scene.add(selRing);

    // ------------------------------------------------------- flare marker ---
    var flareMarker = new THREE.Mesh(markerGeo, flareMat);
    flareMarker.visible = false;
    scene.add(flareMarker);

    // ----------------------------------------------------------------- lift ---
    var lift = new THREE.Group();
    scene.add(lift);
    var cage = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.18, 1.5), liftMat);
    cage.castShadow = true;
    lift.add(cage);
    var postGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.15, 6);
    var postOffsets = [[-0.85, -0.65], [0.85, -0.65], [-0.85, 0.65], [0.85, 0.65]];
    for (var pi = 0; pi < 4; pi++) {
      var post = new THREE.Mesh(postGeo, liftMat);
      post.position.set(postOffsets[pi][0], 0.65, postOffsets[pi][1]);
      lift.add(post);
    }
    var crossbar = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.12), liftMat);
    crossbar.position.y = 1.25;
    lift.add(crossbar);
    var cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 60, 4), beamMat);
    cable.position.y = 30; // runs up out of frame
    lift.add(cable);
    // A bed of ore grows from the platform; the fixed cage gives it a capacity reference.
    var cargoGeo = new THREE.BoxGeometry(1.5, 0.85, 1.1);
    cargoGeo.translate(0, 0.425, 0);
    var cargo = new THREE.Mesh(cargoGeo, oreMat);
    cargo.position.y = 0.09;
    cargo.visible = false;
    lift.add(cargo);
    var cargoTop = new THREE.Group();
    var chunkGeo = new THREE.OctahedronGeometry(0.18, 0);
    for (var chunk = 0; chunk < 12; chunk++) {
      var piece = new THREE.Mesh(chunkGeo, oreMat);
      piece.position.set((chunk % 4 - 1.5) * 0.34, 0, (Math.floor(chunk / 4) - 1) * 0.32);
      piece.rotation.set(chunk * 0.7, chunk * 1.3, 0.4);
      piece.scale.set(1, 0.65 + (chunk % 3) * 0.2, 1);
      cargoTop.add(piece);
    }
    lift.add(cargoTop);

    // ----------------------------------------------------- VFX: particles ---
    // Pooled THREE.Points; raycasts only ever target hitBoxes, so particles
    // can never intercept picking.
    var P_MAX = CONFIG.particleMax;
    var pPos = new Float32Array(P_MAX * 3);
    var pCol = new Float32Array(P_MAX * 3);
    var pVel = new Float32Array(P_MAX * 3);
    var pBase = new Float32Array(P_MAX * 3);
    var pLife = new Float32Array(P_MAX);
    var pLife0 = new Float32Array(P_MAX);
    for (var pj = 0; pj < P_MAX; pj++) pPos[pj * 3 + 1] = -9999;
    var pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
    var pMat = new THREE.PointsMaterial({
      size: 0.26, map: glowTex, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var points = new THREE.Points(pGeo, pMat);
    points.frustumCulled = false;
    scene.add(points);
    var pCursor = 0;

    function spawnBurst(x, y, z, count, hex, speed, life, spread) {
      var mult = GFX.PARTICLE_MULT[g.particles] * (reducedMotion ? 0.35 : 1);
      var n = Math.max(1, Math.round(count * mult));
      var r = ((hex >> 16) & 255) / 255;
      var g2 = ((hex >> 8) & 255) / 255;
      var b = (hex & 255) / 255;
      for (var k = 0; k < n; k++) {
        var i2 = pCursor;
        pCursor = (pCursor + 1) % P_MAX;
        var i3 = i2 * 3;
        pPos[i3] = x + (Math.random() - 0.5) * spread;
        pPos[i3 + 1] = y + (Math.random() - 0.5) * spread * 0.5;
        pPos[i3 + 2] = z + (Math.random() - 0.5) * spread;
        var th = Math.random() * Math.PI * 2;
        var up = Math.random() * 0.9 + 0.25;
        var sp = speed * (0.4 + Math.random() * 0.8);
        pVel[i3] = Math.cos(th) * sp;
        pVel[i3 + 1] = up * sp;
        pVel[i3 + 2] = Math.sin(th) * sp * 0.5;
        pBase[i3] = r; pBase[i3 + 1] = g2; pBase[i3 + 2] = b;
        pLife[i2] = pLife0[i2] = life * (0.6 + Math.random() * 0.7);
      }
    }

    function updateParticles(dt) {
      for (var i2 = 0; i2 < P_MAX; i2++) {
        if (pLife[i2] <= 0) continue;
        pLife[i2] -= dt;
        var i3 = i2 * 3;
        if (pLife[i2] <= 0) { pPos[i3 + 1] = -9999; pCol[i3] = pCol[i3 + 1] = pCol[i3 + 2] = 0; continue; }
        pVel[i3 + 1] -= 4.5 * dt; // light gravity
        pPos[i3] += pVel[i3] * dt;
        pPos[i3 + 1] += pVel[i3 + 1] * dt;
        pPos[i3 + 2] += pVel[i3 + 2] * dt;
        var f = pLife[i2] / pLife0[i2];
        pCol[i3] = pBase[i3] * f;
        pCol[i3 + 1] = pBase[i3 + 1] * f;
        pCol[i3 + 2] = pBase[i3 + 2] * f;
      }
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.color.needsUpdate = true;
    }

    // -------------------------------------------------- VFX: flash / glow ---
    // Camera-space additive quad for 'complete'; world glow quad for 'upgrade';
    // small red HUD-anchor blink for 'error'. None of them move the camera.
    var flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false
    });
    var flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), flashMat);
    flashMesh.position.set(0, 0, -2);
    flashMesh.renderOrder = 999;
    flashMesh.frustumCulled = false;
    camera.add(flashMesh);

    var glowMat = new THREE.MeshBasicMaterial({
      map: glowTex, color: pigment(theme.accent), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), glowMat);
    glowMesh.position.set(0, CONFIG.surfaceY + 1.4, 1.2);
    scene.add(glowMesh);

    var hudBlinkMat = new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0 });
    var hudBlink = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), hudBlinkMat);
    hudBlink.position.set(6.0, CONFIG.surfaceY + 1.1, 1.0); // next to the depot
    scene.add(hudBlink);

    // ------------------------------------------------------- runtime state ---
    var time = 0;
    var paused = false;
    var disposed = false;
    var lastState = null;
    var selectedLayer = null;
    var flareLayer = null;
    var yaw = { v: 0, w: 0 };
    var yawTarget = 0;
    var shakeAmp = 0;
    var liftTrip = null, liftElapsed = 0;
    var liftClock = -1, liftSeed = null;
    var liftFloors = new Array(CONFIG.maxLayers);
    var flashT = 0;
    var glowT = 0;
    var errorT = 0;

    // preallocated temporaries for the animation loop (no per-frame allocs)
    var tmpV3 = new THREE.Vector3();
    var tmpM4 = new THREE.Matrix4();
    var tmpRaycaster = new THREE.Raycaster();
    var tmpNDC = new THREE.Vector2();

    function binCapOf(state, i) {
      if (RULES && RULES.binCapMilli) return RULES.binCapMilli(state, i);
      return (state.ruleset.binCap && state.ruleset.binCap[i]) || 1;
    }
    function deepestWorkingLayer(state) {
      var best = -1;
      for (var i2 = 0; i2 < state.layers.length; i2++) {
        var L = state.layers[i2];
        if (L.unlocked && L.workers > 0) best = i2;
      }
      return best;
    }

    // ------------------------------------------------------------ frame ---
    function setSnapshot(state, dtSec) {
      if (disposed || !state) return;
      if (typeof document !== 'undefined' && document.hidden) return; // caller also setPaused
      if (paused) return; // static frame was rendered by setPaused(true)
      var layersChanged = !lastState || !lastState.layers || lastState.layers.length !== state.layers.length;
      lastState = state;
      if (layersChanged) resize(); // framing depends on the number of layers
      var dt = Math.min(Math.max(dtSec || 0, 0), 0.1);
      time += dt;

      var layerCount = Math.min(state.ruleset.layerCount || CONFIG.maxLayers, CONFIG.maxLayers);
      var sway = reducedMotion ? 0 : CONFIG.swayAmp;
      var floorY = -H / 2 + 0.05;

      for (var i2 = 0; i2 < CONFIG.maxLayers; i2++) {
        var rec = layers[i2];
        var inRange = i2 < layerCount;
        rec.group.visible = inRange;
        if (!inRange) continue;
        var L = state.layers[i2];
        var unlocked = !!(L && L.unlocked);
        rec.interior.visible = unlocked;
        rec.sealed.visible = !unlocked;
        rec.lamp.visible = unlocked;
        // lamp shimmer: a slow, small flicker (steady under reduced motion)
        rec.lamp.intensity = reducedMotion ? 1.2
          : 1.2 + 0.08 * Math.sin(time * 7.3 + i2 * 2.1) + 0.05 * Math.sin(time * 13.1 + i2);

        // selection lift (spring; never cumulative lerp)
        springStep(rec.selLift, selectedLayer === i2 ? CONFIG.selectLift : 0, dt, CONFIG.springW);
        rec.group.position.y = rec.baseY + rec.selLift.v;

        if (!unlocked) continue;

        // seam glow: subtle idle pulse; strong pulse while flaring
        if (flareLayer === i2) {
          rec.seamMat.emissiveIntensity = reducedMotion
            ? 1.4 + 0.4 * Math.sin(time * 4)
            : 1.7 + 0.8 * Math.sin(time * 9);
        } else {
          rec.seamMat.emissiveIntensity = 0.48 + 0.1 * Math.sin(time * 1.7 + i2 * 1.3);
        }

        // ore bin gauge
        var cap = binCapOf(state, i2);
        var frac = cap > 0 ? Math.min(1, (L.milliOre || 0) / cap) : 0;
        rec.binFill.scale.y = Math.max(0.03, frac * CONFIG.binHeight);
        var blocked = cap > 0 && L.milliOre >= cap * 0.98;
        if (blocked) {
          // warning = color shift AND shape change (pulsing width + cap marker)
          rec.binFillMat.color.setHex(0xff6622);
          rec.binFillMat.emissive.setHex(0xcc3311);
          rec.binFill.scale.x = reducedMotion ? 1 : 1 + 0.14 * Math.sin(time * 10);
          rec.warnCap.visible = true;
        } else {
          rec.binFillMat.color.setHex(theme.seam).convertSRGBToLinear();
          rec.binFillMat.emissive.setHex(theme.seam).convertSRGBToLinear();
          rec.binFill.scale.x = 1;
          rec.warnCap.visible = false;
        }

        // workers: count from state, gentle deterministic bob
        var wc = Math.min(CONFIG.workerSlots, Math.max(0, L.workers | 0));
        rec.workers.count = wc;
        var bobAmp = reducedMotion ? 0 : 0.06;
        var lamps = rec.helmets.visible;
        rec.helmets.count = lamps ? wc : 0;
        for (var w2 = 0; w2 < wc; w2++) {
          var off = rec.workerOffsets[w2];
          tmpV3.set(off.x, floorY + bobAmp * Math.sin(time * 3 + off.phase), off.z);
          tmpM4.makeTranslation(tmpV3.x, tmpV3.y, tmpV3.z);
          rec.workers.setMatrixAt(w2, tmpM4);
          if (lamps) rec.helmets.setMatrixAt(w2, tmpM4);
        }
        if (wc > 0) {
          rec.workers.instanceMatrix.needsUpdate = true;
          if (lamps) rec.helmets.instanceMatrix.needsUpdate = true;
        }

        // dust motes rise slowly through the cavern and wrap (frozen with reduced motion)
        var dn = rec.dust.geometry.drawRange.count;
        if (dn > 0 && (!reducedMotion || !rec.dustPlaced)) {
          var dtime = reducedMotion ? 0 : time;
          for (var d2 = 0; d2 < dn; d2++) {
            var ds = rec.dustSeed[d2];
            var dy = (ds.y + dtime * ds.speed) % 1;
            rec.dustPos[d2 * 3] = ds.x + ds.amp * Math.sin(dtime * 0.35 + ds.phase);
            rec.dustPos[d2 * 3 + 1] = -H / 2 + 0.15 + dy * (H - 0.3);
            rec.dustPos[d2 * 3 + 2] = ds.z + 0.15 * Math.sin(dtime * 0.5 + ds.phase * 1.7);
          }
          rec.dust.geometry.attributes.position.needsUpdate = true;
          rec.dustPlaced = true;
        }
      }

      // selection rim + grounded ring follow the selected layer
      if (selectedLayer !== null && selectedLayer >= 0 && selectedLayer < layerCount) {
        var rec2 = layers[selectedLayer];
        var sy = rec2.group.position.y;
        selRim.visible = true;
        selRim.position.set(0, sy, 0);
        selRing.visible = true;
        var ringPulse = reducedMotion ? 1 : 1 + 0.08 * Math.sin(time * 4);
        selRing.scale.set(ringPulse, ringPulse, 1);
        selRing.position.set(0, sy - H / 2 - 0.2 + 0.03, D / 2 + 0.4);
      } else {
        selRim.visible = false;
        selRing.visible = false;
      }

      // flare marker floats above the flaring layer; layer stays clickable
      if (flareLayer !== null && flareLayer >= 0 && flareLayer < layerCount &&
          layers[flareLayer].interior.visible) {
        flareMarker.visible = true;
        var fy = layers[flareLayer].group.position.y;
        var bob = reducedMotion ? 0 : 0.18 * Math.sin(time * 5);
        flareMarker.position.set(0, fy + H / 2 + 1.0 + bob, 0.6);
        flareMarker.rotation.y = reducedMotion ? 0 : time * 2.2;
        flareMat.emissiveIntensity = 1.4 + 0.7 * Math.sin(time * 9);
      } else {
        flareMarker.visible = false;
      }

      // Dock the platform's top at the actual floor, including selection lift.
      // Freeze the itinerary during travel so a new crew cannot move the destination.
      var clock = state.tick + state.tickMs / 1000;
      if (liftSeed !== state.seed || clock < liftClock || !state.ruleset.mechanics.lift ||
          (liftTrip && liftTrip.segments.some(function (seg) {
            return seg.to >= 0 && (!state.layers[seg.to] || !state.layers[seg.to].unlocked);
          }))) {
        liftTrip = null; liftElapsed = 0;
      }
      liftSeed = state.seed; liftClock = clock;
      if (!liftTrip) liftTrip = planLiftTrip(state);
      if (liftTrip) {
        liftElapsed += dt;
        if (liftElapsed >= liftTrip.duration) {
          liftElapsed -= liftTrip.duration;
          liftTrip = planLiftTrip(state);
        }
      } else liftElapsed = 0;
      for (var fi = 0; fi < CONFIG.maxLayers; fi++) {
        liftFloors[fi] = layers[fi].group.position.y - H / 2;
      }
      var ride = sampleLiftTrip(liftTrip, liftElapsed, liftFloors);
      lift.position.set(0, ride.y, 0);
      cargo.visible = cargoTop.visible = ride.fill > 0.001;
      cargo.scale.y = Math.max(0.001, ride.fill);
      cargoTop.position.y = 0.09 + 0.85 * ride.fill;
      cargoTop.scale.y = Math.min(1, ride.fill * 5);

      // camera: idle sway + drag-orbit yaw spring + decaying pulse shake
      springStep(yaw, yawTarget, dt, CONFIG.springW);
      camYaw.rotation.y = yaw.v;
      if (reducedMotion) shakeAmp = 0;
      shakeAmp *= Math.exp(-CONFIG.shakeDecay * dt);
      camShake.position.set(
        shakeAmp * Math.sin(time * 47.3),
        shakeAmp * Math.sin(time * 39.1 + 1.7),
        0
      );
      camera.position.set(
        CONFIG.camPos.x + sway * Math.sin(time * CONFIG.swaySpeed),
        CONFIG.camPos.y + sway * 0.5 * Math.sin(time * CONFIG.swaySpeed * 0.73 + 1.3),
        CONFIG.camPos.z * frameDist
      );

      // one-shot VFX timers
      if (flashT > 0) { flashT = Math.max(0, flashT - dt * 1.4); flashMat.opacity = flashT * 0.85; }
      if (glowT > 0) { glowT = Math.max(0, glowT - dt * 1.8); glowMat.opacity = glowT * 0.9; }
      if (errorT > 0) {
        errorT = Math.max(0, errorT - dt * 0.8);
        hudBlinkMat.opacity = errorT * (Math.sin(time * 18) > 0 ? 0.85 : 0.15);
      } else {
        hudBlinkMat.opacity = 0;
      }

      updateParticles(dt);
      renderFrame();
    }

    // ------------------------------------------------------------- theme ---
    function setTheme(th) {
      theme = th || DEFAULT_THEME;
      var oldRock = rockMat.map;
      rockTex = makeCrackTexture(theme, false);
      rockMat.map = rockTex;
      if (rockMat.bumpMap) rockMat.bumpMap = rockTex;
      rockMat.needsUpdate = true;
      if (oldRock) oldRock.dispose();
      rockDarkMat.color.setHex(theme.rockDark).convertSRGBToLinear();
      rockDarkMat.emissive.setHex(theme.rockDark).convertSRGBToLinear();
      rimLight.color.setHex(theme.fill);
      liftMat.color.setHex(theme.lift).convertSRGBToLinear();
      beamMat.color.setHex(theme.lift).convertSRGBToLinear();
      depotMat.color.setHex(theme.accent).convertSRGBToLinear();
      oreMat.color.setHex(theme.seam).convertSRGBToLinear();
      oreMat.emissive.setHex(theme.seam).convertSRGBToLinear();
      flareMat.color.setHex(theme.seamHot).convertSRGBToLinear();
      flareMat.emissive.setHex(theme.seamHot).convertSRGBToLinear();
      rimMat.color.setHex(theme.accent).convertSRGBToLinear();
      ringMat.color.setHex(theme.accent).convertSRGBToLinear();
      glowMat.color.setHex(theme.accent).convertSRGBToLinear();
      dustMat.color.setHex(theme.seamHot).convertSRGBToLinear();
      keyLight.color.setHex(theme.key);
      hemiLight.color.setHex(theme.fill);
      hemiLight.groundColor.setHex(theme.rockDark);
      scene.fog.color.setHex(theme.fog);
      for (var i2 = 0; i2 < layers.length; i2++) {
        layers[i2].workers.material.color.setHex(theme.accent).convertSRGBToLinear();
        [layers[i2].seamPlain, layers[i2].seamGloss].forEach(function (m) {
          m.color.setHex(theme.seam).convertSRGBToLinear();
          m.emissive.setHex(theme.seam).convertSRGBToLinear();
        });
        layers[i2].lamp.color.setHex(theme.seam);
        if (!layers[i2].warnCap.visible) {
          layers[i2].binFillMat.color.setHex(theme.seam).convertSRGBToLinear();
          layers[i2].binFillMat.emissive.setHex(theme.seam).convertSRGBToLinear();
        }
      }
      // regenerate theme-derived textures; dispose the old ones
      var oldSky = scene.background;
      skyTex = makeSkyTexture(theme);
      scene.background = skyTex;
      if (oldSky && oldSky.dispose) oldSky.dispose();
      var oldCrack = lockedMat.map;
      crackTex = makeCrackTexture(theme, true);
      lockedMat.map = crackTex;
      if (lockedMat.bumpMap) lockedMat.bumpMap = crackTex;
      lockedMat.needsUpdate = true;
      if (oldCrack && oldCrack.dispose) oldCrack.dispose();
    }

    // ---------------------------------------------------------- graphics ---
    // Output pass: ACES tone map + sRGB encode, then an optional colour grade
    // (gentle S-curve, saturation, warm highlights / cool shadows) and vignette.
    var OutputGradeShader = {
      uniforms: {
        tDiffuse: { value: null }, uExposure: { value: CONFIG.exposure },
        uGrade: { value: 1.0 }, uVignette: { value: 0.28 }
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform sampler2D tDiffuse; uniform float uExposure; uniform float uGrade; uniform float uVignette;',
        'varying vec2 vUv;',
        'vec3 rrtOdt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }',
        'vec3 aces(vec3 c) {',
        '  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));',
        '  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));',
        '  c *= uExposure / 0.6; c = inM * c; c = rrtOdt(c); c = outM * c; return clamp(c, 0.0, 1.0);',
        '}',
        'vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c)); }',
        'void main() {',
        '  vec4 src = texture2D(tDiffuse, vUv);',
        '  vec3 c = toSRGB(aces(src.rgb));',
        '  if (uGrade > 0.0) {',
        '    vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);',
        '    float l = dot(s, vec3(0.299, 0.587, 0.114));',
        '    s = mix(vec3(l), s, 1.1);',
        '    s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.05, 1.0, 0.94), smoothstep(0.15, 0.75, l));',
        '    s = s * 0.97 + 0.018;',
        '    c = mix(c, clamp(s, 0.0, 1.0), uGrade);',
        '    float d = length((vUv - 0.5) * vec2(1.1, 1.0));',
        '    c *= 1.0 - uVignette * uGrade * smoothstep(0.38, 0.9, d);',
        '  }',
        '  gl_FragColor = vec4(c, 1.0);',
        '}'
      ].join('\n')
    };

    var composer = null, composerKey = 'none', postError = '', ssaoPass = null;
    var envTex = null, pmrem = null;
    var adaptScale = 1, frameAcc = 0, frameCount = 0, lastRenderAt = 0, fpsValue = 0;
    var fpsEl = null;

    function allMaterials(fn) {
      var seen = [];
      scene.traverse(function (o) {
        if (!o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var i2 = 0; i2 < mats.length; i2++) {
          if (seen.indexOf(mats[i2]) < 0) { seen.push(mats[i2]); fn(mats[i2]); }
        }
      });
      layers.forEach(function (rec) {
        [rec.seamPlain, rec.seamGloss].forEach(function (m) { if (seen.indexOf(m) < 0) { seen.push(m); fn(m); } });
      });
    }

    function currentPixelRatio() {
      return GFX.pixelRatio(g, root.devicePixelRatio || 1, g.adaptive ? adaptScale : 1);
    }

    function hdrType() {
      try {
        var caps = renderer.capabilities;
        if (caps.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') ||
            renderer.extensions.has('EXT_color_buffer_half_float'))) return THREE.HalfFloatType;
      } catch (e) { /* fall through */ }
      return THREE.UnsignedByteType;
    }

    function disposeComposer() {
      if (!composer) return;
      composer.passes.forEach(function (p) { if (p.dispose) { try { p.dispose(); } catch (e) { /* ignore */ } } });
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
      composer = null;
      ssaoPass = null;
    }

    // Post chain: scene (or SSAO beauty) → HDR bloom → tone map/grade → FXAA|SMAA.
    function buildPost() {
      disposeComposer();
      postError = '';
      if (!g.post) return;
      try {
        if (!THREE.EffectComposer || !THREE.RenderPass || !THREE.ShaderPass) throw new Error('addons missing');
        var w = container.clientWidth || 1, h = container.clientHeight || 1;
        var pr = currentPixelRatio();
        var type = hdrType();
        var params = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: type };
        var rt;
        if (g.antialias === 'msaa' && renderer.capabilities.isWebGL2 && THREE.WebGLMultisampleRenderTarget) {
          rt = new THREE.WebGLMultisampleRenderTarget(Math.round(w * pr), Math.round(h * pr), params);
          rt.samples = 4;
        } else {
          rt = new THREE.WebGLRenderTarget(Math.round(w * pr), Math.round(h * pr), params);
        }
        var c = new THREE.EffectComposer(renderer, rt);
        c.setPixelRatio(pr);
        c.setSize(w, h);
        if (g.ao !== 'off') {
          var ao = new THREE.SSAOPass(scene, camera, Math.round(w * pr), Math.round(h * pr));
          ao.beautyRenderTarget.texture.type = type;
          ao.normalRenderTarget.depthTexture.type = THREE.UnsignedIntType; // 24-bit depth
          ao.kernelRadius = g.ao === 'high' ? 0.9 : 0.7;
          ao.minDistance = 0.00008;
          ao.maxDistance = 0.0045;
          // Helpers that must never occlude: invisible pick boxes and
          // transparent overlays (flash quad, glow, selection ring).
          var baseHide = ao.overrideVisibility.bind(ao);
          ao.overrideVisibility = function () {
            baseHide();
            scene.traverse(function (o) {
              if (o.isMesh && o.material && (o.material.visible === false || o.material.transparent)) o.visible = false;
            });
          };
          if (g.ao === 'on') {
            // half-resolution occlusion buffers; full-resolution beauty
            var baseSize = ao.setSize.bind(ao);
            ao.setSize = function (sw, sh) {
              baseSize(sw, sh);
              var hw = Math.max(1, Math.round(sw / 2)), hh = Math.max(1, Math.round(sh / 2));
              ao.normalRenderTarget.setSize(hw, hh);
              ao.ssaoRenderTarget.setSize(hw, hh);
              ao.blurRenderTarget.setSize(hw, hh);
              ao.ssaoMaterial.uniforms.resolution.value.set(hw, hh);
              ao.blurMaterial.uniforms.resolution.value.set(hw, hh);
            };
          }
          c.addPass(ao);
          ssaoPass = ao;
        } else {
          c.addPass(new THREE.RenderPass(scene, camera));
        }
        if (g.bloom === 'on') {
          var bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.22, 0.88);
          // HDR mip chain: 8-bit mips band into visible steps in the dark rock.
          bloom.renderTargetBright.texture.type = type;
          bloom.renderTargetsHorizontal.concat(bloom.renderTargetsVertical).forEach(function (t) { t.texture.type = type; });
          c.addPass(bloom);
        }
        var out = new THREE.ShaderPass(OutputGradeShader);
        out.uniforms.uGrade.value = g.grade === 'on' ? 1 : 0;
        c.addPass(out);
        if (g.antialias === 'smaa' && THREE.SMAAPass) {
          c.addPass(new THREE.SMAAPass(Math.round(w * pr), Math.round(h * pr)));
        } else if (g.antialias === 'fxaa' && THREE.FXAAShader) {
          var fxaa = new THREE.ShaderPass(THREE.FXAAShader);
          fxaa.uniforms.resolution.value.set(1 / Math.round(w * pr), 1 / Math.round(h * pr));
          fxaa.fxaaPass = true;
          c.addPass(fxaa);
        }
        c.setPixelRatio(pr);
        c.setSize(w, h);
        composer = c;
      } catch (e) {
        disposeComposer();
        postError = String((e && e.message) || e);
      }
    }

    function sizeComposer(w, h, pr) {
      if (!composer) return;
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.passes.forEach(function (p) {
        if (p.fxaaPass) p.uniforms.resolution.value.set(1 / Math.round(w * pr), 1 / Math.round(h * pr));
      });
    }

    function applyToneMapping() {
      // With the post chain the output pass tone-maps; the scene renders linear HDR.
      var want = composer ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
      if (renderer.toneMapping !== want) {
        renderer.toneMapping = want;
        allMaterials(function (m) { m.needsUpdate = true; });
      }
    }

    function renderFrame() {
      var now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
      if (lastRenderAt) {
        var ms = now - lastRenderAt;
        if (ms < 250) { frameAcc += ms; frameCount++; }
        if (frameCount >= 90) {
          var avg = frameAcc / frameCount;
          fpsValue = avg > 0 ? 1000 / avg : 0;
          frameAcc = 0; frameCount = 0;
          if (g.adaptive) {
            var next = adaptScale;
            if (avg > 26) next = Math.max(0.6, adaptScale - 0.1);
            else if (avg < 14) next = Math.min(1, adaptScale + 0.05);
            if (Math.abs(next - adaptScale) > 1e-3) { adaptScale = next; applyPixelRatio(); }
          }
          updateFps();
        }
      }
      lastRenderAt = now;
      if (composer) {
        try { composer.render(); return; } catch (e) {
          postError = String((e && e.message) || e);
          disposeComposer();
          applyToneMapping();
        }
      }
      renderer.render(scene, camera);
    }

    function updateFps() {
      if (!g.showFps) { if (fpsEl) fpsEl.hidden = true; return; }
      if (!fpsEl && root.document) {
        fpsEl = root.document.createElement('div');
        fpsEl.id = 'gfx-fps';
        fpsEl.setAttribute('aria-hidden', 'true');
        root.document.body.appendChild(fpsEl);
      }
      if (!fpsEl) return;
      fpsEl.hidden = false;
      fpsEl.textContent = (fpsValue ? Math.round(fpsValue) : '–') + ' fps · ' + Math.round(currentPixelRatio() * 100) / 100 + '×';
    }

    function applyPixelRatio() {
      var w = container.clientWidth || 1, h = container.clientHeight || 1;
      var pr = currentPixelRatio();
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false);
      sizeComposer(w, h, pr);
    }

    // Shadow camera fitted to the mine's bounding box in light space.
    var tmpBox = [new THREE.Vector3(), new THREE.Matrix4()];
    function fitShadow(layerCount) {
      var n = Math.max(1, Math.min(CONFIG.maxLayers, layerCount || CONFIG.maxLayers));
      var yTop = CONFIG.surfaceY + 3.0;
      var yBot = CONFIG.firstLayerY - (n - 1) * CONFIG.spacing - H / 2 - 1.0;
      var xs = [-W / 2 - 1, W / 2 + 1], ys = [yBot, yTop], zs = [-D / 2 - 0.6, D / 2 + 1.2];
      var view = tmpBox[1].lookAt(keyLight.position, keyLight.target.position, camera.up);
      view.setPosition(keyLight.position);
      view.invert();
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var c = 0; c < 2; c++) {
        var v = tmpBox[0].set(xs[a], ys[b], zs[c]).applyMatrix4(view);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
      }
      var sc = keyLight.shadow.camera;
      sc.left = minX - 0.5; sc.right = maxX + 0.5; sc.bottom = minY - 0.5; sc.top = maxY + 0.5;
      sc.near = Math.max(0.5, -maxZ - 2); sc.far = -minZ + 2;
      sc.updateProjectionMatrix();
    }

    function setReflections(on) {
      if (on && !envTex) {
        try {
          pmrem = new THREE.PMREMGenerator(renderer);
          envTex = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
          pmrem.dispose();
        } catch (e) { envTex = null; }
      }
      var want = on ? envTex : null;
      if (scene.environment !== want) {
        scene.environment = want;
        allMaterials(function (m) { m.needsUpdate = true; });
      }
    }

    /** Apply saved graphics settings live (no reload). */
    function setGraphics(saved) {
      gfxSaved = saved || {};
      var prev = g;
      g = GFX.resolve(gfxSaved, detected);
      if (!g.adaptive) adaptScale = 1;
      // shadows
      var size = GFX.SHADOW_MAP[g.shadows];
      var shadowsOn = size > 0;
      if (renderer.shadowMap.enabled !== shadowsOn || keyLight.castShadow !== shadowsOn) {
        renderer.shadowMap.enabled = shadowsOn;
        keyLight.castShadow = shadowsOn;
        allMaterials(function (m) { m.needsUpdate = true; });
      }
      if (shadowsOn && keyLight.shadow.mapSize.x !== size) {
        keyLight.shadow.mapSize.set(size, size);
        if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
      }
      keyLight.shadow.bias = -0.0004;
      keyLight.shadow.normalBias = 0.02;
      // reflections (image-based lighting)
      setReflections(g.reflections === 'on');
      // surface detail
      var detailed = g.detail === 'detailed';
      if (!!rockMat.bumpMap !== detailed) {
        rockMat.bumpMap = detailed ? rockMat.map : null;
        lockedMat.bumpMap = detailed ? lockedMat.map : null;
        rockMat.needsUpdate = lockedMat.needsUpdate = true;
      }
      for (var i2 = 0; i2 < layers.length; i2++) {
        var rec = layers[i2];
        var mat = detailed ? rec.seamGloss : rec.seamPlain;
        if (rec.seamMat !== mat) {
          mat.emissiveIntensity = rec.seamMat.emissiveIntensity;
          rec.seamMat = mat;
          rec.crystals.material = mat;
        }
        rec.crystals.count = GFX.CRYSTALS[g.detail];
        rec.helmets.visible = detailed;
        rec.dust.geometry.setDrawRange(0, GFX.DUST[g.particles]);
        rec.dustPlaced = false;
      }
      // post chain (rebuilt only when its shape changes)
      var key = g.post ? [g.ao, g.bloom, g.antialias].join('|') : 'none';
      if (key !== composerKey || (g.post && !composer && !postError)) {
        composerKey = key;
        buildPost();
      }
      var outPass = composer && composer.passes.filter(function (p) { return p.uniforms && p.uniforms.uGrade; })[0];
      if (outPass) outPass.uniforms.uGrade.value = g.grade === 'on' ? 1 : 0;
      applyToneMapping();
      if (root.document && root.document.body) {
        root.document.body.dataset.gfxPreset = g.preset;
      }
      updateFps();
      resize();
      return prev;
    }

    function graphicsInfo() {
      var pr = renderer.getPixelRatio();
      var w = container.clientWidth || 1, h = container.clientHeight || 1;
      return {
        gpu: gpuName, detected: detected, resolved: g, postError: postError,
        postActive: !!composer, pixels: [Math.round(w * pr), Math.round(h * pr)],
        adaptiveScale: adaptScale, fps: fpsValue
      };
    }

    function setReducedMotion(v) {
      reducedMotion = !!v;
      if (reducedMotion) shakeAmp = 0;
    }

    function setSelectedLayer(i) {
      selectedLayer = (typeof i === 'number' && i >= 0) ? i : null;
    }

    function setFlareActive(i) {
      flareLayer = (typeof i === 'number' && i >= 0) ? i : null;
    }

    // -------------------------------------------------------------- pulse ---
    function pulse(eventName) {
      if (disposed) return;
      var deepest = lastState ? Math.max(0, deepestWorkingLayer(lastState)) : 0;
      var deepY = layers[deepest].baseY;
      switch (eventName) {
        case 'coin':
          spawnBurst(2.5, CONFIG.surfaceY + 1.0, 0.6, 14, theme.accent, 2.2, 0.7, 0.8);
          break;
        case 'upgrade':
          glowT = 1;
          spawnBurst(0, CONFIG.surfaceY + 1.2, 0.6, 26, theme.accent, 3.0, 0.9, 1.6);
          break;
        case 'unlock':
          shakeAmp = Math.max(shakeAmp, 0.22);
          spawnBurst(0, deepY, 0.8, 60, theme.seamHot, 3.6, 1.1, 4.0);
          spawnBurst(0, deepY - 0.5, 0.8, 30, theme.rock, 2.4, 1.2, 4.5);
          break;
        case 'complete':
          flashT = 1;
          shakeAmp = Math.max(shakeAmp, CONFIG.shakeMax);
          spawnBurst(0, layers[1].baseY, 1.5, 150, theme.seamHot, 6.0, 1.5, 6.0);
          spawnBurst(0, CONFIG.surfaceY + 1.0, 1.0, 60, theme.accent, 4.5, 1.3, 3.0);
          break;
        case 'error':
          errorT = 1; // subtle red blink on the HUD anchor; no camera move
          break;
      }
    }

    // ------------------------------------------------- projection helper ---
    function screenPosForLayer(i) {
      if (disposed || typeof i !== 'number' || i < 0 || i >= layers.length) return null;
      var rec = layers[i];
      tmpV3.set(CONFIG.anchorX, rec.group.position.y + 0.4, CONFIG.anchorZ);
      tmpV3.project(camera);
      var rect = canvas.getBoundingClientRect();
      return {
        x: (tmpV3.x * 0.5 + 0.5) * rect.width,
        y: (-tmpV3.y * 0.5 + 0.5) * rect.height
      };
    }

    // ------------------------------------------------------------- resize ---
    var frameDist = 1; // aspect compensation: pull back on narrow screens

    // The canvas rectangle not covered by HUD chrome (top bar, lesson card,
    // bottom tray, drawer toggles). The mine is framed inside it via a camera
    // view offset so layer labels never hide under the HUD.
    function safeRect(w, h) {
      var r = { x: 0, y: 0, w: w, h: h };
      var doc = root.document;
      if (!doc) return r;
      var cr = container.getBoundingClientRect();
      var band = function (id) {
        var el = doc.getElementById(id);
        if (!el || el.classList.contains('hidden') || !el.offsetParent) return null;
        var b = el.getBoundingClientRect();
        if (!b.width || !b.height) return null;
        return { t: b.top - cr.top, b: b.bottom - cr.top, l: b.left - cr.left, r: b.right - cr.left };
      };
      var top = 0, bottom = h;
      var ht = band('hud-top'); if (ht && ht.b < h * 0.4) top = Math.max(top, ht.b);
      var lb = band('lesson-banner');
      if (lb && lb.b < h * 0.5 && lb.r - lb.l > w * 0.5) top = Math.max(top, lb.b);
      var hb = band('hud-bottom'); if (hb && hb.t > h * 0.6) bottom = Math.min(bottom, hb.t);
      r.y = top + 6; r.h = Math.max(60, bottom - top - 12);
      return r;
    }
    function resize() {
      if (disposed) return;
      var w = container.clientWidth || 1;
      var h = container.clientHeight || 1;
      var sr = safeRect(w, h);
      camera.aspect = sr.w / sr.h;
      camera.setViewOffset(sr.w, sr.h, -sr.x, -sr.y, w, h);
      var tanHalf = Math.tan((CONFIG.fov * Math.PI / 180) / 2);
      var halfW = CONFIG.layerWidth / 2 + 1.5;
      var needZ = halfW / (tanHalf * camera.aspect);
      // vertical: surface slab down to the deepest layer that exists in this
      // mine (unlockable ones included), not the theoretical maximum.
      var layerCount = lastState && lastState.layers ? lastState.layers.length : CONFIG.maxLayers;
      var span = CONFIG.surfaceY - CONFIG.firstLayerY + (layerCount - 1) * CONFIG.spacing + CONFIG.layerHeight + 1.5;
      var centreY = CONFIG.surfaceY - span / 2 + 0.75;
      var needZv = (span / 2) / tanHalf;
      frameDist = Math.max(1, needZ / CONFIG.camPos.z, needZv / CONFIG.camPos.z);
      // keep the framed band centred on the visible layers
      camera.lookAt(CONFIG.camTarget.x, Math.min(CONFIG.camTarget.y, centreY) , CONFIG.camTarget.z);
      camera.updateProjectionMatrix();
      fitShadow(layerCount);
      var pr = currentPixelRatio();
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false); // CSS keeps the canvas filling the container
      sizeComposer(w, h, pr); // also refreshes SSAO's projection matrices
      if (paused) renderFrame(); // repaint the frozen frame
    }

    // ------------------------------------------------------------ picking ---
    // Raycast ONLY against the explicit per-layer hit-boxes. Pointer travel
    // beyond CONFIG.tapSlopPx turns the gesture into a yaw drag (clamped).
    var ptrActive = false;
    var ptrId = null;
    var ptrStartX = 0;
    var ptrStartY = 0;
    var ptrDragging = false;
    var ptrStartYaw = 0;

    function onPointerDown(e) {
      if (ptrActive) return;
      ptrActive = true;
      ptrId = e.pointerId;
      ptrStartX = e.clientX;
      ptrStartY = e.clientY;
      ptrDragging = false;
      ptrStartYaw = yawTarget;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older UAs */ }
    }
    function onPointerMove(e) {
      if (!ptrActive || e.pointerId !== ptrId) return;
      var dx = e.clientX - ptrStartX;
      var dy = e.clientY - ptrStartY;
      if (!ptrDragging && Math.sqrt(dx * dx + dy * dy) > CONFIG.tapSlopPx) ptrDragging = true;
      if (ptrDragging) {
        yawTarget = Math.max(-CONFIG.maxYaw, Math.min(CONFIG.maxYaw, ptrStartYaw + dx * CONFIG.yawPerPixel));
      }
    }
    function onPointerUp(e) {
      if (!ptrActive || e.pointerId !== ptrId) return;
      var wasDrag = ptrDragging;
      resetPointer(e);
      if (wasDrag) return;
      var rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      tmpNDC.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      tmpRaycaster.setFromCamera(tmpNDC, camera);
      var hits = tmpRaycaster.intersectObjects(hitBoxes, false);
      if (hits.length > 0) onSelect(hits[0].object.userData.layerIndex);
    }
    function onPointerCancel(e) {
      if (!ptrActive || (e && e.pointerId !== undefined && e.pointerId !== ptrId)) return;
      resetPointer(e);
    }
    function resetPointer(e) {
      if (ptrId !== null) {
        try { canvas.releasePointerCapture(ptrId); } catch (err) { /* already released */ }
      }
      ptrActive = false;
      ptrId = null;
      ptrDragging = false;
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('lostpointercapture', onPointerCancel);

    // ------------------------------------------------------------ dispose ---
    function dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onPointerCancel);
      scene.traverse(function (obj) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (var i2 = 0; i2 < mats.length; i2++) {
            if (mats[i2].map) mats[i2].map.dispose();
            mats[i2].dispose();
          }
        }
      });
      if (scene.background && scene.background.dispose) scene.background.dispose();
      disposeComposer();
      if (envTex) envTex.dispose();
      if (fpsEl && fpsEl.parentNode) fpsEl.parentNode.removeChild(fpsEl);
      renderer.dispose();
      if (canvas.parentNode === container) container.removeChild(canvas);
    }

    function stats() {
      return {
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles
      };
    }

    function setPaused(v) {
      var next = !!v;
      if (next && !paused && !disposed) {
        // freeze decorative motion: present one static frame, then stop
        renderFrame();
      }
      paused = next;
    }

    // ------------------------------------------------------------ startup ---
    setGraphics(gfxSaved); // also sizes the canvas (resize)
    renderer.compile(scene, camera); // precompile shaders before first frame
    renderFrame();

    return {
      setSnapshot: setSnapshot,
      setTheme: setTheme,
      setGraphics: setGraphics,
      graphicsInfo: graphicsInfo,
      setReducedMotion: setReducedMotion,
      setSelectedLayer: setSelectedLayer,
      setFlareActive: setFlareActive,
      pulse: pulse,
      screenPosForLayer: screenPosForLayer,
      resize: resize,
      dispose: dispose,
      stats: stats,
      setPaused: setPaused,
      canvas: canvas
    };
  }

  root.DWRender = { create: create, planLiftTrip: planLiftTrip, sampleLiftTrip: sampleLiftTrip };
})(typeof self !== 'undefined' ? self : this);
