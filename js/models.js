// =============================================================================
// CRIMSON BOLT (赤電) — procedural low-poly models: registry + stage-1 models
// -----------------------------------------------------------------------------
// Everything here is built from code: no model files, no image files. The
// toolkit (GB builder, materials, caches, palettes, helpers) and the house style
// live in modelkit.js; the other aircraft and the stage-2/3 enemies and bosses
// live in the extension files and are merged into the registry below:
//
//   createPlayer(id = 'bolt')     kind 'player:<id>'  bolt here, others: models_ships.js PLAYERS
//   createOption(id = 'phantom')  kind 'option:<id>'  models_ships.js OPTIONS, else a placeholder pod
//   createEnemy(type)             kind <type>         stage-1 types here, others: models_s2/s3 ENEMIES
//   createBoss(id = 'arclight')   kind 'boss:<id>'    ARCLIGHT here, others: models_s2/s3 BOSSES
//   createItem(kind)              P (setColor: any MAIN_WEAPONS key), S (setKind: any SUB_WEAPONS
//                                 key), B, medal, 1UP
//   createShadow(model)           one baked silhouette per kind (pristineOf knows every prefix)
//   PLAYER_TYPES, OPTION_TYPES, BOSS_TYPES, ENEMY_TYPES, GROUND_TYPES (merged), ITEM_KINDS, modelStats
// An unknown aircraft / option / boss id falls back to bolt / the placeholder pod /
// ARCLIGHT with a console warning (so a missing extension never stops the game);
// an unknown enemy type throws, as before.
//
// Extras beyond the contract (all optional for core to use):
//   * userData.muzzles of tank / turret / gunboat / crawler are refreshed by
//     update() to follow the turret's current yaw (still group-local space);
//     turret.userData.muzzles holds the same points in turret-local space.
//   * userData.kind, userData.dispose() (frees this instance's materials; shared
//     geometry stays cached until disposeAll()), userData.halfExtents {x,z} on
//     the long units (gunboat, bomber, crawler) for an optional box test.
//   * crawler parts (turret / gunL / gunR) have radius, setFlash, setDestroyed
//     and part-local muzzles, exactly like boss parts.
//   * player: userData.bankPivot (the rolling sub-group). setBank(b > 0) rolls
//     RIGHT (right wing down) — pass +1 while strafing toward +x. userData.trail
//     ([[x, z], …] engine exhaust points) and userData.muzzleZ (gun line z), local.
//   * createShadow() bakes one soft silhouette (JS-rasterised DataTexture, no
//     canvas read-back) per model kind, always from a pristine instance of that
//     kind, onto a single quad (1 draw call, no double-darkening where parts overlap).
// =============================================================================
import * as THREE from 'three';
import {
  TAU, DEG, lin, rgb, S, lit, GL, EM, scl, hash3, M, GB, wreckOf, bodyMat, additiveMat, FLASH_K, flashFn,
  GEO, TEX, GBS, G, GG, gbOf, PL, EN, BO, FLAME_JET, FLAME_VIOLET, buildFlame, assemblePlayer, enemyShell,
  syncMuzzles, hazardStrip, trackLoft, TRACK_COL, hazardDrape, blockOn, makePart, destructiblePart, glyphTex, haloTex,
} from './modelkit.js';
import { AIRCRAFT_BY_ID, MAIN_WEAPONS, SUB_WEAPONS } from './defs.js';
import * as SHIPS from './models_ships.js';
import * as S2 from './models_s2.js';
import * as S3 from './models_s3.js';
export { modelStats } from './modelkit.js';

// extension tables (merged; stage-1 names always win a collision)
const EXT_PLAYERS = { ...(SHIPS.PLAYERS || {}) };
const EXT_OPTIONS = { ...(SHIPS.OPTIONS || {}) };
const EXT_ENEMIES = { ...(S2.ENEMIES || {}), ...(S3.ENEMIES || {}) };
const EXT_BOSSES = { ...(S2.BOSSES || {}), ...(S3.BOSSES || {}) };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const warned = new Set();
function warnOnce(what, id, fallback) {
  const k = what + ':' + id;
  if (warned.has(k)) return;
  warned.add(k);
  console.warn(`models: no ${what} model "${id}" yet — using ${fallback}`);
}

// =============================================================================
// PLAYER — "CRIMSON BOLT"
// =============================================================================
const P_FUS = [ // z, halfWidth, top, bottom, chineY
  [-0.97, 0.004, 0.004, 0.004, 0.000],
  [-0.87, 0.040, 0.032, 0.026, -0.004],
  [-0.75, 0.074, 0.064, 0.046, -0.008],
  [-0.58, 0.106, 0.092, 0.060, -0.010],
  [-0.40, 0.138, 0.114, 0.071, -0.012],
  [-0.22, 0.164, 0.124, 0.079, -0.012],
  [-0.19, 0.167, 0.125, 0.080, -0.012],
  [0.02, 0.188, 0.122, 0.085, -0.010],
  [0.24, 0.196, 0.117, 0.086, -0.008],
  [0.27, 0.196, 0.116, 0.086, -0.008],
  [0.46, 0.188, 0.109, 0.082, -0.006],
  [0.64, 0.176, 0.099, 0.078, -0.005],
  [0.74, 0.168, 0.093, 0.075, -0.005],
];
const P_SEG = ['radome', 'nose', 'nose', 'canopy', 'canopy', 'line', 'mid', 'mid', 'line', 'aft', 'aft', 'aft'];
function pTopAt(z) {
  for (let i = 0; i < P_FUS.length - 1; i++) {
    const a = P_FUS[i], b = P_FUS[i + 1];
    if (z >= a[0] && z <= b[0]) { const t = (z - a[0]) / (b[0] - a[0]); return a[2] + (b[2] - a[2]) * t; }
  }
  return 0.09;
}
function buildPlayer() {
  const b = new GB();
  // ---- fuselage (chined, 10-sided)
  const ring = ([z, w, tp, bt, ch]) => [
    [0, tp, z], [w * 0.22, tp * 0.985, z], [w * 0.62, tp * 0.82, z], [w, ch, z], [w * 0.6, -bt * 0.9, z],
    [0, -bt, z], [-w * 0.6, -bt * 0.9, z], [-w, ch, z], [-w * 0.62, tp * 0.82, z], [-w * 0.22, tp * 0.985, z]];
  b.loft(P_FUS.map(ring), (i, j) => {
    const tag = P_SEG[i];
    if (tag === 'radome') return PL.radome;
    const spine = j === 0 || j === 9, sh = j === 1 || j === 8, up = j === 2 || j === 7, lo = j === 3 || j === 6;
    if (tag === 'line') return spine ? PL.steel : (sh || up) ? PL.crimsonDk : lo ? PL.crimsonDk : PL.bellyDk;
    if (spine) return tag === 'canopy' ? PL.crimson : PL.white;
    if (sh) return PL.crimson;
    if (up) return PL.crimsonMd;
    if (lo) return PL.crimsonDk;
    return PL.belly;
  }, null, PL.gunDk);

  // ---- canopy (faceted bubble)
  const CN = [[-0.67, 0.006, 0.003], [-0.58, 0.052, 0.038], [-0.47, 0.078, 0.064], [-0.35, 0.087, 0.074],
    [-0.32, 0.087, 0.074], [-0.22, 0.078, 0.062], [-0.11, 0.05, 0.034], [-0.02, 0.012, 0.006]];
  const cring = ([z, cw, ch]) => {
    const y0 = pTopAt(z) - 0.014;
    return [[-cw, y0, z], [-cw * 0.8, y0 + ch * 0.56, z], [-cw * 0.42, y0 + ch * 0.93, z], [0, y0 + ch, z],
      [cw * 0.42, y0 + ch * 0.93, z], [cw * 0.8, y0 + ch * 0.56, z], [cw, y0, z], [0, y0 - 0.03, z]];
  };
  b.loft(CN.map(cring), (i, j) => {
    if (j >= 6) return null;
    if (i === 3) return PL.steel;                     // canopy bow frame
    if (i <= 1) return (j === 2 || j === 3) ? PL.glassLt : PL.glass;   // windscreen glint
    if (i === 4 && (j === 2 || j === 3)) return PL.glassLt;
    return PL.glass;
  });

  // ---- intakes (right, mirrored)
  const f0 = b.n;
  const IN = [[-0.25, 0.12, 0.288, -0.068, 0.062], [-0.22, 0.12, 0.288, -0.068, 0.062],
    [0.06, 0.12, 0.282, -0.066, 0.058], [0.36, 0.12, 0.2, -0.05, 0.03]];
  const iring = ([z, xi, xo, yb, yt]) => [[xi, yb, z], [xo, yb, z], [xo, yt - 0.03, z], [xo - 0.032, yt, z], [xi, yt, z]];
  b.loft(IN.map(iring), (i, j) => {
    if (j === 4) return null;
    if (i === 0) return j === 0 ? PL.steelDk : PL.white;   // inlet lip
    if (j === 0) return PL.belly;
    if (j === 1) return PL.crimsonDk;
    if (j === 2) return i === 1 ? PL.white : PL.crimsonMd;  // chamfer: white stripe on the intake
    return PL.crimson;
  }, PL.intake, null);

  // ---- main wing: cranked arrow with a leading-edge strake
  const w0 = b.n;
  b.wing([
    { x: 0.13, y: -0.016, zl: -0.3, zt: 0.62, t: 0.058 },
    { x: 0.24, y: -0.013, zl: -0.12, zt: 0.61, t: 0.052 },
    { x: 0.46, y: -0.007, zl: 0.065, zt: 0.59, t: 0.04 },
    { x: 0.64, y: -0.001, zl: 0.215, zt: 0.57, t: 0.03 },
    { x: 0.8, y: 0.005, zl: 0.35, zt: 0.55, t: 0.02 },
  ], (i, j) => {
    if (j >= 4) return PL.belly;
    if (j === 0) return i === 0 ? PL.steel : PL.white;       // bright leading edge
    if (j === 3) return i === 2 ? PL.crimsonMd : PL.crimsonDk; // flaps / aileron
    if (i === 3 && j === 1) return PL.crimsonLt;
    return PL.crimson;
  }, null, PL.crimsonDk);
  const w1 = b.n;
  // livery: white lightning bolt draped over the wing skin
  const bolt = [[0.19, 0.5], [0.43, 0.23], [0.47, 0.39], [0.735, 0.43]];
  const quads = [];
  for (let k = 0; k < bolt.length - 1; k++) {
    const [ax, az] = bolt[k], [bx, bz] = bolt[k + 1];
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    const w = k === 1 ? 0.036 : 0.042, nx = -uz * w, nz = ux * w, e = 0.018;
    const A = [ax - ux * e, az - uz * e], B = [bx + ux * e, bz + uz * e];
    quads.push([[A[0] + nx, A[1] + nz], [B[0] + nx, B[1] + nz], [B[0] - nx, B[1] - nz], [A[0] - nx, A[1] - nz]]);
  }
  b.drape(quads, PL.white, w0, w1, 0.0035, 4);
  // wing gun: short barrel poking out of the strake crank
  b.lathe([0.27, 0.004, 0.0], [0, 0, -1], [[0, 0.022], [0.1, 0.02], [0.1, 0.014], [0.17, 0.014]], 6,
    (i) => (i === 0 ? PL.steelDk : PL.gunDk), null, PL.black, { phase: Math.PI / 6 });
  // wingtip missile
  b.lathe([0.8, 0.006, 0.58], [0, 0, -1], [[0, 0.012], [0.04, 0.026], [0.42, 0.026], [0.52, 0.017], [0.6, 0.002]], 6,
    (i) => (i >= 3 ? PL.crimson : i === 0 ? PL.steelDk : PL.white), PL.gunDk, null, { phase: Math.PI / 6 });
  // canard
  b.wing([{ x: 0.1, y: 0.03, zl: -0.61, zt: -0.41, t: 0.022 }, { x: 0.33, y: 0.038, zl: -0.48, zt: -0.41, t: 0.01 }],
    (i, j) => (j >= 4 ? PL.belly : j === 0 ? PL.steel : PL.white), null, PL.white);
  // horizontal stabiliser
  b.wing([{ x: 0.15, y: -0.004, zl: 0.45, zt: 0.8, t: 0.026 }, { x: 0.38, zl: 0.62, zt: 0.83, t: 0.018 }, { x: 0.48, zl: 0.7, zt: 0.84, t: 0.012 }],
    (i, j) => (j >= 4 ? PL.belly : i === 1 ? PL.white : j === 0 ? PL.white : j === 3 ? PL.crimsonDk : PL.crimson), null, PL.white);
  // canted twin tail
  const f2 = b.n;
  b.wing([{ x: 0, zl: 0.33, zt: 0.74, t: 0.036 }, { x: 0.22, zl: 0.54, zt: 0.78, t: 0.022 }, { x: 0.31, zl: 0.62, zt: 0.8, t: 0.015 }],
    (i, j) => (i === 1 ? PL.white : j === 0 ? PL.crimsonLt : j >= 3 ? PL.crimsonDk : PL.crimson), null, PL.white);
  b.xform(f2, M(0.11, 0.08, 0, 0, 0, 62 * DEG));
  // engine nozzle with glowing core
  b.lathe([0.095, 0.0, 0.6], [0, 0, 1], [[0, 0.086], [0.14, 0.09], [0.17, 0.085], [0.3, 0.075], [0.3, 0.05]], 8,
    (i) => (i === 0 ? PL.gunDk : i === 1 ? PL.steel : i === 2 ? PL.nozzle : PL.gunDk), null, GL(EM.engineHot, 0.7), { phase: Math.PI / 8 });
  b.mirrorX(f0);
  return b;
}
const BOLT_NOZZLES = [[-0.095, 0], [0.095, 0]];
/** CRIMSON BOLT — the reference implementation of the player contract (see assemblePlayer) */
function createBolt() {
  return assemblePlayer({
    name: 'player', body: GG('player', buildPlayer), rough: 0.5, metal: 0.12,
    flame: G('player.flame', () => buildFlame(BOLT_NOZZLES, FLAME_JET)), flameZ: 0.9,
    radius: 0.3, grazeRadius: 1.0, debris: '#c41c26',
    muzzles: [[0, 0, -1.0], [-0.27, 0, -0.2], [0.27, 0, -0.2]], muzzleZ: -1.0,
    trail: [[-0.095, 0.95], [0.095, 0.95]],   // nozzle exits (the flame mesh starts at z 0.9)
    bankDeg: 35,
  });
}

const NOOP = () => {};
/** registry stamp + safe defaults, so a model missing an optional hook never breaks the game loop */
function finishPlayer(g, id) {
  const ud = g.userData;
  ud.kind = 'player:' + id;
  if (ud.radius === undefined) ud.radius = 0.3;
  if (ud.grazeRadius === undefined) ud.grazeRadius = 1.0;
  if (!ud.debrisColor) ud.debrisColor = new THREE.Color('#c41c26');
  if (!ud.muzzles) ud.muzzles = [new THREE.Vector3(0, 0, -1.0)];
  if (ud.muzzleZ === undefined) ud.muzzleZ = -1.0;
  if (!ud.trail) ud.trail = [[0, 0.95]];
  for (const k of ['setBank', 'setThrust', 'setFlash', 'update', 'dispose']) if (typeof ud[k] !== 'function') ud[k] = NOOP;
  return g;
}

