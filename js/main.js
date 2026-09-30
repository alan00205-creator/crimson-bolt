// main.js — boot, renderer + post-processing, adaptive quality, game-flow state machine, menus.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FX, Shake } from './fx.js';
import { Input } from './input.js';
import { UI, fmt } from './ui.js';
import { AIRCRAFT, AIRCRAFT_BY_ID, DEFAULT_AIRCRAFT, DEFAULT_PAINT, MONEY, PAINTS, paintOf, UPGRADES, UPGRADE_BY_ID, STAGE_COUNT } from './defs.js';

window.__cbBooted = true;
clearTimeout(window.__cbBootTimer);

const $ = (id) => document.getElementById(id);
const DEBUG = /debug/.test(location.hash);
// Phones/tablets (coarse pointer, no mouse) start in touch mode with the joystick; computers start in
// keyboard mode. Hybrid devices switch live: a finger on the screen shows the joystick, a movement
// key or gamepad hides it again.
const isTouch = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
let touchUI = isTouch;
document.body.classList.toggle('touch', touchUI);
function setTouchUI(on) {
  if (touchUI === on) return;
  touchUI = on;
  document.body.classList.toggle('touch', on);
  if (!on && input) input.releaseStick();
  if (renderer) resize();
}
window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') setTouchUI(true); }, { capture: true, passive: true });
window.addEventListener('keydown', (e) => {
  // (typing a name for the board is not a switch to the keyboard layout: soft keyboards send keys too)
  const typing = e.target && e.target.tagName === 'INPUT' && e.target.type === 'text';
  if (!typing && /^(Arrow|Key[WASDXKPQE]$|Space|Shift|Escape|Enter)/.test(e.code)) setTouchUI(false);
  // A held Enter must not auto-repeat a focused button's click: its repeats would confirm a
  // purchase (or QUIT / RESTART) that the first press only armed.
  // Nor submit a name box for the board: NO on CONTINUE (or QUIT) focuses one under the held key,
  // and a repeat there would confirm the prefilled name before anything could be typed.
  if (e.repeat && (e.code === 'Enter' || e.code === 'NumpadEnter') && e.target.closest && e.target.closest('button, form.entry')) e.preventDefault();
}, { capture: true });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const landscapeLock = matchMedia('(orientation: landscape) and (max-height: 500px)');
const safeProbe = document.createElement('div');
safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
document.body.appendChild(safeProbe);
const isPortraitBlocked = () => touchUI && landscapeLock.matches;

// ---------------------------------------------------------------------------------
// persistence (never required to work)
// ---------------------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem('crimsonbolt.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('crimsonbolt.' + k, JSON.stringify(v)); return true; } catch (_) { return false; } },
};
const settings = Object.assign({ music: 0.7, sfx: 0.8, muted: false, quality: 'auto', shake: !reducedMotion, haptics: true, touchSens: 1 }, store.get('settings', {}));
if (![0.85, 1, 1.2].includes(settings.touchSens)) settings.touchSens = 1; // old drag-sensitivity values
let hiScore = 0; // HI-SCORE shown (syncHi sets it at boot)

// Wallet + hangar: store 'hangar' → { money, owned: [aircraft ids], equipped, paints: { <aircraft>:
// [paint ids owned] }, paint: { <aircraft>: paint equipped }, upgrades: { <upgrade>: level } }.
// Always sanitised (bolt always owned, equipped must be owned, money a finite whole number ≥ 0,
// 'std' always owned and the fallback paint, levels 0..prices.length, unknown ids dropped), so a
// wallet saved before paints / upgrades existed loads with the defaults. Like the board, every
// change re-reads storage first so two tabs can't overwrite each other's CR. If storage is
// unavailable (or a write fails) the wallet keeps working in memory for this session.
const MONEY_MAX = 999999999;
// Own-property lookups, so a hand-edited save naming 'constructor' or 'toString' is not an aircraft
// (or an upgrade, or a key of a paint table).
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const shipDef = (id) => (own(AIRCRAFT_BY_ID, id) ? AIRCRAFT_BY_ID[id] : null);
const upDef = (id) => (own(UPGRADE_BY_ID, id) ? UPGRADE_BY_ID[id] : null);
function cleanWallet(w) {
  const out = { money: 0, owned: [DEFAULT_AIRCRAFT], equipped: DEFAULT_AIRCRAFT, paints: {}, paint: {}, upgrades: {} };
  if (!w || typeof w !== 'object') w = {};
  const m = Math.floor(Number(w.money));
  if (Number.isFinite(m) && m > 0) out.money = Math.min(m, MONEY_MAX);
  if (Array.isArray(w.owned)) for (const id of w.owned) if (shipDef(id) && !out.owned.includes(id)) out.owned.push(id);
  if (out.owned.includes(w.equipped)) out.equipped = w.equipped;
  for (const ac of AIRCRAFT) {
    // owned paints in PAINTS order ('std' always); the equipped one must be owned
    const had = own(w.paints, ac.id) && Array.isArray(w.paints[ac.id]) ? w.paints[ac.id] : [];
    const all = own(PAINTS, ac.id) ? PAINTS[ac.id].map((p) => p.id) : [DEFAULT_PAINT];
    const list = all.filter((id) => id === DEFAULT_PAINT || had.includes(id));
    out.paints[ac.id] = list;
    const eq = own(w.paint, ac.id) ? w.paint[ac.id] : DEFAULT_PAINT;
    out.paint[ac.id] = list.includes(eq) ? eq : DEFAULT_PAINT;
  }
  for (const u of UPGRADES) {
    const v = own(w.upgrades, u.id) ? Math.floor(Number(w.upgrades[u.id])) : 0;
    out.upgrades[u.id] = v > 0 ? Math.min(v, u.prices.length) : 0; // NaN → 0
  }
  return out;
}
let walletMem = cleanWallet(store.get('hangar', null));
let walletStored = true; // false after a failed write: memory is the only truth from then on
function readWallet() {
  if (walletStored) { const v = store.get('hangar', null); if (v) walletMem = cleanWallet(v); }
  return walletMem;
}
function writeWallet(w) {
  walletMem = cleanWallet(w);
  walletStored = store.set('hangar', walletMem) && walletStored;
  showWallet();
  return walletMem;
}
// CR of the current run already moved into the wallet (whole CR; game.runMoney is fractional).
// A run's CR is banked at results, game over, quit, restart and page hide; each call adds only
// what came in since the last one, so no path can credit the same CR twice.
let runBanked = 0;
function bankMoney() {
  if (!game) return 0;
  const earned = Math.floor(Math.max(0, game.runMoney || 0));
  const delta = earned - runBanked;
  if (!(delta > 0)) return 0;
  const w = readWallet();
  w.money = Math.min(MONEY_MAX, w.money + delta);
  runBanked = earned;
  writeWallet(w);
  return delta;
}
// A new run starts from zero CR: bank what is left of the old one first.
function endRunMoney() { bankMoney(); runBanked = 0; }
// The aircraft (and its paint) to fly, and the upgrades to fly with: the wallet's loadout.
function applyLoadout() {
  const w = readWallet();
  game.setUpgrades(w.upgrades);
  game.setAircraft(w.equipped, w.paint[w.equipped]);
}

