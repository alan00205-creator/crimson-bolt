// stage2.js — STAGE 2 "SCORCHED CANYON" (灼熱峽谷): dunes → canyon → mesa (mid-boss SCORPION) →
// refinery → desert fortress → dry lakebed (boss: the land battleship BEHEMOTH).
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages)
//   STAGE  { ...STAGE_META[1], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll }
// World 'canyon' (world.js): dunes 0–260 · canyon 260–560 (walls beyond |x| ≈ 10) · mesa
// 560–780 (mid-boss plateau, clear |x| < 5.5) · refinery 780–1000 · fortress 1000–1240 · dry
// lakebed 1240+ (boss arena, clear |x| < 9). Ground units run only on the lanes (LANES_X) and
// the cross roads (d ≡ 20 mod 40) within 260..1240, which world.js keeps flat and clear.
// Models: models_s2.js (gunship, s2_striker, mlrs, sandskiff, scorpion, BOSSES.behemoth).
import { LANES_X, CROSS_ROAD_PERIOD } from './world.js';
import { STAGE_META } from './defs.js';
import { F } from './fx.js';
import { fireTimer, faceYaw, W, makeTimeline, midbossEvent, bossDefeated } from './stage.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const wrap = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// Enemy definitions (fields: see the ENEMY table in stage.js). The mid-boss's body is only a
// holder: its HP lives in its parts and the reactor core kills it, so the body is no target at
// all (bodyTarget: false: no shot, beam, lock or bomb can waste damage on it; its hp is only a
// backstop). keepOff holds the jet 8.5 below it: the claw guns sit ~3.7 in front of the walker,
// so they stay beyond shoot()'s 4-unit point-blank rule and hugging it can't silence it.
export const ENEMY = {
  gunship:    { hp: 34, score: 1500, radius: 1.25, air: true, explode: 1.5, debris: 12, medal: 1, prewarm: 5 },
  s2_striker: { hp: 10, score: 700, radius: 1.0, air: true, explode: 1.1, debris: 8, medal: 0.35, prewarm: 6 },
  mlrs:       { hp: 24, score: 1000, radius: 1.1, air: false, explode: 1.3, debris: 10, medal: 1, prewarm: 6 },
  sandskiff:  { hp: 7, score: 350, radius: 0.85, air: false, explode: 0.9, debris: 6, medal: 0.4, prewarm: 8 },
  scorpion: {
    hp: 5000, score: 30000, radius: 0.1, air: false, explode: 3.4, debris: 32, midboss: true, noRevenge: true, prewarm: 1,
    bodyTarget: false, keepOff: 8.5,
    parts: [
      { key: 'clawL', hp: 115, score: 4000, medals: 2, big: 1.6 }, { key: 'clawR', hp: 115, score: 4000, medals: 2, big: 1.6 },
      { key: 'tail', hp: 150, score: 5000, medals: 2, big: 1.8 },
      { key: 'core', hp: 720, score: 20000, medals: 3, core: true },
    ],
    hull: { hw: 1.3, z0: -2.3, z1: -0.25 },          // the armoured abdomen behind the reactor (never in front of a part)
  },
  behemoth: {
    hp: 1, score: 0, radius: 5, air: false, explode: 5, debris: 40, boss: true, model: 'behemoth', prewarm: 1,
    parts: [
      { key: 'turret', hp: 620, score: 15000, medals: 3, big: 2.4 },
      { key: 'battery', list: true, hp: 150, score: 3000 },
      { key: 'silo', list: true, hp: 230, score: 6000, medals: 2, big: 1.8 },
      { key: 'core', hp: 1950, score: 120000, core: true },
    ],
    hull: { hw: 4.0, z0: -7.9, z1: -5.5 },           // the prow beyond the main turret: shots that clear every part spark off it
  },
};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// --------------------------------------------------------------------------------
// shared effects (constant colour / option tables: nothing is allocated per frame)
// --------------------------------------------------------------------------------
const DUST_A = [0.66, 0.54, 0.4, 0.5], DUST_B = [0.6, 0.5, 0.38, 0];
const GRIT_A = [0.42, 0.4, 0.37, 0.32], GRIT_B = [0.4, 0.38, 0.35, 0];     // lakebed grit (grey clay)
const DUST_OPT = { scroll: true, drag: 1.5 };
const SMOKE_A = [0.2, 0.18, 0.16, 0.6], SMOKE_B = [0.16, 0.15, 0.14, 0];
const SMOKE_OPT = { scroll: true, drag: 0.8 };
const FIRE_A = [1.6, 0.55, 0.12, 0.9], FIRE_B = [0.6, 0.12, 0.03, 0];
const NO_DRAG = { drag: 0 };
const FLAT = { flat: true, rot: 0, drag: 0 };
/** a puff of desert dust at a ground point (it stays behind with the ground) */
function dust(g, x, z, s, rate, c0 = DUST_A, c1 = DUST_B) {
  if (Math.random() > rate) return;
  g.fx.p.emit(x + rnd(-0.25, 0.25), g.GROUND_Y + 0.15, z + rnd(-0.2, 0.2), rnd(-0.5, 0.5), rnd(0.3, 0.9), rnd(-0.2, 0.3),
    rnd(0.7, 1.1), s * 0.5, s * 1.8, c0, c1, F.SMOKE, 2, DUST_OPT);
}
/** muzzle smoke at the last g.muzzlePos() world point (g.tmpV), drifting with the ground */
function muzzleSmoke(g, s = 0.6) {
  const v = g.tmpV;
  g.fx.p.emit(v.x, v.y, v.z, rnd(-0.3, 0.3), rnd(0.6, 1.2), rnd(-0.3, 0.3), rnd(0.6, 0.9), s * 0.6, s * 2.2, SMOKE_A, SMOKE_B, F.SMOKE, 2, SMOKE_OPT);
}

