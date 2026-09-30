// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 6 "SOLAR VOYAGE" (太陽系航線)
// -----------------------------------------------------------------------------
// models.js registers these tables: createEnemy(type) falls back to ENEMIES[type],
// createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { s6_raider, s6_rock, s6_sail, s6_comet, s6_skimmer, s6_flare, basilisk };
//   export const BOSSES = { helios };
//
// The Heliarch corsairs, raiders of the outer lanes: burnt-bronze hulls under cool silver
// heat-shield plating, polished brass trim, sunfire-gold eyes and energy lines and golden
// plasma drives (stage 3's gunmetal / cyan, stage 4's white ceramic / emerald and stage 5's
// slate / moonlight blue stay distinct). The backdrops run warm and bright — rust Mars, cream
// Jupiter, beige rings, the Sun's glare — and dark between them, so every unit is two-tone:
// the dark bronze carries the silhouette on the bright bodies, the cool silver and the gold
// glows carry it on black space and the corona's dark red.
//
//   S6_RAIDER   asteroid rider: a raider craft clamped on a tumbling rock (userData.setRide(0..1):
//               1 = riding, 0 = the rock gone and the craft free); twin plasma drives, a nose gun
//   S6_ROCK     the loose asteroid a raider kicks away (ore veins glowing faintly): tumbles on its own
//   S6_SAIL     solar-sail fighter: a gunship gondola towing a great diamond sail of film on brass spars
//               (userData.setSail(tilt, billow) trims it; setCharge(0..1) lights the film: the telegraph)
//   S6_COMET    comet bomber: an icy nucleus in a brass harness with a ram prow and shard racks, trailing
//               a long ion tail (additive; userData.setTail(0..1))
//   S6_SKIMMER  ring skimmer: a saucer inside a spinning ring of ice plates (a Saturn in miniature)
//   S6_FLARE    a solar flare HELIOS lobs: a ball of plasma in a spiked corona (userData.setFuse(0..1)
//               swells and whitens it before it bursts)
//   BASILISK    mid-boss: a mechanical serpent — see its section below
//   HELIOS      boss, the corona battleship — see its section below
//
// Imports: only 'three' and './modelkit.js' — never models.js (import cycle).
// House style and helpers: see the modelkit.js header.
//
// Enemy contract — enemyShell(kind, radius, debrisHex) + bodyMat + GG(key, buildXxx):
//   * nose/front toward −z (the game yaws units that face the player by π), up +y,
//     centred on the origin. Across the Solar System: AIR UNITS ONLY (no userData.ground)
//   * userData: kind (the registry sets it to the type), radius, debrisColor, muzzles
//     (group-local Vector3[], refreshed in update() when they move), setFlash(v),
//     update(dt, t), dispose() (materials only)
//   * gameplay numbers (hp, score, collision radius) live in stage6.js ENEMY, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (userData.midboss)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) fully restores the pose
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
// Cache keys: 'ext:s6:<name>'.
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, M, S, DEG, TAU, lit, lin, rgb, GL, EM, scl, hash3, bodyMat, additiveMat, flashFn, enemyShell,
  hazardDrape, makePart, destructiblePart, buildFlame,
} from './modelkit.js';

// =============================================================================
// palette + shared helpers
// =============================================================================
const K = {
  hull: lit('#342a23'), hullLt: lit('#54443a'), hullDk: lit('#211a16'), hullXDk: lit('#120e0c'),
  plate: lit('#a9b3bd'), plateLt: lit('#c6ced6'), plateDk: lit('#78828c'),
  brass: lit('#b08030'), brassLt: lit('#d4a852'), brassDk: lit('#6a4a1c'),
  copper: lit('#b4562a'), black: lit('#0a0908'),
  // film of the solar sails: a dichroic sheen, violet-blue and teal bands (cool against every warm backdrop),
  // a faint self-glow so the sail keeps its body on black space
  film: S(lin('#3f4c92'), rgb(0.02, 0.025, 0.07)), filmLt: S(lin('#5a54a8'), rgb(0.035, 0.03, 0.09)), filmB: S(lin('#2f6f86'), rgb(0.012, 0.04, 0.05)),
  glassDk: S(lin('#2a1c10'), rgb(0.05, 0.03, 0.01)),
};
const SUN = rgb(1.0, 0.7, 0.26, 3.3);       // sunfire (sensor eyes, energy lines)
const SUNH = rgb(1.0, 0.88, 0.6, 4.2);      // white-hot gold (lenses, the plasma)
const SUND = rgb(1.0, 0.62, 0.22, 1.7);     // dim gold (panel lights, ore veins)
const ICE = rgb(0.34, 0.9, 1.0, 3.0);       // comet ice
const ICEH = rgb(0.72, 0.97, 1.0, 4.0);
const G_SUN = GL(SUN, 0.42), G_SUNH = GL(SUNH, 0.5), G_SUND = GL(SUND, 0.3), G_ICE = GL(ICE, 0.45), G_ICEH = GL(ICEH, 0.55);
const G_RD = GL(EM.eyeRed, 0.45);
// golden plasma drives (additive cones, see modelkit buildFlame)
const FLAME_SUN = [
  { r: 0.075, len: 0.62, base: rgb(1.0, 0.6, 0.18, 1.5), tip: rgb(0.6, 0.14, 0.0, 0.0), sides: 6 },
  { r: 0.042, len: 0.34, base: rgb(1.0, 0.93, 0.72, 2.4), tip: rgb(1.0, 0.55, 0.14, 0.1), sides: 5 },
];
const FLAME_SUN_BIG = [
  { r: 0.3, len: 1.5, base: rgb(1.0, 0.58, 0.16, 1.2), tip: rgb(0.55, 0.1, 0.0, 0.0), sides: 8 },
  { r: 0.17, len: 0.85, base: rgb(1.0, 0.92, 0.7, 1.9), tip: rgb(1.0, 0.5, 0.12, 0.05), sides: 6 },
];

/** 8-point fuselage section [z, halfWidth, top, bottom]. Edges: 0/7 top, 1/6 shoulders, 2/5 flanks, 3/4 belly */
function ring8([z, w, tp, bt], y = 0) {
  return [[0, y + tp, z], [w * 0.55, y + tp * 0.82, z], [w, y + tp * 0.18, z], [w * 0.68, y - bt * 0.75, z],
    [0, y - bt, z], [-w * 0.68, y - bt * 0.75, z], [-w, y + tp * 0.18, z], [-w * 0.55, y + tp * 0.82, z]];
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
/** faceted glowing orb (icosahedron), per-face brightness jitter; centre (0, cy, 0) */
function orbGB(r, cy, em, seed, dead = false) {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const k = hash3(i / 9, seed, 3.1);
    const st = dead ? (k > 0.8 ? GL(EM.emberDim, 0.3) : S(lin(k > 0.4 ? '#1c1a18' : '#2e2a26')))
      : GL(scl(em, k > 0.7 ? 1.0 : k > 0.35 ? 0.72 : 0.5), 0.55);
    const d = (v) => (dead ? [p[v] * (0.9 + k * 0.15), p[v + 1] * 0.78 + cy * 0.8, p[v + 2] * (0.9 + k * 0.15)] : [p[v], p[v + 1] + cy, p[v + 2]]);
    b.triO(d(i), d(i + 3), d(i + 6), [0, cy, 0], st);
  }
  geo.dispose();
  return b;
}
/**
 * Lumpy asteroid (a displaced icosahedron) added to b: radius r, y squashed by sq, z stretched by sz; every vertex
 * is moved by a hash of its rest position (shared corners move together, so the shell stays closed).
 * pal(k, ny) → face style (k: a face hash in [0, 1], ny: the face normal's y). Centre (cx, cy, cz).
 */
function rockGB(b, r, seed, pal, { sq = 0.8, sz = 1, amp = 0.36, detail = 1, cx = 0, cy = 0, cz = 0 } = {}) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const p = geo.attributes.position.array;
  const disp = (x, y, z) => {
    const n1 = hash3(x * 2.3 + seed, y * 2.9, z * 2.1), n2 = hash3(x * 6.1, y * 5.3 + seed, z * 6.7);
    const k = r * (1 - amp * 0.55 + amp * (n1 * 0.72 + n2 * 0.28));
    return [cx + x * k, cy + y * k * sq, cz + z * k * sz];
  };
  for (let i = 0; i < p.length; i += 9) {
    const A = disp(p[i], p[i + 1], p[i + 2]), B = disp(p[i + 3], p[i + 4], p[i + 5]), C = disp(p[i + 6], p[i + 7], p[i + 8]);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (A[0] + B[0] + C[0]) / 3 - cx, my = (A[1] + B[1] + C[1]) / 3 - cy, mz = (A[2] + B[2] + C[2]) / 3 - cz;
    if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    b.triO(A, B, C, [cx, cy, cz], pal(hash3(i / 9 + seed, seed * 1.7, 5.3), ny / l));
  }
  geo.dispose();
  return b;
}
// rock faces: basalt greys with lighter, sun-caught facets, dust, and a few ore veins glowing faintly
const ROCK = [lit('#5d544b'), lit('#6f6458'), lit('#4a423b'), lit('#877a6a'), lit('#3a342f')];
const ROCK_ORE = GL(rgb(1.0, 0.55, 0.18, 0.95), 0.3);
function rockPal(ore = 0.05) {
  return (k, ny) => {
    if (k < ore) return ROCK_ORE;
    if (ny > 0.55 && k > 0.62) return ROCK[3];
    if (k < 0.22) return ROCK[4];
    return ROCK[(k * 7) % 3 | 0];
  };
}
// comet ice: pale blue-white with dark dust crusts, the cracks glowing ice-blue
const ICE_C = [lit('#b6c6d2'), lit('#91a6b6'), lit('#d2dde4'), lit('#3c3c46'), lit('#5a5c66')];
function icePal(k, ny) {
  if (k < 0.1) return G_ICE;
  if (k > 0.86) return ny > 0 ? ICE_C[2] : ICE_C[1];
  if (k < 0.3) return ICE_C[3 + ((k * 13) & 1)];
  return ICE_C[(k * 5) & 1];
}

// =============================================================================
// S6_ROCK — loose asteroid (≈ 2.2 across)
// =============================================================================
function buildRock() { return rockGB(new GB(), 1.0, 3.7, rockPal(0.06), { sq: 0.78, amp: 0.4 }); }
function createRock() {
  const { g, pivot, ud } = enemyShell('s6_rock', 1.0, '#6f6458');
  const mat = bodyMat(0.85, 0.08);
  const body = new THREE.Mesh(GG('ext:s6:rock', buildRock), mat);
  pivot.add(body);
  ud.muzzles = [new THREE.Vector3(0, 0, 0)];
  // tumble axis and rate differ per instance (the pool shows several at once)
  const ax = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  let spin = 0.6 + Math.random() * 0.9;
  /** tumble rate (rad/s) */
  ud.setSpin = (v) => { spin = v; };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt) => { body.rotateOnAxis(ax, dt * spin); };
  ud.dispose = () => mat.dispose();
  return g;
}

