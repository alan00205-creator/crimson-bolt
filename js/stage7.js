// stage7.js — STAGE 7 "GALACTIC STORM" (銀河風暴): through the Galaxy, air units only.
// World 'galaxy' (world.js): glowing nebula gas 0–420 · star clusters 420–800 · dust lanes 800–1240 (the core's
// glow rising ahead) · the galactic core 1240+ (the boss arena: the golden bulge at the top of the screen).
// Nothing below the play area but light: every unit here flies. The Swarm's units (models in models_s7.js):
//   s7_swarmer  bio-mechanical swarm drones: flocks that swirl in the upper screen and peel off one by one to
//               dive at the jet (the sac flares: the tell), streams pouring in from a flank, and broods flung
//               out of warp gates and out of NEMESIS
//   s7_stinger  nebula stingers: they dart in, curl the tail up over the back (the tell: the venom bulb
//               blazes) and strike — pairs of venom needles that bow in from both sides and cross where the
//               jet was — then hop to a new perch and strike again
//   s7_crystal  crystal ships: slow and tanky; the spines store light, over time and from every hit taken,
//               and when full they discharge — needle lines along every spine and a fan from the crown.
//               Kill them fast (they carry the items)
//   s7_gate     warp gates: open in the upper screen and pour broods of swarmers through the portal (the
//               nodes fire aimed big orbs as it pulses) until they warp out again — or are destroyed
//   leviathan   mid-boss space leviathan: spore fountains from its mantle glands (orbs flung up that arc over
//               and rain down in a curtain), a snaking breath from its maw, then its heart: breathing rings
//               that fly out, stop and fall back through it
//   nemesis     boss, the alien mothership: bio-cannons on its mandible arms (curving pincer needles) and
//               brood bays launching swarmers; then its crystal spires grow (double-ring lattices, the
//               refraction lance); then the brood-heart opens — galaxy spirals of curving orbs, breathing
//               rings, broods
// Stage-1 carriers bring most of the items; the crystal ships carry the rest.
// Bullets that bend: every curved pattern here is a plain enemy bullet with a constant acceleration (eb.ax /
// eb.az, set right after shoot()), so it costs nothing extra per frame and can't be told apart from the
// others by the engine (bombs, grazes and cancels all work as usual).
import { STAGE_META } from './defs.js';
import { F } from './fx.js';
import { bez, faceYaw, W, makeTimeline, midbossEvent, bossDefeated } from './stage.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// Enemy definitions (see the field list at the top of stage.js).
export const ENEMY = {
  // swarm drones come by the dozen (flocks, streams, broods): no revenge shots, no distance HP growth
  s7_swarmer: { hp: 3, score: 250, radius: 0.7, air: true, explode: 0.8, debris: 4, medal: 0.15, noRevenge: true, noHpSeg: true, prewarm: 36 },
  s7_stinger: { hp: 30, score: 1100, radius: 0.95, air: true, explode: 1.3, debris: 9, medal: 0.5, prewarm: 7 },
  // three crystals at d 884 while the one from d 806 still holds: 4 when none is shot down (pool: that + 1)
  s7_crystal: { hp: 150, score: 5000, radius: 1.6, air: true, explode: 2.3, debris: 16, medal: 2, prewarm: 5 },
  s7_gate: { hp: 110, score: 6000, radius: 1.9, air: true, explode: 2.4, debris: 18, medal: 2, noRevenge: true, prewarm: 4 },
  // mid-boss: the wings (their spore glands) and the maw, then the heart (armoured under its lid until both wings
  // are gone or 16 s have passed; the maw in front of it shields it too). The body is armour and never a target
  // (bodyTarget: false), so shots, locks and missiles go for the parts; hp is only a backstop. keepOff holds the jet
  // 8.5 below the body: the maw's muzzle is ~4 in front of it, beyond shoot()'s point-blank rule, so hugging can't
  // silence it. hull: the body aft of the heart (shots that clear the parts spark off it).
  leviathan: {
    hp: 9999, score: 45000, radius: 2.4, air: true, explode: 3.4, debris: 32, midboss: true, noRevenge: true, bodyTarget: false, keepOff: 8.5, prewarm: 1,
    parts: [
      { key: 'wingL', hp: 190, score: 7000, medals: 2, big: 2.0 }, { key: 'wingR', hp: 190, score: 7000, medals: 2, big: 2.0 },
      { key: 'maw', hp: 220, score: 9000, medals: 2, big: 1.8 },
      { key: 'core', hp: 640, core: true, score: 45000 },
    ],
    hull: { hw: 1.5, z0: -2.8, z1: -1.2 },
  },
  // boss: parts in hit-test order. The crystal spires and the heart start sealed (not targets) and count in the HP
  // bar from the start. hull: the stern aft of the lance spire (never in front of a part).
  nemesis: {
    hp: 1, score: 0, radius: 5.0, air: true, explode: 4, debris: 40, boss: true, model: 'nemesis', prewarm: 1,
    parts: [
      { key: 'spine', list: true, hp: 140, score: 5000 },
      { key: 'bay', list: true, hp: 270, score: 10000, medals: 3, big: 2 },
      { key: 'prismL', hp: 340, score: 12000, medals: 3, big: 1.8 },
      { key: 'prismR', hp: 340, score: 12000, medals: 3, big: 1.8 },
      { key: 'prismC', hp: 560, score: 20000, medals: 4, big: 2.2 },
      { key: 'core', hp: 1800, core: true, score: 300000 },
    ],
    hull: { hw: 1.8, z0: -6.9, z1: -5.1 },
  },
};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// The top HUD is fixed CSS px (index.html: score strip ≈ 58 px, boss bar down to ≈ 102 px), so on short
// phones a row picked relative to zTop can sit under it. zAtRow gives the world z at height y that
// projects to CSS pixel row py (screen centre column): hover rows are kept at or below it. It works from the
// camera's rest pose (view.C, the view direction view.v, the fixed fov) instead of unprojecting through the
// camera: during a screen shake the camera stands up to ~0.9 off view.C and screenToPlane's ray (a point
// ~2 in front of the shaken camera, less view.C) swings by several units — a boss stationed in a shake (its
// entrance flash) would hold its whole fight several units low.
const HUD_ROW = 80;    // clear of the score strip
const BAR_ROW = 118;   // 16 px under the boss bar
function zAtRow(v, py, y = 0) {
  const f = v.v, k = (1 - (2 * py) / v.h) * Math.tan(v.camera.fov * Math.PI / 360);
  const dy = f.y - f.z * k, dz = f.z + f.y * k;             // the ray: forward + up·k (up = (0, −f.z, f.y))
  return v.C.z + dz * (-v.C.y / dy) * (1 - y / v.C.y);
}
const live = (pt) => (pt && !pt.dead ? pt : null);
/** like stage.js fireTimer, on a named slot of s (a unit with several independent guns) */
function fireTimerS(s, key, dt, g, interval, first) {
  if (s[key] === undefined) s[key] = first / g.diff.fr;
  s[key] -= dt;
  if (s[key] <= 0) { s[key] += interval / g.diff.fr; return true; }
  return false;
}
/** how many units of a type are alive (spawn gates: broods never flood the screen) */
function countType(g, type) {
  let n = 0;
  for (const e of g.enemies) if (e.alive && !e.dying && e.type === type) n++;
  return n;
}
const BROOD_CAP = 16;   // live swarm drones above which gates, bays and the heart hold their broods

// --------------------------------------------------------------------------------
// bullets that bend (a constant acceleration set right after shoot(); see the header)
// --------------------------------------------------------------------------------
const PM = [-1, 1];
/** Venom pincer: a pair of bullets leaving at ±delta off the line to (tx, tz), each bowing back toward the line
 *  so the two cross at the target (then fly apart again). Constant lateral acceleration: the pair crosses after
 *  t = D / (s cos δ) with a = 2 s² sin δ cos δ / D (s = the bullet's real speed, D = the distance, clamped) */
function pincer(g, x, z, tx, tz, speed, delta, kind) {
  const a = Math.atan2(tx - x, tz - z), D = clamp(Math.hypot(tx - x, tz - z), 5, 18), ca = Math.cos(a), sa = Math.sin(a);
  const b = g.eb, sd = Math.sin(delta), cd = Math.cos(delta);
  for (const sg of PM) {
    const i = g.shoot(x, z, a + sg * delta, speed, kind);
    if (i < 0) continue;
    const s = Math.hypot(b.vx[i], b.vz[i]), al = (2 * s * s * sd * cd) / D;
    b.ax[i] = -sg * al * ca; b.az[i] = sg * al * sa;     // toward the line: −sg along n = (cos a, −sin a)
  }
}
/** bend bullet i sideways: an acceleration c across its path (c > 0 curls it clockwise on screen) */
function curve(g, i, c) {
  if (i < 0) return;
  const b = g.eb, s = Math.hypot(b.vx[i], b.vz[i]) || 1;
  b.ax[i] = (c * b.vz[i]) / s; b.az[i] = (-c * b.vx[i]) / s;
}
/** breathing bullet: it decelerates to a stop after 1/k s, then falls back along its line (through where it
 *  was fired) and on out the other side */
function breathe(g, i, k) {
  if (i < 0) return;
  const b = g.eb;
  b.ax[i] = -b.vx[i] * k; b.az[i] = -b.vz[i] * k;
}

