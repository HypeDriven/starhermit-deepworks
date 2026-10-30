// The mine on starhermit:scene, as the browser build's js/render.js drew it:
// a vertical cross-section framed like a tabletop diorama — the ground slab
// with the depot hut, hopper and headframe over the shaft mouth, the shaft
// with its beams, up to six layer caverns (rock shell, dark back walls, a
// seam of instanced glowing crystals, the ore-bin gauge with its "blocked"
// marker, instanced workers with helmet lamps, drifting dust motes, a
// seam-coloured lamp; a cracked sealed block while locked), the selection
// rim and grounded ring with the selected layer's spring lift, the flare
// marker, the lift cage riding its cosmetic itinerary (js/lift.js) with its
// growing bed of ore, pooled additive particle bursts, the upgrade glow and
// the error blink, the idle camera sway, the drag yaw spring and the pulse
// shake. The camera frames the mine into the band the HUD leaves (the top
// bar, the lesson card, the phone's tray) with a view offset, as the
// browser build did; picking casts onto each layer's box.
//
// Gaps and changes from three.js r128: colours keep r128's meaning (its
// pigment() swatches are the engine's sRGB hex, its raw hex values linear);
// r128's legacy light intensities × π (engine minor 28 uses three r155+ units),
// the page's light-space shadow box, the room on every standard material; its point-light cut-off falloff became the inverse square, so the layer
// lamps are brighter at the source; the post chain is renderer.ao / bloom /
// grade / antialias (the grade the old output pass's S-curve, saturation,
// warm-highlight / cool-shadow split and vignette in display space); the
// 'complete' white flash is drawn by the UI over the view (screens.ts reads
// flashAlpha()) instead of a camera-space quad; the rock's per-pixel grain
// is a scatter of faint flecks (per-pixel canvas loops are too slow on the
// native runtime); adaptive resolution, the frame-rate readout and the
// pixel-ratio cap are the runtime's.
import { loadClassic } from "starhermit:script";
import {
  ACESFilmicToneMapping, AdditiveBlending, Box3, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry,
  CylinderGeometry, DirectionalLight, DoubleSide, DynamicDrawUsage, EdgesGeometry, Euler, Fog, Group, HemisphereLight,
  InstancedMesh, OrthographicCamera, LineBasicMaterial, LineSegments, LinearSRGBColorSpace, Matrix4, Mesh, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, OctahedronGeometry, PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight, Points, PointsMaterial,
  Quaternion, Ray, RepeatWrapping, RingGeometry, RoomEnvironment, SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3,
  renderer, scene, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { R, type State, type Theme } from "./classic.ts";
import type { Look } from "./quality.ts";

loadClassic("js/lift.js");
interface Seg { kind: string; from: number; to: number; start: number; duration: number; before: number; after: number }
interface Trip { segments: Seg[]; duration: number }
const Lift = (globalThis as unknown as { DWLift: {
  planLiftTrip(s: State): Trip | null;
  sampleLiftTrip(t: Trip | null, elapsed: number, floors: number[]): { y: number; fill: number; phase: string };
} }).DWLift;

// -------------------------------------------------------------- config ---
const CONFIG = {
  seed: 0x5eed1234,
  fov: 30, near: 1.0, far: 220,
  camPos: { x: 0, y: -6.0, z: 37.0 },
  camTarget: { x: 0, y: -7.2, z: 0 },
  spacing: 3.2, firstLayerY: -2.0, maxLayers: 6,
  layerWidth: 15, layerHeight: 2.1, layerDepth: 3.0,
  surfaceY: 1.2, shaftWidth: 2.6,
  swayAmp: 0.35, swaySpeed: 0.32,
  maxYaw: 0.349, yawPerPixel: 0.0035,
  selectLift: 0.32, springW: 7.0,
  shakeDecay: 3.0, shakeMax: 0.55,
  binX: 5.9, binZ: 0.9, binHeight: 1.5,
  anchorX: 6.8, anchorZ: 1.2,
  workerSlots: 8, crystalMax: 80, particleMax: 512, dustMax: 36,
  exposure: 1.15, fogNear: 62, fogFar: 130,
};
const W = CONFIG.layerWidth, H = CONFIG.layerHeight, D = CONFIG.layerDepth;
const PI = Math.PI;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** r128's raw hex (taken as linear values there). */
const lin = (hex: number): Color => new Color().setHex(hex, LinearSRGBColorSpace);
/** r128's pigment(): an sRGB swatch (the engine's hex). */
const pig = (hex: number): Color => new Color(hex);
function cssColor(hex: number, mul: number): string {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * mul));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * mul));
  const b = Math.min(255, Math.round((hex & 255) * mul));
  return `rgb(${r},${g},${b})`;
}
interface Spring { v: number; w: number }
function springStep(s: Spring, target: number, dt: number, omega: number): void {
  const x = s.v - target;
  s.w += (-omega * omega * x - 2 * omega * s.w) * dt;
  s.v += s.w * dt;
}

// ------------------------------------------------------------ renderer ---
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.exposure;
const camera = new PerspectiveCamera(CONFIG.fov, 1, CONFIG.near, CONFIG.far);
renderer.camera = camera;

const DEFAULT_THEME: Theme = {
  id: "_fallback", name: "Fallback", rock: 0x754639, rockDark: 0x152d3b, seam: 0xff751f, seamHot: 0xffdfa0,
  fog: 0x091622, key: 0xffd4ab, fill: 0x65b9de, accent: 0xffb653, lift: 0x72b7c6, ambience: "warm",
};
let theme: Theme = DEFAULT_THEME;
let look: Look | null = null;
let reducedMotion = false;

