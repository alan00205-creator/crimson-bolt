// ui.js — DOM HUD, banners, popups and menu screens (incl. the hangar, the ranking board and item legends).
import { AIRCRAFT, AIRCRAFT_BY_ID, MAIN_WEAPONS, MAIN_ORDER, SUB_WEAPONS, SUB_ORDER, MAX_LEVEL, MONEY, PAINTS, DEFAULT_PAINT, paintOf, UPGRADES } from './defs.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rgba = (hex, a) => `rgba(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255}, ${a})`;
// A DOM node with a class and (plain) text: player names only ever reach the page this way.
const node = (tag, cls = '', text = null) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== null) e.textContent = text; return e; };
// a paint's two-tone chip (body / trim)
const swatchBg = (pt) => `linear-gradient(135deg, ${pt.swatch[0]} 55%, ${pt.swatch[1]} 55%)`;
// every bar reads "more is more": the hitbox bar counts how SMALL the hitbox is (5 = smallest)
const STAT_ROWS = [['speed', '速度'], ['power', '火力'], ['bombs', '炸彈'], ['hitbox', '判定小']];
// upgrade row accents: the colour of what each one improves (bombs, the VULCAN, the jet, items,
// the shield bubble, CR)
const UP_COL = { bombs: '#ff9a2a', power: '#ff6a4a', life: '#ff4a55', magnet: '#8cff5a', shield: '#8fe6ff', bonus: '#ffcf4a' };
const HANGAR_SUB = { ship: '機庫・選擇出擊戰機', paint: '機庫・替戰機換上塗裝', up: '機庫・永久強化（全機共用）' };
const RANK_NOTE = '「2-3」＝第 2 輪第 3 關。紀錄只存在這台裝置。';
// a board date: '09/30' this year, '2025/09/30' before
const boardDate = (d) => { if (!d) return ''; const [y, m, day] = d.split('-'); return y === String(new Date().getFullYear()) ? `${m}/${day}` : `${y}/${m}/${day}`; };
const WARN_DEFAULT = { e: 'HUGE FORTRESS APPROACHING', s: '巨大要塞 接近中' };
const ZH_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), hiscore: $('hiscore'), lives: $('lives'), bombs: $('bombs'),
      weapon: $('weapon'), bombBtn: $('btn-bomb'), bombCount: $('bomb-count'), bossbar: $('bossbar'),
      bossFill: $('boss-fill'), bossName: $('boss-name'), banner: $('banner'), popups: $('popups'),
      flash: $('flash'), vignette: $('vignette'), titleHi: $('title-hi'), sideHi: $('side-hi'), bossSub: $('boss-sub'),
      hudCr: $('hud-cr'), titleCr: $('title-cr'), sideCr: $('side-cr'), hangarCr: $('hangar-cr'),
      focusBtn: $('btn-focus'), toast: $('toast'), shield: $('hud-shield'),
    };
    this.screens = ['loading', 'title', 'howto', 'settings', 'hangar', 'ranking', 'pause', 'continue', 'gameover', 'results', 'record'];
    this.hrows = {}; // hangar rows by key: 'ship:<id>', 'paint:<slot>', 'up:<id>' (built once by buildHangar)
    this.ships = {}; // the aircraft rows by aircraft id
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
  // The current aircraft (pt: its PAINTS entry): lives icons in the paint's accent colour, its name
  // on the title and in the side panel, and the touch 集中 button (only for aircraft with option drones).
  setShip(ac, pt = null) {
    const col = pt ? pt.col : ac.color;
    this.set('ship', ac.id + ':' + (pt ? pt.id : ''), () => {
      this.el.lives.style.setProperty('--ship', col);
      this.el.focusBtn.hidden = !(ac.options > 0);
      this.el.focusBtn.style.setProperty('--ac', col);
      $('hangar-label').textContent = '機庫・' + ac.zh;
      const side = $('side-ship'); if (side) side.textContent = `${ac.name} ${ac.zh}` + (pt && pt.id !== DEFAULT_PAINT ? `・${pt.zh}` : '');
    });
  }
  // The shield upgrade's charge, next to the lives: 1 ready, 0 used up (until the next stage or
  // continue), -1 no shield upgrade.
  setShield(v) {
    this.set('shield', v, (x) => {
      const el = this.el.shield;
      el.hidden = x < 0;
      el.classList.toggle('used', x === 0);
      el.setAttribute('aria-label', x === 0 ? '能量護盾：本關已用掉' : '能量護盾：可擋一次中彈');
    });
  }
  // The CR bonus upgrade on a CR line: '（+20%）', hidden without it.
  setBonus(el, pct) { el.hidden = !(pct > 0); el.textContent = pct > 0 ? `（+${pct}%）` : ''; }
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
  // (7 icons, then a count: TITAN with the 起始炸彈 upgrade holds up to 8, and on the keyboard
  // layout the B button's count is hidden; touch shows at most 6 icons beside the joystick)
  setBombs(n) {
    this.set('bombs', n, (x) => {
      const k = Math.max(0, Math.min(x, 7));
      this.el.bombs.innerHTML = '<i class="icon-bomb">B</i>'.repeat(k) + (x > 7 ? `<span class="hud-label">+${x - 7}</span>` : '');
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
    this.hintTimer = setTimeout(() => this.hideHint(true), 3600);
  }
  hideHint(fade = false) {
    clearTimeout(this.hintTimer);
    document.getElementById('btn-bomb').classList.remove('pulse'); // the bomb hint's pulse ends with any hint
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
  // The how-to route line and each stage's clear reward (MONEY.stageClear, before the bonus upgrade).
  setRoute(stages) {
    const el = $('howto-route');
    const n = stages.length, zh = ZH_NUM[n] || String(n);
    if (el) el.textContent = `共${zh}關：${stages.map((s) => s.zh).join(' → ')}。第${zh}關是最終決戰，全破後進入下一輪（難度提升）。`;
    const cr = $('howto-clearcr');
    if (cr) cr.textContent = `（第 1～${n} 關依序 ${stages.map((s) => fmt(MONEY.stageClear[s.n] || 0)).join('／')}）`;
  }

  // --- hangar ---------------------------------------------------------------------
  // Three tabs of .btn.hrow rows, each with a tag (price / owned / in use / MAX) and a description
  // box that also shows short messages: 機體 one row per aircraft (a two-line description and 4
  // stat bars), 塗裝 one row per paint slot (refilled with the picked aircraft's paints by
  // renderHangar) and 強化 one row per upgrade (level pips, a one-line description).
  buildHangar() {
    this.hrows = {}; this.ships = {};
    const add = (kind, id, b, desc, box) => {
      b.classList.add('btn', 'hrow', kind);
      b.dataset.act = kind;
      box.appendChild(b);
      const r = { b, kind, id, tag: b.querySelector('.sh-tag'), desc: b.querySelector('.sh-desc'), base: desc, msg: false, msgT: 0, k: '' };
      this.hrows[kind + ':' + id] = r;
      return r;
    };
    const ships = $('ships');
    ships.innerHTML = '';
    for (const ac of AIRCRAFT) {
      const b = document.createElement('button');
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
      const r = add('ship', ac.id, b, ac.desc, ships);
      r.ac = ac;
      this.ships[ac.id] = r;
    }
    const paints = $('paints');
    paints.innerHTML = '';
    const slots = Math.max(...AIRCRAFT.map((a) => (PAINTS[a.id] || []).length));
    for (let i = 0; i < slots; i++) {
      const b = document.createElement('button');
      b.dataset.slot = String(i);
      b.innerHTML = '<div class="sh-top"><i class="swatch"></i><b class="pt-name"></b><em class="sh-tag"></em></div><div class="sh-desc one"></div>';
      const r = add('paint', String(i), b, '', paints);
      r.id = null; r.of = null; // the paint shown in this slot, and whose (renderHangar)
      r.swatch = b.querySelector('.swatch'); r.name = b.querySelector('.pt-name');
    }
    const ups = $('ups');
    ups.innerHTML = '';
    for (const u of UPGRADES) {
      const b = document.createElement('button');
      b.dataset.up = u.id;
      const col = u.col || UP_COL[u.id] || '#ffffff';
      b.style.setProperty('--ac', col);
      b.style.setProperty('--ac-dim', rgba(parseInt(col.slice(1), 16), 0.22));
      b.innerHTML = `<div class="sh-top"><b class="up-name">${esc(u.zh)}</b><span class="up-pips">${'<i></i>'.repeat(u.prices.length)}</span><em class="sh-tag"></em></div>`
        + `<div class="sh-desc one">${esc(u.desc)}</div>`;
      const r = add('up', u.id, b, u.desc, ups);
      r.u = u; r.pips = [...b.querySelectorAll('.up-pips i')];
    }
  }
  hrow(key) { return this.hrows[key] || null; }
  eachHangarRow(fn) { for (const key in this.hrows) fn(this.hrows[key], key); }
  paintRow(pid) { for (const key in this.hrows) { const r = this.hrows[key]; if (r.kind === 'paint' && r.id === pid && !r.b.hidden) return r; } return null; }
  // w: the wallet; h: the hangar view { tab, sel (the picked aircraft), paint (the paint shown), up
  // (the highlighted upgrade) }.
  renderHangar(w, h) {
    const tab = h.tab, sel = AIRCRAFT_BY_ID[h.sel] ? h.sel : AIRCRAFT[0].id, sac = AIRCRAFT_BY_ID[sel];
    for (const t of document.querySelectorAll('#htabs .htab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    $('ships').hidden = tab !== 'ship'; $('paints').hidden = tab !== 'paint'; $('ups').hidden = tab !== 'up';
    $('hctx').hidden = tab !== 'paint';
    // once every jet is bought, say so: CR then goes to paints and upgrades
    $('hangar-sub').textContent = tab === 'ship' && AIRCRAFT.every((a) => w.owned.includes(a.id)) ? '機庫・全機已入手' : HANGAR_SUB[tab];
    const tag = (r, key, html) => { if (r.k !== key + html) { r.k = key + html; r.tag.className = 'sh-tag ' + key; r.tag.innerHTML = html; } };
    const price = (n, poor) => [poor ? 'price poor' : 'price', `<i class="coin"></i>${fmt(n)}`];
    for (const id in this.ships) {
      const r = this.ships[id], ac = r.ac, owned = w.owned.includes(id);
      tag(r, ...(owned && w.equipped === id ? ['on', '使用中'] : owned ? ['own', '已擁有'] : price(ac.price, w.money < ac.price)));
      r.b.classList.toggle('sel', id === sel);
      r.b.setAttribute('aria-current', String(owned && w.equipped === id));
      r.b.setAttribute('aria-label', `${ac.name} ${ac.zh}，${owned ? (w.equipped === id ? '使用中' : '已擁有') : `${MONEY.label} ${fmt(ac.price)}`}。${ac.desc}`);
    }
    // paints of the picked aircraft (only an owned one can buy them)
    const list = PAINTS[sel] || [], acOwned = w.owned.includes(sel), have = w.paints[sel] || [DEFAULT_PAINT];
    const ctx = $('hctx');
    ctx.firstElementChild.textContent = `${sac.name} ${sac.zh}`;
    ctx.lastElementChild.textContent = !acOwned ? '未擁有・先在「機體」購買' : w.equipped === sel ? '出擊機' : '已擁有';
    ctx.classList.toggle('locked', !acOwned);
    for (const key in this.hrows) {
      const r = this.hrows[key];
      if (r.kind !== 'paint') continue;
      const pt = list[+r.b.dataset.slot];
      r.b.hidden = !pt;
      if (!pt) continue;
      if (r.id !== pt.id || r.of !== sel) {
        r.id = pt.id; r.of = sel; r.b.dataset.paint = pt.id; r.base = pt.desc;
        r.swatch.style.background = swatchBg(pt);
        r.name.textContent = pt.zh;
        r.b.style.setProperty('--ac', pt.col);
        r.b.style.setProperty('--ac-dim', rgba(pt.hex, 0.24));
        if (!r.msg && r.b.dataset.armed !== '1') r.desc.textContent = pt.desc;
      }
      // (a jet not bought yet flies no paint: its free scheme is just 出廠, nothing is 使用中)
      const owned = have.includes(pt.id), on = acOwned && owned && w.paint[sel] === pt.id;
      tag(r, ...(on ? ['on', '使用中'] : !acOwned && pt.price === 0 ? ['own', '出廠'] : owned ? ['own', '已擁有'] : price(pt.price, !acOwned || w.money < pt.price)));
      r.b.classList.toggle('sel', pt.id === h.paint);
      r.b.classList.toggle('locked', !acOwned);
      r.b.setAttribute('aria-current', String(on));
      r.b.setAttribute('aria-label', `塗裝 ${pt.zh}，${on ? '使用中' : !acOwned && pt.price === 0 ? '出廠塗裝' : owned ? '已擁有' : `${MONEY.label} ${fmt(pt.price)}`}${acOwned ? '' : `（需先擁有${sac.zh}）`}。${pt.desc}`);
    }
    // upgrades: level pips, the next level's price or MAX
    for (const u of UPGRADES) {
      const r = this.hrows['up:' + u.id], lv = w.upgrades[u.id] || 0, max = u.prices.length;
      r.pips.forEach((p, i) => p.classList.toggle('on', i < lv));
      tag(r, ...(lv >= max ? ['max', 'MAX'] : price(u.prices[lv], w.money < u.prices[lv])));
      r.b.classList.toggle('sel', u.id === h.up);
      r.b.setAttribute('aria-label', `${u.zh} Lv${lv}/${max}，${lv >= max ? '已達最高等級' : `下一級 ${MONEY.label} ${fmt(u.prices[lv])}`}。${u.desc}`);
    }
    const pt = paintOf(sel, h.paint) || list[0];
    const cap = $('hangar-cap'), col = pt ? pt.col : sac.color;
    cap.innerHTML = `${esc(sac.name)}<i style="color:${col}">${esc(sac.zh)}${pt && pt.id !== DEFAULT_PAINT ? '・' + esc(pt.zh) : ''}</i>`;
  }
  // A short message in a row's description box (cls: msg | good | bad); ms <= 0 keeps it.
  hangarMsg(key, text, cls = 'msg', ms = 1800) {
    const r = this.hrows[key];
    if (!r) return;
    clearTimeout(r.msgT);
    r.msg = true;
    r.desc.classList.remove('msg', 'good', 'bad');
    r.desc.classList.add(cls);
    r.desc.textContent = text;
    if (ms > 0) r.msgT = setTimeout(() => this.hangarMsgClear(key), ms);
  }
  hangarMsgClear(key) {
    const r = this.hrows[key];
    if (!r) return;
    clearTimeout(r.msgT);
    r.msg = false;
    r.desc.classList.remove('msg', 'good', 'bad');
    r.desc.textContent = r.base;
  }
  hangarShake(key) {
    const r = this.hrows[key];
    if (!r) return;
    r.b.classList.remove('deny');
    void r.b.offsetWidth; // restart the animation
    r.b.classList.add('deny');
  }
  walletBump() {
    const w = $('hangar-wallet');
    w.classList.remove('bump'); void w.offsetWidth; w.classList.add('bump');
  }

  // --- ranking board ----------------------------------------------------------------
  // The aircraft (paint chip + name), the stage reached ('loop-stage'), ALL CLEAR and continues of a
  // board row (a flex line; the board appends the date).
  rankMeta(r) {
    const ac = AIRCRAFT_BY_ID[r.ac], pt = paintOf(r.ac, r.paint) || PAINTS[r.ac][0];
    const m = node('span', 'rmeta'), sw = node('i', 'swatch'), n = node('span', 'rac', ac.zh);
    sw.style.background = swatchBg(pt);
    n.style.color = pt.col;
    m.append(sw, n, node('span', 'rst', `${r.loop}-${r.stage}`));
    if (r.clear) m.append(node('em', 'rclear', 'ALL CLEAR'));
    if (r.cont > 0) m.append(node('span', 'rcont', `接關×${r.cont}`));
    return m;
  }
  // list: the sanitised board, best first. The newest row (highest t) is highlighted.
  renderRanking(list) {
    const ol = $('rank-list');
    ol.textContent = '';
    $('btn-rclear').classList.toggle('dim', !list.length);
    if (!list.length) { ol.append(node('li', 'rempty', '還沒有紀錄。打完一局，前 10 名的分數會留在這裡。')); return; }
    let newest = 0;
    for (const r of list) newest = Math.max(newest, r.t);
    list.forEach((r, i) => {
      const li = node('li', 'rrow' + (i < 3 ? ' top' + (i + 1) : '') + (newest && r.t === newest ? ' new' : ''));
      const meta = this.rankMeta(r);
      meta.append(node('span', 'rdate', boardDate(r.date)));
      li.append(node('b', 'rn', String(i + 1)), node('span', 'rname', r.name), node('span', 'rscore', fmt(r.score)), meta);
      ol.append(li);
    });
  }
  // The note under the board (text: a temporary message for ms, then the default note again).
  rankNote(text = null, cls = '', ms = 0) {
    const el = $('rank-note');
    clearTimeout(this.rankNoteT);
    el.className = 'note' + (cls ? ' ' + cls : '');
    el.textContent = text === null ? RANK_NOTE : text;
    if (text !== null && ms > 0) this.rankNoteT = setTimeout(() => this.rankNote(), ms);
  }
  // A name entry form (GAME OVER screen, record screen) for a run ranked `rank`, and its done state.
  showEntry(form, rank) {
    form.hidden = false;
    form.classList.remove('done');
    form.querySelector('.entry-rank').textContent = `第 ${rank} 名`;
  }
  entryDone(form, rank, name) {
    form.classList.add('done');
    const d = form.querySelector('.entry-done');
    d.textContent = '';
    d.append(`排行榜 第 ${rank} 名　`, node('b', '', name));
  }
  // The record screen of a run that made the board (r: its row; isNew: it beat the HI-SCORE).
  recordScreen(rank, r, isNew = rank === 1) {
    $('rec-title').textContent = isNew ? 'NEW RECORD' : 'HIGH SCORE';
    $('rec-title').classList.toggle('all', isNew);
    $('rec-rank').textContent = `排行榜 第 ${rank} 名`;
    $('rec-score').textContent = fmt(r ? r.score : 0);
    const meta = $('rec-meta');
    meta.textContent = '';
    if (r) meta.append(this.rankMeta(r));
  }

  // --- results tally --------------------------------------------------------------
  // Lay out every row first (invisible) so the screen never jumps, then reveal them in turn.
  // lines: [label, sub, value, cls?]; sound('line', cls) plays as each row shows (an 'extend' row
  // always sounds, even when the tally is sped up). money: { earned, wallet, bonus } adds a
  // counting "CR 獲得" row (with the bonus upgrade's '（+20%）') and the wallet balance after TOTAL.
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
      cr.innerHTML = `<span><i class="coin"></i>${MONEY.label}<small>獲得</small></span><span><span class="n">+0</span><small class="bonus"></small></span>`;
      this.setBonus(cr.querySelector('.bonus'), money.bonus || 0);
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
      const v = cr.querySelector('.n'), n = Math.max(0, Math.floor(money.earned));
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
