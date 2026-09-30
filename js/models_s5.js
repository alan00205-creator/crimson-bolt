// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 5 "LUNAR SIEGE" (月面攻防)
// -----------------------------------------------------------------------------
// models.js registers these tables: createEnemy(type) falls back to ENEMIES[type],
// createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { s5_rover, s5_walker, s5_turret, s5_lander, s5_skimmer, selenite };
//   export const BOSSES = { selene };
//
// The lunar garrison: slate-blue armour under white thermal plating, gold-foil insulation,
// safety-orange hazard trim, red sensor eyes and pale moonlight-blue energy (stage 2's molten
// orange, stage 3's cyan and stage 4's emerald stay distinct). The regolith is mid grey and the
// shadows are black, so every unit carries a white or gold top and saturated glows: it reads on
// the bright highlands, the graded base, the dark mare and inside a black shadow alike.
//
//   S5_ROVER    six-wheeled assault rover (ground): hull + twin laser turret (userData.turret)
//               + a spinning dish antenna
//   S5_WALKER   quad strider (ground): armoured pod on four legs (two diagonal pairs that trot,
//               userData.setWalk(ph, amp)), a dorsal lance cannon (userData.turret) whose
//               capacitor coils light up with userData.setCharge(0..1); setBrace(0..1) crouches
//   S5_TURRET   crater turret (ground): an armoured hatch in the regolith; two doors slide apart
//               and a triple-barrel gun rises out of the pit (userData.setOpen(0..1): doors,
//               setRise(0..1): the gun; userData.turret aims). The factory pose is raised (the
//               stage hides it at spawn)
//   S5_LANDER   lunar lander dropship (air): gold-foil descent stage on four legs, crew cabin,
//               twin gun pods, descent-engine flame (setThrust), and a cargo drop pod slung
//               underneath (userData.setPod(y, visible): its height below the lander)
//   S5_SKIMMER  crescent-winged skimmer (air): the garrison's emblem as a fighter
//   SELENITE    mid-boss tunnelling machine (ground, 5 draw calls): a tracked, armoured
//               carapace; two drill bits (parts drillL / drillR, spun with setSpin), the selenite
//               crystal crown on its back (part crown) and the crystal heart under two blast
//               plates (part core: setOpen(0..1) blows the plates open and raises the heart)
//   SELENE      boss, the lunar fortress (ground, 16 draw calls + the beam): a crescent of
//               armour hovering on lift jets round a domed citadel. Horn cannons (parts horn0/1),
//               four ridge batteries (battery0..3), two tide emitters in the crescent's back
//               (bay0/1: setOpen), the solar mirror under the dome (part mirror: setRise,
//               setCharge, setBeam(width, glow)), the crystal heart (part core: setOpen raises
//               it); setDome(0..1) opens the dome, setHover(0..1) runs the lift jets,
//               setBreak(0..1) splits the crescent for the death; reset() for the pool.
//
// Imports: only 'three' and './modelkit.js' — never models.js (import cycle).
// House style and helpers: see the modelkit.js header.
//
// Enemy contract — enemyShell(kind, radius, debrisHex) + bodyMat + GG(key, buildXxx):
//   * nose/front toward −z (the game yaws units that face the player by π), up +y;
//     air units centred on the origin; ground units with their base at y = 0 AND
//     userData.ground = true (the registry adds them to GROUND_TYPES: no air shadow)
//   * userData: kind (the registry sets it to the type), radius, debrisColor, muzzles
//     (group-local Vector3[], refreshed in update() when they move), setFlash(v),
//     update(dt, t), dispose() (materials only)
//   * turreted units: userData.turret (a Group rotating about y only) with
//     turret.userData.muzzles (turret-local), kept in sync by syncMuzzles() in update()
//   * gameplay numbers (hp, score, collision radius) live in stage5.js ENEMY, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (userData.midboss)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) fully restores the pose
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * mirrored parts share geometry + wreck with mesh.scale.x = −1
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
//   * a part's origin sits at the middle of what it shows (its hit circle is centred there):
//     elevated or long pieces are offset inside their part
// Cache keys: 'ext:s5:<name>'.
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, M, S, DEG, TAU, lit, lin, rgb, GL, EM, scl, sub, hash3, bodyMat, additiveMat, flashFn, enemyShell, syncMuzzles,
  hazardStrip, hazardDrape, trackLoft, makePart, wreckGeo, buildFlame,
} from './modelkit.js';

// =============================================================================
// palette + shared helpers
// =============================================================================
const LN = {
  armor: lit('#3d4656'), armorLt: lit('#5c677b'), armorDk: lit('#272d38'), armorXDk: lit('#171b22'),
  white: lit('#c3c8d0'), whiteLt: lit('#dce0e6'), whiteDk: lit('#949ba6'),
  gold: lit('#c4952e'), goldLt: lit('#e2b852'), goldDk: lit('#7e5a1a'),
  orange: lit('#e0661c'), orangeDk: lit('#a2460f'), black: lit('#0b0c0f'),
  tire: lit('#26292e'), tireLt: lit('#474c55'), hub: lit('#8d949e'),
  glass: S(lin('#16202c'), rgb(0.008, 0.025, 0.05)), glassLt: S(lin('#43607e'), rgb(0.025, 0.06, 0.11)),
};
const MB = rgb(0.52, 0.76, 1.0, 3.2);      // moonlight blue: energy, lenses, the selenite crystals
const MBH = rgb(0.82, 0.92, 1.0, 4.2);     // white-hot moonlight
const MBD = rgb(0.42, 0.64, 1.0, 1.6);     // dim: conduits, panel lights
const SUN = rgb(1.0, 0.84, 0.52, 3.4);     // focused sunlight (SELENE's mirror)
const G_MB = GL(MB, 0.4), G_MBH = GL(MBH, 0.5), G_MBD = GL(MBD, 0.3), G_AMB = GL(EM.amber, 0.42), G_RED = GL(EM.eyeRed, 0.45);
const HAZ_A = LN.orange, HAZ_B = LN.black;
const TRACK_LN = { treadA: lit('#4a4f58'), treadB: lit('#2a2e35'), side: lit('#30353d'), sideB: lit('#3f4550'), bottom: lit('#181b20'), end: lit('#383d46') };
// moonlight-blue exhaust (additive cones, see modelkit buildFlame)
const FLAME_MOON = [
  { r: 0.07, len: 0.5, base: rgb(0.5, 0.72, 1.0, 1.3), tip: rgb(0.15, 0.25, 0.6, 0.0), sides: 6 },
  { r: 0.04, len: 0.28, base: rgb(0.85, 0.94, 1.0, 1.8), tip: rgb(0.4, 0.6, 1.0, 0.1), sides: 5 },
];
const FLAME_LIFT = [
  { r: 0.34, len: 1.0, base: rgb(0.45, 0.66, 1.0, 0.9), tip: rgb(0.1, 0.18, 0.5, 0.0), sides: 7 },
  { r: 0.18, len: 0.55, base: rgb(0.8, 0.9, 1.0, 1.4), tip: rgb(0.35, 0.55, 1.0, 0.05), sides: 6 },
];

