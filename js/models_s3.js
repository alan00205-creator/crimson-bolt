// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 3 "SKY CITADEL" (天空要塞)
// -----------------------------------------------------------------------------
// models.js registers these tables: createEnemy(type) falls back to ENEMIES[type],
// createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { interceptor, frigate, lancer, minelayer, valkyrie };
//   export const BOSSES = { seraph };
//
// The citadel's air force: gunmetal hulls under pale armour plates, red sensor eyes and
// hazard trim, cold cyan engines and energy lines (the player's crimson and stage 1's
// orange / magenta stay distinct). Silhouettes are dark-edged so they read on white
// cloud, and the pale plates carry them on the storm grey and the dusk blue.
//
//   INTERCEPTOR  swept-wing jet: needle nose, canards, twin canted tails, twin cyan nozzles
//   FRIGATE      small flying warship: pointed hull with a deck, bridge, fore + aft gun
//                turrets (userData.turrets, each with its own muzzles), two lift nacelles
//   LANCER       ram craft: long charging lance, delta canards, one big engine; a red
//                targeting beam (additive, userData.setCharge(0..1)) telegraphs its lane
//   MINELAYER    manta flying wing with a revolving dorsal mine drum (userData.drop() turns it)
//   VALKYRIE     mid-boss escort cruiser: parts batteryL / batteryR (twin-gun sponsons that
//                aim) and core (cyan reactor under two shutters, setOpen)
//   SERAPH       boss mothership, six-winged: fore wings with gun pods (pods[0..1]), main
//                wings with batteries (battery[0..3]), spinal cannons that rise from wells
//                (spineF with a telegraph beam, spineL, spineR — setRaise(0..1)), the citadel
//                and its reactor core (setOpen). setBreak(0..1) snaps the hull in two and
//                lets the main wings fall away for the death sequence.
//
// Imports: only 'three' and './modelkit.js' — never models.js (import cycle).
// House style and helpers: see the modelkit.js header.
//
// Enemy contract — enemyShell(kind, radius, debrisHex) + bodyMat + GG(key, buildXxx):
//   * nose/front toward −z (the game yaws units that face the player by π), up +y,
//     centred on the origin. Stage 3 is above a cloud sea: AIR UNITS ONLY (no
//     userData.ground); every unit gets a baked shadow on the cloud deck
//   * userData: kind (the registry sets it to the type), radius, debrisColor, muzzles
//     (group-local Vector3[], refreshed in update() when they move), setFlash(v),
//     update(dt, t), dispose() (materials only)
//   * gameplay numbers (hp, score, collision radius) live in stage3.js ENEMY, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (userData.midboss)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) fully restores the pose
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * mirrored parts share geometry + wreck with mesh.scale.x = −1
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
// Cache keys: 'ext:s3:<name>'.
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, M, S, DEG, TAU, lit, lin, rgb, GL, EM, scl, hash3, bodyMat, additiveMat, flashFn, enemyShell, syncMuzzles,
  hazardDrape, blockOn, makePart, destructiblePart, wreckOf, gbOf, buildFlame,
} from './modelkit.js';

// =============================================================================
// palette + shared helpers
// =============================================================================
const K = {
  steel: lit('#3b4352'), steelLt: lit('#5a6475'), steelDk: lit('#262c37'), steelXDk: lit('#161a21'),
  plate: lit('#c6ccd6'), plateLt: lit('#d9dee5'), plateDk: lit('#8e97a5'), edge: lit('#b3bbc7'),
  red: lit('#b0172b'), redDk: lit('#650c18'), black: lit('#0b0d11'),
  glass: S(lin('#0d2c3b'), rgb(0.02, 0.13, 0.19)), glassLt: S(lin('#2f93b6'), rgb(0.04, 0.24, 0.34)),
};
const CY = rgb(0.16, 0.78, 1.0, 3.2);      // cold cyan energy
const CYH = rgb(0.62, 0.94, 1.0, 4.2);     // white-hot cyan (nozzle cores, reactor)
const CYD = rgb(0.12, 0.6, 1.0, 1.7);      // dim cyan (panel lights)
const RD = EM.eyeRed;                      // sensor eyes / warning lights
const G_CY = GL(CY, 0.4), G_CYH = GL(CYH, 0.5), G_CYD = GL(CYD, 0.3), G_RD = GL(RD, 0.45);
// ice-blue afterburner (additive cones, see modelkit buildFlame)
const FLAME_ICE = [
  { r: 0.06, len: 0.5, base: rgb(0.25, 0.7, 1.0, 1.1), tip: rgb(0.05, 0.2, 0.6, 0.0), sides: 6 },
  { r: 0.034, len: 0.28, base: rgb(0.7, 0.92, 1.0, 1.6), tip: rgb(0.3, 0.72, 1.0, 0.1), sides: 5 },
];
const FLAME_BIG = [
  { r: 0.3, len: 1.3, base: rgb(0.25, 0.68, 1.0, 1.0), tip: rgb(0.05, 0.15, 0.5, 0.0), sides: 8 },
  { r: 0.17, len: 0.7, base: rgb(0.7, 0.92, 1.0, 1.5), tip: rgb(0.3, 0.7, 1.0, 0.05), sides: 6 },
];

/** 8-point fuselage section [z, halfWidth, top, bottom]. Edges: 0/7 top, 1/6 shoulders, 2/5 flanks, 3/4 belly */
function ring8([z, w, tp, bt], y = 0) {
  return [[0, y + tp, z], [w * 0.55, y + tp * 0.82, z], [w, y + tp * 0.18, z], [w * 0.68, y - bt * 0.75, z],
    [0, y - bt, z], [-w * 0.68, y - bt * 0.75, z], [-w, y + tp * 0.18, z], [-w * 0.55, y + tp * 0.82, z]];
}
/** 10-point armoured section with a flat top [z, halfWidth, top, bottom]. Edges: 0 top, 1/9 bevels, 2/8 upper flanks,
 *  3/7 lower flanks, 4/6 chines, 5 keel */
function ring10([z, w, tp, bt], y = 0) {
  return [[-w * 0.36, y + tp, z], [w * 0.36, y + tp, z], [w * 0.8, y + tp * 0.78, z], [w, y + tp * 0.3, z], [w * 0.86, y - bt * 0.4, z],
    [w * 0.45, y - bt, z], [-w * 0.45, y - bt, z], [-w * 0.86, y - bt * 0.4, z], [-w, y + tp * 0.3, z], [-w * 0.8, y + tp * 0.78, z]];
}
/** drape quads for a stripe of half-width w along the polyline [[x, z], …] */
function stripe(pts, w) {
  const quads = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L * w, nz = (bx - ax) / L * w;
    quads.push([[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]);
  }
  return quads;
}
/** faceted glowing orb (icosahedron), per-face brightness jitter; centre (0, cy, 0) */
function orbGB(r, cy, em, seed, dead = false) {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const k = hash3(i / 9, seed, 3.1);
    const st = dead ? (k > 0.8 ? GL(EM.emberDim, 0.3) : S(lin(k > 0.4 ? '#1c1e22' : '#2b2e33')))
      : GL(scl(em, k > 0.7 ? 1.0 : k > 0.35 ? 0.7 : 0.45), 0.55);
    const d = (v) => (dead ? [p[v] * (0.9 + k * 0.15), p[v + 1] * 0.78 + cy * 0.8, p[v + 2] * (0.9 + k * 0.15)] : [p[v], p[v + 1] + cy, p[v + 2]]);
    b.triO(d(i), d(i + 3), d(i + 6), [0, cy, 0], st);
  }
  geo.dispose();
  return b;
}
/** quarter-dome shutter (right half; the left is the same mesh with scale.x = −1), radius R, hinge at x = R */
function shutterGB(R, glow) {
  const b = new GB();
  const prof = [[0.0, 1.0], [0.34, 0.95], [0.66, 0.79], [0.9, 0.52], [1.0, 0.2]];
  const inner = [[0.0, 0.87], [0.3, 0.83], [0.58, 0.68], [0.8, 0.45], [0.88, 0.2]];
  const zs = [[-1.0, 0.55], [-0.72, 0.88], [-0.3, 1.0], [0.3, 1.0], [0.72, 0.88], [1.0, 0.55]];
  const ringAt = ([z, sc]) => [...prof.map(([x, y]) => [(x * sc + 0.012) * R, (0.2 + (y - 0.2) * (0.6 + sc * 0.4)) * R, z * R]),
    ...inner.slice().reverse().map(([x, y]) => [(x * sc + 0.012) * R, (0.2 + (y - 0.2) * (0.6 + sc * 0.4)) * R, z * R])];
  const NP = prof.length;
  b.loft(zs.map(ringAt), (i, j) => {
    if (j >= NP) return j === 2 * NP - 1 ? glow : K.steelXDk;
    if (j === NP - 1) return K.steelDk;
    if (i === 0 || i === zs.length - 2) return K.edge;
    if (j === 0) return K.plateLt;
    return (i + j) & 1 ? K.plate : K.plateDk;
  }, K.steel, K.steel);
  return b;
}
/** flat targeting beam along −z from the origin (unit length: the mesh is scaled to its length). Normal
 *  blended with vertex alpha (additive red vanishes on white cloud): an HDR red core that still blooms,
 *  a translucent halo, fading with distance. RGBA vertex colours: the same program as the hornet's rotor disc. */
function buildBeam(w, halo) {
  const pos = [], col = [];
  const N = 8, core = [2.2, 0.28, 0.32, 0.92], hot = [1.3, 0.06, 0.12, 0.5], edge = [0.8, 0.02, 0.06, 0];
  const quad = (xa, xb, za, zb, ca, cb, fa, fb) => {
    const A = [xa, 0, za], B = [xb, 0, za], C = [xb, 0, zb], D = [xa, 0, zb];
    const c = (cc, f) => [cc[0], cc[1], cc[2], cc[3] * f];
    pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    col.push(...c(ca, fa), ...c(cb, fa), ...c(cb, fb), ...c(ca, fa), ...c(cb, fb), ...c(ca, fb));
  };
  for (let k = 0; k < N; k++) {
    const za = -k / N, zb = -(k + 1) / N;
    const fa = 1 - 0.75 * (k / N), fb = 1 - 0.75 * ((k + 1) / N);
    quad(-halo, -w, za, zb, edge, hot, fa, fb);
    quad(-w, w, za, zb, core, core, fa, fb);
    quad(w, halo, za, zb, hot, edge, fa, fb);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}
/** hidden beam mesh of length len; userData.set(v) shows it at strength v (0 hides it). Hidden, it collapses
 *  to zero length so bounding boxes (dev page framing) ignore it. */
function beamMesh(key, len, w, halo) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(G(key, () => buildBeam(w, halo)), mat);
  m.name = 'beam'; m.visible = false; m.renderOrder = 3; m.userData.noShadow = true; m.frustumCulled = false;
  m.scale.z = 1e-4;
  m.userData.set = (v) => { const on = v > 0.01; m.visible = on; m.scale.z = on ? len : 1e-4; mat.opacity = Math.min(1, v); };
  return { m, mat };
}

