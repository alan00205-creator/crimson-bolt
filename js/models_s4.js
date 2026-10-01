// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 4 "ORBITAL FRONT" (軌道戰線)
// -----------------------------------------------------------------------------
// models.js registers these tables: createEnemy(type) falls back to ENEMIES[type],
// createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { s4_drone, s4_laser, s4_frigate, s4_mine, hydra };
//   export const BOSSES = { aegis };
//
// The orbital defence force: graphite hulls under white ceramic armour, gold-foil
// insulation, emerald sensor eyes and energy lines, amber warning lights and blue-violet
// ion drives (stage 3's gunmetal / red / cyan and the player's crimson stay distinct). The
// graphite carries the silhouettes over the white cloud of the day side, the ceramic and
// the gold over the black night side, deep space and the grey station hull.
//
//   S4_DRONE    octagonal sentinel drone: glowing eye, four thruster pods on outriggers,
//               a sensor crown that spins; userData.setThrust(0..1) flares its pods
//   S4_LASER    laser satellite: gold-foil bus, two solar wings that feather, an emitter on a
//               gimbal (userData.turret, aims) and a red targeting beam (userData.setCharge(0..1)
//               = lens glow + beam; setFire(0..1) = the discharge glare)
//   S4_FRIGATE  space frigate: long armoured hull, bridge tower, three twin-gun broadside
//               sponsons a side (muzzles 0–2 starboard, 3–5 port), three ion engines
//   S4_MINE     proximity mine pod: spiked sphere, a band of warning lights
//               (userData.setArm(0..1): amber standby → red, blinking faster)
//   HYDRA       mid-boss weapons platform: an armoured carapace, three cannon heads on long
//               articulated necks (parts headL / headC / headR; userData.necks[k] is the neck's
//               pivot, the AI swings and rears it; a head's setCharge(0..1) lights its jaws)
//               and a reactor core under a hinged lid (setOpen); reset() for the pool
//   AEGIS       boss: the orbital defence platform — a central hub under a shield dome, a ring
//               that turns around it (userData.setSpin) carrying three gun turrets and three
//               shield generators (parts turret[0..2], gen[0..2]), the railgun (part cannon,
//               stowed facing up-screen, swings round to fire; cannon.userData.setBeam /
//               setCharge), two capacitor banks (capL, capR), the reactor core under two
//               shutters (setOpen). setShield(0..1) shows the dome, setBreak(0..1) splits the
//               ring and tips the hub for the death; reset() restores the pooled pose.
//
// Imports: only 'three' and './modelkit.js' — never models.js (import cycle).
// House style and helpers: see the modelkit.js header.
//
// Enemy contract — enemyShell(kind, radius, debrisHex) + bodyMat + GG(key, buildXxx):
//   * nose/front toward −z (the game yaws units that face the player by π), up +y,
//     centred on the origin. Earth orbit: AIR UNITS ONLY (no userData.ground)
//   * userData: kind (the registry sets it to the type), radius, debrisColor, muzzles
//     (group-local Vector3[], refreshed in update() when they move), setFlash(v),
//     update(dt, t), dispose() (materials only)
//   * gameplay numbers (hp, score, collision radius) live in stage4.js ENEMY, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (userData.midboss)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) fully restores the pose
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
// Cache keys: 'ext:s4:<name>'.
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, M, S, DEG, TAU, lit, lin, rgb, GL, EM, scl, hash3, bodyMat, additiveMat, flashFn, enemyShell, syncMuzzles,
  hazardDrape, makePart, destructiblePart, buildFlame,
} from './modelkit.js';

// =============================================================================
// palette + shared helpers
// =============================================================================
const K = {
  hull: lit('#353c48'), hullLt: lit('#4f5866'), hullDk: lit('#232830'), hullXDk: lit('#14171c'),
  cer: lit('#cdd3da'), cerLt: lit('#e1e5ea'), cerDk: lit('#98a1ab'),
  gold: lit('#c08c2c'), goldLt: lit('#dcb04e'), goldDk: lit('#7a561a'),
  orange: lit('#d4581a'), black: lit('#0b0c0f'),
  cell: S(lin('#101419'), rgb(0.002, 0.012, 0.006)), cellLt: S(lin('#1d2a26'), rgb(0.004, 0.03, 0.016)),   // collector cells (graphite, green-black)
  solar: S(lin('#15265a'), rgb(0.004, 0.012, 0.045)), solarLt: S(lin('#2a4690'), rgb(0.012, 0.03, 0.09)),     // the station's solar arrays
};
const GRN = rgb(0.16, 1.0, 0.48, 3.2);      // emerald energy (sensor eyes, energy lines)
const GRNH = rgb(0.66, 1.0, 0.78, 4.2);     // white-hot green (lenses, the reactor)
const GRND = rgb(0.12, 0.85, 0.4, 1.7);     // dim green (panel lights)
const ION = rgb(0.52, 0.58, 1.0, 3.4);      // ion-drive nozzle glow (blue-violet)
const G_GRN = GL(GRN, 0.4), G_GRNH = GL(GRNH, 0.5), G_GRND = GL(GRND, 0.3), G_ION = GL(ION, 0.45);
const G_AMB = GL(EM.amber, 0.42), G_RD = GL(EM.eyeRed, 0.45);
// warning-light band baked warm white: the material's emit tint makes it amber or red (the mine)
const G_WARN = GL(rgb(1.0, 0.85, 0.6, 3.2), 0.45);
// blue-violet ion exhaust (additive cones, see modelkit buildFlame)
const FLAME_ION = [
  { r: 0.07, len: 0.55, base: rgb(0.45, 0.5, 1.0, 1.2), tip: rgb(0.2, 0.1, 0.6, 0.0), sides: 6 },
  { r: 0.04, len: 0.3, base: rgb(0.8, 0.86, 1.0, 1.7), tip: rgb(0.42, 0.4, 1.0, 0.1), sides: 5 },
];
const FLAME_ION_SM = [
  { r: 0.055, len: 0.34, base: rgb(0.45, 0.5, 1.0, 1.1), tip: rgb(0.2, 0.1, 0.6, 0.0), sides: 6 },
  { r: 0.032, len: 0.19, base: rgb(0.8, 0.86, 1.0, 1.5), tip: rgb(0.42, 0.4, 1.0, 0.1), sides: 5 },
];
const FLAME_ION_BIG = [
  { r: 0.34, len: 1.4, base: rgb(0.42, 0.48, 1.0, 1.0), tip: rgb(0.16, 0.08, 0.55, 0.0), sides: 8 },
  { r: 0.19, len: 0.8, base: rgb(0.78, 0.84, 1.0, 1.5), tip: rgb(0.4, 0.38, 1.0, 0.05), sides: 6 },
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
const polar = (r, a, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
/** flat annulus sector r0..r1 at height y from angle a0 to a1 (n steps), facing up (up = 1) or down (−1) */
function annulus(b, r0, r1, y, a0, a1, n, style, up = 1) {
  for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n, t1 = a0 + ((a1 - a0) * (k + 1)) / n;
    const s = typeof style === 'function' ? style(k) : style;
    b.quadN(polar(r0, t0, y), polar(r1, t0, y), polar(r1, t1, y), polar(r0, t1, y), [0, up, 0], s);
  }
}
/** vertical wall sector at radius r between y0 and y1 (angles a0..a1, n steps) facing out (out = 1) or in (−1) */
function wall(b, r, y0, y1, a0, a1, n, style, out = 1) {
  for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n, t1 = a0 + ((a1 - a0) * (k + 1)) / n, tm = (t0 + t1) / 2;
    const s = typeof style === 'function' ? style(k) : style;
    b.quadN(polar(r, t0, y0), polar(r, t1, y0), polar(r, t1, y1), polar(r, t0, y1), [Math.cos(tm) * out, 0, Math.sin(tm) * out], s);
  }
}
/** RGBA vertex-alpha beam along −z from the origin (unit length: the mesh is scaled to its length). Normal
 *  blended (additive red vanishes on the white cloud of the day side): an HDR red core that still blooms, a
 *  translucent halo, fading with distance. RGBA vertex colours: the same program as the hornet's rotor disc. */
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
    const fa = 1 - 0.7 * (k / N), fb = 1 - 0.7 * ((k + 1) / N);
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
    if (j >= NP) return j === 2 * NP - 1 ? glow : K.hullXDk;
    if (j === NP - 1) return K.hullDk;
    if (i === 0 || i === zs.length - 2) return K.goldLt;
    if (j === 0) return K.cerLt;
    return (i + j) & 1 ? K.cer : K.cerDk;
  }, K.hull, K.hull);
  return b;
}
/** point on the cubic bezier a-b-c-d (arrays) at t */
function bez3(a, b, c, d, t) {
  const u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [a[0] * k0 + b[0] * k1 + c[0] * k2 + d[0] * k3, a[1] * k0 + b[1] * k1 + c[1] * k2 + d[1] * k3, a[2] * k0 + b[2] * k1 + c[2] * k2 + d[2] * k3];
}
/** 8-point ring of radius r (flattened by squash) centred on c, perpendicular to the tangent t; edge 0 on top */
function tubeRing(c, t, r, squash = 0.8) {
  const tl = Math.hypot(t[0], t[1], t[2]) || 1, tx = t[0] / tl, ty = t[1] / tl, tz = t[2] / tl;
  const sl = Math.hypot(tz, tx) || 1, sx = -tz / sl, sz = tx / sl;                     // side = t × up
  const ux = -tx * ty / sl, uy = (tx * tx + tz * tz) / sl, uz = -tz * ty / sl;          // up' = side × t
  const out = [];
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 2 - (k * TAU) / 8, cs = Math.cos(a) * r, sn = Math.sin(a) * r * squash;
    out.push([c[0] + sx * cs + ux * sn, c[1] + uy * sn, c[2] + sz * cs + uz * sn]);
  }
  return out;
}

