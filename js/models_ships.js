// =============================================================================
// CRIMSON BOLT (赤電) — extension models: hangar aircraft + option drones
// -----------------------------------------------------------------------------
// models.js registers these tables: createPlayer(id) uses PLAYERS[id],
// createOption(id) uses OPTIONS[id]. Each entry is a factory () => THREE.Group
// that returns a NEW instance per call (pools build several).
//
//   export const PLAYERS = { gale, titan, phantom };   // keys = AIRCRAFT ids in defs.js ('bolt' lives in models.js)
//   export const OPTIONS = { phantom };                 // the option drone of that aircraft
//
//   GALE 疾風     slim forward-swept interceptor: needle nose + pitot, canards, forward-swept
//                 wing with glowing cyan tip lights, twin small nozzles, pearl white + cyan
//   TITAN 重鎚    broad heavy attack jet: blunt nose with a rotary cannon, two big engine
//                 nacelles, chunky trapezoid wings with pylons (bomb, rocket pod, wingtip ECM
//                 pods), gunmetal + amber / gold visor
//   PHANTOM 幻影  stealth cranked-kite flying wing (no tails), sawtooth trailing edge, black-violet
//                 skin with glowing violet leading / trailing edges and one flat slit exhaust
//   phantom drone glowing violet core orb in an armoured collar, four spinning pinwheel fins
//
// Imports: only 'three', './modelkit.js' (and './defs.js' for colours) — never
// models.js (import cycle). House style and helpers: see the modelkit.js header.
//
// Player contract — build a body GB, then call modelkit.assemblePlayer({...}):
//   * nose toward −z, up +y, centred on the origin (= the collision centre)
//   * userData: kind (the registry sets 'player:<id>'), radius, grazeRadius, debrisColor,
//     muzzles (local Vector3[]), muzzleZ (local z of the gun line; bolt −1.0),
//     trail [[x, z], …] (local engine-exhaust points for the game's engine sprite; bolt
//     [[±0.095, 0.95]]), hitboxMarker (makeHitboxMarker(); the game hides / scales it),
//     bankPivot, setBank(b) (−1..1, b > 0 rolls RIGHT), setThrust(0..1), setFlash(0..1),
//     update(dt, t), dispose() (frees materials only; geometry stays cached)
//   * gameplay numbers (speed, hitR, grazeR, bombs, damage) live in defs.js AIRCRAFT, not here
//   * size close to the bolt (≈ 1.9 long, 1.6 wide) so the hitbox marker and shots line up
//   * budget: ≤ 4 draw calls, ≤ 1500 triangles (dev/models.html checks it)
//   * a distinct silhouette per aircraft: the shadow is baked per kind from a pristine instance
// Option contract (small escort drone; the game spawns AIRCRAFT.options of them):
//   * nose −z, up +y, centred; ≈ 0.7 long
//   * userData: kind (the registry sets 'option:<id>'), radius, debrisColor, muzzles (local),
//     setFlash(v), update(dt, t), dispose(); optional setThrust(0..1)
//   * budget: ≤ 3 draw calls, ≤ 500 triangles
// Cache keys: 'ext:ships:<name>' — e.g. 'ext:ships:gale', 'ext:ships:gale.flame' — so
// nothing collides with the stage-1 keys ('player', 'player.flame', …).
//
// Extra (optional) userData on these models: trailColor [r, g, b] — an HDR colour for the
// game's engine-trail sprite that matches the aircraft's flame (the bolt's trail is orange).
// =============================================================================
import * as THREE from 'three';
import { GB, GG, G, M, S, DEG, lit, lin, rgb, GL, EM, bodyMat, additiveMat, flashFn, buildFlame, FLAME_JET, assemblePlayer, enemyShell } from './modelkit.js';
import { AIRCRAFT_BY_ID } from './defs.js';

// =============================================================================
// shared helpers
// =============================================================================
/** the CRIMSON BOLT's chined 10-point fuselage section: [z, halfWidth, top, bottom, chineY] */
function fusRing([z, w, tp, bt, ch]) {
  return [[0, tp, z], [w * 0.22, tp * 0.985, z], [w * 0.62, tp * 0.82, z], [w, ch, z], [w * 0.6, -bt * 0.9, z],
    [0, -bt, z], [-w * 0.6, -bt * 0.9, z], [-w, ch, z], [-w * 0.62, tp * 0.82, z], [-w * 0.22, tp * 0.985, z]];
}
/** spine height of a fuselage table at z (linear between stations) */
function topAt(tab, z) {
  for (let i = 0; i < tab.length - 1; i++) {
    const a = tab[i], b = tab[i + 1];
    if (z >= a[0] && z <= b[0]) { const t = (z - a[0]) / (b[0] - a[0]); return a[2] + (b[2] - a[2]) * t; }
  }
  return tab[tab.length - 1][2];
}
/** faceted bubble canopy (the bolt's) seated at baseY(z); rows [z, halfWidth, height]; style(i, j) */
function canopy(b, rows, baseY, style) {
  const ring = ([z, cw, ch]) => {
    const y0 = baseY(z) - 0.014;
    return [[-cw, y0, z], [-cw * 0.8, y0 + ch * 0.56, z], [-cw * 0.42, y0 + ch * 0.93, z], [0, y0 + ch, z],
      [cw * 0.42, y0 + ch * 0.93, z], [cw * 0.8, y0 + ch * 0.56, z], [cw, y0, z], [0, y0 - 0.03, z]];
  };
  b.loft(rows.map(ring), (i, j) => (j >= 6 ? null : style(i, j)));
}
/** drape quads for a livery stripe of half-width w along the polyline [[x, z], …] */
function stripe(pts, w, e = 0.012) {
  const quads = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz * w, nz = ux * w;
    const A = [ax - ux * e, az - uz * e], B = [bx + ux * e, bz + uz * e];
    quads.push([[A[0] + nx, A[1] + nz], [B[0] + nx, B[1] + nz], [B[0] - nx, B[1] - nz], [A[0] - nx, A[1] - nz]]);
  }
  return quads;
}
/** gameplay numbers the model mirrors (hitbox / graze radius) come from defs.js */
function acOf(id) { return AIRCRAFT_BY_ID[id] || AIRCRAFT_BY_ID.bolt; }

