// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 8 "EDGE OF INFINITY" (宇宙盡頭)
// -----------------------------------------------------------------------------
// models.js registers these tables: createEnemy(type) falls back to ENEMIES[type],
// createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { s8_wraith, s8_watcher, s8_fractal, s8_mine, sentinel };
//   export const BOSSES = { omega };
//
// The Architects, the last machines at the edge of the Universe: void-obsidian hulls (blue-black
// glass) under pale platinum plate, lit from inside by white-gold starlight (eyes, seams, emitters);
// the wraiths burn a cold ghost-light instead, and OMEGA's true heart the crimson of the end of
// everything (stage 3's gunmetal / cyan, stage 4's white ceramic / emerald, stage 5's slate /
// moonlight blue, stage 6's bronze / gold and stage 7's plum chitin / lime stay distinct). The
// backdrops are black void, blue-violet web filaments, a cyan spacetime grid and a black hole's
// blue-white disk: the platinum and the starlight carry every unit on the black, the dark
// obsidian carries it on the bright filaments and the disk.
//
//   S8_WRAITH   void wraith (≈ 2.7 across): a hooded phantom in a tattered cloak, ghost-light eyes
//               and hem; userData.setPhase(0..1) folds it into a sliver of light (its blink: 1 =
//               gone) and back
//   S8_WATCHER  cosmic sentinel (≈ 3 across): a great eye in a gyroscope — a flat outer ring with four
//               emitters (userData.ring, its muzzles 0–3 turn with it) round a tilted inner ring;
//               userData.setCharge(0..1) lights the emitters and the iris
//   S8_FRACTAL  fractal construct (≈ 2.8 on a side): a Sierpinski tetrahedron of obsidian and platinum
//               with starlight in its voids; the stage flies it at three sizes (a construct splits into
//               smaller ones). userData.setCharge(0..1); muzzles at its three lower corners (0–2) and
//               its top (3)
//   S8_MINE     singularity mine (≈ 2.2 across the ring): a black sphere in a spinning accretion ring
//               and a faint lensing halo; userData.setArm(0..1) spins it up, the ring tightens and
//               blazes, the halo collapses onto it (the implosion's tell)
//   SENTINEL    mid-boss — see its section below
//   OMEGA       boss, the final core — see its section below
//
// Imports: only 'three' and './modelkit.js' — never models.js (import cycle).
// House style and helpers: see the modelkit.js header.
//
// Enemy contract — enemyShell(kind, radius, debrisHex) + bodyMat + GG(key, buildXxx):
//   * nose/front toward −z (the game yaws units that face the player by π), up +y,
//     centred on the origin. At the edge of the Universe: AIR UNITS ONLY (no userData.ground)
//   * userData: kind (the registry sets it to the type), radius, debrisColor, muzzles
//     (group-local Vector3[], refreshed in update() when they move), setFlash(v),
//     update(dt, t), dispose() (materials only)
//   * gameplay numbers (hp, score, collision radius) live in stage8.js ENEMY, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (userData.midboss)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) fully restores the pose
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
// Cache keys: 'ext:s8:<name>'.
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, S, DEG, TAU, lit, lin, rgb, GL, scl, nrm, mid, centroid, hash3, bodyMat, additiveMat, flashFn, enemyShell,
  makePart, destructiblePart, wreckGeo,
} from './modelkit.js';

// =============================================================================
// palette + shared helpers
// =============================================================================
const K = {
  obs: lit('#1a1c27'), obsLt: lit('#2a2e3d'), obsDk: lit('#101119'), obsXDk: lit('#07080c'),
  cloak: lit('#221e34'), cloakLt: lit('#363152'),                                      // the wraiths' indigo-black
  plat: lit('#98a0b0'), platLt: lit('#c0c6d2'), platDk: lit('#667085'),
  gilt: lit('#a8844c'), giltDk: lit('#6e5530'),                                        // gilded rims (albedo only)
  glass: S(lin('#0e1119'), rgb(0.03, 0.035, 0.07)),
};
const STAR = rgb(1.0, 0.84, 0.56, 3.2);     // white-gold starlight: eyes, seams, emitters
const STARH = rgb(1.0, 0.94, 0.8, 4.4);     // white-hot
const STARD = rgb(1.0, 0.76, 0.42, 1.5);    // dim seams
const GHOST = rgb(0.64, 0.95, 1.0, 3.0);    // the wraiths' ghost-light
const GHOSTD = rgb(0.5, 0.86, 1.0, 1.3);
const END = rgb(1.0, 0.1, 0.2, 3.4);        // entropy crimson (OMEGA's true heart)
const ENDH = rgb(1.0, 0.5, 0.55, 4.4);
const G_STAR = GL(STAR, 0.45), G_STARH = GL(STARH, 0.55), G_STARD = GL(STARD, 0.3);
const G_GHOST = GL(GHOST, 0.45), G_GHOSTD = GL(GHOSTD, 0.3);
const G_END = GL(END, 0.4), G_ENDH = GL(ENDH, 0.55);
const G_EMBER = GL(rgb(1.0, 0.1, 0.01, 0.6), 0.3);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/** faceted sphere (icosahedron of the given detail) of radius r centred on c; style(n, k) per face, n its unit
 *  normal, k a seeded 0..1. sy squashes it vertically */
function sphere(b, r, c, detail, style, seed = 1, sy = 1) {
  const geo = new THREE.IcosahedronGeometry(r, detail);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const A = [p[i] + c[0], p[i + 1] * sy + c[1], p[i + 2] + c[2]], B = [p[i + 3] + c[0], p[i + 4] * sy + c[1], p[i + 5] + c[2]];
    const C = [p[i + 6] + c[0], p[i + 7] * sy + c[1], p[i + 8] + c[2]];
    const n = nrm([(p[i] + p[i + 3] + p[i + 6]) / 3, (p[i + 1] + p[i + 4] + p[i + 7]) / 3, (p[i + 2] + p[i + 5] + p[i + 8]) / 3]);
    b.triO(A, B, C, c, style(n, hash3(i / 9, seed, 1.7)));
  }
  geo.dispose();
}
/** flat strip of half-width w from (x0, z0) to (x1, z1) at height y, facing up; w1 tapers the far end */
function strip(b, x0, z0, x1, z1, y, w, style, w1 = w) {
  const L = Math.hypot(x1 - x0, z1 - z0) || 1, ux = -(z1 - z0) / L, uz = (x1 - x0) / L;
  b.decal([[x0 + ux * w, y, z0 + uz * w], [x1 + ux * w1, y, z1 + uz * w1], [x1 - ux * w1, y, z1 - uz * w1], [x0 - ux * w, y, z0 - uz * w]], style);
}
/** closed rectangular-section ring (a flat washer) round `axis` through o: radii r0..r1, thickness 2h.
 *  style(face, j): face 0 bottom, 1 outer wall, 2 top, 3 inner wall; j the segment round */
function washer(b, o, axis, r0, r1, h, n, style, phase = 0) {
  // (not GB.lathe: a flat face's reference point would lie in its own plane and leave its facing to chance)
  const a = nrm(axis), u = Math.abs(a[1]) < 0.99 ? nrm([a[2], 0, -a[0]]) : [1, 0, 0];
  const v = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  const P = (r, th, y) => { const c = Math.cos(th) * r, s = Math.sin(th) * r; return [o[0] + u[0] * c + v[0] * s + a[0] * y, o[1] + u[1] * c + v[1] * s + a[1] * y, o[2] + u[2] * c + v[2] * s + a[2] * y]; };
  const na = [-a[0], -a[1], -a[2]];
  for (let j = 0; j < n; j++) {
    const t0 = phase + (TAU * j) / n, t1 = phase + (TAU * (j + 1)) / n, tm = (t0 + t1) / 2;
    const rd = [u[0] * Math.cos(tm) + v[0] * Math.sin(tm), u[1] * Math.cos(tm) + v[1] * Math.sin(tm), u[2] * Math.cos(tm) + v[2] * Math.sin(tm)];
    const i0 = P(r0, t0, h), i1 = P(r0, t1, h), o0 = P(r1, t0, h), o1 = P(r1, t1, h);
    const i0b = P(r0, t0, -h), i1b = P(r0, t1, -h), o0b = P(r1, t0, -h), o1b = P(r1, t1, -h);
    b.quadN(i0, o0, o1, i1, a, style(2, j));
    b.quadN(i0b, o0b, o1b, i1b, na, style(0, j));
    b.quadN(o0b, o1b, o1, o0, rd, style(1, j));
    b.quadN(i0b, i1b, i1, i0, [-rd[0], -rd[1], -rd[2]], style(3, j));
  }
}
/** octahedron of radius r at c (a glowing core in a fractal's void) */
function octa(b, c, r, style) {
  const V = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]].map((v) => [v[0] + c[0], v[1] + c[1], v[2] + c[2]]);
  for (const [a, bb, cc] of [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]) b.triO(V[a], V[bb], V[cc], c, style);
}
/** RGB flat annulus (additive halo / accretion glow) in the xz plane: radii r0 → r1, colours c0 → c1 (HDR rgb),
 *  n segments, optionally a second band r1 → r2 fading to c2; for additiveMat (vertex colours) */