// =============================================================================
// INTERCEPTOR — swept-wing jet (≈ 1.9 long, 1.75 span)
// =============================================================================
const IC_FUS = [[-1.02, 0.004, 0.004, 0.004], [-0.86, 0.04, 0.035, 0.028], [-0.62, 0.08, 0.075, 0.05], [-0.36, 0.115, 0.108, 0.065],
  [-0.08, 0.145, 0.122, 0.075], [0.3, 0.165, 0.11, 0.08], [0.6, 0.15, 0.09, 0.075], [0.74, 0.13, 0.08, 0.07]];
function buildInterceptor() {
  const b = new GB();
  const s0 = b.n;
  b.loft(IC_FUS.map((s) => ring8(s)), (i, j) => {
    if (i === 0) return K.edge;                                         // pale needle nose
    const top = j === 0 || j === 7, sh = j === 1 || j === 6, fl = j === 2 || j === 5;
    if (top) return i <= 2 ? K.steelDk : i === 4 ? K.red : K.steel;       // dark anti-glare nose, red spine band
    if (sh) return i <= 1 ? K.steelLt : K.plate;
    if (fl) return i === 4 ? K.redDk : K.steelDk;
    return K.steelXDk;
  }, null, K.steelDk);
  const s1 = b.n;
  // canopy (smoked glass, cyan glint) and a red sensor slit ahead of it
  b.drape([[[-0.045, -0.6], [0.045, -0.6], [0.075, -0.42], [-0.075, -0.42]], [[-0.075, -0.42], [0.075, -0.42], [0.07, -0.18], [-0.07, -0.18]]], K.glass, s0, s1, 0.006, 2);
  b.drape([[[-0.02, -0.5], [0.02, -0.5], [0.03, -0.3], [-0.03, -0.3]]], K.glassLt, s0, s1, 0.01, 1);
  b.drape([[[-0.03, -0.74], [0.03, -0.74], [0.045, -0.66], [-0.045, -0.66]]], G_RD, s0, s1, 0.008, 1);
  // twin nozzles, cyan-hot
  for (const x of [-0.075, 0.075]) {
    b.lathe([x, -0.005, 0.6], [0, 0, 1], [[0, 0.07], [0.12, 0.075], [0.2, 0.062]], 6, (i) => (i === 0 ? K.steelDk : K.steelLt), null, G_CYH, { phase: Math.PI / 6 });
  }
  const f0 = b.n;
  // swept main wing: pale upper panels, red tip, bright leading edge
  b.wing([{ x: 0.13, y: -0.02, zl: -0.3, zt: 0.6, t: 0.06 }, { x: 0.56, y: 0.0, zl: 0.2, zt: 0.64, t: 0.034 },
    { x: 0.88, y: 0.01, zl: 0.5, zt: 0.72, t: 0.016 }], (i, j) => {
    if (j >= 4) return K.steelXDk;
    if (j === 0) return K.edge;
    if (i === 1) return j === 3 ? K.redDk : K.red;
    return j === 3 ? K.steel : K.plate;
  }, null, K.red);
  // panel seam + cyan wing-root light
  b.decal([[0.2, 0.052, 0.05], [0.5, 0.034, 0.3], [0.52, 0.034, 0.34], [0.22, 0.052, 0.1]], K.steelDk);
  b.decal([[0.16, 0.058, -0.12], [0.24, 0.055, -0.03], [0.22, 0.056, 0.02], [0.15, 0.059, -0.07]], G_CY);
  // canard
  b.wing([{ x: 0.09, y: 0.02, zl: -0.56, zt: -0.36, t: 0.03 }, { x: 0.34, y: 0.03, zl: -0.4, zt: -0.3, t: 0.014 }],
    (i, j) => (j >= 4 ? K.steelXDk : j === 0 ? K.edge : K.steel), null, K.steelDk);
  // canted tail fin
  const f1 = b.n;
  b.wing([{ x: 0, zl: 0.26, zt: 0.72, t: 0.035 }, { x: 0.32, zl: 0.54, zt: 0.8, t: 0.016 }], (i, j) => (j === 0 ? K.edge : j >= 3 ? K.steelDk : K.steel), null, K.red);
  b.xform(f1, M(0.1, 0.07, 0, 0, 0, 62 * DEG));
  // intake
  b.block({ x: 0.17, y: -0.05, z: -0.16, w: 0.09, d: 0.3, h: 0.09, tw: 0.07, td: 0.24, oz: 0.03, top: K.steelLt, side: K.steelDk, front: K.black });
  b.mirrorX(f0);
  return b;
}
function createInterceptor() {
  const { g, pivot, ud } = enemyShell('interceptor', 0.8, '#3b4352');
  const mat = bodyMat(0.5, 0.35);
  pivot.add(new THREE.Mesh(GG('ext:s3:interceptor', buildInterceptor), mat));
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:s3:interceptor.flame', () => buildFlame([[-0.075, -0.005], [0.075, -0.005]], FLAME_ICE)), flameMat);
  flame.position.z = 0.8; flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, 0, -1.0)];
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    mat.uEmitScale.value = 0.85 + Math.sin(t * 13) * 0.15;
    flame.scale.set(1, 1, 1.1 + Math.sin(t * 47) * 0.12);
    pivot.rotation.z = Math.sin(t * 2.7) * 0.05;
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  return g;
}

// =============================================================================
// FRIGATE — small flying warship (≈ 2.6 wide with its nacelles, 3.8 long)
// =============================================================================
const FR_HULL = [[-1.95, 0.02, 0.26, 0.02], [-1.62, 0.34, 0.24, 0.2], [-1.05, 0.6, 0.22, 0.34], [-0.2, 0.7, 0.21, 0.4],
  [0.9, 0.68, 0.21, 0.38], [1.5, 0.6, 0.21, 0.3], [1.78, 0.52, 0.21, 0.22]];
