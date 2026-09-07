/**
 * Deepworks — Three.js presentation layer.
 *
 * Classic script (no modules): uses the global `THREE` (r128 UMD) and the
 * global `DWRules` for read-only derived values. Exposes `DWRender`.
 *
 * The renderer NEVER mutates rules state; `setSnapshot` only reads it.
 * All decorative motion is a pure function of (state, accumulated time);
 * the only smoothed quantities are critically-damped springs (camera yaw,
 * selection lift, lift target depth), so there is no cumulative lerp drift.
 *
 * Scene: a vertical mine cross-section framed like a tabletop diorama.
 * No external assets; the few textures (sky gradient, sealed-rock cracks)
 * are generated on a canvas at runtime. No post-processing.
 */
(function (root) {
  'use strict';

  var THREE = root.THREE;
  var RULES = root.DWRules;

  // -------------------------------------------------------------- config ---
  var CONFIG = {
    seed: 0x5eed1234, // fixed decoration seed (stable across loads)
    fov: 30,
    near: 0.1,
    far: 220,
    camPos: { x: 0, y: -6.0, z: 37.0 },
    camTarget: { x: 0, y: -7.2, z: 0 },
    spacing: 3.2,            // layer i center at y = -i * spacing
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
    crystalCounts: { low: 24, medium: 48, high: 80 },
    particleMax: 512,        // pooled cosmetic particles
    particleMult: { low: 0.35, medium: 0.7, high: 1.0 },
    pixelRatioCap: { low: 1, medium: 1.5, high: 2 },
    fogNear: 62,
    fogFar: 130
  };

  var DEFAULT_THEME = {
    id: '_fallback', name: 'Fallback',
    rock: 0x2b1d18, rockDark: 0x191009, seam: 0xff9a3c, seamHot: 0xffd28a,
    fog: 0x140b06, key: 0xffc890, fill: 0x3a4a66, accent: 0xffb35c, lift: 0x8a97a8
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

  // ---------------------------------------------------------------- factory ---
  function create(container, opts) {
    if (!THREE || !container) return null;
    opts = opts || {};
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};
    var theme = opts.theme || DEFAULT_THEME;
    var reducedMotion = !!opts.reducedMotion;
    var quality = (opts.quality === 'low' || opts.quality === 'medium') ? opts.quality : 'high';

    var renderer;
    try {
      // antialias is a creation-time flag; quality tiers never change it
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (e) {
      return null; // WebGL unavailable
    }
    if (!renderer.getContext()) return null;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.5;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
      grad.addColorStop(0, cssColor(th.fog, 3.2));
      grad.addColorStop(0.45, cssColor(th.fog, 1.5));
      grad.addColorStop(1, cssColor(th.fog, 0.7));
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 256);
      var tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
      return tex;
    }

    function makeCrackTexture(th) {
      var c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      var g = c.getContext('2d');
      g.fillStyle = cssColor(th.rockDark, 1.0);
      g.fillRect(0, 0, 128, 128);
      var rnd = mulberry32(CONFIG.seed ^ 0xc4ac);
      g.strokeStyle = cssColor(th.rock, 1.9);
      g.lineWidth = 1;
      for (var i = 0; i < 10; i++) {
        var x = rnd() * 128, y = rnd() * 128;
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
      var tex = new THREE.CanvasTexture(c);
      tex.encoding = THREE.sRGBEncoding;
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
    var crackTex = makeCrackTexture(theme);
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

    // ----------------------------------------------------------- materials ---
    var rockMat = new THREE.MeshStandardMaterial({ color: theme.rock, roughness: 0.95, metalness: 0.02 });
    var rockDarkMat = new THREE.MeshStandardMaterial({ color: theme.rockDark, emissive: theme.rockDark, emissiveIntensity: 0.5, roughness: 1.0, metalness: 0.0 });
    var lockedMat = new THREE.MeshStandardMaterial({ color: theme.rock, map: crackTex, roughness: 1.0, metalness: 0.0 });
    var liftMat = new THREE.MeshStandardMaterial({ color: theme.lift, roughness: 0.45, metalness: 0.6 });
    var depotMat = new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.85, metalness: 0.05 });
    var oreMat = new THREE.MeshStandardMaterial({ color: theme.seam, emissive: theme.seam, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.1 });
    var flareMat = new THREE.MeshStandardMaterial({ color: theme.seamHot, emissive: theme.seamHot, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.1 });
    var rimMat = new THREE.LineBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.9 });
    var ringMat = new THREE.MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    var hitMat = new THREE.MeshBasicMaterial({ visible: false }); // raycast-only
    var beamMat = new THREE.MeshStandardMaterial({ color: theme.lift, roughness: 0.6, metalness: 0.4 });

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
    var binFrameGeo = new THREE.BoxGeometry(0.85, CONFIG.binHeight + 0.25, 0.55);
    var binFillGeo = new THREE.BoxGeometry(0.58, 1, 0.36);
    binFillGeo.translate(0, 0.5, 0); // grows upward from its base
    var warnGeo = new THREE.ConeGeometry(0.26, 0.42, 4);
    var rimGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(W + 0.2, H + 1.0, D + 0.2));
    var ringGeo = new THREE.RingGeometry(0.9, 1.18, 40);
    var unitBeamGeo = new THREE.BoxGeometry(0.3, 1, 0.3);
    var oreChunkGeo = new THREE.OctahedronGeometry(0.3, 0);
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
    var shaftLen = (CONFIG.maxLayers - 1) * CONFIG.spacing + H + 2.5;
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
        var baseY = -i * CONFIG.spacing;
        g.position.y = baseY;
        scene.add(g);

        var ceil = new THREE.Mesh(slabGeo, rockMat);
        ceil.position.y = H / 2 + 0.225;
        ceil.castShadow = true;
        ceil.receiveShadow = true;
        g.add(ceil);
        var floor = new THREE.Mesh(slabGeo, rockMat);
        floor.position.y = -H / 2 - 0.225;
        floor.receiveShadow = true;
        g.add(floor);
        var capL = new THREE.Mesh(capGeo, rockMat);
        capL.position.x = -(W / 2 - 0.25);
        g.add(capL);
        var capR = new THREE.Mesh(capGeo, rockMat);
        capR.position.x = W / 2 - 0.25;
        g.add(capR);

        // interior (visible when unlocked)
        var interior = new THREE.Group();
        g.add(interior);
        var backL = new THREE.Mesh(backGeo, rockDarkMat);
        backL.position.set(-(CONFIG.shaftWidth / 2 + halfBack / 2), 0, -D / 2 + 0.06);
        backL.receiveShadow = true;
        interior.add(backL);
        var backR2 = new THREE.Mesh(backGeo, rockDarkMat);
        backR2.position.set(CONFIG.shaftWidth / 2 + halfBack / 2, 0, -D / 2 + 0.06);
        backR2.receiveShadow = true;
        interior.add(backR2);

        // glowing mineral seam: instanced elongated crystals on the back wall
        var seamMat = new THREE.MeshStandardMaterial({
          color: theme.seam, emissive: theme.seam, emissiveIntensity: 0.9,
          roughness: 0.35, metalness: 0.15
        });
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
        }
        crystals.count = CONFIG.crystalCounts[quality];
        crystals.instanceMatrix.needsUpdate = true;
        interior.add(crystals);

        // ore bin gauge (right side of the cavern)
        var binFrame = new THREE.Mesh(binFrameGeo, rockDarkMat);
        binFrame.position.set(CONFIG.binX, -H / 2 + (CONFIG.binHeight + 0.25) / 2 + 0.05, CONFIG.binZ);
        interior.add(binFrame);
        var binFillMat = new THREE.MeshStandardMaterial({
          color: theme.seam, emissive: theme.seam, emissiveIntensity: 0.55,
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
        var workerMat = new THREE.MeshStandardMaterial({ color: theme.lift, roughness: 0.7, metalness: 0.2 });
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
          crystals: crystals,
          workers: workers,
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
    var oreChunk = new THREE.Mesh(oreChunkGeo, oreMat);
    oreChunk.position.set(0, 0.4, 0);
    oreChunk.visible = false;
    lift.add(oreChunk);

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
      size: 0.22, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var points = new THREE.Points(pGeo, pMat);
    points.frustumCulled = false;
    scene.add(points);
    var pCursor = 0;

    function spawnBurst(x, y, z, count, hex, speed, life, spread) {
      var mult = CONFIG.particleMult[quality] * (reducedMotion ? 0.35 : 1);
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
      map: glowTex, color: theme.accent, transparent: true, opacity: 0,
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
    var liftDepth = { v: 0, w: 0 }; // spring toward current target depth
    var liftPhase = 0;              // 0..1 within one cycle, advanced by dt/cycle
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
    function cycleMsOf(state) {
      if (RULES && RULES.liftCycleMs) return RULES.liftCycleMs(state);
      return state.ruleset.liftCycleBase || 4000;
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
      lastState = state;
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
          rec.seamMat.emissiveIntensity = 0.85 + 0.18 * Math.sin(time * 1.7 + i2 * 1.3);
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
          rec.binFillMat.color.setHex(theme.seam);
          rec.binFillMat.emissive.setHex(theme.seam);
          rec.binFill.scale.x = 1;
          rec.warnCap.visible = false;
        }

        // workers: count from state, gentle deterministic bob
        var wc = Math.min(CONFIG.workerSlots, Math.max(0, L.workers | 0));
        rec.workers.count = wc;
        var bobAmp = reducedMotion ? 0 : 0.06;
        for (var w2 = 0; w2 < wc; w2++) {
          var off = rec.workerOffsets[w2];
          tmpV3.set(off.x, floorY + bobAmp * Math.sin(time * 3 + off.phase), off.z);
          tmpM4.makeTranslation(tmpV3.x, tmpV3.y, tmpV3.z);
          rec.workers.setMatrixAt(w2, tmpM4);
        }
        if (wc > 0) rec.workers.instanceMatrix.needsUpdate = true;
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

      // lift: continuous ride between the surface and the deepest working
      // layer; cycle period from the rules, phase advanced by real time
      var cycleMs = Math.max(600, cycleMsOf(state));
      liftPhase = (liftPhase + (dt * 1000) / cycleMs) % 1;
      var deepIdx = deepestWorkingLayer(state);
      var surfaceStop = CONFIG.surfaceY + 0.15;
      var targetDepth = deepIdx >= 0 ? -deepIdx * CONFIG.spacing : surfaceStop;
      springStep(liftDepth, targetDepth, dt, 2.0);
      var tri = liftPhase < 0.5 ? liftPhase * 2 : 2 - liftPhase * 2;
      var eased = smooth01(tri);
      lift.position.set(0, surfaceStop + (liftDepth.v - surfaceStop) * eased, 0);
      oreChunk.visible = !!(state.lift && state.lift.transitMilliOre > 0);
      if (oreChunk.visible) oreChunk.rotation.y = time * 1.5;

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
      renderer.render(scene, camera);
    }

    // ------------------------------------------------------------- theme ---
    function setTheme(th) {
      theme = th || DEFAULT_THEME;
      rockMat.color.setHex(theme.rock);
      rockDarkMat.color.setHex(theme.rockDark);
      rockDarkMat.emissive.setHex(theme.rockDark);
      lockedMat.color.setHex(theme.rock);
      liftMat.color.setHex(theme.lift);
      beamMat.color.setHex(theme.lift);
      depotMat.color.setHex(theme.accent);
      oreMat.color.setHex(theme.seam);
      oreMat.emissive.setHex(theme.seam);
      flareMat.color.setHex(theme.seamHot);
      flareMat.emissive.setHex(theme.seamHot);
      rimMat.color.setHex(theme.accent);
      ringMat.color.setHex(theme.accent);
      glowMat.color.setHex(theme.accent);
      keyLight.color.setHex(theme.key);
      hemiLight.color.setHex(theme.fill);
      hemiLight.groundColor.setHex(theme.rockDark);
      scene.fog.color.setHex(theme.fog);
      for (var i2 = 0; i2 < layers.length; i2++) {
        layers[i2].seamMat.color.setHex(theme.seam);
        layers[i2].seamMat.emissive.setHex(theme.seam);
        layers[i2].lamp.color.setHex(theme.seam);
        if (!layers[i2].warnCap.visible) {
          layers[i2].binFillMat.color.setHex(theme.seam);
          layers[i2].binFillMat.emissive.setHex(theme.seam);
        }
      }
      // regenerate theme-derived textures; dispose the old ones
      var oldSky = scene.background;
      skyTex = makeSkyTexture(theme);
      scene.background = skyTex;
      if (oldSky && oldSky.dispose) oldSky.dispose();
      var oldCrack = lockedMat.map;
      crackTex = makeCrackTexture(theme);
      lockedMat.map = crackTex;
      lockedMat.needsUpdate = true;
      if (oldCrack && oldCrack.dispose) oldCrack.dispose();
    }

    // ----------------------------------------------------------- quality ---
    function setQuality(tier) {
      if (!CONFIG.pixelRatioCap[tier]) return;
      quality = tier;
      keyLight.castShadow = tier !== 'low';
      var shadowSize = tier === 'high' ? 1024 : 512;
      if (keyLight.shadow.mapSize.x !== shadowSize) {
        keyLight.shadow.mapSize.set(shadowSize, shadowSize);
        if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
      }
      for (var i2 = 0; i2 < layers.length; i2++) {
        layers[i2].crystals.count = CONFIG.crystalCounts[tier];
      }
      // note: antialiasing is fixed at renderer creation (antialias: true);
      // tiers scale pixel ratio, shadows and particle density only. Picking
      // targets and gameplay information are identical on every tier.
      resize();
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
      var deepY = -deepest * CONFIG.spacing;
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
          spawnBurst(0, -CONFIG.spacing, 1.5, 150, theme.seamHot, 6.0, 1.5, 6.0);
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
    function resize() {
      if (disposed) return;
      var w = container.clientWidth || 1;
      var h = container.clientHeight || 1;
      camera.aspect = w / h;
      var halfW = CONFIG.layerWidth / 2 + 1.5;
      var needZ = halfW / (Math.tan((CONFIG.fov * Math.PI / 180) / 2) * camera.aspect);
      frameDist = Math.max(1, needZ / CONFIG.camPos.z);
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, CONFIG.pixelRatioCap[quality]));
      renderer.setSize(w, h, false); // CSS keeps the canvas filling the container
      if (paused) renderer.render(scene, camera); // repaint the frozen frame
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
        renderer.render(scene, camera);
      }
      paused = next;
    }

    // ------------------------------------------------------------ startup ---
    resize();
    setQuality(quality);
    renderer.compile(scene, camera); // precompile shaders before first frame
    renderer.render(scene, camera);

    return {
      setSnapshot: setSnapshot,
      setTheme: setTheme,
      setQuality: setQuality,
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

  root.DWRender = { create: create };
})(typeof self !== 'undefined' ? self : this);
