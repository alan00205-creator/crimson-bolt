// ui.js — DOM HUD, banners, popups and menu screens (incl. the hangar list and item legends).
import { AIRCRAFT, MAIN_WEAPONS, MAIN_ORDER, SUB_WEAPONS, SUB_ORDER, MAX_LEVEL, MONEY } from './defs.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rgba = (hex, a) => `rgba(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255}, ${a})`;
// every bar reads "more is more": the hitbox bar counts how SMALL the hitbox is (5 = smallest)
const STAT_ROWS = [['speed', '速度'], ['power', '火力'], ['bombs', '炸彈'], ['hitbox', '判定小']];
const WARN_DEFAULT = { e: 'HUGE FORTRESS APPROACHING', s: '巨大要塞 接近中' };

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), hiscore: $('hiscore'), lives: $('lives'), bombs: $('bombs'),
      weapon: $('weapon'), bombBtn: $('btn-bomb'), bombCount: $('bomb-count'), bossbar: $('bossbar'),
      bossFill: $('boss-fill'), bossName: $('boss-name'), banner: $('banner'), popups: $('popups'),
      flash: $('flash'), vignette: $('vignette'), titleHi: $('title-hi'), sideHi: $('side-hi'), bossSub: $('boss-sub'),
      hudCr: $('hud-cr'), titleCr: $('title-cr'), sideCr: $('side-cr'), hangarCr: $('hangar-cr'),
      focusBtn: $('btn-focus'), toast: $('toast'),
    };
    this.screens = ['loading', 'title', 'howto', 'settings', 'hangar', 'pause', 'continue', 'gameover', 'results'];
    this.ships = {}; // hangar rows by aircraft id (built once by buildHangar)
    this.cache = {};
    this.popPool = [];
    for (let i = 0; i < 18; i++) {
      const d = document.createElement('div');
      d.className = 'popup';
      d.style.opacity = '0';
      this.el.popups.appendChild(d);
      this.popPool.push({ el: d, t: 0, life: 0, x: 0, y: 0, sx: 0, sy: 0, medals: 0, sum: 0, tLast: 0, active: false });
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
  // CR earned in this run (HUD) and the wallet balance (title, side panel, hangar header).
  setRunMoney(v) { this.set('runCr', Math.floor(v), (x) => { this.el.hudCr.textContent = fmt(x); }); }
  setWallet(v) {
    this.set('wallet', Math.floor(v), (x) => {
      const s = fmt(x);
      this.el.titleCr.textContent = s; this.el.hangarCr.textContent = s; if (this.el.sideCr) this.el.sideCr.textContent = s;
    });
  }
  // The current aircraft: lives icons in its colour, its name on the title and in the side panel,
  // and the touch 集中 button (only for aircraft with option drones).
  setShip(ac) {
    this.set('ship', ac.id, () => {
      this.el.lives.style.setProperty('--ship', ac.color);
      this.el.focusBtn.hidden = !(ac.options > 0);
      this.el.focusBtn.style.setProperty('--ac', ac.color);
      $('hangar-label').textContent = '機庫・' + ac.zh;
      const side = $('side-ship'); if (side) side.textContent = `${ac.name} ${ac.zh}`;
    });
  }
  // Side-panel mission block and the how-to route line. stages: STAGES / STAGE_META entries.
  setMission(stages, idx, loop = 1) {
    const st = stages[idx] || stages[0];
    this.set('mission', `${idx}:${loop}`, () => {
      $('side-stage').textContent = `STAGE ${st.n}${loop > 1 ? ' · LOOP ' + loop : ''} · ${st.zh}`;
      $('side-mission').textContent = st.mission;
      $('side-route').innerHTML = stages.map((s, i) => `<span class="${i < idx ? 'done' : i === idx ? 'on' : ''}">${esc(s.zh)}</span>`).join('<i>›</i>');
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
      const w = MAIN_WEAPONS[main] || MAIN_WEAPONS.red;
      let pips = '';
      for (let i = 1; i <= MAX_LEVEL; i++) pips += `<i class="${i <= level ? 'on' : ''}"></i>`;
      let subTxt = '';
      const sw = sub && SUB_WEAPONS[sub];
      if (sw) subTxt = ` <span style="color:${sw.col}">${sw.name} ${subLevel}</span>`;
      this.el.weapon.innerHTML = `<b style="color:${w.col}">${w.name} ${level >= MAX_LEVEL ? 'MAX' : 'LV' + level}</b><div class="pips" style="color:${w.col}">${pips}</div><div style="margin-top:3px">${subTxt || '&nbsp;'}</div>`;
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
  boss(on, name, sub) {
    this.el.bossbar.hidden = !on;
    if (name) this.el.bossName.textContent = name;
    if (sub !== undefined) this.el.bossSub.textContent = sub;
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
  // warn: { e, s } from STAGE_META (English line, Chinese line)
  warning(on, warn = WARN_DEFAULT) {
    clearTimeout(this.bannerTimer);
    this.el.banner.innerHTML = on
      ? `<div class="warn"><div class="stripe"></div><div class="e">${esc(warn.e)}</div><div class="w">WARNING</div><div class="s">${esc(warn.s)}</div><div class="stripe"></div></div>`
      : '';
  }
  clearBanner() { clearTimeout(this.bannerTimer); this.el.banner.innerHTML = ''; }
  // A short status line under the HUD (e.g. mute on/off); works on every screen.
  toast(text, ms = 1400) {
    const el = this.el.toast;
    clearTimeout(this.toastTimer);
    el.textContent = text;
    el.hidden = false;
    this.toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // --- floating score popups (projected from world by caller) ---------------------------------
  popup(text, sx, sy, cls = '') {
    // medals picked up in a quick run on one spot (a boss kill's medal rush) count up in one
    // popup, "★×N total", instead of piling up into an unreadable smear
    const medal = cls === 'medal' ? Number(String(text).replace(/,/g, '')) : 0;
    if (medal > 0) {
      for (const q of this.popPool) {
        if (!q.active || !q.medals || q.t - q.tLast > 0.3 || Math.abs(q.sx - sx) > 48 || Math.abs(q.sy - sy) > 48) continue;
        q.medals++; q.sum += medal; q.tLast = q.t; q.life = q.t + 0.9;
        q.el.className = 'popup medal many';
        q.el.textContent = `★×${q.medals} ${fmt(q.sum)}`;
        return;
      }
    }
    let p = null;
    for (const q of this.popPool) { if (!q.active) { p = q; break; } }
    if (!p) { p = this.popPool[0]; for (const q of this.popPool) if (q.t > p.t) p = q; }
    // stack popups that land on the same spot instead of overprinting
    let near = 0;
    for (const q of this.popPool) if (q.active && q.t < 0.3 && Math.abs(q.x - sx) < 24 && Math.abs(q.y - sy) < 24) near++;
    p.active = true; p.t = 0; p.life = 0.9; p.x = sx; p.y = sy - 16 * Math.min(near, 3);
    p.sx = sx; p.sy = sy; p.medals = medal > 0 ? 1 : 0; p.sum = medal; p.tLast = 0;
    p.el.className = 'popup ' + cls;
    p.el.textContent = text;
  }
  // Rise for the first 0.36 s, fade over the last 0.27 s (a merged medal counter lives on).
  updatePopups(dt) {
    for (const p of this.popPool) {
      if (!p.active) continue;
      p.t += dt;
      const left = p.life - p.t;
      if (left <= 0) { p.active = false; p.el.style.opacity = '0'; continue; }
      const y = p.y - 26 * Math.min(1, p.t / 0.36);
      p.el.style.transform = `translate(${p.x}px, ${y}px) translate(-50%, -50%)`;
      p.el.style.opacity = String(left > 0.27 ? 1 : left / 0.27);
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

  // --- item legends (side panel + how-to), built from defs so they never go stale -----------
  buildLegends() {
    const chip = (col, t) => `<span class="chip" style="background:${col}">${t}</span>`;
    const side = $('side-items');
    if (side) {
      side.innerHTML = MAIN_ORDER.map((k) => `${chip(MAIN_WEAPONS[k].col, 'P')}<span>${esc(MAIN_WEAPONS[k].zh)}</span>`).join('')
        + SUB_ORDER.map((k) => `${chip(SUB_WEAPONS[k].col, k)}<span>${esc(SUB_WEAPONS[k].zh)}</span>`).join('')
        + `<span class="chip b">B</span><span>炸彈</span>`;
    }
    const ul = $('howto-items');
    if (ul) {
      const grid = (keys, W, t) => `<li class="legend-grid">${keys.map((k) => `<span>${chip(W[k].col, t || k)}${esc(W[k].zh)}</span>`).join('')}</li>`;
      ul.insertAdjacentHTML('afterbegin',
        `<li>P 主武器：依序循環變色，吃同色升級，換色切換武器。</li>${grid(MAIN_ORDER, MAIN_WEAPONS, 'P')}`
        + `<li>S 副武器：同樣循環變換，吃同字母升級。</li>${grid(SUB_ORDER, SUB_WEAPONS)}`);
    }
  }
  setRoute(stages) {
    const el = $('howto-route');
    if (el) el.textContent = `共 ${stages.length} 關：${stages.map((s) => s.zh).join(' → ')}。全破後進入下一輪（難度提升）。`;
  }

  // --- hangar ---------------------------------------------------------------------
  // One .btn row per aircraft: name, a two-line description, 4 stat bars and a price / owned tag.
  buildHangar() {
    const box = $('ships');
    box.innerHTML = '';
    for (const ac of AIRCRAFT) {
      const b = document.createElement('button');
      b.className = 'btn ship';
      b.dataset.act = 'ship';
      b.dataset.ship = ac.id;
      b.style.setProperty('--ac', ac.color);
      b.style.setProperty('--ac-dim', rgba(ac.hex, 0.24));
      const stats = STAT_ROWS.map(([k, label]) => {
        let bar = '';
        for (let i = 1; i <= 5; i++) bar += `<i class="${i <= (ac.stats[k] || 0) ? 'on' : ''}"></i>`;
        return `<div><small>${label}</small><b class="sh-bar" aria-label="${label} ${ac.stats[k]}/5">${bar}</b></div>`;
      }).join('');
      b.innerHTML = `<div class="sh-top"><b>${esc(ac.name)}</b><i>${esc(ac.zh)}</i><em class="sh-tag"></em></div>`
        + `<div class="sh-desc">${esc(ac.desc)}</div><div class="sh-stats">${stats}</div>`;
      box.appendChild(b);
      this.ships[ac.id] = { b, tag: b.querySelector('.sh-tag'), desc: b.querySelector('.sh-desc'), ac, msgT: 0 };
    }
  }
  // w: the wallet { money, owned, equipped }; sel: the aircraft being previewed.
  renderHangar(w, sel) {
    // once every jet is bought, say so: CR then simply keeps counting
    $('hangar-sub').textContent = AIRCRAFT.every((a) => w.owned.includes(a.id)) ? '機庫・全機已入手' : '機庫・選擇出擊戰機';
    for (const id in this.ships) {
      const r = this.ships[id], ac = r.ac, owned = w.owned.includes(id);
      let key, html;
      if (owned && w.equipped === id) { key = 'on'; html = '使用中'; }
      else if (owned) { key = 'own'; html = '已擁有'; }
      else { key = w.money >= ac.price ? 'price' : 'price poor'; html = `<i class="coin"></i>${fmt(ac.price)}`; }
      if (r.key !== key + html) { r.key = key + html; r.tag.className = 'sh-tag ' + key; r.tag.innerHTML = html; }
      r.b.classList.toggle('sel', id === sel);
      r.b.setAttribute('aria-current', String(owned && w.equipped === id));
      r.b.setAttribute('aria-label', `${ac.name} ${ac.zh}，${owned ? (w.equipped === id ? '使用中' : '已擁有') : `${MONEY.label} ${fmt(ac.price)}`}。${ac.desc}`);
    }
    const ac = this.ships[sel] ? this.ships[sel].ac : null;
    if (ac) {
      const cap = $('hangar-cap');
      cap.innerHTML = `${esc(ac.name)}<i style="color:${ac.color}">${esc(ac.zh)}</i>`;
    }
  }
  // A short message in a row's description line (cls: msg | good | bad); ms <= 0 keeps it.
  hangarMsg(id, text, cls = 'msg', ms = 1800) {
    const r = this.ships[id];
    if (!r) return;
    clearTimeout(r.msgT);
    r.desc.className = 'sh-desc ' + cls;
    r.desc.textContent = text;
    if (ms > 0) r.msgT = setTimeout(() => this.hangarMsgClear(id), ms);
  }
  hangarMsgClear(id) {
    const r = this.ships[id];
    if (!r) return;
    clearTimeout(r.msgT);
    r.desc.className = 'sh-desc';
    r.desc.textContent = r.ac.desc;
  }
  hangarShake(id) {
    const r = this.ships[id];
    if (!r) return;
    r.b.classList.remove('deny');
    void r.b.offsetWidth; // restart the animation
    r.b.classList.add('deny');
  }
  walletBump() {
    const w = $('hangar-wallet');
    w.classList.remove('bump'); void w.offsetWidth; w.classList.add('bump');
  }

  // --- results tally --------------------------------------------------------------
  // Lay out every row first (invisible) so the screen never jumps, then reveal them in turn.
  // lines: [label, sub, value, cls?]; sound('line', cls) plays as each row shows (an 'extend' row
  // always sounds, even when the tally is sped up). money: { earned, wallet } adds a counting
  // "CR 獲得" row and the wallet balance after TOTAL.
  async tally(lines, total, rank, isNew, speedUp, sound = () => {}, money = null) {
    const box = $('tally');
    box.innerHTML = '';
    const r = $('rank');
    r.classList.remove('on'); r.textContent = rank;
    $('res-new').hidden = false; $('res-new').classList.add('reserve');
    $('res-menu').hidden = false; $('res-menu').classList.add('reserve');
    const rows = lines.map(([label, sub, value, cls = '']) => {
      const ln = document.createElement('div');
      ln.className = cls ? 'ln ' + cls : 'ln';
      ln.innerHTML = `<span>${label}<small>${sub}</small></span><span>${value}</span>`;
      box.appendChild(ln);
      return { ln, cls };
    });
    const tl = document.createElement('div');
    tl.className = 'ln total';
    tl.innerHTML = `<span>TOTAL<small>總分</small></span><span>${fmt(total)}</span>`;
    box.appendChild(tl);
    let cr = null, wal = null;
    if (money) {
      cr = document.createElement('div');
      cr.className = 'ln cr';
      cr.innerHTML = `<span><i class="coin"></i>${MONEY.label}<small>獲得</small></span><span>+0</span>`;
      wal = document.createElement('div');
      wal.className = 'ln wallet';
      wal.innerHTML = `<span>WALLET<small>持有</small></span><span>${MONEY.label} ${fmt(money.wallet)}</span>`;
      box.append(cr, wal);
    }
    const wait = (ms) => new Promise((res) => setTimeout(res, speedUp() ? 0 : ms));
    for (const { ln, cls } of rows) { await wait(60); ln.classList.add('on'); if (cls === 'extend' || !speedUp()) sound('line', cls); await wait(360); }
    await wait(40); tl.classList.add('on'); sound('total');
    if (cr) {
      await wait(380);
      cr.classList.add('on');
      const v = cr.lastElementChild, n = Math.max(0, Math.floor(money.earned));
      const steps = n > 0 ? 14 : 0;
      for (let i = 1; i <= steps && !speedUp(); i++) {
        v.textContent = '+' + fmt((n * i) / steps);
        if (i % 2 === 1) sound('coin', i / steps);
        await wait(45);
      }
      v.textContent = '+' + fmt(n);
      sound('coinEnd');
      await wait(200); wal.classList.add('on');
    }
    await wait(500);
    r.classList.add('on'); sound('rank');
    await wait(450);
    if (isNew) { $('res-new').classList.remove('reserve'); sound('record'); } else $('res-new').hidden = true;
    $('res-menu').classList.remove('reserve');
  }
}
export { fmt };