// --------------------------------------------------------------------------------
// air behaviours
// --------------------------------------------------------------------------------
// Gunship: armoured tandem-rotor helicopter. Flies in, hovers and fires aimed 3-way bursts:
// three volleys down the same line, so a short side-step clears the whole burst.
export function gunshipAI(tx, tzFrac = 0.28, stay = 6.5) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.x0 === undefined) {
      s.x0 = tx; s.z0 = v.zTop - 3.5; s.tz = v.zTop + (v.zBottom - v.zTop) * tzFrac;
      s.fixedYaw = true; s.yaw = Math.PI; s.burst = 0; s.bt = 0; s.ba = 0;
    }
    const IN = 1.8;
    if (e.t < IN) { const k = ease(e.t / IN); e.x = s.x0; e.z = s.z0 + (s.tz - s.z0) * k; }
    else if (e.t < IN + stay) {
      const k = e.t - IN;
      e.x = s.x0 + Math.sin(k * 0.8) * 1.5;
      e.z = s.tz + Math.sin(k * 1.6) * 0.35;
      if (s.burst <= 0 && fireTimer(e, dt, g, 2.3, 0.3)) {
        const m = g.muzzlePos(e.mesh, 0);
        s.burst = 3; s.bt = 0; s.ba = g.aim(m.x, m.z);
      }
    } else {
      const k = e.t - IN - stay;
      e.x += Math.sign(e.x || 1) * (3 + k * 8) * dt;
      e.z -= (2 + k * 9) * dt;
    }
    if (s.burst > 0) {
      s.bt -= dt;
      if (s.bt <= 0) {
        s.bt = 0.13; s.burst--;
        if (g.canFire(e)) {
          const m = g.muzzlePos(e.mesh, 0);
          g.fan(m.x, m.z, s.ba, 3, 0.34, 8.4);
          g.fx.muzzle(m.x, m.z, 2.2, 1.2, 0.4, 0.55);
          if (s.burst === 2) g.audio.play('lock', { vol: 0.28 });
        }
      }
    }
    s.yaw += wrap(faceYaw(e, g.player.x, g.player.z) - s.yaw) * Math.min(1, dt * 3);
  };
}

// Strike jet: dives in from the top, brakes into its run, releases a cluster bomb at dropFrac of
// the screen and pulls away. The bomb falls a short way (a blinking shell) and bursts into a ring.
export function strikerAI(x0, dropFrac = 0.34) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.z0 === undefined) {
      s.z0 = v.zTop - 3; s.dz = v.zTop + (v.zBottom - v.zTop) * dropFrac; s.vz = 15;
      s.side = x0 > 0.5 ? 1 : x0 < -0.5 ? -1 : (Math.random() < 0.5 ? -1 : 1);
      e.x = x0; e.z = s.z0;
    }
    if (!s.dropped) {
      s.vz = Math.max(7, s.vz - dt * 7);
      e.z += s.vz * dt;
      e.x += (x0 - e.x) * Math.min(1, dt * 2);
      if (e.z >= s.dz) { s.dropped = true; s.pt = 0; clusterBomb(g, e); }
    } else {
      s.pt += dt;
      const k = s.pt;
      e.x += s.side * (2 + k * 13) * dt;
      e.z += (s.vz - k * 16) * dt;
    }
  };
}
const BOMB_A = [1.8, 0.35, 0.12, 1], BOMB_B = [2.4, 0.9, 0.3, 1];
function clusterBomb(g, e) {
  if (!g.canFire(e)) return;
  const x = e.x, z = e.z, fuse = 0.72, vz = 3.6;
  g.fx.p.emit(x, 0.12, z, 0, 0, vz, fuse, 0.5, 0.95, BOMB_A, BOMB_B, F.GLOW, 0, NO_DRAG);
  g.audio.play('lock', { vol: 0.22, pitch: -5 });
  g.later(fuse, () => {
    const bx = x, bz = z + vz * fuse;
    g.fx.explosion(bx, 0.1, bz, 0.75);
    g.audio.play('explodeS', { vol: 0.55 });
    g.ring(bx, bz, 10, 4.6, Math.random() * TAU);
  });
}

// --------------------------------------------------------------------------------
// ground behaviours
// --------------------------------------------------------------------------------
// Rocket truck on a lane: drives up-screen, brakes once it is well above the jet, raises its
// launcher (the six glowing rocket noses turn to the sky: the tell) and ripples a slow NEEDLE
// volley in a loose fan along one aim, then stows and drives on. Two volleys at most.
const MLRS_SPREAD = [-0.2, 0.13, -0.05, 0.2, -0.13, 0.05];
export function mlrsAI(speed = 2.3) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    if (!s.mode) { s.mode = 'drive'; s.raise = 0; s.volleys = 0; s.mt = 0; s.cd = rnd(0.2, 0.8); }
    e.yaw = 0;
    switch (s.mode) {
      case 'drive':
        e.gd += speed * dt;
        s.cd -= dt;
        if (s.volleys < 2 && s.cd <= 0 && e.z > v.zTop + 3.5 && e.z < g.player.z - 8) { s.mode = 'brake'; s.mt = 0; }
        break;
      case 'brake':
        s.mt += dt; e.gd += speed * dt * Math.max(0, 1 - s.mt / 0.4);
        if (s.mt > 0.4) { s.mode = 'raise'; s.mt = 0; }
        break;
      case 'raise':
        s.mt += dt; s.raise = Math.min(1, s.mt / 0.7);
        if (s.mt > 0.8) { s.mode = 'fire'; s.mt = 0; s.shots = 0; s.fa = null; }
        break;
      case 'fire':
        s.mt -= dt;
        if (s.mt <= 0 && s.shots < 6) {
          s.mt = 0.11;
          const k = s.shots++;
          if (g.canFire(e) && ud.launcher) {
            const m = g.muzzlePos(ud.launcher, k);
            if (s.fa === null) s.fa = g.aim(m.x, m.z);
            g.shoot(m.x, m.z, s.fa + MLRS_SPREAD[k], 5.2, g.BK.NEEDLE);
            g.fx.muzzle(m.x, m.z, 2.4, 1.1, 0.35, 0.7);
            muzzleSmoke(g, 0.7);
            if (k % 2 === 0) g.audio.play('missile', { vol: 0.32 });
          }
        }
        if (s.shots >= 6 && s.mt <= 0) { s.mode = 'hold'; s.mt = 0; }
        break;
      case 'hold':
        s.mt += dt; if (s.mt > 0.5) { s.mode = 'lower'; s.mt = 0; }
        break;
      default: // lower
        s.mt += dt; s.raise = Math.max(0, 1 - s.mt / 0.6);
        if (s.mt > 0.6) { s.mode = 'drive'; s.volleys++; s.cd = 1.4; }
    }
    if (ud.setRaise) ud.setRaise(s.raise);
    const T = ud.turret;
    if (T) {
      if (s.mode === 'drive' || (s.mode === 'lower' && s.raise < 0.4)) T.rotation.y -= clamp(wrap(T.rotation.y), -2.5 * dt, 2.5 * dt);
      else g.aimTurret(e, T, dt, 2.6);
    }
  };
}