// --------------------------------------------------------------------------------
// shared effects (constant colour / option tables: nothing is allocated per frame)
// --------------------------------------------------------------------------------
const VEN_A = [1.1, 2.4, 0.35, 0.9], VEN_B = [0.25, 0.6, 0.05, 0];        // lime bio-light
const XT_A = [1.4, 2.6, 3.2, 1], XT_B = [0.3, 0.7, 1.1, 0];               // crystal light
const WARP_A = [1.8, 0.9, 3.2, 1], WARP_B = [0.35, 0.12, 0.9, 0];         // warp violet
const WHITE_A = [2.8, 2.6, 3.0, 1];
const TEAR_A = [1.6, 2.2, 0.5, 0.9], TEAR_B = [0.6, 0.3, 0.05, 0];          // bio-fire along a torn hull
const OPT_GLOW = { drag: 1.4 }, OPT_FLAT = { flat: true, rot: 0, drag: 0 }, OPT_SHARD = { drag: 3, stretch: 0.05 };
const OPT_SPORE = { drag: 0.6, vrot: 0 }, NO_DRAG = { drag: 0 };
/** a puff of lime bio-light behind a unit (dx, dz: the wake direction on the plane) */
function bioPuff(g, x, z, dx, dz, s = 0.35) {
  g.fx.p.emit(x + rnd(-0.1, 0.1), 0.02, z + rnd(-0.1, 0.1), dx * rnd(0.8, 2.2), 0, dz * rnd(0.8, 2.2), rnd(0.25, 0.45), s, s * 0.3, VEN_A, VEN_B, F.GLOW, 0, OPT_GLOW);
}
/** a warp gate tearing open (or a warp jump): a violet flat ring spreading, a flare */
function warpFlash(g, x, z, s) {
  const p = g.fx.p;
  p.emit(x, 0.2, z, 0, 0, 0, 0.5, s * 0.6, s * 4.2, WARP_A, WARP_B, F.RING, 0, OPT_FLAT);
  p.emit(x, 0.3, z, 0, 0, 0, 0.3, s * 1.2, s * 2.6, WARP_A, WARP_B, F.GLOW, 0, NO_DRAG);
  p.emit(x, 0.3, z, 0, 0, 0, 0.35, s * 0.8, s * 3.0, WHITE_A, WARP_B, F.FLARE, 0, NO_DRAG);
}
/** a warp closing: a ring collapsing inward to a point, a last spark */
function warpCollapse(g, x, z, s) {
  const p = g.fx.p;
  p.emit(x, 0.2, z, 0, 0, 0, 0.45, s * 3.6, s * 0.2, WARP_A, WARP_B, F.RING, 0, OPT_FLAT);
  p.emit(x, 0.3, z, 0, 0, 0, 0.25, s * 1.6, s * 0.3, WHITE_A, WARP_B, F.GLOW, 0, NO_DRAG);
}
/** crystal splinters flying off (a discharge, a crystal breaking) */
function shatter(g, x, z, n, sp = 1) {
  const p = g.fx.p;
  for (let i = 0; i < n; i++) {
    const a = rnd(0, TAU), v = rnd(4, 10) * sp;
    p.emit(x, 0.4, z, Math.cos(a) * v, rnd(0, 2), Math.sin(a) * v, rnd(0.3, 0.6), rnd(0.35, 0.6), 0.08, XT_A, XT_B, F.SHARD, 0, OPT_SHARD);
  }
}
/** glowing spores drifting out of a wound or a burst sac */
function sporeBurst(g, x, z, n, sp = 1) {
  const p = g.fx.p;
  for (let i = 0; i < n; i++) {
    const a = rnd(0, TAU), v = rnd(1, 4.5) * sp;
    OPT_SPORE.vrot = rnd(-2, 2);
    p.emit(x + rnd(-0.3, 0.3), 0.4, z + rnd(-0.3, 0.3), Math.cos(a) * v, rnd(0.5, 2.5), Math.sin(a) * v, rnd(0.6, 1.2), rnd(0.25, 0.45), rnd(0.5, 0.9), VEN_A, VEN_B, F.GLOW, 0, OPT_SPORE);
  }
}

// --------------------------------------------------------------------------------
// swarm drones
// --------------------------------------------------------------------------------
// Flock: n drones swirl round a centre that drops into the upper screen (zf of the height) and sways across.
// Each drone spits one aimed orb as it swirls into view (its sac flickers: a rippling volley from the ring, so a
// flock bites even when a strong jet burns it down at once); after `hold` s they peel off one by one (k·0.22 s
// apart) and dive at the jet in a straight line (the sac flares as each one breaks: the tell), every other one
// firing another aimed orb as it goes.
function flockAI(cx, zf, k, n, dir = 1, hold = 2.0, R = 2.0) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (s.mode === undefined) {
      s.mode = 'swirl'; s.z0 = v.zTop - 3; s.cz = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + R);
      s.a0 = (k / n) * TAU; s.brk = hold + k * 0.22; s.ph = rnd(0, TAU); s.dx = 0; s.dz = 1; s.dt = 0; s.spat = false; s.rg = 0;
      s.zs = zAtRow(v, HUD_ROW);                       // spits only once clear of the score strip
      if (ud.setRage) ud.setRage(0);
    }
    if (s.mode === 'swirl') {
      const u = ease(e.t / 2.0), ccx = cx + dir * Math.sin(e.t * 0.55) * 2.2 * u, ccz = s.z0 + (s.cz - s.z0) * u;
      const a = s.a0 + e.t * 2.1 * dir, r = R * (0.6 + 0.4 * u) * (0.85 + 0.15 * Math.sin(e.t * 3.3 + s.ph));
      e.x = ccx + Math.cos(a) * r; e.z = ccz + Math.sin(a) * r * 0.75;
      if (!s.spat && e.z > s.zs && e.t > 0.3 + (k % 3) * 0.08 && g.canFire(e)) { s.spat = true; s.rg = 0.8; g.shoot(e.x, e.z, g.aim(e.x, e.z), 6.4); }
      if (s.rg > 0) { s.rg = Math.max(0, s.rg - dt * 3); if (ud.setRage) ud.setRage(s.rg); }
      if (e.t > s.brk) {
        s.mode = 'dive';
        const p = g.player, dx = p.x - e.x, dz = Math.max(3, p.z - e.z), l = Math.hypot(dx, dz);
        s.dx = dx / l; s.dz = dz / l;                   // never up the screen
        if (ud.setRage) ud.setRage(1);
        if (k % 2 === 0 && g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 7.2);
      }
    } else {
      s.dt += dt;
      const sp = 4 + Math.min(1, s.dt / 0.6) * 8.5;
      e.x += s.dx * sp * dt; e.z += s.dz * sp * dt;
      if (Math.random() < 0.3) bioPuff(g, e.x - s.dx * 0.6, e.z - s.dz * 0.6, -s.dx, -s.dz, 0.25);
    }
  };
}
// Stream: a river of drones pouring in from a flank (side = +1: from the right) along one curve across the upper
// screen and out the other side, weaving as they go; every other one fires an aimed orb half-way.
function streamAI(side, zf, k) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (!s.P) {
      const T = v.zTop, H = v.zBottom - v.zTop;
      s.P = [[side * 11, T + zf * H], [side * 3.2, T + (zf - 0.1) * H], [-side * 1.2, T + (zf + 0.46) * H], [-side * 10.5, T + (zf + 0.3) * H]];
      s.ph = k * 0.9;
    }
    const u = e.t / 3.6;
    if (u < 1) {
      e.x = bez(s.P[0][0], s.P[1][0], s.P[2][0], s.P[3][0], u);
      e.z = bez(s.P[0][1], s.P[1][1], s.P[2][1], s.P[3][1], u) + Math.sin(e.t * 5 + s.ph) * 0.45;
    } else { e.x += e.vx * dt; e.z += e.vz * dt; }
    if (!s.fired && u > 0.5) { s.fired = true; if (k % 2 === 0 && g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 7.8); }
  };
}
// Brood: flung out (world heading a0, speed sp0) from a gate's portal, a bay or the heart; it speeds up and turns
// toward the jet for a moment (turn rad/s), then flies on straight. `fire`: one aimed orb after a second.
function broodAI(a0, sp0 = 3, fire = false, turn = 1.5) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData;
    if (s.a === undefined) { s.a = a0; s.sp = sp0; if (ud.setRage) ud.setRage(0.6); }
    s.sp = Math.min(8.5, s.sp + dt * 5);
    if (e.t > 0.35 && e.t < 1.9) s.a += clamp(wrapA(g.aim(e.x, e.z) - s.a), -turn * dt, turn * dt);
    e.x += Math.sin(s.a) * s.sp * dt; e.z += Math.cos(s.a) * s.sp * dt;
    if (fire && !s.fired && e.t > 1.0) { s.fired = true; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 7.0); }
  };
}
/** fling n drones out of (x, z) toward heading a0 (spread over ±fan), one every `gap` s, while `alive()` holds */
function brood(g, src, x, z, a0, n, fan = 0.5, gap = 0.2) {
  for (let q = 0; q < n; q++) {
    g.later(q * gap, () => {
      if (!src.alive || src.dying || countType(g, 's7_swarmer') >= BROOD_CAP) return;
      const a = a0 + (n > 1 ? (q / (n - 1) - 0.5) * 2 * fan : 0);
      g.spawn('s7_swarmer', { x, z, ai: broodAI(a, 3.2, q === 1) });
    });
  }
}

