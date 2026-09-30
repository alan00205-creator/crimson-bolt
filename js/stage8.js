// stage8.js — STAGE 8 "EDGE OF INFINITY" (宇宙盡頭), the final stage: out past the last galaxies to the edge of the
// Universe, air units only.
// World 'cosmos' (world.js): the void and its old galaxies 0–420 · the cosmic web 420–800 · warped space, lenses and a
// spacetime grid 800–1240 · a black hole's event horizon 1240+ (the boss arena: the hole at the top of the screen).
// Nothing below the play area but light and the dark: every unit here flies. The Architects' last machines (models
// in models_s8.js):
//   s8_wraith   void wraiths: they condense out of nothing (the shimmer is the tell), fire an aimed needle pair, then
//               fold into a sliver of light and blink somewhere else (a shimmer marks where) — a few hops, then back
//               into the void. Packs of them ambush the jet from all round
//   s8_watcher  cosmic sentinels: a great eye in a gyroscope; the ring spins up and its four emitters blaze (the
//               tell), then spray three waves outward as it turns (a rotating lattice), and the eye fires a needle
//               line at the jet
//   s8_fractal  fractal constructs: a Sierpinski tetrahedron that fires spinning three-armed fans from its corners
//               and, destroyed, splits into three smaller constructs (s8_frag, one aimed shot each), which split
//               again into splinters (s8_shard) that tumble away
//   s8_mine     singularity mines: they drift in and arm when the jet comes near (or their fuse runs out): the ring
//               spins up and blazes, space pulls toward them (a gentle tug on the jet) and a ring of light marks the
//               horizon — then they collapse: a ring of orbs appears on that circle and falls inward, crosses and
//               flies out the far side. Shoot them first and they just pop
//   sentinel    mid-boss, the great SENTINEL — see its section below
//   omega       boss, OMEGA the final core — see its section below
// Stage-1 carriers bring the items; the watchers carry a few.
import { STAGE_META } from './defs.js';
import { F } from './fx.js';
import { W, makeTimeline, midbossEvent, bossDefeated, faceYaw } from './stage.js';
import * as S3 from './stage3.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// Enemy definitions (see the field list at the top of stage.js).
export const ENEMY = {
  s8_wraith: { hp: 7, score: 600, radius: 0.85, air: true, explode: 1.0, debris: 6, medal: 0.35, noRevenge: true, prewarm: 12 },
  s8_watcher: { hp: 60, score: 3000, radius: 1.3, air: true, explode: 1.9, debris: 12, medal: 2, prewarm: 4 },
  // a fractal construct splits when it dies (its AI plays the split, see fractalAI): three sizes, one model; the
  // splits are the answer to a kill, so none of them fires revenge shots
  s8_fractal: { hp: 38, score: 2000, radius: 1.35, air: true, explode: 1.8, debris: 10, medal: 1, noRevenge: true, prewarm: 3 },
  s8_frag: { hp: 7, score: 400, radius: 0.75, air: true, explode: 1.1, debris: 5, medal: 0.3, noRevenge: true, model: 's8_fractal', prewarm: 9 },
  s8_shard: { hp: 1.5, score: 100, radius: 0.45, air: true, explode: 0.6, debris: 3, medal: 0.12, noRevenge: true, noHpSeg: true, model: 's8_fractal', prewarm: 18 },
  // a mine that is shot pops (no revenge: it would fire from where the implosion would have been)
  s8_mine: { hp: 8, score: 350, radius: 0.75, air: true, explode: 0.9, debris: 4, medal: 0.25, noRevenge: true, prewarm: 12 },
  // mid-boss: the two shields and the halo, then the eye (armoured under its iris until both shields are gone or 16 s
  // have passed; a shut shield in front of it takes the shots). The body is armour and never a target
  // (bodyTarget: false), so shots, locks and missiles go for the parts; hp is only a backstop. keepOff holds the jet
  // 7.5 below the body: the eye's muzzle is ~1 in front of it, beyond shoot()'s point-blank rule. No hull: the halo
  // stands behind the head, where a hull box would shield it.
  sentinel: {
    hp: 9999, score: 50000, radius: 2.4, air: true, explode: 3.4, debris: 30, midboss: true, noRevenge: true, bodyTarget: false, keepOff: 7.5, prewarm: 1,
    parts: [
      { key: 'shieldL', hp: 160, score: 7000, medals: 2, big: 1.8 }, { key: 'shieldR', hp: 160, score: 7000, medals: 2, big: 1.8 },
      { key: 'halo', hp: 230, score: 9000, medals: 3, big: 2.0 },
      { key: 'eye', hp: 640, core: true, score: 50000 },
    ],
  },
};

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
/** like stage.js fireTimer, on a named slot of s (a unit with several independent guns) */
function fireTimerS(s, key, dt, g, interval, first) {
  if (s[key] === undefined) s[key] = first / g.diff.fr;
  s[key] -= dt;
  if (s[key] <= 0) { s[key] += interval / g.diff.fr; return true; }
  return false;
}
/** the jet can be touched by the stage right now (pulls, ambush placement) */
const jetFree = (g) => g.player.alive && g.player.entering <= 0 && g.phase !== 'bossdead' && g.phase !== 'clear';

