// stage4.js — STAGE 4 "ORBITAL FRONT" (軌道戰線): Earth orbit, air units only.
// World 'orbit' (world.js): earth-lit day side 0–420 · debris storm over the night side 420–800 ·
// the enemy station passing below 800–1240 · the arena over the planet's limb 1240+. Nothing below the
// play area but the planet: every unit here flies. Enemy types introduced here (models in models_s4.js):
//   s4_drone    orbital drones: ring formations that spin in and burst apart, RCS "jinkers" that hop
//               from hold to hold with an aimed shot at each stop, loops that swing round the screen
//   s4_laser    laser satellite: drifts in from the side, tracks the jet with a red targeting beam,
//               locks it (the telegraph) and fires a pulse of fast needles down the locked line
//   s4_frigate  space frigate: crosses the screen broadside-on (or stops to hold station) and
//               ripples lattices of orbs from its gun sponsons; tanky, carries items
//   s4_mine     proximity mine pod: drifts down, arms (red, blinking) when the jet comes close or it
//               sinks low, and bursts into a ring of orbs — shoot it first
//   hydra       mid-boss weapons platform: three cannon heads on articulated necks (snapping needle
//               bursts from the outer two, a scattered "breath" from the centre), then its core
//   aegis       boss: the orbital defence platform — shield generators and gun turrets on a ring that
//               turns round the shielded hub, then the railgun (a telegraphed lane) and its capacitor
//               banks, then the open reactor
// Stage-1 carriers bring the items; stage 3's interceptors fly escort now and then.
import { STAGE_META } from './defs.js';
import { F } from './fx.js';
import { bez, W, makeTimeline, midbossEvent, bossDefeated } from './stage.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// Enemy definitions (see the field list at the top of stage.js).
export const ENEMY = {
  s4_drone: { hp: 5, score: 350, radius: 0.75, air: true, explode: 0.9, debris: 6, medal: 0.2, prewarm: 18 },
  // the laser satellite's circle reaches well out along its collector wings (shots used to pass through the
  // glowing blades); the frigate's covers its bow and stern engine block broadside-on
  s4_laser: { hp: 88, score: 2500, radius: 1.9, air: true, explode: 1.7, debris: 12, medal: 1, prewarm: 4 },
  s4_frigate: { hp: 170, score: 5000, radius: 2.0, air: true, explode: 2.4, debris: 20, medal: 2, prewarm: 3 },
  s4_mine: { hp: 10, score: 250, radius: 0.7, air: true, explode: 0.8, debris: 5, noHpSeg: true, prewarm: 16 },
  // mid-boss: three heads on necks, then the core (armoured under its lid until two heads are gone or
  // 16 s have passed). The body is armour and never a target (bodyTarget: false), so shots, locks and
  // missiles go for the heads and the core; hp is only a backstop. keepOff holds the jet 8 below the
  // body: the heads reach ~4 in front of it, beyond shoot()'s point-blank rule, so hugging can't silence
  // them. hull: the carapace aft of the core (shots that clear the heads and the core spark off it).
  hydra: {
    hp: 9999, score: 40000, radius: 2.0, air: true, explode: 3.4, debris: 32, midboss: true, noRevenge: true, bodyTarget: false, keepOff: 8, prewarm: 1,
    parts: [
      { key: 'headL', hp: 165, score: 6000, medals: 2, big: 1.8 }, { key: 'headC', hp: 210, score: 8000, medals: 2, big: 2.0 },
      { key: 'headR', hp: 165, score: 6000, medals: 2, big: 1.8 },
      { key: 'core', hp: 660, core: true, score: 40000 },
    ],
    hull: { hw: 2.2, z0: -2.9, z1: -1.75 },        // the carapace behind the core (never in front of a part)
  },
  // boss: parts in hit-test order. The railgun and the capacitor banks start sealed (not targets) and count
  // in the HP bar from the start; the core is armoured until phase 3. hull: the hub aft of the core and the
  // capacitor banks (never in front of a part); while the shield dome is up the unit wears AEGIS_DOMED, whose
  // hull is the whole dome (shots spark off the shield instead of flying through the hub).
  aegis: {
    hp: 1, score: 0, radius: 5.0, air: true, explode: 4, debris: 40, boss: true, model: 'aegis', prewarm: 1,
    parts: [
      { key: 'turret', list: true, hp: 150, score: 5000 },
      { key: 'gen', list: true, hp: 230, score: 8000, medals: 2, big: 1.8 },
      { key: 'cannon', hp: 700, score: 25000, medals: 4, big: 2.4 },
      { key: 'capL', hp: 260, score: 10000, medals: 2, big: 1.6 },
      { key: 'capR', hp: 260, score: 10000, medals: 2, big: 1.6 },
      { key: 'core', hp: 1850, core: true, score: 250000 },
    ],
    hull: { hw: 2.3, z0: -2.9, z1: -1.95 },
  },
};
const AEGIS_DOMED = { ...ENEMY.aegis, hull: { hw: 3.0, z0: -3.1, z1: 3.1 } };

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// The top HUD is fixed CSS px (index.html: score strip ≈ 58 px, boss bar down to ≈ 102 px), so on short
// phones a row picked relative to zTop can sit under it. zAtRow gives the world z at height y that
// projects to CSS pixel row py (screen centre column): hover rows are kept at or below it.
const HUD_ROW = 80;    // clear of the score strip
const BAR_ROW = 118;   // 16 px under the boss bar
const rowQ = { x: 0, z: 0 };
function zAtRow(v, py, y = 0) {
  const q = v.screenToPlane(v.w / 2, py, rowQ);
  return v.C.z + (q.z - v.C.z) * (1 - y / v.C.y);
}
const live = (pt) => (pt && !pt.dead ? pt : null);

// --------------------------------------------------------------------------------
// shared effects (constant colour / option tables: nothing is allocated per frame)
// --------------------------------------------------------------------------------
const ION_A = [0.9, 1.0, 2.6, 0.9], ION_B = [0.2, 0.2, 0.7, 0];            // ion exhaust (blue-violet)
const GRN_A = [0.5, 2.4, 1.2, 1], GRN_B = [0.1, 0.6, 0.3, 0];             // emerald discharge
const FIRE_A = [2.4, 1.1, 0.35, 0.9], FIRE_B = [0.9, 0.2, 0.05, 0];       // re-entry fire
const HOT_A = [2.8, 2.2, 1.6, 1], HOT_B = [1.2, 0.4, 0.15, 0];
const SMOKE_A = [0.22, 0.2, 0.22, 0.55], SMOKE_B = [0.12, 0.11, 0.12, 0];
const OPT_ION = { drag: 1.2 }, OPT_FIRE = { drag: 0.6, vrot: 0 }, OPT_FLAT = { flat: true, rot: 0, drag: 0 }, OPT_SMOKE = { drag: 0.5, vrot: 0 };
const OPT_SHARD = { drag: 3, stretch: 0.05 };
/** a puff of ion exhaust behind a unit (x, z on the plane; dz = the exhaust direction on the plane) */
function ionPuff(g, x, z, dx, dz, s = 0.35) {
  g.fx.p.emit(x + rnd(-0.08, 0.08), 0.02, z + rnd(-0.08, 0.08), dx * rnd(1, 2.5), 0, dz * rnd(1, 2.5), rnd(0.2, 0.35), s, s * 0.3, ION_A, ION_B, F.GLOW, 0, OPT_ION);
}
/** emerald discharge sparks at a point (a laser pulse leaving the lens, a shield generator pulsing) */
function greenFlash(g, x, z, s = 1) {
  const p = g.fx.p;
  p.emit(x, 0.3, z, 0, 0, 0, 0.14, 0.6 * s, 2.2 * s, GRN_A, GRN_B, F.GLOW, 0, OPT_FLAT);
  p.emit(x, 0.3, z, 0, 0, 0, 0.2, 0.5 * s, 2.6 * s, GRN_A, GRN_B, F.FLARE, 0, OPT_FLAT);
}
/** re-entry fire streaming off something falling toward the planet (y: its height, it trails up) */
function reentry(g, x, y, z, s) {
  OPT_FIRE.vrot = rnd(-2, 2);
  g.fx.p.emit(x + rnd(-1, 1) * s, y, z + rnd(-1, 1) * s, rnd(-0.6, 0.6), rnd(2.5, 5.5), rnd(-0.6, 0.6), rnd(0.45, 0.8), rnd(0.5, 0.9) * s, rnd(1.4, 2.4) * s,
    FIRE_A, FIRE_B, F.FIRE, 0, OPT_FIRE);
  if (Math.random() < 0.5) {
    OPT_SMOKE.vrot = rnd(-0.8, 0.8);
    g.fx.p.emit(x + rnd(-1, 1) * s, y + 0.5, z + rnd(-1, 1) * s, rnd(-0.3, 0.3), rnd(1.5, 3.0), rnd(-0.3, 0.3), rnd(1.0, 1.6), s * 0.8, s * 2.6, SMOKE_A, SMOKE_B, F.SMOKE, 2, OPT_SMOKE);
  }
}