// Local leaderboard (this device only): store 'ranking' → up to RANK_MAX runs, best first:
// { score, name, ac, paint, stage (1-3 reached), loop, clear (stage 3 cleared in the run), cont
// (continues used), date ('yyyy-mm-dd'), t (ms when recorded; the newest row is highlighted) }.
// Sanitised on every read like the wallet (malformed rows dropped, names trimmed to NAME_MAX);
// works in memory when storage fails. Names are player text: the UI shows them with textContent.
const RANK_MAX = 10, NAME_MAX = 10, NAME_DEFAULT = 'PLAYER';
const int = (v, min) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= Number.MAX_SAFE_INTEGER ? n : null; };
// Control and bidi-override characters out, surrounding blanks trimmed, at most NAME_MAX characters.
function cleanName(s) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim();
  return Array.from(t).slice(0, NAME_MAX).join('').trim();
}
function cleanRanking(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const score = int(r.score, 0), stage = int(r.stage, 1), loop = int(r.loop, 1), ac = shipDef(r.ac);
    if (score === null || stage === null || stage > STAGE_COUNT || loop === null || !ac) continue;
    out.push({
      score, name: cleanName(r.name) || NAME_DEFAULT, ac: ac.id,
      paint: paintOf(ac.id, r.paint) ? r.paint : DEFAULT_PAINT,
      stage, loop, clear: r.clear === true, cont: int(r.cont, 0) || 0,
      date: typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '',
      t: int(r.t, 0) || 0,
    });
  }
  out.sort((a, b) => b.score - a.score); // stable: an equal score keeps its older row first
  out.length = Math.min(out.length, RANK_MAX);
  return out;
}
let rankMem = cleanRanking(store.get('ranking', []));
let rankStored = true;
function readRanking() {
  if (rankStored) { const v = store.get('ranking', null); if (v) rankMem = cleanRanking(v); }
  return rankMem;
}
function writeRanking(list) {
  rankMem = cleanRanking(list);
  rankStored = store.set('ranking', rankMem) && rankStored;
  return rankMem;
}
function lastName() { return cleanName(store.get('rankName', '')) || NAME_DEFAULT; }
// HI-SCORE is the top of the board, or the old 'hi' key when that is higher (an existing player's
// record from before the board). Only a run offered to the board raises it on disk (syncHi below;
// clearRecords zeroes it), so a tab closed on a results or CONTINUE screen can't leave behind a HI
// that the board lacks. During a run the HUD shows a higher score as HI; the title reverts to this.
function storedHi() { const v = Math.floor(Number(store.get('hi', 0))); return Number.isFinite(v) && v > 0 ? v : 0; }
function syncHi() {
  const top = readRanking().length ? rankMem[0].score : 0;
  const best = storedHi();
  if (top > best) store.set('hi', top);
  hiScore = Math.max(best, top);
  ui.setHi(hiScore);
}
const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// The run in progress, for the board: its best score (a continue zeroes the score), whether stage 3
// was cleared, and whether it has been offered. A run ends — and is offered once — at GAME OVER,
// at QUIT / RESTART from the pause menu and at TITLE from the results; NEXT STAGE / NEXT LOOP and
// hiding the page keep it going.
let run = null; // { best, clear, offered, mark (the score at its last results / continue, for NEW RECORD) }
function trackBest() { if (run && game.score > run.best) run.best = game.score; }
// Record the run that just ended. Returns { rank, t } when it made the top RANK_MAX (the row is
// saved at once under the last used name; the name entry only renames it), else null.
function offerRun() {
  if (!run || run.offered) return null;
  trackBest();
  run.offered = true;
  const score = Math.floor(run.best);
  if (!(score > 0)) return null;
  const list = readRanking().slice();
  let i = list.findIndex((r) => r.score < score);
  if (i < 0) i = list.length;
  if (i >= RANK_MAX) return null;
  const t = Math.max(Date.now(), ...list.map((r) => r.t + 1)); // unique, and the newest
  list.splice(i, 0, { score, name: lastName(), ac: game.ac.id, paint: game.paint, stage: game.stage.n, loop: game.loop,
    clear: run.clear, cont: game.continues, date: today(), t });
  writeRanking(list);
  syncHi();
  const rank = rankMem.findIndex((r) => r.t === t) + 1;
  return rank > 0 ? { rank, t } : null;
}

// ---------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------
const ui = new UI();
const viewEl = $('view');
let renderer, scene, camera, composer, bloom, world, fx, shake, game, audio, models, input, view, gameMod;
let W = 0, H = 0;

function fail(msg) {
  ui.only('loading');
  const m = $('loading-msg');
  m.className = 'err';
  m.textContent = msg;
}

async function boot() {
  let worldMod, audioMod;
  try {
    [models, worldMod, gameMod, audioMod] = await Promise.all([
      import('./models.js'), import('./world.js'), import('./game.js'), import('./audio.js'),
    ]);
  } catch (err) {
    console.error(err);
    return fail('遊戲模組載入失敗，請重新整理頁面。');
  }
  audio = audioMod.audio;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance', alpha: false, stencil: false });
  } catch (err) {
    return fail('您的瀏覽器不支援 WebGL，無法執行 3D 遊戲。請改用新版 Chrome、Safari 或 Edge。');
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x0b1320, 1);
  viewEl.prepend(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (state === 'playing') pause(); });
  renderer.domElement.addEventListener('webglcontextrestored', () => { needsRender = true; });

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9fc4e0, 60, 140);
  camera = new THREE.PerspectiveCamera(40, 0.5, 1, 260);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3b3226, 1.1);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(-14, 30, 10);
  scene.add(hemi, sun, sun.target);

  const { World, GROUND_Y, LANES_X } = worldMod;
  world = new World({ scene, renderer, sun, hemi, quality: 'high' });
  fx = new FX(scene);
  shake = new Shake();
  view = new gameMod.View(camera, GROUND_Y);
  input = new Input(viewEl);
  input.bindStick($('stick'), document.querySelector('#stick .stick-base'), document.querySelector('#stick .stick-knob'));
  input.bindFocus($('btn-focus'));
  game = new gameMod.Game({ scene, world, fx, audio, ui, models, view, shake, settings, GROUND_Y, LANES_X });
  game.onEvent = onGameEvent;

  resize();
  game.initPools();
  applyLoadout();
  game.resetRun();
  ui.buildLegends();
  ui.setRoute(gameMod.STAGES);
  ui.buildHangar();
  setupComposer();
  applyQuality(true);
  await precompile();
  bindUI();
  applySettings();
  syncHi();
  showWallet();
  toTitle(true);
  requestAnimationFrame(frame);
  if (DEBUG) exposeDebug();
}

// Compile every pooled material once so the first enemy of each type doesn't hitch, for every
// stage world (stage 2/3 terrain too) at both qualities; stage 1 is restored afterwards. Programs
// differ by render target (the bloom path renders the scene into the composer's linear target,
// low quality straight to the canvas), and compile() also walks hidden objects (e.g. a stage's
// cloud deck), so compile for both targets rather than relying on the render() at the end.
async function precompile() {
  const shown = [];
  game.forEachPooled((o) => { o.mesh.visible = true; o.mesh.position.set(0, 0, -10); shown.push(o); });
  try {
    const compileFor = async (rt) => {
      renderer.setRenderTarget(rt);
      if (renderer.compileAsync) await renderer.compileAsync(scene, camera); else renderer.compile(scene, camera);
    };
    const compile = async () => {
      try { if (composer) await compileFor(composer.renderTarget1); await compileFor(null); } finally { renderer.setRenderTarget(null); }
    };
    const worlds = world.setStage ? [...new Set(gameMod.STAGES.map((s) => s.world))] : [null];
    for (const id of worlds) {
      if (id) { world.setStage(id); world.reset(0); }
      world.setQuality('low'); await compile();
      if (qualityLevel > 0) { world.setQuality('high'); await compile(); }
    }
    if (worlds.length > 1) { world.setStage(worlds[0]); world.reset(0); }
    world.setQuality(qualityLevel === 0 ? 'low' : 'high');
    render();
  } catch (err) { console.warn('precompile', err); }
  for (const o of shown) { o.mesh.visible = false; if (o.shadow) o.shadow.visible = false; }
}

// ---------------------------------------------------------------------------------
// rendering + quality
// ---------------------------------------------------------------------------------
let qualityLevel = 2; // 2 high, 1 medium, 0 low
let perf = { acc: 0, frames: 0, window: 0, strikes: 0 };
function setupComposer() {
  const samples = isTouch ? 0 : 4;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.55, 0.38, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}
function applyQuality(initial = false) {
  if (settings.quality === 'high') qualityLevel = 2;
  else if (settings.quality === 'low') qualityLevel = 0;
  else if (initial) qualityLevel = isTouch ? 1 : 2;
  setPixelRatio();
  world.setQuality(qualityLevel === 0 ? 'low' : 'high');
  fx.setQuality(qualityLevel === 0 ? 'low' : 'high');
  resize();
  perf = { acc: 0, frames: 0, window: 0, strikes: 0 };
}
function render() {
  if (qualityLevel > 0 && composer) composer.render();
  else renderer.render(scene, camera);
}
function trackPerf(rawDt) {
  if (settings.quality !== 'auto' || (state !== 'playing' && state !== 'title') || qualityLevel === 0) return;
  perf.acc += rawDt; perf.frames++;
  if (perf.acc >= 3) {
    const avg = perf.acc / perf.frames;
    perf.acc = 0; perf.frames = 0;
    if (avg > 1 / 48) perf.strikes++; else perf.strikes = 0;
    const calm = state === 'title' || (game.eb.n < 15 && !game.boss && game.phase === 'stage');
    if (perf.strikes >= 2 && calm) { qualityLevel--; perf.strikes = 0; applyQualityLevel(); }
  }
}
function setPixelRatio() {
  const dprCap = qualityLevel === 2 ? 2 : qualityLevel === 1 ? 1.25 : 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  if (composer) composer.setPixelRatio(renderer.getPixelRatio()); // the bloom path renders at the same resolution
}
function applyQualityLevel() {
  setPixelRatio();
  world.setQuality(qualityLevel === 0 ? 'low' : 'high');
  fx.setQuality(qualityLevel === 0 ? 'low' : 'high');
  resize();
}

