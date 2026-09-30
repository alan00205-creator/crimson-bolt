// weapons.js — the player's weapons: main weapons (P items), sub-weapons (S items), option drones
// and every kind of player shot. game.js owns the shot arrays (g.ps, structure of arrays) and the
// collision loop, and calls in here:
//   fireWeapons(g, dt)   every update step: main weapon, sub-weapon, option drones
//   updateShots(g, dt)   move, age and cull shots
//   shotHit(g, i, t)     shot i touched target t (from game.collide) → 'remove' | 'keep'
//   drawWeapons(g, fx)   every rendered frame: shots, then beams / beam roots / muzzle glows
//
// Tables — a new weapon is one entry in each (plus its item colour / letter in defs.js):
//   MAIN[key]  = { fire(g, p, dt), draw?(g, p, fx, t), equip?(g, p) }   key: MAIN_WEAPONS key (p.main)
//   SUB[key]   = { fire(g, p), equip?(g, p) }            key: SUB_WEAPONS key (p.sub); fire is called
//                                                         when p.subT runs out and must set p.subT again
//   equip runs when an item switches to that weapon (after p.main / p.sub changed; game.collect
//   already zeroes p.fireT, p.laserT and p.subT) — reset any timer or lock state of your own there.
//   SHOT[kind] = { life, update?(g, i, dt) → 'remove'?, hit(g, i, t) → 'remove' | 'keep',
//                  armor?(g, i, t) → 'remove' | 'keep', test?(g, i, t) → bool, draw(g, i, fx) }
//                kind: SK value. test is an optional narrow phase: game.collide calls it after the
//                circle test (radius ps.r) and the pierce check; false = not touched after all.
//   OPT_FIRE[key] = (g, p, dt, drones)   what the option drones fire for main weapon `key`
// Continuous weapons keep a cadence timer on the player and fire with the age-compensated loop
//   timer -= dt; if (timer < -0.2) timer = 0; while (timer <= 0) { age = -timer; timer += interval; … }
// spawning each shot where it would be after `age` seconds, because main.js may split a frame into
// two update steps; the cadence then stays exact at any frame rate.
// PLASMA is not made of shots: its beams live in BEAMS / DBEAMS below and burn their targets
// directly every step.
//
// Shot fields (g.ps, index i): x z vx vz, dmg (already × aircraft dmg), r (hit radius), t (age),
// kind, w (beam width; WAVE: current half-width), target (homing lock), trail (smoke timer; WAVE:
// full half-width), and three generic ones for new weapons: pierce (Uint8: >0 = passes through,
// skips targets already in its hit list), hits (4 target uids per shot: hits[i * 4 .. i * 4 + 3],
// see markHit / wasHit; a target's uid is t.uid — its own for a boss part, else the enemy's
// e.uid) and aux (one free float; WAVE: hit-memory slot, OPT_LASER: drone index).
// addShot() initialises every field and game.removeShot() copies every field.
//
// Balance (bolt, measured with the b6 harness: one r 1.3 target 12 units ahead / six spread r 0.75
// targets 8-13 ahead, jet standing still) — DPS single / spread-total (targets hit):
//   VULCAN  L1 27 / 27 (2)   L4 40 / 80 (4)    L8 93 / 133 (4)    coverage, point-blank power
//   LASER   L1 31 / 0        L4 53 / 53 (1)    L8 83 / 83 (1)     single-target burst
//   PLASMA  L1 26 / 26 (1)   L4 44 / 44 (2)    L8 68 / 68 (3)     auto-aim anywhere ahead, ~15 % less
//   WAVE    L1 18 / 36 (2)   L4 32 / 128 (4)   L8 52 / 310 (6)    pierce + width, weakest per target
//   HOMING  L1 9 · L4 29     NUKE L1 12 · L4 33     MULTI L1 12 / 12 · L4 17 / 45 (5): fan coverage
import { F, flatRot } from './fx.js';
import { MAIN_WEAPONS, SUB_WEAPONS } from './defs.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Player shot kinds (index into SHOT; ps.kind is a Uint8Array)
export const SK = { VULCAN: 0, LASER: 1, HOMING: 2, NUKE: 3, OPTION: 4, WAVE: 5, ROCKET: 6, OPT_LASER: 7 };

// Vulcan (red): per level, a list of [xOffset, angleDeg]. Angle 0 = straight up.
// Forward (near-0°) streams grow 2,2,3,3,4,4,5,5 so every level adds focused damage; outer
// streams add coverage.
export const VULCAN = [
  null,
  [[-0.2, 0], [0.2, 0]],
  [[-0.2, 0], [0.2, 0], [-0.35, -8], [0.35, 8]],
  [[-0.3, 0], [0, 0], [0.3, 0], [-0.4, -9], [0.4, 9]],
  [[-0.3, 0], [0, 0], [0.3, 0], [-0.4, -7], [0.4, 7], [-0.5, -16], [0.5, 16]],
  [[-0.36, -1], [-0.12, 0], [0.12, 0], [0.36, 1], [-0.45, -7], [0.45, 7], [-0.55, -17], [0.55, 17]],
  [[-0.36, -1], [-0.12, 0], [0.12, 0], [0.36, 1], [-0.45, -6], [0.45, 6], [-0.5, -13], [0.5, 13], [-0.6, -24], [0.6, 24]],
  [[-0.4, -1.5], [-0.2, -0.5], [0, 0], [0.2, 0.5], [0.4, 1.5], [-0.45, -7], [0.45, 7], [-0.5, -15], [0.5, 15], [-0.6, -26], [0.6, 26]],
  [[-0.4, -1.5], [-0.2, -0.5], [0, 0], [0.2, 0.5], [0.4, 1.5], [-0.45, -6], [0.45, 6], [-0.5, -12], [0.5, 12], [-0.55, -20], [0.55, 20], [-0.6, -30], [0.6, 30]],
];

// PLASMA (pink): lock-on bending beams. Each beam locks a different target ahead (an enemy, or a
// boss / mid-boss part), bends to it along a quadratic curve that leaves the gun straight ahead
// and whips after the jet, and burns it with continuous damage once its tip has arrived. Spare
// beams double up on a locked target; with nothing in range a short straight beam hums ahead.
// Armoured targets (closed cores, units still entering) are only locked when nothing soft is
// left: no damage, deflect sparks. The damage total is split over the beams.
export const PLASMA = {
  beams: (lv) => (lv >= 7 ? 3 : lv >= 4 ? 2 : 1),
  dps: (lv) => 18 + 6 * lv,      // damage per second, all beams together (× aircraft dmg)
  width: (lv) => 0.8 + 0.06 * lv,
  range: 23,                     // lock range from the gun (the screen is ~30 units tall)
  keep: 1.25,                    // a lock holds out to range × keep
  ahead: 0.8,                    // a target may sit at most this far behind the gun line
  side: 1.4,                     // lateral distance weighs more: prefers what is in front
  armor: 900,                    // score penalty: armoured targets rank behind every soft one
  retarget: 0.3,                 // a free target scoring below this × the lock's steals the lock
  track: 30, bend: 11,           // tip / control-point follow rates (1/s): lower bend = more whip
  idle: 6,                       // no target: beam length
};
// the option drones' version: one short lock beam each
const DRONE_PLASMA = { range: 12.5, dps: (lv) => 4 + 0.5 * lv, width: (lv) => 0.34 + 0.02 * lv, idle: 2.4 };