// --------------------------------------------------------------------------------
// drones
// --------------------------------------------------------------------------------
// Ring: n drones in a ring that spins as it descends into the upper screen, then bursts apart — each
// drone burns straight out along its spoke. The ring ripples a round of aimed orbs round its rim as it
// settles (one drone after another), and every drone fires again as the ring breaks.
function ringAI(cx, n, k, zf = 0.28, dir = 1, R = 2.2) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (s.z0 === undefined) {
      s.z0 = v.zTop - 3; s.cz = v.zTop + (v.zBottom - v.zTop) * zf; s.a0 = (k / n) * TAU; s.fixedYaw = true; s.yaw = Math.PI;
      s.st = 1.15 + (k / n) * 0.6;
      if (ud.setThrust) ud.setThrust(0.3);
    }
    if (!s.burst) {
      const u = ease(e.t / 2.3), a = s.a0 + e.t * 1.6 * dir, r = R * (0.55 + 0.45 * u);
      e.x = cx + Math.cos(a) * r;
      e.z = s.z0 + (s.cz - s.z0) * u + Math.sin(a) * r * 0.85;
      if (s.st > 0 && e.t > s.st) { s.st = 0; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 6.6); }
      if (e.t > 3.1) {
        s.burst = true; s.bt = 0; s.dx = Math.cos(a); s.dz = Math.sin(a) * 0.85;
        if (ud.setThrust) ud.setThrust(1);
        if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 7.0);
      }
    } else {
      s.bt += dt;
      const sp = 2.5 + s.bt * 9;
      e.x += s.dx * sp * dt; e.z += (s.dz * sp + 1.5) * dt;
      if (Math.random() < 0.5) ionPuff(g, e.x - s.dx * 0.6, e.z - s.dz * 0.6, -s.dx, -s.dz, 0.3);
    }
  };
}
// Jinker: RCS hops. It burns in from the top to a hold point, stops dead, fires an aimed 3-way, and
// hops again toward the jet's column (a little lower each time); after `hops` holds it burns away.
function jinkAI(x0, hops = 3, zf = 0.2) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData, p = g.player;
    if (!s.mode) {
      s.mode = 'hop'; s.mt = 0; s.hop = 0; s.dur = 1.0; s.fixedYaw = true; s.yaw = Math.PI;
      s.sx = x0; s.sz = v.zTop - 2; s.fx = x0; s.fz = v.zTop + (v.zBottom - v.zTop) * zf; e.x = s.sx; e.z = s.sz;
    }
    s.mt += dt;
    if (s.mode === 'hop') {
      const u = clamp(s.mt / s.dur, 0, 1), k = smooth(u);
      e.x = s.sx + (s.fx - s.sx) * k; e.z = s.sz + (s.fz - s.sz) * k;
      if (ud.setThrust) ud.setThrust(u < 0.3 || u > 0.7 ? 1 : 0.35);
      if (u < 0.3 && Math.random() < 0.6) ionPuff(g, e.x, e.z - 0.8, s.sx - s.fx > 0 ? 0.4 : -0.4, -1, 0.3);
      if (u >= 1) { s.mode = 'hold'; s.mt = 0; s.fired = false; if (ud.setThrust) ud.setThrust(0.12); }
    } else if (s.mode === 'hold') {
      if (!s.fired && s.mt > 0.16 / g.diff.fr) {
        s.fired = true;
        if (g.canFire(e)) g.fan(e.x, e.z, g.aim(e.x, e.z), 3, 0.34, 7.2);
      }
      if (s.mt > 0.75) {
        s.hop++; s.sx = e.x; s.sz = e.z; s.mt = 0;
        if (s.hop >= hops) { s.mode = 'out'; s.dx = e.x > 0 ? 1 : -1; }
        else {
          s.mode = 'hop'; s.dur = 0.55;
          s.fx = clamp(e.x + clamp(p.x - e.x, -3.2, 3.2) + rnd(-1, 1), -7, 7);
          s.fz = Math.min(e.z + rnd(1.4, 3.0), v.zTop + (v.zBottom - v.zTop) * 0.6);
        }
      }
    } else {                                     // burn away over the nearer edge
      e.x += s.dx * (3 + s.mt * 14) * dt; e.z -= (1 + s.mt * 4) * dt;
      if (ud.setThrust) ud.setThrust(1);
    }
  };
}
// Loop: drop in along one side, swing round a loop through the lower-middle screen and climb out over the
// top toward the other side (side = +1: in on the left, round clockwise). An aimed 3-way at the bottom
// and a single orb as it climbs the far side.
function loopAI(side, zf = 0.3, R = 4.4) {
  const w = 1.7, sp = w * R;                     // loop angular speed (rad/s), path speed
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.cz === undefined) {
      s.cx = side * 1.6; s.cz = v.zTop + (v.zBottom - v.zTop) * zf; s.xl = s.cx - side * R; s.z0 = v.zTop - 2.5;
      s.t1 = (s.cz - s.z0) / sp; s.fixedYaw = true; s.yaw = Math.PI;
    }
    if (e.t < s.t1) { e.x = s.xl; e.z = s.z0 + sp * e.t; }
    else {
      const th = (e.t - s.t1) * w;               // 0 → 3/2 π round the loop (over the top last), then out
      if (th < 1.5 * Math.PI) {
        const a = (side > 0 ? Math.PI : 0) - side * th;
        e.x = s.cx + Math.cos(a) * R; e.z = s.cz + Math.sin(a) * R;
        if ((s.fired | 0) < (th > Math.PI * 1.1 ? 2 : th > Math.PI * 0.45 ? 1 : 0)) {
          s.fired = (s.fired | 0) + 1;
          if (g.canFire(e)) { if (s.fired === 1) g.fan(e.x, e.z, g.aim(e.x, e.z), 3, 0.3, 7.0); else g.shoot(e.x, e.z, g.aim(e.x, e.z), 7.4); }
        }
      } else {                                   // off the top of the loop: on along the tangent, climbing away
        const k = e.t - s.t1 - (1.5 * Math.PI) / w;
        e.x -= side * sp * dt; e.z -= (1 + k * 9) * dt;
      }
    }
  };
}

// --------------------------------------------------------------------------------
// laser satellite
// --------------------------------------------------------------------------------
// Drifts in from the side edge to its station (braking on its thrusters), then cycles: track the jet
// (faint beam), lock (the beam flares and freezes: the telegraph), fire a pulse of fast needles down
// the locked line, rest. After `cycles` pulses it drifts back out.
function laserAI(side, x1, zf = 0.2, cycles = 2) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData, T = ud.turret;
    if (!s.mode) {
      s.mode = 'in'; s.mt = 0; s.n = 0; s.fixedYaw = true; s.yaw = Math.PI;
      s.x0 = side * 12.5; s.x1 = x1; s.z1 = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 1); e.x = s.x0; e.z = s.z1 - 1.5;
      if (T) T.rotation.y = -side * 0.6;
      if (ud.setCharge) { ud.setCharge(0); ud.setFire(0); }
    }
    s.mt += dt;
    const fr = g.diff.fr;
    if (s.mode === 'in') {
      const k = ease(s.mt / 2.4);
      e.x = s.x0 + (s.x1 - s.x0) * k; e.z = s.z1 - 1.5 * (1 - k);
      if (s.mt < 1.8 && Math.random() < 0.5) ionPuff(g, e.x + side * 0.7, e.z, side, 0, 0.4);
      g.aimTurret(e, T, dt, 2.0);
      if (s.mt > 2.0) { s.mode = 'aim'; s.mt = 0; }   // (the last 0.5 % of the glide is not worth waiting for)
    } else if (s.mode === 'aim') {             // track the jet, the beam faint and growing (shorter on the first
      const aimT = s.n ? 1.0 : 0.65;           // pulse: the satellite is under fire from the moment it drifts in)
      g.aimTurret(e, T, dt, 1.5);
      ud.setCharge(0.22 + 0.33 * Math.min(1, s.mt / aimT));
      if (s.mt > aimT) { s.mode = 'lock'; s.mt = 0; g.audio.play('lock', { vol: 0.35, pitch: 2 }); }
    } else if (s.mode === 'lock') {            // the telegraph: the line is fixed now
      ud.setCharge(0.6 + 0.4 * Math.min(1, s.mt / 0.6));
      if (s.mt > 0.7) {
        s.mode = 'fire'; s.mt = 0; s.st = 0; ud.setCharge(0);
        g.audio.play('missile', { vol: 0.5, pitch: 5 });
        const m = g.muzzlePos(T); greenFlash(g, m.x, m.z, 1);
      }
    } else if (s.mode === 'fire') {            // the pulse: fast needles down the locked line
      ud.setFire(Math.max(0, 1 - s.mt / 0.7));
      s.st -= dt;
      const ang = T.rotation.y + e.yaw - Math.PI;
      while (s.st <= 0 && s.mt < 0.55) {
        s.st += 0.05;
        if (g.canFire(e)) { const m = g.muzzlePos(T); g.shoot(m.x, m.z, ang, 13, g.BK.NEEDLE); }
      }
      if (s.mt > 0.8) { s.n++; ud.setFire(0); s.mode = s.n >= cycles ? 'out' : 'rest'; s.mt = 0; }
    } else if (s.mode === 'rest') {
      g.aimTurret(e, T, dt, 1.5);
      if (s.mt > 1.1 / fr) { s.mode = 'aim'; s.mt = 0; }
    } else {                                   // drift back out the way it came
      e.x += side * (0.5 + s.mt * 5) * dt; e.z -= (0.3 + s.mt * 1.5) * dt;
      if (Math.random() < 0.5) ionPuff(g, e.x - side * 0.7, e.z, -side, 0, 0.4);
    }
    if (e.hp < e.maxHp * 0.5 && Math.random() < 0.2) g.fx.smokePuff(e.x + rnd(-0.6, 0.6), 0.2, e.z + rnd(-0.4, 0.4), 0.4, 0.7);
  };
}