const wideMQ = matchMedia('(min-width: 900px)'); // the side panels' CSS breakpoint (.side)
let lastIW = 0;
function resize() {
  const iw = window.innerWidth, ih = window.innerHeight;
  // a soft keyboard opening over a name box (in browsers that still shrink the page for it) keeps
  // the layout: the view would otherwise narrow to 0.64 × the space left above the keyboard
  if (document.body.classList.contains('typing') && iw === lastIW && renderer) return;
  lastIW = iw;
  const maxAspect = 0.64;
  const w = Math.min(iw, Math.round(ih * maxAspect));
  viewEl.style.width = w + 'px';
  viewEl.style.flex = '0 0 auto';
  const side = Math.max(0, (iw - w) / 2);
  const sides = side >= 220 && wideMQ.matches;
  for (const id of ['side-l', 'side-r']) {
    const el = $(id);
    el.style.width = side + 'px';
    if (id === 'side-l') el.style.left = '0'; else el.style.right = '0';
    el.hidden = !sides;
  }
  document.body.classList.toggle('sides', sides); // the in-view key legend (#keys) shows only without them
  W = w; H = ih;
  needsRender = true;
  if (!renderer) return;
  renderer.setSize(W, H, false);
  if (composer) composer.setSize(W, H);
  // keep the jet clear of the bottom HUD (lives/weapon/bomb button) and the thumb
  view.bottomPx = (touchUI ? 158 : 70) + (safeProbe.offsetHeight || 0); // touch: stay above the joystick
  view.fit(W, H);
  if (isPortraitBlocked() && (state === 'playing' || state === 'resuming')) pause();
}
window.addEventListener('resize', () => { resize(); });
if (landscapeLock.addEventListener) landscapeLock.addEventListener('change', () => resize());

// ---------------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------------
let state = 'loading';
let last = performance.now();
let t = 0;
let contT = 0, contShown = -1, pendingContinue = -1;
let wakeLock = null;
let fpsAvg = 60;

function frame(now) {
  requestAnimationFrame(frame);
  let rawDt = (now - last) / 1000;
  last = now;
  if (!(rawDt > 0)) rawDt = 1 / 60;
  rawDt = Math.min(rawDt, 0.05);
  t += rawDt;
  fpsAvg = fpsAvg * 0.95 + (1 / rawDt) * 0.05;
  input.pollGamepad();
  if (input.padUsed) { input.padUsed = false; setTouchUI(false); }
  fx.begin();

  if (input.take('mute')) toggleMute();

  if (state === 'playing') {
    if (input.take('pause')) { pause(); }
    else {
      if (input.take('bomb')) game.useBomb();
      // sub-step so fast bullets never tunnel on slow frames
      const steps = rawDt > 1 / 50 ? 2 : 1;
      for (let i = 0; i < steps; i++) game.update(rawDt / steps, input);
      trackPerf(rawDt);
      if (pendingContinue > 0) { pendingContinue -= rawDt; if (pendingContinue <= 0) { pendingContinue = -1; showContinue(); } }
    }
    updateHud();
    updateHints();
  } else if (state === 'title') {
    game.updateAttract(rawDt, t);
    trackPerf(rawDt);
    if (game.world.distance > 260) { game.world.reset(0); ui.flash(0.25); }
    if (panelOpen()) { if (input.take('pause')) closePanel(); }
    else if (!$('title').hidden && input.take('confirm')) startGame();
  } else if (state === 'continue') {
    if (!isPortraitBlocked()) contT -= rawDt;
    const n = Math.max(0, Math.ceil(contT) - 1);
    if (n !== contShown) { contShown = n; $('cont-num').textContent = String(n); if (n < 9) audio.play('select', { vol: 0.5 }); }
    if (input.take('confirm')) continueYes();
    else if (contT <= 0) gameOver();
    game.fx.update(rawDt, game.GROUND_Y, 0);
  } else if (state === 'results' || state === 'gameover') {
    world.update(rawDt, 3);
    fx.update(rawDt, game.GROUND_Y, 3);
    if (state === 'results' && $('res-menu').classList.contains('reserve') && (input.take('confirm') || input.take('tap') || input.take('padConfirm'))) { speedTally = true; }
    if (entry && input.take('pause')) commitEntry(true); // Esc away from the name box keeps the prefilled name
  } else if (state === 'record') {
    if (entry && input.take('pause')) commitEntry(true);
  } else if (state === 'paused') {
    if (input.take('pause')) { if (panelOpen()) closePanel(); else resume(); }
  } else if (state === 'resuming') {
    resumeT -= rawDt;
    const n = Math.max(1, Math.ceil(resumeT / 0.3));
    if (n !== resumeShown) { resumeShown = n; ui.banner(`<div class="h">${n}</div>`, 'count', 0); audio.play('select', { vol: 0.5 }); }
    if (input.take('pause')) { state = 'paused'; ui.clearBanner(); ui.only('pause'); focusFirst('pause'); }
    else if (resumeT <= 0) finishResume();
  }
  if (state !== 'playing') { menuNav(); input.clearEdges(); }

  shake.update(rawDt);
  camera.position.set(view.C.x + shake.x, view.C.y + shake.y, view.C.z + shake.z);
  const frozen = state === 'paused' || state === 'record';
  if (state === 'playing' || state === 'title' || state === 'results' || state === 'continue' || state === 'gameover') game.draw();
  else if (state === 'resuming' || (frozen && needsRender)) game.draw(false); // frozen frame keeps its bullets
  fx.end();
  ui.updatePopups(rawDt);
  ui.updateFlash(rawDt, reducedMotion);
  // while paused (or entering a name for the board) the scene is frozen: draw it once, then save the GPU/battery
  if (!frozen || needsRender) { render(); needsRender = false; }
}
let needsRender = true;
let resumeT = 0, resumeShown = 0;