/** player aircraft by id ('bolt' here, others from models_ships.js); kind 'player:<id>' */
export function createPlayer(id = 'bolt') {
  let g;
  if (id !== 'bolt' && own(EXT_PLAYERS, id)) g = EXT_PLAYERS[id]();
  else { if (id !== 'bolt') warnOnce('aircraft', id, 'bolt'); g = createBolt(); }
  return finishPlayer(g, id);
}

// =============================================================================
// OPTION — escort drone. Placeholder until models_ships.js provides OPTIONS[id]:
// a gunmetal pod with a glowing lens and energy band, swept side vanes and a
// ventral keel. Every glow is white HDR in the geometry, tinted per instance
// (uEmitTint) by the aircraft colour, so one geometry serves every aircraft.
// =============================================================================
const OPT = {
  hull: lit('#5a636f'), hullLt: lit('#8a94a1'), hullDk: lit('#323842'), edge: lit('#c3cad3'), black: lit('#0e1014'),
  glow: GL(rgb(1, 1, 1, 1.9), 0.16), glowDim: GL(rgb(1, 1, 1, 0.9), 0.12),
};
function buildOptionPod() {
  const b = new GB();
  // pod along +z, octagonal with a flat top (edge 1 = top, 3/7 = sides, 5 = belly):
  // lens · bezel · hull · energy band · hull · nozzle collar
  b.lathe([0, 0, -0.34], [0, 0, 1], [[0, 0], [0.04, 0.05], [0.09, 0.083], [0.13, 0.1], [0.3, 0.11], [0.36, 0.11], [0.5, 0.098], [0.6, 0.07]], 8, (i, j) => {
    if (i <= 1) return i === 0 ? OPT.glow : OPT.glowDim;
    if (i === 2) return OPT.black;
    if (i === 4) return OPT.glow;
    if (i === 6) return j <= 2 ? OPT.hullDk : OPT.black;
    return j === 1 ? OPT.hullLt : (j === 0 || j === 2) ? OPT.hull : (j === 3 || j === 7) ? OPT.hullDk : OPT.black;
  }, null, GL(rgb(1, 1, 1, 1.6), 0.5), { phase: Math.PI / 8 });
  // dorsal sensor spine
  b.block({ x: 0, y: 0.096, z: -0.07, w: 0.05, d: 0.18, h: 0.026, tw: 0.036, td: 0.15, top: OPT.edge, side: OPT.hullDk });
  // ventral keel (centre line, before the mirrored half)
  const k0 = b.n;
  b.wing([{ x: 0.08, zl: 0.04, zt: 0.25, t: 0.03 }, { x: 0.19, zl: 0.15, zt: 0.27, t: 0.016 }], (i, j) => (j === 0 ? OPT.edge : OPT.hullDk), null, OPT.glowDim);
  b.xform(k0, M(0, 0, 0, 0, 0, -Math.PI / 2));
  // swept side vane with a glowing tip strip (right, mirrored)
  const f0 = b.n;
  b.wing([{ x: 0.085, y: 0, zl: -0.08, zt: 0.2, t: 0.045 }, { x: 0.24, y: 0.015, zl: 0.06, zt: 0.25, t: 0.024 }, { x: 0.3, y: 0.02, zl: 0.13, zt: 0.26, t: 0.016 }],
    (i, j) => {
      if (j >= 4) return OPT.black;
      if (i === 1) return j <= 1 ? OPT.glow : OPT.hullDk;
      if (j === 0) return OPT.edge;
      return j === 3 ? OPT.hullDk : OPT.hull;
    }, null, OPT.hullDk);
  b.mirrorX(f0);
  return b;
}
function createOptionPod(id) {
  const ac = AIRCRAFT_BY_ID[id];
  const hex = ac ? ac.hex : 0xb98cff;
  const { g, pivot, ud } = enemyShell('option', 0.35, hex);
  g.name = 'option';
  const mat = bodyMat(0.5, 0.3);
  const tint = new THREE.Color(hex);                                            // linear; ^1.5 = a touch more saturated
  mat.uEmitTint.value.setRGB(tint.r ** 1.5, tint.g ** 1.5, tint.b ** 1.5);
  const body = new THREE.Mesh(GG('option.pod', buildOptionPod), mat); body.name = 'body';
  pivot.add(body);
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('option.flame', () => buildFlame([[0, 0, 0.55]], FLAME_JET)), flameMat); flame.name = 'flame';
  flame.position.set(0, 0, 0.26); flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, 0, -0.4)];
  ud.muzzleZ = -0.4;
  ud.trail = [[0, 0.3]];
  let thrust = 0.5;
  ud.setThrust = (t) => { thrust = Math.max(0, Math.min(1, t)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    pivot.rotation.z = Math.sin(t * 1.7) * 0.35;                               // lazy roll
    const fl = 1 + Math.sin(t * 49) * 0.08 + Math.sin(t * 29.3) * 0.05;
    flame.scale.set(1, 1, (0.5 + thrust * 0.9) * fl);
    flameMat.color.setScalar(0.8 + thrust * 0.3);
    mat.uEmitScale.value = 0.8 + Math.sin(t * 6) * 0.2;
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  ud.update(0, 0);
  return g;
}
/** option drone by aircraft id (models_ships.js OPTIONS[id], else the placeholder pod); kind 'option:<id>' */
export function createOption(id = 'phantom') {
  const g = own(EXT_OPTIONS, id) ? EXT_OPTIONS[id]() : createOptionPod(id);
  const ud = g.userData;
  ud.kind = 'option:' + id;
  if (ud.radius === undefined) ud.radius = 0.35;
  if (!ud.debrisColor) ud.debrisColor = new THREE.Color(0xb98cff);
  if (!ud.muzzles) ud.muzzles = [new THREE.Vector3(0, 0, -0.4)];
  for (const k of ['setThrust', 'setFlash', 'update', 'dispose']) if (typeof ud[k] !== 'function') ud[k] = NOOP;
  return g;
}

// =============================================================================
// DART — small fast interceptor
// =============================================================================
function buildDart() {
  const b = new GB();
  const ST = [[-0.72, 0.004, 0.004, 0.004], [-0.54, 0.07, 0.058, 0.04], [-0.24, 0.125, 0.098, 0.06],
    [0.16, 0.15, 0.1, 0.07], [0.5, 0.12, 0.08, 0.06], [0.64, 0.1, 0.066, 0.05]];
  const ring = ([z, w, tp, bt]) => [[0, tp, z], [w * 0.55, tp * 0.72, z], [w, 0, z], [w * 0.45, -bt, z],
    [-w * 0.45, -bt, z], [-w, 0, z], [-w * 0.55, tp * 0.72, z]];
  b.loft(ST.map(ring), (i, j) => {
    if (i === 0) return EN.edgeLt;                      // light nose cone (contrast)
    if (j === 0 || j === 6) return i === 1 ? EN.gunLt : EN.gun;
    if (j === 1 || j === 5) return EN.gunDk;
    return EN.gunXDk;
  }, null, GL(EM.eyeOrange, 0.5));
  // glowing V-visor eye
  const ey = 0.078;
  b.decal([[0, ey + 0.012, -0.47], [0.075, ey, -0.29], [0.04, ey + 0.004, -0.22], [0, ey + 0.012, -0.33]], GL(EM.eyeRed));
  b.decal([[0, ey + 0.012, -0.47], [-0.075, ey, -0.29], [-0.04, ey + 0.004, -0.22], [0, ey + 0.012, -0.33]], GL(EM.eyeRed));
  // exhaust glow cone
  b.lathe([0, 0, 0.64], [0, 0, 1], [[0, 0.065], [0.18, 0.0]], 6, GL(EM.engine, 0.5));
  const f0 = b.n;
  // swept wing
  b.wing([{ x: 0.07, y: -0.01, zl: -0.3, zt: 0.56, t: 0.05 }, { x: 0.44, y: 0.0, zl: 0.26, zt: 0.62, t: 0.028 },
    { x: 0.7, y: 0.01, zl: 0.5, zt: 0.7, t: 0.014 }], (i, j) => {
    if (j >= 4) return EN.gunXDk;
    if (j === 0) return EN.edge;                         // bright leading edge
    if (i === 1) return j === 3 ? EN.orangeDk : EN.orange; // hazard tip
    return j === 3 ? EN.gunDk : EN.gun;
  }, null, EN.orange);
  // hazard black bar across the tip panel
  b.decal([[0.44, 0.03, 0.3], [0.5, 0.028, 0.37], [0.51, 0.03, 0.62], [0.45, 0.03, 0.62]], EN.black);
  // wingtip fin (down-canted)
  const f1 = b.n;
  b.wing([{ x: 0, zl: 0.44, zt: 0.72, t: 0.02 }, { x: 0.14, zl: 0.6, zt: 0.74, t: 0.01 }], (i, j) => (j === 0 ? EN.edge : EN.gunDk), null, EN.edge);
  b.xform(f1, M(0.7, 0.01, 0, 0, 0, -70 * DEG));
  // canted tail fin
  const f2 = b.n;
  b.wing([{ x: 0, zl: 0.2, zt: 0.6, t: 0.03 }, { x: 0.24, zl: 0.46, zt: 0.66, t: 0.014 }], (i, j) => (j === 0 ? EN.edge : j >= 3 ? EN.gunDk : EN.gun), null, EN.orange);
  b.xform(f2, M(0.07, 0.05, 0, 0, 0, 55 * DEG));
  // intake scoops
  b.block({ x: 0.15, y: -0.04, z: -0.02, w: 0.08, d: 0.28, h: 0.08, tw: 0.06, td: 0.22, oz: 0.03, top: EN.gunLt, side: EN.gunDk, front: EN.black });
  b.mirrorX(f0);
  return b.xform(0, M(0, 0, 0, 0, 0, 0, 0.92));
}

// =============================================================================
// HORNET — rotor gunship drone
// =============================================================================
function buildHornet() {
  const b = new GB();
  const ring = ([z, w, h, yc]) => {
    const r = [];
    for (let k = 0; k < 8; k++) { const th = Math.PI / 8 + (k * TAU) / 8; r.push([Math.cos(th) * w, yc + Math.sin(th) * h, z]); }
    return r;
  };
  const ST = [[-0.62, 0.05, 0.04, 0.03], [-0.5, 0.22, 0.17, 0.03], [-0.3, 0.33, 0.25, 0.05], [0.04, 0.35, 0.26, 0.06],
    [0.32, 0.27, 0.2, 0.05], [0.52, 0.12, 0.1, 0.05]];
  // edges: 0 right-upper(22.5→67.5) 1 top-right 2 top-left 3 left-upper ... (θ from π/8)
  b.loft(ST.map(ring), (i, j) => {
    const top = j === 1 || j === 2, upper = j === 0 || j === 3, lower = j === 4 || j === 7;
    if (top) return i === 2 ? EN.sandLt : EN.sand;
    if (upper) return i === 3 ? EN.orange : EN.olive;
    if (lower) return EN.oliveDk;
    return EN.gunXDk;
  }, null, EN.oliveDk);
  // compound eye (big, red, faceted)
  b.lathe([0, 0.07, -0.42], [0, 0.18, -1], [[0, 0.17], [0.1, 0.15], [0.18, 0.09], [0.22, 0.0]], 8,
    (i, j) => GL(((i + j) & 1) ? EM.eyeRed : scl(EM.eyeRed, 0.65), 0.45), null, null, { phase: Math.PI / 8 });
  // tail boom + tail
  b.lathe([0, 0.06, 0.48], [0, 0, 1], [[0, 0.075], [0.44, 0.045]], 6, (i, j) => (j === 1 ? EN.sand : EN.olive), null, EN.oliveDk, { phase: Math.PI / 6 });
  b.plate([[-0.3, 0.8], [0.3, 0.8], [0.26, 0.95], [-0.26, 0.95]], 0.05, 0.08, EN.sand, EN.oliveDk);
  b.decal([[0.2, 0.082, 0.8], [0.3, 0.082, 0.8], [0.26, 0.082, 0.95], [0.18, 0.082, 0.95]], EN.orange);
  b.decal([[-0.2, 0.082, 0.8], [-0.3, 0.082, 0.8], [-0.26, 0.082, 0.95], [-0.18, 0.082, 0.95]], EN.orange);
  b.block({ x: 0, y: 0.08, z: 0.86, w: 0.03, d: 0.18, h: 0.2, td: 0.1, oz: 0.04, top: EN.orange, side: EN.olive });
  // rotor mast
  b.lathe([0, 0.28, -0.02], [0, 1, 0], [[0, 0.09], [0.1, 0.07], [0.16, 0.05]], 6, EN.gunDk, null, EN.gun);
  // exhaust vents
  for (const sg of [-1, 1]) for (const z of [0.2, 0.3]) {
    b.decal([[0.1 * sg, 0.302, z], [0.2 * sg, 0.272, z], [0.19 * sg, 0.265, z + 0.045], [0.095 * sg, 0.295, z + 0.045]], GL(scl(EM.engine, 0.55), 0.3), [0.2 * sg, 1, 0]);
  }
  const f0 = b.n;
  // stub wing
  b.wing([{ x: 0.26, y: 0.02, zl: -0.14, zt: 0.2, t: 0.06 }, { x: 0.68, y: 0.06, zl: -0.1, zt: 0.16, t: 0.04 }],
    (i, j) => (j >= 4 ? EN.oliveDk : j === 0 ? EN.sandLt : EN.olive), null, EN.oliveDk);
  // gun pod
  b.lathe([0.76, 0.04, 0.34], [0, 0, -1], [[0, 0.05], [0.08, 0.105], [0.36, 0.105], [0.46, 0.105], [0.62, 0.085],
    [0.62, 0.04], [0.86, 0.036], [0.92, 0.05]], 6, (i, j) => {
    if (i === 2) return (j === 1 || j === 2) ? EN.orange : EN.orangeDk;           // hazard band
    if (i >= 5) return i === 6 ? EN.gunLt : EN.gunXDk;
    return (j === 1 || j === 2) ? EN.gunLt : EN.gun;
  }, EN.gunDk, GL(EM.eyeOrange, 0.4), { phase: Math.PI / 6 });
  b.mirrorX(f0);
  return b;
}
function buildRotorBlades() {
  const b = new GB();
  for (let k = 0; k < 3; k++) {
    const f = b.n;
    b.block({ x: 0.46, y: -0.012, z: 0, w: 0.72, d: 0.085, h: 0.024, tw: 0.72, td: 0.06, top: EN.gunDk, side: EN.gunXDk });
    b.block({ x: 0.8, y: -0.011, z: 0, w: 0.12, d: 0.087, h: 0.026, top: EN.orange, side: EN.orangeDk });
    b.xform(f, M(0, 0, 0, 0, (k * TAU) / 3, 0));
  }
  b.lathe([0, -0.03, 0], [0, 1, 0], [[0, 0.1], [0.05, 0.1], [0.08, 0.05]], 6, EN.gun, null, EN.gunLt);
  return b;
}
/** Motion-blur disc: smoky and almost clear over the hub (the drone body must stay
 *  readable through it), with three trailing blade-sweep lobes that turn with the
 *  rotor, and a thin hazard-orange tip ring. Vertex RGBA, 160 triangles. */
function buildRotorDisc() {
  const N = 20, R = [0.14, 0.52, 0.78, 0.82, 0.87];
  const A = [0.0, 0.05, 0.1, 0.3, 0.3];                  // radial alpha
  const C = [[0.5, 0.55, 0.58], [0.55, 0.6, 0.63], [0.62, 0.66, 0.68], [1.0, 0.5, 0.14], [1.0, 0.5, 0.14]];
  // blade sweep: 3 lobes. update() spins the rotor toward +angle (rotation.y decreases), so each
  // lobe has its sharp leading edge at the high-angle end and a soft tail trailing behind it.
  const sweep = (a) => {
    const f = ((a * 3) / TAU) % 1;                        // 0..1 within one lobe
    return 0.35 + 0.65 * Math.pow(f, 2.2);
  };
  const pos = [], col = [];
  for (let r = 0; r < R.length - 1; r++) {
    for (let k = 0; k < N; k++) {
      const a0 = (TAU * k) / N, a1 = (TAU * (k + 1)) / N;
      const P = (ri, a) => [Math.cos(a) * R[ri], 0, Math.sin(a) * R[ri]];
      const Cc = (ri, a) => [...C[ri], A[ri] * (ri >= 3 ? 1 : sweep(a))];
      pos.push(...P(r, a0), ...P(r + 1, a1), ...P(r + 1, a0), ...P(r, a0), ...P(r, a1), ...P(r + 1, a1));
      col.push(...Cc(r, a0), ...Cc(r + 1, a1), ...Cc(r + 1, a0), ...Cc(r, a0), ...Cc(r, a1), ...Cc(r + 1, a1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}

// =============================================================================
// TANK
// =============================================================================
function buildTankHull() {
  const b = new GB();
  trackLoft(b, 0.5, 0.28, 0.3, -0.85, 0.85, 9, TRACK_COL);
  trackLoft(b, -0.5, 0.28, 0.3, -0.85, 0.85, 9, TRACK_COL);
  // hull
  const ring = (z, w, lo, hi) => [[-w, lo, z], [w, lo, z], [w + 0.02, hi - 0.06, z], [w - 0.06, hi, z], [-w + 0.06, hi, z], [-w - 0.02, hi - 0.06, z]];
  b.loft([ring(-0.8, 0.28, 0.12, 0.2), ring(-0.52, 0.36, 0.08, 0.39), ring(0.7, 0.36, 0.08, 0.39), ring(0.8, 0.32, 0.1, 0.32)], (i, j) => {
    if (j === 3) return i === 0 ? EN.oliveLt : EN.olive;         // top
    if (j === 2 || j === 4) return EN.sandLt;                    // bright edge bevels
    if (j === 0) return null;
    return EN.oliveDk;
  }, EN.oliveDk, EN.oliveDk);
  // fenders over tracks (front/back mud guards)
  for (const s of [-1, 1]) {
    b.block({ x: 0.5 * s, y: 0.3, z: -0.72, w: 0.32, d: 0.2, h: 0.03, top: EN.oliveDk, side: EN.sandDk });
    b.block({ x: 0.5 * s, y: 0.3, z: 0.74, w: 0.32, d: 0.16, h: 0.03, top: EN.oliveDk, side: EN.sandDk });
  }
  // engine deck grille + hazard stripes
  for (let k = 0; k < 4; k++) b.decal([[-0.22, 0.392, 0.42 + k * 0.07], [0.22, 0.392, 0.42 + k * 0.07], [0.22, 0.392, 0.45 + k * 0.07], [-0.22, 0.392, 0.45 + k * 0.07]], EN.gunXDk);
  hazardStrip(b, -0.3, 0.72, 0.3, 0.72, 0.393, 0.08, 6);
  // headlights
  b.decal([[0.18, 0.3, -0.66], [0.26, 0.3, -0.66], [0.26, 0.27, -0.7], [0.18, 0.27, -0.7]], GL(EM.eyeOrange), [0, 0.6, -1]);
  b.decal([[-0.18, 0.3, -0.66], [-0.26, 0.3, -0.66], [-0.26, 0.27, -0.7], [-0.18, 0.27, -0.7]], GL(EM.eyeOrange), [0, 0.6, -1]);
  return b;
}
function buildTankTurret() {
  const b = new GB();
  const ring = (z, w, h) => [[-w, 0, z], [w, 0, z], [w * 1.04, h * 0.5, z], [w * 0.72, h, z], [-w * 0.72, h, z], [-w * 1.04, h * 0.5, z]];
  const t0 = b.n;
  b.loft([ring(-0.36, 0.2, 0.12), ring(-0.26, 0.3, 0.2), ring(0.22, 0.32, 0.21), ring(0.36, 0.26, 0.16)], (i, j) => {
    if (j === 0) return null;
    if (j === 3) return EN.olive;                                // dark olive top reads on tan dirt lanes
    if (j === 2 || j === 4) return i === 1 ? EN.sandLt : EN.oliveDk; // thin light rim
    return EN.oliveDk;
  }, EN.oliveDk, EN.oliveDk);
  const t1 = b.n;
  // barrel with muzzle brake
  b.lathe([0, 0.1, -0.3], [0, 0, -1], [[0, 0.062], [0.06, 0.05], [0.62, 0.042], [0.62, 0.058], [0.74, 0.058], [0.74, 0.03]], 6,
    (i) => (i === 3 ? EN.gunLt : i >= 2 ? EN.gunDk : EN.gun), null, EN.black, { phase: Math.PI / 6 });
  // commander hatch
  b.lathe([0.1, 0.2, 0.08], [0, 1, 0], [[0, 0.085], [0.04, 0.075], [0.055, 0.0]], 6, EN.oliveDk, null, null);
  // sensor eye (draped onto the roof: a flat decal at the roof height was buried and never showed)
  b.drape([[[-0.14, -0.25], [0.14, -0.25], [0.11, -0.18], [-0.11, -0.18]]], GL(EM.eyeRed), t0, t1, 0.005, 1);
  // hazard on the rear
  hazardStrip(b, -0.16, 0.3, 0.16, 0.3, 0.214, 0.06, 4);
  return b;
}

// =============================================================================
// TURRET — AA bunker on a concrete pad
// =============================================================================
function buildTurretBase() {
  const b = new GB();
  const oct = (r, ph = Math.PI / 8) => Array.from({ length: 8 }, (_, k) => [Math.cos(ph + (k * TAU) / 8) * r, Math.sin(ph + (k * TAU) / 8) * r]);
  b.plate(oct(0.94), 0, 0.14, EN.concrete, EN.concreteDk);
  // hazard ring (16 alternating segments)
  for (let k = 0; k < 16; k++) {
    const a0 = Math.PI / 8 + (k * TAU) / 16, a1 = Math.PI / 8 + ((k + 1) * TAU) / 16;
    const r0 = 0.74, r1 = 0.88, y = 0.141;
    const q = (r, a) => [Math.cos(a) * r, y, Math.sin(a) * r];
    b.decal([q(r0, a0), q(r1, a0), q(r1, a1), q(r0, a1)], k & 1 ? EN.black : EN.orange);
  }
  // corner bolts / light rim
  b.decal(oct(0.66).map(([x, z]) => [x, 0.142, z]), EN.pit);
  // armoured drum
  b.lathe([0, 0.14, 0], [0, 1, 0], [[0, 0.58], [0.16, 0.56], [0.2, 0.5], [0.27, 0.46]], 8,
    (i) => (i === 1 ? EN.edge : i === 0 ? EN.gunDk : EN.gun), null, EN.gunDk, { phase: Math.PI / 8 });
  return b;
}
function buildTurretHead() {
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.44], [0.12, 0.43], [0.22, 0.33], [0.28, 0.16], [0.29, 0.0]], 8,
    (i, j) => (i === 1 ? ((j === 1 || j === 2) ? EN.sandLt : EN.sand) : i === 0 ? EN.oliveDk : i === 2 ? EN.olive : EN.oliveLt),
    null, null, { phase: Math.PI / 8 });
  // barrel housing
  b.block({ x: 0, y: 0.06, z: -0.32, w: 0.42, d: 0.3, h: 0.17, tw: 0.36, td: 0.26, oz: 0.02, bev: 0.03, top: EN.gun, bevS: EN.edge, side: EN.gunDk, front: EN.gunXDk });
  for (const x of [-0.11, 0.11]) {
    b.lathe([x, 0.15, -0.44], [0, 0, -1], [[0, 0.05], [0.56, 0.04], [0.56, 0.052], [0.66, 0.052], [0.66, 0.02]], 6,
      (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black, { phase: Math.PI / 6 });
  }
  // sensor eye
  b.decal([[-0.07, 0.3, -0.25], [0.07, 0.3, -0.25], [0.05, 0.31, -0.16], [-0.05, 0.31, -0.16]], GL(EM.eyeRed), [0, 1, -0.4]);
  hazardStrip(b, -0.14, 0.22, 0.14, 0.22, 0.335, 0.08, 4);
  return b;
}

// =============================================================================
// GUNBOAT
// =============================================================================
function buildGunboatHull() {
  const b = new GB();
  const ring = ([z, w, dk, kl]) => [[0, dk + 0.02, z], [w, dk, z], [w * 0.97, 0.1, z], [w * 0.78, -0.08, z], [0, kl, z],
    [-w * 0.78, -0.08, z], [-w * 0.97, 0.1, z], [-w, dk, z]];
  const ST = [[-2.0, 0.02, 0.46, -0.02], [-1.62, 0.42, 0.4, -0.18], [-1.0, 0.7, 0.36, -0.22], [-0.2, 0.8, 0.34, -0.22],
    [1.0, 0.78, 0.34, -0.22], [1.7, 0.7, 0.34, -0.2], [2.0, 0.64, 0.34, -0.16]];
  const d0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    if (j === 0 || j === 7) return i === 0 ? EN.orange : EN.deckDk;   // deck plating (bow hazard)
    if (j === 1 || j === 6) return i === 0 ? EN.white : EN.navy;                          // topsides
    if (j === 2 || j === 5) return EN.hullRed;                                            // boot stripe
    return EN.navyDk;
  }, null, EN.navyDk);
  const d1 = b.n;
  // deck markings are draped onto the crowned deck (flat decals sank under its centre ridge)
  // bow hazard chevrons
  hazardDrape(b, -0.3, -1.45, 0.3, -1.45, 0.12, 5, EN.orange, EN.black, d0, d1, 0.009, 1);
  // walkway lines + bow marker
  b.drape([[[-0.68, -0.9], [-0.56, -0.9], [-0.56, 1.75], [-0.68, 1.75]], [[0.56, -0.9], [0.68, -0.9], [0.68, 1.75], [0.56, 1.75]]], EN.deck, d0, d1, 0.005, 1);
  b.drape([[[-0.22, -1.61], [0, -1.61], [0, -1.565], [-0.22, -1.565]], [[0, -1.61], [0.22, -1.61], [0.22, -1.565], [0, -1.565]]], EN.white, d0, d1, 0.005, 1);
  // bridge
  b.block({ x: 0, y: 0.34, z: 0.35, w: 0.9, d: 1.1, h: 0.34, tw: 0.8, td: 0.94, oz: 0.05, bev: 0.05, top: EN.white, bevS: EN.edgeLt, side: EN.deckDk, front: EN.deck });
  b.block({ x: 0, y: 0.68, z: 0.22, w: 0.62, d: 0.5, h: 0.16, tw: 0.5, td: 0.4, oz: 0.04, bev: 0.03, top: EN.edgeLt, bevS: EN.white, side: EN.deck });
  // glowing bridge windows
  b.decal([[-0.28, 0.8, -0.03], [0.28, 0.8, -0.03], [0.26, 0.74, -0.05], [-0.26, 0.74, -0.05]], GL(EM.eyeOrange), [0, 0.3, -1]);
  // mast + radar
  b.lathe([0, 0.84, 0.32], [0, 1, 0], [[0, 0.04], [0.4, 0.025]], 5, EN.gunDk, null, EN.gun);
  b.block({ x: 0, y: 1.14, z: 0.32, w: 0.46, d: 0.07, h: 0.05, top: EN.edgeLt, side: EN.gun });
  // funnel with warning band
  b.lathe([0, 0.34, 1.12], [0, 1, 0], [[0, 0.17], [0.22, 0.15], [0.28, 0.15], [0.34, 0.14]], 6,
    (i) => (i === 1 ? EN.orange : EN.gunDk), null, S(lin('#141414'), EM.emberDim.map((v) => v * 0.4)), { sx: 1, sy: 1.4 });
  // aft AA mount (static, facing aft)
  b.lathe([0, 0.34, 1.6], [0, 1, 0], [[0, 0.2], [0.1, 0.18], [0.14, 0.12]], 6, EN.gun, null, EN.gunLt);
  for (const x of [-0.06, 0.06]) b.lathe([x, 0.44, 1.64], [0, 0, 1], [[0, 0.03], [0.4, 0.025]], 5, EN.gunDk, null, EN.black);
  // life rafts (orange canisters) + ammo lockers either side of the bridge
  for (const sg of [-1, 1]) {
    for (const z of [-0.05, 0.28, 0.61]) b.lathe([0.58 * sg, 0.4, z - 0.12], [0, 0, 1], [[0, 0.055], [0.24, 0.055]], 5, (i, j) => (j <= 1 ? EN.orange : EN.orangeDk), EN.white, null, { phase: Math.PI / 2 });
    b.block({ x: 0.5 * sg, y: 0.34, z: -0.62, w: 0.22, d: 0.3, h: 0.14, bev: 0.02, top: EN.navy, bevS: EN.edge, side: EN.navyDk });
    b.block({ x: 0.5 * sg, y: 0.34, z: 1.35, w: 0.2, d: 0.34, h: 0.12, bev: 0.02, top: EN.gunLt, bevS: EN.edge, side: EN.gunDk });
  }
  // stern: depth-charge racks, hazard band, light
  for (const sg of [-1, 1]) {
    b.block({ x: 0.32 * sg, y: 0.34, z: 1.78, w: 0.3, d: 0.16, h: 0.1, top: EN.gunLt, side: EN.gunDk });
    b.decal([[0.24 * sg, 0.442, 1.72], [0.28 * sg, 0.442, 1.72], [0.28 * sg, 0.442, 1.84], [0.24 * sg, 0.442, 1.84]], EN.gunXDk);
    b.decal([[0.36 * sg, 0.442, 1.72], [0.4 * sg, 0.442, 1.72], [0.4 * sg, 0.442, 1.84], [0.36 * sg, 0.442, 1.84]], EN.gunXDk);
  }
  hazardDrape(b, -0.55, 1.93, 0.55, 1.93, 0.07, 7, EN.orange, EN.black, d0, d1, 0.005, 1);
  b.drape([[[-0.09, 1.815], [0.09, 1.815], [0.09, 1.855], [-0.09, 1.855]]], GL(EM.eyeRed), d0, d1, 0.006, 1);
  return b;
}
function buildGunboatTurret() {
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.34], [0.08, 0.33], [0.12, 0.26]], 8, (i) => (i === 0 ? EN.gun : EN.edge), null, EN.gun, { phase: Math.PI / 8 });
  b.block({ x: 0, y: 0.1, z: 0.02, w: 0.44, d: 0.5, h: 0.2, tw: 0.36, td: 0.4, oz: 0.03, bev: 0.03, top: EN.deck, bevS: EN.edgeLt, side: EN.deckDk, front: EN.gunDk });
  for (const x of [-0.08, 0.08]) {
    b.lathe([x, 0.2, -0.2], [0, 0, -1], [[0, 0.045], [0.52, 0.036], [0.52, 0.046], [0.6, 0.046], [0.6, 0.02]], 6,
      (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black, { phase: Math.PI / 6 });
  }
  b.decal([[-0.12, 0.305, -0.16], [0.12, 0.305, -0.16], [0.1, 0.305, -0.1], [-0.1, 0.305, -0.1]], GL(EM.eyeRed));
  return b;
}