// Sand skiff crossing a cross road at speed: one aimed pair as it passes the middle, a dust plume.
export function skiffCross(dir, speed = 7.2) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData;
    e.gx += dir * speed * dt;
    e.yaw = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.aimTurret(e, ud.turret, dt, 6);
    if (!s.fired && Math.abs(e.gx) < 6 && e.t > 0.4) { s.fired = true; s.burst = 2; s.bt = 0; }
    skiffBurst(e, dt, g, 8.6);
    dust(g, e.gx - dir * 0.95, e.gz, 1.1, 0.7);
    if (Math.abs(e.gx) > 17 && e.t > 2) e.alive = false;
  };
}
// Sand skiff racing down a lane toward the jet: one aimed 3-way on the way in.
export function skiffRush(speed = 5.5) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    e.gd -= speed * dt;
    e.yaw = Math.PI;
    g.aimTurret(e, ud.turret, dt, 6);
    if (!s.fired && e.z > v.zTop + 3 && e.t > 0.3) {
      s.fired = true;
      if (g.canFire(e) && ud.turret) { const m = g.muzzlePos(ud.turret); g.fan(m.x, m.z, g.aim(m.x, m.z), 3, 0.42, 7.6); }
    }
    dust(g, e.gx, e.gz - 1.0, 1.2, 0.8);
  };
}
function skiffBurst(e, dt, g, speed) {
  const s = e.s, ud = e.mesh.userData;
  if (!(s.burst > 0)) return;
  s.bt -= dt;
  if (s.bt <= 0) {
    s.bt = 0.14; s.burst--;
    if (g.canFire(e) && ud.turret) { const m = g.muzzlePos(ud.turret); g.shoot(m.x, m.z, g.aim(m.x, m.z), speed); }
  }
}