// =============================================================================
// GALE 疾風 — slim forward-swept interceptor, pearl white + cyan
// =============================================================================
const GA = {
  pearl: lit('#d6dee6'), pearlLt: lit('#dde4ea'), pearlDk: lit('#9ea9b6'),
  cyan: lit('#1aa2cc'), cyanLt: lit('#38bde2'), cyanDk: lit('#0c6788'),
  navy: lit('#1b2e43'), navyDk: lit('#101b28'),
  belly: lit('#55616e'), bellyDk: lit('#38414b'), steel: lit('#8f9aa7'), steelDk: lit('#4a525d'),
  gunDk: lit('#1d2228'), nozzle: lit('#363c45'), black: lit('#0b0d10'), intake: lit('#090a0d'),
  glass: S(lin('#163e66'), rgb(0.01, 0.07, 0.15)), glassLt: S(lin('#6aaee0'), rgb(0.03, 0.17, 0.3)),
  glow: GL(rgb(0.2, 0.85, 1.0, 3.0), 0.45),
};
const GALE_HOT = rgb(0.72, 0.94, 1.0, 4.2);   // nozzle core: blue-white afterburner
const FLAME_GALE = [
  { r: 0.056, len: 0.72, base: rgb(0.3, 0.78, 1.0, 1.7), tip: rgb(0.05, 0.2, 0.6, 0.0), sides: 7 },
  { r: 0.034, len: 0.42, base: rgb(0.85, 0.97, 1.0, 2.7), tip: rgb(0.3, 0.72, 1.0, 0.2), sides: 6 },
];
const GA_FUS = [ // z, halfWidth, top, bottom, chineY — long and slim
  [-0.96, 0.004, 0.004, 0.004, 0.0],
  [-0.86, 0.028, 0.024, 0.02, -0.003],
  [-0.73, 0.052, 0.046, 0.034, -0.006],
  [-0.56, 0.077, 0.07, 0.046, -0.008],
  [-0.38, 0.095, 0.086, 0.054, -0.01],
  [-0.2, 0.105, 0.094, 0.058, -0.01],
  [-0.17, 0.106, 0.094, 0.058, -0.01],
  [0.04, 0.111, 0.092, 0.06, -0.01],
  [0.26, 0.12, 0.088, 0.062, -0.008],
  [0.29, 0.121, 0.087, 0.062, -0.008],
  [0.47, 0.128, 0.082, 0.062, -0.006],
  [0.64, 0.126, 0.074, 0.06, -0.005],
];
const GA_SEG = ['radome', 'nose', 'nose', 'canopy', 'canopy', 'line', 'mid', 'mid', 'line', 'aft', 'aft'];
const GALE_NOZZLES = [[-0.068, 0, 0.8], [0.068, 0, 0.8]];
function buildGale() {
  const b = new GB();
  // ---- fuselage: navy anti-glare nose, cyan spine stripe
  b.loft(GA_FUS.map(fusRing), (i, j) => {
    const tag = GA_SEG[i];
    if (tag === 'radome') return GA.pearlDk;
    const spine = j === 0 || j === 9, sh = j === 1 || j === 8, up = j === 2 || j === 7, lo = j === 3 || j === 6;
    if (tag === 'line') return spine ? GA.cyanDk : (sh || up) ? GA.pearlDk : lo ? GA.steelDk : GA.bellyDk;
    if (spine) return tag === 'nose' || tag === 'canopy' ? GA.navy : GA.cyan;
    if (sh) return tag === 'nose' ? GA.navy : GA.pearl;
    if (up) return GA.pearlLt;
    if (lo) return GA.pearlDk;
    return GA.belly;
  }, null, GA.gunDk);
  // ---- needle nose: pitot probe carrying the fuselage point on
  b.lathe([0, 0, -0.9], [0, 0, -1], [[0, 0.016], [0.08, 0.013], [0.2, 0.007], [0.29, 0.0]], 6,
    (i) => (i === 1 ? GA.cyan : GA.steel), null, null, { phase: Math.PI / 6 });
  // ---- canopy: long, far forward (smoked glass, white bow frame)
  canopy(b, [[-0.72, 0.005, 0.003], [-0.63, 0.043, 0.032], [-0.53, 0.063, 0.054], [-0.41, 0.07, 0.064],
    [-0.38, 0.07, 0.064], [-0.28, 0.063, 0.054], [-0.17, 0.04, 0.03], [-0.08, 0.01, 0.006]], (z) => topAt(GA_FUS, z), (i, j) => {
    if (i === 3) return GA.pearl;
    if (i <= 1) return (j === 2 || j === 3) ? GA.glassLt : GA.glass;
    if (i === 4 && (j === 2 || j === 3)) return GA.glassLt;
    return GA.glass;
  });

  // ---- right side (mirrored): shoulder intake, forward-swept wing, canard, tails, nozzle
  const f0 = b.n;
  const IN = [[-0.17, 0.08, 0.165, -0.046, 0.046], [-0.145, 0.08, 0.165, -0.046, 0.046],
    [0.1, 0.08, 0.16, -0.045, 0.044], [0.36, 0.08, 0.128, -0.04, 0.028]];
  b.loft(IN.map(([z, xi, xo, yb, yt]) => [[xi, yb, z], [xo, yb, z], [xo, yt - 0.025, z], [xo - 0.028, yt, z], [xi, yt, z]]), (i, j) => {
    if (j === 4) return null;
    if (i === 0) return j === 0 ? GA.steelDk : GA.cyanLt;   // cyan inlet lip
    if (j === 0) return GA.belly;
    if (j === 1) return GA.pearlDk;
    if (j === 2) return GA.pearl;
    return GA.pearlLt;
  }, GA.intake, null);
  // main wing: forward swept (leading edge 27°, trailing edge 44°), narrow tip
  const w0 = b.n;
  b.wing([
    { x: 0.1, y: -0.014, zl: 0.08, zt: 0.6, t: 0.05 },
    { x: 0.28, y: -0.008, zl: -0.013, zt: 0.426, t: 0.04 },
    { x: 0.5, y: 0.0, zl: -0.126, zt: 0.213, t: 0.028 },
    { x: 0.72, y: 0.008, zl: -0.24, zt: 0.0, t: 0.018 },
  ], (i, j) => {
    if (j >= 4) return GA.belly;
    if (j === 0) return i === 0 ? GA.steel : GA.cyanLt;           // cyan leading edge
    if (j === 3) return i === 1 ? GA.cyanDk : GA.pearlDk;        // flaperons
    if (i === 2) return GA.cyan;                                  // cyan outer panel
    return j === 1 ? GA.pearlLt : GA.pearl;
  }, null, GA.cyanDk);
  const w1 = b.n;
  // livery: navy pinstripe between the white inner wing and the cyan outer panel, and a cyan
  // band echoing the leading edge across the white inner wing
  b.drape(stripe([[0.48, -0.12], [0.5, 0.2]], 0.012), GA.navy, w0, w1, 0.0035, 3);
  b.drape(stripe([[0.14, 0.15], [0.45, -0.01]], 0.016), GA.cyan, w0, w1, 0.0035, 3);
  // wingtip rail with a glowing cyan tip light (the forward-swept tips read as two cyan points)
  b.lathe([0.725, 0.008, -0.28], [0, 0, 1], [[0, 0.0], [0.03, 0.015], [0.06, 0.017], [0.3, 0.017], [0.34, 0.01]], 6,
    (i) => (i <= 1 ? GA.glow : i === 2 ? GA.pearl : GA.steelDk), null, GA.steelDk, { phase: Math.PI / 6 });
  // canard (cyan)
  b.wing([{ x: 0.085, y: 0.03, zl: -0.56, zt: -0.39, t: 0.02 }, { x: 0.27, y: 0.036, zl: -0.47, zt: -0.4, t: 0.01 }],
    (i, j) => (j >= 4 ? GA.belly : j === 0 ? GA.pearl : GA.cyan), null, GA.cyanDk);
  // small swept stabiliser
  b.wing([{ x: 0.12, y: -0.006, zl: 0.58, zt: 0.84, t: 0.022 }, { x: 0.31, y: -0.002, zl: 0.7, zt: 0.86, t: 0.013 }],
    (i, j) => (j >= 4 ? GA.belly : j === 0 ? GA.cyanLt : j === 3 ? GA.pearlDk : GA.pearl), null, GA.cyan);
  // canted twin tail with a cyan cap
  const f2 = b.n;
  b.wing([{ x: 0, zl: 0.34, zt: 0.76, t: 0.03 }, { x: 0.2, zl: 0.53, zt: 0.8, t: 0.02 }, { x: 0.28, zl: 0.61, zt: 0.81, t: 0.014 }],
    (i, j) => (i === 1 ? GA.cyan : j === 0 ? GA.pearlLt : j >= 3 ? GA.pearlDk : GA.pearl), null, GA.cyan);
  b.xform(f2, M(0.085, 0.07, 0, 0, 0, 72 * DEG));
  // small nozzle with a blue-white core
  b.lathe([0.068, 0.0, 0.56], [0, 0, 1], [[0, 0.066], [0.12, 0.068], [0.15, 0.064], [0.27, 0.055], [0.27, 0.036]], 8,
    (i) => (i === 0 ? GA.gunDk : i === 1 ? GA.steel : i === 2 ? GA.nozzle : GA.gunDk), null, GL(GALE_HOT, 0.7), { phase: Math.PI / 8 });
  b.mirrorX(f0);
  return b;
}
function createGale() {
  const ac = acOf('gale');
  const g = assemblePlayer({
    name: 'player', body: GG('ext:ships:gale', buildGale), rough: 0.46, metal: 0.16,
    flame: G('ext:ships:gale.flame', () => buildFlame(GALE_NOZZLES, FLAME_GALE)), flameZ: 0.83,
    radius: ac.hitR, grazeRadius: ac.grazeR, debris: '#2cb4dc',
    muzzles: [[0, 0, -1.08], [-0.2, 0, -0.3], [0.2, 0, -0.3]], muzzleZ: -1.05,
    trail: [[-0.068, 0.88], [0.068, 0.88]],
    bankDeg: 40,                      // the light interceptor rolls a little further
  });
  g.userData.trailColor = [0.7, 1.7, 2.8];
  return g;
}

