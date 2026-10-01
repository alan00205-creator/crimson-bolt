// stage5.js — STAGE 5 "LUNAR SIEGE" (月面攻防): the Moon, ground and air.
// World 'moon' (world.js): cratered highlands 0–300 (the rover tracks along the lanes) · rilles 300–560
// (two chasms across the play area, bridged by the lanes and the cross roads, chasms down both flanks) ·
// the great crater 560–780 (the mid-boss floor, clear |x| < 5.5) · lunar base 780–1000 · mass driver
// 1000–1240 · the mare 1240+ (the boss arena, flat and clear |x| < 9). Lanes are flat and clear at every
// distance, cross roads (d ≡ 20 mod 40) over 300–1240. Enemy types introduced here (models_s5.js):
//   s5_skimmer  crescent-winged skimmers: crescent formations that swing across the upper screen (aimed
//               orbs as they bottom out) and diving pairs that brake, fire a needle fan and peel away
//   s5_rover    assault rovers: up the lanes (twin laser bursts), rushing the jet (a 3-way), racing across
//               the cross roads, and rolled out of the landers' drop pods
//   s5_walker   quad striders on the lanes and cross roads: they crouch, charge the lance cannon (its coils
//               light up: the tell) and sweep a line of needles across the jet
//   s5_turret   crater turrets: an armoured hatch (shots spark off it) that opens; the gun rises, throws a
//               "bloom" ring of slow orbs that speed up as they spread, then a needle fan, and sinks again
//   s5_lander   dropships: descend over a lane, fire aimed fans and drop a cargo pod that lands and rolls
//               out a rover — kill the lander first and the rover never lands
//   selenite    mid-boss tunnelling machine: erupts from the crater floor; its drills throw bowed fans of
//               rock, its crystal crown fires prism shards that shatter into needles; it burrows and erupts
//               somewhere else (a dust trail and a ring mark the spot), then its crystal heart opens
//   selene      boss, the lunar fortress: a crescent hovering on lift jets round a domed citadel — horn
//               cannons (crescent volleys) and ridge batteries; then the dome opens on the solar mirror (a
//               sun-lance that locks on the jet and sweeps to one side: the beam trembles toward that side)
//               and the tide emitters (wide fans with a travelling gap); then the crystal heart
// Stage-1 carriers bring the items.
import { LANES_X, CROSS_ROAD_PERIOD } from './world.js';
import { STAGE_META } from './defs.js';
import { F } from './fx.js';
import { bez, W, makeTimeline, midbossEvent, bossDefeated } from './stage.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
/** derivative of the cubic bezier (stage.js bez) */
const bezD = (a, b, c, d, t) => { const u = 1 - t; return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c); };

// Enemy definitions (see the field list at the top of stage.js).
export const ENEMY = {
  s5_skimmer: { hp: 4, score: 300, radius: 0.8, air: true, explode: 0.9, debris: 6, medal: 0.2, prewarm: 14 },
  s5_rover: { hp: 12, score: 600, radius: 0.9, air: false, explode: 1.1, debris: 8, medal: 0.5, prewarm: 10 },
  s5_walker: { hp: 42, score: 2000, radius: 1.3, air: false, explode: 1.6, debris: 12, medal: 1, prewarm: 5 },
  s5_turret: { hp: 28, score: 1200, radius: 1.0, air: false, explode: 1.3, debris: 10, medal: 1, prewarm: 6 },
  s5_lander: { hp: 60, score: 2500, radius: 1.25, air: true, explode: 1.8, debris: 14, medal: 1, prewarm: 4 },
  // mid-boss: two drills and the crown, then the heart (sealed under its blast plates — not a target —
  // until two parts are gone or 18 s have passed). The body is armour and never a target (bodyTarget:
  // false); hp is only a backstop. keepOff holds the jet 9.5 below it: the drills reach ~4.5 in front of
  // it, so they stay beyond shoot()'s point-blank rule. hull: the carapace just aft of the crown.
  selenite: {
    hp: 9999, score: 40000, radius: 3.0, air: false, explode: 3.6, debris: 32, midboss: true, noRevenge: true, bodyTarget: false, keepOff: 9.5, prewarm: 1,
    parts: [
      { key: 'drillL', hp: 105, score: 5000, medals: 2, big: 1.6 }, { key: 'drillR', hp: 105, score: 5000, medals: 2, big: 1.6 },
      { key: 'crown', hp: 150, score: 8000, medals: 3, big: 1.8 },
      { key: 'core', hp: 640, score: 40000, medals: 3, core: true },
    ],
    hull: { hw: 1.9, z0: -5.0, z1: -4.1 },
  },
  // boss: parts in hit-test order. The tide emitters and the mirror start sealed (not targets) and count in
  // the HP bar from the start, like the heart (sealed until phase 3). hull: the crescent's back behind the
  // emitters; while the dome is shut the unit wears SELENE_DOMED, whose hull is the dome (shots spark off it).
  selene: {
    hp: 1, score: 0, radius: 5.5, air: false, explode: 5, debris: 40, boss: true, model: 'selene', prewarm: 1,
    parts: [
      { key: 'horn', list: true, hp: 300, score: 12000, medals: 3, big: 2.2 },
      { key: 'battery', list: true, hp: 110, score: 4000 },
      { key: 'bay', list: true, hp: 240, score: 8000, medals: 2, big: 1.8 },
      { key: 'mirror', hp: 620, score: 25000, medals: 4, big: 2.4 },
      { key: 'core', hp: 1650, core: true, score: 250000 },
    ],
    hull: { hw: 3.2, z0: -7.6, z1: -6.3 },
  },
};
const SELENE_DOMED = { ...ENEMY.selene, hull: { hw: 1.7, z0: -3.0, z1: 0.3 } };
const SELENITE_HIDDEN = { ...ENEMY.selenite, hull: null };      // under the floor: nothing to spark off

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// The top HUD is fixed CSS px (index.html: score strip ≈ 58 px, boss bar down to ≈ 102 px), so on short
// phones a row picked relative to zTop can sit under it. zAtRow gives the world z at height y that
// projects to CSS pixel row py (screen centre column): hover rows are kept at or below it. It works from the
// camera's rest pose (view.C, the view direction view.v, the fixed fov) instead of unprojecting through the
// camera: during a screen shake the camera stands up to ~0.9 off view.C and screenToPlane's ray (a point
// ~2 in front of the shaken camera, less view.C) swings by several units.
const HUD_ROW = 80;    // clear of the score strip
const BAR_ROW = 118;   // 16 px under the boss bar
function zAtRow(v, py, y = 0) {
  const f = v.v, k = (1 - (2 * py) / v.h) * Math.tan(v.camera.fov * Math.PI / 360);
  const dy = f.y - f.z * k, dz = f.z + f.y * k;             // the ray: forward + up·k (up = (0, −f.z, f.y))
  return v.C.z + dz * (-v.C.y / dy) * (1 - y / v.C.y);
}
const live = (pt) => (pt && !pt.dead ? pt : null);

// --------------------------------------------------------------------------------
// shared effects (constant colour / option tables: nothing is allocated per frame)
// --------------------------------------------------------------------------------
// No air on the Moon: dust doesn't billow, it sprays up in arcs and falls straight back (low drag,
// gravity), and it stays behind with the ground (scroll).
const DUST_A = [0.5, 0.5, 0.52, 0.55], DUST_B = [0.44, 0.44, 0.46, 0];
const DUST_OPT = { scroll: true, drag: 0.25, grav: 4.5 };
const RING_A = [0.9, 0.9, 0.95, 0.5], RING_B = [0.5, 0.5, 0.55, 0];
const FLAT_SCROLL = { flat: true, rot: 0, drag: 0, scroll: true };
const FLAT = { flat: true, rot: 0, drag: 0 };
const MARK_A = [1.6, 0.9, 0.3, 0.45], MARK_B = [2.2, 1.1, 0.35, 0.9];        // eruption mark (amber, flat)
const MOON_A = [0.9, 1.4, 2.6, 1], MOON_B = [0.2, 0.35, 0.8, 0];            // moonlight-blue glow
const SUN_A = [2.6, 2.0, 1.0, 1], SUN_B = [1.0, 0.5, 0.12, 0];              // focused sunlight
const SHARD_OPT = { drag: 2.2, stretch: 0.05 };
const FIRE_A = [1.8, 0.7, 0.2, 0.9], FIRE_B = [0.6, 0.12, 0.03, 0];
const FIRE_OPT = { scroll: true, drag: 0.4, grav: 1.2 };
const EMBER_A = [2.2, 1.0, 0.3, 1], EMBER_B = [0.9, 0.2, 0.05, 0];
const EMBER_OPT = { scroll: true, drag: 0.05, grav: 2.6 };                  // low gravity: long slow arcs
const ROCK_A = [0.34, 0.34, 0.36, 0.95], ROCK_B = [0.28, 0.28, 0.3, 0];
const ROCK_OPT = { scroll: true, drag: 0.05, grav: 2.6, vrot: 0 };
const NO_DRAG = { drag: 0 };
/** a puff of lunar dust at a ground point (world x, z) */
function dust(g, x, z, s, rate) {
  if (Math.random() > rate) return;
  g.fx.p.emit(x + rnd(-0.25, 0.25), g.GROUND_Y + 0.1, z + rnd(-0.2, 0.2), rnd(-0.6, 0.6), rnd(0.8, 1.9), rnd(-0.4, 0.4),
    rnd(0.5, 0.85), s * 0.4, s * 1.2, DUST_A, DUST_B, F.SMOKE, 2, DUST_OPT);
}
/** a spray of dust in a ring round a ground point (landings, eruptions), with a flat shock ring */
function dustBurst(g, x, z, n, sp, s) {
  const q = g.fx.lowQuality ? 0.6 : 1;
  for (let i = 0, m = Math.round(n * q); i < m; i++) {
    const a = rnd(0, TAU), v = rnd(0.4, 1) * sp;
    g.fx.p.emit(x + Math.cos(a) * 0.4, g.GROUND_Y + 0.1, z + Math.sin(a) * 0.4, Math.cos(a) * v, rnd(1.5, 4.5), Math.sin(a) * v,
      rnd(0.8, 1.4), s * 0.5, s * 1.6, DUST_A, DUST_B, F.SMOKE, 2, DUST_OPT);
  }
  g.fx.p.emit(x, g.GROUND_Y + 0.06, z, 0, 0, 0, 0.7, s, s * 4.5, RING_A, RING_B, F.RING, 1, FLAT_SCROLL);
}
/** rock and ember chunks thrown up in slow lunar arcs (the big blasts) */
function lunarDebris(g, x, y, z, n, sp) {
  const q = g.fx.lowQuality ? 0.5 : 1;
  for (let i = 0, m = Math.round(n * q); i < m; i++) {
    const a = rnd(0, TAU), v = rnd(0.3, 1) * sp, hot = Math.random() < 0.35;
    ROCK_OPT.vrot = rnd(-3, 3);
    g.fx.p.emit(x, y, z, Math.cos(a) * v, rnd(3, 7), Math.sin(a) * v, rnd(1.6, 2.6), rnd(0.25, 0.45), rnd(0.15, 0.3),
      hot ? EMBER_A : ROCK_A, hot ? EMBER_B : ROCK_B, hot ? F.GLOW : F.SHARD, hot ? 0 : 2, hot ? EMBER_OPT : ROCK_OPT);
  }
}

