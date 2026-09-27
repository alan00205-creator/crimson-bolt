// input.js — keyboard, pointer (touch/mouse drag = relative movement) and gamepad.
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
      if (a === 'bomb' || a.startsWith('up') || a === 'down' || a === 'left' || a === 'right' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.edges.add(a);
      this.keys.add(a);
      this.usingTouch = false;
    });
    window.addEventListener('keyup', (e) => { const a = map[e.code]; if (a) this.keys.delete(a); });
    window.addEventListener('blur', () => { this.keys.clear(); this._endDrag(); });

    const s = this.surface;
    s.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('button, input, .panel')) return;
      if (e.pointerType === 'touch') this.usingTouch = true;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (this.dragId === null) {
        this.dragId = e.pointerId;
        this.dragLast = { x: e.clientX, y: e.clientY };
        try { s.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      } else if (e.pointerType === 'touch' && this.touches.size === 2) {
        // second finger tap = bomb
        this.edges.add('bomb');
      }
      this.edges.add('tap');
    });
    s.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragId || !this.dragLast) return;
      // coalesced events give smoother movement on high-rate touch screens
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      const last = list && list.length ? list[list.length - 1] : e;
      this.dragDX += last.clientX - this.dragLast.x;
      this.dragDY += last.clientY - this.dragLast.y;
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
    s.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  }
  _endDrag() { this.dragId = null; this.dragLast = null; }
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