// =============================================================================
// S6_RAIDER — asteroid rider (≈ 2.3 across the rock): a raider craft clamped on a rock
// =============================================================================
const RD_Y = 0.62, RD_Z = -0.3, RD_K = 1.15;   // the craft's seat on the rock, toward its nose (it settles to 0 once the rock is kicked away), its scale
function buildRaiderCraft() {   // craft-local: nose toward −z
  const b = new GB();
  // hull: a wedge — silver armour on top, bronze flanks with a brass stripe, dark belly
  b.loft([[-0.98, 0.04, 0.05, 0.03], [-0.7, 0.24, 0.13, 0.08], [-0.25, 0.4, 0.2, 0.12], [0.25, 0.44, 0.2, 0.13], [0.62, 0.36, 0.15, 0.1]].map((s) => ring8(s)), (i, j) => {
    if (j === 0 || j === 7) return i === 2 ? K.hullDk : K.plateLt;
    if (j === 1 || j === 6) return i === 1 ? K.brass : K.plate;
    if (j === 2 || j === 5) return i === 2 ? K.brassLt : K.hull;
    return K.hullXDk;
  }, K.plate, K.hullDk);
  // canopy: a gold visor slit, the raiders' sun mark behind it
  b.decal([[-0.1, 0.16, -0.62], [0.1, 0.16, -0.62], [0.13, 0.2, -0.44], [-0.13, 0.2, -0.44]], G_SUN, [0, 0.6, -1]);
  b.decal([[-0.07, 0.205, 0.02], [0.07, 0.205, 0.02], [0.07, 0.205, 0.16], [-0.07, 0.205, 0.16]], K.copper);
  // dorsal fin with a red beacon
  b.spike([[-0.03, 0.18, 0.1], [0.03, 0.18, 0.1], [0.03, 0.17, 0.5], [-0.03, 0.17, 0.5]], [0, 0.46, 0.56], (k) => (k & 1 ? K.brassLt : K.brass));
  b.block({ x: 0, y: 0.44, z: 0.55, w: 0.05, d: 0.05, h: 0.05, top: G_RD, side: G_RD });
  // nose gun under the chin
  b.lathe([0, -0.04, -0.72], [0, 0, -1], [[0, 0.055], [0.42, 0.045], [0.42, 0.06], [0.5, 0.06], [0.5, 0.03]], 6, (i) => (i === 2 ? K.brassLt : K.hullDk), null, G_SUNH, { phase: Math.PI / 6 });
  const f0 = b.n;
  // twin drives on stub pylons (nozzles aft, +z)
  b.block({ x: 0.36, y: -0.02, z: 0.28, w: 0.3, d: 0.26, h: 0.08, tw: 0.24, top: K.hull, side: K.hullDk });
  b.lathe([0.5, 0.0, -0.05], [0, 0, 1], [[0, 0.09], [0.1, 0.13], [0.62, 0.12], [0.72, 0.09]], 6,
    (i, j) => (i === 1 ? (j === 1 || j === 2 ? K.plateLt : K.plate) : i === 0 ? K.brass : K.hull), K.brassDk, G_SUN, { phase: Math.PI / 6 });
  // clamp legs gripping the rock: a strut down and out from each flank
  for (const z of [-0.35, 0.3]) {
    const f = b.n;
    b.block({ x: 0.3, y: -0.3, z, w: 0.08, d: 0.1, h: 0.32, tw: 0.06, top: K.brass, side: K.hullDk });
    b.xform(f, M(0.3, -0.14, z, 0, 0, 0.5).multiply(M(-0.3, 0.14, -z)));
    b.block({ x: 0.43, y: -0.42, z, w: 0.14, d: 0.16, h: 0.06, top: K.brassDk, side: K.hullXDk });
  }
  b.mirrorX(f0);
  return b;
}
function createRaider() {
  const { g, pivot, ud } = enemyShell('s6_raider', 1.2, '#54443a');
  const mat = bodyMat(0.55, 0.3), rockMat = bodyMat(0.85, 0.08);
  const rock = new THREE.Mesh(GG('ext:s6:rock', buildRock), rockMat);
  rock.scale.setScalar(1.0);   // the same size as the loose rock it becomes (s6_rock)
  pivot.add(rock);
  const craft = new THREE.Group(); craft.name = 'craft'; craft.scale.setScalar(RD_K);
  craft.add(new THREE.Mesh(GG('ext:s6:raider', buildRaiderCraft), mat));
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:s6:raider.flame', () => buildFlame([[-0.5, 0.0], [0.5, 0.0]], FLAME_SUN)), flameMat);
  flame.position.z = 0.68; flame.userData.noShadow = true; flame.renderOrder = 2;
  craft.add(flame);
  pivot.add(craft);
  ud.muzzles = [new THREE.Vector3(0, RD_Y - 0.05, RD_Z - 1.24 * RD_K)];
  let ride = 1, thrust = 0.4;
  const rockAxis = new THREE.Vector3(0.3, 0.2, 1).normalize();
  /** 1 = clamped on its rock, 0 = the rock gone (hidden) and the craft free at y = 0 */
  ud.setRide = (v) => { ride = Math.max(0, Math.min(1, v)); rock.visible = ride > 0.5; craft.position.set(0, RD_Y * ride, RD_Z * ride); };
  ud.setThrust = (v) => { thrust = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat, rockMat]);
  ud.update = (dt, t) => {
    // riding: the rock rolls under the craft, the craft rocks on its clamps
    if (rock.visible) rock.rotateOnAxis(rockAxis, dt * 0.5);
    craft.rotation.z = Math.sin(t * 2.1) * 0.06 * ride;
    craft.rotation.x = Math.sin(t * 1.7) * 0.04 * ride;
    ud.muzzles[0].set(0, craft.position.y - 0.05, craft.position.z - 1.24 * RD_K);
    mat.uEmitScale.value = 0.85 + Math.sin(t * 6) * 0.15;
    flame.scale.set(0.9 + thrust * 0.3, 1, (0.4 + thrust * 1.4) * (1 + Math.sin(t * 47) * 0.1));
  };
  ud.dispose = () => { mat.dispose(); rockMat.dispose(); flameMat.dispose(); };
  ud.setRide(1);
  return g;
}