// --------------------------------------------------------------------------------
// s5_skimmer
// --------------------------------------------------------------------------------
// Crescent formation: n skimmers on an arc that trails its leader (the horns follow), the whole crescent
// swinging in from side `side`, dipping to zf of the screen and climbing out the other side. The even ones
// fire an aimed orb, one after another, as the crescent bottoms out.
function arcAI(side, k, n, zf = 0.36, dur = 4.4) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (!s.P) {
      const T = v.zTop, H = v.zBottom - v.zTop;
      s.P = [[side * 10.5, T - 3], [side * 4, T + zf * H * 1.33], [-side * 4, T + zf * H * 1.33], [-side * 10.5, T - 2]];
      s.u = n > 1 ? (k / (n - 1)) * 2 - 1 : 0;
      s.fireAt = 0.42 + Math.abs(s.u) * 0.14;
    }
    const u = e.t / dur;
    if (u < 1) {
      const P = s.P;
      const cx = bez(P[0][0], P[1][0], P[2][0], P[3][0], u), cz = bez(P[0][1], P[1][1], P[2][1], P[3][1], u);
      let tx = bezD(P[0][0], P[1][0], P[2][0], P[3][0], u), tz = bezD(P[0][1], P[1][1], P[2][1], P[3][1], u);
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const off = s.u * 2.7, back = s.u * s.u * 1.5;
      e.x = cx - tz * off - tx * back;
      e.z = cz + tx * off - tz * back;
    } else { e.x += e.vx * dt; e.z += e.vz * dt; }
    if (!s.fired && u > s.fireAt) {
      s.fired = true;
      if ((k & 1) === 0 && g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 7.4);
    }
  };
}
// Diving skimmer: drops in fast, brakes hard at zf of the screen, hangs a moment, fires a 3-needle fan at
// the jet and peels away to its side, climbing out.
function diveAI(x0, zf = 0.3) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.mode === undefined) {
      s.mode = 0; s.vz = 17; s.side = x0 > 0.3 ? 1 : x0 < -0.3 ? -1 : (Math.random() < 0.5 ? -1 : 1);
      s.zs = v.zTop + (v.zBottom - v.zTop) * zf; e.x = x0; e.z = v.zTop - 2.5;
    }
    if (s.mode === 0) {
      s.vz = Math.max(1.4, s.vz - dt * 15);
      e.z += s.vz * dt;
      if (e.z >= s.zs || s.vz <= 1.4) { s.mode = 1; s.mt = 0; }
    } else if (s.mode === 1) {
      s.mt += dt; e.z += 0.8 * dt;
      if (!s.fired && s.mt > 0.2) { s.fired = true; if (g.canFire(e)) g.fan(e.x, e.z, g.aim(e.x, e.z), 3, 0.28, 9.4, g.BK.NEEDLE); }
      if (s.mt > 0.55) { s.mode = 2; s.mt = 0; }
    } else {
      s.mt += dt;
      e.x += s.side * (2 + s.mt * 14) * dt; e.z -= (0.5 + s.mt * 7) * dt;
    }
  };
}

// --------------------------------------------------------------------------------
// s5_rover
// --------------------------------------------------------------------------------
/** twin-laser burst: `n` rounds 0.14 s apart from both barrels, aimed */
function roverBurst(e, dt, g, speed) {
  const s = e.s, ud = e.mesh.userData;
  if (!(s.burst > 0)) return;
  s.bt -= dt;
  if (s.bt <= 0) {
    s.bt = 0.14; s.burst--;
    if (g.canFire(e) && ud.turret) {
      for (let k = 0; k < 2; k++) { const m = g.muzzlePos(ud.turret, k); g.shoot(m.x, m.z, g.aim(m.x, m.z), speed); }
      const m = g.muzzlePos(ud.turret, 0);
      g.fx.muzzle(m.x, m.z, 0.9, 1.4, 2.6, 0.5);
    }
  }
}
// Up the lane (dir +1) or down it toward the jet (dir −1): twin-laser bursts every 2.4 s.
function roverLane(dir = 1, speed = 2.2) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData;
    if (s.ft === undefined) { s.ft = rnd(0.5, 1.1) / g.diff.fr; s.burst = 0; }
    e.gd += speed * dir * dt;
    e.yaw = dir > 0 ? 0 : Math.PI;
    g.aimTurret(e, ud.turret, dt, 3.5);
    s.ft -= dt;
    if (s.ft <= 0) { s.ft = 2.4 / g.diff.fr; s.burst = 2; s.bt = 0; }
    roverBurst(e, dt, g, 7.4);
    dust(g, e.gx + rnd(-0.5, 0.5), e.gz + dir * 1.1, 0.8, 0.35);
  };
}
// Rushing down a lane at the jet: one aimed 3-way as it comes in, a twin burst later if still well above it.
function roverRush(speed = 4.4, pause = 0) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    if (s.st === undefined) { s.st = 0; s.shots = 0; s.burst = 0; }
    s.st += dt;
    if (s.st > pause) e.gd -= speed * Math.min(1, (s.st - pause) * 2) * dt;
    e.yaw = Math.PI;
    g.aimTurret(e, ud.turret, dt, 6);
    if (s.shots === 0 && e.z > v.zTop + 3 && s.st > pause + 0.3) {
      s.shots = 1;
      if (g.canFire(e) && ud.turret) { const m = g.muzzlePos(ud.turret, 0); g.fan(m.x, m.z, g.aim(m.x, m.z), 3, 0.36, 7.8); }
    } else if (s.shots === 1 && e.z > v.zTop + 9 && e.z < g.player.z - 5) { s.shots = 2; s.burst = 2; s.bt = 0; }
    roverBurst(e, dt, g, 8.2);
    if (s.st > pause) dust(g, e.gx + rnd(-0.5, 0.5), e.gz - 1.1, 1.0, 0.5);
  };
}
// Racing across a cross road: one twin burst as it passes the middle.
function roverCross(dir, speed = 5.6) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData;
    if (s.burst === undefined) s.burst = 0;
    e.gx += dir * speed * dt;
    e.yaw = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.aimTurret(e, ud.turret, dt, 6);
    if (!s.fired && Math.abs(e.gx) < 5.5 && e.t > 0.4) { s.fired = true; s.burst = 2; s.bt = 0; }
    roverBurst(e, dt, g, 8.0);
    dust(g, e.gx - dir * 1.1, e.gz + rnd(-0.4, 0.4), 1.0, 0.6);
    if (Math.abs(e.gx) > 17 && e.t > 2) e.alive = false;
  };
}

// --------------------------------------------------------------------------------
// s5_walker
// --------------------------------------------------------------------------------
// Walks a lane (cross = false: dir +1 up-screen, −1 toward the jet) or a cross road (cross = true: dir
// +1 left → right). Every few seconds, once it is well above the jet: it crouches (0.3 s), charges the lance
// cannon (0.75 s: the coils light up, a low whine), then sweeps nine needles across the jet — the sweep
// runs from one side of the locked aim to the other, alternating — recovers and walks on. Two sweeps at most.
const WK_SWEEP = 1.1, WK_N = 9;
function walkerAI(dir = 1, cross = false, speed = 1.5) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, T = ud.turret, v = g.view;
    if (!s.mode) {
      s.mode = 'walk'; s.mt = 0; s.ph = rnd(0, TAU); s.cd = rnd(0.6, 1.2) / g.diff.fr; s.sweeps = 0; s.sd = Math.random() < 0.5 ? -1 : 1;
      if (ud.reset) ud.reset();
    }
    s.mt += dt;
    const walking = s.mode === 'walk';
    const pace = walking ? 1 : 0;
    if (cross) { e.gx += dir * speed * pace * dt; e.yaw = dir > 0 ? -Math.PI / 2 : Math.PI / 2; }
    else { e.gd += dir * speed * pace * dt; e.yaw = dir > 0 ? 0 : Math.PI; }
    if (walking) { s.ph += dt * speed * 3.4; if (ud.setWalk) ud.setWalk(s.ph, 1); }
    const P = g.player;
    switch (s.mode) {
      case 'walk':
        g.aimTurret(e, T, dt, 2.2);
        s.cd -= dt;
        if (s.cd <= 0 && s.sweeps < 2 && e.z > v.zTop + 3.5 && e.z < P.z - 6.5 && g.canFire(e)) { s.mode = 'brace'; s.mt = 0; }
        if (cross && Math.abs(e.gx) > 16 && e.t > 2) e.alive = false;
        break;
      case 'brace':
        if (ud.setBrace) ud.setBrace(s.mt / 0.3);
        g.aimTurret(e, T, dt, 2.2);
        if (s.mt > 0.3) { s.mode = 'charge'; s.mt = 0; g.audio.play('lock', { vol: 0.3, pitch: -4 }); }
        break;
      case 'charge':
        if (ud.setCharge) ud.setCharge(s.mt / 0.75);
        g.aimTurret(e, T, dt, 1.6);
        if (s.mt > 0.75) {
          s.mode = 'sweep'; s.mt = 0; s.k = 0; s.st = 0;
          const m = g.muzzlePos(T); s.a0 = g.aim(m.x, m.z); s.sd = -s.sd;
          g.audio.play('missile', { vol: 0.35, pitch: 6 });
        }
        break;
      case 'sweep': {
        s.st -= dt;
        const span = 0.5;                                  // the sweep lasts span seconds
        while (s.st <= 0 && s.k < WK_N) {
          s.st += span / (WK_N - 1);
          const ang = s.a0 + s.sd * (-0.5 + s.k / (WK_N - 1)) * WK_SWEEP;
          T.rotation.y = wrapA(ang + Math.PI - e.yaw);
          if (g.canFire(e)) { const m = g.muzzlePos(T); g.shoot(m.x, m.z, ang, 8.4, g.BK.NEEDLE); g.fx.muzzle(m.x, m.z, 0.9, 1.3, 2.6, 0.55); }
          s.k++;
        }
        if (ud.setCharge) ud.setCharge(1 - s.mt / span);
        if (s.k >= WK_N) { s.mode = 'recover'; s.mt = 0; s.sweeps++; if (ud.setCharge) ud.setCharge(0); }
        break;
      }
      default:   // recover
        if (ud.setBrace) ud.setBrace(1 - s.mt / 0.45);
        if (s.mt > 0.45) { s.mode = 'walk'; s.mt = 0; s.cd = 2.2 / g.diff.fr; }
    }
  };
}

