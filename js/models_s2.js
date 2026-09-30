// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 2 "SCORCHED CANYON"
// -----------------------------------------------------------------------------
// models.js registers these tables: createEnemy(type) falls back to ENEMIES[type],
// createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { <type>: factory };  // type = the ENEMY def key in stage2.js (or its `model`)
//   export const BOSSES = { <id>: factory };     // id = the boss ENEMY def `model` (e.g. 'behemoth')
//
// Names must not collide with stage-1 types (dart hornet tank turret gunboat carrier
// bomber crawler, arclight) or with models_s3.js; the registry reports collisions.
//
// Imports: only 'three', './modelkit.js' (and './defs.js') — never models.js
// (import cycle). House style and helpers: see the modelkit.js header.
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
//   * long units: userData.halfExtents { x, z }
//   * gameplay numbers (hp, score, collision radius) live in the stage's ENEMY def, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (mark it
//     userData.midboss = true so dev/models.html applies that budget)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) must fully restore
//     the pose. The stage's ENEMY def `parts` names these keys; a core may add setOpen(0..1)
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * mirrored parts share geometry + wreck with mesh.scale.x = −1
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
//   * stage 2 flies over desert ground (no sea, no splash): sand / rust / olive
//     palettes read on it (EN.sand*, EN.olive*, EN.gun*, BO.* or local lit() tables)
// Cache keys: 'ext:s2:<name>' — e.g. 'ext:s2:behemoth.hull', 'ext:s2:behemoth.turret.wreck'.
//
// The stage-2 roster (gameplay in stage2.js):
//   gunship     armoured tandem-rotor attack helicopter (air): body + two rotor discs
//   s2_striker  desert delta-wing strike jet that drops cluster bombs (air): body + flame
//   mlrs        six-wheeled rocket truck (ground): hull + traversing mount + elevating launcher
//                 (userData.turret, userData.launcher, userData.setRaise(0..1))
//   sandskiff   fast hovercraft with twin ducted fans (ground): hull + 2 fans + gun turret
//   scorpion    mid-boss assault walker (ground, 6 draw calls): body (+ core part that
//                 swaps to an open carapace), two tripod leg sets, claw cannons L/R, tail mortar
//   behemoth    boss land battleship (ground, 17 draw calls): bow / stern hull halves (they
//                 break apart in setCollapse), twin-gun main turret, 4 side batteries, 2
//                 missile silos with lids, command-bridge core with clamshell shutters
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, M, S, lit, lin, rgb, GL, EM, EN, scl, sub, bodyMat, additiveMat, flashFn, enemyShell, syncMuzzles,
  hazardStrip, hazardDrape, blockOn, trackLoft, makePart, destructiblePart, wreckGeo, wreckOf, gbOf, buildFlame, hash3,
  FLAME_JET, TAU, DEG,
} from './modelkit.js';

// ------------------------------------------------------------------ palette ---
// Desert livery: khaki / sandstone / rust with yellow-black hazard accents. Kept a step darker
// than the sand they drive over (sandL #c39f72), with bright bevels, so every unit reads on
// the dunes, the red canyon floor and the grey lakebed alike.
const DS = {
  khaki: lit('#7a6a45'), khakiLt: lit('#a18e64'), khakiDk: lit('#4d432e'),
  sand: lit('#b49a6a'), sandLt: lit('#d4bd8f'), sandDk: lit('#86704d'),
  rust: lit('#86432a'), rustLt: lit('#a65b38'), rustDk: lit('#54291a'),
  rubber: lit('#29251f'), rubberLt: lit('#3b352d'),
  glass: S(lin('#16252d'), rgb(0.015, 0.05, 0.07)), glassLt: S(lin('#3f7383'), rgb(0.03, 0.11, 0.14)),
  hot: GL(rgb(1.0, 0.5, 0.12, 3.4), 0.4),       // molten orange (vents, rocket tips)
  warm: GL(rgb(1.0, 0.45, 0.1, 1.5), 0.35),     // dimmer glow for big areas (grilles, seams)
};
const MOLTEN = rgb(1.0, 0.55, 0.14, 3.8);        // reactor glow (mid-boss / boss cores)
const HAZ = [EN.yellow, EN.black];
const TRACK_S2 = { treadA: lit('#4a443b'), treadB: lit('#2b2722'), side: lit('#33302b'), sideB: lit('#423d35'), bottom: lit('#1b1a18'), end: lit('#3a3630') };

/** tapered n-sided strut from p0 to p1 (radii r0 → r1) */
function strut(b, p0, p1, r0, r1, n, style, capB = null, phase = 0) {
  const ax = sub(p1, p0), len = Math.hypot(ax[0], ax[1], ax[2]);
  b.lathe(p0, ax, [[0, r0], [len, r1]], n, style, null, capB, { phase });
}
/** the rotor-disc material (same settings as the stage-1 hornet disc: one shared GPU program) */
function discMat() {
  return new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
}

