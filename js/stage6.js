// stage6.js — STAGE 6 "SOLAR VOYAGE" (太陽系航線): across the Solar System, air units only.
// World 'solar' (world.js): past Mars (the red planet under the play area) 0–320 · the asteroid belt
// (tumbling rocks at the sides, never in the lanes) 320–700 · Jupiter's banded cloud tops 700–1000 ·
// Saturn's ring plane 1000–1240 · the Sun's corona 1240+ (the boss arena, its glare across the top of
// the screen). Nothing below the play area but the bodies: every unit here flies. Enemy types
// introduced here (models in models_s6.js):
//   s6_raider   asteroid riders: a raider clamped on a rock rides it down the screen firing aimed bursts,
//               then kicks the rock away (it tumbles on: an s6_rock) and peels off with a fan
//   s6_rock     the loose asteroid a raider kicks away, or a field of them drifting across: solid, shoot it
//   s6_sail     solar-sail fighters: glide in on the light, the film lights up (the telegraph) and the sail
//               looses a curtain of orbs from along its span — a wall to slip round, not through
//   s6_comet    comet bombers: streak straight across on a long ion tail, shedding ice shards that hang
//               for a moment, then fall toward where the jet was
//   s6_skimmer  ring skimmers: streams crossing the screen (each drops a needle pair as it passes over the
//               jet) and skippers hopping across in arcs (an aimed orb at the bottom of each dip)
//   s6_flare    the solar flares HELIOS lobs: they swell and burst into rings — shoot them first
//   basilisk    mid-boss: a mechanical serpent winding a figure of eight across the upper screen — gun spines
//               sprinkling fans from its flanks, a stinger spitting homing venom, hissing fans from the jaws,
//               then the eye rises: the petrifying gaze (a line of sparks locks, a stream of needles runs down it)
//   helios      boss (stand-in for now: stage 3's SERAPH)
// Stage-1 carriers bring the items.
import { STAGE_META } from './defs.js';
import { F } from './fx.js';
import { fireTimer, bez, W, makeTimeline, midbossEvent } from './stage.js';
import * as S3 from './stage3.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const live = (pt) => (pt && !pt.dead ? pt : null);

// Enemy definitions (see the field list at the top of stage.js).
export const ENEMY = {
  s6_skimmer: { hp: 5, score: 300, radius: 0.8, air: true, explode: 0.9, debris: 6, medal: 0.2, prewarm: 16 },
  s6_raider: { hp: 22, score: 1200, radius: 1.2, air: true, explode: 1.4, debris: 10, medal: 0.6, prewarm: 6 },
  s6_rock: { hp: 14, score: 250, radius: 0.95, air: true, explode: 1.2, debris: 9, noRevenge: true, prewarm: 8 },
  s6_sail: { hp: 40, score: 2000, radius: 1.3, air: true, explode: 1.6, debris: 12, medal: 1, prewarm: 5 },
  s6_comet: { hp: 64, score: 3000, radius: 1.2, air: true, explode: 1.9, debris: 14, medal: 1, prewarm: 4 },
  s6_flare: { hp: 5, score: 100, radius: 0.55, air: true, explode: 0.9, debris: 3, noRevenge: true, noHpSeg: true, prewarm: 8 },
  // mid-boss: the kill is the eye (the core), sunk in its armoured socket until the spines and the stinger
  // are gone or 16 s have passed. The coils are armour and never a target (bodyTarget: false): shots, locks
  // and missiles go for the spines, the stinger and the eye; hp is only a backstop. keepOff holds the jet 6.5
  // below the head (the coils trail along the same figure of eight, so they stay out of its reach too).
  basilisk: {
    hp: 9999, score: 40000, radius: 1.0, air: true, explode: 3.4, debris: 32, midboss: true, noRevenge: true, bodyTarget: false, keepOff: 6.5, prewarm: 1,
    parts: [
      { key: 'spineA', hp: 150, score: 6000, medals: 2, big: 1.8 }, { key: 'spineB', hp: 150, score: 6000, medals: 2, big: 1.8 },
      { key: 'tail', hp: 170, score: 7000, medals: 2, big: 1.8 },
      { key: 'core', hp: 610, core: true, score: 40000 },
    ],
  },
};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// The top HUD is fixed CSS px (index.html: score strip ≈ 58 px, boss bar down to ≈ 102 px), so on short
// phones a row picked relative to zTop can sit under it. zAtRow gives the world z at height y that
// projects to CSS pixel row py (screen centre column): hover rows are kept at or below it.
const HUD_ROW = 80;    // clear of the score strip
const rowQ = { x: 0, z: 0 };
function zAtRow(v, py, y = 0) {
  const q = v.screenToPlane(v.w / 2, py, rowQ);
  return v.C.z + (q.z - v.C.z) * (1 - y / v.C.y);
}

