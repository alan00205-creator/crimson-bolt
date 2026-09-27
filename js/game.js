// game.js — gameplay runtime: player, weapons, enemies, bullets, items, collisions, scoring.
// The stage timeline and enemy behaviours live in stage.js; menus/flow live in main.js.
import * as THREE from 'three';
import { F, flatRot } from './fx.js';
import { ENEMY, TIMELINE, STAGE_BOSS_AT, spawnBoss } from './stage.js';

const DEG = Math.PI / 180;
const TILT = 20 * DEG;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------
// View: camera fitting and plane/ground/screen conversions.
// ---------------------------------------------------------------------------
export class View {
  constructor(camera, groundY) {
    this.camera = camera;
    this.GY = groundY;
    this.C = new THREE.Vector3();
    this.T = new THREE.Vector3(0, 0, -6);
    this.v = new THREE.Vector3(0, -Math.cos(TILT), -Math.sin(TILT));
    this.w = 1; this.h = 1;
    this.zTop = -25; this.zBottom = 9; this.gTop = -31; this.tanH = 0.2;
    this._p = new THREE.Vector3();
  }
  fit(w, h) {
    this.w = w; this.h = h;
    const a = w / h;
    const cam = this.camera;
    cam.fov = 40; cam.aspect = a; cam.near = 1; cam.far = 260;
    const tanV = Math.tan(20 * DEG);
    this.tanH = tanV * a;
    let D = 8.4 / this.tanH + 3.42;
    D = clamp(D, 30, 66);
    this.D = D;
    this.C.set(0, D * Math.cos(TILT), -6 + D * Math.sin(TILT));
    cam.position.copy(this.C);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.T);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const edge = (ndcY, y) => {
      const p = this._p.set(0, ndcY, 0.5).unproject(cam).sub(this.C).normalize();
      const t = (y - this.C.y) / p.y;
      return this.C.z + p.z * t;
    };
    this.zTop = edge(1, 0); this.zBottom = edge(-1, 0);
    this.gTop = edge(1, this.GY); this.gBottom = edge(-1, this.GY);
    this.k = this.C.y / (this.C.y - this.GY); // ground→plane scale
  }
  depthAt(z, y = 0) { return (z - this.C.z) * this.v.z + (y - this.C.y) * this.v.y; }
  hw(z) { return this.depthAt(z) * this.tanH; }            // half-width of the visible plane at z
  gToPx(gx) { return this.C.x + (gx - this.C.x) * this.k; }
  gToPz(gz) { return this.C.z + (gz - this.C.z) * this.k; }
  pToGx(px) { return this.C.x + (px - this.C.x) / this.k; }
  pToGz(pz) { return this.C.z + (pz - this.C.z) / this.k; }
  // Project any world point onto the gameplay plane along the camera ray.
  toPlane(v, out) {
    const t = this.C.y / (this.C.y - v.y);
    out.x = this.C.x + (v.x - this.C.x) * t;
    out.z = this.C.z + (v.z - this.C.z) * t;
    out.s = t;
    return out;
  }
  toScreen(x, y, z, out) {
    const p = this._p.set(x, y, z).project(this.camera);
    out.x = (p.x + 1) * 0.5 * this.w; out.y = (1 - p.y) * 0.5 * this.h;
    return out;
  }
  screenToPlane(px, py, out) {
    const p = this._p.set((px / this.w) * 2 - 1, 1 - (py / this.h) * 2, 0.5).unproject(this.camera).sub(this.C).normalize();
    const t = -this.C.y / p.y;
    out.x = this.C.x + p.x * t; out.z = this.C.z + p.z * t;
    return out;
  }
  onScreen(x, z, m = 0) { return z > this.zTop - m && z < this.zBottom + m && Math.abs(x) < this.hw(z) + m; }
}

// ---------------------------------------------------------------------------
// Mesh pool: reuse models (and their shadows) instead of creating per spawn.
// ---------------------------------------------------------------------------
class Pool {
  constructor(scene, make, withShadow, models) { this.scene = scene; this.make = make; this.free = []; this.withShadow = withShadow; this.models = models; }
  get() {
    let o = this.free.pop();
    if (!o) {
      const mesh = this.make();
      mesh.rotation.order = 'YXZ';
      let shadow = null;
      if (this.withShadow && this.models.createShadow) {
        try { shadow = this.models.createShadow(mesh); } catch (_) { shadow = null; }
        if (shadow) { shadow.rotation.order = 'YXZ'; this.scene.add(shadow); }
      }
      this.scene.add(mesh);
      o = { mesh, shadow };
    }
    o.mesh.visible = true;
    if (o.shadow) o.shadow.visible = true;
    return o;
  }
  put(o) {
    o.mesh.visible = false;
    if (o.shadow) o.shadow.visible = false;
    const ud = o.mesh.userData;
    if (ud.setFlash) ud.setFlash(0);
    this.free.push(o);
  }
  prewarm(n) { const a = []; for (let i = 0; i < n; i++) a.push(this.get()); for (const o of a) this.put(o); }
}

// Weapon patterns --------------------------------------------------------------
// Vulcan (red): per level, a list of [xOffset, angleDeg]. Angle 0 = straight up.
const VULCAN = [
  null,
  [[-0.2, 0], [0.2, 0]],
  [[0, 0], [-0.3, -7], [0.3, 7]],
  [[-0.2, 0], [0.2, 0], [-0.35, -9], [0.35, 9]],
  [[0, 0], [-0.3, -5], [0.3, 5], [-0.4, -13], [0.4, 13]],
  [[-0.2, 0], [0.2, 0], [-0.35, -7], [0.35, 7], [-0.45, -16], [0.45, 16]],
  [[0, 0], [-0.3, -5], [0.3, 5], [-0.4, -12], [0.4, 12], [-0.5, -22], [0.5, 22]],
  [[-0.2, 0], [0.2, 0], [-0.3, -6], [0.3, 6], [-0.4, -14], [0.4, 14], [-0.5, -26], [0.5, 26]],
  [[0, 0], [-0.25, -4], [0.25, 4], [-0.35, -10], [0.35, 10], [-0.45, -19], [0.45, 19], [-0.55, -32], [0.55, 32]],
];
export const MEDAL_VALUES = [500, 1000, 2000, 4000, 6000, 8000, 10000];
const EXTENDS = [200000, 600000];

// Enemy bullet kinds
const BK = { ORB: 0, BIG: 1, NEEDLE: 2, MINE: 3 };
const B_RADIUS = [0.2, 0.36, 0.17, 0.4];
const B_SIZE = [0.66, 1.08, 0.34, 1.2];
const B_COLOR = [[2.6, 0.42, 1.3], [2.9, 1.15, 0.25], [2.4, 0.45, 2.3], [3.0, 0.55, 0.18]];

// Player shot kinds
const SK = { VULCAN: 0, LASER: 1, HOMING: 2, NUKE: 3 };