// --------------------------------------------------------------------------------
// shared effects (constant colour / option tables: nothing is allocated per frame)
// --------------------------------------------------------------------------------
const GH_A = [1.1, 2.0, 2.4, 0.9], GH_B = [0.15, 0.4, 0.7, 0];            // ghost-light
const ST_A = [2.6, 2.1, 1.3, 1], ST_B = [0.8, 0.45, 0.15, 0];             // starlight
const WH_A = [2.8, 2.7, 2.6, 1], WH_B = [0.9, 0.7, 0.5, 0];
const LENS_A = [0.9, 1.3, 2.2, 0.85], LENS_B = [0.5, 0.8, 1.6, 0.4];      // a mine's horizon motes
const RIM_A = [0.12, 0.2, 0.4, 0.25], RIM_B = [0.3, 0.5, 1.0, 0.5];        // … and its ring (faint: the motes mark the spots)
const OPT_FLAT = { flat: true, rot: 0, drag: 0 }, NO_DRAG = { drag: 0 }, OPT_SPARK = { drag: 3, stretch: 0.05 };
const OPT_IN = { drag: 0, stretch: 0.08 };
/** ghost-light shimmer where a wraith condenses (or will): a flat ring closing in, a soft glow, a few motes */
function shimmer(g, x, z, s = 1) {
  const p = g.fx.p;
  p.emit(x, 0.2, z, 0, 0, 0, 0.45, s * 3.2, s * 0.5, GH_A, GH_B, F.RING, 0, OPT_FLAT);
  p.emit(x, 0.3, z, 0, 0, 0, 0.35, s * 0.6, s * 2.2, GH_A, GH_B, F.GLOW, 0, NO_DRAG);
  for (let i = 0; i < 4; i++) {
    const a = rnd(0, TAU), r = rnd(1.0, 1.8) * s;
    p.emit(x + Math.cos(a) * r, 0.3, z + Math.sin(a) * r, -Math.cos(a) * 4 * s, 0, -Math.sin(a) * 4 * s, 0.25, 0.3, 0.1, GH_A, GH_B, F.GLOW, 0, NO_DRAG);
  }
}
/** a wraith folding away into the void: a vertical flash, a burst of motes */
function ghostPuff(g, x, z) {
  const p = g.fx.p;
  p.emit(x, 0.3, z, 0, 0, 0, 0.3, 0.8, 0.2, WH_A, GH_B, F.FLARE, 0, NO_DRAG);
  for (let i = 0; i < 5; i++) {
    const a = rnd(0, TAU), v = rnd(2, 5);
    p.emit(x, 0.3, z, Math.cos(a) * v, rnd(0, 1.5), Math.sin(a) * v, rnd(0.3, 0.5), 0.3, 0.05, GH_A, GH_B, F.GLOW, 0, OPT_SPARK);
  }
}
/** starlight splinters (a construct splitting, an emitter's volley) */
function starBurst(g, x, z, n, sp = 1) {
  const p = g.fx.p;
  for (let i = 0; i < n; i++) {
    const a = rnd(0, TAU), v = rnd(4, 10) * sp;
    p.emit(x, 0.4, z, Math.cos(a) * v, rnd(0, 2), Math.sin(a) * v, rnd(0.25, 0.5), rnd(0.3, 0.5), 0.06, ST_A, ST_B, F.SHARD, 0, OPT_SPARK);
  }
}

// --------------------------------------------------------------------------------
// void wraith
// --------------------------------------------------------------------------------
// Condenses at (x0, zf of the height) — invulnerable while it forms (the shimmer, 0.55 s) — turns to face the jet,
// drifts toward its column and fires an aimed needle pair; then `hops` times: it folds into a sliver (0.22 s, a
// shimmer where it will come out), blinks there and unfolds, and fires again. Then it folds back into the void.
// Blinks always land well clear of the jet and in the upper half of the screen.
const WR_FORM = 0.55, WR_FOLD = 0.22;
function wraithAI(x0, zf = 0.24, hops = 2, glide = 0.95) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData, p = g.player;
    const top = zAtRow(v, HUD_ROW) + 1.2, low = v.zTop + (v.zBottom - v.zTop) * 0.46;
    if (!s.mode) {
      s.mode = 'form'; s.mt = 0; s.n = 0; s.fixedYaw = true; s.yaw = Math.PI;
      e.x = x0; e.z = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, top); e.invuln = true;
      // never condense within 5.5 of the jet: up the screen first, then sideways away from it
      for (let q = 0; q < 14 && Math.hypot(e.x - p.x, e.z - p.z) < 5.5; q++) {
        if (e.z > top) e.z = Math.max(top, e.z - 1);
        else e.x = clamp(e.x + (e.x >= p.x ? 1 : -1), -6.8, 6.8);
      }
      if (ud.setPhase) ud.setPhase(1);
      shimmer(g, e.x, e.z, 1);
    }
    s.mt += dt;
    s.yaw += clamp(wrapA(faceYaw(e, p.x, p.z) - s.yaw), -4 * dt, 4 * dt);
    if (s.mode === 'form' || s.mode === 'unfold') {
      const dur = s.mode === 'form' ? WR_FORM : WR_FOLD, k = clamp(s.mt / dur, 0, 1);
      if (ud.setPhase) ud.setPhase(1 - ease(k));
      if (k > 0.6) e.invuln = false;
      if (k >= 1) { s.mode = 'glide'; s.mt = 0; s.fired = false; }
    } else if (s.mode === 'glide') {
      e.x += clamp(clamp(p.x, -6.5, 6.5) - e.x, -1.4 * dt, 1.4 * dt);
      e.z += Math.sin(e.t * 2.3) * 0.25 * dt;
      if (!s.fired && s.mt > glide * 0.4) {
        s.fired = true;
        if (g.canFire(e)) {
          const m = g.muzzlePos(e.mesh), mx = m.x, mz = m.z, a = g.aim(mx, mz);
          g.shoot(mx, mz, a - 0.11, 8.4, g.BK.NEEDLE); g.shoot(mx, mz, a + 0.11, 8.4, g.BK.NEEDLE);
          g.fx.p.emit(mx, 0.3, mz, 0, 0, 0, 0.12, 0.5, 1.1, GH_A, GH_B, F.FLARE, 0, NO_DRAG);
        }
      }
      if (s.mt > glide) {
        s.mt = 0;
        if (s.n >= hops) { s.mode = 'vanish'; e.invuln = true; }
        else {
          s.mode = 'fold'; s.n++;
          // the next spot: across toward the jet's side, never within 6 of it, inside the upper screen
          let tx = clamp(p.x + rnd(-3.8, 3.8), -6.6, 6.6);
          if (Math.abs(tx - e.x) < 2.2) tx = clamp(e.x + (tx >= e.x ? 2.4 : -2.4), -6.6, 6.6);
          let tz = clamp(e.z + rnd(-1.2, 2.4), top, low);
          const dx = tx - p.x, dz = tz - p.z;
          if (dx * dx + dz * dz < 36) tz = Math.max(top, p.z - 6.2);
          s.tx = tx; s.tz = tz;
          shimmer(g, tx, tz, 0.8);
          g.audio.play('lock', { vol: 0.18, pitch: 14 });
        }
      }
    } else if (s.mode === 'fold') {
      const k = clamp(s.mt / WR_FOLD, 0, 1);
      if (ud.setPhase) ud.setPhase(ease(k));
      if (k > 0.5) e.invuln = true;
      if (k >= 1) { ghostPuff(g, e.x, e.z); e.x = s.tx; e.z = s.tz; s.mode = 'unfold'; s.mt = 0; }
    } else {                                   // back into the void (no score: it got away)
      const k = clamp(s.mt / 0.3, 0, 1);
      if (ud.setPhase) ud.setPhase(ease(k));
      if (k >= 1) { ghostPuff(g, e.x, e.z); e.alive = false; }
    }
    if (Math.random() < 0.25) g.fx.p.emit(e.x + rnd(-0.5, 0.5), 0.1, e.z - 0.8, 0, 0, -0.6, 0.5, 0.35, 0.8, GH_A, GH_B, F.GLOW, 0, NO_DRAG);
  };
}