// =============================================================================
// CARRIER — friendly-looking item transport
// =============================================================================
function buildCarrier() {
  const b = new GB();
  const ring = ([z, w, h, yc]) => {
    const r = [];
    for (let k = 0; k < 8; k++) { const th = Math.PI / 8 + (k * TAU) / 8; r.push([Math.cos(th) * w, yc + Math.sin(th) * h, z]); }
    return r;
  };
  const ST = [[-1.0, 0.1, 0.08, 0.02], [-0.9, 0.3, 0.24, 0.03], [-0.62, 0.42, 0.32, 0.04], [0.5, 0.42, 0.32, 0.04],
    [0.8, 0.3, 0.24, 0.06], [1.0, 0.16, 0.12, 0.08]];
  const c0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    const top = j === 1 || j === 2, upper = j === 0 || j === 3;
    if (top) return EN.yellow;
    if (upper) return i === 0 ? EN.yellow : EN.yellowDk;
    return EN.khaki;
  }, EN.khaki, EN.khaki);
  const c1 = b.n;
  // olive chevrons across the back (friendly "cargo" livery)
  for (let k = 0; k < 3; k++) {
    const z = -0.3 + k * 0.28, y = 0.362;
    b.decal([[-0.16, y, z + 0.12], [0, y, z], [0, y, z + 0.1], [-0.16, y, z + 0.22]], EN.khaki);
    b.decal([[0.16, y, z + 0.12], [0, y, z], [0, y, z + 0.1], [0.16, y, z + 0.22]], EN.khaki);
  }
  // big friendly cockpit
  b.lathe([0, 0.14, -0.66], [0, 0.35, -1], [[0, 0.22], [0.1, 0.19], [0.2, 0.11], [0.25, 0.0]], 8,
    (i, j) => (j === 1 || j === 2 ? S(lin('#7fe7ff'), rgb(0.05, 0.3, 0.4)) : S(lin('#2aa9d6'), rgb(0.01, 0.1, 0.16))), null, null, { phase: Math.PI / 8, sy: 0.8 });
  // cabin windows along the shoulders (draped onto the sloped shoulder facet; flat quads floated ~7 cm off it)
  const WIN = S(lin('#2aa9d6'), rgb(0.02, 0.12, 0.2)), winQ = [];
  for (const sg of [-1, 1]) for (let k = 0; k < 3; k++) {
    const z = -0.5 + k * 0.14;
    winQ.push([[0.21 * sg, z], [0.35 * sg, z], [0.35 * sg, z + 0.08], [0.21 * sg, z + 0.08]]);
  }
  b.drape(winQ, WIN, c0, c1, 0.004, 1);
  // cargo hatch outline
  b.decal([[-0.2, 0.362, 0.55], [0.2, 0.362, 0.55], [0.2, 0.362, 0.62], [-0.2, 0.362, 0.62]], EN.yellowDk);
  // tail
  b.block({ x: 0, y: 0.18, z: 0.92, w: 0.05, d: 0.26, h: 0.26, td: 0.14, oz: 0.06, top: EN.yellow, side: EN.khaki });
  const f0 = b.n;
  // stub wing
  b.wing([{ x: 0.36, y: 0.06, zl: -0.14, zt: 0.26, t: 0.08 }, { x: 0.56, y: 0.08, zl: -0.12, zt: 0.24, t: 0.06 }],
    (i, j) => (j >= 4 ? EN.khaki : j === 0 ? EN.white : EN.yellow), null, EN.khaki);
  // ducted lift fan ring
  b.lathe([0.8, -0.06, 0.06], [0, 1, 0], [[0, 0.32], [0.06, 0.34], [0.18, 0.32], [0.2, 0.27], [0.02, 0.26]], 12,
    (i, j) => (i === 1 ? (j % 3 === 0 ? EN.khaki : EN.yellow) : i === 2 ? EN.edge : i === 3 ? EN.khaki : EN.yellowDk), null, null);
  // beacon on duct
  b.block({ x: 1.13, y: 0.1, z: 0.06, w: 0.06, d: 0.1, h: 0.05, top: GL(EM.green), side: GL(EM.green, 0.5) });
  // tailplane
  b.wing([{ x: 0.05, y: 0.12, zl: 0.78, zt: 1.0, t: 0.03 }, { x: 0.36, y: 0.14, zl: 0.86, zt: 1.02, t: 0.02 }],
    (i, j) => (j === 0 ? EN.white : EN.yellow), null, EN.khaki);
  // engine glows on the rear of the body
  b.decal([[0.12, 0.24, 0.98], [0.2, 0.22, 0.97], [0.2, 0.18, 0.99], [0.12, 0.2, 1.0]], GL(scl(EM.amber, 0.6)), [0, 0, 1]);
  b.mirrorX(f0);
  return b;
}
function buildCarrierFan() {
  const b = new GB();
  for (let k = 0; k < 5; k++) {
    const f = b.n;
    b.block({ x: 0.14, y: 0, z: 0, w: 0.24, d: 0.07, h: 0.018, top: EN.gunDk, side: EN.gunXDk });
    b.xform(f, M(0, 0, 0, 0.35, (k * TAU) / 5, 0));
  }
  b.lathe([0, -0.02, 0], [0, 1, 0], [[0, 0.07], [0.05, 0.06], [0.07, 0.0]], 6, (i, j) => (j & 1 ? EN.gunLt : GL(scl(EM.amber, 0.4), 0.4)));
  return b;
}