export class Game {
  constructor(ctx) {
    Object.assign(this, ctx); // scene, world, fx, audio, ui, models, view, shake, settings, GROUND_Y, LANES_X
    this.time = 0;
    this.loop = 1;
    this.enemies = [];
    this.items = [];
    this.pools = {};
    this.tmpA = { x: 0, z: 0, s: 1 };
    this.tmpV = new THREE.Vector3();
    this.tmpS = { x: 0, y: 0 };
    this.targets = [];
    for (let i = 0; i < 64; i++) this.targets.push({ x: 0, z: 0, r: 0, e: null, part: null, armored: false });
    this.nTargets = 0;
    this.hullTarget = { x: 0, z: 0, r: 0, e: null, part: null, armored: true };
    // enemy bullets (SoA)
    const EB = 800;
    this.eb = {
      n: 0, max: EB, x: new Float32Array(EB), z: new Float32Array(EB), vx: new Float32Array(EB), vz: new Float32Array(EB),
      ax: new Float32Array(EB), az: new Float32Array(EB), t: new Float32Array(EB), kind: new Uint8Array(EB), grazed: new Uint8Array(EB),
      home: new Float32Array(EB),
    };
    // player shots (SoA)
    const PS = 520;
    this.ps = {
      n: 0, max: PS, x: new Float32Array(PS), z: new Float32Array(PS), vx: new Float32Array(PS), vz: new Float32Array(PS),
      dmg: new Float32Array(PS), r: new Float32Array(PS), t: new Float32Array(PS), kind: new Uint8Array(PS), w: new Float32Array(PS),
      target: new Array(PS).fill(null), trail: new Float32Array(PS),
    };
    this.player = {
      x: 0, z: 5, alive: true, mesh: null, shadow: null, invuln: 0, respawn: 0, bank: 0, thrust: 0.5,
      main: 'red', level: 1, sub: null, subLevel: 0, fireT: 0, subT: 0, laserT: 0, entering: 0, lastX: 0, lastZ: 5,
    };
    this.scrollSpeed = 7; this.scrollTarget = 7;
    this.stats = null;
    this.timers = [];
    this.onEvent = () => {};
  }

  // --- setup ------------------------------------------------------------------------
  initPools() {
    const M = this.models;
    const mk = (fn) => () => { try { return fn(); } catch (e) { console.error(e); return new THREE.Group(); } };
    const air = ['dart', 'hornet', 'carrier', 'bomber'];
    const ground = ['tank', 'turret', 'gunboat', 'crawler'];
    for (const t of air) this.pools[t] = new Pool(this.scene, mk(() => M.createEnemy(t)), true, M);
    for (const t of ground) this.pools[t] = new Pool(this.scene, mk(() => M.createEnemy(t)), false, M);
    this.pools.boss = new Pool(this.scene, mk(() => M.createBoss()), true, M);
    for (const k of ['P', 'S', 'B', 'medal', '1UP']) this.pools['item_' + k] = new Pool(this.scene, mk(() => M.createItem(k)), false, M);
    const pp = new Pool(this.scene, mk(() => M.createPlayer()), true, M);
    const po = pp.get();
    this.player.mesh = po.mesh; this.player.shadow = po.shadow;
    const hm = po.mesh.userData.hitboxMarker; if (hm) hm.visible = false;
    const counts = { dart: 14, hornet: 5, carrier: 2, bomber: 2, tank: 10, turret: 8, gunboat: 4, crawler: 1, boss: 1, item_P: 4, item_S: 2, item_B: 2, item_medal: 16, item_1UP: 1 };
    for (const [k, n] of Object.entries(counts)) this.pools[k].prewarm(n);
  }
  // Make every pooled model visible for one compile pass (avoids first-spawn hitches).
  forEachPooled(fn) { for (const p of Object.values(this.pools)) for (const o of p.free) fn(o); }

  resetRun({ keepScore = false, loop = 1 } = {}) {
    this.clearField();
    this.loop = loop;
    if (!keepScore) {
      this.score = 0; this.lives = 2; this.bombs = 3; this.credits = 1;
      this.extendIdx = 0;
      Object.assign(this.player, { main: 'red', level: 1, sub: null, subLevel: 0 });
    }
    this.medalChain = 0; this.medalMaxChain = 0;
    this.stats = { spawned: 0, killed: 0, deaths: 0, bombsUsed: 0, grazes: 0, medals: 0, stageScoreStart: this.score };
    this.tlIndex = 0;
    this.phase = 'stage'; // stage | midboss | warning | boss | bossdead | clear
    this.boss = null; this.midboss = null;
    this.midbossDone = false; this.warned = false; this.clearAnnounced = false; this.clearDone = false;
    this.bombT = 0; this.bombWave = 0;
    this.timeScale = 1; this.slowT = 0;
    this.warningT = 0;
    this.clearT = 0;
    this.scrollSpeed = 7; this.scrollTarget = 7;
    const p = this.player;
    p.alive = true; p.x = 0; p.z = this.view.zBottom + 2; p.entering = 1.2; p.invuln = 2.2; p.respawn = 0;
    p.fireT = 0; p.subT = 0; p.bank = 0; p.mesh.visible = true;
    this.diff = loop > 1 ? { bs: 1.22, fr: 1.35, hp: 1.3 } : { bs: 1, fr: 1, hp: 1 };
    this.world.reset(0);
  }
  clearField() {
    for (const e of this.enemies) this.releaseEnemy(e);
    this.enemies.length = 0;
    for (const it of this.items) this.pools['item_' + it.kind].put(it.o);
    this.items.length = 0;
    this.eb.n = 0; this.ps.n = 0;
    this.timers.length = 0;
    this.fx.clear();
    this.ui.boss(false);
  }

