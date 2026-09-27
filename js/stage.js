// stage.js — enemy table, behaviours (AI), the mid-boss, the boss and the stage-1 timeline.
// Timeline events fire on world distance (ground units travelled), so ground units line up
// with the terrain world.js builds for each biome.
import { LANES_X, CROSS_ROAD_PERIOD } from './world.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const TAU = Math.PI * 2;

export const ENEMY = {
  dart:    { hp: 2,   score: 200,  radius: 0.75, air: true,  explode: 0.8, debris: 5 },
  hornet:  { hp: 20,  score: 700,  radius: 1.0,  air: true,  explode: 1.2, debris: 8 },
  carrier: { hp: 14,  score: 300,  radius: 1.15, air: true,  explode: 1.3, debris: 8 },
  bomber:  { hp: 320, score: 6000, radius: 2.3,  air: true,  explode: 2.6, debris: 24, medal: 3 },
  tank:    { hp: 10,  score: 400,  radius: 0.9,  air: false, explode: 1.0, debris: 8, medal: 0.6 },
  turret:  { hp: 22,  score: 600,  radius: 1.0,  air: false, explode: 1.1, debris: 8, medal: 1 },
  gunboat: { hp: 40,  score: 1500, radius: 1.5,  air: false, explode: 1.6, debris: 12, medal: 2, water: true },
  crawler: { hp: 340, score: 30000, radius: 2.4, air: false, explode: 3.2, debris: 30 },
  boss:    { hp: 1,   score: 0,    radius: 3.5,  air: true,  explode: 4, debris: 40, boss: true },
};

export const MIDBOSS_AT = 590;
export const STAGE_BOSS_AT = 1275;

// --------------------------------------------------------------------------------
// shared bits
// --------------------------------------------------------------------------------
function fireTimer(e, dt, g, interval, first = rnd(0.6, 1.4)) {
  if (e.s.ft === undefined) e.s.ft = first / g.diff.fr;
  e.s.ft -= dt;
  if (e.s.ft <= 0) { e.s.ft += interval / g.diff.fr; return g.canFire(e); }
  return false;
}
function bez(a, b, c, d, t) {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}
function faceYaw(e, x, z) { return Math.atan2(-(x - e.x), -(z - e.z)); }