// --------------------------------------------------------------------------------
// cosmic sentinel (watcher)
// --------------------------------------------------------------------------------
// Glides down into the upper screen, holds for `stay` s with a slow sway, then climbs away. Its cycle: the ring
// spins up and the emitters blaze (0.55 s: the tell), then three waves 0.16 s apart — each emitter throws a pair
// outward along its arm, and the ring is still turning, so the waves wind into a lattice — and the eye fires a
// line of three needles at the jet.
function watcherAI(x0, zf = 0.24, stay = 8) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (s.z0 === undefined) {
      s.z0 = v.zTop - 3; s.tz = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 1.8);
      s.fixedYaw = true; s.yaw = Math.PI; s.st = 'idle'; s.ct = 1.3; s.mt = 0; s.spin = 0.6; s.q = 0;
      if (ud.setCharge) ud.setCharge(0);
    }
    const dir = Math.sign(x0) || 1;
    if (e.t < 2.4) { e.x = x0; e.z = s.z0 + (s.tz - s.z0) * ease(e.t / 2.4); }
    else if (e.t < 2.4 + stay) { const k = e.t - 2.4; e.x = x0 - dir * Math.sin(k * 0.5) * 1.4; e.z = s.tz + Math.sin(k * 0.9) * 0.3; }
    else { const k = e.t - 2.4 - stay; e.z -= (1.2 + k * 5) * dt; }
    if (ud.ring) ud.ring.rotation.y += dt * s.spin;
    const busy = e.t > 1.8 && e.t < 2.4 + stay;
    s.mt += dt;
    if (s.st === 'idle') {
      s.spin += (0.6 - s.spin) * Math.min(1, dt * 2);
      if (ud.setCharge) ud.setCharge(0);
      if (busy) s.ct -= dt;
      if (s.ct <= 0 && g.canFire(e)) { s.st = 'charge'; s.mt = 0; g.audio.play('lock', { vol: 0.28, pitch: 4 }); }
    } else if (s.st === 'charge') {
      if (ud.setCharge) ud.setCharge(s.mt / 0.5);
      s.spin = 0.6 + 2.6 * smooth(s.mt / 0.55);
      if (s.mt > 0.55) { s.st = 'burst'; s.mt = 0; s.q = 0; }
    } else {
      while (s.q < 3 && s.mt >= s.q * 0.16) {
        s.q++;
        if (g.canFire(e) && ud.ring) {
          for (let k = 0; k < 4; k++) {
            const m = g.muzzlePos(ud.ring, k), mx = m.x, mz = m.z, a = Math.atan2(mx - e.x, mz - e.z);
            g.shoot(mx, mz, a - 0.1, 5.4); g.shoot(mx, mz, a + 0.1, 5.4);
          }
        }
      }
      if (s.q >= 3 && s.mt > 0.55) {
        if (g.canFire(e)) {
          const m = g.muzzlePos(e.mesh), mx = m.x, mz = m.z, a = g.aim(mx, mz);
          for (let q = 0; q < 3; q++) g.shoot(mx, mz, a, 7.8 + q * 1.1, g.BK.NEEDLE);
        }
        s.st = 'idle'; s.ct = 2.7 / g.diff.fr;
      }
    }
  };
}