// =============================================================================
// S6_SAIL — solar-sail fighter (≈ 4.1 across the sail's side corners, 4.4 nose to sail tail)
// =============================================================================
// A gunship gondola towing the light: the sail flies over its back half (the gondola's nose and guns stick
// out ahead of it, so the fighter reads from above), a diamond of film on four spars billowed up at the
// middle. Sail-local corners (±SX, 0.05), (0, SZB), (0, SZF); the sail's centre sits at (0, SAIL_Y, SAIL_Z).
const SX = 2.05, SZF = -1.25, SZB = 1.55, SAIL_Y = 0.36, SAIL_Z = 1.05;
function buildSailHull() {
  const b = new GB();
  // gondola: silver back, bronze flanks with a brass band, a dark keel
  b.loft([[-1.75, 0.03, 0.04, 0.03], [-1.45, 0.14, 0.11, 0.08], [-0.95, 0.26, 0.17, 0.12], [-0.3, 0.3, 0.19, 0.13], [0.4, 0.24, 0.15, 0.11], [0.9, 0.12, 0.09, 0.07]].map((s) => ring8(s)), (i, j) => {
    if (j === 0 || j === 7) return i === 3 ? K.brass : i === 2 ? K.plate : K.plateLt;
    if (j === 1 || j === 6) return i === 3 ? K.brassDk : K.plate;
    if (j === 2 || j === 5) return i === 2 ? K.brassLt : K.hull;
    return K.hullXDk;
  }, K.plate, K.hullDk);
  // gold visor, a copper sun mark behind it
  b.decal([[-0.08, 0.1, -1.36], [0.08, 0.1, -1.36], [0.13, 0.155, -1.0], [-0.13, 0.155, -1.0]], G_SUN, [0, 0.6, -1]);
  b.decal([[-0.08, 0.192, -0.55], [0.08, 0.192, -0.55], [0.08, 0.192, -0.38], [-0.08, 0.192, -0.38]], K.copper);
  // the boom up to the sail's hub, a brass collar at its foot
  b.lathe([0, 0.1, 0.4], [0, 0.26, 0.65], [[0, 0.06], [0.72, 0.045]], 6, K.brassLt, K.brass, K.brass);
  b.lathe([0, 0.13, 0.36], [0, 1, 0], [[0, 0.1], [0.05, 0.09]], 6, K.brassDk, null, K.brass);
  const f0 = b.n;
  // twin needle cannons along the flanks, swept canards
  b.lathe([0.28, -0.03, -0.55], [0, 0, -1], [[0, 0.05], [0.72, 0.042], [0.72, 0.058], [0.8, 0.058], [0.8, 0.025]], 5, (i) => (i === 2 ? K.brassLt : K.hullDk), null, G_SUNH);
  b.block({ x: 0.26, y: -0.08, z: -0.45, w: 0.12, d: 0.4, h: 0.1, tw: 0.1, top: K.hull, side: K.hullXDk });
  b.wing([{ x: 0.2, zl: -1.05, zt: -0.62, t: 0.035 }, { x: 0.62, zl: -0.78, zt: -0.6, t: 0.012 }], (i, j) => (j === 0 ? K.plateLt : j === 3 ? K.brassDk : K.hull), null, G_SUND);
  b.mirrorX(f0);
  return b;
}
function buildSail() {   // sail-local: the hub at the origin
  const b = new GB();
  const C = [[SX, 0.05], [0, SZB], [-SX, 0.05], [0, SZF]];   // right, back, left, front
  const N = 4;   // bands per panel, parallel to the outer edge
  const h = (u) => 0.3 * (1 - u) * (1 - u * 0.3);   // billow: the centre up, falling to the rim
  // four panels (centre → two neighbouring corners), each cut in bands of alternating film
  for (let q = 0; q < 4; q++) {
    const a = C[q], c = C[(q + 1) % 4];
    for (let k = 0; k < N; k++) {
      const u0 = k / N, u1 = (k + 1) / N;
      const P = (u, w) => { const x = a[0] * (1 - w) + c[0] * w, z = a[1] * (1 - w) + c[1] * w; return [x * u, h(u), z * u]; };
      const st = k === N - 1 ? K.filmLt : (k + q) & 1 ? K.film : K.filmB;
      for (let m = 0; m < 3; m++) {
        const w0 = m / 3, w1 = (m + 1) / 3;
        b.quadN(P(u0, w0), P(u1, w0), P(u1, w1), P(u0, w1), [0, 1, 0], st);
        b.quadN(P(u0, w0), P(u1, w0), P(u1, w1), P(u0, w1), [0, -1, 0], K.hullXDk);   // the dark back
      }
    }
  }
  // gold rigging round the rim, brass spars along the diagonals, a hair above the film
  const lift = 0.012;
  for (let q = 0; q < 4; q++) {
    const a = C[q], c = C[(q + 1) % 4], dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz), nx = -dz / L * 0.035, nz = dx / L * 0.035;
    b.quadN([a[0] - nx, lift, a[1] - nz], [c[0] - nx, lift, c[1] - nz], [c[0] + nx, lift, c[1] + nz], [a[0] + nx, lift, a[1] + nz], [0, 1, 0], G_SUND);
  }
  for (let q = 0; q < 4; q++) {
    const a = C[q], L = Math.hypot(a[0], a[1]), nx = -a[1] / L * 0.03, nz = a[0] / L * 0.03;
    const P = (u, s) => [a[0] * u + nx * s, h(u) + lift, a[1] * u + nz * s];
    for (let k = 0; k < 3; k++) b.quadN(P(k / 3, -1), P((k + 1) / 3, -1), P((k + 1) / 3, 1), P(k / 3, 1), [0, 1, 0], K.brassLt);
  }
  // corner tips: brass fittings with a light
  for (const [x, z] of C) b.block({ x, y: -0.03, z, w: 0.14, d: 0.14, h: 0.07, top: G_SUNH, side: K.brass });
  // the hub
  b.lathe([0, h(0) - 0.04, 0], [0, 1, 0], [[0, 0.16], [0.06, 0.14], [0.1, 0.06]], 6, K.brassLt, null, G_SUNH);
  return b;
}
function createSail() {
  const { g, pivot, ud } = enemyShell('s6_sail', 1.25, '#54443a');
  ud.halfExtents = { x: SX, z: 2.2 };
  const mat = bodyMat(0.5, 0.35), sailMat = bodyMat(0.75, 0.1);   // the film: matte, so it shows its colour, not the sky
  pivot.add(new THREE.Mesh(GG('ext:s6:sail.hull', buildSailHull), mat));
  const rig = new THREE.Group(); rig.position.set(0, SAIL_Y, SAIL_Z);
  const sail = new THREE.Mesh(GG('ext:s6:sail.sail', buildSail), sailMat);
  rig.add(sail);
  pivot.add(rig);
  // 0, 1: the gondola's guns; 2: the sail's centre (the curtain volley is strung across the sail from here)
  ud.muzzles = [new THREE.Vector3(-0.28, -0.03, -1.4), new THREE.Vector3(0.28, -0.03, -1.4), new THREE.Vector3(0, SAIL_Y, SAIL_Z)];
  /** half-span of the sail's side corners (the curtain volley leaves from along it) */
  ud.spread = SX * 0.92;
  let tilt = 0, billow = 1, charge = 0;
  /** tilt: bank of the sail (−1..1, a tack), billow: 0.2 furled … 1 full */
  ud.setSail = (t, bl = 1) => { tilt = Math.max(-1, Math.min(1, t)); billow = Math.max(0.2, Math.min(1.2, bl)); };
  /** 0..1: the film lights up (charging the curtain volley) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  ud.setThrust = () => {};
  ud.setFlash = flashFn([mat, sailMat]);
  ud.update = (dt, t) => {
    rig.rotation.z = tilt * 0.45 + Math.sin(t * 1.3) * 0.04;
    rig.rotation.x = Math.sin(t * 0.9) * 0.05;
    sail.scale.set(1, 0.4 + 0.6 * billow + Math.sin(t * 2.3) * 0.06, 1);
    mat.uEmitScale.value = 0.85 + Math.sin(t * 5) * 0.12;
    sailMat.uEmitScale.value = 0.75 + Math.sin(t * 2.2) * 0.1 + charge * (4.2 + Math.sin(t * 38) * 0.9);
  };
  ud.dispose = () => { mat.dispose(); sailMat.dispose(); };
  return g;
}

// =============================================================================
// S6_COMET — comet bomber (≈ 1.9 long nucleus + a 7-unit tail): it flies nose first (heading = travel)
// =============================================================================
function buildComet() {
  const b = new GB();
  // the nucleus: dirty ice, stretched along the flight line
  rockGB(b, 0.78, 9.1, icePal, { sq: 0.82, sz: 1.22, amp: 0.34, cz: 0.1 });
  // brass harness: two bands round the ice, a ram prow with a sunfire eye, shard racks on the flanks
  for (const [z, r] of [[-0.25, 0.8], [0.45, 0.78]]) {
    b.lathe([0, 0, z - 0.07], [0, 0, 1], [[0, r], [0.14, r]], 10, (i, j) => ((j & 1) ? K.brass : K.brassDk), null, null, { phase: Math.PI / 10, sy: 0.84 });
  }
  b.lathe([0, 0.04, -0.62], [0, 0, -1], [[0, 0.46], [0.18, 0.4], [0.52, 0.2], [0.72, 0.02]], 8, (i, j) => {
    if (i === 0) return K.hullDk;
    if (i === 1) return (j & 1) ? K.plate : K.plateLt;
    return j === 2 || j === 6 ? K.brassLt : K.hull;
  }, null, null, { phase: Math.PI / 8, sy: 0.8 });
  b.decal([[-0.14, 0.33, -0.86], [0.14, 0.33, -0.86], [0.1, 0.24, -1.06], [-0.1, 0.24, -1.06]], G_SUN, [0, 0.7, -1]);
  const f0 = b.n;
  b.block({ x: 0.78, y: -0.16, z: 0.05, w: 0.24, d: 0.9, h: 0.26, tw: 0.2, td: 0.82, bev: 0.03, top: K.plate, bevS: K.plateLt, side: K.hull, front: K.brass });
  for (const z of [-0.25, 0.05, 0.35]) b.decal([[0.7, 0.103, z - 0.07], [0.86, 0.103, z - 0.07], [0.86, 0.103, z + 0.07], [0.7, 0.103, z + 0.07]], G_ICEH);
  // drive nozzles at the stern, half buried in the ice
  b.lathe([0.34, -0.05, 0.86], [0, 0, 1], [[0, 0.12], [0.18, 0.14], [0.26, 0.1]], 6, (i) => (i === 0 ? K.brassDk : K.hull), null, G_SUN, { phase: Math.PI / 6 });
  b.mirrorX(f0);
  return b;
}
/** the comet's coma and tails, additive (vertex colours fade to black): a glow round the nucleus, a straight
 *  ion tail (ice-blue) and a broader dust tail curving off to one side (pale gold), from z = 0.4 to +len */
function buildCometTail(len = 7.4) {
  const pos = [], col = [];
  const tri = (a, b, c, ca, cb, cc) => { pos.push(...a, ...b, ...c); col.push(...ca, ...cb, ...cc); };
  // coma: a flat disc round the nucleus
  const N = 14, R = 1.35, cC = [0.18, 0.42, 0.5], cE = [0, 0, 0];
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * TAU, a1 = ((k + 1) / N) * TAU;
    tri([0, -0.05, 0.1], [Math.cos(a0) * R, -0.05, 0.1 + Math.sin(a0) * R], [Math.cos(a1) * R, -0.05, 0.1 + Math.sin(a1) * R], cC, cE, cE);
  }
  // a tail as a strip of n segments: centre line x(z), half-width w(z), colour fading along it
  const strip = (x0, bend, w0, w1, y, core, n) => {
    for (let s = 0; s < n; s++) {
      const t0 = s / n, t1 = (s + 1) / n, z0 = 0.4 + t0 * len, z1 = 0.4 + t1 * len;
      const xa = x0 + bend * t0 * t0, xb = x0 + bend * t1 * t1, wa = w0 + (w1 - w0) * t0, wb = w0 + (w1 - w0) * t1;
      const fa = (1 - t0) * (1 - t0), fb = (1 - t1) * (1 - t1);
      const ca = [core[0] * fa, core[1] * fa, core[2] * fa], cb = [core[0] * fb, core[1] * fb, core[2] * fb];
      tri([xa - wa, y, z0], [xa, y, z0], [xb, y, z1], cE, ca, cb); tri([xa - wa, y, z0], [xb, y, z1], [xb - wb, y, z1], cE, cb, cE);
      tri([xa, y, z0], [xa + wa, y, z0], [xb + wb, y, z1], ca, cE, cE); tri([xa, y, z0], [xb + wb, y, z1], [xb, y, z1], ca, cE, cb);
    }
  };
  strip(0.35, 1.9, 0.5, 1.9, -0.1, [0.62, 0.5, 0.3], 7);      // dust tail: broad, curving away, pale gold
  strip(0, 0, 0.32, 0.95, -0.02, [0.34, 0.9, 1.25], 8);       // ion tail: straight, ice-blue
  strip(0, 0, 0.1, 0.3, 0.02, [0.7, 1.1, 1.3], 5);            // its bright core
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
function createComet() {
  const { g, pivot, ud } = enemyShell('s6_comet', 1.3, '#91a6b6');
  const mat = bodyMat(0.45, 0.25);
  pivot.add(new THREE.Mesh(GG('ext:s6:comet', buildComet), mat));
  const tailMat = additiveMat();
  const tail = new THREE.Mesh(G('ext:s6:comet.tail', () => buildCometTail()), tailMat);
  tail.userData.noShadow = true; tail.renderOrder = 2;
  pivot.add(tail);
  // shard racks (either flank) and the prow
  ud.muzzles = [new THREE.Vector3(0.8, 0, 0.05), new THREE.Vector3(-0.8, 0, 0.05), new THREE.Vector3(0, 0.05, -1.3)];
  let tailK = 1;
  /** 0..1: the tail's length and brightness */
  ud.setTail = (v) => { tailK = Math.max(0, Math.min(1.3, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    mat.uEmitScale.value = 0.8 + Math.sin(t * 3.7) * 0.2;
    tail.scale.set(1 + Math.sin(t * 5.3) * 0.05, 1, 0.1 + tailK * (0.9 + Math.sin(t * 7.1) * 0.06));
    tailMat.color.setScalar(0.25 + tailK * 0.75 + Math.sin(t * 13) * 0.05);
    pivot.rotation.z = Math.sin(t * 0.9) * 0.12;
  };
  ud.dispose = () => { mat.dispose(); tailMat.dispose(); };
  return g;
}

// =============================================================================
// S6_SKIMMER — ring skimmer (≈ 2.0 across its ring)
// =============================================================================
function buildSkimmer() {
  const b = new GB();
  // saucer: a silver dome with a gold eye ring, bronze skirt, a dark belly
  b.lathe([0, 0, 0], [0, 1, 0], [[-0.2, 0.12], [-0.14, 0.5], [0.0, 0.62], [0.08, 0.56], [0.18, 0.36], [0.28, 0.12]], 10, (i, j) => {
    if (i === 0) return K.hullXDk;
    if (i === 1) return (j & 1) ? K.hull : K.hullDk;
    if (i === 2) return j === 7 ? G_SUN : (j & 1) ? K.brass : K.brassDk;
    if (i === 3) return (j & 1) ? K.plate : K.plateLt;
    return K.plateLt;
  }, K.hullDk, K.glassDk, { phase: -Math.PI / 2 + Math.PI / 10 });
  // a canopy slit toward the nose (−z), fins and the drive at the stern
  b.decal([[-0.12, 0.3, -0.26], [0.12, 0.3, -0.26], [0.1, 0.27, -0.36], [-0.1, 0.27, -0.36]], G_SUN, [0, 0.8, -0.6]);
  const f0 = b.n;
  b.wing([{ x: 0.16, y: 0.02, zl: 0.3, zt: 0.72, t: 0.05 }, { x: 0.42, y: 0.14, zl: 0.5, zt: 0.78, t: 0.02 }], (i, j) => (j === 0 ? K.plate : K.hull), null, K.brass);
  b.mirrorX(f0);
  b.lathe([0, 0.02, 0.5], [0, 0, 1], [[0, 0.1], [0.2, 0.12], [0.3, 0.08]], 6, (i) => (i === 0 ? K.brassDk : K.hull), null, G_SUN, { phase: Math.PI / 6 });
  return b;
}
function buildSkimmerRing() {   // spins about y: two bands of ice plates with a gap between, gold studs
  const b = new GB();
  const n = 16;
  annulus(b, 0.74, 0.86, 0.02, 0, TAU, n, (k) => (k % 4 === 0 ? K.hull : (k & 1) ? K.plateLt : K.plate));
  annulus(b, 0.9, 1.0, 0.02, 0, TAU, n, (k) => (k % 4 === 2 ? G_SUND : (k & 1) ? K.plateDk : K.plate));
  annulus(b, 0.74, 1.0, -0.03, 0, TAU, n, K.hullDk, -1);
  wall(b, 1.0, -0.03, 0.02, 0, TAU, n, K.brassDk, 1);
  // four spokes to the hub
  for (let k = 0; k < 4; k++) {
    const f = b.n;
    b.block({ x: 0.62, y: -0.02, z: 0, w: 0.26, d: 0.06, h: 0.04, top: K.brass, side: K.hullDk });
    b.xform(f, M(0, 0, 0, 0, (k * TAU) / 4 + Math.PI / 4, 0));
  }
  return b;
}
function createSkimmer() {
  const { g, pivot, ud } = enemyShell('s6_skimmer', 0.85, '#78828c');
  const mat = bodyMat(0.5, 0.35);
  pivot.add(new THREE.Mesh(GG('ext:s6:skimmer', buildSkimmer), mat));
  const ring = new THREE.Mesh(GG('ext:s6:skimmer.ring', buildSkimmerRing), mat);
  ring.rotation.x = 0.16;
  const tilt = new THREE.Group(); tilt.add(ring); tilt.rotation.z = 0.1;
  pivot.add(tilt);
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('ext:s6:skimmer.flame', () => buildFlame([[0, 0.02, 0.9]], FLAME_SUN)), flameMat);
  flame.position.z = 0.8; flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, 0, -0.5)];
  let thrust = 0.6;
  ud.setThrust = (v) => { thrust = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    ring.rotation.y += dt * 3.2;
    mat.uEmitScale.value = 0.85 + Math.sin(t * 8) * 0.15;
    flame.scale.set(1, 1, (0.4 + thrust * 1.4) * (1 + Math.sin(t * 45) * 0.12));
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); };
  return g;
}