// --------------------------------------------------------------------------------
// air behaviours
// --------------------------------------------------------------------------------
// Swoop: dive in from a top corner, curve across the screen and climb out the other side.
function swoop(side, dur = 3.8) {
  return (e, dt, g) => {
    const v = g.view, s = e.s;
    if (!s.P) {
      const T = v.zTop, H = v.zBottom - v.zTop;
      s.P = [[side * 8, T - 2], [side * 5, T + 0.5 * H], [-side * 3, T + 0.58 * H], [-side * 10, T + 0.08 * H]];
    }
    const u = e.t / dur;
    if (u < 1) {
      e.x = bez(s.P[0][0], s.P[1][0], s.P[2][0], s.P[3][0], u);
      e.z = bez(s.P[0][1], s.P[1][1], s.P[2][1], s.P[3][1], u);
    } else { e.x += e.vx * dt; e.z += e.vz * dt; }
    if (!s.fired && e.t > 1.1 / g.diff.fr) { s.fired = true; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 8.5); }
  };
}
// Dive: straight down fast, nudging toward where the player was.
function dive(x0, speed = 12) {
  return (e, dt, g) => {
    const s = e.s;
    if (s.tx === undefined) { s.tx = clamp(g.player.x, -6, 6); e.x = x0; e.z = g.view.zTop - 2; }
    e.x += (s.tx - e.x) * Math.min(1, dt * 0.9);
    e.z += speed * dt;
    if (!s.fired && e.t > 0.7 / g.diff.fr) { s.fired = true; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 9); }
  };
}
// Snake: weave down the screen.
function snake(x0, amp = 2.6, speed = 6.2) {
  return (e, dt, g) => {
    const s = e.s;
    if (s.z0 === undefined) s.z0 = g.view.zTop - 2;
    e.x = x0 + Math.sin(e.t * 2.4) * amp;
    e.z = s.z0 + speed * e.t;
    if (!s.fired && e.t > 1.5 / g.diff.fr) { s.fired = true; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 8); }
  };
}
// Rise: overtake the player from behind along a screen edge (fires once, from a fair distance).
function rise(side) {
  return (e, dt, g) => {
    const s = e.s;
    if (s.z0 === undefined) { s.z0 = g.view.zBottom + 2; e.x = side * 9; }
    e.z = s.z0 - 11 * e.t;
    e.x = side * (9 - 3.2 * ease((e.t - 0.9) / 2.2));
    if (!s.fired && e.t > 1.7) { s.fired = true; if (g.canFire(e)) g.shoot(e.x, e.z, g.aim(e.x, e.z), 7); }
  };
}
// Vee: descend in formation, then break outward.
function vee(ox, oz) {
  return (e, dt, g) => {
    const s = e.s;
    if (s.z0 === undefined) s.z0 = g.view.zTop - 2 + oz;
    if (e.t < 1.9) { e.x = ox; e.z = s.z0 + 8.5 * e.t; }
    else { const k = e.t - 1.9; e.x = ox + Math.sign(ox || 1) * k * k * 5; e.z = s.z0 + 8.5 * 1.9 + 8.5 * k - k * k * 3; }
    if (!s.fired && e.t > 1.6) { s.fired = true; if (g.canFire(e)) g.fan(e.x, e.z, g.aim(e.x, e.z), 2, 0.25, 8); }
  };
}
// Hornet gunship: fly in, hover and fire 3-way bursts, leave.
function hover(tx, tzFrac, stay = 5.5) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.x0 === undefined) { s.x0 = tx; s.z0 = v.zTop - 3; s.tz = v.zTop + (v.zBottom - v.zTop) * tzFrac; s.fixedYaw = true; s.yaw = Math.PI; }
    if (e.t < 1.5) { const k = ease(e.t / 1.5); e.x = s.x0; e.z = s.z0 + (s.tz - s.z0) * k; }
    else if (e.t < 1.5 + stay) {
      const k = e.t - 1.5;
      e.x = s.x0 + Math.sin(k * 1.3) * 1.2;
      e.z = s.tz + Math.sin(k * 2.1) * 0.4;
      if (fireTimer(e, dt, g, 1.35, 0.15)) {
        g.fan(e.x, e.z + 0.5, g.aim(e.x, e.z), 3, 0.42, 7.2);
        g.audio.play('lock', { vol: 0.25 });
      }
    } else {
      const k = e.t - 1.5 - stay;
      e.x += Math.sign(e.x || 1) * (4 + k * 10) * dt;
      e.z -= (3 + k * 8) * dt;
    }
    s.yaw = s.yaw + (faceYaw(e, g.player.x, g.player.z) - s.yaw) * Math.min(1, dt * 4);
  };
}
// Item carrier: slow zig-zag descent, never shoots.
function carrierAI(x0) {
  return (e, dt, g) => {
    const s = e.s;
    if (s.z0 === undefined) { s.z0 = g.view.zTop - 2; s.fixedYaw = true; s.yaw = Math.PI; }
    e.x = x0 + Math.sin(e.t * 1.1) * 2.2;
    e.z = s.z0 + 2.6 * e.t;
  };
}
// Heavy bomber: settles in the upper screen, spirals + aimed fans, then climbs away.
function bomberAI(x0) {
  return (e, dt, g) => {
    const s = e.s, v = g.view;
    if (s.z0 === undefined) { s.z0 = v.zTop - 5; s.tz = v.zTop + 9; s.fixedYaw = true; s.yaw = Math.PI; s.a = 0; }
    const stay = 17;
    if (e.t < 3) { e.x = x0; e.z = s.z0 + (s.tz - s.z0) * ease(e.t / 3); }
    else if (e.t < stay) { e.x = x0 + Math.sin((e.t - 3) * 0.45) * 3; e.z = s.tz + Math.sin(e.t * 0.8) * 0.5; }
    else { e.z -= (2 + (e.t - stay) * 6) * dt; }
    if (e.t > 3 && e.t < stay) {
      const k = e.t - 3;
      if (fireTimer(e, dt, g, 2.8, 1.0)) g.fan(e.x, e.z + 1.6, g.aim(e.x, e.z), 5, 0.75, 6.8, g.BK.BIG);
      const spiral = (k > 3 && k < 6.5) || (k > 9.5 && k < 13);
      if (spiral) {
        s.st = (s.st || 0) - dt;
        if (s.st <= 0) {
          s.st = 0.13 / g.diff.fr;
          s.a += 0.36;
          if (g.canFire(e)) { g.shoot(e.x, e.z, s.a, 6.2); g.shoot(e.x, e.z, s.a + Math.PI, 6.2); }
        }
      }
    }
    if (e.hp < e.maxHp * 0.5 && Math.random() < 0.3) g.fx.smokePuff(e.x + rnd(-1.5, 1.5), 0.2, e.z + rnd(-0.5, 0.5), 0.6, 0.9);
  };
}