// --------------------------------------------------------------------------------
// fractal constructs
// --------------------------------------------------------------------------------
// One model at three sizes. A construct's death is its split: its hit points are kept in s.hp (the engine's e.hp
// is held at a large value and the damage taken read back from it every frame), so the AI sees the killing blow,
// flings out the next size along its corners and only then kills itself (score, blast, medals as usual).
const FR = {
  s8_fractal: { scale: 1, tint: 0, next: 's8_frag', n: 3 },
  s8_frag: { scale: 0.52, tint: 0.45, next: 's8_shard', n: 3 },
  s8_shard: { scale: 0.28, tint: 1, next: null, n: 0 },
};
const HP_HOLD = 1e6;
/** keeps the construct's real hit points in s.hp; true once they are gone (the split then follows) */
function fractalHit(e) {
  const s = e.s;
  if (s.hp === undefined) { s.hp = e.hp; e.hp = HP_HOLD; }
  if (e.hp < HP_HOLD) { s.hp -= HP_HOLD - e.hp; e.hp = HP_HOLD; }
  return s.hp <= 0;
}
function fractalSplit(e, g) {
  const f = FR[e.type];
  if (f.next) {
    const ud = e.mesh.userData, spin = ud.spin ? ud.spin.rotation.y : 0;
    for (let k = 0; k < f.n; k++) {
      const a = spin + (k * TAU) / f.n + rnd(-0.25, 0.25);
      g.spawn(f.next, { x: e.x + Math.sin(a) * 0.4 * f.scale, z: e.z + Math.cos(a) * 0.4 * f.scale, ai: fragAI(a, f.next === 's8_frag' ? 6.5 : 7.5) });
    }
  }
  starBurst(g, e.x, e.z, f.next === 's8_frag' ? 14 : 8, f.scale + 0.3);
  g.fx.p.emit(e.x, 0.3, e.z, 0, 0, 0, 0.3, f.scale * 1.2, f.scale * 5, ST_A, ST_B, F.RING, 0, OPT_FLAT);
  g.killEnemy(e);
}
// The whole construct: glides down into the upper screen, holds (a slow drift) for `stay` s, then climbs away. Every
// 2.2 s its cores blaze (0.45 s: the tell) and each lower corner throws a three-orb fan straight out from the centre
// (it is turning, so every volley points a new way) while the top fires an aimed needle pair.
function fractalAI(x0, zf = 0.24, stay = 10) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (fractalHit(e)) { fractalSplit(e, g); return; }
    if (s.z0 === undefined) {
      s.z0 = v.zTop - 3; s.tz = Math.max(v.zTop + (v.zBottom - v.zTop) * zf, zAtRow(v, HUD_ROW) + 2.0); s.fixedYaw = true; s.yaw = Math.PI;
      s.st = 'idle'; s.ct = 1.2; s.mt = 0;
      e.mesh.scale.setScalar(1);
      if (ud.setTint) { ud.setTint(0); ud.setCharge(0); }
    }
    const dir = Math.sign(x0) || 1;
    if (e.t < 3) { e.x = x0; e.z = s.z0 + (s.tz - s.z0) * ease(e.t / 3); }
    else if (e.t < 3 + stay) { const k = e.t - 3; e.x = x0 - dir * Math.sin(k * 0.4) * 1.8; e.z = s.tz + Math.sin(k * 0.7) * 0.5; }
    else { const k = e.t - 3 - stay; e.z -= (1 + k * 4) * dt; e.x += dir * k * 1.2 * dt; }
    s.mt += dt;
    if (s.st === 'idle') {
      if (ud.setCharge) ud.setCharge(0);
      if (e.t > 2.6 && e.t < 3 + stay) s.ct -= dt;
      if (s.ct <= 0 && g.canFire(e)) { s.st = 'charge'; s.mt = 0; g.audio.play('lock', { vol: 0.25, pitch: 9 }); }
    } else if (s.mt < 0.45) {
      if (ud.setCharge) ud.setCharge(s.mt / 0.45);
    } else {
      s.st = 'idle'; s.ct = 2.2 / g.diff.fr;
      if (ud.setCharge) ud.setCharge(0);
      if (g.canFire(e)) {
        for (let k = 0; k < 3; k++) {
          const m = g.muzzlePos(e.mesh, k), mx = m.x, mz = m.z;
          g.fan(mx, mz, Math.atan2(mx - e.x, mz - e.z), 3, 0.32, 5.2);
        }
        const m = g.muzzlePos(e.mesh, 3), mx = m.x, mz = m.z, a = g.aim(mx, mz);
        g.shoot(mx, mz, a - 0.05, 8.2, g.BK.NEEDLE); g.shoot(mx, mz, a + 0.05, 8.2, g.BK.NEEDLE);
        starBurst(g, e.x, e.z, 4, 0.6);
      }
    }
  };
}
// A piece flung out of a split (heading a, speed sp): it slows, then drifts down and away, still turning. The middle
// size fires one aimed orb after 0.9 s; the splinters don't fire.
function fragAI(a, sp) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, f = FR[e.type];
    if (fractalHit(e)) { fractalSplit(e, g); return; }
    if (s.vx === undefined) {
      s.vx = Math.sin(a) * sp; s.vz = Math.cos(a) * sp; s.fixedYaw = true; s.yaw = rnd(0, TAU);
      e.mesh.scale.setScalar(f.scale);
      if (ud.setTint) { ud.setTint(f.tint); ud.setCharge(0.6); }
    }
    e.mesh.scale.setScalar(f.scale);
    const k = Math.max(0, 1 - dt * 2.2);
    s.vx *= k; s.vz = s.vz * k + (1 - k) * 2.2;          // settles into a slow fall down the screen
    e.x += s.vx * dt; e.z += s.vz * dt;
    if (ud.setCharge) ud.setCharge(Math.max(0, 0.6 - e.t));
    if (e.type === 's8_frag' && !s.fired && e.t > 0.9) {
      s.fired = true;
      if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 6.4);
    }
  };
}

// --------------------------------------------------------------------------------
// singularity mine
// --------------------------------------------------------------------------------
// Drifts (vx, vz). It arms when the jet comes within `near` or when `fuse` s have passed on screen: for 0.95 s it
// spins up and blazes, a ring of light marks its horizon (MN_R) and space pulls toward it (a gentle tug on the jet,
// never more than a fifth of its slow speed). Then it collapses: a ring of orbs appears on the horizon, falls in,
// crosses in the middle and flies out the far side. shoot() never places an orb within reach of the jet, so the ring
// always has a gap where the jet is.
const MN_ARM = 0.95, MN_R = 3.6, MN_PULL = 1.3, MN_PULL_R = 7.5;
function mineAI(vx, vz, fuse = 5, near = 5.5) {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, p = g.player, v = g.view;
    if (s.mode === undefined) { s.mode = 'drift'; s.mt = 0; s.on = 0; s.fixedYaw = true; s.yaw = 0; if (ud.setArm) ud.setArm(0); }
    s.mt += dt;
    if (s.mode === 'drift') {
      e.x += vx * dt; e.z += vz * dt;
      if (v.onScreen(e.x, e.z, -1)) s.on += dt;
      const dx = p.x - e.x, dz = p.z - e.z;
      if (s.on > 0.6 && (s.on > fuse || (jetFree(g) && dx * dx + dz * dz < near * near))) {
        s.mode = 'arm'; s.mt = 0; s.n = g.diff.level >= 2 ? 14 : 12; s.a0 = rnd(0, TAU);
        g.audio.play('lock', { vol: 0.35, pitch: -8 });
        // the horizon: a faint ring, and a mote on every spot an orb will appear
        g.fx.p.emit(e.x, 0.1, e.z, 0, 0, 0, MN_ARM, MN_R / 0.39, MN_R / 0.39 * 0.97, RIM_A, RIM_B, F.RING, 0, OPT_FLAT);
        for (let q = 0; q < s.n; q++) {
          const a = s.a0 + (q * TAU) / s.n;
          g.fx.p.emit(e.x + Math.sin(a) * MN_R, 0.15, e.z + Math.cos(a) * MN_R, vx * 0.25, 0, vz * 0.25, MN_ARM, 0.15, 0.75, LENS_A, LENS_B, F.GLOW, 0, NO_DRAG);
        }
      }
    } else {
      e.x += vx * 0.25 * dt; e.z += vz * 0.25 * dt;
      const k = clamp(s.mt / MN_ARM, 0, 1);
      if (ud.setArm) ud.setArm(k);
      // space pours in: streaks falling toward it
      if (Math.random() < 0.7) {
        const a = rnd(0, TAU), r = rnd(2.2, 3.6);
        g.fx.p.emit(e.x + Math.sin(a) * r, 0.1, e.z + Math.cos(a) * r, -Math.sin(a) * 6, 0, -Math.cos(a) * 6, 0.3, 0.25, 0.1, LENS_A, LENS_B, F.GLOW, 0, OPT_IN);
      }
      // the tug on the jet
      if (jetFree(g)) {
        const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
        if (d > 0.5 && d < MN_PULL_R) { const f = MN_PULL * (1 - d / MN_PULL_R) * k * dt / d; p.x += dx * f; p.z += dz * f; }
      }
      if (k >= 1) {
        if (g.canFire(e)) {
          for (let q = 0; q < s.n; q++) {
            const a = s.a0 + (q * TAU) / s.n;
            g.shoot(e.x + Math.sin(a) * MN_R, e.z + Math.cos(a) * MN_R, a + Math.PI, 3.6);
          }
        }
        g.fx.p.emit(e.x, 0.3, e.z, 0, 0, 0, 0.25, 2.6, 0.2, WH_A, LENS_B, F.GLOW, 0, NO_DRAG);
        g.fx.p.emit(e.x, 0.1, e.z, 0, 0, 0, 0.3, MN_R / 0.39, 0.3, RIM_A, RIM_B, F.RING, 0, OPT_FLAT);
        g.audio.play('hitArmor', { vol: 0.6, pitch: -9 });
        e.alive = false;                        // gone down its own hole: no score
      }
    }
  };
}