// --------------------------------------------------------------------------------
// s5_turret
// --------------------------------------------------------------------------------
// A shut hatch in the regolith (armoured: shots spark off it) until it is on screen and well above the jet
// (and `delay` has passed). The doors slide apart, the gun rises (it can be hit from here on), throws a bloom
// ring — eight slow orbs that speed up as they spread — then an aimed fan of three needles, and sinks back.
// `cycles` pop-ups at most.
function popAI(delay = 0, cycles = 2) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, T = ud.turret, v = g.view, P = g.player;
    if (!s.mode) { s.mode = 'hidden'; s.mt = 0; s.left = cycles; s.cd = delay; e.invuln = true; if (ud.reset) ud.reset(); }
    s.mt += dt;
    switch (s.mode) {
      case 'hidden':
        e.invuln = true;
        s.cd -= dt;
        if (s.left > 0 && s.cd <= 0 && e.z > v.zTop + 2.5 && e.z < P.z - 7.5 && P.alive) {
          s.mode = 'open'; s.mt = 0; g.audio.play('lock', { vol: 0.22, pitch: -9 });
          if (T) T.rotation.y = wrapA(Math.atan2(-(P.x - e.x), -(P.z - e.z)) - e.yaw);
        }
        break;
      case 'open':
        if (ud.setOpen) ud.setOpen(s.mt / 0.35);
        if (Math.random() < 0.5) dust(g, e.gx + rnd(-0.8, 0.8), e.gz + rnd(-0.8, 0.8), 0.7, 1);
        if (s.mt > 0.35) { s.mode = 'rise'; s.mt = 0; e.invuln = false; }
        break;
      case 'rise':
        if (ud.setRise) ud.setRise(s.mt / 0.45);
        g.aimTurret(e, T, dt, 4);
        if (s.mt > 0.45) { s.mode = 'fire'; s.mt = 0; s.shot = 0; }
        break;
      case 'fire':
        g.aimTurret(e, T, dt, 3);
        if (s.shot === 0 && s.mt > 0.15) {
          s.shot = 1;
          if (g.canFire(e)) {
            const m = g.muzzlePos(T, 1), mx = m.x, mz = m.z, a0 = rnd(0, TAU), acc = 3.8 * g.diff.bs;
            for (let i = 0; i < 8; i++) {
              const a = a0 + (i / 8) * TAU, j = g.shoot(mx, mz, a, 1.1);
              if (j >= 0) { g.eb.ax[j] = Math.sin(a) * acc; g.eb.az[j] = Math.cos(a) * acc; }
            }
            g.fx.muzzle(mx, mz, 1.2, 1.6, 2.8, 1.1);
            g.audio.play('missile', { vol: 0.35, pitch: 4 });
          }
        } else if (s.shot === 1 && s.mt > 1.05) {
          s.shot = 2;
          if (g.canFire(e)) {
            const m = g.muzzlePos(T, 1), a = g.aim(m.x, m.z);
            g.fan(m.x, m.z, a, 3, 0.26, 9.0, g.BK.NEEDLE);
            g.fx.muzzle(m.x, m.z, 0.9, 1.3, 2.6, 0.7);
          }
        }
        if (s.mt > 1.9) { s.mode = 'sink'; s.mt = 0; }
        break;
      case 'sink':
        if (ud.setRise) ud.setRise(1 - s.mt / 0.45);
        if (s.mt > 0.25) e.invuln = true;
        if (s.mt > 0.45) { s.mode = 'shut'; s.mt = 0; }
        break;
      default:   // shut
        if (ud.setOpen) ud.setOpen(1 - s.mt / 0.3);
        if (s.mt > 0.3) { s.mode = 'hidden'; s.mt = 0; s.left--; s.cd = 1.4 / g.diff.fr; }
    }
  };
}

// --------------------------------------------------------------------------------
// s5_lander
// --------------------------------------------------------------------------------
// Descends over lane `lane` (the lander's x is the lane's: its pod lands on it) to a hover row, fires an
// aimed 3-way twice, drops its cargo pod — it falls to the regolith, lands in a spray of dust and a rover
// rolls out of it at the jet — and burns away up the screen.
const LD_POD_Y = -0.98, LD_FALL = 0.62;
function landerAI(lane, zf = 0.24, carry = true) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.mode) {
      s.mode = 'in'; s.mt = 0; s.fixedYaw = true; s.yaw = Math.PI; s.x = LANES_X[lane]; s.carry = carry; s.shots = 0;
      s.z0 = v.zTop - 3; s.z1 = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 1.4);
      e.x = s.x; e.z = s.z0;
      if (ud.reset) ud.reset();
      if (ud.setPod) ud.setPod(LD_POD_Y, carry);
    }
    s.mt += dt;
    if (s.mode === 'in') {
      const k = ease(s.mt / 2.0);
      e.z = s.z0 + (s.z1 - s.z0) * k; e.x = s.x;
      if (ud.setThrust) ud.setThrust(0.5 + 0.5 * (1 - k));
      if (s.mt > 2.0) { s.mode = 'hover'; s.mt = 0; }
    } else if (s.mode === 'hover') {
      e.x = s.x + Math.sin(s.mt * 1.3) * 0.12; e.z = s.z1 + Math.sin(s.mt * 1.9) * 0.1;
      if (ud.setThrust) ud.setThrust(0.45 + Math.sin(s.mt * 5) * 0.08);
      const fr = g.diff.fr;
      if ((s.shots === 0 && s.mt > 0.45 / fr) || (s.shots === 1 && s.mt > 2.3 / fr)) {
        s.shots++;
        if (g.canFire(e)) {
          for (let k = 0; k < 2; k++) { const m = g.muzzlePos(e.mesh, k); g.fan(m.x, m.z, g.aim(m.x, m.z), 3, 0.4, 7.0); g.fx.muzzle(m.x, m.z, 0.9, 1.4, 2.6, 0.6); }
          g.audio.play('lock', { vol: 0.22 });
        }
      }
      if (s.carry && s.mt > 1.2) { s.carry = false; s.mode = 'drop'; s.mt = 0; g.audio.play('missile', { vol: 0.3, pitch: -6 }); }
      if (s.mt > 3.0) { s.mode = 'out'; s.mt = 0; }
    } else if (s.mode === 'drop') {
      // the pod falls to the ground (it hangs from the lander's pivot, which bobs with the hover)
      e.x = s.x; e.z = s.z1;
      const k = clamp(s.mt / LD_FALL, 0, 1), piv = e.mesh.children[0] ? e.mesh.children[0].position.y : 0;
      const floor = g.GROUND_Y + 0.22 - (e.s.y || 0) - piv;
      if (ud.setPod) ud.setPod(LD_POD_Y + (floor - LD_POD_Y) * k * k, true);
      if (k >= 1) {
        if (ud.setPod) ud.setPod(LD_POD_Y, false);
        dustBurst(g, s.x, e.z, 14, 3.5, 1.2);
        g.fx.explosion(s.x, g.GROUND_Y + 0.3, e.z, 0.6, { ground: true });
        g.audio.play('explodeS', { vol: 0.4, pitch: -8 });
        g.spawn('s5_rover', { gx: s.x, gd: g.world.distance - e.z, yaw: Math.PI, ai: roverRush(3.8, 0.45) });
        s.mode = 'hover'; s.mt = 1.3;
      }
    } else {
      e.z -= (1.5 + s.mt * 7) * dt;
      if (ud.setThrust) ud.setThrust(1);
    }
    if (e.hp < e.maxHp * 0.5 && Math.random() < 0.2) g.fx.smokePuff(e.x + rnd(-0.6, 0.6), 0.2, e.z + rnd(-0.4, 0.4), 0.4, 0.7);
  };
}

