// =============================================================================
// CRIMSON BOLT (赤電) — extension models: hangar aircraft + option drones
// -----------------------------------------------------------------------------
// models.js registers these tables: createPlayer(id, paint) uses PLAYERS[id],
// createOption(id, paint) uses OPTIONS[id]. Each entry is a factory
// (paint = 'std') => THREE.Group that returns a NEW instance per call (pools
// build several); the registry only passes paints listed in PLAYER_PAINTS[id].
//
//   export const PLAYERS = { gale, titan, phantom };   // keys = AIRCRAFT ids in defs.js ('bolt' lives in models.js)
//   export const OPTIONS = { phantom };                 // the option drone of that aircraft
//   export const PLAYER_PAINTS = { gale: { dusk: { accent }, … }, … };   // paints besides 'std'
//
// Paints (hangar liveries, see modelkit "Paint schemes") are recolours of the std body
// geometry, so they keep the budget, silhouette and shadow; 'std' never goes through them:
//   GALE     黃昏 dusk (orange → violet gradient) · 幽靈 ghost (low-vis greys) · 黃金 gold
//   TITAN    叢林 jungle (olive camouflage) · 鋼灰 steel (dark steel, red stripes) · 黃金 gold
//   PHANTOM  血月 blood (black, blood-red edges) · 極光 aurora (white, teal/green glow drifting) · 黃金 gold
//   the drone follows the PHANTOM paint
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
import {
  GB, GG, G, M, S, DEG, lit, lin, rgb, GL, EM, mix3, bodyMat, additiveMat, flashFn, buildFlame, FLAME_JET, assemblePlayer, enemyShell,
  paintedBody, GOLD, FLAME_GOLD, flameTint, flameRecolour, retint, noise2, lum,
} from './modelkit.js';
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
function createGale(paint = 'std') {
  const ac = acOf('gale'), pt = paintOf(GALE_PAINTS, paint);
  const g = assemblePlayer({
    name: 'player', body: pt ? paintedBody('ext:ships:gale', buildGale, GALE_PAL, paint, pt) : GG('ext:ships:gale', buildGale),
    rough: pt ? pt.rough : 0.46, metal: pt ? pt.metal : 0.16,
    flame: pt && pt.flame ? G('ext:ships:gale.flame.' + paint, () => buildFlame(GALE_NOZZLES, pt.flame)) : G('ext:ships:gale.flame', () => buildFlame(GALE_NOZZLES, FLAME_GALE)),
    flameZ: 0.83,
    radius: ac.hitR, grazeRadius: ac.grazeR, debris: pt ? pt.debris : '#2cb4dc',
    muzzles: [[0, 0, -1.08], [-0.2, 0, -0.3], [0.2, 0, -0.3]], muzzleZ: -1.05,
    trail: [[-0.068, 0.88], [0.068, 0.88]],
    bankDeg: 40,                      // the light interceptor rolls a little further
  });
  g.userData.trailColor = pt && pt.trail ? pt.trail : [0.7, 1.7, 2.8];
  return g;
}
// ---- GALE paints (recolours of 'ext:ships:gale'; roles = GA + the nozzle core)
const GALE_PAL = { ...GA, hot: GL(GALE_HOT, 0.7) };
const DUSK_A = lin('#ec7a26'), DUSK_B = lin('#5c2e8e'), duskStyles = new Map();
/** 黃昏 gradient at centroid c (nose → tail, centre → tips), 9 steps, shade k */
function dusk(c, k) {
  const u = Math.round(Math.max(0, Math.min(1, (c[2] + 0.45) / 1.15 + Math.abs(c[0]) * 0.5)) * 8) / 8, key = u * 10 + k;
  let s = duskStyles.get(key);
  if (!s) { const m = mix3(DUSK_A, DUSK_B, u); s = S([m[0] * k, m[1] * k, m[2] * k]); duskStyles.set(key, s); }
  return s;
}
const GALE_PAINTS = {
  // 黃昏 DUSK — the white skin fades from sunset orange at the nose to dusk violet at the tail and wingtips;
  // sunset orange where the gale is cyan, golden leading edges, amber tip lights, rose canopy
  dusk: {
    rough: 0.48, metal: 0.16, debris: '#f08a3a', accent: '#ff8a3d',
    map: {
      pearl: (st, c) => dusk(c, 1), pearlLt: (st, c) => dusk(c, 1.14), pearlDk: (st, c) => dusk(c, 0.62),
      cyan: lit('#e2601c'), cyanLt: lit('#f8b03e'), cyanDk: lit('#9c2c1c'),
      navy: lit('#26113a'), navyDk: lit('#180a26'), belly: lit('#3a2250'), bellyDk: lit('#281739'),
      steel: lit('#b07a8a'), steelDk: lit('#4a2e4c'),
      glass: S(lin('#4a1634'), rgb(0.12, 0.02, 0.07)), glassLt: S(lin('#e48a72'), rgb(0.3, 0.1, 0.07)),
      glow: GL(rgb(1.0, 0.6, 0.2, 3.0), 0.45), hot: GL(rgb(1.0, 0.8, 0.6, 4.2), 0.7),
    },
    flame: flameRecolour(FLAME_GALE, [
      { base: rgb(1.0, 0.42, 0.3, 1.7), tip: rgb(0.55, 0.05, 0.35, 0.0) },
      { base: rgb(1.0, 0.85, 0.66, 2.7), tip: rgb(1.0, 0.42, 0.3, 0.2) }]),
    trail: [2.8, 0.95, 0.8],
  },
  // 幽靈 GHOST — low-visibility two-tone greys (light top, darker grey where the gale is cyan), dim markings
  ghost: {
    rough: 0.8, metal: 0.1, debris: '#9aa2ab', accent: '#aab3bc',
    map: {
      pearl: lit('#a2a9b0'), pearlLt: lit('#adb3b9'), pearlDk: lit('#7b838c'),
      cyan: lit('#5f666f'), cyanLt: lit('#737a83'), cyanDk: lit('#4a5058'),
      navy: lit('#3d434a'), navyDk: lit('#2c3136'), belly: lit('#5a6068'), bellyDk: lit('#434850'),
      glass: S(lin('#20262d'), rgb(0.01, 0.02, 0.03)), glassLt: S(lin('#7c8792'), rgb(0.03, 0.05, 0.07)),
      glow: GL(rgb(0.85, 0.93, 1.0, 1.7), 0.4),
    },
    flame: flameTint(FLAME_GALE, ([r, g, b]) => { const m = (r + g + b) / 3; return [(r + m) * 0.42, (g + m) * 0.42, (b + m) * 0.45]; }),
    trail: [1.1, 1.35, 1.7],
  },
  // 黃金 GOLD
  gold: {
    rough: GOLD.rough, metal: GOLD.metal, debris: GOLD.debris, accent: '#f0c75a',
    map: { glass: GOLD.glass, glassLt: GOLD.glassLt, hot: GOLD.hot, '*': GOLD.face },
    flame: flameRecolour(FLAME_GALE, FLAME_GOLD), trail: GOLD.trail,
  },
};

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
function createTitan(paint = 'std') {
  const ac = acOf('titan'), pt = paintOf(TITAN_PAINTS, paint);
  const g = assemblePlayer({
    name: 'player', body: pt ? paintedBody('ext:ships:titan', buildTitan, TITAN_PAL, paint, pt) : GG('ext:ships:titan', buildTitan),
    rough: pt ? pt.rough : 0.58, metal: pt ? pt.metal : 0.3,
    flame: pt && pt.flame ? G('ext:ships:titan.flame.' + paint, () => buildFlame(TITAN_NOZZLES, pt.flame)) : G('ext:ships:titan.flame', () => buildFlame(TITAN_NOZZLES, FLAME_JET)),
    flameZ: 0.88,
    radius: ac.hitR, grazeRadius: ac.grazeR, debris: pt ? pt.debris : '#c8943a',
    muzzles: [[0, -0.03, -1.1], [-0.52, -0.1, -0.22], [0.52, -0.1, -0.22]], muzzleZ: -1.06,
    trail: [[-TI_NX, 0.93], [TI_NX, 0.93]],
    bankDeg: 30,                      // the heavy jet rolls less
  });
  g.userData.trailColor = pt && pt.trail ? pt.trail : [2.6, 1.2, 0.32];
  return g;
}
// ---- TITAN paints (recolours of 'ext:ships:titan'; roles = TI + the nozzle cores)
const TITAN_PAL = { ...TI, hot: GL(EM.engineHot, 0.7) };
/** 叢林 camouflage: olive / forest green / earth brown blotches from 2D noise over the planform (asymmetric,
 *  like a real scheme); the face's role picks the shade so the panel shading survives */
