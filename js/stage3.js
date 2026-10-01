// stage3.js — STAGE 3 "SKY CITADEL" (天空要塞): above a cloud sea, air units only.
// World 'skies' (world.js): stratosphere 0–420 · storm band 420–800 · golden high altitude 800–1240 ·
// near-space dusk 1240+ (boss arena). Enemy types introduced here (models in models_s3.js):
//   interceptor  swept-wing jets diving across in pairs, 2-round aimed needle bursts
//   frigate      small flying warship: fore turret bursts + aft turret fans, slow, tanky, carries items
//   lancer       hovers, locks a lane (red targeting beam = telegraph), dashes down it, fires a spread
//   minelayer    crosses the upper screen sowing slow drifting mines
//   valkyrie     mid-boss escort cruiser: two wing batteries, then its reactor core
//   seraph       boss: the six-winged mothership — wing batteries and gun pods, then the spinal
//                cannons it raises from its wells, then its open reactor core
// Stage-1 air types (dart, hornet, carrier, bomber) fill in through the shared W helpers.
import { STAGE_META } from './defs.js';
import { F } from './fx.js';
import { fireTimer, bez, W, makeTimeline, midbossEvent, bossDefeated } from './stage.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// Enemy definitions (see the field list at the top of stage.js).
export const ENEMY = {
  interceptor: { hp: 8, score: 500, radius: 0.85, air: true, explode: 1.0, debris: 6, prewarm: 10 },
  frigate: { hp: 150, score: 4000, radius: 1.8, air: true, explode: 2.3, debris: 18, medal: 2, prewarm: 3 },
  lancer: { hp: 26, score: 1200, radius: 0.95, air: true, explode: 1.3, debris: 9, medal: 0.5, prewarm: 5 },
  minelayer: { hp: 70, score: 2500, radius: 1.4, air: true, explode: 1.8, debris: 12, medal: 1, prewarm: 3 },
  // mid-boss: the kill is the core, which stays shut (armoured) until both batteries are gone or 12 s
  // have passed. The body is armour, never a target (bodyTarget: false), so shots and homing missiles
  // go for the batteries and the core; hp is only a backstop. hull: armour behind the batteries.
  // Tuned so a mid-power jet keeping its distance still gets the kill (the core has 45 s of fight to
  // open and die): VULCAN L2 with a sub-weapon, WAVE / PLASMA from L3.
  valkyrie: {
    hp: 9999, score: 40000, radius: 2.2, air: true, explode: 3.2, debris: 30, midboss: true, noRevenge: true, bodyTarget: false, prewarm: 1,
    parts: [
      { key: 'batteryL', hp: 190, score: 6000, medals: 2, big: 1.8 }, { key: 'batteryR', hp: 190, score: 6000, medals: 2, big: 1.8 },
      { key: 'core', hp: 620, core: true, score: 40000 },
    ],
    hull: { hw: 3.7, z0: -2.5, z1: -1.05 },
  },
  // boss: parts in hit-test order. The spinal cannons start sealed in their wells (not targets) and
  // count in the HP bar from the start; the core is armoured until phase 3. hull: the wings and the aft
  // hull behind every row of parts (it starts past the outer batteries and the core), so shots that
  // clear the parts spark off the ship instead of flying over it.
  seraph: {
    hp: 1, score: 0, radius: 5.0, air: true, explode: 4, debris: 40, boss: true, model: 'seraph', prewarm: 1,
    parts: [
      { key: 'battery', list: true, hp: 125, score: 4000 },
      { key: 'pods', list: true, hp: 380, score: 10000, medals: 3, big: 2 },
      { key: 'spineF', hp: 600, score: 20000, medals: 4, big: 2.2 },
      { key: 'spineL', hp: 420, score: 12000, medals: 3, big: 1.8 },
      { key: 'spineR', hp: 420, score: 12000, medals: 3, big: 1.8 },
      { key: 'core', hp: 2450, core: true, score: 250000 },
    ],
    hull: { hw: 5.9, z0: -9.5, z1: -4.0 },
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
// shared: turn a boss part toward the player (parts sit in the unit's yawed frame)
function aimPart(g, e, pt, dt, rate) {
  const obj = pt.obj;
  const want = Math.atan2(-(g.player.x - pt.x), -(g.player.z - pt.z)) - e.yaw;
  obj.rotation.y += clamp(wrapA(want - obj.rotation.y), -rate * dt, rate * dt);
}
// Cloud-sea burst where something heavy falls through the deck (stage 3 has no water to splash):
// billows rolling out flat over the deck, a plume thrown up where it went under, a shock ring on the
// cloud tops. The smoke layer is depth-tested, so the upright plume puffs are held clear of the deck
// (a camera-facing puff that dips into it shows a hard, stepped edge).
const CLOUD_A = [0.8, 0.77, 0.9, 0.75], CLOUD_B = [0.5, 0.48, 0.62, 0];   // dusk-lit cloud (the smoke layer is unlit)
function cloudBurst(g, x, z, size) {
  const p = g.fx.p, y = g.GROUND_Y;
  const n = Math.round(16 * Math.min(1.6, size / 3));
  for (let i = 0; i < n; i++) {          // a ragged ring rolling outward, not a solid disc
    const a = (i / n) * TAU + rnd(-0.3, 0.3), r = rnd(0.25, 0.8) * size, sp = rnd(0.8, 2.4) * size * 0.35;
    p.emit(x + Math.cos(a) * r, y + 0.12 + i * 0.012, z + Math.sin(a) * r, Math.cos(a) * sp, 0, Math.sin(a) * sp,
      rnd(1.3, 2.1), rnd(0.4, 0.7) * size * 0.45, rnd(1.1, 1.9) * size * 0.45, CLOUD_A, CLOUD_B, F.SMOKE, 2,
      { flat: true, scroll: true, drag: 1.5, vrot: rnd(-0.6, 0.6) });
  }
  for (let i = 0; i < n >> 1; i++) {
    const s1 = rnd(1.6, 2.6) * size * 0.4;
    p.emit(x + rnd(-0.4, 0.4) * size, y + s1 * 0.5 + rnd(0.3, 1.2), z + rnd(-0.3, 0.3) * size, rnd(-0.8, 0.8), rnd(1.5, 4.0), rnd(-0.8, 0.8),
      rnd(1.0, 1.6), s1 * 0.35, s1, CLOUD_A, CLOUD_B, F.SMOKE, 2, { scroll: true, drag: 1.8, vrot: rnd(-0.8, 0.8) });
  }
  p.emit(x, y + 0.08, z, 0, 0, 0, 1.3, size * 0.6, size * 3.6, [1.3, 1.3, 1.6, 0.7], [0.5, 0.5, 0.7, 0], F.RING, 1, { flat: true, rot: 0, scroll: true, drag: 0 });
}

// --------------------------------------------------------------------------------
// air behaviours
// --------------------------------------------------------------------------------
// Interceptor: dive in from a top corner (side = +1: from the right), bottom out low, cross the
// screen and climb away over the far side; one aimed 2-round needle burst at the bottom of the dive.
// ox / oz: wingman offset (outboard and behind the lead).
function interceptAI(side, depth = 0.56, dur = 2.8, ox = 0, oz = 0) {
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
// Interceptor split: a pair drops in over the centre, then breaks outward and climbs away (side = the
// way this one breaks). Fires its burst as it breaks.
function splitAI(side, x0) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.z0 === undefined) { s.z0 = v.zTop - 2; s.bz = v.zTop + (v.zBottom - v.zTop) * 0.34; }
    if (e.t < 1.2) { e.x = x0; e.z = s.z0 + (s.bz - s.z0) * ease(e.t / 1.2); }
    else {
      const k = e.t - 1.2;
      e.x = x0 + side * (k * k * 6 + k * 3);
      e.z = s.bz + k * 3 - k * k * 4.5;
      if (!s.fired) { s.fired = true; s.burst = 2; s.bt = 0; }
    }
    if (s.burst > 0) {
      s.bt -= dt;
      if (s.bt <= 0) { s.bt = 0.11; s.burst--; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 10, g.BK.NEEDLE); }
    }
  };
}
// Frigate: noses down into the upper screen, holds there drifting while its fore turret fires
// 3-round needle bursts and the aft turret 5-way fans, then climbs away.
function frigateAI(x0, stay = 11) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, T = e.mesh.userData.turrets;
    if (s.z0 === undefined) { s.z0 = v.zTop - 3; s.tz = v.zTop + (v.zBottom - v.zTop) * 0.27; s.fixedYaw = true; s.yaw = Math.PI; }
    const dir = Math.sign(x0) || 1;
    if (e.t < 3.5) { e.x = x0; e.z = s.z0 + (s.tz - s.z0) * ease(e.t / 3.5); }
    else if (e.t < 3.5 + stay) { const k = e.t - 3.5; e.x = x0 - dir * Math.sin(k * 0.5) * 1.8; e.z = s.tz + Math.sin(k * 0.9) * 0.3; }
    else { const k = e.t - 3.5 - stay; e.z -= (1.5 + k * 5) * dt; e.x += dir * k * 2.5 * dt; }
    if (T) { g.aimTurret(e, T[0], dt, 2.4); g.aimTurret(e, T[1], dt, 2.0); }
    if (T && e.t > 3 && e.t < 3.5 + stay) {
      if (fireTimer(e, dt, g, 2.5, 0.8)) s.burst = 3;
      if (s.burst > 0) {
        s.bt = (s.bt || 0) - dt;
        if (s.bt <= 0) { s.bt = 0.12; s.burst--; if (g.canFire(e)) { const m = g.muzzlePos(T[0], s.burst); g.shoot(m.x, m.z, g.aim(m.x, m.z), 8.8, g.BK.NEEDLE); } }
      }
      s.ft2 = (s.ft2 ?? 2.0 / g.diff.fr) - dt;
      if (s.ft2 <= 0) { s.ft2 = 3.2 / g.diff.fr; if (g.canFire(e)) { const m = g.muzzlePos(T[1]); g.fan(m.x, m.z, g.aim(m.x, m.z), 5, 0.8, 6.4); } }
    }
    if (e.hp < e.maxHp * 0.5 && Math.random() < 0.25) g.fx.smokePuff(e.x + rnd(-0.8, 0.8), 0.2, e.z + rnd(-1, 1), 0.5, 0.8);
  };
}
// Lancer: slides into the upper screen, drifts over the player's lane, locks it (the red targeting
// beam is the telegraph), dashes down the lane, brakes and fires a 7-way spread, then turns away.
function lancerAI(x0) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData, p = g.player;
    if (!s.mode) {
      s.mode = 'in'; s.mt = 0; s.fixedYaw = true; s.yaw = Math.PI;
      s.z0 = v.zTop - 2.5; s.tz = Math.max(v.zTop + 3.6, zAtRow(v, HUD_ROW)) + rnd(0, 1.2); e.x = x0; e.z = s.z0;
      if (ud.setCharge) { ud.setCharge(0); ud.setBoost(0.3); }
    }
    s.mt += dt;
    const H = v.zBottom - v.zTop;
    if (s.mode === 'in') {
      e.z = s.z0 + (s.tz - s.z0) * ease(s.mt / 1.1);
      if (s.mt > 1.1) { s.mode = 'track'; s.mt = 0; }
    } else if (s.mode === 'track') {   // drift over the jet's lane (speed-limited, so dodging stays possible)
      e.x += clamp(clamp(p.x, -6.5, 6.5) - e.x, -4.5 * dt, 4.5 * dt);
      if (ud.setCharge) ud.setCharge(0.25 * Math.min(1, s.mt / 0.4));
      if (s.mt > 0.7) { s.mode = 'lock'; s.mt = 0; s.lx = e.x; g.audio.play('lock', { vol: 0.35, pitch: 5 }); }
    } else if (s.mode === 'lock') {    // telegraph: the lane is fixed now
      e.x = s.lx + Math.sin(s.mt * 70) * 0.035;
      if (ud.setCharge) ud.setCharge(0.45 + 0.55 * (s.mt / 0.85));
      if (s.mt > 0.85) {
        s.mode = 'dash'; s.mt = 0; s.vz = 5; e.x = s.lx;
        s.stopZ = clamp(p.z - 9, v.zTop + 8, v.zTop + 0.55 * H);   // brakes well short of the jet
        if (ud.setCharge) { ud.setCharge(0); ud.setBoost(1); }
        g.audio.play('missile', { vol: 0.55 });
      }
    } else if (s.mode === 'dash') {
      s.vz = Math.min(26, s.vz + 70 * dt);
      e.z += s.vz * dt;
      if (Math.random() < 0.6) g.fx.trail(e.x + rnd(-0.1, 0.1), 0.05, e.z - 1.2, 0.8, 2.2, 3.0, 0.6, 0.4, 0.3);
      if (e.z >= s.stopZ) { s.mode = 'brake'; s.mt = 0; }
    } else if (s.mode === 'brake') {
      s.vz *= Math.max(0, 1 - dt * 14);
      e.z += s.vz * dt;
      if (s.mt > 0.16) {
        s.mode = 'fire'; s.mt = 0;
        if (ud.setBoost) ud.setBoost(0.3);
        if (g.canFire(e)) g.fan(e.x, e.z + 1.2, g.aim(e.x, e.z), 7, 1.15, 6.4);
      }
    } else if (s.mode === 'fire') {
      if (s.mt > 0.45) { s.mode = 'out'; s.mt = 0; s.fixedYaw = false; s.dx = e.x > 0 ? 1 : -1; if (ud.setBoost) ud.setBoost(0.8); }
    } else {                           // turn and climb away
      e.z -= (1 + s.mt * 13) * dt;
      e.x += s.dx * (1 + s.mt * 5) * dt;
    }
  };
}
// Minelayer: crosses the upper screen (dir = +1: left → right) sowing slow mines that drift down,
// lean toward the jet for a moment and sink away.
function minelayerAI(dir, zf = 0.24, speed = 2.9) {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (s.z0 === undefined) { s.x0 = -dir * 11.5; s.z0 = v.zTop + (v.zBottom - v.zTop) * zf; }
    e.x = s.x0 + dir * speed * e.t;
    e.z = s.z0 + Math.sin(e.t * 1.2) * 0.6;
    if (Math.abs(e.x) < 7.6 && fireTimer(e, dt, g, 0.85, 0.3)) {
      const i = g.shoot(e.x - dir * 0.9, e.z + 0.3, rnd(-0.35, 0.35), 1.7, g.BK.MINE);
      if (i >= 0) { g.eb.home[i] = 0.7; g.eb.az[i] = 0.42; }
      if (ud.drop) ud.drop();
    }
  };
}

