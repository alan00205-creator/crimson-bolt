// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 7 "GALACTIC STORM" (銀河風暴)
// -----------------------------------------------------------------------------
// models.js registers these tables: createEnemy(type) falls back to ENEMIES[type],
// createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { s7_swarmer, s7_stinger, s7_crystal, s7_gate, leviathan };
//   export const BOSSES = { nemesis };
//
// The Swarm, the galaxy's hive: bio-mechanical carapaces of plum-black chitin under ivory bone
// armour, venom-lime bioluminescence (eyes, veins, spore sacs), crystals of cold cyan light grown
// into their hulls, and the violet of their warp gates (stage 3's gunmetal / cyan, stage 4's white
// ceramic / emerald, stage 5's slate / moonlight blue and stage 6's bronze / gold stay distinct).
// The nebula behind them is bright teal, blue and gold gas over black space, so every unit is
// two-tone: the dark chitin carries the silhouette on the bright gas, the bone plates and the lime
// and cyan glows carry it on black space and the dust rifts.
//
//   S7_SWARMER  bio-mechanical swarm drone (≈ 1.5 long): an armoured insect with two pairs of
//               membrane wings that beat (the wing mesh folds in x), lime compound eyes and a
//               glowing venom sac; userData.setRage(0..1) brightens it (a dive)
//   S7_STINGER  nebula stinger (≈ 2.6 across the blades): a wasp-like fighter whose segmented tail
//               curls forward over its back to strike (userData.setCurl(0..1): 0 trailing, 1 poised;
//               the venom bulb brightens with it). userData.tip is the tail's last segment: its
//               muzzles[0] is the stinger point
//   S7_CRYSTAL  crystal ship (≈ 3.4 long): a chitin cradle gripping a great smoky crystal, a crown of
//               cyan crystal spines that store the light it absorbs (userData.setCharge(0..1):
//               dim → blazing); muzzles at the spine tips (0–5) and the crown (6)
//   S7_GATE     warp gate (≈ 4.5 across): a ring of chitin and bone with four crystal nodes round a
//               swirling violet portal, lying flat under the camera (userData.setOpen(0..1) opens the
//               portal, setPulse(v) flares it); muzzles at the nodes (0–3, they follow the ring's slow
//               turn) and the portal's heart (4)
//   LEVIATHAN   mid-boss — see its section below
//   NEMESIS     boss, the alien mothership — see its section below
//
// Imports: only 'three' and './modelkit.js' — never models.js (import cycle).
// House style and helpers: see the modelkit.js header.
//
// Enemy contract — enemyShell(kind, radius, debrisHex) + bodyMat + GG(key, buildXxx):
//   * nose/front toward −z (the game yaws units that face the player by π), up +y,
//     centred on the origin. Inside the Galaxy: AIR UNITS ONLY (no userData.ground)
//   * userData: kind (the registry sets it to the type), radius, debrisColor, muzzles
//     (group-local Vector3[], refreshed in update() when they move), setFlash(v),
//     update(dt, t), dispose() (materials only)
//   * gameplay numbers (hp, score, collision radius) live in stage7.js ENEMY, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (userData.midboss)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) fully restores the pose
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
// Cache keys: 'ext:s7:<name>'.
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, S, DEG, TAU, lit, lin, rgb, GL, scl, hash3, bodyMat, additiveMat, flashFn, enemyShell,
  makePart, destructiblePart, wreckGeo, buildFlame,
} from './modelkit.js';

// =============================================================================
// palette + shared helpers
// =============================================================================
const K = {
  chit: lit('#3b2a46'), chitLt: lit('#57405f'), chitDk: lit('#261a2e'), chitXDk: lit('#150e1a'),
  bone: lit('#9a8e74'), boneLt: lit('#b0a488'), boneDk: lit('#6e6452'),
  memb: lit('#2a1e33'), membLt: lit('#3e2d4a'),                         // wing membranes
  smoke: S(lin('#1d2634'), rgb(0.012, 0.04, 0.06)), smokeLt: S(lin('#30445a'), rgb(0.02, 0.07, 0.1)),   // smoky crystal
  black: lit('#0a070c'),
};
const VEN = rgb(0.62, 1.0, 0.14, 3.2);     // venom lime: eyes, veins, spore sacs
const VENH = rgb(0.86, 1.0, 0.56, 4.2);    // white-hot lime (sacs at full, the heart)
const VEND = rgb(0.5, 0.9, 0.1, 1.6);      // dim veins
const XT = rgb(0.42, 0.88, 1.0, 3.2);      // crystal cyan
const XTH = rgb(0.8, 0.96, 1.0, 4.2);      // white-hot crystal
const WARP = rgb(0.62, 0.32, 1.0, 3.0);    // warp violet
const G_VEN = GL(VEN, 0.4), G_VENH = GL(VENH, 0.5), G_VEND = GL(VEND, 0.3);
const G_WARP = GL(WARP, 0.4);
const G_EMBER = GL(rgb(1.0, 0.1, 0.01, 0.6), 0.3);
// lime bio-drive exhaust (additive cones, see modelkit buildFlame)
const FLAME_BIO = [
  { r: 0.3, len: 1.3, base: rgb(0.5, 1.0, 0.2, 1.0), tip: rgb(0.15, 0.4, 0.05, 0.0), sides: 7 },
  { r: 0.16, len: 0.7, base: rgb(0.85, 1.0, 0.6, 1.5), tip: rgb(0.4, 0.8, 0.1, 0.05), sides: 6 },
];

/** 10-point armoured section with a flat top [z, halfWidth, top, bottom]. Edges: 0 top, 1/9 bevels, 2/8 upper
 *  flanks, 3/7 lower flanks, 4/6 chines, 5 keel */
function ring10([z, w, tp, bt], y = 0) {
  return [[-w * 0.36, y + tp, z], [w * 0.36, y + tp, z], [w * 0.8, y + tp * 0.78, z], [w, y + tp * 0.3, z], [w * 0.86, y - bt * 0.4, z],
    [w * 0.45, y - bt, z], [-w * 0.45, y - bt, z], [-w * 0.86, y - bt * 0.4, z], [-w, y + tp * 0.3, z], [-w * 0.8, y + tp * 0.78, z]];
}
/** 8-point section [z, halfWidth, top, bottom]. Edges: 0/7 top, 1/6 shoulders, 2/5 flanks, 3/4 belly */
function ring8([z, w, tp, bt], y = 0) {
  return [[0, y + tp, z], [w * 0.55, y + tp * 0.82, z], [w, y + tp * 0.18, z], [w * 0.68, y - bt * 0.75, z],
    [0, y - bt, z], [-w * 0.68, y - bt * 0.75, z], [-w, y + tp * 0.18, z], [-w * 0.55, y + tp * 0.82, z]];
}
/** point on the cubic bezier a-b-c-d (arrays) at t */
function bez3(a, b, c, d, t) {
  const u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [a[0] * k0 + b[0] * k1 + c[0] * k2 + d[0] * k3, a[1] * k0 + b[1] * k1 + c[1] * k2 + d[1] * k3, a[2] * k0 + b[2] * k1 + c[2] * k2 + d[2] * k3];
}
/** n-point ring (default 8) of radius r (flattened by squash) centred on c, perpendicular to the tangent t; point 0 on
 *  top, so facet 0 and facet n − 1 are the two upper faces */
function tubeRing(c, t, r, squash = 0.8, n = 8) {
  const tl = Math.hypot(t[0], t[1], t[2]) || 1, tx = t[0] / tl, ty = t[1] / tl, tz = t[2] / tl;
  const sl = Math.hypot(tz, tx) || 1, sx = -tz / sl, sz = tx / sl;                     // side = t × up
  const ux = -tx * ty / sl, uy = (tx * tx + tz * tz) / sl, uz = -tz * ty / sl;          // up' = side × t
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = Math.PI / 2 - (k * TAU) / n, cs = Math.cos(a) * r, sn = Math.sin(a) * r * squash;
    out.push([c[0] + sx * cs + ux * sn, c[1] + uy * sn, c[2] + sz * cs + uz * sn]);
  }
  return out;
}
/** tube along the bezier P = [p0, p1, p2, p3] at params T (rings of radius rad(t), `sides` points); style(i, j) as GB.loft */
function tube(b, P, T, rad, style, capA = null, capB = null, squash = 0.8, sides = 8) {
  const rings = T.map((t) => {
    const c = bez3(P[0], P[1], P[2], P[3], t), c2 = bez3(P[0], P[1], P[2], P[3], Math.min(1, t + 0.02)), c1 = bez3(P[0], P[1], P[2], P[3], Math.max(0, t - 0.02));
    return tubeRing(c, [c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]], rad(t), squash, sides);
  });
  b.loft(rings, style, capA, capB);
}
const polar = (r, a, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
/** flat strip of half-width w from (x0, z0) to (x1, z1) at height y, facing up */
function strip(b, x0, z0, x1, z1, y, w, style) {
  const L = Math.hypot(x1 - x0, z1 - z0) || 1, nx = -(z1 - z0) / L * w, nz = (x1 - x0) / L * w;
  b.decal([[x0 + nx, y, z0 + nz], [x1 + nx, y, z1 + nz], [x1 - nx, y, z1 - nz], [x0 - nx, y, z0 - nz]], style);
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
/** crystal: an n-sided prism with a pointed tip from `base` along `dir`; its facets glow cyan (× glow),
 *  brightness seeded per facet */
function crystal(b, base, dir, len, r, seed, glow = 1, n = 6) {
  b.lathe(base, dir, [[0, r * 0.62], [len * 0.14, r], [len * 0.7, r * 0.86], [len, 0]], n, (i, j) => {
    const k = hash3(i * 3.1 + seed, j * 1.7, seed * 0.37);
    if (i === 0) return K.chitDk;
    if (i === 2) return GL(scl(XTH, (0.5 + 0.3 * k) * glow), 0.55);
    return GL(scl(XT, (k > 0.66 ? 0.9 : k > 0.33 ? 0.6 : 0.38) * glow), 0.55);
  }, K.chitXDk, null, { phase: seed });
}
/** a curved spike (horn, fang, mandible point): a tapering tube of `sides` faces along the bezier P, n segments */
function horn(b, P, r0, style, n = 4, sides = 5) {
  const T = [];
  for (let k = 0; k <= n; k++) T.push(k / n);
  tube(b, P, T, (t) => r0 * (1 - t * 0.92), style, style, null, 0.85, sides);
}
/** faceted glowing orb (icosahedron), per-face brightness jitter; centre (0, cy, 0). em = the hue, em2 a second
 *  hue on a few faces; dead = dark and cracked */
function orbGB(r, cy, em, em2, seed, dead = false) {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const k = hash3(i / 9, seed, 3.1);
    const st = dead ? (k > 0.8 ? G_EMBER : S(lin(k > 0.4 ? '#1c1520' : '#2c2230')))
      : GL(scl(k > 0.82 ? em2 : em, k > 0.7 ? 1.0 : k > 0.35 ? 0.72 : 0.46), 0.55);
    const d = (v) => (dead ? [p[v] * (0.9 + k * 0.15), p[v + 1] * 0.78 + cy * 0.8, p[v + 2] * (0.9 + k * 0.15)] : [p[v], p[v + 1] + cy, p[v + 2]]);
    b.triO(d(i), d(i + 3), d(i + 6), [0, cy, 0], st);
  }
  geo.dispose();
  return b;
}
/** chitin face with a seeded shade (living carapace is never one flat colour) */
function chitJ(i, j, seed) { const k = hash3(i * 1.7 + seed, j * 2.3, seed); return k > 0.7 ? K.chitLt : k > 0.3 ? K.chit : K.chitDk; }
/** RGBA vertex-alpha beam along −z from the origin (unit length: the mesh is scaled to its length). Normal
 *  blended so it reads over the bright gas: an HDR core that still blooms, a translucent halo, fading with
 *  distance. RGBA vertex colours: the same program as the hornet's rotor disc and stage 4's beams. */
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
function beamMesh(key, len, w, halo, core, hot, edge) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(G(key, () => buildBeam(w, halo, core, hot, edge)), mat);
  m.name = 'beam'; m.visible = false; m.renderOrder = 3; m.userData.noShadow = true; m.frustumCulled = false;
  m.scale.z = 1e-4;
  m.userData.set = (v) => { const on = v > 0.01; m.visible = on; m.scale.z = on ? len : 1e-4; mat.opacity = Math.min(1, v); };
  return { m, mat };
}