// WAVE (gold): expanding crescents that pass through everything. A wave leaves the gun narrow and
// spreads to its full width within `grow` seconds; it hits each target once (the shot's hit list
// plus a longer per-wave memory, see waveSeen), sparks off armour without stopping and sails
// through boss hulls. Wide and piercing, but every target takes only one wave per interval: the
// lowest single-target damage of the four.
export const WAVE = {
  interval: 0.15, speed: 25, life: 1.3,
  hw: (lv) => 1.3 + 0.55 * lv,   // full half-width
  dmg: (lv) => 2.1 + 0.6 * lv,   // per target per wave
  hw0: 0.45, grow: 0.42,         // half-width at the gun; seconds to full width
  th: 0.36,                      // half-thickness of the hit band
  sag: 0.378,                    // the tips trail the apex by sag × half-width (the ARC frame's shape)
};
const DRONE_WAVE = { interval: 0.24, speed: 25, hw: (lv) => 0.7 + 0.05 * lv, dmg: (lv) => 1.1 + 0.12 * lv };

// MULTI (M): fans of straight rockets. Per sub level, a list of [xOffset, angleDeg]: 2 rockets at
// level 1 up to 6 at level 4, the fan widening; they launch slow and accelerate.
export const MULTI = [
  null,
  [[-0.45, -3], [0.45, 3]],
  [[-0.55, -7], [0, 0], [0.55, 7]],
  [[-0.45, -3], [0.45, 3], [-0.8, -12], [0.8, 12]],
  [[-0.45, -3], [0.45, 3], [-0.8, -11], [0.8, 11], [-1.05, -21], [1.05, 21]],
];
const ROCKET = { dmg: 3.0, v0: 11, v1: 34, acc: 85, interval: (lv) => 0.52 - 0.04 * lv };

// Option drones: each fires a reduced version of the main weapon (OPT_FIRE). Spread wide the
// streams angle outward for coverage; tucked in (slow) they angle inward and cross about 12 units
// ahead (the plasma beams take the jet's own target): all of it lands on one target.
const OPT = { interval: 0.12, speed: 38, dmg: 0.3, dmgPerLevel: 0.03, r: 0.34, twin: 0.11, wideDeg: 5, tuckDeg: -3 };
const OPT_LASER = { interval: 0.045, speed: 44, dmg: (lv) => 0.24 + 0.028 * lv, r: 0.26 };

// HDR colours of the new weapons
const PINK = [2.1, 0.3, 1.75], STEEL = [0.75, 1.0, 1.6], GOLD = [1.5, 0.95, 0.16], SKY = [0.75, 1.5, 3.0];

// --- shot helpers ----------------------------------------------------------------------------
/** new player shot; dmg is scaled by the aircraft's damage multiplier. Returns its index or -1 (full). */
export function addShot(g, x, z, vx, vz, dmg, kind, r, w = 1) {
  const ps = g.ps;
  if (ps.n >= ps.max) return -1;
  const i = ps.n++;
  ps.x[i] = x; ps.z[i] = z; ps.vx[i] = vx; ps.vz[i] = vz; ps.dmg[i] = dmg * g.ac.dmg; ps.kind[i] = kind; ps.r[i] = r; ps.t[i] = 0; ps.w[i] = w;
  ps.target[i] = null; ps.trail[i] = 0; ps.pierce[i] = 0; ps.aux[i] = 0;
  const h = i * 4; ps.hits[h] = 0; ps.hits[h + 1] = 0; ps.hits[h + 2] = 0; ps.hits[h + 3] = 0;
  return i;
}
/** remember that piercing shot i has hit target uid (keeps the last 4) */
export function markHit(ps, i, uid) {
  const h = i * 4;
  ps.hits[h + 3] = ps.hits[h + 2]; ps.hits[h + 2] = ps.hits[h + 1]; ps.hits[h + 1] = ps.hits[h]; ps.hits[h] = uid;
}
export function wasHit(ps, i, uid) {
  const h = i * 4;
  return ps.hits[h] === uid || ps.hits[h + 1] === uid || ps.hits[h + 2] === uid || ps.hits[h + 3] === uid;
}
/** damage a collision target (an enemy or one of its parts) */
export function damageTarget(g, t, dmg) {
  if (t.part) g.damagePart(t.e, t.part, dmg); else g.damageEnemy(t.e, dmg);
}
/** default armour contact: sparks, a clank, the shot is spent */
function armorHit(g, i) {
  const ps = g.ps;
  g.fx.armorSpark(ps.x[i], 0.1, ps.z[i]);
  g.audio.play('hitArmor', { vol: 0.5 });
  return 'remove';
}
/** the jet may shoot right now (also gates beam glows) */
export function canShoot(g) {
  const p = g.player;
  return p.alive && p.entering <= 0.3 && g.phase !== 'bossdead' && g.phase !== 'clear';
}

// --- main weapons --------------------------------------------------------------------------
function fireVulcan(g, p, dt) {
  p.fireT -= dt;
  if (p.fireT < -0.2) p.fireT = 0;
  let fired = false;
  const gunZ = p.z + g.muzzleZ; // bolt: p.z - 1.0
  while (p.fireT <= 0) {
    const age = -p.fireT;
    p.fireT += 0.075;
    const pat = VULCAN[p.level];
    const S = 36;
    for (const [ox, ad] of pat) {
      const a = ad * DEG, vx = Math.sin(a) * S, vz = -Math.cos(a) * S;
      addShot(g, p.x + ox + vx * age, gunZ + 0.1 + vz * age, vx, vz, 1.0, SK.VULCAN, 0.42);
    }
    fired = true;
  }
  if (fired) {
    g.fx.muzzle(p.x, gunZ, 2.0, 1.0, 0.3, 0.5 + p.level * 0.04);
    g.audio.play('shot');
  }
}
function fireLaser(g, p, dt) {
  p.laserT -= dt;
  if (p.laserT < -0.2) p.laserT = 0;
  const gunZ = p.z + g.muzzleZ;
  while (p.laserT <= 0) {
    const age = -p.laserT;
    p.laserT += 0.034;
    const lv = p.level;
    const i = addShot(g, p.x, gunZ - 44 * age, 0, -44, 0.8 + lv * 0.25, SK.LASER, 0.28 + lv * 0.075, 0.34 + lv * 0.11);
    if (i >= 0) g.ps.t[i] = age;
  }
  g.audio.play('laser'); // every frame while firing; audio.js throttles it into a sustained hum
}
// laser root glow at the gun
function drawLaserRoot(g, p, fx, t) {
  const w = 0.9 + p.level * 0.14 + Math.sin(t * 40) * 0.1;
  fx.bullets.push(p.x, 0.1, p.z + g.muzzleZ - 0.05, w, w, t * 3, F.FLARE, 0, 0.5, 1.8, 3.2, 1);
}