// =============================================================================
// S6_FLARE — a solar flare (≈ 1.0 across the ball, 2.6 across the corona spikes)
// =============================================================================
function buildFlareCorona() {   // additive, flat: a spiked star burst round the ball
  const pos = [], col = [];
  const N = 10, hot = [1.2, 0.72, 0.28], mid = [0.7, 0.26, 0.05], zero = [0, 0, 0];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU, a0 = a - 0.2, a1 = a + 0.2, r = k & 1 ? 1.05 : 1.35;
    pos.push(Math.cos(a0) * 0.42, 0, Math.sin(a0) * 0.42, Math.cos(a1) * 0.42, 0, Math.sin(a1) * 0.42, Math.cos(a) * r, 0, Math.sin(a) * r);
    col.push(...hot, ...hot, ...zero);
  }
  const M1 = 16;
  for (let k = 0; k < M1; k++) {
    const a0 = (k / M1) * TAU, a1 = ((k + 1) / M1) * TAU;
    pos.push(0, 0, 0, Math.cos(a0) * 0.8, 0, Math.sin(a0) * 0.8, Math.cos(a1) * 0.8, 0, Math.sin(a1) * 0.8);
    col.push(...mid, ...zero, ...zero);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
function createFlare() {
  const { g, pivot, ud } = enemyShell('s6_flare', 0.55, '#ffb040');
  const mat = bodyMat(0.4, 0.1);
  const ball = new THREE.Mesh(GG('ext:s6:flare', () => orbGB(0.46, 0, SUNH, 2.2)), mat);
  pivot.add(ball);
  const corMat = additiveMat();
  const corona = new THREE.Mesh(G('ext:s6:flare.corona', buildFlareCorona), corMat);
  corona.userData.noShadow = true; corona.renderOrder = 2;
  pivot.add(corona);
  ud.muzzles = [new THREE.Vector3(0, 0, 0)];
  let fuse = 0;
  /** 0..1: the flare swells, whitens and flickers faster toward its burst */
  ud.setFuse = (v) => { fuse = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    const f = 1 + Math.sin(t * (9 + fuse * 30)) * (0.06 + fuse * 0.1);
    ball.scale.setScalar((0.9 + fuse * 0.45) * f);
    ball.rotation.y += dt * 2.4;
    corona.rotation.y -= dt * (1.4 + fuse * 3);
    corona.scale.setScalar((0.85 + fuse * 0.6) * (1 + Math.sin(t * 17) * 0.06));
    corMat.color.setScalar(0.8 + fuse * 0.8);
    mat.uEmitScale.value = 0.75 + fuse * 0.7;
  };
  ud.dispose = () => { mat.dispose(); corMat.dispose(); };
  ud.setFuse(0);
  return g;
}

// =============================================================================
// BASILISK — mid-boss: a mechanical serpent (≈ 13 long, 1.7 across the body)
// =============================================================================
// One skinned body (head, armoured coils and neck in a single mesh) on a chain of BAS_N bones spaced BAS_BS
// apart along +z (bone 0 is the head, at the origin, facing −z). The bones are flat children of the pivot, so
// the AI lays them along the path the head has travelled: bone k at arc distance k·BAS_BS behind it
// (userData.bones[k].position / .rotation.y, in the unit's frame). Riding the bones: the lower jaw (bone 0),
// the eye (part core, in its socket on the head: setOpen raises it out of the armour and lights it), the two
// dorsal gun spines (parts spineA on bone BAS_SPINE[0], spineB on BAS_SPINE[1]; twin barrels firing out of
// either flank) and the barbed tail stinger (part tail, on the last bone).
const BAS_N = 10, BAS_BS = 1.15, BAS_SPINE = [3, 6];   // stage6.js mirrors BAS_N / BAS_BS
const BAS_Z0 = 0.45, BAS_Z1 = BAS_BS * (BAS_N - 1) + 0.25;   // the coils run from the neck to the last bone
const BAS_HEAD = [0, 0];   // the head's triangles in the body GB (skinned wholly to bone 0: its crest reaches back)
const BAS_HK = 1.3;          // the head's scale
function basR(z) {           // body radius along it: a thick middle, tapering to the tail
  if (z < 2) return 0.8 + (z - BAS_Z0) / (2 - BAS_Z0) * 0.2;
  if (z < 4.5) return 1.0;
  return 1.0 - (z - 4.5) / (BAS_Z1 - 4.5) * 0.62;
}
/** 10-point serpent section at z: a rounded back, flattened belly; edge 0 on the spine */
function basRing(z, r, sq = 0.72) {
  const out = [];
  for (let k = 0; k < 10; k++) {
    const a = Math.PI / 2 - ((k + 0.5) * TAU) / 10, y = Math.sin(a) * r * sq;
    out.push([Math.cos(a) * r, Math.max(y, -r * 0.5), z]);
  }
  return out;
}
function buildBasiliskBody() {
  const b = new GB();
  // ---- the coils: silver dorsal scutes between dark joints (a gold energy line along the spine at each
  // joint), bronze flanks with a brass stripe, belly plates
  const rings = [], zs = [];
  for (let z = BAS_Z0; z < BAS_Z1 + 1e-6; z += 0.3) zs.push(z);
  for (const z of zs) rings.push(basRing(z, basR(z)));
  b.loft(rings, (i, j) => {
    const joint = i % 4 === 3;
    if (j === 0 || j === 9) return joint ? (j === 0 ? G_SUND : K.hullXDk) : (i >> 2) & 1 ? K.plate : K.plateLt;
    if (j === 1 || j === 8) return joint ? K.hullXDk : K.plate;
    if (j === 2 || j === 7) return joint ? K.hullDk : (i & 1 ? K.brass : K.hull);
    if (j === 3 || j === 6) return K.hullDk;
    return joint ? K.hullXDk : K.brassDk;
  }, null, K.hullDk);
  // dorsal spikes on the plain coils (the gun spines sit on BAS_SPINE)
  for (let k = 1; k < BAS_N - 1; k++) {
    if (BAS_SPINE.includes(k)) continue;
    const z = k * BAS_BS + 0.3, r = basR(z), top = r * 0.72;
    b.spike([[-0.1, top - 0.04, z - 0.28], [0.1, top - 0.04, z - 0.28], [0, top - 0.04, z + 0.22]], [0, top + 0.3 + r * 0.2, z + 0.34], (q) => (q === 0 ? K.brassLt : K.brass));
  }
  // ---- the head (bone 0): an armoured wedge, flat on top, the eye socket on the brow
  const h0 = b.n;
  const hs = [[0.62, 0.64, 0.46, 0.34], [0.1, 0.8, 0.52, 0.36], [-0.55, 0.74, 0.48, 0.3], [-1.2, 0.54, 0.34, 0.22], [-1.72, 0.3, 0.2, 0.12], [-1.98, 0.1, 0.08, 0.05]];
  const hr = ([z, w, tp, bt]) => [[-w * 0.4, tp, z], [w * 0.4, tp, z], [w * 0.86, tp * 0.72, z], [w, tp * 0.2, z], [w * 0.84, -bt * 0.5, z], [w * 0.4, -bt, z],
    [-w * 0.4, -bt, z], [-w * 0.84, -bt * 0.5, z], [-w, tp * 0.2, z], [-w * 0.86, tp * 0.72, z]];
  b.loft(hs.map(hr), (i, j) => {
    if (j === 0) return i === 1 ? K.hullXDk : i >= 3 ? K.plateLt : K.hull;          // the crown, silver toward the snout
    if (j === 1 || j === 9) return i === 2 ? K.plateLt : K.plate;                   // brow ridges
    if (j === 2 || j === 8) return i === 1 ? G_SUN : K.brass;                       // gill vents behind the cheeks
    if (j === 3 || j === 7) return K.hull;
    return K.hullXDk;
  }, K.hullDk, K.hullXDk);
  // the eye socket: a raised brass collar round a dark well (the eye rises out of it)
  b.lathe([0, 0.44, -0.42], [0, 1, 0], [[0, 0.44], [0.08, 0.42], [0.14, 0.34], [0.14, 0.24], [0.02, 0.2]], 10, (i, j) => (i === 0 ? K.hull : i === 1 ? ((j & 1) ? K.brass : K.brassLt) : K.hullXDk), null, K.black, { phase: Math.PI / 10 });
  // armoured brows over the socket, nostril slits, upper fangs
  for (const sg of [-1, 1]) {
    const f = b.n;
    b.block({ x: 0.36 * sg, y: 0.46, z: -0.5, w: 0.18, d: 0.62, h: 0.12, tw: 0.1, td: 0.5, top: K.plateLt, side: K.hullDk });
    b.xform(f, M(0.36 * sg, 0.46, -0.5, 0, 0.25 * sg, -0.3 * sg).multiply(M(-0.36 * sg, -0.46, 0.5)));
    b.decal([[0.08 * sg, 0.205, -1.62], [0.17 * sg, 0.18, -1.6], [0.14 * sg, 0.176, -1.5], [0.06 * sg, 0.2, -1.52]], G_SUN, [0, 1, -0.3]);
    b.spike([[0.14 * sg, -0.1, -1.5], [0.24 * sg, -0.08, -1.36], [0.1 * sg, -0.1, -1.34]], [0.18 * sg, -0.46, -1.52], (q) => (q ? lit('#e8e2d4') : lit('#bdb6a6')));
  }
  // the crest: five swept spikes fanning back off the crown (a basilisk's crown)
  for (let k = 0; k < 5; k++) {
    const a = (k - 2) * 0.36, x = Math.sin(a) * 0.5, len = k === 2 ? 1.25 : k & 1 ? 1.0 : 0.8;
    b.spike([[x - 0.1, 0.46, 0.05], [x + 0.1, 0.46, 0.05], [x, 0.4, 0.45]], [x + Math.sin(a) * len, 0.62 + len * 0.28, 0.4 + Math.cos(a) * len], (q) => (q === 0 ? K.brassLt : q === 1 ? K.brass : K.brassDk));
  }
  b.xform(h0, M(0, 0, 0, 0, 0, 0, BAS_HK));   // the head a size up
  BAS_HEAD[0] = h0; BAS_HEAD[1] = b.n;
  return b;
}
/** skin the body: each vertex on the two bones either side of its z (the head wholly on bone 0) */
function skinBasilisk(geo) {
  const pos = geo.attributes.position, n = pos.count, h0 = BAS_HEAD[0] * 3, h1 = BAS_HEAD[1] * 3;
  const idx = new Uint16Array(n * 4), wt = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const z = pos.getZ(i), head = i >= h0 && i < h1;
    const u = head ? 0 : Math.max(0, Math.min(BAS_N - 1, z / BAS_BS));
    const k0 = Math.min(BAS_N - 2, Math.floor(u)), w = head || z < BAS_Z0 - 0.05 ? 0 : u - k0;
    idx[i * 4] = k0; idx[i * 4 + 1] = k0 + 1; wt[i * 4] = 1 - w; wt[i * 4 + 1] = w;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wt, 4));
  return geo;
}
function buildBasiliskJaw() {   // hinge-local (the head's scale applied): the lower jaw, hinged near its back, fangs up
  const b = new GB();
  b.loft([[0.3, 0.52, 0.02, 0.18], [-0.5, 0.56, 0.04, 0.2], [-1.2, 0.4, 0.04, 0.14], [-1.8, 0.16, 0.03, 0.06]].map(([z, w, tp, bt]) => [
    [0, tp, z], [w * 0.8, tp, z], [w, -bt * 0.3, z], [w * 0.6, -bt, z], [-w * 0.6, -bt, z], [-w, -bt * 0.3, z], [-w * 0.8, tp, z]]),
  (i, j) => (j === 0 || j === 6 ? K.hullXDk : j === 3 || j === 4 ? K.hullDk : i === 1 ? K.brassDk : K.hull), K.hullDk, K.hullXDk);
  for (const sg of [-1, 1]) {
    b.spike([[0.2 * sg, 0.03, -1.25], [0.3 * sg, 0.03, -1.1], [0.14 * sg, 0.03, -1.08]], [0.22 * sg, 0.34, -1.2], (q) => (q ? lit('#e8e2d4') : lit('#bdb6a6')));
    b.decal([[0.06 * sg, 0.045, -0.2], [0.34 * sg, 0.045, -0.2], [0.3 * sg, 0.045, -0.95], [0.08 * sg, 0.045, -0.95]], G_SUND);   // the glowing gullet
  }
  b.xform(0, M(0, 0, 0, 0, 0, 0, BAS_HK));
  return b;
}
/** the serpent's eye (part-local, centre at the origin): a gold orb, a black slit pupil along its crown, the
 *  underside ember red; dead: a cracked, burnt-out husk */