// =============================================================================
// BOMBER — heavy wide-wing bomber, 4 glowing engines
// =============================================================================
function buildBomber() {
  const b = new GB();
  const ring = ([z, w, tp, bt]) => [[0, tp, z], [w * 0.5, tp * 0.9, z], [w, tp * 0.35, z], [w, -bt * 0.3, z], [w * 0.55, -bt, z],
    [-w * 0.55, -bt, z], [-w, -bt * 0.3, z], [-w, tp * 0.35, z], [-w * 0.5, tp * 0.9, z]];
  const ST = [[-1.78, 0.02, 0.02, 0.02], [-1.6, 0.16, 0.14, 0.1], [-1.3, 0.3, 0.26, 0.2], [-0.8, 0.38, 0.32, 0.26],
    [-0.76, 0.38, 0.32, 0.26], [0.4, 0.38, 0.3, 0.26], [0.44, 0.38, 0.3, 0.26], [1.2, 0.3, 0.24, 0.22], [1.72, 0.16, 0.16, 0.14]];
  const s0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    const line = i === 3 || i === 5;
    if (i === 0) return EN.gunDk;
    if (j === 0 || j === 8) return line ? EN.gunXDk : EN.gunLt;
    if (j === 1 || j === 7) return line ? EN.gunXDk : EN.edge;
    if (j === 2 || j === 6) return EN.gun;
    return EN.gunXDk;
  }, null, EN.gunDk);
  const s1 = b.n;
  // menacing eye slits on the nose (draped: flat quads half-sank into the curved nose)
  //  kept inside the top facet (|x| < ½·halfwidth) so the quad never spans the shoulder crease
  b.drape([[[0.03, -1.41], [0.135, -1.35], [0.14, -1.27], [0.03, -1.32]], [[-0.03, -1.32], [-0.14, -1.27], [-0.135, -1.35], [-0.03, -1.41]]],
    GL(EM.eyeRed), s0, s1, 0.008, 1);
  // dorsal turret
  b.lathe([0, 0.3, -0.4], [0, 1, 0], [[0, 0.2], [0.07, 0.18], [0.12, 0.1]], 8, EN.gunDk, null, EN.gun, { phase: Math.PI / 8 });
  b.decal([[-0.05, 0.43, -0.52], [0.05, 0.43, -0.52], [0.05, 0.43, -0.44], [-0.05, 0.43, -0.44]], GL(EM.eyeOrange));
  for (const x of [-0.05, 0.05]) b.lathe([x, 0.38, -0.5], [0, 0, -1], [[0, 0.025], [0.3, 0.02]], 5, EN.gunXDk, null, EN.black);
  // spine hazard (draped onto the tapering spine)
  hazardDrape(b, 0, 0.55, 0, 1.05, 0.16, 5, EN.orange, EN.black, s0, s1, 0.017, 1);   // lift covers the ridge sag of 1-cell quads
  const f0 = b.n;
  // big swept wing
  b.wing([{ x: 0.3, y: -0.02, zl: -0.62, zt: 0.72, t: 0.13 }, { x: 1.35, y: 0.02, zl: -0.07, zt: 0.82, t: 0.1 },
    { x: 1.4, y: 0.02, zl: -0.04, zt: 0.82, t: 0.1 }, { x: 2.2, y: 0.07, zl: 0.38, zt: 0.94, t: 0.06 }, { x: 2.52, y: 0.09, zl: 0.62, zt: 0.98, t: 0.04 }],
  (i, j) => {
    if (j >= 4) return EN.gunXDk;
    if (i === 1) return j === 0 ? EN.edge : EN.gunXDk;                            // panel line
    if (i === 3) return j === 3 ? EN.black : ((j & 1) ? EN.black : EN.orange);   // hazard tip
    if (j === 0) return EN.edgeLt;
    if (j === 3) return EN.gunDk;
    return i === 2 ? EN.gunLt : EN.gun;
  }, null, EN.orange);
  // engine nacelles
  for (const x of [0.95, 1.75]) {
    b.lathe([x, -0.06, -0.7], [0, 0, 1], [[0, 0.1], [0.08, 0.165], [1.3, 0.16], [1.55, 0.12], [1.62, 0.12]], 6, (i, j) => {
      if (i === 0) return EN.edgeLt;
      if (i === 2) return EN.gunDk;
      return (j === 1) ? EN.gunLt : EN.gun;
    }, EN.gunXDk, GL(EM.engineHot, 0.6), { phase: Math.PI / 6 });
    b.lathe([x, -0.06, 0.92], [0, 0, 1], [[0, 0.1], [0.34, 0.0]], 6, GL(EM.engine, 0.5));
  }
  // tail fins + tailplane
  const f1 = b.n;
  b.wing([{ x: 0, zl: 1.1, zt: 1.72, t: 0.06 }, { x: 0.46, zl: 1.4, zt: 1.78, t: 0.03 }], (i, j) => (j === 0 ? EN.edge : EN.gunDk), null, EN.orange);
  b.xform(f1, M(0.22, 0.18, 0, 0, 0, 58 * DEG));
  b.wing([{ x: 0.15, y: 0.02, zl: 1.2, zt: 1.72, t: 0.05 }, { x: 0.95, y: 0.06, zl: 1.5, zt: 1.8, t: 0.03 }],
    (i, j) => (j >= 4 ? EN.gunXDk : j === 0 ? EN.edge : EN.gun), null, EN.gunDk);
  b.mirrorX(f0);
  return b;
}

// =============================================================================
// CRAWLER — mid-boss siege tank (6 × 5)
// =============================================================================
const CR_TRACK = { treadA: lit('#4a4c4f'), treadB: lit('#2a2b2e'), side: lit('#303236'), sideB: lit('#3f4145'), bottom: lit('#1a1b1d'), end: lit('#393b3f') };
function buildCrawlerHull() {
  const b = new GB();
  trackLoft(b, 2.35, 1.15, 1.0, -2.5, 2.5, 13, CR_TRACK);
  trackLoft(b, -2.35, 1.15, 1.0, -2.5, 2.5, 13, CR_TRACK);
  // armoured skirts over the outer track edge
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z = -1.8 + k * 1.2;
      b.block({ x: 2.98 * s, y: 0.35, z, w: 0.12, d: 1.1, h: 0.62, tw: 0.08, td: 1.04, top: EN.sandLt, side: k & 1 ? EN.sandDk : EN.sand });
    }
    hazardStrip(b, 2.35 * s - 0.5, -2.28, 2.35 * s + 0.5, -2.28, 1.005, 0.2, 6);
  }
  // lower hull
  const ring = (z, w, lo, hi) => [[-w, lo, z], [w, lo, z], [w + 0.05, hi - 0.18, z], [w - 0.18, hi, z], [-w + 0.18, hi, z], [-w - 0.05, hi - 0.18, z]];
  b.loft([ring(-2.45, 1.3, 0.3, 0.7), ring(-1.9, 1.72, 0.22, 1.18), ring(2.1, 1.72, 0.22, 1.18), ring(2.4, 1.55, 0.3, 0.95)], (i, j) => {
    if (j === 0) return null;
    if (j === 3) return i === 0 ? EN.sandLt : EN.sand;
    if (j === 2 || j === 4) return EN.edgeLt;
    return EN.sandDk;
  }, EN.sandDk, EN.sandDk);
  // front hazard + glowing sensor slits (eyes)
  hazardStrip(b, -1.25, -2.2, 1.25, -2.2, 0.72, 0.22, 10, [0, 1, -0.9]);
  for (const s of [-1, 1]) {
    b.decal([[0.55 * s, 1.0, -1.98], [1.15 * s, 1.0, -1.98], [1.1 * s, 0.94, -2.06], [0.6 * s, 0.94, -2.06]], GL(EM.eyeRed), [0, 0.5, -1]);
  }
  // raised armour plates on deck + camo + plate seams
  b.block({ x: 0, y: 1.18, z: -1.4, w: 2.4, d: 0.9, h: 0.1, tw: 2.2, td: 0.78, top: EN.sand, side: EN.edge });
  const CAMO = [lit('#8a7a4e'), lit('#6f7a45')];
  const camo = [[[-1.5, -0.6], [-0.7, -0.9], [-0.5, -0.2], [-1.3, 0.1]], [[0.8, 0.3], [1.55, 0.1], [1.5, 0.9], [0.9, 1.1]],
    [[-1.4, 0.9], [-0.9, 0.7], [-0.8, 1.2], [-1.5, 1.3]], [[1.0, -1.0], [1.5, -1.1], [1.55, -0.5], [1.1, -0.45]]];
  camo.forEach((q, k) => b.decal(q.map(([x, z]) => [x, 1.183, z]), CAMO[k & 1]));
  for (const z of [-0.85, 1.3]) b.decal([[-1.52, 1.184, z], [1.52, 1.184, z], [1.52, 1.184, z + 0.04], [-1.52, 1.184, z + 0.04]], EN.sandDk);
  for (const sg of [-1, 1]) b.decal([[1.52 * sg, 1.184, -1.85], [1.56 * sg, 1.184, -1.85], [1.56 * sg, 1.184, 2.0], [1.52 * sg, 1.184, 2.0]], EN.edgeLt);
  // rear engine deck: vents with glow
  for (let k = 0; k < 5; k++) {
    const z = 1.45 + k * 0.16;
    const vs = k === 2 ? GL(scl(EM.engine, 0.5), 0.3) : EN.gunXDk;
    b.decal([[-1.2, 1.185, z], [-0.2, 1.185, z], [-0.2, 1.185, z + 0.08], [-1.2, 1.185, z + 0.08]], vs);
    b.decal([[0.2, 1.185, z], [1.2, 1.185, z], [1.2, 1.185, z + 0.08], [0.2, 1.185, z + 0.08]], vs);
  }
  // exhaust stacks
  for (const s of [-1, 1]) {
    b.lathe([1.45 * s, 1.1, 2.0], [0, 1, 0], [[0, 0.2], [0.5, 0.18], [0.55, 0.2], [0.62, 0.2]], 6, (i) => (i === 1 ? EN.gunLt : EN.gunDk), null, S(lin('#161412'), EM.emberDim.map((v) => v * 0.66)));
  }
  // sponson mounts for the side guns
  for (const s of [-1, 1]) b.lathe([1.45 * s, 1.1, -1.55], [0, 1, 0], [[0, 0.52], [0.1, 0.5]], 8, EN.gunDk, null, EN.gun, { phase: Math.PI / 8 });
  return b;
}
function buildCrawlerTurret() {
  const b = new GB();
  const oct = (r, y, sc = 1) => Array.from({ length: 8 }, (_, k) => {
    const a = Math.PI / 8 + (k * TAU) / 8; return [Math.cos(a) * r, y, Math.sin(a) * r * sc];
  });
  b.loft([oct(1.3, 0, 1.0), oct(1.28, 0.3, 1.0), oct(1.08, 0.55, 0.95), oct(0.7, 0.62, 0.9)], (i, j) => {
    if (i === 0) return (j & 1) ? EN.sandDk : EN.sand;
    if (i === 1) return (j === 1 || j === 2) ? EN.sandLt : EN.sand;
    return EN.sandLt;
  }, null, EN.sand);
  // main cannon mantlet + twin rail barrels
  b.block({ x: 0, y: 0.1, z: -1.2, w: 1.1, d: 0.6, h: 0.42, tw: 0.9, td: 0.5, oz: 0.04, bev: 0.06, top: EN.gun, bevS: EN.edge, side: EN.gunDk, front: EN.gunXDk });
  for (const x of [-0.26, 0.26]) {
    b.lathe([x, 0.3, -1.45], [0, 0, -1], [[0, 0.17], [0.3, 0.15], [0.35, 0.15], [0.45, 0.15], [0.8, 0.14], [0.85, 0.14], [0.95, 0.14], [1.4, 0.13], [1.45, 0.13], [1.55, 0.13], [1.75, 0.16], [1.95, 0.16], [1.95, 0.08]], 8, (i, j) => {
      if (i === 2 || i === 5 || i === 8) return GL(scl(EM.eyeOrange, 0.6), 0.4);   // glowing coils
      if (i === 10) return EN.edge;
      return (j === 1 || j === 2) ? EN.gunLt : EN.gunDk;
    }, null, GL(EM.eyeRed, 0.3), { phase: Math.PI / 8 });
  }
  // camo patches + engine grille on the turret roof
  b.decal([[-0.65, 0.626, -0.2], [-0.2, 0.626, -0.35], [-0.1, 0.626, 0.1], [-0.55, 0.626, 0.25]], lit('#8a7a4e'));
  b.decal([[0.15, 0.626, 0.35], [0.6, 0.626, 0.2], [0.62, 0.626, 0.6], [0.25, 0.626, 0.7]], lit('#6f7a45'));
  for (let k = 0; k < 3; k++) b.decal([[-0.45, 0.627, 0.45 + k * 0.1], [-0.05, 0.627, 0.45 + k * 0.1], [-0.05, 0.627, 0.49 + k * 0.1], [-0.45, 0.627, 0.49 + k * 0.1]], EN.gunXDk);
  // eye strip + hatch + hazard on turret rear
  b.decal([[-0.5, 0.63, -0.52], [0.5, 0.63, -0.52], [0.44, 0.63, -0.4], [-0.44, 0.63, -0.4]], GL(EM.eyeRed));
  b.lathe([0.35, 0.62, 0.25], [0, 1, 0], [[0, 0.24], [0.06, 0.22], [0.09, 0.0]], 6, EN.oliveDk);
  hazardStrip(b, -0.6, 0.95, 0.6, 0.95, 0.625, 0.18, 6);
  return b;
}
function buildCrawlerGun() {
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.48], [0.14, 0.46], [0.24, 0.34], [0.28, 0.0]], 8,
    (i, j) => (i === 1 ? ((j === 1 || j === 2) ? EN.sandLt : EN.sand) : i === 0 ? EN.sandDk : EN.sandLt), null, null, { phase: Math.PI / 8 });
  for (const x of [-0.12, 0.12]) {
    b.lathe([x, 0.14, -0.3], [0, 0, -1], [[0, 0.07], [0.6, 0.055], [0.6, 0.07], [0.72, 0.07], [0.72, 0.03]], 6,
      (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black, { phase: Math.PI / 6 });
  }
  b.decal([[-0.1, 0.285, -0.2], [0.1, 0.285, -0.2], [0.08, 0.285, -0.1], [-0.08, 0.285, -0.1]], GL(EM.eyeRed));
  return b;
}