// --------------------------------------------------------------------------------
// shared effects (constant colour / option tables: nothing is allocated per frame)
// --------------------------------------------------------------------------------
const SUN_A = [2.4, 1.6, 0.6, 0.9], SUN_B = [0.9, 0.35, 0.05, 0];        // golden plasma exhaust
const ICE_A = [0.9, 1.9, 2.4, 0.9], ICE_B = [0.2, 0.5, 0.7, 0];           // comet ice glitter
const DUST_A = [0.42, 0.38, 0.34, 0.6], DUST_B = [0.2, 0.18, 0.16, 0];    // rock dust
const CHIP_A = [0.55, 0.5, 0.44, 1], CHIP_B = [0.3, 0.27, 0.24, 0];       // rock chips
const OPT_PUFF = { drag: 1.2 }, OPT_ICE = { drag: 0.8 }, OPT_DUST = { drag: 1.4, vrot: 0 }, OPT_CHIP = { drag: 2, stretch: 0.04 };
const OPT_RING = { flat: true, rot: 0, drag: 0 };
/** a puff of golden plasma exhaust behind a unit (dx, dz: the exhaust direction on the plane) */
function plasmaPuff(g, x, z, dx, dz, s = 0.35) {
  g.fx.p.emit(x + rnd(-0.08, 0.08), 0.02, z + rnd(-0.08, 0.08), dx * rnd(1, 2.5), 0, dz * rnd(1, 2.5), rnd(0.18, 0.32), s, s * 0.3, SUN_A, SUN_B, F.GLOW, 0, OPT_PUFF);
}
/** a burst of rock chips and dust (a raider kicking its rock away, a rock breaking) */
function rockBurst(g, x, z, n, sp) {
  const p = g.fx.p;
  for (let i = 0; i < n; i++) {
    const a = rnd(0, TAU), v = rnd(0.4, 1) * sp;
    p.emit(x, 0.2, z, Math.cos(a) * v, rnd(0, 1.5), Math.sin(a) * v, rnd(0.25, 0.5), 0.2, 0.08, CHIP_A, CHIP_B, F.SHARD, 0, OPT_CHIP);
  }
  for (let i = 0; i < n >> 1; i++) {
    OPT_DUST.vrot = rnd(-1, 1);
    const a = rnd(0, TAU), v = rnd(0.2, 0.6) * sp;
    p.emit(x + Math.cos(a) * 0.4, 0.1, z + Math.sin(a) * 0.4, Math.cos(a) * v, 0, Math.sin(a) * v, rnd(0.5, 0.9), 0.5, 1.4, DUST_A, DUST_B, F.SMOKE, 2, OPT_DUST);
  }
}

// --------------------------------------------------------------------------------
// asteroid riders and loose rocks
// --------------------------------------------------------------------------------
// Rider: rides its rock down the screen (vx: a sideways drift) firing aimed 3-round bursts; once past kick
// (a fraction of the screen height) it kicks the rock away — the rock tumbles on down (an s6_rock) — and
// the raider peels off toward the nearer edge, firing a 5-way fan as it goes.
function riderAI(x0, vx = 0, vz = 2.6, kick = 0.4) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.mode) {
      s.mode = 'ride'; s.fixedYaw = true; s.yaw = Math.PI; e.x = x0; e.z = v.zTop - 2; e.r = e.def.radius;
      s.kz = v.zTop + (v.zBottom - v.zTop) * kick; s.burst = 0;
      if (ud.setRide) { ud.setRide(1); ud.setThrust(0.3); }
    }
    if (s.mode === 'ride') {
      e.x += vx * dt; e.z += vz * dt;
      if (fireTimer(e, dt, g, 2.4, 0.9)) s.burst = 3;
      if (s.burst > 0) {
        s.bt = (s.bt || 0) - dt;
        if (s.bt <= 0) { s.bt = 0.14; s.burst--; if (g.canFire(e)) { const m = g.muzzlePos(e.mesh); g.shoot(m.x, m.z, g.aim(m.x, m.z), 7.2); } }
      }
      if (e.z > s.kz && e.t > 1.5) kickOff(e, g, vx, vz);
    } else {
      s.mt += dt;
      e.x += s.dx * (2.5 + s.mt * 10) * dt;
      e.z -= (0.5 + s.mt * 5) * dt;
      if (Math.random() < 0.6) plasmaPuff(g, e.x - s.dx * 0.5, e.z + 0.7, -s.dx * 0.4, 1, 0.35);
    }
  };
}
function kickOff(e, g, vx, vz) {
  const s = e.s, ud = e.mesh.userData, p = g.player;
  s.mode = 'free'; s.mt = 0; s.fixedYaw = false;
  s.dx = e.x > p.x ? 1 : -1;                               // away from the jet, toward the nearer edge
  if (Math.abs(e.x) > 5.5) s.dx = Math.sign(e.x);
  if (ud.setRide) { ud.setRide(0); ud.setThrust(1); }
  e.r = 0.75;
  // the rock tumbles on the way it was going, pushed back by the kick
  g.spawn('s6_rock', { x: e.x, z: e.z, ai: rockAI(vx * 0.5 - s.dx * 1.3, vz + 0.9, 1.8) });
  rockBurst(g, e.x, e.z, 8, 3);
  g.audio.play('missile', { vol: 0.35, pitch: -3 });
  if (g.canFire(e)) g.fan(e.x, e.z, g.aim(e.x, e.z), 5, 0.8, 6.6);
}
// Loose rock: drifts in a straight line and tumbles (the model spins itself); solid — it kills on contact.
// top: it enters from just beyond the top edge (a field), else it starts where it was spawned (a kicked rock).
function rockAI(vx, vz, spin = 1, top = false) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData;
    if (!s.init) { s.init = true; s.fixedYaw = true; s.yaw = 0; if (top) e.z = g.view.zTop - 2; if (ud.setSpin) ud.setSpin(spin); }
    e.x += vx * dt; e.z += vz * dt;
  };
}