// --- PLASMA beams ----------------------------------------------------------------------------
// A beam: its lock (enemy e, part pt or null, target uid; shared = doubling up on another beam's
// lock), the curve (gun m → control c → tip e*) and fx / sound timers. All preallocated.
function newBeam() {
  return { e: null, pt: null, uid: 0, shared: false, armored: false, arrived: false, on: false, lockT: 0,
    mx: 0, mz: 0, cx: 0, cz: 0, ex: 0, ez: 0, tx: 0, tz: 0, tr: 1, fan: 0, fxT: 0, sndT: 0 };
}
const BEAMS = [newBeam(), newBeam(), newBeam()];             // the jet's
const DBEAMS = [newBeam(), newBeam(), newBeam(), newBeam()]; // one per option drone
let nBeams = 0;                // jet beams on in the last plasma step
let plasmaT = -1, droneT = -1; // g.time of the last plasma step (a gap: the beams restart at the gun)

function release(b) { b.e = null; b.pt = null; b.uid = 0; b.shared = false; b.armored = false; b.arrived = false; }
function resetBeams(list) { for (const b of list) { release(b); b.on = false; } }
// index of target uid in this step's g.targets (built on screen, alive, at the last collide), or -1
function targetIndex(g, uid) {
  const T = g.targets;
  for (let k = 0; k < g.nTargets; k++) if (T[k].uid === uid) return k;
  return -1;
}
// does the lock still hold? Refreshes its point, radius and armour from the target list.
function lockHolds(g, b, gx, gz, range) {
  const e = b.e;
  if (!e || !e.alive || e.dying || (b.pt && b.pt.dead)) return false;
  const k = targetIndex(g, b.uid);
  if (k < 0) return false; // off screen, or not in this field any more
  const t = g.targets[k];
  const dx = t.x - gx, dz = t.z - gz;
  if (dz > PLASMA.ahead + 1 || dx * dx + dz * dz > range * range) return false;
  b.tx = t.x; b.tz = t.z; b.tr = t.r; b.armored = t.armored;
  return true;
}
function lockOn(g, b, t, sound, shared, pitch) {
  if (b.uid !== t.uid) {
    b.lockT = 0; b.arrived = false;
    if (sound) g.audio.play('lock', { pitch: pitch - (t.armored ? 5 : 0), vol: 0.45 });
  }
  b.e = t.e; b.pt = t.part; b.uid = t.uid; b.shared = shared;
  b.tx = t.x; b.tz = t.z; b.tr = t.r; b.armored = t.armored;
}
function shareLock(b, o) {
  if (b.uid !== o.uid) { b.lockT = 0; b.arrived = false; }
  b.e = o.e; b.pt = o.pt; b.uid = o.uid; b.shared = true;
  b.tx = o.tx; b.tz = o.tz; b.tr = o.tr; b.armored = o.armored;
}

// Candidates: the best CAND targets ahead of a gun, sorted by score (lateral distance weighs more;
// armoured ones rank behind every soft one). No allocation: indices into g.targets.
const CAND = 10;
const candK = new Int16Array(CAND), candS = new Float32Array(CAND);
let nCand = 0;
const score = (dx, dz, armored) => dx * dx * PLASMA.side + dz * dz + (armored ? PLASMA.armor : 0);
function gather(g, gx, gz, range) {
  nCand = 0;
  const T = g.targets, r2 = range * range;
  for (let k = 0; k < g.nTargets; k++) {
    const t = T[k], e = t.e;
    if (!e.alive || e.dying || (t.part && t.part.dead)) continue;
    const dx = t.x - gx, dz = t.z - gz;
    if (dz > PLASMA.ahead || dx * dx + dz * dz > r2) continue;
    const s = score(dx, dz, t.armored);
    if (nCand === CAND && s >= candS[CAND - 1]) continue;
    let j = nCand < CAND ? nCand++ : CAND - 1;
    while (j > 0 && candS[j - 1] > s) { candS[j] = candS[j - 1]; candK[j] = candK[j - 1]; j--; }
    candS[j] = s; candK[j] = k;
  }
}
// uids held by the jet's own (non-shared) locks this step
const taken = new Int32Array(8);
let nTaken = 0;
function isTaken(uid) { for (let k = 0; k < nTaken; k++) if (taken[k] === uid) return true; return false; }
function untake(uid) { for (let k = 0; k < nTaken; k++) if (taken[k] === uid) { taken[k] = taken[--nTaken]; return; } }
let candT = null; // g.targets of the step being assigned
/** best candidate no jet beam holds yet (soft ones first, by the score order), or -1 */
function firstFree() {
  for (let c = 0; c < nCand; c++) if (!isTaken(candT[candK[c]].uid)) return c;
  return -1;
}