// --------------------------------------------------------------------------------
// mid-boss: SELENITE, the tunnelling machine (the great crater's floor)
// --------------------------------------------------------------------------------
// Rumbles under the floor at its station (dust, a mark on the ground), then erupts (a ring of rocks). It
// holds the crater drifting after the jet: the drills take turns spinning up (the tell) and throw a bowed
// fan of rocks; the crystal crown launches a prism shard that flies part of the way to the jet and shatters
// into a needle fan. Twice it burrows: it sinks, a dust trail runs under the floor to a new spot, the mark
// appears and it erupts there. Its blast plates blow once two parts are gone (or 18 s): the heart spins a
// twin spiral, at half HP rings join in. After SN_FIGHT s it burrows away for good. Sets g.midbossDone on
// death and on that retreat.
const SN_ROW = 12.5, SN_DEPTH = 4.4, SN_FIGHT = 44, SN_BURROW = [12, 28];
function hideParts(e, on) {
  e.def = on ? SELENITE_HIDDEN : ENEMY.selenite;
  for (const pt of e.parts) {
    if (on) { if (!pt.hid) { pt.hid = true; pt.dead = true; } }
    else if (pt.hid) { pt.hid = false; pt.dead = !!pt.obj.userData.destroyed || (pt.core && !e.s.opened); }
  }
}
/** a rumble at the machine's footprint (under the floor), with the eruption mark growing on it */
function rumble(g, e, k) {
  if (Math.random() < 0.6) dust(g, e.gx + rnd(-2, 2), e.gz + rnd(-2.6, 2.6), 1.1, 1);
  if (Math.random() < 0.08 + k * 0.2) g.fx.p.emit(e.x, 0.02, e.z, 0, 0, 0, 0.3, 3 + k * 4, 5 + k * 5, MARK_A, MARK_B, F.RING, 0, FLAT);
  g.shake.add(0.012 + k * 0.02);
}
function erupt(g, e, ring) {
  dustBurst(g, e.gx, e.gz, 26, 5.5, 2.2);
  lunarDebris(g, e.gx, g.GROUND_Y + 0.5, e.gz, 16, 4);
  g.fx.explosion(e.gx, g.GROUND_Y + 0.6, e.gz - 1.5, 1.4, { ground: true, debris: 10, color: e.mesh.userData.debrisColor });
  g.fx.shockwave(e.x, 0.1, e.z, 12, [1.8, 1.8, 2.0, 1], 0.6);
  g.shake.add(0.5); g.audio.play('explodeL', { vol: 0.8 });
  if (ring && g.canFire(e)) g.ring(e.x, e.z, 12, 3.4, rnd(0, TAU), g.BK.BIG);
}
function seleniteAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view, P = g.player;
    if (!s.init) {
      s.init = true; s.mode = 'emerge'; s.mt = 0; s.life = 0; s.fightT = 0; s.opened = false; s.a = 0; s.b = 0; s.burrows = 0;
      s.dl = g.partByKey(e, 'drillL'); s.dr = g.partByKey(e, 'drillR'); s.crown = g.partByKey(e, 'crown'); s.core = g.partByKey(e, 'core');
      s.dtm = 1.6; s.side = 0; s.ct = 3.4; s.spin = [0, 0]; s.lgx = e.gx; s.y = -SN_DEPTH; s.first = true;
      e.armored = true; e.invuln = true;
      if (ud.reset) ud.reset();
      hideParts(e, true);
    }
    s.life += dt; s.mt += dt;
    if (e.dying) { seleniteDeath(e, dt, g); return; }
    const stationGz = v.pToGz(v.zTop + SN_ROW);
    e.gd = g.world.distance - stationGz;
    e.yaw = Math.PI;
    if (ud.setRumble) ud.setRumble(s.mode === 'fight' ? 0 : 1);
    switch (s.mode) {
      case 'emerge': {                                  // under the floor, rumbling; then it breaks out
        const tell = s.first ? 1.6 : 1.1;
        if (s.mt < tell) { rumble(g, e, s.mt / tell); s.y = -SN_DEPTH; }
        else {
          if (!s.erupted) { s.erupted = true; erupt(g, e, !s.first); }
          const k = ease((s.mt - tell) / 0.7);
          s.y = -SN_DEPTH * (1 - k);
          if (s.y > -1.2 && e.parts[0].hid) hideParts(e, false);
          if (Math.random() < 0.7) dust(g, e.gx + rnd(-2, 2), e.gz + rnd(-2.8, 2.8), 1.4, 1);
          if (s.mt > tell + 0.75) { s.mode = 'fight'; s.mt = 0; s.first = false; s.erupted = false; s.y = 0; e.invuln = false; if (e.parts[0].hid) hideParts(e, false); }
        }
        break;
      }
      case 'sink': {                                    // burrowing: down into the floor, dust flying
        const k = smooth(s.mt / 0.9);
        s.y = -SN_DEPTH * k * k;
        if (Math.random() < 0.8) dust(g, e.gx + rnd(-2, 2), e.gz + rnd(-2.8, 2.8), 1.5, 1);
        if (s.y < -1.2) { hideParts(e, true); e.invuln = true; }
        if (s.mt > 0.9) {
          s.y = -SN_DEPTH;
          if (s.leaving) { e.alive = false; g.midbossDone = true; return; }
          s.mode = 'tunnel'; s.mt = 0; s.fx0 = e.gx;
          const px = clamp(v.pToGx(P.x) * 0.5, -1.8, 1.8);
          s.fx1 = Math.abs(px - e.gx) > 1.2 ? px : clamp(-Math.sign(e.gx || 1) * rnd(1.0, 1.8), -1.8, 1.8);
        }
        break;
      }
      case 'tunnel': {                                  // a dust trail runs under the floor to the new spot
        const k = smooth(s.mt / 1.3);
        e.gx = s.fx0 + (s.fx1 - s.fx0) * k;
        dust(g, e.gx + rnd(-0.6, 0.6), e.gz + rnd(-1.4, 1.4), 1.3, 0.9);
        if (s.mt > 1.3) { s.mode = 'emerge'; s.mt = 0; }
        break;
      }
      default: {                                        // fight
        s.fightT += dt;
        const tx = clamp(v.pToGx(P.x) * 0.35 + Math.sin(s.fightT * 0.5) * 1.2, -1.8, 1.8);
        e.gx += clamp(tx - e.gx, -1.2 * dt, 1.2 * dt);
        if (Math.random() < 0.35) dust(g, e.gx + (Math.random() < 0.5 ? -2.0 : 2.0), e.gz - 3.0, 1.0, 1);
        if (s.fightT > SN_FIGHT) { s.mode = 'sink'; s.mt = 0; s.leaving = true; g.audio.play('warning', { vol: 0.3 }); break; }
        if (s.burrows < SN_BURROW.length && s.fightT > SN_BURROW[s.burrows] && s.spin[0] === 0 && s.spin[1] === 0) {
          s.burrows++; s.mode = 'sink'; s.mt = 0;
          dustBurst(g, e.gx, e.gz, 16, 3.5, 1.8); g.audio.play('explodeM', { vol: 0.6, pitch: -5 }); g.shake.add(0.3);
          break;
        }
        seleniteFight(e, dt, g);
      }
    }
    s.lgx = e.gx;
    if (ud.setSpin) { ud.setSpin(0, s.spin[0]); ud.setSpin(1, s.spin[1]); }
  };
}
const SN_ROCK = [4.6, 5.3, 6.0, 5.3, 4.6];
function seleniteFight(e, dt, g) {
  const s = e.s, ud = e.mesh.userData, fr = g.diff.fr;
  const L = live(s.dl), R = live(s.dr), C = live(s.crown), core = s.core;
  // the blast plates blow: two parts gone, or 18 s into the fight
  const lost = (L ? 0 : 1) + (R ? 0 : 1) + (C ? 0 : 1);
  if (!s.opened && (lost >= 2 || s.fightT > 18)) {
    s.opened = true; e.armored = false;
    if (core) { core.dead = false; if (core.obj.userData.setOpen) core.obj.userData.setOpen(1); }
    const cm = g.muzzlePos(core.obj);
    g.fx.explosion(cm.x, 0.4, cm.z, 1.6, { debris: 14, color: ud.debrisColor });
    g.fx.shockwave(cm.x, 0.1, cm.z, 8, [1.2, 1.8, 2.6, 1], 0.5);
    g.audio.play('explodeM'); g.audio.play('warning', { vol: 0.35 });
    g.shake.add(0.35); g.ui.flash(0.2);
  }
  if (!g.canFire(e)) { s.spin[0] = s.spin[1] = 0; return; }
  const rage = s.opened && core && core.hp < core.maxHp * 0.5;
  // drills: take turns — spin up 0.6 s (the tell: the bit screams, sparks at the tip), then a bowed fan of rocks
  for (let k = 0; k < 2; k++) {
    const pt = k ? R : L;
    if (!pt) { s.spin[k] = 0; continue; }
    if (s.spin[k] > 0) {
      s.spin[k] = Math.min(1, s.spin[k] + dt / 0.6);
      const m = g.muzzlePos(pt.obj);
      if (Math.random() < 0.5) g.fx.hitSpark(m.x, 0.4, m.z, 1.0, 0.7, 0.4, 1);
      if (s.spin[k] >= 1) {
        s.spin[k] = 0;
        const mx = m.x, mz = m.z, a = g.aim(mx, mz);
        for (let i = 0; i < 5; i++) g.shoot(mx, mz, a + (i / 4 - 0.5) * 0.8, SN_ROCK[i], g.BK.BIG);
        g.fx.muzzle(mx, mz, 2.0, 1.4, 0.8, 1.1);
        g.fx.p.emit(mx, 0.3, mz, 0, 0, 0, 0.4, 1, 2.6, ROCK_A, ROCK_B, F.SMOKE, 2, NO_DRAG);
        g.audio.play('explodeS', { vol: 0.5, pitch: -6 });
      }
    }
  }
  if (s.spin[0] === 0 && s.spin[1] === 0) s.dtm -= dt;
  if (s.dtm <= 0) {
    s.dtm = ((L && R) ? 1.5 : 1.9) * (rage ? 0.85 : 1) / fr;
    const use = s.side ? (R ? 1 : L ? 0 : -1) : (L ? 0 : R ? 1 : -1);
    if (use >= 0) { s.spin[use] = 0.01; g.audio.play('lock', { vol: 0.28, pitch: -8 }); }
    s.side ^= 1;
  }
  // crown: a prism shard flies part of the way to the jet and shatters into a fan of needles
  if (C) {
    s.ct -= dt;
    if (s.ct <= 0) { s.ct = (rage ? 3.4 : 4.2) / fr; prismShard(g, e, C); }
  }
  // the open heart
  if (s.opened && core && !core.dead) {
    const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
    s.st = (s.st ?? 0.6) - dt;
    if (s.st <= 0) {
      s.st = (rage ? 0.14 : 0.17) / fr;
      s.a += rage ? -0.29 : 0.26;
      const arms = rage ? 3 : 2;
      for (let i = 0; i < arms; i++) g.shoot(cx, cz, s.a + (i / arms) * TAU, 4.9);
    }
    if (rage) {
      s.rt = (s.rt ?? 1.2) - dt;
      if (s.rt <= 0) { s.rt = 3.0 / fr; s.b += 0.4; g.ring(cx, cz, 14, 5.0, s.b); }
    }
  }
}
const SHARD_A = [1.4, 2.0, 3.0, 1], SHARD_B = [1.8, 2.4, 3.2, 1];
const SHARD_FLY = { drag: 0, vrot: 9 };
function prismShard(g, e, C) {
  const m = g.muzzlePos(C.obj), mx = m.x, mz = m.z, P = g.player;
  const k = 0.45, tx = mx + (P.x - mx) * k, tz = mz + (P.z - mz) * k, fuse = 0.85;
  const vx = (tx - mx) / fuse, vz = (tz - mz) / fuse;
  g.fx.p.emit(mx, 0.3, mz, vx, 0, vz, fuse, 0.7, 1.1, SHARD_A, SHARD_B, F.SHARD, 0, SHARD_FLY);
  g.fx.p.emit(mx, 0.3, mz, vx, 0, vz, fuse, 1.3, 1.9, MOON_A, MOON_A, F.GLOW, 0, NO_DRAG);
  g.audio.play('lock', { vol: 0.3, pitch: 7 });
  g.later(fuse, () => {
    if (!e.alive || e.dying) return;
    const a = g.aim(tx, tz);
    g.fan(tx, tz, a, 5, 0.8, 7.0, g.BK.NEEDLE);
    g.fx.sparkle(tx, tz, 1.5, 2.2, 3.2, 1.6, 0.4);
    for (let i = 0; i < 8; i++) { const b = rnd(0, TAU), sp = rnd(4, 9); g.fx.p.emit(tx, 0.3, tz, Math.cos(b) * sp, 0, Math.sin(b) * sp, rnd(0.2, 0.4), 0.4, 0.1, SHARD_B, MOON_B, F.SHARD, 0, SHARD_OPT); }
    g.audio.play('hitArmor', { vol: 0.5 });
  });
}
// Death: the heart shatters (moonlight shards), blasts run over the carapace, it sinks back into its hole
// in a spray of dust and rock, a final blast.
function seleniteDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  if (!s.dieT) {
    s.dieT = 0;
    s.y0 = Math.min(0, s.y || 0);                       // killed mid-burrow/emerge: sink on from where it is
    const cm = g.muzzlePos(s.core.obj), cx = cm.x, cz = cm.z;
    for (let i = 0; i < 22; i++) { const b = rnd(0, TAU), sp = rnd(5, 13); g.fx.p.emit(cx, 0.5, cz, Math.cos(b) * sp, rnd(0, 3), Math.sin(b) * sp, rnd(0.4, 0.8), rnd(0.5, 0.8), 0.1, SHARD_B, MOON_B, F.SHARD, 0, SHARD_OPT); }
    g.fx.p.emit(cx, 0.5, cz, 0, 0, 0, 0.3, 2, 8, MOON_A, MOON_B, F.GLOW, 0, NO_DRAG);
    s.spin[0] = s.spin[1] = 0;
  }
  s.dieT += dt;
  const t = s.dieT;
  if (ud.setRumble) ud.setRumble(1);
  s.y = Math.min(s.y0, s.y0 + (-2.0 - s.y0) * smooth((t - 0.5) / 1.6));
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0 && t < 1.9) {
    s.boomT = 0.11;
    g.fx.explosion(e.gx + rnd(-1.8, 1.8), g.GROUND_Y + rnd(0.8, 2.0), e.gz + rnd(-2.6, 2.6), rnd(1.0, 1.7), { ground: true });
    g.audio.play('explodeM', { vol: 0.7 });
    g.shake.add(0.12);
  }
  if (Math.random() < 0.8) dust(g, e.gx + rnd(-2.2, 2.2), e.gz + rnd(-3, 3), 1.6, 1);
  if (Math.random() < 0.4) g.fx.p.emit(e.gx + rnd(-1.5, 1.5), g.GROUND_Y + 1.8, e.gz + rnd(-2, 2), rnd(-0.4, 0.4), rnd(1.5, 3), rnd(-0.3, 0.3), rnd(0.4, 0.7), 0.8, 2.0, FIRE_A, FIRE_B, F.FIRE, 1, FIRE_OPT);
  if (t > 1.9) {
    g.fx.explosion(e.gx, g.GROUND_Y + 1.0, e.gz, 4, { ground: true, debris: 30, color: ud.debrisColor });
    dustBurst(g, e.gx, e.gz, 30, 6, 2.6);
    lunarDebris(g, e.gx, g.GROUND_Y + 1, e.gz, 20, 5);
    g.fx.shockwave(e.x, 0.1, e.z, 18, [2.0, 2.0, 2.4, 1], 0.8);
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
function spawnSelenite(g) {
  const e = g.spawn('selenite', { gx: 0, gd: g.world.distance - g.view.pToGz(g.view.zTop + SN_ROW), yaw: Math.PI, ai: seleniteAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key === 'drillL' || pt.key === 'drillR') g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    else if (pt.key === 'crown') g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' });
  };
  return e;
}

// --------------------------------------------------------------------------------
// boss: SELENE, the lunar fortress (the mare)
// --------------------------------------------------------------------------------
//   p1  the crescent: the horn cannons take turns firing crescent volleys (seven rocks in a fan whose edges
//       fly faster than its middle, so the fan bows into a crescent round the jet; the horn's barrels glow
//       amber for half a second before) chased by a needle pair; the ridge batteries fire 2-round twin
//       bursts. The dome is shut (shots spark off it).
//   p2  horns and batteries down (or 44 s): the dome swings open and the solar mirror rises; the tide
//       emitters in the crescent's back open. The mirror tracks the jet (a faint beam), locks (the beam
//       flares, trembling toward the side it will sweep to), then sweeps a dense sun-lance of needles 1.1 rad
//       across to that side: step to the other side of the line. Between lances the emitters take turns
//       with wide fans of orbs with a two-orb gap that drifts back and forth like a tide.
//   p3  mirror and emitters down (or 44 s): the crystal heart rises out of the citadel. 9-s cycles: a
//       three-arm spiral that turns back every 1.8 s (waxing, waning), then rings with a crescent-shaped gap
//       that turns ring by ring (the moon's phases), then a breather with an aimed fan; below 40 % an
//       "eclipse" every 7 s: the heart goes dark for a moment, then a double ring and two homing mines.
// Guns left over from earlier phases keep firing, slower. Death: the lift jets fail and the fortress slams
// onto the mare, blasts run round the crescent, it breaks in two at the spine, rock and embers fly in slow
// lunar arcs, a final blast.
const SE_TEMPO = 0.7;                  // leftover guns' rate in p2 (p3: 0.5)
// p1's crescent volleys: one every HORN_GAP s (÷ diff.fr, the horns taking turns), CRES_N rocks across a fan
// CRES_W rad either side of the aim (0.5 left gaps too tight to read: the volleys alone made stage 5 the
// hardest of 4–6); the horn that fires next glows at its barrels for the last HORN_TELL s (and clicks as it
// starts to charge)
const HORN_GAP = 3.2, HORN_TELL = 0.5, CRES_N = 7, CRES_W = 0.58;
function seleneAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.enterT = 0; s.ph = 0; s.pt = 0; s.sway = 0; s.a = 0; s.b = 0; s.c = 0;
      s.dome = 0; s.rise = 0; s.heart = 0; s.hornT = 1.6; s.hk = 0; s.gun = 'off'; s.gunT = 0; s.bayT = 1.5; s.bk = 0; s.tide = 0; s.cyc = 0;
      s.horn = [0, 1].map((i) => g.partByKey(e, 'horn' + i));
      s.bat = [0, 1, 2, 3].map((i) => g.partByKey(e, 'battery' + i));
      s.bay = [0, 1].map((i) => g.partByKey(e, 'bay' + i));
      s.mir = g.partByKey(e, 'mirror'); s.core = g.partByKey(e, 'core');
      s.sealed = [s.bay[0], s.bay[1], s.mir, s.core];
      for (const pt of s.sealed) if (pt) pt.dead = true;          // sealed: out of the hit list (the HP bar still counts them)
      e.def = SELENE_DOMED; e.invuln = true; e.armored = true;
      // station: the crescent's back (≈ 7.4 up-screen of the unit on the plane) stays below the boss bar
      const zs = Math.max(v.zTop + 10.5, zAtRow(v, BAR_ROW) + 7.8);
      s.stationGz = v.pToGz(zs); s.fromGz = v.gTop - 12;
      e.gx = 0;
      if (ud.reset) ud.reset();
    }
    // HP bar: every part (sealed ones count at full health)
    let hp = 0, max = 0;
    for (let i = 0; i < e.parts.length; i++) { const pt = e.parts[i]; max += pt.maxHp; hp += Math.max(0, pt.hp); }
    g.ui.setBossHP(max > 0 ? hp / max : 0);
    if (e.dying) { seleneDeath(e, dt, g); return; }
    const D = g.world.distance, P = g.player;
    // the lift jets kick up the mare's dust under the crescent
    liftDust(g, e, s.mode === 'enter' ? 0.9 : 0.45);
    if (s.mode === 'enter') {
      s.enterT += dt;
      const k = ease(s.enterT / 5.5);
      e.gd = D - (s.fromGz + (s.stationGz - s.fromGz) * k);
      s.rum = (s.rum || 0) - dt;
      if (s.rum <= 0) { s.rum = 0.2; g.shake.add(0.05 * (1 - k * 0.6)); }
      for (let i = 0; i < 2; i++) if (s.horn[i]) aimPart(e, s.horn[i], P, dt, 0.8);
      if (s.enterT >= 5.5) { s.mode = 'p1'; s.ph = 0; e.invuln = false; g.audio.play('explodeL', { vol: 0.5 }); g.shake.add(0.35); }
      return;
    }
    s.pt += dt; s.ph += dt;
    // station keeping: a slow sway that widens as it loses its armament
    const want = s.mode === 'p1' ? 1.6 : s.mode === 'p2' ? 2.1 : 2.6;
    s.sway += (want - s.sway) * Math.min(1, dt * 0.4);
    e.gx = Math.sin(s.pt * 0.26) * s.sway;
    e.gd = D - (s.stationGz + Math.sin(s.pt * 0.37) * 0.5);
    const fr = g.diff.fr, hard = g.loop > 1;
    const H = s.horn, B = s.bat;
    let p1left = 0;
    for (let i = 0; i < 2; i++) if (live(H[i])) p1left++;
    for (let i = 0; i < 4; i++) if (live(B[i])) p1left++;
    // phase changes
    if (s.mode === 'p1' && (p1left === 0 || s.ph > 44)) {
      s.mode = 'p2'; s.ph = 0; s.revealT = 0;
      g.audio.play('warning', { vol: 0.5 }); g.shake.add(0.35);
    }
    const M = live(s.mir), Y0 = live(s.bay[0]), Y1 = live(s.bay[1]);
    if (!M && s.gun !== 'off') s.gun = 'off';
    if (s.mode === 'p2' && s.revealT > 2 && ((!M && !Y0 && !Y1) || s.ph > 44)) {
      s.mode = 'p3'; s.ph = 0; s.cyc = 0; s.heartT = 0;
      if (M) { M.obj.userData.setBeam(0); M.obj.userData.setCharge(0); }
      s.gun = 'off';
      g.shake.add(0.6); g.ui.flash(0.35); g.audio.play('explodeL'); g.audio.play('warning', { vol: 0.5 });
    }
    // the dome, the mirror, the emitters and the heart
    if (s.mode !== 'p1') {
      s.revealT = (s.revealT || 0) + dt;
      s.dome = Math.min(1, s.dome + dt / 1.6);
      if (ud.setDome) ud.setDome(s.dome);
      if (s.mode === 'p2' && s.rise < 1) { s.rise = Math.min(1, s.rise + dt / 1.8); if (s.mir && !s.mir.obj.userData.destroyed) s.mir.obj.userData.setRise(s.rise); }
      if (e.def !== ENEMY.selene && s.dome > 0.5) e.def = ENEMY.selene;
      if (s.mode === 'p2' && s.revealT > 1.8 && !s.revealed) {
        s.revealed = true;
        for (const pt of [s.mir, s.bay[0], s.bay[1]]) if (pt && pt.dead && !pt.obj.userData.destroyed) pt.dead = false;
        for (const pt of s.bay) if (pt && pt.obj.userData.setOpen) pt.obj.userData.setOpen(1);
        g.audio.play('lock', { vol: 0.5, pitch: -6 }); g.shake.add(0.2);
        s.gun = 'track'; s.gunT = 0;
      }
    }
    if (s.mode === 'p3') {
      s.heartT += dt;
      s.heart = Math.min(1, s.heartT / 1.4);
      if (s.core && s.core.obj.userData.setOpen) s.core.obj.userData.setOpen(s.heart);
      if (s.heart >= 1 && s.core && s.core.dead && !s.core.obj.userData.destroyed) { s.core.dead = false; g.audio.play('lock', { vol: 0.5, pitch: -3 }); }
    }
    e.armored = !(s.mode === 'p3' && s.heart >= 1);
    // guns track the jet
    for (let i = 0; i < 2; i++) { const h = live(H[i]); if (h) aimPart(e, h, P, dt, 1.1); }
    for (let i = 0; i < 4; i++) { const b = live(B[i]); if (b) aimPart(e, b, P, dt, 2.2); }
    const mu = M && M.obj.userData;
    if (!g.canFire(e)) {
      if (mu) { mu.setBeam(0); mu.setCharge(0); }
      if (s.gun === 'lock' || s.gun === 'sweep') { s.gun = 'cool'; s.gunT = 0; }
      return;
    }
    const late = s.mode === 'p1' ? 1 : s.mode === 'p2' ? SE_TEMPO : 0.5;
    // horn cannons: crescent volleys, alternating
    if (live(H[0]) || live(H[1])) {
      s.hornT -= dt * late;
      const h = live(H[s.hk ^ 1]) || live(H[s.hk]);           // the horn that fires next
      if (s.hornT < HORN_TELL) hornTell(g, s, h, 1 - Math.max(0, s.hornT) / HORN_TELL);
      if (s.hornT <= 0) {
        s.hornT = HORN_GAP / fr; s.told = false;
        s.hk ^= 1;
        crescentVolley(g, e, h);
      }
    }
    // ridge batteries: staggered 3-round twin bursts
    for (let i = 0; i < 4; i++) {
      const b = live(B[i]);
      if (!b) continue;
      b.fireT -= dt * late;
      if (b.fireT <= 0) { b.fireT = (3.2 + i * 0.3) / fr; b.burst = 2; b.bt = 0; }
      if (b.burst > 0) {
        b.bt -= dt;
        if (b.bt <= 0) {
          b.bt = 0.12; b.burst--;
          for (let q = 0; q < 2; q++) { const m = g.muzzlePos(b.obj, q); g.shoot(m.x, m.z, g.aim(m.x, m.z), 8.0); }
        }
      }
    }
    // the solar mirror's sun-lance
    if (M && s.revealed) sunLance(e, dt, g, M, fr);
    // tide emitters: between lances, the two take turns with wide fans that have a drifting two-orb gap
    if (s.revealed && (Y0 || Y1) && s.gun !== 'lock' && s.gun !== 'sweep') {
      s.bayT -= dt * (s.mode === 'p3' ? 0.6 : 1);
      if (s.bayT <= 0) {
        s.bayT = (M ? 1.3 : 1.0) / fr;
        s.bk ^= 1;
        const y = (s.bk ? Y1 : Y0) || Y0 || Y1;
        s.tide += 1;
        const n = hard ? 13 : 11, gap = Math.round((n - 2) / 2 + Math.sin(s.tide * 0.9) * ((n - 2) / 2 - 1.5));
        const m = g.muzzlePos(y.obj), mx = m.x, mz = m.z, a = g.aim(mx, mz), spread = 1.4;
        for (let i = 0; i < n; i++) { if (i === gap || i === gap + 1) continue; g.shoot(mx, mz, a + (i / (n - 1) - 0.5) * spread, 4.3); }
        g.fx.muzzle(mx, mz, 0.9, 1.4, 2.6, 1.0);
      }
    }
    if (s.mode === 'p3' && s.core && !s.core.dead) heartPatterns(e, dt, g, fr, hard);
  };
}
/** yaw a boss part (its model group, parented to a crescent half) toward the jet at up to `rate` rad/s */
function aimPart(e, pt, P, dt, rate) {
  const want = wrapA(Math.atan2(-(P.x - pt.x), -(P.z - pt.z)) - e.yaw);
  pt.obj.rotation.y += clamp(wrapA(want - pt.obj.rotation.y), -rate * dt, rate * dt);
}
const LIFT_PTS = [[-3.2, -3.6], [3.2, -3.6], [-5.0, -0.4], [5.0, -0.4], [-1.3, 0.2], [1.3, 0.2]];
function liftDust(g, e, rate) {
  const lp = LIFT_PTS[(Math.random() * LIFT_PTS.length) | 0];
  dust(g, e.gx + lp[0] + rnd(-0.6, 0.6), e.gz + lp[1] + rnd(-0.6, 0.6), 1.6, rate);
}
const TELL_A = [2.6, 1.7, 0.7, 1], TELL_B = [1.4, 0.6, 0.15, 0];          // a horn's barrels charging (amber)
/** the next crescent volley's tell: its horn's barrels glow brighter as it nears (k: 0 → 1) */
function hornTell(g, s, h, k) {
  if (!s.told) { s.told = true; g.audio.play('lock', { vol: 0.35, pitch: -9 }); }
  if (Math.random() < 0.5) return;
  for (let q = 0; q < 2; q++) {
    const m = g.muzzlePos(h.obj, q);
    g.fx.p.emit(m.x, 0.3, m.z, 0, 0, 0, 0.12, 0.4 + 0.9 * k, 0.3 + 0.7 * k, TELL_A, TELL_B, F.GLOW, 0, NO_DRAG);
  }
}
// CRES_N rocks in a fan whose edges fly faster than its middle: the fan bows into a crescent round the jet;
// a needle pair down the barrels' line follows it
function crescentVolley(g, e, h) {
  if (!h) return;
  const m0 = g.muzzlePos(h.obj, 0), x0 = m0.x, z0 = m0.z, m1 = g.muzzlePos(h.obj, 1), x1 = m1.x, z1 = m1.z;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, a = g.aim(mx, mz);
  for (let i = 0; i < CRES_N; i++) { const u = (i / (CRES_N - 1)) * 2 - 1; g.shoot(mx, mz, a + u * CRES_W, 4.8 + 1.5 * u * u, g.BK.BIG); }
  g.fx.muzzle(x0, z0, 1.2, 1.6, 2.8, 1.3); g.fx.muzzle(x1, z1, 1.2, 1.6, 2.8, 1.3);
  g.audio.play('explodeS', { vol: 0.55, pitch: -7 });
  g.shake.add(0.12);
  g.later(0.35, () => {
    if (h.dead || !e.alive || e.dying) return;
    const n0 = g.muzzlePos(h.obj, 0), ax = n0.x, az = n0.z, n1 = g.muzzlePos(h.obj, 1);
    g.shoot(ax, az, g.aim(ax, az), 9.5, g.BK.NEEDLE); g.shoot(n1.x, n1.z, g.aim(n1.x, n1.z), 9.5, g.BK.NEEDLE);
  });
}
/** the mirror's yaw that points it at the jet */
function mirrorAim(g, e, M) { return wrapA(Math.atan2(-(g.player.x - M.x), -(g.player.z - M.z)) - e.yaw); }
const LANCE_SWEEP = 1.1, LANCE_T = 1.1;
function sunLance(e, dt, g, M, fr) {
  const s = e.s, o = M.obj, mu = o.userData;
  s.gunT += dt;
  if (s.gun === 'track') {                                  // follow the jet, the beam faint
    o.rotation.y += clamp(wrapA(mirrorAim(g, e, M) - o.rotation.y), -1.6 * dt, 1.6 * dt);
    mu.setBeam(0.12, 0.35); mu.setCharge(0.2);
    if (s.gunT > 1.4) {
      s.gun = 'lock'; s.gunT = 0;
      s.la = mirrorAim(g, e, M);
      // sweep toward the side with more room for the jet to be pushed away from (else at random)
      const px = g.player.x;
      s.sd = Math.abs(px) > 2.5 ? -Math.sign(px) : (Math.random() < 0.5 ? -1 : 1);
      g.audio.play('lock', { vol: 0.55, pitch: -2 });
    }
  } else if (s.gun === 'lock') {                            // the telegraph: the line is fixed, trembling toward the sweep
    const k = Math.min(1, s.gunT / 0.9);
    o.rotation.y = s.la + s.sd * 0.11 * (0.5 + 0.5 * Math.sin(s.gunT * 15)) * k;
    mu.setBeam(0.22 + 0.2 * k, 0.6 + 0.6 * k); mu.setCharge(0.3 + 0.7 * k);
    if (s.gunT > 0.9) {
      s.gun = 'sweep'; s.gunT = 0; s.lst = 0;
      g.audio.play('explodeL', { vol: 0.6 }); g.audio.play('missile', { vol: 0.7, pitch: -8 });
      g.shake.add(0.3);
      const m = g.muzzlePos(o); g.fx.p.emit(m.x, 0.4, m.z, 0, 0, 0, 0.35, 2, 6, SUN_A, SUN_B, F.FLARE, 0, NO_DRAG);
    }
  } else if (s.gun === 'sweep') {                           // the lance: needles down the turning line
    const k = Math.min(1, s.gunT / LANCE_T);
    o.rotation.y = s.la + s.sd * LANCE_SWEEP * k;
    mu.setBeam(0.5, 1.3); mu.setCharge(1 - k * 0.5);
    s.lst -= dt;
    while (s.lst <= 0 && s.gunT < LANCE_T) {
      s.lst += 0.045;
      const m = g.muzzlePos(o), ang = o.rotation.y + e.yaw - Math.PI;
      g.shoot(m.x, m.z, ang, 11, g.BK.NEEDLE);
    }
    if (s.gunT >= LANCE_T) { s.gun = 'cool'; s.gunT = 0; mu.setBeam(0); }
  } else if (s.gun === 'cool') {
    mu.setBeam(0); mu.setCharge(Math.max(0, 0.5 - s.gunT));
    o.rotation.y += clamp(wrapA(mirrorAim(g, e, M) - o.rotation.y), -0.8 * dt, 0.8 * dt);
    if (s.gunT > 1.9 / fr) { s.gun = 'track'; s.gunT = 0; }
  }
}
const ECL_A = [0.05, 0.05, 0.1, 0.8], ECL_B = [0.4, 0.5, 1.0, 0.9];         // the eclipse's closing ring
function heartPatterns(e, dt, g, fr, hard) {
  const s = e.s, core = s.core;
  const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
  s.cyc += dt;
  const cyc = s.cyc % 9;
  const rage = core.hp < core.maxHp * 0.4;
  s.ct = (s.ct || 0) - dt;
  if (cyc < 3.6) {                                         // waxing / waning spiral
    if (s.ct <= 0) {
      s.ct = (rage ? 0.12 : 0.14) / fr;
      const dir = Math.floor(s.cyc / 1.8) & 1 ? -1 : 1;
      s.a += 0.25 * dir;
      for (let k = 0; k < 3; k++) g.shoot(cx, cz, s.a + (k * TAU) / 3, 4.8);
    }
  } else if (cyc < 7.0) {                                  // the moon's phases: rings with a crescent-shaped gap
    if (s.ct <= 0) {
      s.ct = (rage ? 0.72 : 0.85) / fr;
      const n = hard ? 26 : 22, miss = 5;
      s.c += 0.9;
      for (let i = 0; i < n - miss; i++) g.shoot(cx, cz, s.c + ((i + miss / 2 + 0.5) / n) * TAU, 4.2);
    }
  } else if (!s.fanned) { s.fanned = true; g.fan(cx, cz, g.aim(cx, cz), hard ? 7 : 5, hard ? 1.0 : 0.8, 6.4, g.BK.BIG); g.audio.play('lock', { vol: 0.4 }); }
  if (cyc < 7.0) s.fanned = false;
  if (rage) {                                              // eclipse: dark for a moment, then a double ring and mines
    s.ecT = (s.ecT ?? 2.0) - dt;
    if (s.ecT <= 0.8 && !s.ecl) { s.ecl = true; g.fx.p.emit(cx, 0.2, cz, 0, 0, 0, 0.8, 9, 1.5, ECL_A, ECL_B, F.RING, 0, FLAT); g.audio.play('warning', { vol: 0.3 }); }
    if (s.ecT <= 0) {
      s.ecT = 7 / fr; s.ecl = false; s.b += 0.3;
      g.ring(cx, cz, 20, 3.8, s.b); g.ring(cx, cz, 20, 5.0, s.b + Math.PI / 20);
      for (const sx of [-1.8, 1.8]) {
        const i = g.shoot(cx + sx, cz, g.aim(cx + sx, cz) + sx * 0.25, 2.2, g.BK.MINE);
        if (i >= 0) { g.eb.home[i] = 1.1; g.eb.az[i] = 0.3; }
      }
      g.fx.p.emit(cx, 0.4, cz, 0, 0, 0, 0.3, 2, 7, MOON_A, MOON_B, F.GLOW, 0, NO_DRAG);
    }
  }
}
// Death: guns still standing blow in turn, the lift jets fail and it slams onto the mare (a dust shock ring),
// blasts run round the crescent, the heart goes up, the crescent breaks at the spine and the halves sag
// apart, rock and embers fly in slow lunar arcs, a final blast.
const SE_BLASTS = [[-4.6, -2.0], [4.6, -2.0], [-2.6, -4.6], [2.6, -4.6], [-5.6, 1.0], [5.6, 1.0], [0, -5.4], [-3.6, -3.4], [3.6, -3.4]];
function seleneDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  if (!s.dieT) {
    const mu = s.mir && s.mir.obj.userData;
    if (mu) { mu.setBeam(0); mu.setCharge(0); }
  }
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT;
  // it stops dead: the mare carries the hulk off slowly
  s.dv = s.dv === undefined ? g.scrollSpeed : Math.max(0, s.dv - dt * 1.2);
  e.gd += s.dv * dt;
  if (ud.setFlash && t < 1.2) ud.setFlash(Math.max(0, Math.sin(t * 23)) * 0.35);
  // the guns still standing blow one after another
  s.popT = (s.popT ?? 0.1) - dt;
  if (s.popT <= 0 && t < 1.6) {
    s.popT = 0.18;
    let pt = null;
    for (let i = 0; i < e.parts.length && !pt; i++) if (!e.parts[i].dead && !e.parts[i].core) pt = e.parts[i];
    if (pt) {
      pt.dead = true;
      if (pt.obj.userData.setDestroyed) pt.obj.userData.setDestroyed(true);
      g.fx.explosion(pt.x, 0.4, pt.z, Math.min(1.8, pt.big), { debris: 8, color: ud.debrisColor });
      g.audio.play('explodeL', { vol: 0.7 });
    }
  }
  // the lift jets fail: it drops onto the mare
  if (ud.setHover) ud.setHover(1 - smooth((t - 0.3) / 0.9));
  if (t > 1.2 && !s.slam) {
    s.slam = true;
    dustBurst(g, e.gx, e.gz, 40, 7, 3.2);
    g.fx.shockwave(e.x, 0.05, e.z, 30, [1.4, 1.4, 1.6, 0.8], 0.9);
    g.shake.add(0.8); g.audio.play('explodeL', { vol: 0.9, pitch: -6 });
  }
  // blasts running round the crescent
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0 && t < 3.4) {
    s.boomT = 0.09;
    const b = SE_BLASTS[(Math.random() * SE_BLASTS.length) | 0];
    g.fx.explosion(e.gx + b[0] + rnd(-0.8, 0.8), g.GROUND_Y + rnd(1.0, 2.4), e.gz + b[1] + rnd(-0.8, 0.8), rnd(1.0, 2.0), { ground: true, debris: 3, color: ud.debrisColor });
    g.audio.play('explodeM', { vol: 0.55, pan: clamp(b[0] / 7, -0.7, 0.7) });
    g.shake.add(0.08);
  }
  // the heart goes up
  if (t > 1.7 && !s.heartGone) {
    s.heartGone = true;
    const cm = g.muzzlePos(s.core.obj), cx = cm.x, cz = cm.z;
    for (let i = 0; i < 30; i++) { const b = rnd(0, TAU), sp = rnd(6, 15); g.fx.p.emit(cx, 0.6, cz, Math.cos(b) * sp, rnd(0, 4), Math.sin(b) * sp, rnd(0.5, 0.9), rnd(0.6, 0.9), 0.1, SHARD_B, MOON_B, F.SHARD, 0, SHARD_OPT); }
    g.fx.p.emit(cx, 0.6, cz, 0, 0, 0, 0.4, 3, 12, MOON_A, MOON_B, F.GLOW, 0, NO_DRAG);
    g.fx.explosion(e.gx, g.GROUND_Y + 2.4, e.gz + 0.2, 3, { ground: true, debris: 16, color: ud.debrisColor });
    g.ui.flash(0.4); g.audio.play('explodeL'); g.shake.add(0.5);
  }
  // the crescent breaks at the spine
  if (ud.setBreak) ud.setBreak(smooth((t - 2.0) / 1.8));
  if (t > 2.0 && t < 3.8 && Math.random() < 0.6) g.fx.p.emit(e.gx + rnd(-0.6, 0.6), g.GROUND_Y + 1.6, e.gz + rnd(-5.5, -1), rnd(-0.4, 0.4), rnd(1, 2.4), rnd(-0.3, 0.3), rnd(0.4, 0.7), 0.9, 2.2, FIRE_A, FIRE_B, F.FIRE, 1, FIRE_OPT);
  if (t > 1.4 && t < 3.8 && Math.random() < 0.5) {
    const b = SE_BLASTS[(Math.random() * SE_BLASTS.length) | 0];
    lunarDebris(g, e.gx + b[0], g.GROUND_Y + 1.8, e.gz + b[1], 2, 3);
  }
  if (t > 3.8 && !s.final) {
    s.final = true;
    g.fx.explosion(e.gx, g.GROUND_Y + 1.6, e.gz - 1.5, 5.5, { ground: true, debris: 40, color: ud.debrisColor });
    g.fx.explosion(e.gx - 4.5, g.GROUND_Y + 1.2, e.gz - 1.5, 3, { ground: true, debris: 12, color: ud.debrisColor });
    g.fx.explosion(e.gx + 4.5, g.GROUND_Y + 1.2, e.gz - 1.5, 3, { ground: true, debris: 12, color: ud.debrisColor });
    lunarDebris(g, e.gx, g.GROUND_Y + 1.5, e.gz - 1.5, 36, 7);
    dustBurst(g, e.gx, e.gz - 1.5, 30, 8, 3.6);
    g.fx.shockwave(e.x, 0.1, e.z - 1.5, 34, [2.6, 2.4, 2.2, 1], 1.0);
    g.fx.shockwave(e.x, 0.1, e.z - 1.5, 20, [1.4, 1.9, 2.8, 1], 0.8);
    g.ui.flash(1); g.shake.add(1);
    g.audio.play('bossDown');
    g.haptic([80, 50, 200]);
    for (let i = 0; i < 18; i++) g.dropItem('medal', e.x + rnd(-5, 5), e.z + rnd(-3, 3));
  }
  if (t > 4.8) {
    e.alive = false;
    g.ui.boss(false);
  }
}
function spawnSelene(g) {
  const e = g.spawn('selene', { gx: 0, gd: g.world.distance - (g.view.gTop - 12), yaw: 0, ai: seleneAI() });
  e.onDeath = () => { e.s.dieT = 0; bossDefeated(g, e); };
  let bays = 0;
  e.onPartDestroyed = (en, pt) => {
    if (pt.key.startsWith('horn')) g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    else if (pt.key.startsWith('bay') && ++bays === 2) g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' });
    else if (pt.key === 'mirror') g.dropItem('B', pt.x, pt.z);
  };
  return e;
}