const CAMO = [['#627038', '#737f45', '#4b562b', '#30371c'], ['#2f3c24', '#3a492d', '#26311d', '#192014'],
  ['#5c432b', '#6d5235', '#473320', '#2e2115']].map((t) => t.map((h) => lit(h)));
const CAMO_SHADE = { gunLt: 1, gun: 0, gunDk: 2, gunXDk: 3 };
function camo(st, c, t, shade) {
  const n = noise2(c[0] * 2.4 + 7.3, c[2] * 2.4 + 1.7, 4);
  return CAMO[n < 0.42 ? 0 : n < 0.6 ? 1 : 2][shade];
}
const TITAN_PAINTS = {
  // 叢林 JUNGLE — olive camouflage, sand-khaki markings where the titan is amber, dark green visor
  jungle: {
    rough: 0.82, metal: 0.1, debris: '#6d7a3c', accent: '#7f9a45',
    map: {
      gun: (st, c, t) => camo(st, c, t, 0), gunLt: (st, c, t) => camo(st, c, t, 1), gunDk: (st, c, t) => camo(st, c, t, 2),
      belly: lit('#454b33'), bellyDk: lit('#32372a'), steel: lit('#7a7c68'),
      amber: lit('#a89a62'), amberLt: lit('#bcae74'), amberDk: lit('#6e6440'),
      ord: lit('#4b5530'), ordDk: lit('#343b22'),
      glass: S(lin('#16240f'), rgb(0.01, 0.04, 0.01)), glassLt: S(lin('#6f8a4a'), rgb(0.06, 0.1, 0.03)),
    },
  },
  // 鋼灰 STEEL — dark blue-grey steel with red stripes where the titan is amber, smoked canopy
  steel: {
    rough: 0.42, metal: 0.42, debris: '#c0262e', accent: '#e0303a',
    map: {
      gun: lit('#353b43'), gunLt: lit('#474f59'), gunDk: lit('#262b32'), gunXDk: lit('#14171b'),
      belly: lit('#262b31'), bellyDk: lit('#1a1e22'), steel: lit('#7c8692'),
      amber: lit('#b3141e'), amberLt: lit('#cf2630'), amberDk: lit('#720a12'),
      ord: lit('#4d555f'), ordDk: lit('#2a3037'),
      glass: S(lin('#18222c'), rgb(0.01, 0.03, 0.05)), glassLt: S(lin('#7a94ad'), rgb(0.05, 0.1, 0.16)),
    },
  },
  // 黃金 GOLD
  gold: {
    rough: GOLD.rough, metal: GOLD.metal, debris: GOLD.debris, accent: '#f0c75a',
    map: { glass: GOLD.glass, glassLt: GOLD.glassLt, hot: GOLD.hot, '*': GOLD.face },
    flame: FLAME_GOLD, trail: GOLD.trail,
  },
};

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
function createPhantom(paint = 'std') {
  const ac = acOf('phantom'), pt = paintOf(PHANTOM_PAINTS, paint);
  const g = assemblePlayer({
    name: 'player', body: pt ? paintedBody('ext:ships:phantom', buildPhantom, PH, paint, pt) : GG('ext:ships:phantom', buildPhantom),
    rough: pt ? pt.rough : 0.4, metal: pt ? pt.metal : 0.34,
    flame: pt ? G('ext:ships:phantom.flame.' + paint, () => buildBladeFlame(pt.blade, PH_Y_EXH)) : G('ext:ships:phantom.flame', () => buildBladeFlame(FLAME_BLADE, PH_Y_EXH)),
    flameZ: PH_Z_EXH,
    radius: ac.hitR, grazeRadius: ac.grazeR, debris: pt ? pt.debris : '#9466f0',
    muzzles: [[0, 0, -0.98], [-0.3, 0, -0.3], [0.3, 0, -0.3]], muzzleZ: -0.98,
    trail: [[-0.1, 0.56], [0, 0.56], [0.1, 0.56]],
    bankDeg: 35,
  });
  g.userData.trailColor = pt ? pt.trail : [1.5, 0.6, 2.8];
  // slow "breathing" of the violet edges on top of the standard engine flicker
  const ud = g.userData, mat = g.getObjectByName('body').material, base = ud.update;
  ud.update = (dt, t) => { base(dt, t); mat.uEmitScale.value *= 0.88 + Math.sin(t * 2.4) * 0.12; };
  if (pt && pt.flow) flowGlow(ud, mat, pt.flow);
  return g;
}
/** 極光 流轉: the glow drifts between teal and green (per-instance emission tint, no allocation) */
function flowGlow(ud, mat, k) {
  const tint = mat.uEmitTint.value, up = ud.update;
  ud.update = (dt, t) => { up(dt, t); const s = Math.sin(t * 0.8) * k; tint.setRGB(1 + s, 1, 1 - s); };
}