// Hand out targets to the jet's n beams (see PLASMA): locks hold while their target lives, is
// on screen and in reach; an armoured lock gives way to a free soft target, a soft one to a free
// target that is much closer (after a short commitment); free beams take the best free target,
// else double up on the first beam's lock.
function assignBeams(g, n, gx, gz) {
  candT = g.targets;
  gather(g, gx, gz, PLASMA.range);
  nTaken = 0;
  const reach = PLASMA.range * PLASMA.keep;
  for (let k = 0; k < BEAMS.length; k++) {
    const b = BEAMS[k];
    if (k >= n) { release(b); b.on = false; continue; }
    if (b.e && !lockHolds(g, b, gx, gz, reach)) release(b);
    if (b.e && !b.shared && !b.armored) taken[nTaken++] = b.uid;
  }
  for (let k = 0; k < n; k++) {
    const b = BEAMS[k];
    if (!b.e || b.shared) continue;
    const c = firstFree();
    if (b.armored) {
      if (c >= 0 && !candT[candK[c]].armored) lockOn(g, b, candT[candK[c]], true, false, k * 3);
      taken[nTaken++] = b.uid;
    } else if (c >= 0 && b.lockT > 0.4 && !candT[candK[c]].armored && candS[c] < score(b.tx - gx, b.tz - gz, false) * PLASMA.retarget) {
      untake(b.uid);
      lockOn(g, b, candT[candK[c]], true, false, k * 3);
      taken[nTaken++] = b.uid;
    }
  }
  for (let k = 0; k < n; k++) {
    const b = BEAMS[k];
    if (b.e && !b.shared) continue;
    const c = firstFree();
    if (c >= 0) { lockOn(g, b, candT[candK[c]], true, false, k * 3); taken[nTaken++] = b.uid; continue; }
    if (b.e) continue; // already doubling up on a live target
    let o = null;
    for (let j = 0; j < n && !o; j++) if (j !== k && BEAMS[j].e && !BEAMS[j].shared) o = BEAMS[j];
    if (o) shareLock(b, o);
  }
}
// Move a beam: the tip chases its target (or the idle point ahead), the control point sits straight
// ahead of the gun at ~0.45 of the reach, fanned out, and lags so strafing whips the beam.
function moveBeam(b, dt, mx, mz, fan, idle, snap) {
  b.mx = mx; b.mz = mz; b.fan = fan;
  if (snap) { b.ex = mx; b.ez = mz; b.cx = mx; b.cz = mz; }
  let wx, wz;
  if (b.e) { wx = b.tx; wz = b.tz; b.lockT += dt; } else { wx = mx + fan * 0.8; wz = mz - idle; b.lockT = 0; }
  const kt = 1 - Math.exp(-PLASMA.track * dt);
  b.ex += (wx - b.ex) * kt; b.ez += (wz - b.ez) * kt;
  if (b.e && !b.arrived) {
    const dx = wx - b.ex, dz = wz - b.ez, r = Math.max(0.6, b.tr * 0.7);
    if (dx * dx + dz * dz < r * r) b.arrived = true;
  }
  const reach = Math.hypot(b.ex - mx, b.ez - mz);
  const kc = 1 - Math.exp(-PLASMA.bend * dt);
  b.cx += (mx + fan * Math.min(1, reach / 8) - b.cx) * kc;
  b.cz += (mz - reach * 0.45 - b.cz) * kc;
}
// Burn the locked target once the tip has arrived (armour: deflect sparks, no damage).
function burn(g, b, dt, dps, vol) {
  if (!b.e || !b.arrived) return;
  b.fxT -= dt; b.sndT -= dt;
  if (b.armored) {
    if (b.fxT <= 0) { b.fxT = 0.08; g.fx.armorSpark(b.ex, 0.1, b.ez); }
    if (b.sndT <= 0) { b.sndT = 0.16; g.audio.play('hitArmor', { vol: 0.3 * vol }); }
    return;
  }
  const amt = dps * dt;
  if (b.pt) g.damagePart(b.e, b.pt, amt); else g.damageEnemy(b.e, amt);
  if (b.fxT <= 0) { b.fxT = g.fx.lowQuality ? 0.09 : 0.05; g.fx.hitSpark(b.ex, 0.1, b.ez, 1.0, 0.3, 0.85, 1); }
  if (b.sndT <= 0) { b.sndT = 0.1; g.audio.play('hit', { vol: 0.28 * vol }); }
}
function firePlasma(g, p, dt) {
  const lv = p.level, n = PLASMA.beams(lv);
  const gx = p.x, gz = p.z + g.muzzleZ;
  const fresh = !(g.time - plasmaT < 0.12); // (re)starting: the beams grow out of the gun
  plasmaT = g.time;
  if (fresh) resetBeams(BEAMS);
  assignBeams(g, n, gx, gz);
  const dps = (PLASMA.dps(lv) / n) * g.ac.dmg;
  for (let k = 0; k < n; k++) {
    const b = BEAMS[k], off = k - (n - 1) / 2;
    moveBeam(b, dt, gx + off * 0.22, gz, off * 1.4, PLASMA.idle, !b.on);
    b.on = true;
    burn(g, b, dt, dps, 1);
  }
  nBeams = n;
  g.audio.play('plasma'); // every step while the beams are on; audio.js holds one sustained voice
}
// One flat, flickering beam: overlapping streaks along the quadratic curve (a hot core inside a
// soft sheath) with glow joints, a travelling pulse, an impact flare and a lock reticle
// (reticle: false for a doubled-up beam).
function drawBeam(fx, b, k, W, A, t, reticle) {
  if (!b.on) return;
  const B = fx.beams, lowQ = fx.lowQuality;
  const x0 = b.mx, z0 = b.mz, x1 = b.cx, z1 = b.cz, x2 = b.ex, z2 = b.ez;
  const reach = Math.hypot(x1 - x0, z1 - z0) + Math.hypot(x2 - x1, z2 - z1); // ≥ curve length
  const n = clamp(Math.ceil(reach / (lowQ ? 1.4 : 0.85)), 3, 26);
  const idle = !b.e, arm = b.armored && !idle;
  const cr = arm ? STEEL[0] : PINK[0], cg = arm ? STEEL[1] : PINK[1], cb = arm ? STEEL[2] : PINK[2];
  const ph = (t * 2.4 + k * 0.37) % 1;
  let px = x0, pz = z0;
  for (let j = 1; j <= n; j++) {
    const s = j / n, u = 1 - s;
    const qx = u * u * x0 + 2 * u * s * x1 + s * s * x2, qz = u * u * z0 + 2 * u * s * z1 + s * s * z2;
    const dx = qx - px, dz = qz - pz, l = Math.sqrt(dx * dx + dz * dz), rot = flatRot(dx, dz);
    const sm = s - 0.5 / n, dp = (sm - ph) * 7;
    const tip = idle ? 1 - sm * sm * 0.85 : 1;              // an idle beam fades toward its tip
    const a = A * (1 + 0.7 * Math.exp(-dp * dp)) * tip;     // travelling pulse
    const w = W * (0.84 + 0.16 * Math.sin(t * 53 + sm * 13 + k * 2.1)) * (0.78 + 0.22 * sm);
    const mx = (px + qx) * 0.5, mz = (pz + qz) * 0.5, len = l * 1.75 + w * 0.4;
    if (!lowQ) B.push(mx, 0.1, mz, w * 2.4, len, rot, F.STREAK, 1, cr * 0.34 * a, cg * 0.3 * a, cb * 0.34 * a, 1, 0); // sheath
    B.push(mx, 0.1, mz, w, len, rot, F.STREAK, 1, cr * a, cg * a, cb * a, 1, 0.55);                                  // core
    if (!lowQ && j < n && (j & 1) === 0) B.push(qx, 0.1, qz, w * 1.9, w * 1.9, 0, F.GLOW, 0, cr * 0.3 * a, cg * 0.26 * a, cb * 0.3 * a, 0.45, 0.4); // joint
    px = qx; pz = qz;
  }
  if (idle) { // a soft spark where the beam gives out
    const s = 0.5 + 0.15 * Math.sin(t * 29 + k);
    B.push(x2, 0.1, z2, s, s, 0, F.GLOW, 0, cr * 0.5 * A, cg * 0.5 * A, cb * 0.5 * A, 0.7);
    return;
  }
  const f = (1.1 + 0.25 * Math.sin(t * 31 + k * 1.7)) * (b.arrived ? 1 : 0.6) * (0.7 + 0.3 * A);
  B.push(x2, 0.1, z2, f, f, t * 7 + k, F.FLARE, 0, cr * A, cg * A, cb * A, 1);
  if (!reticle) return;
  const lk = Math.min(1, b.lockT / 0.18);                    // lock-in: shrinks onto the target
  const rs = Math.max(1.4, b.tr * 3.1) * (1 + 1.3 * (1 - lk) * (1 - lk) + 0.05 * Math.sin(t * 12 + k)) * (0.75 + 0.25 * A);
  B.push(b.tx, 0.12, b.tz, rs, rs, t * 1.6 + k * 0.8, F.RETICLE, 1, cr * 1.1, cg * 1.1, cb * 1.1, 0.6 + 0.4 * lk, 0.5);
}
function drawPlasma(g, p, fx, t) {
  const lv = p.level, W = PLASMA.width(lv) * (nBeams > 1 ? 0.9 : 1);
  for (let k = 0; k < nBeams; k++) drawBeam(fx, BEAMS[k], k, W, 1, t, !BEAMS[k].shared);
  const w = 0.8 + lv * 0.09 + Math.sin(t * 37) * 0.1; // gun root
  fx.beams.push(p.x, 0.1, p.z + g.muzzleZ - 0.05, w, w, t * 3, F.FLARE, 0, 1.9, 0.4, 1.7, 1);
  if (g.optLive && g.options.length && g.time - droneT < 0.12) {
    const dw = DRONE_PLASMA.width(lv);
    for (let k = 0; k < g.options.length && k < DBEAMS.length; k++) {
      const b = DBEAMS[k];
      let own = true;
      for (let j = 0; j < nBeams; j++) if (BEAMS[j].uid === b.uid) own = false; // the jet's reticle is there already
      drawBeam(fx, b, k + 3, dw, 0.7, t, own && !!b.e);
    }
  }
}