/** tapered n-sided strut from p0 to p1 (radii r0 → r1) */
function strut(b, p0, p1, r0, r1, n, style, capB = null, phase = 0) {
  const ax = sub(p1, p0), len = Math.hypot(ax[0], ax[1], ax[2]);
  b.lathe(p0, ax, [[0, r0], [len, r1]], n, style, null, capB, { phase });
}
/** wheel drum along +x from (x, y, z): radius r, width w; alternate faces carry the tread */
function wheel(b, x, y, z, r, w, n) {
  b.lathe([x, y, z], [1, 0, 0], [[0, r], [w, r]], n, (i, j) => ((j & 1) ? LN.tireLt : LN.tire), null, LN.hub, { phase: Math.PI / n });
}
/** regular n-gon [[x, y, z], …] of radius r round (cx, y, cz), first corner at angle a0 */
function ngon(n, r, cx, y, cz, a0 = 0) {
  const out = [];
  for (let k = 0; k < n; k++) { const a = a0 + (k * TAU) / n; out.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]); }
  return out;
}
/** selenite crystal: a hexagonal prism with a pyramid tip from `base` along `dir`; faceted glow */
function crystal(b, base, dir, len, r, seed, dim = 1) {
  b.lathe(base, dir, [[0, r * 0.7], [len * 0.12, r], [len * 0.72, r * 0.88], [len, 0.0]], 6, (i, j) => {
    const k = hash3(i * 3.1 + seed, j * 1.7, seed * 0.37);
    if (i === 0) return LN.armorDk;
    if (i === 2) return GL(scl(MBH, (0.45 + 0.35 * k) * dim), 0.55);
    return GL(scl(MB, (k > 0.66 ? 0.95 : k > 0.33 ? 0.62 : 0.4) * dim), 0.55);
  }, null, null, { phase: seed });
}
/** faceted glowing gem (icosahedron, stretched in y), centre (0, cy, 0); dead = dark and cracked */
function gemGB(r, sy, cy, seed, dead = false) {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const k = hash3(i / 9, seed, 3.1);
    const st = dead ? (k > 0.82 ? GL(EM.emberDim, 0.3) : S(lin(k > 0.4 ? '#20242b' : '#30353e')))
      : k > 0.7 ? GL(MBH, 0.55) : GL(scl(MB, k > 0.35 ? 0.75 : 0.45), 0.55);
    const d = (v) => (dead ? [p[v] * (0.88 + k * 0.18), p[v + 1] * sy * 0.62 + cy * 0.8, p[v + 2] * (0.88 + k * 0.18)] : [p[v], p[v + 1] * sy + cy, p[v + 2]]);
    b.triO(d(i), d(i + 3), d(i + 6), [0, cy, 0], st);
  }
  geo.dispose();
  return b;
}
/** flat annulus sector r0..r1 round (cx, cz) at height y, angles a0..a1 (x = cos, z = sin), facing up */
function arcRing(b, cx, cz, r0, r1, y, a0, a1, n, style) {
  for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n, t1 = a0 + ((a1 - a0) * (k + 1)) / n;
    const P = (r, t) => [cx + Math.cos(t) * r, y, cz + Math.sin(t) * r];
    b.quadN(P(r0, t0), P(r1, t0), P(r1, t1), P(r0, t1), [0, 1, 0], typeof style === 'function' ? style(k) : style);
  }
}
/** RGB beam ribbon (two crossed quads + a hot core line) along −z, unit length (scale z to its length) */
function beamGeo(c0, c1) {
  const pos = [], col = [];
  const q = (a, b2, c, d, ca, cb) => { pos.push(...a, ...b2, ...c, ...a, ...c, ...d); col.push(...ca, ...ca, ...cb, ...ca, ...cb, ...cb); };
  q([-0.5, 0, 0], [0.5, 0, 0], [0.5, 0, -1], [-0.5, 0, -1], c0, c1);
  q([0, -0.5, 0], [0, 0.5, 0], [0, 0.5, -1], [0, -0.5, -1], c0, c1);
  q([-0.12, 0.01, 0], [0.12, 0.01, 0], [0.12, 0.01, -1], [-0.12, 0.01, -1], scl(c0, 1.6), scl(c1, 0.8));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

// =============================================================================
// S5_ROVER — six-wheeled assault rover (3 draw calls)
// =============================================================================
function buildRoverHull() {
  const b = new GB();
  // chassis tub between the wheels
  b.block({ x: 0, y: 0.14, z: 0.0, w: 0.8, d: 2.0, h: 0.22, top: LN.armorDk, side: LN.armorXDk });
  // deck: slate plate with a pointed nose
  const d0 = b.n;
  b.plate([[0, -1.24], [0.34, -1.1], [0.5, -0.84], [0.5, 1.02], [0.34, 1.1], [-0.34, 1.1], [-0.5, 1.02], [-0.5, -0.84], [-0.34, -1.1]], 0.32, 0.44, LN.armor, LN.armorLt, null);
  const d1 = b.n;
  hazardDrape(b, -0.3, -0.98, 0.3, -0.98, 0.14, 5, HAZ_A, HAZ_B, d0, d1, 0.005, 1);
  b.drape([[[-0.46, -0.3], [-0.3, -0.3], [-0.3, 0.46], [-0.46, 0.46]], [[0.3, -0.3], [0.46, -0.3], [0.46, 0.46], [0.3, 0.46]]], LN.whiteDk, d0, d1, 0.004, 1);
  for (const sg of [-1, 1]) b.drape([[[0.12 * sg, -1.1], [0.26 * sg, -1.04], [0.26 * sg, -0.98], [0.12 * sg, -1.02]]], G_AMB, d0, d1, 0.006, 1);
  // sensor head on the nose: white, glass visor, red eye strip on top
  b.block({ x: 0, y: 0.44, z: -0.8, w: 0.58, d: 0.34, h: 0.14, tw: 0.5, td: 0.24, oz: 0.03, bev: 0.03, top: LN.white, bevS: LN.whiteLt, side: LN.whiteDk, front: LN.glass });
  b.decal([[-0.18, 0.584, -0.87], [0.18, 0.584, -0.87], [0.18, 0.584, -0.81], [-0.18, 0.584, -0.81]], G_RED);
  // gold RTG box at the back with white radiator fins and an amber beacon
  b.block({ x: 0, y: 0.44, z: 0.72, w: 0.64, d: 0.46, h: 0.2, bev: 0.03, top: LN.gold, bevS: LN.goldLt, side: LN.goldDk, back: LN.goldDk });
  for (const x of [-0.2, 0, 0.2]) b.block({ x, y: 0.64, z: 0.72, w: 0.05, d: 0.4, h: 0.09, top: LN.whiteLt, side: LN.white });
  b.block({ x: 0.26, y: 0.64, z: 0.94, w: 0.08, d: 0.08, h: 0.06, top: G_AMB, side: GL(EM.amber, 0.3) });
  // antenna mast (the dish sits on top)
  b.lathe([-0.32, 0.44, 0.34], [0, 1, 0], [[0, 0.035], [0.46, 0.025]], 4, LN.armorDk, null, null);
  const f0 = b.n;
  // --- right side (mirrored): three wire-mesh wheels, the orange fender rail, the rocker arm
  for (const z of [-0.74, 0.0, 0.74]) wheel(b, 0.44, 0.26, z, 0.26, 0.2, 7);
  b.block({ x: 0.55, y: 0.53, z: 0.0, w: 0.26, d: 2.02, h: 0.04, top: LN.orange, side: LN.orangeDk });
  b.block({ x: 0.43, y: 0.22, z: 0.0, w: 0.06, d: 1.5, h: 0.08, top: LN.hub, side: LN.armorDk });
  b.mirrorX(f0);
  return b;
}
function buildRoverGun() {   // twin laser on a ring mount (turret-local, barrels along −z)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.24], [0.08, 0.22], [0.12, 0.15]], 7, (i) => (i === 0 ? LN.armorDk : LN.armor), null, LN.armorLt);
  b.block({ x: 0, y: 0.06, z: 0.04, w: 0.36, d: 0.4, h: 0.15, tw: 0.3, td: 0.32, bev: 0.03, top: LN.white, bevS: LN.whiteLt, side: LN.armor, front: LN.armorDk });
  for (const x of [-0.09, 0.09]) {
    b.lathe([x, 0.13, -0.14], [0, 0, -1], [[0, 0.045], [0.46, 0.035], [0.46, 0.052], [0.54, 0.052]], 5, (i) => (i === 2 ? LN.whiteLt : LN.armorDk), null, G_MB);
  }
  return b;
}
function buildRoverDish() {  // high-gain dish on the mast top (origin), tilted back, facing up
  const b = new GB();
  b.lathe([0, 0.02, 0], [0, 1, 0], [[0, 0.04], [0.06, 0.16], [0.1, 0.22]], 7, LN.whiteDk, null, null);
  b.decal(ngon(7, 0.215, 0, 0.12, 0), LN.whiteLt);
  b.lathe([0, 0.12, 0], [0, 1, 0], [[0, 0.02], [0.14, 0.01]], 3, LN.armorDk, null, G_MB);
  b.xform(0, M(0, 0, 0, 0.5, 0, 0));
  return b;
}
function createRover() {
  const { g, pivot, ud } = enemyShell('s5_rover', 0.85, '#5c677b');
  ud.ground = true;
  ud.halfExtents = { x: 0.7, z: 1.25 };
  const mat = bodyMat(0.6, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s5:rover', buildRoverHull), mat));
  const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.44, 0.16);
  turret.add(new THREE.Mesh(GG('ext:s5:rover.gun', buildRoverGun), mat));
  pivot.add(turret);
  const dish = new THREE.Mesh(GG('ext:s5:rover.dish', buildRoverDish), mat);
  dish.position.set(-0.32, 0.9, 0.34);
  pivot.add(dish);
  ud.turret = turret;
  const local = [new THREE.Vector3(-0.09, 0.13, -0.7), new THREE.Vector3(0.09, 0.13, -0.7)];
  turret.userData.muzzles = local;
  ud.muzzles = [new THREE.Vector3(), new THREE.Vector3()];
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    dish.rotation.y += dt * 1.7;
    pivot.position.y = Math.abs(Math.sin(t * 8.3)) * 0.02;   // the suspension on the rough regolith
    syncMuzzles(ud.muzzles, local, turret);
    mat.uEmitScale.value = 0.8 + Math.sin(t * 7) * 0.2;
  };
  syncMuzzles(ud.muzzles, local, turret);
  ud.dispose = () => mat.dispose();
  return g;
}

// =============================================================================
// S5_WALKER — quad strider: pod, two diagonal leg pairs, dorsal lance cannon (4 draw calls)
// =============================================================================
const WK_Y = 1.42;          // pod centre height
function buildWalkerBody() {
  const b = new GB();
  // armoured pod: 8-sided sections [z, halfWidth, top, bottom]; edges 0/6 roof bevels, 1/5 upper flanks,
  // 2/4 lower flanks, 3 belly, 7 roof
  const ring = ([z, w, t, bt]) => [[w * 0.5, WK_Y + t, z], [w, WK_Y + t * 0.35, z], [w, WK_Y - bt * 0.3, z], [w * 0.55, WK_Y - bt, z],
    [-w * 0.55, WK_Y - bt, z], [-w, WK_Y - bt * 0.3, z], [-w, WK_Y + t * 0.35, z], [-w * 0.5, WK_Y + t, z]];
  const ST = [[-1.02, 0.3, 0.16, 0.14], [-0.84, 0.6, 0.34, 0.28], [-0.4, 0.76, 0.42, 0.34], [0.46, 0.76, 0.42, 0.34], [0.86, 0.58, 0.32, 0.26], [1.02, 0.32, 0.18, 0.14]];
  const s0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    if (j === 7) return i === 2 ? LN.whiteLt : LN.white;
    if (j === 0 || j === 6) return i === 1 ? LN.whiteLt : LN.whiteDk;
    if (j === 1 || j === 5) return i === 3 ? LN.orange : LN.armor;
    if (j === 2 || j === 4) return LN.armorDk;
    return LN.armorXDk;
  }, LN.armorXDk, LN.armorDk);
  const s1 = b.n;
  // hazard chevrons over the tail, a gold-foil panel, two glowing roof vents
  hazardDrape(b, 0, 0.62, 0, 0.92, 0.5, 4, HAZ_A, HAZ_B, s0, s1, 0.008, 1);
  b.drape([[[-0.26, -0.72], [0.26, -0.72], [0.3, -0.5], [-0.3, -0.5]]], LN.gold, s0, s1, 0.006, 1);
  for (const x of [-0.42, 0.42]) b.drape([[[x - 0.08, -0.2], [x + 0.08, -0.2], [x + 0.08, 0.3], [x - 0.08, 0.3]]], G_MBD, s0, s1, 0.006, 1);
  // sensor cluster on the nose: a big lens flanked by two red eyes
  b.lathe([0, WK_Y + 0.02, -0.98], [0, 0, -1], [[0, 0.13], [0.07, 0.1]], 7, LN.armorXDk, null, G_MBH);
  for (const sg of [-1, 1]) b.lathe([0.22 * sg, WK_Y + 0.1, -0.9], [0, 0.2, -1], [[0, 0.06], [0.05, 0.045]], 5, LN.armorXDk, null, G_RED);
  // hip sockets
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.lathe([0.62 * sx, WK_Y - 0.12, 0.5 * sz], [sx, 0, 0], [[0, 0.17], [0.12, 0.15]], 5, LN.armorDk, null, LN.armorLt, { phase: Math.PI / 5 });
  // turret ring on the roof
  b.lathe([0, WK_Y + 0.38, 0.12], [0, 1, 0], [[0, 0.34], [0.07, 0.3]], 8, LN.armorDk, null, LN.armorXDk);
  return b;
}
function buildWalkerLegs() {  // a diagonal pair: front-left and rear-right (the other pair is this mirrored in x)
  const b = new GB();
  const leg = (sx, sz) => {
    const hip = [0.66 * sx, WK_Y - 0.12, 0.5 * sz], knee = [1.42 * sx, WK_Y + 0.46, 0.94 * sz], ankle = [1.78 * sx, 0.3, 1.3 * sz];
    strut(b, hip, knee, 0.13, 0.1, 6, (i, j) => (j === 1 || j === 2 ? LN.whiteLt : j === 0 || j === 3 ? LN.white : LN.armorDk), null, Math.PI / 6);
    strut(b, knee, ankle, 0.1, 0.07, 5, (i, j) => (j & 1 ? LN.armor : LN.armorDk));
    // piston alongside the shin, gold knee joint, the foot pad
    strut(b, [knee[0] - 0.1 * sx, knee[1] - 0.12, knee[2] - 0.05 * sz], [ankle[0] - 0.14 * sx, ankle[1] + 0.3, ankle[2] - 0.1 * sz], 0.045, 0.045, 4, LN.hub);
    b.lathe([knee[0], knee[1] - 0.1, knee[2]], [0, 1, 0], [[0, 0.13], [0.2, 0.12]], 6, (i, j) => (j & 1 ? LN.goldLt : LN.gold), null, LN.goldLt);
    b.lathe([ankle[0], 0.0, ankle[2]], [0, 1, 0], [[0, 0.24], [0.08, 0.21], [0.3, 0.07]], 6, (i) => (i === 0 ? LN.armorDk : LN.armor), null, LN.orange);
  };
  leg(-1, -1); leg(1, 1);
  return b;
}
function buildWalkerGun() {   // dorsal lance cannon (turret-local, barrel along −z) with three capacitor coils
  const b = new GB();
  b.block({ x: 0, y: 0.0, z: 0.1, w: 0.5, d: 0.66, h: 0.26, tw: 0.4, td: 0.5, oz: 0.03, bev: 0.04, top: LN.white, bevS: LN.whiteLt, side: LN.armor, front: LN.armorDk, back: LN.armorDk });
  b.block({ x: 0, y: 0.26, z: 0.3, w: 0.2, d: 0.24, h: 0.06, top: LN.gold, side: LN.goldDk });
  b.lathe([0, 0.14, -0.2], [0, 0, -1], [[0, 0.1], [1.12, 0.07], [1.12, 0.1], [1.24, 0.1], [1.24, 0.05]], 6, (i) => (i === 2 ? LN.whiteLt : LN.armorDk), null, G_MBH, { phase: Math.PI / 6 });
  for (let k = 0; k < 3; k++) b.lathe([0, 0.14, -0.36 - k * 0.24], [0, 0, -1], [[0, 0.13], [0.1, 0.13]], 6, G_MB, null, null, { phase: Math.PI / 6 });
  return b;
}
function createWalker() {
  const { g, pivot, ud } = enemyShell('s5_walker', 1.2, '#c3c8d0');
  ud.ground = true;
  ud.halfExtents = { x: 1.9, z: 1.45 };
  const mat = bodyMat(0.6, 0.28), gunMat = bodyMat(0.55, 0.3);
  const body = new THREE.Mesh(GG('ext:s5:walker', buildWalkerBody), mat);
  pivot.add(body);
  const legGeo = GG('ext:s5:walker.legs', buildWalkerLegs);
  const legA = new THREE.Mesh(legGeo, mat), legB = new THREE.Mesh(legGeo, mat);
  legB.scale.x = -1;
  pivot.add(legA, legB);
  const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, WK_Y + 0.45, 0.12);
  turret.add(new THREE.Mesh(GG('ext:s5:walker.gun', buildWalkerGun), gunMat));
  pivot.add(turret);
  ud.turret = turret;
  const local = [new THREE.Vector3(0, 0.14, -1.46)];
  turret.userData.muzzles = local;
  ud.muzzles = [new THREE.Vector3()];
  let charge = 0, brace = 0, bob = 0;
  const place = () => { body.position.y = bob - brace * 0.3; turret.position.y = WK_Y + 0.45 + body.position.y; };
  /** walk(ph, amp): the two diagonal pairs lift and swing half a cycle apart (a trot) */
  ud.setWalk = (ph, amp) => {
    const s = Math.sin(ph), c = Math.cos(ph);
    legA.position.set(0, Math.max(0, s) * 0.22 * amp, -c * 0.24 * amp);
    legB.position.set(0, Math.max(0, -s) * 0.22 * amp, c * 0.24 * amp);
    bob = Math.abs(c) * 0.05 * amp;
    place();
  };
  /** 0 … 1: the cannon's coils charge (the tell before a sweep) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  /** 0 … 1: crouch to fire (the pod sinks between the legs) */
  ud.setBrace = (v) => { brace = Math.max(0, Math.min(1, v)); place(); };
  ud.setFlash = flashFn([mat, gunMat]);
  ud.update = (dt, t) => {
    syncMuzzles(ud.muzzles, local, turret);
    mat.uEmitScale.value = 0.8 + Math.sin(t * 5) * 0.2;
    gunMat.uEmitScale.value = charge > 0 ? 0.9 + charge * 2.6 * (0.8 + Math.sin(t * 40) * 0.2) : 0.75;
  };
  ud.reset = () => { charge = 0; brace = 0; ud.setWalk(0, 0); turret.rotation.set(0, 0, 0); };
  ud.setWalk(0, 0);
  syncMuzzles(ud.muzzles, local, turret);
  ud.dispose = () => { mat.dispose(); gunMat.dispose(); };
  return g;
}