// ---- PHANTOM paints (recolours of 'ext:ships:phantom'; roles = PH). The slit exhaust takes the paint's
// glow: FLAME_BLADE layers with new base / tip colours.
const bladeTint = (base0, tip0, base1, tip1) => FLAME_BLADE.map((l, i) => [l[0], l[1], l[2], l[3], i ? base1 : base0, i ? tip1 : tip0]);
const BLOOD_EDGE = rgb(1.0, 0.05, 0.06), AURORA_A = rgb(0.1, 0.95, 1.0), AURORA_B = rgb(0.3, 1.0, 0.45);
const PHANTOM_PAINTS = {
  // 血月 BLOOD — red-black skin, blood-red glowing edges and slit, dark red canopy
  blood: {
    rough: 0.4, metal: 0.34, debris: '#d0202a', accent: '#ff2436',
    map: {
      skin: lit('#2e1719'), skinLt: lit('#43201f'), skinMd: lit('#381b1c'), skinDk: lit('#211011'),
      belly: lit('#180b0c'), bellyDk: lit('#0f0708'), trim: lit('#86202a'), intake: lit('#070304'),
      glass: S(lin('#3c0a0e'), rgb(0.13, 0.0, 0.01)), glassLt: S(lin('#c0303a'), rgb(0.34, 0.03, 0.04)),
      edge: (st) => retint(st, BLOOD_EDGE, 0.5, 0.7), edgeHot: (st) => retint(st, rgb(1.0, 0.3, 0.26), 0.5, 0.8),
    },
    blade: bladeTint(rgb(1.0, 0.12, 0.1, 0.85), rgb(0.6, 0.0, 0.02, 0.0), rgb(1.0, 0.62, 0.55, 1.3), rgb(1.0, 0.15, 0.1, 0.1)),
    trail: [2.8, 0.34, 0.3],
  },
  // 極光 AURORA — pearl-white skin, edges glowing teal at the centre fading to aurora green at the tips,
  // teal trim and canopy
  aurora: {
    rough: 0.36, metal: 0.2, debris: '#5fe8c8', accent: '#3ff0c8',
    map: {
      skin: lit('#b4c4cb'), skinLt: lit('#d8e1e5'), skinMd: lit('#c6d2d7'), skinDk: lit('#8aa3ad'),
      belly: lit('#5a6974'), bellyDk: lit('#43505a'), trim: lit('#1e9c8c'),
      glass: S(lin('#0b3438'), rgb(0.01, 0.1, 0.1)), glassLt: S(lin('#62d8c8'), rgb(0.06, 0.26, 0.24)),
      edge: (st, c) => retint(st, mix3(AURORA_A, AURORA_B, Math.min(1, Math.abs(c[0]) / 0.85)), 0.45),
      edgeHot: (st) => retint(st, rgb(0.55, 1.0, 0.95), 0.5),
    },
    blade: bladeTint(rgb(0.15, 1.0, 0.8, 0.85), rgb(0.0, 0.4, 0.5, 0.0), rgb(0.7, 1.0, 0.95, 1.3), rgb(0.2, 1.0, 0.8, 0.1)),
    trail: [0.5, 2.5, 2.1],
    flow: 0.3,                          // 流轉: the edge glow drifts teal ↔ green (flowGlow)
  },
  // 黃金 GOLD
  gold: {
    rough: GOLD.rough, metal: GOLD.metal, debris: GOLD.debris, accent: '#f0c75a',
    map: { glass: GOLD.glass, glassLt: GOLD.glassLt, '*': GOLD.face },
    blade: bladeTint(rgb(1.0, 0.62, 0.2, 0.85), rgb(0.55, 0.25, 0.0, 0.0), rgb(1.0, 0.92, 0.7, 1.3), rgb(1.0, 0.6, 0.18, 0.1)),
    trail: GOLD.trail,
  },
};

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
function createPhantomDrone(paint = 'std') {
  const pt = paintOf(DRONE_PAINTS, paint);
  const { g, pivot, ud } = enemyShell('option', 0.3, pt ? pt.debris : '#9466f0');
  g.name = 'option';
  const mat = pt ? bodyMat(pt.rough, pt.metal) : bodyMat(0.42, 0.3);
  const body = new THREE.Mesh(pt ? paintedBody('ext:ships:phantom.drone', buildDrone, DR, paint, pt) : GG('ext:ships:phantom.drone', buildDrone), mat); body.name = 'body';
  pivot.add(body);
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(pt ? G('ext:ships:phantom.drone.flame.' + paint, () => buildFlame([[0, 0, 1]], pt.flame))
    : G('ext:ships:phantom.drone.flame', () => buildFlame([[0, 0, 1]], FLAME_DRONE)), flameMat); flame.name = 'flame';
  flame.position.set(0, 0, 0.11); flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, 0, -0.16)];
  ud.muzzleZ = -0.16;
  ud.trail = [[0, 0.22]];
  ud.trailColor = pt ? pt.trail : [1.5, 0.6, 2.8];
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
  if (pt && pt.flow) flowGlow(ud, mat, pt.flow);
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  ud.update(0, 0);
  return g;
}