  // --- helpers used by stage.js ------------------------------------------------------------
  later(sec, fn) { this.timers.push({ t: sec, fn }); }
  runTimers(dt) {
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= dt;
      if (tm.t <= 0) { this.timers.splice(i, 1); try { tm.fn(); } catch (err) { console.error('timer', err); } }
    }
  }
  aim(x, z) { const p = this.player; return Math.atan2(p.x - x, p.z - z); }
  shoot(x, z, ang, speed, kind = BK.ORB) {
    const b = this.eb;
    if (b.n >= b.max) return -1;
    const i = b.n++;
    const s = speed * this.diff.bs;
    b.x[i] = x; b.z[i] = z; b.vx[i] = Math.sin(ang) * s; b.vz[i] = Math.cos(ang) * s;
    b.ax[i] = 0; b.az[i] = 0; b.t[i] = 0; b.kind[i] = kind; b.grazed[i] = 0; b.home[i] = kind === BK.MINE ? 1.3 : 0;
    return i;
  }
  fan(x, z, center, n, spread, speed, kind) {
    if (n === 1) { this.shoot(x, z, center, speed, kind); return; }
    for (let i = 0; i < n; i++) this.shoot(x, z, center + (i / (n - 1) - 0.5) * spread, speed, kind);
  }
  ring(x, z, n, speed, offset = 0, kind = BK.ORB) {
    for (let i = 0; i < n; i++) this.shoot(x, z, offset + (i / n) * Math.PI * 2, speed, kind);
  }
  // Is it fair to let this enemy fire right now?
  canFire(e) {
    const p = this.player;
    if (!p.alive || p.entering > 0) return false;
    if (e.z < this.view.zTop + 0.8 || e.z > this.view.zBottom - 1) return false;
    const dx = p.x - e.x, dz = p.z - e.z;
    return dx * dx + dz * dz > 10;
  }
  get BK() { return BK; }

  // Stage coordinate for a ground unit spawned just beyond the top edge.
  topGd(margin = 2) { return this.world.distance - (this.view.gTop - margin); }

  spawn(type, opts) {
    const def = ENEMY[type];
    const o = this.pools[type].get();
    const hpMul = def.boss ? 1 : this.diff.hp;
    const e = {
      type, def, o, mesh: o.mesh, shadow: o.shadow, ground: !def.air,
      hp: def.hp * hpMul, maxHp: def.hp * hpMul, r: def.radius, alive: true,
      x: 0, z: -40, gx: 0, gd: 0, vx: 0, vz: 0, yaw: Math.PI, roll: 0, t: 0, flash: 0,
      ai: opts.ai, s: opts.s || {}, drops: opts.drops || null, parts: null, armored: false,
      entered: false, scoreMul: 1, noCount: !!def.boss, sinks: def.water,
    };
    if (e.ground) { e.gx = opts.gx; e.gd = opts.gd; e.yaw = opts.yaw ?? 0; this.syncGround(e); }
    else { e.x = opts.x; e.z = opts.z; }
    const ud = e.mesh.userData;
    if (ud.setFlash) ud.setFlash(0);
    e.mesh.rotation.set(0, e.yaw, 0);
    if (!e.noCount) this.stats.spawned++;
    this.enemies.push(e);
    if (def.boss || type === 'crawler') this.initParts(e);
    // let the behaviour place the unit before its first rendered frame
    try { e.ai(e, 0, this); } catch (err) { console.error('ai-init', type, err); }
    if (e.ground) this.syncGround(e);
    this.syncEnemyMesh(e, 0);
    return e;
  }
  syncGround(e) {
    const gz = this.world.distance - e.gd;
    e.gz = gz;
    e.x = this.view.gToPx(e.gx);
    e.z = this.view.gToPz(gz);
  }
  initParts(e) {
    const ud = e.mesh.userData;
    const P = ud.parts;
    if (!P) return;
    const list = [];
    const add = (key, obj, hp, extra = {}) => {
      if (!obj) return;
      const pud = obj.userData || {};
      if (pud.setDestroyed) pud.setDestroyed(false);
      if (pud.setFlash) pud.setFlash(0);
      list.push({ key, obj, hp: hp * (this.loop > 1 ? 1.2 : 1), maxHp: hp * (this.loop > 1 ? 1.2 : 1), r: pud.radius || 1, dead: false, flash: 0, x: 0, z: 0, fireT: rnd(0.5, 1.5), ...extra });
    };
    if (e.type === 'crawler') {
      add('gunL', P.gunL, 45); add('gunR', P.gunR, 45);
    } else if (e.def.boss) {
      add('wingL', P.wingL, 170); add('wingR', P.wingR, 170);
      add('podL', P.podL, 80); add('podR', P.podR, 80);
      (P.turrets || []).forEach((t, i) => add('turret' + i, t, 36));
      add('core', P.core, 680, { core: true });
      if (P.core && P.core.userData.setOpen) P.core.userData.setOpen(0);
    }
    e.parts = list;
  }
  partByKey(e, key) { return e.parts ? e.parts.find((p) => p.key === key) : null; }

  releaseEnemy(e) {
    if (e.mesh.userData.parts && e.def.boss) {
      const P = e.mesh.userData.parts;
      for (const k of Object.keys(P)) { const o = P[k]; if (Array.isArray(o)) o.forEach((x) => x.userData.setDestroyed && x.userData.setDestroyed(false)); else if (o && o.userData.setDestroyed) o.userData.setDestroyed(false); }
    }
    e.mesh.scale.setScalar(1);
    e.mesh.position.y = 0;
    this.pools[e.type].put(e.o);
  }

  // --- items ---------------------------------------------------------------------
  dropItem(kind, x, z, opts = {}) {
    const o = this.pools['item_' + kind].get();
    const a = rnd(-2.4, -0.7);
    const it = {
      kind, o, mesh: o.mesh, x, z, vx: opts.vx ?? Math.cos(a) * rnd(1.2, 2.4) * (Math.random() < 0.5 ? -1 : 1), vz: opts.vz ?? -rnd(1.5, 3),
      t: 0, color: opts.color || 'red', sub: opts.sub || 'H', life: kind === 'medal' ? 99 : 10, bounce: kind !== 'medal',
    };
    if (kind === 'medal') { it.vx = rnd(-0.6, 0.6); it.vz = -rnd(2.5, 4.5); }
    const ud = it.mesh.userData;
    if (kind === 'P' && ud.setColor) ud.setColor(it.color);
    if (kind === 'S' && ud.setKind) ud.setKind(it.sub);
    it.mesh.position.set(x, 0.2, z);
    this.items.push(it);
    return it;
  }

  // --- main update ---------------------------------------------------------------------
  update(rawDt, input) {
    // slow motion (death / boss kill)
    if (this.slowT > 0) { this.slowT -= rawDt; this.timeScale = lerp(this.timeScale, 0.3, 0.3); }
    else this.timeScale = lerp(this.timeScale, 1, Math.min(1, rawDt * 6));
    const dt = rawDt * this.timeScale;
    this.time += dt;

    this.scrollSpeed = lerp(this.scrollSpeed, this.scrollTarget, Math.min(1, dt * 0.8));
    this.world.update(dt, this.scrollSpeed);
    this.updatePlayer(dt, rawDt, input);
    this.runTimers(dt);
    this.runTimeline();
    this.updatePhase(dt);
    this.fireWeapons(dt);
    this.updateShots(dt);
    this.updateEnemies(dt);
    this.updateBullets(dt);
    this.collide();
    this.updateItems(dt);
    this.updateBomb(dt);
    this.fx.update(dt, this.GROUND_Y, this.scrollSpeed);
    this.checkExtends();
  }
  // Title screen: the jet cruises over the sea.
  updateAttract(dt, t) {
    this.world.update(dt, 5.5);
    const p = this.player;
    p.x = Math.sin(t * 0.45) * 2.4;
    p.z = this.view.zBottom - 9 + Math.sin(t * 0.7) * 0.8;
    const bank = Math.cos(t * 0.45) * 0.45;
    p.bank = lerp(p.bank, bank, 0.1);
    this.syncPlayerMesh(dt, true);
    this.fx.update(dt, this.GROUND_Y, 5.5);
  }

  // Debug: skip timeline events before distance d.
  skipTo(d) { let i = 0; while (i < TIMELINE.length && TIMELINE[i].d < d) i++; this.tlIndex = i; }
  runTimeline() {
    const d = this.world.distance;
    while (this.tlIndex < TIMELINE.length && TIMELINE[this.tlIndex].d <= d) {
      const ev = TIMELINE[this.tlIndex++];
      try { ev.run(this); } catch (err) { console.error('timeline', ev.d, err); }
    }
  }

  updatePhase(dt) {
    const d = this.world.distance;
    if (this.phase === 'midboss' && this.midbossDone) { this.phase = 'stage'; this.scrollTarget = 7; this.onEvent('midbossEnd'); }
    if (this.phase === 'stage' && d >= STAGE_BOSS_AT - 40 && !this.warned) {
      this.warned = true; this.phase = 'warning'; this.warningT = 5.5;
      this.scrollTarget = 3;
      this.onEvent('warning');
    }
    if (this.phase === 'warning') {
      this.warningT -= dt;
      if (this.warningT <= 0) { this.phase = 'boss'; this.scrollTarget = 2.2; this.boss = spawnBoss(this); this.onEvent('bossStart'); }
    }
    if (this.phase === 'bossdead') {
      this.clearT += dt;
      if (this.clearT > 3.2 && !this.clearAnnounced) { this.clearAnnounced = true; this.onEvent('clearBanner'); }
      if (this.clearT > 4.0) {
        const p = this.player; // fly off the top
        p.z -= (6 + (this.clearT - 4) * 30) * dt;
      }
      if (this.clearT > 6.4 && !this.clearDone) { this.clearDone = true; this.phase = 'clear'; this.onEvent('clear'); }
    }
  }

  // --- player ------------------------------------------------------------------------
  updatePlayer(dt, rawDt, input) {
    const p = this.player, v = this.view;
    if (p.invuln > 0) p.invuln -= dt;
    if (!p.alive) {
      p.respawn -= rawDt;
      if (p.respawn <= 0 && this.lives >= 0 && this.phase !== 'clear') this.respawnPlayer();
      input.consumeDrag();
      return;
    }
    const prevX = p.x, prevZ = p.z;
    if (p.entering > 0) {
      p.entering -= dt;
      const tz = v.zBottom - 5;
      p.z = lerp(p.z, tz, Math.min(1, dt * 4));
      input.consumeDrag();
    } else if (this.phase !== 'bossdead' && this.phase !== 'clear') {
      // relative drag: convert pixel delta at the jet's screen position into plane units
      const drag = input.consumeDrag();
      if (drag.x || drag.y) {
        const sens = this.settings.touchSens || 1;
        const s = v.toScreen(p.x, 0, p.z, this.tmpS);
        const a = v.screenToPlane(s.x, s.y, { x: 0, z: 0 });
        const b = v.screenToPlane(s.x + drag.x * sens, s.y + drag.y * sens, { x: 0, z: 0 });
        p.x += b.x - a.x; p.z += b.z - a.z;
      }
      const ax = input.axis();
      const sp = ax.slow ? 6.5 : 13.5;
      p.x += ax.x * sp * dt; p.z += ax.y * sp * dt;
      const zMin = v.zTop + 5, zMax = v.zBottom - 1.3;
      p.z = clamp(p.z, zMin, zMax);
      const hw = v.hw(p.z) - 0.75;
      p.x = clamp(p.x, -hw, hw);
    }
    const vx = (p.x - prevX) / Math.max(dt, 1e-4);
    const vz = (p.z - prevZ) / Math.max(dt, 1e-4);
    p.bank = lerp(p.bank, clamp(vx / 12, -1, 1), Math.min(1, dt * 10));
    p.thrust = lerp(p.thrust, clamp(0.55 - vz / 20, 0.25, 1), Math.min(1, dt * 8));
    this.syncPlayerMesh(dt, false);
  }
  syncPlayerMesh(dt, attract) {
    const p = this.player, m = p.mesh, ud = m.userData;
    m.position.set(p.x, 0.15, p.z);
    m.rotation.set(0, 0, 0);
    if (ud.setBank) ud.setBank(p.bank); else m.rotation.z = -p.bank * 0.6; // +bank = roll right
    if (ud.setThrust) ud.setThrust(attract ? 0.6 : p.thrust);
    if (ud.update) ud.update(dt, this.time);
    const blink = p.invuln > 0 && p.alive && !attract && Math.floor(this.time * 16) % 2 === 0;
    m.visible = p.alive && !blink;
    this.placeShadow(p.shadow, p.x, 0, p.z, 0, p.alive);
  }
  placeShadow(sh, x, y, z, yaw, vis) {
    if (!sh) return;
    const h = y - this.GROUND_Y;
    sh.visible = vis;
    sh.position.set(x + h * 0.467, this.GROUND_Y + 0.06, z - h * 0.333);
    sh.rotation.set(0, yaw, 0);
  }
  respawnPlayer() {
    const p = this.player, v = this.view;
    p.alive = true; p.x = 0; p.z = v.zBottom + 2; p.entering = 1.0; p.invuln = 3.2;
    p.mesh.visible = true;
    this.cancelBullets(0, p.z - 6, 9, false);
    this.onEvent('respawn');
  }
  killPlayer() {
    const p = this.player;
    if (!p.alive || p.invuln > 0 || this.bombT > 0 || this.phase === 'bossdead' || this.phase === 'clear') return;
    p.alive = false;
    p.mesh.visible = false;
    if (p.shadow) p.shadow.visible = false;
    this.stats.deaths++;
    this.fx.explosion(p.x, 0.2, p.z, 2.4, { debris: 20, color: new THREE.Color(0.9, 0.15, 0.18) });
    this.fx.shockwave(p.x, 0.1, p.z, 9, [2.4, 1.2, 1.0, 1], 0.7);
    this.shake.add(0.75);
    this.ui.flash(0.55);
    this.slowT = 0.5;
    this.audio.play('death');
    this.haptic([60, 40, 120]);
    // drop some power so the next life can recover it
    this.dropItem('P', p.x, p.z, { color: p.main });
    if (p.sub) this.dropItem('S', p.x + 0.8, p.z, { sub: p.sub });
    p.level = Math.max(1, p.level - 2);
    if (p.sub) { p.subLevel = Math.max(0, p.subLevel - 1); if (p.subLevel === 0) p.sub = null; }
    this.bombs = Math.max(this.bombs, 3);
    this.lives -= 1;
    p.respawn = 1.4;
    this.medalChain = 0;
    if (this.lives < 0) { p.respawn = 999; this.onEvent('gameover'); }
    else this.onEvent('death');
  }
  continueRun() {
    this.score = 0; this.credits += 1; this.lives = 2; this.bombs = 3;
    this.extendIdx = 0;
    this.player.respawn = 0.3;
  }

  // --- weapons ---------------------------------------------------------------------
  fireWeapons(dt) {
    const p = this.player;
    if (!p.alive || p.entering > 0.3 || this.phase === 'bossdead' || this.phase === 'clear') return;
    const ps = this.ps;
    const add = (x, z, vx, vz, dmg, kind, r, w = 1) => {
      if (ps.n >= ps.max) return -1;
      const i = ps.n++;
      ps.x[i] = x; ps.z[i] = z; ps.vx[i] = vx; ps.vz[i] = vz; ps.dmg[i] = dmg; ps.kind[i] = kind; ps.r[i] = r; ps.t[i] = 0; ps.w[i] = w;
      ps.target[i] = null; ps.trail[i] = 0;
      return i;
    };
    if (p.main === 'red') {
      p.fireT -= dt;
      if (p.fireT < -0.2) p.fireT = 0;
      let fired = false;
      while (p.fireT <= 0) {
        const age = -p.fireT;
        p.fireT += 0.075;
        const pat = VULCAN[p.level];
        const S = 36;
        for (const [ox, ad] of pat) {
          const a = ad * DEG, vx = Math.sin(a) * S, vz = -Math.cos(a) * S;
          add(p.x + ox + vx * age, p.z - 0.9 + vz * age, vx, vz, 1.0, SK.VULCAN, 0.42);
        }
        fired = true;
      }
      if (fired) {
        this.fx.muzzle(p.x, p.z - 1.0, 2.0, 1.0, 0.3, 0.5 + p.level * 0.04);
        this.audio.play('shot');
      }
    } else {
      p.laserT -= dt;
      if (p.laserT < -0.2) p.laserT = 0;
      while (p.laserT <= 0) {
        const age = -p.laserT;
        p.laserT += 0.034;
        const lv = p.level;
        const i = add(p.x, p.z - 1.0 - 44 * age, 0, -44, 0.55 + lv * 0.2, SK.LASER, 0.28 + lv * 0.075, 0.34 + lv * 0.11);
        if (i >= 0) ps.t[i] = age;
      }
      this.audio.play('laser');
    }
    if (p.sub) {
      p.subT -= dt;
      if (p.subT <= 0) {
        const lv = p.subLevel;
        if (p.sub === 'H') {
          p.subT = 0.62 - lv * 0.07;
          const n = lv >= 3 ? 4 : 2;
          for (let i = 0; i < n; i++) {
            const side = i % 2 ? 1 : -1, outer = i >= 2 ? 1.6 : 1;
            add(p.x + side * 0.5 * outer, p.z - 0.2, side * 7 * outer, 2, 2.6, SK.HOMING, 0.45);
          }
        } else {
          p.subT = 0.56 - lv * 0.05;
          const n = lv >= 3 ? 4 : 2;
          for (let i = 0; i < n; i++) {
            const side = i % 2 ? 1 : -1, outer = i >= 2 ? 1.9 : 1;
            add(p.x + side * 0.55 * outer, p.z - 0.3, 0, -8, 5.2, SK.NUKE, 0.45);
          }
        }
        this.audio.play('missile', { vol: 0.6 });
      }
    }
  }
  updateShots(dt) {
    const ps = this.ps, v = this.view, p = this.player;
    let i = 0;
    while (i < ps.n) {
      ps.t[i] += dt;
      const k = ps.kind[i];
      if (k === SK.LASER) {
        // the beam whips after the jet: young segments follow its x
        const f = Math.max(0, 1 - ps.t[i] * 2.4);
        if (p.alive) ps.x[i] += (p.x - ps.x[i]) * Math.min(1, dt * 16) * f;
      } else if (k === SK.HOMING) {
        let tg = ps.target[i];
        if (!tg || !tg.alive || (tg.part && tg.part.dead)) { tg = this.findTarget(ps.x[i], ps.z[i]); ps.target[i] = tg; }
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
        if (ps.trail[i] <= 0) { ps.trail[i] = 0.022; this.fx.missileTrail(ps.x[i], ps.z[i], 0.6, 1.8, 0.5); }
      } else if (k === SK.NUKE) {
        ps.vz[i] = Math.max(-30, ps.vz[i] - 60 * dt);
        ps.trail[i] -= dt;
        if (ps.trail[i] <= 0) { ps.trail[i] = 0.022; this.fx.missileTrail(ps.x[i], ps.z[i] + 0.3, 1.4, 0.6, 2.2); }
      }
      ps.x[i] += ps.vx[i] * dt; ps.z[i] += ps.vz[i] * dt;
      const life = k === SK.HOMING ? 2.6 : 1.4;
      if (ps.t[i] > life || ps.z[i] < v.zTop - 3 || ps.z[i] > v.zBottom + 3 || Math.abs(ps.x[i]) > v.hw(ps.z[i]) + 3) { this.removeShot(i); continue; }
      i++;
    }
  }
  removeShot(i) {
    const ps = this.ps, j = --ps.n;
    if (i === j) { ps.target[j] = null; return; }
    ps.x[i] = ps.x[j]; ps.z[i] = ps.z[j]; ps.vx[i] = ps.vx[j]; ps.vz[i] = ps.vz[j]; ps.dmg[i] = ps.dmg[j];
    ps.r[i] = ps.r[j]; ps.t[i] = ps.t[j]; ps.kind[i] = ps.kind[j]; ps.w[i] = ps.w[j]; ps.target[i] = ps.target[j]; ps.trail[i] = ps.trail[j];
    ps.target[j] = null;
  }
  findTarget(x, z) {
    let best = null, bd = 1e9;
    for (let i = 0; i < this.nTargets; i++) {
      const t = this.targets[i];
      if (t.armored) continue;
      const dx = t.x - x, dz = t.z - z;
      const d = dx * dx + dz * dz + (dz > 0 ? 40 : 0); // prefer things ahead
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return null;
    // store a lightweight handle that tracks the enemy/part
    return best.part ? { part: best.part, get alive() { return !this.part.dead; }, get x() { return this.part.x; }, get z() { return this.part.z; } }
      : best.e;
  }

  // --- bombs --------------------------------------------------------------------
  useBomb() {
    const p = this.player;
    if (this.bombs <= 0 || !p.alive || p.entering > 0.2 || this.bombT > 0 || this.phase === 'bossdead' || this.phase === 'clear') return false;
    this.bombs--;
    this.stats.bombsUsed++;
    this.bombT = 2.4; this.bombWave = 0;
    p.invuln = Math.max(p.invuln, 3.0);
    this.ui.flash(0.9);
    this.shake.add(0.9);
    this.audio.play('bomb');
    this.haptic([40, 30, 80]);
    this.fx.shockwave(p.x, 0.1, p.z - 6, 40, [3, 2.2, 1.4, 1], 0.9);
    this.fx.shockwave(p.x, 0.1, p.z - 6, 26, [2.4, 1.2, 0.6, 1], 0.7);
    this.bombHit(30);
    return true;
  }
  bombHit(amount) {
    const v = this.view;
    for (const e of this.enemies) {
      if (!e.alive || !v.onScreen(e.x, e.z, 1)) continue;
      if (e.parts && e.parts.length) {
        const mul = e.def.boss ? 0.45 : 1;
        for (const pt of e.parts) if (!pt.dead && !(pt.core && e.armored)) this.damagePart(e, pt, amount * mul, true);
        if (!e.def.boss) this.damageEnemy(e, amount, true);
      } else this.damageEnemy(e, amount, true);
    }
  }
  updateBomb(dt) {
    if (this.bombT <= 0) return;
    this.bombT -= dt;
    this.bombWave -= dt;
    this.cancelBullets(0, 0, 999, true);
    if (this.bombWave <= 0) {
      this.bombWave = 0.11;
      const v = this.view;
      const z = rnd(v.zTop + 3, v.zBottom - 3), x = rnd(-v.hw(z), v.hw(z));
      this.fx.explosion(x, 0.3, z, rnd(1.6, 2.6));
      this.shake.add(0.12);
    }
    this.bombHit(40 * dt);
  }
  cancelBullets(x, z, radius, score) {
    const b = this.eb;
    let i = 0;
    const r2 = radius * radius;
    while (i < b.n) {
      const dx = b.x[i] - x, dz = b.z[i] - z;
      if (dx * dx + dz * dz < r2) {
        if (score) { this.addScore(10); if (Math.random() < 0.5) this.fx.sparkle(b.x[i], b.z[i], 2.2, 2.0, 1.0, 0.5, 0.3); }
        this.removeBullet(i);
        continue;
      }
      i++;
    }
  }

  // --- enemies ---------------------------------------------------------------------
  updateEnemies(dt) {
    const v = this.view;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive) { this.enemies.splice(i, 1); this.releaseEnemy(e); continue; }
      e.t += dt;
      const px = e.x, pz = e.z;
      try { e.ai(e, dt, this); } catch (err) { console.error('ai', e.type, err); e.alive = false; continue; }
      if (e.ground) this.syncGround(e);
      if (!e.entered && v.onScreen(e.x, e.z, -0.5)) e.entered = true;
      e.vx = (e.x - px) / Math.max(dt, 1e-4); e.vz = (e.z - pz) / Math.max(dt, 1e-4);
      // despawn when well off-screen (after having entered, or if it is far outside)
      const off = e.z > v.zBottom + 4 || (e.entered && !v.onScreen(e.x, e.z, 5)) || e.z < v.zTop - 40 || Math.abs(e.x) > 40;
      if (off && !e.def.boss && e.type !== 'crawler' && e.t > 1) {
        if (e.type === 'carrier' && e.drops) { /* item escaped */ }
        e.alive = false; this.enemies.splice(i, 1); this.releaseEnemy(e); continue;
      }
      if (e.flash > 0) { e.flash = Math.max(0, e.flash - dt * 9); const ud = e.mesh.userData; if (ud.setFlash) ud.setFlash(e.flash); }
      if (e.parts) for (const pt of e.parts) if (pt.flash > 0) { pt.flash = Math.max(0, pt.flash - dt * 9); const u = pt.obj.userData; if (u.setFlash) u.setFlash(pt.flash); }
      this.syncEnemyMesh(e, dt);
    }
  }
  syncEnemyMesh(e, dt) {
    const m = e.mesh;
    if (e.ground) {
      m.position.set(e.gx, this.GROUND_Y + (e.s.y || 0), e.gz);
      m.rotation.set(0, e.yaw, 0);
    } else {
      // face the direction of travel; bank into turns
      if (!e.s.fixedYaw) {
        const sp = Math.hypot(e.vx, e.vz);
        if (sp > 0.5) {
          const want = Math.atan2(-e.vx, -e.vz);
          let d = want - e.yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          e.yaw += d * Math.min(1, dt * 7);
          e.roll = lerp(e.roll, clamp(-d * 1.4, -0.8, 0.8), Math.min(1, dt * 6));
        }
      } else if (e.s.yaw !== undefined) e.yaw = e.s.yaw;
      m.position.set(e.x, e.s.y || 0, e.z);
      m.rotation.set(e.s.pitch || 0, e.yaw, e.roll);
      this.placeShadow(e.shadow, e.x, e.s.y || 0, e.z, e.yaw, true);
    }
    const ud = m.userData;
    if (ud.update) ud.update(dt, this.time);
  }
  // Aim a model's turret (ground units) at the player.
  aimTurret(e, turret, dt, rate = 5) {
    if (!turret) return;
    const want = Math.atan2(-(this.player.x - e.x), -(this.player.z - e.z)) - e.yaw;
    let d = want - turret.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    turret.rotation.y += clamp(d, -rate * dt, rate * dt);
  }
  // World-space muzzle → plane coordinates.
  muzzlePos(obj, idx = 0) {
    const mz = obj.userData.muzzles;
    const lp = mz && mz.length ? mz[idx % mz.length] : null;
    obj.updateWorldMatrix(true, false);
    this.tmpV.set(lp ? lp.x : 0, lp ? lp.y : 0, lp ? lp.z : 0).applyMatrix4(obj.matrixWorld);
    return this.view.toPlane(this.tmpV, this.tmpA);
  }

  damageEnemy(e, dmg, fromBomb = false) {
    if (!e.alive || e.invuln) return;
    e.hp -= dmg;
    e.flash = e.maxHp > 60 ? 0.55 : 1; // big units: softer flash so rapid fire doesn't strobe
    if (e.hp <= 0) this.killEnemy(e, fromBomb);
  }
  damagePart(e, pt, dmg, fromBomb = false) {
    if (pt.dead || !e.alive) return;
    pt.hp -= dmg;
    pt.flash = 0.45;
    if (pt.hp <= 0) {
      pt.dead = true;
      const u = pt.obj.userData;
      if (u.setDestroyed) u.setDestroyed(true);
      if (u.setFlash) u.setFlash(0);
      const big = pt.core ? 3 : pt.key.startsWith('wing') ? 2 : 1.3;
      this.fx.explosion(pt.x, 0.4, pt.z, big, { debris: 10, color: e.mesh.userData.debrisColor || new THREE.Color(0.4, 0.4, 0.45) });
      this.shake.add(0.35);
      this.audio.play(big >= 2 ? 'explodeL' : 'explodeM');
      const pts = pt.core ? 100000 : pt.key.startsWith('wing') ? 8000 : pt.key.startsWith('pod') ? 5000 : 3000;
      this.addScore(pts);
      this.popupAt(pt.x, pt.z, pts.toLocaleString('en-US'), 'big');
      for (let i = 0; i < (pt.key.startsWith('wing') ? 3 : 1); i++) this.dropItem('medal', pt.x + rnd(-1, 1), pt.z + rnd(-1, 1));
      if (e.onPartDestroyed) e.onPartDestroyed(e, pt, this);
      if (pt.core) this.killEnemy(e, fromBomb);
    }
  }
  killEnemy(e, fromBomb) {
    if (!e.alive || e.dying) return;
    const def = e.def;
    if (def.boss || e.type === 'crawler') { e.dying = true; if (e.onDeath) e.onDeath(e, this); return; }
    e.alive = false;
    if (!e.noCount) this.stats.killed++;
    const pts = def.score;
    this.addScore(pts);
    if (pts >= 1000) this.popupAt(e.x, e.z, pts.toLocaleString('en-US'), pts >= 5000 ? 'big' : '');
    const size = def.explode;
    const col = e.mesh.userData.debrisColor || new THREE.Color(0.35, 0.36, 0.4);
    if (e.ground) {
      this.fx.explosion(e.gx, this.GROUND_Y + 0.4, e.gz, size, { ground: true, debris: def.debris, color: col });
      if (e.sinks) this.fx.splash(e.gx, this.GROUND_Y, e.gz, 2.4);
    } else {
      this.fx.explosion(e.x, 0.1, e.z, size, { debris: def.debris, color: col });
    }
    this.shake.add(size >= 2 ? 0.45 : size >= 1.3 ? 0.18 : 0.06);
    this.audio.play(size >= 2 ? 'explodeL' : size >= 1.2 ? 'explodeM' : 'explodeS', { pan: clamp(e.x / 10, -1, 1) });
    // drops
    if (e.drops) for (const d of e.drops) this.dropItem(d, e.x, e.z, { color: Math.random() < 0.5 ? 'red' : 'blue' });
    const medals = typeof def.medal === 'number' ? (def.medal >= 1 ? def.medal : (Math.random() < def.medal ? 1 : 0)) : 0;
    for (let i = 0; i < medals; i++) this.dropItem('medal', e.x + rnd(-0.6, 0.6), e.z + rnd(-0.4, 0.4));
    if (def.boss !== true && size >= 2) this.ui.flash(0.12);
  }

  // --- enemy bullets ---------------------------------------------------------------------
  updateBullets(dt) {
    const b = this.eb, v = this.view, p = this.player;
    let i = 0;
    while (i < b.n) {
      b.t[i] += dt;
      if (b.home[i] > 0 && p.alive) {
        b.home[i] -= dt;
        const sp = Math.hypot(b.vx[i], b.vz[i]);
        let ang = Math.atan2(b.vx[i], b.vz[i]);
        let d = Math.atan2(p.x - b.x[i], p.z - b.z[i]) - ang;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        ang += clamp(d, -1.6 * dt, 1.6 * dt);
        b.vx[i] = Math.sin(ang) * sp; b.vz[i] = Math.cos(ang) * sp;
      }
      b.vx[i] += b.ax[i] * dt; b.vz[i] += b.az[i] * dt;
      b.x[i] += b.vx[i] * dt; b.z[i] += b.vz[i] * dt;
      if (b.z[i] > v.zBottom + 1.5 || b.z[i] < v.zTop - 6 || Math.abs(b.x[i]) > v.hw(b.z[i]) + 1.5) { this.removeBullet(i); continue; }
      i++;
    }
  }
  removeBullet(i) {
    const b = this.eb, j = --b.n;
    if (i === j) return;
    b.x[i] = b.x[j]; b.z[i] = b.z[j]; b.vx[i] = b.vx[j]; b.vz[i] = b.vz[j]; b.ax[i] = b.ax[j]; b.az[i] = b.az[j];
    b.t[i] = b.t[j]; b.kind[i] = b.kind[j]; b.grazed[i] = b.grazed[j]; b.home[i] = b.home[j];
  }

  // --- collisions ------------------------------------------------------------------------
  buildTargets() {
    let n = 0;
    const v = this.view;
    for (const e of this.enemies) {
      if (!e.alive || e.dying) continue;
      if (!v.onScreen(e.x, e.z, 0.5)) continue;
      if (e.parts && e.parts.length) {
        for (const pt of e.parts) {
          if (pt.dead) continue;
          pt.obj.updateWorldMatrix(true, false);
          this.tmpV.setFromMatrixPosition(pt.obj.matrixWorld);
          const q = v.toPlane(this.tmpV, this.tmpA);
          pt.x = q.x; pt.z = q.z;
          if (n >= this.targets.length) break;
          const t = this.targets[n++];
          t.x = q.x; t.z = q.z; t.r = pt.r * q.s; t.e = e; t.part = pt; t.armored = !!(pt.core && e.armored) || !!e.invuln;
        }
        if (e.def.boss) continue; // boss hull itself isn't a target
      }
      if (n >= this.targets.length) break;
      const t = this.targets[n++];
      t.x = e.x; t.z = e.z; t.r = e.r * (e.ground ? this.view.k : 1); t.e = e; t.part = null; t.armored = !!e.invuln;
    }
    this.nTargets = n;
  }
  collide() {
    this.buildTargets();
    const ps = this.ps, T = this.targets;
    // player shots vs enemies
    let i = 0;
    while (i < ps.n) {
      const x = ps.x[i], z = ps.z[i], r = ps.r[i];
      let hit = null;
      for (let k = 0; k < this.nTargets; k++) {
        const t = T[k];
        const rr = t.r + r;
        const dx = t.x - x, dz = t.z - z;
        if (dx * dx + dz * dz < rr * rr) { hit = t; break; }
      }
      if (!hit && this.boss && this.boss.alive && !this.boss.dying && this.boss.s.mode !== 'enter') {
        const bz = this.boss.z, bx = this.boss.x;
        if (Math.abs(x - bx) < 6.3 && z < bz - 1.6 && z > bz - 3.8) hit = this.hullTarget;
      }
      if (hit) {
        const kind = ps.kind[i];
        if (hit.armored) {
          this.fx.armorSpark(x, 0.1, z);
          this.audio.play('hitArmor', { vol: 0.5 });
        } else {
          const dmg = ps.dmg[i];
          if (hit.part) this.damagePart(hit.e, hit.part, dmg); else this.damageEnemy(hit.e, dmg);
          if (kind === SK.NUKE) {
            this.fx.explosion(x, 0.2, z, 0.7);
            for (let k = 0; k < this.nTargets; k++) {
              const t = T[k];
              if (t === hit || t.armored) continue;
              const dx = t.x - x, dz = t.z - z;
              if (dx * dx + dz * dz < 2.6) { if (t.part) this.damagePart(t.e, t.part, 2.5); else this.damageEnemy(t.e, 2.5); }
            }
          } else if (kind === SK.LASER) this.fx.hitSpark(x, 0.1, z - 0.2, 0.4, 0.9, 1.0, 1);
          else this.fx.hitSpark(x, 0.1, z, 1.0, 0.75, 0.35, kind === SK.VULCAN ? 1 : 3);
          this.audio.play('hit', { vol: 0.35 });
        }
        this.removeShot(i);
        continue;
      }
      i++;
    }
    // enemy bullets vs player (+ graze)
    const p = this.player;
    if (!p.alive || p.entering > 0) return;
    const b = this.eb;
    const hitR = 0.3, grazeR = 1.05;
    for (let j = 0; j < b.n; j++) {
      const dx = b.x[j] - p.x, dz = b.z[j] - p.z;
      const d2 = dx * dx + dz * dz;
      const br = B_RADIUS[b.kind[j]];
      if (d2 < (hitR + br) * (hitR + br)) {
        if (p.invuln > 0 || this.bombT > 0) continue;
        this.removeBullet(j);
        this.killPlayer();
        return;
      }
      if (!b.grazed[j] && d2 < (grazeR + br) * (grazeR + br)) {
        b.grazed[j] = 1;
        this.stats.grazes++;
        this.addScore(10);
        this.fx.sparkle(b.x[j] * 0.5 + p.x * 0.5, b.z[j] * 0.5 + p.z * 0.5, 2.2, 2.2, 2.6, 0.45, 0.2);
        this.audio.play('graze', { vol: 0.4 });
      }
    }
    // air enemy bodies vs player
    if (p.invuln > 0 || this.bombT > 0) return;
    for (const e of this.enemies) {
      if (!e.alive || e.ground || e.dying || !e.entered) continue;
      const rr = e.r * 0.7 + hitR;
      if (e.def.boss) continue; // boss hull too complex; its bullets are the threat
      const dx = e.x - p.x, dz = e.z - p.z;
      if (dx * dx + dz * dz < rr * rr) { this.killPlayer(); return; }
    }
  }

  // --- items ---------------------------------------------------------------------------
  updateItems(dt) {
    const v = this.view, p = this.player;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      if (it.kind === 'medal') {
        it.vz = Math.min(it.vz + 7 * dt, this.scrollSpeed * v.k * 0.9);
        it.vx *= 1 - dt;
      } else {
        // float and bounce inside the screen, then drift away
        if (it.t > 0.6 && it.bounce && it.t < it.life) {
          const hw = v.hw(it.z) - 0.8;
          if ((it.x < -hw && it.vx < 0) || (it.x > hw && it.vx > 0)) it.vx = -it.vx;
          if (it.z < v.zTop + 1.5 && it.vz < 0) it.vz = -it.vz;
          if (it.z > v.zBottom - 2 && it.vz > 0) it.vz = -it.vz;
        }
        if (it.t > it.life) it.vz += 3 * dt;
        if (it.t < 0.6) it.vz += 5 * dt;
      }
      it.x += it.vx * dt; it.z += it.vz * dt;
      if (it.kind === 'P') {
        const c = Math.floor(it.t / 2.2) % 2 === 0 ? it.color : (it.color === 'red' ? 'blue' : 'red');
        if (c !== it.cur) { it.cur = c; const ud = it.mesh.userData; if (ud.setColor) ud.setColor(c); }
      } else if (it.kind === 'S') {
        const c = Math.floor(it.t / 2.6) % 2 === 0 ? it.sub : (it.sub === 'H' ? 'N' : 'H');
        if (c !== it.cur) { it.cur = c; const ud = it.mesh.userData; if (ud.setKind) ud.setKind(c); }
      }
      // magnet when close
      let collected = false;
      if (p.alive) {
        const dx = p.x - it.x, dz = p.z - it.z, d2 = dx * dx + dz * dz;
        if (d2 < 1.3 * 1.3) collected = true;
        else if (d2 < 9 && it.kind === 'medal') { const d = Math.sqrt(d2); it.x += dx / d * 9 * dt; it.z += dz / d * 9 * dt; }
      }
      if (collected) { this.collect(it); this.items.splice(i, 1); this.pools['item_' + it.kind].put(it.o); continue; }
      if (it.z > v.zBottom + 2 || it.z < v.zTop - 8) {
        if (it.kind === 'medal' && it.z > 0) this.medalChain = 0;
        this.items.splice(i, 1); this.pools['item_' + it.kind].put(it.o); continue;
      }
      it.mesh.position.set(it.x, 0.2 + Math.sin(it.t * 4) * 0.08, it.z);
      const ud = it.mesh.userData;
      if (ud.update) ud.update(dt, this.time);
    }
  }
  collect(it) {
    const p = this.player;
    const k = it.kind;
    if (k === 'P') {
      const c = it.cur || it.color;
      if (c === p.main) {
        if (p.level < 8) { p.level++; this.audio.play('powerup'); this.popupAt(it.x, it.z, p.level === 8 ? 'MAX POWER' : 'POWER UP', 'big'); }
        else { this.addScore(5000); this.popupAt(it.x, it.z, '5,000', 'big'); this.audio.play('item'); }
      } else {
        p.main = c; p.level = Math.min(8, p.level + 1); p.fireT = 0; p.laserT = 0;
        this.audio.play('powerup');
        this.popupAt(it.x, it.z, c === 'red' ? 'VULCAN' : 'LASER', 'big');
      }
    } else if (k === 'S') {
      const c = it.cur || it.sub;
      if (c === p.sub) {
        if (p.subLevel < 4) { p.subLevel++; this.audio.play('powerup'); this.popupAt(it.x, it.z, c === 'H' ? 'HOMING UP' : 'NUKE UP', 'big'); }
        else { this.addScore(5000); this.popupAt(it.x, it.z, '5,000', 'big'); this.audio.play('item'); }
      } else {
        p.sub = c; p.subLevel = Math.max(1, Math.min(4, p.subLevel + 1)); p.subT = 0;
        this.audio.play('powerup');
        this.popupAt(it.x, it.z, c === 'H' ? 'HOMING' : 'NUKE', 'big');
      }
    } else if (k === 'B') {
      if (this.bombs < 5) { this.bombs++; this.popupAt(it.x, it.z, 'BOMB', 'big'); }
      else { this.addScore(5000); this.popupAt(it.x, it.z, '5,000', 'big'); }
      this.audio.play('item');
    } else if (k === 'medal') {
      const val = MEDAL_VALUES[Math.min(this.medalChain, MEDAL_VALUES.length - 1)];
      this.addScore(val);
      this.audio.play('medal', { pitch: Math.min(this.medalChain, 6) * 2 });
      this.popupAt(it.x, it.z, val.toLocaleString('en-US'), 'medal');
      this.medalChain++;
      this.stats.medals++;
      this.medalMaxChain = Math.max(this.medalMaxChain, this.medalChain);
    } else if (k === '1UP') {
      this.lives++;
      this.audio.play('oneup');
      this.popupAt(it.x, it.z, '1UP', 'big');
    }
    this.fx.sparkle(it.x, it.z, 2.5, 2.2, 1.4, 1.4, 0.35);
    this.haptic(12);
  }

  // --- scoring -------------------------------------------------------------------
  addScore(n) { this.score += n; }
  checkExtends() {
    if (this.extendIdx < EXTENDS.length && this.score >= EXTENDS[this.extendIdx]) {
      this.extendIdx++;
      this.lives++;
      this.audio.play('oneup');
      this.onEvent('extend');
    }
  }
  popupAt(x, z, text, cls) {
    const s = this.view.toScreen(x, 0, z, this.tmpS);
    this.ui.popup(text, s.x, s.y, cls);
  }
  haptic(pattern) {
    if (!this.settings.haptics) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* ignore */ }
  }

  // --- rendering of bullets/shots (called every frame after update) --------------------------
  draw() {
    const fx = this.fx, ps = this.ps, b = this.eb, t = this.time;
    // player shots
    for (let i = 0; i < ps.n; i++) {
      const k = ps.kind[i], x = ps.x[i], z = ps.z[i];
      if (k === SK.VULCAN) {
        const rot = flatRot(ps.vx[i], ps.vz[i]);
        fx.bullets.push(x, 0.1, z, 0.36, 1.25, rot, F.STREAK, 1, 2.8, 0.9, 0.2, 0.9, 0.3);
      } else if (k === SK.LASER) {
        const w = ps.w[i];
        const fade = Math.min(1, ps.t[i] * 20);
        fx.bullets.push(x, 0.1, z, w * 1.35, 1.9, 0, F.STREAK, 1, 0.35 * fade, 1.35 * fade, 3.0 * fade, 1);
      } else if (k === SK.HOMING) {
        fx.bullets.push(x, 0.1, z, 0.34, 0.9, flatRot(ps.vx[i], ps.vz[i]), F.STREAK, 1, 1.2, 3.0, 0.8, 1, 0.6);
        fx.bullets.push(x, 0.1, z, 0.7, 0.7, 0, F.GLOW, 0, 0.5, 1.6, 0.4, 0.8);
      } else {
        fx.bullets.push(x, 0.1, z, 0.36, 1.0, 0, F.STREAK, 1, 1.8, 0.8, 2.6, 1, 0.6);
        fx.bullets.push(x, 0.1, z, 0.6, 0.6, 0, F.GLOW, 0, 0.9, 0.35, 1.5, 0.45);
      }
    }
    // laser root glow
    const p = this.player;
    if (p.alive && p.main === 'blue' && p.entering <= 0.3 && this.phase !== 'bossdead' && this.phase !== 'clear') {
      const w = 0.9 + p.level * 0.14 + Math.sin(t * 40) * 0.1;
      fx.bullets.push(p.x, 0.1, p.z - 1.05, w, w, t * 3, F.FLARE, 0, 0.5, 1.8, 3.2, 1);
    }
    // enemy bullets with a dark underlay so they read on any terrain
    for (let i = 0; i < b.n; i++) {
      const k = b.kind[i], x = b.x[i], z = b.z[i];
      const birth = Math.min(1, b.t[i] * 12);
      const c = B_COLOR[k];
      if (k === BK.NEEDLE) {
        const rot = flatRot(b.vx[i], b.vz[i]);
        fx.underlay.push(x, 0.05, z, 0.55, 1.3, rot, F.GLOW, 1, 0.05, 0.0, 0.06, 0.7);
        fx.bullets.push(x, 0.1, z, 0.42 * birth, 1.15 * birth, rot, F.STREAK, 1, c[0], c[1], c[2], 1);
      } else {
        const s = B_SIZE[k] * (0.4 + 0.6 * birth) * (k === BK.MINE ? 1 + Math.sin(t * 14 + i) * 0.12 : 1);
        fx.underlay.push(x, 0.05, z, s * 1.45, s * 1.45, 0, F.GLOW, 0, 0.06, 0.0, 0.07, 0.75);
        fx.bullets.push(x, 0.1, z, s, s, 0, F.ORB, 0, c[0], c[1], c[2], 1);
      }
    }
    // hitbox core: always visible while alive
    if (p.alive && this.phase !== 'clear') {
      const pulse = 0.5 + Math.sin(t * 10) * 0.08;
      fx.bullets.push(p.x, 0.2, p.z, pulse, pulse, 0, F.ORB, 0, 2.6, 1.8, 2.2, p.invuln > 0 ? 0.5 : 0.9);
    }
    // engine trail
    if (p.alive && p.mesh.visible && Math.random() < 0.7) fx.trail(p.x + rnd(-0.18, 0.18), 0.05, p.z + 0.95, 2.6, 1.1, 0.35, 0.45, 0.22, 0.2);
  }
}

export { BK, SK };
