// input.js — keyboard (computer), on-screen joystick (touch) and gamepad.
export class Input {
  constructor(surface) {
    this.surface = surface;
    this.keys = new Set();
    this.edges = new Set();       // actions triggered since last consume
    this.usingTouch = false;
    this.dragTravel = 0; // total joystick travel in px (used to retire the movement hint)
    this.touchFocus = false; // the on-screen 集中 button is held (tucks the option drones)
    this.pad = { x: 0, y: 0, slow: false, bomb: false, pause: false, prevBomb: false, prevPause: false, prevStart: false, start: false };
    this.enabled = true;
    this._bind();
  }
  _bind() {
    const map = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
      KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down',
      ShiftLeft: 'slow', ShiftRight: 'slow',
      KeyX: 'bomb', Space: 'bomb', KeyK: 'bomb',
      Escape: 'pause', KeyP: 'pause', Enter: 'confirm', NumpadEnter: 'confirm', KeyZ: 'confirm',
      KeyM: 'mute',
    };
    window.addEventListener('keydown', (e) => {
      const a = map[e.code];
      if (!a) return;
      // a focused slider keeps left/right for itself; up/down still move the menu focus, Esc closes
      if (e.target && e.target.tagName === 'INPUT' && (e.target.type !== 'range' || a === 'left' || a === 'right')) return;
      // a focused button handles Enter/Space itself (native click); don't also start the game
      if ((a === 'confirm' || e.code === 'Space') && e.target && e.target.closest && e.target.closest('button')) return;
      if (a === 'bomb' || a.startsWith('up') || a === 'down' || a === 'left' || a === 'right' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.edges.add(a);
      this.keys.add(a);
      this.usingTouch = false;
    });
    window.addEventListener('keyup', (e) => { const a = map[e.code]; if (a) this.keys.delete(a); });
    window.addEventListener('blur', () => { this.keys.clear(); this.releaseStick(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseStick(); });

    const s = this.surface;
    s.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('button, input, .panel, #stick')) return;
      // The jet moves only with the joystick (touch) or the keyboard/gamepad (computer);
      // taps and clicks elsewhere just count as a 'tap' (e.g. to skip the results tally).
      if (e.pointerType !== 'mouse') this.usingTouch = true;
      this.edges.add('tap');
    });
    // keep the page from scrolling/zooming under the game
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    // block page scroll/zoom during play, but let menu panels scroll
    s.addEventListener('touchmove', (e) => {
      if (!e.cancelable) return;
      if (e.target && e.target.closest && e.target.closest('.screen:not([hidden])')) return;
      e.preventDefault();
    }, { passive: false });
  }
  // On-screen joystick. zone: the touch area; base: the ring; knob: the moving cap.
  bindStick(zone, base, knob) {
    const st = this.stick = { id: null, x: 0, y: 0, cx: 0, cy: 0, R: 48, zone, knob };
    const move = (px, py) => {
      let dx = px - st.cx, dy = py - st.cy;
      const len = Math.hypot(dx, dy);
      if (len > st.R) { dx *= st.R / len; dy *= st.R / len; }
      this.dragTravel += Math.hypot(dx / st.R - st.x, dy / st.R - st.y) * st.R; // retires the movement hint
      st.x = dx / st.R; st.y = dy / st.R;
      knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    };
    zone.addEventListener('pointerdown', (e) => {
      if (st.id !== null) return;
      e.preventDefault(); e.stopPropagation();
      const r = base.getBoundingClientRect();
      st.cx = r.left + r.width / 2; st.cy = r.top + r.height / 2; st.R = r.width * 0.4;
      st.id = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      zone.classList.add('active');
      this.usingTouch = true;
      move(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== st.id) return;
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      const last = list && list.length ? list[list.length - 1] : e;
      move(last.clientX, last.clientY);
    });
    const up = (e) => { if (e.pointerId === st.id) this.releaseStick(); };
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
    zone.addEventListener('lostpointercapture', up);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  // On-screen hold-to-focus button (touch): tucks the option drones while held, without slowing.
  bindFocus(btn) {
    this.focusBtn = btn;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.touchFocus = true;
      btn.classList.add('active');
    });
    const up = () => { this.touchFocus = false; btn.classList.remove('active'); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  // Let go of every on-screen control (joystick and focus button).
  releaseStick() {
    this.touchFocus = false;
    if (this.focusBtn) this.focusBtn.classList.remove('active');
    const st = this.stick;
    if (!st) return;
    st.id = null; st.x = 0; st.y = 0;
    st.knob.style.transform = '';
    st.zone.classList.remove('active');
  }
  // Digital + analog movement axis in [-1, 1] (x right, y down). slow: slow move (Shift, pad
  // LB/LT/RT), which also tucks the drones; focus: tucks them without slowing (touch 集中 button).
  axis() {
    let x = 0, y = 0;
    if (this.keys.has('left')) x -= 1;
    if (this.keys.has('right')) x += 1;
    if (this.keys.has('up')) y -= 1;
    if (this.keys.has('down')) y += 1;
    if (x && y) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
    if (Math.abs(this.pad.x) > Math.abs(x)) x = this.pad.x;
    if (Math.abs(this.pad.y) > Math.abs(y)) y = this.pad.y;
    const st = this.stick;
    if (st && st.id !== null) {
      // dead zone + gentle curve: small pushes give fine control, full push gives full speed
      const m = Math.hypot(st.x, st.y);
      if (m > 0.1) {
        const k = Math.min(1, (m - 0.1) / 0.9);
        const c = (k * (0.3 + 0.7 * k)) / m;
        return { x: st.x * c, y: st.y * c, slow: false, focus: this.touchFocus, stick: true };
      }
      return { x: 0, y: 0, slow: false, focus: this.touchFocus, stick: true };
    }
    return { x, y, slow: this.keys.has('slow') || this.pad.slow, focus: this.touchFocus };
  }
  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    if (!gp) { this.pad.x = 0; this.pad.y = 0; this.pad.slow = false; return; }
    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
    let x = dz(gp.axes[0] || 0), y = dz(gp.axes[1] || 0);
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) y = -1; if (b(13)) y = 1;
    this.pad.x = x; this.pad.y = y;
    const slow = b(4) || b(6) || b(7); // LB / LT / RT (RB is a bomb button)
    this.pad.slow = slow;
    const bomb = b(1) || b(2) || b(5), start = b(9), confirm = b(0);
    if (bomb && !this.pad.prevBomb) { this.edges.add('bomb'); if (b(1)) this.edges.add('padBack'); }
    if (start && !this.pad.prevStart) this.edges.add('pause');
    if (confirm && !this.pad.prevPause) this.edges.add('padConfirm');
    const navY = y < -0.5 ? -1 : y > 0.5 ? 1 : 0, navX = x < -0.5 ? -1 : x > 0.5 ? 1 : 0;
    if (navY !== this.pad.prevNav) { if (navY < 0) this.edges.add('navUp'); if (navY > 0) this.edges.add('navDown'); }
    if (navX !== this.pad.prevNavX) { if (navX < 0) this.edges.add('navLeft'); if (navX > 0) this.edges.add('navRight'); }
    this.pad.prevNav = navY; this.pad.prevNavX = navX;
    this.pad.prevBomb = bomb; this.pad.prevStart = start; this.pad.prevPause = confirm;
    if (x || y || slow || bomb || start || confirm) { this.usingTouch = false; this.padUsed = true; }
  }
  // Edge-triggered action (true once per press).
  take(action) { if (this.edges.has(action)) { this.edges.delete(action); return true; } return false; }
  clearEdges() { this.edges.clear(); }
}