// --------------------------------------------------------------------------------
// ground behaviours
// --------------------------------------------------------------------------------
// Tank rolling along a lane. dir +1 drives up-screen (into the distance), -1 comes toward us.
function laneTank(speed = 1.6, dir = 1) {
  return (e, dt, g) => {
    e.gd += speed * dir * dt;
    e.yaw = dir > 0 ? 0 : Math.PI;
    const ud = e.mesh.userData;
    g.aimTurret(e, ud.turret, dt, 3);
    if (fireTimer(e, dt, g, 2.4, rnd(0.35, 0.95)) && ud.turret) {
      const m = g.muzzlePos(ud.turret);
      g.shoot(m.x, m.z, g.aim(m.x, m.z), 7.2);
    }
  };
}
// Tank crossing a road horizontally.
function crossTank(dir, speed = 2.6) {
  return (e, dt, g) => {
    e.gx += dir * speed * dt;
    e.yaw = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    const ud = e.mesh.userData;
    g.aimTurret(e, ud.turret, dt, 3);
    if (fireTimer(e, dt, g, 2.6, rnd(1.2, 2.0)) && ud.turret && Math.abs(e.gx) < 11) {
      const m = g.muzzlePos(ud.turret);
      g.shoot(m.x, m.z, g.aim(m.x, m.z), 7.2);
    }
    if (Math.abs(e.gx) > 16 && e.t > 3) e.alive = false;
  };
}
// Emplaced gun: 3-round aimed bursts.
function turretAI() {
  return (e, dt, g) => {
    const ud = e.mesh.userData, s = e.s;
    g.aimTurret(e, ud.turret, dt, 4);
    if (fireTimer(e, dt, g, 2.9, rnd(0.35, 0.95))) s.burst = 3;
    if (s.burst > 0) {
      s.bt = (s.bt || 0) - dt;
      if (s.bt <= 0) {
        s.bt = 0.13; s.burst--;
        if (g.canFire(e) && ud.turret) { const m = g.muzzlePos(ud.turret); g.shoot(m.x, m.z, g.aim(m.x, m.z), 8.2); }
      }
    }
  };
}
// Patrol boat: sails forward, bobs, fires 5-way fans.
function boatAI(speed = 1.4) {
  return (e, dt, g) => {
    e.gd += speed * dt;
    e.yaw = Math.sin(e.t * 0.7) * 0.08;
    const ud = e.mesh.userData;
    e.s.y = Math.sin(e.t * 2.2) * 0.05;
    g.aimTurret(e, ud.turret, dt, 2.5);
    if (fireTimer(e, dt, g, 2.7, rnd(0.8, 1.6))) {
      const m = ud.turret ? g.muzzlePos(ud.turret) : { x: e.x, z: e.z };
      g.fan(m.x, m.z, g.aim(m.x, m.z), 5, 0.9, 6.4);
    }
    if (Math.random() < 0.5) g.fx.p.emit(e.gx + rnd(-0.3, 0.3), g.GROUND_Y + 0.05, e.gz + 2.0, rnd(-0.4, 0.4), 0, 0.5, 1.1, 0.5, 1.6,
      [0.85, 0.9, 0.95, 0.45], [0.8, 0.85, 0.9, 0], 3, 2, { scroll: true, drag: 1, flat: true });
  };
}