// --- WAVE crescents ----------------------------------------------------------------------------
// Per-wave hit memory: WM_N uids per slot (ring), slot in ps.aux. Slots are handed out round-robin;
// a slot comes back after WM_SLOTS newer waves (~7 s of firing), long after its wave is gone.
const WM_SLOTS = 128, WM_N = 12;
const wmUid = new Int32Array(WM_SLOTS * WM_N), wmCnt = new Uint16Array(WM_SLOTS);
let wmNext = 0;
function waveSlot() { const s = wmNext; wmNext = (wmNext + 1) % WM_SLOTS; wmCnt[s] = 0; return s; }
function waveSeen(ps, i, uid) {
  const s = ps.aux[i] | 0, n = Math.min(wmCnt[s], WM_N), o = s * WM_N;
  for (let k = 0; k < n; k++) if (wmUid[o + k] === uid) return true;
  return false;
}
function waveMark(ps, i, uid) {
  const s = ps.aux[i] | 0, c = wmCnt[s];
  wmUid[s * WM_N + (c % WM_N)] = uid;
  wmCnt[s] = c < 60000 ? c + 1 : WM_N + ((c + 1) % WM_N);
  markHit(ps, i, uid);
}
function waveHalfWidth(t, full) { const k = clamp(t / WAVE.grow, 0, 1); return WAVE.hw0 + (full - WAVE.hw0) * (1 - (1 - k) * (1 - k)); }
// Is target t inside wave i's crescent band? In the wave's frame: lat across, back = behind the apex.
function waveTouches(ps, i, t) {
  const hw = ps.w[i], vx = ps.vx[i], vz = ps.vz[i], sp = Math.sqrt(vx * vx + vz * vz) || 1;
  const fx = vx / sp, fz = vz / sp, dx = t.x - ps.x[i], dz = t.z - ps.z[i];
  const lat = dz * fx - dx * fz, back = -(dx * fx + dz * fz);
  if (Math.abs(lat) > hw + t.r * 0.8) return false;
  const u = clamp(lat / hw, -1, 1);
  return Math.abs(back - WAVE.sag * hw * u * u) < WAVE.th + t.r * 0.85;
}
// Spawn a wave (main or drone) at its apex; full: its full half-width.
function addWave(g, x, z, vx, vz, dmg, full, age) {
  const i = addShot(g, x, z, vx, vz, dmg, SK.WAVE, WAVE.hw0 * 1.08 + WAVE.th, WAVE.hw0);
  if (i < 0) return;
  const ps = g.ps;
  ps.t[i] = age; ps.pierce[i] = 1; ps.trail[i] = full; ps.aux[i] = waveSlot();
}
// One wave touching one target: remember it, then damage (or deflect off armour).
function waveStrike(g, i, t) {
  const ps = g.ps, small = ps.trail[i] < 1.3;
  waveMark(ps, i, t.uid);
  const sz = t.z + t.r * 0.45; // the near edge, where the crescent meets it
  if (t.armored) { g.fx.armorSpark(t.x, 0.1, sz); g.audio.play('hitArmor', { vol: 0.35 }); return; }
  damageTarget(g, t, ps.dmg[i]);
  g.fx.hitSpark(t.x, 0.1, sz, 1.0, 0.78, 0.22, small ? 1 : 2);
  g.audio.play('hit', { vol: small ? 0.22 : 0.33 });
}
function fireWave(g, p, dt) {
  p.fireT -= dt;
  if (p.fireT < -0.2) p.fireT = 0;
  const gunZ = p.z + g.muzzleZ, lv = p.level;
  let fired = false;
  while (p.fireT <= 0) {
    const age = -p.fireT;
    p.fireT += WAVE.interval;
    addWave(g, p.x, gunZ - 0.1 - WAVE.speed * age, 0, -WAVE.speed, WAVE.dmg(lv), WAVE.hw(lv), age);
    fired = true;
  }
  if (fired) {
    g.fx.muzzle(p.x, gunZ, 2.2, 1.6, 0.4, 0.7 + lv * 0.05);
    g.audio.play('wave');
  }
}

export const MAIN = {
  red: { fire: fireVulcan },                        // VULCAN: widening spread
  blue: { fire: fireLaser, draw: drawLaserRoot },   // LASER: piercing-feel beam that whips after the jet
  pink: { fire: firePlasma, draw: drawPlasma, equip() { resetBeams(BEAMS); resetBeams(DBEAMS); nBeams = 0; plasmaT = droneT = -1; } }, // PLASMA: lock-on bending beams
  gold: { fire: fireWave },                         // WAVE: expanding piercing crescents
};

// --- sub-weapons ---------------------------------------------------------------------------
function fireHoming(g, p) {
  const lv = p.subLevel;
  p.subT = 0.62 - lv * 0.07;
  const n = lv >= 3 ? 4 : 2;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1, outer = i >= 2 ? 1.6 : 1;
    addShot(g, p.x + side * 0.5 * outer, p.z - 0.2, side * 7 * outer, 2, 2.6, SK.HOMING, 0.45);
  }
  g.audio.play('missile', { vol: 0.6 });
}
function fireNuke(g, p) {
  const lv = p.subLevel;
  p.subT = 0.56 - lv * 0.05;
  const n = lv >= 3 ? 4 : 2;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1, outer = i >= 2 ? 1.9 : 1;
    addShot(g, p.x + side * 0.55 * outer, p.z - 0.3, 0, -8, 3.0, SK.NUKE, 0.45);
  }
  g.audio.play('missile', { vol: 0.6 });
}
function fireMulti(g, p) {
  const lv = clamp(p.subLevel, 1, MULTI.length - 1);
  p.subT = ROCKET.interval(lv);
  for (const [ox, ad] of MULTI[lv]) {
    const a = ad * DEG;
    addShot(g, p.x + ox, p.z - 0.25, Math.sin(a) * ROCKET.v0, -Math.cos(a) * ROCKET.v0, ROCKET.dmg, SK.ROCKET, 0.42);
  }
  g.audio.play('multi', { vol: 0.6 });
}
export const SUB = {
  H: { fire: fireHoming },   // HOMING: seeks the nearest target ahead
  N: { fire: fireNuke },     // NUKE: slow straight rockets with a small blast
  M: { fire: fireMulti },    // MULTI: a widening fan of fast straight rockets
};