// --------------------------------------------------------------------------------
// mid-boss: the great SENTINEL
// --------------------------------------------------------------------------------
// It steps out of a flare of starlight above the web and holds the gate. Its shields swing in turns: shut over the
// chest (3 s — they take the shots meant for the eye) and swung out (4 s — each throws a fan from its point as it
// opens). The halo behind its head turns and pours a wheel of orbs from its eight rays in pulses. Once both shields
// are gone (or after 16 s) the iris opens on the eye: its judgment is a cross of four needle streams — the arms are
// drawn first, a quarter-turn off the jet (0.9 s: the tell), then fire as they sweep 36° on round; below half health
// it adds rings. After 46 s it gives up and folds away into the light.
const SN_ROW = 9.5, SN_EYE_OPEN = 16, SN_FIGHT = 46;
const SN_GUARD = 3.0, SN_SWING = 4.2;
const XL_A = [2.4, 1.9, 1.0, 1], XL_B = [2.4, 1.9, 1.0, 1];            // the cross's telegraph (alpha set per frame)
const OPT_LINE = { drag: 0, stretch: 1 };
/** the judgment's telegraph: one stretched streak from (x, z) along ang, len long, at brightness k */
function crossLine(g, x, z, ang, len, k) {
  const sx = Math.sin(ang), sz = Math.cos(ang);
  XL_A[3] = XL_B[3] = 0.55 * k; XL_A[0] = XL_B[0] = 1.6 + k; OPT_LINE.stretch = len;
  g.fx.p.emit(x + sx * (len * 0.5 + 0.8), 0.12, z + sz * (len * 0.5 + 0.8), sx, 0, sz, 0.05, 0.35 + 0.25 * k, 0.35 + 0.25 * k, XL_A, XL_B, F.STREAK, 0, OPT_LINE);
}
function sentinelAI() {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.life = 0; s.open = 0; s.b = 0; s.fixedYaw = true; s.yaw = Math.PI;
      // station: the halo's top edge (≈ e.z − 4.9 at y ≈ 2) stays below the score strip
      e.x = 0; e.z = v.zTop - 8; s.tz = Math.max(v.zTop + SN_ROW, zAtRow(v, HUD_ROW, 2.0) + 5.2); e.invuln = true; e.armored = true;
      s.sh = [g.partByKey(e, 'shieldL'), g.partByKey(e, 'shieldR')]; s.halo = g.partByKey(e, 'halo'); s.eye = g.partByKey(e, 'eye');
      s.gst = 'guard'; s.gt = SN_GUARD; s.guard = 1; s.jst = 'rest'; s.jt = 1.6; s.jdir = 1; s.ja = 0; s.ht = 1.2; s.hq = 0; s.hon = 0;
      if (ud.reset) ud.reset();
      e.mesh.scale.setScalar(0.3);
      g.fx.p.emit(0, 0.4, s.tz - 1, 0, 0, 0, 0.6, 2, 14, WH_A, ST_B, F.FLARE, 0, NO_DRAG);
      g.fx.p.emit(0, 0.2, s.tz - 1, 0, 0, 0, 0.9, 1, 16, ST_A, ST_B, F.RING, 0, OPT_FLAT);
      g.audio.play('lock', { vol: 0.55, pitch: -12 });
    }
    s.life += dt;
    const P = s.sh, halo = live(s.halo), eye = s.eye;
    if (e.dying) { sentinelDeath(e, dt, g); return; }
    if (s.mode === 'enter') {
      const k = ease(e.t / 3.4);
      e.z = (v.zTop - 8) + (s.tz - (v.zTop - 8)) * k;
      e.mesh.scale.setScalar(0.3 + 0.7 * ease(e.t / 2.4));
      if (Math.random() < 0.6) starBurst(g, e.x + rnd(-2, 2), e.z + rnd(-3, 2), 1, 0.4);
      if (e.t > 3.4) { s.mode = 'fight'; s.ft = 0; e.invuln = false; e.mesh.scale.setScalar(1); }
    } else if (s.mode === 'fight') {
      s.ft += dt;
      e.x = Math.sin(s.ft * 0.42) * 2.6;
      e.z = s.tz + Math.sin(s.ft * 0.77) * 0.5;
      if (s.ft > SN_FIGHT) { s.mode = 'retreat'; s.rt = 0; g.audio.play('lock', { vol: 0.5, pitch: -12 }); }
    } else {                                   // it folds away into the light: the stage goes on
      s.rt += dt;
      e.z -= (1 + s.rt * 5) * dt;
      e.mesh.scale.setScalar(Math.max(0.04, 1 - smooth(s.rt / 1.1)));
      if (Math.random() < 0.8) starBurst(g, e.x + rnd(-1.5, 1.5), e.z + rnd(-2, 2), 1, 0.5);
      if (s.rt > 1.1) {
        g.fx.p.emit(e.x, 0.4, e.z, 0, 0, 0, 0.5, 1.5, 10, WH_A, ST_B, F.FLARE, 0, NO_DRAG);
        e.alive = false; g.midbossDone = true;
      }
    }
    // the shields swing in turns (shut over the chest / out to the sides)
    const nSh = (live(P[0]) ? 1 : 0) + (live(P[1]) ? 1 : 0);
    if (s.mode === 'fight' && nSh) {
      s.gt -= dt;
      if (s.gst === 'guard' && s.gt <= 0) { s.gst = 'swing'; s.gt = SN_SWING; s.struck = false; g.audio.play('lock', { vol: 0.3, pitch: -4 }); }
      else if (s.gst === 'swing' && s.gt <= 0) { s.gst = 'guard'; s.gt = SN_GUARD * (nSh === 2 ? 1 : 0.8); }
    } else if (s.mode !== 'fight') s.gst = 'guard';
    s.guard += ((s.gst === 'guard' ? 1 : 0) - s.guard) * Math.min(1, dt * 3.2);
    for (let k = 0; k < 2; k++) if (P[k] && !P[k].obj.userData.destroyed) P[k].obj.userData.setGuard(s.guard);
    // the eye opens once both shields are gone (or it is tired of waiting)
    const wantOpen = s.mode === 'fight' && (!nSh || s.ft > SN_EYE_OPEN) ? 1 : 0;
    s.open += (wantOpen - s.open) * Math.min(1, dt * 2.0);
    if (eye && eye.obj.userData.setOpen) eye.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;
    if (!s.opened && s.open > 0.5) { s.opened = true; g.audio.play('warning', { vol: 0.4 }); g.shake.add(0.25); starBurst(g, e.x, e.z + 0.5, 12, 1); }
    if (s.mode !== 'fight' || !g.canFire(e)) { if (ud.setCharge) ud.setCharge(0); if (s.jst !== 'rest') { s.jst = 'rest'; s.jt = 1.5; } return; }
    const fr = g.diff.fr, hard = g.diff.level >= 2;
    // the shields' strike: a fan from each point as it swings out
    if (s.gst === 'swing' && !s.struck && s.guard < 0.25) {
      s.struck = true;
      for (let k = 0; k < 2; k++) {
        const pt = live(P[k]);
        if (!pt) continue;
        const m = g.muzzlePos(pt.obj), mx = m.x, mz = m.z;
        g.fan(mx, mz, g.aim(mx, mz), 7, 1.05, 6.0);
        starBurst(g, mx, mz, 4, 0.6);
      }
    }
    // the halo's wheel: every ray throws an orb straight out, 0.42 s apart for 2.4 s, then 2.2 s of rest; the halo turns
    // between volleys, so the wheel winds into eight spiral arms
    if (halo) {
      s.hon = (s.hon + dt) % 4.6;
      if (s.hon < 2.4) {
        s.ht -= dt;
        if (s.ht <= 0) {
          s.ht = 0.42 / fr;
          const hx = halo.x, hz = halo.z;
          for (let k = 0; k < 8; k++) { const m = g.muzzlePos(halo.obj, k), mx = m.x, mz = m.z; g.shoot(mx, mz, Math.atan2(mx - hx, mz - hz), 4.0); }
        }
      }
    }
    // the eye's judgment: the cross drawn a quarter-turn off the jet, then four needle streams as it sweeps on round
    if (eye && s.open > 0.85) {
      const m = g.muzzlePos(eye.obj), ex = m.x, ez = m.z;
      s.jt -= dt;
      if (s.jst === 'rest') {
        if (ud.setCharge) ud.setCharge(0);
        if (s.jt <= 0) { s.jst = 'mark'; s.jt = 0.9; s.jdir = -s.jdir; s.ja = g.aim(ex, ez) - s.jdir * Math.PI / 4; g.audio.play('lock', { vol: 0.45, pitch: -2 }); }
      } else if (s.jst === 'mark') {
        const k = 1 - s.jt / 0.9;
        if (ud.setCharge) ud.setCharge(k);
        for (let q = 0; q < 4; q++) crossLine(g, ex, ez, s.ja + q * Math.PI / 2 + s.jdir * 0.12 * k, 16, 0.3 + 0.7 * k);
        if (s.jt <= 0) { s.jst = 'sweep'; s.jt = 1.4; s.jst2 = 0; g.audio.play('missile', { vol: 0.7, pitch: -6 }); g.shake.add(0.15); }
      } else {
        if (ud.setCharge) ud.setCharge(0.8);
        s.ja += s.jdir * 0.45 * dt;
        s.jst2 -= dt;
        while (s.jst2 <= 0 && s.jt > 0) { s.jst2 += 0.075; for (let q = 0; q < 4; q++) g.shoot(ex, ez, s.ja + q * Math.PI / 2, 10.5, g.BK.NEEDLE); }
        if (s.jt <= 0) { s.jst = 'rest'; s.jt = 2.6 / fr; }
      }
      if (eye.hp < eye.maxHp * 0.5) {
        s.rgT = (s.rgT ?? 1.6) - dt;
        if (s.rgT <= 0 && s.jst === 'rest') { s.rgT = 3.4 / fr; s.b += 0.21; g.ring(ex, ez, hard ? 18 : 14, 4.4, s.b, g.BK.BIG); }
      }
    }
  };
}
// Death: the shields are torn off, the halo shatters, blasts run down the body while the eye blazes and throws its
// cross one last time as light, then it bursts in a flash of starlight; the items.
function sentinelDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT;
  e.z -= 0.4 * dt;
  s.pitch = Math.min(0.2, t * 0.1);
  e.roll = Math.sin(t * 8) * 0.06;
  if (ud.setCharge) ud.setCharge(Math.min(1, t / 1.2) * (0.7 + Math.sin(t * 30) * 0.3));
  if (ud.setFlash && t < 1.9) ud.setFlash(Math.max(0, Math.sin(t * 25)) * 0.5);
  // the parts still standing go one by one
  s.popT = (s.popT ?? 0.2) - dt;
  if (s.popT <= 0 && t < 1.4) {
    s.popT = 0.3;
    let pt = null;
    for (let i = 0; i < e.parts.length && !pt; i++) if (!e.parts[i].dead && !e.parts[i].core) pt = e.parts[i];
    if (pt) {
      pt.dead = true;
      if (pt.obj.userData.setDestroyed) pt.obj.userData.setDestroyed(true);
      g.fx.explosion(pt.x, 0.4, pt.z, Math.min(1.8, pt.big), { debris: 8, color: ud.debrisColor });
      starBurst(g, pt.x, pt.z, 8, 1);
      g.audio.play('explodeL', { vol: 0.7 });
    }
  }
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0) {
    s.boomT = 0.1;
    const x = e.x + rnd(-1.2, 1.2), z = e.z + rnd(-3, 3);
    g.fx.explosion(x, 0.3, z, rnd(0.9, 1.6), { debris: 4, color: ud.debrisColor });
    g.audio.play('explodeM', { vol: 0.65, pan: clamp(x / 10, -1, 1) });
    g.shake.add(0.12);
  }
  // the judgment turns on itself: the cross, drawn in light from the eye, widening
  if (t > 0.8) { const m = g.muzzlePos(s.eye.obj), k = Math.min(1, (t - 0.8) / 0.9); for (let q = 0; q < 4; q++) crossLine(g, m.x, m.z, q * Math.PI / 2 + t * 0.6, 4 + k * 16, 0.4 + k * 0.6); }
  if (t > 1.9) {
    g.fx.explosion(e.x, 0.4, e.z, 4, { debris: 30, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z, 20, [2.6, 2.2, 1.4, 1], 0.8);
    g.fx.shockwave(e.x, 0.1, e.z, 12, [2.4, 2.4, 2.6, 1], 0.5);
    g.fx.p.emit(e.x, 0.5, e.z, 0, 0, 0, 0.5, 2, 16, WH_A, ST_B, F.FLARE, 0, NO_DRAG);
    starBurst(g, e.x, e.z, 26, 2);
    g.shake.add(0.7); g.ui.flash(0.55);
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
function spawnSentinel(g) {
  const e = g.spawn('sentinel', { x: 0, z: g.view.zTop - 8, ai: sentinelAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key === 'shieldL' || pt.key === 'shieldR') g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    else if (pt.key === 'halo') { g.dropItem('S', pt.x, pt.z, { sub: g.player.sub || 'H' }); starBurst(g, pt.x, pt.z, 16, 1.4); }
  };
  return e;
}

// --------------------------------------------------------------------------------
// spawn helpers for this stage's units (the stage-1 ones come from W)
// --------------------------------------------------------------------------------
const W8 = {
  // wraiths condensing at xs (one every `gap` s), hopping `hops` times
  wraiths(g, xs, zf = 0.22, hops = 2, gap = 0.35) {
    xs.forEach((x, i) => g.later(i * gap, () => g.spawn('s8_wraith', { x, z: -60, ai: wraithAI(x, zf + (i % 2) * 0.06, hops) })));
  },
  // an ambush: n wraiths condense round the jet at ~7.5 (above it and to the sides, inside the screen)
  ambush(g, n = 4, hops = 1) {
    const p = g.player, v = g.view;
    for (let i = 0; i < n; i++) {
      g.later(i * 0.12, () => {
        const a = Math.PI + (i / (n - 1 || 1) - 0.5) * 2.3;          // fanned over the upper half round the jet
        const x = clamp(p.x + Math.sin(a) * 7.5, -6.6, 6.6);
        const zf = clamp((p.z + Math.cos(a) * 7.5 - v.zTop) / (v.zBottom - v.zTop), 0.12, 0.5);
        g.spawn('s8_wraith', { x, z: -60, ai: wraithAI(x, zf, hops, 1.1) });
      });
    }
  },
  watcher(g, x0, drops, stay = 8, zf = 0.24) { return g.spawn('s8_watcher', { x: x0, z: -60, ai: watcherAI(x0, zf, stay), drops }); },
  fractal(g, x0, drops, stay = 10, zf = 0.24) { return g.spawn('s8_fractal', { x: x0, z: -60, ai: fractalAI(x0, zf, stay), drops }); },
  // a mine drifting in from above (x0, a row fraction to enter at is implicit: it starts off the top)
  mine(g, x0, vx = 0, vz = 2.2, fuse = 5.5, z0 = null) {
    return g.spawn('s8_mine', { x: x0, z: z0 ?? g.view.zTop - 2, ai: mineAI(vx, vz, fuse) });
  },
  // a row of mines across the top
  mineRow(g, xs, vz = 2.2, fuse = 5.5, gap = 0) { xs.forEach((x, i) => g.later(i * gap, () => W8.mine(g, x, 0, vz, fuse + i * 0.3))); },
  // mines streaming in from a flank (side +1: from the right) along the upper screen
  mineSweep(g, side, n = 4, zf = 0.3, gap = 0.9) {
    for (let i = 0; i < n; i++) {
      g.later(i * gap, () => {
        const v = g.view;
        W8.mine(g, side * 11, -side * 3.0, 0.5, 4.0, v.zTop + (v.zBottom - v.zTop) * zf);
      });
    }
  },
};

// Stand-in until OMEGA lands: stage 3's SERAPH.
// --------------------------------------------------------------------------------
// Stage 8 timeline (distance in stage units; ~7 units/s)
// --------------------------------------------------------------------------------
const TIMELINE = makeTimeline((at) => {
  // THE VOID ───────────────────────────────────────────
  at(22, (g) => W8.wraiths(g, [-4.5, 0, 4.5], 0.2, 2));
  at(40, (g) => W8.wraiths(g, [5.5, 2, -2, -5.5], 0.26, 2, 0.3));
  at(58, (g) => W.carrier(g, 2, ['P']));
  at(72, (g) => { W8.watcher(g, 0, null, 7); g.later(2.5, () => W8.wraiths(g, [-5.5, 5.5], 0.3, 1)); });
  at(98, (g) => W8.mineRow(g, [-6, -2, 2, 6], 2.0, 5.0, 0.25));
  at(118, (g) => { W8.wraiths(g, [-5, -1.5, 1.5, 5], 0.2, 3, 0.3); });
  at(140, (g) => W8.fractal(g, 0, null, 9));
  at(162, (g) => { W8.watcher(g, -4, null, 7); g.later(1.2, () => W8.watcher(g, 4, null, 7, 0.3)); });
  at(186, (g) => W8.ambush(g, 4, 1));
  at(204, (g) => W.carrier(g, -2, ['P', 'S']));
  at(216, (g) => { W8.mineSweep(g, 1, 4, 0.22); g.later(2.4, () => W8.wraiths(g, [-4, 0], 0.3, 2)); });
  at(240, (g) => { W8.fractal(g, -4, null, 8); g.later(1.6, () => W8.fractal(g, 4, null, 8, 0.3)); });
  at(264, (g) => { W8.watcher(g, 0, ['P'], 8, 0.2); g.later(2, () => W8.wraiths(g, [-5.5, 5.5, -2.5, 2.5], 0.3, 2, 0.25)); });
  at(290, (g) => { W8.mineRow(g, [-6, -3, 0, 3, 6], 1.8, 5.5, 0.15); g.later(2.8, () => W8.mineRow(g, [-4.5, -1.5, 1.5, 4.5], 1.8, 5.5, 0.15)); });
  at(316, (g) => { W8.ambush(g, 5, 1); g.later(2.4, () => W8.fractal(g, 0, null, 8, 0.2)); });
  at(340, (g) => { W8.watcher(g, -5, null, 7); W8.watcher(g, 0, null, 7, 0.3); W8.watcher(g, 5, null, 7); });
  // (rest beat)
  at(368, (g) => W.carrier(g, 0, ['B']));
  at(382, (g) => W8.wraiths(g, [-6, -3, 0, 3, 6], 0.22, 2, 0.28));
  at(402, (g) => { W8.fractal(g, -3.5, null, 8); g.later(2.2, () => W8.mineSweep(g, -1, 3, 0.34)); });
  // THE COSMIC WEB ─────────────────────────────────────
  at(428, (g) => { W8.fractal(g, 0, ['P'], 10, 0.2); g.later(2.4, () => { W8.watcher(g, -5, null, 7, 0.3); W8.watcher(g, 5, null, 7, 0.3); }); });
  at(456, (g) => W8.ambush(g, 5, 2));
  at(478, (g) => { W8.mineRow(g, [-5, -1.5, 2, 5.5], 2.2, 4.5, 0.2); g.later(1.8, () => W8.wraiths(g, [0, -4, 4], 0.22, 2)); });
  at(502, (g) => { W8.watcher(g, -3.5, ['S'], 8, 0.22); W8.watcher(g, 3.5, null, 8, 0.28); });
  at(526, (g) => { W8.fractal(g, -5, null, 8); W8.fractal(g, 0, null, 8, 0.3); W8.fractal(g, 5, null, 8); });
  at(548, (g) => W.carrier(g, 0, ['P']));
  at(560, (g) => { W8.wraiths(g, [-5.5, -2, 2, 5.5], 0.24, 2, 0.25); g.later(1.4, () => W8.mineSweep(g, 1, 3, 0.2)); });
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnSentinel));
  at(626, (g) => W.carrier(g, -3, ['S']));
  at(640, (g) => { W8.ambush(g, 5, 1); g.later(2.6, () => W8.fractal(g, 0, null, 8, 0.22)); });
  at(664, (g) => { W8.watcher(g, -5, null, 8); W8.watcher(g, 0, ['P'], 8, 0.3); W8.watcher(g, 5, null, 8); });
  at(692, (g) => { W8.mineSweep(g, -1, 4, 0.2); W8.mineSweep(g, 1, 4, 0.36, 1.0); });
  at(716, (g) => { W8.fractal(g, -4, ['B'], 9); W8.fractal(g, 4, null, 9, 0.3); g.later(3, () => W8.wraiths(g, [-6, 6], 0.3, 2)); });
  at(744, (g) => W8.wraiths(g, [-6, -3, 0, 3, 6, -1.5], 0.2, 3, 0.25));
  at(768, (g) => { W.carrier(g, 2, ['P']); g.later(1.5, () => W8.mineRow(g, [-6, -2, 2, 6], 2.0, 5.0)); });
  at(788, (g) => W8.ambush(g, 4, 2));
  // WARPED SPACE ───────────────────────────────────────
  at(808, (g) => { W8.watcher(g, 0, ['S'], 9, 0.2); g.later(1.8, () => { W8.fractal(g, -5, null, 8, 0.32); W8.fractal(g, 5, null, 8, 0.32); }); });
  at(836, (g) => { W8.mineRow(g, [-6, -3, 0, 3, 6], 2.0, 4.5, 0.15); g.later(2, () => W8.ambush(g, 4, 1)); });
  at(862, (g) => { W8.watcher(g, -5.5, null, 8); W8.watcher(g, -1.8, null, 8, 0.3); W8.watcher(g, 1.8, null, 8, 0.3); W8.watcher(g, 5.5, null, 8); });
  at(892, (g) => { W8.fractal(g, 0, ['P'], 10, 0.18); g.later(2.2, () => W8.wraiths(g, [-6, -3, 3, 6], 0.3, 2, 0.3)); });
  at(918, (g) => { W8.mineSweep(g, 1, 5, 0.2, 0.8); g.later(2.2, () => W8.mineSweep(g, -1, 5, 0.36, 0.8)); });
  at(942, (g) => W8.ambush(g, 6, 1));
  at(962, (g) => W.carrier(g, 0, ['1UP']));
  // (rest beat)
  at(990, (g) => { W8.fractal(g, -4.5, null, 9); W8.fractal(g, 4.5, null, 9, 0.3); g.later(2.6, () => W8.watcher(g, 0, null, 8, 0.22)); });
  at(1016, (g) => W8.wraiths(g, [-6, -3, 0, 3, 6], 0.2, 3, 0.2));
  at(1038, (g) => W.carrier(g, -2, ['P', 'S']));
  at(1052, (g) => { W8.mineRow(g, [-6, -3, 0, 3, 6], 2.2, 4.0, 0.12); g.later(1.6, () => { W8.watcher(g, -4.5, null, 8, 0.24); W8.watcher(g, 4.5, null, 8, 0.24); }); });
  at(1080, (g) => { W8.fractal(g, -5, ['B'], 9); W8.fractal(g, 0, null, 9, 0.3); W8.fractal(g, 5, null, 9); });
  at(1108, (g) => { W8.ambush(g, 5, 2); g.later(2.6, () => W8.mineSweep(g, -1, 4, 0.24)); });
  at(1134, (g) => { W8.watcher(g, -5, null, 8); W8.watcher(g, 5, null, 8); g.later(1.4, () => W8.wraiths(g, [-2, 2], 0.3, 3)); });
  at(1160, (g) => { W8.fractal(g, 0, null, 8, 0.2); g.later(1.8, () => W8.mineRow(g, [-5.5, 5.5], 2.0, 4.0)); g.later(2.4, () => W8.ambush(g, 4, 1)); });
  at(1188, (g) => W8.wraiths(g, [-6, -3.5, -1, 1.5, 4, 6.5], 0.22, 2, 0.2));
  at(1210, (g) => W.carrier(g, 0, ['B']));
  at(1224, (g) => W8.mineSweep(g, 1, 3, 0.26));
});

export const STAGE = {
  ...STAGE_META[7],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => S3.STAGE.spawnBoss(g), // stand-in for OMEGA
  // the Architects' machines harden through the web and the warped space
  hpSeg: (d) => (d < 420 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};

