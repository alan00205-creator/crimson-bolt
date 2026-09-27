// ui.js — DOM HUD, banners, popups and menu screens.
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.floor(n).toLocaleString('en-US');

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), hiscore: $('hiscore'), lives: $('lives'), bombs: $('bombs'),
      weapon: $('weapon'), bombBtn: $('btn-bomb'), bombCount: $('bomb-count'), bossbar: $('bossbar'),
      bossFill: $('boss-fill'), bossName: $('boss-name'), banner: $('banner'), popups: $('popups'),
      flash: $('flash'), vignette: $('vignette'), titleHi: $('title-hi'), sideHi: $('side-hi'),
    };
    this.screens = ['loading', 'title', 'howto', 'settings', 'pause', 'continue', 'gameover', 'results'];
    this.cache = {};
    this.popPool = [];
    for (let i = 0; i < 18; i++) {
      const d = document.createElement('div');
      d.className = 'popup';
      d.style.opacity = '0';
      this.el.popups.appendChild(d);
      this.popPool.push({ el: d, t: 0, life: 0, x: 0, y: 0, active: false });
    }
    this.flashV = 0;
    this.bannerTimer = null;
  }
  show(name, on = true) { const e = $(name); if (e) e.hidden = !on; }
  only(...names) { for (const s of this.screens) this.show(s, names.includes(s)); }
  hud(on) { this.el.hud.hidden = !on; }

  // --- HUD values (write DOM only on change) -----------------------------------
  set(key, value, fn) { if (this.cache[key] === value) return; this.cache[key] = value; fn(value); }
  setScore(v) { this.set('score', Math.floor(v), (x) => { this.el.score.textContent = fmt(x); }); }
  setHi(v) {
    this.set('hi', Math.floor(v), (x) => {
      const s = fmt(x);
      this.el.hiscore.textContent = s; this.el.titleHi.textContent = s; if (this.el.sideHi) this.el.sideHi.textContent = s;
    });
  }
  setLives(n) {
    this.set('lives', n, (x) => {
      const k = Math.max(0, Math.min(x, 6));
      this.el.lives.innerHTML = '<i class="icon-ship"></i>'.repeat(k) + (x > 6 ? `<span class="hud-label">+${x - 6}</span>` : '');
    });
  }
  setBombs(n) {
    this.set('bombs', n, (x) => {
      this.el.bombs.innerHTML = '<i class="icon-bomb">B</i>'.repeat(Math.max(0, Math.min(x, 7)));
      this.el.bombCount.textContent = String(x);
      this.el.bombBtn.classList.toggle('empty', x <= 0);
    });
  }
  setWeapon(main, level, sub, subLevel) {
    const key = `${main}${level}${sub}${subLevel}`;
    this.set('weapon', key, () => {
      const col = main === 'red' ? '#ff6a4a' : '#45e3ff';
      const name = main === 'red' ? 'VULCAN' : 'LASER';
      let pips = '';
      for (let i = 1; i <= 8; i++) pips += `<i class="${i <= level ? 'on' : ''}"></i>`;
      let subTxt = '';
      if (sub) subTxt = ` <span style="color:${sub === 'H' ? '#8cff5a' : '#b77bff'}">${sub === 'H' ? 'HOMING' : 'NUKE'} ${subLevel}</span>`;
      this.el.weapon.innerHTML = `<b style="color:${col}">${name} ${level === 8 ? 'MAX' : 'LV' + level}</b><div class="pips" style="color:${col}">${pips}</div><div style="margin-top:3px">${subTxt || '&nbsp;'}</div>`;
    });
  }
  setChain(chain, nextValue) {
    const key = chain >= 2 ? chain : 0;
    this.set('chain', key, (x) => {
      document.getElementById('chain').textContent = x ? `★×${x} → ${fmt(nextValue)}` : '';
    });
  }
  hint(touch) {
    const h = document.getElementById('hint');
    clearTimeout(this.hintTimer);
    h.className = '';
    h.innerHTML = touch
      ? '<svg class="finger" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10h.5V8.5a1.5 1.5 0 0 1 3 0V10h.5V9.5a1.5 1.5 0 0 1 3 0v5.8c0 3.4-2.4 6.2-5.8 6.2h-.6c-2 0-3.5-.8-4.7-2.4L4.6 14.6a1.4 1.4 0 0 1 2.1-1.8L9 15z" fill="currentColor"/></svg><span>用下方搖桿移動・射擊全自動</span>'
      : '<span>方向鍵／WASD 移動・按住 Shift 慢速移動・X 投彈・射擊全自動</span>';
    h.hidden = false;
    this.hintTimer = setTimeout(() => this.hideHint(true), 5200);
  }
  bombHint(touch) {
    const h = document.getElementById('hint');
    clearTimeout(this.hintTimer);
    h.className = 'warnhint';
    h.innerHTML = touch ? '<span>危急時按右下 <b>B</b> 投彈：清除敵彈並短暫無敵</span>' : '<span>危急時按 <b>X</b> 投彈：清除敵彈並短暫無敵</span>';
    h.hidden = false;
    document.getElementById('btn-bomb').classList.add('pulse');
    this.hintTimer = setTimeout(() => { this.hideHint(true); document.getElementById('btn-bomb').classList.remove('pulse'); }, 3600);
  }
  hideHint(fade = false) {
    clearTimeout(this.hintTimer);
    const h = document.getElementById('hint');
    if (h.hidden) return;
    if (!fade) { h.hidden = true; return; }
    h.classList.add('out');
    this.hintTimer = setTimeout(() => { h.hidden = true; }, 520);
  }
  boss(on, name) {
    this.el.bossbar.hidden = !on;
    if (name) this.el.bossName.textContent = name;
    if (on) this.cache.bossPct = -1;
  }
  setBossHP(frac) {
    const v = Math.round(Math.max(0, Math.min(1, frac)) * 200) / 200;
    this.set('bossPct', v, (x) => { this.el.bossFill.style.transform = `scaleX(${x})`; });
  }

  // --- banners ---------------------------------------------------------------
  banner(html, cls = '', ms = 2200) {
    clearTimeout(this.bannerTimer);
    const b = this.el.banner;
    b.innerHTML = `<div class="bn ${cls}">${html}</div>`;
    if (ms > 0) {
      this.bannerTimer = setTimeout(() => {
        const n = b.firstElementChild; if (n) n.classList.add('out');
        this.bannerTimer = setTimeout(() => { b.innerHTML = ''; }, 380);
      }, ms);
    }
  }
  warning(on) {
    clearTimeout(this.bannerTimer);
    this.el.banner.innerHTML = on
      ? `<div class="warn"><div class="stripe"></div><div class="e">HUGE FORTRESS APPROACHING</div><div class="w">WARNING</div><div class="s">巨大要塞 接近中</div><div class="stripe"></div></div>`
      : '';
  }
  clearBanner() { clearTimeout(this.bannerTimer); this.el.banner.innerHTML = ''; }

  // --- floating score popups (projected from world by caller) ---------------------------------
  popup(text, sx, sy, cls = '') {
    let p = null;
    for (const q of this.popPool) { if (!q.active) { p = q; break; } }
    if (!p) { p = this.popPool[0]; for (const q of this.popPool) if (q.t > p.t) p = q; }
    p.active = true; p.t = 0; p.life = 0.9; p.x = sx; p.y = sy;
    p.el.className = 'popup ' + cls;
    p.el.textContent = text;
  }
  updatePopups(dt) {
    for (const p of this.popPool) {
      if (!p.active) continue;
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) { p.active = false; p.el.style.opacity = '0'; continue; }
      const y = p.y - 26 * Math.min(1, k * 2.5);
      p.el.style.transform = `translate(${p.x}px, ${y}px) translate(-50%, -50%)`;
      p.el.style.opacity = String(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
    }
  }
  clearPopups() { for (const p of this.popPool) { p.active = false; p.el.style.opacity = '0'; } }

  // --- full-screen flashes ------------------------------------------------------
  flash(v) { this.flashV = Math.max(this.flashV, v); }
  updateFlash(dt, reduced) {
    if (this.flashV <= 0 && this._lastFlash === 0) return;
    this.flashV = Math.max(0, this.flashV - dt * 2.6);
    const o = reduced ? this.flashV * 0.35 : this.flashV;
    const r = Math.round(o * 100) / 100;
    if (r !== this._lastFlash) { this._lastFlash = r; this.el.flash.style.opacity = String(r); }
  }
  danger(on) { this.set('danger', on, (x) => { this.el.vignette.style.opacity = x ? '1' : '0'; }); }

  // --- results tally --------------------------------------------------------------
  async tally(lines, total, rank, isNew, speedUp) {
    const box = $('tally');
    box.innerHTML = '';
    $('rank').classList.remove('on');
    $('res-new').hidden = true;
    $('res-menu').hidden = true;
    const wait = (ms) => new Promise((r) => setTimeout(r, speedUp() ? 0 : ms));
    for (const [label, sub, value] of lines) {
      const ln = document.createElement('div');
      ln.className = 'ln';
      ln.innerHTML = `<span>${label}<small>${sub}</small></span><span>${value}</span>`;
      box.appendChild(ln);
      await wait(40);
      ln.classList.add('on');
      await wait(380);
    }
    const tl = document.createElement('div');
    tl.className = 'ln total';
    tl.innerHTML = `<span>TOTAL<small>總分</small></span><span>${fmt(total)}</span>`;
    box.appendChild(tl);
    await wait(40);
    tl.classList.add('on');
    await wait(500);
    const r = $('rank'); r.textContent = rank; r.classList.add('on');
    await wait(450);
    $('res-new').hidden = !isNew;
    $('res-menu').hidden = false;
  }
}
export { fmt };