// =============================================================================
// S7_SWARMER — bio-mechanical swarm drone (≈ 1.5 long, 1.9 across the wings)
// =============================================================================
function buildSwarmer() {
  const b = new GB();
  // body: head → thorax → waist → abdomen in one flattened lathe along +z (8 facets: j = 1 on top, 5 underneath)
  const P = [[-0.66, 0.0], [-0.6, 0.08], [-0.5, 0.16], [-0.38, 0.19], [-0.3, 0.14], [-0.22, 0.24], [0.0, 0.28], [0.12, 0.21], [0.18, 0.1],
    [0.24, 0.18], [0.36, 0.27], [0.5, 0.27], [0.62, 0.2], [0.72, 0.1], [0.8, 0.0]];
  b.lathe([0, 0, 0], [0, 0, 1], P, 8, (i, j) => {
    const top = j === 1, sh = j === 0 || j === 2, low = j >= 4 && j <= 6;
    if (i <= 2) return top ? K.boneDk : low ? K.chitXDk : K.chitDk;                       // head
    if (i === 3) return K.chitXDk;                                                          // neck
    if (i >= 4 && i <= 6) return top ? K.boneLt : sh ? K.bone : low ? K.chitXDk : K.chit;  // thorax: bone plates
    if (i === 7) return K.chitXDk;                                                          // waist
    if (top || sh) return i === 10 && top ? G_VEN : i === 9 || i === 11 ? G_VEND : i === 13 ? K.boneDk : K.chit;   // abdomen: the venom sac shows in bands
    return low ? K.chitXDk : K.chitDk;
  }, null, null, { phase: Math.PI / 8, sy: 0.72 });
  // compound eyes on the head, a sting at the tail
  for (const sg of [-1, 1]) {
    const x = sg * 0.09, z = -0.44;
    b.spike([[x - 0.06, 0.07, z - 0.06], [x + 0.06, 0.07, z - 0.06], [x + 0.06, 0.07, z + 0.06], [x - 0.06, 0.07, z + 0.06]], [x + sg * 0.02, 0.15, z], G_VEN);
  }
  b.spike([[-0.04, 0.02, 0.76], [0.04, 0.02, 0.76], [0.0, -0.03, 0.76]], [0, 0, 0.98], K.boneLt);
  // back spines on the thorax
  for (const z of [-0.14, 0.02]) b.spike([[-0.05, 0.17, z - 0.05], [0.05, 0.17, z - 0.05], [0, 0.17, z + 0.07]], [0, 0.3, z + 0.12], K.boneLt);
  // mandibles: two hooked prongs curving in ahead of the head
  const f0 = b.n;
  horn(b, [[0.1, 0.0, -0.5], [0.16, 0.0, -0.66], [0.11, -0.01, -0.8], [0.03, -0.02, -0.86]], 0.05, K.boneLt, 3);
  // legs folded under: short bone spurs out to the sides (they read at the flanks from above)
  for (const [z, a] of [[-0.18, -0.4], [-0.02, 0.0], [0.1, 0.4]]) {
    horn(b, [[0.18, -0.06, z], [0.3, -0.08, z + a * 0.1], [0.4, -0.1, z + a * 0.25], [0.46, -0.16, z + a * 0.4]], 0.035, K.boneDk, 2);
  }
  b.mirrorX(f0);
  return b;
}
function buildSwarmerWings() {   // both pairs (the fore wing long, the hind wing short) above the thorax
  const b = new GB();
  const f0 = b.n;
  b.plate([[0.14, -0.2], [0.55, -0.27], [0.92, -0.16], [1.02, -0.02], [0.72, 0.07], [0.22, 0.04]], 0.13, 0.15, K.memb, K.chitDk, K.chitXDk);
  b.plate([[0.16, 0.06], [0.58, 0.13], [0.8, 0.26], [0.56, 0.36], [0.18, 0.2]], 0.11, 0.13, K.membLt, K.chitDk, K.chitXDk);
  // veins: a lime leading edge and a dim second vein on the fore wing, one on the hind wing
  strip(b, 0.16, -0.19, 0.93, -0.15, 0.152, 0.018, G_VEND);
  strip(b, 0.2, -0.08, 0.84, -0.04, 0.152, 0.012, K.boneDk);
  strip(b, 0.18, 0.1, 0.72, 0.24, 0.132, 0.012, K.boneDk);
  b.mirrorX(f0);
  return b;
}
function createSwarmer() {
  const { g, pivot, ud } = enemyShell('s7_swarmer', 0.7, '#57405f');
  const mat = bodyMat(0.55, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s7:swarmer', buildSwarmer), mat));
  const wings = new THREE.Mesh(GG('ext:s7:swarmer.wings', buildSwarmerWings), mat);
  pivot.add(wings);
  pivot.scale.setScalar(1.12);
  ud.muzzles = [new THREE.Vector3(0, 0, -0.9)];
  const ph = Math.random() * TAU;      // each drone beats out of step with the swarm
  let rage = 0;
  /** 0..1: the sac and eyes flare (a dive) */
  ud.setRage = (v) => { rage = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    const w = Math.abs(Math.sin(t * (24 + rage * 10) + ph));
    wings.scale.x = 0.5 + 0.5 * w;                    // a beat seen from above: the wings fold in and out
    wings.position.y = (1 - w) * 0.08;
    mat.uEmitScale.value = 0.7 + Math.sin(t * 6 + ph) * 0.12 + rage * 0.9;
    pivot.rotation.z = Math.sin(t * 3.1 + ph) * 0.12;
  };
  ud.dispose = () => { mat.dispose(); };
  return g;
}

// =============================================================================
// S7_STINGER — nebula stinger (≈ 2.7 across the blades, 3.3 long with the tail trailing)
// =============================================================================
const ST_TAIL = [0, 0.1, 0.56];     // tail root (pivot of the first segment)
const ST_SEG = 0.82;                // first segment length (pivot of the second)
function buildStinger() {
  const b = new GB();
  const s0 = b.n;
  b.loft([[-1.22, 0.02, 0.02, 0.02], [-1.02, 0.12, 0.1, 0.07], [-0.72, 0.21, 0.17, 0.12], [-0.48, 0.15, 0.13, 0.1], [-0.28, 0.3, 0.22, 0.16],
    [0.12, 0.34, 0.25, 0.18], [0.44, 0.25, 0.19, 0.14], [0.62, 0.13, 0.13, 0.1]].map((s) => ring8(s)), (i, j) => {
    const top = j === 0 || j === 7, sh = j === 1 || j === 6;
    if (i <= 2) return top ? K.boneDk : sh ? K.chitLt : K.chitXDk;                                   // head
    if (i === 3) return top ? G_VEND : K.chitXDk;                                                   // neck: a vein on top
    if (top) return i === 5 ? K.boneLt : K.bone;                                                    // thorax armour
    if (sh) return i === 4 ? K.boneDk : chitJ(i, j, 3);
    return j === 3 || j === 4 ? K.chitXDk : K.chitDk;
  }, K.boneLt, K.chitDk);
  const s1 = b.n;
  // eyes: lime slits sweeping back along the head, a crest line on the thorax
  for (const sg of [-1, 1]) b.drape([[[0.03 * sg, -0.98], [0.17 * sg, -0.76], [0.15 * sg, -0.66], [0.02 * sg, -0.86]]], G_VEN, s0, s1, 0.008, 2);
  b.drape(stripe([[0, -0.24], [0, 0.44]], 0.035), K.boneDk, s0, s1, 0.008, 1);
  const f0 = b.n;
  // scythe blades: swept, armoured wings (bone leading edge, dark membrane, a lime vein)
  const w0 = b.n;
  b.wing([{ x: 0.26, y: 0.0, zl: -0.3, zt: 0.34, t: 0.12 }, { x: 0.78, y: 0.03, zl: -0.06, zt: 0.5, t: 0.07 },
    { x: 1.22, y: 0.06, zl: 0.32, zt: 0.64, t: 0.03 }, { x: 1.36, y: 0.07, zl: 0.62, zt: 0.72, t: 0.01 }], (i, j) => {
    if (j === 0) return K.boneLt;
    if (j >= 4) return K.chitXDk;
    return j === 1 ? K.bone : i === 0 ? K.memb : K.membLt;
  }, null, K.chitDk);
  const w1 = b.n;
  b.drape(stripe([[0.3, 0.06], [0.82, 0.24], [1.22, 0.5]], 0.02), G_VEND, w0, w1, 0.006, 1);
  // mandible prongs at the nose, a pair of short fore-legs (spurs) under the head
  horn(b, [[0.07, -0.02, -0.9], [0.14, -0.02, -1.12], [0.1, -0.03, -1.3], [0.03, -0.04, -1.38]], 0.05, K.boneLt, 3);
  horn(b, [[0.2, -0.08, -0.34], [0.36, -0.12, -0.42], [0.46, -0.16, -0.56], [0.5, -0.2, -0.72]], 0.04, K.boneDk, 2);
  b.mirrorX(f0);
  return b;
}
function buildStingerTailA() {    // pivot-local: along +z from the root, three plates on glowing joints
  const b = new GB();
  b.lathe([0, 0, 0], [0, 0, 1], [[0, 0.15], [0.1, 0.17], [0.24, 0.14], [0.27, 0.11], [0.38, 0.15], [0.52, 0.12], [0.55, 0.1], [0.66, 0.13], [0.8, 0.1], [0.84, 0.08]], 8,
    (i, j) => (i === 2 || i === 5 || i === 8 ? (j === 1 ? G_VEND : K.chitXDk) : j === 1 ? K.boneLt : j === 0 || j === 2 ? K.bone : j >= 4 && j <= 6 ? K.chitXDk : K.chit),
    K.chitDk, K.chitXDk, { phase: Math.PI / 8, sy: 0.85 });
  return b;
}
function buildStingerTailB() {    // pivot-local: the last plate, the venom bulb and the sting (point at z ≈ 1.0)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 0, 1], [[0, 0.09], [0.12, 0.11], [0.22, 0.09], [0.26, 0.13], [0.4, 0.19], [0.54, 0.15], [0.62, 0.07], [0.66, 0.0]], 8,
    (i, j) => {
      if (i === 3 || i === 4) return j === 1 || j === 0 || j === 2 ? G_VENH : G_VEN;     // the venom bulb
      if (i === 5) return j === 1 ? K.boneLt : K.bone;
      return j === 1 ? K.boneLt : j >= 4 && j <= 6 ? K.chitXDk : K.chit;
    }, K.chitDk, null, { phase: Math.PI / 8, sy: 0.85 });
  // the sting: a bone spike, curved down a little, a lime point
  horn(b, [[0, 0.02, 0.6], [0, 0.03, 0.74], [0, 0.0, 0.88], [0, -0.05, 0.98]], 0.07, K.boneLt, 3);
  b.spike([[-0.02, -0.03, 0.9], [0.02, -0.03, 0.9], [0, 0.0, 0.9]], [0, -0.06, 1.02], G_VENH);
  return b;
}
function createStinger() {
  const { g, pivot, ud } = enemyShell('s7_stinger', 0.95, '#57405f');
  pivot.scale.setScalar(1.15);
  const mat = bodyMat(0.5, 0.3), tailMat = bodyMat(0.5, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s7:stinger', buildStinger), mat));
  const tailA = new THREE.Group(); tailA.name = 'tailA'; tailA.position.set(ST_TAIL[0], ST_TAIL[1], ST_TAIL[2]);
  tailA.add(new THREE.Mesh(GG('ext:s7:stinger.tailA', buildStingerTailA), tailMat));
  const tailB = new THREE.Group(); tailB.name = 'tailB'; tailB.position.set(0, 0, ST_SEG);
  tailB.add(new THREE.Mesh(GG('ext:s7:stinger.tailB', buildStingerTailB), tailMat));
  tailA.add(tailB);
  pivot.add(tailA);
  tailB.userData.muzzles = [new THREE.Vector3(0, -0.06, 1.02)];
  ud.tip = tailB;
  ud.muzzles = [new THREE.Vector3(0, 0, -1.3)];
  let curl = 0;
  /** 0..1: the tail curls up and over the back (1 = poised to strike, the venom bulb blazing) */
  ud.setCurl = (v) => { curl = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat, tailMat]);
  ud.update = (dt, t) => {
    const c = curl * curl * (3 - 2 * curl), sway = Math.sin(t * 2.3) * (1 - c);
    tailA.rotation.set(-0.12 - c * 1.62 + Math.sin(t * 1.7) * 0.06 * (1 - c), sway * 0.25, 0);
    tailB.rotation.set(-0.1 - c * 1.38, sway * 0.3, 0);
    mat.uEmitScale.value = 0.75 + Math.sin(t * 4) * 0.12;
    tailMat.uEmitScale.value = 0.45 + c * (1.5 + Math.sin(t * 38) * 0.3);
    pivot.rotation.z = Math.sin(t * 2.6) * 0.07;
  };
  ud.dispose = () => { mat.dispose(); tailMat.dispose(); };
  ud.update(0, 0);
  return g;
}