// =============================================================================
// S4_DRONE — octagonal sentinel drone (≈ 1.7 across the pods)
// =============================================================================
const DR_POD = 0.78;    // pod distance from the centre (diagonals)
function buildDrone() {
  const b = new GB();
  // body: octagonal saucer — gold-foil belly, graphite flanks, ceramic top panels, graphite collar, eye on top
  b.lathe([0, 0, 0], [0, 1, 0], [[-0.2, 0.16], [-0.13, 0.44], [0.0, 0.54], [0.1, 0.5], [0.18, 0.34], [0.22, 0.2]], 8, (i, j) => {
    if (i === 0) return (j & 1) ? K.goldDk : K.gold;
    if (i === 1) return K.hullDk;
    if (i === 2) return j === 2 || j === 6 ? K.orange : K.hull;             // orange side marks
    if (i === 3) return (j & 1) ? K.cer : K.cerLt;
    return K.hullDk;
  }, K.gold, GL(rgb(0.14, 1.0, 0.46, 2.1), 0.4), { phase: Math.PI / 8 });
  // the eye: a white-hot pupil over the green disc, and a forward sensor visor
  b.decal(Array.from({ length: 6 }, (_, k) => polar(0.09, (k * TAU) / 6, 0.228)), G_GRNH);
  b.decal([[-0.2, 0.07, -0.5], [0.2, 0.07, -0.5], [0.16, 0.14, -0.43], [-0.16, 0.14, -0.43]], G_GRN, [0, 0.35, -1]);
  // four outriggers on the diagonals, each carrying a thruster pod along z (nozzle aft, +z)
  const f0 = b.n;
  for (const sz of [-1, 1]) {
    const a = Math.atan2(sz, 1), cx = Math.cos(Math.PI / 4) * DR_POD, cz = sz * cx;
    const arm = b.n;
    b.block({ x: 0.36, y: -0.04, z: 0, w: 0.5, d: 0.12, h: 0.08, tw: 0.42, td: 0.08, top: K.cerDk, side: K.hullDk });
    b.xform(arm, M(0, 0, 0, 0, -a, 0));
    b.lathe([cx, 0.0, cz + 0.2], [0, 0, -1], [[0, 0.07], [0.06, 0.11], [0.34, 0.11], [0.42, 0.06]], 6,
      (i, j) => (i === 1 ? (j === 1 || j === 2 ? K.cerLt : K.cer) : K.hull), G_ION, K.hullDk, { phase: Math.PI / 6 });
    b.decal([[cx - 0.05, 0.112, cz - 0.1], [cx + 0.05, 0.112, cz - 0.1], [cx + 0.05, 0.112, cz + 0.02], [cx - 0.05, 0.112, cz + 0.02]], G_AMB);
  }
  b.mirrorX(f0);
  return b;
}
function buildDroneCrown() {   // spins about y: a thin ring and three sensor vanes
  const b = new GB();
  wall(b, 0.3, 0.24, 0.3, 0, TAU, 8, (k) => (k & 1 ? K.hullDk : K.cerDk));
  annulus(b, 0.24, 0.3, 0.3, 0, TAU, 8, K.hull);
  for (let k = 0; k < 3; k++) {
    const f = b.n;
    b.block({ x: 0.38, y: 0.25, z: 0, w: 0.2, d: 0.05, h: 0.05, top: K.cerLt, side: K.hull });
    b.decal([[0.44, 0.302, -0.02], [0.48, 0.302, -0.02], [0.48, 0.302, 0.02], [0.44, 0.302, 0.02]], G_GRN);
    b.xform(f, M(0, 0, 0, 0, (k * TAU) / 3, 0));
  }
  return b;
}
function createDrone() {
  const { g, pivot, ud } = enemyShell('s4_drone', 0.75, '#4f5866');
  const mat = bodyMat(0.5, 0.35);
  pivot.add(new THREE.Mesh(GG('ext:s4:drone', buildDrone), mat));
  const crown = new THREE.Mesh(GG('ext:s4:drone.crown', buildDroneCrown), mat);
  pivot.add(crown);
  // the two pods whose exits face up-screen (+z) carry the flames
  const px = Math.cos(Math.PI / 4) * DR_POD;
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:s4:drone.flame', () => buildFlame([[-px, 0], [px, 0]], FLAME_ION_SM)), flameMat);
  flame.position.z = px + 0.22; flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, 0, -0.55)];
  let thrust = 0.3;
  /** 0..1: pod burn (a jink) */
  ud.setThrust = (v) => { thrust = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    crown.rotation.y += dt * 2.6;
    mat.uEmitScale.value = 0.85 + Math.sin(t * 7) * 0.15;
    flame.scale.set(0.8 + thrust * 0.4, 1, (0.4 + thrust * 1.6) * (1 + Math.sin(t * 43) * 0.12));
    pivot.rotation.z = Math.sin(t * 1.9) * 0.08;
    pivot.rotation.x = Math.sin(t * 1.4) * 0.05;
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  return g;
}

// =============================================================================
// S4_LASER — laser satellite (≈ 5.0 span across its solar wings)
// =============================================================================
function buildSatBus() {
  const b = new GB();
  // bus: gold-foil sides, ceramic radiator top with graphite seams, dark base
  b.block({ x: 0, y: -0.36, z: 0.05, w: 0.95, d: 1.15, h: 0.66, tw: 0.9, td: 1.08, bev: 0.05, top: K.cer, bevS: K.cerLt,
    front: K.gold, back: K.goldDk, left: K.goldLt, right: K.goldLt, bottom: K.hullDk });
  for (const z of [-0.2, 0.25]) b.decal([[-0.4, 0.302, z], [0.4, 0.302, z], [0.4, 0.302, z + 0.03], [-0.4, 0.302, z + 0.03]], K.hullDk);
  b.decal([[-0.36, 0.303, 0.38], [-0.2, 0.303, 0.38], [-0.2, 0.303, 0.46], [-0.36, 0.303, 0.46]], G_AMB);
  // gimbal socket for the emitter
  b.lathe([0, 0.3, -0.05], [0, 1, 0], [[0, 0.36], [0.06, 0.32], [0.08, 0.2]], 8, (i) => (i === 0 ? K.hull : K.hullLt), null, K.hullDk, { phase: Math.PI / 8 });
  // antenna whip + beacon, a small dish at the rear
  b.block({ x: 0.3, y: 0.3, z: 0.42, w: 0.03, d: 0.03, h: 0.5, top: G_RD, side: K.cerDk });
  b.lathe([-0.28, 0.32, 0.42], [0, 1, 0], [[0, 0.02], [0.04, 0.22], [0.09, 0.24]], 6, (i) => (i === 1 ? K.cerLt : K.cer), null, K.cerDk);
  // solar-wing booms (the wings themselves feather on their own mesh)
  const f0 = b.n;
  b.block({ x: 0.66, y: -0.08, z: 0, w: 0.4, d: 0.08, h: 0.08, top: K.cerDk, side: K.hull });
  b.lathe([0.5, -0.04, 0], [1, 0, 0], [[0, 0.1], [0.08, 0.1]], 6, K.hullLt, K.hull, K.hull);
  b.mirrorX(f0);
  return b;
}
function buildSatWings() {    // both wings, feathering about the x axis through the booms
  const b = new GB();
  const f0 = b.n;
  // a swept, angular collector blade (not a civilian satellite's flat panel): the frame glows green through
  // the gaps of its dark cells, ceramic edge caps, a gold-foil back
  b.plate([[0.66, -0.34], [2.3, -0.52], [2.62, 0.0], [2.3, 0.52], [0.66, 0.34]], -0.06, 0.0, G_GRND, K.cerDk, K.goldDk);
  for (let u = 0; u < 4; u++) {
    const x0 = 0.76 + u * 0.44, x1 = x0 + 0.38, hz0 = 0.34 + (x0 - 0.66) * 0.11 - 0.05, hz1 = 0.34 + (x1 - 0.66) * 0.11 - 0.05;
    for (const sz of [-1, 1]) {
      b.decal([[x0, 0.006, sz * 0.04], [x1, 0.006, sz * 0.04], [x1, 0.006, sz * hz1], [x0, 0.006, sz * hz0]], (u + (sz > 0 ? 1 : 0)) & 1 ? K.cellLt : K.cell);
    }
  }
  b.decal([[2.34, 0.008, -0.46], [2.6, 0.008, -0.03], [2.6, 0.008, 0.03], [2.34, 0.008, 0.46]], K.cerLt);
  b.mirrorX(f0);
  return b;
}
function buildSatEmitter() {   // turret-local; lens barrel along −z
  const b = new GB();
  b.block({ x: 0, y: 0.0, z: 0.1, w: 0.46, d: 0.56, h: 0.3, tw: 0.36, td: 0.44, bev: 0.04, top: K.cer, bevS: K.cerLt, side: K.hull, front: K.hullDk });
  b.lathe([0, 0.18, 0.05], [0, 0, -1], [[0, 0.2], [0.14, 0.22], [0.2, 0.22], [0.24, 0.17], [0.46, 0.15], [0.5, 0.2], [0.58, 0.2], [0.62, 0.15],
    [0.8, 0.13], [0.84, 0.18], [0.9, 0.18]], 8, (i, j) => {
    if (i === 5 || i === 9) return G_GRND;                               // charge coils
    if (i === 1 || i === 6) return j === 1 || j === 2 ? K.cerLt : K.cer;
    if (i === 2 || i === 10) return K.goldLt;
    return j === 1 || j === 2 ? K.hullLt : K.hull;
  }, K.hullDk, G_GRNH, { phase: Math.PI / 8 });
  b.decal([[-0.1, 0.302, 0.18], [0.1, 0.302, 0.18], [0.1, 0.302, 0.28], [-0.1, 0.302, 0.28]], G_RD);
  return b;
}
function createLaserSat() {
  const { g, pivot, ud } = enemyShell('s4_laser', 1.3, '#b88a2c');
  ud.halfExtents = { x: 3.0, z: 0.7 };
  pivot.scale.setScalar(1.15);
  const mat = bodyMat(0.5, 0.35), emMat = bodyMat(0.45, 0.35);
  pivot.add(new THREE.Mesh(GG('ext:s4:sat.bus', buildSatBus), mat));
  const wings = new THREE.Mesh(GG('ext:s4:sat.wings', buildSatWings), mat);
  wings.position.y = -0.04;
  pivot.add(wings);
  const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.46, -0.05);
  turret.add(new THREE.Mesh(GG('ext:s4:sat.emitter', buildSatEmitter), emMat));
  pivot.add(turret);
  const beam = beamMesh('ext:s4:sat.beam', 30, 0.1, 0.45);
  beam.m.position.set(0, 0.18, -0.98);
  turret.add(beam.m);
  const local = [new THREE.Vector3(0, 0.18, -0.95)];
  turret.userData.muzzles = local;
  ud.turret = turret;
  ud.muzzles = [new THREE.Vector3()];
  let charge = 0, fire = 0;
  /** 0..1: lens glow + targeting beam (the telegraph) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  /** 0..1: discharge glare on the lens */
  ud.setFire = (v) => { fire = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat, emMat]);
  ud.update = (dt, t) => {
    syncMuzzles(ud.muzzles, local, turret);
    wings.rotation.x = Math.sin(t * 0.55) * 0.38;
    mat.uEmitScale.value = 0.85 + Math.sin(t * 3) * 0.12;
    emMat.uEmitScale.value = 0.8 + charge * (1.0 + Math.sin(t * 36) * 0.25) + fire * 2.2;
    beam.m.userData.set(charge > 0 ? charge * (0.75 + Math.sin(t * 30) * 0.25) : 0);
    pivot.rotation.z = Math.sin(t * 0.8) * 0.05;
  };
  ud.dispose = () => { mat.dispose(); emMat.dispose(); beam.mat.dispose(); };
  ud.setCharge(0);
  return g;
}