export function createEnemy(type) {
  switch (type) {
    case 'dart': {
      const { g, pivot, ud } = enemyShell('dart', 0.6, '#48505b');
      const mat = bodyMat(0.55, 0.3);
      pivot.add(new THREE.Mesh(GG('dart', buildDart), mat));
      ud.muzzles = [new THREE.Vector3(0, 0, -0.68)];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => { mat.uEmitScale.value = 0.85 + Math.sin(t * 17) * 0.15; pivot.rotation.z = Math.sin(t * 2.3) * 0.06; };
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'hornet': {
      const { g, pivot, ud } = enemyShell('hornet', 0.8, '#5f6b3a');
      const mat = bodyMat(0.6, 0.2);
      pivot.add(new THREE.Mesh(GG('hornet', buildHornet), mat));
      const rotor = new THREE.Group(); rotor.name = 'rotor'; rotor.position.set(0, 0.46, -0.02);
      rotor.add(new THREE.Mesh(GG('hornet.blades', buildRotorBlades), mat));
      const discMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const disc = new THREE.Mesh(G('hornet.disc', buildRotorDisc), discMat); disc.userData.noShadow = true; disc.renderOrder = 1;
      rotor.add(disc);
      pivot.add(rotor);
      ud.rotor = rotor;
      ud.muzzles = [new THREE.Vector3(-0.76, 0.04, -0.62), new THREE.Vector3(0.76, 0.04, -0.62)];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        rotor.rotation.y -= dt * 24;
        pivot.position.y = Math.sin(t * 3.1) * 0.05;
        pivot.rotation.x = Math.sin(t * 2.2) * 0.04;
        mat.uEmitScale.value = 0.8 + Math.sin(t * 6) * 0.2;
      };
      ud.dispose = () => { mat.dispose(); discMat.dispose(); };
      return g;
    }
    case 'tank': {
      const { g, pivot, ud } = enemyShell('tank', 0.7, '#5f6b3a');
      const mat = bodyMat(0.72, 0.15);
      pivot.add(new THREE.Mesh(GG('tank.hull', buildTankHull), mat));
      const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.39, 0.06);
      turret.add(new THREE.Mesh(GG('tank.turret', buildTankTurret), mat));
      pivot.add(turret);
      ud.turret = turret;
      const local = [new THREE.Vector3(0, 0.1, -1.06)];
      turret.userData.muzzles = local;
      ud.muzzles = [new THREE.Vector3()];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => { syncMuzzles(ud.muzzles, local, turret); mat.uEmitScale.value = 0.8 + Math.sin(t * 5) * 0.2; };
      syncMuzzles(ud.muzzles, local, turret);
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'turret': {
      const { g, pivot, ud } = enemyShell('turret', 0.8, '#9c9b93');
      const mat = bodyMat(0.75, 0.12);
      pivot.add(new THREE.Mesh(GG('turret.base', buildTurretBase), mat));
      const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.41, 0);
      turret.add(new THREE.Mesh(GG('turret.head', buildTurretHead), mat));
      pivot.add(turret);
      ud.turret = turret;
      const local = [new THREE.Vector3(-0.11, 0.15, -1.12), new THREE.Vector3(0.11, 0.15, -1.12)];
      turret.userData.muzzles = local;
      ud.muzzles = [new THREE.Vector3(), new THREE.Vector3()];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => { syncMuzzles(ud.muzzles, local, turret); mat.uEmitScale.value = 0.75 + Math.sin(t * 4) * 0.25; };
      syncMuzzles(ud.muzzles, local, turret);
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'gunboat': {
      const { g, pivot, ud } = enemyShell('gunboat', 1.1, '#465363');
      ud.halfExtents = { x: 0.8, z: 2.0 };
      const mat = bodyMat(0.65, 0.2);
      pivot.add(new THREE.Mesh(GG('gunboat.hull', buildGunboatHull), mat));
      const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.36, -1.05);
      turret.add(new THREE.Mesh(GG('gunboat.turret', buildGunboatTurret), mat));
      pivot.add(turret);
      ud.turret = turret;
      const local = [new THREE.Vector3(-0.08, 0.2, -0.82), new THREE.Vector3(0.08, 0.2, -0.82)];
      turret.userData.muzzles = local;
      ud.muzzles = [new THREE.Vector3(), new THREE.Vector3()];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        syncMuzzles(ud.muzzles, local, turret);
        pivot.rotation.z = Math.sin(t * 1.3) * 0.025; pivot.rotation.x = Math.sin(t * 0.9) * 0.012;
        mat.uEmitScale.value = 0.85 + Math.sin(t * 3) * 0.15;
      };
      syncMuzzles(ud.muzzles, local, turret);
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'carrier': {
      const { g, pivot, ud } = enemyShell('carrier', 1.0, '#f2c02a');
      const mat = bodyMat(0.55, 0.15);
      pivot.add(new THREE.Mesh(GG('carrier', buildCarrier), mat));
      const fanGeo = GG('carrier.fan', buildCarrierFan);
      const fanL = new THREE.Mesh(fanGeo, mat), fanR = new THREE.Mesh(fanGeo, mat);
      fanL.position.set(-0.8, 0.0, 0.06); fanR.position.set(0.8, 0.0, 0.06);
      pivot.add(fanL, fanR);
      ud.muzzles = [new THREE.Vector3(0, 0, -1.0)];
      ud.fans = [fanL, fanR];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        fanL.rotation.y += dt * 18; fanR.rotation.y -= dt * 18;
        pivot.position.y = Math.sin(t * 2) * 0.06;
        pivot.rotation.z = Math.sin(t * 1.4) * 0.05;
        mat.uEmitScale.value = (Math.sin(t * 5) > 0.3 ? 1.25 : 0.55);
      };
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'bomber': {
      const { g, pivot, ud } = enemyShell('bomber', 1.9, '#48505b');
      ud.halfExtents = { x: 2.5, z: 1.7 };
      const mat = bodyMat(0.6, 0.3);
      pivot.add(new THREE.Mesh(GG('bomber', buildBomber), mat));
      ud.muzzles = [new THREE.Vector3(0, 0.38, -0.84), new THREE.Vector3(-0.95, -0.06, -0.78), new THREE.Vector3(0.95, -0.06, -0.78)];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        mat.uEmitScale.value = 0.9 + Math.sin(t * 23) * 0.06 + Math.sin(t * 2) * 0.1;
        pivot.rotation.z = Math.sin(t * 0.9) * 0.03;
      };
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'crawler': return createCrawler();
    default: {
      if (!own(EXT_ENEMIES, type)) throw new Error(`models.createEnemy: unknown type "${type}"`);
      const g = EXT_ENEMIES[type]();
      g.userData.kind = type;
      return g;
    }
  }
}

function createCrawler() {
  const { g, pivot, ud } = enemyShell('crawler', 2.6, '#b9a878');
  ud.halfExtents = { x: 3.0, z: 2.5 };
  const hullMat = bodyMat(0.72, 0.18);
  pivot.add(new THREE.Mesh(GG('crawler.hull', buildCrawlerHull), hullMat));
  const mkPart = (key, build, name, radius, pos, muzzles, wreck, sag) =>
    destructiblePart({ key, build, name, radius, pos, muzzles, wreck, sag, mat: bodyMat(0.68, 0.2) });
  const turret = mkPart('crawler.turret', buildCrawlerTurret, 'turret', 1.2, new THREE.Vector3(0, 1.18, 0.45),
    [new THREE.Vector3(-0.26, 0.3, -3.42), new THREE.Vector3(0.26, 0.3, -3.42)],
    { keep: (x, y, z) => 1.9 + z, crumple: 0.12, seed: 3, dir: [0, 0, -1], shards: 12, shardSize: 0.3, band: 0.5 }, [0.04, -0.04, 0.02]);
  const gunL = mkPart('crawler.gun', buildCrawlerGun, 'gunL', 0.6, new THREE.Vector3(-1.45, 1.2, -1.55),
    [new THREE.Vector3(-0.12, 0.14, -1.04), new THREE.Vector3(0.12, 0.14, -1.04)],
    { keep: (x, y, z) => 0.45 + z, crumple: 0.08, seed: 5, dir: [0, 0, -1], shards: 7, shardSize: 0.16, band: 0.3 }, [0.1, -0.05, 0.08]);
  const gunR = mkPart('crawler.gun', buildCrawlerGun, 'gunR', 0.6, new THREE.Vector3(1.45, 1.2, -1.55),
    [new THREE.Vector3(-0.12, 0.14, -1.04), new THREE.Vector3(0.12, 0.14, -1.04)],
    { keep: (x, y, z) => 0.45 + z, crumple: 0.08, seed: 5, dir: [0, 0, -1], shards: 7, shardSize: 0.16, band: 0.3 }, [0.1, -0.05, -0.08]);
  pivot.add(turret, gunL, gunR);
  ud.parts = { turret, gunL, gunR };
  ud.turret = turret;
  const mats = [hullMat, ...turret.userData.materials, ...gunL.userData.materials, ...gunR.userData.materials];
  ud.setFlash = flashFn(mats);
  ud.muzzles = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const sync = () => {
    const tm = turret.userData.muzzles, lm = gunL.userData.muzzles, rm = gunR.userData.muzzles;
    const o = ud.muzzles;
    syncMuzzles(TMP_MUZ2, tm, turret); o[0].copy(TMP_MUZ2[0]); o[1].copy(TMP_MUZ2[1]);
    syncMuzzles(TMP_MUZ2, lm, gunL); o[2].copy(TMP_MUZ2[0]); o[3].copy(TMP_MUZ2[1]);
    syncMuzzles(TMP_MUZ2, rm, gunR); o[4].copy(TMP_MUZ2[0]); o[5].copy(TMP_MUZ2[1]);
  };
  sync();
  ud.update = (dt, t) => {
    sync();
    const p = 0.8 + Math.sin(t * 4) * 0.2;
    for (let i = 0; i < mats.length; i++) mats[i].uEmitScale.value = p;
  };
  ud.dispose = () => { for (const m of mats) m.dispose(); };
  return g;
}
const TMP_MUZ2 = [new THREE.Vector3(), new THREE.Vector3()];