function buildBasiliskEye(dead = false) {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(0.36, 2);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const cx = (p[i] + p[i + 3] + p[i + 6]) / 3, cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3, cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3;
    const k = hash3(i / 9, 4.1, 2.7);
    let st;
    if (dead) st = k > 0.85 ? GL(EM.emberDim, 0.3) : S(lin(k > 0.4 ? '#221c18' : '#3a322c'));
    else if (cy > 0.02 && Math.abs(cx) < 0.075) st = S(lin('#050404'));                  // the slit pupil
    else if (cy > -0.05) st = GL(scl(SUNH, 0.75 + k * 0.3), 0.55);                        // the iris
    else st = GL(rgb(1.0, 0.2, 0.05, 1.4 + k * 0.6), 0.4);                               // ember-red below
    const d = (v) => (dead ? [p[v] * 0.9, p[v + 1] * 0.7 - 0.05, p[v + 2] * 0.9] : [p[v], p[v + 1], p[v + 2]]);
    b.triO(d(i), d(i + 3), d(i + 6), [0, dead ? -0.05 : 0, 0], st);
  }
  geo.dispose();
  return b;
}
function buildBasiliskSpine() {   // part-local, on the back of the coil: a gun crest with twin flank barrels
  const b = new GB();
  // armoured saddle over the coil
  b.lathe([0, -0.1, 0], [0, 0, 1], [[-0.5, 0.72], [-0.3, 0.9], [0.3, 0.9], [0.5, 0.72]], 8, (i, j) => (j >= 3 && j <= 5 ? null : i === 1 ? ((j & 1) ? K.plateLt : K.plate) : K.hullDk), null, null, { phase: Math.PI / 8, sy: 0.62 });
  // the gun block across the back, a barrel out of each flank (along ±x)
  b.block({ x: 0, y: 0.38, z: 0, w: 0.9, d: 0.56, h: 0.26, tw: 0.76, td: 0.46, bev: 0.04, top: K.brass, bevS: K.brassLt, side: K.hull });
  for (const sg of [-1, 1]) {
    b.lathe([0.4 * sg, 0.5, 0], [sg, 0, 0], [[0, 0.1], [0.62, 0.075], [0.62, 0.1], [0.74, 0.1], [0.74, 0.05]], 6, (i) => (i === 2 ? K.brassLt : K.hullDk), null, G_SUNH, { phase: Math.PI / 6 });
  }
  // the crest: three blades swept back, a sunfire lens between them
  for (const [x, len] of [[-0.18, 0.7], [0, 0.95], [0.18, 0.7]]) {
    b.spike([[x - 0.08, 0.6, -0.2], [x + 0.08, 0.6, -0.2], [x, 0.6, 0.18]], [x * 1.6, 0.6 + len * 0.5, 0.3 + len * 0.5], (q) => (q === 0 ? K.plateLt : K.hull));
  }
  b.decal([[-0.12, 0.645, -0.22], [0.12, 0.645, -0.22], [0.12, 0.645, -0.08], [-0.12, 0.645, -0.08]], G_SUN);
  return b;
}
function buildBasiliskTail() {   // part-local (on the last bone): the stinger, barbed, pointing back along +z
  const b = new GB();
  b.lathe([0, 0, 0.1], [0, 0, 1], [[0, 0.34], [0.3, 0.36], [0.9, 0.22], [1.45, 0.06], [1.62, 0.0]], 8, (i, j) => {
    if (i === 0) return (j & 1) ? K.brass : K.brassDk;
    if (i === 1) return j === 0 || j === 7 ? K.plateLt : K.plate;
    if (i === 3) return G_SUNH;
    return j === 0 || j === 7 ? K.hullDk : K.hull;
  }, K.hullDk, null, { phase: Math.PI / 8, sy: 0.8 });
  // barbs: two swept hooks either side, one on top
  for (const sg of [-1, 1]) b.spike([[0.2 * sg, 0.04, 0.55], [0.28 * sg, 0.0, 0.8], [0.18 * sg, -0.04, 0.62]], [0.72 * sg, 0.06, 0.3], (q) => (q ? K.plateLt : K.brass));
  b.spike([[-0.08, 0.26, 0.4], [0.08, 0.26, 0.4], [0, 0.24, 0.8]], [0, 0.72, 0.2], (q) => (q === 0 ? K.plateLt : K.brass));
  // a venom sac glowing under the root
  b.decal([[-0.16, 0.285, 0.2], [0.16, 0.285, 0.2], [0.12, 0.2, 0.5], [-0.12, 0.2, 0.5]], G_SUN, [0, 1, 0.3]);
  return b;
}
function createBasilisk() {
  const { g, pivot, ud } = enemyShell('basilisk', 1.0, '#54443a');
  ud.midboss = true;
  ud.halfExtents = { x: 1.2, z: 6.5 };
  const bodyMatB = bodyMat(0.55, 0.3);
  const allMats = [bodyMatB];
  // ---- the bone chain
  const bones = [];
  for (let k = 0; k < BAS_N; k++) {
    const bn = new THREE.Bone(); bn.name = 'bone' + k; bn.position.set(0, 0, k * BAS_BS); bn.rotation.order = 'YXZ';
    pivot.add(bn); bones.push(bn);
  }
  g.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const body = new THREE.SkinnedMesh(G('ext:s6:basilisk.body', () => skinBasilisk(buildBasiliskBody().build())), bodyMatB);
  body.name = 'body'; body.frustumCulled = false;
  body.bind(skeleton, new THREE.Matrix4());
  pivot.add(body);
  skeleton.update();
  // ---- the lower jaw and the mouth (bone 0)
  const jawHinge = new THREE.Object3D(); jawHinge.position.set(0, -0.14 * BAS_HK, 0.18 * BAS_HK);
  const jaw = new THREE.Mesh(GG('ext:s6:basilisk.jaw', buildBasiliskJaw), bodyMatB);
  jawHinge.add(jaw);
  bones[0].add(jawHinge);
  bones[0].userData.muzzles = [new THREE.Vector3(0, -0.15, -2.0 * BAS_HK)];
  // ---- the eye (core): sunk in its socket, raised and lit by setOpen
  const eyeMat = bodyMat(0.4, 0.1); allMats.push(eyeMat);
  const eyeGeo = GG('ext:s6:basilisk.eye', () => buildBasiliskEye()), eyeDead = GG('ext:s6:basilisk.eyeDead', () => buildBasiliskEye(true));
  const eye = new THREE.Mesh(eyeGeo, eyeMat);
  const core = makePart('core', 0.85, [{ mesh: eye, intact: eyeGeo, wreck: eyeDead }], [new THREE.Vector3(0, 0.3, -0.1)]);
  core.position.set(0, 0.36 * BAS_HK, -0.42 * BAS_HK); core.scale.setScalar(BAS_HK / 1.12);
  bones[0].add(core);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT * openT * (3 - 2 * openT);
    eye.position.y = -0.14 + e * 0.34; eye.scale.setScalar(0.8 + e * 0.35);
  };
  core.userData.setOpen(0);
  // ---- the gun spines and the stinger
  const spineKeep = { keep: (x, y, z) => 0.5 - y, crumple: 0.12, seed: 61, dir: [0, 1, 0], shards: 8, shardSize: 0.2, band: 0.3 };
  const spines = BAS_SPINE.map((bk, k) => {
    const m = bodyMat(0.55, 0.3); allMats.push(m);
    const r = basR(bk * BAS_BS);
    const pt = destructiblePart({ key: 'ext:s6:basilisk.spine', build: buildBasiliskSpine, name: k ? 'spineB' : 'spineA', radius: 0.95,
      muzzles: [new THREE.Vector3(1.14, 0.5, 0), new THREE.Vector3(-1.14, 0.5, 0)], wreck: spineKeep, sag: [0, -0.1, 0.25], pos: [0, r * 0.72 - 0.3, 0], mat: m });
    pt.scale.setScalar(1.15);
    bones[bk].add(pt);
    return pt;
  });
  const tailMat = bodyMat(0.5, 0.3); allMats.push(tailMat);
  const tail = destructiblePart({ key: 'ext:s6:basilisk.tail', build: buildBasiliskTail, name: 'tail', radius: 0.78,
    muzzles: [new THREE.Vector3(0, 0, 1.62)], wreck: { keep: (x, y, z) => 0.7 - z, crumple: 0.1, seed: 67, dir: [0, 0, 1], shards: 7, shardSize: 0.18, band: 0.35 },
    sag: [0.2, -0.05, 0], pos: [0, 0, 0.12], mat: tailMat });
  tail.scale.setScalar(1.2);
  bones[BAS_N - 1].add(tail);
  ud.parts = { spineA: spines[0], spineB: spines[1], tail, core };
  ud.bones = bones;
  ud.jawHinge = jawHinge;
  ud.muzzles = [new THREE.Vector3(0, -0.15, -2.0 * BAS_HK)];
  let jawT = 0, hurt = 0;
  /** 0..1: the jaw opens (a hiss) */
  ud.setJaw = (v) => { jawT = Math.max(0, Math.min(1, v)); jawHinge.rotation.x = -jawT * 0.55; };
  /** 0..1: the coils darken and flicker (dying) */
  ud.setHurt = (v) => { hurt = Math.max(0, Math.min(1, v)); };
  /** pooled instances come back posed: laid straight back from the head, jaw shut, eye sunk */
  ud.reset = () => {
    for (let k = 0; k < BAS_N; k++) bones[k].position.set(0, 0, k * BAS_BS), bones[k].rotation.set(0, 0, 0);
    ud.setJaw(0); hurt = 0; core.userData.setOpen(0);
  };
  const flashAll = flashFn(allMats);
  ud.setFlash = (v) => flashAll(v * 0.4);   // armour hits on the coils: a soft flash (the parts flash on their own)
  ud.update = (dt, t) => {
    const p = (0.8 + Math.sin(t * 2.9) * 0.2) * (1 - hurt * 0.6);
    bodyMatB.uEmitScale.value = p; tailMat.uEmitScale.value = tail.userData.destroyed ? 0.6 : p;
    for (const sp of spines) sp.userData.materials[0].uEmitScale.value = sp.userData.destroyed ? 0.6 : p;
    eyeMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.3 + openT * 0.6) * (1 + Math.sin(t * 7) * 0.12);
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); skeleton.dispose(); };
  return g;
}
// =============================================================================
// HELIOS — boss: the corona battleship (≈ 14.8 long, 15 across with its wings spread)
// =============================================================================
// Hierarchy (it faces the jet: yaw π, the prow at the bottom of the screen, the drives toward the Sun):
//   pivot ┬ hull (static): the armoured hull and its heat-shield prow, the sun-emblem collar round the core
//         │   well, the bridge tower, turret pads, wing pivot housings, radiator fins, the drive block + flames
//         ├ turret0..3 (parts; twin barrels along −z, rotation.y aims)   fore pair, aft pair
//         ├ flareL, flareR (parts): mortar launchers on the flank sponsons (setCharge lights the tube)
//         ├ hingeR / hingeL (the left one mirrored: scale.x = −1) → wingR / wingL (parts): the corona wings,
//         │   a fan of collector glass on brass ribs with five ray emitters on the rim; their hinges swing them
//         │   out (setWings(0..1): 0 swept back along the flanks, 1 spread square to the hull); the wing's
//         │   setCharge lights its glass. hinge.userData.muzzles = [pivot] (the rays run pivot → emitter)
//         └ core (part): the captive star (an orb of plasma) under four armour petals on the collar rim and its
//             corona halo (additive); setOpen(0..1) opens the petals and raises the star, setStar(v) its heat
// setBreak(0..1) tears the wings away, flings the petals and cracks the hull for the death; reset() restores
// the pooled pose.
const HE_SHIFT = 1.2;                                                 // the pivot sits this far aft of the unit's centre
const HE_CORE = [0, 0.72, -0.6];                                      // the core well (collar centre, deck level)
const HE_TURRETS = [[-1.35, -3.7], [1.35, -3.7], [-1.8, 1.5], [1.8, 1.5]];   // turret pads (x, z)
const HE_FLARE = [2.55, 0.42, -2.3];                                  // right flare launcher (base)
const HE_PIVOT = [2.35, 0.34, 1.35];                                  // right wing pivot
const HE_WING = { r0: 0.5, r1: 4.4, tip: 5.2, half: 0.55, c: 2.8 };  // the wing's fan (span along +x), its hit centre
const HE_WING_FOLD = -Math.PI / 2 + 0.6;                             // hinge yaw folded (swept back and a little out)
/** 10-point armoured section with a flat top [z, halfWidth, top, bottom]. Edges: 0 top, 1/9 bevels, 2/8 upper flanks,
 *  3/7 lower flanks, 4/6 chines, 5 keel */