// =============================================================================
// S5_TURRET — crater turret: hatch collar, two sliding doors, a triple-barrel gun that rises (4 draw calls)
// =============================================================================
const POP_DOWN = -0.62, POP_UP = 0.12;
function buildPopBase() {
  const b = new GB();
  // sloped armoured collar round the pit
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 1.02], [0.08, 0.98], [0.16, 0.8], [0.15, 0.72]], 10,
    (i, j) => (i === 0 ? LN.armorDk : i === 1 ? ((j & 1) ? LN.armorLt : LN.armor) : LN.armorXDk), null, null, { phase: Math.PI / 10 });
  // the pit (seen between the doors)
  b.decal(ngon(10, 0.73, 0, 0.02, 0, Math.PI / 10), LN.black);
  // hazard chevrons on the collar's slope, amber lamps between them
  for (let k = 0; k < 5; k++) {
    const a = (k * TAU) / 5 + 0.3, c = Math.cos(a), s = Math.sin(a), tx = -s, tz = c;
    const P = (r, w) => [c * r + tx * w, 0.094 + (0.98 - r) * 0.444, s * r + tz * w];
    b.quadN(P(0.97, -0.13), P(0.97, 0.13), P(0.84, 0.13), P(0.84, -0.13), [c * 0.4, 1, s * 0.4], (k & 1) ? HAZ_B : HAZ_A);
    const la = a + TAU / 10;
    b.block({ x: Math.cos(la) * 0.9, y: 0.11, z: Math.sin(la) * 0.9, w: 0.08, d: 0.08, h: 0.06, top: G_AMB, side: GL(EM.amber, 0.3) });
  }
  return b;
}
function buildPopDoor() {   // right door (x ≥ 0): a half-disc lid, origin at the pit centre
  const b = new GB();
  const out = [[0, -0.74], [0.28, -0.69], [0.52, -0.52], [0.7, -0.22], [0.7, 0.22], [0.52, 0.52], [0.28, 0.69], [0, 0.74]];
  b.plate(out, 0.12, 0.2, LN.armorLt, LN.armorDk);
  hazardStrip(b, 0.06, -0.62, 0.06, 0.62, 0.202, 0.12, 6, [0, 1, 0], HAZ_A, HAZ_B);
  b.block({ x: 0.42, y: 0.2, z: 0, w: 0.3, d: 0.5, h: 0.05, top: LN.white, side: LN.whiteDk });
  return b;
}
function buildPopGun() {    // squat dome + triple barrels (origin at the dome's base, barrels along −z)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.58], [0.14, 0.56], [0.3, 0.46], [0.42, 0.26], [0.46, 0.0]], 8,
    (i, j) => (i === 0 ? LN.armorDk : i === 1 ? ((j & 1) ? LN.whiteLt : LN.white) : i === 2 ? LN.whiteDk : LN.armor), null, null, { phase: Math.PI / 8 });
  // barrel housing, three barrels with glowing bores, sensor eye, a hazard band over the brow
  b.block({ x: 0, y: 0.1, z: -0.3, w: 0.56, d: 0.36, h: 0.26, tw: 0.46, td: 0.3, bev: 0.03, top: LN.armorLt, bevS: LN.whiteDk, side: LN.armorDk, front: LN.armorXDk });
  for (const [x, y] of [[-0.16, 0.2], [0, 0.28], [0.16, 0.2]]) b.lathe([x, y, -0.46], [0, 0, -1], [[0, 0.06], [0.5, 0.05], [0.5, 0.068], [0.58, 0.068]], 5, (i) => (i === 2 ? LN.orange : LN.armorDk), null, G_MB);
  b.decal([[-0.1, 0.445, 0.0], [0.1, 0.445, 0.0], [0.08, 0.43, 0.12], [-0.08, 0.43, 0.12]], G_RED);
  hazardStrip(b, -0.28, -0.14, 0.28, -0.14, 0.4, 0.08, 4, [0, 1, 0.3], HAZ_A, HAZ_B);
  return b;
}
function createPopTurret() {
  const { g, pivot, ud } = enemyShell('s5_turret', 1.0, '#3d4656');
  ud.ground = true;
  ud.halfExtents = { x: 1.0, z: 1.0 };
  const mat = bodyMat(0.62, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s5:turret.base', buildPopBase), mat));
  const doorGeo = GG('ext:s5:turret.door', buildPopDoor);
  const doorR = new THREE.Mesh(doorGeo, mat), doorL = new THREE.Mesh(doorGeo, mat);
  doorL.scale.x = -1;
  pivot.add(doorR, doorL);
  const turret = new THREE.Group(); turret.name = 'turret';
  turret.add(new THREE.Mesh(GG('ext:s5:turret.gun', buildPopGun), mat));
  pivot.add(turret);
  ud.turret = turret;
  const local = [new THREE.Vector3(-0.16, 0.2, -1.06), new THREE.Vector3(0, 0.28, -1.06), new THREE.Vector3(0.16, 0.2, -1.06)];
  turret.userData.muzzles = local;
  ud.muzzles = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let open = 0, rise = 0;
  /** 0 … 1: the doors slide apart */
  ud.setOpen = (v) => { open = Math.max(0, Math.min(1, v)); doorR.position.x = open * 0.66; doorL.position.x = -open * 0.66; };
  /** 0 … 1: the gun rises out of the pit (hidden below the ground at 0) */
  ud.setRise = (v) => { rise = Math.max(0, Math.min(1, v)); turret.position.y = POP_DOWN + (POP_UP - POP_DOWN) * rise * rise * (3 - 2 * rise); turret.visible = rise > 0.01; };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    syncMuzzles(ud.muzzles, local, turret);
    mat.uEmitScale.value = 0.7 + rise * 0.3 + Math.sin(t * 6) * 0.15;
  };
  /** pooled instances come back hidden: doors shut, gun down */
  ud.reset = () => { ud.setOpen(0); ud.setRise(0); turret.rotation.set(0, 0, 0); };
  ud.setOpen(1); ud.setRise(1);          // the catalogue shows it raised; the stage hides it at spawn
  syncMuzzles(ud.muzzles, local, turret);
  ud.dispose = () => mat.dispose();
  return g;
}