// =============================================================================
// BOSS — flying fortress "ARCLIGHT"
// =============================================================================
function buildBossHull() {
  const b = new GB();
  // ---- central spine (8-sided armoured section)
  const ring = ([z, w, tp, bt]) => [[-w * 0.45, tp, z], [w * 0.45, tp, z], [w, tp * 0.5, z], [w, -bt * 0.4, z], [w * 0.55, -bt, z],
    [-w * 0.55, -bt, z], [-w, -bt * 0.4, z], [-w, tp * 0.5, z]];
  const ST = [[-4.2, 0.2, 0.12, 0.1], [-3.55, 0.85, 0.4, 0.3], [-2.6, 1.35, 0.58, 0.42], [-2.5, 1.38, 0.59, 0.42],
    [-1.4, 1.7, 0.66, 0.48], [2.4, 1.78, 0.66, 0.5], [2.5, 1.76, 0.65, 0.5], [3.5, 1.6, 0.58, 0.45], [4.1, 1.45, 0.5, 0.4]];
  const s0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    const line = i === 2 || i === 5;
    if (j === 0) return line ? BO.black : (i <= 1 ? BO.panel : BO.plate);
    if (j === 1 || j === 7) return line ? BO.steelDk : BO.trim;           // lit bevels outline the spine
    if (j === 2 || j === 6) return BO.steel;
    return BO.steelXDk;
  }, null, BO.steelDk);
  const s1 = b.n;
  // prow "face": two slanted magenta eye slits
  for (const sg of [-1, 1]) b.drape([[[0.08 * sg, -3.42], [0.46 * sg, -3.02], [0.4 * sg, -2.9], [0.06 * sg, -3.24]]], GL(EM.magenta), s0, s1, 0.006, 2);
  hazardDrape(b, -0.5, -2.62, 0.5, -2.62, 0.16, 7, BO.hazard, BO.black, s0, s1);
  // front armour wedge + crest
  b.block({ x: 0, y: 0.56, z: -1.85, w: 1.7, d: 1.3, h: 0.2, tw: 1.3, td: 1.05, oz: 0.08, bev: 0.06, top: BO.panel, bevS: BO.trimLt, side: BO.steel });
  b.block({ x: 0, y: 0.64, z: -0.85, w: 0.3, d: 0.8, h: 0.16, tw: 0.2, td: 0.7, bev: 0.03, top: GL(scl(EM.magenta, 0.8), 0.4), bevS: BO.trim, side: BO.steelDk });
  // dorsal spikes along the spine shoulders
  for (const sg of [-1, 1]) for (const z of [-1.3, -0.35, 2.05, 2.75]) {
    const x = 1.45 * sg, y = 0.5;
    b.spike([[x - 0.12, y, z - 0.22], [x + 0.12, y, z - 0.22], [x + 0.12 * sg, y, z + 0.22], [x - 0.12 * sg, y, z + 0.18]], [x + 0.22 * sg, y + 0.42, z + 0.1], (k) => (k & 1 ? BO.trim : BO.steel));
  }
  // rear armour deck with violet vents
  b.block({ x: 0, y: 0.6, z: 3.05, w: 2.6, d: 1.3, h: 0.2, tw: 2.4, td: 1.1, bev: 0.05, top: BO.plate, bevS: BO.trim, side: BO.steel });
  for (let k = 0; k < 4; k++) {
    const z = 2.7 + k * 0.2;
    b.decal([[-1.0, 0.802, z], [-0.25, 0.802, z], [-0.25, 0.802, z + 0.09], [-1.0, 0.802, z + 0.09]], k & 1 ? BO.black : GL(EM.violet, 0.3));
    b.decal([[0.25, 0.802, z], [1.0, 0.802, z], [1.0, 0.802, z + 0.09], [0.25, 0.802, z + 0.09]], k & 1 ? BO.black : GL(EM.violet, 0.3));
  }
  // ---- engine block + 5 nozzles
  b.block({ x: 0, y: -0.35, z: 3.9, w: 4.0, d: 0.9, h: 0.8, tw: 3.8, td: 0.8, bev: 0.08, top: BO.plate, bevS: BO.trim, side: BO.steelDk, back: BO.steelXDk });
  for (const x of [-1.5, -0.75, 0, 0.75, 1.5]) {
    b.lathe([x, 0.05, 4.1], [0, 0, 1], [[0, 0.3], [0.2, 0.33], [0.3, 0.33], [0.36, 0.29], [0.5, 0.26], [0.5, 0.17]], 8,
      (i, j) => (i === 1 ? ((j === 1 || j === 2) ? BO.trimLt : BO.trim) : i === 3 ? BO.steelDk : BO.steel), null, GL(EM.violet, 0.6), { phase: Math.PI / 8 });
  }
  const f0 = b.n;
  // ---- inner wing (static)
  b.wing([{ x: 1.5, y: -0.05, zl: -2.0, zt: 3.75, t: 0.62 }, { x: 2.45, y: -0.03, zl: -1.75, zt: 3.55, t: 0.56 },
    { x: 2.52, y: -0.03, zl: -1.73, zt: 3.54, t: 0.56 }, { x: 3.7, y: 0.0, zl: -1.4, zt: 3.2, t: 0.5 }], (i, j) => {
    if (j >= 4) return BO.steelXDk;
    if (i === 1) return BO.black;                         // panel seam
    if (j === 0) return BO.trimLt;
    if (j === 3) return BO.steelDk;
    return j === 1 ? BO.panel : BO.plate;
  }, null, BO.steel);
  const f1 = b.n;
  // armour plates + ribs
  blockOn(b, f0, f1, { x: 2.65, z: -0.75, w: 1.5, d: 1.1, h: 0.16, tw: 1.36, td: 0.96, bev: 0.04, top: BO.panel, bevS: BO.trim, side: BO.steel });
  for (const z of [1.55, 1.85]) blockOn(b, f0, f1, { x: 2.4, z, w: 1.5, d: 0.1, h: 0.12, top: BO.trim, side: BO.steelDk });
  // energy conduits: core → wing, core → pod
  blockOn(b, f0, f1, { x: 2.5, z: 0.7, w: 2.3, d: 0.11, h: 0.12, top: GL(EM.magenta), side: BO.steelDk }, 0.06);
  blockOn(b, f0, f1, { x: 1.9, z: -1.25, w: 1.3, d: 0.12, h: 0.1, ry: 0.55, top: GL(EM.magenta, 0.4), side: BO.steelDk }, 0.05);
  // pod pylon
  b.block({ x: 2.6, y: -0.25, z: -1.6, w: 0.95, d: 1.4, h: 0.55, tw: 0.75, td: 1.2, top: BO.plate, side: BO.steelDk, front: BO.steelXDk });
  // red warning lights near the rear corners
  b.drape([[[3.2, 2.95], [3.45, 2.95], [3.45, 3.1], [3.2, 3.1]]], GL(EM.red), f0, f1, 0.006, 1);
  b.mirrorX(f0);
  return b;
}
/** core housing: armoured collar ring around the orb well (part-local, origin at part) */
function buildBossCoreFrame() {
  const b = new GB();
  const N = 12;
  const ring = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  b.loft([ring(1.48, 0.1), ring(1.44, 0.5), ring(1.24, 0.7), ring(1.0, 0.68), ring(0.92, 0.1)], (i, j) => {
    if (i === 0) return (j & 1) ? BO.steel : BO.steelDk;
    if (i === 1) return (j % 3 === 1) ? GL(EM.magenta, 0.4) : BO.trim;
    if (i === 2) return BO.panel;
    return BO.steelXDk;
  });
  b.lathe([0, 0.12, 0], [0, 1, 0], [[0, 0.95], [0, 0.0]], N, BO.black);
  // four buttress claws around the crown
  for (let k = 0; k < 4; k++) {
    const f = b.n, a = Math.PI / 4 + (k * TAU) / 4;
    b.block({ x: 1.55, y: 0.0, z: 0, w: 0.5, d: 0.55, h: 0.62, tw: 0.3, td: 0.4, ox: -0.08, bev: 0.05, top: BO.panel, bevS: BO.trimLt, side: BO.steel });
    b.spike([[1.72, 0.1, -0.22], [1.72, 0.1, 0.22], [1.72, 0.5, 0]], [2.05, 0.18, 0], (q) => (q === 1 ? BO.trim : BO.steelDk));
    b.xform(f, M(0, 0, 0, 0, -a, 0));
  }
  return b;
}
function buildBossOrb() {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(0.64, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const t = i / 9, k = hash3(t, 1.7, 3.1);
    const e = scl(EM.magenta, k > 0.7 ? 0.95 : k > 0.35 ? 0.66 : 0.42);
    const cy = 0.36;
    b.triO([p[i], p[i + 1] + cy, p[i + 2]], [p[i + 3], p[i + 4] + cy, p[i + 5]], [p[i + 6], p[i + 7] + cy, p[i + 8]], [0, cy, 0], GL(e, 0.55));
  }
  geo.dispose();
  return b;
}
function buildBossOrbDead() {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(0.55, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const t = i / 9, k = hash3(t, 4.7, 1.1);
    const st = k > 0.8 ? GL(EM.emberDim, 0.3) : S(lin(k > 0.4 ? '#1f1a1d' : '#2e2629'));
    const d = (v) => [p[v] * (0.9 + k * 0.15), p[v + 1] * 0.75 + 0.28, p[v + 2] * (0.9 + k * 0.15)];
    b.triO(d(i), d(i + 3), d(i + 6), [0, 0.28, 0], st);
  }
  geo.dispose();
  return b;
}
/** right-hand shutter (the left one is the same mesh with scale.x = −1): quarter-dome shell */
function buildBossShutter() {
  const b = new GB();
  const prof = [[0.0, 1.04], [0.34, 0.99], [0.66, 0.82], [0.9, 0.54], [1.02, 0.2]];     // (x, y) outer arc
  const inner = [[0.0, 0.9], [0.3, 0.86], [0.58, 0.7], [0.8, 0.46], [0.9, 0.2]];
  const zs = [[-1.02, 0.55], [-0.74, 0.88], [-0.3, 1.0], [0.3, 1.0], [0.74, 0.88], [1.02, 0.55]];
  const ringAt = ([z, sc]) => [...prof.map(([x, y]) => [x * sc + 0.012, 0.2 + (y - 0.2) * (0.6 + sc * 0.4), z]),
    ...inner.slice().reverse().map(([x, y]) => [x * sc + 0.012, 0.2 + (y - 0.2) * (0.6 + sc * 0.4), z])];
  const rings = zs.map(ringAt);
  const NP = prof.length;
  b.loft(rings, (i, j) => {
    if (j >= NP) return j === 2 * NP - 1 ? GL(EM.magenta, 0.35) : BO.steelXDk;   // inner lip of the seam glows
    if (j === NP - 1) return BO.steelDk;
    if (i === 0 || i === rings.length - 2) return BO.trim;
    if (j === 0) return BO.trimLt;                             // seam edge
    return (i + j) & 1 ? BO.plate : BO.panel;
  }, BO.steel, BO.steel);
  return b;
}
function buildBossWing() {   // right wing, part-local (part at x=+5, z=+0.6); forward-swept claw
  const b = new GB();
  const w0 = b.n;
  b.wing([{ x: -1.6, y: 0.0, zl: -2.0, zt: 2.6, t: 0.5 }, { x: -0.3, y: 0.02, zl: -2.15, zt: 2.2, t: 0.44 },
    { x: -0.22, y: 0.02, zl: -2.16, zt: 2.16, t: 0.44 }, { x: 1.0, y: 0.05, zl: -2.5, zt: 0.95, t: 0.3 },
    { x: 1.95, y: 0.08, zl: -3.05, zt: -1.3, t: 0.14 }], (i, j) => {
    if (j >= 4) return BO.steelXDk;
    if (i === 1) return BO.black;
    if (j === 0) return BO.trimLt;
    if (j === 3) return BO.steelDk;
    return j === 1 ? BO.panel : BO.plate;
  }, BO.steel, BO.trim);
  const w1 = b.n;
  // claw tip
  b.spike([[1.78, 0.04, -2.75], [2.12, 0.04, -2.75], [1.95, 0.2, -2.7]], [2.22, 0.06, -3.85], (k) => (k === 1 ? BO.trimLt : k === 2 ? BO.trim : BO.steelDk), BO.steelDk);
  // serrated trailing edge
  for (const [x, te] of [[-1.1, 2.42], [-0.05, 1.95], [0.85, 1.2]]) {
    b.spike([[x - 0.3, 0.02, te - 0.35], [x + 0.26, 0.02, te - 0.4], [x - 0.02, 0.2, te - 0.35]], [x + 0.28, 0.03, te + 0.62], (k) => (k === 2 ? BO.trim : BO.steelDk), BO.steelXDk);
  }
  // part boundary: hazard band along the root
  hazardDrape(b, -1.42, -1.5, -1.42, 2.1, 0.2, 9, BO.hazard, BO.black, w0, w1);
  // big cannon nacelle
  b.block({ x: -0.15, y: 0.12, z: -0.25, w: 1.05, d: 2.4, h: 0.42, tw: 0.86, td: 2.1, oz: 0.1, bev: 0.08, top: BO.panel, bevS: BO.trimLt, side: BO.steel, front: BO.steelXDk });
  b.lathe([-0.15, 0.36, -1.4], [0, 0, -1], [[0, 0.25], [0.2, 0.21], [1.05, 0.19], [1.1, 0.25], [1.35, 0.25], [1.35, 0.12]], 8, (i, j) => {
    if (i === 3) return BO.trimLt;
    return (j === 1 || j === 2) ? BO.trim : BO.steel;
  }, null, GL(EM.magentaHot, 0.6), { phase: Math.PI / 8 });
  for (const z of [-1.75, -2.05]) b.lathe([-0.15, 0.36, z], [0, 0, -1], [[0, 0.215], [0.09, 0.215]], 8, GL(EM.magenta, 0.4), null, null, { phase: Math.PI / 8 });
  // engine nozzle at the rear
  b.lathe([-0.15, 0.05, 1.75], [0, 0, 1], [[0, 0.36], [0.3, 0.4], [0.5, 0.34], [0.5, 0.22]], 8, (i) => (i === 1 ? BO.trim : BO.steelDk), null, GL(EM.violet, 0.6), { phase: Math.PI / 8 });
  // energy line root → nacelle, armour plate outboard, tip light
  blockOn(b, w0, w1, { x: -1.0, z: 0.15, w: 0.75, d: 0.1, h: 0.1, top: GL(EM.magenta), side: BO.steelDk }, 0.05);
  blockOn(b, w0, w1, { x: 0.95, z: -0.9, w: 0.8, d: 1.1, h: 0.12, tw: 0.7, td: 1.0, top: BO.panel, side: BO.trim }, 0.05);
  b.drape([[[1.62, -2.35], [1.86, -2.5], [1.92, -2.3], [1.7, -2.18]]], GL(EM.red), w0, w1, 0.006, 1);
  return b;
}
function buildBossPod() {    // part-local (part at x=±2.6, z=−2.8); symmetric forked mandible cannon
  const b = new GB();
  const ring = ([z, w, tp, bt]) => [[-w * 0.5, tp, z], [w * 0.5, tp, z], [w, tp * 0.4, z], [w * 0.8, -bt, z], [-w * 0.8, -bt, z], [-w, tp * 0.4, z]];
  const s0 = b.n;
  b.loft([[-1.15, 0.44, 0.34, 0.28], [-0.95, 0.58, 0.46, 0.36], [0.25, 0.64, 0.5, 0.4], [0.35, 0.64, 0.5, 0.4], [1.1, 0.6, 0.46, 0.38], [1.55, 0.42, 0.32, 0.28]].map(ring), (i, j) => {
    const line = i === 2;
    if (j === 0) return line ? BO.black : (i === 0 ? BO.trimLt : BO.panel);
    if (j === 1 || j === 5) return line ? BO.steelDk : BO.trim;
    if (j === 2 || j === 4) return BO.steelDk;
    return BO.steelXDk;
  }, BO.steelDk, BO.steelDk);
  const s1 = b.n;
  // prongs with blade tips
  for (const sg of [-1, 1]) {
    b.block({ x: 0.32 * sg, y: -0.24, z: -1.5, w: 0.3, d: 1.0, h: 0.5, tw: 0.22, td: 0.9, oz: 0.05, bev: 0.05, top: BO.plate, bevS: BO.trimLt, side: BO.steelDk, front: BO.steel });
    b.spike([[0.32 * sg - 0.14, -0.2, -1.98], [0.32 * sg + 0.14, -0.2, -1.98], [0.32 * sg, 0.2, -1.98]], [0.32 * sg - 0.06 * sg, 0.0, -2.5], (k) => (k === 2 ? BO.trimLt : BO.steel));
  }
  // energy lens between the prongs
  b.lathe([0, 0.02, -1.3], [0, 0, -1], [[0, 0.21], [0.14, 0.19], [0.3, 0.0]], 8, (i, j) => GL((j & 1) ? EM.magentaHot : EM.magenta, 0.5), null, null, { phase: Math.PI / 8 });
  // hazard chevrons on top mark it as a separate target
  hazardDrape(b, 0, -0.6, 0, 0.1, 0.5, 5, BO.hazard, BO.black, s0, s1);
  // side vents
  for (const sg of [-1, 1]) for (let k = 0; k < 3; k++) {
    const z = 0.45 + k * 0.24;
    b.drape([[[0.2 * sg, z], [0.5 * sg, z], [0.5 * sg, z + 0.1], [0.2 * sg, z + 0.1]]], k === 1 ? GL(EM.magenta, 0.4) : BO.black, s0, s1, 0.005, 2);
  }
  return b;
}
function buildBossTurret() { // part-local; barrels along −z
  const b = new GB();
  b.lathe([0, -0.22, 0], [0, 1, 0], [[0, 0.66], [0.16, 0.64], [0.21, 0.54], [0.24, 0.0]], 10,
    (i, j) => (i === 0 ? BO.steelDk : i === 1 ? ((j & 1) ? BO.trim : BO.trimLt) : BO.steelXDk), null, null, { phase: Math.PI / 10 });
  b.block({ x: 0, y: 0.0, z: 0.04, w: 0.82, d: 0.92, h: 0.36, tw: 0.64, td: 0.76, oz: 0.05, bev: 0.06, top: BO.panel, bevS: BO.trimLt, side: BO.steel, front: BO.steelDk });
  for (const x of [-0.14, 0.14]) {
    b.lathe([x, 0.2, -0.4], [0, 0, -1], [[0, 0.08], [0.62, 0.065], [0.62, 0.085], [0.76, 0.085], [0.76, 0.04]], 6,
      (i) => (i === 2 ? BO.trimLt : BO.steelDk), null, GL(EM.magentaHot, 0.5), { phase: Math.PI / 6 });
  }
  b.decal([[-0.2, 0.365, -0.24], [0.2, 0.365, -0.24], [0.15, 0.365, -0.13], [-0.15, 0.365, -0.13]], GL(EM.magenta));
  b.decal([[-0.22, 0.365, 0.2], [0.22, 0.365, 0.2], [0.22, 0.365, 0.3], [-0.22, 0.365, 0.3]], BO.hazard);
  return b;
}