// --------------------------------------------------------------------------------
// nebula stinger
// --------------------------------------------------------------------------------
// Swings in from the top to a perch in the upper screen, turned to face the jet. Then, `strikes` times: it curls
// its tail up over its back (0.6 s: the venom bulb blazes and it hisses — the tell), strikes (three venom pincers
// 0.15 s apart from the sting, each pair bowing in to cross where the jet was), recoils and hops to a new perch
// nearer the jet's column. Then it flies off. The first curl comes during the last 0.45 s of the swoop in, so
// the first strike lands as it settles on its perch.
function stingAI(x0, strikes = 3, zf = 0.24) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData, p = g.player;
    if (!s.mode) {
      s.mode = 'in'; s.mt = 0; s.n = 0; s.fixedYaw = true; s.yaw = Math.PI;
      s.sx = x0 + (x0 >= 0 ? 4 : -4); s.sz = v.zTop - 2;
      s.tx = x0; s.tz = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 1.6);
      e.x = s.sx; e.z = s.sz;
      if (ud.setCurl) ud.setCurl(0);
    }
    s.mt += dt;
    if (s.mode !== 'out') s.yaw += clamp(wrapA(faceYaw(e, p.x, p.z) - s.yaw), -3.2 * dt, 3.2 * dt);
    if (s.mode === 'in' || s.mode === 'hop') {
      const dur = s.mode === 'in' ? 1.2 : 0.5, u = clamp(s.mt / dur, 0, 1), k = s.mode === 'in' ? ease(u) : smooth(u);
      e.x = s.sx + (s.tx - s.sx) * k; e.z = s.sz + (s.tz - s.sz) * k;
      if (s.mode === 'hop' && Math.random() < 0.6) bioPuff(g, e.x, e.z - 0.6, s.sx > s.tx ? 1 : -1, -0.6, 0.3);
      if (s.mode === 'in') {                    // the first tell, while it glides in
        if (!s.hiss && s.mt > 0.75) { s.hiss = true; g.audio.play('lock', { vol: 0.3, pitch: 9 }); }
        if (ud.setCurl) ud.setCurl((s.mt - 0.75) / 0.42);
        if (u >= 1) { s.mode = 'strike'; s.mt = 0; s.q = 0; }
      } else if (u >= 1) { s.mode = 'curl'; s.mt = 0; g.audio.play('lock', { vol: 0.3, pitch: 9 }); }
    } else if (s.mode === 'curl') {              // the tell: the tail rises over the back, the bulb blazes
      e.x = s.tx + Math.sin(s.mt * 40) * 0.02;
      if (ud.setCurl) ud.setCurl(Math.min(1, s.mt / 0.55));
      if (s.mt > 0.6) { s.mode = 'strike'; s.mt = 0; s.q = 0; }
    } else if (s.mode === 'strike') {            // three pincers down at the jet
      if (s.q < 3 && s.mt >= s.q * 0.15) {
        s.q++;
        if (g.canFire(e)) {
          const m = g.muzzlePos(ud.tip), mx = m.x, mz = m.z;
          pincer(g, mx, mz, p.x, p.z, 7.6, s.q === 1 ? 0.42 : s.q === 2 ? 0.62 : 0.52, g.BK.NEEDLE);
          if (s.q === 1) { g.audio.play('missile', { vol: 0.3, pitch: 7 }); sporeBurst(g, mx, mz, 4, 0.6); }
        }
      }
      if (s.mt > 0.5) { s.mode = 'recoil'; s.mt = 0; s.n++; }
    } else if (s.mode === 'recoil') {
      if (ud.setCurl) ud.setCurl(Math.max(0, 1 - s.mt / 0.3));
      if (s.mt > 0.35 / Math.min(1.3, g.diff.fr)) {
        s.mt = 0; s.sx = e.x; s.sz = e.z;
        if (s.n >= strikes) { s.mode = 'out'; s.fixedYaw = false; s.dx = e.x > 0 ? 1 : -1; }
        else {
          s.mode = 'hop';
          s.tx = clamp(e.x + clamp(p.x - e.x, -3.5, 3.5) + rnd(-1.2, 1.2), -6.5, 6.5);
          s.tz = clamp(e.z + rnd(-0.6, 1.4), zAtRow(v, HUD_ROW) + 1.2, v.zTop + (v.zBottom - v.zTop) * 0.42);
        }
      }
    } else {                                      // off over the nearer edge, climbing
      e.x += s.dx * (2 + s.mt * 10) * dt; e.z -= (1 + s.mt * 6) * dt;
    }
  };
}

// --------------------------------------------------------------------------------
// crystal ship
// --------------------------------------------------------------------------------
// Noses down into the upper screen, holds there drifting for `stay` s, then climbs away. Its spines store light —
// over time, and from every hit it takes (60 % of its hull in damage fills them) — and blaze brighter as they
// fill; at 85 % it rings a warning, full it discharges: three needles down the line of every spine (a starburst of
// needle lines) and an aimed fan of big orbs from the crown, then the spines are dark again. From the moment it
// noses into view the crown fires an aimed needle trio every 2 s.
function crystalAI(x0, zf = 0.22, stay = 10) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (s.z0 === undefined) {
      s.z0 = v.zTop - 3; s.tz = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 2.2); s.fixedYaw = true; s.yaw = Math.PI;
      s.charge = 0; s.hp0 = e.hp; s.warned = false;
      if (ud.setCharge) ud.setCharge(0);
    }
    const dir = Math.sign(x0) || 1;
    if (e.t < 3) { e.x = x0; e.z = s.z0 + (s.tz - s.z0) * ease(e.t / 3); }
    else if (e.t < 3 + stay) { const k = e.t - 3; e.x = x0 - dir * Math.sin(k * 0.42) * 1.6; e.z = s.tz + Math.sin(k * 0.8) * 0.3; }
    else { const k = e.t - 3 - stay; e.z -= (1.2 + k * 4) * dt; e.x += dir * k * 1.5 * dt; }
    // absorb: the spines fill with time and with the damage taken
    const lost = Math.max(0, s.hp0 - e.hp);
    s.hp0 = e.hp;
    if (e.t > 2.2 && e.t < 3 + stay) s.charge += dt / 6.2 + (lost / e.maxHp) * 0.6;
    if (ud.setCharge) ud.setCharge(s.charge);
    if (!s.warned && s.charge > 0.85) { s.warned = true; g.audio.play('lock', { vol: 0.4, pitch: 12 }); }
    if (s.charge >= 1) {
      s.charge = 0; s.warned = false;
      if (g.canFire(e)) {
        const ex = e.x, ez = e.z;
        for (let k = 0; k < 6; k++) {
          const m = g.muzzlePos(e.mesh, k), mx = m.x, mz = m.z, a = Math.atan2(mx - ex, mz - ez);
          for (let q = 0; q < 3; q++) g.shoot(mx, mz, a, 6.0 + q * 1.5, g.BK.NEEDLE);
        }
        const m = g.muzzlePos(e.mesh, 6), mx = m.x, mz = m.z;
        g.fan(mx, mz, g.aim(mx, mz), 7, 0.95, 6.0, g.BK.BIG);
      }
      shatter(g, e.x, e.z, 10, 0.8);
      g.fx.p.emit(e.x, 0.4, e.z, 0, 0, 0, 0.25, 1.4, 4.5, XT_A, XT_B, F.GLOW, 0, NO_DRAG);
      g.audio.play('hitArmor', { vol: 0.8 }); g.audio.play('explodeS', { vol: 0.6, pitch: 6 });
    }
    if (e.t > 1.7 && e.t < 3 + stay && fireTimerS(s, 'nt', dt, g, 2.0, 0.15) && g.canFire(e)) {
      const m = g.muzzlePos(e.mesh, 6), mx = m.x, mz = m.z, a = g.aim(mx, mz);
      g.shoot(mx, mz, a - 0.13, 8.4, g.BK.NEEDLE); g.shoot(mx, mz, a, 8.8, g.BK.NEEDLE); g.shoot(mx, mz, a + 0.13, 8.4, g.BK.NEEDLE);
    }
    if (e.hp < e.maxHp * 0.5 && Math.random() < 0.2) shatter(g, e.x + rnd(-1, 1), e.z + rnd(-1, 1), 1, 0.5);
  };
}

// --------------------------------------------------------------------------------
// warp gate
// --------------------------------------------------------------------------------
// Tears open at (x0, zf of the height) — a violet flash, the ring swelling out of nothing (armoured while it
// forms) — and drifts down slowly. Every pulse (1.9 s) the portal flares and flings a brood of three drones out
// of it (each brood leaves in a new direction round the dial) and the four nodes fire an aimed big orb each. After
// `life` s the portal shuts and the gate warps out (no score: shoot it before).
function gateAI(x0, zf = 0.26, life = 9) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (s.mode === undefined) {
      s.mode = 'warp'; s.mt = 0; s.fixedYaw = true; s.yaw = 0; s.pt = 0.9; s.pulses = 0; s.ex = rnd(-1, 1);
      s.z0 = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 2.6);
      e.x = x0; e.z = s.z0; e.invuln = true;
      if (ud.setOpen) ud.setOpen(0);
      e.mesh.scale.setScalar(0.15);
      warpFlash(g, e.x, e.z, 1.4);
      g.audio.play('lock', { vol: 0.4, pitch: -7 });
    }
    s.mt += dt;
    e.x = x0 + Math.sin(e.t * 0.5) * 0.6;
    e.z = s.z0 + e.t * 0.45;
    if (s.mode === 'warp') {
      e.mesh.scale.setScalar(0.15 + 0.85 * ease(s.mt / 0.8));
      if (ud.setOpen) ud.setOpen(smooth((s.mt - 0.4) / 0.6));
      if (s.mt > 1.0) { s.mode = 'open'; s.mt = 0; e.invuln = false; }
    } else if (s.mode === 'open') {
      s.pt -= dt;
      if (s.pt <= 0) {
        s.pt = 1.9 / g.diff.fr; s.pulses++;
        if (ud.setPulse) ud.setPulse(1);
        s.ex += 1.3;
        const a0 = Math.PI * 0.5 * Math.sin(s.ex);              // out of the portal, swinging from side to side, downward
        if (g.canFire(e)) brood(g, e, e.x, e.z, a0, 3, 0.35, 0.18);
        g.fx.p.emit(e.x, 0.3, e.z, 0, 0, 0, 0.3, 1.0, 3.2, WARP_A, WARP_B, F.GLOW, 0, NO_DRAG);
        if (g.canFire(e)) {
          for (let k = 0; k < 4; k++) { const m = g.muzzlePos(e.mesh, k); g.shoot(m.x, m.z, g.aim(m.x, m.z), 6.0, g.BK.BIG); }
        }
      }
      if (s.mt > life) { s.mode = 'close'; s.mt = 0; e.invuln = true; g.audio.play('lock', { vol: 0.3, pitch: -9 }); }
    } else {                                     // the portal shuts, the ring folds into a point: gone
      const k = clamp(s.mt / 0.7, 0, 1);
      if (ud.setOpen) ud.setOpen(1 - k);
      e.mesh.scale.setScalar(Math.max(0.05, 1 - 0.9 * k * k));
      if (s.mt > 0.7) { warpCollapse(g, e.x, e.z, 1.3); e.alive = false; }
    }
  };
}