// =============================================================================
// TITAN 重鎚 — broad heavy attack jet, gunmetal + amber
// =============================================================================
const TI = {
  gun: lit('#555e69'), gunLt: lit('#727c88'), gunDk: lit('#353c45'), gunXDk: lit('#1f2429'),
  belly: lit('#3b424b'), bellyDk: lit('#2a2f36'), steel: lit('#8f99a5'),
  amber: lit('#d08a1c'), amberLt: lit('#e0a53c'), amberDk: lit('#8c570e'),
  ord: lit('#59614c'), ordDk: lit('#3b4133'),
  black: lit('#0c0d10'), intake: lit('#08090b'), nozzle: lit('#353a42'),
  glass: S(lin('#5c3d0c'), rgb(0.1, 0.05, 0.0)), glassLt: S(lin('#d9a54c'), rgb(0.22, 0.12, 0.02)),
};
const TI_FUS = [ // z, halfWidth, top, bottom, chineY — blunt, wide centre tub between the engines
  [-0.99, 0.036, 0.028, 0.03, 0.0],
  [-0.92, 0.072, 0.056, 0.05, -0.004],
  [-0.8, 0.106, 0.084, 0.068, -0.008],
  [-0.62, 0.136, 0.108, 0.08, -0.012],
  [-0.44, 0.152, 0.124, 0.088, -0.012],
  [-0.26, 0.16, 0.13, 0.092, -0.012],
  [-0.23, 0.16, 0.13, 0.092, -0.012],
  [0.0, 0.16, 0.126, 0.094, -0.01],
  [0.24, 0.155, 0.12, 0.094, -0.01],
  [0.27, 0.154, 0.119, 0.094, -0.01],
  [0.48, 0.138, 0.108, 0.09, -0.008],
  [0.72, 0.1, 0.088, 0.08, -0.006],
  [0.86, 0.05, 0.06, 0.05, -0.004],
];
const TI_SEG = ['radome', 'nose', 'nose', 'canopy', 'canopy', 'line', 'mid', 'mid', 'line', 'aft', 'aft', 'aft'];
const TI_NAC = [ // z, halfWidth, halfHeight, roundness — boxy intake flowing into a round engine
  [-0.46, 0.104, 0.074, 0],
  [-0.42, 0.11, 0.08, 0],
  [-0.2, 0.118, 0.092, 0.25],
  [0.12, 0.122, 0.106, 0.6],
  [0.42, 0.122, 0.116, 0.9],
  [0.62, 0.12, 0.12, 1],
];
const TI_NX = 0.25, TI_NY = -0.01;
const TITAN_NOZZLES = [[-TI_NX, TI_NY, 1.45], [TI_NX, TI_NY, 1.45]];
function nacRing([z, hw, hh, r]) {
  const out = [];
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
    const bx = Math.sign(c) * (Math.abs(c) > 0.5 ? 1 : 0.55), by = Math.sign(s) * (Math.abs(s) > 0.5 ? 1 : 0.55);
    out.push([TI_NX + (c + (bx - c) * (1 - r)) * hw, TI_NY + (s + (by - s) * (1 - r)) * hh, z]);
  }
  return out;
}
function buildTitan() {
  const b = new GB();
  // ---- centre fuselage: dark blunt radome, gold spine stripe
  b.loft(TI_FUS.map(fusRing), (i, j) => {
    const tag = TI_SEG[i];
    const spine = j === 0 || j === 9, sh = j === 1 || j === 8, up = j === 2 || j === 7, lo = j === 3 || j === 6;
    if (tag === 'radome') return spine || sh ? TI.gunDk : TI.gunXDk;
    if (tag === 'line') return spine ? TI.amberDk : (sh || up || lo) ? TI.gunDk : TI.bellyDk;
    if (spine) return tag === 'nose' || tag === 'canopy' ? TI.gunDk : TI.amber;
    if (sh) return TI.gun;
    if (up) return TI.gunLt;
    if (lo) return TI.gunDk;
    return TI.belly;
  }, TI.gunXDk, TI.gunXDk);
  // ---- rotary cannon under the chin
  b.lathe([0, -0.03, -0.9], [0, 0, -1], [[0, 0.034], [0.1, 0.03], [0.1, 0.02], [0.2, 0.02]], 6,
    (i) => (i === 0 ? TI.gunDk : TI.gunXDk), null, TI.black, { phase: Math.PI / 6 });
  // ---- two-seat canopy with a gold visor tint and two frames
  canopy(b, [[-0.8, 0.006, 0.003], [-0.71, 0.056, 0.04], [-0.61, 0.08, 0.066], [-0.51, 0.088, 0.076], [-0.48, 0.088, 0.076],
    [-0.38, 0.086, 0.074], [-0.35, 0.086, 0.074], [-0.25, 0.07, 0.056], [-0.16, 0.04, 0.03], [-0.09, 0.01, 0.006]],
  (z) => topAt(TI_FUS, z), (i, j) => {
    if (i === 3 || i === 5) return TI.gunLt;                   // bow frame + frame between the seats
    if (i <= 1) return (j === 2 || j === 3) ? TI.glassLt : TI.glass;
    if ((i === 4 || i === 6) && (j === 2 || j === 3)) return TI.glassLt;
    return TI.glass;
  });

  // ---- right side (mirrored)
  const f0 = b.n;
  // engine nacelle: amber intake lip, box → round
  // (ring edges: 0 upper-outer chamfer, 1 top, 2 upper-inner, 3 inner, 4–6 underside, 7 outer side)
  b.loft(TI_NAC.map(nacRing), (i, j) => {
    if (i === 0) return TI.amber;
    if (j >= 4 && j <= 6) return i === 3 ? TI.bellyDk : TI.belly;
    if (j === 1) return i === 2 ? TI.amber : TI.gunLt;                   // amber band across the engine
    if (j === 0 || j === 2 || j === 7) return TI.gun;
    return TI.gunDk;
  }, TI.intake, null);
  // big nozzle with a hot core
  b.lathe([TI_NX, TI_NY, 0.6], [0, 0, 1], [[0, 0.12], [0.08, 0.124], [0.11, 0.118], [0.28, 0.104], [0.28, 0.07]], 8,
    (i) => (i === 0 ? TI.gunXDk : i === 1 ? TI.steel : i === 2 ? TI.nozzle : TI.gunXDk), null, GL(EM.engineHot, 0.7), { phase: Math.PI / 8 });
  // chunky trapezoid wing (amber outer panel)
  const w0 = b.n;
  b.wing([
    { x: 0.3, y: -0.02, zl: -0.2, zt: 0.52, t: 0.075 },
    { x: 0.46, y: -0.016, zl: -0.112, zt: 0.499, t: 0.064 },
    { x: 0.7, y: -0.01, zl: 0.019, zt: 0.468, t: 0.05 },
    { x: 0.92, y: -0.004, zl: 0.14, zt: 0.44, t: 0.04 },
  ], (i, j) => {
    if (j >= 4) return TI.belly;
    if (j === 0) return i === 2 ? TI.amberLt : TI.gunLt;
    if (j === 3) return i === 2 ? TI.amberDk : TI.gunDk;
    if (i === 2) return TI.amber;
    return j === 1 ? TI.gunLt : TI.gun;
  }, null, TI.amberDk);
  const w1 = b.n;
  // livery: dark walkway band where the amber panel starts
  b.drape(stripe([[0.69, 0.0], [0.69, 0.47]], 0.014), TI.gunXDk, w0, w1, 0.004, 3);
  // wingtip ECM pod
  b.lathe([0.935, -0.004, 0.5], [0, 0, -1], [[0, 0.016], [0.03, 0.03], [0.44, 0.03], [0.52, 0.018], [0.58, 0.0]], 6,
    (i) => (i === 2 ? TI.gunLt : i === 3 ? TI.amber : TI.gunDk), TI.gunXDk, null, { phase: Math.PI / 6 });
  // hardpoints: pylons with a slick bomb (inner) and a rocket pod (outer), noses ahead of the wing
  b.block({ x: 0.52, y: -0.075, z: 0.12, w: 0.022, d: 0.3, h: 0.04, side: TI.gunDk, top: TI.gunDk });
  b.block({ x: 0.76, y: -0.066, z: 0.2, w: 0.022, d: 0.26, h: 0.04, side: TI.gunDk, top: TI.gunDk });
  b.lathe([0.52, -0.105, 0.33], [0, 0, -1], [[0, 0.018], [0.05, 0.046], [0.34, 0.052], [0.46, 0.034], [0.54, 0.0]], 6,
    (i) => (i === 2 ? TI.amber : i === 0 ? TI.ordDk : TI.ord), TI.ordDk, null, { phase: Math.PI / 6 });
  b.block({ x: 0.52, y: -0.108, z: 0.3, w: 0.14, d: 0.06, h: 0.008, side: TI.ordDk, top: TI.ord });   // tail fin
  b.lathe([0.76, -0.092, 0.34], [0, 0, -1], [[0, 0.04], [0.03, 0.046], [0.36, 0.046], [0.4, 0.04]], 6,
    (i) => (i === 1 ? TI.gun : i === 2 ? TI.amberDk : TI.gunDk), TI.gunDk, TI.black, { phase: Math.PI / 6 });
  // canted twin tail on the nacelle (amber cap)
  const f2 = b.n;
  b.wing([{ x: 0, zl: 0.26, zt: 0.8, t: 0.042 }, { x: 0.27, zl: 0.5, zt: 0.84, t: 0.028 }, { x: 0.36, zl: 0.58, zt: 0.85, t: 0.02 }],
    (i, j) => (i === 1 ? TI.amber : j === 0 ? TI.gunLt : j >= 3 ? TI.gunDk : TI.gun), null, TI.amber);
  b.xform(f2, M(TI_NX, 0.1, 0, 0, 0, 76 * DEG));
  // big stabiliser
  b.wing([{ x: 0.34, y: -0.012, zl: 0.52, zt: 0.9, t: 0.03 }, { x: 0.58, y: -0.008, zl: 0.62, zt: 0.9, t: 0.022 }, { x: 0.66, y: -0.006, zl: 0.7, zt: 0.9, t: 0.016 }],
    (i, j) => (j >= 4 ? TI.belly : j === 0 ? TI.gunLt : i === 1 ? TI.amber : j === 3 ? TI.gunDk : TI.gun), null, TI.amberDk);
  b.mirrorX(f0);
  return b;
}
function createTitan() {
  const ac = acOf('titan');
  const g = assemblePlayer({
    name: 'player', body: GG('ext:ships:titan', buildTitan), rough: 0.58, metal: 0.3,
    flame: G('ext:ships:titan.flame', () => buildFlame(TITAN_NOZZLES, FLAME_JET)), flameZ: 0.88,
    radius: ac.hitR, grazeRadius: ac.grazeR, debris: '#c8943a',
    muzzles: [[0, -0.03, -1.1], [-0.52, -0.1, -0.22], [0.52, -0.1, -0.22]], muzzleZ: -1.06,
    trail: [[-TI_NX, 0.93], [TI_NX, 0.93]],
    bankDeg: 30,                      // the heavy jet rolls less
  });
  g.userData.trailColor = [2.6, 1.2, 0.32];
  return g;
}