// --------------------------------------------------------------------------------
// space frigate
// --------------------------------------------------------------------------------
// Crosses the upper screen broadside-on (dir = +1: left → right, starboard to the jet). With `hold` it
// brakes to hold station near the centre for that long, then burns on. Every few seconds its three
// sponsons ripple three rows of orbs, all on one heading swung toward the jet's side of the screen when
// the volley starts (a slanted lattice to slip through or go round), and the bow sponson fires an aimed
// 3-needle fan in between.
function frigateAI(dir, zf = 0.22, hold = 0) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (s.z0 === undefined) {
      s.fixedYaw = true; s.yaw = -dir * Math.PI / 2; s.z0 = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 1.6);
      e.x = -dir * 15; e.z = s.z0; s.vx = hold ? 7.5 : 3.0; s.port = dir > 0 ? 0 : 3; s.ph = 'in'; s.pt = 0; s.rows = 0;
    }
    s.pt += dt;
    if (hold) {
      const stopX = -dir * 1.2;
      if (s.ph === 'in') { s.vx = Math.max(0.35, Math.min(7.5, Math.abs(stopX - e.x) * 1.1)); if (Math.abs(stopX - e.x) < 0.3) { s.ph = 'hold'; s.pt = 0; } }
      else if (s.ph === 'hold') { s.vx = 0.3; if (s.pt > hold) { s.ph = 'out'; s.pt = 0; } }
      else s.vx = Math.min(8, 0.3 + s.pt * 3.5);
    }
    e.x += dir * s.vx * dt;
    e.z = s.z0 + Math.sin(e.t * 0.7) * 0.25;
    if (ud.setThrust) ud.setThrust(s.ph === 'hold' ? 0.25 : 0.9);
    if (Math.random() < 0.5) ionPuff(g, e.x - dir * 2.7, e.z + rnd(-0.35, 0.35), -dir, 0, 0.45);
    const on = Math.abs(e.x) < 7.5;
    if (on && fireTimerS(s, 'bt', dt, g, 2.9, 1.2) && g.canFire(e)) { s.rows = 3; s.rt = 0; s.la = clamp(g.aim(e.x, e.z), -0.45, 0.45); }
    if (s.rows > 0) {
      s.rt -= dt;
      if (s.rt <= 0) {
        s.rt = 0.3; s.rows--;
        for (let k = 0; k < 3; k++) { const m = g.muzzlePos(e.mesh, s.port + k); g.shoot(m.x, m.z, s.la, 5.6); }
      }
    }
    if (on && fireTimerS(s, 'nt', dt, g, 2.9, 2.6) && g.canFire(e)) {
      const m = g.muzzlePos(e.mesh, s.port + (dir > 0 ? 0 : 2)), mx = m.x, mz = m.z;
      g.fan(mx, mz, g.aim(mx, mz), 3, 0.24, 9, g.BK.NEEDLE);
    }
    if (e.hp < e.maxHp * 0.5 && Math.random() < 0.3) g.fx.smokePuff(e.x + rnd(-2, 2), 0.2, e.z + rnd(-0.4, 0.4), 0.5, 0.9);
  };
}
/** like stage.js fireTimer, on a named slot of s (a unit with two independent guns) */
function fireTimerS(s, key, dt, g, interval, first) {
  if (s[key] === undefined) s[key] = first / g.diff.fr;
  s[key] -= dt;
  if (s[key] <= 0) { s[key] += interval / g.diff.fr; return true; }
  return false;
}

// --------------------------------------------------------------------------------
// mine pod
// --------------------------------------------------------------------------------
// Drifts down (vz) with a slow sideways drift; arms when the jet comes within ~5.5, when it sinks past
// armZ of the screen, or MINE_FUSE s after it appears (a field left alone goes off): 0.75 s of red
// blinking, then it bursts into a ring of orbs (no score — shoot it first; the armoured pod takes a
// moment). Too close to the jet, the burst holds its fire (shoot() never fires point-blank).
const MINE_FUSE = 1.4;
function mineAI(x0, vz = 2.3, drift = 0, armZ = 0.58) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData, p = g.player;
    if (s.arm === undefined) { s.arm = -1; e.x = x0; e.z = v.zTop - 1.5; s.fixedYaw = true; s.yaw = 0; if (ud.setArm) ud.setArm(0); }
    if (s.arm < 0) {
      e.z += vz * dt; e.x += drift * dt;
      const dx = p.x - e.x, dz = p.z - e.z;
      if ((p.alive && dx * dx + dz * dz < 30) || e.t > MINE_FUSE || e.z > v.zTop + (v.zBottom - v.zTop) * armZ) { s.arm = 0; g.audio.play('lock', { vol: 0.25, pitch: 9 }); }
    } else {
      s.arm += dt;
      e.z += vz * 0.35 * dt;
      if (ud.setArm) ud.setArm(Math.min(1, s.arm / 0.7));
      if (s.arm > 0.75) {
        if (g.canFire(e)) g.ring(e.x, e.z, 10, 4.4, rnd(0, TAU));
        g.fx.explosion(e.x, 0.1, e.z, 0.9, { debris: 4, color: ud.debrisColor });
        g.audio.play('explodeS', { pan: clamp(e.x / 10, -1, 1) });
        e.alive = false;
      }
    }
  };
}