// --------------------------------------------------------------------------------
// mid-boss: LEVIATHAN, the space leviathan
// --------------------------------------------------------------------------------
const LV_ROW = 9.5;     // station below the top edge
const LV_OPEN = 16;     // fight time at which the heart opens even with a wing left
const LV_FIGHT = 46;    // fight time at which it gives up and swims away
const LV_SPORES = 7;
function leviathanAI() {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.life = 0; s.open = 0; s.a = 0; s.b = 0; s.flap = 0; s.fixedYaw = true; s.yaw = Math.PI;
      // station: the tail's tip (e.z − 6) stays below the score strip
      e.x = 0; e.z = v.zTop - 10; s.tz = Math.max(v.zTop + LV_ROW, zAtRow(v, HUD_ROW, 0.3) + 6.2); e.invuln = true; e.armored = true;
      s.wings = [g.partByKey(e, 'wingR'), g.partByKey(e, 'wingL')]; s.maw = g.partByKey(e, 'maw'); s.core = g.partByKey(e, 'core');
      s.ws = [{ st: 'idle', t: 1.4, mt: 0, q: 0 }, { st: 'idle', t: 3.3, mt: 0, q: 0 }];
      s.ms = { st: 'idle', t: 2.6, mt: 0, lock: 0, bt: 0 };
      if (ud.reset) ud.reset();
    }
    s.life += dt;
    const W = s.wings;
    const swell = (live(W[0]) && W[0].obj.userData.charge > 0.2) || (live(W[1]) && W[1].obj.userData.charge > 0.2);
    s.flap += dt * (1.6 + (swell ? 1.4 : 0) + (e.dying ? 3 : 0));
    if (ud.setFlap) ud.setFlap(s.flap);
    // spores drifting off the tail fluke
    if (Math.random() < 0.3) bioPuff(g, e.x + rnd(-0.8, 0.8), e.z - 5.9, 0, -1, 0.4);
    if (e.dying) { leviathanDeath(e, dt, g); return; }
    if (s.mode === 'enter') {
      e.z = (v.zTop - 10) + (s.tz - (v.zTop - 10)) * ease(e.t / 3.4);
      e.roll = Math.sin(e.t * 1.3) * 0.1;
      if (e.t > 3.4) { s.mode = 'fight'; s.ft = 0; e.invuln = false; }
    } else if (s.mode === 'fight') {
      s.ft += dt;
      const lost = (live(W[0]) ? 0 : 1) + (live(W[1]) ? 0 : 1) + (live(s.maw) ? 0 : 1);
      s.sw = (s.sw || 0) + dt * (0.36 + lost * 0.05);        // it swims faster as it is hurt
      e.x = Math.sin(s.sw) * 2.8;
      e.z = s.tz + Math.sin(s.ft * 0.7) * 0.5;
      e.roll = -Math.cos(s.sw) * 0.14;                        // banking into the turns
      if (s.ft > LV_FIGHT) { s.mode = 'retreat'; s.rt = 0; }
    } else {                                   // retreat: it dives away up the screen, the stage goes on
      s.rt += dt;
      e.z -= (2 + s.rt * 10) * dt;
      e.roll *= 1 - dt * 2;
      if (e.z < v.zTop - 12) { e.alive = false; g.midbossDone = true; }
    }
    const maw = live(s.maw), core = s.core;
    // the heart opens once both wings are gone (or it is tired of waiting)
    const wantOpen = s.mode === 'fight' && ((!live(W[0]) && !live(W[1])) || s.ft > LV_OPEN) ? 1 : 0;
    s.open += (wantOpen - s.open) * Math.min(1, dt * 2.2);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;
    if (!s.opened && s.open > 0.5) { s.opened = true; g.audio.play('warning', { vol: 0.4 }); g.shake.add(0.25); sporeBurst(g, e.x, e.z + 0.3, 12, 1); }
    if (s.mode !== 'fight' || !g.canFire(e)) {
      for (let k = 0; k < 2; k++) if (W[k]) W[k].obj.userData.setCharge(0);
      if (s.maw) { s.maw.obj.userData.setCharge(0); s.maw.obj.userData.setOpen(Math.max(0, (s.ms.open || 0) - dt * 2)); }
      return;
    }
    const fr = g.diff.fr, lostWings = (live(W[0]) ? 0 : 1) + (live(W[1]) ? 0 : 1), rage = 1 + lostWings * 0.2 + (maw ? 0 : 0.2);
    // mantle glands, in turn: the gland swells (0.6 s: it blazes, the mantle beats harder), then flings a
    // fountain of spores up the screen that arc over and rain down across its side of the screen
    for (let k = 0; k < 2; k++) {
      const pt = live(W[k]), ws = s.ws[k];
      if (!pt) continue;
      const pu = pt.obj.userData;
      ws.mt += dt;
      if (ws.st === 'idle') {
        ws.t -= dt * rage;
        pu.setCharge(Math.max(0, pu.charge - dt * 2));
        if (ws.t <= 0) { ws.st = 'swell'; ws.mt = 0; ws.t = 3.9 / fr; g.audio.play('lock', { vol: 0.3, pitch: -2 }); }
      } else if (ws.st === 'swell') {
        pu.setCharge(Math.min(1, ws.mt / 0.55));
        if (ws.mt > 0.6) { ws.st = 'launch'; ws.mt = 0; ws.q = 0; g.audio.play('missile', { vol: 0.35, pitch: 6 }); }
      } else {
        while (ws.q < LV_SPORES && ws.mt >= ws.q * 0.055) {
          const m = g.muzzlePos(pt.obj, 0), mx = m.x, mz = m.z, side = mx >= e.x ? 1 : -1;
          const a = Math.PI - side * (0.08 + 0.09 * ws.q + rnd(-0.03, 0.03));
          const i = g.shoot(mx, mz, a, rnd(3.0, 3.8));
          if (i >= 0) g.eb.az[i] = 1.55;                      // falls back toward the jet
          ws.q++;
          if (ws.q === 1) sporeBurst(g, mx, mz, 5, 0.8);
        }
        if (ws.q >= LV_SPORES) { ws.st = 'idle'; }
      }
    }
    // the maw: the mandibles spread and the gullet blazes (0.75 s: the tell), then a snaking stream of big orbs
    // swept to and fro through the line it locked on the jet
    if (maw) {
      const ms = s.ms, mu = maw.obj.userData;
      ms.mt += dt;
      if (ms.st === 'idle') {
        ms.t -= dt * rage;
        ms.open = Math.max(0, (ms.open || 0) - dt * 2); mu.setOpen(ms.open); mu.setCharge(0);
        if (ms.t <= 0) { ms.st = 'open'; ms.mt = 0; ms.t = 4.8 / fr; g.audio.play('lock', { vol: 0.4, pitch: -6 }); }
      } else if (ms.st === 'open') {
        ms.open = Math.min(1, ms.mt / 0.5); mu.setOpen(ms.open); mu.setCharge(Math.min(1, ms.mt / 0.7));
        if (ms.mt > 0.75) { ms.st = 'breath'; ms.mt = 0; ms.bt = 0; const m = g.muzzlePos(maw.obj, 0); ms.lock = g.aim(m.x, m.z); g.shake.add(0.15); }
      } else if (ms.st === 'breath') {
        mu.setCharge(0.7);
        ms.bt -= dt;
        while (ms.bt <= 0 && ms.mt < 1.1) {
          ms.bt += 0.075;
          const m = g.muzzlePos(maw.obj, 0);
          g.shoot(m.x, m.z, ms.lock + Math.sin(ms.mt * 7.5) * 0.34, 6.0, g.BK.BIG);
        }
        if (ms.mt > 1.2) { ms.st = 'idle'; ms.mt = 0; }
      }
    }
    // the open heart: breathing rings (out, a stop, back in through the heart and out again), a two-arm spiral in
    // pulses; below half health, aimed fans of big orbs
    if (core && s.open > 0.85) {
      const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
      s.rgT = (s.rgT ?? 0.8) - dt;
      if (s.rgT <= 0) {
        s.rgT = 2.8 / fr; s.b += 0.5;
        const n = 14;
        for (let q = 0; q < n; q++) breathe(g, g.shoot(cx, cz, (s.b + q) * (TAU / n), 5.0), 0.45);
        g.fx.p.emit(cx, 0.3, cz, 0, 0, 0, 0.3, 1.0, 4.0, VEN_A, VEN_B, F.RING, 0, OPT_FLAT);
      }
      s.cy = (s.cy || 0) + dt;
      s.st = (s.st || 0) - dt;
      if ((s.cy % 4.0) < 2.2 && s.st <= 0) { s.st = 0.14 / fr; s.a += 0.27; g.shoot(cx, cz, s.a, 4.6); g.shoot(cx, cz, s.a + Math.PI, 4.6); }
      if (core.hp < core.maxHp * 0.5) {
        s.fnT = (s.fnT ?? 1.5) - dt;
        if (s.fnT <= 0) { s.fnT = 3.4 / fr; g.fan(cx, cz, g.aim(cx, cz), 5, 0.8, 6.2, g.BK.BIG); }
      }
    }
  };
}
// Death: the mantle thrashes, blasts and spore bursts run along the body and out the wings, the heart bursts in a
// cloud of spores, a big blast, the items.
function leviathanDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT;
  e.z -= 0.5 * dt;
  s.pitch = Math.min(0.22, t * 0.12);
  e.roll = Math.sin(t * 9) * 0.12;
  for (let k = 0; k < 2; k++) if (s.wings[k]) s.wings[k].obj.userData.setCharge(0);
  if (s.maw) { s.maw.obj.userData.setCharge(0); s.maw.obj.userData.setOpen(0.6 + Math.sin(t * 14) * 0.3); }
  if (ud.setFlash && t < 1.7) ud.setFlash(Math.max(0, Math.sin(t * 25)) * 0.6);
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0) {
    s.boomT = 0.1;
    const f = Math.random(), side = Math.random() < 0.5 ? -1 : 1;
    const x = Math.random() < 0.5 ? e.x + rnd(-1.2, 1.2) : e.x + side * (1.5 + f * 3.6), z = Math.random() < 0.5 ? e.z + rnd(-2.6, 3.2) : e.z - 0.4 - f * 1.4;
    g.fx.explosion(x, 0.3, z, rnd(1.0, 1.7), { debris: 4, color: ud.debrisColor });
    if (Math.random() < 0.5) sporeBurst(g, x, z, 4, 1);
    g.audio.play('explodeM', { vol: 0.7, pan: clamp(x / 10, -1, 1) });
    g.shake.add(0.12);
  }
  if (t > 1.9) {
    g.fx.explosion(e.x, 0.4, e.z, 4, { debris: 30, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 18, [1.4, 2.6, 0.5, 1], 0.8);
    g.fx.shockwave(e.x, 0.1, e.z, 11, [2.4, 2.4, 1.6, 1], 0.5);
    sporeBurst(g, e.x, e.z, 26, 2);
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
function spawnLeviathan(g) {
  const e = g.spawn('leviathan', { x: 0, z: g.view.zTop - 10, ai: leviathanAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key === 'wingL' || pt.key === 'wingR') { g.dropItem('P', pt.x, pt.z, { color: g.player.main }); sporeBurst(g, pt.x, pt.z, 16, 1.4); }
    else if (pt.key === 'maw') g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' });
  };
  return e;
}

// --------------------------------------------------------------------------------
// boss: NEMESIS, the alien mothership
// --------------------------------------------------------------------------------
// It tears in through a warp rift at the top of the screen (a violet ring, the ship swelling out of it).
// p1: the bio-cannons on its mandible arms fire curving pincers at the jet (two pairs each, staggered); the brood
//     bays open in turn (the iris shrinks back and the mouth blazes: the tell) and fling out three drones each;
//     the prow drops a swaying double curtain of big orbs → p2 once the cannons and bays are gone (or after 44 s):
//     the crystal spires grow out of their sockets — the side spires fire double rings (an inner ring and a faster
//     outer ring half a step round: a lattice, at times laid on the jet in big orbs) and refract needle lines that
//     converge on the jet, the lance spire tracks the jet, locks (its beam flares: the telegraph; a lattice comes
//     with it) and fires a stream of needles down the lane with two refracted side streams, the spent tip shedding
//     a fan of big shards → p3 once the spires are gone (or after 40 s): the ribs open on the brood-heart — galaxy
//     spirals (three arms of orbs that curl as they fly), aimed fans of big orbs, breathing rings, a breather; low
//     on HP it flings broods and homing mines.
// Parts left alive keep firing in the later phases at a reduced rate.
const NM_FIGHT_P1 = 44, NM_FIGHT_P2 = 40;
function nemesisAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.fixedYaw = true; s.yaw = Math.PI; e.invuln = true; e.armored = true;
      s.open = 0; s.grow = 0; s.a = 0; s.b = 0; s.c = 0; s.sway = 0; s.pt = 0; s.ph = 0; s.bk = 0; s.lance = 'idle'; s.lt = 0; s.curl = 1;
      // station: the stern (e.z − 7) stays below the boss bar
      s.z0 = v.zTop - 6; s.baseZ = Math.max(v.zTop + 12, zAtRow(v, BAR_ROW, 1.0) + 7.4); e.x = 0; e.z = s.z0;
      s.sp = [0, 1, 2, 3].map((i) => g.partByKey(e, 'spine' + i));
      s.bay = [g.partByKey(e, 'bay0'), g.partByKey(e, 'bay1')];
      s.pr = [g.partByKey(e, 'prismL'), g.partByKey(e, 'prismR'), g.partByKey(e, 'prismC')];
      s.core = g.partByKey(e, 'core');
      s.bs = [{ st: 'idle', t: 2.6, mt: 0, q: 0 }, { st: 'idle', t: 6.0, mt: 0, q: 0 }];
      for (const pt of s.pr) if (pt) pt.dead = true;            // sealed nubs until phase 2
      if (s.core) s.core.dead = true;                          // under its ribs until phase 3
      if (ud.reset) ud.reset();
      for (const pt of s.pr) if (pt && pt.obj.userData.setGrow) pt.obj.userData.setGrow(0);
      e.mesh.scale.setScalar(0.2);
      warpFlash(g, 0, s.baseZ - 2, 4.5);
      g.audio.play('lock', { vol: 0.6, pitch: -10 });
    }
    const core = s.core;
    // HP bar: every part (sealed ones count at full health)
    let hp = 0, max = 0;
    for (let i = 0; i < e.parts.length; i++) { const pt = e.parts[i]; max += pt.maxHp; hp += Math.max(0, pt.hp); }
    g.ui.setBossHP(hp / max);
    if (e.dying) { nemesisDeath(e, dt, g); return; }

    if (s.mode === 'enter') {                  // out of the rift: the ship swells to full size as it glides down
      const k = ease(e.t / 6.0);
      e.z = s.z0 + (s.baseZ - s.z0) * k;
      e.mesh.scale.setScalar(0.2 + 0.8 * ease(e.t / 4.2));
      if (e.t < 3.5 && Math.random() < 0.7) {
        const a = rnd(0, TAU), r = rnd(3, 7);
        g.fx.p.emit(e.x + Math.cos(a) * r, 0.4, s.baseZ - 2 + Math.sin(a) * r * 0.7, -Math.cos(a) * 4, 0, -Math.sin(a) * 3, 0.5, 0.5, 0.15, WARP_A, WARP_B, F.GLOW, 0, NO_DRAG);
      }
      if (e.t > 1.2 && !s.rc) { s.rc = true; warpCollapse(g, 0, s.baseZ - 2, 4); }
      if (Math.random() < 0.6) bioPuff(g, e.x + rnd(-0.7, 0.7), e.z - 7.4 * e.mesh.scale.x, 0, -1, 0.7);
      if (e.t > 6.0) { s.mode = 'p1'; s.ph = 0; e.invuln = false; e.mesh.scale.setScalar(1); }
      return;
    }
    s.pt += dt; s.ph += dt;
    // movement: a slow, heavy sway that widens as it loses its armament
    const want = s.mode === 'p1' ? 1.3 : s.mode === 'p2' ? 2.0 : 2.6;
    s.sway += (want - s.sway) * Math.min(1, dt * 0.4);
    e.x = Math.sin(s.pt * 0.26) * s.sway;
    e.z = s.baseZ + Math.sin(s.pt * 0.4) * 0.5;
    e.roll = -Math.cos(s.pt * 0.26) * 0.04 * s.sway;
    if (Math.random() < 0.5) bioPuff(g, e.x + rnd(-0.7, 0.7), e.z - 7.6, 0, -1, 0.6);

    // phase changes
    let outer = 0;
    for (let i = 0; i < 4; i++) if (live(s.sp[i])) outer++;
    if (live(s.bay[0])) outer++;
    if (live(s.bay[1])) outer++;
    if (s.mode === 'p1' && (!outer || s.ph > NM_FIGHT_P1)) {
      s.mode = 'p2'; s.ph = 0; s.lance = 'idle'; s.lt = 1.6;
      g.audio.play('warning', { vol: 0.5 }); g.shake.add(0.35);
    }
    if (s.mode !== 'p1' && s.grow < 1) {       // the crystal spires grow out of their sockets
      s.grow = Math.min(1, s.grow + dt / 2.2);
      const k = smooth(s.grow);
      for (const pt of s.pr) if (pt && !pt.obj.userData.destroyed) pt.obj.userData.setGrow(k);
      if (s.grow > 0.55) for (const pt of s.pr) if (pt && pt.dead && !pt.obj.userData.destroyed) pt.dead = false;
      if (Math.random() < 0.6) {
        const pt = s.pr[(Math.random() * 3) | 0];
        if (pt && !pt.obj.userData.destroyed) { const m = g.muzzlePos(pt.obj); g.fx.sparkle(m.x + rnd(-0.7, 0.7), m.z + rnd(-0.7, 0.7), 1.4, 2.6, 3.2, 0.7, 0.4); }
      }
    }
    const pL = live(s.pr[0]), pR = live(s.pr[1]), pC = live(s.pr[2]);
    if (s.mode === 'p2' && s.grow >= 1 && ((!pL && !pR && !pC) || s.ph > NM_FIGHT_P2)) {
      s.mode = 'p3'; s.ph = 0; s.cyc = 0;
      if (core && !core.obj.userData.destroyed) core.dead = false;
      g.shake.add(0.6); g.ui.flash(0.35); g.audio.play('explodeL'); g.audio.play('warning', { vol: 0.5 });
    }
    // the ribs over the heart
    s.open += ((s.mode === 'p3' ? 1 : 0) - s.open) * Math.min(1, dt * 1.5);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;
    if (s.mode === 'p3' && !s.opened && s.open > 0.5) { s.opened = true; sporeBurst(g, e.x, e.z - 0.4, 20, 1.6); }

    // the bio-cannons track the jet (aiming is free; firing is gated below)
    for (let i = 0; i < 4; i++) { const t = live(s.sp[i]); if (t) aimPart(g, e, t, dt, 2.2); }
    const lo = s.pr[2] && s.pr[2].obj, lu = lo && lo.userData;
    if (pC && s.lance !== 'fire' && s.lance !== 'lock') lo.rotation.y += clamp(wrapA(partAim(g, e, pC) - lo.rotation.y), -1.0 * dt, 1.0 * dt);
    if (!g.canFire(e)) {
      if (lu) { lu.setBeam(0); lu.setCharge(0); }
      if (s.lance === 'lock' || s.lance === 'fire') { s.lance = 'idle'; s.lt = 2; }
      for (let k = 0; k < 2; k++) if (s.bay[k] && s.bs[k].st !== 'idle') { s.bs[k].st = 'close'; s.bs[k].mt = 0; }
      bayDoors(s, dt);
      return;
    }
    const fr = g.diff.fr, hard = g.diff.level >= 2;
    const late = s.mode === 'p1' ? 1 : s.mode === 'p2' ? 0.7 : 0.5;     // leftover outer guns slow down
    // bio-cannons: two pincers each (0.16 s apart) that bow in to cross where the jet was, staggered
    for (let i = 0; i < 4; i++) {
      const t = live(s.sp[i]);
      if (!t) continue;
      t.fireT -= dt * late;
      if (t.fireT <= 0) { t.fireT = (2.2 + i * 0.3) / fr; t.burst = 2; t.bt = 0; }
      if (t.burst > 0) {
        t.bt -= dt;
        if (t.bt <= 0) {
          t.bt = 0.16; t.burst--;
          const m = g.muzzlePos(t.obj, t.burst), p = g.player;
          pincer(g, m.x, m.z, p.x, p.z, 7.0, t.burst ? 0.36 : 0.56, g.BK.NEEDLE);
        }
      }
    }
    // brood bays, in turn: the iris opens (0.9 s: the mouth blazes — the tell), three drones are flung out, it shuts
    for (let k = 0; k < 2; k++) {
      const pt = live(s.bay[k]), bs = s.bs[k];
      if (!pt) continue;
      bs.mt += dt;
      if (bs.st === 'idle') {
        bs.t -= dt * late;
        if (bs.t <= 0) { bs.st = 'open'; bs.mt = 0; bs.t = 6.6 / fr; g.audio.play('lock', { vol: 0.35, pitch: -4 }); }
      } else if (bs.st === 'open') {
        if (bs.mt > 0.9) {
          bs.st = 'fling'; bs.mt = 0;
          const m = g.muzzlePos(pt.obj), side = m.x >= e.x ? 1 : -1;
          brood(g, e, m.x, m.z, side * 1.15, 3, 0.35, 0.2);
          sporeBurst(g, m.x, m.z, 8, 1);
        }
      } else if (bs.st === 'fling') {
        if (bs.mt > 0.8) { bs.st = 'close'; bs.mt = 0; }
      } else if (bs.mt > 0.6) bs.st = 'idle';
    }
    bayDoors(s, dt);
    if (s.mode === 'p1') {
      // the prow: a curtain of big orbs straight down the screen, swept slowly to and fro, and a second row 0.4 s
      // behind it half a step round (a lattice to thread) — not aimed (the cannons' pincers keep the jet moving; a
      // fan that tracked it too would corner it)
      s.pfT = (s.pfT ?? 3.4) - dt;
      if (s.pfT <= 0) {
        s.pfT = 3.6 / fr; s.pfQ = 0.4; s.pfA = Math.sin(s.pt * 0.9) * 0.3;
        const m = g.muzzlePos(e.mesh); g.fan(m.x, m.z, s.pfA, 7, 1.38, 5.6, g.BK.BIG);
      }
      if (s.pfQ > 0) {
        s.pfQ -= dt;
        if (s.pfQ <= 0) { const m = g.muzzlePos(e.mesh); g.fan(m.x, m.z, s.pfA, 6, 1.15, 5.2, g.BK.BIG); }
      }
      return;
    }
    const spMul = s.mode === 'p2' ? 1 : 0.6;
    // p1 guns still standing (the 44 s timeout) slow the spires down: their fire is already on top of it
    const held = 1 + 0.1 * outer;
    // side spires, in turn: a double ring — an inner ring and a faster outer ring half a step round (a lattice);
    // two volleys in four (one from each spire) the inner ring is laid on the jet and both are of big orbs, so a
    // lattice line runs down its column. With every ring the spire's facets refract a burst at the jet: three needle
    // lines from across its face, converging where the jet is. When the lance locks, the next ring comes at once: a
    // lattice to thread on the way out of the lane
    if ((pL || pR) && s.grow >= 1) {
      s.prT = (s.prT ?? 1.0) - dt * spMul;
      if (s.prT <= 0) {
        s.prT = (1.85 / fr) * held; s.bk ^= 1; s.vq = (s.vq || 0) + 1;
        const pt = (s.bk ? pL : pR) || pL || pR, m = g.muzzlePos(pt.obj), mx = m.x, mz = m.z, n = hard ? 14 : 12;
        const a = g.aim(mx, mz), ca = Math.cos(a), sa = Math.sin(a);
        s.b = s.vq & 2 ? a : s.b + 0.37;
        const kind = s.vq & 2 ? g.BK.BIG : g.BK.ORB;
        g.ring(mx, mz, n, 3.9, s.b, kind); g.ring(mx, mz, n, 5.3, s.b + Math.PI / n, kind);
        for (let q = -1; q <= 1; q++) {
          const fx = mx + ca * q * 1.3, fz = mz - sa * q * 1.3, fa = g.aim(fx, fz);
          g.shoot(fx, fz, fa, 8.0, g.BK.NEEDLE); g.shoot(fx, fz, fa, 6.9, g.BK.NEEDLE);
        }
        g.fx.p.emit(mx, 0.5, mz, 0, 0, 0, 0.25, 0.8, 3.0, XT_A, XT_B, F.GLOW, 0, NO_DRAG);
        g.audio.play('hitArmor', { vol: 0.4, pitch: 5 });
      }
    }
    // the lance: track (faint beam), lock (the beam flares: the telegraph), fire a needle stream down the lane with
    // two refracted streams either side, cool
    if (pC && s.grow >= 1) {
      if (s.lance === 'idle') {                                // lt: the countdown to the next lock
        s.lt -= dt * spMul;
        lu.setBeam(0.22); lu.setCharge(0.1);
        if (s.lt <= 0) { s.lance = 'lock'; s.lt = 0; g.audio.play('lock', { vol: 0.5, pitch: -3 }); if (s.prT > 0.35) s.prT = 0.35; }
      } else if (s.lance === 'lock') {                         // lt: time in the state
        s.lt += dt;
        const k = Math.min(1, s.lt / 1.0);
        lu.setBeam(0.4 + 0.6 * k * (0.85 + Math.sin(s.lt * 40) * 0.15)); lu.setCharge(0.2 + 0.8 * k);
        if (s.lt > 1.05) { s.lance = 'fire'; s.lt = 0; s.lst = 0; s.lsd = 0; lu.setBeam(0); g.audio.play('missile', { vol: 0.8, pitch: -5 }); g.shake.add(0.25); const m = g.muzzlePos(lo); shatter(g, m.x, m.z, 6, 0.6); }
      } else if (s.lance === 'fire') {
        s.lt += dt;
        lu.setCharge(Math.max(0, 1 - s.lt / 0.6));
        const ang = lo.rotation.y + e.yaw - Math.PI;
        s.lst -= dt; s.lsd -= dt;
        while (s.lst <= 0 && s.lt < 0.62) { s.lst += 0.045; const m = g.muzzlePos(lo); g.shoot(m.x, m.z, ang, 14, g.BK.NEEDLE); }
        while (s.lsd <= 0 && s.lt < 0.62) {
          s.lsd += 0.1;
          const m = g.muzzlePos(lo), mx = m.x, mz = m.z;
          g.shoot(mx, mz, ang - 0.48, 9.5, g.BK.NEEDLE); g.shoot(mx, mz, ang + 0.48, 9.5, g.BK.NEEDLE);
        }
        if (s.lt > 0.75) {
          s.lance = 'idle'; s.lt = (s.mode === 'p2' ? 1.6 * held : 3.2) / fr;
          // phase 2: the spent tip sheds its charge as a fan of big shards after the jet
          if (s.mode === 'p2') { const m = g.muzzlePos(lo), mx = m.x, mz = m.z; g.fan(mx, mz, g.aim(mx, mz), 7, 1.1, 5.4, g.BK.BIG); shatter(g, mx, mz, 5, 0.5); }
        }
      }
    } else if (lu && !pC) { lu.setBeam(0); lu.setCharge(0); }
    if (s.mode !== 'p3' || !core || s.open < 0.85) return;
    // the brood-heart, in 10 s cycles: galaxy spirals (three arms of orbs that curl as they fly; the curl flips each
    // cycle) that end in an aimed fan of big orbs, then breathing rings (out, a stop, back through the heart and out
    // again; every other one of big orbs), then a breather with a wider aimed fan; below 40 % it flings broods and
    // homing mines too
    const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
    s.cyc += dt;
    const cyc = s.cyc % 10, dir = Math.floor(s.cyc / 10) & 1 ? -1 : 1;
    const rage = core.hp < core.maxHp * 0.4;
    s.ct = (s.ct || 0) - dt;
    if (cyc < 4.6) {
      if (s.ct <= 0) {
        s.ct = (rage ? 0.13 : 0.15) / fr;
        s.a += 0.24 * dir;
        for (let k = 0; k < 3; k++) curve(g, g.shoot(cx, cz, s.a + (k * TAU) / 3, 4.3), 1.7 * dir);
      }
    } else if (cyc < 8.6) {
      if (!s.fanned2) { s.fanned2 = true; g.fan(cx, cz, g.aim(cx, cz), 7, 1.05, 6.2, g.BK.BIG); g.audio.play('lock', { vol: 0.35, pitch: 3 }); }
      if (s.ct <= 0) {
        s.ct = (rage ? 0.85 : 1.0) / fr;
        const n = hard ? 20 : 16;
        s.c += 0.5; s.bq = (s.bq || 0) + 1;
        const kind = s.bq & 1 ? g.BK.ORB : g.BK.BIG;      // every other breath of big orbs
        for (let q = 0; q < n; q++) breathe(g, g.shoot(cx, cz, (s.c + q) * (TAU / n), 5.0, kind), 0.42);
        g.fx.p.emit(cx, 0.4, cz, 0, 0, 0, 0.3, 1.2, 4.6, VEN_A, VEN_B, F.RING, 0, OPT_FLAT);
      }
    } else if (!s.fanned) { s.fanned = true; g.fan(cx, cz, g.aim(cx, cz), hard ? 9 : 7, hard ? 1.25 : 1.05, 6.6, g.BK.BIG); g.audio.play('lock', { vol: 0.4 }); }
    if (cyc < 8.6) s.fanned = false;
    if (cyc < 4.6) s.fanned2 = false;
    if (rage) {
      s.rgT = (s.rgT ?? 1.5) - dt;
      if (s.rgT <= 0) {
        s.rgT = 4.2 / fr;
        brood(g, e, cx, cz + 0.6, 0, 2, 1.1, 0.25);
        for (const sx of PM) {
          const i = g.shoot(cx + sx * 1.6, cz, g.aim(cx + sx * 1.6, cz) + sx * 0.3, 2.2, g.BK.MINE);
          if (i >= 0) { g.eb.home[i] = 1.1; g.eb.az[i] = 0.3; }
        }
        sporeBurst(g, cx, cz, 10, 1.2);
      }
    }
  };
}
/** the bays' irises follow their states (open while opening / flinging, shut otherwise) */
function bayDoors(s, dt) {
  for (let k = 0; k < 2; k++) {
    const pt = s.bay[k];
    if (!pt || pt.dead) continue;
    const bs = s.bs[k], u = pt.obj.userData, want = bs.st === 'open' || bs.st === 'fling' ? 1 : 0;
    u.setOpen(u.open + (want - u.open) * Math.min(1, dt * 4));
  }
}
/** the yaw a part must turn to (in the unit's yawed frame) to face the jet */
function partAim(g, e, pt) { return wrapA(Math.atan2(-(g.player.x - pt.x), -(g.player.z - pt.z)) - e.yaw); }
/** turn a part toward the jet (parts sit in the unit's yawed frame) */
function aimPart(g, e, pt, dt, rate) {
  const obj = pt.obj;
  obj.rotation.y += clamp(wrapA(partAim(g, e, pt) - obj.rotation.y), -rate * dt, rate * dt);
}
// Death: the guns still standing blow in turn while crystal shatters and blasts run in from the arm tips; the heart
// collapses (a lime flash, a ring falling inward), the prow tears away from the carapace, a final blast — then the
// wreck sinks away, shrinking, and a warp rift closes over what is left.
function nemesisDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  if (!s.dieT) {
    const lu = s.pr[2] && s.pr[2].obj.userData;
    if (lu) { lu.setBeam(0); lu.setCharge(0); }
    for (const pt of s.bay) if (pt && pt.obj.userData.setOpen) pt.obj.userData.setOpen(0.4);
  }
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT, y = s.y || 0;
  if (ud.setFlash && t < 2.4) ud.setFlash(Math.max(0, Math.sin(t * 23)) * 0.35);
  // guns still standing blow one after another (crystal shatters)
  s.popT = (s.popT ?? 0.15) - dt;
  if (s.popT <= 0 && t < 2.0) {
    s.popT = 0.2;
    let pt = null;
    for (let i = 0; i < e.parts.length && !pt; i++) if (!e.parts[i].dead && !e.parts[i].core && !e.parts[i].obj.userData.destroyed) pt = e.parts[i];
    if (pt) {
      pt.dead = true;
      if (pt.obj.userData.setDestroyed) pt.obj.userData.setDestroyed(true);
      g.fx.explosion(pt.x, 0.4, pt.z, Math.min(1.8, pt.big), { debris: 8, color: ud.debrisColor });
      if (pt.key.startsWith('prism')) shatter(g, pt.x, pt.z, 12, 1);
      g.audio.play('explodeL', { vol: 0.7 });
    }
  }
  // blasts walking in from the arm tips over the first seconds
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0 && t < 2.4) {
    s.boomT = 0.12;
    const k = Math.min(1, t / 2.2), side = (s.side = -(s.side || 1));
    const x = e.x + side * rnd(1.5, 6.5 - k * 3.5), z = e.z + rnd(1, 6.5 - k * 4);
    g.fx.explosion(x, 0.4 + y * 0.5, z, rnd(0.9, 1.5), { debris: 4, color: ud.debrisColor });
    if (Math.random() < 0.4) sporeBurst(g, x, z, 4, 1);
    g.audio.play('explodeM', { vol: 0.55, pan: clamp(x / 9, -1, 1) });
    g.shake.add(0.1);
  }
  // the heart collapses: a lime-white flash and a ring falling inward
  if (t > 0.9 && !s.crit) {
    s.crit = true;
    const cx = e.x, cz = e.z - 0.4;
    g.fx.p.emit(cx, 1.2, cz, 0, 0, 0, 0.5, 9, 1.2, VEN_A, VEN_B, F.RING, 0, OPT_FLAT);
    g.fx.p.emit(cx, 1.2, cz, 0, 0, 0, 0.3, 2.5, 9, WHITE_A, VEN_B, F.GLOW, 0, NO_DRAG);
    g.fx.explosion(cx, 1.0, cz, 2.6, { debris: 12, color: ud.debrisColor });
    sporeBurst(g, cx, cz, 24, 2);
    g.audio.play('explodeL'); g.shake.add(0.5); g.ui.flash(0.4);
  }
  if (ud.setBreak) ud.setBreak(clamp((t - 1.2) / 2.0, 0, 1));
  if (t > 1.2 && t < 3.4 && Math.random() < 0.5) {   // fire along the tear between prow and carapace
    g.fx.p.emit(e.x + rnd(-2.2, 2.2), 0.6 + y, e.z + 2.9 + rnd(-0.5, 0.5), rnd(-0.6, 0.6), rnd(0.6, 1.6), rnd(-0.6, 0.6), rnd(0.4, 0.8), rnd(0.6, 1.0), rnd(1.6, 2.6),
      TEAR_A, TEAR_B, F.FIRE, 0, OPT_GLOW);
  }
  // it sinks away, pitching and shrinking with distance
  e.z += 0.4 * dt;
  s.pitch = Math.min(0.3, t * 0.09);
  s.y = -5.0 * smooth((t - 2.0) / 3.2);
  e.mesh.scale.setScalar(1 - 0.55 * smooth((t - 2.2) / 3.0));
  if (t > 2.4 && !s.final) {
    s.final = true;
    g.fx.explosion(e.x, 0.5, e.z, 3.8, { debris: 40, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 32, [1.4, 2.6, 0.6, 1], 1.0);
    g.fx.shockwave(e.x, 0.1, e.z, 20, [1.8, 0.9, 3.0, 1], 0.8);
    g.ui.flash(0.65); g.shake.add(1);
    g.audio.play('bossDown');
    g.haptic([80, 50, 200]);
    for (let i = 0; i < 18; i++) g.dropItem('medal', e.x + rnd(-5, 5), e.z + rnd(-3, 3));
  }
  // a rift opens under the wreck and closes over it
  if (t > 4.3 && !s.rift) { s.rift = true; warpFlash(g, e.x, e.z, 3.2); g.audio.play('lock', { vol: 0.5, pitch: -10 }); }
  if (t > 4.3) e.mesh.scale.setScalar(Math.max(0.02, e.mesh.scale.x * (1 - dt * 3)));
  if (t > 5.2 && !s.gone) { s.gone = true; warpCollapse(g, e.x, e.z, 3.5); }
  if (t > 5.4) {
    e.alive = false;
    g.ui.boss(false);
  }
}
function spawnNemesis(g) {
  const e = g.spawn('nemesis', { x: 0, z: g.view.zTop - 6, ai: nemesisAI() });
  e.onDeath = () => { e.s.dieT = 0; bossDefeated(g, e); };
  let spines = 0;
  e.onPartDestroyed = (en, pt) => {
    if (pt.key.startsWith('spine')) { spines++; if (spines % 2 === 0) g.dropItem('P', pt.x, pt.z, { color: g.player.main }); }
    else if (pt.key === 'bay0') g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' });
    else if (pt.key === 'bay1') g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    else if (pt.key === 'prismC') g.dropItem('B', pt.x, pt.z);
    if (pt.key.startsWith('prism')) shatter(g, pt.x, pt.z, 14, 1.2);
    else sporeBurst(g, pt.x, pt.z, 10, 1.2);
  };
  return e;
}