// =============================================================================
// GUNSHIP — armoured tandem-rotor attack helicopter (3 draw calls)
// =============================================================================
function buildGunship() {
  const b = new GB();
  // armoured fuselage: flat-sided octagon stations [z, halfWidth, top, bottom, yc]
  // edges: 0 right shoulder, 1 right flank, 2 right chine, 3 belly, 4 left chine, 5 left flank, 6 left shoulder, 7 roof
  const ring = ([z, w, t, bt, yc]) => [[w * 0.5, yc + t, z], [w, yc + t * 0.42, z], [w, yc - bt * 0.35, z], [w * 0.55, yc - bt, z],
    [-w * 0.55, yc - bt, z], [-w, yc - bt * 0.35, z], [-w, yc + t * 0.42, z], [-w * 0.5, yc + t, z]];
  const ST = [[-1.62, 0.08, 0.07, 0.07, -0.1], [-1.4, 0.26, 0.2, 0.18, -0.1], [-1.05, 0.38, 0.32, 0.23, -0.08],
    [-0.6, 0.44, 0.37, 0.25, -0.05], [0.45, 0.44, 0.37, 0.25, -0.05], [1.0, 0.31, 0.3, 0.18, 0.02], [1.62, 0.13, 0.18, 0.08, 0.1]];
  const s0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    if (j === 7) return i === 3 ? DS.khakiLt : DS.khaki;                  // roof
    if (j === 0 || j === 6) return i === 3 ? DS.sandLt : DS.sand;         // lit shoulders carry the outline
    if (j === 1 || j === 5) return i === 4 ? DS.rust : i === 2 ? DS.khakiDk : DS.khaki;
    return DS.khakiDk;
  }, GL(EM.eyeRed, 0.4), DS.rustDk);
  const s1 = b.n;
  // stepped tandem canopy (gunner low in front, pilot behind and higher)
  b.lathe([0, 0.14, -1.33], [0, 0.3, 1], [[0, 0.03], [0.16, 0.15], [0.5, 0.15], [0.68, 0.03]], 6,
    (i, j) => ((j === 1 || j === 2) ? DS.glassLt : DS.glass), null, null, { phase: Math.PI / 6, sy: 0.85 });
  // glowing sensor slits either side of the nose
  b.drape([[[0.05, -1.45], [0.17, -1.38], [0.18, -1.3], [0.07, -1.36]], [[-0.05, -1.45], [-0.07, -1.36], [-0.18, -1.3], [-0.17, -1.38]]],
    GL(EM.eyeRed), s0, s1, 0.006, 1);
  // rust camo on the roof + a hazard band before the tail pylon
  b.drape([[[-0.3, -0.5], [0.05, -0.62], [0.26, -0.2], [-0.12, -0.1]], [[-0.05, 0.1], [0.3, 0.02], [0.3, 0.4], [0.02, 0.45]]], DS.rust, s0, s1, 0.005, 1);
  hazardDrape(b, 0, 0.62, 0, 0.84, 0.3, 4, EN.yellow, EN.black, s0, s1, 0.008, 1);
  // front rotor mast; rear rotor pylon + mast
  b.lathe([0, 0.28, -0.72], [0, 1, 0], [[0, 0.13], [0.16, 0.1], [0.28, 0.06]], 6, (i) => (i === 0 ? DS.khakiDk : EN.gun), null, EN.gunLt, { phase: Math.PI / 6 });
  b.block({ x: 0, y: 0.2, z: 1.1, w: 0.36, d: 0.9, h: 0.44, tw: 0.24, td: 0.58, oz: 0.05, bev: 0.03, top: DS.khaki, bevS: DS.sandLt, side: DS.khakiDk, back: DS.rustDk });
  b.lathe([0, 0.62, 1.13], [0, 1, 0], [[0, 0.08], [0.14, 0.05]], 6, EN.gun, null, EN.gunLt, { phase: Math.PI / 6 });
  // chin gun: turret ball + twin barrels
  b.lathe([0, -0.34, -1.2], [0, 1, 0], [[0, 0.11], [0.14, 0.1]], 6, EN.gunDk, EN.gunXDk, null, { phase: Math.PI / 6 });
  for (const x of [-0.045, 0.045]) b.lathe([x, -0.27, -1.28], [0, 0, -1], [[0, 0.032], [0.44, 0.026]], 4, EN.gunXDk, null, EN.black, { phase: Math.PI / 4 });
  // tailplane with hazard stripes
  b.block({ x: 0, y: 0.13, z: 1.5, w: 1.16, d: 0.2, h: 0.045, top: DS.khaki, side: DS.khakiDk });
  hazardStrip(b, -0.52, 1.5, 0.52, 1.5, 0.177, 0.14, 7, [0, 1, 0], EN.yellow, EN.black);
  const f0 = b.n;
  // --- right side (mirrored)
  // engine nacelle on the roof shoulder: dark intake, glowing exhaust
  b.lathe([0.28, 0.33, -0.34], [0, 0, 1], [[0, 0.1], [0.1, 0.13], [0.9, 0.1]], 6,
    (i, j) => (i === 0 ? DS.sandLt : (j === 1 || j === 2) ? DS.khakiLt : DS.khaki), EN.black, GL(scl(EM.engine, 0.6), 0.35), { phase: Math.PI / 6 });
  // stub wing + rocket pod under its tip (hazard band, glowing rocket noses)
  b.wing([{ x: 0.4, y: -0.06, zl: -0.26, zt: 0.26, t: 0.07 }, { x: 0.98, y: -0.02, zl: -0.2, zt: 0.18, t: 0.05 }],
    (i, j) => (j >= 4 ? DS.khakiDk : j === 0 ? DS.sandLt : DS.khaki), null, DS.khakiDk);
  b.lathe([0.97, -0.15, -0.62], [0, 0, 1], [[0, 0.08], [0.1, 0.12], [0.24, 0.12], [0.84, 0.1]], 6,
    (i, j) => (i === 1 ? ((j & 1) ? EN.black : EN.yellow) : (j === 1 || j === 2) ? DS.khakiLt : DS.khakiDk), DS.hot, EN.gunDk, { phase: Math.PI / 6 });
  // tail endplate fin
  b.block({ x: 0.58, y: 0.0, z: 1.48, w: 0.05, d: 0.28, h: 0.32, td: 0.18, oz: 0.05, top: EN.orange, side: DS.khaki });
  b.mirrorX(f0);
  return b;
}
/** Rotor: motion-blur disc with three swept lobes + crisp blades with hazard tips (vertex RGBA). */
function buildRotor(R) {
  const N = 14, RR = [0.09 * R, 0.88 * R, R];
  const A = [0.02, 0.15, 0.34];
  const C = [[0.42, 0.4, 0.36], [0.56, 0.52, 0.46], [1.0, 0.62, 0.18]];
  const sweep = (a) => { const f = ((a * 3) / TAU) % 1; return 0.3 + 0.7 * Math.pow(f, 2.4); };
  const pos = [], col = [];
  for (let r = 0; r < RR.length - 1; r++) {
    for (let k = 0; k < N; k++) {
      const a0 = (TAU * k) / N, a1 = (TAU * (k + 1)) / N;
      const P = (ri, a) => [Math.cos(a) * RR[ri], 0, Math.sin(a) * RR[ri]];
      const Cc = (ri, a) => [...C[ri], A[ri] * (ri >= 2 ? 1 : sweep(a))];
      pos.push(...P(r, a0), ...P(r + 1, a1), ...P(r + 1, a0), ...P(r, a0), ...P(r, a1), ...P(r + 1, a1));
      col.push(...Cc(r, a0), ...Cc(r + 1, a1), ...Cc(r + 1, a0), ...Cc(r, a0), ...Cc(r, a1), ...Cc(r + 1, a1));
    }
  }
  // three blades on the lobes' leading edges (the rotor turns toward +angle)
  for (let k = 0; k < 3; k++) {
    const a = (k * TAU) / 3, ca = Math.cos(a), sa = Math.sin(a), w = 0.045;
    const q = (r, s) => [ca * r - sa * s, 0.004, sa * r + ca * s];
    for (const [r0, r1, c] of [[0.06, 0.84 * R, [0.15, 0.14, 0.13, 0.9]], [0.84 * R, 0.98 * R, [1.0, 0.62, 0.16, 0.95]]]) {
      pos.push(...q(r0, -w), ...q(r1, -w), ...q(r1, w), ...q(r0, -w), ...q(r1, w), ...q(r0, w));
      for (let i = 0; i < 6; i++) col.push(...c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}
function createGunship() {
  const { g, pivot, ud } = enemyShell('gunship', 1.2, '#7a6a45');
  ud.halfExtents = { x: 1.1, z: 1.7 };
  const mat = bodyMat(0.62, 0.22);
  pivot.add(new THREE.Mesh(GG('ext:s2:gunship', buildGunship), mat));
  const dm = discMat();
  const rotorGeo = G('ext:s2:gunship.rotor', () => buildRotor(0.92));
  const rF = new THREE.Mesh(rotorGeo, dm), rR = new THREE.Mesh(rotorGeo, dm);
  rF.position.set(0, 0.57, -0.72); rR.position.set(0, 0.77, 1.13);
  rR.scale.x = -1;                                   // counter-rotating: its lobes trail the other way
  for (const r of [rF, rR]) { r.userData.noShadow = true; r.renderOrder = 1; }
  pivot.add(rF, rR);
  ud.rotors = [rF, rR];
  ud.muzzles = [new THREE.Vector3(0, -0.27, -1.74), new THREE.Vector3(-0.97, -0.15, -0.64), new THREE.Vector3(0.97, -0.15, -0.64)];
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    rF.rotation.y -= dt * 21; rR.rotation.y += dt * 21;
    pivot.position.y = Math.sin(t * 2.6) * 0.05;
    pivot.rotation.x = Math.sin(t * 1.9) * 0.035;
    pivot.rotation.z = Math.sin(t * 1.3) * 0.03;
    mat.uEmitScale.value = 0.8 + Math.sin(t * 5) * 0.2;
  };
  ud.dispose = () => { mat.dispose(); dm.dispose(); };
  return g;
}

// =============================================================================
// S2_STRIKER — desert delta-wing strike jet, cluster bombs under the wings (2 draw calls)
// =============================================================================
function buildStriker() {
  const b = new GB();
  // fuselage: 8-sided, long needle nose [z, halfWidth, top, bottom]
  const ring = ([z, w, t, bt]) => [[w * 0.45, t, z], [w, t * 0.4, z], [w, -bt * 0.35, z], [w * 0.5, -bt, z],
    [-w * 0.5, -bt, z], [-w, -bt * 0.35, z], [-w, t * 0.4, z], [-w * 0.45, t, z]];
  const ST = [[-1.32, 0.01, 0.01, 0.01], [-1.12, 0.07, 0.06, 0.05], [-0.72, 0.14, 0.12, 0.08], [-0.3, 0.2, 0.15, 0.1],
    [0.4, 0.22, 0.15, 0.1], [0.86, 0.2, 0.13, 0.09], [1.0, 0.18, 0.11, 0.08]];
  const s0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    if (i === 0) return EN.edgeLt;                                   // pale nose cone
    if (j === 7) return i === 3 ? DS.sandLt : DS.sand;
    if (j === 0 || j === 6) return i === 1 ? DS.sandLt : DS.sand;
    if (j === 1 || j === 5) return i === 4 ? DS.rust : DS.khaki;
    return DS.khakiDk;
  }, null, EN.gunXDk);
  const s1 = b.n;
  // canopy bubble + glowing visor eyes
  b.lathe([0, 0.08, -0.86], [0, 0.18, 1], [[0, 0.02], [0.1, 0.075], [0.34, 0.085], [0.5, 0.02]], 6,
    (i, j) => ((j === 1 || j === 2) ? DS.glassLt : DS.glass), null, null, { phase: Math.PI / 6, sy: 0.8 });
  b.drape([[[0.02, -1.08], [0.08, -0.98], [0.07, -0.93], [0.02, -1.0]], [[-0.02, -1.08], [-0.02, -1.0], [-0.07, -0.93], [-0.08, -0.98]]], GL(EM.eyeRed), s0, s1, 0.006, 1);
  // twin nozzles + glow
  for (const x of [-0.1, 0.1]) {
    b.lathe([x, -0.01, 0.86], [0, 0, 1], [[0, 0.085], [0.2, 0.075]], 6, (i, j) => (j & 1 ? EN.gunDk : EN.gun), null, GL(EM.engineHot, 0.5), { phase: Math.PI / 6 });
  }
  const f0 = b.n;
  // --- right side (mirrored)
  // cranked delta wing: sand with a rust camo panel and a hazard tip
  const w0 = b.n;
  b.wing([{ x: 0.16, y: -0.02, zl: -0.5, zt: 0.84, t: 0.07 }, { x: 0.62, y: 0.0, zl: 0.12, zt: 0.86, t: 0.045 },
    { x: 1.02, y: 0.02, zl: 0.56, zt: 0.88, t: 0.025 }], (i, j) => {
    if (j >= 4) return DS.khakiDk;
    if (j === 0) return DS.sandLt;                                    // bright leading edge
    if (i === 1) return j === 3 ? EN.black : (j & 1 ? EN.yellow : EN.black);   // hazard tip
    return j === 3 ? DS.khaki : DS.sand;
  }, null, EN.yellow);
  const w1 = b.n;
  b.drape([[[0.3, 0.1], [0.55, 0.3], [0.52, 0.6], [0.28, 0.5]]], DS.rust, w0, w1, 0.005, 1);
  b.drape([[[0.22, 0.6], [0.4, 0.62], [0.4, 0.8], [0.22, 0.8]]], DS.khaki, w0, w1, 0.005, 1);
  // canard
  b.wing([{ x: 0.12, y: 0.02, zl: -0.66, zt: -0.42, t: 0.03 }, { x: 0.42, y: 0.03, zl: -0.5, zt: -0.4, t: 0.015 }],
    (i, j) => (j >= 4 ? DS.khakiDk : j === 0 ? DS.sandLt : DS.sand), null, DS.khaki);
  // canted tail fin
  const f1 = b.n;
  b.wing([{ x: 0, zl: 0.46, zt: 1.0, t: 0.04 }, { x: 0.36, zl: 0.76, zt: 1.04, t: 0.02 }], (i, j) => (j === 0 ? DS.sandLt : j >= 3 ? DS.khakiDk : DS.rust), null, EN.orange);
  b.xform(f1, M(0.12, 0.08, 0, 0, 0, 62 * DEG));
  // intake
  b.block({ x: 0.2, y: -0.09, z: -0.2, w: 0.1, d: 0.42, h: 0.12, tw: 0.08, td: 0.34, oz: 0.04, top: DS.khaki, side: DS.khakiDk, front: EN.black });
  // cluster bombs under the wing: dark body, yellow band, red fuse glow
  b.lathe([0.48, -0.1, -0.1], [0, 0, 1], [[0, 0.02], [0.08, 0.07], [0.42, 0.07], [0.52, 0.04]], 5,
    (i, j) => (i === 1 ? (j === 1 || j === 2 ? EN.yellow : EN.yellowDk) : (j === 1 || j === 2) ? EN.gun : EN.gunXDk), GL(EM.eyeRed, 0.4), EN.gunDk, { phase: Math.PI / 5 });
  b.mirrorX(f0);
  return b;
}
const STRIKER_NOZZLES = [[-0.1, -0.01, 1.05], [0.1, -0.01, 1.05]];
function createStriker() {
  const { g, pivot, ud } = enemyShell('s2_striker', 0.9, '#b49a6a');
  ud.halfExtents = { x: 1.05, z: 1.2 };
  const mat = bodyMat(0.52, 0.25);
  pivot.add(new THREE.Mesh(GG('ext:s2:striker', buildStriker), mat));
  const fm = additiveMat();
  const flame = new THREE.Mesh(G('ext:s2:striker.flame', () => buildFlame(STRIKER_NOZZLES, FLAME_JET)), fm);
  flame.position.set(0, 0, 1.06); flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  ud.muzzles = [new THREE.Vector3(0, -0.1, -1.3), new THREE.Vector3(-0.48, -0.12, 0.2), new THREE.Vector3(0.48, -0.12, 0.2)];
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    const fl = 1 + Math.sin(t * 51) * 0.08 + Math.sin(t * 29) * 0.05;
    flame.scale.set(1, 1, 1.4 * fl);
    mat.uEmitScale.value = 0.85 + Math.sin(t * 13) * 0.15;
    pivot.rotation.z = Math.sin(t * 2.1) * 0.05;
  };
  ud.dispose = () => { mat.dispose(); fm.dispose(); };
  return g;
}