function buildFrigateHull() {
  const b = new GB();
  // hull section: crowned deck, chine, V keel
  const ring = ([z, w, dk, kl]) => [[0, dk + 0.03, z], [w * 0.8, dk, z], [w, dk - 0.1, z], [w * 0.74, -kl * 0.45, z], [0, -kl, z],
    [-w * 0.74, -kl * 0.45, z], [-w, dk - 0.1, z], [-w * 0.8, dk, z]];
  const d0 = b.n;
  b.loft(FR_HULL.map(ring), (i, j) => {
    if (j === 0 || j === 7) return i === 0 ? K.plateLt : K.steel;          // deck
    if (j === 1 || j === 6) return i === 0 ? K.plateLt : K.plate;          // pale topsides
    if (j === 2 || j === 5) return i === 3 || i === 4 ? K.red : K.steelDk;  // red chine stripe amidships
    return K.steelXDk;
  }, null, K.steelDk);
  const d1 = b.n;
  // deck markings: walkway lines, bow chevrons, stern hazard band
  b.drape(stripe([[-0.46, -0.9], [-0.46, 1.6]], 0.035).concat(stripe([[0.46, -0.9], [0.46, 1.6]], 0.035)), K.steelDk, d0, d1, 0.006, 1);
  hazardDrape(b, -0.25, -1.45, 0.25, -1.45, 0.14, 5, K.red, K.black, d0, d1, 0.009, 1);
  hazardDrape(b, -0.4, 1.66, 0.4, 1.66, 0.08, 6, K.red, K.black, d0, d1, 0.006, 1);
  // bridge: two tiers with glowing cyan windows and a red sensor eye, mast + radar bar
  b.block({ x: 0, y: 0.2, z: 0.3, w: 0.66, d: 0.72, h: 0.24, tw: 0.58, td: 0.62, oz: 0.04, bev: 0.04, top: K.plate, bevS: K.plateLt, side: K.steel, front: K.steelLt });
  b.block({ x: 0, y: 0.44, z: 0.24, w: 0.44, d: 0.38, h: 0.14, tw: 0.36, td: 0.3, oz: 0.03, bev: 0.03, top: K.steelLt, bevS: K.plateLt, side: K.steelDk });
  b.decal([[-0.2, 0.555, 0.07], [0.2, 0.555, 0.07], [0.18, 0.51, 0.055], [-0.18, 0.51, 0.055]], G_CY, [0, 0.3, -1]);
  b.decal([[-0.05, 0.585, 0.12], [0.05, 0.585, 0.12], [0.05, 0.585, 0.18], [-0.05, 0.585, 0.18]], G_RD);
  b.lathe([0, 0.58, 0.36], [0, 1, 0], [[0, 0.03], [0.3, 0.018]], 5, K.steelDk, null, K.steel);
  b.block({ x: 0, y: 0.8, z: 0.36, w: 0.38, d: 0.06, h: 0.04, top: K.plateLt, side: K.steel });
  const f0 = b.n;
  // lift nacelle on a pylon: cyan intake ring, hot exhaust
  b.lathe([1.08, -0.06, -0.85], [0, 0, 1], [[0, 0.1], [0.12, 0.2], [1.6, 0.2], [1.95, 0.15], [2.05, 0.15]], 6, (i, j) => {
    if (i === 0) return K.plateLt;
    if (i === 2) return K.steelDk;
    return j === 1 || j === 2 ? K.plate : K.steel;
  }, G_CYD, G_CYH, { phase: Math.PI / 6 });
  b.decal([[1.0, 0.145, -0.2], [1.16, 0.145, -0.2], [1.16, 0.145, 0.5], [1.0, 0.145, 0.5]], K.red);
  b.block({ x: 0.84, y: -0.05, z: 0.2, w: 0.5, d: 0.62, h: 0.1, tw: 0.46, td: 0.5, top: K.steel, side: K.steelDk });
  // stern fin (canted out)
  const f1 = b.n;
  b.wing([{ x: 0, zl: 1.2, zt: 1.8, t: 0.05 }, { x: 0.36, zl: 1.5, zt: 1.86, t: 0.02 }], (i, j) => (j === 0 ? K.edge : j >= 3 ? K.steelDk : K.steel), null, K.red);
  b.xform(f1, M(0.42, 0.18, 0, 0, 0, 48 * DEG));
  // deck-edge running lights
  b.decal([[0.55, 0.215, -0.9], [0.6, 0.212, -0.9], [0.6, 0.212, -0.7], [0.55, 0.215, -0.7]], G_CY);
  b.mirrorX(f0);
  return b;
}
function buildFrigateTurret() {
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.3], [0.07, 0.29], [0.1, 0.22]], 8, (i) => (i === 0 ? K.steelDk : K.edge), null, K.steel, { phase: Math.PI / 8 });
  b.block({ x: 0, y: 0.09, z: 0.03, w: 0.4, d: 0.46, h: 0.17, tw: 0.32, td: 0.36, oz: 0.03, bev: 0.03, top: K.plate, bevS: K.plateLt, side: K.steel, front: K.steelDk });
  for (const x of [-0.07, 0.07]) {
    b.lathe([x, 0.17, -0.18], [0, 0, -1], [[0, 0.04], [0.46, 0.032], [0.54, 0.044]], 6,
      (i) => (i === 1 ? K.edge : K.steelDk), null, G_CY, { phase: Math.PI / 6 });
  }
  b.decal([[-0.1, 0.262, -0.15], [0.1, 0.262, -0.15], [0.08, 0.262, -0.09], [-0.08, 0.262, -0.09]], G_RD);
  b.decal([[-0.12, 0.262, 0.08], [0.12, 0.262, 0.08], [0.12, 0.262, 0.13], [-0.12, 0.262, 0.13]], K.red);
  return b;
}
function createFrigate() {
  const { g, pivot, ud } = enemyShell('frigate', 1.6, '#3b4352');
  ud.halfExtents = { x: 1.3, z: 1.95 };
  const mat = bodyMat(0.6, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s3:frigate.hull', buildFrigateHull), mat));
  const tGeo = GG('ext:s3:frigate.turret', buildFrigateTurret);
  const local = [new THREE.Vector3(-0.07, 0.17, -0.74), new THREE.Vector3(0.07, 0.17, -0.74)];
  const mkTurret = (z) => {
    const t = new THREE.Group(); t.name = 'turret'; t.position.set(0, 0.22, z);
    t.add(new THREE.Mesh(tGeo, mat));
    t.userData.muzzles = local;
    pivot.add(t);
    return t;
  };
  const fore = mkTurret(-0.95), aft = mkTurret(1.12);
  aft.rotation.y = Math.PI;
  ud.turret = fore;
  ud.turrets = [fore, aft];
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:s3:frigate.flame', () => buildFlame([[-1.08, -0.06, 1.4], [1.08, -0.06, 1.4]], FLAME_ICE)), flameMat);
  flame.position.z = 1.2; flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const tmp = [new THREE.Vector3(), new THREE.Vector3()];
  const sync = () => {
    syncMuzzles(tmp, local, fore); ud.muzzles[0].copy(tmp[0]); ud.muzzles[1].copy(tmp[1]);
    syncMuzzles(tmp, local, aft); ud.muzzles[2].copy(tmp[0]); ud.muzzles[3].copy(tmp[1]);
  };
  sync();
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    sync();
    mat.uEmitScale.value = 0.85 + Math.sin(t * 4) * 0.15;
    flame.scale.set(1, 1, 1 + Math.sin(t * 41) * 0.1);
    pivot.position.y = Math.sin(t * 1.6) * 0.06;
    pivot.rotation.z = Math.sin(t * 1.1) * 0.03;
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  return g;
}

// =============================================================================
// LANCER — ram craft with a charging lance (≈ 3.0 long including the lance, 1.5 span)
// =============================================================================
function buildLancer() {
  const b = new GB();
  // lance: steel root, cyan charge coils, pale blade, red-hot tip
  b.lathe([0, 0.02, -0.7], [0, 0, -1], [[0, 0.085], [0.18, 0.08], [0.24, 0.095], [0.34, 0.095], [0.4, 0.07], [0.52, 0.07], [0.58, 0.085],
    [0.66, 0.085], [0.72, 0.06], [1.3, 0.03], [1.55, 0.0]], 6, (i, j) => {
    if (i === 2 || i === 6) return G_CY;
    if (i === 1 || i === 3 || i === 5 || i === 7) return K.steelDk;
    if (i === 9) return G_RD;
    if (i === 8) return j === 1 || j === 2 ? K.plateLt : K.edge;
    return K.steel;
  }, null, null, { phase: Math.PI / 6 });
  // body: short wedge, dark spine, pale shoulders
  const s0 = b.n;
  b.loft([[-0.82, 0.1, 0.1, 0.08], [-0.5, 0.22, 0.17, 0.12], [0.0, 0.3, 0.2, 0.14], [0.45, 0.3, 0.18, 0.14], [0.78, 0.24, 0.15, 0.12]].map((s) => ring8(s)), (i, j) => {
    const top = j === 0 || j === 7, sh = j === 1 || j === 6, fl = j === 2 || j === 5;
    if (top) return i === 1 ? K.red : K.steelDk;
    if (sh) return K.plate;
    if (fl) return K.steel;
    return K.steelXDk;
  }, K.steelDk, null);
  const s1 = b.n;
  b.drape([[[-0.07, -0.42], [0.07, -0.42], [0.1, -0.12], [-0.1, -0.12]]], K.glass, s0, s1, 0.006, 2);
  b.drape([[[-0.05, -0.62], [0.05, -0.62], [0.06, -0.52], [-0.06, -0.52]]], G_RD, s0, s1, 0.008, 1);
  // big engine: pale collar, cyan core
  b.lathe([0, 0, 0.72], [0, 0, 1], [[0, 0.22], [0.1, 0.26], [0.26, 0.25], [0.34, 0.2]], 8, (i, j) => (i === 0 ? K.plateLt : i === 1 ? (j & 1 ? K.steel : K.steelLt) : K.steelDk),
    null, G_CYH, { phase: Math.PI / 8 });
  const f0 = b.n;
  // delta canard (forward, big) and short swept blade wing
  b.wing([{ x: 0.2, y: 0.0, zl: -0.62, zt: 0.02, t: 0.07 }, { x: 0.62, y: 0.02, zl: -0.18, zt: 0.12, t: 0.03 }, { x: 0.74, y: 0.02, zl: -0.02, zt: 0.14, t: 0.012 }],
    (i, j) => (j >= 4 ? K.steelXDk : j === 0 ? K.edge : i === 1 ? K.red : j === 3 ? K.steel : K.plate), null, K.red);
  b.wing([{ x: 0.24, y: -0.02, zl: 0.26, zt: 0.7, t: 0.05 }, { x: 0.58, y: 0.0, zl: 0.5, zt: 0.78, t: 0.02 }],
    (i, j) => (j >= 4 ? K.steelXDk : j === 0 ? K.edge : j === 3 ? K.steelDk : K.steel), null, K.steelDk);
  // energy rail from canard root to the lance coils
  b.block({ x: 0.13, y: 0.1, z: -0.5, w: 0.05, d: 0.5, h: 0.05, top: G_CY, side: K.steelDk });
  // dorsal fin
  const f1 = b.n;
  b.wing([{ x: 0, zl: 0.2, zt: 0.74, t: 0.04 }, { x: 0.3, zl: 0.46, zt: 0.8, t: 0.02 }], (i, j) => (j === 0 ? K.edge : K.steel), null, K.red);
  b.xform(f1, M(0.08, 0.14, 0, 0, 0, 70 * DEG));
  b.mirrorX(f0);
  return b;
}
function createLancer() {
  const { g, pivot, ud } = enemyShell('lancer', 0.9, '#3b4352');
  const mat = bodyMat(0.5, 0.35);
  pivot.add(new THREE.Mesh(GG('ext:s3:lancer', buildLancer), mat));
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:s3:lancer.flame', () => buildFlame([[0, 0, 2.2]], FLAME_ICE)), flameMat);
  flame.position.z = 1.04; flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  const beam = beamMesh('ext:s3:lancer.beam', 32, 0.12, 0.55);
  beam.m.position.set(0, -0.02, -2.3);
  pivot.add(beam.m);
  ud.muzzles = [new THREE.Vector3(0, 0, -2.2)];
  let charge = 0, boost = 0;
  /** 0..1: lance glow + targeting beam strength (the telegraph) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  /** 0..1: afterburner (the dash) */
  ud.setBoost = (v) => { boost = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    mat.uEmitScale.value = 0.8 + charge * (1.1 + Math.sin(t * 38) * 0.3) + Math.sin(t * 9) * 0.1;
    beam.m.userData.set(charge > 0 ? charge * (0.75 + Math.sin(t * 30) * 0.25) : 0);
    flame.scale.set(1 + boost * 0.4, 1, (0.8 + boost * 1.6) * (1 + Math.sin(t * 47) * 0.1));
    pivot.rotation.z = Math.sin(t * 2.1) * 0.04 * (1 - charge);
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); beam.mat.dispose(); };
  ud.setCharge(0);
  return g;
}