const ARCLIGHT_NOZZLES = [[-1.5, 0.05], [-0.75, 0.05], [0, 0.05], [0.75, 0.05], [1.5, 0.05]];
function createArclight() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss:arclight';
  ud.radius = 3.0;
  ud.debrisColor = new THREE.Color('#3b404b');

  const hullMat = bodyMat(0.55, 0.35);
  const hull = new THREE.Mesh(GG('boss.hull', buildBossHull), hullMat); hull.name = 'hull';
  pivot.add(hull);
  const flameMat = additiveMat();
  const flames = new THREE.Mesh(G('boss.flames', () => buildFlame(ARCLIGHT_NOZZLES, FLAME_VIOLET)), flameMat); flames.name = 'flames';
  flames.position.set(0, 0, 4.6); flames.userData.noShadow = true; flames.renderOrder = 2;
  pivot.add(flames);

  const allMats = [hullMat];
  const partMat = () => { const m = bodyMat(0.55, 0.35); allMats.push(m); return m; };

  // ---- core (armoured dome with clamshell shutters)
  const coreMat = partMat();
  const frameGeo = GG('boss.coreFrame', buildBossCoreFrame);
  const frameWreck = G('boss.coreFrame.wreck', () => wreckOf(gbOf('boss.coreFrame', buildBossCoreFrame),
    { keep: () => 1, crumple: 0.14, seed: 7, shards: 14, shardSize: 0.3, band: 2, dir: [0, 1, 0] }).build());
  const frame = new THREE.Mesh(frameGeo, coreMat);
  const orbGeo = GG('boss.orb', buildBossOrb), orbDead = GG('boss.orbDead', buildBossOrbDead);
  const orbMat = bodyMat(0.5, 0.1); allMats.push(orbMat);
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const shutterGeo = G('boss.shutter', () => buildBossShutter().build());
  // left shutter = same geometry mirrored by scale.x = −1 (three flips the winding for us)
  const hingeR = new THREE.Object3D(); hingeR.position.set(1.02, 0.2, 0);
  const hingeL = new THREE.Object3D(); hingeL.position.set(-1.02, 0.2, 0);
  const shR = new THREE.Mesh(shutterGeo, coreMat); shR.position.set(-1.02, -0.2, 0);
  const shL = new THREE.Mesh(shutterGeo, coreMat); shL.position.set(1.02, -0.2, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  const core = makePart('core', 1.3, [
    { mesh: frame, intact: frameGeo, wreck: frameWreck },
    { mesh: orb, intact: orbGeo, wreck: orbDead },
    { mesh: shR, hideOnDestroy: true }, { mesh: shL, hideOnDestroy: true },
  ], [new THREE.Vector3(0, 0.9, 0)]);
  core.add(hingeR, hingeL);
  core.userData.materials.push(orbMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(0, 0.3, 0.8);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (t) => {
    openT = Math.max(0, Math.min(1, t)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;   // ease in-out
    hingeR.rotation.z = -e * 118 * DEG; hingeL.rotation.z = e * 118 * DEG;
  };
  // ---- wings
  const wingKeep = { keep: (x) => -0.4 - x, crumple: 0.16, seed: 11, dir: [1, 0, 0], shards: 16, shardSize: 0.42, band: 0.7 };
  const mkWing = (side) => {
    const m = partMat();
    const intact = GG('boss.wing', buildBossWing);
    const wreck = G('boss.wing.wreck', () => wreckOf(gbOf('boss.wing', buildBossWing), wingKeep).build());
    const mesh = new THREE.Mesh(intact, m);
    if (side < 0) mesh.scale.x = -1;
    const part = makePart(side < 0 ? 'wingL' : 'wingR', 1.5, [{ mesh, intact, wreck, sag: [0.05, -0.12, -0.1 * side] }],
      [new THREE.Vector3(-0.15 * side, 0.36, -2.8)]);
    part.position.set(5 * side, 0, 0.6);
    return part;
  };
  const wingL = mkWing(-1), wingR = mkWing(1);
  // ---- pods
  const podKeep = { keep: (x, y, z) => z + 0.1, crumple: 0.14, seed: 13, dir: [0, 0, -1], shards: 12, shardSize: 0.3, band: 0.5 };
  const mkPod = (side) => {
    const m = partMat();
    const intact = GG('boss.pod', buildBossPod);
    const wreck = G('boss.pod.wreck', () => wreckOf(gbOf('boss.pod', buildBossPod), podKeep).build());
    const part = makePart(side < 0 ? 'podL' : 'podR', 1.0, [{ mesh: new THREE.Mesh(intact, m), intact, wreck, sag: [0.1, -0.1, 0.06 * side] }],
      [new THREE.Vector3(0, 0.02, -1.66)]);
    part.position.set(2.6 * side, 0, -2.8);
    return part;
  };
  const podL = mkPod(-1), podR = mkPod(1);
  // ---- turrets
  const turKeep = { keep: (x, y, z) => z + 0.42, crumple: 0.1, seed: 17, dir: [0, 0.4, -1], shards: 8, shardSize: 0.2, band: 0.35 };
  const TPOS = [[-1.8, 0.6, -0.6], [1.8, 0.6, -0.6], [-3.4, 0.4, 2.2], [3.4, 0.4, 2.2]];
  const turrets = TPOS.map((p, k) => {
    const m = partMat();
    const intact = GG('boss.turret', buildBossTurret);
    const wreck = G('boss.turret.wreck', () => wreckOf(gbOf('boss.turret', buildBossTurret), turKeep).build());
    const part = makePart('t' + k, 0.6, [{ mesh: new THREE.Mesh(intact, m), intact, wreck, sag: [0.12, -0.08, 0.1 * (k & 1 ? 1 : -1)] }],
      [new THREE.Vector3(-0.14, 0.2, -1.2), new THREE.Vector3(0.14, 0.2, -1.2)]);
    part.position.set(p[0], p[1], p[2]);
    return part;
  });
  pivot.add(core, wingL, wingR, podL, podR, ...turrets);
  ud.parts = { core, wingL, wingR, podL, podR, turrets };
  ud.muzzles = [new THREE.Vector3(0, 0.5, -3.4)];
  ud.setFlash = flashFn(allMats);
  core.userData.setOpen(0);
  ud.update = (dt, t) => {
    const pulse = 0.8 + Math.sin(t * 3.2) * 0.2;
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = pulse;
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.8 : (0.3 + openT * 0.8) * (1 + Math.sin(t * 9) * 0.12);
    orb.rotation.y += dt * (0.5 + openT * 2.5);
    const fl = 1 + Math.sin(t * 37) * 0.08 + Math.sin(t * 23) * 0.05;
    flames.scale.set(1, 1, fl);
    flameMat.color.setScalar(0.9 + Math.sin(t * 29) * 0.1);
    pivot.position.y = Math.sin(t * 0.8) * 0.12;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); flameMat.dispose(); };
  return g;
}

/** boss by id ('arclight' here, others from models_s2/s3 BOSSES); kind 'boss:<id>' */
export function createBoss(id = 'arclight') {
  let g;
  if (id !== 'arclight' && own(EXT_BOSSES, id)) g = EXT_BOSSES[id]();
  else { if (id !== 'arclight') warnOnce('boss', id, 'arclight'); g = createArclight(); }
  g.userData.kind = 'boss:' + id;
  return g;
}

// =============================================================================
// ITEMS
// =============================================================================
const ITEM_COL = {
  red: { body: '#ff3a2e', glow: rgb(1.0, 0.16, 0.08, 1.6), halo: rgb(1.0, 0.2, 0.1) },
  blue: { body: '#3a86ff', glow: rgb(0.14, 0.45, 1.0, 1.6), halo: rgb(0.2, 0.5, 1.0) },
  H: { body: '#2fe060', glow: rgb(0.14, 1.0, 0.32, 1.3), halo: rgb(0.14, 0.7, 0.24) },
  N: { body: '#b64cff', glow: rgb(0.66, 0.2, 1.0, 1.6), halo: rgb(0.65, 0.25, 1.0) },
  B: { body: '#ff8a1c', glow: rgb(1.0, 0.46, 0.06, 1.6), halo: rgb(1.0, 0.5, 0.12) },
  medal: { body: '#ffffff', glow: rgb(1.0, 0.7, 0.18, 1.0), halo: rgb(1.0, 0.72, 0.2) },
  '1UP': { body: '#2fd84e', glow: rgb(0.25, 1.0, 0.3, 0.6), halo: rgb(0.16, 0.5, 0.16) },
};
/** item colours of the other weapons, derived from the defs hex the way the hand-tuned ones above read:
 *  glow ≈ (sRGB hue / max)^1.3 × 1.6. Luminous hues (gold, lime) get a deeper, dimmer glow — otherwise
 *  bloom + tone mapping wash them out to cream */
function itemHue(hex) {
  const n = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  const m = Math.max(n[0], n[1], n[2]) || 1;
  const pw = (e) => n.map((v) => Math.pow(v / m, e));
  const y = pw(1.3), dim = Math.max(0, Math.min(1, (0.2126 * y[0] + 0.7152 * y[1] + 0.0722 * y[2] - 0.45) / 0.32));
  return { body: '#' + hex.toString(16).padStart(6, '0'), glow: scl(pw(1.3 + dim), 1.6 - dim * 0.4), halo: scl(pw(1.2 + dim), 1 - dim * 0.3) };
}
for (const table of [MAIN_WEAPONS, SUB_WEAPONS]) {
  for (const [k, w] of Object.entries(table)) if (!own(ITEM_COL, k)) ITEM_COL[k] = itemHue(w.hex);
}
const SILVER =lit('#c9d0d9'), SILVER_DK = lit('#7d8793'), ITEM_DARK = lit('#23272e');
/** facet shades: albedo is tinted by material.color, emission by uEmitTint */
const FAC = (k, e) => S([k, k, k], [e, e, e]);

function buildGem() {         // power crystal: brilliant-cut gem lying flat, long axis z
  const b = new GB();
  const hex = (y, sx, sz) => Array.from({ length: 6 }, (_, k) => {
    const a = (k * TAU) / 6 + Math.PI / 6; return [Math.cos(a) * sx, y, Math.sin(a) * sz];
  });
  const R = [hex(-0.22, 0.001, 0.001), hex(0.0, 0.34, 0.46), hex(0.09, 0.3, 0.4), hex(0.15, 0.17, 0.23)];
  b.loft(R, (i, j) => (i === 0 ? FAC((j & 1) ? 0.55 : 0.4, 0.5) : i === 1 ? FAC(1, 0.35) : FAC((j & 1) ? 0.95 : 0.72, (j & 1) ? 0.9 : 0.45)),
    null, FAC(0.9, 0.95));
  return b;
}
function buildCapsule() {     // pill along x with a glowing belt
  const b = new GB();
  b.lathe([-0.48, 0, 0], [1, 0, 0], [[0, 0], [0.05, 0.14], [0.13, 0.22], [0.22, 0.26], [0.27, 0.26], [0.69, 0.26], [0.74, 0.26], [0.83, 0.22], [0.91, 0.14], [0.96, 0]], 10, (i, j) => {
    if (i === 3 || i === 5) return ITEM_DARK;
    if (i === 4) return S([0.5, 0.5, 0.5], (j & 1) ? [1.25, 1.25, 1.25] : [0.8, 0.8, 0.8]);
    return (j & 1) ? SILVER : SILVER_DK;
  });
  return b;
}
function buildBombItem() {    // cartoon bomb: round orange body, silver tail fins, nose along −z
  const b = new GB();
  b.lathe([0, 0, 0.3], [0, 0, -1], [[0, 0.0], [0.03, 0.16], [0.1, 0.25], [0.24, 0.31], [0.4, 0.3], [0.52, 0.24], [0.6, 0.14], [0.64, 0.0]], 10, (i, j) => {
    if (i === 0) return SILVER_DK;
    if (i === 2) return S([0.45, 0.45, 0.45], [1.1, 1.1, 1.1]);
    return S((j & 1) ? [1, 1, 1] : [0.78, 0.78, 0.78], [0.18, 0.18, 0.18]);
  }, null, null, { phase: Math.PI / 10 });
  b.lathe([0, 0, 0.26], [0, 0, 1], [[0, 0.13], [0.16, 0.1]], 8, SILVER_DK, null, ITEM_DARK);
  for (let k = 0; k < 4; k++) {
    const f = b.n;
    b.block({ x: 0.2, y: -0.014, z: 0.36, w: 0.24, d: 0.22, h: 0.028, tw: 0.24, td: 0.12, oz: 0.05, top: SILVER, side: SILVER_DK });
    b.xform(f, M(0, 0, 0, 0, 0, (k * TAU) / 4 + Math.PI / 4));
  }
  return b;
}
function buildMedal() {       // coin facing +y: gold rim, raised star; tinted gold by vertex colour
  const b = new GB();
  const G0 = lin('#ffc21a'), G1 = lin('#ffe07a'), G2 = lin('#b37a06');
  const GOLD = S(G0, rgb(1, 0.6, 0.08, 0.28)), GOLD_LT = S(G1, rgb(1, 0.8, 0.3, 0.7)), GOLD_DK = S(G2, rgb(0.6, 0.32, 0.03, 0.12));
  b.lathe([0, -0.06, 0], [0, 1, 0], [[0, 0], [0, 0.33], [0.02, 0.43], [0.1, 0.43], [0.12, 0.33], [0.12, 0]], 16,
    (i, j) => (i === 0 || i === 4 ? GOLD_DK : i === 2 ? ((j & 1) ? GOLD_LT : GOLD) : GOLD), null, null);
  const star = (y, dir) => {
    const pts = [];
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * TAU) / 10, r = k & 1 ? 0.12 : 0.29; pts.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
    const apex = [0, y + 0.06 * dir, 0];
    for (let k = 0; k < 10; k++) b.triN(pts[k], pts[(k + 1) % 10], apex, [0, dir, 0], k & 1 ? GOLD : GOLD_LT);
  };
  star(0.061, 1); star(-0.061, -1);
  return b;
}
function buildOneUp() {       // bevelled emerald hexagon badge
  const b = new GB();
  b.lathe([0, -0.08, 0], [0, 1, 0], [[0, 0], [0, 0.4], [0.035, 0.47], [0.125, 0.47], [0.16, 0.4], [0.16, 0]], 6,
    (i, j) => (i === 2 ? FAC((j & 1) ? 1 : 0.8, 0.55) : i === 4 ? FAC(0.9, 0.9) : i === 3 ? FAC(0.85, 0.7) : FAC(0.6, 0.4)),
    null, null, { phase: Math.PI / 6 });
  return b;
}