// =============================================================================
// S7_CRYSTAL — crystal ship (≈ 3.4 long, 3.0 across the spines)
// =============================================================================
// the spine crystals: [base x, y, z, dir x, y, z, len, r]; the right side (the left is mirrored), then the crown
const CR_SPINE = [[0.5, 0.18, -0.7, 0.9, 0.42, -0.32, 1.05, 0.15], [0.6, 0.2, 0.05, 1.0, 0.45, 0.12, 1.3, 0.18], [0.44, 0.16, 0.8, 0.8, 0.4, 0.55, 1.0, 0.14]];
const CR_CROWN = [0, 0.34, -0.15, 0.0, 1.0, 0.35, 0.8, 0.16];
function buildCrystalShip() {
  const b = new GB();
  // the great crystal: an elongated hexagonal bipyramid (a ridge on top), smoky with a band of light inside
  b.lathe([0, 0, 0], [0, 0, 1], [[-1.85, 0], [-1.0, 0.5], [-0.3, 0.7], [0.5, 0.6], [1.55, 0]], 6, (i, j) => {
    const k = hash3(i * 2.3, j * 1.9, 5.1);
    if (i === 1 || i === 2) return (j === 1 || j === 2) ? GL(scl(XT, 0.42 + k * 0.2), 0.5) : k > 0.5 ? K.smokeLt : K.smoke;
    return (j & 1) ? K.smoke : K.smokeLt;
  }, null, null, { phase: Math.PI / 2, sy: 0.6 });
  // the cradle: a bone keel under it, chitin claws gripping its flanks from the stern forward
  b.lathe([0, -0.34, -1.3], [0, 0.08, 1], [[0, 0.02], [0.3, 0.12], [1.9, 0.14], [2.5, 0.05]], 5, (i, j) => (j === 1 ? K.boneDk : K.chitXDk), null, K.chitDk);
  const f0 = b.n;
  tube(b, [[0.1, -0.36, 1.25], [0.9, -0.3, 0.9], [0.95, -0.02, -0.35], [0.46, 0.2, -1.2]], [0, 0.25, 0.5, 0.75, 1], (t) => 0.13 - t * 0.07,
    (i, j) => (j === 0 || j === 5 ? (i & 1 ? K.bone : K.boneDk) : i === 1 && j === 1 ? G_VEND : chitJ(i, j, 9)), K.chitDk, null, 0.8, 6);
  tube(b, [[0.08, -0.34, 1.1], [0.62, -0.42, 1.25], [0.9, -0.2, 1.5], [0.66, 0.06, 1.75]], [0, 0.5, 1], (t) => 0.1 - t * 0.06,
    (i, j) => (j === 0 || j === 4 ? K.bone : chitJ(i, j, 11)), K.chitDk, null, 0.8, 5);
  b.spike([[0.52, 0.16, -1.1], [0.4, 0.26, -1.16], [0.38, 0.12, -1.2]], [0.1, 0.26, -1.64], K.boneLt);
  b.mirrorX(f0);
  return b;
}
function buildCrystalSpines() {   // the charge crystals (their own material: they blaze as it charges)
  const b = new GB();
  const f0 = b.n;
  // baked at half glow: the material's emit scale carries the charge (dim cyan → blazing white)
  CR_SPINE.forEach(([x, y, z, dx, dy, dz, len, r], k) => crystal(b, [x, y, z], [dx, dy, dz], len, r, 1.7 + k * 2.3, 0.55, 5));
  // a small crystal between the front and middle spines
  crystal(b, [0.42, 0.18, -0.32], [0.6, 0.7, -0.2], 0.5, 0.08, 9.1, 0.45, 4);
  b.mirrorX(f0);
  const [x, y, z, dx, dy, dz, len, r] = CR_CROWN;
  crystal(b, [x, y, z], [dx, dy, dz], len, r, 12.7, 0.65);
  return b;
}
/** spine tip (group-local, before the pivot scale) */
function crTip(c, sx = 1) {
  const l = Math.hypot(c[3], c[4], c[5]);
  return new THREE.Vector3(sx * (c[0] + (c[3] / l) * c[6]), c[1] + (c[4] / l) * c[6], c[2] + (c[5] / l) * c[6]);
}
function createCrystalShip() {
  const { g, pivot, ud } = enemyShell('s7_crystal', 1.6, '#30445a');
  const mat = bodyMat(0.35, 0.2), spMat = bodyMat(0.3, 0.1);
  pivot.add(new THREE.Mesh(GG('ext:s7:crystal', buildCrystalShip), mat));
  const spines = new THREE.Mesh(GG('ext:s7:crystal.spines', buildCrystalSpines), spMat);
  pivot.add(spines);
  const SC = 1.05;
  pivot.scale.setScalar(SC);
  ud.halfExtents = { x: 1.6, z: 1.9 };
  ud.muzzles = [...CR_SPINE.map((c) => crTip(c, 1)), ...CR_SPINE.map((c) => crTip(c, -1)), crTip(CR_CROWN)].map((v) => v.multiplyScalar(SC));
  let charge = 0;
  /** 0..1: the spines store light (dim → blazing) */
  ud.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  ud.setFlash = flashFn([mat, spMat]);
  ud.update = (dt, t) => {
    mat.uEmitScale.value = 0.75 + charge * 0.6 + Math.sin(t * 2.2) * 0.1;
    spMat.uEmitScale.value = 0.4 + charge * 2.1 + charge * charge * Math.sin(t * 34) * 0.5;
    pivot.rotation.z = Math.sin(t * 0.9) * 0.06;
    pivot.rotation.x = Math.sin(t * 0.7) * 0.04;
  };
  ud.dispose = () => { mat.dispose(); spMat.dispose(); };
  ud.setCharge(0);
  return g;
}

