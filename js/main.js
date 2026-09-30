// main.js — boot, renderer + post-processing, adaptive quality, game-flow state machine, menus.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FX, Shake } from './fx.js';
import { Input } from './input.js';
import { UI, fmt } from './ui.js';
import { AIRCRAFT_BY_ID, DEFAULT_AIRCRAFT, MONEY } from './defs.js';

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
  if (/^(Arrow|Key[WASDXKP]$|Space|Shift|Escape|Enter)/.test(e.code)) setTouchUI(false);
  // A held Enter must not auto-repeat a focused button's click: its repeats would confirm a
  // purchase (or QUIT / RESTART) that the first press only armed.
  if (e.repeat && (e.code === 'Enter' || e.code === 'NumpadEnter') && e.target.closest && e.target.closest('button')) e.preventDefault();
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
const settings = Object.assign({ music: 0.7, sfx: 0.8, quality: 'auto', shake: !reducedMotion, haptics: true, touchSens: 1 }, store.get('settings', {}));
if (![0.85, 1, 1.2].includes(settings.touchSens)) settings.touchSens = 1; // old drag-sensitivity values
let hiScore = Number(store.get('hi', 0)) || 0;

// Wallet + hangar: store 'hangar' → { money, owned: [aircraft ids], equipped }. Always sanitised
// (bolt always owned, equipped must be owned, money a finite whole number ≥ 0). Like saveHi(),
// every change re-reads storage first so two tabs can't overwrite each other's CR. If storage
// is unavailable (or a write fails) the wallet keeps working in memory for this session.
const MONEY_MAX = 999999999;
// Own-property lookup, so a hand-edited save naming 'constructor' or 'toString' is not an aircraft.
const shipDef = (id) => (Object.prototype.hasOwnProperty.call(AIRCRAFT_BY_ID, id) ? AIRCRAFT_BY_ID[id] : null);
function cleanWallet(w) {
  const out = { money: 0, owned: [DEFAULT_AIRCRAFT], equipped: DEFAULT_AIRCRAFT };
  if (!w || typeof w !== 'object') return out;
  const m = Math.floor(Number(w.money));
  if (Number.isFinite(m) && m > 0) out.money = Math.min(m, MONEY_MAX);
  if (Array.isArray(w.owned)) for (const id of w.owned) if (shipDef(id) && !out.owned.includes(id)) out.owned.push(id);
  if (out.owned.includes(w.equipped)) out.equipped = w.equipped;
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
  game = new gameMod.Game({ scene, world, fx, audio, ui, models, view, shake, settings, GROUND_Y, LANES_X });
  game.onEvent = onGameEvent;

  resize();
  game.initPools();
  game.setAircraft(readWallet().equipped);
  game.resetRun();
  ui.buildLegends();
  ui.setRoute(gameMod.STAGES);
  ui.buildHangar();
  setupComposer();
  applyQuality(true);
  await precompile();
  bindUI();
  applySettings();
  ui.setHi(hiScore);
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
function resize() {
  const iw = window.innerWidth, ih = window.innerHeight;
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

  if (input.take('mute')) { audio.setMuted(!audio.muted); }

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
  if (state === 'playing' || state === 'title' || state === 'results' || state === 'continue' || state === 'gameover') game.draw();
  else if (state === 'resuming' || (state === 'paused' && needsRender)) game.draw(false); // frozen frame keeps its bullets
  fx.end();
  ui.updatePopups(rawDt);
  ui.updateFlash(rawDt, reducedMotion);
  // while paused the scene is frozen: draw it once, then save the GPU/battery
  if (state !== 'paused' || needsRender) { render(); needsRender = false; }
}
let needsRender = true;
let resumeT = 0, resumeShown = 0;

// Gamepad menu navigation: D-pad/stick moves focus, A activates, B goes back.
function menuNav() {
  const up = input.take('navUp') || input.take('up'), down = input.take('navDown') || input.take('down');
  const ok = input.take('padConfirm'), back = input.take('padBack');
  if (!up && !down && !ok && !back) return;
  const btns = [...document.querySelectorAll('.screen:not([hidden]) .btn')].filter((b) => b.offsetParent !== null);
  if (!btns.length) return;
  const i = btns.indexOf(document.activeElement);
  if (up || down) { const n = i < 0 ? 0 : (i + (down ? 1 : -1) + btns.length) % btns.length; btns[n].focus({ preventScroll: false }); audio.play('select', { vol: 0.4 }); }
  if (ok) (i >= 0 ? btns[i] : btns[0]).click();
  if (back) { const b = document.querySelector('.screen:not([hidden]) [data-act="back"], .screen:not([hidden]) [data-act="resume"]'); if (b) b.click(); }
}

function updateHud() {
  const g = game, p = g.player;
  ui.setScore(g.score);
  if (g.score > hiScore) { hiScore = g.score; ui.setHi(hiScore); }
  ui.setLives(Math.max(0, g.lives));
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
function panelOpen() { return !$('howto').hidden || !$('settings').hidden || !$('hangar').hidden; }
function closePanel() {
  const fromHangar = !$('hangar').hidden;
  audio.play('select');
  ui.only(backTo);
  if (fromHangar) leaveHangar();
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
  game.clearField();
  game.setAircraft(readWallet().equipped); // the title fly-by shows the equipped jet
  game.resetRun();
  game.player.mesh.visible = true;
  ui.setShip(game.ac);
  ui.setMission(gameMod.STAGES, 0);
  ui.hud(false);
  ui.hideHint();
  ui.clearBanner();
  ui.clearPopups();
  ui.boss(false);
  ui.danger(false);
  ui.only('title');
  ui.setHi(hiScore);
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
  if (!keepScore) { endRunMoney(); game.setAircraft(readWallet().equipped); }
  game.resetRun({ keepScore, loop, stage });
  const st = game.stage;
  state = 'playing';
  ui.only();
  ui.hud(true);
  ui.boss(false);
  ui.danger(false);
  ui.clearPopups();
  ui.flash(0.45);
  ui.setShip(game.ac);
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
  $('go-wallet').textContent = `${MONEY.label} ${fmt(readWallet().money)}`;
  $('go-new').hidden = !isNew;
  ui.only('gameover');
  ui.hud(false);
  ui.boss(false);
  ui.danger(false);
  ui.clearBanner();
  audio.music('gameover');
  releaseWake();
  focusFirst('gameover');
}
// Persist the best score seen (including runs that were continued, which reset the score).
// Returns true when this run's current score is a new record.
function saveHi() {
  const best = Number(store.get('hi', 0)) || 0;
  const cand = Math.floor(Math.max(hiScore, game.score));
  const isNew = game.score > best;
  if (cand > best) store.set('hi', cand);
  hiScore = Math.max(cand, best);
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
  }, { earned, wallet: readWallet().money });
  if (state === 'results') focusFirst('results');
}
// Results → the next stage, or after the last stage the next loop from stage 1 (harder).
function nextStage() {
  const last = game.stageIdx >= gameMod.STAGES.length - 1;
  startGame(last ? { loop: game.loop + 1, stage: 0, keepScore: true } : { loop: game.loop, stage: game.stageIdx + 1, keepScore: true });
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
function focusFirst(id) { focusEl(document.querySelector(`#${id} .btn`)); }
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
function showWallet() {
  ui.setWallet(walletMem.money);
  if (!$('hangar').hidden) ui.renderHangar(walletMem, hangarSel);
}
let hangarSel = null; // the aircraft previewed on the title fly-by while the hangar is open
function openHangar(opener) {
  const w = readWallet();
  hangarSel = w.equipped;
  openPanel('hangar', opener, ui.ships[w.equipped] && ui.ships[w.equipped].b); // focus the equipped row: no preview swap
  $('ships').scrollTop = 0;
  ui.renderHangar(w, hangarSel);
}
// Show a jet on the fly-by and highlight its row (focus, hover or tap).
function previewShip(id) {
  if (!shipDef(id) || $('hangar').hidden || state !== 'title') return;
  if (id === hangarSel) return;
  for (const k in ui.ships) if (k !== id) disarm(ui.ships[k].b);
  hangarSel = id;
  game.setAircraft(id);
  ui.renderHangar(readWallet(), id);
  audio.play('select', { vol: 0.35 });
}
// Enter / click / tap on a row: owned → equip; affordable → confirm, then buy; else refuse.
function activateShip(btn) {
  const id = btn.dataset.ship, ac = shipDef(id);
  if (!ac) return;
  previewShip(id);
  const w = readWallet();
  if (w.owned.includes(id)) {
    if (w.equipped === id) { audio.play('select'); ui.hangarMsg(id, '這架已是出擊機', 'good', 1200); return; }
    w.equipped = id;
    writeWallet(w);
    audio.play('equip');
    ui.setShip(ac);
    ui.hangarMsg(id, '已設為出擊機', 'good', 1400);
    return;
  }
  if (w.money < ac.price) { refuse(id, ac.price - w.money); return; }
  if (btn.dataset.armed !== '1') ui.hangarMsgClear(id); // (armed: the confirm text stays up)
  if (!confirmTwice(btn, `再按一次確認購買（購買後剩 ${MONEY.label} ${fmt(w.money - ac.price)}）`, ui.ships[id].desc, 'msg', 3000)) return;
  const w2 = readWallet(); // storage may have changed meanwhile (another tab)
  if (w2.money < ac.price) { refuse(id, ac.price - w2.money); return; }
  w2.money -= ac.price;
  if (!w2.owned.includes(id)) w2.owned.push(id);
  w2.equipped = id;
  writeWallet(w2);
  audio.play('buy');
  ui.flash(0.2);
  ui.walletBump();
  ui.setShip(ac);
  ui.hangarMsg(id, `購買完成！已設為出擊機`, 'good', 2200);
}
function refuse(id, short) {
  audio.play('deny');
  ui.hangarShake(id);
  ui.hangarMsg(id, `還差 ${MONEY.label} ${fmt(short)}`, 'bad', 1600);
}
// Closing the hangar puts the equipped jet back on the fly-by.
function leaveHangar() {
  for (const k in ui.ships) { disarm(ui.ships[k].b); ui.hangarMsgClear(k); }
  hangarSel = null;
  if (state === 'title') game.setAircraft(readWallet().equipped);
  ui.setShip(game.ac);
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
      case 'ship': if (state === 'title' && !$('hangar').hidden) activateShip(b); break;
      case 'back': closePanel(); break;
      case 'resume': resume(); break;
      case 'restart': if (!confirmTwice(b)) break; audio.play('confirm'); if (game.score > 0) saveHi(); startGame(); break; // (banks the run's CR)
      case 'quit': if (state === 'paused' && !confirmTwice(b)) break; audio.play('select'); if (game.score > 0) saveHi(); toTitle(); break;
      case 'retry': audio.play('confirm'); startGame(); break;
      case 'cont-yes': continueYes(); break;
      case 'cont-no': gameOver(); break;
      case 'next': if (state === 'results') { audio.play('confirm'); nextStage(); } break;
      default: break;
    }
  });
  // hangar: moving the focus (arrows, gamepad), hovering with the mouse or tapping previews a jet
  const ships = $('ships');
  ships.addEventListener('focusin', (e) => { const b = e.target.closest('.ship'); if (b) previewShip(b.dataset.ship); });
  ships.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const b = e.target.closest('.ship'); if (b) previewShip(b.dataset.ship);
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
  });
  window.addEventListener('pagehide', () => { bankMoney(); if (game.score > 0) saveHi(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state === 'playing' || state === 'resuming') pause(); bankMoney(); if (state === 'paused' && game.score > 0) saveHi(); audio.suspend(); }
    else if (state !== 'paused') audio.resume();
  });
  window.addEventListener('blur', () => { if (state === 'playing' || state === 'resuming') pause(); updateFocusNote(); });
  window.addEventListener('focus', updateFocusNote);
}
// Embedded pages (e.g. an iframe preview) don't get key presses until clicked once; say so on the title.
function updateFocusNote() { $('focus-note').hidden = document.hasFocus(); }
let lastQualitySetting = settings.quality;
function applySettings() {
  const setSeg = (id, v) => { for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); };
  setSeg('set-quality', settings.quality);
  setSeg('set-shake', settings.shake ? 'on' : 'off');
  setSeg('set-haptics', settings.haptics ? 'on' : 'off');
  setSeg('set-touch', settings.touchSens);
  $('set-music').value = Math.round(settings.music * 100);
  $('set-sfx').value = Math.round(settings.sfx * 100);
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
    // money(n): set the wallet balance; ship(id): own + equip an aircraft (both persisted)
    money(n) { const w = readWallet(); w.money = n; writeWallet(w); return walletMem.money; },
    ship(id) {
      if (!shipDef(id)) return null;
      const w = readWallet();
      if (!w.owned.includes(id)) w.owned.push(id);
      w.equipped = id;
      writeWallet(w);
      game.setAircraft(id); ui.setShip(game.ac);
      return id;
    },
    wallet: () => JSON.parse(JSON.stringify(readWallet())),
    bank: () => bankMoney(),
    get runBanked() { return runBanked; },
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
        stage: game.stage.n, stageIdx: game.stageIdx, loop: game.loop, aircraft: game.ac.id, continues: game.continues,
        runMoney: Math.floor(game.runMoney), banked: runBanked, money: walletMem.money,
        calls: renderer.info.render.calls, tris: renderer.info.render.triangles, quality: qualityLevel };
    },
    pause, resume, toTitle,
  };
}

boot().catch((err) => { console.error(err); fail('啟動時發生錯誤：' + (err && err.message ? err.message : err)); });
