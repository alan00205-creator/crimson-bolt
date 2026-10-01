// game.js — gameplay runtime: player aircraft and option drones, enemies, bullets, items,
// collisions, scoring and the stage phases. Stage timelines, enemy definitions and behaviours live
// in stage.js / stage2.js … stage8.js (assembled by stages.js); the player's weapons and shot kinds
// in weapons.js; menus and flow in main.js; shared data (aircraft, weapons, money) in defs.js.
import * as THREE from 'three';
import { F, flatRot } from './fx.js';
import { ENEMY, STAGES } from './stages.js';
import * as WP from './weapons.js';
import {
  AIRCRAFT, AIRCRAFT_BY_ID, DEFAULT_AIRCRAFT, MONEY, MAIN_WEAPONS, MAIN_ORDER, SUB_WEAPONS, SUB_ORDER, MAX_LEVEL, MAX_SUB_LEVEL,
  DEFAULT_PAINT, paintOf, UPGRADES, UPGRADE_BY_ID, STAGE_LEVEL,
} from './defs.js';

const DEG = Math.PI / 180;
const TILT = 20 * DEG;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);
const r9 = (v) => Math.round(v * 1e9) / 1e9; // canonical doubles: 1 + 0.3 * 1 === 1.3 exactly
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

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
    this.setBottomReserve(this.bottomPx || 60);
  }
  // Keep the jet above the bottom HUD / thumb zone: bottomPx is the reserved strip in CSS px.
  setBottomReserve(bottomPx) {
    const q = this.screenToPlane(this.w / 2, Math.max(this.h * 0.5, this.h - bottomPx), { x: 0, z: 0 });
    this.zPlayerMax = Math.min(this.zBottom - 1.3, q.z);
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

export const MEDAL_VALUES = [500, 1000, 2000, 4000, 6000, 8000, 10000];
const EXTENDS = [300000, 1000000];

// Enemy bullet kinds
const BK = { ORB: 0, BIG: 1, NEEDLE: 2, MINE: 3 };
const B_RADIUS = [0.2, 0.36, 0.17, 0.4];
const B_SIZE = [0.66, 1.08, 0.34, 1.2];
const B_COLOR = [[1.5, 0.16, 0.75], [1.8, 0.42, 0.03], [1.3, 0.2, 1.4], [1.8, 0.25, 0.06]]; // saturated, lightly HDR

const SK = WP.SK; // player shot kinds live with the weapons
const HIT_R0 = 0.3; // the hitbox dot is drawn for this radius (bolt); other aircraft scale it
const TRAIL_COL = [2.6, 1.1, 0.35]; // engine exhaust sprite colour when the model has no userData.trailColor
// shield upgrade: the charge's bubble (ring radius around the jet, HDR colour) and what a break does
const SHIELD_R = 1.2, SHIELD_COL = [0.36, 0.95, 1.35];
const SHIELD_INVULN = 1.5, SHIELD_CLEAR_R = 3.6;
// score popups (popupAt): how far below the HUD's lowest row a popup's anchor must sit (CSS px:
// ui.popup's 26 px rise + half a 17 px line + a 2 px gap), and the row step of popups held there
const POP_CLEAR = 38, POP_STEP = 24;
// debris fallbacks for models without userData.debrisColor
const DEATH_DEBRIS = new THREE.Color(0.9, 0.15, 0.18);
const PART_DEBRIS = new THREE.Color(0.4, 0.4, 0.45);
const ENEMY_DEBRIS = new THREE.Color(0.35, 0.36, 0.4);

// Pool factories log a failed model build and stand in an empty group, so one broken model can't
// take the game down.
const safeMake = (fn) => () => { try { return fn(); } catch (e) { console.error(e); return new THREE.Group(); } };
// Pool keys of an aircraft's jet / drones in a paint scheme (the factory scheme keeps the plain key).
const playerKey = (id, paint) => (paint === DEFAULT_PAINT ? 'player:' + id : 'player:' + id + ':' + paint);
const optionKey = (id, paint) => (paint === DEFAULT_PAINT ? 'option:' + id : 'option:' + id + ':' + paint);
const warned = new Set();

export class Game {
  constructor(ctx) {
    Object.assign(this, ctx); // scene, world, fx, audio, ui, models, view, shake, settings, GROUND_Y, LANES_X
    this.time = 0;
    this.loop = 1;
    this.stageIdx = 0; this.stage = STAGES[0];
    this.diff = { bs: 1, fr: 1, hp: 1, level: 0, part: 1 };
    this.score = 0; this.runMoney = 0; this.continues = 0;
    this.uidN = 0; // enemy / part uids (pierce hit lists)
    // aircraft (setAircraft): stats, gun line and exhaust points of the current mesh
    this.ac = AIRCRAFT_BY_ID[DEFAULT_AIRCRAFT]; this.paint = DEFAULT_PAINT;
    this.playerO = null; this.playerKey = null; this.optKey = null;
    this.muzzleZ = -1.0; this.trail = [[0, 0.95]]; this.trailJ = 0.18; this.hitK = 1; this.trailCol = TRAIL_COL;
    // option drones: [{ o, mesh, shadow, x, z, bank, side, row, muzzleZ, trail }]
    this.options = []; this.optLive = false; this.optSpread = 1; this.optCol = [1, 1, 1];
    // permanent upgrades (setUpgrades): the levels set and the levels in force since the last
    // stage start / continue (applyUpgrades), with their derived factors
    this.upgrades = {}; this.up = {};
    for (const u of UPGRADES) { this.upgrades[u.id] = 0; this.up[u.id] = 0; }
    this.moneyMul = 1; this.magnetK = 1; this.pickR2 = 1.3 * 1.3; this.magnetR2 = 9;
    this.shield = false; // a shield charge is ready (HUD hook)
    this.enemies = [];
    this.items = [];
    this.pools = {};
    this.tmpA = { x: 0, z: 0, s: 1 };
    this.tmpV = new THREE.Vector3();
    this.tmpS = { x: 0, y: 0 };
    this.hudRows = { w: 0, h: 0, strip: -1, bar: -1 };   // hudFloor's DOM reads, per view size
    this.popLow = { t: -9, x: 0, n: 0 };                // the last popup held under the HUD (popupAt)
    this.targets = [];
    for (let i = 0; i < 64; i++) this.targets.push({ x: 0, z: 0, r: 0, e: null, part: null, armored: false, uid: 0 });
    this.nTargets = 0;
    this.hullTarget = { x: 0, z: 0, r: 0, e: null, part: null, armored: true, uid: 0 };
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
      pierce: new Uint8Array(PS), hits: new Int32Array(PS * 4), aux: new Float32Array(PS), // generic (see weapons.js)
    };
    this.player = {
      x: 0, z: 5, alive: true, mesh: null, shadow: null, invuln: 0, respawn: 0, bank: 0, thrust: 0.5, slow: false, focus: false,
      main: 'red', level: 1, sub: null, subLevel: 0, fireT: 0, subT: 0, laserT: 0, optT: 0, entering: 0, lastX: 0, lastZ: 5,
    };
    this.scrollSpeed = 7; this.scrollTarget = 7;
    this.stats = null;
    this.timers = [];
    this.onEvent = () => {};
  }

  // --- setup ------------------------------------------------------------------------
  // One pool per ENEMY key (model: def.model or the key; air units get a ground shadow), per item
  // kind, per aircraft ('player:<id>', one mesh each) and per drone type ('option:<id>'). Every
  // model is built here and parked in a free list, so main.js precompile() compiles its shaders.
  // Paint schemes other than the factory one get their own pools on demand (setAircraft): they
  // reuse the factory materials' shader programs, so they need no compile pass.
  initPools() {
    const M = this.models;
    for (const [type, def] of Object.entries(ENEMY)) {
      const make = def.boss ? () => M.createBoss(def.model || 'arclight') : () => M.createEnemy(def.model || type);
      this.pools[type] = new Pool(this.scene, safeMake(make), !!def.air, M);
    }
    for (const k of ['P', 'S', 'B', 'medal', '1UP']) this.pools['item_' + k] = new Pool(this.scene, safeMake(() => M.createItem(k)), false, M);
    for (const ac of AIRCRAFT) {
      this.pools['player:' + ac.id] = new Pool(this.scene, safeMake(() => M.createPlayer(ac.id)), true, M);
      if (ac.options > 0) this.pools['option:' + ac.id] = new Pool(this.scene, safeMake(() => M.createOption(ac.id)), true, M);
    }
    this.setAircraft(this.ac.id, this.paint); // the current jet (+ drones) come out of their pools first
    for (const [type, def] of Object.entries(ENEMY)) this.pools[type].prewarm(def.prewarm ?? (def.boss || def.midboss ? 1 : 4));
    // medals: the big kills shower them (OMEGA's supernova drops 24 at once, the other bosses 16-18,
    // often onto a field still holding a destroyed part's few): none built mid-fight
    const counts = { item_P: 4, item_S: 2, item_B: 2, item_medal: 30, item_1UP: 1 };
    for (const [k, n] of Object.entries(counts)) this.pools[k].prewarm(n);
    for (const ac of AIRCRAFT) {
      if (this.playerKey === 'player:' + ac.id) continue; // already built and in use
      this.pools['player:' + ac.id].prewarm(1);
      if (ac.options > 0) this.pools['option:' + ac.id].prewarm(ac.options);
    }
  }
  // Make every pooled model visible for one compile pass (avoids first-spawn hitches).
  forEachPooled(fn) { for (const p of Object.values(this.pools)) for (const o of p.free) fn(o); }

  // Switch the player aircraft (AIRCRAFT id) and its paint scheme (a PAINTS[id] entry's id; an
  // unknown one falls back to the factory 'std'): mesh + shadow, option drones and every stat
  // (speed, hitbox, graze, bombs, damage, start level). Works at any time: in a run, on the title
  // fly-by and as the hangar preview (browsing paints too). Lives, bombs and weapons carry over;
  // new runs start with ac.bombs and ac.startLevel (plus upgrades). A scheme's jet is built the
  // first time it is shown. Returns the aircraft def.
  setAircraft(id, paint = DEFAULT_PAINT) {
    const ac = own(AIRCRAFT_BY_ID, id) ? AIRCRAFT_BY_ID[id] : AIRCRAFT_BY_ID[DEFAULT_AIRCRAFT];
    let pid = paint;
    if (!paintOf(ac.id, pid)) {
      pid = DEFAULT_PAINT;
      const w = ac.id + '/' + paint;
      if (paint != null && !warned.has(w)) { warned.add(w); console.warn(`setAircraft: unknown paint "${paint}" for ${ac.id}, using ${pid}`); }
    }
    if (ac === this.ac && pid === this.paint && this.playerO) return ac;
    if (!this.pools['player:' + ac.id]) { this.ac = ac; this.paint = pid; return ac; } // before initPools: just remember the choice
    const M = this.models, key = playerKey(ac.id, pid);
    const pool = this.pools[key] || (this.pools[key] = new Pool(this.scene, safeMake(() => M.createPlayer(ac.id, pid)), true, M));
    const p = this.player;
    if (this.playerO) this.pools[this.playerKey].put(this.playerO);
    for (const d of this.options) this.pools[this.optKey].put(d.o);
    this.options.length = 0;
    this.ac = ac; this.paint = pid; this.playerKey = key;
    const o = pool.get();
    this.playerO = o; p.mesh = o.mesh; p.shadow = o.shadow;
    const ud = o.mesh.userData;
    if (ud.hitboxMarker) ud.hitboxMarker.visible = false; // the game draws its own hitbox dot
    this.muzzleZ = typeof ud.muzzleZ === 'number' ? ud.muzzleZ : -1.0;
    this.trail = ud.trail && ud.trail.length ? ud.trail : [[0, 0.95]];
    let mx = 0;
    for (const t of this.trail) mx = Math.max(mx, Math.abs(t[0]));
    this.trailJ = Math.max(0.06, 0.18 - mx); // bolt: ±0.095 nozzles ± 0.085 = the old ±0.18 spread
    this.trailCol = Array.isArray(ud.trailColor) && ud.trailColor.length === 3 ? ud.trailColor : TRAIL_COL; // bolt has none: the old orange
    this.hitK = ac.hitR / HIT_R0;
    const c = new THREE.Color(paintOf(ac.id, pid).hex); // the scheme's accent ('std': the aircraft colour)
    this.optCol = [c.r, c.g, c.b];
    let op = null;
    this.optKey = null;
    if (ac.options > 0) {
      const ok = optionKey(ac.id, pid);
      op = this.pools[ok] || (this.pools[ok] = new Pool(this.scene, safeMake(() => M.createOption(ac.id, pid)), true, M));
      this.optKey = ok;
    }
    for (let k = 0; op && k < ac.options; k++) {
      const oo = op.get(), dud = oo.mesh.userData;
      const tr = dud.trail && dud.trail.length ? dud.trail[0] : [0, 0.3];
      this.options.push({ o: oo, mesh: oo.mesh, shadow: oo.shadow, x: p.x, z: p.z, bank: 0, side: k % 2 ? 1 : -1, row: k >> 1,
        muzzleZ: typeof dud.muzzleZ === 'number' ? dud.muzzleZ : -0.4, trail: tr });
    }
    this.optLive = false;
    // place the new jet at once (menus may not run an update before the next render)
    this.syncPlayerMesh(0, true);
    this.updateOptions(0, true);
    return ac;
  }

  // --- permanent upgrades (hangar shop) ----------------------------------------------------
  // levels: { <UPGRADES id>: level } (missing / unknown / bad values count as 0, levels are clamped
  // to 0..prices.length). They take effect at the next resetRun / continueRun (applyUpgrades);
  // returns the sanitised copy that was stored.
  setUpgrades(levels) {
    for (const u of UPGRADES) {
      const v = levels && typeof levels === 'object' && own(levels, u.id) ? Math.floor(Number(levels[u.id])) : 0;
      this.upgrades[u.id] = v > 0 ? Math.min(v, u.prices.length) : 0; // NaN → 0
    }
    return { ...this.upgrades };
  }
  // Put the levels set with setUpgrades in force (resetRun / continueRun call it; the title can
  // call it to refresh the shield bubble on the fly-by after a purchase): the CR multiplier, the
  // magnet radii and — only when `recharge` — a fresh shield charge. Starting lives / bombs /
  // power are handed out by resetRun and continueRun themselves.
  applyUpgrades(recharge = true) {
    const up = this.up;
    for (const u of UPGRADES) up[u.id] = this.upgrades[u.id];
    this.moneyMul = r9(1 + UPGRADE_BY_ID.bonus.step * up.bonus);
    this.magnetK = r9(1 + UPGRADE_BY_ID.magnet.step * up.magnet);
    const pr = 1.3 * this.magnetK, mr = 3 * this.magnetK; // pickup radius, medal magnet radius
    this.pickR2 = pr * pr; this.magnetR2 = mr * mr;
    if (recharge) this.shield = up.shield > 0;
  }
  get startBombs() { return this.ac.bombs + this.up.bombs; } // a new run, a continue and every life
  get bombCap() { return this.ac.bombCap + this.up.bombs; }
  get startLives() { return 2 + this.up.life; }             // a new run and a continue
  get bonusPct() { return Math.round((this.moneyMul - 1) * 100); } // the CR bonus in force, e.g. 20

  // Start a stage. stage: 0-based index into STAGES. keepScore carries score, lives, bombs,
  // weapons, continues and runMoney over (next stage / next loop); otherwise it is a new run.
  // Every stage start puts the upgrades set with setUpgrades in force and recharges the shield.
  resetRun({ keepScore = false, loop = 1, stage = 0 } = {}) {
    this.clearField();
    this.loop = loop;
    this.stageIdx = clamp(stage | 0, 0, STAGES.length - 1);
    this.stage = STAGES[this.stageIdx];
    this.fx.setAirless(this.stage.airless, this.stage.dust); // stages 4–8: no smoke in a vacuum
    const ac = this.ac;
    this.applyUpgrades();
    if (!keepScore) {
      this.score = 0; this.lives = this.startLives; this.bombs = this.startBombs; this.continues = 0;
      this.runMoney = 0;
      this.extendIdx = 0;
      Object.assign(this.player, { main: 'red', level: Math.min(MAX_LEVEL, ac.startLevel + this.up.power), sub: null, subLevel: 0 });
    }
    this.medalChain = 0; this.medalMaxChain = 0;
    this.stats = { spawned: 0, killed: 0, deaths: 0, bombsUsed: 0, grazes: 0, medals: 0, shieldBreaks: 0,
      stageScoreStart: this.score, moneyStart: this.runMoney, clearMoney: 0 };
    this.tlIndex = 0;
    this.phase = 'stage'; // stage | midboss | warning | boss | bossdead | clear
    this.boss = null; this.midboss = null;
    this.midbossDone = false; this.warned = false; this.clearAnnounced = false; this.clearDone = false;
    this.lostT = 0;
    this.bombT = 0; this.bombWave = 0;
    this.timeScale = 1; this.slowT = 0;
    this.warningT = 0;
    this.clearT = 0;
    this.scrollSpeed = this.stage.scroll; this.scrollTarget = this.stage.scroll;
    const p = this.player;
    p.alive = true; p.x = 0; p.z = this.view.zBottom + 2; p.entering = 1.2; p.invuln = 2.2; p.respawn = 0;
    p.fireT = 0; p.subT = 0; p.optT = 0; p.bank = 0; p.slow = false; p.focus = false; p.mesh.visible = true;
    this.optLive = false;
    // difficulty by stage (defs STAGE_LEVEL: stages 1–3 a third of a loop apart, then flatter):
    // loop 1 stage 1 = 1/1/1, loop 2 stage 1 = 1.22/1.35/1.3
    const level = r9((loop - 1) + (STAGE_LEVEL[this.stageIdx] ?? STAGE_LEVEL[STAGE_LEVEL.length - 1]));
    this.diff = { bs: r9(1 + 0.22 * level), fr: r9(1 + 0.35 * level), hp: r9(1 + 0.3 * level), level, part: r9(1 + 0.2 * level) };
    this.world.setStage(this.stage.world);
    this.world.reset(0);
  }
  clearField() {
    for (const e of this.enemies) this.releaseEnemy(e);
    this.enemies.length = 0;
    for (const it of this.items) this.pools['item_' + it.kind].put(it.o);
    this.items.length = 0;
    this.eb.n = 0; this.ps.n = 0;
    this.nTargets = 0; // the old field's targets (weapons read the list before the next collide)
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
    const p = this.player;
    if (p.alive) { const dx = p.x - x, dz = p.z - z; if (dx * dx + dz * dz < 16) return -1; } // never spawn point-blank
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
    if (e.def.boss || e.def.midboss) return true;        // bosses never go quiet when hugged
    if (e.z < this.view.zTop + 0.8 || e.z > this.view.zBottom - 1) return false;
    if (e.ground && e.z > p.z - 1.5) return false;       // ground units hold fire once level with the jet
    const dx = p.x - e.x, dz = p.z - e.z;
    return dx * dx + dz * dz > 20;
  }
  get BK() { return BK; }

  // Stage coordinate for a ground unit spawned just beyond the top edge.
  topGd(margin = 2) { return this.world.distance - (this.view.gTop - margin); }

  spawn(type, opts) {
    const def = ENEMY[type], pool = this.pools[type];
    if (!def || !pool) throw new Error('spawn: unknown enemy type "' + type + '"');
    const o = pool.get();
    const d = this.world.distance;
    const st = this.stage;
    const seg = (def.boss || def.midboss || def.noHpSeg || !st.hpSeg) ? 1 : st.hpSeg(d);
    const hpMul = def.boss ? 1 : this.diff.hp * seg;
    const e = {
      type, def, o, mesh: o.mesh, shadow: o.shadow, ground: !def.air, uid: ++this.uidN,
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
    if (def.parts) this.initParts(e);
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
  // Part records from def.parts (see stage.js ENEMY) for the parts the model exposes.
  initParts(e) {
    const ud = e.mesh.userData;
    const P = ud.parts;
    if (!P) return;
    const list = [];
    const k = this.diff.part;
    const add = (key, obj, spec) => {
      if (!obj) return;
      const pud = obj.userData || {};
      if (pud.setDestroyed) pud.setDestroyed(false);
      if (pud.setFlash) pud.setFlash(0);
      const core = !!spec.core, hp = spec.hp * k;
      list.push({ key, obj, hp, maxHp: hp, r: pud.radius || 1, dead: false, flash: 0, x: 0, z: 0, fireT: rnd(0.5, 1.5), core,
        uid: ++this.uidN, score: spec.score ?? (core ? 100000 : 3000), medals: spec.medals ?? 1, big: spec.big ?? (core ? 3 : 1.3) });
      if (core && pud.setOpen) pud.setOpen(0);
    };
    for (const spec of e.def.parts) {
      const obj = P[spec.key];
      if (spec.list) { if (Array.isArray(obj)) obj.forEach((o, i) => add(spec.key + i, o, spec)); }
      else add(spec.key, obj, spec);
    }
    e.parts = list;
  }
  partByKey(e, key) { return e.parts ? e.parts.find((p) => p.key === key) : null; }

  releaseEnemy(e) {
    const P = e.mesh.userData.parts;
    if (P && e.def.parts) { // pooled models come back whole
      for (const k of Object.keys(P)) { const o = P[k]; if (Array.isArray(o)) o.forEach((x) => x.userData.setDestroyed && x.userData.setDestroyed(false)); else if (o && o.userData.setDestroyed) o.userData.setDestroyed(false); }
    }
    e.mesh.scale.setScalar(1);
    e.mesh.position.y = 0;
    this.pools[e.type].put(e.o);
  }

  // --- items ---------------------------------------------------------------------
  // P items cycle through MAIN_ORDER from opts.color, S items through SUB_ORDER from opts.sub.
  dropItem(kind, x, z, opts = {}) {
    const o = this.pools['item_' + kind].get();
    const a = rnd(-2.4, -0.7);
    const ci = Math.max(0, MAIN_ORDER.indexOf(opts.color || 'red')), si = Math.max(0, SUB_ORDER.indexOf(opts.sub || 'H'));
    const it = {
      kind, o, mesh: o.mesh, x, z, vx: opts.vx ?? Math.cos(a) * rnd(1.2, 2.4) * (Math.random() < 0.5 ? -1 : 1), vz: opts.vz ?? -rnd(1.5, 3),
      t: 0, color: MAIN_ORDER[ci], sub: SUB_ORDER[si], ci, si, cur: null, life: kind === 'medal' ? 99 : 10, bounce: kind !== 'medal',
    };
    if (kind === 'medal') { it.vx = rnd(-0.6, 0.6); it.vz = -rnd(2.5, 4.5); }
    const ud = it.mesh.userData;
    if (kind === 'P' && ud.setColor) ud.setColor(it.color);
    if (kind === 'S' && ud.setKind) ud.setKind(it.sub);
    it.mesh.position.set(x, 0.2, z);
    it.mesh.scale.setScalar(kind === 'medal' ? 1.3 : 1.5); // readable at phone size
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
    const row = this.view.screenToPlane(this.view.w / 2, this.view.h * 0.84, this.tmpA).z;
    p.z = row + Math.sin(t * 0.7) * 0.8;
    const bank = Math.cos(t * 0.45) * 0.45;
    p.bank = lerp(p.bank, bank, 0.1);
    this.syncPlayerMesh(dt, true);
    this.updateOptions(dt, true);
    this.fx.update(dt, this.GROUND_Y, 5.5);
  }

  // Debug: skip timeline events before distance d.
  skipTo(d) { const T = this.stage.timeline; let i = 0; while (i < T.length && T[i].d < d) i++; this.tlIndex = i; }
  runTimeline() {
    if (this.phase === 'midboss') return; // the stage waits for the mid-boss
    const d = this.world.distance, T = this.stage.timeline;
    while (this.tlIndex < T.length && T[this.tlIndex].d <= d && this.phase !== 'midboss') {
      const ev = T[this.tlIndex++];
      try { ev.run(this); } catch (err) { console.error('timeline', ev.d, err); }
    }
  }

  updatePhase(dt) {
    const d = this.world.distance, st = this.stage;
    if (this.phase === 'midboss' && this.midbossDone) { this.phase = 'stage'; this.scrollTarget = st.scroll; this.midboss = null; this.lostT = 0; this.onEvent('midbossEnd'); }
    if (this.phase === 'stage' && d >= st.bossAt - 40 && !this.warned) {
      this.warned = true; this.phase = 'warning'; this.warningT = 4.2;
      this.scrollTarget = st.warnScroll;
      this.onEvent('warning');
    }
    if (this.phase === 'warning') {
      this.warningT -= dt;
      if (this.warningT <= 0) {
        this.phase = 'boss'; this.scrollTarget = st.bossScroll; this.lostT = 0;
        try { this.boss = st.spawnBoss(this); } catch (err) { console.error('spawnBoss', err); this.boss = null; }
        this.onEvent('bossStart');
      }
    }
    // Safety nets: a mid-boss / boss whose AI crashed is removed without its hand-off, which would
    // stall the stage for good. Log it loudly and move on.
    if (this.phase === 'midboss' && !this.midbossDone) {
      const m = this.midboss;
      if (m && m.def && m.def.midboss && !m.alive) {
        this.lostT += dt;
        if (this.lostT > 2) { console.error('mid-boss removed without setting midbossDone — continuing the stage'); this.midbossDone = true; }
      }
    }
    if (this.phase === 'boss' && (!this.boss || !this.boss.alive)) {
      this.lostT += dt;
      if (this.lostT > 2) {
        console.error('boss missing or removed without bossDefeated — clearing the stage');
        this.ui.boss(false); this.audio.music(null);
        this.phase = 'bossdead'; this.clearT = 0;
      }
    }
    if (this.phase === 'bossdead') {
      this.clearT += dt;
      if (this.clearT > 4.5 && !this.clearAnnounced) { this.clearAnnounced = true; this.onEvent('clearBanner'); }
      if (this.clearT > 5.5) {
        const p = this.player; // fly off the top
        p.z -= (6 + (this.clearT - 5.5) * 30) * dt;
      }
      if (this.clearT > 7.8 && !this.clearDone) {
        this.clearDone = true; this.phase = 'clear';
        // stage-clear CR (stats.clearMoney: this stage's, after the bonus upgrade)
        const bonus = Math.round((MONEY.stageClear[st.n] || 0) * this.moneyMul);
        this.runMoney += bonus; this.stats.clearMoney = bonus;
        this.onEvent('clear');
      }
    }
  }

  // --- player ------------------------------------------------------------------------
  updatePlayer(dt, rawDt, input) {
    const p = this.player, v = this.view;
    if (p.invuln > 0) p.invuln -= dt;
    if (!p.alive) {
      p.respawn -= rawDt;
      if (p.respawn <= 0 && this.lives >= 0 && this.phase !== 'clear') this.respawnPlayer();
      this.updateOptions(dt, false);
      return;
    }
    const prevX = p.x, prevZ = p.z;
    if (p.entering > 0) {
      p.entering -= dt;
      const tz = Math.min(v.zBottom - 5, (v.zPlayerMax ?? v.zBottom) - 1.5);
      p.z = lerp(p.z, tz, Math.min(1, dt * 4));
    } else if (this.phase !== 'clear' && !(this.phase === 'bossdead' && this.clearT > 5.5)) {
      const ax = input.axis(), ac = this.ac;
      p.slow = !!ax.slow;                 // slow move (speed)
      p.focus = !!(ax.slow || ax.focus);  // focus: tucks the option drones (touch / pad may focus without slowing)
      const sp = (ax.slow ? ac.slow : ac.speed) * (ax.stick ? (this.settings.touchSens || 1) : 1);
      p.x += ax.x * sp * dt; p.z += ax.y * sp * dt;
      const b = this.boss, m = this.midboss;
      let zMin = (b && b.alive && !b.dying) ? Math.max(v.zTop + 5, b.z + 7) : v.zTop + 5;
      const zMax = v.zPlayerMax ?? v.zBottom - 1.3;
      // a mid-boss with def.keepOff holds the jet that far below it, so its guns can't be hugged into
      // silence (shoot() never fires point-blank)
      if (m && m.alive && !m.dying && m.def && m.def.keepOff) zMin = Math.max(zMin, Math.min(m.z + m.def.keepOff, zMax));
      p.z = clamp(p.z, zMin, zMax);
      const hw = v.hw(p.z) - 0.75;
      p.x = clamp(p.x, -hw, hw);
    }
    const vx = (p.x - prevX) / Math.max(dt, 1e-4);
    const vz = (p.z - prevZ) / Math.max(dt, 1e-4);
    p.bank = lerp(p.bank, clamp(vx / 12, -1, 1), Math.min(1, dt * 10));
    p.thrust = lerp(p.thrust, clamp(0.55 - vz / 20, 0.25, 1), Math.min(1, dt * 8));
    this.syncPlayerMesh(dt, false);
    this.updateOptions(dt, false);
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
  // Option drones trail the jet in a loose line abreast; focus (slow, or a touch / pad focus input)
  // tucks them in close (their streams then converge, see weapons.js). They vanish with the jet and
  // fly out of it again.
  updateOptions(dt, attract) {
    const opts = this.options;
    if (!opts.length) return;
    const p = this.player, v = this.view;
    if (!p.alive) {
      if (this.optLive) for (const d of opts) { d.mesh.visible = false; if (d.shadow) d.shadow.visible = false; }
      this.optLive = false;
      return;
    }
    const want = attract || !p.focus ? 1 : 0;
    this.optSpread += (want - this.optSpread) * Math.min(1, dt * 9);
    const s = this.optSpread, snap = !this.optLive;
    const k = 1 - Math.exp(-dt * 14);
    this.optLive = true;
    const vis = p.mesh.visible; // blinks with the jet
    for (const d of opts) {
      const tx = p.x + d.side * (0.66 + 0.94 * s + d.row * 0.9);
      const tz = p.z + (-0.45 + 0.85 * s) + d.row * 0.6;
      const px = d.x;
      if (snap) { d.x = p.x; d.z = p.z + 0.2; d.bank = 0; }
      else { d.x += (tx - d.x) * k; d.z += (tz - d.z) * k; }
      const hw = v.hw(d.z) - 0.35;
      d.x = clamp(d.x, -hw, hw);
      if (!snap) d.bank = lerp(d.bank, clamp((d.x - px) / Math.max(dt, 1e-4) / 12, -1, 1), Math.min(1, dt * 10));
      const m = d.mesh, ud = m.userData;
      m.position.set(d.x, 0.15, d.z);
      m.rotation.set(0, 0, -d.bank * 0.55);
      if (ud.setThrust) ud.setThrust(attract ? 0.6 : p.thrust);
      if (ud.update) ud.update(dt, this.time);
      m.visible = vis;
      this.placeShadow(d.shadow, d.x, 0, d.z, 0, true);
    }
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
    if (this.shield) { this.breakShield(); return; }
    p.alive = false;
    p.mesh.visible = false;
    if (p.shadow) p.shadow.visible = false;
    this.stats.deaths++;
    const col = p.mesh.userData.debrisColor || DEATH_DEBRIS;
    this.fx.explosion(p.x, 0.2, p.z, 2.4, { debris: 20, color: col });
    if (this.optLive) for (const d of this.options) this.fx.explosion(d.x, 0.2, d.z, 0.9, { debris: 4, color: col });
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
    this.bombs = Math.max(this.bombs, this.startBombs);
    this.lives -= 1;
    p.respawn = 1.4;
    this.medalChain = 0;
    if (this.lives < 0) { p.respawn = 999; this.onEvent('gameover'); }
    else this.onEvent('death');
  }
  // The shield upgrade's charge takes a hit that would have killed the jet: the bullets around it
  // are wiped, it is invulnerable for a moment, and the charge is gone until the next stage start
  // or continue. onEvent('shield') lets the HUD react (g.shield is false from now on).
  breakShield() {
    const p = this.player;
    this.shield = false;
    this.stats.shieldBreaks++;
    p.invuln = Math.max(p.invuln, SHIELD_INVULN);
    this.cancelBullets(p.x, p.z, SHIELD_CLEAR_R, false);
    this.fx.shieldBreak(p.x, 0.2, p.z, SHIELD_R, SHIELD_COL);
    this.shake.add(0.4);
    this.ui.flash(0.2);
    this.audio.play('shield');
    this.haptic([30, 30, 70]);
    this.popupAt(p.x, p.z - 1.8, 'SHIELD', 'big');
    this.onEvent('shield');
  }
  // Continue: the score restarts (earned CR stays in runMoney), the stage carries on where it was.
  continueRun() {
    this.applyUpgrades();
    this.score = 0; this.continues += 1; this.lives = this.startLives; this.bombs = this.startBombs;
    this.extendIdx = 0;
    this.player.respawn = 0.3;
  }

  // --- weapons (weapons.js) ---------------------------------------------------------------
  fireWeapons(dt) { WP.fireWeapons(this, dt); }
  updateShots(dt) { WP.updateShots(this, dt); }
  removeShot(i) {
    const ps = this.ps, j = --ps.n;
    if (i === j) { ps.target[j] = null; return; }
    ps.x[i] = ps.x[j]; ps.z[i] = ps.z[j]; ps.vx[i] = ps.vx[j]; ps.vz[i] = ps.vz[j]; ps.dmg[i] = ps.dmg[j];
    ps.r[i] = ps.r[j]; ps.t[i] = ps.t[j]; ps.kind[i] = ps.kind[j]; ps.w[i] = ps.w[j]; ps.target[i] = ps.target[j]; ps.trail[i] = ps.trail[j];
    ps.pierce[i] = ps.pierce[j]; ps.aux[i] = ps.aux[j];
    const hi = i * 4, hj = j * 4;
    ps.hits[hi] = ps.hits[hj]; ps.hits[hi + 1] = ps.hits[hj + 1]; ps.hits[hi + 2] = ps.hits[hj + 2]; ps.hits[hi + 3] = ps.hits[hj + 3];
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
    return best.part ? { part: best.part, e: best.e, get alive() { return !this.part.dead && this.e.alive && !this.e.dying; }, get x() { return this.part.x; }, get z() { return this.part.z; } }
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
    amount *= this.ac.dmg;
    for (const e of this.enemies) {
      if (!e.alive || e.dying || !v.onScreen(e.x, e.z, 1)) continue;
      if (e.parts && e.parts.length) {
        const mul = e.def.boss ? 0.45 : 1;
        for (const pt of e.parts) if (!pt.dead && !(pt.core && e.armored)) this.damagePart(e, pt, amount * mul, true);
        if (!e.def.boss && e.def.bodyTarget !== false) this.damageEnemy(e, amount, true);
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
      if (off && !e.def.boss && !e.def.midboss && e.t > 1) {
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
    if (pt.dead || !e.alive || e.dying) return;
    pt.hp -= dmg;
    pt.flash = 0.45;
    if (pt.hp <= 0) {
      pt.dead = true;
      const u = pt.obj.userData;
      if (u.setDestroyed) u.setDestroyed(true);
      if (u.setFlash) u.setFlash(0);
      const big = pt.big;
      this.fx.explosion(pt.x, 0.4, pt.z, big, { debris: 10, color: e.mesh.userData.debrisColor || PART_DEBRIS });
      this.shake.add(0.35);
      this.audio.play(big >= 2 ? 'explodeL' : 'explodeM');
      const pts = pt.score;
      this.addScore(pts);
      this.popupAt(pt.x, pt.z, pts.toLocaleString('en-US'), 'big');
      for (let i = 0; i < pt.medals; i++) this.dropItem('medal', pt.x + rnd(-1, 1), pt.z + rnd(-1, 1));
      if (e.onPartDestroyed) e.onPartDestroyed(e, pt, this);
      if (pt.core) this.killEnemy(e, fromBomb);
    }
  }
  killEnemy(e, fromBomb) {
    if (!e.alive || e.dying) return;
    const def = e.def;
    if (def.boss || def.midboss) { e.dying = true; if (e.onDeath) e.onDeath(e, this); return; } // the AI plays the death
    e.alive = false;
    if (!e.noCount) this.stats.killed++;
    const pts = def.score;
    this.addScore(pts);
    if (pts >= 1000) this.popupAt(e.x, e.z, pts.toLocaleString('en-US'), pts >= 5000 ? 'big' : '');
    const size = def.explode;
    const col = e.mesh.userData.debrisColor || ENEMY_DEBRIS;
    if (e.ground) {
      this.fx.explosion(e.gx, this.GROUND_Y + 0.4, e.gz, size, { ground: true, debris: def.debris, color: col });
      if (e.sinks) this.fx.splash(e.gx, this.GROUND_Y, e.gz, 2.4);
    } else {
      this.fx.explosion(e.x, 0.1, e.z, size, { debris: def.debris, color: col });
    }
    this.shake.add(size >= 2 ? 0.45 : size >= 1.3 ? 0.18 : 0.06);
    this.audio.play(size >= 2 ? 'explodeL' : size >= 1.2 ? 'explodeM' : 'explodeS', { pan: clamp(e.x / 10, -1, 1) });
    // drops
    if (e.drops) for (const d of e.drops) this.dropItem(d, e.x, e.z, { color: MAIN_ORDER[(Math.random() * MAIN_ORDER.length) | 0] });
    const medals = typeof def.medal === 'number' ? (def.medal >= 1 ? def.medal : (Math.random() < def.medal ? 1 : 0)) : 0;
    for (let i = 0; i < medals; i++) this.dropItem('medal', e.x + rnd(-0.6, 0.6), e.z + rnd(-0.4, 0.4));
    if (def.boss !== true && size >= 2) this.ui.flash(0.12);
    // loop 2+: destroyed enemies answer with a slow revenge shot
    if (this.diff.level >= 1 && !fromBomb && !def.noRevenge && this.canFire(e)) {
      const a = this.aim(e.x, e.z);
      if (e.ground) this.fan(e.x, e.z, a, 3, 0.5, 5.2); else this.shoot(e.x, e.z, a, 5.6);
    }
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
          t.x = q.x; t.z = q.z; t.r = pt.r * q.s; t.e = e; t.part = pt; t.armored = !!(pt.core && e.armored) || !!e.invuln; t.uid = pt.uid;
        }
        // a boss hull, or a holder body whose HP lives in its parts (def.bodyTarget: false), isn't a target
        if (e.def.boss || e.def.bodyTarget === false) continue;
      }
      if (n >= this.targets.length) break;
      const t = this.targets[n++];
      t.x = e.x; t.z = e.z; t.r = e.r * (e.ground ? this.view.k : 1); t.e = e; t.part = null; t.armored = !!e.invuln; t.uid = e.uid;
    }
    this.nTargets = n;
  }
  // Armoured boss/mid-boss body box from def.hull (shots spark off it instead of passing through).
  inHull(e, x, z) {
    if (!e || !e.alive || e.dying || !e.def || !e.def.hull || e.s.mode === 'enter') return false;
    const h = e.def.hull;
    return Math.abs(x - e.x) < h.hw && z > e.z + h.z0 && z < e.z + h.z1;
  }
  collide() {
    this.buildTargets();
    const ps = this.ps, T = this.targets;
    const hulls = this.boss || this.midboss; // most of the stage: no hull to test
    // player shots vs enemies
    let i = 0;
    while (i < ps.n) {
      const x = ps.x[i], z = ps.z[i], r = ps.r[i], pierce = ps.pierce[i];
      const test = WP.SHOT[ps.kind[i]].test; // optional narrow phase (WAVE: its crescent band)
      let hit = null;
      for (let k = 0; k < this.nTargets; k++) {
        const t = T[k];
        const rr = t.r + r;
        const dx = t.x - x, dz = t.z - z;
        if (dx * dx + dz * dz < rr * rr) {
          if (pierce && WP.wasHit(ps, i, t.uid)) continue; // a piercing shot hits each target once
          if (test && !test(this, i, t)) continue;
          hit = t; break;
        }
      }
      if (!hit && hulls && (this.inHull(this.boss, x, z) || this.inHull(this.midboss, x, z))) hit = this.hullTarget;
      if (hit && WP.shotHit(this, i, hit) !== 'keep') { this.removeShot(i); continue; }
      i++;
    }
    // enemy bullets vs player (+ graze)
    const p = this.player;
    if (!p.alive || p.entering > 0) return;
    const b = this.eb;
    const hitR = this.ac.hitR, grazeR = this.ac.grazeR;
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
      if (!b.grazed[j] && p.invuln <= 0 && d2 < (grazeR + br) * (grazeR + br)) {
        b.grazed[j] = 1;
        this.stats.grazes++;
        this.addScore(100);
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
      if (it.kind === 'P') { // cycles through the main weapons (starting at its drop colour)
        const c = MAIN_ORDER[(it.ci + Math.floor(it.t / 2.2)) % MAIN_ORDER.length];
        if (c !== it.cur) { it.cur = c; const ud = it.mesh.userData; if (ud.setColor) ud.setColor(c); }
      } else if (it.kind === 'S') { // … and S through the sub-weapons
        const c = SUB_ORDER[(it.si + Math.floor(it.t / 2.6)) % SUB_ORDER.length];
        if (c !== it.cur) { it.cur = c; const ud = it.mesh.userData; if (ud.setKind) ud.setKind(c); }
      }
      // magnet when close (both radii grow with the magnet upgrade)
      let collected = false;
      if (p.alive) {
        const dx = p.x - it.x, dz = p.z - it.z, d2 = dx * dx + dz * dz;
        if (d2 < this.pickR2) collected = true;
        else if (it.kind === 'medal' && (d2 < this.magnetR2 || this.phase === 'bossdead')) {
          const d = Math.sqrt(d2), sp = this.phase === 'bossdead' ? 14 : 9;
          it.x += dx / d * sp * dt; it.z += dz / d * sp * dt;
        }
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
        if (p.level < MAX_LEVEL) { p.level++; this.audio.play('powerup'); this.popupAt(it.x, it.z, p.level === MAX_LEVEL ? 'MAX POWER' : 'POWER UP', 'big'); }
        else { this.addScore(5000); this.popupAt(it.x, it.z, '5,000', 'big'); this.audio.play('item'); }
      } else {
        p.main = c; p.level = Math.min(MAX_LEVEL, p.level + 1); p.fireT = 0; p.laserT = 0; // new weapon: fire at once
        WP.equipped(this, p, 'main');
        this.audio.play('powerup');
        this.popupAt(it.x, it.z, MAIN_WEAPONS[c] ? MAIN_WEAPONS[c].name : 'POWER UP', 'big');
      }
    } else if (k === 'S') {
      const c = it.cur || it.sub, name = SUB_WEAPONS[c] ? SUB_WEAPONS[c].name : 'MISSILE';
      if (c === p.sub) {
        if (p.subLevel < MAX_SUB_LEVEL) { p.subLevel++; this.audio.play('powerup'); this.popupAt(it.x, it.z, name + ' UP', 'big'); }
        else { this.addScore(5000); this.popupAt(it.x, it.z, '5,000', 'big'); this.audio.play('item'); }
      } else {
        p.sub = c; p.subLevel = Math.max(1, Math.min(MAX_SUB_LEVEL, p.subLevel + 1)); p.subT = 0;
        WP.equipped(this, p, 'sub');
        this.audio.play('powerup');
        this.popupAt(it.x, it.z, name, 'big');
      }
    } else if (k === 'B') {
      if (this.bombs < this.bombCap) { this.bombs++; this.popupAt(it.x, it.z, 'BOMB', 'big'); }
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
  // Every point also earns CR (runMoney, banked by main.js; × moneyMul with the bonus upgrade); a
  // continue zeroes the score, not the CR.
  addScore(n) { this.score += n; this.runMoney += n * MONEY.perScore * this.moneyMul; }
  // Extra lives at the EXTENDS scores; returns how many were awarded. quiet: no sound and no
  // 'extend' event (the results screen reports a life its bonus earned in the tally instead).
  checkExtends(quiet = false) {
    let n = 0;
    while (this.extendIdx < EXTENDS.length && this.score >= EXTENDS[this.extendIdx]) { this.extendIdx++; this.lives++; n++; }
    if (n && !quiet) { this.audio.play('oneup'); this.onEvent('extend'); }
    return n;
  }
  // Score / pickup popups. One projected above the HUD's top strip (score, HI-SCORE + CR, the
  // pause button) — or the boss bar while it shows — is held just under it, its rise included, so
  // it never prints over them; another held there within 0.3 s steps a row down instead of
  // stacking up into the strip (medals merge into one counter in ui.popup, so they don't step).
  popupAt(x, z, text, cls) {
    const s = this.view.toScreen(x, 0, z, this.tmpS);
    const top = this.hudFloor() + POP_CLEAR;
    if (s.y < top) {
      const q = this.popLow, dt = this.time - q.t;
      if (cls !== 'medal') {
        q.n = dt >= 0 && dt < 0.3 && Math.abs(q.x - s.x) < POP_STEP ? Math.min(q.n + 1, 3) : 0;
        q.t = this.time; q.x = s.x;
      }
      s.y = top + POP_STEP * (cls !== 'medal' ? q.n : 0);
    }
    this.ui.popup(text, s.x, s.y, cls);
  }
  // The lowest CSS-px row of the HUD's top strip, or of the boss bar while it shows (popupAt). Read
  // from the DOM once per view size (and when the boss bar first shows), never per frame; 0 while
  // there is no HUD on screen.
  hudFloor() {
    const el = this.ui && this.ui.el, hud = el && el.hud;
    if (!hud || hud.hidden || !hud.getBoundingClientRect) return 0;
    const c = this.hudRows, v = this.view;
    if (c.w !== v.w || c.h !== v.h) { c.w = v.w; c.h = v.h; c.strip = -1; c.bar = -1; }
    const bar = !!el.bossbar && !el.bossbar.hidden;
    if (c.strip < 0 || (bar && c.bar < 0)) {
      const y0 = hud.getBoundingClientRect().top, strip = hud.querySelector('.hud-top');
      c.strip = strip ? Math.max(0, strip.getBoundingClientRect().bottom - y0) : 0;
      if (bar) c.bar = Math.max(0, el.bossbar.getBoundingClientRect().bottom - y0);
    }
    return bar && c.bar > c.strip ? c.bar : c.strip;
  }
  haptic(pattern) {
    if (!this.settings.haptics) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* ignore */ }
  }

  // --- rendering of bullets/shots (called every frame after update) --------------------------
  draw(emit = true) {
    const fx = this.fx, b = this.eb, t = this.time;
    // player shots, then beam roots / muzzle glows
    WP.drawWeapons(this, fx);
    // enemy bullets over a dark underlay. Its soft halo reads on dark ground and sea; a bright stage
    // (stage.bulletRim: stage 3's white cloud deck) adds a hard dark rim / a wider needle shadow, and
    // burning PLASMA beams get a bigger, darker halo (their bloom floods back over the soft one).
    const rim = !!this.stage.bulletRim, lit = WP.plasmaLit(this);
    const nw = lit ? 0.9 : 0.55, nh = lit ? 2.1 : 1.3, na = lit ? 0.95 : 0.7;
    const ok = lit ? 2.32 : 1.45, oa = lit ? 0.95 : 0.75;
    for (let i = 0; i < b.n; i++) {
      const k = b.kind[i], x = b.x[i], z = b.z[i];
      const birth = Math.min(1, b.t[i] * 12);
      const c = B_COLOR[k];
      if (k === BK.NEEDLE) {
        const rot = flatRot(b.vx[i], b.vz[i]);
        if (rim) fx.underlay.push(x, 0.05, z, 0.8, 1.5, rot, F.GLOW, 1, 0.05, 0.0, 0.06, 0.85);
        fx.underlay.push(x, 0.05, z, nw, nh, rot, F.GLOW, 1, 0.05, 0.0, 0.06, na);
        fx.bullets.push(x, 0.1, z, 0.42 * birth, 1.15 * birth, rot, F.STREAK, 1, c[0], c[1], c[2], 1, 0.4);
      } else {
        const s = B_SIZE[k] * (0.4 + 0.6 * birth) * (k === BK.MINE ? 1 + Math.sin(t * 14 + i) * 0.12 : 1);
        if (rim) fx.underlay.push(x, 0.05, z, s * 1.3, s * 1.3, 0, F.ORB, 0, 0.03, 0.0, 0.05, 0.9);
        fx.underlay.push(x, 0.05, z, s * ok, s * ok, 0, F.GLOW, 0, 0.06, 0.0, 0.07, oa);
        fx.bullets.push(x, 0.1, z, s, s, 0, F.ORB, 0, c[0], c[1], c[2], 1, 0.45);
      }
    }
    // hitbox core: always visible while alive (sized to the aircraft's hitbox)
    const p = this.player;
    if (p.alive && this.phase !== 'clear') {
      const pulse = (0.3 + Math.sin(t * 10) * 0.04) * this.hitK;
      fx.bullets.push(p.x, 0.2, p.z, pulse, pulse, 0, F.ORB, 0, 1.8, 0.4, 0.9, p.invuln > 0 ? 0.5 : 0.85, 0.4);
      if (this.shield) this.drawShield(fx, p, t, rim);
    }
    // engine trail from one of the jet's exhaust points
    if (emit && p.alive && p.mesh.visible && Math.random() < 0.7) {
      const tr = this.trail, e = tr.length === 1 ? tr[0] : tr[(Math.random() * tr.length) | 0], j = this.trailJ;
      const tc = this.trailCol;
      fx.trail(p.x + e[0] + rnd(-j, j), 0.05, p.z + e[1], tc[0], tc[1], tc[2], 0.45, 0.22, 0.2);
    }
    if (emit && this.optLive) {
      const c = this.optCol;
      for (const d of this.options) {
        if (d.mesh.visible && Math.random() < 0.5) fx.trail(d.x + d.trail[0] + rnd(-0.05, 0.05), 0.05, d.z + d.trail[1], c[0] * 2, c[1] * 2, c[2] * 2, 0.4, 0.14, 0.16);
      }
    }
  }
  // The shield charge: a faint bubble around the jet — a thin camera-facing ring that breathes,
  // and two glints running round it (placed on the ring as the camera sees it: camera right is +x,
  // camera up is (0, sin TILT, -cos TILT)). A bright stage (rim) gets a dark outline under it.
  drawShield(fx, p, t, rim) {
    const c = SHIELD_COL, S = SHIELD_R / 0.39; // the RING frame's line sits at 0.78 of the half-size
    const k = 0.3 + 0.07 * Math.sin(t * 3.1);
    const x = p.x, y = 0.2, z = p.z;
    if (rim) fx.underlay.push(x, y, z, S * 1.02, S * 1.02, 0, F.RING, 0, 0.02, 0.05, 0.08, 0.55);
    fx.bullets.push(x, y, z, S, S, 0, F.RING, 0, c[0], c[1], c[2], k, 0.3);
    const a = t * 1.7, sy = Math.sin(TILT) * SHIELD_R, sz = Math.cos(TILT) * SHIELD_R;
    for (let i = 0; i < 2; i++) {
      const ca = Math.cos(a + i * Math.PI), sa = Math.sin(a + i * Math.PI);
      fx.bullets.push(x + ca * SHIELD_R, y + sa * sy, z - sa * sz, 0.36, 0.36, 0, F.GLOW, 0, c[0], c[1], c[2], 0.75, 0.6);
    }
  }
}

export { BK, SK, STAGES };