// --------------------------------------------------------------------------------
// mid-boss: CRAWLER siege tank
// --------------------------------------------------------------------------------
function crawlerAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, P = ud.parts || {};
    const scroll = g.scrollSpeed;
    if (!s.init) { s.init = true; s.mode = 'enter'; s.a = 0; s.life = 0; }
    s.life += dt;
    if (e.dying) {
      s.dieT = (s.dieT || 0) + dt;
      e.gd += scroll * dt;
      s.boomT = (s.boomT || 0) - dt;
      if (s.boomT <= 0) {
        s.boomT = 0.12;
        g.fx.explosion(e.gx + rnd(-2.5, 2.5), g.GROUND_Y + 0.8, e.gz + rnd(-2, 2), rnd(1.0, 1.8), { ground: true });
        g.audio.play('explodeM', { vol: 0.7 });
        g.shake.add(0.12);
      }
      if (s.dieT > 1.6) {
        g.fx.explosion(e.gx, g.GROUND_Y + 1, e.gz, 4, { ground: true, debris: 30, color: ud.debrisColor });
        g.fx.shockwave(e.x, 0.1, e.z, 18, [2.4, 1.6, 1.0, 1], 0.8);
        g.shake.add(0.7); g.ui.flash(0.5);
        g.audio.play('explodeL');
        g.addScore(ENEMY.crawler.score);
        g.popupAt(e.x, e.z, '30,000', 'big');
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
    const v = g.view;
    const stationGz = v.pToGz(v.zTop + 11);
    if (s.mode === 'enter') {
      e.gd += (scroll - 4.5) * dt;
      if (e.gz >= stationGz) { s.mode = 'fight'; s.fightT = 0; }
      e.invuln = true;
    } else if (s.mode === 'fight') {
      e.invuln = false;
      s.fightT += dt;
      e.gd = g.world.distance - stationGz;
      e.gx = Math.sin(s.fightT * 0.42) * 3.2;
      if (s.fightT > 38) s.mode = 'retreat';
    } else {
      e.gd += (scroll + 5) * dt;
      if (e.gz < v.gTop - 8) { e.alive = false; g.midbossDone = true; }
    }
    e.yaw = 0;
    g.aimTurret(e, P.turret, dt, 1.6);
    if (s.mode !== 'fight') return;
    const rage = e.hp < e.maxHp * 0.5;
    if (fireTimer(e, dt, g, rage ? 2.0 : 2.5, 1.2) && P.turret) {
      const m = g.muzzlePos(P.turret);
      g.fan(m.x, m.z, g.aim(m.x, m.z), rage ? 7 : 5, rage ? 1.0 : 0.7, 6.8, g.BK.BIG);
      g.shake.add(0.08);
    }
    if (rage) {
      s.rt = (s.rt || 3) - dt;
      if (s.rt <= 0) { s.rt = 3.6 / g.diff.fr; s.a += 0.2; if (g.canFire(e)) g.ring(e.x, e.z, 18, 5.6, s.a); }
    }
    for (const pt of e.parts || []) {
      if (pt.dead) continue;
      pt.fireT -= dt;
      if (pt.fireT <= 0) {
        pt.fireT = 1.7 / g.diff.fr;
        if (!g.canFire(e)) continue;
        const m = g.muzzlePos(pt.obj);
        const mx = m.x, mz = m.z, a = g.aim(mx, mz); // copy: muzzlePos returns a shared scratch object
        for (let i = 0; i < 3; i++) g.later(i * 0.09, () => { if (!pt.dead && e.alive && !e.dying) g.shoot(mx, mz, a, 9.5, g.BK.NEEDLE); });
      }
    }
  };
}