// =============================================================================
// MINELAYER — manta flying wing with a revolving mine drum (≈ 3.0 span, 2.0 long)
// =============================================================================
function buildMinelayer() {
  const b = new GB();
  const s0 = b.n;
  b.loft([[-1.0, 0.04, 0.05, 0.04], [-0.78, 0.28, 0.2, 0.14], [-0.3, 0.42, 0.26, 0.18], [0.4, 0.44, 0.25, 0.18], [0.9, 0.3, 0.16, 0.12]].map((s) => ring8(s)), (i, j) => {
    const top = j === 0 || j === 7, sh = j === 1 || j === 6, fl = j === 2 || j === 5;
    if (i === 0) return K.steelDk;
    if (top) return K.steel;
    if (sh) return i === 1 ? K.steelLt : K.plateDk;
    if (fl) return K.steelDk;
    return K.steelXDk;
  }, null, K.steelDk);
  const s1 = b.n;
  // red visor eyes, dark glass
  b.drape([[[0.03, -0.74], [0.16, -0.66], [0.15, -0.58], [0.03, -0.64]], [[-0.03, -0.64], [-0.15, -0.58], [-0.16, -0.66], [-0.03, -0.74]]], G_RD, s0, s1, 0.008, 1);
  // drum cradle (the drum itself is a separate, turning mesh on top of it)
  b.block({ x: 0, y: 0.2, z: 0.3, w: 0.62, d: 0.82, h: 0.08, tw: 0.56, td: 0.74, top: K.steelXDk, side: K.steelDk });
  for (const x of [-0.3, 0.3]) b.block({ x, y: 0.2, z: 0.3, w: 0.06, d: 0.78, h: 0.2, top: K.plate, side: K.steel });
  // drop chute at the stern with a red hazard band
  hazardDrape(b, -0.26, 0.82, 0.26, 0.82, 0.08, 5, K.red, K.black, s0, s1, 0.008, 1);
  const f0 = b.n;
  // manta wing: pale upper panels with red/black hazard bands (the mine-layer warning)
  const w0 = b.n;
  b.wing([{ x: 0.3, y: -0.02, zl: -0.78, zt: 0.84, t: 0.2 }, { x: 0.95, y: 0.02, zl: -0.2, zt: 0.8, t: 0.1 },
    { x: 1.48, y: 0.06, zl: 0.36, zt: 0.78, t: 0.04 }], (i, j) => {
    if (j >= 4) return K.steelXDk;
    if (j === 0) return K.edge;
    if (i === 1) return j === 3 ? K.steelDk : K.steel;
    return j === 3 ? K.steel : K.plate;
  }, null, K.steelDk);
  const w1 = b.n;
  hazardDrape(b, 0.62, -0.28, 0.62, 0.62, 0.16, 5, K.red, K.black, w0, w1, 0.008, 1);
  b.drape(stripe([[0.4, -0.5], [1.3, 0.42]], 0.02), G_CYD, w0, w1, 0.008, 1);
  // engine pod on the trailing edge
  b.lathe([0.5, 0.04, 0.2], [0, 0, 1], [[0, 0.07], [0.1, 0.13], [0.62, 0.12], [0.72, 0.09]], 6, (i, j) => (i === 0 ? K.plateLt : j === 1 || j === 2 ? K.plate : K.steel),
    null, G_CYH, { phase: Math.PI / 6 });
  // wing-tip light
  b.drape([[[1.3, 0.5], [1.42, 0.54], [1.44, 0.66], [1.32, 0.64]]], G_RD, w0, w1, 0.006, 1);
  b.mirrorX(f0);
  return b;
}
function buildMineDrum() {   // along z, turns about z; four glowing mines in its slots
  const b = new GB();
  b.lathe([0, 0, -0.36], [0, 0, 1], [[0, 0.1], [0.04, 0.2], [0.68, 0.2], [0.72, 0.1]], 8, (i, j) => (i === 1 ? (j & 1 ? K.steelDk : K.steel) : K.steelLt), K.steelDk, K.steelDk);
  for (let k = 0; k < 4; k++) {
    const a = (k * TAU) / 4 + Math.PI / 4, x = Math.cos(a) * 0.19, y = Math.sin(a) * 0.19;
    for (const z of [-0.14, 0.14]) {
      b.lathe([x, y, z - 0.1], [0, 0, 1], [[0, 0.02], [0.03, 0.08], [0.17, 0.08], [0.2, 0.02]], 5, (i) => (i === 1 ? GL(scl(RD, 0.85), 0.45) : K.steelXDk), null, null);
    }
  }
  return b;
}
function createMinelayer() {
  const { g, pivot, ud } = enemyShell('minelayer', 1.3, '#3b4352');
  ud.halfExtents = { x: 1.5, z: 1.0 };
  const mat = bodyMat(0.55, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s3:minelayer', buildMinelayer), mat));
  const drum = new THREE.Mesh(GG('ext:s3:minelayer.drum', buildMineDrum), mat);
  drum.position.set(0, 0.36, 0.3);
  pivot.add(drum);
  ud.muzzles = [new THREE.Vector3(0, 0, 0.95)];
  let turn = 0, pulse = 0;
  /** one mine dropped: the drum turns a slot and the drop light flares */
  ud.drop = () => { turn += Math.PI / 2; pulse = 1; };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    drum.rotation.z += (turn - drum.rotation.z) * Math.min(1, dt * 10);
    pulse = Math.max(0, pulse - dt * 3);
    mat.uEmitScale.value = 0.85 + pulse * 0.6 + Math.sin(t * 5) * 0.12;
    pivot.rotation.z = Math.sin(t * 1.3) * 0.05;
  };
  ud.dispose = () => mat.dispose();
  return g;
}

// =============================================================================
// VALKYRIE — mid-boss escort cruiser (≈ 7.8 span, 6.6 long)
// =============================================================================
const VK_HULL = [[-3.3, 0.06, 0.12, 0.08], [-2.9, 0.5, 0.36, 0.3], [-2.2, 0.9, 0.52, 0.42], [-1.2, 1.2, 0.6, 0.5], [0.4, 1.34, 0.64, 0.52],
  [1.9, 1.3, 0.62, 0.5], [2.7, 1.1, 0.56, 0.44], [3.1, 0.9, 0.5, 0.4]];