// ---------------------------------------------------- generated textures ---
function makeSkyTexture(th: Theme): Texture {
  const c = new OffscreenCanvas(4, 256);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, cssColor(th.fill, 0.45));
  grad.addColorStop(0.4, cssColor(th.fog, 1.4));
  grad.addColorStop(1, cssColor(th.fog, 0.7));
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
function makeCrackTexture(th: Theme, sealed: boolean): Texture {
  const c = new OffscreenCanvas(256, 128);
  const g = c.getContext("2d");
  g.fillStyle = cssColor(th.rock, sealed ? 0.6 : 1);
  g.fillRect(0, 0, 256, 128);
  const rnd = mulberry32(CONFIG.seed ^ 0xc4ac);
  // Broad, irregular sediment bands give the cut faces readable structure.
  for (let band = 0; band < 7; band++) {
    const yBand = band * 20;
    g.fillStyle = cssColor(th.rock, (sealed ? 0.42 : 0.72) + rnd() * 0.22);
    g.beginPath(); g.moveTo(0, yBand);
    for (let bx = 0; bx <= 256; bx += 16) g.lineTo(bx, yBand + rnd() * 10);
    g.lineTo(256, yBand + 15); g.lineTo(0, yBand + 15); g.fill();
  }
  g.strokeStyle = cssColor(th.rockDark, 0.7);
  g.lineWidth = 1;
  for (let i = 0; i < 10; i++) {
    let x = rnd() * 256, y = rnd() * 128;
    g.beginPath();
    g.moveTo(x, y);
    const segs = 3 + Math.floor(rnd() * 4);
    for (let s2 = 0; s2 < segs; s2++) { x += (rnd() - 0.5) * 42; y += (rnd() - 0.5) * 42; g.lineTo(x, y); }
    g.stroke();
  }
  // Fine grain so flat faces read as stone (and give the bump map relief).
  for (let i = 0; i < 700; i++) {
    const n = rnd();
    g.fillStyle = n < 0.5 ? `rgba(0,0,0,${0.05 + rnd() * 0.06})` : `rgba(255,255,255,${0.03 + rnd() * 0.05})`;
    g.fillRect(Math.floor(rnd() * 256), Math.floor(rnd() * 128), 1 + Math.floor(rnd() * 2), 1);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}
function makeGlowTexture(): Texture {
  const c = new OffscreenCanvas(64, 64);
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}
let rockTex = makeCrackTexture(theme, false);
let crackTex = makeCrackTexture(theme, true);
const glowTex = makeGlowTexture();
scene.background = makeSkyTexture(theme);
scene.fog = new Fog(lin(theme.fog), CONFIG.fogNear, CONFIG.fogFar);

// -------------------------------------------------------------- lights ---
const keyLight = new DirectionalLight(lin(theme.key), 1.25 * PI);
keyLight.position.set(14, 16, 22);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
keyLight.target.position.set(0, -7, 0);
scene.add(keyLight);
scene.add(keyLight.target);
const hemiLight = new HemisphereLight(lin(theme.fill), lin(theme.rockDark), 1.3 * PI);
scene.add(hemiLight);
const rimLight = new DirectionalLight(lin(theme.fill), 1.1 * PI);
rimLight.position.set(-12, 2, 8);
scene.add(rimLight);
/** r128's lamp (1.2, cut off at 14 with decay 2) at the cavern's walls, under the inverse square. */
const LAMP = 3.4 * PI;

// ----------------------------------------------------------- materials ---
const rockMat = new MeshStandardMaterial({ color: 0xffffff, map: rockTex, roughness: 0.95, metalness: 0.02, bumpScale: 0.035, envMapIntensity: 0.18 });
const rockDarkMat = new MeshStandardMaterial({ color: pig(theme.rockDark), emissive: pig(theme.rockDark), emissiveIntensity: 0.5, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.1 });
const lockedMat = new MeshStandardMaterial({ color: 0xffffff, map: crackTex, roughness: 1.0, metalness: 0.0, bumpScale: 0.05, envMapIntensity: 0.15 });
const liftMat = new MeshStandardMaterial({ color: pig(theme.lift), roughness: 0.32, metalness: 0.75, envMapIntensity: 0.9 });
const depotMat = new MeshStandardMaterial({ color: pig(theme.accent), roughness: 0.8, metalness: 0.05, envMapIntensity: 0.3 });
const oreMat = new MeshStandardMaterial({ color: pig(theme.seam), emissive: pig(theme.seam), emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.5 });
const flareMat = new MeshStandardMaterial({ color: pig(theme.seamHot), emissive: pig(theme.seamHot), emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.1, envMapIntensity: 0.5 });
const rimMat = new LineBasicMaterial({ color: pig(theme.accent), transparent: true, opacity: 0.9 });
const ringMat = new MeshBasicMaterial({ color: pig(theme.accent), transparent: true, opacity: 0.8, side: DoubleSide });
const beamMat = new MeshStandardMaterial({ color: pig(theme.lift), roughness: 0.55, metalness: 0.45, envMapIntensity: 0.3 });
const helmetMat = new MeshStandardMaterial({ color: lin(0xfff1d0), emissive: lin(0xffe2a8), emissiveIntensity: 2.4, roughness: 0.4 });
const dustMat = new PointsMaterial({
  size: 0.16, map: glowTex, color: pig(theme.seamHot), transparent: true, opacity: 0.55,
  blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true,
});

// ---------------------------------------------------------- geometries ---
const slabGeo = new BoxGeometry(W, 0.45, D);
const capGeo = new BoxGeometry(0.5, H + 0.9, D);
const backGeo = new PlaneGeometry((W - CONFIG.shaftWidth) / 2 - 0.1, H);
const lockedGeo = new BoxGeometry(W, CONFIG.spacing * 0.98, D);
const crystalGeo = new OctahedronGeometry(0.3, 0);
crystalGeo.scale(0.55, 1.7, 0.55); // elongated shard
const workerGeo = new ConeGeometry(0.16, 0.52, 6);
workerGeo.translate(0, 0.26, 0); // base at y=0
const helmetGeo = new SphereGeometry(0.075, 8, 6);
helmetGeo.translate(0.05, 0.5, 0.1); // lamp on the brow, facing the viewer
const binFrameGeo = new BoxGeometry(0.85, CONFIG.binHeight + 0.25, 0.55);
const binFillGeo = new BoxGeometry(0.58, 1, 0.36);
binFillGeo.translate(0, 0.5, 0); // grows upward from its base
const warnGeo = new ConeGeometry(0.26, 0.42, 4);
const rimGeo = new EdgesGeometry(new BoxGeometry(W + 0.2, H + 1.0, D + 0.2));
const ringGeo = new RingGeometry(0.9, 1.18, 40);
const unitBeamGeo = new BoxGeometry(0.3, 1, 0.3);
const markerGeo = new OctahedronGeometry(0.42, 0);

// ------------------------------------------------------------- surface ---
const ground = new Mesh(new BoxGeometry(60, 1.2, 14), rockMat);
ground.position.set(0, CONFIG.surfaceY - 0.6, 0);
ground.receiveShadow = true;
scene.add(ground);
const hut = new Mesh(new BoxGeometry(1.7, 1.1, 1.5), depotMat);
hut.position.set(4.4, CONFIG.surfaceY + 0.55, 0);
hut.castShadow = true;
scene.add(hut);
const roof = new Mesh(new ConeGeometry(1.5, 0.85, 4), rockDarkMat);
roof.position.set(4.4, CONFIG.surfaceY + 1.5, 0);
roof.rotation.y = PI / 4;
roof.castShadow = true;
scene.add(roof);
const hopper = new Mesh(new ConeGeometry(0.7, 0.95, 4), liftMat);
hopper.position.set(2.5, CONFIG.surfaceY + 1.05, 0.2);
hopper.rotation.x = PI; // funnel point down
hopper.castShadow = true;
scene.add(hopper);
for (const x of [-1.15, 1.15]) {
  const hf = new Mesh(unitBeamGeo, beamMat);
  hf.scale.set(1, 2.4, 1);
  hf.position.set(x, CONFIG.surfaceY + 1.2, 0.4);
  scene.add(hf);
}
const wheel = new Mesh(new TorusGeometry(0.38, 0.09, 8, 20), liftMat);
wheel.position.set(0, CONFIG.surfaceY + 2.3, 0.4);
scene.add(wheel);

// --------------------------------------------------------------- shaft ---
const shaftLen = -CONFIG.firstLayerY + (CONFIG.maxLayers - 1) * CONFIG.spacing + H + 2.5;
const shaftBack = new Mesh(new PlaneGeometry(CONFIG.shaftWidth + 0.8, shaftLen), rockDarkMat);
shaftBack.position.set(0, CONFIG.surfaceY - shaftLen / 2 + 0.5, -D / 2 - 0.35);
scene.add(shaftBack);
for (const x of [-CONFIG.shaftWidth / 2, CONFIG.shaftWidth / 2]) {
  const beam = new Mesh(unitBeamGeo, beamMat);
  beam.scale.set(1, shaftLen, 1);
  beam.position.set(x, CONFIG.surfaceY - shaftLen / 2 + 0.5, -0.2);
  scene.add(beam);
}

// -------------------------------------------------------------- layers ---
interface LayerRec {
  group: Group; baseY: number; interior: Group; sealed: Mesh; seamMat: MeshStandardMaterial; seamPlain: MeshStandardMaterial;
  seamGloss: MeshPhysicalMaterial; crystals: InstancedMesh; workers: InstancedMesh; helmets: InstancedMesh; dust: Points;
  dustPos: Float32Array; dustSeed: { x: number; z: number; y: number; speed: number; phase: number; amp: number }[];
  dustCount: number; dustPlaced: boolean; workerOffsets: { x: number; z: number; phase: number }[];
  binFill: Mesh; binFillMat: MeshStandardMaterial; warnCap: Mesh; lamp: PointLight; selLift: Spring; workerMat: MeshStandardMaterial;
}
const layers: LayerRec[] = [];
const halfBack = (W - CONFIG.shaftWidth) / 2;
for (let i = 0; i < CONFIG.maxLayers; i++) {
  const g = new Group();
  const baseY = CONFIG.firstLayerY - i * CONFIG.spacing;
  g.position.y = baseY;
  scene.add(g);
  // The sealed block replaces the entire cavern (their faces share the shell's depth).
  const interior = new Group();
  g.add(interior);
  const ceil = new Mesh(slabGeo, rockMat);
  ceil.position.y = H / 2 + 0.225; ceil.castShadow = true; ceil.receiveShadow = true;
  interior.add(ceil);
  const floor = new Mesh(slabGeo, rockMat);
  floor.position.y = -H / 2 - 0.225; floor.receiveShadow = true;
  interior.add(floor);
  for (const x of [-(W / 2 - 0.25), W / 2 - 0.25]) {
    const cap = new Mesh(capGeo, rockMat);
    cap.position.x = x;
    interior.add(cap);
  }
  for (const x of [-(CONFIG.shaftWidth / 2 + halfBack / 2), CONFIG.shaftWidth / 2 + halfBack / 2]) {
    const back = new Mesh(backGeo, rockDarkMat);
    back.position.set(x, 0, -D / 2 + 0.06);
    back.receiveShadow = true;
    interior.add(back);
  }
  // The glowing mineral seam: instanced elongated crystals on the back wall.
  const seamPlain = new MeshStandardMaterial({ color: pig(theme.seam), emissive: pig(theme.seam), emissiveIntensity: 0.5, roughness: 0.22, metalness: 0.25 });
  const seamGloss = new MeshPhysicalMaterial({
    color: pig(theme.seam), emissive: pig(theme.seam), emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.1,
    clearcoat: 0.6, clearcoatRoughness: 0.12, envMapIntensity: 0.35,
  });
  const crystals = new InstancedMesh(crystalGeo, seamPlain, CONFIG.crystalMax);
  crystals.frustumCulled = false;
  crystals.castShadow = true;
  const rnd = mulberry32(CONFIG.seed + i * 7919);
  const m4 = new Matrix4(), q = new Quaternion(), e = new Euler(), v = new Vector3(), s = new Vector3();
  for (let ci = 0; ci < CONFIG.crystalMax; ci++) {
    const cx = (rnd() < 0.5 ? -1 : 1) * (CONFIG.shaftWidth / 2 + 0.5 + rnd() * (halfBack - 1.0));
    const cy = -H / 2 + 0.25 + rnd() * (H - 0.6);
    const cz = -D / 2 + 0.15 + rnd() * 0.55;
    e.set((rnd() - 0.5) * 0.7, rnd() * PI, (rnd() - 0.5) * 0.9);
    q.setFromEuler(e);
    const cs = 0.55 + rnd() * 0.95;
    s.set(cs, cs, cs);
    v.set(cx, cy, cz);
    m4.compose(v, q, s);
    crystals.setMatrixAt(ci, m4);
    crystals.setColorAt(ci, new Color().setHSL(0.06 + (ci % 5) * 0.025, 0.15, 0.58 + (ci % 4) * 0.12, LinearSRGBColorSpace));
  }
  crystals.count = 24;
  crystals.instanceMatrix.needsUpdate = true;
  interior.add(crystals);
  // The ore-bin gauge (right side of the cavern).
  const binFrame = new Mesh(binFrameGeo, rockDarkMat);
  binFrame.position.set(CONFIG.binX, -H / 2 + (CONFIG.binHeight + 0.25) / 2 + 0.05, CONFIG.binZ);
  interior.add(binFrame);
  const binFillMat = new MeshStandardMaterial({ color: pig(theme.seam), emissive: pig(theme.seam), emissiveIntensity: 0.55, roughness: 0.5, metalness: 0.1 });
  const binFill = new Mesh(binFillGeo, binFillMat);
  binFill.position.set(CONFIG.binX, -H / 2 + 0.14, CONFIG.binZ);
  interior.add(binFill);
  const warnMat = new MeshStandardMaterial({ color: lin(0xff5522), emissive: lin(0xff3311), emissiveIntensity: 0.9, roughness: 0.5 });
  const warnCap = new Mesh(warnGeo, warnMat);
  warnCap.rotation.z = PI; // point down: the "blocked" marker shape
  warnCap.position.set(CONFIG.binX, -H / 2 + CONFIG.binHeight + 0.55, CONFIG.binZ);
  warnCap.visible = false;
  interior.add(warnCap);
  // Worker figures: instanced cones with deterministic offsets.
  const workerMat = new MeshStandardMaterial({ color: pig(theme.accent), roughness: 0.7, metalness: 0.2 });
  const workers = new InstancedMesh(workerGeo, workerMat, CONFIG.workerSlots);
  workers.frustumCulled = false;
  workers.castShadow = true;
  workers.count = 0;
  const offsets: LayerRec["workerOffsets"] = [];
  for (let wi = 0; wi < CONFIG.workerSlots; wi++) {
    let wx = -W / 2 + 1.6 + (wi + 0.5) * ((W - 3.2) / CONFIG.workerSlots) + (rnd() - 0.5) * 0.9;
    if (Math.abs(wx) < CONFIG.shaftWidth / 2 + 0.5) wx += CONFIG.shaftWidth / 2 + 0.8; // keep out of the shaft gap
    offsets.push({ x: wx, z: 0.3 + rnd() * 0.9, phase: rnd() * PI * 2 });
  }
  interior.add(workers);
  const helmets = new InstancedMesh(helmetGeo, helmetMat, CONFIG.workerSlots);
  helmets.frustumCulled = false;
  helmets.count = 0;
  helmets.visible = false;
  interior.add(helmets);
  // Dust motes: deterministic drift paths inside the cavern.
  const dustPos = new Float32Array(CONFIG.dustMax * 3);
  const dustSeed: LayerRec["dustSeed"] = [];
  for (let di = 0; di < CONFIG.dustMax; di++) {
    dustSeed.push({ x: (rnd() - 0.5) * (W - 1.5), z: -D / 2 + 0.4 + rnd() * (D - 0.6), y: rnd(), speed: 0.04 + rnd() * 0.08, phase: rnd() * PI * 2, amp: 0.2 + rnd() * 0.5 });
  }
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute("position", new BufferAttribute(dustPos, 3).setUsage(DynamicDrawUsage));
  dustGeo.setDrawRange(0, 0);
  const dust = new Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  interior.add(dust);
  // Locked: one dark sealed block with a faint crack texture.
  const sealed = new Mesh(lockedGeo, lockedMat);
  sealed.visible = false;
  g.add(sealed);
  // A seam-coloured lamp makes open interiors readable.
  const lamp = new PointLight(lin(theme.seam), LAMP, 14, 2);
  lamp.position.set(0, 0.2, 1.1);
  lamp.visible = false;
  g.add(lamp);
  layers.push({
    group: g, baseY, interior, sealed, seamMat: seamPlain, seamPlain, seamGloss, crystals, workers, helmets, dust, dustPos, dustSeed,
    dustCount: 0, dustPlaced: false, workerOffsets: offsets, binFill, binFillMat, warnCap, lamp, selLift: { v: 0, w: 0 }, workerMat,
  });
}

// ------------------------------------------------- selection treatment ---
const selRim = new LineSegments(rimGeo, rimMat);
selRim.visible = false;
scene.add(selRim);
const selRing = new Mesh(ringGeo, ringMat);
selRing.rotation.x = -PI / 2; // grounded on the cavern floor
selRing.visible = false;
scene.add(selRing);
const flareMarker = new Mesh(markerGeo, flareMat);
flareMarker.visible = false;
scene.add(flareMarker);

// ----------------------------------------------------------------- lift ---
const lift = new Group();
scene.add(lift);
const cage = new Mesh(new BoxGeometry(1.9, 0.18, 1.5), liftMat);
cage.castShadow = true;
lift.add(cage);
const postGeo = new CylinderGeometry(0.05, 0.05, 1.15, 6);
for (const [px, pz] of [[-0.85, -0.65], [0.85, -0.65], [-0.85, 0.65], [0.85, 0.65]] as [number, number][]) {
  const post = new Mesh(postGeo, liftMat);
  post.position.set(px, 0.65, pz);
  lift.add(post);
}
const crossbar = new Mesh(new BoxGeometry(1.9, 0.12, 0.12), liftMat);
crossbar.position.y = 1.25;
lift.add(crossbar);
const cable = new Mesh(new CylinderGeometry(0.03, 0.03, 60, 4), beamMat);
cable.position.y = 30; // runs up out of frame
lift.add(cable);
// A bed of ore grows from the platform; the fixed cage gives it a capacity reference.
const cargoGeo = new BoxGeometry(1.5, 0.85, 1.1);
cargoGeo.translate(0, 0.425, 0);
const cargo = new Mesh(cargoGeo, oreMat);
cargo.position.y = 0.09;
cargo.visible = false;
lift.add(cargo);
const cargoTop = new Group();
const chunkGeo = new OctahedronGeometry(0.18, 0);
for (let chunk = 0; chunk < 12; chunk++) {
  const piece = new Mesh(chunkGeo, oreMat);
  piece.position.set((chunk % 4 - 1.5) * 0.34, 0, (Math.floor(chunk / 4) - 1) * 0.32);
  piece.rotation.set(chunk * 0.7, chunk * 1.3, 0.4);
  piece.scale.set(1, 0.65 + (chunk % 3) * 0.2, 1);
  cargoTop.add(piece);
}
lift.add(cargoTop);

// ----------------------------------------------------- VFX: particles ---
const P_MAX = CONFIG.particleMax;
const pPos = new Float32Array(P_MAX * 3);
const pCol = new Float32Array(P_MAX * 3);
const pVel = new Float32Array(P_MAX * 3);
const pBase = new Float32Array(P_MAX * 3);
const pLife = new Float32Array(P_MAX);
const pLife0 = new Float32Array(P_MAX);
for (let j = 0; j < P_MAX; j++) pPos[j * 3 + 1] = -9999;
const pGeo = new BufferGeometry();
pGeo.setAttribute("position", new BufferAttribute(pPos, 3).setUsage(DynamicDrawUsage));
pGeo.setAttribute("color", new BufferAttribute(pCol, 3).setUsage(DynamicDrawUsage));
const pMat = new PointsMaterial({ size: 0.26, map: glowTex, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true });
const points = new Points(pGeo, pMat);
points.frustumCulled = false;
scene.add(points);
let pCursor = 0;
let liveParticles = 0;
function spawnBurst(x: number, y: number, z: number, count: number, hex: number, speed: number, life: number, spread: number): void {
  const mult = (look ? look.budget.burst : 0.21) * (reducedMotion ? 0.35 : 1);
  const n = Math.max(1, Math.round(count * mult));
  const r = ((hex >> 16) & 255) / 255, g2 = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  for (let k = 0; k < n; k++) {
    const i2 = pCursor;
    pCursor = (pCursor + 1) % P_MAX;
    const i3 = i2 * 3;
    pPos[i3] = x + (Math.random() - 0.5) * spread;
    pPos[i3 + 1] = y + (Math.random() - 0.5) * spread * 0.5;
    pPos[i3 + 2] = z + (Math.random() - 0.5) * spread;
    const th = Math.random() * PI * 2;
    const up = Math.random() * 0.9 + 0.25;
    const sp = speed * (0.4 + Math.random() * 0.8);
    pVel[i3] = Math.cos(th) * sp;
    pVel[i3 + 1] = up * sp;
    pVel[i3 + 2] = Math.sin(th) * sp * 0.5;
    pBase[i3] = r; pBase[i3 + 1] = g2; pBase[i3 + 2] = b;
    pLife[i2] = pLife0[i2] = life * (0.6 + Math.random() * 0.7);
  }
  liveParticles = P_MAX;
}
function updateParticles(dt: number): void {
  if (!liveParticles) return;
  let alive = 0;
  for (let i2 = 0; i2 < P_MAX; i2++) {
    if (pLife[i2]! <= 0) continue;
    pLife[i2]! -= dt;
    const i3 = i2 * 3;
    if (pLife[i2]! <= 0) { pPos[i3 + 1] = -9999; pCol[i3] = pCol[i3 + 1] = pCol[i3 + 2] = 0; continue; }
    alive++;
    pVel[i3 + 1]! -= 4.5 * dt; // light gravity
    pPos[i3]! += pVel[i3]! * dt;
    pPos[i3 + 1]! += pVel[i3 + 1]! * dt;
    pPos[i3 + 2]! += pVel[i3 + 2]! * dt;
    const f = pLife[i2]! / pLife0[i2]!;
    pCol[i3] = pBase[i3]! * f;
    pCol[i3 + 1] = pBase[i3 + 1]! * f;
    pCol[i3 + 2] = pBase[i3 + 2]! * f;
  }
  liveParticles = alive;
  pGeo.attributes.position!.needsUpdate = true;
  pGeo.attributes.color!.needsUpdate = true;
}

// ---------------------------------------------- VFX: glow and error blink ---
const glowMat = new MeshBasicMaterial({ map: glowTex, color: pig(theme.accent), transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false });
const glowMesh = new Mesh(new PlaneGeometry(4, 4), glowMat);
glowMesh.position.set(0, CONFIG.surfaceY + 1.4, 1.2);
scene.add(glowMesh);
const hudBlinkMat = new MeshBasicMaterial({ color: lin(0xff3333), transparent: true, opacity: 0 });
const hudBlink = new Mesh(new PlaneGeometry(0.7, 0.7), hudBlinkMat);
hudBlink.position.set(6.0, CONFIG.surfaceY + 1.1, 1.0); // next to the depot
scene.add(hudBlink);

// ------------------------------------------------------- runtime state ---
let time = 0;
let paused = false;
let lastState: State | null = null;
let selectedLayer: number | null = null;
let flareLayer: number | null = null;
const yaw: Spring = { v: 0, w: 0 };
let yawTarget = 0;
let shakeAmp = 0;
let liftTrip: Trip | null = null, liftElapsed = 0, liftClock = -1, liftSeed: number | null = null;
const liftFloors: number[] = new Array(CONFIG.maxLayers).fill(0);
let flashT = 0, glowT = 0, errorT = 0;
let frameDist = 1;
let targetY = CONFIG.camTarget.y;
let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
let viewLayers = -1;

/** The scene draws only where it is shown (always: the title sits over the attract mine). */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

/** One frame of the mine for `state` (read only), `dtSec` of decorative time. */
export function setSnapshot(state: State, dtSec: number): void {
  if (state.layers.length !== viewLayers) { lastState = state; frame(); }
  lastState = state;
  // Paused: the state shows, the decorative motion holds still.
  const dt = paused ? 0 : Math.min(Math.max(dtSec || 0, 0), 0.1);
  time += dt;
  const layerCount = Math.min(state.ruleset.layerCount || CONFIG.maxLayers, CONFIG.maxLayers);
  const sway = reducedMotion ? 0 : CONFIG.swayAmp;
  const floorY = -H / 2 + 0.05;
  const m4 = new Matrix4();
  for (let i = 0; i < CONFIG.maxLayers; i++) {
    const rec = layers[i]!;
    const inRange = i < layerCount;
    rec.group.visible = inRange;
    rec.lamp.visible = false;
    if (!inRange) continue;
    const L = state.layers[i];
    const unlocked = !!(L && L.unlocked);
    rec.interior.visible = unlocked;
    rec.sealed.visible = !unlocked;
    rec.lamp.visible = unlocked;
    const flick = reducedMotion ? 1 : 1 + (0.08 * Math.sin(time * 7.3 + i * 2.1) + 0.05 * Math.sin(time * 13.1 + i)) / 1.2;
    rec.lamp.intensity = LAMP * flick;
    springStep(rec.selLift, selectedLayer === i ? CONFIG.selectLift : 0, dt, CONFIG.springW);
    rec.group.position.y = rec.baseY + rec.selLift.v;
    if (!unlocked || !L) continue;
    // Seam glow: a subtle idle pulse; a strong pulse while flaring.
    rec.seamMat.emissiveIntensity = flareLayer === i
      ? (reducedMotion ? 1.4 + 0.4 * Math.sin(time * 4) : 1.7 + 0.8 * Math.sin(time * 9))
      : 0.48 + 0.1 * Math.sin(time * 1.7 + i * 1.3);
    // The ore-bin gauge.
    const cap = R.binCapMilli(state, i);
    const frac = cap > 0 ? Math.min(1, (L.milliOre || 0) / cap) : 0;
    rec.binFill.scale.y = Math.max(0.03, frac * CONFIG.binHeight);
    const blocked = cap > 0 && L.milliOre >= cap * 0.98;
    if (blocked) {
      // warning = colour shift AND shape change (pulsing width + cap marker)
      rec.binFillMat.color.copy(lin(0xff6622));
      rec.binFillMat.emissive.copy(lin(0xcc3311));
      rec.binFill.scale.x = reducedMotion ? 1 : 1 + 0.14 * Math.sin(time * 10);
      rec.warnCap.visible = true;
    } else {
      rec.binFillMat.color.copy(pig(theme.seam));
      rec.binFillMat.emissive.copy(pig(theme.seam));
      rec.binFill.scale.x = 1;
      rec.warnCap.visible = false;
    }
    // Workers: the count from the state, a gentle deterministic bob.
    const wc = Math.min(CONFIG.workerSlots, Math.max(0, L.workers | 0));
    rec.workers.count = wc;
    const bobAmp = reducedMotion ? 0 : 0.06;
    const lamps = rec.helmets.visible;
    rec.helmets.count = lamps ? wc : 0;
    for (let w2 = 0; w2 < wc; w2++) {
      const off = rec.workerOffsets[w2]!;
      m4.makeTranslation(off.x, floorY + bobAmp * Math.sin(time * 3 + off.phase), off.z);
      rec.workers.setMatrixAt(w2, m4);
      if (lamps) rec.helmets.setMatrixAt(w2, m4);
    }
    if (wc > 0) {
      rec.workers.instanceMatrix.needsUpdate = true;
      if (lamps) rec.helmets.instanceMatrix.needsUpdate = true;
    }
    // Dust motes rise slowly through the cavern and wrap (frozen with reduced motion).
    const dn = rec.dustCount;
    if (dn > 0 && (!reducedMotion || !rec.dustPlaced)) {
      const dtime = reducedMotion ? 0 : time;
      for (let d2 = 0; d2 < dn; d2++) {
        const ds = rec.dustSeed[d2]!;
        const dy = (ds.y + dtime * ds.speed) % 1;
        rec.dustPos[d2 * 3] = ds.x + ds.amp * Math.sin(dtime * 0.35 + ds.phase);
        rec.dustPos[d2 * 3 + 1] = -H / 2 + 0.15 + dy * (H - 0.3);
        rec.dustPos[d2 * 3 + 2] = ds.z + 0.15 * Math.sin(dtime * 0.5 + ds.phase * 1.7);
      }
      rec.dust.geometry.attributes.position!.needsUpdate = true;
      rec.dustPlaced = true;
    }
  }
  // The selection rim and grounded ring follow the selected layer.
  if (selectedLayer !== null && selectedLayer >= 0 && selectedLayer < layerCount) {
    const sy = layers[selectedLayer]!.group.position.y;
    selRim.visible = true;
    selRim.position.set(0, sy, 0);
    selRing.visible = true;
    const ringPulse = reducedMotion ? 1 : 1 + 0.08 * Math.sin(time * 4);
    selRing.scale.set(ringPulse, ringPulse, 1);
    selRing.position.set(0, sy - H / 2 - 0.2 + 0.03, D / 2 + 0.4);
  } else {
    selRim.visible = false;
    selRing.visible = false;
  }
  // The flare marker floats above the flaring layer.
  if (flareLayer !== null && flareLayer >= 0 && flareLayer < layerCount && layers[flareLayer]!.interior.visible) {
    flareMarker.visible = true;
    const fy = layers[flareLayer]!.group.position.y;
    const bob = reducedMotion ? 0 : 0.18 * Math.sin(time * 5);
    flareMarker.position.set(0, fy + H / 2 + 1.0 + bob, 0.6);
    flareMarker.rotation.y = reducedMotion ? 0 : time * 2.2;
    flareMat.emissiveIntensity = 1.4 + 0.7 * Math.sin(time * 9);
  } else flareMarker.visible = false;
  // The lift docks its platform's top at the actual floor, selection lift included;
  // the itinerary is frozen during travel so a new crew cannot move the destination.
  const clock = state.tick + state.tickMs / 1000;
  if (liftSeed !== state.seed || clock < liftClock || !state.ruleset.mechanics.lift ||
      (liftTrip && liftTrip.segments.some((seg) => seg.to >= 0 && (!state.layers[seg.to] || !state.layers[seg.to]!.unlocked)))) {
    liftTrip = null; liftElapsed = 0;
  }
  liftSeed = state.seed; liftClock = clock;
  if (!liftTrip) liftTrip = Lift.planLiftTrip(state);
  if (liftTrip) {
    liftElapsed += dt;
    if (liftElapsed >= liftTrip.duration) { liftElapsed -= liftTrip.duration; liftTrip = Lift.planLiftTrip(state); }
  } else liftElapsed = 0;
  for (let fi = 0; fi < CONFIG.maxLayers; fi++) liftFloors[fi] = layers[fi]!.group.position.y - H / 2;
  const ride = Lift.sampleLiftTrip(liftTrip, liftElapsed, liftFloors);
  lift.position.set(0, ride.y, 0);
  cargo.visible = cargoTop.visible = ride.fill > 0.001;
  cargo.scale.y = Math.max(0.001, ride.fill);
  cargoTop.position.y = 0.09 + 0.85 * ride.fill;
  cargoTop.scale.y = Math.min(1, ride.fill * 5);
  // Camera: idle sway + drag-orbit yaw spring + decaying pulse shake.
  springStep(yaw, yawTarget, dt, CONFIG.springW);
  if (reducedMotion) shakeAmp = 0;
  shakeAmp *= Math.exp(-CONFIG.shakeDecay * dt);
  placeCamera(sway);
  // One-shot effects.
  if (flashT > 0) flashT = Math.max(0, flashT - dt * 1.4);
  if (glowT > 0) { glowT = Math.max(0, glowT - dt * 1.8); glowMat.opacity = glowT * 0.9; }
  if (errorT > 0) {
    errorT = Math.max(0, errorT - dt * 0.8);
    hudBlinkMat.opacity = errorT * (Math.sin(time * 18) > 0 ? 0.85 : 0.15);
  } else hudBlinkMat.opacity = 0;
  updateParticles(dt);
}

const camLocal = new Vector3();
const camLook = new Vector3();
const yAxis = new Vector3(0, 1, 0);
function placeCamera(sway: number): void {
  camLocal.set(
    CONFIG.camPos.x + sway * Math.sin(time * CONFIG.swaySpeed),
    CONFIG.camPos.y + sway * 0.5 * Math.sin(time * CONFIG.swaySpeed * 0.73 + 1.3),
    CONFIG.camPos.z * frameDist,
  ).applyAxisAngle(yAxis, yaw.v);
  camLook.set(CONFIG.camTarget.x, targetY, CONFIG.camTarget.z).applyAxisAngle(yAxis, yaw.v);
  const sx = shakeAmp * Math.sin(time * 47.3), sy = shakeAmp * Math.sin(time * 39.1 + 1.7);
  camera.position.set(camLocal.x + sx, camLocal.y + sy, camLocal.z);
  camera.lookAt(camLook.x + sx, camLook.y + sy, camLook.z);
  camera.updateMatrixWorld();
}

// ------------------------------------------------------------- framing ---
/** The band of the window (physical px) the mine is framed into, within the W × H window. */
export function setView(x: number, y: number, w: number, h: number, Wd: number, Hd: number): void {
  const next = { x, y, w: Math.max(60, w), h: Math.max(60, h), W: Math.max(1, Wd), H: Math.max(1, Hd) };
  if ((Object.keys(next) as (keyof typeof next)[]).every((k) => Math.abs(next[k] - view[k]) < 0.5)) return;
  view = next;
  frame();
}
function frame(): void {
  camera.aspect = view.w / view.h;
  camera.updateProjectionMatrix();
  camera.setViewOffset(view.w, view.h, -view.x, -view.y, view.W, view.H);
  const aspect = view.w / view.h;
  const tanHalf = Math.tan((CONFIG.fov * PI / 180) / 2);
  const halfW = CONFIG.layerWidth / 2 + 1.5;
  const needZ = halfW / (tanHalf * aspect);
  // Vertically: the surface slab down to the deepest layer this mine has (sealed ones included).
  const layerCount = lastState ? lastState.layers.length : CONFIG.maxLayers;
  viewLayers = lastState ? lastState.layers.length : -1;
  const span = CONFIG.surfaceY - CONFIG.firstLayerY + (layerCount - 1) * CONFIG.spacing + CONFIG.layerHeight + 1.5;
  const centreY = CONFIG.surfaceY - span / 2 + 0.75;
  const needZv = (span / 2) / tanHalf;
  frameDist = Math.max(1, needZ / CONFIG.camPos.z, needZv / CONFIG.camPos.z);
  targetY = Math.min(CONFIG.camTarget.y, centreY);
  fitShadow(layerCount);
  placeCamera(reducedMotion ? 0 : CONFIG.swayAmp);
}
function fitShadow(layerCount: number): void {
  const n = Math.max(1, Math.min(CONFIG.maxLayers, layerCount));
  const yTop = CONFIG.surfaceY + 3.0;
  const yBot = CONFIG.firstLayerY - (n - 1) * CONFIG.spacing - H / 2 - 1.0;
  // The page's shadow box: the mine's bounding box in light space.
  const xs = [-W / 2 - 1, W / 2 + 1], ys = [yBot, yTop], zs = [-D / 2 - 0.6, D / 2 + 1.2];
  const lv = new Matrix4().lookAt(keyLight.position, keyLight.target.position, camera.up);
  lv.setPosition(keyLight.position);
  lv.invert();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const x of xs) for (const y of ys) for (const z of zs) {
    const v = new Vector3(x, y, z).applyMatrix4(lv);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
  }
  const sc = keyLight.shadow.camera as OrthographicCamera;
  sc.left = minX - 0.5; sc.right = maxX + 0.5; sc.bottom = minY - 0.5; sc.top = maxY + 0.5;
  sc.near = Math.max(0.5, -maxZ - 2); sc.far = -minZ + 2;
  sc.updateProjectionMatrix();
}