// --------------------------------------------------------------------------------
// boss: ARCLIGHT flying fortress
// --------------------------------------------------------------------------------
function bossAI() {
  return (e, dt, g) => {
    const s = e.s, ud = e.mesh.userData, v = g.view;
    const core = g.partByKey(e, 'core');
    if (!s.init) {
      s.init = true; s.mode = 'enter'; s.a = 0; s.b = 0; s.mt = 0; s.open = 0;
      s.fixedYaw = true; s.yaw = Math.PI; e.invuln = true; e.armored = true;
      e.x = 0; e.z = v.zTop - 9; s.baseZ = v.zTop + 14;
    }
    // HP bar: all living parts
    let hp = 0, max = 0;
    for (const pt of e.parts) { max += pt.maxHp; hp += Math.max(0, pt.hp); }
    g.ui.setBossHP(hp / max);

    if (e.dying) {
      s.dieT = (s.dieT || 0) + dt;
      s.boomT = (s.boomT || 0) - dt;
      if (s.boomT <= 0 && s.dieT < 2.8) {
        s.boomT = 0.09;
        g.fx.explosion(e.x + rnd(-6, 6), 0.4, e.z + rnd(-3.5, 3.5), rnd(1.2, 2.4), { debris: 4, color: ud.debrisColor });
        g.audio.play('explodeM', { vol: 0.6, pan: rnd(-0.6, 0.6) });
        g.shake.add(0.15);
      }
      // sink toward the sea, nose down
      e.z += 0.8 * dt;
      s.pitch = Math.min(0.5, s.dieT * 0.12);
      if (s.dieT > 2.0) s.y = -(s.dieT - 2.0) * (s.dieT - 2.0) * 2.2;
      if (s.dieT > 2.8 && !s.final) {
        s.final = true;
        g.fx.explosion(e.x, 0.5, e.z, 5, { debris: 40, color: ud.debrisColor });
        g.fx.shockwave(e.x, 0.1, e.z, 32, [3, 2.2, 1.6, 1], 1.0);
        g.fx.shockwave(e.x, 0.1, e.z, 20, [2.6, 1.0, 1.8, 1], 0.8);
        g.ui.flash(1); g.shake.add(1);
        g.audio.play('bossDown');
        g.haptic([80, 50, 200]);
        for (let i = 0; i < 16; i++) g.dropItem('medal', e.x + rnd(-5, 5), e.z + rnd(-3, 3));
      }
      if (s.dieT > 3.4) {
        for (const dx of [-4, 0, 4]) g.fx.splash(v.pToGx(e.x + dx), g.GROUND_Y, v.pToGz(e.z + rnd(-1, 1)), 3.5);
        e.alive = false;
        g.ui.boss(false);
      }
      return;
    }

    if (s.mode === 'enter') {
      const k = ease(e.t / 3.5);
      e.z = (v.zTop - 9) + (s.baseZ - (v.zTop - 9)) * k;
      if (e.t > 3.5) { s.mode = 'p1'; s.pt = 0; e.invuln = false; }
      return;
    }
    s.pt += dt;
    const living = (key) => { const p = g.partByKey(e, key); return p && !p.dead ? p : null; };
    // movement
    const sway = s.mode === 'p1' ? 2.4 : s.mode === 'p2' ? 3.8 : 4.4;
    const freq = s.mode === 'p3' ? 0.55 : 0.36;
    e.x = Math.sin(s.pt * freq) * sway;
    e.z = s.baseZ + Math.sin(s.pt * 0.5) * 0.8;

    // core shutters
    const wantOpen = s.mode === 'p1' ? 0 : 1;
    s.open += (wantOpen - s.open) * Math.min(1, dt * 1.8);
    if (core && core.obj.userData.setOpen) core.obj.userData.setOpen(s.open);
    e.armored = s.open < 0.85;

    // phase transitions
    const wingsGone = !living('wingL') && !living('wingR');
    if (s.mode === 'p1' && (wingsGone || s.pt > 42)) { s.mode = 'p2'; s.pt2 = 0; g.audio.play('warning', { vol: 0.5 }); g.shake.add(0.3); }
    if (s.mode === 'p2' && core && core.hp < core.maxHp * 0.4) { s.mode = 'p3'; g.shake.add(0.5); g.ui.flash(0.3); g.audio.play('explodeL'); }
    if (!g.canFire(e)) return;
    const fr = g.diff.fr;

    // wing cannons: alternating aimed fans
    s.wt = (s.wt ?? 1.2) - dt;
    if (s.wt <= 0) {
      s.wt = 2.1 / fr;
      s.side = s.side === 'L' ? 'R' : 'L';
      const w = living('wing' + s.side) || living(s.side === 'L' ? 'wingR' : 'wingL');
      if (w) { const m = g.muzzlePos(w.obj); g.fan(m.x, m.z, g.aim(m.x, m.z), 5, 0.62, 7); }
    }
    // turrets: aimed needles
    for (let i = 0; i < 4; i++) {
      const t = living('turret' + i);
      if (!t) continue;
      const obj = t.obj;
      const want = Math.atan2(-(g.player.x - t.x), -(g.player.z - t.z)) - e.yaw;
      obj.rotation.y += clamp(((want - obj.rotation.y + Math.PI * 3) % TAU) - Math.PI, -3 * dt, 3 * dt);
      t.fireT -= dt;
      if (t.fireT <= 0) { t.fireT = (1.8 + i * 0.2) / fr; const m = g.muzzlePos(obj); g.shoot(m.x, m.z, g.aim(m.x, m.z), 9, g.BK.NEEDLE); }
    }
    // missile pods: slow homing mines
    s.mt -= dt;
    if (s.mt <= 0) {
      s.mt = 3.6 / fr;
      for (const k of ['podL', 'podR']) { const p = living(k); if (p) { const m = g.muzzlePos(p.obj); g.shoot(m.x, m.z, g.aim(m.x, m.z) + rnd(-0.4, 0.4), 4.8, g.BK.MINE); } }
    }
    if (s.mode === 'p2' || s.mode === 'p3') {
      const cm = core ? g.muzzlePos(core.obj) : { x: e.x, z: e.z };
      s.st = (s.st || 0) - dt;
      const hard = g.loop > 1;
      const arms = s.mode === 'p3' ? (hard ? 4 : 3) : 2;
      if (s.st <= 0) {
        s.st = (s.mode === 'p3' ? (hard ? 0.12 : 0.14) : 0.1) / fr;
        s.a += s.mode === 'p3' ? 0.29 : 0.23;
        for (let i = 0; i < arms; i++) g.shoot(cm.x, cm.z, s.a + (i / arms) * TAU, s.mode === 'p3' ? 6.4 : 5.8);
      }
      s.ft2 = (s.ft2 ?? 2) - dt;
      if (s.ft2 <= 0) { s.ft2 = 3.0 / fr; g.fan(cm.x, cm.z, g.aim(cm.x, cm.z), 7, 1.0, 6.6, g.BK.BIG); }
      if (s.mode === 'p3') {
        s.rt = (s.rt ?? 1) - dt;
        if (s.rt <= 0) { s.rt = (hard ? 1.7 : 2.0) / fr; s.b += 0.13; g.ring(cm.x, cm.z, hard ? 20 : 16, 5.2, s.b); }
      }
    }
  };
}