// --------------------------------------------------------------------------------
// spawn helpers (stage 5 units; the stage-1 ones are in stage.js W)
// --------------------------------------------------------------------------------
function nextRoad(g) {
  const top = g.topGd(0);
  return Math.ceil((top - CROSS_ROAD_PERIOD / 2) / CROSS_ROAD_PERIOD) * CROSS_ROAD_PERIOD + CROSS_ROAD_PERIOD / 2;
}
/** fn(road) once the next cross road beyond the top edge is `lead` units short of it (re-checked at least
 *  every 0.25 s, so a changing scroll speed can't throw it off): released at once, a road up to 40 units out
 *  would carry its crossing units across above the screen */
function onRoad(g, lead, fn) {
  const road = nextRoad(g);
  const release = () => {
    const wait = (road - g.topGd(0) - lead) / Math.max(1, g.scrollSpeed);
    if (wait > 0.02) { g.later(Math.min(wait, 0.25), release); return; }
    fn(road);
  };
  release();
}
export const W5 = {
  // a crescent of n skimmers swinging in from side (+1 right)
  arc(g, side, n = 5, zf = 0.36) { for (let k = 0; k < n; k++) g.spawn('s5_skimmer', { x: side * 10, z: -60, ai: arcAI(side, k, n, zf) }); },
  dive(g, xs, gap = 0.3, zf = 0.3) { xs.forEach((x, i) => g.later(i * gap, () => g.spawn('s5_skimmer', { x, z: -60, ai: diveAI(x, zf + (i % 2) * 0.05) }))); },
  rovers(g, lane, n = 1, gap = 3.4, dir = 1, extra = 0) {
    for (let i = 0; i < n; i++) g.spawn('s5_rover', { gx: LANES_X[lane], gd: g.topGd(1.5 + extra + i * gap), yaw: dir > 0 ? 0 : Math.PI, ai: roverLane(dir) });
  },
  rush(g, lane, n = 2, gap = 2.6) { for (let i = 0; i < n; i++) g.spawn('s5_rover', { gx: LANES_X[lane], gd: g.topGd(1 + i * gap), yaw: Math.PI, ai: roverRush() }); },
  // rovers racing across the next cross road (dir +1: left → right)
  crossRovers(g, dirs, gap = 0.6) {
    onRoad(g, 3, (road) => dirs.forEach((dir, i) => g.later(i * gap, () => g.spawn('s5_rover', { gx: -dir * 15, gd: road, yaw: dir > 0 ? -Math.PI / 2 : Math.PI / 2, ai: roverCross(dir) }))));
  },
  walker(g, lane, dir = 1, extra = 0) { return g.spawn('s5_walker', { gx: LANES_X[lane], gd: g.topGd(2 + extra), yaw: dir > 0 ? 0 : Math.PI, ai: walkerAI(dir) }); },
  // walkers stepping onto the next cross road from the side edges (dir +1: from the left)
  crossWalkers(g, dirs) {
    onRoad(g, 4, (road) => dirs.forEach((dir, i) => g.later(i * 0.4, () => g.spawn('s5_walker', { gx: -dir * 11.5, gd: road, yaw: dir > 0 ? -Math.PI / 2 : Math.PI / 2, ai: walkerAI(dir, true, 2.2) }))));
  },
  turrets(g, lanes, delay = 0, extra = 0) { lanes.forEach((l, i) => g.spawn('s5_turret', { gx: LANES_X[l], gd: g.topGd(1 + extra), yaw: 0, ai: popAI(delay + i * 0.35) })); },
  lander(g, lane, zf = 0.24, drops = null, carry = true) { return g.spawn('s5_lander', { x: LANES_X[lane], z: -60, ai: landerAI(lane, zf, carry), drops }); },
};

