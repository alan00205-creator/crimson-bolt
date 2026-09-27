// main.js — boot, renderer + post-processing, adaptive quality, game-flow state machine, menus.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FX, Shake } from './fx.js';
import { Input } from './input.js';
import { UI, fmt } from './ui.js';

window.__cbBooted = true;
clearTimeout(window.__cbBootTimer);

const $ = (id) => document.getElementById(id);
const DEBUG = /debug/.test(location.hash);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const landscapeLock = matchMedia('(orientation: landscape) and (max-height: 500px)');
const safeProbe = document.createElement('div');
safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
document.body.appendChild(safeProbe);
const isPortraitBlocked = () => isTouch && landscapeLock.matches;

// ---------------------------------------------------------------------------------
// persistence (never required to work)
// ---------------------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem('crimsonbolt.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('crimsonbolt.' + k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
};
const settings = Object.assign({ music: 0.7, sfx: 0.8, quality: 'auto', shake: !reducedMotion, haptics: true, touchSens: 1 }, store.get('settings', {}));
let hiScore = Number(store.get('hi', 0)) || 0;

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
  let worldMod;
  try {
    [models, worldMod, gameMod, { audio }] = await Promise.all([
      import('./models.js'), import('./world.js'), import('./game.js'), import('./audio.js'),
    ]);
  } catch (err) {
    console.error(err);
    return fail('遊戲模組載入失敗，請重新整理頁面。');
  }
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
  game = new gameMod.Game({ scene, world, fx, audio, ui, models, view, shake, settings, GROUND_Y, LANES_X });
  game.onEvent = onGameEvent;

  resize();
  game.initPools();
  game.resetRun();
  setupComposer();
  applyQuality(true);
  await precompile();
  bindUI();
  applySettings();
  ui.setHi(hiScore);
  toTitle(true);
  requestAnimationFrame(frame);
  if (DEBUG) exposeDebug();
}

// Compile every pooled material once so the first enemy of each type doesn't hitch.
async function precompile() {
  const shown = [];
  game.forEachPooled((o) => { o.mesh.visible = true; o.mesh.position.set(0, 0, -10); shown.push(o); });
  try {
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
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
  const dprCap = qualityLevel === 2 ? 2 : qualityLevel === 1 ? 1.5 : 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
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
    if (perf.strikes >= 2) { qualityLevel--; perf.strikes = 0; applyQualityLevel(); }
  }
}
function applyQualityLevel() {
  const dprCap = qualityLevel === 2 ? 2 : qualityLevel === 1 ? 1.5 : 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  world.setQuality(qualityLevel === 0 ? 'low' : 'high');
  fx.setQuality(qualityLevel === 0 ? 'low' : 'high');
  resize();
}

function resize() {
  const iw = window.innerWidth, ih = window.innerHeight;
  const maxAspect = 0.64;
  const w = Math.min(iw, Math.round(ih * maxAspect));
  viewEl.style.width = w + 'px';
  viewEl.style.flex = '0 0 auto';
  const side = Math.max(0, (iw - w) / 2);
  for (const id of ['side-l', 'side-r']) {
    const el = $(id);
    el.style.width = side + 'px';
    if (id === 'side-l') el.style.left = '0'; else el.style.right = '0';
    el.hidden = side < 220;
  }
  W = w; H = ih;
  needsRender = true;
  if (!renderer) return;
  renderer.setSize(W, H, false);
  if (composer) composer.setSize(W, H);
  // keep the jet clear of the bottom HUD (lives/weapon/bomb button) and the thumb
  view.bottomPx = (isTouch ? 104 : 60) + (safeProbe.offsetHeight || 0);
  view.fit(W, H);
  if (isPortraitBlocked() && state === 'playing') pause();
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
    if (state === 'results' && (input.take('confirm') || input.take('tap'))) { speedTally = true; }
  } else if (state === 'paused') {
    if (input.take('pause')) { if (panelOpen()) closePanel(); else resume(); }
  }
  if (state !== 'playing') input.clearEdges();

  shake.update(rawDt);
  camera.position.set(view.C.x + shake.x, view.C.y + shake.y, view.C.z + shake.z);
  if (state === 'playing' || state === 'title' || state === 'results' || state === 'continue' || state === 'gameover') game.draw();
  fx.end();
  ui.updatePopups(rawDt);
  ui.updateFlash(rawDt, reducedMotion);
  // while paused the scene is frozen: draw it once, then save the GPU/battery
  if (state !== 'paused' || needsRender) { render(); needsRender = false; }
}
let needsRender = true;