// =============================================================================
// PHANTOM 幻影 — stealth cranked-kite flying wing, black-violet with glowing edges
// =============================================================================
const PH = {
  skin: lit('#382a50'), skinLt: lit('#4d3d72'), skinMd: lit('#42335f'), skinDk: lit('#281e3a'),
  belly: lit('#1b1524'), bellyDk: lit('#120e18'), trim: lit('#6a5a94'),
  glass: S(lin('#2b1a4a'), rgb(0.05, 0.01, 0.12)), glassLt: S(lin('#8a6cd0'), rgb(0.12, 0.06, 0.3)),
  edge: GL(rgb(0.6, 0.28, 1.0, 2.15), 0.45), edgeHot: GL(rgb(0.8, 0.52, 1.0, 1.9), 0.5),
  intake: lit('#07060a'),
};
/** flat exhaust sheets for the slit nozzle: [halfWidth at the slit, halfWidth at the tip, halfHeight, length, base, tip] */
const FLAME_BLADE = [
  [0.15, 0.05, 0.02, 0.56, rgb(0.6, 0.24, 1.0, 0.85), rgb(0.25, 0.0, 0.6, 0.0)],
  [0.1, 0.02, 0.01, 0.3, rgb(0.9, 0.68, 1.0, 1.3), rgb(0.6, 0.25, 1.0, 0.1)],
];
/** additive flame geometry for a flat slit exhaust (buildFlame makes round cones): tapered sheets along +z */
function buildBladeFlame(layers, y = 0) {
  const pos = [], col = [];
  for (const [w0, w1, h, len, cb, ct] of layers) {
    const A = [[-w0, y - h, 0], [w0, y - h, 0], [w0, y + h, 0], [-w0, y + h, 0]];
    const B = [[-w1, y - h * 0.3, len], [w1, y - h * 0.3, len], [w1, y + h * 0.3, len], [-w1, y + h * 0.3, len]];
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      pos.push(...A[k], ...A[k1], ...B[k1], ...A[k], ...B[k1], ...B[k]);
      col.push(...cb, ...cb, ...ct, ...cb, ...ct, ...ct);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
const PH_Z_EXH = 0.5, PH_Y_EXH = -0.012;    // flat slit exhaust exit
/** planform sections (right half; x = 0 is the centre line): x, y, leading-edge z, trailing-edge z, thickness */
const PH_SECS = [
  [0.0, -0.045, -0.95, 0.56, 0.155],
  [0.07, -0.041, -0.812, 0.56, 0.14],
  [0.14, -0.034, -0.675, 0.56, 0.108],
  [0.24, -0.022, -0.478, 0.45, 0.07],
  [0.32, -0.014, -0.341, 0.361, 0.05],
  [0.52, -0.004, -0.148, 0.14, 0.03],
  [0.7, 0.004, 0.026, 0.25, 0.02],
  [0.88, 0.01, 0.2, 0.36, 0.014],
];
/** 9-point faceted section (flat-topped ridge, F-117 style): LE · LE glow bevel · front-top · ridge front ·
 *  ridge back · rear-top · TE glow bevel · TE · belly. Edges 0 and 6 are the glowing bands. */
function kiteSec([x, y, zl, zt, t]) {
  const c = zt - zl;
  const along = (a, b, d) => { const k = d / Math.abs(b[2] - a[2]); return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; };
  const LE = [x, y, zl], FT = [x, y + t * 0.62, zl + 0.22 * c], R1 = [x, y + t, zl + 0.4 * c], R2 = [x, y + t * 0.96, zl + 0.6 * c];
  const RT = [x, y + t * 0.5, zl + 0.82 * c], TE = [x, y, zt];
  return [LE, along(LE, FT, Math.min(0.036, 0.14 * c)), FT, R1, R2, RT, along(TE, RT, Math.min(0.03, 0.12 * c)), TE, [x, y - t * 0.45, zl + 0.45 * c]];
}
function buildPhantom() {
  const b = new GB();
  // ---- the wing (right half, mirrored at the end): glowing leading / trailing edge bands + tip
  b.loft(PH_SECS.map(kiteSec), (i, j) => {
    if (j === 0 || j === 6) return PH.edge;
    if (j >= 7) return i & 1 ? PH.belly : PH.bellyDk;
    if (j === 1 || j === 5) return PH.skinDk;
    if (j === 2) return i & 1 ? PH.skin : PH.skinMd;               // front slope
    if (j === 3) return i & 1 ? PH.skinMd : PH.skinLt;             // flat ridge
    return i & 1 ? PH.skinDk : PH.skin;                            // aft slope
  }, null, PH.edge);
  const k1 = b.n;
  const surf = (x, z) => { const y = b.surfaceY(x, z, 0, k1); return y === null ? 0 : y; };
  // panel lines echoing the leading edge and the sawtooth trailing edge (light violet trim)
  b.drape([...stripe([[0.07, -0.72], [0.3, -0.25], [0.78, 0.2]], 0.009), ...stripe([[0.21, 0.4], [0.52, 0.06], [0.79, 0.225]], 0.009)],
    PH.trim, 0, k1, 0.004, 3);
  // ---- dorsal intake (right; B-2 style scoop with a glowing lip)
  const scoop = (z, xi, xo, h) => { const yi = surf(xi, z), yo = surf(xo, z); return [[xi, yi - 0.012, z], [xo, yo - 0.012, z], [xo, yo + h * 0.7, z], [xo - 0.02, yo + h, z], [xi, yi + h, z]]; };
  b.loft([scoop(-0.27, 0.09, 0.22, 0.036), scoop(-0.25, 0.09, 0.22, 0.036), scoop(-0.05, 0.09, 0.21, 0.026), scoop(0.1, 0.1, 0.17, 0.0)], (i, j) => {
    if (j === 0) return null;
    if (i === 0) return PH.edge;
    return j === 1 ? PH.skinMd : j === 2 ? PH.skinLt : j === 4 ? PH.skinDk : PH.skin;
  }, PH.intake, null);
  // ---- flat slit exhaust housing on the rear deck (right half); its back face is the glowing slit
  const deck = (z, hw, h) => { const y = surf(0.001, z); return [[0, y - 0.01, z], [hw, surf(hw, z) - 0.01, z], [hw, surf(hw, z) + h * 0.6, z], [hw * 0.7, y + h, z], [0, y + h * 1.04, z]]; };
  b.loft([deck(0.1, 0.1, 0.0), deck(0.2, 0.15, 0.03), deck(0.4, 0.165, 0.034), deck(PH_Z_EXH, 0.17, 0.03)], (i, j) => {
    if (j === 0 || j === 4) return null;
    return j === 1 ? PH.skinDk : j === 2 ? (i === 2 ? PH.trim : PH.skinMd) : PH.skin;
  }, null, PH.edgeHot);
  b.mirrorX(0);
  // ---- blended cockpit canopy on the centre ridge (built whole, after the mirror)
  canopy(b, [[-0.68, 0.006, 0.003], [-0.61, 0.04, 0.026], [-0.53, 0.058, 0.038], [-0.43, 0.064, 0.042],
    [-0.35, 0.056, 0.034], [-0.28, 0.03, 0.016], [-0.23, 0.006, 0.003]], (z) => surf(0.001, z) + 0.004, (i, j) => {
    if (i <= 1) return (j === 2 || j === 3) ? PH.glassLt : PH.glass;
    if (i === 3 && (j === 2 || j === 3)) return PH.glassLt;
    return PH.glass;
  });
  return b;
}
function createPhantom() {
  const ac = acOf('phantom');
  const g = assemblePlayer({
    name: 'player', body: GG('ext:ships:phantom', buildPhantom), rough: 0.4, metal: 0.34,
    flame: G('ext:ships:phantom.flame', () => buildBladeFlame(FLAME_BLADE, PH_Y_EXH)), flameZ: PH_Z_EXH,
    radius: ac.hitR, grazeRadius: ac.grazeR, debris: '#9466f0',
    muzzles: [[0, 0, -0.98], [-0.3, 0, -0.3], [0.3, 0, -0.3]], muzzleZ: -0.98,
    trail: [[-0.1, 0.56], [0, 0.56], [0.1, 0.56]],
    bankDeg: 35,
  });
  g.userData.trailColor = [1.5, 0.6, 2.8];
  // slow "breathing" of the violet edges on top of the standard engine flicker
  const ud = g.userData, mat = g.getObjectByName('body').material, base = ud.update;
  ud.update = (dt, t) => { base(dt, t); mat.uEmitScale.value *= 0.88 + Math.sin(t * 2.4) * 0.12; };
  return g;
}

// =============================================================================
// PHANTOM option drone — glowing violet core orb in an armoured collar with four
// pinwheel fins. The orb is symmetric about y, so the whole body can spin (the fins
// sweep round like a shuriken) while the flame mesh stays pointed aft.
// =============================================================================
const DR = {
  collar: lit('#3e2f5c'), collarLt: lit('#54427e'), collarDk: lit('#211a31'),
  fin: lit('#35294e'), finLt: lit('#4c3c6e'), finDk: lit('#1d1629'),
  tip: GL(rgb(0.62, 0.28, 1.0, 2.1), 0.42),
};
const DR_CORE_K = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6];   // emission per latitude band, bottom → top
const FLAME_DRONE = [
  { r: 0.045, len: 0.3, base: rgb(0.62, 0.3, 1.0, 1.4), tip: rgb(0.3, 0.0, 0.7, 0.0), sides: 6 },
  { r: 0.026, len: 0.16, base: rgb(1.0, 0.75, 1.0, 2.2), tip: rgb(0.7, 0.3, 1.0, 0.1), sides: 5 },
];
function buildDrone() {
  const b = new GB();
  // faceted energy core: brighter toward the top so the sphere keeps its shape under bloom
  const core = [];
  for (let i = 0; i < DR_CORE_K.length; i++) {
    core.push([0, 1].map((f) => { const k = DR_CORE_K[i] * (f ? 0.84 : 1); return i >= 4 ? GL(rgb(0.66, 0.36, 1.0, k), 0.42) : GL(rgb(0.55, 0.22, 1.0, k), 0.4); }));
  }
  b.lathe([0, -0.125, 0], [0, 1, 0], [[0, 0], [0.03, 0.07], [0.08, 0.115], [0.125, 0.128], [0.17, 0.115], [0.22, 0.07], [0.25, 0]], 8,
    (i, j) => core[i][j & 1], null, null, { phase: Math.PI / 8 });
  // armoured collar round the equator: chamfer · wall · chamfer
  b.lathe([0, 0, 0], [0, 1, 0], [[-0.04, 0.116], [-0.022, 0.17], [0.022, 0.17], [0.04, 0.116]], 8,
    (i, j) => (i === 0 ? DR.collarDk : i === 1 ? (j & 1 ? DR.collar : DR.collarDk) : (j & 1 ? DR.collarLt : DR.collar)), null, null, { phase: Math.PI / 8 });
  // four pinwheel fins (tips trail the spin), glowing tip caps
  const f0 = b.n;
  b.wing([{ x: 0.15, zl: -0.045, zt: 0.075, t: 0.024 }, { x: 0.3, zl: 0.05, zt: 0.12, t: 0.011 }],
    (i, j) => (j >= 4 ? DR.finDk : j === 0 ? DR.finLt : j === 3 ? DR.finDk : DR.fin), null, DR.tip);
  const f1 = b.n;
  b.xform(f0, M(0, 0, 0, 0, Math.PI / 4, 0));
  for (let k = 1; k < 4; k++) b.dup(f0, f1, M(0, 0, 0, 0, (k * Math.PI) / 2, 0));
  return b;
}
function createPhantomDrone() {
  const { g, pivot, ud } = enemyShell('option', 0.3, '#9466f0');
  g.name = 'option';
  const mat = bodyMat(0.42, 0.3);
  const body = new THREE.Mesh(GG('ext:ships:phantom.drone', buildDrone), mat); body.name = 'body';
  pivot.add(body);
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:ships:phantom.drone.flame', () => buildFlame([[0, 0, 1]], FLAME_DRONE)), flameMat); flame.name = 'flame';
  flame.position.set(0, 0, 0.11); flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, 0, -0.16)];
  ud.muzzleZ = -0.16;
  ud.trail = [[0, 0.22]];
  ud.trailColor = [1.5, 0.6, 2.8];
  let thrust = 0.5;
  ud.setThrust = (t) => { thrust = Math.max(0, Math.min(1, t)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    body.rotation.y = t * 2.4;                                                  // the pinwheel fins spin
    const fl = 1 + Math.sin(t * 51) * 0.08 + Math.sin(t * 31.3) * 0.05;
    flame.scale.set(1, 1, (0.5 + thrust * 0.9) * fl);
    flameMat.color.setScalar(0.8 + thrust * 0.3);
    mat.uEmitScale.value = 0.85 + Math.sin(t * 5.5) * 0.18;
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  ud.update(0, 0);
  return g;
}

export const PLAYERS = { gale: createGale, titan: createTitan, phantom: createPhantom };
export const OPTIONS = { phantom: createPhantomDrone };