// =============================================================================
// MLRS — six-wheeled rocket truck: hull, traversing mount, elevating 6-tube launcher (3 draw calls)
// =============================================================================
function buildMlrsHull() {
  const b = new GB();
  // chassis rails + bed
  b.block({ x: 0, y: 0.16, z: 0.02, w: 0.74, d: 2.62, h: 0.2, top: EN.gunDk, side: EN.gunXDk });
  b.block({ x: 0, y: 0.36, z: 0.42, w: 1.06, d: 1.86, h: 0.14, bev: 0.03, top: DS.khaki, bevS: DS.sandLt, side: DS.khakiDk, back: DS.rustDk });
  // armoured cab with a sloped windscreen face
  b.block({ x: 0, y: 0.3, z: -1.02, w: 1.1, d: 0.86, h: 0.62, tw: 0.98, td: 0.58, oz: 0.1, bev: 0.05, top: DS.khaki, bevS: DS.sandLt, side: DS.khakiDk, front: DS.khakiDk, back: DS.rust });
  b.decal([[-0.4, 0.8, -1.3], [0.4, 0.8, -1.3], [0.36, 0.9, -1.24], [-0.36, 0.9, -1.24]], DS.glassLt, [0, 0.6, -1]);
  // roof: hatch ring, hazard band, amber beacon
  b.lathe([0.2, 0.92, -0.9], [0, 1, 0], [[0, 0.14], [0.05, 0.12], [0.07, 0.0]], 6, DS.khakiDk, null, null);
  hazardStrip(b, -0.44, -0.62, 0.44, -0.62, 0.925, 0.1, 6, [0, 1, 0], EN.yellow, EN.black);
  b.block({ x: -0.28, y: 0.92, z: -0.78, w: 0.1, d: 0.1, h: 0.07, top: GL(EM.amber), side: GL(EM.amber, 0.5) });
  // bumper grille + headlights
  b.block({ x: 0, y: 0.18, z: -1.46, w: 1.14, d: 0.12, h: 0.2, top: EN.gunDk, side: EN.gunXDk, front: EN.gun });
  for (const sg of [-1, 1]) b.decal([[0.3 * sg, 0.62, -1.448], [0.46 * sg, 0.62, -1.448], [0.46 * sg, 0.54, -1.46], [0.3 * sg, 0.54, -1.46]], GL(EM.amber), [0, 0.2, -1]);
  // rear: hazard edge + tail lights, stabiliser jacks
  hazardStrip(b, -0.5, 1.3, 0.5, 1.3, 0.505, 0.1, 7, [0, 1, 0], EN.yellow, EN.black);
  for (const sg of [-1, 1]) {
    b.decal([[0.34 * sg, 0.46, 1.352], [0.48 * sg, 0.46, 1.352], [0.48 * sg, 0.4, 1.352], [0.34 * sg, 0.4, 1.352]], GL(EM.red), [0, 0, 1]);
    b.block({ x: 0.56 * sg, y: 0.0, z: 1.18, w: 0.1, d: 0.14, h: 0.4, top: EN.gunLt, side: EN.gunDk });
  }
  const f0 = b.n;
  // --- right side (mirrored): wheels, mud guards, side locker
  for (const z of [-0.9, 0.24, 0.86]) {
    b.lathe([0.4, 0.24, z], [1, 0, 0], [[0, 0.24], [0.2, 0.24]], 8, (i, j) => (j & 1 ? DS.rubberLt : DS.rubber), null, EN.gun, { phase: Math.PI / 8 });
  }
  b.block({ x: 0.5, y: 0.46, z: -0.9, w: 0.26, d: 0.56, h: 0.05, top: DS.khakiDk, side: DS.sandDk });
  b.block({ x: 0.5, y: 0.5, z: 0.55, w: 0.24, d: 1.0, h: 0.05, top: DS.khakiDk, side: DS.sandDk });
  b.block({ x: 0.5, y: 0.34, z: -0.33, w: 0.16, d: 0.4, h: 0.22, bev: 0.02, top: DS.sand, bevS: DS.sandLt, side: DS.khaki });
  b.mirrorX(f0);
  return b;
}
function buildMlrsMount() {   // traversing ring + trunnion cheeks (origin: centre of the ring, on the bed)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.44], [0.1, 0.42], [0.14, 0.34]], 8, (i) => (i === 0 ? EN.gunDk : EN.gun), null, EN.gunDk, { phase: Math.PI / 8 });
  for (const sg of [-1, 1]) b.block({ x: 0.36 * sg, y: 0.1, z: 0.45, w: 0.1, d: 0.5, h: 0.3, td: 0.3, oz: 0.06, top: DS.sandLt, side: DS.khakiDk });
  return b;
}
function buildMlrsLauncher() {   // box of 6 tubes; origin at the rear trunnion pivot, tubes along −z
  const b = new GB();
  b.block({ x: 0, y: -0.04, z: -0.78, w: 0.84, d: 1.62, h: 0.56, bev: 0.04, top: DS.sand, bevS: DS.sandLt, side: DS.sandDk, front: EN.gunDk, back: DS.khakiDk });
  // lid: stencilled hazard band at the muzzle end, stiffening ribs, a rust panel and a warning lamp
  hazardStrip(b, -0.36, -1.38, 0.36, -1.38, 0.525, 0.14, 6, [0, 1, 0], EN.yellow, EN.black);
  for (const z of [-1.12, -0.78, -0.44, -0.1]) b.block({ x: 0, y: 0.52, z, w: 0.86, d: 0.08, h: 0.035, top: DS.sandLt, side: DS.khaki });
  b.decal([[-0.3, 0.524, -0.66], [0.3, 0.524, -0.66], [0.3, 0.524, -0.9], [-0.3, 0.524, -0.9]], DS.rust);
  b.decal([[-0.3, 0.524, -0.32], [0.3, 0.524, -0.32], [0.3, 0.524, -0.56], [-0.3, 0.524, -0.56]], DS.rust);
  b.block({ x: 0.32, y: 0.52, z: 0.0, w: 0.08, d: 0.08, h: 0.06, top: GL(EM.red), side: GL(EM.red, 0.5) });
  // tube mouths with glowing rocket noses
  for (const x of [-0.26, 0, 0.26]) for (const y of [0.1, 0.34]) {
    const oct = Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 6 + (k * TAU) / 6; return [x + Math.cos(a) * 0.1, y + Math.sin(a) * 0.1, -1.595]; });
    b.decal(oct, EN.black, [0, 0, -1]);
    b.decal(oct.map(([px, py]) => [x + (px - x) * 0.5, y + (py - y) * 0.5, -1.6]), DS.hot, [0, 0, -1]);
  }
  return b;
}
const MLRS_TUBES = [[-0.26, 0.1], [0.26, 0.34], [0, 0.1], [-0.26, 0.34], [0.26, 0.1], [0, 0.34]];
function createMlrs() {
  const { g, pivot, ud } = enemyShell('mlrs', 1.0, '#7a6a45');
  ud.ground = true;
  ud.halfExtents = { x: 0.62, z: 1.5 };
  const mat = bodyMat(0.72, 0.16);
  pivot.add(new THREE.Mesh(GG('ext:s2:mlrs.hull', buildMlrsHull), mat));
  const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.5, 0.52);
  turret.add(new THREE.Mesh(GG('ext:s2:mlrs.mount', buildMlrsMount), mat));
  const launcher = new THREE.Group(); launcher.name = 'launcher'; launcher.position.set(0, 0.2, 0.62);
  launcher.add(new THREE.Mesh(GG('ext:s2:mlrs.launcher', buildMlrsLauncher), mat));
  turret.add(launcher); pivot.add(turret);
  ud.turret = turret; ud.launcher = launcher;
  launcher.userData.muzzles = MLRS_TUBES.map(([x, y]) => new THREE.Vector3(x, y, -1.7));
  const local = [new THREE.Vector3(0, 0.42, -1.1)];
  turret.userData.muzzles = local;
  ud.muzzles = [new THREE.Vector3()];
  let raise = 0;
  /** launcher elevation 0 (stowed) … 1 (raised ~34°) */
  ud.setRaise = (k) => { raise = Math.max(0, Math.min(1, k)); launcher.rotation.x = raise * 0.6; };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => { syncMuzzles(ud.muzzles, local, turret); mat.uEmitScale.value = 0.75 + raise * 0.35 + Math.sin(t * 6) * 0.15; };
  syncMuzzles(ud.muzzles, local, turret);
  ud.dispose = () => mat.dispose();
  return g;
}

// =============================================================================
// SANDSKIFF — fast hovercraft: skirt, deck, twin ducted fans, bow gun (4 draw calls)
// =============================================================================
const SKIFF_FAN = [0.3, 0.6, 0.62];       // right fan hub (duct centre), hull-local
const SKIFF_TILT = -28 * DEG;              // duct axis pitched up-back toward the camera
function buildSkiffHull() {
  const b = new GB();
  // inflated skirt: rounded-rect rings (bottom tuck, bulge, deck lip)
  const rr = (hw, z0, z1, c, y) => {
    const pts = [];
    const corners = [[hw - c, z0 + c, -Math.PI / 2], [hw - c, z1 - c, 0], [-hw + c, z1 - c, Math.PI / 2], [-hw + c, z0 + c, Math.PI]];
    for (const [cx, cz, a0] of corners) for (let k = 0; k < 3; k++) { const a = a0 + (k * Math.PI) / 4; pts.push([cx + Math.cos(a) * c, y, cz + Math.sin(a) * c]); }
    return pts;
  };
  b.loft([rr(0.5, -0.92, 0.82, 0.28, 0.02), rr(0.64, -1.02, 0.94, 0.36, 0.12), rr(0.58, -0.98, 0.9, 0.34, 0.24)],
    (i, j) => (i === 0 ? DS.rubber : (j % 3 === 1 ? DS.rubberLt : DS.rubber)), null, null);
  // deck plate: pointed bow
  const d0 = b.n;
  b.plate([[0, -1.02], [0.44, -0.78], [0.56, -0.3], [0.56, 0.86], [-0.56, 0.86], [-0.56, -0.3], [-0.44, -0.78]], 0.2, 0.34, DS.sand, DS.rustDk);
  const d1 = b.n;
  hazardDrape(b, -0.32, -0.66, 0.32, -0.66, 0.14, 5, EN.yellow, EN.black, d0, d1, 0.005, 1);
  b.drape([[[-0.5, 0.2], [0.5, 0.2], [0.5, 0.34], [-0.5, 0.34]]], DS.rust, d0, d1, 0.004, 1);
  // cabin with a wrap-round visor
  b.block({ x: 0, y: 0.34, z: -0.1, w: 0.56, d: 0.62, h: 0.26, tw: 0.46, td: 0.46, oz: 0.03, bev: 0.03, top: DS.khaki, bevS: DS.sandLt, side: DS.khakiDk, front: DS.glass });
  b.decal([[-0.21, 0.58, -0.3], [0.21, 0.58, -0.3], [0.2, 0.61, -0.22], [-0.2, 0.61, -0.22]], DS.glassLt);
  b.decal([[-0.06, 0.612, 0.0], [0.06, 0.612, 0.0], [0.06, 0.612, 0.1], [-0.06, 0.612, 0.1]], GL(EM.amber));
  // antenna mast
  b.lathe([-0.2, 0.6, 0.12], [0, 1, 0], [[0, 0.018], [0.42, 0.01]], 3, EN.gunDk, null, GL(EM.red, 0.5));
  // bow sensor eye
  b.decal([[-0.08, 0.342, -0.9], [0.08, 0.342, -0.9], [0.06, 0.342, -0.82], [-0.06, 0.342, -0.82]], GL(EM.eyeRed));
  const f0 = b.n;
  // --- right side (mirrored): fan duct with a dark fan bed (tilted back so the spinning fan faces
  // the camera, airboat style), pylon, rudder, jerry can
  const u0 = b.n;
  b.lathe([0.3, 0.6, 0.48], [0, 0, 1], [[0, 0.3], [0.05, 0.31], [0.24, 0.31], [0.28, 0.29]], 10,
    (i, j) => (i === 0 ? DS.sandLt : (j === 2 || j === 3) ? DS.khakiLt : i === 2 ? DS.khakiDk : DS.khaki), null, null);
  b.lathe([0.3, 0.6, 0.52], [0, 0, 1], [[0, 0.28], [0.02, 0.0]], 8, EN.gunXDk, null, null);
  b.xform(u0, M(...SKIFF_FAN, SKIFF_TILT).multiply(M(-SKIFF_FAN[0], -SKIFF_FAN[1], -SKIFF_FAN[2])));
  b.block({ x: 0.3, y: 0.34, z: 0.52, w: 0.18, d: 0.12, h: 0.28, top: DS.khakiDk, side: EN.gunDk });
  b.block({ x: 0.3, y: 0.32, z: 0.97, w: 0.04, d: 0.16, h: 0.4, td: 0.12, top: EN.orange, side: DS.rust });
  b.block({ x: 0.46, y: 0.34, z: -0.46, w: 0.12, d: 0.22, h: 0.14, bev: 0.02, top: DS.khakiLt, bevS: DS.sandLt, side: DS.khaki });
  b.mirrorX(f0);
  return b;
}
function buildSkiffFan() {   // 5 blades + hub, spinning about z (origin at the hub)
  const b = new GB();
  for (let k = 0; k < 5; k++) {
    const f = b.n;
    b.block({ x: 0.14, y: -0.014, z: 0, w: 0.24, d: 0.07, h: 0.028, top: EN.gunDk, side: EN.gunXDk });
    // pitch about the blade's own axis, spread round the hub, then stand the disc up (normal → +z)
    b.xform(f, M(0, 0, 0, 0.3, 0, 0).premultiply(M(0, 0, 0, 0, (k * TAU) / 5, 0)).premultiply(M(0, 0, 0, Math.PI / 2, 0, 0)));
  }
  b.lathe([0, 0, -0.04], [0, 0, 1], [[0, 0.06], [0.08, 0.05]], 6, EN.gun, EN.gunLt, null);
  return b;
}
function buildSkiffGun() {   // bow gun: squat mount + single barrel along −z
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.17], [0.08, 0.15], [0.13, 0.08]], 6, (i) => (i === 0 ? EN.gunDk : EN.gun), null, EN.gunLt, { phase: Math.PI / 6 });
  b.block({ x: 0, y: 0.05, z: -0.05, w: 0.16, d: 0.22, h: 0.1, top: DS.khakiLt, side: DS.khakiDk });
  b.lathe([0, 0.1, -0.14], [0, 0, -1], [[0, 0.035], [0.4, 0.028], [0.4, 0.04], [0.46, 0.04]], 5, (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black);
  return b;
}
function createSkiff() {
  const { g, pivot, ud } = enemyShell('sandskiff', 0.8, '#b49a6a');
  ud.ground = true;
  ud.halfExtents = { x: 0.65, z: 1.0 };
  const mat = bodyMat(0.66, 0.18);
  pivot.add(new THREE.Mesh(GG('ext:s2:sandskiff.hull', buildSkiffHull), mat));
  const fanGeo = GG('ext:s2:sandskiff.fan', buildSkiffFan);
  const fanL = new THREE.Mesh(fanGeo, mat), fanR = new THREE.Mesh(fanGeo, mat);
  fanL.position.set(-SKIFF_FAN[0], SKIFF_FAN[1], SKIFF_FAN[2]); fanR.position.set(...SKIFF_FAN);
  fanL.rotation.x = fanR.rotation.x = SKIFF_TILT;     // spin (z) inside the tilted duct (Euler XYZ)
  pivot.add(fanL, fanR);
  const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.34, -0.62);
  turret.add(new THREE.Mesh(GG('ext:s2:sandskiff.gun', buildSkiffGun), mat));
  pivot.add(turret);
  ud.turret = turret;
  const local = [new THREE.Vector3(0, 0.1, -0.6)];
  turret.userData.muzzles = local;
  ud.muzzles = [new THREE.Vector3()];
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    fanL.rotation.z += dt * 30; fanR.rotation.z -= dt * 30;
    pivot.position.y = 0.05 + Math.sin(t * 7.3) * 0.03;
    pivot.rotation.z = Math.sin(t * 3.1) * 0.03;
    syncMuzzles(ud.muzzles, local, turret);
    mat.uEmitScale.value = 0.8 + Math.sin(t * 9) * 0.2;
  };
  syncMuzzles(ud.muzzles, local, turret);
  ud.dispose = () => mat.dispose();
  return g;
}