// --------------------------------------------------------------------------------
// mid-boss: SCORPION assault walker (mesa plateau)
// --------------------------------------------------------------------------------
// Stalks the plateau facing the jet. Claw cannons alternate (left: 3-needle bursts, right: 5-way
// fans); the tail lobs mortar shells onto a reticle at the jet's position (burst + shrapnel ring,
// a direct hit is fatal — the closing ring gives 1.25 s to step out). The carapace blows open
// once two parts are gone or after 18 s; the exposed reactor spins a twin spiral, and at half HP
// a third arm and rings. Retreats after 40 s. Sets g.midbossDone on death and on retreat.
const MORTAR_R = 1.3;                 // blast radius (+ the jet's hit radius)
const SHELL_A = [2.2, 0.8, 0.25, 1], SHELL_B = [2.6, 1.2, 0.4, 1];
const RET_A = [2.4, 0.3, 0.12, 0.2], RET_B = [2.6, 0.45, 0.15, 1];
const RET_C = [1.4, 0.2, 0.08, 0.1], RET_D = [2.4, 0.5, 0.15, 0.55];
const SHOCK_C = [2.4, 1.2, 0.5, 1];
function mortar(g, tail) {
  const v = g.view, p = g.player;
  const m = g.muzzlePos(tail.obj), mx = m.x, mz = m.z;
  const tz = clamp(p.z, v.zTop + 4, v.zBottom - 2), tx = clamp(p.x, -v.hw(tz) + 0.8, v.hw(tz) - 0.8);
  const fuse = 1.25;
  // the shell arcs over (it swells as it climbs toward the camera) onto a closing red reticle
  g.fx.p.emit(mx, 0.4, mz, (tx - mx) / fuse, 0, (tz - mz) / fuse, fuse, 0.45, 1.25, SHELL_A, SHELL_B, F.GLOW, 0, NO_DRAG);
  g.fx.p.emit(tx, 0.05, tz, 0, 0, 0, fuse, 6.4, MORTAR_R / 0.39, RET_A, RET_B, F.RING, 0, FLAT);
  g.fx.p.emit(tx, 0.05, tz, 0, 0, 0, fuse, 0.6, 1.6, RET_C, RET_D, F.GLOW, 0, FLAT);
  g.fx.muzzle(mx, mz, 2.6, 1.3, 0.4, 1.1);
  muzzleSmoke(g, 0.9);
  g.audio.play('missile', { vol: 0.55, pitch: -7 });
  g.later(fuse, () => {
    g.fx.explosion(tx, 0.15, tz, 1.3);
    g.fx.shockwave(tx, 0.1, tz, (MORTAR_R + 0.4) / 0.39, SHOCK_C, 0.35);
    g.audio.play('explodeM', { vol: 0.55 });
    g.shake.add(0.14);
    const pl = g.player;
    if (pl.alive) { const dx = pl.x - tx, dz = pl.z - tz, r = MORTAR_R + g.ac.hitR; if (dx * dx + dz * dz < r * r) g.killPlayer(); }
    g.ring(tx, tz, 8, 4.3, Math.random() * TAU);
  });
}
export function scorpionAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    const scroll = g.scrollSpeed;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.life = 0; s.walk = 0; s.opened = false; s.a = 0;
      s.lgx = e.gx; s.lgd = e.gd; s.ct = 1.2; s.mt = 2.8; s.side = 0;
      // part records (built by g.spawn before this first call): looked up once, not every frame
      s.clawL = g.partByKey(e, 'clawL'); s.clawR = g.partByKey(e, 'clawR'); s.tail = g.partByKey(e, 'tail'); s.core = g.partByKey(e, 'core');
      e.armored = true;
      if (ud.reset) ud.reset();
    }
    s.life += dt;
    if (e.dying) { scorpionDeath(e, dt, g); return; }
    const stationGz = v.pToGz(v.zTop + 12.5);
    if (s.mode === 'enter') {
      e.gd += (scroll - 4.0) * dt;
      e.invuln = true;
      if (g.world.distance - e.gd >= stationGz) { s.mode = 'fight'; s.fightT = 0; e.invuln = false; }
    } else if (s.mode === 'fight') {
      s.fightT += dt;
      // hold the plateau station, lunging a little toward the jet now and then; drift after it
      const lunge = Math.max(0, Math.sin(s.fightT * 0.37 - 1.2)) * 1.8;
      e.gd = g.world.distance - (stationGz + lunge);
      const tx = clamp(v.pToGx(g.player.x) * 0.35 + Math.sin(s.fightT * 0.55) * 1.4, -1.8, 1.8);
      e.gx += clamp(tx - e.gx, -1.6 * dt, 1.6 * dt);
      if (s.fightT > 40) s.mode = 'retreat';
    } else {
      e.gd += (scroll + 5.5) * dt;
      if (g.world.distance - e.gd < v.gTop - 10) { e.alive = false; g.midbossDone = true; }
    }
    e.yaw = Math.PI;
    // legs: stride with the ground passing under the feet
    const rel = Math.hypot(e.gd - s.lgd, e.gx - s.lgx) / Math.max(dt, 1e-4);
    s.lgd = e.gd; s.lgx = e.gx;
    s.walk += Math.min(rel, 8) * dt * 2.3;
    if (ud.setWalk) ud.setWalk(s.walk, clamp(rel / 1.4, 0.3, 1));
    // claws track the jet (limited swing)
    const P = g.player;
    const clawL = s.clawL, clawR = s.clawR, tail = s.tail, core = s.core;
    const pivots = ud.clawPivots;
    if (pivots) for (let i = 0; i < 2; i++) {
      const pt = i ? clawR : clawL, piv = pivots[i];
      if (!pt || pt.dead) { piv.rotation.y *= Math.max(0, 1 - dt * 2); continue; }
      const want = clamp(wrap(Math.atan2(-(P.x - pt.x), -(P.z - pt.z)) - e.yaw), -0.45, 0.45);
      piv.rotation.y += clamp(want - piv.rotation.y, -1.4 * dt, 1.4 * dt);
    }
    if (s.mode !== 'fight') return;
    // the carapace blows open: two parts gone, or 18 s in
    const lost = (clawL && clawL.dead ? 1 : 0) + (clawR && clawR.dead ? 1 : 0) + (tail && tail.dead ? 1 : 0);
    if (!s.opened && (lost >= 2 || s.fightT > 18)) {
      s.opened = true; e.armored = false;
      if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(1);
      const cm = g.muzzlePos(core.obj);
      g.fx.explosion(cm.x, 0.3, cm.z, 1.5, { debris: 14, color: ud.debrisColor });
      g.fx.shockwave(cm.x, 0.1, cm.z, 7, SHOCK_C, 0.5);
      g.audio.play('explodeM'); g.audio.play('warning', { vol: 0.35 });
      g.shake.add(0.35); g.ui.flash(0.2);
    }
    if (!g.canFire(e)) return;
    const fr = g.diff.fr;
    const rage = s.opened && core && core.hp < core.maxHp * 0.5;
    // claw cannons: alternate left (needle bursts) and right (fans)
    const L = clawL && !clawL.dead ? clawL : null, R = clawR && !clawR.dead ? clawR : null;
    s.ct -= dt;
    if (s.ct <= 0) {
      s.ct = ((L && R) ? 1.5 : 1.15) * (rage ? 0.8 : 1) / fr;
      s.side ^= 1;
      const use = (s.side ? R : L) || L || R;
      if (use) {
        const m = g.muzzlePos(use.obj), mx = m.x, mz = m.z, a = g.aim(mx, mz); // copy: muzzlePos returns a shared scratch object
        if (use === L) for (let i = 0; i < 3; i++) g.later(i * 0.1, () => { if (!use.dead && e.alive && !e.dying) g.shoot(mx, mz, a, 9.6, g.BK.NEEDLE); });
        else g.fan(mx, mz, a, 5, 0.72, 6.8);
        g.fx.muzzle(mx, mz, 2.4, 1.0, 0.3, 0.9);
        g.audio.play('lock', { vol: 0.3 });
      }
    }
    // tail mortar
    if (tail && !tail.dead) {
      s.mt -= dt;
      if (s.mt <= 0) { s.mt = (rage ? 3.4 : 4.2) / fr; mortar(g, tail); if (ud.kick) ud.kick(); }
    }
    // the open reactor
    if (s.opened && core && !core.dead) {
      const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
      s.st = (s.st ?? 0.6) - dt;
      if (s.st <= 0) {
        s.st = (rage ? 0.14 : 0.17) / fr;
        s.a += rage ? -0.29 : 0.27;
        const arms = rage ? 3 : 2;
        for (let i = 0; i < arms; i++) g.shoot(cx, cz, s.a + (i / arms) * TAU, 5.0);
      }
      if (rage) {
        s.rt = (s.rt ?? 1.5) - dt;
        if (s.rt <= 0) { s.rt = 3.2 / fr; g.ring(cx, cz, 14, 5.4, Math.random() * TAU); }
      }
    }
  };
}
function scorpionDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  s.dieT = (s.dieT || 0) + dt;
  e.gd += g.scrollSpeed * dt;                           // stops dead: the plateau carries it off
  e.s.y = -sstep(0.3, 1.8, s.dieT) * 0.9;               // legs buckle, the hulk settles
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0) {
    s.boomT = 0.11;
    g.fx.explosion(e.gx + rnd(-2.6, 2.6), g.GROUND_Y + rnd(0.8, 2.2), e.gz + rnd(-2.6, 2.6), rnd(1.0, 1.8), { ground: true });
    g.audio.play('explodeM', { vol: 0.7 });
    g.shake.add(0.12);
  }
  if (Math.random() < 0.5) g.fx.p.emit(e.gx + rnd(-1.5, 1.5), g.GROUND_Y + 2, e.gz + rnd(-1.5, 1.5), rnd(-0.4, 0.4), rnd(1.5, 3), rnd(-0.3, 0.3), rnd(0.4, 0.7), 0.8, 2.2, FIRE_A, FIRE_B, F.FIRE, 1, SMOKE_OPT);
  if (s.dieT > 1.8) {
    g.fx.explosion(e.gx, g.GROUND_Y + 1.2, e.gz, 4, { ground: true, debris: 30, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 18, [2.4, 1.6, 1.0, 1], 0.8);
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
function spawnScorpion(g) {
  const e = g.spawn('scorpion', { gx: 0, gd: g.topGd(6), yaw: Math.PI, ai: scorpionAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  return e;
}

// --------------------------------------------------------------------------------
// boss: BEHEMOTH land battleship (dry lakebed)
// --------------------------------------------------------------------------------
// Grinds in from the top and keeps station at the top of the screen, swaying across the arena.
//   p1  the parts fight, the command bridge is shut: main twin guns alternate shell fans and
//       needle rails, four batteries fire aimed pairs, two silos launch homing mines. The shut
//       bridge is not a target at all (it sits in front of the main turret on screen and would
//       swallow every shot aimed at it): shots pass over the closed dome like over the deck
//   p2  every part down (or 46 s): the bridge's clamshell opens; the reactor spins a twin
//       spiral and throws 7-way shell fans (surviving parts keep firing, a little slower)
//   p3  reactor under 45 %: the spiral reverses with a third (hard: fourth) arm, rings join in
// Death: chain blasts along the hull, the hull breaks its back and sinks into the salt flat.
const TREAD_X = [-3.94, 3.94];                  // track centre lines (ground units from the hull axis)
/** the part record while it still stands, else null */
function standing(pt) { return pt && !pt.dead ? pt : null; }
/** yaw a boss part (its model group) toward the jet at up to `rate` rad/s */
function aimPart(e, pt, P, dt, rate) {
  const want = wrap(Math.atan2(-(P.x - pt.x), -(P.z - pt.z)) - e.yaw);
  pt.obj.rotation.y += clamp(wrap(want - pt.obj.rotation.y), -rate * dt, rate * dt);
}
export function behemothAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.enterT = 0; s.open = 0; s.a = 0; s.b = 0; s.amp = 0; s.ph = 0; s.pt = 0;
      s.fromGz = v.gTop - 12; s.stationGz = v.pToGz(v.zTop + 12);
      s.tt = 2.4; s.salvo = 0; s.silT = 3.4; s.silo = 1; s.rumble = 0;
      e.invuln = true; e.armored = true; e.gx = 0;
      if (ud.reset) ud.reset();
      // part records (built by g.spawn before this first call): looked up once, not every frame
      s.T = g.partByKey(e, 'turret'); s.core = g.partByKey(e, 'core');
      s.B = [0, 1, 2, 3].map((i) => g.partByKey(e, 'battery' + i));
      s.S = [0, 1].map((i) => g.partByKey(e, 'silo' + i));
      if (s.core) s.core.dead = true;                 // shut: out of the collision list until p2 (HP bar still counts it)
    }
    // HP bar: every living part
    let hp = 0, max = 0;
    for (const pt of e.parts) { max += pt.maxHp; hp += Math.max(0, pt.hp); }
    g.ui.setBossHP(max > 0 ? hp / max : 0);
    if (e.dying) { behemothDeath(e, dt, g); return; }
    const D = g.world.distance;
    const P = g.player;
    // grinding treads: dust off the rear of every track, smoke from the stacks
    const heavy = s.mode === 'enter' ? 1 : 0.6;
    for (let i = 0; i < 2; i++) {
      const sx = TREAD_X[i];
      dust(g, e.gx + sx, e.gz + 7.7, 1.2, 0.2 * heavy, GRIT_A, GRIT_B); dust(g, e.gx + sx, e.gz - 1.1, 0.9, 0.1 * heavy, GRIT_A, GRIT_B);
    }
    if (Math.random() < (s.mode === 'p3' ? 0.5 : 0.25)) {
      const sx = Math.random() < 0.5 ? -1.35 : 1.35;
      g.fx.p.emit(e.gx + sx, g.GROUND_Y + 3.4, e.gz + 5.45, rnd(-0.3, 0.3), rnd(1.2, 2), rnd(0.2, 0.6), rnd(1.0, 1.6), 0.7, 2.6, SMOKE_A, SMOKE_B, F.SMOKE, 2, SMOKE_OPT);
    }
    if (s.mode === 'enter') {
      s.enterT += dt;
      const k = ease(s.enterT / 5.5);
      e.gd = D - (s.fromGz + (s.stationGz - s.fromGz) * k);
      s.rumble -= dt;
      if (s.rumble <= 0) { s.rumble = 0.18; g.shake.add(0.07 * (1 - k * 0.6)); }
      for (const pt of e.parts) if (!pt.core) aimPart(e, pt, P, dt, 0.8);
      if (s.enterT >= 5.5) { s.mode = 'p1'; s.pt = 0; e.invuln = false; g.audio.play('explodeL', { vol: 0.5 }); g.shake.add(0.4); }
      return;
    }
    s.pt += dt;
    // station keeping: sway across the arena, surge a little
    const ampT = s.mode === 'p1' ? 2.0 : s.mode === 'p2' ? 2.6 : 3.2;
    s.amp += (ampT - s.amp) * Math.min(1, dt * 0.5);
    s.ph += dt * (s.mode === 'p3' ? 0.42 : 0.3);
    e.gx = Math.sin(s.ph) * s.amp;
    e.gd = D - (s.stationGz + Math.sin(s.pt * 0.21) * 0.8);
    if (ud.setHeat) ud.setHeat(s.mode === 'p3' ? 1 : s.mode === 'p2' ? 0.55 : 0.2);
    // the command bridge opens after p1
    const core = s.core;
    const wantOpen = s.mode === 'p1' ? 0 : 1;
    s.open += (wantOpen - s.open) * Math.min(1, dt * 1.4);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;
    // phases
    let others = 0;
    for (const pt of e.parts) if (!pt.core && !pt.dead) others++;
    // (core.dead is only the 'shut' flag here: the core's own death goes through damagePart → killEnemy)
    if (s.mode === 'p1' && (others === 0 || s.pt > 46)) {
      s.mode = 'p2'; s.p2t = 0;
      if (core) core.dead = false;                    // the bridge opens: a target (armoured until the shutters clear)
      g.audio.play('warning', { vol: 0.5 }); g.shake.add(0.35);
      if (core) { const cm = g.muzzlePos(core.obj); g.fx.shockwave(cm.x, 0.1, cm.z, 10, SHOCK_C, 0.6); }
    }
    if (s.mode === 'p2' && core && core.hp < core.maxHp * 0.45) {
      s.mode = 'p3'; g.shake.add(0.5); g.ui.flash(0.3); g.audio.play('explodeL');
      for (let i = 0; i < 4; i++) g.fx.explosion(e.gx + rnd(-3, 3), g.GROUND_Y + 2.4, e.gz + rnd(-6, 6), rnd(1.2, 1.8), { ground: true, debris: 4, color: ud.debrisColor });
    }
    // turrets track the jet
    const T = standing(s.T);
    if (T) aimPart(e, T, P, dt, 1.2);
    for (let i = 0; i < 4; i++) { const B = standing(s.B[i]); if (B) aimPart(e, B, P, dt, 2.4); }
    if (!g.canFire(e)) return;
    const fr = g.diff.fr, hard = g.diff.level >= 1;
    const slow = s.mode === 'p1' ? 1 : 1.25;
    // main twin guns: shell fans and needle rails, alternately
    if (T) {
      s.tt -= dt;
      if (s.tt <= 0) {
        s.tt = 3.1 * slow / fr;
        s.salvo ^= 1;
        if (ud.kick) ud.kick();
        g.shake.add(0.15);
        let m = g.muzzlePos(T.obj, 0); const x0 = m.x, z0 = m.z; muzzleSmoke(g, 1.1);
        m = g.muzzlePos(T.obj, 1); const x1 = m.x, z1 = m.z; muzzleSmoke(g, 1.1);
        g.fx.muzzle(x0, z0, 2.6, 1.3, 0.4, 1.5); g.fx.muzzle(x1, z1, 2.6, 1.3, 0.4, 1.5);
        if (s.salvo) {
          g.fan(x0, z0, g.aim(x0, z0), 3, 0.46, 6.2, g.BK.BIG);
          g.fan(x1, z1, g.aim(x1, z1), 3, 0.46, 6.2, g.BK.BIG);
          g.audio.play('explodeS', { vol: 0.55, pitch: -6 });
        } else {
          const a0 = g.aim(x0, z0), a1 = g.aim(x1, z1);
          for (let i = 0; i < 5; i++) g.later(i * 0.09, () => { if (!T.dead && e.alive && !e.dying) { g.shoot(x0, z0, a0, 10, g.BK.NEEDLE); g.shoot(x1, z1, a1, 10, g.BK.NEEDLE); } });
          g.audio.play('lock', { vol: 0.4 });
        }
      }
    }
    // side batteries: aimed pairs, staggered
    for (let i = 0; i < 4; i++) {
      const B = standing(s.B[i]);
      if (!B) continue;
      B.fireT -= dt;
      if (B.fireT <= 0) {
        B.fireT = (2.4 + i * 0.3) * slow / fr;
        for (let k = 0; k < 2; k++) g.later(k * 0.14, () => {
          if (B.dead || !e.alive || e.dying) return;
          const m = g.muzzlePos(B.obj, k);
          g.shoot(m.x, m.z, g.aim(m.x, m.z), 7.6);
          g.fx.muzzle(m.x, m.z, 2.2, 1.0, 0.3, 0.5);
        });
      }
    }
    // missile silos: the lid swings open, two homing mines, the lid shuts
    s.silT -= dt;
    if (s.silT <= 0) {
      s.silo ^= 1;
      const idx = standing(s.S[s.silo]) ? s.silo : standing(s.S[s.silo ^ 1]) ? s.silo ^ 1 : -1;
      if (idx >= 0) {
        const S = s.S[idx];
        s.silT = 5.4 * slow / fr;
        if (ud.setSilo) ud.setSilo(idx, 1);
        g.later(0.5, () => {
          if (S.dead || !e.alive || e.dying) return;
          for (let k = 0; k < 2; k++) {
            const m = g.muzzlePos(S.obj, k);
            g.shoot(m.x, m.z, g.aim(m.x, m.z) + (k ? 0.55 : -0.55), 4.4, g.BK.MINE);
            muzzleSmoke(g, 1.0);
          }
          g.audio.play('missile', { vol: 0.5 });
        });
        g.later(1.5, () => { if (ud.setSilo) ud.setSilo(idx, 0); });
      } else s.silT = 1;
    }
    // the reactor (p2/p3)
    if (s.mode !== 'p1' && core && !core.dead && s.open > 0.6) {
      const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
      const p3 = s.mode === 'p3';
      const arms = p3 ? (hard ? 4 : 3) : 2;
      s.sp = (s.sp ?? 0.4) - dt;
      if (s.sp <= 0) {
        s.sp = (p3 ? 0.13 : 0.11) / fr;
        s.a += p3 ? -0.26 : 0.22;
        for (let i = 0; i < arms; i++) g.shoot(cx, cz, s.a + (i / arms) * TAU, p3 ? 6.0 : 5.6);
      }
      s.cf = (s.cf ?? 2.2) - dt;
      if (s.cf <= 0) { s.cf = (p3 ? 2.8 : 3.4) / fr; g.fan(cx, cz, g.aim(cx, cz), 7, 1.0, 6.4, g.BK.BIG); }
      if (p3) {
        s.cr = (s.cr ?? 1.2) - dt;
        if (s.cr <= 0) { s.cr = (hard ? 2.2 : 2.6) / fr; s.b += 0.13; g.ring(cx, cz, hard ? 20 : 16, 5.2, s.b); }
      }
    }
  };
}
/** one of the death set pieces (bit: done flag, t: seconds into the death, lz: hull station) */
function deathPiece(e, g, bit, t, lz, size) {
  const s = e.s;
  if (s.dieT < t || (s.set & bit)) return;
  s.set = (s.set || 0) | bit;
  g.fx.explosion(e.gx, g.GROUND_Y + 2.6, e.gz + lz, size, { ground: true, debris: 12, color: e.mesh.userData.debrisColor });
  g.fx.shockwave(g.view.gToPx(e.gx), 0.1, g.view.gToPz(e.gz + lz), size * 3, SHOCK_C, 0.5);
  g.audio.play('explodeL', { vol: 0.8 }); g.shake.add(0.4); g.ui.flash(0.2);
}
function behemothDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  s.dieT = (s.dieT || 0) + dt;
  // the engines die: it grinds to a halt and the lakebed carries the hulk down the screen
  s.dv = s.dv === undefined ? g.scrollSpeed : Math.max(0, s.dv - dt * 1.4);
  e.gd += s.dv * dt;
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0 && s.dieT < 4.0) {
    s.boomT = 0.085;
    const lx = rnd(-3.8, 3.8), lz = rnd(-8, 8);
    g.fx.explosion(e.gx + lx, g.GROUND_Y + rnd(1.2, 3), e.gz + lz, rnd(1.0, 2.2), { ground: true, debris: 3, color: ud.debrisColor });
    g.audio.play('explodeM', { vol: 0.55, pan: clamp(lx / 6, -0.7, 0.7) });
    g.shake.add(0.1);
  }
  // set pieces: the main magazine, the silos, the bridge
  deathPiece(e, g, 1, 0.7, -4.3, 3);
  deathPiece(e, g, 2, 1.5, -1.5, 2.6);
  deathPiece(e, g, 4, 2.4, 2.0, 3.4);
  if (Math.random() < 0.6) g.fx.p.emit(e.gx + rnd(-3, 3), g.GROUND_Y + 2.5, e.gz + rnd(-7, 7), rnd(-0.4, 0.4), rnd(1.5, 3.5), rnd(-0.3, 0.3), rnd(0.5, 0.8), 1.0, 2.6, FIRE_A, FIRE_B, F.FIRE, 1, SMOKE_OPT);
  if (Math.random() < 0.5) g.fx.p.emit(e.gx + rnd(-3, 3), g.GROUND_Y + 3, e.gz + rnd(-7, 7), rnd(-0.4, 0.4), rnd(1.5, 3), rnd(-0.2, 0.4), rnd(1.4, 2.2), 1.2, 3.6, SMOKE_A, SMOKE_B, F.SMOKE, 2, SMOKE_OPT);
  if (ud.setCollapse) ud.setCollapse(sstep(1.6, 4.1, s.dieT));
  if (s.dieT > 4.1 && !s.final) {
    s.final = true;
    g.fx.explosion(e.gx, g.GROUND_Y + 1.5, e.gz, 5.5, { ground: true, debris: 40, color: ud.debrisColor });
    g.fx.explosion(e.gx, g.GROUND_Y + 1.2, e.gz - 5.5, 3.2, { ground: true, debris: 12, color: ud.debrisColor });
    g.fx.explosion(e.gx, g.GROUND_Y + 1.2, e.gz + 5.5, 3.2, { ground: true, debris: 12, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 34, [3, 2.2, 1.6, 1], 1.0);
    g.fx.shockwave(e.x, 0.1, e.z, 20, [2.6, 1.3, 0.5, 1], 0.8);
    g.ui.flash(1); g.shake.add(1);
    g.audio.play('bossDown');
    g.haptic([80, 50, 200]);
    for (let i = 0; i < 18; i++) g.dropItem('medal', e.x + rnd(-5, 5), e.z + rnd(-3, 3));
  }
  if (s.dieT > 4.9) {
    e.alive = false;
    g.ui.boss(false);
  }
}
function spawnBehemoth(g) {
  const e = g.spawn('behemoth', { gx: 0, gd: g.topGd(14), yaw: 0, ai: behemothAI() });
  e.onDeath = () => {
    e.s.dieT = 0;
    bossDefeated(g, e);
  };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key === 'turret') g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    if (pt.key.startsWith('silo') && en.parts.every((p) => !p.key.startsWith('silo') || p.dead)) g.dropItem('B', pt.x, pt.z);
  };
  return e;
}