// --- option drones -------------------------------------------------------------------------
// the drones' stream angle: outward when spread, inward (converging) when tucked in
function droneDeg(g) { return (OPT.tuckDeg + (OPT.wideDeg - OPT.tuckDeg) * g.optSpread) * DEG; }
function droneFlash(g, opts, c, k) {
  for (let j = 0; j < opts.length; j++) { const d = opts[j]; g.fx.muzzle(d.x, d.z + d.muzzleZ, c[0] * k, c[1] * k, c[2] * k, 0.34); }
}
// VULCAN: twin straight shots per drone (the same damage per second as one stream at 0.1 s)
function droneVulcan(g, p, dt, opts) {
  p.optT -= dt;
  if (p.optT < -0.2) p.optT = 0;
  const deg = droneDeg(g), dmg = OPT.dmg + OPT.dmgPerLevel * p.level;
  let fired = false;
  while (p.optT <= 0) {
    const age = -p.optT;
    p.optT += OPT.interval;
    for (let k = 0; k < opts.length; k++) {
      const d = opts[k];
      const a = d.side * deg, sx = Math.sin(a), vx = sx * OPT.speed, vz = -Math.cos(a) * OPT.speed;
      const ox = Math.cos(a) * OPT.twin, oz = sx * OPT.twin; // across the stream
      for (let s = -1; s <= 1; s += 2) addShot(g, d.x + s * ox + vx * age, d.z + d.muzzleZ + s * oz + vz * age, vx, vz, dmg, SK.OPTION, OPT.r);
    }
    fired = true;
  }
  if (fired) droneFlash(g, opts, g.optCol, 1.6);
}
// LASER: a thin beam per drone that whips after it
function droneLaser(g, p, dt, opts) {
  p.optT -= dt;
  if (p.optT < -0.2) p.optT = 0;
  const dmg = OPT_LASER.dmg(p.level), sp = OPT_LASER.speed;
  while (p.optT <= 0) {
    const age = -p.optT;
    p.optT += OPT_LASER.interval;
    for (let k = 0; k < opts.length; k++) {
      const d = opts[k];
      const i = addShot(g, d.x, d.z + d.muzzleZ - sp * age, 0, -sp, dmg, SK.OPT_LASER, OPT_LASER.r);
      if (i >= 0) { g.ps.t[i] = age; g.ps.aux[i] = k; }
    }
  }
}
// WAVE: small crescents, angled like the other streams
function droneWave(g, p, dt, opts) {
  p.optT -= dt;
  if (p.optT < -0.2) p.optT = 0;
  const deg = droneDeg(g), lv = p.level, sp = DRONE_WAVE.speed;
  let fired = false;
  while (p.optT <= 0) {
    const age = -p.optT;
    p.optT += DRONE_WAVE.interval;
    for (let k = 0; k < opts.length; k++) {
      const d = opts[k];
      const a = d.side * deg, vx = Math.sin(a) * sp, vz = -Math.cos(a) * sp;
      addWave(g, d.x + vx * age, d.z + d.muzzleZ + vz * age, vx, vz, DRONE_WAVE.dmg(lv), DRONE_WAVE.hw(lv), age);
    }
    fired = true;
  }
  if (fired) droneFlash(g, opts, GOLD, 0.8);
}
// PLASMA: one short lock beam per drone. Tucked in, a drone burns the jet's first target when it
// can reach it; spread out, it locks the target nearest to itself (preferring ones the jet's
// beams leave alone) and keeps it while it holds.
function dronePlasma(g, p, dt, opts) {
  const fresh = !(g.time - droneT < 0.12);
  droneT = g.time;
  if (fresh) resetBeams(DBEAMS);
  const lv = p.level, dps = DRONE_PLASMA.dps(lv) * g.ac.dmg, R = DRONE_PLASMA.range;
  const tuck = g.optSpread < 0.5, main = BEAMS[0];
  candT = g.targets;
  for (let k = 0; k < opts.length && k < DBEAMS.length; k++) {
    const d = opts[k], b = DBEAMS[k];
    const gx = d.x, gz = d.z + d.muzzleZ;
    if (b.e && !lockHolds(g, b, gx, gz, R * 1.3)) release(b);
    if (tuck && main.e && main.arrived && main.uid !== b.uid) {
      const dx = main.tx - gx, dz = main.tz - gz;
      if (dz < PLASMA.ahead && dx * dx + dz * dz < R * R * 2.6) { shareLock(b, main); b.shared = false; }
    }
    if (!b.e) {
      gather(g, gx, gz, R);
      let c = firstFree();
      if (c < 0 && nCand) c = 0;
      if (c >= 0) lockOn(g, b, candT[candK[c]], false, false, 0);
    }
    moveBeam(b, dt, gx, gz, 0, DRONE_PLASMA.idle, !b.on);
    b.on = true;
    burn(g, b, dt, dps, 0.5);
  }
}
export const OPT_FIRE = { red: droneVulcan, blue: droneLaser, pink: dronePlasma, gold: droneWave };
export function fireOptions(g, dt) {
  const p = g.player, opts = g.options;
  if (!opts.length || !g.optLive) return;
  (OPT_FIRE[p.main] || droneVulcan)(g, p, dt, opts);
}

// --- shot kinds ----------------------------------------------------------------------------
function hitSound(g) { g.audio.play('hit', { vol: 0.35 }); }