// Keyboard / gamepad menu navigation: up/down (arrows, W/S, D-pad/stick) move the focus, left/right
// change the focused settings switch or slider, A activates, B goes back. A panel whose only focus
// stop is its OK button (HOW TO PLAY) scrolls instead, so the text under OK can be read. In the
// hangar, left/right (and Q/E, LB/RB) switch its tabs. In a name entry for the board, A confirms
// the name in the box and B keeps the prefilled one.
function menuNav() {
  const up = input.take('navUp') || input.take('up'), down = input.take('navDown') || input.take('down');
  const left = input.take('navLeft') || input.take('left'), right = input.take('navRight') || input.take('right');
  const ok = input.take('padConfirm'), back = input.take('padBack');
  const tabPrev = input.take('tabPrev'), tabNext = input.take('tabNext');
  if (!up && !down && !left && !right && !ok && !back && !tabPrev && !tabNext) return;
  if (entry && (back || (ok && document.activeElement === entry.input))) {
    if (back || !(performance.now() - entry.focusAt < ENTRY_GAP)) commitEntry(back);
    return;
  }
  if ((left || right || tabPrev || tabNext) && !$('hangar').hidden) {
    stepHangarTab(left || tabPrev ? -1 : 1);
    if (!up && !down && !ok && !back) return;
  }
  // focus stops: buttons, each switch group once (at its selected option), sliders and name boxes
  const stops = [];
  for (const el of document.querySelectorAll('.screen:not([hidden]) :is(.btn, .seg, input[type=range], input[type=text])')) {
    if (el.offsetParent === null) continue;
    stops.push(el.classList.contains('seg') ? el.querySelector('[aria-pressed="true"]') || el.querySelector('button') : el);
  }
  if (!stops.length) return;
  const ae = document.activeElement, seg = ae && ae.closest ? ae.closest('.seg') : null;
  const i = stops.findIndex((s) => s === ae || (seg && s.parentElement === seg));
  if (up || down) {
    const panel = stops.length === 1 && document.querySelector('.screen:not([hidden]) .panel');
    const room = panel ? panel.scrollHeight - panel.clientHeight : 0;
    if (room > 1 && (down ? panel.scrollTop < room - 1 : panel.scrollTop > 0)) {
      panel.scrollBy({ top: (down ? 1 : -1) * Math.round(panel.clientHeight * 0.4), behavior: reducedMotion ? 'auto' : 'smooth' });
    } else {
      const n = i < 0 ? 0 : (i + (down ? 1 : -1) + stops.length) % stops.length;
      if (n !== i) { stops[n].focus({ preventScroll: false }); audio.play('select', { vol: 0.4 }); }
    }
  }
  if ((left || right) && i >= 0) {
    const d = right ? 1 : -1, s = stops[i];
    if (seg) {
      const opts = [...seg.querySelectorAll('button')], o = opts[opts.indexOf(ae) + d];
      if (o) { o.click(); o.focus(); }
    } else if (s.type === 'range') {
      const v = Math.max(+s.min, Math.min(+s.max, +s.value + d * 10));
      if (v !== +s.value) { s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }
  if (ok) (i >= 0 ? stops[i] : stops[0]).click();
  if (back) { const b = document.querySelector('.screen:not([hidden]) [data-act="back"], .screen:not([hidden]) [data-act="resume"]'); if (b) b.click(); }
}

function updateHud() {
  const g = game, p = g.player;
  ui.setScore(g.score);
  if (g.score > hiScore) { hiScore = g.score; ui.setHi(hiScore); }
  if (run && g.score > run.best) run.best = g.score;
  ui.setLives(Math.max(0, g.lives));
  ui.setShield(g.up.shield > 0 ? (g.shield ? 1 : 0) : -1); // the shield upgrade's charge: ready / used / none
  ui.setBombs(g.bombs);
  ui.setWeapon(p.main, p.level, p.sub, p.subLevel);
  ui.setChain(g.medalChain, gameMod.MEDAL_VALUES[Math.min(g.medalChain, gameMod.MEDAL_VALUES.length - 1)]);
  ui.setRunMoney(g.runMoney);
}

let hintFlags = store.get('hints', { moved: false, bomb: false });
let hintState = { moveShown: false, bombShown: false };
function updateHints() {
  if (hintState.moveShown && !hintFlags.moved && input.dragTravel > 40) {
    hintFlags.moved = true; store.set('hints', hintFlags); ui.hideHint(true);
  }
  if (!hintFlags.bomb && !hintState.bombShown && game.eb.n >= 6 && game.bombs > 0 && game.player.alive) {
    hintState.bombShown = true; hintFlags.bomb = true; store.set('hints', hintFlags);
    ui.bombHint(touchUI);
  }
}
function panelOpen() { return !$('howto').hidden || !$('settings').hidden || !$('hangar').hidden || !$('ranking').hidden; }
function closePanel() {
  const fromHangar = !$('hangar').hidden, fromRanking = !$('ranking').hidden;
  audio.play('select');
  ui.only(backTo);
  if (fromHangar) leaveHangar();
  if (fromRanking) disarm($('btn-rclear'));
  // The pause menu gets its SETTINGS button back; the title always refocuses START, so the
  // blinking "PRESS ENTER ・ 按 Enter 出擊" stays true (Enter on HANGAR would reopen the hangar).
  if (backTo === 'pause' && panelOpener && panelOpener.closest('#pause')) focusEl(panelOpener);
  else focusFirst(backTo);
  panelOpener = null;
}

function toTitle(first = false) {
  state = 'title';
  audio.setMusicDuck(1);
  pendingContinue = -1;
  endRunMoney();
  commitEntry(false, false); // (a name box still open: keep what is in it)
  run = null;
  game.clearField();
  applyLoadout(); // the title fly-by shows the equipped jet in its paint (and the shield bubble)
  game.resetRun();
  game.player.mesh.visible = true;
  showShip();
  ui.setMission(gameMod.STAGES, 0);
  ui.hud(false);
  ui.hideHint();
  ui.clearBanner();
  ui.clearPopups();
  ui.boss(false);
  ui.danger(false);
  ui.only('title');
  syncHi();
  audio.music('title');
  releaseWake();
  if (!first) ui.flash(0.3);
  focusFirst('title');
  updateFocusNote();
}
// Start a stage. stage: 0-based index into STAGES. keepScore carries the run over (next stage /
// next loop); otherwise it is a new run with the equipped aircraft (the old run's CR banked first).
function startGame({ loop = 1, stage = 0, keepScore = false } = {}) {
  audio.init();
  audio.setMusicDuck(1);
  pendingContinue = -1;
  commitEntry(false, false);
  if (!keepScore) { endRunMoney(); applyLoadout(); run = { best: 0, clear: false, offered: false, mark: 0 }; }
  game.resetRun({ keepScore, loop, stage });
  const st = game.stage;
  state = 'playing';
  ui.only();
  ui.hud(true);
  ui.boss(false);
  ui.danger(false);
  ui.clearPopups();
  ui.flash(0.45);
  showShip();
  ui.setMission(gameMod.STAGES, game.stageIdx, loop);
  const k = loop <= 1 ? `STAGE ${st.n}` : game.stageIdx === 0 ? `LOOP ${loop} · 難度提升` : `STAGE ${st.n} · LOOP ${loop}`;
  ui.banner(`<div class="k">${k}</div><div class="h">${st.name}</div><div class="s">${st.zh}</div>`, '', 2800);
  audio.play(st.startSfx);
  audio.music(st.music);
  hintState = { moveShown: false, bombShown: false };
  if (loop === 1 && game.stageIdx === 0 && !keepScore && !(hintFlags.moved && touchUI)) {
    setTimeout(() => { if (state === 'playing') { hintState.moveShown = true; input.dragTravel = 0; ui.hint(touchUI); } }, 1200);
  }
  pushBackGuard();
  updateHud();
  requestWake();
  input.clearEdges();
}
function pause() {
  if (state !== 'playing' && state !== 'resuming') return;
  ui.clearBanner();
  state = 'paused';
  input.releaseStick();
  input.clearEdges(); // movement presses from play must not move the menu focus
  document.querySelectorAll('#pause [data-armed="1"]').forEach((b) => { b.dataset.armed = ''; restoreLabel(b); });
  ui.only('pause');
  audio.play('pause');
  audio.setMusicDuck(0.35);
  releaseWake();
  focusFirst('pause');
}
function resume() {
  if (state !== 'paused') return;
  if (isPortraitBlocked()) return;
  // short 3-2-1 so the thumb can get back to the joystick before the action restarts
  state = 'resuming';
  resumeT = 0.9; resumeShown = 0;
  ui.only();
  audio.setMusicDuck(1);
  audio.resume();
  input.clearEdges();
  pushBackGuard(); // a Back on the pause screen used up the run's entry
}
function finishResume() {
  state = 'playing';
  ui.clearBanner();
  input.clearEdges();
  last = performance.now();
  requestWake();
}
function showContinue() {
  if (state !== 'playing') return;
  state = 'continue';
  contT = 10; contShown = -1;
  ui.only('continue');
  audio.music(null);
  focusFirst('continue');
}
function continueYes() {
  if (state !== 'continue') return;
  saveHi();
  trackBest(); // (the board records the run's best score, not the one after the continue)
  // the score restarts at 0: keep this stage's points so far for the results screen
  const stats = game.stats;
  stats.stageCarry = (stats.stageCarry || 0) + Math.max(0, game.score - stats.stageScoreStart);
  game.continueRun();
  stats.stageScoreStart = 0;
  state = 'playing';
  ui.only();
  const st = game.stage;
  const tr = { boss: st.bossMusic, warning: null, bossdead: null, clear: null }[game.phase];
  audio.music(tr === undefined ? st.music : tr);
  audio.play('confirm');
  input.clearEdges();
}
function gameOver() {
  state = 'gameover';
  audio.setMusicDuck(1);
  const isNew = saveHi();
  bankMoney();
  const st = game.stage;
  $('go-stage').textContent = `STAGE ${st.n}${game.loop > 1 ? ' · LOOP ' + game.loop : ''} ${st.zh}`;
  $('go-score').textContent = fmt(game.score);
  $('go-hi').textContent = fmt(hiScore);
  // this stage's CR, like the results screen: CR from earlier stages was shown (and banked) there
  $('go-cr').textContent = '+' + fmt(Math.max(0, Math.floor(game.runMoney) - Math.floor(game.stats.moneyStart)));
  ui.setBonus($('go-bonus'), game.bonusPct);
  $('go-wallet').textContent = `${MONEY.label} ${fmt(readWallet().money)}`;
  $('go-new').hidden = !isNew;
  const rec = offerRun(); // the run ends here (a continue would have kept it going)
  ui.only('gameover');
  ui.hud(false);
  ui.boss(false);
  ui.danger(false);
  ui.clearBanner();
  audio.music('gameover');
  releaseWake();
  if (rec) showEntry($('go-entry'), rec, () => focusFirst('gameover'));
  else { $('go-entry').hidden = true; focusFirst('gameover'); }
}
// The HI on the results / GAME OVER screen and their NEW RECORD test, at a save point of the run
// (a stage's results, a continue, the game over). Memory only: the run's score reaches the stored
// HI through the board when the run ends (offerRun → syncHi). Returns true when the score beats
// the stored HI and this run's earlier save points (a continue zeroes the score in between).
function saveHi() {
  const best = Math.max(storedHi(), run ? run.mark : 0);
  const score = Math.floor(game.score);
  const isNew = score > best;
  if (run) run.mark = Math.max(run.mark, score);
  hiScore = Math.max(hiScore, best, score);
  ui.setHi(hiScore); // updateHud only shows a HI that the score passes during play
  return isNew;
}
let speedTally = false;
async function showResults() {
  state = 'results';
  const g = game, st = g.stats, meta = g.stage;
  const last = g.stageIdx >= gameMod.STAGES.length - 1;
  const stageScore = (st.stageCarry || 0) + Math.max(0, g.score - st.stageScoreStart);
  const pct = st.spawned ? st.killed / st.spawned : 1;
  const clearBonus = 50000 * g.loop * meta.n;
  const noMiss = st.deaths === 0 ? 100000 : 0;
  const bombBonus = g.bombs * 10000;
  const destroy = Math.round(pct * 100) * 500;
  const chainBonus = g.medalMaxChain * 1000;
  const total = clearBonus + noMiss + bombBonus + destroy + chainBonus;
  g.addScore(total); // bonus points earn CR like any other points
  // an extra life the bonus crosses into is awarded here and shown in the tally (in-play extends
  // show a banner, which would only ghost through this screen)
  const ext = g.checkExtends(true);
  const pts = pct * 100 + (st.deaths === 0 ? 30 : Math.max(0, 18 - st.deaths * 8)) + Math.min(20, g.medalMaxChain * 1.2);
  const rank = pts >= 128 ? 'S' : pts >= 108 ? 'A' : pts >= 88 ? 'B' : 'C';
  const isNew = saveHi();
  trackBest();
  if (last && run) run.clear = true;
  const earned = Math.floor(g.runMoney) - Math.floor(st.moneyStart); // this stage's CR (incl. the clear reward)
  bankMoney();
  updateHud();
  ui.hud(false);
  ui.clearBanner();
  ui.only('results');
  speedTally = false;
  const lines = [
    ['STAGE SCORE', '關卡得分', fmt(stageScore)],
    ['CLEAR BONUS', '過關獎勵', '+' + fmt(clearBonus)],
    ['DESTRUCTION ' + Math.round(pct * 100) + '%', '擊破率', '+' + fmt(destroy)],
    ['NO MISS', '無傷', noMiss ? '+' + fmt(noMiss) : '—'],
    ['BOMB × ' + g.bombs, '剩餘炸彈', '+' + fmt(bombBonus)],
    ['CHAIN × ' + g.medalMaxChain, '勳章連鎖', '+' + fmt(chainBonus)],
  ];
  if (ext) lines.push(['EXTEND', '戰機增加', '+' + ext, 'extend']);
  const zh = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  $('res-title').textContent = last ? 'ALL CLEAR' : `STAGE ${meta.n} CLEAR`;
  $('res-title').classList.toggle('all', last);
  $('res-sub').innerHTML = last
    ? `LOOP ${g.loop} COMPLETE <b>全 ${gameMod.STAGES.length} 關制霸</b>`
    : `${meta.name} <b>${meta.zh}</b>`;
  $('res-next').textContent = last ? '' : `NEXT ▸ STAGE ${meta.n + 1} ${gameMod.STAGES[g.stageIdx + 1].zh}`;
  if (last) {
    $('next-title').textContent = 'NEXT LOOP';
    $('next-label').textContent = `第${zh[g.loop + 1] || g.loop + 1}輪・難度提升`;
  } else {
    $('next-title').textContent = 'NEXT STAGE';
    $('next-label').textContent = '下一關';
  }
  audio.setMusicDuck(1);
  await ui.tally(lines, g.score, rank, isNew, () => speedTally, (kind, k) => {
    if (kind === 'line') { if (k === 'extend') audio.play('oneup'); else audio.play('select', { vol: 0.5 }); }
    else if (kind === 'total') audio.play('confirm');
    else if (kind === 'coin') audio.play('coin', { vol: 0.5, pitch: Math.round(k * 6) * 2 });
    else if (kind === 'coinEnd') audio.play('coin', { vol: 0.7, pitch: 12 });
    else if (kind === 'rank') audio.play('powerup');
    else if (kind === 'record') audio.play('oneup', ext ? { pitch: 5 } : undefined); // pitched up after an EXTEND row's own 1UP
  }, { earned, wallet: readWallet().money, bonus: g.bonusPct });
  if (state === 'results') focusFirst('results');
}
// Results → the next stage, or after the last stage the next loop from stage 1 (harder).
function nextStage() {
  const last = game.stageIdx >= gameMod.STAGES.length - 1;
  startGame(last ? { loop: game.loop + 1, stage: 0, keepScore: true } : { loop: game.loop, stage: game.stageIdx + 1, keepScore: true });
}

// --- leaderboard: run end, name entry, record screen -----------------------------------
// End the run in progress (QUIT / RESTART from the pause menu, TITLE from the results): offer it
// to the board — with the record screen first when it made the top RANK_MAX — then go on (next).
function endRun(next) {
  const rec = state === 'paused' || state === 'results' ? offerRun() : null;
  if (rec) showRecord(rec, next); else next();
}
// The record screen (a run that made the board ended without a GAME OVER): NEW RECORD / 第 n 名,
// the score and a name entry; confirming it goes on to the title or the new run.
function showRecord(rec, next) {
  state = 'record';
  needsRender = true;
  input.releaseStick();
  input.clearEdges();
  ui.hud(false);
  ui.boss(false);
  ui.danger(false);
  ui.clearBanner();
  ui.clearPopups();
  ui.recordScreen(rec.rank, rankMem[rec.rank - 1]);
  ui.only('record');
  releaseWake();
  showEntry($('rec-entry'), rec, next);
}
// A run that made the board gets a name entry (inside the GAME OVER screen, or on the record
// screen). Its row is already saved under the prefilled name (the last one used), so leaving the
// page here loses nothing; confirming only renames it. Enter / OK confirms the box, Esc / B keeps
// the prefilled name, and RETRY / TITLE with a name typed but not confirmed keep what is typed.
let entry = null; // { form, input, t, rank, prefill, done, focusAt }
// A submit this soon after the box took the focus is the tail of the press that opened it (Enter
// pressed twice on CONTINUE › NO), not a name being confirmed.
const ENTRY_GAP = 250;
function showEntry(form, rec, done) {
  const box = form.querySelector('.entry-name');
  entry = { form, input: box, t: rec.t, rank: rec.rank, prefill: lastName(), done, focusAt: -Infinity };
  box.value = entry.prefill;
  ui.showEntry(form, rec.rank);
  // keyboard / gamepad: the box has the focus (typing replaces the name, A confirms it); touch:
  // tapping the box brings up the soft keyboard
  if (!touchUI) setTimeout(() => { if (entry && entry.input === box) { box.focus({ preventScroll: true }); box.select(); entry.focusAt = performance.now(); } }, 30);
}
// keep: the prefilled name, not the box; then: go on (focus RETRY, the title, the new run).
function commitEntry(keep = false, then = true) {
  const e = entry;
  if (!e) return;
  entry = null;
  const name = (!keep && cleanName(e.input.value)) || e.prefill;
  const list = readRanking().slice(), row = list.find((r) => r.t === e.t);
  if (row) { list[list.indexOf(row)] = { ...row, name }; writeRanking(list); }
  store.set('rankName', name);
  if (document.activeElement === e.input) e.input.blur();
  ui.entryDone(e.form, e.rank, name);
  if (!then) return;
  audio.play('confirm');
  if (e.done) e.done();
}

function onGameEvent(ev) {
  switch (ev) {
    case 'warning':
      audio.music(null);
      audio.play('warning');
      ui.warning(true, game.stage.warn);
      ui.danger(true);
      break;
    case 'bossStart':
      ui.warning(false);
      ui.danger(false);
      ui.boss(true, game.stage.boss, game.stage.bossZh);
      audio.music(game.stage.bossMusic);
      break;
    case 'midboss':
      audio.play('lock', { vol: 0.6 });
      break;
    case 'extend':
      ui.banner('<div class="h">EXTEND!</div><div class="s">戰機 +1</div>', 'extend', 1600);
      break;
    case 'gameover':
      pendingContinue = 1.6;
      break;
    case 'clearBanner':
      ui.boss(false);
      ui.banner(`<div class="k">STAGE ${game.stage.n}</div><div class="h">MISSION COMPLETE</div><div class="s">任務完成</div>`, 'clear', 3000);
      audio.music('clear');
      break;
    case 'clear':
      showResults();
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------------
let backTo = 'title';
let panelOpener = null; // the pause-menu button that opened a panel gets the focus back
// A same-page history entry, so Android / browser Back closes a panel or pauses the run instead
// of leaving the game. Called from taps and key presses (user activation keeps the entry).
function pushBackGuard() {
  try { if (!history.state || !history.state.cb) history.pushState({ cb: 1 }, ''); } catch (_) { /* ignore */ }
}
// Destructive pause-menu actions (and purchases) need a second tap within ms (2 s). msg replaces
// the text of el (default: the button's <span>) until then; cls is added to el meanwhile.
// A second press sooner than CONFIRM_GAP after arming (a double-click, a double-tap) is ignored
// and leaves the button armed, so the confirm step can't be skipped by accident.
const CONFIRM_GAP = 400;
function confirmTwice(btn, msg = '再按一次確認', el = btn.querySelector('span'), cls = '', ms = 2000) {
  if (btn.dataset.armed === '1') {
    if (performance.now() - btn._armAt < CONFIRM_GAP) return false;
    btn.dataset.armed = ''; restoreLabel(btn); return true;
  }
  btn.dataset.armed = '1';
  btn._armAt = performance.now();
  btn._armEl = el; btn._armCls = cls;
  btn.dataset.label = el.textContent;
  el.textContent = msg;
  if (cls) el.classList.add(cls);
  audio.play('select');
  clearTimeout(btn._armT);
  btn._armT = setTimeout(() => { btn.dataset.armed = ''; restoreLabel(btn); }, ms);
  return false;
}
function restoreLabel(btn) {
  const el = btn._armEl || btn.querySelector('span');
  if (btn.dataset.label) el.textContent = btn.dataset.label;
  if (btn._armCls) el.classList.remove(btn._armCls);
  btn.dataset.label = ''; btn._armCls = '';
  clearTimeout(btn._armT);
}
function disarm(btn) { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; restoreLabel(btn); } }
function focusEl(el) { if (!touchUI && el) setTimeout(() => el.focus({ preventScroll: true }), 30); }
function focusFirst(id) { focusEl([...document.querySelectorAll(`#${id} .btn`)].find((b) => b.offsetParent !== null)); }
// focus: the element to focus in the panel (default: its first button)
function openPanel(id, opener = null, focus = null) {
  backTo = state === 'paused' ? 'pause' : 'title';
  panelOpener = opener;
  ui.only(id);
  audio.play('select');
  if (focus) focusEl(focus); else focusFirst(id);
  pushBackGuard(); // before the first run there is no entry yet: Back would leave the page
}

// --- wallet display + hangar -------------------------------------------------------
// Three tabs: 機體 (aircraft: buy / equip), 塗裝 (paints of the aircraft picked in 機體; only an
// owned aircraft can buy them) and 強化 (permanent upgrades, shared by every aircraft). The title
// fly-by is the preview: the picked aircraft (hangar.sel) in the paint being browsed (hangar.paint,
// which outside 塗裝 is that aircraft's own equipped paint).
const HANGAR_TABS = ['ship', 'paint', 'up'];
const hangar = { sel: null, tab: 'ship', paint: DEFAULT_PAINT, up: null }; // (tab: remembered for the session)
function showWallet() {
  ui.setWallet(walletMem.money);
  if (!$('hangar').hidden) ui.renderHangar(walletMem, hangar);
}
// The flown aircraft's name and paint colour (title label, side panel, lives icons, 集中 button).
function showShip(ac = game.ac, paint = game.paint) { ui.setShip(ac, paintOf(ac.id, paint)); }
function showEquipped() { const w = walletMem; showShip(shipDef(w.equipped), w.paint[w.equipped]); }
function openHangar(opener) {
  const w = readWallet();
  hangar.sel = w.equipped; hangar.paint = w.paint[w.equipped]; hangar.up = null; // (= the fly-by already)
  ui.renderHangar(w, hangar);
  openPanel('hangar', opener, hangarRow()); // focus the tab's current row: no preview swap
  $('hangar').scrollTop = 0; $('hangar').querySelector('.panel').scrollTop = 0;
}
// The row to focus in the current tab: the picked aircraft, the paint shown, the last upgrade.
function hangarRow() {
  if (hangar.tab === 'ship') return ui.hrow('ship:' + hangar.sel).b;
  if (hangar.tab === 'paint') { const r = ui.paintRow(hangar.paint); return r ? r.b : null; }
  return ui.hrow('up:' + (hangar.up || UPGRADES[0].id)).b;
}
function setHangarTab(tab, sound = false) {
  if (!HANGAR_TABS.includes(tab) || hangar.sel === null) return;
  const w = readWallet();
  disarmHangar();
  hangar.tab = tab;
  if (tab !== 'paint') hangar.paint = w.paint[hangar.sel]; // leaving 塗裝: the jet wears its own paint again
  game.setAircraft(hangar.sel, hangar.paint);
  ui.renderHangar(w, hangar);
  if (sound) audio.play('select', { vol: 0.4 });
  focusEl(hangarRow());
}
// ←→ / Q E / LB RB: the previous / next tab (wrapping round).
function stepHangarTab(d) { setHangarTab(HANGAR_TABS[(HANGAR_TABS.indexOf(hangar.tab) + d + HANGAR_TABS.length) % HANGAR_TABS.length], true); }
// Disarm every pending purchase (and clear row messages), or only the rows of one kind but `keep`.
function disarmHangar(kind = null, keep = null) {
  ui.eachHangarRow((r, key) => {
    if ((kind && r.kind !== kind) || (keep !== null && r.id === keep)) return;
    disarm(r.b);
    if (!kind) ui.hangarMsgClear(key);
  });
}
// Show a jet on the fly-by and highlight its row (focus, hover or tap).
function previewShip(id) {
  if (!shipDef(id) || $('hangar').hidden || state !== 'title' || hangar.tab !== 'ship') return;
  if (id === hangar.sel) return;
  const w = readWallet();
  disarmHangar('ship', id);
  hangar.sel = id; hangar.paint = w.paint[id];
  game.setAircraft(id, hangar.paint);
  ui.renderHangar(w, hangar);
  audio.play('select', { vol: 0.35 });
}
// The same for a paint of the picked aircraft.
function previewPaint(pid) {
  if ($('hangar').hidden || state !== 'title' || hangar.tab !== 'paint' || !paintOf(hangar.sel, pid)) return;
  if (pid === hangar.paint) return;
  disarmHangar('paint', pid);
  hangar.paint = pid;
  game.setAircraft(hangar.sel, pid);
  ui.renderHangar(readWallet(), hangar);
  audio.play('select', { vol: 0.35 });
}
// An upgrade row only gets highlighted (upgrades have nothing to preview).
function pickUpgrade(id) {
  if (!upDef(id) || $('hangar').hidden || hangar.tab !== 'up' || id === hangar.up) return;
  disarmHangar('up', id);
  hangar.up = id;
  ui.renderHangar(readWallet(), hangar);
  audio.play('select', { vol: 0.35 });
}
// Enter / click / tap on a row: owned → equip; affordable → confirm, then buy; else refuse.
function activateShip(btn) {
  const id = btn.dataset.ship, ac = shipDef(id), key = 'ship:' + id;
  if (!ac) return;
  previewShip(id);
  const w = readWallet();
  if (w.owned.includes(id)) {
    if (w.equipped === id) { audio.play('select'); ui.hangarMsg(key, '這架已是出擊機', 'good', 1200); return; }
    w.equipped = id;
    writeWallet(w);
    audio.play('equip');
    showEquipped();
    ui.hangarMsg(key, '已設為出擊機', 'good', 1400);
    return;
  }
  if (w.money < ac.price) { refuse(key, ac.price - w.money); return; }
  if (btn.dataset.armed !== '1') ui.hangarMsgClear(key); // (armed: the confirm text stays up)
  if (!confirmTwice(btn, `再按一次確認購買（購買後剩 ${MONEY.label} ${fmt(w.money - ac.price)}）`, ui.hrow(key).desc, 'msg', 3000)) return;
  const w2 = readWallet(); // storage may have changed meanwhile (another tab)
  if (w2.money < ac.price) { refuse(key, ac.price - w2.money); return; }
  if (!w2.owned.includes(id)) { w2.money -= ac.price; w2.owned.push(id); }
  w2.equipped = id;
  writeWallet(w2);
  audio.play('buy');
  ui.flash(0.2);
  ui.walletBump();
  showEquipped();
  ui.hangarMsg(key, '購買完成！已設為出擊機', 'good', 2200);
}
// A paint row: owned → wear it; affordable → confirm, then buy and wear it; else refuse. A paint is
// worn by its own aircraft whenever that one flies (the sortie aircraft is picked in 機體).
function activatePaint(btn) {
  const ac = shipDef(hangar.sel), pid = btn.dataset.paint, pt = ac && paintOf(ac.id, pid), key = 'paint:' + btn.dataset.slot;
  if (!pt) return;
  previewPaint(pid);
  const w = readWallet();
  if (!w.owned.includes(ac.id)) { refuse(key, 0, `先在「機體」買下${ac.zh}才能換塗裝`); return; }
  if (w.paints[ac.id].includes(pid)) {
    if (w.paint[ac.id] === pid) { audio.play('select'); ui.hangarMsg(key, '這個塗裝使用中', 'good', 1200); return; }
    w.paint[ac.id] = pid;
    writeWallet(w);
    audio.play('equip');
    showEquipped();
    ui.hangarMsg(key, '已換上這個塗裝', 'good', 1400);
    return;
  }
  if (w.money < pt.price) { refuse(key, pt.price - w.money); return; }
  if (btn.dataset.armed !== '1') ui.hangarMsgClear(key);
  if (!confirmTwice(btn, `再按一次確認購買（購買後剩 ${MONEY.label} ${fmt(w.money - pt.price)}）`, ui.hrow(key).desc, 'msg', 3000)) return;
  const w2 = readWallet();
  if (w2.money < pt.price && !w2.paints[ac.id].includes(pid)) { refuse(key, pt.price - w2.money); return; }
  if (!w2.paints[ac.id].includes(pid)) { w2.money -= pt.price; w2.paints[ac.id].push(pid); }
  w2.paint[ac.id] = pid;
  writeWallet(w2);
  audio.play('buy');
  ui.flash(0.2);
  ui.walletBump();
  showEquipped();
  ui.hangarMsg(key, '購買完成！已換上塗裝', 'good', 2200);
}
// An upgrade row: the next level, after a confirm; refused when short of CR, nothing past MAX.
// Upgrades count from the next run (game.setUpgrades); on the title the shield bubble shows at once.
function activateUpgrade(btn) {
  const u = upDef(btn.dataset.up), key = 'up:' + btn.dataset.up;
  if (!u) return;
  pickUpgrade(u.id);
  const w = readWallet(), lv = w.upgrades[u.id], max = u.prices.length;
  if (lv >= max) { audio.play('select'); ui.hangarMsg(key, '已達最高等級', 'good', 1200); return; }
  const price = u.prices[lv];
  if (w.money < price) { refuse(key, price - w.money); return; }
  if (btn.dataset.armed !== '1') ui.hangarMsgClear(key);
  if (!confirmTwice(btn, `再按一次確認（購買後剩 ${MONEY.label} ${fmt(w.money - price)}）`, ui.hrow(key).desc, 'msg', 3000)) return;
  const w2 = readWallet();
  if (w2.upgrades[u.id] !== lv) { ui.renderHangar(w2, hangar); ui.hangarMsg(key, '等級已變動，請再按一次', 'msg', 1600); return; } // (another tab bought it)
  if (w2.money < price) { refuse(key, price - w2.money); return; }
  w2.money -= price;
  w2.upgrades[u.id] = lv + 1;
  writeWallet(w2);
  game.setUpgrades(w2.upgrades);
  if (state === 'title') game.applyUpgrades(); // (the shield bubble on the fly-by)
  audio.play('buy');
  ui.flash(0.2);
  ui.walletBump();
  ui.hangarMsg(key, lv + 1 >= max ? '強化完成！已達最高等級' : `強化完成！Lv${lv + 1}・下一局生效`, 'good', 2200);
}
// text: the refusal (default: the CR still missing).
function refuse(key, short, text = '') {
  audio.play('deny');
  ui.hangarShake(key);
  ui.hangarMsg(key, text || `還差 ${MONEY.label} ${fmt(short)}`, 'bad', 1600);
}
// Closing the hangar puts the equipped jet (in its paint) back on the fly-by.
function leaveHangar() {
  disarmHangar();
  hangar.sel = null; hangar.up = null;
  if (state === 'title') applyLoadout();
  showEquipped();
}

// --- ranking panel ------------------------------------------------------------------
function openRanking(opener) {
  ui.renderRanking(readRanking());
  ui.rankNote();
  openPanel('ranking', opener, $('rank-ok')); // (not CLEAR: Enter must not arm it)
  $('ranking').querySelector('.panel').scrollTop = 0;
}
// Clears the board and the HI-SCORE, after a second press.
function clearRecords(btn) {
  if (!readRanking().length && !(hiScore > 0)) { audio.play('deny'); ui.rankNote('目前沒有紀錄', 'bad', 1400); return; }
  if (btn.dataset.armed !== '1') ui.rankNote();
  if (!confirmTwice(btn, '再按一次「清除」：刪除全部紀錄與最高分', $('rank-note'), 'arm', 3000)) return;
  writeRanking([]);
  store.set('hi', 0);
  hiScore = 0;
  ui.setHi(0);
  ui.renderRanking(rankMem);
  audio.play('confirm');
  ui.rankNote('已清除全部紀錄', 'good', 1800);
}
function bindUI() {
  // first gesture unlocks audio
  const unlock = () => { audio.init(); if (state === 'title') audio.music('title'); };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    audio.init();
    switch (act) {
      case 'start': audio.play('confirm'); startGame(); break;
      case 'howto': openPanel('howto', b); break;
      case 'settings': openPanel('settings', b); break;
      case 'hangar': if (state === 'title') openHangar(b); break;
      case 'ranking': if (state === 'title') openRanking(b); break;
      case 'htab': if (state === 'title' && !$('hangar').hidden) setHangarTab(b.dataset.tab, true); break;
      case 'ship': if (state === 'title' && !$('hangar').hidden) activateShip(b); break;
      case 'paint': if (state === 'title' && !$('hangar').hidden) activatePaint(b); break;
      case 'up': if (state === 'title' && !$('hangar').hidden) activateUpgrade(b); break;
      case 'rank-clear': if (state === 'title' && !$('ranking').hidden) clearRecords(b); break;
      case 'back': closePanel(); break;
      case 'resume': resume(); break;
      // (both bank the run's CR and offer the run to the board, which keeps HI-SCORE)
      case 'restart': if (!confirmTwice(b)) break; audio.play('confirm'); endRun(() => startGame()); break;
      case 'quit':
        if (state === 'paused' && !confirmTwice(b)) break;
        audio.play('select');
        endRun(() => toTitle());
        break;
      case 'retry': audio.play('confirm'); startGame(); break;
      case 'cont-yes': continueYes(); break;
      case 'cont-no': gameOver(); break;
      case 'next': if (state === 'results') { audio.play('confirm'); nextStage(); } break;
      default: break;
    }
  });
  // hangar: moving the focus (arrows, gamepad), hovering with the mouse or tapping previews a jet
  // or a paint (and highlights an upgrade)
  const hrow = (b) => {
    if (b.dataset.act === 'ship') previewShip(b.dataset.ship);
    else if (b.dataset.act === 'paint') previewPaint(b.dataset.paint);
    else if (b.dataset.act === 'up') pickUpgrade(b.dataset.up);
  };
  const hp = $('hangar');
  hp.addEventListener('focusin', (e) => { const b = e.target.closest('.hrow'); if (b) hrow(b); });
  hp.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const b = e.target.closest('.hrow'); if (b) hrow(b);
  });
  $('btn-pause').addEventListener('click', (e) => { e.stopPropagation(); pause(); });
  const bombBtn = $('btn-bomb');
  bombBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (state === 'playing') game.useBomb(); });

  // settings controls
  const seg = (id, key, conv = (v) => v) => {
    const el = $(id);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      settings[key] = conv(b.dataset.v);
      applySettings(); audio.play('select');
    });
  };
  seg('set-quality', 'quality');
  seg('set-mute', 'muted', (v) => v === 'on');
  seg('set-shake', 'shake', (v) => v === 'on');
  seg('set-haptics', 'haptics', (v) => v === 'on');
  seg('set-touch', 'touchSens', (v) => Number(v));
  $('set-music').addEventListener('input', (e) => { settings.music = e.target.value / 100; applySettings(); });
  $('set-sfx').addEventListener('input', (e) => { settings.sfx = e.target.value / 100; applySettings(); });
  $('set-sfx').addEventListener('change', () => audio.play('item'));

  // Back: pauses a run, or closes a panel. Only a run keeps an entry after that (a panel over
  // the pause menu); at the title the next Back leaves the page, as expected.
  window.addEventListener('popstate', () => {
    if (state === 'playing' || state === 'resuming') { pause(); pushBackGuard(); }
    else if (panelOpen()) { const inRun = backTo === 'pause'; closePanel(); if (inRun) pushBackGuard(); }
    else if (state === 'record' && entry) commitEntry(true);
  });
  // name entries for the board: Enter (or OK) submits the form, Esc keeps the prefilled name.
  // body.typing (touch): no layout change or rotate hint for the soft keyboard meanwhile.
  for (const f of document.querySelectorAll('form.entry')) {
    const box = f.querySelector('.entry-name');
    f.addEventListener('submit', (e) => { e.preventDefault(); if (entry && entry.form === f && !(performance.now() - entry.focusAt < ENTRY_GAP)) commitEntry(); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && entry && entry.form === f) { e.preventDefault(); commitEntry(true); }
    });
    // the name is selected when the box gets the focus, so typing replaces it (a tap puts the caret
    // after the focus event: select once it has landed)
    box.addEventListener('focus', () => { document.body.classList.toggle('typing', touchUI); setTimeout(() => { if (document.activeElement === box) box.select(); }, 0); });
    box.addEventListener('blur', () => { document.body.classList.remove('typing'); resize(); });
  }
  // (hiding the page keeps the run going: its CR is banked, its score waits for the board)
  window.addEventListener('pagehide', () => { bankMoney(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state === 'playing' || state === 'resuming') pause(); bankMoney(); audio.suspend(); }
    else if (state !== 'paused') audio.resume();
  });
  window.addEventListener('blur', () => { if (state === 'playing' || state === 'resuming') pause(); updateFocusNote(); });
  window.addEventListener('focus', updateFocusNote);
}
// Embedded pages (e.g. an iframe preview) don't get key presses until clicked once; say so on the title.
function updateFocusNote() { $('focus-note').hidden = document.hasFocus(); }
// M: mute / unmute everything; saved like any setting and shown in SETTINGS.
function toggleMute() {
  settings.muted = !settings.muted;
  applySettings();
  ui.toast(settings.muted ? '靜音 ON ・ 按 M 恢復聲音' : '靜音 OFF');
}
let lastQualitySetting = settings.quality;
function applySettings() {
  const setSeg = (id, v) => { for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); };
  setSeg('set-quality', settings.quality);
  setSeg('set-mute', settings.muted ? 'on' : 'off');
  setSeg('set-shake', settings.shake ? 'on' : 'off');
  setSeg('set-haptics', settings.haptics ? 'on' : 'off');
  setSeg('set-touch', settings.touchSens);
  $('set-music').value = Math.round(settings.music * 100);
  $('set-sfx').value = Math.round(settings.sfx * 100);
  audio.setMuted(!!settings.muted);
  audio.setMusicVolume(settings.music);
  audio.setSfxVolume(settings.sfx);
  shake.enabled = settings.shake;
  const prev = qualityLevel;
  if (settings.quality === 'high') qualityLevel = 2;
  else if (settings.quality === 'low') qualityLevel = 0;
  else if (settings.quality === 'auto' && lastQualitySetting !== 'auto') { qualityLevel = isTouch ? 1 : 2; perf = { acc: 0, frames: 0, window: 0, strikes: 0 }; }
  lastQualitySetting = settings.quality;
  if (renderer && prev !== qualityLevel) applyQualityLevel();
  store.set('settings', settings);
}