function haloGeo(r0, r1, c0, c1, n, r2 = 0, c2 = null) {
  const pos = [], col = [];
  const ring = (ra, rb, ca, cb) => {
    for (let k = 0; k < n; k++) {
      const a0 = (TAU * k) / n, a1 = (TAU * (k + 1)) / n;
      const P = (r, a) => [Math.cos(a) * r, 0, Math.sin(a) * r];
      pos.push(...P(ra, a0), ...P(rb, a0), ...P(rb, a1), ...P(ra, a0), ...P(rb, a1), ...P(ra, a1));
      col.push(...ca, ...cb, ...cb, ...ca, ...cb, ...ca);
    }
  };
  ring(r0, r1, c0, c1);
  if (r2 > r1 && c2) ring(r1, r2, c1, c2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

// =============================================================================
// S8_WRAITH — void wraith (≈ 2.7 across the cloak, 2.3 long with its tatters)
// =============================================================================
// right half of the cloak's outline, front centre → back centre: the shoulders, the sleeve out to its hanging point,
// then the ragged hem (the rags longest in the middle)
const WR_CLOAK = [[0.0, -0.5], [0.42, -0.46], [0.86, -0.18], [1.2, 0.2], [1.3, 0.62], [1.02, 0.5], [0.9, 0.9], [0.66, 0.68],
  [0.52, 1.12], [0.3, 0.84], [0.16, 1.3], [0.0, 0.96]];
function buildWraith() {
  const b = new GB();
  const R = WR_CLOAK, outline = [...R, ...R.slice(1, -1).reverse().map(([x, z]) => [-x, z])];
  b.plate(outline, -0.03, 0.03, K.cloak, K.obsDk, K.obsXDk);
  // hood: a deep cowl over the front (8 facets: j = 1 on top), a platinum crest along its top
  b.lathe([0, 0.08, -0.98], [0, 0, 1], [[0, 0.0], [0.1, 0.2], [0.32, 0.34], [0.6, 0.34], [0.86, 0.2]], 8, (i, j) => {
    if (j === 1) return i === 0 ? K.obs : i < 3 ? K.plat : K.platDk;
    if (j === 0 || j === 2) return i === 0 ? K.obsDk : K.cloakLt;
    return K.obsXDk;
  }, null, K.obsDk, { phase: Math.PI / 8, sy: 0.72 });
  // the spine of the cloak and its folds: dark ridges running back from the shoulders
  b.lathe([0, 0.03, -0.3], [0, 0, 1], [[0, 0.13], [0.6, 0.1], [1.2, 0.02]], 6, (i, j) => (j === 1 ? K.cloakLt : K.obsDk), null, null, { phase: Math.PI / 6, sy: 0.6 });
  const f0 = b.n;
  // eyes: two ghost-light slits in the cowl, a faint glow of a face under it
  b.spike([[0.06, 0.33, -0.86], [0.17, 0.3, -0.8], [0.15, 0.3, -0.7]], [0.13, 0.38, -0.8], G_GHOST);
  strip(b, 0.02, -1.0, 0.16, -0.9, 0.02, 0.05, G_GHOSTD, 0.02);
  strip(b, 0.34, -0.3, 0.52, 0.9, 0.034, 0.05, K.cloakLt, 0.02);
  strip(b, 0.72, -0.08, 1.0, 0.72, 0.034, 0.045, K.cloakLt, 0.015);
  // claws: bone fingers reaching out ahead of the sleeves, ghost-lit at the tips
  const hand = [0.66, 0.0, -0.46];
  for (const [dx, dz, L] of [[0.12, -0.7, 0.62], [0.28, -0.6, 0.56], [-0.04, -0.72, 0.52]]) {
    const tip = [hand[0] + dx * L * 1.6, 0.02, hand[2] + dz * L * 1.6];
    b.spike([[hand[0] - 0.05, 0.05, hand[2] + 0.02], [hand[0] + 0.05, 0.05, hand[2] + 0.02], [hand[0], -0.02, hand[2]]], tip, K.platLt);
    b.spike([[tip[0] - 0.03, 0.03, tip[2] + 0.06], [tip[0] + 0.03, 0.03, tip[2] + 0.06], [tip[0], 0.0, tip[2] + 0.04]], [tip[0] + dx * 0.25, 0.02, tip[2] + dz * 0.25], G_GHOST);
  }
  // a ghost-lit hem along the rags' points only
  for (const k of [4, 6, 8, 10]) strip(b, R[k][0], R[k][1] - 0.18, R[k][0], R[k][1], 0.036, 0.02, G_GHOSTD, 0.005);
  b.mirrorX(f0);
  return b;
}
function buildWraithTatters() {   // mesh-local: roots on the line z = 0 (the mesh sits at z 0.52), streaming back along +z
  const b = new GB();
  const rib = (x0, dx, L, w, seed) => {
    const P = [];
    for (let k = 0; k <= 3; k++) { const t = k / 3; P.push([x0 + dx * t + Math.sin(t * 3 + seed) * 0.06, 0.0, L * t]); }
    for (let k = 0; k < 3; k++) {
      const wa = w * (1 - k / 3), wb = w * (1 - (k + 1) / 3) + 0.004;
      strip(b, P[k][0], P[k][2], P[k + 1][0], P[k + 1][2], 0.0, wa, k === 2 ? G_GHOSTD : k ? K.cloakLt : K.cloak, wb);
    }
  };
  rib(0.2, 0.28, 1.25, 0.1, 1.3); rib(0, 0, 1.55, 0.12, 2.1); rib(-0.2, -0.28, 1.25, 0.1, 3.7);
  return b;
}
function createWraith() {
  const { g, pivot, ud } = enemyShell('s8_wraith', 0.9, '#2c2742');
  const mat = bodyMat(0.5, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s8:wraith', buildWraith), mat));
  const tat = new THREE.Mesh(GG('ext:s8:wraith.tatters', buildWraithTatters), mat);
  tat.position.set(0, 0.0, 0.8);
  pivot.add(tat);
  ud.muzzles = [V3(0, 0.05, -1.0)];
  let phase = 0;
  const seed = Math.random() * 10;
  /** 0 = solid, 1 = folded into a sliver of light (a blink) */
  ud.setPhase = (v) => {
    phase = Math.max(0, Math.min(1, v));
    pivot.scale.set(1 - 0.94 * phase, 1 - 0.6 * phase, 1 + 1.3 * phase);
  };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    tat.rotation.y = Math.sin(t * 4.1 + seed) * 0.14;
    tat.scale.set(1, 1, 1 + Math.sin(t * 6.3 + seed) * 0.12);
    pivot.position.y = Math.sin(t * 2.2 + seed) * 0.08;
    mat.uEmitScale.value = 0.75 + Math.sin(t * 9 + seed) * 0.12 + phase * 1.8;
  };
  ud.dispose = () => mat.dispose();
  ud.setPhase(0);
  return g;
}

// =============================================================================
// S8_WATCHER — cosmic sentinel (≈ 3 across the outer ring): a great eye in a gyroscope
// =============================================================================
const WT_R = [1.2, 1.36];                        // outer ring radii
const WT_NODE = [0.25, 0.75, 1.25, 1.75].map((k) => k * Math.PI);
const WT_EYE = nrm([0, 0.75, -0.66]);            // the eye looks up and forward (toward the camera once yawed π)
function buildWatcherEye() {
  const b = new GB();
  // lathed round its gaze: pupil, white-hot iris, gold iris rim, a platinum ring, then the obsidian globe
  const r = 0.54, th = [0, 11, 24, 38, 50, 72, 100, 130, 158, 180].map((d) => d * DEG);
  b.lathe([0, 0.12, 0], WT_EYE, th.map((a) => [r * Math.cos(a), r * Math.sin(a) + 1e-4]), 12, (i, j) => {
    if (i === 0) return K.glass;
    if (i === 1) return G_STAR;
    if (i === 2) return G_STARD;
    if (i === 3) return j % 3 === 0 ? G_STARD : K.platLt;
    if (i === 4) return (j & 1) ? K.plat : K.platDk;
    return (j + i) % 4 === 0 ? K.obsLt : K.obs;
  }, null, null, { phase: Math.PI / 12 });
  return b;
}
function buildWatcherRing() {   // ring-local: the flat outer ring and its four emitters
  const b = new GB();
  washer(b, [0, 0, 0], [0, 1, 0], WT_R[0], WT_R[1], 0.06, 24, (f, j) => {
    if (f === 2) return j % 6 === 0 ? G_STARD : (j & 1) ? K.plat : K.platLt;
    if (f === 1) return K.obs;
    return K.obsDk;
  });
  for (const a of WT_NODE) {
    const c = Math.cos(a), s = Math.sin(a), rm = (WT_R[0] + WT_R[1]) / 2;
    b.block({ x: c * rm, y: -0.1, z: s * rm, w: 0.3, d: 0.3, h: 0.24, top: K.obsLt, side: K.obs, bev: 0.05, bevS: K.platDk, ry: -a });
    const tip = [c * (WT_R[1] + 0.3), 0.08, s * (WT_R[1] + 0.3)], ux = -s * 0.1, uz = c * 0.1;
    const base = [[c * WT_R[1] + ux, 0.02, s * WT_R[1] + uz], [c * WT_R[1], 0.16, s * WT_R[1]], [c * WT_R[1] - ux, 0.02, s * WT_R[1] - uz], [c * WT_R[1], -0.08, s * WT_R[1]]];
    b.spike(base, tip, (k) => (k === 0 ? G_STARH : G_STAR));
  }
  return b;
}
function buildWatcherGyro() {   // the tilted inner ring (it turns about the model's x axis)
  const b = new GB();
  washer(b, [0, 0, 0], [0, 0, 1], 0.78, 0.88, 0.05, 18, (f, j) => (f === 1 ? (j % 3 === 0 ? G_STARD : K.platDk) : f === 3 ? K.obsDk : K.obs));
  return b;
}
function createWatcher() {
  const { g, pivot, ud } = enemyShell('s8_watcher', 1.3, '#98a0b0');
  const eyeMat = bodyMat(0.35, 0.3), ringMat = bodyMat(0.5, 0.35);
  pivot.add(new THREE.Mesh(GG('ext:s8:watcher.eye', buildWatcherEye), eyeMat));
  const ring = new THREE.Object3D(); ring.name = 'ring';
  ring.add(new THREE.Mesh(GG('ext:s8:watcher.ring', buildWatcherRing), ringMat));
  ring.position.y = 0.1;
  ring.userData.muzzles = WT_NODE.map((a) => V3(Math.cos(a) * (WT_R[1] + 0.34), 0.08, Math.sin(a) * (WT_R[1] + 0.34)));
  pivot.add(ring);
  const gyro = new THREE.Mesh(GG('ext:s8:watcher.gyro', buildWatcherGyro), ringMat);
  gyro.position.y = 0.12;
  pivot.add(gyro);
  ud.ring = ring;
  ud.muzzles = [V3(0, 0.3, -0.6)];                  // the pupil
  let charge = 0;
  const seed = Math.random() * 10;
  /** 0..1: the emitters and the iris blaze (a burst coming) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([eyeMat, ringMat]);
  ud.update = (dt, t) => {
    gyro.rotation.set(0.5 + Math.sin(t * 0.9 + seed) * 0.35, t * 1.1 + seed, 0);
    eyeMat.uEmitScale.value = 0.55 + Math.sin(t * 5 + seed) * 0.08 + charge * 1.1;
    ringMat.uEmitScale.value = 0.6 + charge * (1.5 + Math.sin(t * 40) * 0.3);
    pivot.position.y = Math.sin(t * 1.6 + seed) * 0.1;
  };
  ud.dispose = () => { eyeMat.dispose(); ringMat.dispose(); };
  return g;
}

// =============================================================================
// S8_FRACTAL — fractal construct (a Sierpinski tetrahedron ≈ 2.8 on a side, one corner up)
// =============================================================================
const FR_L = 2.8, FR_H = FR_L * Math.sqrt(2 / 3), FR_RR = FR_L / Math.sqrt(3);
// corners: the top, then the three below (one toward the front, −z); centred on the centroid
const FR_V = [[0, FR_H * 0.75, 0], ...[0, 1, 2].map((k) => { const a = -Math.PI / 2 + (TAU * k) / 3; return [Math.cos(a) * FR_RR, -FR_H * 0.25, Math.sin(a) * FR_RR]; })];
function buildFractal() {
  const b = new GB();
  const rec = (v, depth, path) => {
    if (depth === 0) {
      const c = centroid(v), k = hash3(path * 1.37, 2.1, 5.3);
      const top = (k > 0.55) ? K.platLt : (k > 0.2 ? K.plat : K.obsLt);
      for (const [a, bb, cc] of [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 2, 3]]) {
        const fc = centroid([v[a], v[bb], v[cc]]), up = fc[1] - c[1] > 0.01;
        b.triO(v[a], v[bb], v[cc], c, a === 1 ? K.obsDk : up ? top : K.obs);
      }
      return;
    }
    // the void left in the middle of this tetrahedron (an octahedron on its edge midpoints): a core of light
    if (depth >= 2) octa(b, centroid(v), FR_L * Math.pow(0.5, 4 - depth) * 0.3, depth === 3 ? G_STAR : G_STARD);
    const m = (i, j) => mid(v[i], v[j]);
    rec([v[0], m(0, 1), m(0, 2), m(0, 3)], depth - 1, path * 4 + 1);
    rec([m(0, 1), v[1], m(1, 2), m(1, 3)], depth - 1, path * 4 + 2);
    rec([m(0, 2), m(1, 2), v[2], m(2, 3)], depth - 1, path * 4 + 3);
    rec([m(0, 3), m(1, 3), m(2, 3), v[3]], depth - 1, path * 4 + 4);
  };
  rec(FR_V, 3, 0);
  return b;
}
function createFractal() {
  const { g, pivot, ud } = enemyShell('s8_fractal', 1.4, '#c0c6d2');
  const mat = bodyMat(0.4, 0.35);
  const spin = new THREE.Object3D(); spin.name = 'spin';
  spin.add(new THREE.Mesh(GG('ext:s8:fractal', buildFractal), mat));
  pivot.add(spin);
  ud.spin = spin;
  ud.muzzles = [...FR_V.slice(1), FR_V[0]].map((v) => V3(v[0], v[1], v[2]));
  const local = ud.muzzles.map((v) => v.clone());
  let charge = 0, tint = 0;
  const seed = Math.random() * 10;
  /** 0..1: its cores blaze (a volley coming) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  /** 0 white-gold (a whole construct) … 1 pale ghost-blue (the smallest splinters): the light fades as it divides */
  ud.setTint = (v) => { tint = Math.max(0, Math.min(1, v)); mat.uEmitTint.value.setRGB(1 - 0.35 * tint, 1 - 0.1 * tint, 1 + 0.25 * tint); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    spin.rotation.set(Math.sin(t * 0.8 + seed) * 0.28, t * 0.9 + seed, Math.cos(t * 0.7 + seed) * 0.22);
    mat.uEmitScale.value = 0.75 + Math.sin(t * 3.1 + seed) * 0.1 + charge * (1.6 + Math.sin(t * 38) * 0.3);
    // the muzzles turn with the construct (group-local)
    spin.updateMatrix();
    for (let i = 0; i < 4; i++) ud.muzzles[i].copy(local[i]).applyMatrix4(spin.matrix);
  };
  ud.dispose = () => mat.dispose();
  ud.setTint(0);
  return g;
}

// =============================================================================
// S8_MINE — singularity mine (a black sphere ≈ 1 across in an accretion ring ≈ 2.2 across)
// =============================================================================
function buildMineCore() {
  const b = new GB();
  sphere(b, 0.46, [0, 0, 0], 1, (n, k) => (k > 0.9 ? K.platDk : k > 0.55 ? K.obsLt : n[1] > 0.3 ? K.obs : K.obsXDk), 3.3);
  // three short anchor horns (they read as a machine, not a rock)
  for (let q = 0; q < 3; q++) {
    const a = (q * TAU) / 3 + 0.5, c = Math.cos(a), s = Math.sin(a);
    const base = [[c * 0.4 - s * 0.08, 0.1, s * 0.4 + c * 0.08], [c * 0.4 + s * 0.08, 0.1, s * 0.4 - c * 0.08], [c * 0.38, 0.26, s * 0.38]];
    b.spike(base, [c * 0.72, 0.3, s * 0.72], (k) => (k === 1 ? G_STAR : K.platDk));
  }
  return b;
}
// the accretion disc: a hot inner edge fading out through gold gas to a dark rim, two spiral arms of hot gas wound
// through it (they trail its spin, so the turning reads); thin, lit on both sides
const MN_HOT = GL(rgb(1.0, 0.8, 0.5, 2.0), 0.45), MN_GAS = GL(rgb(1.0, 0.62, 0.28, 1.0), 0.3), MN_DIM = GL(rgb(0.8, 0.4, 0.16, 0.45), 0.2);
function buildMineRing() {
  const b = new GB();
  const n = 24, R = [0.6, 0.68, 0.86, 1.06], band = [MN_HOT, MN_GAS, MN_DIM];
  for (let k = 0; k < n; k++) {
    const a0 = (TAU * k) / n, a1 = (TAU * (k + 1)) / n, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    for (let q = 0; q < 3; q++) {
      const ra = R[q], rb = R[q + 1];
      const P = [[c0 * ra, 0, s0 * ra], [c0 * rb, 0, s0 * rb], [c1 * rb, 0, s1 * rb], [c1 * ra, 0, s1 * ra]];
      b.quadN(P[0], P[1], P[2], P[3], [0, 1, 0], band[q]);
      b.quadN(P[0], P[1], P[2], P[3], [0, -1, 0], q === 0 ? MN_GAS : K.obsDk);
    }
  }
  // spiral arms: from the inner edge out to the rim over a third of a turn
  for (let arm = 0; arm < 2; arm++) {
    const N = 8;
    for (let k = 0; k < N; k++) {
      const t0 = k / N, t1 = (k + 1) / N, a0 = arm * Math.PI - t0 * 2.2, a1 = arm * Math.PI - t1 * 2.2;
      const r0 = 0.62 + t0 * 0.44, r1 = 0.62 + t1 * 0.44, w0 = 0.07 * (1 - t0 * 0.7), w1 = 0.07 * (1 - t1 * 0.7);
      strip(b, Math.cos(a0) * r0, Math.sin(a0) * r0, Math.cos(a1) * r1, Math.sin(a1) * r1, 0.012, w0, t0 < 0.5 ? MN_HOT : MN_GAS, w1);
    }
  }
  return b;
}
function createMine() {
  const { g, pivot, ud } = enemyShell('s8_mine', 0.7, '#667085');
  const coreMat = bodyMat(0.35, 0.4), ringMat = bodyMat(0.5, 0.2);
  pivot.add(new THREE.Mesh(GG('ext:s8:mine', buildMineCore), coreMat));
  const tilt = new THREE.Object3D(); tilt.rotation.set(0.32, 0, 0.12);
  const ring = new THREE.Mesh(GG('ext:s8:mine.ring', buildMineRing), ringMat);
  tilt.add(ring); pivot.add(tilt);
  const haloMat = additiveMat();
  const halo = new THREE.Mesh(G('ext:s8:mine.halo', () => haloGeo(1.2, 1.42, [0.0, 0.0, 0.0], [0.1, 0.16, 0.3], 28, 1.62, [0, 0, 0])), haloMat);
  halo.userData.noShadow = true; halo.renderOrder = 2; halo.position.y = -0.05;
  pivot.add(halo);
  ud.muzzles = [V3(0, 0, 0)];
  let arm = 0, spin = 0;
  const seed = Math.random() * 10;
  /** 0..1: spun up, the ring tight and blazing, the halo collapsed onto it (the implosion's tell) */
  ud.setArm = (v) => { arm = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([coreMat, ringMat]);
  ud.update = (dt, t) => {
    spin += dt * (2.2 + arm * 14);
    ring.rotation.y = spin;
    ring.scale.setScalar(1 - arm * 0.35);
    const hs = (1 - arm * 0.62) * (1 + Math.sin(t * 3 + seed) * 0.05);
    halo.scale.set(hs, 1, hs);
    haloMat.color.setScalar(0.7 + arm * 2.4 + Math.sin(t * 5 + seed) * 0.1);
    ringMat.uEmitScale.value = 0.7 + arm * (1.8 + Math.sin(t * 46) * 0.4);
    coreMat.uEmitScale.value = 0.6 + arm * 1.2;
    pivot.rotation.y = -spin * 0.1;
  };
  ud.dispose = () => { coreMat.dispose(); ringMat.dispose(); haloMat.dispose(); };
  return g;
}

// =============================================================================
// SENTINEL — mid-boss: the great sentinel at the gate of the web (≈ 8 across the folded wings, 9 long)
// =============================================================================
// Hierarchy:
//   pivot ┬ body (the obsidian torso: a kite of plate from the robe's point to the crowned head, pauldrons,
//         │   folded wings, the eye's collar)
//         ├ halo (part: a ring of platinum and starlight behind the head, tilted up to face the camera; its inner
//         │   mesh spins in its plane and its eight rays are the muzzles 0–7, kept turning in update())
//         ├ sideR ─ hingeR ─ shieldR, sideL (scale.x −1) ─ hingeL ─ shieldL (parts: tower shields hinged at the
//         │   shoulders; userData.setGuard(0..1): 1 swung shut over the chest, 0 swung out to the sides.
//         │   Their muzzle is the shield's point)
//         └ eye (core part: the great eye in its collar under an iris of six obsidian petals; setOpen(0..1))
// Hit order in stage8.js: shields, halo, eye — a shut shield in front of the eye takes the shots meant for it.
const SN_EYE = [0, 0.74, -0.5];
const SN_HALO = [0, 1.55, 3.05];
const SN_HINGE = [1.8, 0.42, 0.95];
const SN_PLATE = [-1.12, 1.15, -1.95];        // shield centre relative to its hinge (guard pose = hinge turned 0)
const SN_OPEN = -1.25;                          // hinge turn when swung out
function snRing([z, w, tp, bt], y = 0) {        // 10-point armoured section [z, halfWidth, top, bottom]
  return [[-w * 0.36, y + tp, z], [w * 0.36, y + tp, z], [w * 0.8, y + tp * 0.78, z], [w, y + tp * 0.3, z], [w * 0.86, y - bt * 0.4, z],
    [w * 0.45, y - bt, z], [-w * 0.45, y - bt, z], [-w * 0.86, y - bt * 0.4, z], [-w, y + tp * 0.3, z], [-w * 0.8, y + tp * 0.78, z]];
}
function buildSentinelBody() {
  const b = new GB();
  // torso: the robe's point (front) → waist → chest → neck → the crowned head
  const SEC = [[-3.2, 0.04, 0.05, 0.04], [-2.5, 0.5, 0.22, 0.18], [-1.5, 0.92, 0.42, 0.28], [-0.5, 1.12, 0.56, 0.34], [0.5, 1.24, 0.62, 0.34],
    [1.35, 1.06, 0.58, 0.3], [1.95, 0.5, 0.5, 0.24], [2.25, 0.62, 0.72, 0.28], [2.95, 0.54, 0.8, 0.3], [3.45, 0.22, 0.52, 0.2]];
  b.loft(SEC.map((s) => snRing(s)), (i, j) => {
    const top = j === 0, sh = j === 1 || j === 9, fl = j === 2 || j === 8;
    if (i === 5) return top ? K.obsLt : K.obsDk;                                   // collar under the neck
    if (i >= 6) return top ? (i === 7 ? K.platLt : K.plat) : sh ? K.platDk : fl ? K.obs : K.obsDk;   // helm
    if (top) return i === 1 ? G_STARD : (i & 1) ? K.plat : K.platLt;               // breastplate bands (a seam on the robe)
    if (sh) return i === 2 ? K.platDk : K.plat;
    if (fl) return (i & 1) ? K.obsLt : K.obs;
    return K.obsDk;
  }, K.obsDk, K.obs);
  // the eye's collar: a raised gilded socket on the chest
  b.lathe([SN_EYE[0], 0.46, SN_EYE[2]], [0, 1, 0], [[0, 1.02], [0.12, 1.02], [0.22, 0.9], [0.28, 0.74]], 16, (i, j) => (i === 1 ? (j % 4 === 0 ? G_STARD : K.gilt) : i === 2 ? K.giltDk : K.obsDk), null, null, { phase: Math.PI / 16 });
  // the visor: a slit of starlight across the helm
  strip(b, -0.36, 2.5, 0.36, 2.5, 0.735, 0.05, G_STAR);
  const f0 = b.n;
  // pauldrons over the shield hinges
  b.block({ x: 1.45, y: 0.1, z: 0.95, w: 0.9, d: 1.3, h: 0.6, tw: 0.62, td: 1.0, top: K.platLt, side: K.obs, bev: 0.12, bevS: K.plat, rz: -0.18 });
  b.spike([[1.66, 0.62, 0.6], [1.9, 0.52, 0.95], [1.66, 0.62, 1.3]], [2.35, 0.95, 1.05], (k) => (k === 1 ? K.platDk : K.plat));
  // folded wings: long swept blades from behind the shoulders, up-screen and out (feathers of plate, starlight seams)
  for (let q = 0; q < 3; q++) {
    const x0 = 1.0 + q * 0.18, z0 = 1.5 + q * 0.25, x1 = 3.4 - q * 0.45, z1 = 4.2 - q * 0.55, y = 0.1 - q * 0.08;
    const w = 0.34 - q * 0.06;
    b.plate([[x0, z0 - w], [x1, z1], [x0 - 0.05, z0 + w]], y - 0.05, y + 0.05, q === 0 ? K.plat : q === 1 ? K.platDk : K.obsLt, K.obs, K.obsDk);
    strip(b, x0 + 0.1, z0, x1 - 0.2, z1 - 0.12, y + 0.052, 0.025, q === 0 ? G_STARD : K.obs, 0.008);
  }
  // tassets: two blades down the robe's flanks
  b.plate([[0.72, -0.9], [1.1, -1.2], [0.68, -3.0], [0.46, -2.3]], -0.02, 0.26, K.plat, K.obs, K.obsDk);
  strip(b, 0.84, -1.15, 0.64, -2.6, 0.265, 0.03, G_STARD, 0.01);
  // the crown: rays of plate round the back of the helm
  for (const [x, z, h] of [[0.2, 3.35, 1.0], [0.52, 3.05, 0.8]]) {
    b.spike([[x - 0.12, 0.5, z - 0.12], [x + 0.12, 0.5, z - 0.12], [x + 0.12, 0.5, z + 0.1], [x - 0.12, 0.5, z + 0.1]], [x * 1.9, 0.5 + h * 0.7, z + h], (k) => (k === 2 ? G_STAR : k & 1 ? K.plat : K.platLt));
  }
  b.mirrorX(f0);
  b.spike([[-0.12, 0.62, 3.3], [0.12, 0.62, 3.3], [0.12, 0.62, 3.52], [-0.12, 0.62, 3.52]], [0, 1.45, 4.45], (k) => (k === 2 ? G_STARH : k & 1 ? K.plat : K.platLt));
  return b;
}
function buildSentinelHalo() {   // part-local, in the ring's own plane (xz before the part's tilt)
  const b = new GB();
  washer(b, [0, 0, 0], [0, 1, 0], 1.72, 2.02, 0.07, 32, (f, j) => {
    if (f === 2) return j % 4 === 0 ? G_STAR : (j & 1) ? K.plat : K.platLt;
    if (f === 0) return j % 4 === 2 ? G_STARD : K.obs;
    return K.obsLt;
  });
  for (let k = 0; k < 8; k++) {
    const a = (k * TAU) / 8, c = Math.cos(a), s = Math.sin(a), px = -s, pz = c;
    const r0 = 2.0, r1 = k & 1 ? 2.45 : 2.75;
    b.spike([[c * r0 + px * 0.14, 0.07, s * r0 + pz * 0.14], [c * r0, 0.16, s * r0], [c * r0 - px * 0.14, 0.07, s * r0 - pz * 0.14], [c * r0, -0.06, s * r0]],
      [c * r1, 0.02, s * r1], (q) => (q === 0 ? G_STARH : q === 1 ? G_STAR : K.plat));
  }
  return b;
}
function buildSentinelShield() {   // part-local: a kite-shaped tower shield lying face up, point toward −z, centre at the origin
  const b = new GB();
  const O = [[0.0, 1.62], [0.5, 1.5], [0.64, 0.7], [0.52, -0.5], [0.0, -1.85], [-0.52, -0.5], [-0.64, 0.7], [-0.5, 1.5]];
  b.plate(O, -0.09, 0.07, K.platLt, K.obs, K.obsDk);
  // the rim: a raised obsidian border (strips round the outline), a ridge down the middle
  for (let k = 0; k < O.length; k++) { const A = O[k], B = O[(k + 1) % O.length]; strip(b, A[0] * 0.93, A[1] * 0.95, B[0] * 0.93, B[1] * 0.95, 0.072, 0.06, K.obsLt); }
  b.lathe([0, 0.07, -1.6], [0, 0, 1], [[0, 0.02], [0.3, 0.1], [2.8, 0.1], [3.1, 0.02]], 4, (i, j) => (j === 0 || j === 3 ? K.plat : K.platDk), null, null, { phase: Math.PI / 4, sy: 0.9 });
  // the sigil: a diamond of starlight round an eye
  const D = [[0, 0.95], [0.36, 0.2], [0, -0.75], [-0.36, 0.2]];
  for (let k = 0; k < 4; k++) { const A = D[k], B = D[(k + 1) % 4]; strip(b, A[0], A[1], B[0], B[1], 0.1, 0.035, G_STARD); }
  b.lathe([0, 0.11, 0.1], [0, 1, 0], [[0, 0.2], [0.06, 0.12], [0.08, 0.0]], 8, (i) => (i === 0 ? G_STAR : G_STARH), null, null);
  return b;
}
function buildSentinelEye(dead) {   // part-local, centred on the socket
  const b = new GB();
  const ed = nrm([0, 0.8, -0.6]), r = dead ? 0.62 : 0.7, th = [0, 12, 26, 42, 58, 80, 110, 145, 180].map((d) => d * DEG);
  b.lathe([0, 0, 0], ed, th.map((a) => [r * Math.cos(a), r * Math.sin(a) + 1e-4]), 14, (i, j) => {
    if (dead) return i < 3 ? (j % 3 === 0 ? G_EMBER : K.obsXDk) : (j & 1) ? K.obsDk : K.obs;
    if (i === 0) return K.glass;
    if (i === 1) return G_STARH;
    if (i === 2) return G_STAR;
    if (i === 3) return (j & 1) ? G_STARD : K.gilt;
    if (i === 4) return K.platLt;
    return (j + i) % 3 === 0 ? K.obsLt : K.obs;
  }, null, null, { phase: Math.PI / 14 });
  return b;
}
function buildSentinelIris() {   // part-local: six petals closing over the eye (a dome of radius 0.8 round it, split)
  const b = new GB();
  const TH = [0, 28, 56, 82, 102].map((d) => d * DEG), R = 0.8;
  const P = (a, th) => [Math.cos(a) * R * Math.sin(th), R * Math.cos(th), Math.sin(a) * R * Math.sin(th)];
  for (let k = 0; k < 6; k++) {
    const a0 = (k * TAU) / 6 + 0.035, a1 = ((k + 1) * TAU) / 6 - 0.035;
    for (let i = 0; i < TH.length - 1; i++) {
      const A = P(a0, TH[i]), B = P(a1, TH[i]), C = P(a1, TH[i + 1]), D = P(a0, TH[i + 1]);
      const st = i === 3 ? K.platDk : i === 2 ? K.plat : (k & 1) ? K.obsLt : K.obs;
      b.quadO(A, B, C, D, [0, 0, 0], st);
      b.quadO(A, B, C, D, scl(centroid([A, B, C, D]), 40), K.obsXDk);      // the inside
    }
  }
  return b;
}
function createSentinel() {
  const { g, pivot, ud } = enemyShell('sentinel', 2.6, '#98a0b0');
  ud.midboss = true;
  ud.halfExtents = { x: 4.0, z: 4.6 };
  const allMats = [];
  const mat = (r = 0.5, m = 0.35) => { const x = bodyMat(r, m); allMats.push(x); return x; };
  const hullMat = mat();
  pivot.add(new THREE.Mesh(GG('ext:s8:sentinel.body', buildSentinelBody), hullMat));
  // ---- the halo: tilted up behind the head, the ring spinning in its own plane
  const haloMat = mat(0.45, 0.4);
  const haloGeo8 = GG('ext:s8:sentinel.halo', buildSentinelHalo);
  const haloWreck = wreckGeo('ext:s8:sentinel.halo', buildSentinelHalo, { keep: (x, y, z) => (Math.atan2(z, x) > -0.4 && Math.atan2(z, x) < 1.9 ? -1 : 1), crumple: 0.12, seed: 91, dir: [0, 1, 0], shards: 12, shardSize: 0.26, band: 0.5 });
  const haloMesh = new THREE.Mesh(haloGeo8, haloMat);
  const halo = makePart('halo', 1.9, [{ mesh: haloMesh, intact: haloGeo8, wreck: haloWreck, sag: [0.2, -0.3, 0.1] }], []);
  halo.position.set(SN_HALO[0], SN_HALO[1], SN_HALO[2]);
  halo.rotation.x = -1.05;                        // stood up, leaning back from the camera's view: a wide ellipse
  const RAYS = [];
  for (let k = 0; k < 8; k++) { const a = (k * TAU) / 8, r1 = k & 1 ? 2.45 : 2.75; RAYS.push([Math.cos(a) * r1, Math.sin(a) * r1]); }
  halo.userData.muzzles = RAYS.map(() => V3(0, 0, 0));
  pivot.add(halo);
  // ---- the shields: one geometry (the left one mirrored through its side group)
  const shGeo = GG('ext:s8:sentinel.shield', buildSentinelShield);
  const shWreck = wreckGeo('ext:s8:sentinel.shield', buildSentinelShield, { keep: (x, y, z) => z - 0.1 + x * 0.35, crumple: 0.12, seed: 93, dir: [0, 0.4, -1], shards: 12, shardSize: 0.28, band: 0.5 });
  const hinges = [], shields = [];
  for (const sx of [1, -1]) {
    const side = new THREE.Object3D(); side.scale.x = sx;
    const hinge = new THREE.Object3D(); hinge.position.set(SN_HINGE[0], SN_HINGE[1], SN_HINGE[2]);
    const m = mat(0.45, 0.4);
    const mesh = new THREE.Mesh(shGeo, m);
    const part = makePart(sx > 0 ? 'shieldR' : 'shieldL', 1.35, [{ mesh, intact: shGeo, wreck: shWreck, sag: [0.25, -0.35, -0.3] }], [V3(0, 0.1, -1.7)]);
    part.position.set(SN_PLATE[0], SN_PLATE[1], SN_PLATE[2]);
    part.rotation.set(0.06, -0.12, -0.16);       // lying over the chest, the outer edge a little lower
    part.userData.mat = m;
    hinge.add(part); side.add(hinge); pivot.add(side);
    hinges.push(hinge); shields.push(part);
    let guard = 1;
    /** 1 = swung shut over the chest, 0 = swung out to the side */
    part.userData.setGuard = (v) => { guard = Math.max(0, Math.min(1, v)); const e = guard * guard * (3 - 2 * guard); hinge.rotation.y = SN_OPEN * (1 - e); };
    part.userData.setGuard(1);
  }
  // ---- the eye: the orb under the iris
  const eyeMat = bodyMat(0.35, 0.2), irisMat = mat(0.45, 0.4);
  const eyeGeo = GG('ext:s8:sentinel.eye', () => buildSentinelEye(false)), eyeDead = GG('ext:s8:sentinel.eyeDead', () => buildSentinelEye(true));
  const orb = new THREE.Mesh(eyeGeo, eyeMat);
  const iris = new THREE.Mesh(GG('ext:s8:sentinel.iris', buildSentinelIris), irisMat);
  const eye = makePart('eye', 0.95, [{ mesh: orb, intact: eyeGeo, wreck: eyeDead }, { mesh: iris, hideOnDestroy: true }], [V3(0, 0.45, -0.45)]);
  eye.position.set(SN_EYE[0], SN_EYE[1], SN_EYE[2]);
  eye.userData.materials.push(irisMat);
  eye.userData.setFlash = flashFn([eyeMat, irisMat]);
  let openT = 0;
  eye.userData.open = 0;
  eye.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); eye.userData.open = openT;
    const e = openT * openT * (3 - 2 * openT), s = 1 - e * 0.84;
    iris.scale.set(s, 1 - e * 0.55, s); iris.position.y = -e * 0.3; iris.rotation.y = e * 0.8;
  };
  eye.userData.setOpen(0);
  pivot.add(eye);
  ud.parts = { shieldL: shields[1], shieldR: shields[0], halo, eye };
  ud.muzzles = [V3(0, 0.6, -3.2)];
  let charge = 0, spin = 0;
  /** 0..1: the eye blazes (a judgment coming) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  /** pooled instances come back posed: shields shut, iris shut, halo whole and still */
  ud.reset = () => { for (const p of shields) p.userData.setGuard(1); eye.userData.setOpen(0); charge = 0; spin = 0; pivot.scale.setScalar(1); };
  const flashAll = flashFn(allMats);
  ud.setFlash = (v) => flashAll(v * 0.4);   // body hits: a soft flash (the parts flash on their own)
  ud.update = (dt, t) => {
    const p = 0.72 + Math.sin(t * 2.1) * 0.12;
    hullMat.uEmitScale.value = p;
    for (const s of shields) s.userData.mat.uEmitScale.value = s.userData.destroyed ? 0.6 : p;
    haloMat.uEmitScale.value = halo.userData.destroyed ? 0.6 : 0.8 + Math.sin(t * 3) * 0.12;
    spin += dt * (halo.userData.destroyed ? 0 : 0.7);
    haloMesh.rotation.y = spin;
    for (let k = 0; k < 8; k++) {
      const c = Math.cos(spin), s = Math.sin(spin), [x, z] = RAYS[k];
      halo.userData.muzzles[k].set(x * c + z * s, 0.02, -x * s + z * c);
    }
    eyeMat.uEmitScale.value = eye.userData.destroyed ? 0.7 : (0.45 + openT * 0.4) * (1 + Math.sin(t * 6) * 0.1) + charge * (1.3 + Math.sin(t * 44) * 0.3);
    orb.rotation.y = Math.sin(t * 0.7) * 0.2;
    pivot.position.y = Math.sin(t * 0.9) * 0.12;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); eyeMat.dispose(); };
  return g;
}

