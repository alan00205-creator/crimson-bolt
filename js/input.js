// input.js — keyboard, on-screen joystick (touch), mouse drag (desktop) and gamepad.
export class Input {
  constructor(surface) {
    this.surface = surface;
    this.keys = new Set();
    this.edges = new Set();       // actions triggered since last consume
    this.dragId = null;
    this.dragLast = null;         // {x, y} in client px
    this.dragDX = 0; this.dragDY = 0; // accumulated px since last consume
    this.touches = new Map();
    this.usingTouch = false;
    this.dragTravel = 0; // total drag distance in px (used to retire the movement hint)
    this.pad = { x: 0, y: 0, bomb: false, pause: false, prevBomb: false, prevPause: false, prevStart: false, start: false };
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
      if (e.target && (e.target.tagName === 'INPUT')) return;
      // a focused button handles Enter/Space itself (native click); don't also start the game
      if ((a === 'confirm' || e.code === 'Space') && e.target && e.target.closest && e.target.closest('button')) return;
      if (a === 'bomb' || a.startsWith('up') || a === 'down' || a === 'left' || a === 'right' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.edges.add(a);
      this.keys.add(a);
      this.usingTouch = false;
    });
    window.addEventListener('keyup', (e) => { const a = map[e.code]; if (a) this.keys.delete(a); });
    window.addEventListener('blur', () => { this.keys.clear(); this.touches.clear(); this._endDrag(); this.releaseStick(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.touches.clear(); this._endDrag(); this.releaseStick(); } });

    const s = this.surface;
    s.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('button, input, .panel, #stick')) return;
      // Touch/pen move the jet only through the joystick; the rest of the screen does nothing.
      if (e.pointerType !== 'mouse') { this.usingTouch = true; this.edges.add('tap'); return; }
      if (this.dragId !== null && !this.touches.has(this.dragId)) this._endDrag(); // stale drag (lost pointerup)
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (this.dragId === null) {
        this.dragId = e.pointerId;
        this.dragLast = { x: e.clientX, y: e.clientY };
        try { s.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }
      this.edges.add('tap');
    });
    s.addEventListener('pointermove', (e) => {
      const tp = this.touches.get(e.pointerId);
      if (tp) { tp.x = e.clientX; tp.y = e.clientY; }
      if (e.pointerId !== this.dragId || !this.dragLast) return;
      // coalesced events give smoother movement on high-rate touch screens
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      const last = list && list.length ? list[list.length - 1] : e;
      this.dragDX += last.clientX - this.dragLast.x;
      this.dragDY += last.clientY - this.dragLast.y;
      this.dragTravel += Math.abs(last.clientX - this.dragLast.x) + Math.abs(last.clientY - this.dragLast.y);
      this.dragLast.x = last.clientX; this.dragLast.y = last.clientY;
    });
    const end = (e) => {
      this.touches.delete(e.pointerId);
      if (e.pointerId === this.dragId) {
        // hand the drag over to a remaining finger, if any
        this._endDrag();
        for (const [id, t] of this.touches) { this.dragId = id; this.dragLast = { x: t.x, y: t.y }; break; }
      }
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('lostpointercapture', (e) => { if (e.pointerId === this.dragId) this._endDrag(); });
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
  _endDrag() { this.dragId = null; this.dragLast = null; }
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
  releaseStick() {
    const st = this.stick;
    if (!st) return;
    st.id = null; st.x = 0; st.y = 0;
    st.knob.style.transform = '';
    st.zone.classList.remove('active');
  }
  get dragging() { return this.dragId !== null; }
  // Accumulated drag in client pixels since the last call.
  consumeDrag() { const d = { x: this.dragDX, y: this.dragDY }; this.dragDX = 0; this.dragDY = 0; return d; }
  // Digital + analog movement axis in [-1, 1] (x right, y down).
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
        return { x: st.x * c, y: st.y * c, slow: false, stick: true };
      }
      return { x: 0, y: 0, slow: false, stick: true };
    }
    return { x, y, slow: this.keys.has('slow') };
  }
  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    if (!gp) { this.pad.x = 0; this.pad.y = 0; return; }
    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
    let x = dz(gp.axes[0] || 0), y = dz(gp.axes[1] || 0);
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) y = -1; if (b(13)) y = 1;
    this.pad.x = x; this.pad.y = y;
    const bomb = b(1) || b(2) || b(5), start = b(9), confirm = b(0);
    if (bomb && !this.pad.prevBomb) this.edges.add('bomb');
    if (start && !this.pad.prevStart) this.edges.add('pause');
    if (confirm && !this.pad.prevPause) this.edges.add('confirm');
    this.pad.prevBomb = bomb; this.pad.prevStart = start; this.pad.prevPause = confirm;
    if (x || y) this.usingTouch = false;
  }
  // Edge-triggered action (true once per press).
  take(action) { if (this.edges.has(action)) { this.edges.delete(action); return true; } return false; }
  clearEdges() { this.edges.clear(); }
}