// --------------------------------------------------------------------------------
// spawn helpers for this stage's units (the stage-1 ones come from W)
// --------------------------------------------------------------------------------
const W7 = {
  // a flock of n drones over cx (dir: its swirl), breaking to dive after `hold` s
  flock(g, cx = 0, n = 7, zf = 0.24, dir = 1, hold = 2.0, R = 2.0) {
    for (let k = 0; k < n; k++) g.spawn('s7_swarmer', { x: cx, z: -60, ai: flockAI(cx, zf, k, n, dir, hold, R) });
  },
  // a stream of n drones pouring in from `side` (+1: the right)
  stream(g, side, n = 8, gap = 0.24, zf = 0.14) { for (let i = 0; i < n; i++) g.later(i * gap, () => g.spawn('s7_swarmer', { x: side * 11, z: -60, ai: streamAI(side, zf, i) })); },
  stinger(g, x0, strikes = 3, zf = 0.24) { return g.spawn('s7_stinger', { x: x0, z: -60, ai: stingAI(x0, strikes, zf) }); },
  stingers(g, xs, gap = 0.7, strikes = 3) { xs.forEach((x, i) => g.later(i * gap, () => W7.stinger(g, x, strikes, 0.2 + (i % 2) * 0.07))); },
  crystal(g, x0, drops, stay = 10, zf = 0.22) { return g.spawn('s7_crystal', { x: x0, z: -60, ai: crystalAI(x0, zf, stay), drops }); },
  gate(g, x0, life = 9, zf = 0.26) { return g.spawn('s7_gate', { x: x0, z: -60, ai: gateAI(x0, zf, life) }); },
};