function ring10([z, w, tp, bt], y = 0) {
  return [[-w * 0.36, y + tp, z], [w * 0.36, y + tp, z], [w * 0.8, y + tp * 0.78, z], [w, y + tp * 0.3, z], [w * 0.86, y - bt * 0.4, z],
    [w * 0.45, y - bt, z], [-w * 0.45, y - bt, z], [-w * 0.86, y - bt * 0.4, z], [-w, y + tp * 0.3, z], [-w * 0.8, y + tp * 0.78, z]];
}
const HE_HULL = [[-7.2, 0.25, 0.3, 0.2], [-6.3, 1.1, 0.42, 0.35], [-5.0, 1.8, 0.55, 0.5], [-3.2, 2.3, 0.65, 0.6], [-1.0, 2.55, 0.7, 0.65],
  [1.5, 2.5, 0.72, 0.65], [3.8, 2.3, 0.68, 0.6], [5.4, 2.0, 0.6, 0.55], [6.5, 1.6, 0.5, 0.45]];
const HE_GLASS = S(lin('#48170a'), rgb(0.07, 0.016, 0.003)), HE_GLASS2 = S(lin('#5c2a0c'), rgb(0.09, 0.03, 0.004));   // collector glass
function buildHeliosHull() {
  const b = new GB();
  // ---- the hull: silver deck plates, brass bevels, bronze flanks with glowing heat vents, a dark keel
  const d0 = b.n;
  b.loft(HE_HULL.map((sec) => ring10(sec)), (i, j) => {
    if (j === 0) return i === 0 ? K.hullDk : (i & 1) ? K.plate : K.plateDk;           // darker deck plates than the fighters':
    // the corona's glare is bright, the battleship reads as a dark hull with bright trim
    if (j === 1 || j === 9) return i === 0 ? K.brassDk : (i & 1) ? K.brass : K.brassDk;
    if (j === 2 || j === 8) return i === 2 || i === 5 ? G_SUND : i === 0 ? K.hullXDk : K.hull;
    if (j === 3 || j === 7) return K.hullDk;
    return K.hullXDk;
  }, K.hullDk, K.hullXDk);
  const d1 = b.n;
  // the prow: an armoured ram with a gold chevron, the prow gun at its tip
  b.block({ x: 0, y: 0.38, z: -5.5, w: 1.7, d: 2.8, h: 0.34, tw: 0.9, td: 2.3, oz: 0.25, bev: 0.08, top: K.hull, bevS: K.brass, side: K.hullDk, front: K.hullXDk });
  b.decal([[-0.5, 0.726, -5.3], [0, 0.726, -6.2], [0.5, 0.726, -5.3], [0.36, 0.726, -5.1], [0, 0.726, -5.85], [-0.36, 0.726, -5.1]].slice(0, 3), G_SUN);
  b.lathe([0, 0.34, -6.9], [0, 0, -1], [[0, 0.3], [0.5, 0.26], [0.5, 0.34], [0.72, 0.34], [0.72, 0.18]], 8, (i) => (i === 2 ? K.brassLt : K.hullDk), null, G_SUNH, { phase: Math.PI / 8 });
  hazardDrape(b, -1.6, -2.75, 1.6, -2.75, 0.28, 10, K.copper, K.black, d0, d1, 0.012, 1);
  // ---- the core well: a brass collar studded with sunfire nodes round a dark pit, twelve gold rays round it on the deck
  const [cx, cy, cz] = HE_CORE;
  b.lathe([cx, cy - 0.02, cz], [0, 1, 0], [[0, 1.78], [0.14, 1.72], [0.26, 1.52], [0.22, 1.22], [0.0, 1.12]], 16,
    (i, j) => (i === 1 ? (j % 4 === 1 ? G_SUN : (j & 1) ? K.brass : K.brassLt) : i === 0 ? K.brassDk : K.hullXDk), null, null, { phase: Math.PI / 16 });
  b.lathe([cx, cy - 0.01, cz], [0, 1, 0], [[0, 1.12], [0, 0.0]], 16, K.black);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU + Math.PI / 12, r0 = 1.86, r1 = k & 1 ? 2.2 : 2.45, w = 0.07;
    const ca = Math.cos(a), sa = Math.sin(a);
    if (Math.abs(cz + sa * r1) > 7) continue;
    const pts = [[cx + ca * r0 - sa * w, cy + 0.004, cz + sa * r0 + ca * w], [cx + ca * r1, cy + 0.004, cz + sa * r1], [cx + ca * r0 + sa * w, cy + 0.004, cz + sa * r0 - ca * w]];
    const y = b.surfaceY(pts[1][0], pts[1][2], d0, d1);
    if (y === null) continue;
    for (const q of pts) q[1] = Math.max(q[1], (b.surfaceY(q[0], q[2], d0, d1) ?? y) + 0.01);
    b.decal(pts, k & 1 ? G_SUND : G_SUN);
  }
  // ---- the spine to the bridge, the bridge tower (a gold window band facing forward), masts, a dish
  b.block({ x: 0, y: 0.66, z: 1.85, w: 0.9, d: 1.4, h: 0.2, tw: 0.8, td: 1.3, top: K.plate, side: K.hullDk });
  b.decal([[-0.06, 0.865, 1.2], [0.06, 0.865, 1.2], [0.06, 0.865, 2.5], [-0.06, 0.865, 2.5]], G_SUN);
  b.block({ x: 0, y: 0.66, z: 3.5, w: 2.0, d: 1.9, h: 0.52, tw: 1.8, td: 1.7, bev: 0.06, top: K.plate, bevS: K.brass, side: K.hull, front: K.hullDk });
  b.block({ x: 0, y: 1.18, z: 3.65, w: 1.3, d: 1.15, h: 0.4, tw: 1.1, td: 0.95, bev: 0.05, top: K.plate, bevS: K.brassLt, side: K.hullDk });
  b.decal([[-0.62, 1.5, 3.02], [0.62, 1.5, 3.02], [0.6, 1.3, 3.08], [-0.6, 1.3, 3.08]], G_SUN, [0, 0.3, -1]);
  b.decal([[-0.9, 1.1, 2.58], [0.9, 1.1, 2.58], [0.88, 0.92, 2.6], [-0.88, 0.92, 2.6]], G_SUND, [0, 0.3, -1]);
  b.lathe([0, 1.58, 4.0], [0, 1, 0], [[0, 0.05], [0.12, 0.34], [0.2, 0.38]], 8, (i) => (i === 1 ? K.plateLt : K.plate), null, K.plateDk);
  // ---- turret pads
  for (const [x, z] of HE_TURRETS) b.lathe([x, 0.62, z], [0, 1, 0], [[0, 0.62], [0.12, 0.6], [0.14, 0.5]], 8, (i) => (i === 0 ? K.hullDk : K.brassDk), null, K.hull, { phase: Math.PI / 8 });
  // ---- the drive block and three drive bells
  b.block({ x: 0, y: -0.45, z: 5.9, w: 3.6, d: 1.3, h: 1.05, tw: 3.3, td: 1.2, bev: 0.08, top: K.hull, bevS: K.brassDk, side: K.hullDk, back: K.hullXDk });
  const f0 = b.n;
  // (right side; mirrored) flank sponson for the flare launcher, the wing pivot housing, radiator fins, the outer bell
  b.block({ x: 2.3, y: -0.05, z: HE_FLARE[2], w: 0.9, d: 1.5, h: 0.5, tw: 0.8, td: 1.3, bev: 0.05, top: K.plate, bevS: K.brass, side: K.hull });
  b.lathe([HE_PIVOT[0], 0.0, HE_PIVOT[2]], [0, 1, 0], [[0, 0.52], [0.34, 0.5], [0.46, 0.4], [0.5, 0.2]], 10, (i, j) => (i === 1 ? ((j & 1) ? K.brass : K.brassLt) : i === 0 ? K.hullDk : K.hullXDk), null, G_SUND, { phase: Math.PI / 10 });
  for (let k = 0; k < 3; k++) {
    const r = b.n, z = 3.4 + k * 0.75;
    b.plate([[2.05, z - 0.28], [3.15 - k * 0.12, z - 0.12], [3.15 - k * 0.12, z + 0.12], [2.05, z + 0.28]], 0.0, 0.08, k === 1 ? G_SUND : K.hullDk, K.brassDk, K.hullXDk);
    b.xform(r, M(2.05, 0.04, z, 0, 0, 0.35).multiply(M(-2.05, -0.04, -z)));
  }
  b.lathe([1.12, 0.05, 6.5], [0, 0, 1], [[0, 0.52], [0.2, 0.56], [0.52, 0.44]], 10, (i) => (i === 0 ? K.brassDk : i === 1 ? K.hull : K.hullDk), null, G_SUN, { phase: Math.PI / 10 });
  b.block({ x: 1.7, y: 0.72, z: 2.6, w: 0.05, d: 0.05, h: 1.0, top: G_RD, side: K.plateDk });
  b.mirrorX(f0);
  b.lathe([0, 0.05, 6.5], [0, 0, 1], [[0, 0.6], [0.24, 0.64], [0.6, 0.5]], 10, (i) => (i === 0 ? K.brassDk : i === 1 ? K.hull : K.hullDk), null, G_SUNH, { phase: Math.PI / 10 });
  return b;
}
function buildHeliosTurret() {   // part-local, twin barrels along −z
  const b = new GB();
  b.lathe([0, -0.02, 0], [0, 1, 0], [[0, 0.56], [0.1, 0.55], [0.18, 0.44], [0.22, 0.0]], 8, (i, j) => (i === 0 ? K.hullDk : i === 1 ? ((j & 1) ? K.brass : K.brassLt) : K.hullXDk), null, null, { phase: Math.PI / 8 });
  b.block({ x: 0, y: 0.12, z: 0.06, w: 0.78, d: 0.9, h: 0.34, tw: 0.62, td: 0.72, oz: 0.06, bev: 0.05, top: K.plate, bevS: K.brass, side: K.hull, front: K.hullDk });
  for (const x of [-0.15, 0.15]) {
    b.lathe([x, 0.28, -0.36], [0, 0, -1], [[0, 0.075], [0.66, 0.062], [0.66, 0.08], [0.8, 0.08], [0.8, 0.035]], 6, (i) => (i === 2 ? K.brassLt : K.hullDk), null, G_SUNH, { phase: Math.PI / 6 });
  }
  b.decal([[-0.18, 0.462, 0.05], [0.18, 0.462, 0.05], [0.18, 0.462, 0.3], [-0.18, 0.462, 0.3]], K.copper);
  b.decal([[-0.14, 0.462, -0.26], [0.14, 0.462, -0.26], [0.1, 0.462, -0.15], [-0.1, 0.462, -0.15]], G_SUN);
  return b;
}
function buildHeliosFlare() {   // part-local: a squat launcher, the mortar tube raised up and forward (−z)
  const b = new GB();
  b.block({ x: 0, y: 0, z: 0.05, w: 1.0, d: 1.2, h: 0.4, tw: 0.86, td: 1.02, bev: 0.05, top: K.plate, bevS: K.brass, side: K.hull, front: K.hullDk });
  const dir = [0, 0.8, -0.6];
  b.lathe([0, 0.3, 0.2], dir, [[0, 0.36], [0.2, 0.34], [0.22, 0.3], [0.86, 0.28], [0.9, 0.34], [1.02, 0.34], [1.02, 0.22]], 8,
    (i, j) => (i === 4 ? K.brassLt : i === 1 ? K.brassDk : (j & 1) ? K.hull : K.hullLt), null, G_SUNH, { phase: Math.PI / 8 });
  for (const sg of [-1, 1]) b.block({ x: 0.38 * sg, y: 0.2, z: 0.25, w: 0.1, d: 0.7, h: 0.5, tw: 0.08, td: 0.4, oz: -0.12, top: K.brass, side: K.hullDk });
  b.decal([[-0.36, 0.401, 0.42], [0.36, 0.401, 0.42], [0.36, 0.401, 0.56], [-0.36, 0.401, 0.56]], G_SUND);
  return b;
}
/** a corona wing (part-local: the hit centre at the origin; the pivot at (−HE_WING.c, 0, 0), the fan along +x):
 *  collector glass in two bands between brass ribs, a scalloped rim of sun rays with an emitter at each tip */