export const SHOT = [];
SHOT[SK.VULCAN] = {
  life: 1.4,
  hit(g, i, t) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i];
    damageTarget(g, t, ps.dmg[i]);
    g.fx.hitSpark(x, 0.1, z, 1.0, 0.75, 0.35, 1);
    hitSound(g);
    return 'remove';
  },
  draw(g, i, fx) {
    const ps = g.ps;
    fx.bullets.push(ps.x[i], 0.1, ps.z[i], 0.36, 1.25, flatRot(ps.vx[i], ps.vz[i]), F.STREAK, 1, 2.8, 0.9, 0.2, 0.9, 0.3);
  },
};
SHOT[SK.LASER] = {
  life: 1.4,
  update(g, i, dt) {
    // the beam whips after the jet: young segments follow its x
    const ps = g.ps, p = g.player;
    const f = Math.max(0, 1 - ps.t[i] * 2.4);
    if (p.alive) ps.x[i] += (p.x - ps.x[i]) * Math.min(1, dt * 16) * f;
  },
  hit(g, i, t) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i];
    damageTarget(g, t, ps.dmg[i]);
    g.fx.hitSpark(x, 0.1, z - 0.2, 0.4, 0.9, 1.0, 2);
    const lv = g.player.level;
    g.fx.p.emit(x, 0.12, z, 0, 0, 0, 0.06, 0.7 + 0.1 * lv, 1.1 + 0.12 * lv, [0.8, 2.0, 3.0, 1], [0.3, 0.8, 1.5, 0], F.FLARE, 0, { drag: 0 });
    hitSound(g);
    return 'remove';
  },
  draw(g, i, fx) {
    const ps = g.ps, w = ps.w[i];
    const fade = Math.min(1, ps.t[i] * 20);
    fx.bullets.push(ps.x[i], 0.1, ps.z[i], w * 1.35, 1.9, 0, F.STREAK, 1, 0.35 * fade, 1.35 * fade, 3.0 * fade, 1);
  },
};
SHOT[SK.HOMING] = {
  life: 2.6,
  update(g, i, dt) {
    const ps = g.ps;
    let tg = ps.target[i];
    if (!tg || !tg.alive || tg.dying || (tg.part && tg.part.dead)) { tg = g.findTarget(ps.x[i], ps.z[i]); ps.target[i] = tg; }
    const sp = Math.min(26, Math.hypot(ps.vx[i], ps.vz[i]) + 40 * dt);
    let ang = Math.atan2(ps.vx[i], ps.vz[i]);
    let want = Math.PI; // straight up
    if (tg && ps.t[i] > 0.12) want = Math.atan2(tg.x - ps.x[i], tg.z - ps.z[i]);
    let da = want - ang;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    ang += clamp(da, -8 * dt, 8 * dt);
    ps.vx[i] = Math.sin(ang) * sp; ps.vz[i] = Math.cos(ang) * sp;
    ps.trail[i] -= dt;
    if (ps.trail[i] <= 0) { ps.trail[i] = 0.022; g.fx.missileTrail(ps.x[i], ps.z[i], 0.6, 1.8, 0.5); }
  },
  hit(g, i, t) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i];
    damageTarget(g, t, ps.dmg[i]);
    g.fx.hitSpark(x, 0.1, z, 1.0, 0.75, 0.35, 3);
    hitSound(g);
    return 'remove';
  },
  draw(g, i, fx) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i];
    fx.bullets.push(x, 0.1, z, 0.34, 0.9, flatRot(ps.vx[i], ps.vz[i]), F.STREAK, 1, 1.2, 3.0, 0.8, 1, 0.6);
    fx.bullets.push(x, 0.1, z, 0.7, 0.7, 0, F.GLOW, 0, 0.5, 1.6, 0.4, 0.8);
  },
};
SHOT[SK.NUKE] = {
  life: 1.4,
  update(g, i, dt) {
    const ps = g.ps;
    ps.vz[i] = Math.max(-30, ps.vz[i] - 60 * dt);
    ps.trail[i] -= dt;
    if (ps.trail[i] <= 0) { ps.trail[i] = 0.022; g.fx.missileTrail(ps.x[i], ps.z[i] + 0.3, 1.4, 0.6, 2.2); }
  },
  hit(g, i, t) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i];
    damageTarget(g, t, ps.dmg[i]);
    g.fx.explosion(x, 0.2, z, 0.7);
    // small blast: everything else within ~1.6 units takes splash damage
    const T = g.targets, splash = 1.5 * g.ac.dmg;
    for (let k = 0; k < g.nTargets; k++) {
      const u = T[k];
      if (u === t || u.armored) continue;
      const dx = u.x - x, dz = u.z - z;
      if (dx * dx + dz * dz < 2.6) damageTarget(g, u, splash);
    }
    hitSound(g);
    return 'remove';
  },
  draw(g, i, fx) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i];
    fx.bullets.push(x, 0.1, z, 0.36, 1.0, 0, F.STREAK, 1, 1.8, 0.8, 2.6, 1, 0.6);
    fx.bullets.push(x, 0.1, z, 0.6, 0.6, 0, F.GLOW, 0, 0.9, 0.35, 1.5, 0.45);
  },
};
SHOT[SK.OPTION] = { // the drones' VULCAN pair: drone-tinted tracers
  life: 1.4,
  hit(g, i, t) {
    const ps = g.ps, c = g.optCol;
    damageTarget(g, t, ps.dmg[i]);
    g.fx.hitSpark(ps.x[i], 0.1, ps.z[i], c[0], c[1], c[2], 1);
    g.audio.play('hit', { vol: 0.25 });
    return 'remove';
  },
  draw(g, i, fx) {
    const ps = g.ps, c = g.optCol;
    fx.bullets.push(ps.x[i], 0.1, ps.z[i], 0.3, 1.05, flatRot(ps.vx[i], ps.vz[i]), F.STREAK, 1, c[0] * 2.4, c[1] * 2.4, c[2] * 2.4, 0.9, 0.35);
  },
};
SHOT[SK.WAVE] = {
  life: WAVE.life,
  update(g, i) {
    const ps = g.ps, hw = waveHalfWidth(ps.t[i], ps.trail[i]);
    ps.w[i] = hw; ps.r[i] = hw * 1.08 + WAVE.th; // the circle that holds the whole crescent
  },
  test(g, i, t) { const ps = g.ps; return !waveSeen(ps, i, t.uid) && waveTouches(ps, i, t); },
  hit(g, i, t) {
    waveStrike(g, i, t);
    // everything else the crescent covers right now takes its hit this step too
    const ps = g.ps, T = g.targets, x = ps.x[i], z = ps.z[i], r = ps.r[i];
    for (let k = 0; k < g.nTargets; k++) {
      const u = T[k];
      if (u === t) continue;
      const dx = u.x - x, dz = u.z - z, rr = r + u.r;
      if (dx * dx + dz * dz < rr * rr && !waveSeen(ps, i, u.uid) && waveTouches(ps, i, u)) waveStrike(g, i, u);
    }
    return 'keep';
  },
  armor(g, i, t) {
    const ps = g.ps;
    if (t !== g.hullTarget) return SHOT[SK.WAVE].hit(g, i, t); // armoured part: sparks, sweeps on
    if (!waveSeen(ps, i, 0)) { // a boss hull: one spray of sparks, the wave sails through
      waveMark(ps, i, 0);
      g.fx.armorSpark(ps.x[i] - ps.w[i] * 0.5, 0.1, ps.z[i]); g.fx.armorSpark(ps.x[i] + ps.w[i] * 0.5, 0.1, ps.z[i]);
      g.audio.play('hitArmor', { vol: 0.3 });
    }
    return 'keep';
  },
  draw(g, i, fx) {
    // the ARC frame's apex sits 0.25 × its height ahead of the quad centre, its tips at ±0.41 × width
    const ps = g.ps, hw = ps.w[i], t = ps.t[i], small = ps.trail[i] < 1.3;
    const vx = ps.vx[i], vz = ps.vz[i], sp = Math.sqrt(vx * vx + vz * vz) || 1, fx_ = vx / sp, fz_ = vz / sp;
    const sx = hw * 2.44, sy = sx * 0.62, back = sy * 0.25, rot = flatRot(vx, vz);
    // fades in at the gun, dims as it travels (the far screen stays readable), fades out at the end
    const a = Math.min(1, t * 14) * clamp((WAVE.life - t) / 0.3, 0, 1) * (1 - 0.5 * t / WAVE.life) * (small ? 0.75 : clamp(1.2 - 0.06 * hw, 0.8, 1.1));
    const cx = ps.x[i] - fx_ * back, cz = ps.z[i] - fz_ * back;
    const B = fx.beams;
    B.push(cx, 0.1, cz, sx, sy, rot, F.ARC, 1, GOLD[0] * a, GOLD[1] * a, GOLD[2] * a, 1, 0.5);
    if (fx.lowQuality) return;
    B.push(cx - fx_ * 0.5, 0.1, cz - fz_ * 0.5, sx * 0.95, sy * 0.95, rot, F.ARC, 1, 0.55 * a, 0.26 * a, 0.03 * a, 0.5, 0); // afterimage
    if (small) return;
    const tb = WAVE.sag * hw, gs = 0.55 + hw * 0.07; // glints on the tips
    for (let s = -1; s <= 1; s += 2) {
      B.push(ps.x[i] - fz_ * hw * s - fx_ * tb, 0.1, ps.z[i] + fx_ * hw * s - fz_ * tb, gs, gs, 0, F.GLOW, 0, 1.1 * a, 0.75 * a, 0.2 * a, 0.7);
    }
  },
};
SHOT[SK.ROCKET] = {
  life: 1.6,
  update(g, i, dt) {
    const ps = g.ps, vx = ps.vx[i], vz = ps.vz[i], sp = Math.sqrt(vx * vx + vz * vz) || 1;
    const ns = Math.min(ROCKET.v1, sp + ROCKET.acc * dt), k = ns / sp;
    ps.vx[i] = vx * k; ps.vz[i] = vz * k;
    ps.trail[i] -= dt;
    if (ps.trail[i] <= 0) {
      ps.trail[i] = g.fx.lowQuality ? 0.055 : 0.03;
      g.fx.rocketTrail(ps.x[i] - (vx / sp) * 0.45, ps.z[i] - (vz / sp) * 0.45, 0.7, 1.3, 2.6);
    }
  },
  hit(g, i, t) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i];
    damageTarget(g, t, ps.dmg[i]);
    g.fx.pop(x, 0.15, z, 0.75, 0.55, 0.9, 1.8);
    hitSound(g);
    return 'remove';
  },
  draw(g, i, fx) {
    const ps = g.ps, x = ps.x[i], z = ps.z[i], vx = ps.vx[i], vz = ps.vz[i];
    const sp = Math.sqrt(vx * vx + vz * vz) || 1, bx = -vx / sp, bz = -vz / sp, rot = flatRot(vx, vz);
    const fl = 0.8 + 0.2 * Math.sin(ps.t[i] * 70 + i);
    fx.beams.push(x, 0.1, z, 0.36, 1.3, rot, F.STREAK, 1, SKY[0], SKY[1], SKY[2], 1, 0.7);                       // body
    fx.beams.push(x + bx * 0.75, 0.1, z + bz * 0.75, 0.3 * fl, 0.9 * fl, rot, F.STREAK, 1, 2.2, 1.6, 1.0, 1, 1); // exhaust
    fx.beams.push(x, 0.1, z, 0.85, 0.85, 0, F.GLOW, 0, 0.3, 0.62, 1.3, 0.75);
  },
};
SHOT[SK.OPT_LASER] = {
  life: 1.4,
  update(g, i, dt) {
    // like the jet's laser: young segments follow their drone's x
    const ps = g.ps, d = g.options[ps.aux[i] | 0];
    const f = Math.max(0, 1 - ps.t[i] * 2.4);
    if (d && g.optLive) ps.x[i] += (d.x - ps.x[i]) * Math.min(1, dt * 16) * f;
  },
  hit(g, i, t) {
    const ps = g.ps;
    damageTarget(g, t, ps.dmg[i]);
    g.fx.hitSpark(ps.x[i], 0.1, ps.z[i] - 0.2, 0.4, 0.9, 1.0, 1);
    g.audio.play('hit', { vol: 0.22 });
    return 'remove';
  },
  draw(g, i, fx) {
    const ps = g.ps, fade = Math.min(1, ps.t[i] * 20);
    fx.beams.push(ps.x[i], 0.1, ps.z[i], 0.36, 2.5, 0, F.STREAK, 1, 0.3 * fade, 1.15 * fade, 2.6 * fade, 1);
  },
};