// --------------------------------------------------------------------------------
// mid-boss: VALKYRIE escort cruiser
// --------------------------------------------------------------------------------
const live = (pt) => (pt && !pt.dead ? pt : null);
const VK_ROW = 9.5;    // station below the top edge
const VK_OPEN = 12;    // fight time at which the core opens even with a battery left
const VK_FIGHT = 45;   // fight time at which it gives up and climbs away
// battery: 3 rounds of twin needles along its barrels
function batteryBurst(g, e, pt, dt, interval, speed) {
  pt.fireT -= dt;
  if (pt.fireT <= 0) { pt.fireT = interval; pt.burst = 3; pt.bt = 0; }
  if (pt.burst > 0) {
    pt.bt -= dt;
    if (pt.bt <= 0) {
      pt.bt = 0.1; pt.burst--;
      const ang = pt.obj.rotation.y + e.yaw - Math.PI;
      for (let k = 0; k < 2; k++) { const m = g.muzzlePos(pt.obj, k); g.shoot(m.x, m.z, ang, speed, g.BK.NEEDLE); }
    }
  }
}
function valkyrieAI() {
  return (e, dt, g) => {
    const s = e.s, v = g.view, ud = e.mesh.userData;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.life = 0; s.open = 0; s.a = 0; s.b = 0; s.fixedYaw = true; s.yaw = Math.PI;
      e.x = 0; e.z = v.zTop - 6; s.tz = v.zTop + VK_ROW; e.invuln = true; e.armored = true;
      s.bl = g.partByKey(e, 'batteryL'); s.br = g.partByKey(e, 'batteryR'); s.core = g.partByKey(e, 'core');
      if (ud.reset) ud.reset();
    }
    s.life += dt;
    // engine wash from the three stern nozzles (the model points them up-screen)
    if (Math.random() < 0.6) g.fx.trail(e.x + rnd(-0.7, 0.7), 0.05, e.z - 3.4, 0.6, 1.8, 2.8, 0.5, 0.45, 0.3);
    if (e.dying) {
      s.dieT = (s.dieT || 0) + dt;
      e.z -= 0.8 * dt;
      s.pitch = Math.min(0.25, s.dieT * 0.14);
      s.boomT = (s.boomT || 0) - dt;
      if (s.boomT <= 0) {
        s.boomT = 0.11;
        g.fx.explosion(e.x + rnd(-3.4, 3.4), 0.3, e.z + rnd(-2.6, 2.6), rnd(1.0, 1.8), { debris: 4, color: ud.debrisColor });
        g.audio.play('explodeM', { vol: 0.7, pan: clamp(e.x / 10, -1, 1) });
        g.shake.add(0.12);
      }
      if (s.dieT > 1.7) {
        g.fx.explosion(e.x, 0.4, e.z, 4, { debris: 30, color: ud.debrisColor });
        g.fx.shockwave(e.x, 0.1, e.z, 18, [1.4, 2.2, 2.8, 1], 0.8);
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
      return;
    }
    if (s.mode === 'enter') {
      e.z = (v.zTop - 6) + (s.tz - (v.zTop - 6)) * ease(e.t / 3);
      if (e.t > 3) { s.mode = 'fight'; s.ft = 0; e.invuln = false; }
    } else if (s.mode === 'fight') {
      s.ft += dt;
      e.x = Math.sin(s.ft * 0.47) * 3.3;
      e.z = s.tz + Math.sin(s.ft * 0.83) * 0.6;
      if (s.ft > VK_FIGHT) { s.mode = 'retreat'; s.rt = 0; }
    } else {                                  // retreat: climb away, the stage goes on
      s.rt += dt;
      e.z -= (2 + s.rt * 10) * dt;
      if (e.z < v.zTop - 9) { e.alive = false; g.midbossDone = true; }
    }
    // ramming: the hull (fuselage, then the swept wings) is solid; the engine only checks the body circle
    const p = g.player, dx = Math.abs(p.x - e.x), dz = p.z - e.z;
    if (p.alive && ((dx < 0.95 && dz > -2.9 && dz < 2.7) || (dx < 3.5 && dz > -2.2 && dz < 1.45 - (dx - 1.1) * 0.8))) g.killPlayer();
    const bl = live(s.bl), br = live(s.br), core = s.core;
    // the core opens once both batteries are gone (or it is tired of waiting)
    const wantOpen = s.mode === 'fight' && ((!bl && !br) || s.ft > VK_OPEN) ? 1 : 0;
    s.open += (wantOpen - s.open) * Math.min(1, dt * 2.2);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;
    if (!s.opened && s.open > 0.5) { s.opened = true; g.audio.play('warning', { vol: 0.4 }); g.shake.add(0.2); }
    if (bl) aimPart(g, e, bl, dt, 2.2);
    if (br) aimPart(g, e, br, dt, 2.2);
    if (s.mode !== 'fight' || !g.canFire(e)) return;
    const fr = g.diff.fr;
    // batteries: twin-needle bursts, plus 5-way fans of big orbs
    if (bl) batteryBurst(g, e, bl, dt, 2.1 / fr, 9.6);
    if (br) batteryBurst(g, e, br, dt, 2.1 / fr, 9.6);
    s.fanT = (s.fanT ?? 3) - dt;
    if (s.fanT <= 0) {
      s.fanT = 4.2 / fr;
      if (bl) { const m = g.muzzlePos(bl.obj); g.fan(m.x, m.z, g.aim(m.x, m.z), 5, 0.9, 6.4, g.BK.BIG); }
      if (br) { const m = g.muzzlePos(br.obj); g.fan(m.x, m.z, g.aim(m.x, m.z), 5, 0.9, 6.4, g.BK.BIG); }
    }
    // open core: pulsing 3-arm spiral bursts; below half HP it adds rings
    if (core && s.open > 0.85) {
      const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
      s.cy = (s.cy || 0) + dt;
      const on = (s.cy % 4.2) < 2.6;
      s.st = (s.st || 0) - dt;
      if (on && s.st <= 0) { s.st = 0.13 / fr; s.a += 0.26; for (let k = 0; k < 3; k++) g.shoot(cx, cz, s.a + (k * TAU) / 3, 5.4); }
      if (core.hp < core.maxHp * 0.5) {
        s.rt2 = (s.rt2 ?? 1) - dt;
        if (s.rt2 <= 0) { s.rt2 = 3.0 / fr; s.b += 0.11; g.ring(cx, cz, 16, 4.8, s.b); }
      }
    }
  };
}
function spawnValkyrie(g) {
  const e = g.spawn('valkyrie', { x: 0, z: g.view.zTop - 6, ai: valkyrieAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  e.onPartDestroyed = (en, pt) => { if (pt.key.startsWith('battery')) g.dropItem('P', pt.x, pt.z, { color: g.player.main }); };
  return e;
}

// --------------------------------------------------------------------------------
// boss: SERAPH, the six-winged mothership
// --------------------------------------------------------------------------------
// p1: wing batteries (aimed needle bursts), fore-wing gun pods (sweeping fans), prow rings of big
//     orbs → p2 once batteries and pods are gone (or after 42 s): the spinal cannons rise out of
//     their wells — the lance (telegraph beam, then a needle stream along the locked line) and two
//     twin guns spraying counter-rotating spirals → p3 once they are gone (or after 40 s): the core
//     opens — counter-rotating lattices and a swaying spiral in turn, breathers with aimed fans, and
//     rings when it is low.
// Parts left alive keep firing in the later phases at a reduced rate.
function seraphAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.fixedYaw = true; s.yaw = Math.PI; e.invuln = true; e.armored = true;
      s.open = 0; s.raise = 0; s.a = 0; s.b = 0; s.c = 0; s.sway = 0; s.pt = 0; s.ph = 0; s.podSide = 0; s.lance = 'idle';
      // station: the core's top edge (e.z − 2.5 − 1.5, raised 0.95; the sway dips 0.6) stays below the boss bar
      s.z0 = v.zTop - 17; s.baseZ = Math.max(v.zTop + 12.5, zAtRow(v, BAR_ROW, 0.95) + 4.6); e.x = 0; e.z = s.z0;
      s.bat = [0, 1, 2, 3].map((i) => g.partByKey(e, 'battery' + i));
      s.pods = [g.partByKey(e, 'pods0'), g.partByKey(e, 'pods1')];
      s.spF = g.partByKey(e, 'spineF'); s.spL = g.partByKey(e, 'spineL'); s.spR = g.partByKey(e, 'spineR');
      s.spine = [s.spF, s.spL, s.spR];
      s.core = g.partByKey(e, 'core');
      for (const pt of s.spine) if (pt) pt.dead = true;   // sealed in their wells until phase 2
      if (ud.reset) ud.reset();                           // a pooled model may come back mid-lock or broken
      if (ud.setRaise) ud.setRaise(0);
    }
    const core = s.core;
    // HP bar: every part (sealed ones count at full health)
    let hp = 0, max = 0;
    for (let i = 0; i < e.parts.length; i++) { const pt = e.parts[i]; max += pt.maxHp; hp += Math.max(0, pt.hp); }
    g.ui.setBossHP(hp / max);

    if (e.dying) { seraphDeath(e, dt, g); return; }

    if (s.mode === 'enter') {
      const k = ease(e.t / 5.5);
      e.z = s.z0 + (s.baseZ - s.z0) * k;
      e.x = Math.sin(e.t * 0.6) * 0.4 * (1 - k);
      if (Math.random() < 0.8) g.fx.trail(e.x + rnd(-1.4, 1.4), 0.05, e.z - 8.8, 0.7, 1.9, 3.0, 0.55, 0.9, 0.5);
      if (e.t > 5.5) { s.mode = 'p1'; s.ph = 0; e.invuln = false; }
      return;
    }
    s.pt += dt; s.ph += dt;
    // movement: a slow, heavy sway that widens as it loses its outer armament
    const want = s.mode === 'p1' ? 1.5 : s.mode === 'p2' ? 2.1 : 2.6;
    s.sway += (want - s.sway) * Math.min(1, dt * 0.4);
    e.x = Math.sin(s.pt * 0.31) * s.sway;
    e.z = s.baseZ + Math.sin(s.pt * 0.47) * 0.6;
    if (Math.random() < 0.5) g.fx.trail(e.x + rnd(-1.4, 1.4), 0.05, e.z - 8.8, 0.7, 1.9, 3.0, 0.5, 0.8, 0.45);

    // phase changes
    let outer = 0;
    for (let i = 0; i < 4; i++) if (live(s.bat[i])) outer++;
    if (live(s.pods[0])) outer++;
    if (live(s.pods[1])) outer++;
    if (s.mode === 'p1' && (!outer || s.ph > 42)) {
      s.mode = 'p2'; s.ph = 0; s.lanceT = 2.2; s.spT = 1.4;
      g.audio.play('warning', { vol: 0.5 }); g.shake.add(0.35);
    }
    if (s.mode !== 'p1' && s.raise < 1) {    // the spinal cannons rise out of their wells
      s.raise = Math.min(1, s.raise + dt / 1.6);
      if (ud.setRaise) ud.setRaise(smooth(s.raise));
      if (s.raise > 0.55) for (const pt of s.spine) if (pt && pt.dead && !pt.obj.userData.destroyed) pt.dead = false;
      if (Math.random() < 0.5) g.fx.smokePuff(e.x + rnd(-1.6, 1.6), 0.8, e.z + rnd(1.0, 4.0), 0.6, 0.6);
    }
    const lanceP = live(s.spF), tl = live(s.spL), tr = live(s.spR);
    if (s.mode === 'p2' && s.raise >= 1 && ((!lanceP && !tl && !tr) || s.ph > 40)) {
      s.mode = 'p3'; s.ph = 0; s.cyc = 0;
      g.shake.add(0.6); g.ui.flash(0.35); g.audio.play('explodeL'); g.audio.play('warning', { vol: 0.5 });
    }
    // core shutters
    s.open += ((s.mode === 'p3' ? 1 : 0) - s.open) * Math.min(1, dt * 1.6);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;

    // turrets track the jet (aiming is free; firing is gated below)
    for (let i = 0; i < 4; i++) { const t = live(s.bat[i]); if (t) aimPart(g, e, t, dt, 2.6); }
    if (lanceP && s.lance !== 'fire') aimPart(g, e, lanceP, dt, s.lance === 'lock' ? 0.12 : 1.1);
    const setBeam = s.spF && s.spF.obj.userData.setBeam;
    if (!g.canFire(e)) { if (setBeam) setBeam(0); if (s.lance !== 'idle') { s.lance = 'idle'; s.lanceT = 2; } return; }
    const fr = g.diff.fr, hard = g.diff.level >= 1;
    const late = s.mode === 'p1' ? 1 : s.mode === 'p2' ? 0.7 : 0.5;     // leftover outer guns slow down

    // wing batteries: aimed 3-round twin-needle bursts, staggered
    for (let i = 0; i < 4; i++) { const t = live(s.bat[i]); if (t) batteryBurst(g, e, t, dt * late, (2.3 + i * 0.17) / fr, 9.4); }
    // gun pods: alternating 9-way fans leaning inward / outward
    s.podT = (s.podT ?? 1.5) - dt * late;
    if (s.podT <= 0) {
      s.podT = 1.75 / fr;
      s.podSide ^= 1;
      const pd = live(s.pods[s.podSide]) || live(s.pods[s.podSide ^ 1]);
      if (pd) { const m = g.muzzlePos(pd.obj); g.fan(m.x, m.z, g.aim(m.x, m.z) + (s.podSide ? 0.09 : -0.09), 9, 1.45, 5.4); }
    }
    if (s.mode === 'p1') {
      // prow: a slow ring of big orbs now and then (wide gaps)
      s.ringT = (s.ringT ?? 3.5) - dt;
      if (s.ringT <= 0) { s.ringT = 6.2 / fr; s.b += 0.2; const m = g.muzzlePos(e.mesh); g.ring(m.x, m.z, hard ? 16 : 14, 4.0, s.b, g.BK.BIG); }
      return;
    }
    const spMul = s.mode === 'p2' ? 1 : 0.6;
    // the lance: lock on (beam), then a stream of fast needles down the locked line
    if (lanceP) {
      const lo = lanceP.obj;
      s.lanceT -= dt * spMul;
      if (s.lance === 'idle') {
        if (s.lanceT <= 0 && s.raise >= 1) { s.lance = 'lock'; s.lt = 0; g.audio.play('lock', { vol: 0.5, pitch: -3 }); }
      } else if (s.lance === 'lock') {
        s.lt += dt;
        if (setBeam) setBeam(0.35 + 0.65 * Math.min(1, s.lt / 1.1) * (0.8 + Math.sin(s.lt * 40) * 0.2));
        if (s.lt > 1.2) { s.lance = 'fire'; s.lt = 0; s.lst = 0; if (setBeam) setBeam(0); g.audio.play('missile', { vol: 0.8, pitch: -5 }); g.shake.add(0.2); }
      } else {
        s.lt += dt;
        s.lst -= dt;
        const ang = lo.rotation.y + e.yaw - Math.PI;
        while (s.lst <= 0 && s.lt < 1.05) { s.lst += 0.05; const m = g.muzzlePos(lo); g.shoot(m.x, m.z, ang, 15, g.BK.NEEDLE); }
        if (s.lt > 1.2) { s.lance = 'idle'; s.lanceT = 3.8 / fr; }
      }
    } else { s.lance = 'idle'; if (setBeam) setBeam(0); }
    // spinners: each sprays along its two opposed barrels as it turns (counter-rotating), 3.4 s on / 1.8 s off
    const onSp = (s.pt % 5.2) < 3.4;
    const iv = 0.15 / (fr * spMul), step = 0.21;
    if (tl) tl.obj.rotation.y -= dt * (onSp ? step / iv : 0.4);
    if (tr) tr.obj.rotation.y += dt * (onSp ? step / iv : 0.4);
    s.spT -= dt;
    if (onSp && s.spT <= 0 && (tl || tr)) {
      s.spT = iv;
      for (let q = 0; q < 2; q++) {
        const t = q ? tr : tl;
        if (!t) continue;
        const ang = t.obj.rotation.y + e.yaw - Math.PI;
        for (let k = 0; k < 2; k++) { const m = g.muzzlePos(t.obj, k); g.shoot(m.x, m.z, ang + k * Math.PI, 5.0); }
      }
    }
    if (s.mode !== 'p3' || !core || s.open < 0.85) return;
    // open core, in 8.5 s cycles that end in a breather with an aimed big fan: two counter-rotating
    // 3-arm lattices, then a swaying 5-arm spiral (a little sparser), alternating; rings of orbs
    // join once it is below 40 %
    const cm = g.muzzlePos(core.obj), cx = cm.x, cz = cm.z;
    s.cyc += dt;
    const breathe = (s.cyc % 8.5) > 7.2, sway = Math.floor(s.cyc / 8.5) & 1;
    const rage = core.hp < core.maxHp * 0.4;
    s.ct = (s.ct || 0) - dt;
    if (!breathe && s.ct <= 0) {
      if (sway) {
        s.ct = (rage ? 0.19 : 0.21) / fr;
        const a0 = Math.sin(s.cyc * 1.5) * 0.85 + s.cyc * 0.2;
        for (let k = 0; k < 5; k++) g.shoot(cx, cz, a0 + (k * TAU) / 5, 5.2);
      } else {
        s.ct = (rage ? 0.1 : 0.11) / fr;
        s.flip = !s.flip;
        if (s.flip) { s.a += 0.2; for (let k = 0; k < 3; k++) g.shoot(cx, cz, s.a + (k * TAU) / 3, 4.6); }
        else { s.c -= 0.25; for (let k = 0; k < 3; k++) g.shoot(cx, cz, s.c + (k * TAU) / 3 + Math.PI / 3, 5.3); }
      }
    }
    if (breathe && !s.fanned) { s.fanned = true; g.fan(cx, cz, g.aim(cx, cz), hard ? 7 : 5, hard ? 1.0 : 0.8, 6.8, g.BK.BIG); g.audio.play('lock', { vol: 0.4 }); }
    if (!breathe) s.fanned = false;
    if (rage) {
      s.rgT = (s.rgT ?? 1.2) - dt;
      if (s.rgT <= 0) { s.rgT = (hard ? 2.2 : 2.6) / fr; s.b += 0.13; g.ring(cx, cz, hard ? 22 : 18, 4.2, s.b); }
    }
  };
}
// Death: the guns still standing blow in turn while blasts walk in from the wing tips, a line of
// explosions cracks the hull at its break line and it snaps in two (the main wings tear away), a final
// blast, then the wreck sinks into the cloud sea — a cloud burst where it goes under, no splash.
function seraphDeath(e, dt, g) {
  const s = e.s, ud = e.mesh.userData;
  if (!s.dieT) { const sb = s.spF && s.spF.obj.userData.setBeam; if (sb) sb(0); }   // a lock in progress dies with it
  s.dieT = (s.dieT || 0) + dt;
  const t = s.dieT, y = s.y || 0;
  // the hull flickers as it cooks off
  if (ud.setFlash && t < 2.6) ud.setFlash(Math.max(0, Math.sin(t * 23)) * 0.35);
  // guns still standing blow one after another
  s.popT = (s.popT ?? 0.15) - dt;
  if (s.popT <= 0 && t < 2.2) {
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
  // blasts walking in from the wing tips over the first seconds
  s.boomT = (s.boomT || 0) - dt;
  if (s.boomT <= 0 && t < 2.4) {
    s.boomT = 0.13;
    const k = Math.min(1, t / 2.2), span = 8 - k * 5;
    const side = (s.side = -(s.side || 1));
    const x = e.x + side * rnd(span * 0.5, span), z = e.z + rnd(-4, 4);
    g.fx.explosion(x, 0.4 + y * 0.5, z, rnd(0.9, 1.5), { debris: 4, color: ud.debrisColor });
    g.audio.play('explodeM', { vol: 0.55, pan: clamp(x / 9, -1, 1) });
    g.shake.add(0.1);
  }
  // the break line (model z 0.9 → e.z − 0.9) cracks open, then the halves part
  if (t > 1.0 && !s.crack) {
    s.crack = true;
    for (let i = 0; i < 5; i++) g.later(i * 0.07, () => { g.fx.explosion(e.x + (i - 2) * 1.0, 0.6, e.z - 0.9, 1.5, { debris: 6, color: ud.debrisColor }); });
    g.audio.play('explodeL'); g.shake.add(0.5); g.ui.flash(0.25);
  }
  if (ud.setBreak) ud.setBreak(clamp((t - 1.2) / 1.9, 0, 1));
  if (t > 1.2 && t < 3.6 && Math.random() < 0.5) {   // fire along the torn edges
    g.fx.p.emit(e.x + rnd(-2.2, 2.2), 0.3 + y, e.z - 0.9 + rnd(-0.6, 0.6), rnd(-0.5, 0.5), rnd(0.5, 1.5), rnd(-0.5, 0.5), rnd(0.4, 0.8), rnd(0.6, 1.0), rnd(1.6, 2.4),
      [2.2, 1.0, 0.35, 0.9], [0.8, 0.2, 0.05, 0], F.FIRE, 0, { drag: 1.5, vrot: rnd(-2, 2) });
  }
  e.z += 0.7 * dt;
  s.pitch = Math.min(0.28, t * 0.08);
  if (t > 2.0) s.y = -(t - 2.0) * (t - 2.0) * 1.6;
  if (t > 2.5 && !s.final) {
    s.final = true;
    g.fx.explosion(e.x, 0.5, e.z - 0.9, 3.6, { debris: 40, color: ud.debrisColor });
    g.fx.shockwave(e.x, 0.1, e.z - 0.9, 30, [2.0, 2.4, 3.0, 1], 1.0);
    g.fx.shockwave(e.x, 0.1, e.z - 0.9, 18, [1.0, 1.8, 2.8, 1], 0.8);
    g.ui.flash(0.7); g.shake.add(1);
    g.audio.play('bossDown');
    g.haptic([80, 50, 200]);
    for (let i = 0; i < 18; i++) g.dropItem('medal', e.x + rnd(-5, 5), e.z + rnd(-3, 3));
  }
  // the wreck meets the cloud deck (GROUND_Y): cloud bursts along the hull, then over the sinking stern
  if (!s.cloud1 && y < g.GROUND_Y + 2.6) {
    s.cloud1 = true;
    cloudBurst(g, e.x - 3, e.z - 3, 4.2); cloudBurst(g, e.x + 3, e.z + 1, 4.2);
    g.audio.play('explodeL', { vol: 0.6 }); g.shake.add(0.4);
  }
  if (!s.cloud2 && y < g.GROUND_Y - 0.5) { s.cloud2 = true; cloudBurst(g, e.x, e.z - 1, 5.5); }
  if (t > 4.7) {
    e.alive = false;
    g.ui.boss(false);
  }
}
function spawnSeraph(g) {
  const e = g.spawn('seraph', { x: 0, z: g.view.zTop - 17, ai: seraphAI() });
  e.onDeath = () => { e.s.dieT = 0; bossDefeated(g, e); };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key.startsWith('pods')) g.dropItem('P', pt.x, pt.z, { color: g.player.main });
    else if (pt.key === 'spineF') g.dropItem('B', pt.x, pt.z);
  };
  return e;
}