// --------------------------------------------------------------------------------
// mid-boss: HYDRA, the three-headed weapons platform
// --------------------------------------------------------------------------------
const HY_ROW = 8.5;     // station below the top edge
const HY_OPEN = 16;     // fight time at which the core opens even with heads left
const HY_FIGHT = 46;    // fight time at which it gives up and climbs away
const NECK_REACH = 0.34; // how far a neck swings off its rest angle to track the jet (the heads never bunch up)
const HY_BASE = [[-1.5, -1.45], [0, -1.9], [1.5, -1.45]];   // neck bases (model x, z)
// the neck's yaw that points its head at the jet (model frame: the platform faces the jet, yaw π)
function neckAim(g, e, k) {
  const bx = e.x - HY_BASE[k][0], bz = e.z - HY_BASE[k][1];      // yaw π: model (x, z) → (−x, −z)
  return wrapA(Math.atan2(-(g.player.x - bx), -(g.player.z - bz)) - e.yaw);
}
function hydraAI() {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData, N = ud.necks;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.life = 0; s.open = 0; s.a = 0; s.b = 0; s.fixedYaw = true; s.yaw = Math.PI;
      e.x = 0; e.z = v.zTop - 9; s.tz = Math.max(v.zTop + HY_ROW, zAtRow(v, HUD_ROW, 0.6) + 3.2); e.invuln = true; e.armored = true;
      s.heads = [g.partByKey(e, 'headL'), g.partByKey(e, 'headC'), g.partByKey(e, 'headR')]; s.core = g.partByKey(e, 'core');
      s.hs = [{ t: 1.2, st: 'idle', mt: 0, burst: 0, bt: 0 }, { t: 3.0, st: 'idle', mt: 0, burst: 0, bt: 0 }, { t: 2.4, st: 'idle', mt: 0, burst: 0, bt: 0 }];
      s.rear = [0, 0, 0]; s.snap = 0;
      if (ud.reset) ud.reset();
    }
    s.life += dt;
    // engine wash from the stern nozzles (up-screen)
    if (Math.random() < 0.5) ionPuff(g, e.x + (Math.random() < 0.5 ? -0.42 : 0.42), e.z - 3.3, 0, -1, 0.5);
    if (e.dying) { hydraDeath(e, dt, g); return; }
    if (s.mode === 'enter') {
      e.z = (v.zTop - 9) + (s.tz - (v.zTop - 9)) * ease(e.t / 3.2);
      if (e.t > 3.2) { s.mode = 'fight'; s.ft = 0; e.invuln = false; }
    } else if (s.mode === 'fight') {
      s.ft += dt;
      e.x = Math.sin(s.ft * 0.41) * 2.4;
      e.z = s.tz + Math.sin(s.ft * 0.73) * 0.45;
      if (s.ft > HY_FIGHT) { s.mode = 'retreat'; s.rt = 0; }
    } else {                                  // retreat: climb away, the stage goes on
      s.rt += dt;
      e.z -= (2 + s.rt * 10) * dt;
      if (e.z < v.zTop - 11) { e.alive = false; g.midbossDone = true; }
    }
    const H = s.heads, core = s.core;
    let alive = 0;
    for (let k = 0; k < 3; k++) if (live(H[k])) alive++;
    // the necks: swing toward the jet around their rest angle, rear back to strike; dead ones hang limp
    for (let k = 0; k < 3; k++) {
      const n = N[k], hs = s.hs[k], rest = ud.neckYaw[k];
      if (!live(H[k])) { n.rotation.x += (-0.42 - n.rotation.x) * Math.min(1, dt * 1.5); n.rotation.y += (rest * 1.4 - n.rotation.y) * Math.min(1, dt); continue; }
      const sway = Math.sin(s.life * 1.3 + k * 2.1) * 0.12;
      const want = hs.st === 'fire' || hs.st === 'breath' ? hs.lock : clamp(neckAim(g, e, k), rest - NECK_REACH, rest + NECK_REACH) + (hs.st === 'idle' ? sway : 0);
      n.rotation.y += clamp(wrapA(want - n.rotation.y), -2.2 * dt, 2.2 * dt);
      const rw = hs.st === 'rear' ? 0.34 : hs.st === 'fire' ? -0.1 : hs.st === 'breath' ? 0.12 : Math.sin(s.life * 1.7 + k) * 0.05;
      n.rotation.x += (rw - n.rotation.x) * Math.min(1, dt * (hs.st === 'fire' ? 16 : 5));
    }
    // the core opens once two heads are gone (or it is tired of waiting)
    const wantOpen = s.mode === 'fight' && (alive <= 1 || s.ft > HY_OPEN) ? 1 : 0;
    s.open += (wantOpen - s.open) * Math.min(1, dt * 2.2);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;
    if (!s.opened && s.open > 0.5) { s.opened = true; g.audio.play('warning', { vol: 0.4 }); g.shake.add(0.25); }
    if (s.mode !== 'fight' || !g.canFire(e)) { for (let k = 0; k < 3; k++) if (H[k]) H[k].obj.userData.setCharge(0); return; }
    const fr = g.diff.fr, rage = 1 + (3 - alive) * 0.22;
    // outer heads: rear back (jaws lit), snap forward and fire a needle burst down the locked line, then a
    // short fan; they take turns
    for (let q = 0; q < 2; q++) {
      const k = q * 2, pt = live(H[k]), hs = s.hs[k];
      if (!pt) continue;
      hs.mt += dt;
      if (hs.st === 'idle') {
        hs.t -= dt * rage;
        if (hs.t <= 0) { hs.st = 'rear'; hs.mt = 0; hs.t = 3.4 / fr; }
      } else if (hs.st === 'rear') {
        pt.obj.userData.setCharge(Math.min(1, hs.mt / 0.55));
        if (hs.mt > 0.6) { hs.st = 'fire'; hs.mt = 0; hs.lock = clamp(neckAim(g, e, k), ud.neckYaw[k] - NECK_REACH, ud.neckYaw[k] + NECK_REACH); hs.burst = 5; hs.bt = 0.08; pt.obj.userData.setCharge(0); g.audio.play('missile', { vol: 0.35, pitch: 3 }); }
      } else if (hs.st === 'fire') {
        hs.bt -= dt;
        if (hs.bt <= 0 && hs.burst > 0) {
          hs.bt = 0.075; hs.burst--;
          const ang = N[k].rotation.y + e.yaw - Math.PI;
          for (let q = 0; q < 2; q++) { const m = g.muzzlePos(pt.obj, q); g.shoot(m.x, m.z, ang, 10, g.BK.NEEDLE); }
          if (hs.burst === 0) { const m = g.muzzlePos(pt.obj); g.fan(m.x, m.z, g.aim(m.x, m.z), 3, 0.5, 6.4); }
        }
        if (hs.mt > 0.6) { hs.st = 'idle'; hs.mt = 0; }
      }
    }
    // centre head: charges (jaws lit, a low hum), then breathes a scattered cone of orbs at the jet
    {
      const pt = live(H[1]), hs = s.hs[1];
      if (pt) {
        hs.mt += dt;
        if (hs.st === 'idle') {
          hs.t -= dt * rage;
          if (hs.t <= 0) { hs.st = 'rear'; hs.mt = 0; hs.t = 5.4 / fr; g.audio.play('lock', { vol: 0.35, pitch: -4 }); }
        } else if (hs.st === 'rear') {
          pt.obj.userData.setCharge(Math.min(1, hs.mt / 0.9) * (0.8 + Math.sin(hs.mt * 30) * 0.2));
          if (hs.mt > 0.95) { hs.st = 'breath'; hs.mt = 0; hs.bt = 0; hs.lock = clamp(neckAim(g, e, 1), -NECK_REACH, NECK_REACH); }
        } else if (hs.st === 'breath') {
          pt.obj.userData.setCharge(0.6);
          hs.bt -= dt;
          while (hs.bt <= 0 && hs.mt < 0.95) {
            hs.bt += 0.065;
            const m = g.muzzlePos(pt.obj, (Math.random() * 2) | 0), ang = hs.lock + e.yaw - Math.PI + rnd(-0.36, 0.36);
            g.shoot(m.x, m.z, ang, rnd(4.0, 6.8), Math.random() < 0.3 ? g.BK.BIG : g.BK.ORB);
          }
          if (hs.mt > 1.1) { hs.st = 'idle'; hs.mt = 0; pt.obj.userData.setCharge(0); }
        }
      }
    }
    // open core: rings with alternating offsets, and a two-arm spiral in pulses; low on HP, aimed big fans
    if (core && s.open > 0.85) {
      const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
      s.rgT = (s.rgT ?? 0.6) - dt;
      if (s.rgT <= 0) { s.rgT = 2.4 / fr; s.b += 0.5; g.ring(cx, cz, 14, 4.2, s.b * (TAU / 28)); greenFlash(g, cx, cz, 0.8); }
      s.cy = (s.cy || 0) + dt;
      s.st = (s.st || 0) - dt;
      if ((s.cy % 4.0) < 2.4 && s.st <= 0) { s.st = 0.13 / fr; s.a += 0.27; g.shoot(cx, cz, s.a, 5.0); g.shoot(cx, cz, s.a + Math.PI, 5.0); }
      if (core.hp < core.maxHp * 0.5) {
        s.fnT = (s.fnT ?? 1.5) - dt;
        if (s.fnT <= 0) { s.fnT = 3.2 / fr; g.fan(cx, cz, g.aim(cx, cz), 5, 0.8, 6.2, g.BK.BIG); }
      }
    }
  };
}
// Death: the necks go limp, blasts run over the carapace and up the necks, a big blast, the items.
function hydraDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData, N = ud.necks;
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT;
  e.z -= 0.6 * dt;
  s.pitch = Math.min(0.2, t * 0.12);
  for (let k = 0; k < 3; k++) { N[k].rotation.x += (-0.5 - N[k].rotation.x) * Math.min(1, dt * 2); s.heads[k].obj.userData.setCharge(0); }
  if (ud.setFlash && t < 1.6) ud.setFlash(Math.max(0, Math.sin(t * 25)) * 0.6);
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0) {
    s.boomT = 0.1;
    const k = (Math.random() * 3) | 0, f = Math.random();
    const x = e.x - HY_BASE[k][0] * (1 - f) + (k - 1) * 1.3 * f, z = e.z - HY_BASE[k][1] + f * 2.6;   // along a neck
    g.fx.explosion(Math.random() < 0.5 ? x : e.x + rnd(-2.4, 2.4), 0.3, Math.random() < 0.5 ? z : e.z + rnd(-2.6, 2), rnd(1.0, 1.7), { debris: 4, color: ud.debrisColor });
    g.audio.play('explodeM', { vol: 0.7, pan: clamp(e.x / 10, -1, 1) });
    g.shake.add(0.12);
  }
  if (t > 1.8) {
    g.fx.explosion(e.x, 0.4, e.z, 4, { debris: 30, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 18, [1.2, 2.6, 1.6, 1], 0.8);
    g.fx.shockwave(e.x, 0.1, e.z, 11, [2.4, 2.2, 1.8, 1], 0.5);
    g.shake.add(0.7); g.ui.flash(0.5);
    g.audio.play('explodeL');
    g.addScore(e.def.score);
    g.popupAt(e.x, e.z, e.def.score.toLocaleString('en-US'), 'big');
    g.stats.killed++;
    g.dropItem('P', e.x - 1, e.z, { color: g.player.main });
    g.dropItem('S', e.x + 1, e.z, { sub: g.player.sub || 'H' });
    g.dropItem('B', e.x, e.z - 1);
    for (let i = 0; i < 6; i++) g.dropItem('medal', e.x + rnd(-2.5, 2.5), e.z + rnd(-1.5, 1.5));
    e.alive = false;
    g.midbossDone = true;
  }
}
function spawnHydra(g) {
  const e = g.spawn('hydra', { x: 0, z: g.view.zTop - 9, ai: hydraAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key === 'headL' || pt.key === 'headR') g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    else if (pt.key === 'headC') g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' });
  };
  return e;
}