// --------------------------------------------------------------------------------
// solar-sail fighters
// --------------------------------------------------------------------------------
// Glides in on a curve from beyond the top (from `side`), the sail banked into the turn; then `cycles`
// times: the film lights up (the telegraph, 0.95 s), it looses a curtain — orbs strung along its span, all
// flying at the jet together — and reaches a little way across; then it catches the light and sails away.
function sailAI(x0, side = 1, zf = 0.24, cycles = 2) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.mode) {
      s.mode = 'in'; s.mt = 0; s.n = 0; s.fixedYaw = true; s.yaw = Math.PI;
      s.tz = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 1.8); s.x0 = x0 + side * 7; s.z0 = v.zTop - 3;
      e.x = s.x0; e.z = s.z0;
      if (ud.setSail) { ud.setSail(side * 0.8, 1); ud.setCharge(0); ud.setThrust(0.8); }
    }
    s.mt += dt;
    const fr = g.diff.fr;
    if (s.mode === 'in') {
      const u = ease(s.mt / 2.3);
      e.x = bez(s.x0, x0 + side * 5, x0 + side * 0.8, x0, u);
      e.z = bez(s.z0, s.tz - 1, s.tz, s.tz, u);
      if (ud.setSail) ud.setSail(side * 0.8 * (1 - u), 1);
      if (s.mt > 2.3) { s.mode = 'charge'; s.mt = 0; g.audio.play('lock', { vol: 0.3, pitch: 7 }); if (ud.setThrust) ud.setThrust(0.2); }
    } else if (s.mode === 'charge') {
      e.z = s.tz + Math.sin(e.t * 1.6) * 0.15;
      if (ud.setCharge) { ud.setCharge(Math.min(1, s.mt / 0.85)); ud.setSail(0, 1.15); }
      if (s.mt > 0.95) {
        s.mode = 'fire'; s.mt = 0; s.walls = g.diff.level >= 1.5 ? 2 : 1; s.wt = 0;
        if (ud.setCharge) ud.setCharge(0);
      }
    } else if (s.mode === 'fire') {
      s.wt -= dt;
      if (s.walls > 0 && s.wt <= 0) {
        s.wt = 0.34; s.walls--;
        const m = g.muzzlePos(e.mesh, 2), mx = m.x, mz = m.z;
        if (g.canFire(e)) curtain(g, mx, mz, 5, (ud.spread || 1.9), 5.4);
        g.fx.p.emit(mx, 0.3, mz, 0, 0, 0, 0.3, 1.2, 4.4, [1.4, 1.1, 2.2, 0.8], [0.3, 0.2, 0.6, 0], F.RING, 0, OPT_RING);
      }
      if (s.mt > 0.5) {
        s.n++;
        if (s.n >= cycles) { s.mode = 'out'; s.mt = 0; s.dx = e.x > 0 ? 1 : -1; if (ud.setThrust) ud.setThrust(1); }
        else { s.mode = 'reach'; s.mt = 0; s.rx0 = e.x; s.rx1 = clamp(e.x + (g.player.x > e.x ? 2.6 : -2.6), -6.5, 6.5); if (ud.setThrust) ud.setThrust(0.7); }
      }
    } else if (s.mode === 'reach') {
      const u = smooth(s.mt / 1.3 * fr);
      e.x = s.rx0 + (s.rx1 - s.rx0) * u;
      if (ud.setSail) ud.setSail(Math.sign(s.rx1 - s.rx0) * 0.6 * Math.sin(u * Math.PI), 1);
      if (u >= 1) { s.mode = 'charge'; s.mt = 0; g.audio.play('lock', { vol: 0.3, pitch: 7 }); if (ud.setThrust) ud.setThrust(0.2); }
    } else {                                   // away on the wind, climbing toward the nearer edge
      e.x += s.dx * (1 + s.mt * 7) * dt;
      e.z -= (0.6 + s.mt * 5) * dt;
      if (ud.setSail) ud.setSail(s.dx * Math.min(1, s.mt), 1);
    }
  };
}
/** n orbs strung across `half` either side of (x, z), perpendicular to the aim, all flying at the jet together */
function curtain(g, x, z, n, half, speed) {
  const a = g.aim(x, z), px = Math.cos(a), pz = -Math.sin(a);
  for (let k = 0; k < n; k++) { const o = (k / (n - 1) - 0.5) * 2 * half; g.shoot(x + px * o, z + pz * o, a, speed); }
}

// --------------------------------------------------------------------------------
// comet bombers
// --------------------------------------------------------------------------------
// Streaks straight from (sx, just beyond the top) to (ex, below the bottom) nose first, on its tail; every
// `drop` s it sheds an ice shard from a flank rack: the shard drifts out sideways and hangs, then falls
// toward where the jet was when it was dropped (a constant pull: slow, then fast).
function cometAI(sx, ex, speed = 7.2, drop = 0.34) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.init) {
      s.init = true; e.x = sx; e.z = v.zTop - 3;
      const dx = ex - sx, dz = v.zBottom + 3 - e.z, L = Math.hypot(dx, dz);
      s.vx = (dx / L) * speed; s.vz = (dz / L) * speed; s.st = 0.6; s.side = 0;
      if (ud.setTail) ud.setTail(1);
    }
    e.x += s.vx * dt; e.z += s.vz * dt;
    if (Math.random() < 0.5) g.fx.p.emit(e.x + rnd(-0.5, 0.5), 0.1, e.z + rnd(-0.5, 0.5), -s.vx * 0.15 + rnd(-0.3, 0.3), 0, -s.vz * 0.15 + rnd(-0.3, 0.3), rnd(0.4, 0.8), 0.22, 0.05, ICE_A, ICE_B, F.FLARE, 0, OPT_ICE);
    s.st -= dt;
    if (s.st <= 0) {
      s.st = drop / g.diff.fr;
      s.side ^= 1;
      if (g.canFire(e)) {
        const m = g.muzzlePos(e.mesh, s.side), mx = m.x, mz = m.z;
        const out = Math.atan2(s.vx, s.vz) + (s.side ? -1 : 1) * Math.PI / 2;   // out of the flank it hangs on
        const i = g.shoot(mx, mz, out, 0.9);
        if (i >= 0) { const a = g.aim(mx, mz), k = 5.2 * g.diff.bs; g.eb.ax[i] = Math.sin(a) * k; g.eb.az[i] = Math.cos(a) * k; }
      }
    }
  };
}