// =============================================================================
// S4_FRIGATE — space frigate (≈ 4.9 long, 2.2 wide across the sponsons); it crosses the screen
// broadside-on, so its starboard (+x) or port (−x) side faces the player
// =============================================================================
const FG_HULL = [[-2.45, 0.03, 0.14, 0.03], [-1.95, 0.32, 0.24, 0.18], [-1.15, 0.54, 0.28, 0.3], [0.2, 0.6, 0.28, 0.32], [1.45, 0.58, 0.26, 0.3], [2.15, 0.5, 0.24, 0.26]];
const FG_PORTS = [-1.3, 0.0, 1.3];       // sponson z; muzzles at x ±1.06
function buildFrigate() {
  const b = new GB();
  const ring = ([z, w, dk, kl]) => [[0, dk + 0.04, z], [w * 0.78, dk, z], [w, dk - 0.12, z], [w * 0.74, -kl * 0.45, z], [0, -kl, z],
    [-w * 0.74, -kl * 0.45, z], [-w, dk - 0.12, z], [-w * 0.78, dk, z]];
  const d0 = b.n;
  b.loft(FG_HULL.map(ring), (i, j) => {
    if (j === 0 || j === 7) return i === 0 ? K.cerLt : i === 3 ? K.hullDk : K.cer;          // ceramic deck, a dark seam
    if (j === 1 || j === 6) return i === 0 ? K.cerLt : K.cerDk;
    if (j === 2 || j === 5) return i === 2 || i === 3 ? K.orange : K.hull;                    // orange flank stripe
    return K.hullXDk;
  }, null, K.hullDk);
  const d1 = b.n;
  // bow: green sensor slits, hazard chevrons; spine walkway line
  for (const sg of [-1, 1]) b.drape([[[0.05 * sg, -2.25], [0.22 * sg, -1.98], [0.18 * sg, -1.9], [0.04 * sg, -2.15]]], G_GRN, d0, d1, 0.008, 2);
  hazardDrape(b, -0.28, -1.55, 0.28, -1.55, 0.14, 5, K.orange, K.black, d0, d1, 0.008, 1);
  b.drape(stripe([[0, -1.2], [0, 0.4]], 0.05), K.hullDk, d0, d1, 0.006, 1);
  // bridge tower: two tiers with a green window band, mast + beacon, sensor dish
  b.block({ x: 0, y: 0.24, z: 0.85, w: 0.62, d: 0.9, h: 0.26, tw: 0.54, td: 0.78, oz: 0.05, bev: 0.04, top: K.cer, bevS: K.cerLt, side: K.hull, front: K.hullLt });
  b.block({ x: 0, y: 0.5, z: 0.9, w: 0.4, d: 0.5, h: 0.16, tw: 0.32, td: 0.4, bev: 0.03, top: K.hullLt, bevS: K.cerLt, side: K.hullDk });
  b.decal([[-0.19, 0.63, 0.66], [0.19, 0.63, 0.66], [0.17, 0.57, 0.645], [-0.17, 0.57, 0.645]], G_GRN, [0, 0.3, -1]);
  b.block({ x: 0, y: 0.66, z: 1.0, w: 0.04, d: 0.04, h: 0.4, top: G_AMB, side: K.cerDk });
  b.lathe([0, 0.44, 0.35], [0, 1, 0], [[0, 0.03], [0.05, 0.2], [0.1, 0.22]], 6, (i) => (i === 1 ? K.cerLt : K.cer), null, K.cerDk);
  // stern: engine block, three ion nozzles
  b.block({ x: 0, y: -0.26, z: 2.2, w: 1.1, d: 0.45, h: 0.5, tw: 1.0, td: 0.4, bev: 0.04, top: K.hull, bevS: K.cerDk, side: K.hullDk, back: K.hullXDk });
  for (const x of [-0.36, 0, 0.36]) {
    b.lathe([x, -0.02, 2.36], [0, 0, 1], [[0, 0.15], [0.12, 0.17], [0.22, 0.14]], 6, (i) => (i === 0 ? K.cerDk : K.hull), null, G_ION, { phase: Math.PI / 6 });
  }
  const f0 = b.n;
  // broadside sponsons (starboard; the port side is the mirror): a gun box + twin barrels pointing out
  for (const z of FG_PORTS) {
    b.block({ x: 0.66, y: -0.08, z, w: 0.34, d: 0.46, h: 0.22, tw: 0.28, td: 0.38, top: K.cer, side: K.hull });
    for (const dz of [-0.09, 0.09]) b.block({ x: 0.92, y: 0.02, z: z + dz, w: 0.24, d: 0.06, h: 0.06, tw: 0.2, td: 0.05, top: K.hullLt, side: K.hullDk, right: G_GRN });
    b.decal([[0.58, 0.141, z - 0.14], [0.74, 0.141, z - 0.14], [0.74, 0.141, z - 0.06], [0.58, 0.141, z - 0.06]], G_AMB);
  }
  // radiator fin (dark panels) canted out amidships
  const r0 = b.n;
  b.wing([{ x: 0, zl: 0.2, zt: 1.25, t: 0.04 }, { x: 0.46, zl: 0.42, zt: 1.28, t: 0.02 }], (i, j) => (j === 0 ? K.cerDk : j >= 3 ? K.hullXDk : K.hullDk), null, K.gold);
  b.xform(r0, M(0.5, 0.2, 0, 0, 0, 40 * DEG));
  b.mirrorX(f0);
  return b;
}
function createFrigate() {
  const { g, pivot, ud } = enemyShell('s4_frigate', 1.8, '#4f5866');
  ud.halfExtents = { x: 1.1, z: 2.5 };
  const mat = bodyMat(0.55, 0.32);
  pivot.add(new THREE.Mesh(GG('ext:s4:frigate', buildFrigate), mat));
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:s4:frigate.flame', () => buildFlame([[-0.36, -0.02, 1.4], [0, -0.02, 1.4], [0.36, -0.02, 1.4]], FLAME_ION)), flameMat);
  flame.position.z = 2.58; flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  // broadside ports: 0–2 starboard (+x), 3–5 port (−x), bow to stern
  ud.muzzles = [...FG_PORTS.map((z) => new THREE.Vector3(1.06, 0.05, z)), ...FG_PORTS.map((z) => new THREE.Vector3(-1.06, 0.05, z))];
  let thrust = 0.5;
  ud.setThrust = (v) => { thrust = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    mat.uEmitScale.value = 0.85 + Math.sin(t * 4) * 0.15;
    flame.scale.set(1, 1, (0.5 + thrust * 1.1) * (1 + Math.sin(t * 41) * 0.1));
    pivot.position.y = Math.sin(t * 1.3) * 0.05;
    pivot.rotation.z = Math.sin(t * 0.9) * 0.025;
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  return g;
}

// =============================================================================
// S4_MINE — proximity mine pod (≈ 1.3 across the prongs)
// =============================================================================
function buildMine() {
  const b = new GB();
  // shell: graphite caps, gold-foil shoulders, a band of warning lights round the middle
  b.lathe([0, 0, 0], [0, 1, 0], [[-0.4, 0.0], [-0.34, 0.22], [-0.14, 0.38], [0.0, 0.4], [0.14, 0.38], [0.34, 0.22], [0.4, 0.0]], 8, (i, j) => {
    if (i === 0 || i === 5) return K.hullDk;
    if (i === 1 || i === 4) return (j & 1) ? K.goldDk : K.gold;
    return (j & 1) ? K.hull : G_WARN;                                  // the light band (i 2, 3)
  }, null, null, { phase: Math.PI / 8 });
  // contact prongs on the six axes: ceramic-tipped spikes on graphite
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [dx, dy, dz] of dirs) {
    const up = Math.abs(dy) > 0.5 ? [1, 0, 0] : [0, 1, 0];
    const u = [dy * up[2] - dz * up[1], dz * up[0] - dx * up[2], dx * up[1] - dy * up[0]];
    const v = [dy * u[2] - dz * u[1], dz * u[0] - dx * u[2], dx * u[1] - dy * u[0]];
    const r0 = 0.32, w = 0.095;
    const base = [0, 1, 2, 3].map((k) => { const a = (k * TAU) / 4 + Math.PI / 4, c = Math.cos(a) * w, s = Math.sin(a) * w;
      return [dx * r0 + u[0] * c + v[0] * s, dy * r0 + u[1] * c + v[1] * s, dz * r0 + u[2] * c + v[2] * s]; });
    b.spike(base, [dx * 0.7, dy * 0.7, dz * 0.7], (k) => (k & 1 ? K.cerLt : K.cerDk));
  }
  return b;
}
function createMine() {
  const { g, pivot, ud } = enemyShell('s4_mine', 0.8, '#7a561a');
  const mat = bodyMat(0.5, 0.35);
  const body = new THREE.Mesh(GG('ext:s4:mine', buildMine), mat);
  body.scale.setScalar(1.3);
  pivot.add(body);
  ud.muzzles = [new THREE.Vector3(0, 0, 0)];
  let arm = 0, ph = Math.random() * 6;
  const AMBER = new THREE.Color(1.0, 0.62, 0.2), RED = new THREE.Color(1.0, 0.1, 0.05);
  /** 0..1: armed (red, blinking faster and brighter) */
  ud.setArm = (v) => { arm = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    ph += dt * (3 + arm * 22);
    const on = Math.sin(ph) > 0 ? 1 : 0.25;
    mat.uEmitTint.value.copy(AMBER).lerp(RED, arm);
    mat.uEmitScale.value = on * (0.9 + arm * 0.9);
    pivot.rotation.y += dt * (0.7 + arm * 3);
    pivot.rotation.x = Math.sin(t * 0.9) * 0.5;
  };
  ud.dispose = () => mat.dispose();
  ud.setArm(0);
  return g;
}