// ---- drone paints (match the PHANTOM paints; recolours of 'ext:ships:phantom.drone', roles = DR; the
// energy-core bands are inline glows, re-tinted by the '*' entry)
const droneFlame = (b0, t0, b1, t1) => FLAME_DRONE.map((c, i) => ({ ...c, base: i ? b1 : b0, tip: i ? t1 : t0 }));
const DRONE_PAINTS = {
  blood: {
    rough: 0.42, metal: 0.3, debris: '#d0202a',
    map: {
      collar: lit('#3a1a1c'), collarLt: lit('#522426'), collarDk: lit('#1f0e0f'), fin: lit('#331719'), finLt: lit('#4a2022'), finDk: lit('#1a0c0d'),
      tip: (st) => retint(st, BLOOD_EDGE, 0.5, 0.7), '*': (st) => retint(st, rgb(1.0, 0.08, 0.06), 0.45, 0.62),
    },
    flame: droneFlame(rgb(1.0, 0.12, 0.1, 1.4), rgb(0.6, 0.0, 0.02, 0.0), rgb(1.0, 0.6, 0.5, 2.2), rgb(1.0, 0.15, 0.1, 0.1)),
    trail: [2.8, 0.34, 0.3],
  },
  aurora: {
    rough: 0.36, metal: 0.2, debris: '#5fe8c8',
    map: {
      collar: lit('#b6c3ca'), collarLt: lit('#ccd7dc'), collarDk: lit('#8394a0'), fin: lit('#aebcc4'), finLt: lit('#c6d1d6'), finDk: lit('#6f808c'),
      tip: (st) => retint(st, AURORA_B, 0.42), '*': (st) => retint(st, AURORA_A, 0.4),
    },
    flame: droneFlame(rgb(0.15, 1.0, 0.8, 1.4), rgb(0.0, 0.4, 0.5, 0.0), rgb(0.7, 1.0, 0.95, 2.2), rgb(0.2, 1.0, 0.8, 0.1)),
    trail: [0.5, 2.5, 2.1],
    flow: 0.3,
  },
  gold: {
    rough: GOLD.rough, metal: GOLD.metal, debris: GOLD.debris,
    map: { '*': GOLD.face },
    flame: flameRecolour(FLAME_DRONE, FLAME_GOLD), trail: GOLD.trail,
  },
};

/** a paint table's entry for `paint`, or null for 'std' / an unknown paint (the registry already warned) */
function paintOf(table, paint) { return paint !== 'std' && Object.prototype.hasOwnProperty.call(table, paint) ? table[paint] : null; }

export const PLAYERS = { gale: createGale, titan: createTitan, phantom: createPhantom };
export const OPTIONS = { phantom: createPhantomDrone };
/** the paints each aircraft here supports (besides 'std'), with the accent colour that identifies them */
export const PLAYER_PAINTS = {
  gale: Object.fromEntries(Object.entries(GALE_PAINTS).map(([k, p]) => [k, { accent: p.accent }])),
  titan: Object.fromEntries(Object.entries(TITAN_PAINTS).map(([k, p]) => [k, { accent: p.accent }])),
  phantom: Object.fromEntries(Object.entries(PHANTOM_PAINTS).map(([k, p]) => [k, { accent: p.accent }])),
};