const VK_CORE = [0, 0.5, -0.5];            // reactor well (the core part's origin)
function buildValkyrieHull() {
  const b = new GB();
  const s0 = b.n;
  b.loft(VK_HULL.map((s) => ring10(s)), (i, j) => {
    const line = i === 3 || i === 5;
    if (j === 0) return line ? K.steelXDk : i <= 1 ? K.plateLt : K.plate;          // pale armoured deck
    if (j === 1 || j === 9) return line ? K.steelDk : K.edge;                         // lit bevels trace the hull
    if (j === 2 || j === 8) return i === 4 ? K.red : K.steel;
    return K.steelXDk;
  }, null, K.steelDk);
  const s1 = b.n;
  // prow: red visor slits and hazard chevrons
  for (const sg of [-1, 1]) b.drape([[[0.06 * sg, -2.95], [0.34 * sg, -2.62], [0.3 * sg, -2.52], [0.05 * sg, -2.8]]], G_RD, s0, s1, 0.008, 2);
  hazardDrape(b, -0.36, -2.25, 0.36, -2.25, 0.14, 6, K.red, K.black, s0, s1, 0.008, 1);
  // reactor collar around the core well (the shutters and orb are the core part)
  const N = 12;
  const cr = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [VK_CORE[0] + Math.cos(a) * r, y, VK_CORE[2] + Math.sin(a) * r]; });
  b.loft([cr(1.02, 0.5), cr(0.98, 0.72), cr(0.84, 0.84), cr(0.68, 0.82), cr(0.62, 0.52)], (i, j) => {
    if (i === 0) return j & 1 ? K.steel : K.steelDk;
    if (i === 1) return j % 3 === 1 ? G_CY : K.plateLt;
    if (i === 2) return K.plateDk;
    return K.steelXDk;
  });
  b.lathe([VK_CORE[0], 0.52, VK_CORE[2]], [0, 1, 0], [[0, 0.64], [0, 0.0]], N, K.black);
  // command tower aft of the core: two tiers, cyan window bands, red beacon
  b.block({ x: 0, y: 0.6, z: 1.35, w: 1.1, d: 1.2, h: 0.34, tw: 0.9, td: 1.0, oz: 0.06, bev: 0.05, top: K.plate, bevS: K.plateLt, side: K.steel, front: K.steelLt });
  b.block({ x: 0, y: 0.94, z: 1.4, w: 0.72, d: 0.72, h: 0.26, tw: 0.56, td: 0.58, oz: 0.04, bev: 0.04, top: K.steelLt, bevS: K.edge, side: K.steelDk });
  b.decal([[-0.34, 1.16, 1.07], [0.34, 1.16, 1.07], [0.3, 1.08, 1.05], [-0.3, 1.08, 1.05]], G_CY, [0, 0.3, -1]);
  b.decal([[-0.43, 0.9, 0.78], [0.43, 0.9, 0.78], [0.4, 0.82, 0.76], [-0.4, 0.82, 0.76]], G_CYD, [0, 0.3, -1]);
  b.lathe([0, 1.2, 1.5], [0, 1, 0], [[0, 0.07], [0.12, 0.05], [0.16, 0.0]], 6, K.steel, null, null);
  b.block({ x: 0, y: 1.3, z: 1.5, w: 0.1, d: 0.1, h: 0.08, top: G_RD, side: GL(RD, 0.25) });
  // armoured fore deck plates + spine conduit to the core
  b.block({ x: 0, y: 0.5, z: -1.75, w: 1.1, d: 0.9, h: 0.12, tw: 0.9, td: 0.76, bev: 0.04, top: K.plateLt, bevS: K.edge, side: K.steel });
  b.block({ x: 0, y: 0.6, z: -1.3, w: 0.16, d: 0.5, h: 0.06, top: G_CY, side: K.steelDk });
  // stern: engine block with three cyan nozzles
  b.block({ x: 0, y: -0.28, z: 2.95, w: 2.0, d: 0.5, h: 0.6, tw: 1.9, td: 0.44, bev: 0.05, top: K.steel, bevS: K.edge, side: K.steelDk, back: K.steelXDk });
  for (const x of [-0.66, 0, 0.66]) {
    b.lathe([x, 0.02, 3.1], [0, 0, 1], [[0, 0.24], [0.14, 0.27], [0.24, 0.27], [0.3, 0.22]], 8, (i) => (i === 1 ? K.edge : K.steelDk), null, G_CYH, { phase: Math.PI / 8 });
  }
  const f0 = b.n;
  // swept main wing: pale plates, red trim, dark root seam
  const w0 = b.n;
  b.wing([{ x: 1.1, y: -0.04, zl: -1.5, zt: 2.6, t: 0.4 }, { x: 2.1, y: -0.02, zl: -0.9, zt: 2.3, t: 0.3 }, { x: 2.18, y: -0.02, zl: -0.86, zt: 2.28, t: 0.3 },
    { x: 3.4, y: 0.02, zl: 0.3, zt: 1.9, t: 0.16 }, { x: 3.95, y: 0.04, zl: 0.9, zt: 1.72, t: 0.08 }], (i, j) => {
    if (j >= 4) return K.steelXDk;
    if (i === 1) return K.steelXDk;
    if (j === 0) return K.edge;
    if (i === 3) return j === 3 ? K.redDk : K.red;
    return j === 3 ? K.steelDk : j === 1 ? K.plateLt : K.plate;
  }, null, K.red);
  const w1 = b.n;
  // battery sponson (the battery part sits on it), cyan conduit hull → sponson
  blockOn(b, w0, w1, { x: 2.35, z: 0.25, w: 0.9, d: 1.0, h: 0.1, tw: 0.8, td: 0.9, bev: 0.03, top: K.steelDk, bevS: K.edge, side: K.steel }, 0.04);
  blockOn(b, w0, w1, { x: 1.6, z: 0.9, w: 0.9, d: 0.08, h: 0.08, top: G_CY, side: K.steelDk }, 0.04);
  hazardDrape(b, 1.28, -1.05, 1.28, 2.3, 0.16, 8, K.red, K.black, w0, w1, 0.008, 1);
  b.drape([[[3.55, 1.2], [3.75, 1.26], [3.78, 1.44], [3.58, 1.4]]], G_RD, w0, w1, 0.008, 1);
  // wingtip fin
  const f1 = b.n;
  b.wing([{ x: 0, zl: 0.9, zt: 1.8, t: 0.08 }, { x: 0.6, zl: 1.3, zt: 1.85, t: 0.03 }], (i, j) => (j === 0 ? K.edge : j >= 3 ? K.steelDk : K.steel), null, K.red);
  b.xform(f1, M(3.8, 0.05, 0, 0, 0, 80 * DEG));
  b.mirrorX(f0);
  return b;
}
function buildValkyrieBattery() {   // part-local, barrels along −z
  const b = new GB();
  b.lathe([0, -0.1, 0], [0, 1, 0], [[0, 0.5], [0.12, 0.48], [0.18, 0.4], [0.2, 0.0]], 10,
    (i, j) => (i === 0 ? K.steelDk : i === 1 ? ((j & 1) ? K.edge : K.plateLt) : K.steelXDk), null, null, { phase: Math.PI / 10 });
  b.block({ x: 0, y: 0.06, z: 0.05, w: 0.66, d: 0.78, h: 0.3, tw: 0.52, td: 0.64, oz: 0.05, bev: 0.05, top: K.plate, bevS: K.plateLt, side: K.steel, front: K.steelDk });
  for (const x of [-0.13, 0.13]) {
    b.lathe([x, 0.22, -0.32], [0, 0, -1], [[0, 0.07], [0.3, 0.06], [0.3, 0.075], [0.4, 0.075], [0.4, 0.055], [0.86, 0.05], [0.86, 0.066], [0.96, 0.066], [0.96, 0.03]], 6,
      (i) => (i === 2 || i === 6 ? K.edge : i === 1 ? G_CYD : K.steelDk), null, G_CY, { phase: Math.PI / 6 });
  }
  b.decal([[-0.16, 0.365, -0.2], [0.16, 0.365, -0.2], [0.12, 0.365, -0.11], [-0.12, 0.365, -0.11]], G_RD);
  b.decal([[-0.2, 0.365, 0.2], [0.2, 0.365, 0.2], [0.2, 0.365, 0.28], [-0.2, 0.365, 0.28]], K.red);
  return b;
}
function createValkyrie() {
  const { g, pivot, ud } = enemyShell('valkyrie', 2.2, '#3b4352');
  ud.midboss = true;
  ud.halfExtents = { x: 3.9, z: 3.3 };
  const hullMat = bodyMat(0.55, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s3:valkyrie.hull', buildValkyrieHull), hullMat));
  const allMats = [hullMat];
  // batteries: one geometry + wreck, mirrored placement (the barrels aim, so no scale flip)
  const batKeep = { keep: (x, y, z) => z + 0.3, crumple: 0.1, seed: 21, dir: [0, 0.4, -1], shards: 8, shardSize: 0.2, band: 0.35 };
  const batY = (gbOf('ext:s3:valkyrie.hull', buildValkyrieHull).surfaceY(2.35, 0.25) ?? 0.1) + 0.08;   // seated on its sponson
  const mkBattery = (side) => {
    const m = bodyMat(0.55, 0.3); allMats.push(m);
    const part = destructiblePart({ key: 'ext:s3:valkyrie.battery', build: buildValkyrieBattery, name: side < 0 ? 'batteryL' : 'batteryR', radius: 0.8,
      muzzles: [new THREE.Vector3(-0.13, 0.22, -1.3), new THREE.Vector3(0.13, 0.22, -1.3)], wreck: batKeep, sag: [0.1, -0.06, 0.08 * side], pos: [2.35 * side, batY, 0.25], mat: m });
    return part;
  };
  const batteryL = mkBattery(-1), batteryR = mkBattery(1);
  // core: cyan reactor orb under two shutters (the collar is part of the hull)
  const coreMat = bodyMat(0.5, 0.3), orbMat = bodyMat(0.4, 0.1);
  allMats.push(coreMat, orbMat);
  const orbGeo = GG('ext:s3:valkyrie.orb', () => orbGB(0.41, 0.23, CYH, 1.7)), orbDead = GG('ext:s3:valkyrie.orbDead', () => orbGB(0.36, 0.23, CYH, 4.1, true));
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const shGeo = GG('ext:s3:valkyrie.shutter', () => shutterGB(0.66, G_CY));
  const hingeR = new THREE.Object3D(); hingeR.position.set(0.66, 0.13, 0);
  const hingeL = new THREE.Object3D(); hingeL.position.set(-0.66, 0.13, 0);
  const shR = new THREE.Mesh(shGeo, coreMat); shR.position.set(-0.66, -0.13, 0);
  const shL = new THREE.Mesh(shGeo, coreMat); shL.position.set(0.66, -0.13, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  const core = makePart('core', 0.95, [{ mesh: orb, intact: orbGeo, wreck: orbDead }, { mesh: shR, hideOnDestroy: true }, { mesh: shL, hideOnDestroy: true }],
    [new THREE.Vector3(0, 0.4, 0)]);
  core.add(hingeR, hingeL);
  core.userData.materials.push(coreMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(VK_CORE[0], VK_CORE[1], VK_CORE[2]);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    hingeR.rotation.z = -e * 115 * DEG; hingeL.rotation.z = e * 115 * DEG;
  };
  core.userData.setOpen(0);
  pivot.add(batteryL, batteryR, core);
  ud.parts = { batteryL, batteryR, core };
  ud.muzzles = [new THREE.Vector3(0, 0.3, -3.2)];
  const flashAll = flashFn(allMats);
  ud.setFlash = (v) => flashAll(v * 0.4);   // armour hits on the body: a soft flash (the parts flash on their own)
  ud.update = (dt, t) => {
    const p = 0.8 + Math.sin(t * 3.4) * 0.2;
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = p;
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.35 + openT * 0.85) * (1 + Math.sin(t * 8) * 0.12);
    orb.rotation.y += dt * (0.4 + openT * 2.2);
    pivot.position.y = Math.sin(t * 0.9) * 0.1;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); };
  return g;
}

// =============================================================================
// SERAPH — boss mothership, six-winged sky citadel (≈ 17 span, 15 long)
// =============================================================================
// Hierarchy (so the death sequence can snap it apart):
//   pivot ┬ foreHinge (z 0.9) → fore: hull fore + fore wings, spineF, spineL, spineR, pods
//         ├ aftHinge  (z 0.9) → aft:  hull aft + aft wings + citadel + core collar, core, engine flames
//         ├ wingHingeL / R (root) → main wing mesh + two batteries each
//         └ halo (additive ring over the citadel spire)
const SR_SPLIT = 0.9;
const SR_FORE = [[-6.3, 0.05, 0.12, 0.06], [-5.7, 0.5, 0.36, 0.26], [-4.8, 0.95, 0.55, 0.4], [-3.4, 1.35, 0.7, 0.5], [-1.8, 1.7, 0.8, 0.56],
  [-0.2, 1.95, 0.85, 0.6], [SR_SPLIT, 2.05, 0.86, 0.62]];