// =============================================================================
// SCORPION — mid-boss assault walker (6 draw calls, ≤ 2500 triangles)
//   body (+ the core part: the carapace swaps to its blown-open variant in setOpen), two tripod
//   leg sets (one geometry, the second mirrored: L-front/R-mid/L-rear and R-front/L-mid/R-rear
//   step alternately), claw cannons L/R (one geometry, mirrored), tail with the mortar pod.
// =============================================================================
const SC = {
  CORE: [0, 2.08, -1.02],                 // reactor under the carapace (core part origin)
  CLAW: [1.22, 1.3, -1.9],                // right shoulder (left is mirrored)
  TAIL: [0, 1.46, 2.28],                  // tail root on the abdomen
  POD: [-1.2, 2.5, -1.2],                 // mortar pod, tail-root-local: the tail arcs over to one flank
};
function scRing([z, w, t, bt, yc]) {
  // 8-sided armoured section; edges: 0 right bevel 1 right upper 2 right lower 3 belly 4 left lower 5 left upper 6 left bevel 7 top
  return [[w * 0.45, yc + t, z], [w * 0.9, yc + t * 0.62, z], [w, yc, z], [w * 0.7, yc - bt, z],
    [-w * 0.7, yc - bt, z], [-w, yc, z], [-w * 0.9, yc + t * 0.62, z], [-w * 0.45, yc + t, z]];
}
function buildScorpionBody(open) {
  const b = new GB();
  // cephalothorax
  const CE = [[-2.42, 0.42, 0.2, 0.18, 1.28], [-2.2, 0.86, 0.4, 0.32, 1.3], [-1.7, 1.25, 0.58, 0.44, 1.34], [-0.9, 1.46, 0.66, 0.48, 1.38],
    [-0.3, 1.36, 0.62, 0.46, 1.38], [-0.08, 1.06, 0.5, 0.4, 1.38]];
  const c0 = b.n;
  b.loft(CE.map(scRing), (i, j) => {
    if (j === 7) return i === 0 ? DS.sandLt : DS.sand;
    if (j === 0 || j === 6) return i === 1 ? DS.sandLt : DS.sandDk;
    if (j === 1 || j === 5) return i === 2 ? DS.rustLt : DS.rust;
    if (j === 2 || j === 4) return DS.rustDk;
    return EN.gunXDk;
  }, DS.rustDk, DS.rustDk);
  const c1 = b.n;
  // abdomen: overlapping armour segments (each ridge a raised band)
  const AB = [[0.0, 1.06, 0.5, 0.4, 1.38], [0.1, 1.3, 0.6, 0.44, 1.4], [0.58, 1.28, 0.58, 0.42, 1.4], [0.68, 1.1, 0.48, 0.38, 1.38],
    [0.78, 1.22, 0.55, 0.4, 1.38], [1.26, 1.16, 0.52, 0.38, 1.37], [1.36, 1.0, 0.44, 0.34, 1.36], [1.46, 1.08, 0.48, 0.34, 1.36],
    [1.94, 0.92, 0.42, 0.3, 1.35], [2.36, 0.5, 0.3, 0.24, 1.38]];
  const a0 = b.n;
  b.loft(AB.map(scRing), (i, j) => {
    const lip = i === 0 || i === 3 || i === 6;                     // segment seams
    if (j === 7) return lip ? DS.rustDk : (i & 1 ? DS.sand : DS.sandLt);
    if (j === 0 || j === 6) return lip ? DS.rustDk : DS.sandDk;
    if (j === 1 || j === 5) return lip ? EN.gunXDk : DS.rust;
    return EN.gunXDk;
  }, DS.rustDk, DS.rustDk);
  const a1 = b.n;
  // hazard chevrons + glowing vents on the abdomen
  hazardDrape(b, 0, 1.52, 0, 1.9, 0.9, 5, EN.yellow, EN.black, a0, a1, 0.01, 1);
  for (const sg of [-1, 1]) for (const z of [0.2, 0.36, 0.9, 1.06]) {
    b.drape([[[0.18 * sg, z], [0.62 * sg, z], [0.62 * sg, z + 0.07], [0.18 * sg, z + 0.07]]], z < 0.5 ? DS.hot : EN.gunXDk, a0, a1, 0.008, 1);
  }
  // head: eye cluster (6 glowing eyes on the brow) + mandible spikes
  const eyes = [[0.14, -2.18], [0.32, -2.1], [0.48, -1.98], [-0.14, -2.18], [-0.32, -2.1], [-0.48, -1.98]];
  for (const [x, z] of eyes) b.drape([[[x - 0.07, z - 0.05], [x + 0.07, z - 0.05], [x + 0.06, z + 0.05], [x - 0.06, z + 0.05]]], GL(EM.eyeRed), c0, c1, 0.012, 1);
  for (const sg of [-1, 1]) {
    b.spike([[0.16 * sg, 1.1, -2.34], [0.42 * sg, 1.14, -2.28], [0.3 * sg, 1.34, -2.3]], [0.2 * sg, 1.08, -2.95], (k) => (k === 2 ? EN.edgeLt : DS.sandDk), DS.rustDk);
  }
  // sockets: claw shoulders, hips, tail root
  for (const sg of [-1, 1]) {
    b.lathe([1.08 * sg, 1.3, -1.9], [sg, 0, 0], [[0, 0.3], [0.22, 0.26]], 6, EN.gunDk, null, EN.gun, { phase: Math.PI / 6 });
    for (const z of [-1.55, -1.0, -0.28]) b.lathe([1.2 * sg, 1.28, z], [sg, 0, 0], [[0, 0.22], [0.16, 0.2]], 5, EN.gunDk, null, EN.gun);
  }
  b.lathe([0, 1.4, 2.2], [0, 0.4, 1], [[0, 0.44], [0.2, 0.4]], 6, EN.gunDk, null, EN.gunXDk, { phase: Math.PI / 6 });
  // carapace over the reactor: closed = two armour shells meeting on a dim glowing seam;
  // open = the shells blown out to the sides and the molten reactor dome exposed
  const [cx, cy, cz] = SC.CORE;
  const shell = shellGB(SC_SHELL);
  for (const sg of [-1, 1]) appendGB(b, shell, shellMatrix(cx, cy - 0.22, cz, 0.82 * sg, 0.7, 0.98, open ? 125 * DEG : 0));
  if (open) {
    // socket rim + the reactor dome with hot cells
    b.lathe([cx, cy - 0.3, cz], [0, 1, 0], [[0, 0.78], [0.22, 0.74], [0.3, 0.6]], 10, (i, j) => (i === 1 ? (j & 1 ? EN.gun : EN.gunDk) : EN.gunXDk), null, null);
    b.lathe([cx, cy - 0.2, cz], [0, 1, 0], [[0, 0.6], [0.26, 0.56], [0.46, 0.4], [0.58, 0.16], [0.6, 0.0]], 10,
      (i, j) => GL(scl(MOLTEN, ((i + j) & 1) ? 1 : 0.66), 0.5), null, null);
  }
  return b;
}
const SC_SHELL = { a: DS.sand, b: DS.sandLt, trim: EN.yellow, edge: DS.sandLt, rim: DS.rustDk, inner: EN.gunXDk, lip: GL(scl(MOLTEN, 0.3), 0.25), end: DS.rust };
function buildScorpionLegs() {  // tripod: L-front, R-mid, L-rear (the other tripod is this mirrored in x)
  const b = new GB();
  const leg = (sg, zA, zF, zK) => {
    const hip = [1.3 * sg, 1.28, zA], knee = [2.42 * sg, 2.12, zK], foot = [3.3 * sg, 0.0, zF];
    const mid = [(knee[0] + foot[0]) / 2 + 0.06 * sg, (knee[1] + foot[1]) / 2 + 0.18, (knee[2] + foot[2]) / 2];
    strut(b, hip, knee, 0.2, 0.15, 6, (i, j) => (j === 1 || j === 2 ? DS.sandLt : j === 0 || j === 3 ? DS.sand : DS.rustDk));
    strut(b, knee, mid, 0.15, 0.11, 5, (i, j) => (j & 1 ? EN.gun : EN.gunDk));
    strut(b, mid, foot, 0.11, 0.035, 5, (i, j) => (j & 1 ? EN.yellow : EN.black));
    // knee spike
    b.spike([[knee[0] - 0.12 * sg, knee[1] - 0.05, knee[2] - 0.12], [knee[0] + 0.1 * sg, knee[1] - 0.05, knee[2]], [knee[0] - 0.12 * sg, knee[1] - 0.05, knee[2] + 0.12]],
      [knee[0] + 0.18 * sg, knee[1] + 0.42, knee[2]], (k) => (k === 1 ? EN.edgeLt : DS.rust), null);
  };
  leg(-1, -1.55, -2.55, -2.12);
  leg(1, -1.0, -1.0, -1.05);
  leg(-1, -0.28, 0.95, 0.4);
  return b;
}
const SC_HAND = [0.46, 0.12, -1.55];      // right hand centre, shoulder-local (the claw part's origin)
function buildScorpionClaw() {  // right claw, part-local (origin at the hand; the arm runs back to the shoulder)
  const b = new GB();
  const H = SC_HAND, o = (p) => [p[0] - H[0], p[1] - H[1], p[2] - H[2]];
  const armSt = (i, j) => (j === 1 || j === 2 ? DS.sandLt : j === 0 || j === 3 ? DS.sand : DS.rustDk);
  // upper arm out to the elbow, forearm in to the wrist
  const sh = o([0, 0, 0]), el = o([0.6, 0.1, -0.55]), wr = o([0.46, 0.12, -0.98]);
  strut(b, sh, el, 0.27, 0.22, 6, armSt, null, Math.PI / 6);
  strut(b, el, wr, 0.22, 0.27, 6, armSt, null, Math.PI / 6);
  b.lathe(addP(el, [0, -0.18, 0]), [0, 1, 0], [[0, 0.24], [0.3, 0.22], [0.4, 0.1]], 6, EN.gunDk, null, EN.gun, { phase: Math.PI / 6 });
  // pincer hand: a bulging armoured chela
  const ring = ([z, w, h]) => [[w * 0.6, h, z], [w, 0, z], [w * 0.6, -h * 0.8, z], [-w * 0.6, -h * 0.8, z], [-w, 0, z], [-w * 0.6, h, z]];
  const h0 = b.n;
  b.loft([[-0.92, 0.3, 0.22], [-1.08, 0.5, 0.34], [-1.62, 0.56, 0.38], [-2.08, 0.42, 0.3]].map((r) => ring(r).map((q) => [q[0], q[1], q[2] - H[2]])), (i, j) => {
    if (j === 5 || j === 0) return i === 1 ? (j === 0 ? EN.yellow : EN.black) : (i === 0 ? DS.sandLt : DS.sand);
    if (j === 1 || j === 4) return DS.rust;
    return DS.rustDk;
  }, null, EN.gunDk);
  const h1 = b.n;
  b.drape([[[-0.24, 0.16], [-0.08, 0.16], [-0.08, 0.28], [-0.24, 0.28]]], GL(EM.eyeRed), h0, h1, 0.008, 1);
  // fingers: outer (fixed) and inner (movable), each a tapered knuckle + a hooked blade
  for (const [base, mid, tip, r] of [[[0.76, 0.14, -2.0], [0.9, 0.14, -2.58], [0.62, 0.14, -3.22], 0.17], [[0.16, 0.14, -2.0], [0.04, 0.14, -2.52], [0.3, 0.14, -3.06], 0.15]]) {
    const B = o(base), Md = o(mid), T = o(tip);
    strut(b, B, Md, r, r * 0.72, 4, (i, j) => (j === 1 ? DS.sandLt : j === 0 ? DS.sand : DS.rustDk), null, Math.PI / 4);
    const q = r * 0.72;
    b.spike([[Md[0] - q, Md[1], Md[2]], [Md[0], Md[1] + q, Md[2]], [Md[0] + q, Md[1], Md[2]], [Md[0], Md[1] - q, Md[2]]], T,
      (k) => (k === 0 ? EN.edgeLt : k === 1 ? DS.sand : DS.rustDk), null);
  }
  // cannon between the fingers, molten bore
  b.lathe(o([0.46, 0.16, -2.02]), [0, 0, -1], [[0, 0.14], [0.12, 0.12], [0.76, 0.1], [0.82, 0.13], [0.98, 0.13]], 6,
    (i) => (i === 3 ? EN.edge : i === 1 ? EN.gunDk : EN.gun), null, DS.hot, { phase: Math.PI / 6 });
  return b;
}
const SC_POD_DIR = [0, 0.5, -1];
function buildScorpionTail() {  // part-local: origin at the mortar pod; the tail runs back down to the root
  const b = new GB();
  const P = SC.POD, off = (p) => [p[0] - P[0], p[1] - P[1], p[2] - P[2]];
  const C = [[0, 0, 0], [-0.18, 0.86, 0.52], [-0.55, 1.84, 0.44], [-1.0, 2.42, -0.28], P].map(off);
  const R = [0.42, 0.36, 0.32, 0.28, 0.26];
  for (let k = 0; k < 4; k++) {
    strut(b, C[k], C[k + 1], R[k], R[k + 1] * 0.94, 6, (i, j) => (j === 1 || j === 2 ? (k & 1 ? DS.sandLt : DS.sand) : j === 0 || j === 3 ? DS.rust : DS.rustDk), null, Math.PI / 6);
    if (k > 0) b.lathe(addP(C[k], [0, -0.06, 0]), [0, 1, 0], [[0, R[k] * 1.12], [0.12, R[k] * 1.1]], 6, EN.gunDk, null, EN.gun);
  }
  // dorsal spines along the tail
  for (let k = 1; k < 4; k++) {
    const c = C[k];
    b.spike([[c[0] - 0.1, c[1] + R[k] * 0.8, c[2] - 0.12], [c[0] + 0.1, c[1] + R[k] * 0.8, c[2] - 0.12], [c[0], c[1] + R[k] * 0.8, c[2] + 0.14]],
      [c[0], c[1] + R[k] + 0.3, c[2] + 0.2], (q) => (q === 2 ? EN.edgeLt : DS.rust), null);
  }
  // mortar pod: heavy drum along SC_POD_DIR, hazard band, molten bore
  const d = SC_POD_DIR, l = Math.hypot(d[0], d[1], d[2]), u = [d[0] / l, d[1] / l, d[2] / l];
  b.lathe([-u[0] * 0.4, -u[1] * 0.4, -u[2] * 0.4], u, [[0, 0.2], [0.1, 0.34], [0.32, 0.36], [0.42, 0.36], [0.62, 0.3], [0.86, 0.28], [0.92, 0.33], [1.0, 0.33]], 8,
    (i, j) => (i === 2 ? (j & 1 ? EN.black : EN.yellow) : i === 5 ? EN.edge : (j === 1 || j === 2 || j === 3) ? DS.sand : DS.rustDk), EN.gunDk, DS.hot, { phase: Math.PI / 8 });
  return b;
}
function addP(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
/** Right quarter-dome armour shell (the left one is its x mirror); its hinge runs along the outer
 *  lower edge (x = 0.95, y = 0.16). st = { a, b (alternating plates), trim (end bands), edge
 *  (seam edge), rim (outer lower edge), inner, lip (inner seam lip), end (end caps) }. */
function shellGB(st) {
  const b = new GB();
  const prof = [[0.0, 0.96], [0.32, 0.92], [0.62, 0.76], [0.84, 0.5], [0.94, 0.16]];
  const inner = [[0.0, 0.84], [0.28, 0.8], [0.54, 0.66], [0.74, 0.43], [0.84, 0.16]];
  const zs = [[-0.94, 0.55], [-0.68, 0.88], [-0.28, 1.0], [0.28, 1.0], [0.68, 0.88], [0.94, 0.55]];
  const ringAt = ([z, sc]) => [...prof.map(([x, y]) => [x * sc + 0.012, 0.16 + (y - 0.16) * (0.6 + sc * 0.4), z]),
    ...inner.slice().reverse().map(([x, y]) => [x * sc + 0.012, 0.16 + (y - 0.16) * (0.6 + sc * 0.4), z])];
  const NP = prof.length;
  b.loft(zs.map(ringAt), (i, j) => {
    if (j >= NP) return j === 2 * NP - 1 ? st.lip : st.inner;
    if (j === NP - 1) return st.rim;
    if (i === 0 || i === zs.length - 2) return st.trim;
    if (j === 0) return st.edge;
    return (i + j) & 1 ? st.a : st.b;
  }, st.end, st.end);
  return b;
}
/** place a shellGB at (x, y, z) scaled (sx < 0 = the left shell), swung open by `open` radians about its hinge */
function shellMatrix(x, y, z, sx, sy, sz, open) {
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
  if (open) m.multiply(new THREE.Matrix4().makeTranslation(0.94, 0.16, 0)).multiply(new THREE.Matrix4().makeRotationZ(-open)).multiply(new THREE.Matrix4().makeTranslation(-0.94, -0.16, 0));
  return m;
}
/** append a copy of src's triangles to b, transformed by m */
function appendGB(b, src, m) {
  const start = b.n;
  for (let i = 0; i < src.p.length; i++) { b.p.push(src.p[i]); b.c.push(src.c[i]); b.e.push(src.e[i]); }
  b.xform(start, m);
}
function createScorpion() {
  const { g, pivot, ud } = enemyShell('scorpion', 2.6, '#86432a');
  ud.ground = true; ud.midboss = true;
  ud.halfExtents = { x: 3.4, z: 3.6 };
  const hullMat = bodyMat(0.68, 0.22);
  const closedGeo = GG('ext:s2:scorpion.body', () => buildScorpionBody(false));
  const openGeo = GG('ext:s2:scorpion.bodyOpen', () => buildScorpionBody(true));
  const body = new THREE.Mesh(closedGeo, hullMat); body.name = 'body';
  pivot.add(body);
  const legGeo = GG('ext:s2:scorpion.legs', buildScorpionLegs);
  const legA = new THREE.Mesh(legGeo, hullMat), legB = new THREE.Mesh(legGeo, hullMat);
  legB.scale.x = -1;
  pivot.add(legA, legB);
  // core: the reactor under the carapace (flashes the whole body; setOpen swaps the carapace).
  // Destroyed, the walker's systems die: every glow (reactor, eyes, vents) fades to embers.
  let dead = false;
  const core = makePart('core', 0.95, [{ mesh: body }], [new THREE.Vector3(0, 0.5, 0)], { onDestroyed: (d) => { dead = d; } });
  core.position.set(SC.CORE[0], SC.CORE[1], SC.CORE[2]);
  pivot.add(core);
  let open = 0;
  core.userData.setOpen = (v) => { open = Math.max(0, Math.min(1, v)); body.geometry = open > 0.5 ? openGeo : closedGeo; core.userData.open = open; };
  // claws (mirrored)
  // claws (mirrored): a shoulder pivot that aims, the part at the pincer hand (its hit circle)
  const clawKeep = { keep: (x, y, z) => z + 0.15, crumple: 0.1, seed: 21, dir: [0, 0, -1], shards: 9, shardSize: 0.24, band: 0.45 };
  const clawPivots = [];
  const mkClaw = (sg) => {
    const m = bodyMat(0.66, 0.22);
    const intact = GG('ext:s2:scorpion.claw', buildScorpionClaw);
    const wreck = wreckGeo('ext:s2:scorpion.claw', buildScorpionClaw, clawKeep);
    const mesh = new THREE.Mesh(intact, m);
    if (sg < 0) mesh.scale.x = -1;
    const part = makePart(sg < 0 ? 'clawL' : 'clawR', 0.82, [{ mesh, intact, wreck, sag: [0.18, -0.3, 0.1 * sg] }],
      [new THREE.Vector3(0, 0.04, -1.52)]);
    part.position.set(SC_HAND[0] * sg, SC_HAND[1], SC_HAND[2]);
    const piv = new THREE.Object3D(); piv.position.set(SC.CLAW[0] * sg, SC.CLAW[1], SC.CLAW[2]);
    piv.add(part);
    pivot.add(piv);
    clawPivots.push(piv);
    return part;
  };
  const clawL = mkClaw(-1), clawR = mkClaw(1);
  ud.clawPivots = clawPivots;   // [left, right]: yaw them to aim (the AI clamps the swing)
  // tail: animated root → part at the mortar pod
  const tailRoot = new THREE.Object3D(); tailRoot.position.set(SC.TAIL[0], SC.TAIL[1], SC.TAIL[2]);
  const tailM = bodyMat(0.66, 0.22);
  const tailIntact = GG('ext:s2:scorpion.tail', buildScorpionTail);
  const tailWreck = wreckGeo('ext:s2:scorpion.tail', buildScorpionTail,
    { keep: (x, y, z) => Math.hypot(x, y, z) - 0.62, crumple: 0.1, seed: 23, dir: [0, 1, 0], shards: 10, shardSize: 0.24, band: 0.5 });
  const tailMesh = new THREE.Mesh(tailIntact, tailM);
  const mu = 0.72 / Math.hypot(SC_POD_DIR[1], SC_POD_DIR[2]);   // just past the bore
  const tail = makePart('tail', 0.72, [{ mesh: tailMesh, intact: tailIntact, wreck: tailWreck, sag: [0.25, -0.2, 0.08] }],
    [new THREE.Vector3(0, SC_POD_DIR[1] * mu, SC_POD_DIR[2] * mu)]);
  tail.position.set(SC.POD[0], SC.POD[1], SC.POD[2]);
  tailRoot.add(tail);
  pivot.add(tailRoot);
  ud.parts = { clawL, clawR, tail, core };
  ud.tailRoot = tailRoot;
  const mats = [hullMat, ...clawL.userData.materials, ...clawR.userData.materials, tailM];
  ud.setFlash = flashFn(mats);
  ud.muzzles = [new THREE.Vector3(-1.68, 1.46, -4.97), new THREE.Vector3(1.68, 1.46, -4.97), new THREE.Vector3(-1.2, 4.3, 0.5)];
  // walk(ph, amp): the two tripods lift and swing half a cycle apart
  let recoil = 0;
  ud.setWalk = (ph, amp) => {
    const s = Math.sin(ph), c = Math.cos(ph);
    legA.position.set(0, Math.max(0, s) * 0.24 * amp, c * 0.2 * amp);
    legB.position.set(0, Math.max(0, -s) * 0.24 * amp, -c * 0.2 * amp);
    legA.rotation.y = s * 0.05 * amp; legB.rotation.y = -s * 0.05 * amp;
    body.position.y = Math.abs(c) * 0.05 * amp;
  };
  ud.kick = () => { recoil = 1; };
  /** pooled instances come back posed: stand still, claws forward, tail at rest */
  ud.reset = () => { recoil = 0; ud.setWalk(0, 0); for (const p of clawPivots) p.rotation.set(0, 0, 0); tailRoot.rotation.set(0, 0, 0); };
  ud.update = (dt, t) => {
    recoil = Math.max(0, recoil - dt * 3);
    tailRoot.rotation.z = Math.sin(t * 1.1) * 0.08;
    tailRoot.rotation.x = -recoil * 0.22 + Math.sin(t * 0.9) * 0.04;
    const p = dead ? 0.22 + Math.sin(t * 17) * 0.06 : 0.8 + Math.sin(t * 4) * 0.2;
    for (let i = 0; i < mats.length; i++) mats[i].uEmitScale.value = p;
    if (open > 0.5 && !dead) hullMat.uEmitScale.value = 1.0 + Math.sin(t * 11) * 0.25;
  };
  ud.dispose = () => { for (const m of mats) m.dispose(); };
  ud.setWalk(0, 0);
  core.userData.setOpen(0);
  return g;
}

// =============================================================================
// BEHEMOTH — boss land battleship (17 draw calls, ≤ 8000 triangles)
//   pivot → bow (z < 0) and stern (z > 0) groups, hinged at z = 0 so setCollapse(k) can break
//   the hull's back as it dies. Bow: hull half, main turret (house + recoiling barrels), front
//   batteries, both missile silos (base + hinged lid). Stern: hull half with the bridge
//   superstructure, rear batteries, stack flames, the core (collar, orb, clamshell shutters).
// =============================================================================
const BH = {
  deck: lit('#9c8762'), deckLt: lit('#bca780'), deckDk: lit('#6d5d40'),
  hull: lit('#7c3e25'), hullLt: lit('#9d5433'), hullDk: lit('#4c2517'),
  plate: lit('#86734f'), seam: lit('#3e3426'),
};
const BH_H = 2.1;                    // deck height
function bhRing([z, hw, top]) {
  // edges: 0 belly 1 right chamfer 2 right side 3 right bevel 4 deck 5 left bevel 6 left side 7 left chamfer
  return [[-hw * 0.84, 0.3, z], [hw * 0.84, 0.3, z], [hw, 0.85, z], [hw, top - 0.3, z], [hw - 0.3, top, z], [-(hw - 0.3), top, z], [-hw, top - 0.3, z], [-hw, 0.85, z]];
}
function bhHullStyle(i, j) {
  if (j === 4) return BH.deck;
  if (j === 3 || j === 5) return BH.deckLt;
  if (j === 2 || j === 6) return i & 1 ? BH.hullLt : BH.hull;
  return BH.hullDk;
}
/** one half of the hull (which = -1 bow, +1 stern), its two track units included */
function buildBehemothHull(which) {
  const b = new GB();
  const bow = which < 0;
  const ST = bow ? [[-8.3, 1.7, 1.35], [-7.7, 2.5, 1.8], [-6.8, 3.05, BH_H], [-3.4, 3.15, BH_H], [0, 3.15, BH_H]]
    : [[0, 3.15, BH_H], [3.4, 3.15, BH_H], [5.8, 3.15, BH_H], [7.3, 3.0, 2.0], [8.05, 2.55, 1.6]];
  const h0 = b.n;
  // the seam at z = 0 is capped dark: it only shows when the hull breaks its back (setCollapse)
  b.loft(ST.map(bhRing), bhHullStyle, bow ? BH.hullDk : EN.gunXDk, bow ? EN.gunXDk : BH.hullDk);
  const h1 = b.n;
  const Y = BH_H + 0.006;
  const quad = (x0, z0, x1, z1, st, y = Y) => b.decal([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], st);
  // deck plating: a checker of worn plates, walkways along the edges with pipe runs, rust weathering
  const za = bow ? -6.6 : 0.0, zb = bow ? 0.0 : 6.0;
  for (let r = 0; za + r * 1.1 < zb - 0.05; r++) {
    const z0 = za + r * 1.1, z1 = Math.min(zb, z0 + 1.1);
    for (let c = 0; c < 4; c++) {
      const x0 = -2.5 + c * 1.25;
      if ((r + c) & 1) quad(x0 + 0.03, z0 + 0.03, x0 + 1.22, z1 - 0.03, BH.plate);
    }
  }
  for (const sg of [-1, 1]) {
    quad(2.52 * sg, za, 2.8 * sg, zb, BH.deckLt, Y + 0.001);
    b.lathe([2.66 * sg, BH_H + 0.1, za + 0.2], [0, 0, 1], [[0, 0.07], [zb - za - 0.4, 0.07]], 4, (i, j) => (j & 1 ? EN.gunLt : EN.gun), EN.gunDk, EN.gunDk, { phase: Math.PI / 4 });
  }
  b.drape(bow ? [[[-2.3, -5.7], [-1.2, -6.1], [-0.8, -5.3], [-2.0, -5.0]], [[1.0, -3.2], [2.3, -3.5], [2.4, -2.7], [1.3, -2.6]]]
    : [[[-2.4, 0.9], [-1.9, 0.6], [-1.8, 1.7], [-2.4, 1.9]], [[1.2, 4.0], [2.3, 3.6], [2.3, 4.6], [1.5, 4.7]]], BH.hull, h0, h1, 0.009, 1);
  // tracks: exposed treads (their bands read as the links from above), mudguards over the ends
  const tz = bow ? [-7.45, -1.25] : [1.25, 7.45];
  for (const sg of [-1, 1]) {
    trackLoft(b, 3.94 * sg, 1.62, 1.5, tz[0], tz[1], 13, TRACK_S2);
    const ze = bow ? tz[0] + 0.45 : tz[1] - 0.45;
    b.block({ x: 3.94 * sg, y: 1.42, z: ze, w: 1.8, d: 0.9, h: 0.2, tw: 1.7, td: 0.7, oz: bow ? 0.08 : -0.08, bev: 0.04, top: BH.hull, bevS: BH.deckLt, side: BH.hullDk });
    hazardStrip(b, 3.94 * sg - 0.72, ze, 3.94 * sg + 0.72, ze, 1.625, 0.4, 6, [0, 1, 0], EN.yellow, EN.black);
    // inner track guard rail
    b.block({ x: 3.08 * sg, y: 1.3, z: (tz[0] + tz[1]) / 2, w: 0.14, d: tz[1] - tz[0] - 0.4, h: 0.32, top: BH.deckLt, side: BH.hullDk });
    // armoured stowage box in the gap between the track units
    b.block({ x: 3.86 * sg, y: 0.7, z: bow ? -0.62 : 0.62, w: 1.3, d: 1.1, h: 0.9, tw: 1.18, td: 0.98, bev: 0.05, top: BH.hullLt, bevS: BH.deckLt, side: BH.hull });
    // battery sponson
    b.lathe([2.62 * sg, BH_H - 0.02, bow ? -2.3 : 4.55], [0, 1, 0], [[0, 0.72], [0.14, 0.7], [0.18, 0.62]], 10,
      (i) => (i === 0 ? BH.hullDk : EN.gun), null, EN.gunDk, { phase: Math.PI / 10 });
  }
  if (bow) {
    // dozer blade + ram teeth
    b.block({ x: 0, y: 0.05, z: -8.72, w: 6.4, d: 0.5, h: 1.05, tw: 6.2, td: 0.3, oz: -0.06, top: EN.gunLt, side: EN.gunDk, front: EN.gun });
    hazardStrip(b, -3.0, -8.75, 3.0, -8.75, 1.105, 0.28, 12, [0, 1, 0], EN.yellow, EN.black);
    for (let k = 0; k < 5; k++) {
      const x = -2.4 + k * 1.2;
      b.spike([[x - 0.22, 0.1, -8.95], [x + 0.22, 0.1, -8.95], [x, 0.55, -8.95]], [x, 0.22, -9.5], (q) => (q === 2 ? EN.edgeLt : EN.gun), null);
    }
    // prow chevrons, searchlights (tilted up so their lenses face the sky), ammunition crates
    hazardDrape(b, -1.9, -7.22, 1.9, -7.22, 0.5, 9, EN.yellow, EN.black, h0, h1, 0.01, 1);
    for (const sg of [-1, 1]) {
      b.lathe([1.7 * sg, BH_H, -6.4], [0, 0.9, -1], [[0, 0.3], [0.32, 0.28], [0.4, 0.22]], 8, (i) => (i === 1 ? EN.gunLt : EN.gunDk), null, GL(rgb(1, 0.85, 0.55, 2.6), 0.5), { phase: Math.PI / 8 });
      b.block({ x: 2.05 * sg, y: BH_H, z: -5.35, w: 0.7, d: 0.5, h: 0.32, bev: 0.03, top: DS.khakiLt, bevS: DS.sandLt, side: DS.khaki });
      b.block({ x: 1.95 * sg, y: BH_H + 0.32, z: -5.4, w: 0.5, d: 0.4, h: 0.24, bev: 0.03, top: DS.khaki, bevS: DS.sandLt, side: DS.khakiDk });
    }
    // main-turret barbette
    b.lathe([0, BH_H - 0.02, -4.3], [0, 1, 0], [[0, 1.94], [0.16, 1.92], [0.3, 1.76], [0.34, 1.72]], 14,
      (i, j) => (i === 1 ? (j & 1 ? BH.deckLt : EN.edge) : i === 2 ? EN.gunDk : BH.hullDk), null, EN.gunXDk);
    // silo wells + the armoured ventilation spine between them
    for (const sg of [-1, 1]) quad(1.55 * sg - 0.7, -2.36, 1.55 * sg + 0.7, -0.64, EN.gunXDk, Y + 0.002);
    b.block({ x: 0, y: BH_H, z: -1.4, w: 1.1, d: 2.3, h: 0.36, tw: 0.92, td: 2.1, bev: 0.05, top: BH.hull, bevS: BH.deckLt, side: BH.hullDk });
    for (let k = 0; k < 5; k++) quad(-0.34, -2.2 + k * 0.36, 0.34, -2.2 + k * 0.36 + 0.14, k === 2 ? DS.warm : EN.gunXDk, BH_H + 0.365);
  } else {
    // command bridge: two stepped tiers with bridge wings; window bands on the sides and the back
    b.block({ x: 0, y: BH_H, z: 2.1, w: 3.8, d: 3.4, h: 0.95, tw: 3.5, td: 3.1, bev: 0.08, top: BH.deck, bevS: BH.deckLt, side: BH.plate, back: BH.deckDk });
    b.block({ x: 0, y: BH_H + 0.95, z: 2.05, w: 2.8, d: 2.6, h: 0.56, tw: 2.5, td: 2.3, bev: 0.06, top: BH.plate, bevS: BH.deckLt, side: BH.hullLt, back: BH.hull });
    b.block({ x: 0, y: BH_H + 0.6, z: 0.9, w: 5.0, d: 0.8, h: 0.24, tw: 4.8, td: 0.66, bev: 0.04, top: BH.hullLt, bevS: BH.deckLt, side: BH.hullDk });
    hazardStrip(b, -2.4, 0.9, -1.8, 0.9, BH_H + 0.845, 0.5, 3, [0, 1, 0], EN.yellow, EN.black);
    hazardStrip(b, 1.8, 0.9, 2.4, 0.9, BH_H + 0.845, 0.5, 3, [0, 1, 0], EN.yellow, EN.black);
    const WIN = GL(scl(EM.amber, 0.45), 0.35);
    for (const sg of [-1, 1]) {
      b.block({ x: 1.8 * sg, y: BH_H + 0.36, z: 2.3, w: 0.06, d: 2.2, h: 0.12, top: WIN, side: WIN });
      b.block({ x: 1.33 * sg, y: BH_H + 1.2, z: 2.05, w: 0.06, d: 2.0, h: 0.1, top: WIN, side: WIN });
    }
    b.block({ x: 0, y: BH_H + 0.36, z: 3.74, w: 3.1, d: 0.06, h: 0.12, top: WIN, side: WIN });
    b.block({ x: 0, y: BH_H + 1.2, z: 3.26, w: 2.2, d: 0.06, h: 0.1, top: WIN, side: WIN });
    // mast with a radar bar and a red beacon, whip antennas
    b.lathe([-1.0, BH_H + 1.5, 3.0], [0, 1, 0], [[0, 0.07], [0.9, 0.05]], 5, EN.gunDk, null, GL(EM.red, 0.5));
    b.block({ x: -1.0, y: BH_H + 2.1, z: 3.0, w: 0.9, d: 0.1, h: 0.08, top: EN.edgeLt, side: EN.gun });
    for (const [x, z] of [[1.05, 3.05], [1.2, 1.0]]) b.lathe([x, BH_H + 1.5, z], [0, 1, 0], [[0, 0.03], [0.8, 0.015]], 3, EN.gunDk, null, GL(EM.red, 0.4));
    // exhaust stacks: sooty mouths with an ember glow
    for (const sg of [-1, 1]) {
      b.lathe([1.35 * sg, BH_H - 0.02, 5.45], [0, 1, 0], [[0, 0.52], [0.2, 0.5], [0.9, 0.44], [0.98, 0.5], [1.28, 0.5], [1.3, 0.34]], 8,
        (i, j) => (i === 3 ? (j & 1 ? EN.yellow : EN.black) : i === 4 ? EN.gunLt : i === 0 ? BH.hullDk : (j & 1 ? BH.hull : BH.hullLt)), null, S(lin('#141210'), scl(EM.emberDim, 0.9)), { phase: Math.PI / 8 });
    }
    // engine-deck grilles with a warm glow between the slats
    for (const sg of [-1, 1]) for (let k = 0; k < 5; k++) {
      const z = 6.2 + k * 0.26;
      quad(0.3 * sg, z, 2.3 * sg, z + 0.12, k === 2 ? DS.warm : EN.gunXDk, BH_H + 0.008);
    }
    // stern hazard band + tail lights
    hazardDrape(b, -2.5, 7.55, 2.5, 7.55, 0.34, 11, EN.yellow, EN.black, h0, h1, 0.008, 1);
    for (const sg of [-1, 1]) b.block({ x: 2.2 * sg, y: 1.35, z: 7.72, w: 0.4, d: 0.12, h: 0.18, top: GL(EM.red), side: GL(EM.red, 0.5) });
  }
  return b;
}
function buildBhTurret() {   // main turret house (part-local, origin on the barbette, barrels along −z)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 1.66], [0.18, 1.62]], 12, EN.gunDk, null, null);
  const r0 = b.n;
  b.block({ x: 0, y: 0.12, z: 0.25, w: 3.0, d: 3.4, h: 0.96, tw: 2.44, td: 2.5, oz: 0.2, bev: 0.14, top: BH.deck, bevS: BH.deckLt, side: BH.hull, front: BH.hullDk, back: BH.hullDk });
  const r1 = b.n;
  // sloped cheek armour, hazard chevrons across the roof front, commander cupola, sensor eye, vents
  for (const sg of [-1, 1]) b.block({ x: 1.42 * sg, y: 0.12, z: -0.62, w: 0.4, d: 1.4, h: 0.66, tw: 0.18, td: 1.08, ox: -0.09 * sg, top: BH.deckLt, side: BH.hullDk });
  hazardDrape(b, -1.0, -0.62, 1.0, -0.62, 0.34, 8, EN.yellow, EN.black, r0, r1, 0.006, 1);
  b.lathe([0.68, 1.08, 0.78], [0, 1, 0], [[0, 0.32], [0.16, 0.28], [0.22, 0.0]], 8, (i) => (i === 0 ? BH.hull : BH.deckLt), null, null);
  b.drape([[[-0.4, -0.24], [0.4, -0.24], [0.33, 0.0], [-0.33, 0.0]]], GL(EM.eyeRed), r0, r1, 0.006, 1);
  for (let k = 0; k < 3; k++) b.drape([[[-1.0, 1.0 + k * 0.16], [0.2, 1.0 + k * 0.16], [0.2, 1.08 + k * 0.16], [-1.0, 1.08 + k * 0.16]]], EN.gunXDk, r0, r1, 0.006, 1);
  return b;
}
const BH_BARREL_X = 0.5;
function buildBhBarrels() {  // twin barrels + mantlet (turret-local, origin at the trunnions)
  const b = new GB();
  b.block({ x: 0, y: -0.3, z: -0.95, w: 1.62, d: 0.5, h: 0.6, tw: 1.4, td: 0.4, oz: -0.04, bev: 0.05, top: EN.gun, bevS: EN.edge, side: EN.gunDk, front: EN.gunXDk });
  for (const sg of [-1, 1]) {
    b.lathe([BH_BARREL_X * sg, 0, -1.1], [0, 0, -1], [[0, 0.23], [0.3, 0.21], [0.36, 0.23], [0.48, 0.23], [3.1, 0.17], [3.2, 0.24], [3.56, 0.24], [3.58, 0.14]], 8,
      (i, j) => (i === 2 ? (j & 1 ? EN.black : EN.yellow) : i === 5 ? EN.edge : (j === 1 || j === 2 || j === 3) ? EN.gunLt : EN.gunDk), null, DS.hot, { phase: Math.PI / 8 });
  }
  return b;
}
function buildBhBattery() {  // secondary twin gun (part-local, barrels along −z)
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.56], [0.1, 0.54], [0.16, 0.44]], 8, (i) => (i === 0 ? EN.gunDk : BH.deckLt), null, EN.gun, { phase: Math.PI / 8 });
  b.block({ x: 0, y: 0.12, z: 0.06, w: 0.84, d: 0.9, h: 0.36, tw: 0.64, td: 0.7, oz: 0.05, bev: 0.06, top: BH.deck, bevS: BH.deckLt, side: BH.hull, front: BH.hullDk });
  for (const x of [-0.15, 0.15]) {
    b.lathe([x, 0.3, -0.36], [0, 0, -1], [[0, 0.075], [0.66, 0.062], [0.66, 0.08], [0.78, 0.08], [0.78, 0.04]], 6, (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black, { phase: Math.PI / 6 });
  }
  b.decal([[-0.18, 0.485, -0.2], [0.18, 0.485, -0.2], [0.14, 0.485, -0.08], [-0.14, 0.485, -0.08]], GL(EM.eyeRed));
  hazardStrip(b, -0.24, 0.3, 0.24, 0.3, 0.485, 0.1, 4, [0, 1, 0], EN.yellow, EN.black);
  return b;
}
function buildBhSilo() {     // missile silo housing (part-local, base on the deck): two tubes with glowing warheads
  const b = new GB();
  b.block({ x: 0, y: 0, z: 0, w: 1.3, d: 1.64, h: 0.4, tw: 1.2, td: 1.54, bev: 0.05, top: BH.plate, bevS: BH.deckLt, side: BH.hullDk });
  for (const z of [-0.36, 0.36]) {
    const oct = Array.from({ length: 8 }, (_, k) => { const a = Math.PI / 8 + (k * TAU) / 8; return [Math.cos(a) * 0.3, 0.405, z + Math.sin(a) * 0.3]; });
    b.decal(oct, EN.gunXDk);
    b.decal(oct.map(([x, y, zz]) => [x * 0.45, 0.41, z + (zz - z) * 0.45]), DS.hot);
  }
  hazardStrip(b, -0.6, 0.76, 0.6, 0.76, 0.406, 0.12, 6, [0, 1, 0], EN.yellow, EN.black);
  return b;
}
function buildBhSiloLid() {  // one hinged lid (origin at the rear hinge, lid over −z)
  const b = new GB();
  b.block({ x: 0, y: 0, z: -0.72, w: 1.12, d: 1.4, h: 0.1, bev: 0.03, top: BH.deck, bevS: BH.deckLt, side: BH.hullDk });
  hazardStrip(b, -0.48, -0.72, 0.48, -0.72, 0.105, 0.5, 6, [0, 1, 0], EN.yellow, EN.black);
  return b;
}
function buildBhCoreFrame() {  // armoured collar around the reactor well (part-local)
  const b = new GB();
  const N = 12;
  const ring = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  b.loft([ring(1.28, 0.0), ring(1.24, 0.34), ring(1.06, 0.5), ring(0.86, 0.48), ring(0.8, 0.1)], (i, j) => {
    if (i === 0) return (j & 1) ? BH.hull : BH.hullDk;
    if (i === 1) return (j % 3 === 1) ? DS.warm : BH.deckLt;
    if (i === 2) return BH.plate;
    return EN.gunXDk;
  });
  b.lathe([0, 0.1, 0], [0, 1, 0], [[0, 0.82], [0, 0.0]], N, EN.black);
  for (let k = 0; k < 4; k++) {
    const f = b.n, a = Math.PI / 4 + (k * TAU) / 4;
    b.block({ x: 1.32, y: 0.0, z: 0, w: 0.42, d: 0.5, h: 0.5, tw: 0.24, td: 0.36, ox: -0.07, bev: 0.04, top: BH.deckLt, bevS: EN.edgeLt, side: BH.hull });
    b.xform(f, M(0, 0, 0, 0, -a, 0));
  }
  return b;
}
function buildBhOrb(dead) {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(dead ? 0.5 : 0.58, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const t = i / 9, k = hash3(t, dead ? 4.7 : 1.9, 3.3);
    const st = dead ? (k > 0.8 ? GL(EM.emberDim, 0.3) : S(lin(k > 0.4 ? '#1f1a17' : '#2e2622')))
      : GL(scl(MOLTEN, k > 0.7 ? 1 : k > 0.35 ? 0.7 : 0.45), 0.55);
    const d = (v) => (dead ? [p[v] * (0.9 + k * 0.15), p[v + 1] * 0.75 + 0.3, p[v + 2] * (0.9 + k * 0.15)] : [p[v], p[v + 1] + 0.32, p[v + 2]]);
    b.triO(d(i), d(i + 3), d(i + 6), [0, 0.32, 0], st);
  }
  geo.dispose();
  return b;
}
const BH_SHELL = { a: BH.deck, b: BH.plate, trim: EN.yellow, edge: BH.deckLt, rim: BH.hullDk, inner: EN.gunXDk, lip: GL(rgb(1.0, 0.5, 0.12, 2.2), 0.3), end: BH.hull };
function buildBhShutter() { return shellGB(BH_SHELL); }
const BH_STACKS = [[-1.35, 0, 0], [1.35, 0, 0]];
const BH_STACK_FLAME = [
  { r: 0.3, len: 1.1, base: rgb(1.0, 0.45, 0.1, 1.3), tip: rgb(0.5, 0.08, 0.0, 0.0), sides: 7 },
  { r: 0.16, len: 0.6, base: rgb(1.0, 0.8, 0.5, 2.0), tip: rgb(1.0, 0.35, 0.05, 0.1), sides: 6 },
];
const BH_TURRET_POS = [0, BH_H + 0.3, -4.3];
const BH_BATTERY_POS = [[-2.62, BH_H + 0.16, -2.3], [2.62, BH_H + 0.16, -2.3], [-2.62, BH_H + 0.16, 4.55], [2.62, BH_H + 0.16, 4.55]];
const BH_SILO_POS = [[-1.55, BH_H, -1.5], [1.55, BH_H, -1.5]];
const BH_CORE_POS = [0, BH_H + 1.5, 2.05];
function createBehemoth() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss:behemoth';
  ud.radius = 5.0;
  ud.ground = true;
  ud.debrisColor = new THREE.Color('#7c3e25');
  ud.halfExtents = { x: 4.8, z: 9.2 };
  const bowG = new THREE.Group(); bowG.name = 'bow';
  const sternG = new THREE.Group(); sternG.name = 'stern';
  pivot.add(bowG, sternG);
  const hullMat = bodyMat(0.66, 0.28);
  bowG.add(new THREE.Mesh(GG('ext:s2:behemoth.bow', () => buildBehemothHull(-1)), hullMat));
  sternG.add(new THREE.Mesh(GG('ext:s2:behemoth.stern', () => buildBehemothHull(1)), hullMat));
  const allMats = [hullMat];
  const partMat = () => { const m = bodyMat(0.62, 0.28); allMats.push(m); return m; };

  // ---- main turret: house (part mesh) + recoiling barrels
  const tMat = partMat();
  const houseI = GG('ext:s2:behemoth.turret', buildBhTurret);
  const houseW = wreckGeo('ext:s2:behemoth.turret', buildBhTurret, { keep: (x, y) => 0.5 - y, crumple: 0.16, seed: 31, dir: [0, 1, 0], shards: 16, shardSize: 0.4, band: 0.5 });
  const barrelsI = GG('ext:s2:behemoth.barrels', buildBhBarrels);
  const barrelsW = wreckGeo('ext:s2:behemoth.barrels', buildBhBarrels, { keep: (x, y, z) => z + 1.9, crumple: 0.14, seed: 33, dir: [0, 0, -1], shards: 8, shardSize: 0.3, band: 0.5 });
  const house = new THREE.Mesh(houseI, tMat), barrels = new THREE.Mesh(barrelsI, tMat);
  const barrelPivot = new THREE.Object3D(); barrelPivot.position.set(0, 0.62, -0.2);
  barrelPivot.add(barrels);
  const turret = makePart('turret', 1.7, [{ mesh: house, intact: houseI, wreck: houseW }, { mesh: barrels, intact: barrelsI, wreck: barrelsW, sag: [0.12, -0.25, 0] }],
    [new THREE.Vector3(-BH_BARREL_X, 0.62, -4.95), new THREE.Vector3(BH_BARREL_X, 0.62, -4.95)]);
  turret.add(barrelPivot);
  turret.position.set(...BH_TURRET_POS);
  bowG.add(turret);
  // ---- secondary batteries (front pair on the bow, rear pair on the stern)
  const batKeep = { keep: (x, y) => 0.24 - y, crumple: 0.1, seed: 35, dir: [0, 1, 0], shards: 8, shardSize: 0.22, band: 0.3 };
  const batteries = BH_BATTERY_POS.map((p, k) => {
    const intact = GG('ext:s2:behemoth.battery', buildBhBattery);
    const wreck = wreckGeo('ext:s2:behemoth.battery', buildBhBattery, batKeep);
    const part = makePart('battery' + k, 0.72, [{ mesh: new THREE.Mesh(intact, partMat()), intact, wreck, sag: [0.1, -0.06, 0.08 * (k & 1 ? 1 : -1)] }],
      [new THREE.Vector3(-0.15, 0.3, -1.18), new THREE.Vector3(0.15, 0.3, -1.18)]);
    part.position.set(p[0], p[1], p[2]);
    (p[2] < 0 ? bowG : sternG).add(part);
    return part;
  });
  // ---- missile silos: housing + hinged lid (opened by setSilo)
  const siloLids = [];
  const silos = BH_SILO_POS.map((p, k) => {
    const m = partMat();
    const intact = GG('ext:s2:behemoth.silo', buildBhSilo);
    const wreck = wreckGeo('ext:s2:behemoth.silo', buildBhSilo, { keep: () => 1, crumple: 0.1, seed: 37, dir: [0, 1, 0], shards: 8, shardSize: 0.26, band: 0.2 });
    const lid = new THREE.Mesh(GG('ext:s2:behemoth.siloLid', buildBhSiloLid), m);
    const hinge = new THREE.Object3D(); hinge.position.set(0, 0.4, 0.78); hinge.add(lid);
    const part = makePart('silo' + k, 0.85, [{ mesh: new THREE.Mesh(intact, m), intact, wreck }, { mesh: lid, hideOnDestroy: true }],
      [new THREE.Vector3(0, 0.5, -0.36), new THREE.Vector3(0, 0.5, 0.36)]);
    part.add(hinge);
    part.position.set(p[0], p[1], p[2]);
    bowG.add(part);
    siloLids.push({ hinge, cur: 0, want: 0 });
    return part;
  });
  // ---- core: collar + reactor orb + clamshell shutters on the bridge roof
  const coreMat = partMat();
  const frameI = GG('ext:s2:behemoth.coreFrame', buildBhCoreFrame);
  const frameW = G('ext:s2:behemoth.coreFrame.wreck', () => wreckOf(gbOf('ext:s2:behemoth.coreFrame', buildBhCoreFrame),
    { keep: () => 1, crumple: 0.14, seed: 39, shards: 14, shardSize: 0.3, band: 2, dir: [0, 1, 0] }).build());
  const orbMat = bodyMat(0.5, 0.1); allMats.push(orbMat);
  const orbI = GG('ext:s2:behemoth.orb', () => buildBhOrb(false)), orbD = GG('ext:s2:behemoth.orbDead', () => buildBhOrb(true));
  const frame = new THREE.Mesh(frameI, coreMat), orb = new THREE.Mesh(orbI, orbMat);
  const shutterGeo = GG('ext:s2:behemoth.shutter', buildBhShutter);
  const hingeR = new THREE.Object3D(); hingeR.position.set(0.94, 0.16, 0);
  const hingeL = new THREE.Object3D(); hingeL.position.set(-0.94, 0.16, 0);
  const shR = new THREE.Mesh(shutterGeo, coreMat); shR.position.set(-0.94, -0.16, 0);
  const shL = new THREE.Mesh(shutterGeo, coreMat); shL.position.set(0.94, -0.16, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  const core = makePart('core', 1.15, [{ mesh: frame, intact: frameI, wreck: frameW }, { mesh: orb, intact: orbI, wreck: orbD },
    { mesh: shR, hideOnDestroy: true }, { mesh: shL, hideOnDestroy: true }], [new THREE.Vector3(0, 0.9, 0)]);
  core.add(hingeR, hingeL);
  core.userData.materials.push(orbMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(...BH_CORE_POS);
  sternG.add(core);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (t) => {
    openT = Math.max(0, Math.min(1, t)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;   // ease in-out
    hingeR.rotation.z = -e * 112 * DEG; hingeL.rotation.z = e * 112 * DEG;
  };
  // ---- stack flames (additive, pointing up)
  const flameMat = additiveMat();
  const flames = new THREE.Mesh(G('ext:s2:behemoth.flames', () => buildFlame(BH_STACKS, BH_STACK_FLAME)), flameMat);
  flames.rotation.x = -Math.PI / 2; flames.position.set(0, BH_H + 1.28, 5.45);
  flames.userData.noShadow = true; flames.renderOrder = 2;
  sternG.add(flames);

  ud.parts = { turret, battery: batteries, silo: silos, core };
  ud.turret = turret;
  ud.muzzles = [new THREE.Vector3(0, BH_H + 1.0, -8.9)];
  ud.setFlash = flashFn(allMats);
  let recoil = 0, heat = 0, collapse = 0;
  /** main-gun recoil kick (the barrels slide back and return) */
  ud.kick = () => { recoil = 1; };
  /** silo lid k (0/1) opens toward want (0 closed … 1 open) */
  ud.setSilo = (k, want) => { if (siloLids[k]) siloLids[k].want = want; };
  /** 0 … 1: stack flames / engine glow (damage and rage) */
  ud.setHeat = (v) => { heat = Math.max(0, Math.min(1, v)); };
  /** 0 … 1: the hull breaks its back and sinks into the lakebed (death) */
  ud.setCollapse = (k) => {
    collapse = Math.max(0, Math.min(1, k));
    const e = collapse * collapse * (3 - 2 * collapse);
    bowG.rotation.set(-0.2 * e, 0, 0.05 * e);
    sternG.rotation.set(0.16 * e, 0, -0.04 * e);
    bowG.position.set(0, -0.3 * e, -0.3 * e);
    sternG.position.set(0, -0.3 * e, 0.3 * e);
    pivot.position.y = -2.4 * e;
  };
  /** pooled instances come back posed: hull whole, lids shut, guns run out, stacks idle */
  ud.reset = () => {
    ud.setCollapse(0); heat = 0; recoil = 0; barrels.position.z = 0;
    for (const L of siloLids) { L.cur = L.want = 0; L.hinge.rotation.x = 0; }
    core.userData.setOpen(0);
  };
  core.userData.setOpen(0);
  ud.update = (dt, t) => {
    const pulse = 0.8 + Math.sin(t * 3.2) * 0.2;
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = pulse;
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.8 : (0.35 + openT * 0.75) * (1 + Math.sin(t * 9) * 0.12);
    orb.rotation.y += dt * (0.4 + openT * 2.2);
    recoil = Math.max(0, recoil - dt * 2.4);
    barrels.position.z = recoil * recoil * 0.9;
    for (const L of siloLids) { L.cur += Math.max(-dt * 3, Math.min(dt * 3, L.want - L.cur)); L.hinge.rotation.x = L.cur * 1.9; }
    const fl = 1 + Math.sin(t * 31) * 0.1 + Math.sin(t * 17) * 0.06;
    flames.scale.set(0.7 + heat * 0.6, 0.7 + heat * 0.6, (0.45 + heat * 1.3) * fl);
    flameMat.color.setScalar(0.6 + heat * 0.5 + Math.sin(t * 23) * 0.08);
    if (collapse === 0) pivot.position.y = Math.sin(t * 11) * 0.015;   // engine rumble
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); flameMat.dispose(); };
  ud.update(0, 0);
  return g;
}

export const ENEMIES = {
  gunship: createGunship,
  s2_striker: createStriker,
  mlrs: createMlrs,
  sandskiff: createSkiff,
  scorpion: createScorpion,
};
export const BOSSES = { behemoth: createBehemoth };