// --------------------------------------------------------------------------------
// Stage 7 timeline (distance in stage units; ~7 units/s)
// --------------------------------------------------------------------------------
const TIMELINE = makeTimeline((at) => {
  // NEBULA ─────────────────────────────────────────────
  at(22, (g) => W7.flock(g, 0, 7, 0.24));
  at(40, (g) => { W7.flock(g, -3.5, 6, 0.2, -1); g.later(1.6, () => W7.stinger(g, 4, 2)); });
  at(56, (g) => W.carrier(g, 2, ['P']));
  at(70, (g) => W7.stingers(g, [-4, 4], 0.9));
  at(92, (g) => { W7.flock(g, 3, 8, 0.24, 1); g.later(1.4, () => W7.stream(g, -1, 6)); });
  at(112, (g) => { W7.crystal(g, 0, ['S'], 9); g.later(3, () => W7.flock(g, -4, 6, 0.3, 1, 1.7)); });
  at(136, (g) => { W7.stream(g, 1, 8); g.later(2.2, () => W7.stinger(g, -3)); });
  at(154, (g) => W7.stingers(g, [-5, 0, 5], 0.8));
  at(174, (g) => { W7.gate(g, -3.5, 8); g.later(2.4, () => W7.flock(g, 3.5, 6, 0.2)); });
  at(198, (g) => { W.carrier(g, -2, ['P', 'B']); g.later(1.2, () => W7.stingers(g, [5, 1], 0.7)); });
  at(212, (g) => { W7.flock(g, -4, 7, 0.22, 1); g.later(1.1, () => W7.flock(g, 4, 7, 0.28, -1)); });
  at(234, (g) => { W7.crystal(g, -4, ['P'], 9); g.later(2.2, () => W7.stinger(g, 4.5, 3)); });
  at(258, (g) => { W7.stream(g, 1, 8); g.later(1.6, () => W7.stream(g, -1, 8, 0.24, 0.2)); });
  at(280, (g) => { W7.gate(g, 4, 9); g.later(3.2, () => W7.stingers(g, [-5, -1.5], 0.6)); });
  at(306, (g) => { W7.flock(g, 0, 10, 0.22, -1, 2.2, 2.6); g.later(2.4, () => W7.stream(g, -1, 7)); });
  at(326, (g) => { W7.crystal(g, -4.5, ['S'], 8); W7.crystal(g, 4.5, null, 8, 0.28); });
  // (rest beat)
  at(356, (g) => W.carrier(g, 0, ['P']));
  at(370, (g) => W7.stingers(g, [-6, -2, 2, 6], 0.6));
  at(396, (g) => { W7.flock(g, -3, 7, 0.2, 1); W7.flock(g, 3, 7, 0.3, -1); g.later(2.6, () => W7.stream(g, 1, 6)); });
  // STAR CLUSTERS ──────────────────────────────────────
  at(426, (g) => { W7.gate(g, -4, 9); g.later(1.2, () => W7.crystal(g, 4, ['P'], 9)); });
  at(452, (g) => { W7.stingers(g, [5, 0, -5], 0.7); g.later(2.4, () => W7.flock(g, 0, 8, 0.24)); });
  at(476, (g) => { W7.stream(g, -1, 9); g.later(1.4, () => W7.stream(g, 1, 9, 0.24, 0.22)); });
  at(496, (g) => { W7.crystal(g, -3.5, null, 9); W7.crystal(g, 3.5, ['S'], 9, 0.28); g.later(3, () => W7.flock(g, 0, 6, 0.36, 1, 1.7)); });
  at(522, (g) => { W7.gate(g, -5, 8); g.later(1.6, () => W7.gate(g, 5, 8, 0.3)); });
  at(546, (g) => { W.carrier(g, 0, ['P']); g.later(1.4, () => W7.stream(g, 1, 7)); });
  at(558, (g) => W7.stingers(g, [-6, -2, 2, 6], 0.55));
  at(574, (g) => W7.flock(g, 0, 8, 0.22, -1));
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnLeviathan));
  at(626, (g) => W.carrier(g, -3, ['S']));
  at(640, (g) => { W7.flock(g, -3.5, 7, 0.22, 1); W7.flock(g, 3.5, 7, 0.22, -1); g.later(2, () => W7.stinger(g, 0, 3)); });
  at(664, (g) => { W7.gate(g, 0, 9, 0.24); g.later(2.4, () => { W7.stream(g, -1, 6); W7.stream(g, 1, 6, 0.24, 0.24); }); });
  at(690, (g) => { W7.crystal(g, -4, ['B'], 9); W7.crystal(g, 4, null, 9, 0.28); });
  at(714, (g) => { W7.stingers(g, [-6, 6, -2.5, 2.5], 0.5); g.later(2.8, () => W7.flock(g, 0, 8, 0.24)); });
  at(742, (g) => { W7.gate(g, -4.5, 8); g.later(1.4, () => W7.gate(g, 4.5, 8, 0.32)); });
  at(768, (g) => { W.carrier(g, 2, ['P']); g.later(1.5, () => W7.stream(g, -1, 8)); });
  at(786, (g) => W7.flock(g, 0, 9, 0.22, 1, 2.2, 2.4));
  // DUST LANES ─────────────────────────────────────────
  at(806, (g) => { W7.crystal(g, 0, ['S'], 10); g.later(1.8, () => { W7.flock(g, -4.5, 6, 0.3, 1); W7.flock(g, 4.5, 6, 0.3, -1); }); });
  at(832, (g) => W7.stingers(g, [-6, -3, 0, 3, 6], 0.5));
  at(856, (g) => { W7.gate(g, -4, 9); g.later(2, () => W7.gate(g, 4, 8, 0.3)); g.later(4, () => W7.flock(g, 0, 7, 0.22)); });
  at(884, (g) => { W7.crystal(g, -5, null, 9); W7.crystal(g, 0, ['P'], 9, 0.18); W7.crystal(g, 5, null, 9); });
  at(912, (g) => { W7.stream(g, 1, 9); g.later(1.2, () => W7.stream(g, -1, 9, 0.24, 0.2)); g.later(2.4, () => W7.stream(g, 1, 7, 0.24, 0.26)); });
  at(936, (g) => { W7.stingers(g, [-5, 5, -1.5, 1.5], 0.55, 3); g.later(3, () => W7.flock(g, 0, 8, 0.24, -1)); });
  at(960, (g) => W.carrier(g, 0, ['1UP']));
  // (rest beat)
  at(986, (g) => { W7.gate(g, -4.5, 9); W7.gate(g, 4.5, 9, 0.3); g.later(2.4, () => W7.crystal(g, 0, null, 8, 0.2)); });
  at(1012, (g) => { W7.flock(g, -4, 7, 0.22, 1); W7.flock(g, 0, 7, 0.3, -1); W7.flock(g, 4, 7, 0.22, 1); });
  at(1036, (g) => W.carrier(g, -2, ['P', 'S']));
  at(1050, (g) => { W7.stingers(g, [-6, -3, 0, 3, 6, -1.5], 0.45); g.later(2.4, () => W7.stream(g, 1, 8)); });
  at(1078, (g) => { W7.crystal(g, -4, ['B'], 9); W7.crystal(g, 4, null, 9); g.later(1.4, () => W7.gate(g, 0, 8, 0.2)); });
  at(1106, (g) => { W7.flock(g, -3.5, 8, 0.24, 1); W7.flock(g, 3.5, 8, 0.24, -1); g.later(2.6, () => W7.stingers(g, [-4, 4], 0.4, 3)); });
  at(1132, (g) => { W7.gate(g, -5, 8); g.later(1.2, () => W7.gate(g, 5, 8, 0.3)); g.later(3, () => W7.stream(g, -1, 7)); });
  at(1160, (g) => { W7.stream(g, 1, 8); W7.stream(g, -1, 8, 0.24, 0.24); g.later(2, () => W7.crystal(g, 0, null, 8)); });
  at(1186, (g) => W7.stingers(g, [-5.5, 5.5, -2, 2], 0.5, 3));
  at(1210, (g) => W.carrier(g, 0, ['B']));
  at(1224, (g) => W7.flock(g, 0, 8, 0.24));
});

export const STAGE = {
  ...STAGE_META[6],
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: spawnNemesis,
  // the swarm thickens among the star clusters and in the dust lanes
  hpSeg: (d) => (d < 420 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
  bulletRim: 1,   // hard dark bullet rims: the galactic core's golden bulge and NEMESIS's crystal spires are bright
};