// =============================================================================
// S7_GATE — warp gate (≈ 4.5 across): a ring round a swirling portal, lying flat (facing the camera)
// =============================================================================
const GT_R = [1.5, 2.2];                                 // ring inner / outer radius
const GT_RM = (GT_R[0] + GT_R[1]) / 2;
const GT_NODE = [0.25, 0.75, 1.25, 1.75].map((k) => k * Math.PI);
function buildGateRing() {
  const b = new GB();
  // the ring: a loft of cross-sections round the circle (inner lip glowing violet), chitin segments on bone ribs
  const N = 16, [r0, r1] = GT_R, rm = GT_RM;
  const sec = [[r0, 0.0], [r0 + 0.14, 0.22], [rm + 0.1, 0.28], [r1, 0.04], [rm + 0.1, -0.22], [r0 + 0.12, -0.16]];
  const rings = [];
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * TAU, bulge = (k & 1) ? 1 : 1.07;
    rings.push(sec.map(([r, y]) => [Math.cos(a) * (rm + (r - rm) * bulge), y * bulge, Math.sin(a) * (rm + (r - rm) * bulge)]));
  }
  b.loft(rings, (i, j) => {
    if (j === 5 || j === 0) return G_WARP;                     // the inner lip: violet light
    if (j === 1) return (i & 1) ? K.bone : K.boneLt;
    if (j === 2) return (i % 4 === 1) ? G_VEND : chitJ(i, j, 21);
    return K.chitXDk;
  });
  // four crystal nodes, each on a bone mount, pointing up and out
  GT_NODE.forEach((a, k) => {
    const c = polar(rm, a, 0.22), o = [Math.cos(a), 0, Math.sin(a)];
    b.lathe([c[0], 0.12, c[2]], [0, 1, 0], [[0, 0.3], [0.18, 0.2]], 5, K.boneDk, null, K.chitDk);
    crystal(b, [c[0], 0.3, c[2]], [o[0] * 0.6, 1, o[2] * 0.6], 0.95, 0.17, 3.1 + k * 1.3, 0.8, 5);
  });
  // spikes on the rim between the nodes
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU, t = [Math.cos(a), Math.sin(a)], n = [-t[1], t[0]];
    const P = (r, s, y) => [t[0] * r + n[0] * s, y, t[1] * r + n[1] * s];
    b.spike([P(r1 - 0.1, -0.16, 0.14), P(r1 - 0.1, 0.16, 0.14), P(r1 - 0.1, 0, -0.1)], P(r1 + 0.75, 0, 0.22), (q) => (q === 2 ? K.boneDk : K.boneLt));
  }
  return b;
}
/** the portal: an additive disc, a bright heart fading to violet at the rim, spiral arms twisted by `twist` */
function buildPortal(R, twist, arms, k0, NR, NA) {
  const pos = [], col = [];
  const colAt = (r, a) => {
    const u = r / R, s = 0.5 + 0.5 * Math.cos(arms * a + twist * u * TAU);
    const heart = Math.max(0, 1 - u * 1.6);
    const edge = u > 0.82 ? Math.max(0, (1 - u) / 0.18) : 1;
    const v = (0.22 + 0.78 * s) * (0.5 + 0.5 * (1 - u)) * edge * k0;
    return [(0.42 * v + heart * 0.5), (0.13 * v + heart * 0.34), (0.95 * v + heart * 0.75)];
  };
  for (let i = 0; i < NR; i++) {
    const ra = (R * i) / NR, rb = (R * (i + 1)) / NR;
    for (let k = 0; k < NA; k++) {
      const a0 = (k / NA) * TAU, a1 = ((k + 1) / NA) * TAU;
      const Q = [[ra, a0], [rb, a0], [rb, a1], [ra, a1]];
      const P = Q.map(([r, a]) => [Math.cos(a) * r, 0, Math.sin(a) * r]), C = Q.map(([r, a]) => colAt(r, a));
      if (i === 0) { pos.push(...P[0], ...P[1], ...P[2]); col.push(...C[0], ...C[1], ...C[2]); continue; }   // the heart: a fan
      pos.push(...P[0], ...P[1], ...P[2], ...P[0], ...P[2], ...P[3]);
      col.push(...C[0], ...C[1], ...C[2], ...C[0], ...C[2], ...C[3]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
function createGate() {
  const { g, pivot, ud } = enemyShell('s7_gate', 1.9, '#57405f');
  const mat = bodyMat(0.5, 0.3);
  pivot.add(new THREE.Mesh(GG('ext:s7:gate', buildGateRing), mat));
  const pMat = additiveMat(), qMat = additiveMat();
  const portal = new THREE.Mesh(G('ext:s7:gate.portal', () => buildPortal(GT_R[0] + 0.05, 1.3, 3, 1.0, 4, 24)), pMat);
  const swirl = new THREE.Mesh(G('ext:s7:gate.swirl', () => buildPortal(GT_R[0] * 0.8, -0.9, 2, 0.7, 3, 16)), qMat);
  for (const m of [portal, swirl]) { m.userData.noShadow = true; m.renderOrder = 2; pivot.add(m); }
  portal.position.y = 0.02; swirl.position.y = 0.05;
  ud.muzzles = [...GT_NODE.map((a) => new THREE.Vector3(Math.cos(a) * GT_RM, 0.9, Math.sin(a) * GT_RM)), new THREE.Vector3(0, 0.1, 0)];
  let open = 1, pulse = 0;
  /** 0..1: the portal opens (0 = closed: only the ring) */
  ud.setOpen = (v) => { open = Math.max(0, Math.min(1, v)); };
  /** a flare of the portal (something comes through) */
  ud.setPulse = (v) => { pulse = Math.max(pulse, v); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    pulse = Math.max(0, pulse - dt * 2.2);
    const s = Math.max(0.001, open);
    portal.scale.set(s, 1, s); swirl.scale.set(s * (1 + pulse * 0.2), 1, s * (1 + pulse * 0.2));
    portal.visible = swirl.visible = open > 0.01;
    portal.rotation.y -= dt * (1.4 + pulse * 3);
    swirl.rotation.y += dt * (2.3 + pulse * 5);
    pMat.color.setScalar((0.75 + Math.sin(t * 5.3) * 0.1 + pulse * 0.8) * (0.4 + 0.6 * open));
    qMat.color.setScalar(0.7 + Math.sin(t * 7.1) * 0.12 + pulse * 1.0);
    mat.uEmitScale.value = 0.7 + open * 0.3 + pulse * 0.8 + Math.sin(t * 3) * 0.1;
    // the ring turns slowly; its node muzzles turn with it (rotation about y by r: x' = x cos r + z sin r)
    const r = (pivot.rotation.y + dt * 0.25) % TAU, cr = Math.cos(r), sr = Math.sin(r);
    pivot.rotation.y = r;
    for (let k = 0; k < 4; k++) {
      const x = Math.cos(GT_NODE[k]) * GT_RM, z = Math.sin(GT_NODE[k]) * GT_RM;
      ud.muzzles[k].set(x * cr + z * sr, 0.9, -x * sr + z * cr);
    }
  };
  ud.dispose = () => { mat.dispose(); pMat.dispose(); qMat.dispose(); };
  ud.update(0, 0);
  return g;
}

// =============================================================================
// LEVIATHAN — mid-boss: a bio-mechanical space leviathan (≈ 11 across the mantle, 10 long with the tail)
// =============================================================================
// Hierarchy: pivot → body mesh (head, body, tail and fluke); the maw (part: the mandibles and the lit
// gullet between them; setOpen spreads them); per side a wing pivot at the mantle's root (the AI beats it
// with setFlap) → the wing part, placed on its great spore gland, whose one mesh is the whole wing reaching
// back to the root (so the hit circle sits on the gland); the core (the heart orb + the dorsal lid on its hinge).
const LV_CORE = [0, 0.62, 0.35];
const LV_WING = [1.55, 0.04, 0.0];         // right wing pivot (the left one mirrors it)
const LV_GLAND = [1.9, 0.0, 0.3];          // the part (its gland) relative to the pivot
const LV_MAW = [0, 0.02, -3.2];
function buildLeviathanBody() {
  const b = new GB();
  const s0 = b.n;
  const secs = [[-3.55, 0.3, 0.2, 0.14], [-3.1, 0.95, 0.42, 0.3], [-2.4, 1.25, 0.56, 0.38], [-1.75, 1.2, 0.5, 0.36], [-1.0, 1.75, 0.68, 0.45],
    [0.3, 1.95, 0.74, 0.5], [1.5, 1.6, 0.64, 0.42], [2.5, 1.05, 0.46, 0.32]];
  b.loft(secs.map((s) => ring10(s)), (i, j) => {
    if (j === 0) return i === 3 ? K.chitDk : i === 0 ? K.boneDk : (i & 1) ? K.bone : K.boneLt;            // dorsal plates
    if (j === 1 || j === 9) return i === 1 || i === 4 ? K.boneDk : chitJ(i, j, 31);
    if (j === 2 || j === 8) return i === 3 ? G_VEN : chitJ(i, j, 33);                                      // gill slits
    if (j === 3 || j === 7) return K.chitDk;
    return K.chitXDk;
  }, K.chitDk, null);
  const s1 = b.n;
  // tail: tapering plates on dark joints to a crescent fluke
  const tsec = [[2.5, 1.05, 0.46, 0.32], [3.1, 0.8, 0.38, 0.28], [3.25, 0.66, 0.3, 0.24], [3.9, 0.56, 0.3, 0.22], [4.05, 0.46, 0.24, 0.18],
    [4.7, 0.38, 0.22, 0.16], [4.85, 0.3, 0.17, 0.13], [5.4, 0.22, 0.14, 0.1], [5.9, 0.1, 0.08, 0.06]];
  b.loft(tsec.map((s) => ring10(s)), (i, j) => {
    const joint = (i & 1) === 1;
    if (j === 0) return joint ? K.chitXDk : K.bone;
    if (j === 1 || j === 9) return joint ? K.chitXDk : K.boneDk;
    return joint ? K.chitXDk : chitJ(i, j, 35);
  }, null, K.chitDk);
  const f0 = b.n;
  b.plate([[0.0, 5.3], [0.7, 5.6], [1.35, 6.3], [1.2, 6.55], [0.6, 6.1], [0.0, 6.0]], -0.04, 0.04, K.membLt, K.chitDk, K.chitXDk);
  strip(b, 0.08, 5.45, 1.25, 6.35, 0.045, 0.03, K.boneLt);
  // brow horns sweeping back from the head, eyes along the head's flanks
  horn(b, [[0.5, 0.42, -2.7], [0.9, 0.6, -2.3], [1.1, 0.72, -1.7], [1.05, 0.8, -1.2]], 0.14, K.boneLt, 4);
  horn(b, [[0.72, 0.3, -2.95], [1.1, 0.34, -2.8], [1.35, 0.36, -2.5], [1.45, 0.36, -2.15]], 0.09, K.bone, 3);
  b.drape([[[0.55, -2.95], [0.8, -2.8], [0.78, -2.62], [0.52, -2.75]], [[0.72, -2.45], [0.95, -2.3], [0.92, -2.14], [0.7, -2.28]]], G_VEN, s0, s1, 0.01, 2);
  // the mantle's root fairing (where the wing pivots meet the flank)
  b.lathe([1.45, 0.05, 0.0], [1, 0, 0], [[0, 0.62], [0.2, 0.58], [0.3, 0.42]], 8, (i, j) => (j === 2 ? K.boneDk : K.chitDk), null, K.chitXDk, { phase: Math.PI / 8, sy: 0.4 });
  b.mirrorX(f0);
  // dorsal fin spikes along the spine
  for (const [z, h] of [[1.3, 0.5], [2.05, 0.42], [3.55, 0.3], [4.4, 0.22]]) {
    b.spike([[-0.1, 0.4, z - 0.25], [0.1, 0.4, z - 0.25], [0.08, 0.36, z + 0.2], [-0.08, 0.36, z + 0.2]], [0, 0.44 + h, z + 0.42], (k) => (k & 1 ? K.boneLt : K.boneDk));
  }
  // the core well: a bone collar with lime nodes round a dark hollow (the heart and its lid are the core part)
  const N = 12, [cx, , cz] = LV_CORE;
  const cr = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; });
  b.loft([cr(0.98, 0.64), cr(0.94, 0.84), cr(0.8, 0.92), cr(0.66, 0.9), cr(0.6, 0.6)], (i, j) => {
    if (i === 0) return (j & 1) ? K.chit : K.chitDk;
    if (i === 1) return j % 4 === 1 ? G_VEND : K.boneLt;
    if (i === 2) return K.boneDk;
    return K.chitXDk;
  });
  b.lathe([cx, 0.62, cz], [0, 1, 0], [[0, 0.6], [0, 0.0]], N, K.black);
  return b;
}
function buildLeviathanWing() {   // part-local: the gland at the origin; the wing reaches back to its root at x = −LV_GLAND.x
  const b = new GB();
  const [gx, , gz] = LV_GLAND;
  const w0 = b.n;
  b.wing([{ x: 0.0, y: 0.0, zl: -1.5, zt: 1.65, t: 0.34, tb: 0.4 }, { x: 1.0, y: 0.02, zl: -1.18, zt: 1.58, t: 0.27, tb: 0.4 },
    { x: 2.0, y: 0.04, zl: -0.56, zt: 1.55, t: 0.19, tb: 0.4 }, { x: 2.9, y: 0.06, zl: 0.22, zt: 1.7, t: 0.11, tb: 0.4 },
    { x: 3.6, y: 0.07, zl: 1.08, zt: 1.98, t: 0.05, tb: 0.4 }, { x: 3.95, y: 0.08, zl: 1.72, zt: 2.12, t: 0.02, tb: 0.4 }].map((s) => ({ ...s, x: s.x - gx, zl: s.zl - gz, zt: s.zt - gz })),
  (i, j) => {
    if (j === 0) return i < 3 ? K.boneLt : K.bone;                         // bone leading edge
    if (j >= 4) return K.chitXDk;
    if (j === 3) return (i & 1) ? K.memb : K.membLt;                       // trailing membrane
    return chitJ(i, j, 41);
  }, K.chitDk, K.bone);
  const w1 = b.n;
  // bone ribs fanning from the root to the trailing edge, a lime vein between them
  const ribs = [[[0.2, -0.9], [1.6, -0.4], [3.1, 0.7]], [[0.2, 0.2], [1.4, 0.55], [2.6, 1.3]], [[0.2, 1.1], [1.0, 1.35], [1.9, 1.55]]];
  for (const r of ribs) b.drape(stripe(r.map(([x, z]) => [x - gx, z - gz]), 0.055), K.boneDk, w0, w1, 0.012, 1);
  b.drape(stripe([[0.3, -0.35], [1.5, 0.1], [2.9, 1.0]].map(([x, z]) => [x - gx, z - gz]), 0.022), G_VEND, w0, w1, 0.012, 1);
  // spore glands: the great gland at the origin, two small ones either side on the mid-chord
  const gland = (x, z, r, hot) => {
    b.lathe([x, 0.1, z], [0, 1, 0], [[0, r * 1.05], [r * 0.3, r * 1.1], [r * 0.7, r * 0.8], [r * 1.0, r * 0.35], [r * 1.08, 0]], 8,
      (i, j) => (i === 0 ? K.chitDk : i === 1 ? (j & 1 ? K.bone : K.boneDk) : hot ? (i >= 3 ? G_VENH : G_VEN) : i >= 3 ? G_VEN : G_VEND), K.chitXDk, null, { phase: Math.PI / 8 });
  };
  gland(0, 0, 0.34, true);
  gland(-0.95, -0.12, 0.2, false);
  gland(0.85, 0.35, 0.2, false);
  return b;
}
function buildLeviathanMaw() {    // part-local, at the mouth: the mandibles (spread by scale.x) round the lit gullet
  const b = new GB();
  // the gullet: a glowing lime throat ahead of the snout, a dark rim
  b.lathe([0, -0.06, -0.55], [0, 1, 0], [[0, 0.42], [0.08, 0.36], [0.14, 0.0]], 10, (i) => (i === 0 ? K.chitXDk : G_VEN), null, null, { sx: 0.8, sy: 1.1 });
  const f0 = b.n;
  // mandible: a curved armoured tusk from its root beside the head to a point ahead and inward, teeth on its inner edge
  const P = [[0.52, 0.0, 0.5], [0.95, 0.04, -0.2], [0.75, 0.02, -1.0], [0.2, -0.04, -1.45]];
  const T = [0, 0.15, 0.32, 0.5, 0.68, 0.84, 1];
  tube(b, P, T, (t) => 0.3 * (1 - t * 0.85), (i, j) => (j === 0 || j === 1 || j === 7 ? (i & 1 ? K.bone : K.boneLt) : j === 6 || j === 5 ? K.chitDk : chitJ(i, j, 51)),
    K.chitDk, null, 0.7);
  for (let k = 0; k < 4; k++) {
    const t = 0.25 + k * 0.17, c = bez3(P[0], P[1], P[2], P[3], t), r = 0.3 * (1 - t * 0.85);
    b.spike([[c[0] - r * 0.7, c[1] - 0.04, c[2] - 0.08], [c[0] - r * 0.7, c[1] - 0.04, c[2] + 0.08], [c[0] - r * 0.7, c[1] + 0.06, c[2]]],
      [c[0] - r * 0.7 - 0.22, c[1] - 0.02, c[2] - 0.06], K.boneLt);
  }
  b.mirrorX(f0);
  return b;
}
function buildLeviathanLid() {   // hinge-local: a domed bone plate over the core well, hinged at its rear edge (+z)
  const b = new GB();
  b.lathe([0, -0.02, -0.82], [0, 1, 0], [[0, 0.84], [0.12, 0.82], [0.28, 0.66], [0.42, 0.38], [0.48, 0.0]], 12, (i, j) => {
    if (i === 0) return K.chitDk;
    if (i === 2) return j % 3 === 0 ? G_VEND : K.bone;
    return (j & 1) ? K.bone : K.boneLt;
  }, K.chitXDk, K.boneDk, { phase: Math.PI / 12 });
  b.block({ x: 0, y: -0.02, z: -0.02, w: 0.7, d: 0.18, h: 0.16, top: K.boneDk, side: K.chitDk });
  return b;
}
function createLeviathan() {
  const { g, pivot, ud } = enemyShell('leviathan', 2.4, '#57405f');
  ud.midboss = true;
  ud.halfExtents = { x: 5.6, z: 5.0 };
  const hullMat = bodyMat(0.55, 0.28);
  pivot.add(new THREE.Mesh(GG('ext:s7:leviathan.body', buildLeviathanBody), hullMat));
  const allMats = [hullMat];
  // wings: one geometry + wreck (the outer mantle torn away), the left one mirrored
  const wingKeep = { keep: (x, y, z) => -0.55 - x, crumple: 0.14, seed: 71, dir: [1, 0.3, 0], shards: 12, shardSize: 0.3, band: 0.5 };
  const pivots = [], wings = [];
  for (const sg of [1, -1]) {
    const wp = new THREE.Object3D(); wp.name = sg > 0 ? 'wingPivotR' : 'wingPivotL';
    wp.position.set(sg * LV_WING[0], LV_WING[1], LV_WING[2]);
    if (sg < 0) wp.scale.x = -1;
    const m = bodyMat(0.55, 0.28); allMats.push(m);
    const part = destructiblePart({ key: 'ext:s7:leviathan.wing', build: buildLeviathanWing, name: sg > 0 ? 'wingR' : 'wingL', radius: 1.25,
      muzzles: [new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(-0.95, 0.3, -0.12), new THREE.Vector3(0.85, 0.3, 0.35)], wreck: wingKeep, sag: [0.0, -0.12, -0.18], mat: m });
    part.position.set(LV_GLAND[0], LV_GLAND[1], LV_GLAND[2]);
    part.userData.mat = m; part.userData.charge = 0;
    /** 0..1: the glands swell and blaze (a spore launch coming) */
    part.userData.setCharge = (v) => { part.userData.charge = Math.max(0, Math.min(1, v)); };
    wp.add(part); pivot.add(wp);
    pivots.push(wp); wings.push(part);
  }
  // maw: the mandibles round the gullet (setOpen spreads them)
  const mawMat = bodyMat(0.5, 0.28); allMats.push(mawMat);
  const maw = destructiblePart({ key: 'ext:s7:leviathan.maw', build: buildLeviathanMaw, name: 'maw', radius: 1.0,
    muzzles: [new THREE.Vector3(0, 0.1, -0.7), new THREE.Vector3(-0.45, 0.1, -1.0), new THREE.Vector3(0.45, 0.1, -1.0)],
    wreck: { keep: (x, y, z) => z + 0.35, crumple: 0.1, seed: 73, dir: [0, 0.3, -1], shards: 10, shardSize: 0.24, band: 0.4 }, sag: [0.1, -0.08, 0.05], mat: mawMat });
  maw.position.set(LV_MAW[0], LV_MAW[1], LV_MAW[2]);
  const mawMesh = maw.children[0];
  let mawOpen = 0, mawCharge = 0;
  maw.userData.setOpen = (v) => { mawOpen = Math.max(0, Math.min(1, v)); mawMesh.scale.set(1 + mawOpen * 0.42, 1, 1 - mawOpen * 0.12); };
  /** 0..1: the gullet blazes (a breath coming) */
  maw.userData.setCharge = (v) => { mawCharge = Math.max(0, Math.min(1, v)); };
  pivot.add(maw);
  // core: the heart orb under a hinged bone lid (the collar is part of the body)
  const coreMat = bodyMat(0.5, 0.28), orbMat = bodyMat(0.4, 0.1);
  allMats.push(coreMat, orbMat);
  const orbGeo = GG('ext:s7:leviathan.orb', () => orbGB(0.58, 0.18, VENH, XTH, 4.4)), orbDead = GG('ext:s7:leviathan.orbDead', () => orbGB(0.52, 0.18, VENH, XTH, 8.1, true));
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const hinge = new THREE.Object3D(); hinge.position.set(0, 0.28, 0.82);
  const lid = new THREE.Mesh(GG('ext:s7:leviathan.lid', buildLeviathanLid), coreMat);
  hinge.add(lid);
  const core = makePart('core', 0.85, [{ mesh: orb, intact: orbGeo, wreck: orbDead }, { mesh: lid, hideOnDestroy: true }], [new THREE.Vector3(0, 0.45, 0)]);
  core.add(hinge);
  core.userData.materials.push(coreMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(LV_CORE[0], LV_CORE[1] - 0.12, LV_CORE[2]);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    hinge.rotation.x = e * 112 * DEG;
  };
  core.userData.setOpen(0);
  pivot.add(core);
  ud.parts = { wingL: wings[1], wingR: wings[0], maw, core };
  ud.wingPivots = pivots;     // [right, left]
  ud.muzzles = [new THREE.Vector3(0, 0.3, -3.8)];
  let flap = 0;
  /** mantle beat: the AI advances the phase (a slow glide, a hard stroke); the body rises and falls with it */
  ud.setFlap = (v) => { flap = v; };
  /** pooled instances come back posed: mantle level, jaws shut, glands unlit */
  ud.reset = () => { flap = 0; maw.userData.setOpen(0); mawCharge = 0; for (const w of wings) w.userData.charge = 0; };
  const flashAll = flashFn(allMats);
  ud.setFlash = (v) => flashAll(v * 0.4);   // armour hits on the body: a soft flash (the parts flash on their own)
  ud.update = (dt, t) => {
    const p = 0.7 + Math.sin(t * 2.7) * 0.15;
    hullMat.uEmitScale.value = p; coreMat.uEmitScale.value = p;
    for (let k = 0; k < 2; k++) {
      const w = wings[k].userData;
      w.mat.uEmitScale.value = w.destroyed ? 0.7 : p + w.charge * (1.5 + Math.sin(t * 36 + k) * 0.35);
      const lift = w.destroyed ? Math.sin(flap) * 0.07 - 0.15 : Math.sin(flap) * 0.2;
      pivots[k].rotation.z = (k === 0 ? 1 : -1) * lift;
    }
    mawMat.uEmitScale.value = maw.userData.destroyed ? 0.7 : 0.55 + mawOpen * 0.5 + mawCharge * (1.4 + Math.sin(t * 42) * 0.3);
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.35 + openT * 0.45) * (1 + Math.sin(t * 7) * 0.14);
    orb.rotation.y += dt * (0.5 + openT * 2.2);
    pivot.position.y = Math.sin(flap + 1.2) * 0.12;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); };
  return g;
}