// =============================================================================
// OMEGA — boss: the final core (≈ 11 across the halo's eyes, 12 long from the prow to the crown)
// =============================================================================
// A mandala lying under the camera: a star caged at its centre, everything else turning round it.
// Hierarchy:
//   pivot ┬ base (the obsidian platform: four spars out along the diagonals to the pylon mounts, the crown of rays
//         │   behind, the prow in front with the Ω inlaid)
//         ├ gimbal ─ ringA (an armillary ring round the core: tilted, precessing, spinning)
//         ├ halo (the great ring, flat, turning: userData.muzzles 0–11 are the twelve nodes round its rim; setUnfold
//         │   widens it) ─ eye0..2 (parts: lenses on the halo under an iris; setOpen, setBeam, setCharge; rotation.y
//         │   aims one in the halo's turning frame)
//         ├ pylon0..3 (parts: monoliths on the mounts, a crystal of starlight floating over each — the muzzle)
//         ├ core (part: the star under four petals of its cage; setOpen folds them out)
//         └ heart (the core part of the unit: the singularity at the very centre — a black sphere in a crimson
//             accretion disc and its glow; hidden until setGrow brings it out)
// userData.setEnd(0..1) turns every light from starlight to the crimson of the end; setCollapse(0..1) draws the
// whole machine in on itself (the death).
const OM_CORE_Y = 1.45;
const OM_PYLON_R = 5.1;
const OM_HALO = [4.05, 4.45], OM_HALO_Y = 0.72, OM_EYE_R = 4.25;
const OM_EYE_A = [Math.PI / 2, Math.PI / 2 + TAU / 3, Math.PI / 2 + (2 * TAU) / 3];
const OM_PETAL_R = 1.72, OM_PETAL_T = 80 * DEG;
const OM_HINGE = [0, OM_PETAL_R * Math.cos(OM_PETAL_T), OM_PETAL_R * Math.sin(OM_PETAL_T) * Math.cos(Math.PI / 4)];   // core-local
const SUNF = rgb(1.0, 0.56, 0.2, 2.6);           // the star's cooler granules
function buildOmegaBase() {
  const b = new GB();
  // the platform: an octagon, a platinum inlay ring with starlight ticks
  const oct = [];
  for (let k = 0; k < 8; k++) { const a = ((k + 0.5) * TAU) / 8; oct.push([Math.cos(a) * 2.55, Math.sin(a) * 2.55]); }
  b.plate(oct, -0.36, 0.12, K.obs, K.obsLt, K.obsXDk);
  washer(b, [0, 0.13, 0], [0, 1, 0], 1.98, 2.22, 0.02, 32, (f, j) => (f === 2 ? (j % 4 === 0 ? G_STARD : K.platLt) : K.plat));
  // the prow: a tongue of plate toward the player with the Ω inlaid in starlight (its round top toward +z, the
  // back: after the boss is turned to face the jet it reads upright on the screen)
  b.plate([[-1.25, -2.2], [1.25, -2.2], [0.8, -4.3], [-0.8, -4.3]], -0.3, 0.1, K.obs, K.obsLt, K.obsXDk);
  const cz = -3.05, rO = 0.5, A0 = -52 * DEG, A1 = 232 * DEG, NA = 10;
  for (let k = 0; k < NA; k++) {
    const a0 = A0 + ((A1 - A0) * k) / NA, a1 = A0 + ((A1 - A0) * (k + 1)) / NA;
    strip(b, Math.cos(a0) * rO, cz + Math.sin(a0) * rO, Math.cos(a1) * rO, cz + Math.sin(a1) * rO, 0.105, 0.055, G_STAR);
  }
  for (const sx of [-1, 1]) {
    const x0 = Math.cos(sx > 0 ? A0 : A1) * rO, z0 = cz + Math.sin(A0) * rO;
    strip(b, x0, z0, x0 + sx * 0.3, z0 - 0.02, 0.105, 0.05, G_STAR);
  }
  const f0 = b.n;
  // the spars out to the pylon mounts (both on the +x side, then mirrored): platinum-topped beams with a seam
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    const c = Math.cos(a), s = Math.sin(a);
    b.block({ x: c * 3.55, y: -0.3, z: s * 3.55, w: 0.72, d: 2.5, h: 0.44, tw: 0.52, td: 2.3, bev: 0.08, top: K.plat, side: K.obs, bevS: K.platDk, ry: Math.PI / 2 - a });
    strip(b, c * 2.45, s * 2.45, c * 4.6, s * 4.6, 0.145, 0.05, G_STARD);
    b.lathe([c * OM_PYLON_R, -0.34, s * OM_PYLON_R], [0, 1, 0], [[0, 0.86], [0.3, 0.86], [0.44, 0.66]], 6, (i) => (i === 1 ? K.platDk : K.obs), null, K.obsLt, { phase: Math.PI / 6 });
  }
  // the crown: rays fanned out behind the core (the middle one on the centre line, added after the mirror)
  for (let i = 1; i <= 3; i++) {
    const a = Math.PI / 2 - i * 0.27, c = Math.cos(a), s = Math.sin(a), px = -s, pz = c, r0 = 2.35, L = 6.4 - i * 0.42;
    b.spike([[c * r0 + px * 0.3, -0.05, s * r0 + pz * 0.3], [c * r0, 0.34, s * r0], [c * r0 - px * 0.3, -0.05, s * r0 - pz * 0.3]], [c * L, 0.06, s * L],
      (k) => (k === 0 ? K.platLt : k === 1 ? K.plat : K.obs));
    strip(b, c * (r0 + 0.3), s * (r0 + 0.3), c * (L - 0.6), s * (L - 0.6), 0.2, 0.03, i === 3 ? G_STARD : K.platDk, 0.01);
  }
  // the prow's flanking blades
  b.spike([[1.15, -0.05, -2.1], [1.35, 0.25, -1.95], [1.55, -0.05, -1.8]], [2.4, 0.05, -3.9], (k) => (k === 1 ? K.plat : K.platLt));
  b.mirrorX(f0);
  b.spike([[-0.34, -0.05, 2.35], [0, 0.4, 2.35], [0.34, -0.05, 2.35]], [0, 0.08, 7.0], (k) => (k === 1 ? K.platLt : K.plat));
  strip(b, 0, 2.7, 0, 6.3, 0.21, 0.045, G_STAR, 0.015);
  return b;
}
function buildOmegaRingA() {   // the armillary ring (its own plane: xz), ticks of starlight round it like a dial
  const b = new GB();
  washer(b, [0, 0, 0], [0, 1, 0], 2.48, 2.72, 0.09, 40, (f, j) => {
    if (f === 2) return j % 5 === 0 ? G_STAR : (j & 1) ? K.plat : K.platLt;
    if (f === 0) return j % 5 === 0 ? G_STARD : K.obsDk;
    return f === 1 ? K.obs : K.platDk;
  });
  return b;
}
function buildOmegaHalo() {   // the great ring (halo-local), its twelve rim nodes and the three eye sockets
  const b = new GB();
  washer(b, [0, 0, 0], [0, 1, 0], OM_HALO[0], OM_HALO[1], 0.12, 48, (f, j) => {
    if (f === 2) return j % 4 === 0 ? G_STARD : (j & 1) ? K.plat : K.platLt;
    if (f === 1) return j % 4 === 2 ? K.platDk : K.obs;
    return f === 0 ? K.obsDk : K.obsLt;
  });
  for (let k = 0; k < 12; k++) {
    const a = (k * TAU) / 12 + TAU / 24, c = Math.cos(a), s = Math.sin(a), px = -s * 0.13, pz = c * 0.13, r = OM_HALO[1];
    b.spike([[c * r + px, 0.1, s * r + pz], [c * r, 0.2, s * r], [c * r - px, 0.1, s * r - pz], [c * r, -0.1, s * r]], [c * (r + 0.42), 0.04, s * (r + 0.42)],
      (q) => (q === 0 ? G_STARD : q === 1 ? K.plat : K.platDk));
  }
  for (const a of OM_EYE_A) {
    const c = Math.cos(a), s = Math.sin(a);
    b.lathe([c * OM_EYE_R, 0.1, s * OM_EYE_R], [0, 1, 0], [[0, 0.95], [0.1, 0.95], [0.16, 0.82]], 10, (i) => (i === 0 ? K.gilt : K.giltDk), null, K.obs, { phase: Math.PI / 10 });
  }
  return b;
}
function buildOmegaEye(dead) {   // part-local: the lens housing, the eye looking up and out (toward −z: its aim)
  const b = new GB();
  b.lathe([0, -0.1, 0], [0, 1, 0], [[0, 0.62], [0.22, 0.72], [0.36, 0.66], [0.44, 0.5]], 10, (i, j) => (dead ? ((j & 1) ? K.obsDk : K.obs) : i === 1 ? ((j & 1) ? K.plat : K.platLt) : K.obs), K.obsDk, null, { phase: Math.PI / 10 });
  const ed = nrm([0, 0.8, -0.6]), r = dead ? 0.42 : 0.5, th = [0, 13, 28, 45, 70, 110, 180].map((d) => d * DEG);
  b.lathe([0, 0.36, 0], ed, th.map((a) => [r * Math.cos(a), r * Math.sin(a) + 1e-4]), 12, (i, j) => {
    if (dead) return i < 3 && j % 3 === 0 ? G_EMBER : K.obsXDk;
    if (i === 0) return K.glass;
    if (i === 1) return G_STARH;
    if (i === 2) return G_STAR;
    if (i === 3) return (j & 1) ? G_STARD : K.gilt;
    return K.obs;
  }, null, null, { phase: Math.PI / 12 });
  return b;
}
function buildOmegaPylon() {   // part-local, its origin at mid-height: a monolith, a pyramidion, a crystal floating over it
  const b = new GB();
  const sq = (y, w) => [[0, y, -w], [w, y, 0], [0, y, w], [-w, y, 0]];
  b.loft([sq(-1.3, 0.56), sq(-0.2, 0.46), sq(0.55, 0.4), sq(0.72, 0.42), sq(1.0, 0.36)], (i, j) => {
    if (i === 2) return G_STARD;                                                   // a band of starlight
    return (j === 0 || j === 3) ? (i === 3 ? K.platLt : K.plat) : (i === 3 ? K.obsLt : K.obs);
  }, K.obsDk, null);
  b.spike(sq(1.0, 0.36), [0, 1.38, 0], (j) => (j === 0 || j === 3 ? K.platLt : K.obsLt));
  // the crystal (an elongated octahedron) of starlight
  const c = [0, 1.95, 0], w = 0.2, h = 0.42;
  const V = [[w, 0, 0], [0, 0, w], [-w, 0, 0], [0, 0, -w]].map((p) => [p[0] + c[0], c[1], p[2] + c[2]]);
  for (let k = 0; k < 4; k++) {
    b.triO(V[k], V[(k + 1) % 4], [c[0], c[1] + h, c[2]], c, k & 1 ? G_STAR : G_STARH);
    b.triO(V[k], V[(k + 1) % 4], [c[0], c[1] - h, c[2]], c, k & 1 ? G_STARD : G_STAR);
  }
  return b;
}
function buildOmegaCore(dead) {   // part-local: the star (dead: a cinder cracked with embers)
  const b = new GB();
  sphere(b, dead ? 1.12 : 1.25, [0, 0, 0], 2, (n, k) => {
    if (dead) return k > 0.86 ? G_EMBER : k > 0.5 ? K.obsDk : K.obsXDk;
    return k > 0.72 ? G_STARH : k > 0.3 ? G_STAR : GL(SUNF, 0.45);
  }, dead ? 6.1 : 5.2);
  return b;
}
function buildOmegaPetal() {   // hinge-local: a quarter of the cage over the +z side of the core, hinged at its foot
  const b = new GB();
  const NT = 4, NP = 3, R = OM_PETAL_R;
  const pt = (t, p) => { const th = (t / NT) * OM_PETAL_T, ph = ((p / NP) - 0.5) * (88 * DEG); return [R * Math.sin(th) * Math.sin(ph) - OM_HINGE[0], R * Math.cos(th) - OM_HINGE[1], R * Math.sin(th) * Math.cos(ph) - OM_HINGE[2]]; };
  const cen = [-OM_HINGE[0], -OM_HINGE[1], -OM_HINGE[2]];
  for (let t = 0; t < NT; t++) {
    for (let p = 0; p < NP; p++) {
      const A = pt(t, p), B = pt(t, p + 1), C = pt(t + 1, p + 1), D = pt(t + 1, p);
      const st = p === 1 ? (t === 3 ? K.gilt : t === 2 ? G_STARD : K.platLt) : (t === 3 ? K.giltDk : K.obsLt);
      b.quadO(A, B, C, D, cen, st);
      b.quadO(A, D, C, B, [cen[0] + 20 * (A[0] - cen[0]), cen[1] + 20 * (A[1] - cen[1]), cen[2] + 20 * (A[2] - cen[2])], K.obsXDk);   // inside
    }
  }
  return b;
}
function buildOmegaHeart(dead) {   // the singularity: a black sphere, a crimson rim where it bends the light
  const b = new GB();
  sphere(b, dead ? 0.7 : 0.95, [0, 0, 0], 1, (n, k) => {
    if (dead) return k > 0.85 ? G_EMBER : K.obsXDk;
    const rim = Math.abs(n[1]) < 0.35;
    return rim ? (k > 0.5 ? G_END : GL(scl(END, 0.5), 0.3)) : K.obsXDk;
  }, 8.8);
  return b;
}
const OM_DISC = [1.25, 1.45, 1.9, 2.5];
function buildOmegaDisc() {   // the heart's accretion disc: white-hot inside, crimson, dark red at the rim; two spiral arms
  const b = new GB();
  const n = 32, band = [G_ENDH, G_END, GL(scl(END, 0.35), 0.25)];
  for (let k = 0; k < n; k++) {
    const a0 = (TAU * k) / n, a1 = (TAU * (k + 1)) / n, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    for (let q = 0; q < 3; q++) {
      const ra = OM_DISC[q], rb = OM_DISC[q + 1];
      const P = [[c0 * ra, 0, s0 * ra], [c0 * rb, 0, s0 * rb], [c1 * rb, 0, s1 * rb], [c1 * ra, 0, s1 * ra]];
      b.quadN(P[0], P[1], P[2], P[3], [0, 1, 0], band[q]);
      b.quadN(P[0], P[1], P[2], P[3], [0, -1, 0], q ? K.obsXDk : G_END);
    }
  }
  for (let arm = 0; arm < 2; arm++) {
    for (let k = 0; k < 10; k++) {
      const t0 = k / 10, t1 = (k + 1) / 10, a0 = arm * Math.PI - t0 * 2.6, a1 = arm * Math.PI - t1 * 2.6;
      const r0 = 1.3 + t0 * 1.15, r1 = 1.3 + t1 * 1.15;
      strip(b, Math.cos(a0) * r0, Math.sin(a0) * r0, Math.cos(a1) * r1, Math.sin(a1) * r1, 0.015, 0.1 * (1 - t0 * 0.6), t0 < 0.4 ? G_ENDH : G_END, 0.1 * (1 - t1 * 0.6));
    }
  }
  return b;
}
/** RGBA vertex-alpha beam along −z from the origin (unit length: the mesh is scaled to its length): an HDR core that
 *  blooms and a translucent halo, fading with distance (normal blending, so it reads over the bright disk too) */