function updateHud() {
  const g = game, p = g.player;
  ui.setScore(g.score);
  if (g.score > hiScore) { hiScore = g.score; ui.setHi(hiScore); }
  ui.setLives(Math.max(0, g.lives));
  ui.setBombs(g.bombs);
  ui.setWeapon(p.main, p.level, p.sub, p.subLevel);
  ui.setChain(g.medalChain, gameMod.MEDAL_VALUES[Math.min(g.medalChain, gameMod.MEDAL_VALUES.length - 1)]);
}

let hintFlags = store.get('hints', { moved: false, bomb: false });
let hintState = { moveShown: false, bombShown: false };
function updateHints() {
  if (hintState.moveShown && !hintFlags.moved && input.dragTravel > 40) {
    hintFlags.moved = true; store.set('hints', hintFlags); ui.hideHint(true);
  }
  if (!hintFlags.bomb && !hintState.bombShown && game.eb.n >= 6 && game.bombs > 0 && game.player.alive) {
    hintState.bombShown = true; hintFlags.bomb = true; store.set('hints', hintFlags);
    ui.bombHint(isTouch || input.usingTouch);
  }
}
function panelOpen() { return !$('howto').hidden || !$('settings').hidden; }
function closePanel() { audio.play('select'); ui.only(backTo); focusFirst(backTo); }

function toTitle(first = false) {
  state = 'title';
  pendingContinue = -1;
  game.clearField();
  game.resetRun();
  game.player.mesh.visible = true;
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
}
function startGame(loop = 1, keepScore = false) {
  audio.init();
  pendingContinue = -1;
  game.resetRun({ keepScore, loop });
  state = 'playing';
  ui.only();
  ui.hud(true);
  ui.boss(false);
  ui.danger(false);
  ui.clearPopups();
  ui.flash(0.45);
  const lp = loop > 1 ? `<div class="k">LOOP ${loop} · 難度提升</div>` : '<div class="k">STAGE 1</div>';
  ui.banner(`${lp}<div class="h">COASTAL FRONT</div><div class="s">沿岸前線</div>`, '', 2800);
  audio.play('stageStart');
  audio.music('stage');
  hintState = { moveShown: false, bombShown: false };
  if (loop === 1 && !(hintFlags.moved && isTouch)) {
    setTimeout(() => { if (state === 'playing') { hintState.moveShown = true; input.dragTravel = 0; ui.hint(input.usingTouch || isTouch); } }, 1200);
  }
  try { if (!history.state || !history.state.cb) history.pushState({ cb: 1 }, ''); } catch (_) { /* ignore */ }
  updateHud();
  requestWake();
  input.clearEdges();
  input.consumeDrag();
}
function pause() {
  if (state !== 'playing') return;
  state = 'paused';
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
  state = 'playing';
  if (game.player.alive) game.player.invuln = Math.max(game.player.invuln, 1.0); // a moment to get the thumb back
  ui.only();
  audio.setMusicDuck(1);
  audio.resume();
  input.clearEdges();
  input.consumeDrag();
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
  game.continueRun();
  state = 'playing';
  ui.only();
  audio.music(game.phase === 'boss' ? 'boss' : 'stage');
  audio.play('confirm');
  input.clearEdges();
  input.consumeDrag();
}
function gameOver() {
  state = 'gameover';
  const isNew = saveHi();
  $('go-score').textContent = fmt(game.score);
  $('go-hi').textContent = fmt(hiScore);
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
  return isNew;
}
let speedTally = false;
async function showResults() {
  state = 'results';
  const g = game, st = g.stats;
  const stageScore = Math.max(0, g.score - st.stageScoreStart);
  const pct = st.spawned ? st.killed / st.spawned : 1;
  const clearBonus = 50000 * g.loop;
  const noMiss = st.deaths === 0 ? 100000 : 0;
  const bombBonus = g.bombs * 10000;
  const destroy = Math.round(pct * 100) * 500;
  const chainBonus = g.medalMaxChain * 1000;
  const total = clearBonus + noMiss + bombBonus + destroy + chainBonus;
  g.score += total;
  const pts = pct * 100 + (st.deaths === 0 ? 30 : Math.max(0, 18 - st.deaths * 8)) + Math.min(20, g.medalMaxChain * 1.2);
  const rank = pts >= 128 ? 'S' : pts >= 108 ? 'A' : pts >= 88 ? 'B' : 'C';
  const isNew = saveHi();
  updateHud();
  ui.hud(false);
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
  const zh = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  $('next-label').textContent = `第${zh[g.loop + 1] || g.loop + 1}輪・難度提升`;
  await ui.tally(lines, g.score, rank, isNew, () => speedTally);
  focusFirst('results');
}