async function requestWake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (_) { wakeLock = null; }
}
function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (_) { /* ignore */ } wakeLock = null; }

// ---------------------------------------------------------------------------------
// debug hooks (only with #debug in the URL)
// ---------------------------------------------------------------------------------
function exposeDebug() {
  window.__cb = {
    THREE, game, world, view, fx, renderer, audio, input,
    get state() { return state; },
    get fps() { return fpsAvg; },
    get quality() { return qualityLevel; },
    // start({ stage, loop }) — stage is the stage NUMBER (1..3, like STAGE_META.n); start(2) = loop 2
    start(o = {}) {
      if (typeof o === 'number') o = { loop: o };
      startGame({ loop: Math.max(1, o.loop | 0 || 1), stage: Math.max(1, o.stage | 0 || 1) - 1, keepScore: !!o.keepScore });
    },
    // stage(n): play stage n now (keeps the run when one is in progress, else a new run)
    stage(n = 1) {
      const inRun = ['playing', 'paused', 'resuming', 'results', 'continue'].includes(state);
      startGame({ loop: game.loop || 1, stage: Math.max(1, n | 0) - 1, keepScore: inRun });
      return game.stage.n;
    },
    // money(n): set the wallet balance; ship(id, paint): own + equip an aircraft (and a paint of it);
    // paint(pid): own + equip a paint of the equipped aircraft; upgrades({ id: level }): set the
    // levels (all persisted; upgrades count from the next run)
    money(n) { const w = readWallet(); w.money = n; writeWallet(w); return walletMem.money; },
    ship(id, paint) {
      if (!shipDef(id)) return null;
      const w = readWallet();
      if (!w.owned.includes(id)) w.owned.push(id);
      w.equipped = id;
      if (paint !== undefined && paintOf(id, paint)) { if (!w.paints[id].includes(paint)) w.paints[id].push(paint); w.paint[id] = paint; }
      writeWallet(w);
      game.setAircraft(id, walletMem.paint[id]); showShip();
      return id;
    },
    paint(pid) { const w = readWallet(); return this.ship(w.equipped, pid) && walletMem.paint[w.equipped]; },
    upgrades(levels) {
      const w = readWallet();
      w.upgrades = { ...w.upgrades, ...levels };
      writeWallet(w);
      game.setUpgrades(walletMem.upgrades);
      if (state === 'title') game.applyUpgrades();
      return { ...walletMem.upgrades };
    },
    wallet: () => JSON.parse(JSON.stringify(readWallet())),
    bank: () => bankMoney(),
    get runBanked() { return runBanked; },
    // the board and the run being tracked for it
    ranking: () => JSON.parse(JSON.stringify(readRanking())),
    get run() { return run && { ...run }; },
    get entry() { return entry && { rank: entry.rank, t: entry.t, prefill: entry.prefill, value: entry.input.value, form: entry.form.id }; },
    get hangar() { return { ...hangar }; },
    god(on = true) { game.player.invuln = on ? 1e9 : 0; },
    jump(d) {
      // fast-forward the current stage to distance d (skips earlier events)
      const st = game.stage;
      game.clearField();
      game.world.reset(d);
      game.phase = 'stage'; game.scrollTarget = st.scroll; game.boss = null; game.midboss = null;
      game.midbossDone = d > st.midbossAt; game.warned = false;
      game.skipTo(d);
      ui.warning(false); ui.danger(false);
    },
    power(level = 8, main = 'red', sub = 'H', subLevel = 4) { Object.assign(game.player, { level, main, sub, subLevel }); },
    killAll() { for (const e of game.enemies) { if (e.parts) for (const p of e.parts) game.damagePart(e, p, 1e6); game.damageEnemy(e, 1e6); } },
    info() {
      return { state, fps: Math.round(fpsAvg), d: Math.round(world.distance), phase: game.phase, enemies: game.enemies.length,
        bullets: game.eb.n, shots: game.ps.n, particles: fx.p.n, score: game.score, lives: game.lives, bombs: game.bombs,
        stage: game.stage.n, stageIdx: game.stageIdx, loop: game.loop, aircraft: game.ac.id, paint: game.paint, continues: game.continues,
        up: { ...game.up }, shield: game.shield,
        runMoney: Math.floor(game.runMoney), banked: runBanked, money: walletMem.money,
        calls: renderer.info.render.calls, tris: renderer.info.render.triangles, quality: qualityLevel };
    },
    pause, resume, toTitle,
  };
}

boot().catch((err) => { console.error(err); fail('啟動時發生錯誤：' + (err && err.message ? err.message : err)); });