// =============================================================================
// S5_LANDER — lunar lander dropship with a cargo pod (3 draw calls)
// =============================================================================
const LD_POD_Y = -0.98;     // the pod's rest height under the lander
function buildLander() {
  const b = new GB();
  // descent stage: octagonal box in crinkled gold foil
  const oct = (r, y) => ngon(8, r, 0, y, 0, Math.PI / 8);
  b.loft([oct(0.58, -0.4), oct(0.7, -0.3), oct(0.7, 0.04), oct(0.6, 0.12)],
    (i, j) => (i === 1 ? ((j & 1) ? LN.gold : LN.goldDk) : ((j & 1) ? LN.goldLt : LN.gold)), LN.armorDk, LN.armor);
  // descent engine bell (its mouth glows) and the pod clamps
  b.lathe([0, -0.4, 0], [0, -1, 0], [[0, 0.16], [0.12, 0.22], [0.2, 0.27]], 8, (i, j) => (j & 1 ? LN.armorDk : LN.armor), null, G_MB);
  for (const sg of [-1, 1]) b.block({ x: 0.3 * sg, y: -0.72, z: 0, w: 0.06, d: 0.5, h: 0.34, top: LN.armor, side: LN.armorDk });
  // crew cabin: faceted white-and-slate ascent stage with two triangular windows and a red sensor eye
  const c0 = b.n;
  b.block({ x: 0, y: 0.12, z: -0.02, w: 0.9, d: 0.8, h: 0.34, tw: 0.66, td: 0.58, oz: -0.05, bev: 0.05, top: LN.white, bevS: LN.whiteLt, side: LN.armor, front: LN.armorDk, back: LN.armorDk });
  const c1 = b.n;
  for (const sg of [-1, 1]) b.decal([[0.05 * sg, 0.26, -0.4], [0.3 * sg, 0.26, -0.36], [0.08 * sg, 0.42, -0.31]], G_MB, [0, 0.6, -1]);
  b.drape([[[-0.08, -0.28], [0.08, -0.28], [0.08, -0.18], [-0.08, -0.18]]], G_RED, c0, c1, 0.006, 1);
  hazardDrape(b, -0.26, 0.2, 0.26, 0.2, 0.1, 4, HAZ_A, HAZ_B, c0, c1, 0.006, 1);
  // antenna dish on a stub mast
  b.lathe([0.18, 0.46, 0.14], [0, 1, 0], [[0, 0.025], [0.2, 0.02]], 3, LN.armorDk, null, null);
  b.decal(ngon(6, 0.13, 0.18, 0.68, 0.14), LN.whiteLt);
  const f0 = b.n;
  // --- right side (mirrored): two legs with foot pads, RCS quads, the gun pod
  for (const sz of [-1, 1]) {
    const top = [0.46, -0.12, 0.46 * sz], foot = [1.02, -0.8, 1.02 * sz];
    strut(b, top, foot, 0.05, 0.04, 5, (i, j) => (j & 1 ? LN.whiteDk : LN.hub));
    strut(b, [0.62, -0.36, 0.3 * sz], [0.92, -0.7, 0.92 * sz], 0.03, 0.03, 4, LN.armorDk);
    b.lathe([foot[0], foot[1] - 0.04, foot[2]], [0, 1, 0], [[0, 0.16], [0.05, 0.14]], 6, LN.whiteDk, LN.armorDk, LN.white);
    b.block({ x: 0.66, y: 0.02, z: 0.5 * sz, w: 0.1, d: 0.1, h: 0.1, top: LN.orange, side: LN.orangeDk });
  }
  b.lathe([0.7, -0.08, -0.2], [0, 0, -1], [[0, 0.1], [0.12, 0.12], [0.5, 0.1], [0.62, 0.07]], 6,
    (i, j) => (i === 1 ? ((j & 1) ? LN.orange : HAZ_B) : (j === 1 || j === 2) ? LN.armorLt : LN.armor), LN.armorDk, G_MB, { phase: Math.PI / 6 });
  b.block({ x: 0.58, y: -0.06, z: -0.1, w: 0.18, d: 0.2, h: 0.08, top: LN.armor, side: LN.armorDk });
  b.mirrorX(f0);
  return b;
}
function buildLanderPod() {  // cargo capsule along z (origin at its centre)
  const b = new GB();
  b.lathe([0, 0, -0.42], [0, 0, 1], [[0, 0.1], [0.12, 0.22], [0.72, 0.22], [0.84, 0.1]], 6,
    (i, j) => (i === 1 ? ((j === 1 || j === 2) ? LN.goldLt : LN.gold) : (j === 1 || j === 2) ? LN.whiteLt : LN.whiteDk), LN.armorDk, LN.armorDk, { phase: Math.PI / 6 });
  b.lathe([0, 0, -0.1], [0, 0, 1], [[0, 0.225], [0.08, 0.225]], 6, (i, j) => ((j & 1) ? LN.orange : HAZ_B), null, null, { phase: Math.PI / 6 });
  b.block({ x: 0, y: 0.19, z: 0.22, w: 0.06, d: 0.06, h: 0.05, top: G_RED, side: G_RED });
  return b;
}
function createLander() {
  const { g, pivot, ud } = enemyShell('s5_lander', 1.2, '#c4952e');
  ud.halfExtents = { x: 1.1, z: 1.1 };
  const mat = bodyMat(0.55, 0.35);
  pivot.add(new THREE.Mesh(GG('ext:s5:lander', buildLander), mat));
  const pod = new THREE.Mesh(GG('ext:s5:lander.pod', buildLanderPod), mat);
  pod.position.set(0, LD_POD_Y, 0);
  pivot.add(pod);
  const fm = additiveMat();
  const flame = new THREE.Mesh(G('ext:s5:lander.flame', () => buildFlame([[0, 0, 2.2]], FLAME_MOON)), fm);
  flame.rotation.x = Math.PI / 2; flame.position.set(0, -0.62, 0);
  flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.pod = pod;
  ud.muzzles = [new THREE.Vector3(-0.7, -0.08, -0.84), new THREE.Vector3(0.7, -0.08, -0.84)];
  let thrust = 0.6;
  ud.setThrust = (v) => { thrust = Math.max(0, Math.min(1, v)); };
  /** the pod's height under the lander (LD_POD_Y at rest) and whether it is still carried */
  ud.setPod = (y, vis) => { pod.position.y = y; pod.visible = vis; };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    const fl = 1 + Math.sin(t * 43) * 0.08 + Math.sin(t * 27) * 0.05;
    flame.scale.set(0.8 + thrust * 0.4, 0.8 + thrust * 0.4, (0.35 + thrust * 1.1) * fl);
    fm.color.setScalar(0.65 + thrust * 0.45);
    pivot.rotation.z = Math.sin(t * 1.3) * 0.03;
    pivot.rotation.x = Math.sin(t * 1.7) * 0.025;
    mat.uEmitScale.value = 0.8 + Math.sin(t * 6) * 0.2;
  };
  ud.reset = () => { ud.setPod(LD_POD_Y, true); thrust = 0.6; };
  ud.dispose = () => { mat.dispose(); fm.dispose(); };
  return g;
}

// =============================================================================
// S5_SKIMMER — crescent-winged skimmer (2 draw calls)
// =============================================================================
function buildSkimmer() {
  const b = new GB();
  // centre pod: 8-sided, a lens in the nose [z, halfWidth, top, bottom]
  const ring = ([z, w, t, bt]) => [[w * 0.45, t, z], [w, t * 0.35, z], [w, -bt * 0.35, z], [w * 0.5, -bt, z],
    [-w * 0.5, -bt, z], [-w, -bt * 0.35, z], [-w, t * 0.35, z], [-w * 0.45, t, z]];
  const ST = [[-0.74, 0.05, 0.05, 0.04], [-0.6, 0.16, 0.13, 0.08], [-0.2, 0.22, 0.17, 0.1], [0.3, 0.2, 0.15, 0.09], [0.56, 0.12, 0.09, 0.06]];
  b.loft(ST.map(ring), (i, j) => {
    if (i === 0) return G_MBH;
    if (j === 7) return LN.whiteLt;
    if (j === 0 || j === 6) return LN.white;
    if (j === 1 || j === 5) return i === 2 ? LN.orange : LN.armorLt;
    return LN.armorDk;
  }, null, G_MB);
  const f0 = b.n;
  // --- right half (mirrored): the crescent wing sweeping back into a horn, a gold leading edge, an engine
  const w0 = b.n;
  b.wing([{ x: 0.1, y: 0, zl: -0.42, zt: 0.34, t: 0.08 }, { x: 0.52, y: 0.02, zl: -0.28, zt: 0.28, t: 0.06 },
    { x: 0.9, y: 0.04, zl: -0.02, zt: 0.4, t: 0.045 }, { x: 1.1, y: 0.05, zl: 0.34, zt: 0.62, t: 0.03 }, { x: 1.16, y: 0.06, zl: 0.72, zt: 0.84, t: 0.015 }], (i, j) => {
    if (j >= 4) return LN.armorDk;
    if (j === 0) return LN.goldLt;
    if (i === 3) return j === 3 ? HAZ_B : LN.orange;
    return j === 3 ? LN.armor : (i & 1 ? LN.white : LN.whiteLt);
  }, null, LN.orange);
  const w1 = b.n;
  b.drape([[[0.36, -0.1], [0.62, -0.04], [0.62, 0.12], [0.36, 0.08]]], G_MBD, w0, w1, 0.005, 1);
  b.lathe([0.3, -0.02, 0.12], [0, 0, 1], [[0, 0.07], [0.08, 0.09], [0.38, 0.08]], 6, (i, j) => ((j === 1 || j === 2) ? LN.armorLt : LN.armor), LN.armorXDk, G_MB, { phase: Math.PI / 6 });
  b.mirrorX(f0);
  return b;
}
const SKIMMER_NOZZLES = [[-0.3, -0.02, 1.0], [0.3, -0.02, 1.0]];
function createSkimmer() {
  const { g, pivot, ud } = enemyShell('s5_skimmer', 0.8, '#c3c8d0');
  ud.halfExtents = { x: 1.2, z: 0.8 };
  const mat = bodyMat(0.52, 0.28);
  pivot.add(new THREE.Mesh(GG('ext:s5:skimmer', buildSkimmer), mat));
  const fm = additiveMat();
  const flame = new THREE.Mesh(G('ext:s5:skimmer.flame', () => buildFlame(SKIMMER_NOZZLES, FLAME_MOON)), fm);
  flame.position.set(0, 0, 0.5); flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, 0, -0.8)];
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    const fl = 1 + Math.sin(t * 49) * 0.08 + Math.sin(t * 31) * 0.05;
    flame.scale.set(1, 1, 1.2 * fl);
    mat.uEmitScale.value = 0.85 + Math.sin(t * 11) * 0.15;
  };
  ud.dispose = () => { mat.dispose(); fm.dispose(); };
  return g;
}