function itemSprite(tex, sx, sy) {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(m); s.scale.set(sx, sy, 1);
  return s;
}
const LETTER_Y = 0.36, LETTER_Z = 0.1;   // hover over the body, nudged toward the camera so it stays centred on screen

export function createItem(kind) {
  const g = new THREE.Group(); g.name = 'item:' + kind;
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = kind; ud.radius = 0.6; ud.muzzles = [];
  const phase = Math.random() * TAU;
  const halo = itemSprite(haloTex(), 1.55, 1.55);
  halo.material.blending = THREE.AdditiveBlending;
  halo.position.y = -0.25; halo.renderOrder = 3; halo.userData.noShadow = true;
  g.add(halo);
  let letter = null;
  let mat, mesh, spin = () => {};
  let haloK = 0.36;
  ud.debrisColor = new THREE.Color();
  const setHue = (key) => {
    const c = ITEM_COL[key];
    mat.color.set(c.body);
    mat.uEmitTint.value.setRGB(c.glow[0], c.glow[1], c.glow[2]);
    halo.material.color.setRGB(c.halo[0], c.halo[1], c.halo[2]);
    ud.debrisColor.set(key === 'medal' ? '#ffc21a' : c.body);
  };
  switch (kind) {
    case 'P': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.gem', buildGem), mat);
      letter = itemSprite(glyphTex('P'), 0.7, 0.7);
      ud.color = 'red';
      // any MAIN_WEAPONS key (gem hue from its colour); anything else reads as red
      ud.setColor = (c) => { ud.color = own(MAIN_WEAPONS, c) ? c : 'red'; setHue(ud.color); };
      ud.setColor('red');
      spin = (dt, t) => { mesh.rotation.z = Math.sin(t * 2.4 + phase) * 0.9; mesh.rotation.y += dt * 0.6; };
      break;
    }
    case 'S': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.capsule', buildCapsule), mat);
      // one glyph per SUB_WEAPONS key (letter = key), fetched up front so cycling never builds a canvas
      const tex = { H: glyphTex('H') };
      for (const k of Object.keys(SUB_WEAPONS)) tex[k] = glyphTex(k);
      letter = itemSprite(tex.H, 0.68, 0.68);
      ud.subKind = 'H';
      ud.setKind = (k) => {
        ud.subKind = own(SUB_WEAPONS, k) ? k : 'H'; setHue(ud.subKind);
        letter.material.map = tex[ud.subKind]; // body keeps its weapon hue (green H, purple N, …)
      };
      ud.setKind('H');
      spin = (dt) => { mesh.rotation.x += dt * 3.2; };
      break;
    }
    case 'B': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.bomb', buildBombItem), mat);
      letter = itemSprite(glyphTex('B'), 0.68, 0.68);
      setHue('B');
      spin = (dt, t) => { mesh.rotation.z += dt * 2.2; mesh.rotation.y = Math.sin(t * 1.7 + phase) * 0.35; };
      break;
    }
    case 'medal': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.medal', buildMedal), mat);
      setHue('medal');
      haloK = 0.34;
      halo.scale.setScalar(1.35);
      spin = (dt, t) => { mesh.rotation.z = Math.sin(t * 3 + phase) * 1.0; }; // wobble, never edge-on
      pivot.rotation.x = 0.33;          // face the camera
      break;
    }
    case '1UP': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.oneup', buildOneUp), mat);
      letter = itemSprite(glyphTex('1UP'), 1.04, 0.52);
      setHue('1UP');
      pivot.rotation.x = 0.33;
      spin = (dt, t) => { mesh.rotation.y += dt * 1.4; mesh.rotation.z = Math.sin(t * 2 + phase) * 0.25; };
      break;
    }
    default: throw new Error(`models.createItem: unknown kind "${kind}"`);
  }
  pivot.add(mesh);
  if (letter) {
    letter.material.color.setScalar(0.9);
    letter.position.set(0, LETTER_Y, LETTER_Z); letter.renderOrder = 4; letter.userData.noShadow = true;
    g.add(letter);
  }
  ud.letter = letter;
  ud.halo = halo;
  ud.setFlash = (v) => mat.emissive.setScalar(Math.max(0, Math.min(1, v)) * FLASH_K);
  ud.update = (dt, t) => {
    spin(dt, t);
    const bob = Math.sin(t * 3.4 + phase) * 0.07;
    pivot.position.y = bob;
    if (letter) letter.position.y = LETTER_Y + bob;
    halo.material.opacity = haloK + Math.sin(t * 6 + phase) * 0.1;
    mat.uEmitScale.value = 1 + Math.sin(t * 6 + phase) * 0.18;
  };
  ud.dispose = () => { mat.dispose(); halo.material.dispose(); if (letter) letter.material.dispose(); };
  ud.update(0, 0);
  return g;
}

// =============================================================================
// SHADOWS — soft baked silhouette on one quad per model type
// =============================================================================
const SHADOW = new Map();
const _m4a = new THREE.Matrix4(), _m4b = new THREE.Matrix4(), _v3 = new THREE.Vector3();
function shadowKey(model) {
  const ud = model.userData;
  return ud.kind || model.name || model.uuid;
}
/** a clean instance of any registered kind: 'player:<id>', 'option:<id>', 'boss:<id>', enemy types, item kinds */
function pristineOf(kind) {
  if (typeof kind !== 'string') return null;
  try {
    const c = kind.indexOf(':');
    if (c > 0) {
      const pre = kind.slice(0, c), id = kind.slice(c + 1);
      if (pre === 'player') return createPlayer(id);
      if (pre === 'option') return createOption(id);
      if (pre === 'boss') return createBoss(id);
    }
    if (ENEMY_TYPES.includes(kind)) return createEnemy(kind);
    if (ITEM_KINDS.includes(kind)) return createItem(kind);
  } catch (_) { /* fall back to the model itself */ }
  return null;
}
function bakeShadow(model) {
  model.updateWorldMatrix(true, true);
  _m4a.copy(model.matrixWorld).invert();
  const tris = [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  model.traverse((o) => {
    if (!o.isMesh || o.userData.noShadow) return;
    for (let p = o; p && p !== model; p = p.parent) if (!p.visible) return;
    _m4b.multiplyMatrices(_m4a, o.matrixWorld);
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const count = idx ? idx.count : pos.count;
    const arr = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      _v3.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(_m4b);
      arr[i * 2] = _v3.x; arr[i * 2 + 1] = _v3.z;
      if (_v3.x < x0) x0 = _v3.x; if (_v3.x > x1) x1 = _v3.x;
      if (_v3.z < z0) z0 = _v3.z; if (_v3.z > z1) z1 = _v3.z;
    }
    tris.push(arr);
  });
  if (!tris.length) { x0 = z0 = -0.5; x1 = z1 = 0.5; }
  const size = Math.max(x1 - x0, z1 - z0);
  const margin = Math.max(0.12, size * 0.06);
  x0 -= margin; x1 += margin; z0 -= margin; z1 += margin;
  const ppu = Math.min(64, 256 / Math.max(x1 - x0, z1 - z0));
  const W = Math.max(8, Math.ceil((x1 - x0) * ppu)), H = Math.max(8, Math.ceil((z1 - z0) * ppu));
  x1 = x0 + W / ppu; z1 = z0 + H / ppu;            // quad matches the texel grid exactly
  // Rasterise the projected triangles in JS on a supersampled grid. (Canvas 2D +
  // getImageData was ~10× slower and forces a GPU read-back on phones.)
  const SS = ppu >= 40 ? 3 : 2, SW = W * SS, SH = H * SS, sp = ppu * SS;
  const mask = new Uint8Array(SW * SH);
  for (const arr of tris) {
    for (let i = 0; i < arr.length; i += 6) {
      const ax = (arr[i] - x0) * sp, ay = (arr[i + 1] - z0) * sp;
      const bx = (arr[i + 2] - x0) * sp, by = (arr[i + 3] - z0) * sp;
      const cx = (arr[i + 4] - x0) * sp, cy = (arr[i + 5] - z0) * sp;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-4) continue;          // edge-on (vertical) faces cast no footprint
      const sg = area > 0 ? 1 : -1;
      const mnx = Math.max(0, Math.floor(Math.min(ax, bx, cx))), mxx = Math.min(SW - 1, Math.ceil(Math.max(ax, bx, cx)));
      const mny = Math.max(0, Math.floor(Math.min(ay, by, cy))), mxy = Math.min(SH - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = mny; y <= mxy; y++) {
        const py = y + 0.5;
        for (let x = mnx; x <= mxx; x++) {
          const px = x + 0.5;
          if (sg * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0) continue;
          if (sg * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) < 0) continue;
          if (sg * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) < 0) continue;
          mask[y * SW + x] = 1;
        }
      }
    }
  }
  // box-downsample to coverage, then soften with two separable box-blur passes
  const rad = Math.max(1, Math.round(ppu * 0.05));
  const buf = new Float32Array(W * H), tmp = new Float32Array(W * H);
  const k255 = 255 / (SS * SS);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let j = 0; j < SS; j++) { const row = (y * SS + j) * SW + x * SS; for (let i = 0; i < SS; i++) s += mask[row + i]; }
    buf[y * W + x] = s * k255;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += buf[y * W + xx]; n++; } }
      tmp[y * W + x] = s / n;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } }
      buf[y * W + x] = s / n;
    }
  }
  // RGBA (alphaMap samples .g). DataTexture rows run bottom-up (v=0 ↔ +z), grid rows top-down (z0 first).
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const dst = (H - 1 - y) * W * 4;
    for (let x = 0; x < W; x++) {
      const v = Math.min(255, Math.round(buf[y * W + x])), o = dst + x * 4;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geo.rotateX(-Math.PI / 2);
  geo.translate((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, alphaMap: tex,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  return { geo, mat, tex };
}
/**
 * Flattened dark silhouette of `model` for the ground. One draw call: the
 * silhouette (all shadow-casting meshes projected on XZ) is baked once per
 * model type into a small soft alpha mask on a quad, so overlapping parts never
 * double-darken. All shadows of a type share ONE material. Core positions it on
 * the ground and copies model.rotation.y.
 */
export function createShadow(model) {
  const key = shadowKey(model);
  let s = SHADOW.get(key);
  if (!s) {
    // Bake from a pristine instance of the same kind, so the cached silhouette never
    // depends on the pose of the model passed in (banked, turret yawed, parts destroyed…).
    const ref = pristineOf(model.userData.kind);
    s = bakeShadow(ref || model);
    if (ref && ref.userData.dispose) ref.userData.dispose();
    SHADOW.set(key, s);
  }
  const m = new THREE.Mesh(s.geo, s.mat);
  m.name = 'shadow:' + key;
  m.renderOrder = -1;
  m.userData.noShadow = true;
  return m;
}

// =============================================================================
// housekeeping
// =============================================================================
export function disposeAll() {
  for (const g of GEO.values()) g.dispose();
  for (const t of TEX.values()) t.dispose();
  for (const s of SHADOW.values()) { s.geo.dispose(); s.mat.dispose(); s.tex.dispose(); }
  GEO.clear(); GBS.clear(); TEX.clear(); SHADOW.clear();
}

// =============================================================================
// registry lists (game pools, hangar, dev tools)
// =============================================================================
const BASE_ENEMY_TYPES = ['dart', 'hornet', 'tank', 'turret', 'gunboat', 'carrier', 'bomber', 'crawler'];
const BASE_GROUND_TYPES = ['tank', 'turret', 'gunboat', 'crawler'];
// name collisions: stage-1 names win, and models_s3 would silently shadow models_s2 — say so loudly
for (const [what, base, a, b] of [['enemy', BASE_ENEMY_TYPES, S2.ENEMIES, S3.ENEMIES], ['boss', ['arclight'], S2.BOSSES, S3.BOSSES],
  ['aircraft', ['bolt'], SHIPS.PLAYERS, null]]) {
  for (const k of Object.keys(a || {})) {
    if (base.includes(k)) console.error(`models: extension ${what} "${k}" collides with a stage-1 model and is ignored`);
    else if (b && own(b, k)) console.error(`models: ${what} "${k}" is defined in both models_s2.js and models_s3.js (models_s3 wins)`);
  }
  for (const k of Object.keys(b || {})) if (base.includes(k)) console.error(`models: extension ${what} "${k}" collides with a stage-1 model and is ignored`);
}
const EXT_ENEMY_TYPES = Object.keys(EXT_ENEMIES).filter((t) => !BASE_ENEMY_TYPES.includes(t));

/** aircraft with a real model (createPlayer falls back to bolt for any other id) */
export const PLAYER_TYPES = ['bolt', ...Object.keys(EXT_PLAYERS).filter((id) => id !== 'bolt')];
/** aircraft ids with a real option-drone model (createOption uses the placeholder pod for any other id) */
export const OPTION_TYPES = Object.keys(EXT_OPTIONS);
export const BOSS_TYPES = ['arclight', ...Object.keys(EXT_BOSSES).filter((id) => id !== 'arclight')];
export const ENEMY_TYPES = [...BASE_ENEMY_TYPES, ...EXT_ENEMY_TYPES];
export const ITEM_KINDS = ['P', 'S', 'B', 'medal', '1UP'];
/** ground units (no air shadow): stage-1 list + extension enemies whose model sets userData.ground = true.
 *  Finding those costs one throwaway build each at import; the geometry stays cached for the pools. */
export const GROUND_TYPES = [...BASE_GROUND_TYPES, ...EXT_ENEMY_TYPES.filter(isGroundType)];
function isGroundType(type) {
  try {
    const m = createEnemy(type);
    const ground = !!m.userData.ground;
    if (m.userData.dispose) m.userData.dispose();
    return ground;
  } catch (e) {
    console.error(`models: enemy "${type}" failed to build`, e);
    return false;
  }
}