function buildHeliosWing() {
  const b = new GB();
  const { r0, r1, tip, half } = HE_WING, rm = (r0 + r1) * 0.52, NS = 5;
  const P = (r, a, y = 0.06) => [Math.cos(a) * r, y, Math.sin(a) * r];
  const A = (k) => -half + (2 * half * k) / NS;
  // underside and edge (one dark plate over the whole fan)
  const out = [];
  for (let k = 0; k <= NS; k++) out.push([Math.cos(A(k)) * r1, Math.sin(A(k)) * r1]);
  for (let k = NS; k >= 0; k--) out.push([Math.cos(A(k)) * r0, Math.sin(A(k)) * r0]);
  b.plate(out, -0.08, 0.04, K.hullDk, K.brassDk, K.hullXDk);
  // the glass, two bands per sector
  for (let k = 0; k < NS; k++) {
    const a0 = A(k) + 0.02, a1 = A(k + 1) - 0.02;
    b.quadN(P(r0 + 0.1, a0), P(rm, a0), P(rm, a1), P(r0 + 0.1, a1), [0, 1, 0], k & 1 ? HE_GLASS2 : HE_GLASS);
    b.quadN(P(rm + 0.08, a0), P(r1 - 0.1, a0), P(r1 - 0.1, a1), P(rm + 0.08, a1), [0, 1, 0], k & 1 ? HE_GLASS : HE_GLASS2);
  }
  // brass ribs along the sector edges, a brass band across the middle, a lit rim
  for (let k = 0; k <= NS; k++) {
    const a = A(k), c = Math.cos(a), s = Math.sin(a), w = k === 0 || k === NS ? 0.09 : 0.06;
    b.quadN([c * r0 - s * w, 0.075, s * r0 + c * w], [c * r1 - s * w, 0.075, s * r1 + c * w], [c * r1 + s * w, 0.075, s * r1 - c * w], [c * r0 + s * w, 0.075, s * r0 - c * w], [0, 1, 0], k === 0 ? K.brassLt : K.brass);
  }
  for (let k = 0; k < NS; k++) {
    b.quadN(P(rm - 0.04, A(k), 0.07), P(rm + 0.06, A(k), 0.07), P(rm + 0.06, A(k + 1), 0.07), P(rm - 0.04, A(k + 1), 0.07), [0, 1, 0], K.brassDk);
    b.quadN(P(r1 - 0.1, A(k), 0.07), P(r1, A(k), 0.07), P(r1, A(k + 1), 0.07), P(r1 - 0.1, A(k + 1), 0.07), [0, 1, 0], G_SUND);
  }
  // the rays: a spike out of the rim at the middle of each sector, an emitter at its tip
  for (let k = 0; k < NS; k++) {
    const a = (A(k) + A(k + 1)) / 2, w = 0.2;
    const base = [P(r1 - 0.05, a - w / r1 * 2.2, 0.02), P(r1 - 0.05, a + w / r1 * 2.2, 0.02), P(r1 - 0.05, a, 0.14)];
    b.spike(base, P(tip, a, 0.04), (q) => (q === 2 ? K.plateLt : q ? K.brass : K.brassLt));
    const t = P(tip - 0.12, a, 0.05);
    b.block({ x: t[0], y: 0.0, z: t[2], w: 0.2, d: 0.2, h: 0.12, top: G_SUNH, side: G_SUN });
  }
  // the root: a brass knuckle round the pivot
  b.lathe([0, -0.1, 0], [0, 1, 0], [[0, 0.62], [0.24, 0.58], [0.3, 0.3]], 8, (i) => (i === 0 ? K.brassDk : K.brass), null, K.hullDk);
  b.xform(0, M(-HE_WING.c, 0, 0));
  return b;
}
/** one armour petal of the core (petal-local: its hinge on the collar rim along z at the origin, the petal leaning
 *  in over the well toward −x; four of them, turned about the well, close into a dome) */