// --------------------------------------------------------------------------------
// spawn helpers
// --------------------------------------------------------------------------------
const W = {
  swoop(g, side, n = 5, gap = 0.28) { for (let i = 0; i < n; i++) g.later(i * gap, () => g.spawn('dart', { x: side * 8, z: -60, ai: swoop(side) })); },
  dive(g, xs, gap = 0.35) { xs.forEach((x, i) => g.later(i * gap, () => g.spawn('dart', { x, z: -60, ai: dive(x) }))); },
  snake(g, x0, n = 6, gap = 0.32) { for (let i = 0; i < n; i++) g.later(i * gap, () => g.spawn('dart', { x: x0, z: -60, ai: snake(x0) })); },
  rise(g, side, n = 3, gap = 0.3) { for (let i = 0; i < n; i++) g.later(i * gap, () => g.spawn('dart', { x: side * 9, z: 60, ai: rise(side) })); },
  vee(g, cx = 0) {
    const offs = [[0, 0], [-1.6, -1.4], [1.6, -1.4], [-3.2, -2.8], [3.2, -2.8]];
    for (const [ox, oz] of offs) g.spawn('dart', { x: cx + ox, z: -60, ai: vee(cx + ox, oz) });
  },
  hornet(g, tx, tz = 0.3, stay = 5.5) { return g.spawn('hornet', { x: tx, z: -60, ai: hover(tx, tz, stay) }); },
  carrier(g, x0, drops) { return g.spawn('carrier', { x: x0, z: -60, ai: carrierAI(x0), drops }); },
  bomber(g, x0, drops) { return g.spawn('bomber', { x: x0, z: -60, ai: bomberAI(x0), drops }); },
  lane(g, laneIdx, n = 1, gap = 3.2, dir = 1, speed = 1.6) {
    for (let i = 0; i < n; i++) g.spawn('tank', { gx: LANES_X[laneIdx], gd: g.topGd(1 + i * gap), ai: laneTank(speed, dir), yaw: dir > 0 ? 0 : Math.PI });
  },
  // tanks crossing on the next cross road that is just beyond the top edge
  cross(g, dirs) {
    const top = g.topGd(0);
    const road = Math.ceil((top - CROSS_ROAD_PERIOD / 2) / CROSS_ROAD_PERIOD) * CROSS_ROAD_PERIOD + CROSS_ROAD_PERIOD / 2;
    dirs.forEach((dir, i) => g.later(i * 0.9, () => g.spawn('tank', { gx: -dir * 14, gd: road, ai: crossTank(dir), yaw: dir > 0 ? -Math.PI / 2 : Math.PI / 2 })));
  },
  turrets(g, lanes, extra = 0) { for (const l of lanes) g.spawn('turret', { gx: LANES_X[l], gd: g.topGd(1 + extra), ai: turretAI() }); },
  boats(g, xs, stagger = 3) { xs.forEach((gx, i) => g.spawn('gunboat', { gx, gd: g.topGd(2 + i * stagger), ai: boatAI() })); },
};