// every weapon key and shot kind needs its table entry: say so at load, not mid-game
for (const k of Object.keys(MAIN_WEAPONS)) if (!MAIN[k]) console.error(`weapons: no MAIN entry for main weapon "${k}" (falls back to VULCAN)`);
for (const k of Object.keys(MAIN_WEAPONS)) if (!OPT_FIRE[k]) console.error(`weapons: no OPT_FIRE entry for main weapon "${k}" (drones fall back to VULCAN)`);
for (const k of Object.keys(SUB_WEAPONS)) if (!SUB[k]) console.error(`weapons: no SUB entry for sub-weapon "${k}" (falls back to HOMING)`);
for (const [name, k] of Object.entries(SK)) if (!SHOT[k] || typeof SHOT[k].draw !== 'function' || typeof SHOT[k].hit !== 'function') console.error(`weapons: SHOT[SK.${name}] is missing or incomplete`);

// --- entry points (called by game.js) --------------------------------------------------------
/** an item just switched p.main (slot 'main') or p.sub (slot 'sub') */
export function equipped(g, p, slot) {
  const W = slot === 'main' ? MAIN[p.main] : SUB[p.sub];
  if (W && W.equip) W.equip(g, p);
}
export function fireWeapons(g, dt) {
  if (!canShoot(g)) return;
  const p = g.player;
  (MAIN[p.main] || MAIN.red).fire(g, p, dt);
  if (p.sub) {
    p.subT -= dt;
    if (p.subT <= 0) (SUB[p.sub] || SUB.H).fire(g, p);
  }
  if (g.options.length) fireOptions(g, dt);
}
export function updateShots(g, dt) {
  const ps = g.ps, v = g.view;
  let i = 0;
  while (i < ps.n) {
    ps.t[i] += dt;
    const S = SHOT[ps.kind[i]];
    if (S.update && S.update(g, i, dt) === 'remove') { g.removeShot(i); continue; }
    ps.x[i] += ps.vx[i] * dt; ps.z[i] += ps.vz[i] * dt;
    if (ps.t[i] > S.life || ps.z[i] < v.zTop - 3 || ps.z[i] > v.zBottom + 3 || Math.abs(ps.x[i]) > v.hw(ps.z[i]) + 3) { g.removeShot(i); continue; }
    i++;
  }
}
/** shot i touched target t: armour sparks (or SHOT.armor), else the kind's hit → 'remove' | 'keep' */
export function shotHit(g, i, t) {
  const S = SHOT[g.ps.kind[i]];
  if (t.armored) return S.armor ? S.armor(g, i, t) : armorHit(g, i);
  return S.hit(g, i, t);
}
export function drawWeapons(g, fx) {
  const ps = g.ps;
  for (let i = 0; i < ps.n; i++) SHOT[ps.kind[i]].draw(g, i, fx);
  const p = g.player, W = MAIN[p.main];
  if (W && W.draw && canShoot(g)) W.draw(g, p, fx, g.time);
}