// =============================================================================
// HYDRA — mid-boss weapons platform (≈ 7.5 across the outer heads, 8.5 long with the necks)
// =============================================================================
// Hierarchy: pivot → body mesh; core (orb + lid on its hinge); per neck: a pivot at the neck's base
// (the AI swings it about y and rears it about x) → the head part, placed at the head, whose one mesh is
// the head AND the curved neck reaching back to the base (so the hit circle sits on the head).
const HY_CORE = [0, 0.74, 0.95];
// neck bases [x, y, z] and their resting yaw (outer necks splay out)
const HY_NECK = [[-1.5, 0.34, -1.45, 0.52], [0, 0.46, -1.9, 0], [1.5, 0.34, -1.45, -0.52]];
const HY_REACH = 2.45, HY_LIFT = 0.28;    // head centre relative to its neck base (forward, up)
function buildHydraBody() {
  const b = new GB();
  const s0 = b.n;
  b.loft([[-2.0, 1.1, 0.34, 0.28], [-1.4, 1.9, 0.62, 0.45], [-0.3, 2.3, 0.76, 0.52], [1.1, 2.25, 0.74, 0.5], [2.3, 1.75, 0.6, 0.42], [3.0, 1.05, 0.4, 0.3]].map((s) => ring10(s)), (i, j) => {
    const seam = i === 2;
    if (j === 0) return seam ? K.hullXDk : i === 0 ? K.cerLt : K.cer;               // ceramic carapace
    if (j === 1 || j === 9) return seam ? K.hullDk : K.cerLt;
    if (j === 2 || j === 8) return i === 1 || i === 3 ? K.gold : K.hull;             // gold-foil flanks
    if (j === 3 || j === 7) return i === 2 ? K.orange : K.hullDk;
    return K.hullXDk;
  }, K.hullDk, K.hullDk);
  const s1 = b.n;
  // front rim: green eye slits between the necks, hazard chevrons, a green spine line to the core
  for (const sg of [-1, 1]) b.drape([[[0.55 * sg, -1.85], [0.95 * sg, -1.7], [0.92 * sg, -1.6], [0.52 * sg, -1.74]]], G_GRN, s0, s1, 0.01, 2);
  hazardDrape(b, -0.6, -1.25, 0.6, -1.25, 0.18, 7, K.orange, K.black, s0, s1, 0.01, 1);
  b.drape(stripe([[0, -1.0], [0, -0.05]], 0.06), G_GRND, s0, s1, 0.01, 1);
  b.drape(stripe([[-1.5, 0.3], [-0.9, 2.2]], 0.035).concat(stripe([[1.5, 0.3], [0.9, 2.2]], 0.035)), K.hullDk, s0, s1, 0.008, 1);
  // reactor collar round the core well (the orb and its lid are the core part)
  const N = 12, [cx, , cz] = HY_CORE;
  const cr = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; });
  b.loft([cr(1.0, 0.62), cr(0.96, 0.86), cr(0.82, 0.96), cr(0.66, 0.94), cr(0.6, 0.66)], (i, j) => {
    if (i === 0) return j & 1 ? K.hull : K.hullDk;
    if (i === 1) return j % 3 === 1 ? G_GRN : K.cerLt;
    if (i === 2) return K.cerDk;
    return K.hullXDk;
  });
  b.lathe([cx, 0.66, cz], [0, 1, 0], [[0, 0.6], [0, 0.0]], N, K.black);
  // neck mounts: armoured collars at the front rim
  const collar = (x, y, z, yaw) => {
    const d = [-Math.sin(yaw), 0.12, -Math.cos(yaw)];
    b.lathe([x - d[0] * 0.25, y - 0.05, z - d[2] * 0.25], d, [[0, 0.46], [0.18, 0.44], [0.32, 0.34], [0.38, 0.2]], 8,
      (i, j) => (i === 1 ? (j & 1 ? K.gold : K.goldLt) : i === 0 ? K.hull : K.hullLt), null, K.hullXDk, { phase: Math.PI / 8 });
  };
  collar(HY_NECK[1][0], HY_NECK[1][1], HY_NECK[1][2], 0);
  // dorsal crest behind the core
  for (const [z, h] of [[2.0, 0.55], [2.5, 0.42]]) b.spike([[-0.12, 0.62, z - 0.25], [0.12, 0.62, z - 0.25], [0.1, 0.55, z + 0.25], [-0.1, 0.55, z + 0.25]], [0, 0.62 + h, z + 0.4], (k) => (k & 1 ? K.cerLt : K.hull));
  // stern engines: two ion nozzles in an armoured block
  b.block({ x: 0, y: -0.25, z: 2.95, w: 1.5, d: 0.5, h: 0.55, tw: 1.4, td: 0.44, bev: 0.04, top: K.hull, bevS: K.cerDk, side: K.hullDk, back: K.hullXDk });
  const f0 = b.n;
  collar(HY_NECK[2][0], HY_NECK[2][1], HY_NECK[2][2], HY_NECK[2][3]);
  b.lathe([0.42, 0.02, 3.1], [0, 0, 1], [[0, 0.22], [0.12, 0.25], [0.24, 0.2]], 8, (i) => (i === 0 ? K.cerDk : K.hull), null, GL(rgb(0.52, 0.58, 1.0, 2.2), 0.45), { phase: Math.PI / 8 });
  // swept side fin with a green energy line and an amber tip light
  const w0 = b.n;
  b.wing([{ x: 1.95, y: -0.02, zl: -0.4, zt: 1.9, t: 0.2 }, { x: 3.0, y: 0.05, zl: 0.5, zt: 1.9, t: 0.1 }, { x: 3.55, y: 0.12, zl: 1.15, zt: 1.85, t: 0.04 }], (i, j) => {
    if (j >= 4) return K.hullXDk;
    if (j === 0) return K.cerLt;
    return i === 1 ? (j === 3 ? K.hullDk : K.hull) : (j === 3 ? K.hullDk : K.cer);
  }, null, K.hull);
  const w1 = b.n;
  b.drape(stripe([[2.1, 0.2], [3.3, 1.35]], 0.035), G_GRN, w0, w1, 0.008, 1);
  b.drape([[[3.35, 1.45], [3.5, 1.5], [3.52, 1.66], [3.37, 1.62]]], G_AMB, w0, w1, 0.008, 1);
  b.mirrorX(f0);
  return b;
}
const HY_HEAD = 1.3;     // head scale (the neck keeps its length)
function buildHydraHead() {   // part-local: head centred on the origin (jaws toward −z), the neck reaching back to its base
  const b = new GB();
  // neck: armour plates on thin glowing joints, along a curve from the base (0, −LIFT, REACH) up and forward into the skull
  const P0 = [0, -HY_LIFT, HY_REACH], P1 = [0, 0.32, HY_REACH - 0.7], P2 = [0, 0.46, 1.25], P3 = [0, 0.14, 0.55];
  const NT = [0, 0.15, 0.21, 0.37, 0.43, 0.59, 0.65, 0.81, 0.87, 1], rings = [];
  for (let k = 0; k < NT.length; k++) {
    const t = NT[k], c = bez3(P0, P1, P2, P3, t), c2 = bez3(P0, P1, P2, P3, Math.min(1, t + 0.02)), c1 = bez3(P0, P1, P2, P3, Math.max(0, t - 0.02));
    const joint = (k & 1) === 1 ? 0 : 1;          // plates flare at their leading ring
    rings.push(tubeRing(c, [c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]], (0.36 - t * 0.11) * (joint ? 1 : 1.06), 0.8));
  }
  b.loft(rings, (i, j) => {
    const top = j === 0 || j === 7, sh = j === 1 || j === 6;
    if (i & 1) return top ? G_GRND : K.hullXDk;                     // joints: a green conduit on top
    if (top) return K.cer;                                           // armour plates
    if (sh) return i === 0 ? K.cerDk : K.cerLt;
    return j === 2 || j === 5 ? K.gold : K.hullDk;
  }, K.hullDk, null);
  // skull: ceramic wedge with a dark crest line, gold cheek plates (built at 1, scaled up with the jaw, guns and horns)
  const h0 = b.n;
  const s0 = b.n;
  b.loft([[0.55, 0.26, 0.2, 0.16], [0.2, 0.36, 0.28, 0.2], [-0.25, 0.34, 0.25, 0.18], [-0.62, 0.23, 0.15, 0.12], [-0.92, 0.1, 0.07, 0.05]].map((s) => ring8(s, 0.06)), (i, j) => {
    if (j === 0 || j === 7) return i === 1 ? K.hullDk : K.cer;
    if (j === 1 || j === 6) return i === 1 || i === 2 ? K.gold : K.cerLt;
    if (j === 2 || j === 5) return K.hull;
    return K.hullXDk;
  }, K.hull, G_GRN);
  const s1 = b.n;
  // eyes: green slits on the cheeks
  for (const sg of [-1, 1]) b.drape([[[0.1 * sg, -0.42], [0.3 * sg, -0.2], [0.28 * sg, -0.1], [0.08 * sg, -0.32]]], G_GRN, s0, s1, 0.01, 2);
  // lower jaw
  b.loft([[0.3, 0.27, 0.04, 0.1], [-0.3, 0.26, 0.04, 0.12], [-0.85, 0.13, 0.03, 0.06]].map((s) => ring8(s, -0.16)), (i, j) => (j === 3 || j === 4 ? K.hullXDk : j === 0 || j === 7 ? K.hullDk : K.hull), K.hull, K.hullDk);
  // twin cannons in the mouth
  for (const x of [-0.12, 0.12]) {
    b.lathe([x, -0.06, -0.55], [0, 0, -1], [[0, 0.065], [0.4, 0.055], [0.4, 0.07], [0.52, 0.07], [0.52, 0.035]], 6,
      (i) => (i === 2 ? K.cerLt : K.hullDk), null, G_GRNH, { phase: Math.PI / 6 });
  }
  // swept horns
  for (const sg of [-1, 1]) b.spike([[0.14 * sg, 0.3, 0.05], [0.26 * sg, 0.26, 0.2], [0.16 * sg, 0.36, 0.3]], [0.36 * sg, 0.62, 0.85], (k) => (k === 0 ? K.cerLt : K.hull));
  b.xform(h0, M(0, 0, 0, 0, 0, 0, HY_HEAD));
  return b;
}
function buildHydraLid() {   // hinge-local: a domed armour lid over the core well, hinged at its rear edge
  const b = new GB();
  b.lathe([0, -0.02, -0.72], [0, 1, 0], [[0, 0.74], [0.1, 0.72], [0.26, 0.6], [0.38, 0.36], [0.44, 0.0]], 12, (i, j) => {
    if (i === 0) return K.hullDk;
    if (i === 3) return j % 3 === 0 ? G_GRND : K.hull;
    return (j & 1) ? K.cer : K.cerLt;
  }, K.hullXDk, K.cerDk, { phase: Math.PI / 12 });
  b.block({ x: 0, y: -0.02, z: -0.02, w: 0.6, d: 0.16, h: 0.14, top: K.hull, side: K.hullDk });
  return b;
}
function createHydra() {
  const { g, pivot, ud } = enemyShell('hydra', 2.0, '#4f5866');
  ud.midboss = true;
  ud.halfExtents = { x: 3.8, z: 4.3 };
  const hullMat = bodyMat(0.55, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s4:hydra.body', buildHydraBody), hullMat));
  const allMats = [hullMat];
  // heads: one geometry + wreck (the head blown off, a burning neck stump), the centre one a size up
  const headKeep = { keep: (x, y, z) => z - 0.95, crumple: 0.12, seed: 41, dir: [0, 0.3, -1], shards: 10, shardSize: 0.26, band: 0.45 };
  const necks = [], heads = [];
  const names = ['headL', 'headC', 'headR'];
  for (let k = 0; k < 3; k++) {
    const [x, y, z, yaw] = HY_NECK[k], big = k === 1 ? 1.15 : 1;
    const neck = new THREE.Object3D(); neck.name = 'neck' + k; neck.position.set(x, y, z); neck.rotation.order = 'YXZ'; neck.rotation.y = yaw;
    const m = bodyMat(0.5, 0.3); allMats.push(m);
    const part = destructiblePart({ key: 'ext:s4:hydra.head', build: buildHydraHead, name: names[k], radius: 0.8 * big,
      muzzles: [new THREE.Vector3(-0.16, -0.08, -1.42), new THREE.Vector3(0.16, -0.08, -1.42)], wreck: headKeep, sag: [0.25, -0.1, 0.1 * (k - 1)], mat: m });
    part.position.set(0, HY_LIFT * big, -HY_REACH * big);
    part.scale.setScalar(big);
    part.userData.mat = m;
    part.userData.charge = 0;
    /** 0..1: the jaws light up (a charging attack) */
    part.userData.setCharge = (v) => { part.userData.charge = Math.max(0, Math.min(1, v)); };
    neck.add(part);
    pivot.add(neck);
    necks.push(neck); heads.push(part);
  }
  // core: reactor orb under a hinged armour lid (the collar is part of the body)
  const coreMat = bodyMat(0.5, 0.3), orbMat = bodyMat(0.4, 0.1);
  allMats.push(coreMat, orbMat);
  const orbGeo = GG('ext:s4:hydra.orb', () => orbGB(0.5, 0.2, GRNH, 3.3)), orbDead = GG('ext:s4:hydra.orbDead', () => orbGB(0.44, 0.2, GRNH, 7.1, true));
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const hinge = new THREE.Object3D(); hinge.position.set(0, 0.28, 0.72);
  const lid = new THREE.Mesh(GG('ext:s4:hydra.lid', buildHydraLid), coreMat);
  hinge.add(lid);
  const core = makePart('core', 0.8, [{ mesh: orb, intact: orbGeo, wreck: orbDead }, { mesh: lid, hideOnDestroy: true }], [new THREE.Vector3(0, 0.45, 0)]);
  core.add(hinge);
  core.userData.materials.push(coreMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(HY_CORE[0], HY_CORE[1] - 0.12, HY_CORE[2]);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    hinge.rotation.x = e * 112 * DEG;
  };
  core.userData.setOpen(0);
  pivot.add(core);
  ud.parts = { headL: heads[0], headC: heads[1], headR: heads[2], core };
  ud.necks = necks;
  ud.neckYaw = HY_NECK.map((n) => n[3]);
  ud.muzzles = [new THREE.Vector3(0, 0.4, -2.2)];
  /** pooled instances come back posed: necks at rest, heads unlit */
  ud.reset = () => {
    for (let k = 0; k < 3; k++) { necks[k].rotation.set(0, HY_NECK[k][3], 0); heads[k].userData.charge = 0; }
  };
  const flashAll = flashFn(allMats);
  ud.setFlash = (v) => flashAll(v * 0.4);   // armour hits on the body: a soft flash (the parts flash on their own)
  ud.update = (dt, t) => {
    const p = 0.8 + Math.sin(t * 3.1) * 0.2;
    hullMat.uEmitScale.value = p; coreMat.uEmitScale.value = p;
    for (let k = 0; k < 3; k++) {
      const h = heads[k].userData;
      h.mat.uEmitScale.value = h.destroyed ? 0.7 : p + h.charge * (1.3 + Math.sin(t * 40 + k) * 0.35);
    }
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.32 + openT * 0.42) * (1 + Math.sin(t * 8) * 0.12);
    orb.rotation.y += dt * (0.5 + openT * 2.4);
    pivot.position.y = Math.sin(t * 0.8) * 0.1;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); };
  return g;
}