function buildHeliosPetal() {
  const b = new GB();
  const R = 1.2, N = 4, rows = [[0, 1.0, 0.0], [0.28, 0.95, 0.34], [0.55, 0.8, 0.62], [0.8, 0.52, 0.82], [0.96, 0.18, 0.92]];
  // quarter-dome shell: rows along the petal's reach (in toward the well's axis and up)
  const rings = rows.map(([u, span, h]) => {
    const pts = [];
    for (let k = 0; k <= N; k++) { const a = (k / N - 0.5) * (Math.PI / 2) * span; pts.push([-u * R * Math.cos(a), h * 0.9, Math.sin(a) * R * (1 - u * 0.2)]); }
    return pts;
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < N; k++) {
      const st = i === 0 ? K.brassDk : k === 0 || k === N - 1 ? K.plateDk : (i + k) & 1 ? K.plateLt : K.plate;
      b.quadO(rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k], [-R * 0.5, -0.4, 0], st);
      b.quadO(rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k], [-R * 0.5, 2.0, 0], K.hullXDk);
    }
  }
  // a gold seam down the middle and a sun mark near the tip
  const m0 = rings[1][2], m1 = rings[3][2];
  b.decal([[m0[0] + 0.01, m0[1] + 0.02, -0.05], [m1[0] + 0.01, m1[1] + 0.02, -0.04], [m1[0] + 0.01, m1[1] + 0.02, 0.04], [m0[0] + 0.01, m0[1] + 0.02, 0.05]], G_SUND, [-0.4, 1, 0]);
  return b;
}
/** the star's corona (additive, flat): a glow disc and long uneven rays */
function buildHeliosHalo() {
  const pos = [], col = [];
  const N = 14, hot = [1.3, 0.8, 0.3], mid = [0.9, 0.35, 0.06], zero = [0, 0, 0];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU, a0 = a - 0.14, a1 = a + 0.14, r = 1.9 + (hash3(k, 2.1, 7.7) * 1.4);
    pos.push(Math.cos(a0) * 1.05, 0, Math.sin(a0) * 1.05, Math.cos(a1) * 1.05, 0, Math.sin(a1) * 1.05, Math.cos(a) * r, 0, Math.sin(a) * r);
    col.push(...mid, ...mid, ...zero);
  }
  const M1 = 20;
  for (let k = 0; k < M1; k++) {
    const a0 = (k / M1) * TAU, a1 = ((k + 1) / M1) * TAU;
    pos.push(0, 0, 0, Math.cos(a0) * 2.0, 0, Math.sin(a0) * 2.0, Math.cos(a1) * 2.0, 0, Math.sin(a1) * 2.0);
    col.push(...hot, ...zero, ...zero);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
function createHelios() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  pivot.position.z = HE_SHIFT;   // the unit's centre sits between the core and the bridge (the prow 6 ahead of it)
  const ud = g.userData;
  ud.kind = 'boss:helios';
  ud.radius = 5.0;
  ud.debrisColor = new THREE.Color('#6a5444');
  const allMats = [];
  const mat = (r = 0.55, m = 0.32) => { const x = bodyMat(r, m); allMats.push(x); return x; };
  const hullMat = mat();
  const hull = new THREE.Group(); hull.name = 'hull';
  hull.add(new THREE.Mesh(GG('ext:s6:helios.hull', buildHeliosHull), hullMat));
  pivot.add(hull);
  const flameMat = additiveMat();
  const flames = new THREE.Mesh(G('ext:s6:helios.flames', () => buildFlame([[-1.12, 0.05, 1.3], [0, 0.05, 1.55], [1.12, 0.05, 1.3]], FLAME_SUN_BIG)), flameMat);
  flames.position.set(0, 0, 7.05); flames.userData.noShadow = true; flames.renderOrder = 2;
  hull.add(flames);
  // ---- turrets
  const turKeep = { keep: (x, y, z) => z + 0.3, crumple: 0.1, seed: 71, dir: [0, 0.4, -1], shards: 8, shardSize: 0.2, band: 0.35 };
  const turret = HE_TURRETS.map(([x, z], k) => destructiblePart({ key: 'ext:s6:helios.turret', build: buildHeliosTurret, name: 'turret' + k, radius: 0.78,
    muzzles: [new THREE.Vector3(-0.15, 0.28, -1.2), new THREE.Vector3(0.15, 0.28, -1.2)], wreck: turKeep, sag: [0.12, -0.08, 0.1], pos: [x, 0.66, z], mat: mat() }));
  for (const t of turret) { t.rotation.order = 'YXZ'; pivot.add(t); }
  // ---- flare launchers on the flank sponsons
  const flKeep = { keep: (x, y, z) => 0.45 - y, crumple: 0.12, seed: 73, dir: [0, 1, 0], shards: 8, shardSize: 0.22, band: 0.3 };
  const flares = [-1, 1].map((sg) => {
    const m = mat();
    const pt = destructiblePart({ key: 'ext:s6:helios.flare', build: buildHeliosFlare, name: sg < 0 ? 'flareL' : 'flareR', radius: 0.85,
      muzzles: [new THREE.Vector3(0, 1.1, -0.45)], wreck: flKeep, sag: [0.1, -0.1, 0.1 * sg], pos: [HE_FLARE[0] * sg, HE_FLARE[1], HE_FLARE[2]], mat: m });
    let ch = 0;
    /** 0..1: the mortar tube glows (a flare about to go) */
    pt.userData.setCharge = (v) => { ch = Math.max(0, Math.min(1, v)); };
    pt.userData.charge = () => ch;
    pt.userData.mat = m;
    pivot.add(pt);
    return pt;
  });
  // ---- the corona wings on their hinges (the left hinge mirrored)
  const wingKeep = { keep: (x, y, z) => x + 0.6, crumple: 0.16, seed: 79, dir: [1, 0.3, 0], shards: 12, shardSize: 0.3, band: 0.5 };
  const hinges = [], wings = [];
  for (const sg of [1, -1]) {
    const mirror = new THREE.Group(); mirror.scale.x = sg;
    const hinge = new THREE.Object3D(); hinge.name = sg > 0 ? 'hingeR' : 'hingeL';
    hinge.position.set(HE_PIVOT[0], HE_PIVOT[1], HE_PIVOT[2]); hinge.rotation.order = 'YXZ';
    hinge.userData.muzzles = [new THREE.Vector3(0, 0, 0)];
    const m = mat(0.5, 0.35);
    const w = destructiblePart({ key: 'ext:s6:helios.wing', build: buildHeliosWing, name: sg > 0 ? 'wingR' : 'wingL', radius: 1.8,
      muzzles: [-2, -1, 0, 1, 2].map((q) => { const a = (q * 2 * HE_WING.half) / 5; return new THREE.Vector3(Math.cos(a) * HE_WING.tip - HE_WING.c, 0.1, Math.sin(a) * HE_WING.tip); }),
      wreck: wingKeep, sag: [0.1, -0.25, -0.25], pos: [HE_WING.c, 0, 0], mat: m });
    let ch = 0;
    /** 0..1: the collector glass lights up */
    w.userData.setCharge = (v) => { ch = Math.max(0, Math.min(1, v)); };
    w.userData.charge = () => ch;
    w.userData.mat = m;
    hinge.add(w);
    mirror.add(hinge);
    pivot.add(mirror);
    hinges.push(hinge); wings.push(w);
  }
  // ---- the core: the captive star under four petals, its corona
  const coreMat = mat(0.5, 0.35), starMat = bodyMat(0.4, 0.1);
  const starGeo = GG('ext:s6:helios.star', () => orbGB(0.95, 0, SUNH, 11.3)), starDead = GG('ext:s6:helios.starDead', () => orbGB(0.85, 0, SUNH, 13.7, true));
  const star = new THREE.Mesh(starGeo, starMat);
  const haloMat = additiveMat();
  const halo = new THREE.Mesh(G('ext:s6:helios.halo', buildHeliosHalo), haloMat);
  halo.userData.noShadow = true; halo.renderOrder = 3; halo.visible = false;
  const petalGeo = GG('ext:s6:helios.petal', buildHeliosPetal);
  const petalHinges = [], petals = [];
  for (let k = 0; k < 4; k++) {
    const frame = new THREE.Object3D(); frame.rotation.y = (k * TAU) / 4 + Math.PI / 4;
    const h = new THREE.Object3D(); h.position.set(1.18, 0.02, 0);
    const pm = new THREE.Mesh(petalGeo, coreMat);
    h.add(pm); frame.add(h);
    petalHinges.push({ frame, h }); petals.push(pm);
  }
  const core = makePart('core', 1.25, [{ mesh: star, intact: starGeo, wreck: starDead }, ...petals.map((pm) => ({ mesh: pm, hideOnDestroy: true })), { mesh: halo, hideOnDestroy: true }],
    [new THREE.Vector3(0, 0.4, 0)]);
  for (const ph of petalHinges) core.add(ph.frame);
  core.add(halo);
  core.userData.materials.push(coreMat);
  core.userData.setFlash = flashFn([coreMat, starMat]);
  core.position.set(HE_CORE[0], HE_CORE[1], HE_CORE[2]);
  let openT = 0, heat = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    for (const ph of petalHinges) ph.h.rotation.z = -e * 125 * DEG;
    star.position.y = -0.38 + e * 0.95;   // shut: sunk in the well under the petals; open: risen out of it
    halo.position.y = 0.3 + e * 0.4;
    halo.visible = e > 0.05 && !core.userData.destroyed;
  };
  /** 0..1: the star's heat (swells and whitens; 1 = about to go) */
  ud.setStar = (v) => { heat = Math.max(0, Math.min(1.5, v)); };
  core.userData.setOpen(0);
  pivot.add(core);
  ud.parts = { turret, flareL: flares[0], flareR: flares[1], wingL: wings[1], wingR: wings[0], core };
  ud.hinges = { R: hinges[0], L: hinges[1] };
  ud.muzzles = [new THREE.Vector3(0, 0.34, -7.7 + HE_SHIFT)];   // the prow gun (group-local)
  let spread = 0;
  /** 0: the wings swept back along the flanks … 1: spread square to the hull */
  ud.setWings = (v) => { spread = Math.max(0, Math.min(1, v)); const e = spread * spread * (3 - 2 * spread); for (const h of hinges) h.rotation.y = HE_WING_FOLD * (1 - e); };
  const flashAll = flashFn([...allMats, starMat]);
  ud.setFlash = flashAll;
  // ---- death: 0 = whole … 1 = the wings torn away and falling, the petals flung, the hull broken-backed
  let brk = 0;
  ud.setBreak = (v) => {
    brk = Math.max(0, Math.min(1, v));
    const e = brk * brk * (3 - 2 * brk);
    for (let k = 0; k < 2; k++) { const h = hinges[k]; h.position.set(HE_PIVOT[0] + 1.6 * e, HE_PIVOT[1] - 1.3 * e, HE_PIVOT[2] + (k ? -0.8 : 0.9) * e); h.rotation.x = (k ? 0.5 : -0.4) * e; h.rotation.z = -0.6 * e; }
    for (let k = 0; k < 4; k++) { petalHinges[k].h.position.set(1.18 + 1.8 * e, 0.02 + 0.8 * e, 0); }
    hull.rotation.set(0.12 * e, 0, -0.16 * e);
  };
  ud.setBreak(0);
  /** pooled instances come back posed: whole, wings swept back, petals shut, guns forward, the star at rest */
  ud.reset = () => {
    ud.setBreak(0); ud.setWings(0); heat = 0; core.userData.setOpen(0);
    for (const t of turret) t.rotation.set(0, 0, 0);
    for (const f of flares) f.userData.setCharge(0);
    for (const w of wings) w.userData.setCharge(0);
    star.scale.setScalar(1); halo.scale.setScalar(1);
  };
  ud.reset();
  ud.update = (dt, t) => {
    const p = (0.82 + Math.sin(t * 2.4) * 0.18) * (1 - brk * 0.6);
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = p;
    for (const f of flares) if (!f.userData.destroyed) f.userData.mat.uEmitScale.value = p + f.userData.charge() * (2.4 + Math.sin(t * 40) * 0.5);
    for (const w of wings) if (!w.userData.destroyed) w.userData.mat.uEmitScale.value = p + w.userData.charge() * (5.5 + Math.sin(t * 23) * 1.2);
    const hot = core.userData.destroyed ? 0 : heat;
    starMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.34 + openT * 0.5 + hot * 0.9) * (1 + Math.sin(t * 9) * 0.1);
    star.rotation.y += dt * (0.4 + openT * 1.8 + hot * 3);
    star.scale.setScalar(1 + hot * 0.35 + Math.sin(t * 13) * 0.03 * openT);
    if (halo.visible) { halo.rotation.y -= dt * (0.5 + hot); halo.scale.setScalar((0.8 + openT * 0.35 + hot * 0.6) * (1 + Math.sin(t * 6.3) * 0.05)); haloMat.color.setScalar(0.7 + hot * 0.6 + Math.sin(t * 17) * 0.06); }
    flames.scale.set(1, 1, (1 + Math.sin(t * 37) * 0.08 + Math.sin(t * 23) * 0.05) * (1 - brk * 0.85));
    flameMat.color.setScalar(0.9 + Math.sin(t * 29) * 0.1);
    pivot.position.y = Math.sin(t * 0.55) * 0.12;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); starMat.dispose(); haloMat.dispose(); flameMat.dispose(); };
  return g;
}

export const ENEMIES = {
  s6_raider: createRaider,
  s6_rock: createRock,
  s6_sail: createSail,
  s6_comet: createComet,
  s6_skimmer: createSkimmer,
  s6_flare: createFlare,
  basilisk: createBasilisk,
};
export const BOSSES = { helios: createHelios };