// --------------------------------------------------------------------------------
// spawn helpers for this stage's units (the stage-1 ones come from W)
// --------------------------------------------------------------------------------
const W3 = {
  // n pairs diving across from `side` (+1 = from the right), `gap` s apart
  intercept(g, side, pairs = 1, gap = 1.0, depth = 0.56) {
    for (let k = 0; k < pairs; k++) {
      g.later(k * gap, () => {
        g.spawn('interceptor', { x: side * 8, z: -60, ai: interceptAI(side, depth) });
        g.later(0.22, () => g.spawn('interceptor', { x: side * 8, z: -60, ai: interceptAI(side, depth + 0.05, 2.8, 1.3, -1.1) }));
      });
    }
  },
  // a pair drops in over x0 and breaks outward
  split(g, x0 = 0) {
    g.spawn('interceptor', { x: x0 - 0.7, z: -60, ai: splitAI(-1, x0 - 0.7) });
    g.spawn('interceptor', { x: x0 + 0.7, z: -60, ai: splitAI(1, x0 + 0.7) });
  },
  frigate(g, x0, drops, stay) { return g.spawn('frigate', { x: x0, z: -60, ai: frigateAI(x0, stay), drops }); },
  lancer(g, x0) { return g.spawn('lancer', { x: x0, z: -60, ai: lancerAI(x0) }); },
  lancers(g, xs, gap = 0.8) { xs.forEach((x, i) => g.later(i * gap, () => W3.lancer(g, x))); },
  minelayer(g, dir, zf, drops) { return g.spawn('minelayer', { x: -dir * 11.5, z: -60, ai: minelayerAI(dir, zf), drops }); },
};