export function spawnMidboss(g) {
  const e = g.spawn('crawler', { gx: 0, gd: g.topGd(5), ai: crawlerAI() });
  e.invuln = true;
  e.onDeath = () => { g.stats.midbossTime = e.s.life; };
  return e;
}
export function spawnBoss(g) {
  const e = g.spawn('boss', { x: 0, z: g.view.zTop - 9, ai: bossAI() });
  e.onDeath = () => {
    e.s.dieT = 0;
    g.slowT = 1.1;
    g.cancelBullets(0, 0, 999, true);
    g.phase = 'bossdead'; g.clearT = 0;
    g.stats.bossTime = e.t;
    g.audio.music(null);
  };
  e.onPartDestroyed = (en, pt) => {
    if (pt.key.startsWith('wing')) g.dropItem('P', pt.x, pt.z, { color: g.player.main });
  };
  return e;
}

// --------------------------------------------------------------------------------
// Stage 1 timeline (distance in ground units; ~7 units/s)
// --------------------------------------------------------------------------------
export const TIMELINE = [];
const at = (d, run) => TIMELINE.push({ d, run });

// OCEAN ──────────────────────────────────────────────
at(26, (g) => W.swoop(g, -1));
at(46, (g) => W.swoop(g, 1));
at(66, (g) => W.carrier(g, 0, ['P']));
at(84, (g) => W.boats(g, [-5, 5.5]));
at(102, (g) => W.vee(g, 0));
at(120, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
at(146, (g) => W.snake(g, -3.5));
at(160, (g) => W.boats(g, [-7, 0, 7], 4));
at(178, (g) => { W.swoop(g, -1, 4); g.later(0.9, () => W.swoop(g, 1, 4)); });
at(196, (g) => W.dive(g, [-5, 3, -1, 5]));
at(212, (g) => W.carrier(g, 3, ['P', 'S']));
at(226, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
at(250, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
at(264, (g) => { W.boats(g, [-4, 6], 5); W.swoop(g, -1, 4); });
at(286, (g) => W.vee(g, 2));
// COAST ─────────────────────────────────────────────
at(302, (g) => { W.lane(g, 0, 2); W.lane(g, 2, 2); });
at(318, (g) => W.turrets(g, [0, 2]));
at(334, (g) => W.swoop(g, 1));
at(348, (g) => W.carrier(g, -2, ['P']));
at(360, (g) => { W.hornet(g, -4, 0.3); W.hornet(g, 4, 0.3); });
at(372, (g) => W.cross(g, [1, 1]));
// COUNTRY ───────────────────────────────────────────
at(392, (g) => W.dive(g, [-6, -2, 2, 6, 0]));
at(404, (g) => W.lane(g, 1, 3, 3));
at(420, (g) => W.turrets(g, [0, 2]));
at(436, (g) => { W.hornet(g, -5, 0.3); W.cross(g, [-1, -1]); });
at(456, (g) => { W.snake(g, 3.5); g.later(1, () => W.snake(g, -3.5, 4)); });
at(470, (g) => W.carrier(g, 0, ['B']));
at(482, (g) => { W.lane(g, 0, 2); W.lane(g, 2, 2); W.turrets(g, [1], 3); });
at(500, (g) => { W.swoop(g, -1, 4); g.later(1, () => W.swoop(g, 1, 4)); });
at(516, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 6, 0.26); g.later(1.2, () => W.hornet(g, 0, 0.18)); });
at(530, (g) => W.cross(g, [1, -1, 1]));
at(546, (g) => { W.vee(g, -2); W.turrets(g, [0, 2]); });
at(560, (g) => W.carrier(g, 2, ['P']));
at(572, (g) => { W.rise(g, 1); g.later(0.5, () => W.rise(g, -1)); });
at(MIDBOSS_AT, (g) => { g.phase = 'midboss'; g.scrollTarget = 1.0; g.onEvent('midboss'); spawnMidboss(g); });
// CITY ──────────────────────────────────────────────
at(644, (g) => W.cross(g, [1, 1]));
at(652, (g) => { W.swoop(g, -1); g.later(0.9, () => W.swoop(g, 1)); });
at(666, (g) => W.turrets(g, [0, 1, 2]));
at(682, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); });
at(700, (g) => W.bomber(g, 0, ['P', 'B']));
at(734, (g) => { W.lane(g, 0, 2); W.lane(g, 2, 2, 3.2, -1, 1.2); });
at(746, (g) => W.dive(g, [-4, 4, 0]));
at(758, (g) => W.carrier(g, -3, ['P']));
at(772, (g) => { W.turrets(g, [0, 2]); W.cross(g, [-1]); });
at(790, (g) => { W.snake(g, -4); W.snake(g, 4); });
at(806, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
at(826, (g) => { W.snake(g, 0, 10, 0.25); });
at(846, (g) => W.turrets(g, [0, 1, 2]));
at(862, (g) => { W.bomber(g, 0, ['S', 'B']); g.later(2, () => { W.hornet(g, -6, 0.42, 7); W.hornet(g, 6, 0.42, 7); }); });
at(896, (g) => W.cross(g, [1, -1]));
at(908, (g) => W.carrier(g, 3, ['P']));
at(922, (g) => { W.swoop(g, 1); g.later(1, () => W.swoop(g, -1)); });
at(942, (g) => { W.turrets(g, [0, 2]); W.lane(g, 1, 2); });
// BASE ──────────────────────────────────────────────
at(966, (g) => W.turrets(g, [0, 1, 2]));
at(982, (g) => { W.lane(g, 0, 3, 3); W.lane(g, 2, 3, 3); });
at(998, (g) => { W.rise(g, -1, 4); g.later(0.6, () => W.rise(g, 1, 4)); });
at(1012, (g) => { W.hornet(g, -6, 0.24); W.hornet(g, -2, 0.32); W.hornet(g, 2, 0.32); W.hornet(g, 6, 0.24); });
at(1032, (g) => { W.carrier(g, -3, ['P']); g.later(1.5, () => W.carrier(g, 3, ['B'])); });
at(1050, (g) => W.cross(g, [1, -1, 1, -1]));
at(1066, (g) => { W.vee(g, 0); g.later(1.2, () => W.swoop(g, -1, 4)); });
at(1086, (g) => { W.turrets(g, [0, 2]); W.lane(g, 1, 3, 3); });
at(1104, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['B'])); });
at(1142, (g) => W.dive(g, [-6, -3, 0, 3, 6, -1]));
at(1158, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); });
at(1172, (g) => W.carrier(g, 0, ['1UP']));
at(1184, (g) => W.turrets(g, [0, 1, 2]));
at(1198, (g) => { W.swoop(g, -1); g.later(0.8, () => W.swoop(g, 1)); });
at(1216, (g) => W.carrier(g, 0, ['B']));
TIMELINE.sort((a, b) => a.d - b.d);

export const STAGE_INFO = { number: 1, name: 'COASTAL FRONT', nameZh: '沿岸前線', boss: 'ARCLIGHT' };