// --------------------------------------------------------------------------------
// boss: AEGIS, the orbital defence platform
// --------------------------------------------------------------------------------
// p1: the shield dome is up over the hub; the ring turns, its three gun turrets fire aimed twin-needle
//     bursts and its three shield generators take turns pulsing slow rings of orbs; the hub fires aimed
//     big fans → p2 once the generators are gone (or after 44 s; the dome collapses either way): the
//     railgun swings round out of its cradle — it tracks the jet, locks (a wide red lane: the telegraph)
//     and fires a rail of big orbs flanked by needles down the lane; between shots the capacitor banks
//     spray counter-rotating spirals → p3 once the railgun and both banks are gone (or after 42 s): the
//     reactor opens — a three-arm spiral that reverses, then woven rings, a breather with an aimed fan;
//     low on HP it adds homing mines.
// Parts left alive keep firing in the later phases at a reduced rate.
const AE_TURRET_HALF = [0, 0, Math.PI];        // which ring half carries turret k (its frame's extra yaw)
const AE_GEN_HALF = [0, Math.PI, Math.PI];
const AE_GUN_Z = 1.3;                          // railgun pivot: model z −1.3 → world e.z + 1.3 (yaw π)
function aegisAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.fixedYaw = true; s.yaw = Math.PI; e.invuln = true; e.armored = true;
      s.open = 0; s.a = 0; s.b = 0; s.c = 0; s.sway = 0; s.pt = 0; s.ph = 0; s.spin = 0; s.spinV = 0.9; s.gk = 0; s.gun = 'stow'; s.gunT = 0;
      // station: the ring's far side (e.z − 6) stays below the boss bar
      s.z0 = v.zTop - 17; s.baseZ = Math.max(v.zTop + 11.5, zAtRow(v, BAR_ROW, 0.3) + 6.3); e.x = 0; e.z = s.z0;
      s.tur = [0, 1, 2].map((i) => g.partByKey(e, 'turret' + i));
      s.gen = [0, 1, 2].map((i) => g.partByKey(e, 'gen' + i));
      s.can = g.partByKey(e, 'cannon'); s.capL = g.partByKey(e, 'capL'); s.capR = g.partByKey(e, 'capR');
      s.core = g.partByKey(e, 'core');
      s.sealed = [s.can, s.capL, s.capR];
      for (const pt of s.sealed) if (pt) pt.dead = true;          // under the shield until phase 2
      e.def = AEGIS_DOMED;
      if (ud.reset) ud.reset();
      if (ud.setShield) ud.setShield(1);
      s.shield = 1;
    }
    const core = s.core;
    // HP bar: every part (sealed ones count at full health)
    let hp = 0, max = 0;
    for (let i = 0; i < e.parts.length; i++) { const pt = e.parts[i]; max += pt.maxHp; hp += Math.max(0, pt.hp); }
    g.ui.setBossHP(hp / max);
    if (e.dying) { aegisDeath(e, dt, g); return; }

    // the ring turns (faster as the fight goes on)
    const spinW = s.mode === 'p1' ? 0.24 : s.mode === 'p2' ? 0.32 : s.mode === 'p3' ? 0.5 : 0.9;
    s.spinV += (spinW - s.spinV) * Math.min(1, dt * 0.8);
    s.spin += s.spinV * dt;
    if (ud.setSpin) ud.setSpin(s.spin);
    if (s.mode === 'enter') {
      const k = ease(e.t / 5.5);
      e.z = s.z0 + (s.baseZ - s.z0) * k;
      if (Math.random() < 0.8) ionPuff(g, e.x + (Math.random() < 0.5 ? -0.58 : 0.58), e.z - 3.0, 0, -1, 0.8);
      if (e.t > 5.5) { s.mode = 'p1'; s.ph = 0; e.invuln = false; }
      return;
    }
    s.pt += dt; s.ph += dt;
    // movement: a slow drift that widens as it loses its armament
    const want = s.mode === 'p1' ? 1.2 : s.mode === 'p2' ? 1.9 : 2.5;
    s.sway += (want - s.sway) * Math.min(1, dt * 0.4);
    e.x = Math.sin(s.pt * 0.27) * s.sway;
    e.z = s.baseZ + Math.sin(s.pt * 0.41) * 0.5;
    if (Math.random() < 0.5) ionPuff(g, e.x + (Math.random() < 0.5 ? -0.58 : 0.58), e.z - 3.0, 0, -1, 0.7);

    // shield: its strength follows the living generators (phase 1 only)
    let gens = 0;
    for (let i = 0; i < 3; i++) if (live(s.gen[i])) gens++;
    const shieldWant = s.mode === 'p1' && gens > 0 ? 0.35 + 0.65 * (gens / 3) : 0;
    if (s.shield > 0 && shieldWant === 0) { shieldBreak(e, g); e.def = ENEMY.aegis; }
    s.shield += (shieldWant - s.shield) * Math.min(1, dt * 3);
    if (shieldWant === 0) s.shield = 0;
    if (ud.setShield) ud.setShield(s.shield);

    // phase changes
    if (s.mode === 'p1' && (gens === 0 || s.ph > 44)) {
      s.mode = 'p2'; s.ph = 0; s.gun = 'deploy'; s.gunT = 0;
      g.audio.play('warning', { vol: 0.5 }); g.shake.add(0.35);
    }
    const can = live(s.can), cL = live(s.capL), cR = live(s.capR);
    if (s.mode === 'p2' && s.gun !== 'deploy' && ((!can && !cL && !cR) || s.ph > 42)) {
      s.mode = 'p3'; s.ph = 0; s.cyc = 0;
      g.shake.add(0.6); g.ui.flash(0.35); g.audio.play('explodeL'); g.audio.play('warning', { vol: 0.5 });
    }
    // core shutters
    s.open += ((s.mode === 'p3' ? 1 : 0) - s.open) * Math.min(1, dt * 1.6);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;

    // ring turrets track the jet (aiming is free; firing is gated below)
    for (let i = 0; i < 3; i++) { const t = live(s.tur[i]); if (t) aimRingPart(g, e, t, s.spin + AE_TURRET_HALF[i], dt, 2.4); }
    const co = s.can && s.can.obj, cu = co && co.userData;
    const fr = g.diff.fr, hard = g.diff.level >= 1;
    const late = s.mode === 'p1' ? 1 : s.mode === 'p2' ? 0.7 : 0.5;     // leftover ring guns slow down
    // the railgun: swing round out of the cradle, then track / lock / fire / cool
    if (!can && s.gun !== 'stow' && s.gun !== 'deploy') s.gun = 'dead';
    if (s.gun === 'deploy' && co) {
      s.gunT += dt;
      const aim = railAim(g, e);
      co.rotation.y += clamp(wrapA(aim - co.rotation.y), -2.0 * dt, 2.0 * dt);
      if (Math.random() < 0.4) g.fx.smokePuff(e.x + rnd(-1, 1), 0.8, e.z + AE_GUN_Z + rnd(-1, 1), 0.5, 0.6);
      if (s.gunT > 1.8) {
        s.gun = 'track'; s.gunT = 0;
        for (const pt of s.sealed) if (pt && pt.dead && !pt.obj.userData.destroyed) pt.dead = false;
        g.audio.play('lock', { vol: 0.5, pitch: -6 }); g.shake.add(0.2);
      }
    }
    if (!g.canFire(e)) {
      if (cu) { cu.setBeam(0); cu.setCharge(0); }
      if (s.gun === 'lock' || s.gun === 'fire') { s.gun = 'cool'; s.gunT = 0; }
      return;
    }
    if (can && s.gun !== 'deploy' && s.gun !== 'stow') {
      s.gunT += dt;
      const caps = (cL ? 1 : 0) + (cR ? 1 : 0);
      if (s.gun === 'track') {
        co.rotation.y += clamp(wrapA(railAim(g, e) - co.rotation.y), -0.9 * dt, 0.9 * dt);
        cu.setBeam(0.28); cu.setCharge(0.15);
        if (s.gunT > 1.5) { s.gun = 'lock'; s.gunT = 0; g.audio.play('lock', { vol: 0.55, pitch: -3 }); }
      } else if (s.gun === 'lock') {             // the telegraph: the lane is fixed now, the rails charge
        const need = 1.0 + (2 - caps) * 0.35;
        const k = Math.min(1, s.gunT / need);
        cu.setBeam(0.5 + 0.5 * k * (0.85 + Math.sin(s.gunT * 40) * 0.15)); cu.setCharge(0.3 + 0.7 * k);
        if (s.gunT > need) {
          s.gun = 'fire'; s.gunT = 0; s.rst = 0; s.nst = 0; cu.setBeam(0);
          g.audio.play('explodeL', { vol: 0.8 }); g.audio.play('missile', { vol: 0.9, pitch: -8 });
          g.shake.add(0.45); g.ui.flash(0.12);
          const m = g.muzzlePos(co); greenFlash(g, m.x, m.z, 2.2);
        }
      } else if (s.gun === 'fire') {             // the rail: big orbs down the lane, needles along its edges
        cu.setCharge(Math.max(0, 1 - s.gunT / 0.6));
        const ang = co.rotation.y + e.yaw - Math.PI, ux = Math.sin(ang), uz = Math.cos(ang), px = uz, pz = -ux;
        // the muzzle points at the jet and sits ~5.7 in front of the hub, so a jet held close under the boss
        // would be inside shoot()'s point-blank radius of it and the whole rail would fizzle. The rail starts
        // up the barrel instead: never less than 4.3 short of the jet, measured down the lane (so a jet that
        // has stepped out of the lane is still clear of the flanking needles), on the same telegraphed line.
        const m = g.muzzlePos(co), along = (g.player.x - m.x) * ux + (g.player.z - m.z) * uz;
        const back = clamp(4.3 - along, 0, 4.4), rx = m.x - ux * back, rz = m.z - uz * back;
        s.rst -= dt; s.nst -= dt;
        while (s.rst <= 0 && s.gunT < 0.5) { s.rst += 0.042; g.shoot(rx, rz, ang, 15, g.BK.BIG); }
        while (s.nst <= 0 && s.gunT < 0.5) {
          s.nst += 0.09;
          g.shoot(rx + px * 0.95, rz + pz * 0.95, ang, 13, g.BK.NEEDLE); g.shoot(rx - px * 0.95, rz - pz * 0.95, ang, 13, g.BK.NEEDLE);
        }
        if (s.gunT > 0.65) { s.gun = 'cool'; s.gunT = 0; }
      } else if (s.gun === 'cool') {
        cu.setBeam(0); cu.setCharge(0);
        if (s.gunT > 2.1 / (fr * (s.mode === 'p3' ? 0.5 : 1))) { s.gun = 'track'; s.gunT = 0; }
      }
    } else if (cu && s.gun !== 'deploy') { cu.setBeam(0); cu.setCharge(0); }
    // capacitor banks: counter-rotating two-arm spirals while the railgun isn't locking or firing
    if (s.mode !== 'p1' && s.gun !== 'lock' && s.gun !== 'fire' && s.gun !== 'deploy' && (cL || cR)) {
      s.cst = (s.cst || 0) - dt;
      if (s.cst <= 0) {
        s.cst = (s.mode === 'p2' ? 0.17 : 0.24) / fr; s.c += 0.23;
        if (cL) { const m = g.muzzlePos(cL.obj); g.shoot(m.x, m.z, s.c, 4.6); g.shoot(m.x, m.z, s.c + Math.PI, 4.6); }
        if (cR) { const m = g.muzzlePos(cR.obj); g.shoot(m.x, m.z, -s.c, 4.6); g.shoot(m.x, m.z, -s.c + Math.PI, 4.6); }
      }
    }
    // ring turrets: aimed 3-round twin-needle bursts, staggered
    for (let i = 0; i < 3; i++) {
      const t = live(s.tur[i]);
      if (!t) continue;
      t.fireT -= dt * late;
      if (t.fireT <= 0) { t.fireT = (2.5 + i * 0.2) / fr; t.burst = 3; t.bt = 0; }
      if (t.burst > 0) {
        t.bt -= dt;
        if (t.bt <= 0) {
          t.bt = 0.1; t.burst--;
          const ang = t.obj.rotation.y + s.spin + AE_TURRET_HALF[i] + e.yaw - Math.PI;
          for (let q = 0; q < 2; q++) { const m = g.muzzlePos(t.obj, q); g.shoot(m.x, m.z, ang, 9.0, g.BK.NEEDLE); }
        }
      }
    }
    // shield generators: in turn, a slow ring of orbs from the crystal (the dome ripples)
    if (gens) {
      s.gpT = (s.gpT ?? 1.6) - dt * late;
      if (s.gpT <= 0) {
        s.gpT = 2.2 / fr;
        for (let q = 0; q < 3; q++) {
          s.gk = (s.gk + 1) % 3;
          const gp = live(s.gen[s.gk]);
          if (!gp) continue;
          const m = g.muzzlePos(gp.obj), mx = m.x, mz = m.z;
          s.b += 0.37;
          g.ring(mx, mz, hard ? 12 : 10, 3.8, s.b);
          greenFlash(g, mx, mz, 1);
          if (ud.pulseShield) ud.pulseShield(0.8);
          break;
        }
      }
    }
    if (s.mode === 'p1') {
      // hub: aimed big fans now and then
      s.hfT = (s.hfT ?? 3.2) - dt;
      if (s.hfT <= 0) { s.hfT = 4.6 / fr; const m = g.muzzlePos(e.mesh); g.fan(m.x, m.z, g.aim(m.x, m.z), 5, 0.8, 6.2, g.BK.BIG); }
      return;
    }
    if (s.mode !== 'p3' || !core || s.open < 0.85) return;
    // open reactor, in 9 s cycles: a three-arm spiral that reverses every 1.4 s, woven rings (each a half
    // step off the last), then a breather with an aimed big fan; below 40 % homing mines join in
    const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
    s.cyc += dt;
    const cyc = s.cyc % 9;
    const rage = core.hp < core.maxHp * 0.4;
    s.ct = (s.ct || 0) - dt;
    if (cyc < 4.2) {
      if (s.ct <= 0) {
        s.ct = (rage ? 0.13 : 0.15) / fr;
        const dir = Math.floor(s.cyc / 1.4) & 1 ? -1 : 1;
        s.a += 0.24 * dir;
        for (let k = 0; k < 3; k++) g.shoot(cx, cz, s.a + (k * TAU) / 3, 4.8);
      }
    } else if (cyc < 7.6) {
      if (s.ct <= 0) {
        s.ct = (rage ? 0.8 : 0.95) / fr;
        const n = hard ? 20 : rage ? 18 : 16;
        s.c = (s.c || 0) + 0.5;
        g.ring(cx, cz, n, 4.1, s.c * (TAU / n) + s.cyc * 0.05);
      }
    } else if (!s.fanned) { s.fanned = true; g.fan(cx, cz, g.aim(cx, cz), hard ? 7 : 5, hard ? 0.95 : 0.75, 6.6, g.BK.BIG); g.audio.play('lock', { vol: 0.4 }); }
    if (cyc < 7.6) s.fanned = false;
    if (rage) {
      s.mnT = (s.mnT ?? 1.5) - dt;
      if (s.mnT <= 0) {
        s.mnT = 3.8 / fr;
        for (const sx of [-1.8, 1.8]) {
          const i = g.shoot(cx + sx, cz, g.aim(cx + sx, cz) + sx * 0.25, 2.2, g.BK.MINE);
          if (i >= 0) { g.eb.home[i] = 1.1; g.eb.az[i] = 0.3; }
        }
      }
    }
  };
}
// the railgun's yaw that points it at the jet (its pivot: world (e.x, e.z + AE_GUN_Z))
function railAim(g, e) {
  return wrapA(Math.atan2(-(g.player.x - e.x), -(g.player.z - (e.z + AE_GUN_Z))) - e.yaw);
}
// turn a ring-mounted part toward the jet: its frame yaws with the unit, the ring and its half (frameYaw)
function aimRingPart(g, e, pt, frameYaw, dt, rate) {
  const obj = pt.obj;
  const want = Math.atan2(-(g.player.x - pt.x), -(g.player.z - pt.z)) - e.yaw - frameYaw;
  obj.rotation.y += clamp(wrapA(want - obj.rotation.y), -rate * dt, rate * dt);
}
// the dome collapses: a burst of green shards and a shock ring over the hub
function shieldBreak(e, g) {
  const p = g.fx.p;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * TAU + rnd(-0.1, 0.1), r = 3.2, sp = rnd(5, 11), ca = Math.cos(a), sa = Math.sin(a);
    p.emit(e.x + ca * r, 0.6, e.z + sa * r, ca * sp, rnd(0, 3), sa * sp, rnd(0.35, 0.6), rnd(0.4, 0.7), 0.1, GRN_A, GRN_B, F.SHARD, 0, OPT_SHARD);
  }
  p.emit(e.x, 0.3, e.z, 0, 0, 0, 0.5, 3, 12, [0.6, 2.4, 1.4, 1], [0.1, 0.5, 0.3, 0], F.RING, 0, OPT_FLAT);
  g.audio.play('shield'); g.audio.play('explodeM', { vol: 0.6 });
  g.shake.add(0.3); g.ui.flash(0.2);
}
// Death: the guns still standing blow in turn while blasts run round the turning ring, the reactor goes
// critical (a white flash), the ring breaks in two and the halves drift apart, a final blast — then the
// wreck falls away toward the planet, shrinking, burning up in re-entry fire.
function aegisDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  if (!s.dieT) { const cu = s.can && s.can.obj.userData; if (cu) { cu.setBeam(0); cu.setCharge(0); } if (ud.setShield) ud.setShield(0); }
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT, y = s.y || 0;
  s.spinV += (1.6 - s.spinV) * Math.min(1, dt * 0.7);
  s.spin += s.spinV * dt;
  if (ud.setSpin) ud.setSpin(s.spin);
  if (ud.setFlash && t < 2.4) ud.setFlash(Math.max(0, Math.sin(t * 23)) * 0.35);
  // guns still standing blow one after another
  s.popT = (s.popT ?? 0.15) - dt;
  if (s.popT <= 0 && t < 2.0) {
    s.popT = 0.2;
    let pt = null;
    for (let i = 0; i < e.parts.length && !pt; i++) if (!e.parts[i].dead && !e.parts[i].core) pt = e.parts[i];
    if (pt) {
      pt.dead = true;
      if (pt.obj.userData.setDestroyed) pt.obj.userData.setDestroyed(true);
      g.fx.explosion(pt.x, 0.4, pt.z, Math.min(1.8, pt.big), { debris: 8, color: ud.debrisColor });
      g.audio.play('explodeL', { vol: 0.7 });
    }
  }
  // blasts running round the ring with it
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0 && t < 2.6) {
    s.boomT = 0.11;
    const a = s.spin * 1.7 + t * 5 + rnd(-0.3, 0.3), r = rnd(4.6, 6.0);
    const x = e.x - Math.cos(a) * r, z = e.z - Math.sin(a) * r;
    g.fx.explosion(x, 0.3 + y * 0.5, z, rnd(0.9, 1.5), { debris: 4, color: ud.debrisColor });
    g.audio.play('explodeM', { vol: 0.55, pan: clamp(x / 9, -1, 1) });
    g.shake.add(0.1);
  }
  // the reactor goes critical
  if (t > 1.0 && !s.crit) {
    s.crit = true;
    g.fx.explosion(e.x, 1.0, e.z - 0.25, 2.6, { debris: 12, color: ud.debrisColor });
    g.fx.p.emit(e.x, 1.2, e.z, 0, 0, 0, 0.3, 2, 9, HOT_A, HOT_B, F.GLOW, 0, OPT_FLAT);
    g.audio.play('explodeL'); g.shake.add(0.5); g.ui.flash(0.4);
  }
  if (ud.setBreak) ud.setBreak(clamp((t - 1.2) / 2.2, 0, 1));
  if (t > 1.2 && t < 3.4 && Math.random() < 0.5) {   // fire along the broken hub
    g.fx.p.emit(e.x + rnd(-2, 2), 0.6 + y, e.z + rnd(-2, 2), rnd(-0.6, 0.6), rnd(0.6, 1.6), rnd(-0.6, 0.6), rnd(0.4, 0.8), rnd(0.6, 1.0), rnd(1.6, 2.6),
      FIRE_A, FIRE_B, F.FIRE, 0, OPT_FIRE);
  }
  // it falls away toward the planet: sinking, pitching, shrinking with distance, burning up. The sink stops
  // short of GROUND_Y: the orbit's depth-only occluder there (world.js space kit) would swallow the wreck
  e.z += 0.5 * dt;
  s.pitch = Math.min(0.35, t * 0.09);
  s.y = -5.3 * smooth((t - 2.0) / 3.3);
  const sc = 1 - 0.6 * smooth((t - 2.3) / 3.0);
  e.mesh.scale.setScalar(sc);
  // re-entry fire off the leading edges of the two halves (not over the middle: the wreck stays readable)
  if (t > 2.3 && Math.random() < 0.7) {
    const a = s.spin + (Math.random() < 0.5 ? 0 : Math.PI) + rnd(-0.5, 0.5), r = 5.4 * sc;
    reentry(g, e.x - Math.cos(a) * r, (s.y || 0) + 0.6, e.z - Math.sin(a) * r, 0.9 * sc);
  }
  if (t > 2.4 && !s.final) {
    s.final = true;
    g.fx.explosion(e.x, 0.5, e.z, 3.8, { debris: 40, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 32, [1.4, 2.8, 1.8, 1], 1.0);
    g.fx.shockwave(e.x, 0.1, e.z, 19, [2.6, 2.4, 2.0, 1], 0.8);
    g.ui.flash(0.65); g.shake.add(1);
    g.audio.play('bossDown');
    g.haptic([80, 50, 200]);
    for (let i = 0; i < 18; i++) g.dropItem('medal', e.x + rnd(-5, 5), e.z + rnd(-3, 3));
  }
  if (t > 5.4) {
    e.alive = false;
    g.ui.boss(false);
  }
}
function spawnAegis(g) {
  const e = g.spawn('aegis', { x: 0, z: g.view.zTop - 17, ai: aegisAI() });
  e.onDeath = () => { e.s.dieT = 0; bossDefeated(g, e); };
  let gensDown = 0;
  e.onPartDestroyed = (en, pt) => {
    if (pt.key.startsWith('gen')) {
      gensDown++;
      if (gensDown === 2) g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' });
      else g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    } else if (pt.key === 'cannon') g.dropItem('B', pt.x, pt.z);
  };
  return e;
}