// --------------------------------------------------------------------------------
// spawn helpers (stage 2 units; the stage-1 ones are in stage.js W)
// --------------------------------------------------------------------------------
function nextRoad(g) {
  const top = g.topGd(0);
  return Math.ceil((top - CROSS_ROAD_PERIOD / 2) / CROSS_ROAD_PERIOD) * CROSS_ROAD_PERIOD + CROSS_ROAD_PERIOD / 2;
}
export const W2 = {
  gunship(g, tx, tz = 0.28, stay = 6.5, drops) { return g.spawn('gunship', { x: tx, z: -60, ai: gunshipAI(tx, tz, stay), drops }); },
  strikers(g, xs, gap = 0.45, frac = 0.34) { xs.forEach((x, i) => g.later(i * gap, () => g.spawn('s2_striker', { x, z: -60, ai: strikerAI(x, frac) }))); },
  mlrs(g, lane, n = 1, gap = 3.6, extra = 0) {
    for (let i = 0; i < n; i++) g.spawn('mlrs', { gx: LANES_X[lane], gd: g.topGd(1.5 + extra + i * gap), ai: mlrsAI(), yaw: 0 });
  },
  // skiffs crossing on the next cross road beyond the top edge (dir +1: left → right)
  skiffs(g, dirs, gap = 0.55) {
    const road = nextRoad(g);
    dirs.forEach((dir, i) => g.later(i * gap, () => g.spawn('sandskiff', { gx: -dir * 15, gd: road, ai: skiffCross(dir), yaw: dir > 0 ? -Math.PI / 2 : Math.PI / 2 })));
  },
  rush(g, lane, n = 2, gap = 2.4) { for (let i = 0; i < n; i++) g.spawn('sandskiff', { gx: LANES_X[lane], gd: g.topGd(1 + i * gap), ai: skiffRush(), yaw: Math.PI }); },
};