// ----------------------------------------------------- projection, picking ---
const tmpV = new Vector3();
const inv = new Matrix4();
/** Window pixel (physical) of a layer's label anchor, as js/render.js screenPosForLayer (by hand: the view offset). */
export function screenPosForLayer(i: number): { x: number; y: number } | null {
  const rec = layers[i];
  if (!rec || !renderer.camera) return null;
  tmpV.set(CONFIG.anchorX, rec.group.position.y + 0.4, CONFIG.anchorZ);
  inv.copy(camera.matrixWorld).invert();
  tmpV.applyMatrix4(inv);
  if (tmpV.z >= -0.01) return null;
  const tanHalf = Math.tan((CONFIG.fov * PI / 180) / 2);
  const aspect = view.w / view.h;
  const nx = tmpV.x / (-tmpV.z * tanHalf * aspect), ny = tmpV.y / (-tmpV.z * tanHalf);
  return { x: view.x + (nx + 1) / 2 * view.w, y: view.y + (1 - ny) / 2 * view.h };
}
const ray = new Ray();
const box = new Box3();
const hit = new Vector3();
/** The layer under a window pixel (its box: wider and deeper than the cavern), or null. */
export function pick(x: number, y: number): number | null {
  if (!lastState || !renderer.camera) return null;
  const tanHalf = Math.tan((CONFIG.fov * PI / 180) / 2);
  const aspect = view.w / view.h;
  const nx = ((x - view.x) / view.w) * 2 - 1, ny = 1 - ((y - view.y) / view.h) * 2;
  const dir = new Vector3(nx * tanHalf * aspect, ny * tanHalf, -1).transformDirection(camera.matrixWorld);
  ray.origin.copy(camera.position);
  ray.direction.copy(dir);
  const count = Math.min(lastState.ruleset.layerCount || CONFIG.maxLayers, CONFIG.maxLayers, lastState.layers.length);
  let best: number | null = null, bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const gy = layers[i]!.group.position.y;
    box.min.set(-(W + 2) / 2, gy - CONFIG.spacing / 2, -(D + 2) / 2);
    box.max.set((W + 2) / 2, gy + CONFIG.spacing / 2, (D + 2) / 2);
    if (ray.intersectBox(box, hit)) {
      const d = hit.distanceTo(camera.position);
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return best;
}
/** A drag on the mine turns it (window pixels moved since the press, at `scale`), clamped to ±20°. */
export function dragYaw(startYaw: number, dx: number, scale: number): void {
  yawTarget = Math.max(-CONFIG.maxYaw, Math.min(CONFIG.maxYaw, startYaw + (dx / scale) * CONFIG.yawPerPixel));
}
export function currentYawTarget(): number { return yawTarget; }

// ------------------------------------------------------------ theme, look ---
/** The mine's theme (rock, seams, lights, fog, sky). */
export function setTheme(th: Theme): void {
  if (th === theme) return;
  theme = th;
  const oldRock = rockTex, oldCrack = crackTex;
  rockTex = makeCrackTexture(theme, false);
  crackTex = makeCrackTexture(theme, true);
  rockMat.map = rockTex;
  lockedMat.map = crackTex;
  if (rockMat.bumpMap) rockMat.bumpMap = rockTex;
  if (lockedMat.bumpMap) lockedMat.bumpMap = crackTex;
  oldRock.dispose(); oldCrack.dispose();
  rockDarkMat.color.copy(pig(theme.rockDark));
  rockDarkMat.emissive.copy(pig(theme.rockDark));
  rimLight.color.copy(lin(theme.fill));
  liftMat.color.copy(pig(theme.lift));
  beamMat.color.copy(pig(theme.lift));
  depotMat.color.copy(pig(theme.accent));
  oreMat.color.copy(pig(theme.seam));
  oreMat.emissive.copy(pig(theme.seam));
  flareMat.color.copy(pig(theme.seamHot));
  flareMat.emissive.copy(pig(theme.seamHot));
  rimMat.color.copy(pig(theme.accent));
  ringMat.color.copy(pig(theme.accent));
  glowMat.color.copy(pig(theme.accent));
  dustMat.color.copy(pig(theme.seamHot));
  keyLight.color.copy(lin(theme.key));
  hemiLight.color.copy(lin(theme.fill));
  hemiLight.groundColor.copy(lin(theme.rockDark));
  (scene.fog as Fog).color.copy(lin(theme.fog));
  for (const rec of layers) {
    rec.workerMat.color.copy(pig(theme.accent));
    for (const m of [rec.seamPlain, rec.seamGloss]) { m.color.copy(pig(theme.seam)); m.emissive.copy(pig(theme.seam)); }
    rec.lamp.color.copy(lin(theme.seam));
  }
  const oldSky = scene.background as Texture | null;
  scene.background = makeSkyTexture(theme);
  if (oldSky && "dispose" in oldSky) oldSky.dispose();
  bindEnv();
}

let envTex: Texture | null = null;
function envMap(): Texture | null {
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}
/** r128's scene.environment honoured each material's envMapIntensity; three r163+ (the engine) applies
 * scene.environmentIntensity instead, so every standard material takes the room as its own envMap. */
function bindEnv(): void {
  const env = look?.reflections ? envMap() : null;
  scene.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | MeshStandardMaterial[] | undefined;
    for (const x of Array.isArray(m) ? m : m ? [m] : []) {
      if ("envMapIntensity" in x && x.envMap !== env) { x.envMap = env; }
    }
  });
}
/** The graphics level's look (quality.ts), applied live. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  bindEnv();
  rockMat.bumpMap = next.detailed ? rockTex : null;
  lockedMat.bumpMap = next.detailed ? crackTex : null;
  for (const rec of layers) {
    const mat: MeshStandardMaterial = next.detailed ? rec.seamGloss : rec.seamPlain;
    if (rec.seamMat !== mat) {
      mat.emissiveIntensity = rec.seamMat.emissiveIntensity;
      rec.seamMat = mat;
      rec.crystals.material = mat;
    }
    rec.crystals.count = next.budget.crystals;
    rec.helmets.visible = next.detailed;
    rec.dustCount = next.budget.dust;
    rec.dust.geometry.setDrawRange(0, next.budget.dust);
    rec.dustPlaced = false;
  }
  // The old post chain: SSAO (kernel 0.7, 0.9 on high), HDR bloom (0.5, 0.22, 0.88), the output grade.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.8, radius: next.ao === "high" ? 0.9 : 0.7, distanceExponent: 1.2, thickness: 1.0, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: next.ao === "high" ? 1 : 0.5,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // minor 29 bloom follows r185's UnrealBloomPass; this page ran three r128, so the strength is squared (0.5² ≈ 0.25) to keep its look.
  renderer.bloom = next.bloom ? { strength: 0.25, radius: 0.22, threshold: 0.88, resolution: next.budget.bloomRes } : null;
  // The output pass's grade (display space): a 0.22 S-curve, saturation 1.1,
  // cool shadows / warm highlights, a slight lift and the 0.28 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.12, saturation: 1.1,
    shadows: [0.95, 0.98, 1.06], highlights: [1.05, 1.0, 0.94], split: [0.15, 0.75],
    vignette: { amount: 0.28, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; if (on) shakeAmp = 0; }
export function setSelectedLayer(i: number | null): void { selectedLayer = typeof i === "number" && i >= 0 ? i : null; }
export function setFlareActive(i: number | null): void { flareLayer = typeof i === "number" && i >= 0 ? i : null; }
/** A paused run freezes the decorative motion on the last frame. */
export function setPaused(on: boolean): void { paused = on; }
/** The 'complete' flash's strength now (0–1), drawn over the view by the UI. */
export function flashAlpha(): number { return flashT * 0.85; }