const SR_AFT = [[SR_SPLIT, 2.05, 0.86, 0.62], [2.4, 2.25, 0.9, 0.65], [4.4, 2.3, 0.92, 0.66], [6.4, 2.15, 0.88, 0.62], [7.8, 1.85, 0.78, 0.55], [8.5, 1.55, 0.68, 0.5]];
const SR_CORE = [0, 0.95, 2.5];
const SR_SPINE = { F: [0, 0.8, -3.7], L: [-1.2, 0.95, -1.2], R: [1.2, 0.95, -1.2] };
const SR_POD = [5.35, 0.02, -1.5];
const SR_BATT = [[3.5, 0.34, 1.7], [5.3, 0.2, 3.1]];     // right wing; inner, outer
const SR_WROOT = [2.0, 0, 2.2];                          // main-wing hinge (right)
const SR_NOZ = [[-1.25, 0.1], [0, 0.1], [1.25, 0.1]];    // stern nozzles (z = 8.6)
const SR_AFTNOZ = [[-3.9, 0.6], [3.9, 0.6]];             // aft-wing nacelles (exit z = 8.9)
function hullStyle(i, j, n, line) {
  const seam = line.includes(i);
  if (j === 0) return seam ? K.steelXDk : K.plate;                      // pale armoured top deck
  if (j === 1 || j === 9) return seam ? K.steelDk : K.plateLt;            // bright bevels carry the outline at dusk
  if (j === 2 || j === 8) return i === n ? K.red : K.steel;
  if (j === 3 || j === 7) return K.steelDk;
  return K.steelXDk;
}
function buildSeraphFore() {
  const b = new GB();
  const s0 = b.n;
  b.loft(SR_FORE.map((s) => ring10(s)), (i, j) => hullStyle(i, j, 2, [3]), null, null);
  const s1 = b.n;
  // prow: ram blade + visor slits
  b.spike([[-0.16, 0.08, -6.1], [0.16, 0.08, -6.1], [0, 0.2, -5.9]], [0, 0.06, -7.0], (k) => (k === 2 ? K.plateLt : K.steel), K.steelDk);
  for (const sg of [-1, 1]) b.drape([[[0.1 * sg, -5.55], [0.5 * sg, -5.0], [0.44 * sg, -4.86], [0.08 * sg, -5.35]]], G_RD, s0, s1, 0.01, 2);
  // lance-cannon well (dark pit, red rim lights) and the two twin-gun wells
  b.plate([[-0.55, -4.6], [0.55, -4.6], [0.62, -2.8], [-0.62, -2.8]], 0.58, 0.705, K.black, null);
  b.drape(stripe([[-0.64, -4.62], [-0.7, -2.78]], 0.05).concat(stripe([[0.64, -4.62], [0.7, -2.78]], 0.05)), G_RD, s0, s1, 0.012, 1);
  for (const sg of [-1, 1]) {
    const x = SR_SPINE.R[0] * sg, z = SR_SPINE.R[2];
    const oct = Array.from({ length: 8 }, (_, k) => [x + Math.cos(Math.PI / 8 + (k * TAU) / 8) * 0.6, z + Math.sin(Math.PI / 8 + (k * TAU) / 8) * 0.6]);
    b.plate(oct, 0.7, 0.86, K.black, null);
    b.drape([[[x - 0.66, z - 0.66], [x + 0.66, z - 0.66], [x + 0.66, z - 0.6], [x - 0.66, z - 0.6]]], K.red, s0, s1, 0.012, 1);
  }
  // hazard chevrons across the prow, cyan spine conduit
  hazardDrape(b, -0.9, -2.3, 0.9, -2.3, 0.22, 9, K.red, K.black, s0, s1, 0.01, 1);
  b.block({ x: 0, y: 0.8, z: -1.6, w: 0.18, d: 2.2, h: 0.08, top: G_CY, side: K.steelDk });
  const f0 = b.n;
  // fore wing (pair 1): swept blade carrying the gun pod at its tip
  const w0 = b.n;
  b.wing([{ x: 1.4, y: 0.0, zl: -3.4, zt: 0.6, t: 0.4 }, { x: 3.4, y: 0.02, zl: -2.6, zt: 0.3, t: 0.28 }, { x: 3.48, y: 0.02, zl: -2.57, zt: 0.29, t: 0.28 },
    { x: 5.2, y: 0.04, zl: -2.0, zt: -0.3, t: 0.16 }], (i, j) => {
    if (j >= 4) return K.steelXDk;
    if (i === 1) return K.steelXDk;
    if (j === 0) return K.plateLt;
    return j === 3 ? K.steelDk : j === 1 ? K.plateLt : K.plate;
  }, null, K.steel);
  const w1 = b.n;
  b.drape(stripe([[1.8, -2.4], [4.8, -1.6]], 0.05), K.red, w0, w1, 0.01, 1);
  b.drape(stripe([[1.8, -0.2], [4.6, -0.6]], 0.03), G_CYD, w0, w1, 0.01, 1);
  // pylon under the pod
  b.block({ x: SR_POD[0], y: -0.2, z: -1.1, w: 0.4, d: 1.4, h: 0.28, tw: 0.3, td: 1.2, top: K.steel, side: K.steelDk });
  // shoulder armour + sponson for the twin gun
  b.block({ x: 1.55, y: 0.5, z: -0.2, w: 0.7, d: 1.6, h: 0.3, tw: 0.5, td: 1.4, ox: -0.08, bev: 0.05, top: K.plate, bevS: K.plateLt, side: K.steel });
  for (const z of [-4.0, -3.1]) b.spike([[1.02, 0.42, z - 0.3], [1.3, 0.34, z - 0.3], [1.3, 0.34, z + 0.3], [1.02, 0.42, z + 0.3]], [1.38, 0.95, z + 0.2], (k) => (k & 1 ? K.plateLt : K.steel));
  b.mirrorX(f0);
  return b;
}
function buildSeraphAft() {
  const b = new GB();
  const s0 = b.n;
  b.loft(SR_AFT.map((s) => ring10(s)), (i, j) => hullStyle(i, j, 1, [0, 3]), null, K.steelDk);
  const s1 = b.n;
  // reactor collar in front of the citadel
  const N = 14, [cx, cy, cz] = SR_CORE;
  const cr = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; });
  b.loft([cr(1.9, 0.86), cr(1.84, 1.16), cr(1.6, 1.32), cr(1.34, 1.3), cr(1.24, 0.9)], (i, j) => {
    if (i === 0) return j & 1 ? K.steel : K.steelDk;
    if (i === 1) return j % 3 === 1 ? G_CY : K.plateLt;
    if (i === 2) return K.plateDk;
    return K.steelXDk;
  });
  b.lathe([cx, 0.92, cz], [0, 1, 0], [[0, 1.26], [0, 0.0]], N, K.black);
  for (let k = 0; k < 4; k++) {         // buttress claws around the crown
    const f = b.n, a = Math.PI / 4 + (k * TAU) / 4;
    b.block({ x: 1.98, y: 0.86, z: 0, w: 0.5, d: 0.56, h: 0.52, tw: 0.3, td: 0.4, ox: -0.08, bev: 0.04, top: K.plate, bevS: K.plateLt, side: K.steel });
    b.spike([[2.16, 0.95, -0.22], [2.16, 0.95, 0.22], [2.16, 1.32, 0]], [2.55, 1.0, 0], (q) => (q === 1 ? K.plateLt : K.steelDk));
    b.xform(f, M(cx, 0, cz, 0, -a, 0));
  }
  // the citadel: stepped tiers, window bands, spire with a cyan beacon, flanking towers
  b.block({ x: 0, y: 0.88, z: 5.5, w: 3.0, d: 3.8, h: 0.42, tw: 2.7, td: 3.5, bev: 0.06, top: K.plate, bevS: K.plateLt, side: K.steel, front: K.steelLt });
  b.block({ x: 0, y: 1.3, z: 5.6, w: 2.0, d: 2.6, h: 0.44, tw: 1.7, td: 2.3, bev: 0.06, top: K.plateLt, bevS: K.edge, side: K.steelDk });
  b.block({ x: 0, y: 1.74, z: 5.7, w: 1.1, d: 1.4, h: 0.5, tw: 0.8, td: 1.1, bev: 0.05, top: K.plate, bevS: K.plateLt, side: K.steel });
  b.spike([[-0.3, 2.24, 5.45], [0.3, 2.24, 5.45], [0.3, 2.24, 5.95], [-0.3, 2.24, 5.95]], [0, 3.3, 5.7], (k) => (k & 1 ? K.plateLt : K.steel));
  b.block({ x: 0, y: 2.62, z: 5.7, w: 0.16, d: 0.16, h: 0.1, top: G_CYH, side: G_CY });
  for (const y of [0.98, 1.4]) {
    b.decal([[-1.2, y + 0.26, 3.58], [1.2, y + 0.26, 3.58], [1.2, y + 0.12, 3.57], [-1.2, y + 0.12, 3.57]], G_CYD, [0, 0.2, -1]);
  }
  b.decal([[-0.7, 1.96, 4.45], [0.7, 1.96, 4.45], [0.7, 1.86, 4.44], [-0.7, 1.86, 4.44]], G_CY, [0, 0.2, -1]);
  // stern engine block + three big nozzles
  b.block({ x: 0, y: -0.4, z: 8.3, w: 3.6, d: 0.7, h: 0.9, tw: 3.4, td: 0.6, bev: 0.06, top: K.steel, bevS: K.plateLt, side: K.steelDk, back: K.steelXDk });
  for (const [x, y] of SR_NOZ) {
    b.lathe([x, y, 8.45], [0, 0, 1], [[0, 0.44], [0.2, 0.48], [0.34, 0.48], [0.44, 0.4]], 8, (i, j) => (i === 1 ? (j & 1 ? K.plateLt : K.edge) : K.steelDk), null, G_CYH, { phase: Math.PI / 8 });
  }
  const f0 = b.n;
  // flanking tower
  b.block({ x: 1.45, y: 0.8, z: 7.1, w: 0.6, d: 0.8, h: 0.9, tw: 0.44, td: 0.6, bev: 0.04, top: K.plate, bevS: K.plateLt, side: K.steel });
  b.spike([[1.29, 1.7, 6.85], [1.61, 1.7, 6.85], [1.61, 1.7, 7.35], [1.29, 1.7, 7.35]], [1.45, 2.4, 7.1], (k) => (k & 1 ? K.plateLt : K.steelDk));
  b.decal([[1.2, 1.3, 6.69], [1.7, 1.3, 6.69], [1.7, 1.2, 6.68], [1.2, 1.2, 6.68]], G_RD, [0, 0.2, -1]);
  // aft wing (pair 3): swept back, dihedral, nacelle at mid-span
  const w0 = b.n;
  b.wing([{ x: 1.6, y: 0.1, zl: 5.4, zt: 8.4, t: 0.34 }, { x: 3.2, y: 0.4, zl: 6.3, zt: 8.8, t: 0.22 }, { x: 5.2, y: 0.8, zl: 7.6, zt: 9.5, t: 0.1 }], (i, j) => {
    if (j >= 4) return K.steelXDk;
    if (j === 0) return K.plateLt;
    if (i === 1) return j === 3 ? K.redDk : K.red;
    return j === 3 ? K.steelDk : K.plate;
  }, null, K.red);
  const w1 = b.n;
  b.lathe([SR_AFTNOZ[1][0], SR_AFTNOZ[1][1], 7.0], [0, 0, 1], [[0, 0.16], [0.2, 0.34], [1.6, 0.34], [1.9, 0.28]], 8, (i, j) => (i === 0 ? K.plateLt : j === 1 || j === 2 ? K.plate : K.steel),
    null, G_CYH, { phase: Math.PI / 8 });
  b.drape([[[4.9, 9.1], [5.15, 9.2], [5.2, 9.45], [4.95, 9.35]]], G_RD, w0, w1, 0.01, 1);
  b.mirrorX(f0);
  return b;
}
function buildSeraphWing() {   // right main wing (pair 2), group-local = model space
  const b = new GB();
  const w0 = b.n;
  b.wing([{ x: 1.9, y: -0.05, zl: -0.4, zt: 6.2, t: 0.7 }, { x: 4.2, y: -0.02, zl: 0.5, zt: 5.1, t: 0.5 }, { x: 4.3, y: -0.02, zl: 0.54, zt: 5.06, t: 0.5 },
    { x: 6.6, y: 0.02, zl: 1.7, zt: 4.1, t: 0.3 }, { x: 8.5, y: 0.06, zl: 2.9, zt: 3.7, t: 0.12 }], (i, j) => {
    if (j >= 4) return K.steelXDk;
    if (i === 1) return K.steelXDk;
    if (j === 0) return K.plateLt;
    if (i === 3) return j === 3 ? K.redDk : j === 1 ? K.red : K.plate;
    return j === 3 ? K.steelDk : j === 1 ? K.plateLt : K.plate;
  }, K.steel, K.red);
  const w1 = b.n;
  // panel seams, root hazard band, cyan light line, wingtip light
  b.drape(stripe([[2.6, 1.0], [6.0, 2.6]], 0.035).concat(stripe([[2.6, 4.2], [6.0, 3.7]], 0.035)), K.steelDk, w0, w1, 0.01, 1);
  hazardDrape(b, 2.15, 0.2, 2.15, 5.6, 0.24, 11, K.red, K.black, w0, w1, 0.01, 1);
  b.drape(stripe([[2.5, 0.0], [7.9, 2.9]], 0.04), G_CY, w0, w1, 0.012, 1);
  b.drape([[[8.1, 3.05], [8.4, 3.12], [8.44, 3.4], [8.14, 3.34]]], G_RD, w0, w1, 0.01, 1);
  // battery sponsons (the battery parts sit on them)
  for (const [x, , z] of SR_BATT) blockOn(b, w0, w1, { x, z, w: 1.1, d: 1.1, h: 0.12, tw: 0.98, td: 0.98, bev: 0.03, top: K.steelDk, bevS: K.plateLt, side: K.steel }, 0.05);
  // engine nacelle on the trailing edge
  b.lathe([3.1, 0.34, 2.8], [0, 0, 1], [[0, 0.18], [0.2, 0.4], [2.2, 0.4], [2.6, 0.32]], 8, (i, j) => (i === 0 ? K.plateLt : j === 1 || j === 2 ? K.plate : K.steel),
    null, G_CYH, { phase: Math.PI / 8 });
  // armour plates + wingtip spire
  blockOn(b, w0, w1, { x: 6.2, z: 2.6, w: 1.1, d: 0.9, h: 0.1, tw: 1.0, td: 0.8, top: K.plateLt, side: K.steel }, 0.04);
  b.spike([[7.6, 0.08, 2.9], [8.0, 0.08, 3.1], [7.8, 0.3, 3.0]], [8.9, 0.1, 1.9], (k) => (k === 2 ? K.plateLt : K.steel), K.steelDk);
  return b;
}
function buildSeraphPod() {   // part-local; barrels along −z (the fore-wing tip gun pod)
  const b = new GB();
  const s0 = b.n;
  b.lathe([0, 0, 1.3], [0, 0, -1], [[0, 0.2], [0.3, 0.44], [2.0, 0.5], [2.6, 0.46], [3.0, 0.36], [3.1, 0.3]], 8, (i, j) => {
    if (i === 1 || i === 3) return j === 1 || j === 2 ? K.plateLt : K.plate;
    if (i === 2) return j === 1 || j === 2 ? K.plate : K.steel;
    return K.steelDk;
  }, G_CYH, K.steelXDk, { phase: Math.PI / 8 });
  const s1 = b.n;
  // four-barrel rotary face
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4, x = Math.cos(a) * 0.17, y = Math.sin(a) * 0.17;
    b.lathe([x, y, -1.7], [0, 0, -1], [[0, 0.07], [0.5, 0.06], [0.5, 0.075], [0.6, 0.075], [0.6, 0.035]], 5, (i) => (i === 2 ? K.edge : K.steelDk), null, G_CY);
  }
  b.drape([[[-0.2, -1.05], [0.2, -1.05], [0.22, -0.8], [-0.22, -0.8]]], G_RD, s0, s1, 0.012, 1);
  hazardDrape(b, 0, -0.5, 0, 0.5, 0.5, 5, K.red, K.black, s0, s1, 0.012, 1);
  // fins
  for (const sg of [-1, 1]) b.block({ x: 0.5 * sg, y: -0.04, z: 0.6, w: 0.3, d: 0.8, h: 0.08, tw: 0.1, td: 0.6, oz: 0.1, top: K.plate, side: K.steelDk });
  return b;
}
function buildSeraphBattery() {   // part-local, twin barrels along −z
  const b = new GB();
  b.lathe([0, -0.1, 0], [0, 1, 0], [[0, 0.52], [0.13, 0.5], [0.2, 0.4], [0.22, 0.0]], 10,
    (i, j) => (i === 0 ? K.steelDk : i === 1 ? ((j & 1) ? K.edge : K.plateLt) : K.steelXDk), null, null, { phase: Math.PI / 10 });
  b.block({ x: 0, y: 0.08, z: 0.04, w: 0.7, d: 0.8, h: 0.3, tw: 0.54, td: 0.64, oz: 0.05, bev: 0.05, top: K.plate, bevS: K.plateLt, side: K.steel, front: K.steelDk });
  for (const x of [-0.13, 0.13]) {
    b.lathe([x, 0.24, -0.34], [0, 0, -1], [[0, 0.07], [0.62, 0.056], [0.62, 0.075], [0.74, 0.075], [0.74, 0.035]], 6, (i) => (i === 2 ? K.edge : K.steelDk), null, G_CY, { phase: Math.PI / 6 });
  }
  b.decal([[-0.16, 0.385, -0.22], [0.16, 0.385, -0.22], [0.12, 0.385, -0.12], [-0.12, 0.385, -0.12]], G_RD);
  b.decal([[-0.2, 0.385, 0.2], [0.2, 0.385, 0.2], [0.2, 0.385, 0.27], [-0.2, 0.385, 0.27]], K.red);
  return b;
}
function buildSeraphLance() {   // part-local; the prow's spinal lance cannon, barrel along −z
  const b = new GB();
  b.block({ x: 0, y: -0.3, z: 0.1, w: 1.0, d: 1.5, h: 0.46, tw: 0.8, td: 1.3, oz: 0.05, bev: 0.06, top: K.plate, bevS: K.plateLt, side: K.steel, front: K.steelDk });
  b.lathe([0, 0.06, -0.55], [0, 0, -1], [[0, 0.3], [0.2, 0.27], [0.28, 0.32], [0.4, 0.32], [0.46, 0.26], [0.6, 0.26], [0.66, 0.31], [0.78, 0.31], [0.84, 0.24],
    [1.7, 0.2], [1.7, 0.27], [1.95, 0.27], [1.95, 0.12]], 8, (i, j) => {
    if (i === 2 || i === 6) return G_CY;                      // charge coils
    if (i === 10) return j === 1 || j === 2 ? K.plateLt : K.edge;
    if (i === 9) return K.steelDk;
    return j === 1 || j === 2 ? K.steelLt : K.steel;
  }, null, G_CYH, { phase: Math.PI / 8 });
  b.decal([[-0.2, 0.165, 0.3], [0.2, 0.165, 0.3], [0.16, 0.165, 0.45], [-0.16, 0.165, 0.45]], G_RD);
  return b;
}
function buildSeraphTwin() {    // part-local; spinal spinner: two opposed barrels (±z), it turns as it sprays
  const b = new GB();
  b.lathe([0, -0.3, 0], [0, 1, 0], [[0, 0.56], [0.26, 0.54], [0.36, 0.44], [0.42, 0.22], [0.44, 0.0]], 8,
    (i, j) => (i === 1 ? ((j & 1) ? K.plate : K.plateLt) : i === 2 ? K.steel : i === 0 ? K.steelDk : K.steelLt), null, null, { phase: Math.PI / 8 });
  for (const sg of [-1, 1]) {
    b.block({ x: 0, y: -0.02, z: 0.42 * sg, w: 0.34, d: 0.36, h: 0.2, tw: 0.26, td: 0.3, top: K.plate, side: K.steel });
    b.lathe([0, 0.08, 0.5 * sg], [0, 0, sg], [[0, 0.1], [0.36, 0.08], [0.36, 0.1], [0.48, 0.1], [0.48, 0.05]], 6, (i) => (i === 2 ? K.edge : K.steelDk), null, G_CY, { phase: Math.PI / 6 });
  }
  b.decal([[-0.12, 0.145, -0.12], [0.12, 0.145, -0.12], [0.12, 0.145, 0.12], [-0.12, 0.145, 0.12]], G_CY);
  b.decal([[-0.2, 0.145, -0.26], [0.2, 0.145, -0.26], [0.2, 0.145, -0.2], [-0.2, 0.145, -0.2]], K.red);
  return b;
}
function buildHalo() {   // thin glowing ring (additive), radius 1.9, in the xz plane
  const pos = [], col = [];
  const N = 40, r0 = 1.78, r1 = 1.92;
  const cIn = [0.25, 0.9, 1.3], cOut = [0.05, 0.3, 0.7];
  for (let k = 0; k < N; k++) {
    const a0 = (TAU * k) / N, a1 = (TAU * (k + 1)) / N, f = 0.55 + 0.45 * Math.abs(Math.sin(a0 * 3));
    const P = (r, a) => [Math.cos(a) * r, 0, Math.sin(a) * r];
    pos.push(...P(r0, a0), ...P(r1, a0), ...P(r1, a1), ...P(r0, a0), ...P(r1, a1), ...P(r0, a1));
    const ci = cIn.map((v) => v * f), co = cOut.map((v) => v * f);
    col.push(...ci, ...co, ...co, ...ci, ...co, ...ci);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
function createSeraph() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss:seraph';
  ud.radius = 5.0;
  ud.debrisColor = new THREE.Color('#5a6475');
  const allMats = [];
  const mat = (r = 0.55, m = 0.32) => { const x = bodyMat(r, m); allMats.push(x); return x; };
  // ---- hull sections on hinges at the break line
  const hullMat = mat();
  const foreHinge = new THREE.Group(); foreHinge.position.set(0, 0, SR_SPLIT);
  const fore = new THREE.Group(); fore.position.set(0, 0, -SR_SPLIT); foreHinge.add(fore);
  const aftHinge = new THREE.Group(); aftHinge.position.set(0, 0, SR_SPLIT);
  const aft = new THREE.Group(); aft.position.set(0, 0, -SR_SPLIT); aftHinge.add(aft);
  fore.add(new THREE.Mesh(GG('ext:s3:seraph.fore', buildSeraphFore), hullMat));
  aft.add(new THREE.Mesh(GG('ext:s3:seraph.aft', buildSeraphAft), hullMat));
  const flameMat = additiveMat();
  const flames = new THREE.Mesh(G('ext:s3:seraph.flames', () => buildFlame([...SR_NOZ.map(([x, y]) => [x, y, 1.5]), ...SR_AFTNOZ.map(([x, y]) => [x, y, 0.9])], FLAME_BIG)), flameMat);
  flames.position.set(0, 0, 8.95); flames.userData.noShadow = true; flames.renderOrder = 2;
  aft.add(flames);
  // ---- main wings on root hinges
  const wingGeo = GG('ext:s3:seraph.wing', buildSeraphWing);
  const mkWing = (side) => {
    const hinge = new THREE.Group(); hinge.position.set(SR_WROOT[0] * side, SR_WROOT[1], SR_WROOT[2]);
    const grp = new THREE.Group(); grp.position.set(-SR_WROOT[0] * side, -SR_WROOT[1], -SR_WROOT[2]); hinge.add(grp);
    const m = new THREE.Mesh(wingGeo, hullMat);
    if (side < 0) m.scale.x = -1;
    grp.add(m);
    return { hinge, grp };
  };
  const wL = mkWing(-1), wR = mkWing(1);
  // ---- batteries (list: inner L, inner R, outer L, outer R)
  const batKeep = { keep: (x, y, z) => z + 0.3, crumple: 0.1, seed: 23, dir: [0, 0.4, -1], shards: 8, shardSize: 0.2, band: 0.35 };
  const battery = [];
  const wgb = gbOf('ext:s3:seraph.wing', buildSeraphWing);
  for (let k = 0; k < 4; k++) {
    const side = k & 1 ? 1 : -1, [x, , z] = SR_BATT[k >> 1], y = (wgb.surfaceY(x, z) ?? 0.3) + 0.09;   // seated on its sponson
    const part = destructiblePart({ key: 'ext:s3:seraph.battery', build: buildSeraphBattery, name: 'battery' + k, radius: 0.72,
      muzzles: [new THREE.Vector3(-0.13, 0.24, -1.1), new THREE.Vector3(0.13, 0.24, -1.1)], wreck: batKeep, sag: [0.12, -0.08, 0.1 * side], pos: [x * side, y, z], mat: mat() });
    (side < 0 ? wL : wR).grp.add(part);
    battery.push(part);
  }
  // ---- gun pods (list: L, R)
  const podKeep = { keep: (x, y, z) => z + 0.6, crumple: 0.14, seed: 29, dir: [0, 0, -1], shards: 12, shardSize: 0.3, band: 0.5 };
  const pods = [-1, 1].map((side) => {
    const part = destructiblePart({ key: 'ext:s3:seraph.pod', build: buildSeraphPod, name: 'pods' + (side < 0 ? 0 : 1), radius: 1.05,
      muzzles: [new THREE.Vector3(0, 0, -2.4)], wreck: podKeep, sag: [0.1, -0.12, 0.08 * side], pos: [SR_POD[0] * side, SR_POD[1], SR_POD[2]], mat: mat() });
    fore.add(part);
    return part;
  });
  // ---- spinal cannons: rise out of their wells (setRaise), the lance carries a telegraph beam
  const raiseY = [];
  const spineF = destructiblePart({ key: 'ext:s3:seraph.lance', build: buildSeraphLance, name: 'spineF', radius: 1.0,
    muzzles: [new THREE.Vector3(0, 0.06, -2.55)], wreck: { keep: (x, y, z) => z + 0.9, crumple: 0.12, seed: 31, dir: [0, 0.3, -1], shards: 10, shardSize: 0.26, band: 0.45 },
    sag: [0.1, -0.12, 0.06], pos: SR_SPINE.F, mat: mat() });
  const beam = beamMesh('ext:s3:seraph.beam', 34, 0.2, 0.8);
  beam.m.position.set(0, 0.06, -2.6);
  spineF.add(beam.m);
  spineF.userData.setBeam = beam.m.userData.set;
  const twinKeep = { keep: () => 1, crumple: 0.12, seed: 37, dir: [0, 1, 0], shards: 8, shardSize: 0.2, band: 2 };
  const spineL = destructiblePart({ key: 'ext:s3:seraph.twin', build: buildSeraphTwin, name: 'spineL', radius: 0.8,
    muzzles: [new THREE.Vector3(0, 0.08, -1.0), new THREE.Vector3(0, 0.08, 1.0)], wreck: twinKeep, sag: [0.08, -0.14, 0.06], pos: SR_SPINE.L, mat: mat() });
  const spineR = destructiblePart({ key: 'ext:s3:seraph.twin', build: buildSeraphTwin, name: 'spineR', radius: 0.8,
    muzzles: [new THREE.Vector3(0, 0.08, -1.0), new THREE.Vector3(0, 0.08, 1.0)], wreck: twinKeep, sag: [0.08, -0.14, -0.06], pos: SR_SPINE.R, mat: mat() });
  for (const p of [spineF, spineL, spineR]) { fore.add(p); raiseY.push([p, p.position.y]); }
  let raise = 1;
  /** 0 = sunk into their wells (sealed), 1 = raised for battle */
  ud.setRaise = (v) => { raise = Math.max(0, Math.min(1, v)); for (const [p, y] of raiseY) p.position.y = y - (1 - raise) * 0.62; };
  // ---- core: reactor orb under two dome shutters
  const coreMat = mat(0.5, 0.3), orbMat = mat(0.4, 0.1);
  const orbGeo = GG('ext:s3:seraph.orb', () => orbGB(0.8, 0.45, CYH, 2.3)), orbDead = GG('ext:s3:seraph.orbDead', () => orbGB(0.7, 0.45, CYH, 5.9, true));
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const shGeo = GG('ext:s3:seraph.shutter', () => shutterGB(1.3, G_CY));
  const hingeR = new THREE.Object3D(); hingeR.position.set(1.3, 0.26, 0);
  const hingeL = new THREE.Object3D(); hingeL.position.set(-1.3, 0.26, 0);
  const shR = new THREE.Mesh(shGeo, coreMat); shR.position.set(-1.3, -0.26, 0);
  const shL = new THREE.Mesh(shGeo, coreMat); shL.position.set(1.3, -0.26, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  const core = makePart('core', 1.5, [{ mesh: orb, intact: orbGeo, wreck: orbDead }, { mesh: shR, hideOnDestroy: true }, { mesh: shL, hideOnDestroy: true }],
    [new THREE.Vector3(0, 0.9, 0)]);
  core.add(hingeR, hingeL);
  core.userData.materials.push(coreMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(SR_CORE[0], SR_CORE[1], SR_CORE[2]);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    hingeR.rotation.z = -e * 118 * DEG; hingeL.rotation.z = e * 118 * DEG;
  };
  core.userData.setOpen(0);
  aft.add(core);
  // ---- halo over the citadel spire
  const haloMat = additiveMat();
  const halo = new THREE.Mesh(G('ext:s3:seraph.halo', buildHalo), haloMat);
  halo.position.set(0, 3.0, 5.7); halo.userData.noShadow = true; halo.renderOrder = 3;
  aft.add(halo);
  pivot.add(foreHinge, aftHinge, wL.hinge, wR.hinge);
  ud.parts = { battery, pods, spineF, spineL, spineR, core };
  ud.muzzles = [new THREE.Vector3(0, 0.3, -6.0)];
  ud.setFlash = flashFn(allMats);
  // ---- death: 0 = whole, 1 = snapped in two, main wings torn away (the AI sinks the whole group)
  let brk = 0;
  ud.setBreak = (v) => {
    brk = Math.max(0, Math.min(1, v));
    const e = brk * brk * (3 - 2 * brk);
    foreHinge.rotation.set(-0.42 * e, 0.06 * e, 0.1 * e); foreHinge.position.set(0, -0.7 * e, SR_SPLIT - 0.5 * e);
    aftHinge.rotation.set(0.3 * e, -0.05 * e, -0.08 * e); aftHinge.position.set(0, -0.3 * e, SR_SPLIT + 0.6 * e);
    wL.hinge.rotation.set(0.1 * e, 0.12 * e, 0.55 * e); wL.hinge.position.set(-SR_WROOT[0] - 1.2 * e, -1.4 * e, SR_WROOT[2]);
    wR.hinge.rotation.set(0.14 * e, -0.1 * e, -0.62 * e); wR.hinge.position.set(SR_WROOT[0] + 1.3 * e, -1.6 * e, SR_WROOT[2]);
  };
  ud.setBreak(0);
  ud.setRaise(1);
  ud.update = (dt, t) => {
    const pulse = 0.8 + Math.sin(t * 3.0) * 0.2;
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = pulse * (1 - brk * 0.6);
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.35 + openT * 0.9) * (1 + Math.sin(t * 8) * 0.12);
    orb.rotation.y += dt * (0.4 + openT * 2.4);
    halo.rotation.y += dt * (0.3 + openT * 1.4);
    haloMat.color.setScalar((0.7 + openT * 0.6 + Math.sin(t * 2.2) * 0.12) * (1 - brk));
    flames.scale.set(1, 1, (1 + Math.sin(t * 37) * 0.08 + Math.sin(t * 23) * 0.05) * (1 - brk * 0.85));
    flameMat.color.setScalar(0.9 + Math.sin(t * 29) * 0.1);
    pivot.position.y = Math.sin(t * 0.7) * 0.14;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); flameMat.dispose(); haloMat.dispose(); beam.mat.dispose(); };
  return g;
}

export const ENEMIES = {
  interceptor: createInterceptor,
  frigate: createFrigate,
  lancer: createLancer,
  minelayer: createMinelayer,
  valkyrie: createValkyrie,
};
export const BOSSES = { seraph: createSeraph };