// =============================================================================
// NEMESIS — boss: the alien mothership (≈ 14 across the mandible arms, 13 long)
// =============================================================================
// Hierarchy (the death splits fore from aft):
//   pivot ┬ aft (the carapace: brood-sac flanks, the heart well, the crystal sockets, the stern + bio-drive flames)
//         │   ├ bay0, bay1 (parts: the brood bays on the flanks — a bone rim and an iris of petals; setOpen
//         │   │  shrinks the iris into the rim and bares the lit mouth)
//         │   ├ prismL, prismR, prismC (parts: crystal spires on their sockets; setGrow(0..1) grows them out of
//         │   │  sealed nubs; prismC is the lance, its rotation.y aims it; setBeam / setCharge)
//         │   └ core (the brood-heart orb under two rib shutters, setOpen)
//         └ fore (the prow with its eyes and the two great mandible arms)
//             └ spine0..3 (parts: bio-cannons on the arms, 0/1 on the left arm; rotation.y aims them)
const NM_CORE = [0, 1.05, 0.4];
const NM_BAY = [3.55, 1.1, 1.5];                      // right bay (the left mirrors x)
const NM_PRISM = [[-1.95, 1.0, 2.9], [1.95, 1.0, 2.9], [0, 1.1, 4.0]];   // L, R, C sockets
const NM_ARM = [[2.25, 0.25, -1.4], [4.8, 0.4, -1.1], [6.3, 0.25, -3.2], [4.7, 0.02, -5.7]];   // right arm bezier
const NM_SPINE_T = [0.36, 0.72];                        // spine turrets along each arm
const NM_RIB = 1.5;                                     // rib shutter radius (hinges at x = ±NM_RIB)
function nmArmAt(t, sx = 1) { const p = bez3(NM_ARM[0], NM_ARM[1], NM_ARM[2], NM_ARM[3], t); return [p[0] * sx, p[1], p[2]]; }
function nmArmR(t) { return 0.68 * (1 - t * 0.8); }
function buildNemesisAft() {
  const b = new GB();
  const s0 = b.n;
  // the carapace: broad plates on thin bone ribs, lime seams on the flanks
  const Z = [[-2.9, 1.6, 0.62, 0.42], [-2.2, 2.4, 0.92, 0.6], [-2.05, 2.5, 0.95, 0.62], [-0.8, 3.05, 1.14, 0.7], [-0.65, 3.08, 1.15, 0.7],
    [0.9, 3.25, 1.2, 0.74], [1.05, 3.25, 1.2, 0.74], [2.4, 3.05, 1.14, 0.7], [2.55, 3.0, 1.12, 0.7], [3.8, 2.5, 1.0, 0.62], [3.95, 2.42, 0.98, 0.6],
    [5.1, 1.8, 0.78, 0.5], [5.25, 1.72, 0.75, 0.48], [6.2, 1.1, 0.56, 0.38], [7.0, 0.45, 0.34, 0.26]];
  b.loft(Z.map((s) => ring10(s)), (i, j) => {
    const rib = (i & 1) === 1;
    if (j === 0) return rib ? K.boneLt : chitJ(i, j, 61);
    if (j === 1 || j === 9) return rib ? K.bone : chitJ(i, j, 63);
    if (j === 2 || j === 8) return rib ? K.boneDk : (i === 6 || i === 10) ? G_VEND : K.chitDk;
    return K.chitXDk;
  }, K.chitDk, K.chitDk);
  const s1 = b.n;
  // a lime conduit down the spine to the stern, bone crest spikes behind the heart
  b.drape(stripe([[0, 1.8], [0, 6.6]], 0.06), G_VEND, s0, s1, 0.012, 1);
  for (const [z, h] of [[5.0, 0.55], [5.8, 0.42], [6.5, 0.3]]) {
    const y = 0.85 - (z - 5) * 0.2;
    b.spike([[-0.12, y, z - 0.28], [0.12, y, z - 0.28], [0.1, y - 0.05, z + 0.2], [-0.1, y - 0.05, z + 0.2]], [0, y + 0.05 + h, z + 0.45], (k) => (k & 1 ? K.boneLt : K.boneDk));
  }
  // the heart well: a bone collar with lime nodes round a dark hollow (the heart and its ribs are the core part)
  const N = 14, [cx, cy, cz] = NM_CORE;
  const cr = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; });
  b.loft([cr(1.72, cy - 0.02), cr(1.66, cy + 0.2), cr(1.5, cy + 0.3), cr(1.36, cy + 0.26), cr(1.3, cy - 0.3)], (i, j) => {
    if (i === 0) return (j & 1) ? K.chit : K.chitDk;
    if (i === 1) return j % 4 === 1 ? G_VEND : K.boneLt;
    if (i === 2) return K.boneDk;
    return K.chitXDk;
  });
  b.lathe([cx, cy - 0.28, cz], [0, 1, 0], [[0, 1.32], [0, 0.0]], N, K.black);
  // crystal sockets: chitin collars (the crystals are the prism parts)
  for (const [x, y, z] of NM_PRISM) {
    b.lathe([x, y - 0.25, z], [0, 1, 0], [[0, 0.7], [0.18, 0.66], [0.3, 0.5], [0.32, 0.36]], 8, (i, j) => (i === 1 ? (j & 1 ? K.bone : K.boneDk) : K.chitDk),
      null, GL(scl(XT, 0.5), 0.4), { phase: Math.PI / 8 });
  }
  // the stern: the middle bio-drive orifice
  b.lathe([0, 0.08, 6.55], [0, 0, 1], [[0, 0.34], [0.2, 0.36], [0.36, 0.28]], 8, (i) => (i === 0 ? K.chitDk : K.boneDk), null, G_VEN, { phase: Math.PI / 8 });
  const f0 = b.n;
  // brood sacs bulging from the flanks, the bay mouth on top (the rim and iris are the bay part), veins over the sac
  const [bx, by, bz] = NM_BAY;
  b.lathe([bx, by - 1.4, bz], [0, 1, 0], [[0, 0.3], [0.35, 0.95], [0.8, 1.2], [1.2, 1.12], [1.38, 0.86], [1.42, 0.62]], 10,
    (i, j) => (i === 4 ? (j & 1 ? K.boneLt : K.bone) : i === 3 && j % 5 === 0 ? G_VEND : chitJ(i, j, 65)), K.chitXDk, GL(scl(VEN, 0.7), 0.5), { phase: 0.3, sx: 1.05, sy: 1.2 });
  // the side bio-drive orifices
  b.lathe([0.62, 0.08, 6.4], [0, 0, 1], [[0, 0.3], [0.2, 0.32], [0.36, 0.25]], 8, (i) => (i === 0 ? K.chitDk : K.boneDk), null, G_VEN, { phase: Math.PI / 8 });
  b.mirrorX(f0);
  return b;
}
function buildNemesisFore() {
  const b = new GB();
  const s0 = b.n;
  // the prow: a flattened head ahead of the carapace, a brow ridge, rows of eyes, the maw slit at its point
  b.loft([[-2.9, 1.7, 0.66, 0.44], [-3.5, 1.62, 0.66, 0.42], [-4.2, 1.32, 0.56, 0.36], [-4.95, 0.9, 0.42, 0.28], [-5.6, 0.46, 0.26, 0.18], [-6.05, 0.1, 0.08, 0.06]].map((s) => ring10(s)),
    (i, j) => {
      if (j === 0) return i === 1 ? K.boneLt : i === 4 ? K.boneDk : K.bone;
      if (j === 1 || j === 9) return i === 2 ? K.boneLt : chitJ(i, j, 67);
      if (j === 2 || j === 8) return K.chitDk;
      return K.chitXDk;
    }, null, K.chitDk);
  const s1 = b.n;
  for (let k = 0; k < 3; k++) {
    const z = -3.55 - k * 0.5, x = 0.55 + k * 0.08;
    for (const sg of [-1, 1]) b.drape([[[sg * x, z], [sg * (x + 0.26), z + 0.05], [sg * (x + 0.24), z + 0.2], [sg * x, z + 0.16]]], G_VEN, s0, s1, 0.01, 2);
  }
  b.drape(stripe([[0, -5.75], [0, -4.4]], 0.06), G_VEN, s0, s1, 0.012, 1);          // the maw slit
  const f0 = b.n;
  // the mandible arm: a tapering armoured tube along its bezier (bone plates on top, a lime conduit), spikes on
  // its outer edge, a pincer point
  const T = [0, 0.08, 0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.88, 1];
  tube(b, NM_ARM, T, nmArmR, (i, j) => {
    if (j === 0) return (i & 1) ? K.boneLt : (i === 4 ? G_VEND : K.bone);
    if (j === 1 || j === 7) return (i & 1) ? K.bone : K.boneDk;
    if (j === 2 || j === 6) return chitJ(i, j, 69);
    return K.chitXDk;
  }, K.chitDk, null, 0.7);
  const tip = nmArmAt(1);
  horn(b, [tip, [tip[0] - 0.3, tip[1], tip[2] - 0.35], [tip[0] - 0.75, tip[1] - 0.02, tip[2] - 0.6], [tip[0] - 1.2, tip[1] - 0.04, tip[2] - 0.7]], 0.14, K.boneLt, 4);
  for (const t of [0.2, 0.5, 0.8]) {
    const c = nmArmAt(t), d = nmArmAt(Math.min(1, t + 0.02)), e = nmArmAt(Math.max(0, t - 0.02));
    const tx = d[0] - e[0], tz = d[2] - e[2], l = Math.hypot(tx, tz) || 1, ox = tz / l, oz = -tx / l;     // outward normal
    const r = nmArmR(t);
    b.spike([[c[0] + ox * r * 0.6, c[1] + 0.1, c[2] + oz * r * 0.6 - 0.16], [c[0] + ox * r * 0.6, c[1] + 0.1, c[2] + oz * r * 0.6 + 0.16], [c[0] + ox * r * 0.4, c[1] + 0.3, c[2] + oz * r * 0.4]],
      [c[0] + ox * (r + 0.75), c[1] + 0.25, c[2] + oz * (r + 0.75) + 0.3], (k) => (k & 1 ? K.boneLt : K.boneDk));
  }
  // turret sockets on the arm (bone collars)
  for (const t of NM_SPINE_T) { const c = nmArmAt(t); b.lathe([c[0], c[1] + nmArmR(t) * 0.5, c[2]], [0, 1, 0], [[0, 0.5], [0.14, 0.46], [0.2, 0.3]], 8, (i) => (i === 1 ? K.boneDk : K.chitDk), null, K.chitXDk); }
  // the arm's root fairing into the prow's flank
  b.lathe([1.65, 0.3, -2.1], [1, 0.05, 0.2], [[0, 0.8], [0.4, 0.72], [0.7, 0.55]], 8, (i, j) => (j === 1 || j === 2 ? K.boneDk : K.chitDk), null, null, { phase: Math.PI / 8, sy: 0.6 });
  b.mirrorX(f0);
  return b;
}
function buildNemesisSpine() {   // part-local: a bio-cannon (orifice along −z) on a chitin bulb
  const b = new GB();
  b.lathe([0, -0.1, 0.05], [0, 1, 0], [[0, 0.48], [0.18, 0.46], [0.36, 0.36], [0.48, 0.18], [0.52, 0.0]], 8, (i, j) => {
    if (i === 1) return (j & 1) ? K.bone : K.boneDk;
    return chitJ(i, j, 71);
  }, K.chitXDk, K.chitLt, { phase: Math.PI / 8 });
  b.lathe([0, 0.22, 0.0], [0, 0.1, -1], [[0, 0.2], [0.3, 0.22], [0.36, 0.17], [0.62, 0.15], [0.68, 0.19], [0.8, 0.19], [0.86, 0.12]], 8, (i, j) => {
    if (i === 4) return G_VEND;
    if (i === 1) return j === 1 || j === 2 ? K.boneLt : K.bone;
    return j === 1 || j === 2 ? K.chitLt : K.chit;
  }, K.chitDk, G_VENH, { phase: Math.PI / 8 });
  // pincer horns flanking the orifice
  for (const sg of [-1, 1]) horn(b, [[sg * 0.2, 0.22, -0.3], [sg * 0.34, 0.24, -0.6], [sg * 0.28, 0.22, -0.9], [sg * 0.14, 0.2, -1.05]], 0.07, K.boneLt, 3);
  return b;
}
function buildNemesisBayRim() {   // part-local: the bay mouth's bone rim (the iris closes inside it)
  const b = new GB();
  const N = 12;
  const cr = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  b.loft([cr(0.98, -0.12), cr(0.98, 0.08), cr(0.86, 0.18), cr(0.72, 0.12), cr(0.7, -0.1)], (i, j) => {
    if (i === 1) return (j & 1) ? K.boneLt : K.bone;
    if (i === 2) return j % 4 === 0 ? G_VEND : K.boneDk;
    return K.chitDk;
  });
  return b;
}
function buildNemesisIris() {     // part-local: six petals closing over the mouth (bone tips, chitin blades)
  const b = new GB();
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * TAU, a1 = ((k + 1) / 6) * TAU, am = (a0 + a1) / 2;
    const r = 0.74, p0 = polar(r, a0, 0.08), p1 = polar(r, a1, 0.08), pm = polar(r * 0.55, am, 0.24), c = [0, 0.3, 0];
    b.triO(p0, p1, pm, [0, -0.3, 0], (k & 1) ? K.chit : K.chitLt);
    b.triO(p0, pm, c, [0, -0.3, 0], K.chitDk);
    b.triO(pm, p1, c, [0, -0.3, 0], (k & 1) ? K.boneDk : K.bone);
    b.triO(p0, p1, [0, -0.05, 0], [0, 0.6, 0], K.chitXDk);
  }
  return b;
}
function buildNemesisPrism(lance) {   // part-local, on its socket: a crystal cluster (the lance: one great crystal aimed along −z)
  const b = new GB();
  if (lance) {
    crystal(b, [0, 0.35, 0.6], [0, 0.18, -1], 2.6, 0.34, 13.1, 1.1);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + 0.3;
      crystal(b, [Math.cos(a) * 0.32, 0.3, 0.55 + Math.sin(a) * 0.3], [Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55 + 0.4], 0.75, 0.12, 14.3 + k, 0.9);
    }
  } else {
    crystal(b, [0, 0.2, 0], [0, 1, 0.25], 1.9, 0.3, 15.7, 1.1);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      crystal(b, [Math.cos(a) * 0.3, 0.18, Math.sin(a) * 0.3], [Math.cos(a), 0.9, Math.sin(a)], 0.9 + (k & 1) * 0.3, 0.14, 16.9 + k * 1.1, 0.95);
    }
  }
  return b;
}
function buildRibShutter(R) {   // right half (the left is the same mesh, scale.x = −1): bone ribs over a dark membrane, hinge at x = R
  const b = new GB();
  const prof = [[0.0, 1.0], [0.34, 0.95], [0.66, 0.79], [0.9, 0.52], [1.0, 0.2]];
  const inner = [[0.0, 0.88], [0.3, 0.84], [0.58, 0.69], [0.8, 0.46], [0.88, 0.2]];
  const zs = [-1.0, -0.82, -0.68, -0.42, -0.28, -0.07, 0.07, 0.28, 0.42, 0.68, 0.82, 1.0].map((z) => [z, 0.45 + 0.55 * Math.sqrt(Math.max(0, 1 - z * z))]);
  const ringAt = ([z, sc]) => [...prof.map(([x, y]) => [(x * sc + 0.012) * R, (0.2 + (y - 0.2) * (0.6 + sc * 0.4)) * R, z * R]),
    ...inner.slice().reverse().map(([x, y]) => [(x * sc + 0.012) * R, (0.2 + (y - 0.2) * (0.6 + sc * 0.4)) * R, z * R])];
  const NP = prof.length;
  b.loft(zs.map(ringAt), (i, j) => {
    const rib = (i & 1) === 1;
    if (j >= NP) return j === 2 * NP - 1 ? (rib ? K.boneDk : K.chitDk) : K.chitXDk;     // inner face; the meeting edge
    if (j === NP - 1) return K.chitDk;                                                  // the hinge edge
    if (rib) return j === 0 ? K.boneLt : K.bone;
    return (i === 0 || i === zs.length - 2) ? K.chitDk : j === 1 ? K.membLt : K.memb;
  }, K.chitDk, K.chitDk);
  return b;
}
function createNemesis() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss:nemesis';
  ud.radius = 5.0;
  ud.debrisColor = new THREE.Color('#57405f');
  const allMats = [];
  const mat = (r = 0.55, m = 0.28) => { const x = bodyMat(r, m); allMats.push(x); return x; };
  const aftMat = mat(), foreMat = mat();
  const aft = new THREE.Group(); aft.name = 'aft';
  aft.add(new THREE.Mesh(GG('ext:s7:nemesis.aft', buildNemesisAft), aftMat));
  const flameMat = additiveMat();
  const flames = new THREE.Mesh(G('ext:s7:nemesis.flames', () => buildFlame([[-0.62, 0.08, 0.85], [0, 0.08, 1.2], [0.62, 0.08, 0.85]], FLAME_BIO)), flameMat);
  flames.position.set(0, 0, 6.85); flames.userData.noShadow = true; flames.renderOrder = 2;
  aft.add(flames);
  const fore = new THREE.Group(); fore.name = 'fore';
  fore.add(new THREE.Mesh(GG('ext:s7:nemesis.fore', buildNemesisFore), foreMat));
  pivot.add(aft, fore);
  // ---- spine turrets on the arms (they go with the fore hull when it breaks away)
  const spKeep = { keep: (x, y, z) => 0.1 - y, crumple: 0.1, seed: 81, dir: [0, 1, 0], shards: 8, shardSize: 0.22, band: 0.35 };
  const spine = [];
  for (const sx of [-1, 1]) {
    for (const t of NM_SPINE_T) {
      const c = nmArmAt(t, sx);
      const p = destructiblePart({ key: 'ext:s7:nemesis.spine', build: buildNemesisSpine, name: 'spine' + spine.length, radius: 0.72,
        muzzles: [new THREE.Vector3(-0.1, 0.22, -0.9), new THREE.Vector3(0.1, 0.22, -0.9)], wreck: spKeep, sag: [0.12, -0.1, 0.1 * sx],
        pos: [c[0], c[1] + nmArmR(t) * 0.5 + 0.1, c[2]], mat: mat() });
      p.rotation.order = 'YXZ';
      fore.add(p);
      spine.push(p);
    }
  }
  // ---- brood bays: a bone rim + the iris (setOpen shrinks the petals into the middle and bares the lit mouth)
  const rimGeo = GG('ext:s7:nemesis.bayRim', buildNemesisBayRim);
  const rimWreck = wreckGeo('ext:s7:nemesis.bayRim', buildNemesisBayRim, { keep: (x, y, z) => x * 0.8 + z * 0.6 + 0.3, crumple: 0.12, seed: 87, dir: [0, 1, 0], shards: 10, shardSize: 0.22, band: 0.4 });
  const irisGeo = GG('ext:s7:nemesis.iris', buildNemesisIris);
  // a destroyed bay: its petals scorched and slumped shut over the mouth (so the lit mouth under them is covered)
  const irisWreck = wreckGeo('ext:s7:nemesis.iris', buildNemesisIris, { keep: () => 1, crumple: 0.1, scorch: 0.3, seed: 89, shards: 0 });
  const bays = [];
  for (const sx of [-1, 1]) {
    const m = mat();
    const rim = new THREE.Mesh(rimGeo, m), iris = new THREE.Mesh(irisGeo, m);
    const part = makePart(sx < 0 ? 'bay0' : 'bay1', 0.95, [{ mesh: rim, intact: rimGeo, wreck: rimWreck }, { mesh: iris, intact: irisGeo, wreck: irisWreck }],
      [new THREE.Vector3(0, 0.4, 0)], { onDestroyed: (d) => {
        if (d) { iris.scale.set(1, 0.7, 1); iris.rotation.y = 0.3; iris.position.y = -0.08; } else part.userData.setOpen(part.userData.open || 0);
      } });
    part.position.set(NM_BAY[0] * sx, NM_BAY[1], NM_BAY[2]);
    part.userData.open = 0;
    part.userData.setOpen = (v) => {
      const o = Math.max(0, Math.min(1, v)); part.userData.open = o;
      const s = 1 - o * 0.78; iris.scale.set(s, 1 - o * 0.5, s); iris.rotation.y = o * 0.9; iris.position.y = -o * 0.2;
    };
    part.userData.mat = m;
    aft.add(part);
    bays.push(part);
  }
  // ---- crystal spires: sealed small in phase 1, grown in phase 2
  const prismKeep = { keep: (x, y, z) => 0.55 - y, crumple: 0.12, seed: 83, dir: [0, 1, 0], shards: 12, shardSize: 0.26, band: 0.4 };
  const lanceKeep = { keep: (x, y, z) => z - 0.1, crumple: 0.12, seed: 85, dir: [0, 0.3, -1], shards: 12, shardSize: 0.28, band: 0.45 };
  const prisms = NM_PRISM.map(([x, y, z], k) => {
    const isLance = k === 2;
    const m = mat(0.3, 0.1);
    const p = destructiblePart({ key: isLance ? 'ext:s7:nemesis.lance' : 'ext:s7:nemesis.prism', build: () => buildNemesisPrism(isLance), name: ['prismL', 'prismR', 'prismC'][k],
      radius: isLance ? 1.0 : 0.9, muzzles: isLance ? [new THREE.Vector3(0, 0.82, -2.0)] : [new THREE.Vector3(0, 2.0, 0.45)], wreck: isLance ? lanceKeep : prismKeep,
      sag: [0.1, -0.1, 0.06], pos: [x, y, z], mat: m });
    p.rotation.order = 'YXZ';
    p.userData.mat = m;
    p.userData.grow = 1;
    /** 0..1: the crystals grow out of their socket (0 = sealed nubs) */
    p.userData.setGrow = (v) => { const gr = Math.max(0, Math.min(1, v)); p.userData.grow = gr; p.scale.setScalar(0.3 + 0.7 * gr); };
    aft.add(p);
    return p;
  });
  const lance = prisms[2];
  const beam = beamMesh('ext:s7:nemesis.beam', 36, 0.24, 0.9, [1.1, 1.9, 2.1, 0.85], [0.25, 0.9, 1.3, 0.4], [0.05, 0.35, 0.7, 0]);
  beam.m.position.set(0, 0.82, -2.05);
  lance.add(beam.m);
  let charge = 0;
  lance.userData.setBeam = beam.m.userData.set;
  /** 0..1: the lance crystal blazes as it charges */
  lance.userData.setCharge = (v) => { charge = Math.max(0, Math.min(1, v)); };
  // ---- the core: the brood-heart under two rib shutters
  const coreMat = mat(0.5, 0.28), orbMat = bodyMat(0.4, 0.1);
  const orbGeo = GG('ext:s7:nemesis.orb', () => orbGB(1.15, 0.25, VENH, XTH, 6.6)), orbDead = GG('ext:s7:nemesis.orbDead', () => orbGB(1.05, 0.25, VENH, XTH, 9.3, true));
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const shGeo = GG('ext:s7:nemesis.ribs', () => buildRibShutter(NM_RIB));
  const hingeR = new THREE.Object3D(); hingeR.position.set(NM_RIB, 0.18, 0);
  const hingeL = new THREE.Object3D(); hingeL.position.set(-NM_RIB, 0.18, 0);
  const shR = new THREE.Mesh(shGeo, coreMat); shR.position.set(-NM_RIB, -0.18, 0);
  const shL = new THREE.Mesh(shGeo, coreMat); shL.position.set(NM_RIB, -0.18, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  const core = makePart('core', 1.35, [{ mesh: orb, intact: orbGeo, wreck: orbDead }, { mesh: shR, hideOnDestroy: true }, { mesh: shL, hideOnDestroy: true }],
    [new THREE.Vector3(0, 0.9, 0)]);
  core.add(hingeR, hingeL);
  core.userData.materials.push(coreMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(NM_CORE[0], NM_CORE[1] - 0.3, NM_CORE[2]);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (v) => {
    openT = Math.max(0, Math.min(1, v)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;
    hingeR.rotation.z = -e * 116 * DEG; hingeL.rotation.z = e * 116 * DEG;
  };
  core.userData.setOpen(0);
  aft.add(core);
  ud.parts = { spine, bay: bays, prismL: prisms[0], prismR: prisms[1], prismC: lance, core };
  ud.muzzles = [new THREE.Vector3(0, 0.4, -5.9)];
  const flashAll = flashFn([...allMats, orbMat]);
  ud.setFlash = flashAll;
  // ---- death: 0 = whole, 1 = the fore hull torn off (tipped forward, drifting away) and the aft carapace tipped back
  let brk = 0;
  ud.setBreak = (v) => {
    brk = Math.max(0, Math.min(1, v));
    const e = brk * brk * (3 - 2 * brk);
    fore.position.set(0.3 * e, -1.3 * e, -1.8 * e); fore.rotation.set(0.32 * e, 0.12 * e, -0.2 * e);
    aft.position.set(-0.2 * e, -0.6 * e, 1.4 * e); aft.rotation.set(-0.22 * e, -0.08 * e, 0.16 * e);
  };
  ud.setBreak(0);
  /** pooled instances come back posed: whole, shut, crystals full, guns forward */
  ud.reset = () => {
    ud.setBreak(0); beam.m.userData.set(0); charge = 0;
    for (const p of spine) p.rotation.set(0, 0, 0);
    for (const p of bays) p.userData.setOpen(0);
    for (const p of prisms) { p.userData.setGrow(1); p.rotation.set(0, 0, 0); }
  };
  ud.reset();
  ud.update = (dt, t) => {
    const p = (0.7 + Math.sin(t * 2.4) * 0.15) * (1 - brk * 0.6);
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = p;
    for (let k = 0; k < 2; k++) { const bu = bays[k].userData; bu.mat.uEmitScale.value = p + bu.open * 0.8; }
    for (let k = 0; k < 3; k++) {
      const pu = prisms[k].userData;
      pu.mat.uEmitScale.value = pu.destroyed ? 0.6 : (0.35 + pu.grow * 0.65) * (0.85 + Math.sin(t * 3.3 + k * 2) * 0.15) + (k === 2 ? charge * (1.6 + Math.sin(t * 44) * 0.4) : 0);
    }
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.7 : (0.34 + openT * 0.48) * (1 + Math.sin(t * 6) * 0.14);
    orb.rotation.y += dt * (0.4 + openT * 2.0);
    flames.scale.set(1, 1, (1 + Math.sin(t * 31) * 0.08 + Math.sin(t * 19) * 0.05) * (1 - brk * 0.85));
    flameMat.color.setScalar(0.9 + Math.sin(t * 27) * 0.1);
    pivot.position.y = Math.sin(t * 0.55) * 0.14;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); orbMat.dispose(); flameMat.dispose(); beam.mat.dispose(); };
  return g;
}

export const ENEMIES = {
  s7_swarmer: createSwarmer,
  s7_stinger: createStinger,
  s7_crystal: createCrystalShip,
  s7_gate: createGate,
  leviathan: createLeviathan,
};
export const BOSSES = { nemesis: createNemesis };