// =============================================================================
// SELENITE — mid-boss tunnelling machine (5 draw calls, ≤ 2500 triangles)
//   body (the closed / blown-open carapace: two geometries), drill bits L / R (one geometry, the left
//   mirrored; they spin about their own axis), the crystal crown, the crystal heart (rises when open)
// =============================================================================
const SL = {
  DRILL: [1.04, 1.02, -2.2],     // right drill base (left mirrored); the part sits mid-bit
  DRILL_MID: 0.85,               // part origin ahead of the base (the bit's middle)
  CROWN: [0, 1.92, 1.45],        // crystal crown socket; the part sits CROWN_UP above it
  CROWN_UP: 0.6,
  CORE: [0, 1.92, -0.45],        // the heart's well; the part sits CORE_UP above it
  CORE_UP: 0.3,
};
function slRing([z, w, t, bt]) {
  // 8-sided armoured section; edges: 0 right bevel 1 right upper 2 right lower 3 belly 4 left lower 5 left upper 6 left bevel 7 top
  return [[w * 0.55, t, z], [w * 0.92, t - 0.35, z], [w, bt + 0.3, z], [w * 0.7, bt, z], [-w * 0.7, bt, z], [-w, bt + 0.3, z], [-w * 0.92, t - 0.35, z], [-w * 0.55, t, z]];
}
function buildSeleniteBody(open) {
  const b = new GB();
  // carapace: segmented armour along z; plate seams at two sections
  const ST = [[-2.36, 0.9, 1.3, 0.62], [-2.12, 1.36, 1.72, 0.5], [-1.5, 1.56, 1.92, 0.44], [-0.9, 1.6, 1.96, 0.44], [-0.82, 1.52, 1.9, 0.44],
    [0.4, 1.56, 1.94, 0.44], [0.48, 1.62, 1.98, 0.44], [1.9, 1.56, 1.92, 0.44], [2.5, 1.32, 1.7, 0.5], [2.92, 0.86, 1.32, 0.62]];
  const s0 = b.n;
  b.loft(ST.map(slRing), (i, j) => {
    const seam = i === 3 || i === 5;
    if (j === 7) return seam ? LN.armorXDk : (i & 1 ? LN.armor : LN.armorLt);
    if (j === 0 || j === 6) return seam ? LN.armorXDk : i === 1 ? LN.whiteLt : LN.white;
    if (j === 1 || j === 5) return seam ? LN.armorXDk : i === 6 ? LN.orange : LN.armor;
    if (j === 2 || j === 4) return LN.armorDk;
    return LN.armorXDk;
  }, LN.armorDk, LN.armorDk);
  const s1 = b.n;
  hazardDrape(b, 0, 2.2, 0, 2.62, 1.2, 5, HAZ_A, HAZ_B, s0, s1, 0.012, 1);
  // gold-foil side panels, conduits glowing along the shoulders
  for (const sg of [-1, 1]) {
    b.drape([[[0.9 * sg, 0.7], [1.3 * sg, 0.7], [1.3 * sg, 1.7], [0.9 * sg, 1.7]]], LN.gold, s0, s1, 0.01, 1);
    b.drape([[[1.02 * sg, -1.4], [1.14 * sg, -1.4], [1.14 * sg, 0.3], [1.02 * sg, 0.3]]], G_MBD, s0, s1, 0.01, 1);
  }
  // front: the regolith grinder maw between the drills (teeth over an orange glow) and a band of red eyes
  b.block({ x: 0, y: 0.62, z: -2.42, w: 1.1, d: 0.16, h: 0.46, top: LN.armorDk, side: LN.armorXDk, front: GL(rgb(1.0, 0.42, 0.1, 1.6), 0.3) });
  for (let k = 0; k < 5; k++) {
    const x = -0.44 + k * 0.22;
    b.spike([[x - 0.08, 1.06, -2.5], [x + 0.08, 1.06, -2.5], [x, 1.06, -2.4]], [x, 0.72, -2.52], (q) => (q === 2 ? LN.hub : LN.armorDk), null);
  }
  for (const x of [-0.5, -0.25, 0.25, 0.5]) b.drape([[[x - 0.07, -2.1], [x + 0.07, -2.1], [x + 0.07, -1.98], [x - 0.07, -1.98]]], G_RED, s0, s1, 0.012, 1);
  // tracks under the flanks
  for (const sg of [-1, 1]) {
    trackLoft(b, 1.62 * sg, 0.64, 0.74, -2.0, 2.5, 11, TRACK_LN);
    b.block({ x: 1.62 * sg, y: 0.72, z: -1.92, w: 0.76, d: 0.4, h: 0.1, top: LN.orange, side: LN.orangeDk });
  }
  // drill shoulder collars
  for (const sg of [-1, 1]) b.lathe([SL.DRILL[0] * sg, SL.DRILL[1], SL.DRILL[2] + 0.34], [0, 0, -1], [[0, 0.58], [0.26, 0.56], [0.34, 0.46]], 8, (i) => (i === 1 ? LN.armorLt : LN.armorDk), null, LN.armorXDk, { phase: Math.PI / 8 });
  // crown socket, exhaust stacks at the back
  b.lathe([SL.CROWN[0], SL.CROWN[1] - 0.06, SL.CROWN[2]], [0, 1, 0], [[0, 0.72], [0.12, 0.66], [0.16, 0.52]], 8, (i) => (i === 1 ? LN.white : LN.armorDk), null, LN.armorXDk, { phase: Math.PI / 8 });
  for (const sg of [-1, 1]) b.lathe([0.95 * sg, 1.5, 2.55], [0, 1, 0.25], [[0, 0.2], [0.5, 0.17], [0.54, 0.2]], 6, (i) => (i === 1 ? LN.orange : LN.armorDk), null, S(lin('#141619'), scl(EM.emberDim, 0.8)), { phase: Math.PI / 6 });
  // the heart's well: closed = two blast plates meeting on a dim glowing seam; open = the plates blown out
  // to the sides (their dark undersides up) and the well's rim exposed
  const [cx, cy, cz] = SL.CORE;
  for (const sg of [-1, 1]) {
    const f = b.n;
    b.block({ x: 0.36 * sg, y: 0, z: 0, w: 0.72, d: 1.3, h: 0.14, tw: 0.66, td: 1.2, ox: -0.02 * sg, bev: 0.03, top: (sg < 0 ? LN.whiteLt : LN.white), bevS: LN.whiteLt, side: LN.armorDk, bottom: LN.armorXDk });
    hazardStrip(b, 0.36 * sg - 0.24, -0.52, 0.36 * sg + 0.24, -0.52, 0.142, 0.12, 4, [0, 1, 0], HAZ_A, HAZ_B);
    const m = new THREE.Matrix4().makeTranslation(cx, cy + 0.02, cz);
    if (open) m.multiply(new THREE.Matrix4().makeTranslation(0.72 * sg, 0, 0)).multiply(new THREE.Matrix4().makeRotationZ(-sg * 128 * DEG)).multiply(new THREE.Matrix4().makeTranslation(-0.72 * sg, 0, 0));
    b.xform(f, m);
  }
  if (open) b.lathe([cx, cy - 0.04, cz], [0, 1, 0], [[0, 0.76], [0.08, 0.7], [0.1, 0.56]], 10, (i, j) => (i === 1 ? ((j & 1) ? G_MBD : LN.armorDk) : LN.armorXDk), null, LN.black);
  else b.decal([[cx - 0.035, cy + 0.165, cz - 0.6], [cx + 0.035, cy + 0.165, cz - 0.6], [cx + 0.035, cy + 0.165, cz + 0.6], [cx - 0.035, cy + 0.165, cz + 0.6]], G_MBD);
  return b;
}
function buildSeleniteDrill() {   // right drill bit (origin at its base, the bit along −z)
  const b = new GB();
  const prof = [[0, 0.44], [0.12, 0.5], [0.5, 0.44], [0.95, 0.31], [1.4, 0.16], [1.82, 0.02]];
  b.lathe([0, 0, 0], [0, 0, -1], prof, 8, (i, j) => (((i + j) % 4 === 0) ? LN.orange : ((i + j) % 4 === 2) ? LN.armorDk : (j & 1 ? LN.hub : LN.whiteDk)), LN.armorDk, null, { phase: Math.PI / 8 });
  // cutter teeth on three flutes, a glowing ring at the base
  for (let k = 0; k < 3; k++) {
    const a = (k * TAU) / 3, c = Math.cos(a), s = Math.sin(a);
    for (const z of [-0.45, -0.95]) {
      const r = z > -0.6 ? 0.45 : 0.31;
      b.spike([[c * r * 0.9 - s * 0.06, s * r * 0.9 + c * 0.06, z + 0.1], [c * r * 0.9 + s * 0.06, s * r * 0.9 - c * 0.06, z + 0.1], [c * r * 0.9, s * r * 0.9, z - 0.12]],
        [c * (r + 0.2), s * (r + 0.2), z - 0.02], (q) => (q === 0 ? LN.whiteLt : LN.hub), null);
    }
  }
  b.lathe([0, 0, 0.06], [0, 0, -1], [[0, 0.3], [0.08, 0.3]], 8, G_MB, null, null);
  return b;
}
function buildSeleniteCrown() {   // crystal cluster (origin on the socket)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.5], [0.14, 0.44], [0.2, 0.3]], 8, (i) => (i === 0 ? LN.armor : LN.armorDk), null, LN.armorXDk, { phase: Math.PI / 8 });
  crystal(b, [0, 0.12, 0], [0, 1, 0.08], 1.45, 0.24, 1.3, 0.55);
  const T = [[0.36, 0.1, 0.62, 0.95, 0.17], [-0.34, 0.14, 0.58, 1.0, 0.18], [0.5, -0.3, 0.52, 0.85, 0.15], [-0.46, -0.34, 0.5, 0.8, 0.15], [0.02, -0.46, 0.55, 0.9, 0.16], [0.08, 0.42, 0.6, 0.75, 0.14]];
  T.forEach(([x, z, up, len, r], k) => crystal(b, [x * 0.5, 0.1, z * 0.5], [x, up, z], len, r, 2.7 + k * 1.9, 0.45));
  return b;
}
function buildSeleniteHeart(dead) { return gemGB(0.46, 1.35, 0.0, 5.3, dead); }
function createSelenite() {
  const { g, pivot, ud } = enemyShell('selenite', 2.4, '#3d4656');
  ud.ground = true; ud.midboss = true;
  ud.halfExtents = { x: 2.0, z: 4.2 };
  const hullMat = bodyMat(0.64, 0.28);
  const closedGeo = GG('ext:s5:selenite.body', () => buildSeleniteBody(false));
  const openGeo = GG('ext:s5:selenite.bodyOpen', () => buildSeleniteBody(true));
  const body = new THREE.Mesh(closedGeo, hullMat); body.name = 'body';
  pivot.add(body);
  // drills (mirrored): the part is the spinning bit, its origin mid-bit
  const drillKeep = { keep: (x, y, z) => z + 0.62, crumple: 0.12, seed: 51, dir: [0, 0, -1], shards: 8, shardSize: 0.22, band: 0.4 };
  const drills = [];
  const mkDrill = (sg) => {
    const m = bodyMat(0.5, 0.4);
    const intact = GG('ext:s5:selenite.drill', buildSeleniteDrill);
    const wreck = wreckGeo('ext:s5:selenite.drill', buildSeleniteDrill, drillKeep);
    const mesh = new THREE.Mesh(intact, m);
    mesh.position.z = SL.DRILL_MID;
    if (sg < 0) mesh.scale.x = -1;
    const part = makePart(sg < 0 ? 'drillL' : 'drillR', 0.75, [{ mesh, intact, wreck, sag: [0.25, -0.2, 0.1 * sg] }], [new THREE.Vector3(0, 0, SL.DRILL_MID - 1.95)]);
    part.position.set(SL.DRILL[0] * sg, SL.DRILL[1], SL.DRILL[2] - SL.DRILL_MID);
    pivot.add(part);
    drills.push(mesh);
    return part;
  };
  const drillL = mkDrill(-1), drillR = mkDrill(1);
  // crown
  const crownMat = bodyMat(0.4, 0.2);
  const crownI = GG('ext:s5:selenite.crown', buildSeleniteCrown);
  const crownW = wreckGeo('ext:s5:selenite.crown', buildSeleniteCrown, { keep: (x, y) => 0.36 - y, crumple: 0.08, seed: 53, dir: [0, 1, 0], shards: 12, shardSize: 0.2, band: 0.3 });
  const crownMesh = new THREE.Mesh(crownI, crownMat);
  crownMesh.position.y = -SL.CROWN_UP;
  const crown = makePart('crown', 0.9, [{ mesh: crownMesh, intact: crownI, wreck: crownW }], [new THREE.Vector3(0, 1.3 - SL.CROWN_UP, 0)]);
  crown.position.set(SL.CROWN[0], SL.CROWN[1] + SL.CROWN_UP, SL.CROWN[2]);
  pivot.add(crown);
  // core: the heart rises out of its well when the plates blow (setOpen)
  const heartMat = bodyMat(0.35, 0.1);
  const heartI = GG('ext:s5:selenite.heart', () => buildSeleniteHeart(false)), heartD = GG('ext:s5:selenite.heartDead', () => buildSeleniteHeart(true));
  const heart = new THREE.Mesh(heartI, heartMat);
  let dead = false;
  const core = makePart('core', 0.8, [{ mesh: heart, intact: heartI, wreck: heartD }], [new THREE.Vector3(0, 0, 0)], { onDestroyed: (d) => { dead = d; } });
  core.position.set(SL.CORE[0], SL.CORE[1] + SL.CORE_UP, SL.CORE[2]);
  pivot.add(core);
  let open = 0;
  const spinV = [0, 0];
  core.userData.setOpen = (v) => {
    open = Math.max(0, Math.min(1, v)); core.userData.open = open;
    body.geometry = open > 0.2 ? openGeo : closedGeo;
    heart.position.y = -1.2 + 1.25 * open;
  };
  ud.parts = { drillL, drillR, crown, core };
  const mats = [hullMat, ...drillL.userData.materials, ...drillR.userData.materials, crownMat, heartMat];
  ud.setFlash = flashFn(mats);
  ud.muzzles = [new THREE.Vector3(-1.04, 1.02, -4.15), new THREE.Vector3(1.04, 1.02, -4.15), new THREE.Vector3(0, 3.2, 1.45)];
  /** drill k (0 left, 1 right) spins at v (0 … 1: idle … full: the tell before a volley) */
  ud.setSpin = (k, v) => { spinV[k] = v; };
  let rumble = 0;
  /** 0 … 1: the machine shudders (burrowing, erupting) */
  ud.setRumble = (v) => { rumble = v; };
  ud.reset = () => { spinV[0] = spinV[1] = 0; rumble = 0; core.userData.setOpen(0); for (const d of drills) d.rotation.set(0, 0, 0); pivot.position.set(0, 0, 0); };
  ud.update = (dt, t) => {
    for (let k = 0; k < 2; k++) {
      const pt = k ? drillR : drillL;
      if (!pt.userData.destroyed) drills[k].rotation.z += dt * (1.5 + spinV[k] * 22) * (k ? 1 : -1);
    }
    pivot.position.x = rumble ? Math.sin(t * 61) * 0.04 * rumble : 0;
    const p = dead ? 0.22 + Math.sin(t * 17) * 0.06 : 0.8 + Math.sin(t * 4) * 0.2;
    for (let i = 0; i < mats.length; i++) mats[i].uEmitScale.value = p;
    if (!dead) heartMat.uEmitScale.value = (0.7 + open * 0.6) * (1 + Math.sin(t * 7) * 0.15);
    if (!crown.userData.destroyed) crownMat.uEmitScale.value = 0.85 + Math.sin(t * 2.3) * 0.25;
  };
  ud.dispose = () => { for (const m of mats) m.dispose(); };
  core.userData.setOpen(0);
  return g;
}