// --------------------------------------------------------------------------------
// Stage 2 timeline (distance in ground units; ~7 units/s)
// --------------------------------------------------------------------------------
const TIMELINE = makeTimeline((at) => {
  // DUNES (0–260): air only ─────────────────────────────
  at(24, (g) => W.swoop(g, -1));
  at(42, (g) => W.swoop(g, 1));
  at(60, (g) => W2.strikers(g, [-4, 4], 0.3));
  at(80, (g) => W.carrier(g, 0, ['P']));
  at(98, (g) => W.vee(g, 0));
  at(116, (g) => W2.gunship(g, 0, 0.27));
  at(138, (g) => { W.snake(g, -3.5, 5); g.later(1.1, () => W.snake(g, 3.5, 5)); });
  at(158, (g) => W2.strikers(g, [-5, 0, 5], 0.5));
  at(178, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); });
  at(196, (g) => W.dive(g, [-5, 3, -1, 5, 0]));
  at(214, (g) => { W2.gunship(g, -4.5, 0.26); g.later(0.9, () => W2.gunship(g, 4.5, 0.32)); });
  at(236, (g) => W.carrier(g, 2, ['S']));
  at(248, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
  // CANYON (260–560): rocket trucks and tanks on the lanes, skiffs through the wall slots ─
  at(270, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2, 1, 0, 2.5); });
  at(288, (g) => W.swoop(g, 1, 4));
  at(302, (g) => W2.skiffs(g, [1, 1, 1]));
  at(318, (g) => W.lane(g, 1, 3, 3));
  at(334, (g) => W2.gunship(g, 0, 0.24));
  at(350, (g) => W.turrets(g, [0, 2]));
  at(366, (g) => W2.skiffs(g, [-1, -1, -1]));
  at(380, (g) => W2.strikers(g, [-3, 3], 0.35));
  at(396, (g) => { W2.mlrs(g, 1); W.lane(g, 0, 2); W.lane(g, 2, 2); });
  at(414, (g) => W.carrier(g, -2, ['P']));
  at(428, (g) => { W2.gunship(g, -5, 0.28); W2.gunship(g, 5, 0.28); });
  at(446, (g) => { W2.rush(g, 0, 2); g.later(1.2, () => W2.rush(g, 2, 2)); });
  at(462, (g) => { W.dive(g, [-4, 4, 0]); W.turrets(g, [1]); });
  at(480, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2); g.later(0.8, () => W2.strikers(g, [0], 0, 0.3)); });
  at(498, (g) => W.vee(g, 1));
  at(514, (g) => { W2.gunship(g, 0, 0.22); W2.skiffs(g, [1, -1, 1, -1], 0.7); });
  at(532, (g) => W.carrier(g, 0, ['B']));
  at(548, (g) => { W.rise(g, -1); g.later(0.5, () => W.rise(g, 1)); });
  // MESA (560–780): the SCORPION stalks the plateau ───────
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnScorpion));
  at(640, (g) => { W.swoop(g, -1); g.later(0.9, () => W.swoop(g, 1)); });
  at(656, (g) => { W2.mlrs(g, 0); W.lane(g, 2, 2); });
  at(672, (g) => W2.strikers(g, [-5, 0, 5], 0.45));
  at(690, (g) => { W2.gunship(g, 0, 0.26); W2.skiffs(g, [-1, -1]); });
  at(708, (g) => W.carrier(g, 3, ['P']));
  at(722, (g) => W.turrets(g, [0, 2]));
  at(738, (g) => W.bomber(g, 0, ['S', 'B']));
  at(770, (g) => W.dive(g, [-4, 0, 4]));
  // REFINERY (780–1000) ───────────────────────────────────
  at(790, (g) => W.turrets(g, [0, 1, 2]));
  at(806, (g) => W2.skiffs(g, [1, -1, 1, -1], 0.6));
  at(822, (g) => { W2.gunship(g, -5, 0.28); g.later(0.7, () => W2.gunship(g, 5, 0.3)); });
  at(840, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2); g.later(1.4, () => W2.mlrs(g, 1)); });
  at(858, (g) => W2.strikers(g, [-4, 4, -1, 1], 0.4));
  at(874, (g) => W.carrier(g, -2, ['P', 'S']));
  at(890, (g) => { W.lane(g, 0, 2, 3.2, -1, 1.2); W.lane(g, 2, 2, 3.2, -1, 1.2); });
  at(906, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(924, (g) => { W.bomber(g, 0, ['P', 'B']); g.later(2.4, () => { W2.gunship(g, -6, 0.44, 7); W2.gunship(g, 6, 0.44, 7); }); });
  at(944, (g) => W.cross(g, [1, -1]));
  at(962, (g) => { W.turrets(g, [0, 2]); W2.skiffs(g, [-1, -1, -1]); });
  at(978, (g) => W.dive(g, [-6, -2, 2, 6]));
  at(990, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2); g.later(1.0, () => W2.mlrs(g, 1)); });
  // FORTRESS / AIRSTRIP (1000–1240) ───────────────────────
  at(1008, (g) => W.turrets(g, [0, 1, 2]));
  at(1022, (g) => W2.strikers(g, [-6, -2, 2, 6], 0.35));
  at(1038, (g) => { W2.gunship(g, -6, 0.26); W2.gunship(g, 0, 0.2); W2.gunship(g, 6, 0.26); });
  at(1056, (g) => { W.lane(g, 0, 3, 3); W.lane(g, 2, 3, 3); W2.skiffs(g, [1, 1]); });
  at(1072, (g) => W.carrier(g, 0, ['1UP']));
  at(1086, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2); g.later(1.2, () => W2.mlrs(g, 1)); });
  at(1102, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['B'])); });
  at(1142, (g) => { W.dive(g, [-6, -3, 0, 3, 6]); W2.rush(g, 1, 2); });
  at(1158, (g) => { W2.gunship(g, -5, 0.3); W2.gunship(g, 5, 0.3); W.turrets(g, [0, 2]); });
  at(1176, (g) => W2.skiffs(g, [1, -1, 1, -1, 1], 0.5));
  at(1190, (g) => W2.strikers(g, [-5, 5, 0], 0.4));
  at(1206, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2); W.lane(g, 1, 2); });
  at(1220, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[1],
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => spawnBehemoth(g),
  // the desert garrison hardens as the canyon gives way to the refinery and the fortress
  hpSeg: (d) => (d < 260 ? 1 : d < 560 ? 1.12 : d < 1000 ? 1.25 : 1.38),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