// --------------------------------------------------------------------------------
// spawn helpers for this stage's units (the stage-1 ones come from W)
// --------------------------------------------------------------------------------
const W4 = {
  // a ring of n drones over cx (dir: its spin)
  ring(g, cx = 0, n = 6, zf = 0.28, dir = 1, R = 2.2) { for (let k = 0; k < n; k++) g.spawn('s4_drone', { x: cx, z: -60, ai: ringAI(cx, n, k, zf, dir, R) }); },
  // jinkers dropping in over xs, `gap` s apart
  jink(g, xs, gap = 0.45, hops = 3, zf = 0.2) { xs.forEach((x, i) => g.later(i * gap, () => g.spawn('s4_drone', { x, z: -60, ai: jinkAI(x, hops, zf + (i % 2) * 0.05) }))); },
  // n drones in a line round a loop (side = +1: in on the left)
  loop(g, side, n = 5, gap = 0.34, zf = 0.3) { for (let i = 0; i < n; i++) g.later(i * gap, () => g.spawn('s4_drone', { x: -side * 8, z: -60, ai: loopAI(side, zf) })); },
  laser(g, side, x1, zf = 0.2, cycles = 2, drops) { return g.spawn('s4_laser', { x: side * 12.5, z: -60, ai: laserAI(side, x1, zf, cycles), drops }); },
  frigate(g, dir, zf = 0.22, drops, hold = 0) { return g.spawn('s4_frigate', { x: -dir * 15, z: -60, ai: frigateAI(dir, zf, hold), drops }); },
  mine(g, x, vz = 2.3, drift = 0, armZ = 0.58) { return g.spawn('s4_mine', { x, z: -60, ai: mineAI(x, vz, drift, armZ) }); },
  // a field of mines: [[x, delay], …]
  mines(g, list, vz = 2.3) { for (const [x, d] of list) g.later(d, () => W4.mine(g, x, vz, 0)); },
};
// stage 3's interceptors fly escort: pairs (a lead and a wingman outboard and behind) diving across
function escort(g, side, pairs = 1, gap = 1.0) {
  for (let k = 0; k < pairs; k++) {
    g.later(k * gap, () => {
      g.spawn('interceptor', { x: side * 8, z: -60, ai: escortAI(side, 0.52, 0, 0) });
      g.later(0.22, () => g.spawn('interceptor', { x: side * 8, z: -60, ai: escortAI(side, 0.57, 1.3, -1.1) }));
    });
  }
}
// a copy of stage 3's interceptor dive (stage3.js keeps its AIs private): dive in from a top corner, bottom out,
// cross and climb away; one aimed 2-round needle burst at the bottom
function escortAI(side, depth, ox, oz, dur = 2.8) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (!s.P) {
      const T = v.zTop, H = v.zBottom - v.zTop;
      s.P = [[side * (6.5 + ox), T - 2 + oz], [side * (4.2 + ox * 0.6), T + depth * H + oz], [-side * (2 - ox * 0.3), T + (depth + 0.04) * H + oz],
        [-side * (11 + ox), T + 0.12 * H + oz]];
    }
    const u = e.t / dur;
    if (u < 1) {
      e.x = bez(s.P[0][0], s.P[1][0], s.P[2][0], s.P[3][0], u);
      e.z = bez(s.P[0][1], s.P[1][1], s.P[2][1], s.P[3][1], u);
    } else { e.x += e.vx * dt; e.z += e.vz * dt; }
    if (!s.fired && u > 0.34) { s.fired = true; s.burst = 2; s.bt = 0; }
    if (s.burst > 0) {
      s.bt -= dt;
      if (s.bt <= 0) { s.bt = 0.11; s.burst--; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 10, g.BK.NEEDLE); }
    }
  };
}

