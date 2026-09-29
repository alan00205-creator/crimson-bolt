// weapons.js — the player's weapons: main weapons (P items), sub-weapons (S items), option drones
// and every kind of player shot. game.js owns the shot arrays (g.ps, structure of arrays) and the
// collision loop, and calls in here:
//   fireWeapons(g, dt)   every update step: main weapon, sub-weapon, option drones
//   updateShots(g, dt)   move, age and cull shots
//   shotHit(g, i, t)     shot i touched target t (from game.collide) → 'remove' | 'keep'
//   drawWeapons(g, fx)   every rendered frame: shots, then beam roots / muzzle glows
//
// Tables — a new weapon is one entry in each (plus its item colour / letter in defs.js):
//   MAIN[key]  = { fire(g, p, dt), draw?(g, p, fx, t) }   key: MAIN_WEAPONS key (p.main)
//   SUB[key]   = { fire(g, p) }                           key: SUB_WEAPONS key (p.sub); called when
//                                                         p.subT runs out, must set p.subT again
//   SHOT[kind] = { life, update?(g, i, dt) → 'remove'?, hit(g, i, t) → 'remove' | 'keep',
//                  armor?(g, i, t) → 'remove' | 'keep', draw(g, i, fx) }      kind: SK value
// Continuous weapons keep a cadence timer on the player and fire with the age-compensated loop
//   timer -= dt; if (timer < -0.2) timer = 0; while (timer <= 0) { age = -timer; timer += interval; … }
// spawning each shot where it would be after `age` seconds, because main.js may split a frame into
// two update steps; the cadence then stays exact at any frame rate.
//
// Shot fields (g.ps, index i): x z vx vz, dmg (already × aircraft dmg), r (hit radius), t (age),
// kind, w (beam width), target (homing lock), trail (smoke timer), and three generic ones for new
// weapons: pierce (Uint8: >0 = passes through, skips targets already in its hit list), hits (4 target
// uids per shot: hits[i * 4 .. i * 4 + 3], see markHit / wasHit) and aux (one free float).
// addShot() initialises every field and game.removeShot() copies every field.
import { F, flatRot } from './fx.js';
import { MAIN_WEAPONS, SUB_WEAPONS } from './defs.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Player shot kinds (index into SHOT; ps.kind is a Uint8Array)
export const SK = { VULCAN: 0, LASER: 1, HOMING: 2, NUKE: 3, OPTION: 4 };

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

// Option drones: a light stream per drone. Spread wide they angle outward for coverage; tucked in
// (slow) they angle inward and cross about 12 units ahead, so all of it lands on one target.
const OPT = { interval: 0.1, speed: 38, dmg: 0.45, dmgPerLevel: 0.05, r: 0.34, wideDeg: 5, tuckDeg: -3 };

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

export const MAIN = {
  red: { fire: fireVulcan },                        // VULCAN: widening spread
  blue: { fire: fireLaser, draw: drawLaserRoot },   // LASER: piercing-feel beam that whips after the jet
  // ── PLACEHOLDERS until task B6 builds them: PLASMA (pink) and WAVE (gold) fire the VULCAN ──
  pink: { fire: fireVulcan, placeholder: true },
  gold: { fire: fireVulcan, placeholder: true },
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
export const SUB = {
  H: { fire: fireHoming },   // HOMING: seeks the nearest target ahead
  N: { fire: fireNuke },     // NUKE: slow straight rockets with a small blast
  // ── PLACEHOLDER until task B6 builds it: MULTI (M) fires HOMING ──
  M: { fire: fireHoming, placeholder: true },
};

// --- option drones -------------------------------------------------------------------------
export function fireOptions(g, dt) {
  const p = g.player, opts = g.options;
  if (!opts.length || !g.optLive) return;
  p.optT -= dt;
  if (p.optT < -0.2) p.optT = 0;
  const s = g.optSpread;
  const deg = (OPT.tuckDeg + (OPT.wideDeg - OPT.tuckDeg) * s) * DEG;
  const dmg = OPT.dmg + OPT.dmgPerLevel * p.level;
  let fired = false;
  while (p.optT <= 0) {
    const age = -p.optT;
    p.optT += OPT.interval;
    for (let k = 0; k < opts.length; k++) {
      const d = opts[k];
      const a = d.side * deg, vx = Math.sin(a) * OPT.speed, vz = -Math.cos(a) * OPT.speed;
      addShot(g, d.x + vx * age, d.z + d.muzzleZ + vz * age, vx, vz, dmg, SK.OPTION, OPT.r);
    }
    fired = true;
  }
  if (fired) {
    const c = g.optCol;
    for (let k = 0; k < opts.length; k++) { const d = opts[k]; g.fx.muzzle(d.x, d.z + d.muzzleZ, c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 0.34); }
  }
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
SHOT[SK.OPTION] = {
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

// every weapon key and shot kind needs its table entry: say so at load, not mid-game
for (const k of Object.keys(MAIN_WEAPONS)) if (!MAIN[k]) console.error(`weapons: no MAIN entry for main weapon "${k}" (falls back to VULCAN)`);
for (const k of Object.keys(SUB_WEAPONS)) if (!SUB[k]) console.error(`weapons: no SUB entry for sub-weapon "${k}" (falls back to HOMING)`);
for (const [name, k] of Object.entries(SK)) if (!SHOT[k] || typeof SHOT[k].draw !== 'function' || typeof SHOT[k].hit !== 'function') console.error(`weapons: SHOT[SK.${name}] is missing or incomplete`);

// --- per-frame entry points (called by game.js) ---------------------------------------------
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