function deepestWorkingLayer(state: State): number {
  let best = -1;
  for (let i = 0; i < state.layers.length; i++) if (state.layers[i]!.unlocked && state.layers[i]!.workers > 0) best = i;
  return best;
}
/** A one-shot effect: coin, upgrade, unlock, complete or error (js/render.js pulse). */
export function pulse(name: "coin" | "upgrade" | "unlock" | "complete" | "error"): void {
  const deepest = lastState ? Math.max(0, deepestWorkingLayer(lastState)) : 0;
  const deepY = layers[deepest]!.baseY;
  switch (name) {
    case "coin": spawnBurst(2.5, CONFIG.surfaceY + 1.0, 0.6, 14, theme.accent, 2.2, 0.7, 0.8); break;
    case "upgrade": glowT = 1; spawnBurst(0, CONFIG.surfaceY + 1.2, 0.6, 26, theme.accent, 3.0, 0.9, 1.6); break;
    case "unlock":
      shakeAmp = Math.max(shakeAmp, 0.22);
      spawnBurst(0, deepY, 0.8, 60, theme.seamHot, 3.6, 1.1, 4.0);
      spawnBurst(0, deepY - 0.5, 0.8, 30, theme.rock, 2.4, 1.2, 4.5);
      break;
    case "complete":
      if (!reducedMotion) flashT = 1;
      shakeAmp = Math.max(shakeAmp, CONFIG.shakeMax);
      spawnBurst(0, layers[1]!.baseY, 1.5, 150, theme.seamHot, 6.0, 1.5, 6.0);
      spawnBurst(0, CONFIG.surfaceY + 1.0, 1.0, 60, theme.accent, 4.5, 1.3, 3.0);
      break;
    case "error": errorT = 1; break; // a red blink by the depot; no camera move
  }
}