// --------------------------------------------------------------------------------
// ring skimmers
// --------------------------------------------------------------------------------
// Stream: crosses the screen from the −dir edge at a row (zf) with a gentle weave; as it passes over the
// jet's column it drops one needle pair at it.
function streamAI(dir, zf, speed = 6.4, amp = 0.5, ph = 0) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, p = g.player;
    if (s.z0 === undefined) { s.z0 = v.zTop + (v.zBottom - v.zTop) * zf; e.x = -dir * 11.5; e.z = s.z0; }
    e.x += dir * speed * dt;
    e.z = s.z0 + Math.sin(e.t * 2.2 + ph) * amp;
    if (!s.fired && Math.abs(e.x - p.x) < 1.1 && Math.abs(e.x) < 8) {
      s.fired = true;
      if (g.canFire(e)) { const a = g.aim(e.x, e.z); g.shoot(e.x, e.z, a - 0.07, 9.2, g.BK.NEEDLE); g.shoot(e.x, e.z, a + 0.07, 9.2, g.BK.NEEDLE); }
    }
  };
}
// Skipper: hops across from the −dir edge in arcs that dip down the screen and bounce back at its row, like
// a stone skipping off the ring plane; an aimed orb at the bottom of each dip (three at most).
function skipAI(dir, zf, speed = 4.4, hop = 3.0, w = 2.3, ph = 0) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.z0 === undefined) { s.z0 = v.zTop + (v.zBottom - v.zTop) * zf; s.k = 0; s.shots = 0; }
    e.x = -dir * 11.5 + dir * speed * e.t;
    const a = e.t * w + ph;
    e.z = s.z0 + Math.abs(Math.sin(a)) * hop;
    const k = Math.floor(a / Math.PI + 0.5);            // counts the bottoms of the dips
    if (k !== s.k) {
      s.k = k;
      if (e.t > 0.4 && s.shots < 3 && g.canFire(e)) { s.shots++; g.shoot(e.x, e.z, g.aim(e.x, e.z), 7.4); }
    }
  };
}

// --------------------------------------------------------------------------------
// mid-boss: BASILISK, the mechanical serpent
// --------------------------------------------------------------------------------
// It winds a figure of eight across the upper screen, its coils following the head's own trail (a ring
// buffer of the path; bone k of the model lies k·BAS_BS back along it). Its dorsal gun spines sprinkle fans
// out of either flank as the coils sway, the stinger spits homing venom, the head hisses big-orb fans; once
// the guns are gone (or it tires of waiting) the eye rises out of its armour: the petrifying gaze — a line of
// sparks tracks the jet, locks (the telegraph) and a stream of needles runs down it.
const BAS_N = 10, BAS_BS = 1.15;          // the model's bone chain (models_s6.js)
const BA_ROW = 8.4;                       // the figure of eight's mean row below the top edge
const BA_OPEN = 16;                       // fight time at which the eye opens even with guns left
const BA_FIGHT = 46;                      // fight time at which it gives up and slithers away
const BA_W = 0.42, BA_AX = 4.3, BA_AZ = 1.5;   // the figure of eight: rate, half-width, half-height
const BA_R = [1.05, 0.95, 1.0, 1.0, 1.0, 0.95, 0.85, 0.72, 0.58, 0.48];   // ramming radius at each bone
const PATH_N = 320, PATH_STEP = 0.08;     // the head's trail (25.6 units: the body is 10.4 plus the stinger)
const PQ = { x: 0, z: 0 }, PR = { x: 0, z: 0 };
const GAZE_A = [2.4, 0.5, 0.2, 0.9], GAZE_B = [1.2, 0.1, 0.02, 0], OPT_GAZE = { drag: 0, rot: 0 };
/** lay the trail straight back from (x, z) along the unit vector (dx, dz) */
function pathInit(s, x, z, dx, dz) {
  if (!s.px) { s.px = new Float32Array(PATH_N); s.pz = new Float32Array(PATH_N); s.bx = new Float32Array(BAS_N); s.bz = new Float32Array(BAS_N); s.by = new Float32Array(BAS_N); }
  for (let i = 0; i < PATH_N; i++) { s.px[i] = x + dx * i * PATH_STEP; s.pz[i] = z + dz * i * PATH_STEP; }
  s.ph = 0;                               // the newest sample; older ones follow at ph + 1, ph + 2, … (mod PATH_N)
}
/** record the head's travel in PATH_STEP steps */
function pathPush(s, x, z) {
  let lx = s.px[s.ph], lz = s.pz[s.ph], dx = x - lx, dz = z - lz, d = Math.hypot(dx, dz);
  while (d >= PATH_STEP) {
    lx += (dx / d) * PATH_STEP; lz += (dz / d) * PATH_STEP;
    s.ph = (s.ph + PATH_N - 1) % PATH_N; s.px[s.ph] = lx; s.pz[s.ph] = lz;
    dx = x - lx; dz = z - lz; d = Math.hypot(dx, dz);
  }
}
/** the point `dist` back along the trail from the head at (hx, hz) → out */
function pathAt(s, hx, hz, dist, out) {
  const nx = s.px[s.ph], nz = s.pz[s.ph], d0 = Math.hypot(hx - nx, hz - nz);
  if (dist <= d0) { const t = d0 > 1e-6 ? dist / d0 : 0; out.x = hx + (nx - hx) * t; out.z = hz + (nz - hz) * t; return out; }
  const u = Math.min(PATH_N - 1.001, (dist - d0) / PATH_STEP), i = Math.floor(u), f = u - i;
  const a = (s.ph + i) % PATH_N, b = (s.ph + i + 1) % PATH_N;
  out.x = s.px[a] + (s.px[b] - s.px[a]) * f; out.z = s.pz[a] + (s.pz[b] - s.pz[a]) * f;
  return out;
}
/** lay the model's bones along the trail (the unit sits at the head with yaw 0, so its frame is the world's);
 *  a slow ripple runs down the coils (height and pitch), and they bank into the bends */