function onGameEvent(ev) {
  switch (ev) {
    case 'warning':
      audio.music(null);
      audio.play('warning');
      ui.warning(true);
      ui.danger(true);
      break;
    case 'bossStart':
      ui.warning(false);
      ui.danger(false);
      ui.boss(true, 'ARCLIGHT');
      audio.music('boss');
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
      ui.banner('<div class="k">STAGE 1</div><div class="h">MISSION COMPLETE</div><div class="s">任務完成</div>', 'clear', 3000);
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
// Destructive pause-menu actions need a second tap within 2 s.
function confirmTwice(btn) {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; restoreLabel(btn); return true; }
  btn.dataset.armed = '1';
  const span = btn.querySelector('span');
  btn.dataset.label = span.textContent;
  span.textContent = '再按一次確認';
  audio.play('select');
  clearTimeout(btn._armT);
  btn._armT = setTimeout(() => { btn.dataset.armed = ''; restoreLabel(btn); }, 2000);
  return false;
}
function restoreLabel(btn) { const span = btn.querySelector('span'); if (btn.dataset.label) span.textContent = btn.dataset.label; clearTimeout(btn._armT); }
function focusFirst(id) {
  if (isTouch) return;
  const el = document.querySelector(`#${id} .btn`);
  if (el) setTimeout(() => el.focus({ preventScroll: true }), 30);
}
function openPanel(id) {
  backTo = state === 'paused' ? 'pause' : 'title';
  ui.only(id);
  audio.play('select');
  focusFirst(id);
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
      case 'howto': openPanel('howto'); break;
      case 'settings': openPanel('settings'); break;
      case 'back': audio.play('select'); ui.only(backTo); focusFirst(backTo); break;
      case 'resume': resume(); break;
      case 'restart': if (!confirmTwice(b)) break; audio.play('confirm'); if (game.score > 0) saveHi(); startGame(); break;
      case 'quit': if (state === 'paused' && !confirmTwice(b)) break; audio.play('select'); if (game.score > 0) saveHi(); toTitle(); break;
      case 'retry': audio.play('confirm'); startGame(); break;
      case 'cont-yes': continueYes(); break;
      case 'cont-no': gameOver(); break;
      case 'next': audio.play('confirm'); startGame(game.loop + 1, true); break;
      default: break;
    }
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

  window.addEventListener('popstate', () => {
    if (state === 'playing') { pause(); try { history.pushState({ cb: 1 }, ''); } catch (_) { /* ignore */ } }
    else if (panelOpen()) { closePanel(); try { history.pushState({ cb: 1 }, ''); } catch (_) { /* ignore */ } }
  });
  window.addEventListener('pagehide', () => { if (game.score > 0) saveHi(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state === 'playing') pause(); if (state === 'paused' && game.score > 0) saveHi(); audio.suspend(); }
    else if (state !== 'paused') audio.resume();
  });
  window.addEventListener('blur', () => { if (state === 'playing') pause(); });
}
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
    start: (loop = 1) => startGame(loop),
    god(on = true) { game.player.invuln = on ? 1e9 : 0; },
    jump(d) {
      // fast-forward the stage to distance d (skips earlier events)
      game.clearField();
      game.world.reset(d);
      game.phase = 'stage'; game.scrollTarget = 7; game.boss = null;
      game.midbossDone = d > 600; game.warned = false;
      game.skipTo(d);
    },
    power(level = 8, main = 'red', sub = 'H', subLevel = 4) { Object.assign(game.player, { level, main, sub, subLevel }); },
    killAll() { for (const e of game.enemies) { if (e.parts) for (const p of e.parts) game.damagePart(e, p, 1e6); game.damageEnemy(e, 1e6); } },
    info() {
      return { state, fps: Math.round(fpsAvg), d: Math.round(world.distance), phase: game.phase, enemies: game.enemies.length,
        bullets: game.eb.n, shots: game.ps.n, particles: fx.p.n, score: game.score, lives: game.lives, bombs: game.bombs,
        calls: renderer.info.render.calls, tris: renderer.info.render.triangles, quality: qualityLevel };
    },
    pause, resume, toTitle,
  };
}

boot().catch((err) => { console.error(err); fail('啟動時發生錯誤：' + (err && err.message ? err.message : err)); });