// --------------------------------------------------------------------------------
// Stage 3 timeline (distance in stage units; ~7 units/s)
// --------------------------------------------------------------------------------
const TIMELINE = makeTimeline((at) => {
  // STRATOSPHERE ──────────────────────────────────────
  at(24, (g) => W3.intercept(g, 1));
  at(40, (g) => W3.intercept(g, -1));
  at(58, (g) => W.carrier(g, 0, ['P']));
  at(74, (g) => { W.swoop(g, -1, 5); g.later(1.2, () => W3.split(g, 1.5)); });
  at(96, (g) => W3.frigate(g, 0, ['S']));
  at(122, (g) => { W3.intercept(g, 1, 2, 1.1); W3.intercept(g, -1, 1, 1, 0.5); });
  at(144, (g) => W3.lancer(g, 0));
  at(160, (g) => { W.snake(g, -4); g.later(1.4, () => W.hornet(g, 4.5, 0.3)); });
  at(180, (g) => W3.lancers(g, [-4, 4], 1.1));
  at(200, (g) => W3.minelayer(g, 1, 0.22));
  at(218, (g) => W3.intercept(g, -1, 2, 1.0));
  at(240, (g) => W.carrier(g, -2, ['P', 'B']));
  at(256, (g) => { W3.frigate(g, -4, null, 9); g.later(1.5, () => W3.frigate(g, 4, ['P'], 9)); });
  at(284, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); g.later(1.4, () => W3.lancer(g, 0)); });
  at(306, (g) => { W.hornet(g, -5, 0.26); W.hornet(g, 0, 0.18); W.hornet(g, 5, 0.26); });
  at(330, (g) => { W3.minelayer(g, -1, 0.2); g.later(1.8, () => W3.intercept(g, 1, 2, 1)); });
  // (rest beat)
  at(366, (g) => W.carrier(g, 2, ['S']));
  at(382, (g) => W3.lancers(g, [-5, 0, 5], 0.9));
  at(404, (g) => { W.vee(g, 0); g.later(1.6, () => W3.split(g, -2)); });
  // STORM BAND ────────────────────────────────────────
  at(426, (g) => { W.bomber(g, 0, ['P']); g.later(3, () => W3.intercept(g, -1, 2, 1.2)); });
  at(462, (g) => { W3.minelayer(g, 1, 0.18); g.later(2.4, () => W3.minelayer(g, -1, 0.3)); });
  at(484, (g) => { W3.frigate(g, 3, ['B'], 10); g.later(2, () => W.swoop(g, -1, 5)); });
  at(510, (g) => W3.lancers(g, [-5, 5, -1.5, 1.5], 0.75));
  at(534, (g) => W.carrier(g, 0, ['P']));
  at(548, (g) => { W3.intercept(g, 1, 2, 0.9); g.later(1.3, () => W3.intercept(g, -1, 2, 0.9)); });
  at(570, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); });
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnValkyrie));
  at(628, (g) => W.carrier(g, -3, ['S']));
  at(646, (g) => { W3.split(g, 0); g.later(1.4, () => W3.intercept(g, 1, 2, 1)); });
  at(672, (g) => { W3.frigate(g, -4, ['P'], 10); W3.frigate(g, 4, null, 10); g.later(3.5, () => W3.lancer(g, 0)); });
  at(708, (g) => { W3.minelayer(g, -1, 0.2); g.later(1, () => W.hornet(g, -4, 0.34)); g.later(2.4, () => W.hornet(g, 4, 0.34)); });
  at(736, (g) => { W.bomber(g, -3, ['B']); g.later(3.2, () => W3.lancers(g, [4, -5], 1.2)); });
  at(772, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(788, (g) => W.carrier(g, 2, ['P']));
  // GOLDEN HIGH ALTITUDE ─────────────────────────────
  at(812, (g) => { W3.intercept(g, 1, 3, 0.8); g.later(1.2, () => W3.intercept(g, -1, 3, 0.8)); });
  at(840, (g) => { W3.frigate(g, 0, ['S'], 12); g.later(2, () => W3.frigate(g, -5, null, 9)); g.later(3.5, () => W3.frigate(g, 5, null, 9)); });
  at(878, (g) => W3.lancers(g, [-6, -2, 2, 6], 0.7));
  at(904, (g) => { W3.minelayer(g, 1, 0.16); g.later(3.2, () => W3.minelayer(g, -1, 0.3)); });
  at(934, (g) => { W.hornet(g, -6, 0.24); W.hornet(g, -2, 0.32); W.hornet(g, 2, 0.32); W.hornet(g, 6, 0.24); });
  at(962, (g) => W.carrier(g, 0, ['1UP']));
  // (rest beat)
  at(990, (g) => { W3.split(g, -3); g.later(0.8, () => W3.split(g, 3)); });
  at(1010, (g) => { W.bomber(g, -3.5, ['P']); g.later(2.5, () => W3.intercept(g, 1, 2, 1.1)); });
  at(1042, (g) => { W3.lancers(g, [0, -4.5, 4.5], 0.6); g.later(2.6, () => W3.minelayer(g, 1, 0.2)); });
  at(1074, (g) => W.carrier(g, -2, ['P', 'S']));
  at(1090, (g) => { W3.frigate(g, -3.5, ['B'], 10); W3.frigate(g, 3.5, null, 10); g.later(2.2, () => W3.intercept(g, -1, 2, 1)); });
  at(1128, (g) => { W3.intercept(g, 1, 2, 0.8); W3.intercept(g, -1, 2, 0.8); g.later(2, () => W.swoop(g, 1, 5)); });
  at(1156, (g) => { W3.lancers(g, [-5, 5], 0.4); g.later(1.8, () => W3.lancers(g, [-1.5, 1.5], 0.4)); });
  at(1184, (g) => { W3.minelayer(g, -1, 0.2); W3.minelayer(g, 1, 0.3); });
  at(1210, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[2],
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: spawnSeraph,
  // enemies toughen through the storm band and the golden altitude
  hpSeg: (d) => (d < 420 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
  bulletRim: 1,   // hard dark bullet rims: the stratosphere and golden bands are white / cream cloud
};