// =============================================================================
// SELENE — boss, the lunar fortress (16 draw calls + the beam, ≤ 8000 triangles)
//   pivot (the hover) → the two crescent halves (one geometry, the left mirrored; each carries half the
//   citadel plinth, its dome shutter, its horn cannon, two batteries and a tide emitter), the solar
//   mirror + its beam, the crystal heart, the lift-jet flames.
//   The crescent: an outer circle R 6.3 round the origin cut by a circle R 5.2 round (0, +2.3): a thick
//   back (up-screen, the direction of travel), horns trailing toward the jet, tips at (±4.96, +3.9).
// =============================================================================
const SE_RO = 6.3, SE_CI = 2.3, SE_RI = 5.2, SE_TIP = 128.2 * DEG, SE_Y0 = 0.3;
/** the crescent's inner edge along the spoke at angle th (from −z toward +x) */
function seRin(th) { const c = Math.cos(th); return -SE_CI * c + Math.sqrt(SE_RI * SE_RI - SE_CI * SE_CI + SE_CI * SE_CI * c * c); }
/** ridge height along the crescent */
function seH(th) { const u = th / SE_TIP; return 0.62 + 1.32 * Math.pow(Math.max(0, 1 - u * u), 0.7); }
/** a point on the crescent: angle th, radius r, height y */
const seP = (th, r, y) => [Math.sin(th) * r, y, -Math.cos(th) * r];
/** radius halfway across the crescent at th */
const seMid = (th) => (SE_RO + seRin(th)) / 2;
/** the crescent's surface height halfway across (just behind the ridge) */
const seTop = (th) => seH(th) * 0.965;
const SE = {
  PLINTH_Z: 0.2, PLINTH_R: 2.45, PLINTH_Y: 1.05, DOME_R: 1.86,
  HORN_TH: 94 * DEG, BAT_TH: [-68 * DEG, -40 * DEG, 40 * DEG, 68 * DEG], BAY_TH: 22 * DEG,
  HOVER: 0.85,
};
// the profile across the crescent: [u (0 outer … 1 inner), k (fraction of the ridge height), lip]; lip
// points sit at the skirt height, u = 0 / 1 at the belly
const SE_PROF = [[0, 0, 0], [0.03, 0, 1], [0.18, 0.74, 0], [0.44, 1, 0], [0.8, 0.8, 0], [0.97, 0, 1], [1, 0, 0]];
function seRing(th) {
  const ri = seRin(th), H = seH(th), lip = Math.min(0.62, SE_Y0 + (H - SE_Y0) * 0.45);
  return SE_PROF.map(([u, k, isLip]) => seP(th, SE_RO + (ri - SE_RO) * u, isLip ? lip : SE_Y0 + (H - SE_Y0) * k));
}
function buildSeleneHalf() {   // the right half (x ≥ 0) of the crescent + half the citadel plinth
  const b = new GB();
  // --- the crescent: stations from the back (th = 0) round to the horn tip, denser toward the tip
  const N = 20, TH = [];
  for (let i = 0; i <= N; i++) { const u = i / N; TH.push(SE_TIP * 0.985 * (1 - Math.pow(1 - u, 1.35))); }
  const c0 = b.n;
  b.loft(TH.map(seRing), (i, j) => {
    const plate = (i >> 1) & 1, seam = i % 3 === 2;
    if (j === 6) return LN.armorXDk;                                           // belly
    if (j === 0) return LN.gold;                                               // outer skirt: gold foil
    if (j === 1) return seam ? LN.armorDk : plate ? LN.white : LN.whiteDk;     // outer wall: white thermal plating
    if (j === 2) return seam ? LN.armorDk : plate ? LN.armorLt : LN.armor;     // ridge (outer slope)
    if (j === 3) return seam ? LN.armorXDk : plate ? LN.armor : LN.armorDk;    // inner slope
    if (j === 4) return i > N - 4 ? LN.orange : LN.armorDk;                    // inner wall (hazard near the horn)
    return LN.goldDk;
  }, LN.armorXDk, LN.armorDk);
  const c1 = b.n;
  const q = (t, u) => { const r = SE_RO + (seRin(t) - SE_RO) * u; return [Math.sin(t) * r, -Math.cos(t) * r]; };
  // energy conduits along the inner slope, running lights along the ridge
  for (let i = 1; i < N - 2; i += 2) b.drape([[q(TH[i], 0.56), q(TH[i + 1], 0.56), q(TH[i + 1], 0.62), q(TH[i], 0.62)]], G_MBD, c0, c1, 0.012, 2);
  for (let i = 1; i < N; i += 3) {
    const t = TH[i], H = seH(t), p = seP(t, SE_RO + (seRin(t) - SE_RO) * 0.44, 0);
    b.block({ x: p[0], y: H - 0.02, z: p[2], w: 0.14, d: 0.14, h: 0.08, top: i % 2 ? G_MB : G_AMB, side: G_MBD });
  }
  // radiator fins on the thick back (white blades standing out of the outer wall)
  for (let k = 0; k < 4; k++) {
    const t = 0.12 + k * 0.14, p = seP(t, SE_RO - 0.2, 0.46);
    const f = b.n;
    b.block({ x: 0, y: 0, z: 0, w: 0.06, d: 0.8, h: 0.9, td: 0.5, top: LN.whiteLt, side: LN.white });
    b.xform(f, M(p[0], p[1], p[2], 0, Math.PI - t, 0));
  }
  // hazard stripes across the horn, gold-foil patches on the ridge
  { const t = SE_TIP * 0.84; hazardDrape(b, ...q(t, 0.96), ...q(t, 0.04), 0.46, 4, HAZ_A, HAZ_B, c0, c1, 0.012, 1); }
  for (const t of [0.34, 0.86]) b.drape([[q(t - 0.05, 0.22), q(t + 0.05, 0.22), q(t + 0.05, 0.36), q(t - 0.05, 0.36)]], LN.gold, c0, c1, 0.012, 1);
  // weapon sockets: the horn barbette, the battery rings, the tide emitter's well
  const hp = seP(SE.HORN_TH, seMid(SE.HORN_TH), 0);
  b.lathe([hp[0], seTop(SE.HORN_TH), hp[2]], [0, 1, 0], [[0, 0.95], [0.16, 0.9], [0.22, 0.74]], 12, (i, j) => (i === 1 ? ((j & 1) ? LN.whiteLt : LN.armorLt) : LN.armorDk), null, LN.armorXDk);
  for (const th of SE.BAT_TH) {
    if (th < 0) continue;
    const bp = seP(th, seMid(th), 0);
    b.lathe([bp[0], seTop(th), bp[2]], [0, 1, 0], [[0, 0.62], [0.1, 0.58], [0.14, 0.48]], 10, (i) => (i === 1 ? LN.armorLt : LN.armorDk), null, LN.armorXDk);
  }
  { const bp = seP(SE.BAY_TH, seMid(SE.BAY_TH) + 0.1, 0);
    b.lathe([bp[0], seTop(SE.BAY_TH), bp[2]], [0, 1, 0], [[0, 0.8], [0.1, 0.76]], 8, LN.armorDk, null, LN.armorXDk, { phase: Math.PI / 8 }); }
  // --- half the citadel plinth (a hexagon round (0, PLINTH_Z)); its seam face at x = 0 is dark
  const pz = SE.PLINTH_Z, R = SE.PLINTH_R, Y = SE.PLINTH_Y;
  const out = [[0, pz - R * 0.866], [R * 0.5, pz - R * 0.866], [R, pz], [R * 0.5, pz + R * 0.866], [0, pz + R * 0.866]];
  const p0 = b.n;
  b.plate(out, SE_Y0, Y, LN.armor, (i) => (i === 4 ? LN.armorXDk : i === 1 || i === 2 ? LN.whiteDk : LN.armorLt), LN.armorXDk);
  const p1 = b.n;
  // plinth top: gold plating, the dome's base ring, amber lamps, a hazard band at the front
  b.drape([[[0.2, pz - 1.9], [1.05, pz - 1.9], [1.05, pz - 1.66], [0.2, pz - 1.66]], [[0.2, pz + 1.66], [1.05, pz + 1.66], [1.05, pz + 1.9], [0.2, pz + 1.9]]], LN.gold, p0, p1, 0.006, 1);
  arcRing(b, 0, pz, SE.DOME_R - 0.02, SE.DOME_R + 0.22, Y + 0.012, -Math.PI / 2, Math.PI / 2, 8, (k) => ((k & 1) ? LN.armorLt : LN.white));
  hazardDrape(b, 0.05, pz + 2.02, 1.02, pz + 2.02, 0.16, 4, HAZ_A, HAZ_B, p0, p1, 0.008, 1);
  for (const [x, z] of [[2.12, pz - 0.45], [2.12, pz + 0.45], [1.2, pz - 1.95]]) b.block({ x, y: Y, z, w: 0.12, d: 0.12, h: 0.07, top: G_AMB, side: GL(EM.amber, 0.3) });
  // the dome's floor (seen once it opens): dark, a glowing ring round the heart's well
  arcRing(b, 0, pz, 0.64, SE.DOME_R - 0.02, Y + 0.006, -Math.PI / 2, Math.PI / 2, 6, LN.armorXDk);
  arcRing(b, 0, pz, 0.52, 0.64, Y + 0.008, -Math.PI / 2, Math.PI / 2, 6, G_MB);
  // bridges from the plinth to the crescent: the spine at th = 0 (its right half) and one at th = 58°
  b.block({ x: 0.3, y: 0.55, z: pz - R * 0.866 - 0.45, w: 0.6, d: 1.3, h: 0.35, top: LN.armorLt, side: LN.armorDk });
  { const t = 58 * DEG, a = seP(t, R * 0.9, 0), c = seP(t, seRin(t) + 0.2, 0), mx = (a[0] + c[0]) / 2, mz = (a[2] + c[2]) / 2, L = Math.hypot(c[0] - a[0], c[2] - a[2]);
    const f = b.n;
    b.block({ x: 0, y: 0.5, z: 0, w: 0.7, d: L + 0.4, h: 0.4, bev: 0.04, top: LN.armor, bevS: LN.armorLt, side: LN.armorDk });
    hazardStrip(b, -0.3, -L * 0.25, 0.3, -L * 0.25, 0.905, 0.2, 4, [0, 1, 0], HAZ_A, HAZ_B);
    b.xform(f, M(mx, 0, mz, 0, Math.atan2(c[0] - a[0], c[2] - a[2]), 0)); }
  return b;
}
function buildSeleneShutter() {  // the right half of the dome (x ≥ 0), a quarter-sphere shell; origin at the dome's centre
  const b = new GB();
  const R = SE.DOME_R, NA = 6, NE = 4, RI = R * 0.94;
  const P = (a, e, r) => [Math.cos(e) * Math.cos(a) * r, Math.sin(e) * r, Math.cos(e) * Math.sin(a) * r];
  for (let i = 0; i < NA; i++) for (let k = 0; k < NE; k++) {
    const a0 = -Math.PI / 2 + (Math.PI * i) / NA, a1 = -Math.PI / 2 + (Math.PI * (i + 1)) / NA;
    const e0 = ((Math.PI / 2) * k) / NE, e1 = ((Math.PI / 2) * (k + 1)) / NE;
    const st = k === NE - 1 ? LN.whiteLt : k === 0 ? LN.armorLt : ((i + k) & 1) ? LN.white : LN.whiteDk;
    const dir = P((a0 + a1) / 2, (e0 + e1) / 2, 1);
    b.quadN(P(a0, e0, R), P(a1, e0, R), P(a1, e1, R), P(a0, e1, R), dir, st);
    b.quadN(P(a0, e0, RI), P(a1, e0, RI), P(a1, e1, RI), P(a0, e1, RI), scl(dir, -1), LN.armorXDk);   // inside: seen when it swings open
  }
  // the lip along the seam (x = 0, both ends of the arc), a gold band round the base, an orange stripe
  for (const a of [-Math.PI / 2, Math.PI / 2]) for (let k = 0; k < NE; k++) {
    const e0 = ((Math.PI / 2) * k) / NE, e1 = ((Math.PI / 2) * (k + 1)) / NE;
    b.quadN(P(a, e0, RI), P(a, e0, R), P(a, e1, R), P(a, e1, RI), [-1, 0, 0], LN.armorDk);
  }
  for (let i = 0; i < NA; i++) {
    const a0 = -Math.PI / 2 + (Math.PI * i) / NA, a1 = -Math.PI / 2 + (Math.PI * (i + 1)) / NA;
    b.quadN(P(a0, 0.02, R + 0.012), P(a1, 0.02, R + 0.012), P(a1, 0.22, R + 0.012), P(a0, 0.22, R + 0.012), P((a0 + a1) / 2, 0.1, 1), LN.gold);
  }
  b.quadN(P(-0.26, 1.2, R + 0.012), P(0.26, 1.2, R + 0.012), P(0.26, 1.36, R + 0.012), P(-0.26, 1.36, R + 0.012), P(0, 1.28, 1), LN.orange);
  return b;
}
function buildSeleneHorn() {   // horn cannon (origin on the barbette, barrels along −z)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.8], [0.12, 0.76]], 10, LN.armorDk, null, null);
  const h0 = b.n;
  b.block({ x: 0, y: 0.1, z: 0.22, w: 1.36, d: 1.56, h: 0.58, tw: 1.08, td: 1.18, oz: 0.12, bev: 0.08, top: LN.white, bevS: LN.whiteLt, side: LN.armor, front: LN.armorDk, back: LN.armorDk });
  const h1 = b.n;
  hazardDrape(b, -0.46, -0.28, 0.46, -0.28, 0.2, 6, HAZ_A, HAZ_B, h0, h1, 0.006, 1);
  b.drape([[[-0.28, 0.08], [0.28, 0.08], [0.22, 0.28], [-0.22, 0.28]]], G_RED, h0, h1, 0.006, 1);
  b.drape([[[-0.46, 0.48], [0.46, 0.48], [0.46, 0.7], [-0.46, 0.7]]], LN.gold, h0, h1, 0.006, 1);
  // twin barrels with moonlit muzzle rings
  b.block({ x: 0, y: 0.16, z: -0.56, w: 0.84, d: 0.34, h: 0.42, tw: 0.74, td: 0.26, bev: 0.03, top: LN.armorLt, bevS: LN.whiteDk, side: LN.armorDk, front: LN.armorXDk });
  for (const sg of [-1, 1]) {
    b.lathe([0.22 * sg, 0.38, -0.7], [0, 0, -1], [[0, 0.14], [1.3, 0.1], [1.3, 0.15], [1.54, 0.15], [1.56, 0.08]], 7,
      (i, j) => (i === 2 ? (j & 1 ? LN.orange : HAZ_B) : (j === 1 || j === 2 || j === 3) ? LN.armorLt : LN.armorDk), null, G_MB, { phase: Math.PI / 7 });
    b.lathe([0.22 * sg, 0.38, -2.08], [0, 0, -1], [[0, 0.16], [0.06, 0.16]], 7, G_MB, null, null);
  }
  return b;
}
function buildSeleneBattery() {  // ridge battery (origin on its ring, barrels along −z)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.56], [0.1, 0.54], [0.28, 0.4], [0.36, 0.2], [0.38, 0]], 8,
    (i, j) => (i === 0 ? LN.armorDk : i === 1 ? ((j & 1) ? LN.whiteLt : LN.white) : LN.whiteDk), null, null, { phase: Math.PI / 8 });
  for (const x of [-0.13, 0.13]) b.lathe([x, 0.22, -0.3], [0, 0, -1], [[0, 0.07], [0.6, 0.055], [0.6, 0.075], [0.7, 0.075]], 5, (i) => (i === 2 ? LN.orange : LN.armorDk), null, G_MB);
  b.decal([[-0.12, 0.372, -0.12], [0.12, 0.372, -0.12], [0.1, 0.376, 0.02], [-0.1, 0.376, 0.02]], G_RED);
  return b;
}
function buildSeleneBay(open) {  // tide emitter (faces −z): an armoured box; open = the lid slid back, the grille lit
  const b = new GB();
  b.block({ x: 0, y: 0, z: 0, w: 1.3, d: 1.1, h: 0.46, tw: 1.18, td: 0.96, bev: 0.05, top: LN.armor, bevS: LN.armorLt, side: LN.armorDk, front: LN.armorXDk });
  const grille = open ? G_MB : LN.armorXDk;
  for (let k = 0; k < 5; k++) b.block({ x: -0.44 + k * 0.22, y: 0.1, z: -0.56, w: 0.12, d: 0.08, h: 0.26, top: grille, side: grille, front: open ? G_MBH : LN.armorDk });
  const f = b.n;
  b.block({ x: 0, y: 0.46, z: 0, w: 1.2, d: 0.98, h: 0.1, bev: 0.03, top: LN.white, bevS: LN.whiteLt, side: LN.whiteDk });
  hazardStrip(b, -0.5, -0.38, 0.5, -0.38, 0.562, 0.14, 6, [0, 1, 0], HAZ_A, HAZ_B);
  if (open) b.xform(f, M(0, -0.06, 0.78));
  return b;
}
const SE_MIR_TILT = 52 * DEG, SE_MIR_Y = 0.95, SE_FOCUS_D = 1.12;
function buildSeleneMirror() {   // the solar mirror (origin on the gimbal; the dish faces −z, tilted up toward the sky)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.5], [0.3, 0.42], [0.36, 0.3]], 8, (i) => (i === 1 ? LN.armor : LN.armorDk), null, LN.armorDk);
  for (const sg of [-1, 1]) b.block({ x: 0.9 * sg, y: 0.2, z: 0, w: 0.16, d: 0.34, h: 0.8, tw: 0.12, td: 0.24, top: LN.armorLt, side: LN.armor });
  const f = b.n;
  // the dish's back shell (a shallow bowl behind +z) and the segmented mirror face (rings of cells facing −z)
  b.lathe([0, 0, 0], [0, 0, 1], [[-0.06, 1.42], [0.18, 1.2], [0.38, 0.7], [0.46, 0.2]], 10, (i, j) => (i === 0 ? LN.goldDk : (j & 1) ? LN.armorDk : LN.armor), null, LN.armorXDk, { phase: Math.PI / 10 });
  const RS = [0.22, 0.62, 1.02, 1.42];
  for (let r = 0; r < RS.length - 1; r++) {
    const n = 6 + r * 4;
    for (let k = 0; k < n; k++) {
      const a0 = (k * TAU) / n, a1 = ((k + 1) * TAU) / n;
      const P = (rr, a) => [Math.cos(a) * rr, Math.sin(a) * rr, -0.07 + rr * rr * 0.04];
      const st = ((k + r) % 3 === 0) ? GL(SUN, 0.5) : ((k + r) % 3 === 1) ? GL(scl(SUN, 0.5), 0.45) : LN.goldLt;
      b.quadN(P(RS[r] + 0.03, a0 + 0.03), P(RS[r + 1] - 0.03, a0 + 0.03), P(RS[r + 1] - 0.03, a1 - 0.03), P(RS[r] + 0.03, a1 - 0.03), [0, 0, -1], st);
    }
  }
  b.decal(ngon(6, 0.2, 0, 0, 0).map(([x, , z]) => [x, z, -0.08]), GL(SUN, 0.5), [0, 0, -1]);
  // three struts to the focus, the emitter at the focus
  for (let k = 0; k < 3; k++) { const a = Math.PI / 2 + (k * TAU) / 3; strut(b, [Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0.0], [0, 0, -SE_FOCUS_D + 0.1], 0.05, 0.04, 4, LN.armorLt); }
  b.lathe([0, 0, -SE_FOCUS_D + 0.14], [0, 0, -1], [[0, 0.16], [0.18, 0.2], [0.3, 0.08]], 6, (i) => (i === 0 ? LN.armorDk : GL(SUN, 0.5)), null, G_MBH);
  b.xform(f, M(0, SE_MIR_Y, 0, SE_MIR_TILT, 0, 0));
  return b;
}
// the emitter at the dish's focus (mirror-part local)
const SE_FOCUS = new THREE.Vector3(0, SE_MIR_Y + Math.sin(SE_MIR_TILT) * SE_FOCUS_D, -Math.cos(SE_MIR_TILT) * SE_FOCUS_D);
function buildSeleneHeart(dead) {
  const b = gemGB(0.62, 1.3, 0.0, 9.1, dead);
  if (!dead) for (let k = 0; k < 5; k++) { const a = (k * TAU) / 5 + 0.4; crystal(b, [Math.cos(a) * 0.4, -0.5, Math.sin(a) * 0.4], [Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6], 0.9, 0.16, 7 + k); }
  return b;
}
const SE_LIFT = [[-3.2, -3.6], [3.2, -3.6], [-5.0, -0.4], [5.0, -0.4], [-1.3, 0.2], [1.3, 0.2]];
function createSelene() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss:selene';
  ud.radius = 5.5;
  ud.ground = true;
  ud.debrisColor = new THREE.Color('#5c677b');
  ud.halfExtents = { x: 6.4, z: 5.2 };
  const hullMat = bodyMat(0.62, 0.3);
  const allMats = [hullMat];
  const partMat = (r = 0.6, m = 0.3) => { const x = bodyMat(r, m); allMats.push(x); return x; };
  // the crescent halves (the break swings them apart about the spine)
  const halfGeo = GG('ext:s5:selene.half', buildSeleneHalf);
  const halfR = new THREE.Group(), halfL = new THREE.Group();
  const meshR = new THREE.Mesh(halfGeo, hullMat), meshL = new THREE.Mesh(halfGeo, hullMat);
  meshL.scale.x = -1;
  halfR.add(meshR); halfL.add(meshL);
  pivot.add(halfR, halfL);
  // dome shutters (hinged at the base ring's outer edges)
  const pz = SE.PLINTH_Z, Y = SE.PLINTH_Y;
  const shutGeo = GG('ext:s5:selene.shutter', buildSeleneShutter);
  const hingeR = new THREE.Object3D(), hingeL = new THREE.Object3D();
  hingeR.position.set(SE.DOME_R, Y, pz); hingeL.position.set(-SE.DOME_R, Y, pz);
  const shR = new THREE.Mesh(shutGeo, hullMat), shL = new THREE.Mesh(shutGeo, hullMat);
  shR.position.set(-SE.DOME_R, 0, 0); shL.position.set(SE.DOME_R, 0, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  halfR.add(hingeR); halfL.add(hingeL);
  // horn cannons: they start facing the jet (the AI turns them)
  const hornKeep = { keep: (x, y) => 0.42 - y, crumple: 0.14, seed: 61, dir: [0, 1, 0], shards: 14, shardSize: 0.34, band: 0.4 };
  const hornI = GG('ext:s5:selene.horn', buildSeleneHorn), hornW = wreckGeo('ext:s5:selene.horn', buildSeleneHorn, hornKeep);
  const hp = seP(SE.HORN_TH, seMid(SE.HORN_TH), seTop(SE.HORN_TH) + 0.2);
  const horns = [-1, 1].map((sg, k) => {
    const mesh = new THREE.Mesh(hornI, partMat());
    const part = makePart('horn' + k, 1.15, [{ mesh, intact: hornI, wreck: hornW, sag: [0.1, -0.2, 0.08 * sg] }],
      [new THREE.Vector3(-0.22, 0.38, -2.2), new THREE.Vector3(0.22, 0.38, -2.2)]);
    part.position.set(hp[0] * sg, hp[1], hp[2]);
    part.rotation.y = Math.PI;
    (sg < 0 ? halfL : halfR).add(part);
    return part;
  });
  // ridge batteries (k: 0 left outer, 1 left inner, 2 right inner, 3 right outer)
  const batI = GG('ext:s5:selene.battery', buildSeleneBattery);
  const batW = wreckGeo('ext:s5:selene.battery', buildSeleneBattery, { keep: (x, y) => 0.18 - y, crumple: 0.1, seed: 63, dir: [0, 1, 0], shards: 8, shardSize: 0.22, band: 0.3 });
  const batteries = SE.BAT_TH.map((th, k) => {
    const p = seP(Math.abs(th), seMid(th), seTop(th) + 0.12);
    const part = makePart('battery' + k, 0.72, [{ mesh: new THREE.Mesh(batI, partMat()), intact: batI, wreck: batW, sag: [0.1, -0.08, 0.1] }],
      [new THREE.Vector3(-0.13, 0.22, -1.02), new THREE.Vector3(0.13, 0.22, -1.02)]);
    part.position.set(th < 0 ? -p[0] : p[0], p[1], p[2]);
    part.rotation.y = Math.PI;
    (th < 0 ? halfL : halfR).add(part);
    return part;
  });
  // tide emitters in the crescent's back, facing the jet
  const bayC = GG('ext:s5:selene.bay', () => buildSeleneBay(false)), bayO = GG('ext:s5:selene.bayOpen', () => buildSeleneBay(true));
  const bayW = wreckGeo('ext:s5:selene.bay', () => buildSeleneBay(false), { keep: () => 1, crumple: 0.12, seed: 65, dir: [0, 1, 0], shards: 10, shardSize: 0.26, band: 0.3 });
  const bays = [-1, 1].map((sg, k) => {
    const mesh = new THREE.Mesh(bayC, partMat());
    const part = makePart('bay' + k, 0.85, [{ mesh, intact: bayC, wreck: bayW }], [new THREE.Vector3(0, 0.24, -0.72)]);
    const p = seP(SE.BAY_TH, seMid(SE.BAY_TH) + 0.1, seTop(SE.BAY_TH) + 0.04);
    part.position.set(p[0] * sg, p[1], p[2]);
    part.rotation.y = Math.PI - SE.BAY_TH * sg * 0.6;
    part.userData.open = 0;
    part.userData.setOpen = (v) => { part.userData.open = v; if (!part.userData.destroyed) mesh.geometry = v > 0.5 ? bayO : bayC; };
    const sd = part.userData.setDestroyed;
    part.userData.setDestroyed = (d) => { sd(d); if (!d) mesh.geometry = bayC; };
    (sg < 0 ? halfL : halfR).add(part);
    return part;
  });
  // the solar mirror: rises out of the dome, turns (rotation.y) to aim; its beam lies level along the aim
  const mirMat = partMat(0.4, 0.35);
  const mirI = GG('ext:s5:selene.mirror', buildSeleneMirror);
  const mirW = wreckGeo('ext:s5:selene.mirror', buildSeleneMirror, { keep: (x, y, z) => 1.0 - Math.hypot(x, z) * 0.6 - (y > 1.6 ? 1 : 0), crumple: 0.14, seed: 67, dir: [0, 1, 0], shards: 12, shardSize: 0.3, band: 0.5 });
  const mirMesh = new THREE.Mesh(mirI, mirMat);
  const mirror = makePart('mirror', 1.3, [{ mesh: mirMesh, intact: mirI, wreck: mirW, sag: [0.35, -0.5, 0.15] }], [SE_FOCUS.clone()]);
  mirror.position.set(0, Y - 0.1, pz);
  const beamMat = additiveMat();
  const beam = new THREE.Mesh(G('ext:s5:selene.beam', () => beamGeo([2.6, 2.0, 1.1], [0.5, 0.3, 0.1])), beamMat);
  beam.position.copy(SE_FOCUS); beam.userData.noShadow = true; beam.renderOrder = 3; beam.visible = false;
  mirror.add(beam);
  pivot.add(mirror);
  // the crystal heart (under the dome, rising out of the plinth for phase 3)
  const coreMat = partMat(0.35, 0.1);
  const heartI = GG('ext:s5:selene.heart', () => buildSeleneHeart(false)), heartD = GG('ext:s5:selene.heartDead', () => buildSeleneHeart(true));
  const heart = new THREE.Mesh(heartI, coreMat);
  const core = makePart('core', 1.1, [{ mesh: heart, intact: heartI, wreck: heartD }], [new THREE.Vector3(0, 0, 0)]);
  core.position.set(0, Y + 1.1, pz);
  pivot.add(core);
  // lift jets (additive, pointing down)
  const liftMat = additiveMat();
  const lift = new THREE.Mesh(G('ext:s5:selene.lift', () => buildFlame(SE_LIFT.map(([x, z]) => [x, z, 1]), FLAME_LIFT)), liftMat);
  lift.rotation.x = Math.PI / 2; lift.position.y = SE_Y0 + 0.02; lift.userData.noShadow = true; lift.renderOrder = 2;
  pivot.add(lift);

  ud.parts = { horn: horns, battery: batteries, bay: bays, mirror, core };
  ud.muzzles = [new THREE.Vector3(0, 1.5, 3.9)];
  ud.setFlash = flashFn(allMats);
  let heartUp = 0, charge = 0, hover = 1, brk = 0, beamG = 0;
  /** 0 … 1: the dome's shutters swing open */
  ud.setDome = (v) => { const d = Math.max(0, Math.min(1, v)), e = d * d * (3 - 2 * d); hingeR.rotation.z = -e * 104 * DEG; hingeL.rotation.z = e * 104 * DEG; };
  /** 0 … 1: the mirror rises out of the dome */
  mirror.userData.setRise = (v) => { const r = Math.max(0, Math.min(1, v)); mirror.position.y = Y - 1.3 + 1.2 * r * r * (3 - 2 * r); };
  /** 0 … 1: the mirror gathers the sun (glow) */
  mirror.userData.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  /** the beam: width (0 = hidden) and brightness */
  mirror.userData.setBeam = (w, glow = 1) => {
    beamG = glow; beam.visible = w > 0.001 && !mirror.userData.destroyed;
    if (beam.visible) beam.scale.set(w, w, 34); else beam.scale.setScalar(0.001);   // hidden: out of the bounds too
  };
  const sdm = mirror.userData.setDestroyed;
  mirror.userData.setDestroyed = (d) => { sdm(d); if (d) { mirror.userData.setBeam(0); charge = 0; } };
  /** 0 … 1: the heart rises out of the plinth (−1.5 … 0 below its part origin) */
  core.userData.setOpen = (v) => { heartUp = Math.max(0, Math.min(1, v)); core.userData.open = heartUp; heart.position.y = -1.5 * (1 - heartUp * heartUp * (3 - 2 * heartUp)); };
  /** 0 … 1: the lift jets (1 = hovering, 0 = dead: it drops onto the mare) */
  ud.setHover = (v) => { hover = Math.max(0, Math.min(1, v)); };
  /** 0 … 1: the crescent breaks at the spine, the halves fall apart (death) */
  ud.setBreak = (k) => {
    brk = Math.max(0, Math.min(1, k));
    const e = brk * brk * (3 - 2 * brk);
    halfR.rotation.set(0.05 * e, -0.2 * e, -0.22 * e); halfL.rotation.set(0.05 * e, 0.2 * e, 0.22 * e);
    halfR.position.set(0.7 * e, -0.3 * e, 0.3 * e); halfL.position.set(-0.7 * e, -0.3 * e, 0.3 * e);
  };
  /** pooled instances come back whole: dome shut, mirror down, heart sunk, hovering, guns facing the jet */
  ud.reset = () => {
    ud.setBreak(0); ud.setDome(0); mirror.userData.setRise(0); mirror.userData.setCharge(0); mirror.userData.setBeam(0); core.userData.setOpen(0);
    for (const b of bays) b.userData.setOpen(0);
    for (const h of horns) h.rotation.y = Math.PI;
    for (const bt of batteries) bt.rotation.y = Math.PI;
    mirror.rotation.y = 0; hover = 1;
  };
  ud.reset();
  ud.update = (dt, t) => {
    const pulse = 0.8 + Math.sin(t * 3.1) * 0.2;
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = pulse;
    mirMat.uEmitScale.value = mirror.userData.destroyed ? 0.3 : 0.7 + charge * 2.4 * (0.85 + Math.sin(t * 37) * 0.15);
    coreMat.uEmitScale.value = core.userData.destroyed ? 0.5 : (0.5 + heartUp * 0.8) * (1 + Math.sin(t * 6) * 0.15);
    heart.rotation.y += dt * (0.3 + heartUp * 0.9);
    if (beam.visible) beamMat.color.setScalar(beamG * (0.85 + Math.sin(t * 53) * 0.15));
    // hover: bob on the lift jets; the flames shrink as the jets die
    pivot.position.y = SE.HOVER * hover + (hover > 0.5 ? Math.sin(t * 1.7) * 0.06 : 0) - 0.55 * brk;
    const fl = 1 + Math.sin(t * 29) * 0.1 + Math.sin(t * 17) * 0.06;
    lift.scale.set(0.5 + hover * 0.5, 0.5 + hover * 0.5, (0.2 + hover * 0.8) * fl);
    lift.visible = hover > 0.05;
    liftMat.color.setScalar(0.5 + hover * 0.5);
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); beamMat.dispose(); liftMat.dispose(); };
  ud.update(0, 0);
  return g;
}

export const ENEMIES = {
  s5_rover: createRover,
  s5_walker: createWalker,
  s5_turret: createPopTurret,
  s5_lander: createLander,
  s5_skimmer: createSkimmer,
  selenite: createSelenite,
};
export const BOSSES = { selene: createSelene };