function buildBeam(w, halo, core, hot, edge) {
  const pos = [], col = [];
  const N = 8;
  const quad = (xa, xb, za, zb, ca, cb, fa, fb) => {
    const A = [xa, 0, za], B = [xb, 0, za], C = [xb, 0, zb], D = [xa, 0, zb];
    const c = (cc, f) => [cc[0], cc[1], cc[2], cc[3] * f];
    pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    col.push(...c(ca, fa), ...c(cb, fa), ...c(cb, fb), ...c(ca, fa), ...c(cb, fb), ...c(ca, fb));
  };
  for (let k = 0; k < N; k++) {
    const za = -k / N, zb = -(k + 1) / N, fa = 1 - 0.7 * (k / N), fb = 1 - 0.7 * ((k + 1) / N);
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
/** hidden beam mesh of length len; userData.set(v) shows it at strength v (0 hides it and collapses it to zero length,
 *  so bounding boxes ignore it) */
function beamMesh(key, len, w, halo, core, hot, edge) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(G(key, () => buildBeam(w, halo, core, hot, edge)), mat);
  m.name = 'beam'; m.visible = false; m.renderOrder = 3; m.userData.noShadow = true; m.frustumCulled = false;
  m.scale.z = 1e-4;
  m.userData.set = (v) => { const on = v > 0.01; m.visible = on; m.scale.z = on ? len : 1e-4; mat.opacity = Math.min(1, v); };
  return { m, mat };
}
function createOmega() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss:omega';
  ud.radius = 5.5;
  ud.debrisColor = new THREE.Color('#c0c6d2');
  const allMats = [], extra = [];
  const mat = (r = 0.5, m = 0.35) => { const x = bodyMat(r, m); allMats.push(x); return x; };
  const baseMat = mat(0.5, 0.35);
  const base = new THREE.Mesh(GG('ext:s8:omega.base', buildOmegaBase), baseMat);
  pivot.add(base);
  // ---- the armillary ring round the core
  const ringMat = mat(0.4, 0.45);
  const gimbal = new THREE.Object3D(); gimbal.position.y = OM_CORE_Y; gimbal.rotation.order = 'YXZ';
  const ringA = new THREE.Mesh(GG('ext:s8:omega.ringA', buildOmegaRingA), ringMat);
  gimbal.add(ringA); pivot.add(gimbal);
  // ---- the halo and its eyes
  const haloMat = mat(0.45, 0.4);
  const halo = new THREE.Object3D(); halo.name = 'halo'; halo.position.y = OM_HALO_Y;
  halo.add(new THREE.Mesh(GG('ext:s8:omega.halo', buildOmegaHalo), haloMat));
  halo.userData.muzzles = [];
  for (let k = 0; k < 12; k++) { const a = (k * TAU) / 12 + TAU / 24; halo.userData.muzzles.push(V3(Math.cos(a) * (OM_HALO[1] + 0.45), 0.04, Math.sin(a) * (OM_HALO[1] + 0.45))); }
  pivot.add(halo);
  const eyeGeo = GG('ext:s8:omega.eye', () => buildOmegaEye(false)), eyeDead = GG('ext:s8:omega.eyeDead', () => buildOmegaEye(true));
  const irisGeo = GG('ext:s8:sentinel.iris', buildSentinelIris);
  const eyes = OM_EYE_A.map((a, k) => {
    const m = mat(0.4, 0.3);
    const pod = new THREE.Mesh(eyeGeo, m), lid = new THREE.Mesh(irisGeo, m);
    lid.position.y = 0.36; lid.scale.setScalar(0.66);
    const part = makePart('eye' + k, 0.85, [{ mesh: pod, intact: eyeGeo, wreck: eyeDead }, { mesh: lid, hideOnDestroy: true }], [V3(0, 0.5, -0.45)]);
    part.position.set(Math.cos(a) * OM_EYE_R, 0.14, Math.sin(a) * OM_EYE_R);
    part.rotation.order = 'YXZ';
    part.userData.mat = m;
    const beam = beamMesh('ext:s8:omega.beam', 30, 0.09, 0.42, [1.7, 1.45, 1.0, 0.75], [0.9, 0.55, 0.2, 0.3], [0.4, 0.2, 0.05, 0]);
    beam.m.position.set(0, 0.5, -0.5);
    part.add(beam.m);
    extra.push(beam.mat);
    let open = 0, charge = 0;
    part.userData.open = 0; part.userData.charge = 0;
    /** 0..1: the iris opens on the lens */
    part.userData.setOpen = (v) => {
      open = Math.max(0, Math.min(1, v)); part.userData.open = open;
      const e = open * open * (3 - 2 * open), s = 0.66 * (1 - e * 0.84);
      lid.scale.set(s, 0.66 * (1 - e * 0.55), s); lid.position.y = 0.36 - e * 0.2; lid.rotation.y = e * 0.8;
    };
    /** 0..1: the lens blazes (a lance coming) */
    part.userData.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); part.userData.charge = charge; };
    part.userData.setBeam = beam.m.userData.set;
    part.userData.setOpen(0);
    halo.add(part);
    return part;
  });
  // ---- the pylons
  const pyKeep = { keep: (x, y, z) => -0.15 - y + (x + z) * 0.25, crumple: 0.1, seed: 95, dir: [0, 1, 0], shards: 10, shardSize: 0.26, band: 0.4 };
  const pylons = [0, 1, 2, 3].map((k) => {
    const a = Math.PI / 4 + (k * Math.PI) / 2, m = mat(0.45, 0.35);
    const p = destructiblePart({ key: 'ext:s8:omega.pylon', build: buildOmegaPylon, name: 'pylon' + k, radius: 0.95, muzzles: [V3(0, 1.95, 0)], wreck: pyKeep,
      sag: [0.12, -0.25, 0.1], pos: [Math.cos(a) * OM_PYLON_R, 1.4, Math.sin(a) * OM_PYLON_R], mat: m });
    p.userData.mat = m; p.userData.home = p.position.clone();
    pivot.add(p);
    return p;
  });
  // ---- the core: the star under the four petals of its cage
  const orbMat = bodyMat(0.4, 0.1), cageMat = mat(0.45, 0.4);
  const coreGeo = GG('ext:s8:omega.core', () => buildOmegaCore(false)), coreDead = GG('ext:s8:omega.coreDead', () => buildOmegaCore(true));
  const orb = new THREE.Mesh(coreGeo, orbMat);
  const petalGeo = GG('ext:s8:omega.petal', buildOmegaPetal);
  const hinges = [], petals = [];
  for (let k = 0; k < 4; k++) {
    const turn = new THREE.Object3D(); turn.rotation.y = (k * Math.PI) / 2;
    const hinge = new THREE.Object3D(); hinge.position.set(OM_HINGE[0], OM_HINGE[1], OM_HINGE[2]);
    const pm = new THREE.Mesh(petalGeo, cageMat);
    hinge.add(pm); turn.add(hinge);
    hinges.push({ turn, hinge }); petals.push(pm);
  }
  const core = makePart('core', 1.35, [{ mesh: orb, intact: coreGeo, wreck: coreDead }, ...petals.map((m) => ({ mesh: m, hideOnDestroy: true }))], [V3(0, 0.2, 0)]);
  for (const h of hinges) core.add(h.turn);
  core.userData.materials.push(cageMat);
  core.userData.setFlash = flashFn([orbMat, cageMat]);
  core.position.y = OM_CORE_Y;
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    for (const h of hinges) h.hinge.rotation.x = e * 112 * DEG;
  };
  core.userData.setOpen(0);
  pivot.add(core);
  // ---- the heart: hidden inside until the star is gone
  const heartMat = bodyMat(0.25, 0.5), discMat = bodyMat(0.5, 0.2), glowMat = additiveMat();
  const hGeo = GG('ext:s8:omega.heart', () => buildOmegaHeart(false)), hDead = GG('ext:s8:omega.heartDead', () => buildOmegaHeart(true));
  const hSphere = new THREE.Mesh(hGeo, heartMat);
  const discTilt = new THREE.Object3D(); discTilt.rotation.set(0.42, 0, -0.16);
  const disc = new THREE.Mesh(GG('ext:s8:omega.disc', buildOmegaDisc), discMat);
  discTilt.add(disc);
  const glow = new THREE.Mesh(G('ext:s8:omega.glow', () => haloGeo(2.3, 2.8, [0.0, 0.0, 0.0], [0.26, 0.02, 0.05], 36, 3.6, [0, 0, 0])), glowMat);
  glow.userData.noShadow = true; glow.renderOrder = 2; glow.position.y = -0.3;
  const heart = makePart('heart', 1.2, [{ mesh: hSphere, intact: hGeo, wreck: hDead }, { mesh: disc, hideOnDestroy: true }, { mesh: glow, hideOnDestroy: true }], [V3(0, 0, 0)]);
  heart.add(discTilt);
  heart.userData.materials.push(discMat);
  heart.userData.setFlash = flashFn([heartMat, discMat]);
  heart.position.y = OM_CORE_Y;
  let grow = 0;
  /** 0..1: the singularity comes out of the wreck of the star (0 = hidden) */
  heart.userData.setGrow = (v) => {
    grow = Math.max(0, Math.min(1, v)); heart.visible = grow > 0.01; heart.scale.setScalar(Math.max(0.01, grow));
    core.scale.setScalar(Math.max(0.01, 1 - grow)); core.visible = grow < 0.99;          // the star's cinder shrinks away round it
  };
  heart.userData.setGrow(0);
  pivot.add(heart);
  ud.parts = { pylon: pylons, eye: eyes, core, heart };
  ud.halo = halo;
  ud.muzzles = [V3(0, 0.3, -4.0)];                // the prow (the Ω)
  let end = 0, unfold = 0, collapse = 0, haloSpin = 0.25, ringSpin = 1.1;
  /** 0..1: the halo widens (phase 2: its eyes wake) */
  ud.setUnfold = (v) => { unfold = Math.max(0, Math.min(1, v)); };
  /** the halo's and the ring's turning rates (rad/s); halo.userData.rate reads back the halo's (stage8.js's armour
   *  leads an eye along its turn) */
  ud.setSpin = (h, r) => { haloSpin = h; ringSpin = r; halo.userData.rate = h * (1 + collapse * 6); };
  /** 0..1: every light turns from starlight to crimson */
  ud.setEnd = (v) => {
    end = Math.max(0, Math.min(1, v));
    for (const m of allMats) m.uEmitTint.value.setRGB(1 + 0.3 * end, 1 - 0.72 * end, 1 - 0.55 * end);
  };
  /** 0..1: the machine falls in on itself (the death) */
  ud.setCollapse = (v) => { collapse = Math.max(0, Math.min(1, v)); };
  const flashAll = flashFn([...allMats, orbMat, heartMat, discMat]);
  ud.setFlash = flashAll;
  /** pooled instances come back posed: halo folded and slow, eyes shut, cage shut, the heart hidden, starlight */
  ud.reset = () => {
    unfold = 0; collapse = 0; haloSpin = 0.25; ringSpin = 1.1; halo.rotation.y = 0;
    for (const e of eyes) { e.userData.setOpen(0); e.userData.setCharge(0); e.userData.setBeam(0); e.rotation.set(0, 0, 0); }
    core.userData.setOpen(0); heart.userData.setGrow(0); ud.setEnd(0);
    for (const p of pylons) p.position.copy(p.userData.home);
    pivot.scale.setScalar(1);
  };
  ud.reset();
  ud.update = (dt, t) => {
    const k = 1 - collapse;
    const cc = collapse * collapse * (3 - 2 * collapse);
    halo.userData.rate = haloSpin * (1 + collapse * 6);
    halo.rotation.y += dt * halo.userData.rate;
    halo.scale.setScalar((0.8 + 0.2 * unfold) * (1 - 0.9 * cc));
    ringA.rotation.y += dt * ringSpin * (1 + collapse * 6);
    gimbal.rotation.set(1.05 + Math.sin(t * 0.4) * 0.15, t * 0.3, 0);
    gimbal.scale.setScalar(1 - 0.85 * cc);
    base.scale.setScalar(1 - 0.55 * cc);
    for (const p of pylons) { p.position.copy(p.userData.home).multiplyScalar(1 - 0.8 * cc); }
    const pulse = (0.72 + Math.sin(t * 2.2) * 0.12) * (1 + end * 0.3);
    baseMat.uEmitScale.value = pulse; ringMat.uEmitScale.value = pulse; haloMat.uEmitScale.value = pulse + 0.1; cageMat.uEmitScale.value = pulse;
    for (const p of pylons) p.userData.mat.uEmitScale.value = p.userData.destroyed ? 0.6 : pulse + Math.sin(t * 3 + p.position.x) * 0.15;
    for (const e of eyes) {
      const u = e.userData;
      u.mat.uEmitScale.value = u.destroyed ? 0.6 : 0.4 + u.open * 0.3 + u.charge * (1.2 + Math.sin(t * 44) * 0.3);
    }
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.3 + openT * 0.28) * (1 + Math.sin(t * 5.3) * 0.08 + Math.sin(t * 13.1) * 0.05);
    orb.rotation.y += dt * 0.6;
    heartMat.uEmitScale.value = 0.8 + Math.sin(t * 6) * 0.2;
    discMat.uEmitScale.value = 0.75 + Math.sin(t * 3.7) * 0.12;
    disc.rotation.y -= dt * 2.4;
    glowMat.color.setScalar((0.8 + Math.sin(t * 2.6) * 0.2) * grow);
    pivot.position.y = Math.sin(t * 0.5) * 0.12 * k;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); for (const m of extra) m.dispose(); orbMat.dispose(); heartMat.dispose(); discMat.dispose(); glowMat.dispose(); };
  return g;
}

export const ENEMIES = {
  s8_wraith: createWraith,
  s8_watcher: createWatcher,
  s8_fractal: createFractal,
  s8_mine: createMine,
  sentinel: createSentinel,
};
export const BOSSES = { omega: createOmega };