// =============================================================================
// AEGIS — boss: the orbital defence platform (≈ 12 across the ring)
// =============================================================================
// Hierarchy (the ring turns, the death splits it):
//   pivot ┬ hub (static): the station body, the core collar, the railgun socket, the engines + flames
//         ├ ring (setSpin rotates it about y) ┬ half A (0°…180°): mesh + turret0, gen0, turret1
//         │                                   └ half B (the same mesh turned by π): gen1, turret2, gen2
//         ├ cannon (part; rotation.y aims it, π = stowed over the hub facing up-screen) + telegraph beam
//         ├ capL, capR (parts), core (orb + two shutters, setOpen)
//         └ shield dome (additive lattice, setShield)
const AE_RING = [4.9, 6.0], AE_RY = [-0.12, 0.3];    // ring radii and its height span
const AE_MOUNT = 5.45;                                // turret / generator circle
const AE_CORE = [0, 0.96, 0.25];
const AE_GUN = [0, 1.0, -1.3];                         // railgun pivot
const AE_CAP = [1.3, 0.72, 1.3];                       // right capacitor bank (base)
const AE_DOME = 3.45;
// mounts round the ring (polar angle in the ring's frame: x = cos, z = sin): turrets at 0°/120°/240°, generators between
const AE_TURRET_A = [0, 120, 240].map((d) => d * DEG), AE_GEN_A = [60, 180, 300].map((d) => d * DEG);
function buildAegisHub() {
  const b = new GB();
  // station body: gold-foil belly, graphite skirt, a band of ceramic panels and green lights, ceramic shoulder
  b.lathe([0, 0, 0], [0, 1, 0], [[-0.95, 1.1], [-0.66, 2.1], [-0.22, 2.55], [0.36, 2.55], [0.72, 2.22], [0.96, 1.88]], 16, (i, j) => {
    if (i === 0) return (j & 1) ? K.goldDk : K.gold;
    if (i === 1) return (j & 3) === 0 ? K.hullXDk : K.hullDk;
    if (i === 2) return (j & 3) === 1 ? G_GRND : (j & 1) ? K.cer : K.cerDk;
    if (i === 3) return (j & 1) ? K.cer : K.cerLt;
    return K.hull;
  }, K.goldDk, K.hullDk, { phase: Math.PI / 16 });
  // deck markings: hazard band ahead of the railgun socket
  hazardDrape(b, -1.0, -1.72, 1.0, -1.72, 0.2, 9, K.orange, K.black, 0, b.n, 0.01, 1);
  // reactor collar round the core well (the orb and shutters are the core part)
  const N = 12, [cx, , cz] = AE_CORE;
  const cr = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; });
  b.loft([cr(1.12, 0.95), cr(1.08, 1.16), cr(0.94, 1.28), cr(0.8, 1.26), cr(0.74, 0.92)], (i, j) => {
    if (i === 0) return j & 1 ? K.hull : K.hullDk;
    if (i === 1) return j % 3 === 1 ? G_GRND : K.cerLt;
    if (i === 2) return K.cerDk;
    return K.hullXDk;
  });
  b.lathe([cx, 0.96, cz], [0, 1, 0], [[0, 0.74], [0, 0.0]], N, K.black);
  // railgun socket and the cradle the barrel rests in when stowed
  b.lathe([AE_GUN[0], 0.95, AE_GUN[2]], [0, 1, 0], [[0, 0.72], [0.06, 0.7], [0.1, 0.58]], 10, (i) => (i === 0 ? K.hull : K.goldLt), null, K.hullXDk, { phase: Math.PI / 10 });
  // rear: engine block with two big ion nozzles
  b.block({ x: 0, y: -0.52, z: 2.3, w: 2.2, d: 0.7, h: 0.86, tw: 2.0, td: 0.62, bev: 0.06, top: K.hull, bevS: K.cerDk, side: K.hullDk, back: K.hullXDk });
  const f0 = b.n;
  b.block({ x: 0.42, y: 0.95, z: 2.05, w: 0.18, d: 0.3, h: 0.6, tw: 0.14, td: 0.24, top: K.cerDk, side: K.hull });
  b.lathe([0.58, -0.1, 2.55], [0, 0, 1], [[0, 0.34], [0.16, 0.38], [0.3, 0.3]], 8, (i) => (i === 0 ? K.cerDk : K.hull), null, G_ION, { phase: Math.PI / 8 });
  // antenna mast + beacon on the shoulder, a sensor visor facing the player
  b.block({ x: 1.55, y: 0.8, z: -0.7, w: 0.05, d: 0.05, h: 0.9, top: G_RD, side: K.cerDk });
  b.decal([[0.9, 0.34, -2.4], [1.5, 0.34, -2.05], [1.5, 0.12, -2.08], [0.9, 0.12, -2.43]], G_GRN, [0.4, 0.2, -1]);
  // green guide line from the socket back along the deck edge
  b.decal([[0.95, 0.962, -1.2], [1.02, 0.962, -1.2], [1.3, 0.962, 0.6], [1.23, 0.962, 0.6]], G_GRND);
  b.mirrorX(f0);
  return b;
}
function buildAegisRingHalf() {    // ring-local, angles 0…π (the other half is this mesh turned by π)
  const b = new GB();
  const [r0, r1] = AE_RING, [y0, y1] = AE_RY, n = 12, a0 = 0, a1 = Math.PI, rm = r1 - 0.26;
  // cross-section: ceramic deck plates, a gold-foil rim band, gold outer wall, graphite inner wall and belly
  annulus(b, r0, rm, y1, a0, a1, n, (k) => (k % 4 === 1 ? K.hullDk : (k & 1) ? K.cer : K.cerLt));
  annulus(b, rm, r1, y1, a0, a1, n, K.goldLt);
  wall(b, r1, y0, y1, a0, a1, n, (k) => (k & 1 ? K.gold : K.goldDk), 1);
  wall(b, r0, y0, y1, a0, a1, n, K.hullDk, -1);
  annulus(b, r0, r1, y0, a0, a1, n, K.hullXDk, -1);
  // the cut ends (seen only once the ring breaks)
  b.quadN(polar(r0, a0, y0), polar(r1, a0, y0), polar(r1, a0, y1), polar(r0, a0, y1), [0, 0, -1], K.hullXDk);
  b.quadN(polar(r0, a1, y0), polar(r1, a1, y0), polar(r1, a1, y1), polar(r0, a1, y1), [0, 0, -1], K.hullXDk);
  // green running lights on the deck
  for (let k = 0; k < 6; k++) {
    const a = a0 + ((k + 0.5) * (a1 - a0)) / 6, c = polar(r0 + 0.12, a, y1 + 0.004);
    b.decal([[c[0] - 0.06, c[1], c[2] - 0.06], [c[0] + 0.06, c[1], c[2] - 0.06], [c[0] + 0.06, c[1], c[2] + 0.06], [c[0] - 0.06, c[1], c[2] + 0.06]], G_GRN);
  }
  // mount pads (the turrets and generators stand on them); a rotation by −a about y puts +x at polar angle a
  for (const a of [0, 60 * DEG, 120 * DEG]) {
    const f = b.n;
    b.block({ x: AE_MOUNT, y: y1 - 0.02, z: 0, w: 1.0, d: 1.0, h: 0.1, tw: 0.9, td: 0.9, top: K.hull, side: K.cerDk });
    b.xform(f, M(0, 0, 0, 0, -a, 0));
  }
  // girder spokes to the bearing collar round the hub
  for (const a of [30 * DEG, 90 * DEG, 150 * DEG]) {
    const f = b.n;
    b.block({ x: (2.7 + r0) / 2, y: -0.06, z: 0, w: r0 - 2.7 + 0.2, d: 0.44, h: 0.26, tw: r0 - 2.7 + 0.1, td: 0.3, top: K.cer, side: K.hull });
    b.decal([[2.9, 0.205, -0.03], [r0 - 0.1, 0.205, -0.03], [r0 - 0.1, 0.205, 0.03], [2.9, 0.205, 0.03]], G_GRND);
    for (const dz of [-0.12, 0.12]) b.decal([[3.2, 0.203, dz - 0.03], [r0 - 0.3, 0.203, dz - 0.03], [r0 - 0.3, 0.203, dz + 0.03], [3.2, 0.203, dz + 0.03]], K.goldLt);
    b.xform(f, M(0, 0, 0, 0, -a, 0));
  }
  // solar arrays in the sectors between the spokes: dark cells in a checker on a graphite frame
  for (const c of [60 * DEG, 120 * DEG]) {
    const w = 15 * DEG, ra = 3.05, rb = 4.7, y = 0.02;
    annulus(b, ra, rb, y, c - w, c + w, 2, K.hullDk);
    annulus(b, ra, rb, y - 0.04, c - w, c + w, 2, K.cer, -1);
    for (let u = 0; u < 4; u++) {
      for (let v = 0; v < 2; v++) {
        const q0 = ra + 0.08 + u * 0.4, q1 = q0 + 0.34, t0 = c - w + 0.02 + v * w, t1 = t0 + w - 0.04;
        b.quadN(polar(q0, t0, y + 0.006), polar(q1, t0, y + 0.006), polar(q1, t1, y + 0.006), polar(q0, t1, y + 0.006), [0, 1, 0], (u + v) & 1 ? K.solarLt : K.solar);
      }
    }
  }
  wall(b, 2.7, -0.1, 0.24, a0, a1, 6, K.hull, 1);
  annulus(b, 2.56, 2.7, 0.24, a0, a1, 6, K.cerDk);
  return b;
}
function buildAegisTurret() {   // part-local, twin barrels along −z
  const b = new GB();
  b.lathe([0, -0.02, 0], [0, 1, 0], [[0, 0.46], [0.1, 0.45], [0.16, 0.37], [0.2, 0.0]], 8,
    (i, j) => (i === 0 ? K.hullDk : i === 1 ? ((j & 1) ? K.gold : K.goldLt) : K.hullXDk), null, null, { phase: Math.PI / 8 });
  b.block({ x: 0, y: 0.1, z: 0.05, w: 0.64, d: 0.74, h: 0.3, tw: 0.5, td: 0.6, oz: 0.05, bev: 0.05, top: K.cer, bevS: K.cerLt, side: K.hull, front: K.hullDk });
  for (const x of [-0.12, 0.12]) {
    b.lathe([x, 0.25, -0.3], [0, 0, -1], [[0, 0.065], [0.56, 0.055], [0.56, 0.07], [0.68, 0.07], [0.68, 0.03]], 6, (i) => (i === 2 ? K.cerLt : K.hullDk), null, G_GRN, { phase: Math.PI / 6 });
  }
  b.decal([[-0.15, 0.402, -0.2], [0.15, 0.402, -0.2], [0.11, 0.402, -0.11], [-0.11, 0.402, -0.11]], G_GRN);
  b.decal([[-0.2, 0.402, 0.2], [0.2, 0.402, 0.2], [0.2, 0.402, 0.27], [-0.2, 0.402, 0.27]], K.orange);
  return b;
}
function buildAegisGen() {    // part-local: shield-generator pylon with its emitter crystal
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.44], [0.1, 0.42], [0.3, 0.27], [0.86, 0.19], [1.0, 0.25], [1.08, 0.13]], 6, (i, j) => {
    if (i === 0) return K.hullDk;
    if (i === 2) return (j & 1) ? K.cer : K.cerLt;
    if (i === 3) return G_GRND;
    return (j & 1) ? K.gold : K.goldLt;
  }, null, K.hull, { phase: Math.PI / 6 });
  // three fins round the pylon
  for (let k = 0; k < 3; k++) {
    const f = b.n;
    b.block({ x: 0.3, y: 0.05, z: 0, w: 0.26, d: 0.06, h: 0.62, tw: 0.08, td: 0.05, ox: -0.06, top: K.cerLt, side: K.hull });
    b.xform(f, M(0, 0, 0, 0, (k * TAU) / 3 + Math.PI / 6, 0));
  }
  // emitter crystal: an elongated double pyramid, white-hot green
  const cy = 1.42, rr = 0.2;
  const eq = [0, 1, 2, 3].map((k) => polar(rr, (k * TAU) / 4 + Math.PI / 4, cy));
  b.spike(eq, [0, cy + 0.42, 0], (k) => (k & 1 ? G_GRNH : G_GRN));
  b.spike(eq, [0, cy - 0.3, 0], (k) => (k & 1 ? G_GRN : G_GRND));
  return b;
}
function buildAegisCannon() {   // part-local (pivot on the socket); the railgun's twin rails along −z
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.64], [0.14, 0.62], [0.24, 0.5], [0.28, 0.0]], 10,
    (i, j) => (i === 0 ? K.hullDk : i === 1 ? ((j & 1) ? K.cer : K.cerLt) : K.hullXDk), null, null, { phase: Math.PI / 10 });
  // breech: armoured block with hazard stripes
  const br0 = b.n;
  b.block({ x: 0, y: 0.22, z: 0.45, w: 1.0, d: 1.3, h: 0.54, tw: 0.86, td: 1.14, oz: 0.05, bev: 0.06, top: K.cer, bevS: K.cerLt, side: K.hull, front: K.hullDk, back: K.hullXDk });
  const br1 = b.n;
  hazardDrape(b, -0.36, 0.95, 0.36, 0.95, 0.16, 6, K.orange, K.black, br0, br1, 0.01, 1);
  // the twin rails, the glowing slug channel between them, four coil clamps and the muzzle brace
  for (const x of [-0.22, 0.22]) b.block({ x, y: 0.4, z: -2.1, w: 0.18, d: 4.1, h: 0.26, tw: 0.14, td: 4.04, top: K.hullLt, side: K.hull, front: K.cerDk });
  b.lathe([0, 0.54, -0.15], [0, 0, -1], [[0, 0.07], [3.95, 0.07]], 6, G_GRND, null, null, { phase: Math.PI / 6 });
  for (const z of [-0.8, -1.7, -2.6, -3.5]) {
    b.block({ x: 0, y: 0.36, z, w: 0.74, d: 0.24, h: 0.36, tw: 0.66, td: 0.2, top: G_GRN, side: K.hullDk, front: K.cerDk, back: K.cerDk });
  }
  b.block({ x: 0, y: 0.34, z: -4.15, w: 0.8, d: 0.3, h: 0.42, tw: 0.7, td: 0.26, top: K.cer, side: K.hull, front: K.hullXDk });
  b.decal([[-0.08, 0.762, -4.08], [0.08, 0.762, -4.08], [0.08, 0.762, -3.98], [-0.08, 0.762, -3.98]], G_RD);
  return b;
}
function buildAegisCap() {   // part-local, standing on its base: capacitor bank with glowing coil rings
  const b = new GB();
  const prof = [[0, 0.36], [0.1, 0.36], [0.14, 0.3]];
  for (let k = 0; k < 4; k++) { const y = 0.2 + k * 0.2; prof.push([y, 0.32], [y + 0.06, 0.32], [y + 0.1, 0.29]); }
  prof.push([1.02, 0.34], [1.1, 0.34], [1.18, 0.2], [1.22, 0.0]);
  b.lathe([0, 0, 0], [0, 1, 0], prof, 8, (i, j) => {
    if (i < 2) return K.hullDk;
    if (i >= prof.length - 4) return i === prof.length - 3 ? K.goldLt : K.cer;
    const q = (i - 2) % 3;
    return q === 0 ? G_GRN : q === 1 ? ((j & 1) ? K.cer : K.cerLt) : K.hull;
  }, null, null, { phase: Math.PI / 8 });
  b.spike([polar(0.08, 0, 1.22), polar(0.08, TAU / 3, 1.22), polar(0.08, (2 * TAU) / 3, 1.22)], [0, 1.52, 0], G_GRNH);
  return b;
}
function buildShieldDome() {   // additive energy lattice: the edges of a geodesic dome over a faint fill
  const pos = [], col = [];
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position.array;
  const EDGE = [0.2, 1.3, 0.62], IN = [0.02, 0.2, 0.12], FILL = [0.01, 0.07, 0.05];
  const push = (v, c) => { pos.push(v[0] * AE_DOME, Math.max(0, v[1]) * AE_DOME * 0.62 + 0.18, v[2] * AE_DOME); col.push(c[0], c[1], c[2]); };
  for (let i = 0; i < p.length; i += 9) {
    const A = [p[i], p[i + 1], p[i + 2]], B = [p[i + 3], p[i + 4], p[i + 5]], C = [p[i + 6], p[i + 7], p[i + 8]];
    if ((A[1] + B[1] + C[1]) / 3 < -0.02) continue;
    const c = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
    const inset = (v) => [v[0] + (c[0] - v[0]) * 0.16, v[1] + (c[1] - v[1]) * 0.16, v[2] + (c[2] - v[2]) * 0.16];
    const V = [A, B, C], I = V.map(inset);
    for (let e = 0; e < 3; e++) {
      const a = V[e], b2 = V[(e + 1) % 3], ai = I[e], bi = I[(e + 1) % 3];
      push(a, EDGE); push(b2, EDGE); push(bi, IN);
      push(a, EDGE); push(bi, IN); push(ai, IN);
    }
    push(I[0], FILL); push(I[1], FILL); push(I[2], FILL);
  }
  geo.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
function createAegis() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss:aegis';
  ud.radius = 5.0;
  ud.debrisColor = new THREE.Color('#6a7280');
  const allMats = [];
  const mat = (r = 0.55, m = 0.32) => { const x = bodyMat(r, m); allMats.push(x); return x; };
  const hullMat = mat();
  const hub = new THREE.Group(); hub.name = 'hub';
  hub.add(new THREE.Mesh(GG('ext:s4:aegis.hub', buildAegisHub), hullMat));
  pivot.add(hub);
  const flameMat = additiveMat();
  const flames = new THREE.Mesh(G('ext:s4:aegis.flames', () => buildFlame([[-0.58, -0.1], [0.58, -0.1]], FLAME_ION_BIG)), flameMat);
  flames.position.set(0, 0, 2.86); flames.userData.noShadow = true; flames.renderOrder = 2;
  hub.add(flames);
  // ---- the ring, in two halves (they part for the death)
  const ring = new THREE.Group(); ring.name = 'ring';
  const ringGeo = GG('ext:s4:aegis.ring', buildAegisRingHalf);
  const ringMat = mat();
  const halves = [0, 1].map((h) => {
    const grp = new THREE.Group(); grp.rotation.y = h * Math.PI;      // half B is half A turned by π
    grp.add(new THREE.Mesh(ringGeo, ringMat));
    ring.add(grp);
    return grp;
  });
  pivot.add(ring);
  // ---- turrets and shield generators on the ring's mount pads (in the half that carries them)
  const mountY = AE_RY[1] + 0.08;
  const onRing = (part, a) => {
    const h = a >= Math.PI - 1e-6 ? 1 : 0, la = a - h * Math.PI;      // angle inside that half's frame
    part.position.set(Math.cos(la) * AE_MOUNT, mountY, Math.sin(la) * AE_MOUNT);
    halves[h].add(part);
    return part;
  };
  const turKeep = { keep: (x, y, z) => z + 0.3, crumple: 0.1, seed: 43, dir: [0, 0.4, -1], shards: 8, shardSize: 0.2, band: 0.35 };
  const turret = AE_TURRET_A.map((a, k) => onRing(destructiblePart({ key: 'ext:s4:aegis.turret', build: buildAegisTurret, name: 'turret' + k, radius: 0.75,
    muzzles: [new THREE.Vector3(-0.12, 0.25, -1.02), new THREE.Vector3(0.12, 0.25, -1.02)], wreck: turKeep, sag: [0.12, -0.08, 0.1], mat: mat() }), a));
  const genKeep = { keep: (x, y, z) => 0.62 - y, crumple: 0.12, seed: 47, dir: [0, 1, 0], shards: 9, shardSize: 0.22, band: 0.35 };
  const gen = AE_GEN_A.map((a, k) => onRing(destructiblePart({ key: 'ext:s4:aegis.gen', build: buildAegisGen, name: 'gen' + k, radius: 0.72,
    muzzles: [new THREE.Vector3(0, 1.45, 0)], wreck: genKeep, sag: [0.18, -0.12, 0.1], mat: mat() }), a));
  // ---- railgun: stowed facing up-screen (rotation.y = π), swung round to fire; its telegraph lane
  const cannonMat = mat();
  const cannon = destructiblePart({ key: 'ext:s4:aegis.cannon', build: buildAegisCannon, name: 'cannon', radius: 1.05,
    muzzles: [new THREE.Vector3(0, 0.54, -4.4)], wreck: { keep: (x, y, z) => z + 1.9, crumple: 0.14, seed: 53, dir: [0, 0.3, -1], shards: 12, shardSize: 0.3, band: 0.5 },
    sag: [0.14, -0.1, 0.06], pos: AE_GUN, mat: cannonMat });
  cannon.rotation.order = 'YXZ';
  const beam = beamMesh('ext:s4:aegis.beam', 36, 0.34, 1.3);
  beam.m.position.set(0, 0.54, -4.45);
  cannon.add(beam.m);
  let charge = 0;
  cannon.userData.setBeam = beam.m.userData.set;
  /** 0..1: the rails' coils glow as it charges */
  cannon.userData.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  pivot.add(cannon);
  // ---- capacitor banks behind the core (setCharge(0..1): the coil rings glow as a bank charges to dump)
  const capKeep = { keep: (x, y, z) => 0.55 - y, crumple: 0.1, seed: 59, dir: [0, 1, 0], shards: 8, shardSize: 0.2, band: 0.3 };
  const mkCap = (side) => {
    const m = mat();
    const cap = destructiblePart({ key: 'ext:s4:aegis.cap', build: buildAegisCap, name: side < 0 ? 'capL' : 'capR', radius: 0.62,
      muzzles: [new THREE.Vector3(0, 1.45, 0)], wreck: capKeep, sag: [0.1, -0.1, 0.12 * side], pos: [AE_CAP[0] * side, AE_CAP[1], AE_CAP[2]], mat: m });
    cap.userData.charge = 0;
    cap.userData.setCharge = (v) => { cap.userData.charge = Math.max(0, Math.min(1, v)); };
    cap.userData.capMat = m;
    return cap;
  };
  const capL = mkCap(-1), capR = mkCap(1);
  pivot.add(capL, capR);
  // ---- core: reactor orb under two dome shutters
  const coreMat = mat(0.5, 0.3), orbMat = bodyMat(0.4, 0.1);
  const orbGeo = GG('ext:s4:aegis.orb', () => orbGB(0.55, 0.2, GRNH, 5.3)), orbDead = GG('ext:s4:aegis.orbDead', () => orbGB(0.5, 0.2, GRNH, 8.9, true));
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const shGeo = GG('ext:s4:aegis.shutter', () => shutterGB(0.8, G_GRN));
  const hingeR = new THREE.Object3D(); hingeR.position.set(0.8, 0.16, 0);
  const hingeL = new THREE.Object3D(); hingeL.position.set(-0.8, 0.16, 0);
  const shR = new THREE.Mesh(shGeo, coreMat); shR.position.set(-0.8, -0.16, 0);
  const shL = new THREE.Mesh(shGeo, coreMat); shL.position.set(0.8, -0.16, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  const core = makePart('core', 1.1, [{ mesh: orb, intact: orbGeo, wreck: orbDead }, { mesh: shR, hideOnDestroy: true }, { mesh: shL, hideOnDestroy: true }],
    [new THREE.Vector3(0, 0.7, 0)]);
  core.add(hingeR, hingeL);
  core.userData.materials.push(coreMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(AE_CORE[0], AE_CORE[1], AE_CORE[2]);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    hingeR.rotation.z = -e * 118 * DEG; hingeL.rotation.z = e * 118 * DEG;
  };
  core.userData.setOpen(0);
  /** 0..1: the reactor orb flares (and swells) before it fires an aimed volley */
  let coreCharge = 0;
  core.userData.setCharge = (v) => { coreCharge = Math.max(0, Math.min(1, v)); };
  pivot.add(core);
  // ---- shield dome
  const domeMat = additiveMat();
  const dome = new THREE.Mesh(G('ext:s4:aegis.dome', buildShieldDome), domeMat);
  dome.userData.noShadow = true; dome.renderOrder = 4; dome.visible = false;
  pivot.add(dome);
  let shield = 0, pulse = 0;
  /** 0..1: the dome's strength (0 hides it) */
  ud.setShield = (v) => { shield = Math.max(0, Math.min(1, v)); dome.visible = shield > 0.01; };
  /** a ripple of light over the dome (a hit, a generator pulse) */
  ud.pulseShield = (v = 1) => { pulse = Math.max(pulse, v); };
  /** ring angle (radians, about y) */
  ud.setSpin = (a) => { ring.rotation.y = a; };
  ud.ring = ring;
  ud.parts = { turret, gen, cannon, capL, capR, core };
  ud.muzzles = [new THREE.Vector3(0, 0.6, -2.6)];
  const flashAll = flashFn([...allMats, orbMat]);
  ud.setFlash = flashAll;
  // ---- death: 0 = whole, 1 = the ring split in two halves drifting apart, the hub tipped
  let brk = 0;
  ud.setBreak = (v) => {
    brk = Math.max(0, Math.min(1, v));
    const e = brk * brk * (3 - 2 * brk);
    halves[0].position.set(0.2 * e, -1.1 * e, -1.6 * e); halves[0].rotation.set(-0.35 * e, 0.3 * e, 0.22 * e);
    halves[1].position.set(-0.3 * e, -0.8 * e, 1.9 * e); halves[1].rotation.set(0.3 * e, Math.PI - 0.25 * e, -0.18 * e);
    hub.rotation.set(0.22 * e, 0, -0.3 * e);
  };
  ud.setBreak(0);
  /** pooled instances come back posed: whole, ring at 0, railgun stowed, shield off, every gun facing forward */
  ud.reset = () => {
    ud.setBreak(0); ud.setSpin(0); ud.setShield(0); beam.m.userData.set(0); charge = 0; pulse = 0;
    coreCharge = 0; capL.userData.charge = 0; capR.userData.charge = 0;
    cannon.rotation.set(0, Math.PI, 0);
    for (const p of turret) p.rotation.y = 0;
  };
  ud.reset();
  ud.update = (dt, t) => {
    const p = (0.8 + Math.sin(t * 2.6) * 0.2) * (1 - brk * 0.6);
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = p;
    cannonMat.uEmitScale.value = p + charge * (1.6 + Math.sin(t * 44) * 0.4);
    // a charging bank: its coils and crown burn brighter and turn amber (the colour of the big orbs it dumps)
    const cl = capL.userData.destroyed ? 0 : capL.userData.charge, cr = capR.userData.destroyed ? 0 : capR.userData.charge;
    capL.userData.capMat.uEmitScale.value = p + cl * (3.0 + Math.sin(t * 38) * 0.6);
    capL.userData.capMat.uEmitTint.value.setRGB(1 + cl * 1.4, 1, 1 - cl * 0.75);
    capR.userData.capMat.uEmitScale.value = p + cr * (3.0 + Math.sin(t * 38 + 1.3) * 0.6);
    capR.userData.capMat.uEmitTint.value.setRGB(1 + cr * 1.4, 1, 1 - cr * 0.75);
    const cc = core.userData.destroyed ? 0 : coreCharge;
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.32 + openT * 0.45) * (1 + Math.sin(t * 8) * 0.12) + cc * (1.5 + Math.sin(t * 42) * 0.3);
    orb.scale.setScalar(1 + cc * 0.22);
    orb.rotation.y += dt * (0.5 + openT * 2.6);
    pulse = Math.max(0, pulse - dt * 2.5);
    if (dome.visible) {
      dome.rotation.y += dt * 0.12;
      domeMat.color.setScalar(shield * (0.55 + Math.sin(t * 3.3) * 0.12 + pulse * 0.8));
    }
    flames.scale.set(1, 1, (1 + Math.sin(t * 37) * 0.08 + Math.sin(t * 23) * 0.05) * (1 - brk * 0.85));
    flameMat.color.setScalar(0.9 + Math.sin(t * 29) * 0.1);
    pivot.position.y = Math.sin(t * 0.6) * 0.12;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); orbMat.dispose(); flameMat.dispose(); domeMat.dispose(); beam.mat.dispose(); };
  return g;
}

export const ENEMIES = {
  s4_drone: createDrone,
  s4_laser: createLaserSat,
  s4_frigate: createFrigate,
  s4_mine: createMine,
  hydra: createHydra,
};
export const BOSSES = { aegis: createAegis };