// --------------------------------------------------------------------------------
// Stage 4 timeline (distance in stage units; ~7 units/s)
// --------------------------------------------------------------------------------
const TIMELINE = makeTimeline((at) => {
  // EARTH-LIT DAY SIDE ─────────────────────────────────
  at(22, (g) => W4.ring(g, 0, 6));
  at(40, (g) => W4.jink(g, [-5, -1.5, 2], 0.5));
  at(56, (g) => W.carrier(g, 0, ['P']));
  at(70, (g) => W4.loop(g, 1, 5));
  at(90, (g) => W4.laser(g, -1, -4.2, 0.2, 2));
  at(110, (g) => W4.mines(g, [[-3, 0], [3, 0.6], [-3, 1.6], [3, 2.2]]));
  at(128, (g) => { W4.ring(g, -3.2, 6, 0.26, 1); g.later(1.4, () => W4.ring(g, 3.2, 6, 0.3, -1)); });
  at(150, (g) => W4.frigate(g, 1, 0.22, ['S']));
  at(174, (g) => W4.jink(g, [5, 2, -1, -4], 0.4));
  at(194, (g) => { W4.loop(g, -1, 5); g.later(1.6, () => W4.loop(g, 1, 5)); });
  at(214, (g) => W.carrier(g, -2, ['P', 'B']));
  at(230, (g) => { W4.laser(g, -1, -5, 0.18, 2); W4.laser(g, 1, 5, 0.26, 2); });
  at(254, (g) => W4.mines(g, [[-6, 0], [-2, 0.4], [2, 0.8], [6, 1.2], [-4, 2.2], [0, 2.6], [4, 3.0]]));
  at(274, (g) => { W4.frigate(g, -1, 0.2, ['P'], 5); g.later(2.5, () => W4.jink(g, [-5, 5], 0.3, 2)); });
  at(304, (g) => W4.ring(g, 0, 8, 0.3, 1, 2.8));
  at(322, (g) => escort(g, 1, 2, 1.0));
  // (rest beat)
  at(340, (g) => W.carrier(g, 2, ['S']));
  at(354, (g) => { W4.laser(g, 1, 4.5, 0.2, 2); g.later(1.5, () => W4.loop(g, -1, 5)); });
  at(378, (g) => { W4.frigate(g, 1, 0.26, null); g.later(1.2, () => W4.mines(g, [[-5, 0], [5, 0.8], [0, 1.6]])); });
  at(402, (g) => { W4.ring(g, -3, 6, 0.24, -1); W4.ring(g, 3, 6, 0.32, 1); });
  // DEBRIS STORM / NIGHT SIDE ──────────────────────────
  at(424, (g) => W4.mines(g, [[-6.5, 0], [-2, 0.3], [3, 0.6], [6, 1.0], [-4, 1.5], [1, 1.9], [5, 2.4], [-1.5, 2.9]], 2.6));
  at(446, (g) => { W4.jink(g, [-6, -3, 0, 3, 6], 0.35); g.later(2.6, () => W4.mines(g, [[-5.5, 0], [5.5, 0.5]], 2.6)); });
  at(468, (g) => { W4.laser(g, -1, -4.5, 0.22, 2); g.later(1.5, () => W4.frigate(g, 1, 0.3, ['P'])); });
  at(494, (g) => { W4.loop(g, 1, 6, 0.3); g.later(1.2, () => W4.loop(g, -1, 6, 0.3)); g.later(2.2, () => W4.laser(g, 1, 3.5, 0.18, 1)); });
  at(516, (g) => { W.carrier(g, 0, ['P']); g.later(1.0, () => W4.ring(g, 0, 6, 0.22, -1)); });
  at(532, (g) => { W4.frigate(g, 1, 0.18, null); g.later(2.2, () => W4.frigate(g, -1, 0.32, ['B'])); g.later(3.6, () => W4.jink(g, [-4, 4], 0.3, 2, 0.24)); });
  at(556, (g) => { W4.ring(g, 0, 6, 0.26); g.later(1.4, () => W4.mines(g, [[-4, 0], [4, 0.5]])); });
  at(572, (g) => { W4.laser(g, 1, 5, 0.2, 1); W4.laser(g, -1, -5, 0.2, 1); });
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnHydra));
  at(626, (g) => W.carrier(g, -3, ['S']));
  at(642, (g) => { W4.jink(g, [-5, -2, 2, 5], 0.35); g.later(2.4, () => W4.loop(g, 1, 5)); g.later(3.4, () => W4.mines(g, [[-6, 0], [-2, 0.3], [2, 0.6], [6, 0.9]], 2.5)); });
  at(666, (g) => { W4.laser(g, -1, -5, 0.2, 3); W4.laser(g, 1, 5, 0.28, 3); g.later(2.4, () => W4.ring(g, 0, 6, 0.3, 1)); });
  at(692, (g) => { W4.mines(g, [[-5, 0], [-1.5, 0.4], [2, 0.8], [5.5, 1.2]]); g.later(1.8, () => W4.ring(g, 0, 6, 0.24, -1)); g.later(2.6, () => W4.frigate(g, -1, 0.34, null)); });
  at(714, (g) => { W4.frigate(g, 1, 0.22, ['B'], 6); g.later(3, () => escort(g, -1, 2, 1.0)); });
  at(744, (g) => { W4.jink(g, [-6, -2, 2, 6, 0], 0.3, 3, 0.18); g.later(2.0, () => W4.loop(g, -1, 5)); });
  at(762, (g) => { W4.laser(g, -1, -3.5, 0.18, 2); g.later(1.2, () => W4.laser(g, 1, 3.5, 0.24, 2)); g.later(2.6, () => W4.laser(g, -1, -6, 0.3, 1)); });
  at(786, (g) => W.carrier(g, 2, ['P']));
  // STATION APPROACH ───────────────────────────────────
  at(806, (g) => { W4.ring(g, -3.5, 6, 0.24, 1); W4.ring(g, 3.5, 6, 0.24, -1); g.later(2.4, () => W4.loop(g, 1, 5)); });
  at(830, (g) => { W4.frigate(g, 1, 0.2, null); W4.frigate(g, -1, 0.34, ['S']); });
  at(856, (g) => W4.mines(g, [[-7, 0], [-5, 0.25], [-3, 0.5], [3, 0.5], [5, 0.25], [7, 0], [0, 1.6]], 2.5));
  at(874, (g) => { W4.laser(g, -1, -4.5, 0.2, 2); W4.laser(g, 1, 4.5, 0.2, 2); g.later(1.4, () => W4.jink(g, [-2, 2], 0.3, 3, 0.28)); });
  at(900, (g) => { W4.frigate(g, -1, 0.2, ['P'], 5); g.later(1.5, () => escort(g, 1, 2, 0.9)); });
  at(928, (g) => { W4.loop(g, -1, 6, 0.3); g.later(1.4, () => W4.loop(g, 1, 6, 0.3)); });
  at(948, (g) => W.carrier(g, 0, ['1UP']));
  // (rest beat)
  at(972, (g) => { W4.ring(g, 0, 8, 0.28, -1, 2.8); g.later(1.8, () => W4.laser(g, 1, 5, 0.22, 2)); });
  at(996, (g) => W4.mines(g, [[-6, 0], [-3, 0.3], [0, 0.6], [3, 0.9], [6, 1.2], [-4.5, 2.0], [-1.5, 2.3], [1.5, 2.6], [4.5, 2.9]], 2.4));
  at(1020, (g) => W4.frigate(g, 1, 0.24, ['P', 'S'], 6));
  at(1046, (g) => { W4.jink(g, [-6, -3, 0, 3, 6], 0.3); g.later(1.4, () => { W4.laser(g, -1, -5.5, 0.18, 2); W4.laser(g, 1, 5.5, 0.18, 2); }); });
  at(1072, (g) => { escort(g, -1, 2, 0.8); escort(g, 1, 2, 0.8); });
  at(1094, (g) => { W4.ring(g, -3, 6, 0.26, 1); g.later(1.2, () => W4.ring(g, 3, 6, 0.26, -1)); g.later(2.4, () => W4.loop(g, 1, 5)); });
  at(1120, (g) => { W4.frigate(g, 1, 0.18, null); W4.frigate(g, -1, 0.32, ['B']); g.later(2, () => W4.mines(g, [[-3, 0], [3, 0.4]])); });
  at(1150, (g) => { W4.laser(g, -1, -5, 0.18, 2); W4.laser(g, 1, 5, 0.18, 2); g.later(1.6, () => W4.laser(g, -1, -1.5, 0.3, 1)); });
  at(1176, (g) => { W4.jink(g, [-5, -1.5, 2, 5.5], 0.35); g.later(1.8, () => W4.ring(g, 0, 6, 0.24)); });
  at(1202, (g) => W.carrier(g, 0, ['B']));
  at(1216, (g) => W4.mines(g, [[-5, 0], [-1.7, 0.35], [1.7, 0.7], [5, 1.05]], 2.5));
});

export const STAGE = {
  ...STAGE_META[3],
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: spawnAegis,
  // enemies toughen through the debris storm and on the station's approach
  hpSeg: (d) => (d < 420 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
  bulletRim: 1,   // hard dark bullet rims: the day side's white cloud and the pink limb glow are bright
};