// --------------------------------------------------------------------------------
// Stage 5 timeline (distance in stage units; ~7 units/s)
// --------------------------------------------------------------------------------
const TIMELINE = makeTimeline((at) => {
  // HIGHLANDS (0–300): rovers on the tracks, skimmers, the first landers ─────────
  at(22, (g) => W5.arc(g, -1, 5));
  at(40, (g) => { W5.rovers(g, 0); W5.rovers(g, 2, 1, 0, 1, 2); });
  at(58, (g) => W5.dive(g, [-4, 4]));
  at(74, (g) => W.carrier(g, 0, ['P']));
  at(90, (g) => W5.lander(g, 1, 0.24));
  at(110, (g) => W5.arc(g, 1, 5));
  at(126, (g) => W5.turrets(g, [0, 2]));
  at(144, (g) => W5.rush(g, 1, 2));
  at(160, (g) => { W5.walker(g, 0); W5.dive(g, [4.5], 0, 0.28); });
  at(180, (g) => W5.dive(g, [-5, 0, 5], 0.3));
  at(196, (g) => { W5.lander(g, 0, 0.22); g.later(1.0, () => W5.lander(g, 2, 0.28)); });
  at(216, (g) => W.carrier(g, -2, ['S']));
  at(230, (g) => { W5.arc(g, -1, 5, 0.32); g.later(1.8, () => W5.arc(g, 1, 5, 0.4)); });
  at(248, (g) => { W5.rovers(g, 0, 2); W5.rovers(g, 2, 2); W5.turrets(g, [1], 0.8); });
  at(268, (g) => { W5.walker(g, 2); W5.dive(g, [-4.5, -1.5], 0.35); });
  // RILLES (300–560): the chasms across, cross roads from 300 ───────────────────────
  at(300, (g) => W5.turrets(g, [0, 1, 2]));
  at(314, (g) => W5.crossWalkers(g, [1, -1]));
  at(334, (g) => W5.arc(g, 1, 6, 0.34));
  at(352, (g) => { W5.lander(g, 1, 0.22); W5.rush(g, 0, 1); W5.rush(g, 2, 1); });
  at(370, (g) => W5.crossRovers(g, [1, 1, 1]));
  at(388, (g) => { W5.walker(g, 0); W5.walker(g, 2, 1, 3); });
  at(404, (g) => W.carrier(g, 2, ['P']));
  at(418, (g) => W5.dive(g, [-6, -2, 2, 6], 0.28));
  at(436, (g) => { W5.turrets(g, [0, 2]); W5.rovers(g, 1, 2, 3.4, 1, 1); });
  at(456, (g) => { W5.lander(g, 0, 0.22); W5.lander(g, 2, 0.3); });
  at(474, (g) => W5.crossWalkers(g, [-1, 1]));
  at(492, (g) => { W5.arc(g, -1, 5, 0.3); g.later(1.4, () => W5.arc(g, 1, 5, 0.4)); });
  at(510, (g) => { W5.crossRovers(g, [-1, -1, -1]); g.later(1.5, () => W5.rush(g, 1, 2)); });
  at(528, (g) => W.carrier(g, -1, ['B']));
  at(542, (g) => { W5.turrets(g, [1]); W5.dive(g, [-5, 5], 0.4); });
  // THE GREAT CRATER (560–780): SELENITE erupts from the floor ────────────────────────
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnSelenite));
  at(640, (g) => { W5.arc(g, 1, 5); g.later(1.6, () => W5.arc(g, -1, 5)); });
  at(656, (g) => { W5.rovers(g, 0, 2); W5.rovers(g, 2, 2); W5.turrets(g, [1], 0.5); });
  at(674, (g) => W5.lander(g, 1, 0.24, ['P']));
  at(690, (g) => { W5.walker(g, 0); W5.walker(g, 2, 1, 2); });
  at(708, (g) => W.carrier(g, 3, ['P']));
  at(722, (g) => W5.dive(g, [-6, -3, 0, 3, 6], 0.26));
  at(740, (g) => { W5.lander(g, 0, 0.22, ['S', 'B']); W5.rush(g, 2, 2); });
  at(760, (g) => W5.crossRovers(g, [1, -1, 1, -1], 0.55));
  // LUNAR BASE (780–1000) ─────────────────────────────────────────────────────
  at(790, (g) => W5.turrets(g, [0, 1, 2]));
  at(806, (g) => { W5.lander(g, 0, 0.22); g.later(0.9, () => W5.lander(g, 2, 0.28)); });
  at(824, (g) => W5.crossWalkers(g, [1, -1]));
  at(842, (g) => { W5.arc(g, -1, 6, 0.34); W5.rush(g, 1, 1); });
  at(858, (g) => W.carrier(g, -2, ['P', 'S']));
  at(872, (g) => { W5.walker(g, 0); W5.walker(g, 2); W5.turrets(g, [1], 0.8); });
  at(892, (g) => W5.dive(g, [-6, -3, 0, 3, 6], 0.25));
  at(910, (g) => { W5.lander(g, 1, 0.24); W5.crossRovers(g, [1, 1, 1]); });
  at(928, (g) => { W5.walker(g, 1, -1); W5.arc(g, 1, 5, 0.3); });
  at(946, (g) => { W5.turrets(g, [0, 2]); W5.dive(g, [-4, 4], 0.3); });
  at(962, (g) => W.carrier(g, 0, ['1UP']));
  at(978, (g) => { W5.rush(g, 0, 1); W5.rush(g, 2, 1); g.later(1.2, () => W5.arc(g, -1, 5, 0.3)); });
  at(994, (g) => W5.crossWalkers(g, [-1, 1]));
  // MASS DRIVER (1000–1240) ───────────────────────────────────────────────────
  at(1012, (g) => { W5.lander(g, 0, 0.2); W5.lander(g, 2, 0.26); W5.turrets(g, [1]); });
  at(1032, (g) => { W5.arc(g, 1, 6, 0.32); g.later(1.4, () => W5.arc(g, -1, 6, 0.4)); });
  at(1048, (g) => W5.turrets(g, [0, 2]));
  at(1064, (g) => { W5.lander(g, 0, 0.22); g.later(1.2, () => W5.lander(g, 2, 0.26)); });
  at(1082, (g) => W.carrier(g, 2, ['P']));
  at(1096, (g) => { W5.walker(g, 0); W5.walker(g, 2); W5.crossRovers(g, [-1, -1]); });
  at(1114, (g) => W5.dive(g, [-6, -3.5, -1, 1, 3.5, 6], 0.22));
  at(1132, (g) => { W5.rush(g, 0, 1); W5.rush(g, 1, 2); W5.rush(g, 2, 1); });
  at(1150, (g) => { W5.crossWalkers(g, [1, -1]); W5.turrets(g, [1], 0.6); });
  at(1168, (g) => { W5.lander(g, 0, 0.22, ['P', 'S']); W5.lander(g, 2, 0.28); });
  at(1186, (g) => { W5.arc(g, -1, 5, 0.3); W5.rovers(g, 0, 1); W5.rovers(g, 2, 1, 0, 1, 2); });
  at(1204, (g) => W.carrier(g, 0, ['B']));
  at(1216, (g) => { W5.turrets(g, [0, 2]); W5.dive(g, [-3, 3], 0.4); });
});

export const STAGE = {
  ...STAGE_META[4],
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: spawnSelene,
  // the garrison hardens past the rilles, at the base and along the mass driver
  hpSeg: (d) => (d < 300 ? 1 : d < 560 ? 1.12 : d < 1000 ? 1.24 : 1.36),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