function layBody(e, s, ud, g) {
  const B = ud.bones, ey = e.s.y || 0;
  let prevYaw = 0;
  for (let k = 0; k < BAS_N; k++) {
    const q = pathAt(s, e.x, e.z, k * BAS_BS, PQ), r = pathAt(s, e.x, e.z, k * BAS_BS + 0.5, PR);
    const yaw = Math.atan2(-(q.x - r.x), -(q.z - r.z));
    const ph = s.life * 2.4 - k * 0.75, y = Math.sin(ph) * 0.18;
    s.bx[k] = q.x; s.bz[k] = q.z; s.by[k] = y + ey;
    const bn = B[k];
    bn.position.set(q.x - e.x, y, q.z - e.z);
    let bank = 0;
    if (k > 0) { let d = yaw - prevYaw; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; bank = clamp(-d * 2.2, -0.45, 0.45); }
    bn.rotation.set(-Math.cos(ph) * 0.12, yaw, bank);
    prevYaw = yaw;
  }
}
function basiliskAI() {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.life = 0; s.open = 0; s.a = 0; s.fixedYaw = true; s.yaw = 0; e.invuln = true; e.armored = true;
      s.z0 = Math.max(v.zTop + BA_ROW, zAtRow(v, HUD_ROW, 0.6) + 3.6);
      s.sx = -8.5; s.sz = v.zTop - 3; e.x = s.sx; e.z = s.sz;
      pathInit(s, e.x, e.z, -0.34, -0.94);   // trailing straight back up and to the left, off the screen
      s.spA = g.partByKey(e, 'spineA'); s.spB = g.partByKey(e, 'spineB'); s.tail = g.partByKey(e, 'tail'); s.core = g.partByKey(e, 'core');
      s.spT = [1.2, 2.4]; s.venT = 2.8; s.hissT = 1.6; s.jaw = 0; s.gz = 'rest'; s.gt = 1.2; s.gAng = 0; s.gst = 0;
      if (ud.reset) ud.reset();
      layBody(e, s, ud, g);
    }
    s.life += dt;
    if (e.dying) { basiliskDeath(e, dt, g); pathPush(s, e.x, e.z); layBody(e, s, ud, g); return; }
    const kx = BA_W * BA_AX, kz = 2 * BA_W * BA_AZ;          // the figure of eight's velocity at its start
    if (s.mode === 'enter') {
      const u = Math.min(1, e.t / 3.6), L = Math.hypot(kx, kz), tx = kx / L, tz = kz / L;
      e.x = bez(s.sx, -7.2, -3.2 * tx, 0, u);
      e.z = bez(s.sz, s.z0 - 1.5, s.z0 - 3.2 * tz, s.z0, u);
      if (e.t > 3.6) { s.mode = 'fight'; s.ft = 0; e.invuln = false; }
    } else if (s.mode === 'fight') {
      s.ft += dt;
      e.x = Math.sin(s.ft * BA_W) * BA_AX;
      e.z = s.z0 + Math.sin(s.ft * BA_W * 2) * BA_AZ;
      if (s.ft > BA_FIGHT) { s.mode = 'retreat'; s.rt = 0; s.rdx = Math.cos(s.ft * BA_W) >= 0 ? 1 : -1; }
    } else {                                   // retreat: the head climbs away, the coils following it off the top
      s.rt += dt;
      e.x += s.rdx * Math.max(0, 1.8 - s.rt) * dt;
      e.z -= (1.5 + s.rt * 4.5) * dt;
      if (s.bz[BAS_N - 1] < v.zTop - 5) { e.alive = false; g.midbossDone = true; }
    }
    pathPush(s, e.x, e.z);
    layBody(e, s, ud, g);
    // ramming: the coils are solid (the engine only tests the head's circle)
    const p = g.player;
    if (p.alive && s.mode !== 'enter') {
      for (let k = 1; k < BAS_N; k++) {
        const dx = p.x - s.bx[k], dz = p.z - s.bz[k], rr = BA_R[k] * 0.8 + g.ac.hitR;
        if (dx * dx + dz * dz < rr * rr) { g.killPlayer(); break; }
      }
    }
    const spA = live(s.spA), spB = live(s.spB), tail = live(s.tail), core = s.core;
    // the eye rises once the guns are gone (or it is tired of waiting)
    const wantOpen = s.mode === 'fight' && ((!spA && !spB && !tail) || s.ft > BA_OPEN) ? 1 : 0;
    s.open += (wantOpen - s.open) * Math.min(1, dt * 2.0);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;
    if (!s.opened && s.open > 0.5) { s.opened = true; g.audio.play('warning', { vol: 0.4 }); g.shake.add(0.2); }
    s.jaw = Math.max(0, s.jaw - dt * 2.2);
    if (ud.setJaw) ud.setJaw(s.jaw);
    if (s.mode !== 'fight' || !g.canFire(e)) { s.gz = 'rest'; s.gt = Math.max(s.gt, 0.8); return; }
    const fr = g.diff.fr, late = s.open > 0.85 ? 0.7 : 1, hard = g.diff.level >= 1.5;
    // gun spines: 3-way fans out of either flank, square to the coil they ride (the swaying body sweeps them)
    for (let q = 0; q < 2; q++) {
      const sp = q ? spB : spA;
      if (!sp) continue;
      s.spT[q] -= dt * late;
      if (s.spT[q] <= 0) {
        s.spT[q] = 2.5 / fr;
        const yaw = sp.obj.parent.rotation.y, ax = Math.atan2(Math.cos(yaw), -Math.sin(yaw));   // the bone's +x flank
        for (let side = 0; side < 2; side++) { const m = g.muzzlePos(sp.obj, side); g.fan(m.x, m.z, ax + side * Math.PI, 3, 0.46, 5.0); }
      }
    }
    // the stinger: three homing venom mines at the jet
    if (tail) {
      s.venT -= dt * late;
      if (s.venT <= 0) {
        s.venT = 4.6 / fr;
        const m = g.muzzlePos(tail.obj), mx = m.x, mz = m.z, a = g.aim(mx, mz);
        for (let k = -1; k <= 1; k++) { const i = g.shoot(mx, mz, a + k * 0.34, 2.8, g.BK.MINE); if (i >= 0) g.eb.home[i] = 0.9; }
        g.audio.play('lock', { vol: 0.25, pitch: -6 });
      }
    }
    // the head: a hiss (the jaw drops), then a fan of big orbs from the mouth
    s.hissT -= dt;
    if (s.hissT < 0.3 && s.hissT + dt >= 0.3) s.jaw = 1.2;
    if (s.hissT <= 0) {
      s.hissT = (s.open > 0.85 ? 4.4 : 3.0) / fr;
      const m = g.muzzlePos(ud.bones[0]);
      g.fan(m.x, m.z, g.aim(m.x, m.z), 5, 0.8, 6.0, g.BK.BIG);
    }
    if (core && s.open > 0.85) gaze(e, dt, g, s, core, fr, hard);
  };
}
// the petrifying gaze: rest → track (a dim line of sparks follows the jet) → lock (the line holds and burns
// bright: the telegraph) → fire (a stream of needles down the locked line, flanking needles either side) →
// rest; below half HP each stream ends with a ring
function gaze(e, dt, g, s, core, fr, hard) {
  const m = g.muzzlePos(core.obj), ex = m.x, ez = m.z;
  s.gt -= dt;
  if (s.gz === 'rest') {
    if (s.gt <= 0) { s.gz = 'track'; s.gt = 0.7; s.gAng = g.aim(ex, ez); }
  } else if (s.gz === 'track') {
    let d = g.aim(ex, ez) - s.gAng; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
    s.gAng += clamp(d, -2.4 * dt, 2.4 * dt);
    gazeLine(g, ex, ez, s.gAng, 0.45);
    if (s.gt <= 0) { s.gz = 'lock'; s.gt = 0.75; g.audio.play('lock', { vol: 0.45, pitch: -2 }); }
  } else if (s.gz === 'lock') {
    gazeLine(g, ex, ez, s.gAng, 1.0);
    if (s.gt <= 0) { s.gz = 'fire'; s.gt = 0.8; s.gst = 0; s.gk = 0; g.audio.play('missile', { vol: 0.6, pitch: -4 }); g.shake.add(0.15); }
  } else {
    s.gst -= dt;
    while (s.gst <= 0 && s.gt > 0) {
      s.gst += 0.05; s.gk++;
      g.shoot(ex, ez, s.gAng, 13, g.BK.NEEDLE);
      if (s.gk % 3 === 0) { g.shoot(ex, ez, s.gAng - 0.2, 11, g.BK.NEEDLE); g.shoot(ex, ez, s.gAng + 0.2, 11, g.BK.NEEDLE); }
    }
    if (s.gt <= 0) {
      s.gz = 'rest'; s.gt = 1.4 / fr;
      if (core.hp < core.maxHp * 0.5) { s.a += 0.37; g.ring(ex, ez, hard ? 20 : 16, 4.2, s.a); }
    }
  }
}
/** the gaze's line of sparks from the eye along `ang` (k: brightness) */
function gazeLine(g, x, z, ang, k) {
  const sx = Math.sin(ang), sz = Math.cos(ang), p = g.fx.p;
  GAZE_A[3] = 0.9 * k; GAZE_A[0] = 2.4 * k;
  for (let i = 1; i <= 12; i++) {
    const d = i * 1.35 + (g.time * 9) % 1.35;
    p.emit(x + sx * d, 0.15, z + sz * d, 0, 0, 0, 0.06, 0.34 * (0.6 + k * 0.4), 0.2, GAZE_A, GAZE_B, F.GLOW, 0, OPT_GAZE);
  }
}
// Death: it thrashes, blasts run up the coils from the stinger to the head, the eye bursts, the items.
function basiliskDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT;
  e.x += Math.sin(t * 11) * 2.2 * dt; e.z += Math.cos(t * 7) * 1.4 * dt - 0.4 * dt;
  if (ud.setHurt) ud.setHurt(Math.min(1, t / 1.8));
  if (ud.setFlash && t < 1.8) ud.setFlash(Math.max(0, Math.sin(t * 25)) * 0.8);
  if (ud.setJaw) ud.setJaw(Math.min(1, t * 2));
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0 && t < 1.75) {
    s.boomT = 0.12;
    const k = Math.max(0, BAS_N - 1 - Math.floor(t / 0.18));   // tail first, up to the head
    g.fx.explosion(s.bx[k] + rnd(-0.6, 0.6), 0.3, s.bz[k] + rnd(-0.6, 0.6), rnd(1.0, 1.7), { debris: 5, color: ud.debrisColor });
    g.audio.play('explodeM', { vol: 0.7, pan: clamp(s.bx[k] / 10, -1, 1) });
    g.shake.add(0.12);
  }
  if (t > 1.8) {
    g.fx.explosion(e.x, 0.4, e.z, 4, { debris: 30, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 18, [2.6, 1.9, 0.9, 1], 0.8);
    g.fx.shockwave(e.x, 0.1, e.z, 11, [2.8, 2.4, 1.6, 1], 0.5);
    for (let k = 2; k < BAS_N; k += 3) g.fx.explosion(s.bx[k], 0.3, s.bz[k], 1.8, { debris: 8, color: ud.debrisColor });
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
function spawnBasilisk(g) {
  const e = g.spawn('basilisk', { x: -8.5, z: g.view.zTop - 3, ai: basiliskAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key.startsWith('spine')) g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    else if (pt.key === 'tail') g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' });
  };
  return e;
}

// --------------------------------------------------------------------------------
// boss: stand-in until HELIOS is in (stage 3's SERAPH)
// --------------------------------------------------------------------------------

// --------------------------------------------------------------------------------
// spawn helpers for this stage's units (the stage-1 ones come from W)
// --------------------------------------------------------------------------------
const W6 = {
  // n skimmers in a stream from the −dir edge, `gap` s apart
  stream(g, dir, zf = 0.24, n = 5, gap = 0.3, speed = 6.4) {
    for (let i = 0; i < n; i++) g.later(i * gap, () => g.spawn('s6_skimmer', { x: -dir * 11.5, z: -60, ai: streamAI(dir, zf, speed, 0.5, i * 0.9) }));
  },
  // n skippers hopping across from the −dir edge
  skip(g, dir, zf = 0.18, n = 3, gap = 0.55) {
    for (let i = 0; i < n; i++) g.later(i * gap, () => g.spawn('s6_skimmer', { x: -dir * 11.5, z: -60, ai: skipAI(dir, zf + (i & 1) * 0.04) }));
  },
  rider(g, x, vx = 0, kick = 0.4, drops) { return g.spawn('s6_raider', { x, z: -60, ai: riderAI(x, vx, 2.6, kick), drops }); },
  // riders over xs, `gap` s apart (each with a small drift toward the centre)
  riders(g, xs, gap = 0.6, kick = 0.4) { xs.forEach((x, i) => g.later(i * gap, () => W6.rider(g, x, -Math.sign(x) * 0.25, kick + (i & 1) * 0.06))); },
  // a field of loose rocks drifting across and down: [[x, delay, vx], …]
  rocks(g, list, vz = 2.2) {
    for (const [x, d, vx] of list) g.later(d, () => g.spawn('s6_rock', { x, z: -60, ai: rockAI(vx || 0, vz, rnd(0.5, 1.6), true) }));
  },
  sail(g, x0, side = 1, zf = 0.24, cycles = 2, drops) { return g.spawn('s6_sail', { x: x0 + side * 7, z: -60, ai: sailAI(x0, side, zf, cycles), drops }); },
  comet(g, sx, ex, drops, speed) { return g.spawn('s6_comet', { x: sx, z: -60, ai: cometAI(sx, ex, speed), drops }); },
};

// --------------------------------------------------------------------------------
// Stage 6 timeline (distance in stage units; ~7 units/s)
// --------------------------------------------------------------------------------
const TIMELINE = makeTimeline((at) => {
  // MARS ──────────────────────────────────────────────
  at(24, (g) => W6.stream(g, 1, 0.22));
  at(40, (g) => W6.stream(g, -1, 0.3));
  at(56, (g) => W.carrier(g, 0, ['P']));
  at(72, (g) => W6.sail(g, -3, -1, 0.22, 2));
  at(94, (g) => { W6.sail(g, -4.5, -1, 0.2, 1); W6.sail(g, 4.5, 1, 0.26, 1); });
  at(118, (g) => W6.skip(g, 1, 0.16, 3));
  at(138, (g) => W6.riders(g, [-4, 4], 0.8));
  at(158, (g) => { W6.sail(g, 0, 1, 0.2, 2); g.later(1.6, () => W6.stream(g, -1, 0.34, 5)); });
  at(180, (g) => W.carrier(g, 3, ['S']));
  at(192, (g) => W6.comet(g, -7, 5));
  at(210, (g) => W6.riders(g, [-5, 0, 5], 0.5));
  at(232, (g) => { W6.stream(g, 1, 0.2, 5); g.later(1.2, () => W6.stream(g, -1, 0.3, 5)); });
  at(254, (g) => { W6.sail(g, -5, -1, 0.2, 1); W6.sail(g, 0, 1, 0.26, 1); W6.sail(g, 5, 1, 0.2, 1); });
  at(276, (g) => { W6.comet(g, 7, -4); g.later(1.4, () => W6.comet(g, -7, 4)); });
  at(296, (g) => W.carrier(g, -2, ['P', 'B']));
  at(310, (g) => { W6.riders(g, [-3, 3], 0.4); g.later(1.2, () => W6.skip(g, -1, 0.14, 3)); });
  // ASTEROID BELT ──────────────────────────────────────
  at(334, (g) => { W6.riders(g, [-5, -1.5, 2, 5.5], 0.45); });
  at(356, (g) => W6.comet(g, -6, 6, ['S']));
  at(374, (g) => { W6.skip(g, 1, 0.16, 4); g.later(1.4, () => W6.skip(g, -1, 0.22, 3)); });
  at(396, (g) => { W6.sail(g, -4, -1, 0.22, 2); g.later(1.4, () => W6.riders(g, [4], 0)); });
  at(418, (g) => { W6.rocks(g, [[-6.5, 0, 1.1], [-2, 0.5, 0.9], [3, 1.0, -0.8], [6.5, 1.4, -1.1], [-4.5, 2.1, 1.0], [1, 2.6, 0.2]]); g.later(2.6, () => W6.stream(g, 1, 0.26, 5)); });
  at(444, (g) => W.carrier(g, 0, ['P']));
  at(458, (g) => { W6.comet(g, -7, 3); g.later(1.1, () => W6.comet(g, 7, -3)); });
  at(482, (g) => W6.riders(g, [-6, -2, 2, 6], 0.55, 0.36));
  at(506, (g) => { W6.sail(g, -5, -1, 0.2, 1); W6.sail(g, 5, 1, 0.2, 1); g.later(1.8, () => W6.sail(g, 0, 1, 0.3, 1)); });
  at(530, (g) => { W6.stream(g, 1, 0.2, 6, 0.28); W6.stream(g, -1, 0.32, 6, 0.28); });
  at(550, (g) => W.carrier(g, -3, ['B']));
  at(564, (g) => { W6.riders(g, [-4, 4], 0.3, 0.34); W6.rocks(g, [[0, 0.8, 0], [-6, 1.2, 1.2], [6, 1.6, -1.2]]); });
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnBasilisk));
  at(628, (g) => W.carrier(g, 2, ['S']));
  at(644, (g) => { W6.riders(g, [-5, 0, 5], 0.5); g.later(2, () => W6.stream(g, -1, 0.24, 5)); });
  at(666, (g) => W6.comet(g, 6, -6, ['P']));
  at(684, (g) => { W6.sail(g, -3.5, -1, 0.2, 2); W6.sail(g, 3.5, 1, 0.28, 2); });
  // JUPITER ───────────────────────────────────────────
  at(708, (g) => { W6.comet(g, -7.5, 2); g.later(0.8, () => W6.comet(g, 7.5, -2)); });
  at(730, (g) => { W6.skip(g, 1, 0.14, 5, 0.45); });
  at(752, (g) => { W6.sail(g, -5, -1, 0.2, 2); W6.sail(g, 0, 1, 0.3, 2); W6.sail(g, 5, 1, 0.2, 2); g.later(2.5, () => W.carrier(g, 0, ['P'])); });
  at(782, (g) => W6.riders(g, [-6, -1, 4], 0.5));
  at(804, (g) => { W6.comet(g, -8, 0); W6.comet(g, -4, 4); g.later(0.6, () => W6.comet(g, 0, 8)); });
  at(830, (g) => { W6.sail(g, -4, -1, 0.22, 2); W6.sail(g, 4, 1, 0.22, 2); g.later(1, () => W6.stream(g, 1, 0.34, 6)); });
  at(854, (g) => W.carrier(g, -3, ['P', 'S']));
  at(868, (g) => W6.riders(g, [-6, -2, 2, 6], 0.4, 0.36));
  at(894, (g) => { W6.comet(g, 7, -7); g.later(0.7, () => W6.comet(g, -7, 7)); g.later(1.2, () => W6.stream(g, -1, 0.22, 6)); });
  at(920, (g) => { W6.sail(g, -5.5, -1, 0.2, 1); W6.sail(g, 5.5, 1, 0.2, 1); g.later(1.4, () => { W6.sail(g, -2, -1, 0.3, 1); W6.sail(g, 2, 1, 0.3, 1); }); });
  at(946, (g) => W.carrier(g, 0, ['1UP']));
  // (rest beat)
  at(970, (g) => { W6.stream(g, 1, 0.2, 6); g.later(1.4, () => W6.stream(g, -1, 0.3, 6)); });
  at(988, (g) => { W6.comet(g, -7, 6); g.later(1.2, () => W6.comet(g, 7, -6, ['B'])); });
  // SATURN'S RINGS ─────────────────────────────────────
  at(1008, (g) => { W6.stream(g, 1, 0.18, 8, 0.24); g.later(1.0, () => W6.stream(g, -1, 0.3, 8, 0.24)); });
  at(1032, (g) => W6.riders(g, [-5, 0, 5], 0.5, 0.36));
  at(1052, (g) => { W6.sail(g, -5, -1, 0.2, 2); W6.sail(g, 5, 1, 0.2, 2); g.later(1.6, () => W6.sail(g, 0, 1, 0.3, 1)); });
  at(1076, (g) => W.carrier(g, 3, ['P']));
  at(1090, (g) => { W6.comet(g, -8, -1); g.later(0.5, () => W6.comet(g, -3, 3)); g.later(1.0, () => W6.comet(g, 3, 8)); });
  at(1114, (g) => { W6.skip(g, 1, 0.14, 5, 0.45); g.later(1.2, () => W6.stream(g, -1, 0.3, 6)); });
  at(1138, (g) => W6.riders(g, [-6, -2, 2, 6], 0.4, 0.34));
  at(1160, (g) => { W6.sail(g, -4, -1, 0.22, 2); W6.sail(g, 4, 1, 0.22, 2); g.later(2, () => W6.comet(g, 0, 6)); });
  at(1184, (g) => W.carrier(g, -2, ['B']));
  at(1198, (g) => { W6.stream(g, 1, 0.2, 7); W6.stream(g, -1, 0.32, 7); g.later(1.5, () => W6.sail(g, 0, 1, 0.24, 1)); });
  at(1218, (g) => W6.riders(g, [-4, 4], 0.3, 0.34));
});

export const STAGE = {
  ...STAGE_META[5],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => S3.STAGE.spawnBoss(g), // stand-in for HELIOS
  // enemies toughen through the belt, over Jupiter and in the rings
  hpSeg: (d) => (d < 320 ? 1 : d < 700 ? 1.12 : d < 1000 ? 1.24 : 1.34),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
  bulletRim: 1,   // hard dark bullet rims: Jupiter's cream zones, Saturn's rings and the Sun's glare are bright
};
