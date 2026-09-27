// =============================================================================
// CRIMSON BOLT (赤電) — procedural low-poly models
// -----------------------------------------------------------------------------
// Everything here is built from code: no model files, no image files.
//
// Conventions (see CONTRACT.md):
//   * every factory returns a new THREE.Group, nose/front toward −z, up +y;
//     air units are centred on the origin, ground units have their base at y=0
//   * geometry is built once per type and cached; materials are created per
//     instance so every instance can flash on its own
//   * static sub-parts are merged into one BufferGeometry with per-face vertex
//     colours ("panel lines" are colour bands) and a second per-vertex attribute
//     `emit` (HDR emission). A small shader patch adds `emit` to the emissive
//     radiance, so glowing eyes / engines / energy lines live in the SAME mesh
//     as the hull that carries them. That keeps every model at 1–4 draw calls.
//   * glow values are > 1.0 linear so the bloom pass catches them; on LOW
//     quality (no bloom) they still read as hot, saturated colour.
//
// Extras beyond the contract (all optional for core to use):
//   * userData.muzzles of tank / turret / gunboat / crawler are refreshed by
//     update() to follow the turret's current yaw (still group-local space);
//     turret.userData.muzzles holds the same points in turret-local space.
//   * userData.kind, userData.dispose() (frees this instance's materials; shared
//     geometry stays cached until disposeAll()), userData.halfExtents {x,z} on
//     the long units (gunboat, bomber, crawler) for an optional box test.
//   * crawler parts (turret / gunL / gunR) have radius, setFlash, setDestroyed
//     and part-local muzzles, exactly like boss parts.
//   * player: userData.bankPivot (the rolling sub-group). setBank(b > 0) rolls
//     RIGHT (right wing down) — pass +1 while strafing toward +x.
//   * createShadow() bakes one soft silhouette (JS-rasterised DataTexture, no
//     canvas read-back) per model kind, always from a pristine instance of that
//     kind, onto a single quad (1 draw call, no double-darkening where parts overlap).
// =============================================================================
import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ----------------------------------------------------------------- colours ---
const _col = new THREE.Color();
/** sRGB hex → linear rgb triple (optionally scaled) */
function lin(hex, k = 1) { _col.set(hex); return [_col.r * k, _col.g * k, _col.b * k]; }
function rgb(r, g, b, k = 1) { return [r * k, g * k, b * k]; }
const Z3 = [0, 0, 0];
/** a face style: albedo + HDR emission */
function S(c, e = Z3) { return { c, e }; }
function lit(hex, k = 1) { return S(lin(hex, k)); }
/** glowing face: albedo is a dim copy of the hue, emission carries the light */
function GL(e, k = 0.35) {
  const m = Math.max(e[0], e[1], e[2]) || 1;
  return S([Math.min(1, (e[0] / m) * k), Math.min(1, (e[1] / m) * k), Math.min(1, (e[2] / m) * k)], e);
}
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// HDR emission colours (linear). > 1 so bloom (threshold ≈ 0.85) catches them.
const EM = {
  eyeRed: rgb(1.0, 0.13, 0.04, 3.6),
  eyeOrange: rgb(1.0, 0.38, 0.06, 3.2),
  engine: rgb(1.0, 0.5, 0.16, 3.4),
  engineHot: rgb(1.0, 0.78, 0.5, 4.2),
  magenta: rgb(1.0, 0.1, 0.72, 2.8),
  magentaHot: rgb(1.0, 0.45, 0.9, 4.2),
  violet: rgb(0.55, 0.18, 1.0, 3.4),
  green: rgb(0.2, 1.0, 0.35, 3.0),
  amber: rgb(1.0, 0.55, 0.06, 3.0),
  red: rgb(1.0, 0.06, 0.04, 3.4),
  // smoulder (wreckage): deliberately ≤ 1 — ACES pushes brighter reds toward peach/yellow and the
  // wrecks read as orange crystals; kept low they stay a red-hot glow even without bloom
  ember: rgb(1.0, 0.13, 0.015, 0.85),
  emberDim: rgb(1.0, 0.1, 0.01, 0.6),
  white: rgb(1, 1, 1, 3.0),
};

// ------------------------------------------------------------ vector utils ---
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
function centroid(pts) {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  const n = pts.length; return [x / n, y / n, z / n];
}
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
/** build-time matrix helper: translate + euler(xyz) + uniform/vec scale */
function M(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  const sv = Array.isArray(s) ? new THREE.Vector3(s[0], s[1], s[2]) : new THREE.Vector3(s, s, s);
  return new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), sv);
}

// =============================================================================
// GB — tiny geometry builder: non-indexed triangle soup with per-face colours.
// Every primitive orients its faces outward automatically (per-face test
// against a reference point / direction), so winding bugs can't cause holes.
// =============================================================================
class GB {
  constructor() { this.p = []; this.c = []; this.e = []; }
  get n() { return this.p.length / 9; }

  raw(a, b, c, s) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const k = s.c, e = s.e;
    this.c.push(k[0], k[1], k[2], k[0], k[1], k[2], k[0], k[1], k[2]);
    this.e.push(e[0], e[1], e[2], e[0], e[1], e[2], e[0], e[1], e[2]);
  }
  /** triangle whose normal points along `dir` */
  triN(a, b, c, dir, s) {
    if (!s) return;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-16) return;
    if (nx * dir[0] + ny * dir[1] + nz * dir[2] < 0) this.raw(a, c, b, s); else this.raw(a, b, c, s);
  }
  /** triangle whose normal points away from `ref` */
  triO(a, b, c, ref, s) {
    this.triN(a, b, c, [(a[0] + b[0] + c[0]) / 3 - ref[0], (a[1] + b[1] + c[1]) / 3 - ref[1], (a[2] + b[2] + c[2]) / 3 - ref[2]], s);
  }
  quadO(a, b, c, d, ref, s) { this.triO(a, b, c, ref, s); this.triO(a, c, d, ref, s); }
  quadN(a, b, c, d, dir, s) { this.triN(a, b, c, dir, s); this.triN(a, c, d, dir, s); }
  /** convex polygon fan facing `dir` */
  decal(pts, s, dir = [0, 1, 0]) {
    for (let k = 1; k < pts.length - 1; k++) this.triN(pts[0], pts[k], pts[k + 1], dir, s);
    return this;
  }
  fan(ring, center, dir, s) {
    const N = ring.length;
    for (let j = 0; j < N; j++) this.triN(center, ring[j], ring[(j + 1) % N], dir, typeof s === 'function' ? s(j) : s);
  }
  /**
   * Skin consecutive closed rings (same point count). style(i, j) → face style
   * or null to skip; i = segment index, j = edge index within the ring.
   */
  loft(rings, style, capA = null, capB = null) {
    const R = rings.length, N = rings[0].length;
    const cen = rings.map(centroid);
    for (let i = 0; i < R - 1; i++) {
      const r0 = rings[i], r1 = rings[i + 1];
      const ref = mid(cen[i], cen[i + 1]);
      for (let j = 0; j < N; j++) {
        const s = typeof style === 'function' ? style(i, j) : style;
        if (!s) continue;
        const j1 = (j + 1) % N;
        this.quadO(r0[j], r0[j1], r1[j1], r1[j], ref, s);
      }
    }
    if (capA) this.fan(rings[0], cen[0], sub(cen[0], cen[1]), capA);
    if (capB) this.fan(rings[R - 1], cen[R - 1], sub(cen[R - 1], cen[R - 2]), capB);
    return this;
  }
  /** surface of revolution around `axis` through `o`; prof = [[dist, radius], …] */
  lathe(o, axis, prof, n, style, capA = null, capB = null, opt = {}) {
    const a = nrm(axis);
    const u = Math.abs(a[1]) < 0.99 ? nrm(crs([0, 1, 0], a)) : [1, 0, 0];
    const v = crs(a, u);
    const ph = opt.phase ?? 0, sx = opt.sx ?? 1, sy = opt.sy ?? 1;
    const rings = prof.map(([d, r]) => {
      const ring = [];
      for (let k = 0; k < n; k++) {
        const th = ph + (TAU * k) / n, cu = Math.cos(th) * r * sx, sv = Math.sin(th) * r * sy;
        ring.push([o[0] + a[0] * d + u[0] * cu + v[0] * sv, o[1] + a[1] * d + u[1] * cu + v[1] * sv, o[2] + a[2] * d + u[2] * cu + v[2] * sv]);
      }
      return ring;
    });
    return this.loft(rings, style, capA, capB);
  }
  /** chamfered / tapered box. faces: front(−z) right(+x) back(+z) left(−x) top bev bottom */
  block(o) {
    const { x = 0, y = 0, z = 0, w, d, h } = o;
    const tw = o.tw ?? w, td = o.td ?? d, ox = o.ox ?? 0, oz = o.oz ?? 0, bev = o.bev ?? 0;
    const rect = (cx, cy, cz, W, D) => [[cx - W / 2, cy, cz - D / 2], [cx + W / 2, cy, cz - D / 2], [cx + W / 2, cy, cz + D / 2], [cx - W / 2, cy, cz + D / 2]];
    const rings = [rect(x, y, z, w, d)];
    if (bev > 0) {
      rings.push(rect(x + ox, y + h - bev, z + oz, tw, td));
      rings.push(rect(x + ox, y + h, z + oz, Math.max(0.001, tw - 2 * bev), Math.max(0.001, td - 2 * bev)));
    } else rings.push(rect(x + ox, y + h, z + oz, tw, td));
    const sides = [o.front ?? o.side, o.right ?? o.side, o.back ?? o.side, o.left ?? o.side];
    const from = this.n;
    this.loft(rings, (i, j) => (i === 0 ? sides[j] : (o.bevS ?? o.top)), o.bottom ?? null, o.top);
    if (o.rx || o.ry || o.rz) {
      const m = M(x, y, z, o.rx || 0, o.ry || 0, o.rz || 0).multiply(M(-x, -y, -z));
      this.xform(from, m);
    }
    return this;
  }
  /** extruded polygon in the XZ plane; outline = [[x,z],…] (any winding) */
  plate(outline, y0, y1, top, side, bottom = null) {
    const v2 = outline.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(v2, []);
    for (const [i0, i1, i2] of tris) {
      const A = outline[i0], B = outline[i1], C = outline[i2];
      if (top) this.triN([A[0], y1, A[1]], [B[0], y1, B[1]], [C[0], y1, C[1]], [0, 1, 0], top);
      if (bottom) this.triN([A[0], y0, A[1]], [B[0], y0, B[1]], [C[0], y0, C[1]], [0, -1, 0], bottom);
    }
    if (side) {
      let ar = 0;
      for (let i = 0; i < outline.length; i++) {
        const p = outline[i], q = outline[(i + 1) % outline.length];
        ar += p[0] * q[1] - q[0] * p[1];
      }
      const sg = ar > 0 ? 1 : -1;
      for (let i = 0; i < outline.length; i++) {
        const p = outline[i], q = outline[(i + 1) % outline.length];
        const ex = q[0] - p[0], ez = q[1] - p[1];
        const out = sg > 0 ? [ez, 0, -ex] : [-ez, 0, ex];
        const s = typeof side === 'function' ? side(i) : side;
        this.quadN([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], out, s);
      }
    }
    return this;
  }
  /** airfoil loft along the span; sections {x, y, zl, zt, t, tb} (see foil) */
  wing(secs, style, capA = null, capB = null) { return this.loft(secs.map(foil), style, capA, capB); }

  /** pyramid from a base polygon to a tip */
  spike(base, tip, style, baseStyle = null) {
    const ref = centroid([...base, tip]);
    for (let k = 0; k < base.length; k++) this.triO(base[k], base[(k + 1) % base.length], tip, ref, typeof style === 'function' ? style(k) : style);
    if (baseStyle) for (let k = 1; k < base.length - 1; k++) this.triO(base[0], base[k], base[k + 1], ref, baseStyle);
    return this;
  }
  /** highest upward-facing surface of triangles [from,to) above (x,z), or null */
  surfaceY(x, z, from = 0, to = this.n) {
    let best = null; const p = this.p;
    for (let t = from; t < to; t++) {
      const i = t * 9;
      const ax = p[i], az = p[i + 2], bx = p[i + 3], bz = p[i + 5], cx = p[i + 6], cz = p[i + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-5 || l2 < -1e-5 || l3 < -1e-5) continue;
      const y = l1 * p[i + 1] + l2 * p[i + 4] + l3 * p[i + 7];
      if (best === null || y > best) best = y;
    }
    return best;
  }
  /** conformal decal: convex quads [[x,z]×4] subdivided n×n and draped onto the
   *  existing surface of triangles [from,to) (+lift) — for livery on curved skins */
  drape(quads, style, from, to, lift = 0.004, n = 3) {
    const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (const q of quads) {
      const grid = [];
      for (let u = 0; u <= n; u++) {
        const row = [];
        const e0 = lerp2(q[0], q[3], u / n), e1 = lerp2(q[1], q[2], u / n);
        for (let v = 0; v <= n; v++) {
          const [x, z] = lerp2(e0, e1, v / n);
          const y = this.surfaceY(x, z, from, to);
          row.push(y === null ? null : [x, y + lift, z]);
        }
        grid.push(row);
      }
      for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) {
        const a = grid[u][v], b = grid[u][v + 1], c = grid[u + 1][v + 1], d = grid[u + 1][v];
        if (a && b && c && d) this.quadN(a, b, c, d, [0, 1, 0], style);
      }
    }
    return this;
  }

  xform(from, m, to = this.n) {
    const e = m.elements, p = this.p;
    for (let i = from * 9; i < to * 9; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      p[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      p[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      p[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    if (m.determinant() < 0) this._flip(from, to);
    return this;
  }
  _flip(from, to) {
    for (const arr of [this.p, this.c, this.e]) {
      for (let t = from; t < to; t++) {
        const i = t * 9;
        for (let k = 0; k < 3; k++) { const tmp = arr[i + 3 + k]; arr[i + 3 + k] = arr[i + 6 + k]; arr[i + 6 + k] = tmp; }
      }
    }
  }
  /** append x-mirrored copies of triangles [from, to) */
  mirrorX(from = 0, to = this.n) {
    const p = this.p, c = this.c, e = this.e;
    for (let t = from; t < to; t++) {
      const i = t * 9;
      p.push(-p[i], p[i + 1], p[i + 2], -p[i + 6], p[i + 7], p[i + 8], -p[i + 3], p[i + 4], p[i + 5]);
      c.push(c[i], c[i + 1], c[i + 2], c[i + 6], c[i + 7], c[i + 8], c[i + 3], c[i + 4], c[i + 5]);
      e.push(e[i], e[i + 1], e[i + 2], e[i + 6], e[i + 7], e[i + 8], e[i + 3], e[i + 4], e[i + 5]);
    }
    return this;
  }
  /** append a copy of triangles [from,to) transformed by m */
  dup(from, to, m) {
    const start = this.n;
    this.p.push(...this.p.slice(from * 9, to * 9));
    this.c.push(...this.c.slice(from * 9, to * 9));
    this.e.push(...this.e.slice(from * 9, to * 9));
    return this.xform(start, m);
  }
  build() {
    const n = this.p.length;
    const pos = new Float32Array(this.p), nor = new Float32Array(n);
    for (let i = 0; i < n; i += 9) {
      const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
      const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 9; k += 3) { nor[i + k] = nx; nor[i + k + 1] = ny; nor[i + k + 2] = nz; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setAttribute('emit', new THREE.BufferAttribute(new Float32Array(this.e), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** 6-point faceted airfoil section at span position x.
 * edges: 0 LE→front-top, 1 front-top→ridge, 2 ridge→rear-top, 3 rear-top→TE (flap), 4 TE→belly, 5 belly→LE */
function foil({ x, y = 0, zl, zt, t, tb = 0.5 }) {
  const c = zt - zl;
  return [[x, y, zl], [x, y + t * 0.55, zl + 0.16 * c], [x, y + t, zl + 0.42 * c], [x, y + t * 0.5, zl + 0.78 * c], [x, y, zt], [x, y - t * tb, zl + 0.45 * c]];
}

/**
 * Wreck generator: keeps the triangles where keep(cx,cy,cz) ≥ 0, crumples
 * vertices (position-hashed so the shell stays closed), scorches the albedo,
 * adds smouldering embers and jagged torn-metal shards along the cut band.
 */
function wreckOf(src, opt) {
  const out = new GB();
  const P = src.p, C = src.c, E = src.e;
  const cr = opt.crumple ?? 0.06, sc = opt.scorch ?? 0.34, seed = opt.seed ?? 1, band = opt.band ?? 0.3;
  const SOOT = lin('#141313'), ASH = lin('#6d6760'), RUST = lin('#5a3522');
  const edge = [];
  const disp = (x, y, z) => [
    x + (hash3(x * 9.1 + seed, y * 9.3, z * 9.7) - 0.5) * cr,
    y + (hash3(y * 7.3, z * 7.9 + seed, x * 7.1) - 0.5) * cr * 0.7,
    z + (hash3(z * 8.3, x * 8.9, y * 8.1 + seed) - 0.5) * cr];
  for (let t = 0; t < src.n; t++) {
    const i = t * 9;
    const cx = (P[i] + P[i + 3] + P[i + 6]) / 3, cy = (P[i + 1] + P[i + 4] + P[i + 7]) / 3, cz = (P[i + 2] + P[i + 5] + P[i + 8]) / 3;
    const d = opt.keep(cx, cy, cz);
    if (d < 0) continue;
    const a = disp(P[i], P[i + 1], P[i + 2]), b = disp(P[i + 3], P[i + 4], P[i + 5]), c = disp(P[i + 6], P[i + 7], P[i + 8]);
    const r = hash3(cx * 3.1 + seed, cy * 3.7, cz * 3.3);
    let col = [C[i] * sc, C[i + 1] * sc, C[i + 2] * sc];
    if (r < 0.28) col = mix3(col, SOOT, 0.75);
    else if (r > 0.82) col = mix3(col, ASH, 0.55);
    else if (r > 0.7) col = mix3(col, RUST, 0.5);
    let em = Z3;
    const glowed = E[i] + E[i + 1] + E[i + 2] > 0.2;
    if (glowed) { col = SOOT; em = r < 0.55 ? EM.emberDim : Z3; }
    else if (r > 0.955) em = EM.emberDim;
    out.raw(a, b, c, S(col, em));
    if (d < band) edge.push([cx, cy, cz]);
  }
  // torn metal shards + embers along the cut
  const dir = opt.dir ?? [0, 1, 0];
  const nShard = Math.min(opt.shards ?? 10, edge.length);
  // torn plate: mostly soot-dark metal with a bright bent edge catching the sun;
  // only every third shard carries an ember face (glowing tears, not orange confetti)
  const DARK = S(lin('#1a1918')), EDGE = S(lin('#77726b')), EMB = GL(EM.ember, 0.12), EMB2 = GL(EM.emberDim, 0.12);
  for (let k = 0; k < nShard; k++) {
    const pc = edge[Math.floor(hash3(k * 13.1 + seed, k * 7.7, 1.3) * edge.length)];
    const s = (opt.shardSize ?? 0.18) * (0.6 + hash3(k, seed, 2.2) * 0.8);
    const jit = [(hash3(k, 1.1, seed) - 0.5) * s, (hash3(k, 2.1, seed) - 0.2) * s, (hash3(k, 3.1, seed) - 0.5) * s];
    const tip = addv(pc, addv(scl(dir, s * 1.6), jit));
    const up = Math.abs(dir[1]) > 0.8 ? [1, 0, 0] : [0, 1, 0];
    const u = nrm(crs(dir, up)), v = nrm(crs(dir, u));
    const b0 = addv(pc, scl(u, s * 0.5)), b1 = addv(pc, addv(scl(u, -s * 0.35), scl(v, s * 0.4))), b2 = addv(pc, addv(scl(u, -s * 0.2), scl(v, -s * 0.45)));
    const ref = centroid([b0, b1, b2, tip]);
    out.triO(b0, b1, tip, ref, DARK);
    out.triO(b1, b2, tip, ref, EDGE);
    out.triO(b2, b0, tip, ref, k % 3 === 0 ? EMB : k % 6 === 1 ? EMB2 : DARK);
    out.triO(b0, b2, b1, ref, DARK);
  }
  return out;
}

// =============================================================================
// Materials
// =============================================================================
/** MeshStandardMaterial + per-vertex HDR emission (attribute `emit`). All
 *  instances share one GPU program (same onBeforeCompile source). */
class EmitMaterial extends THREE.MeshStandardMaterial {
  constructor(params) {
    super(params);
    this.uEmitScale = { value: 1 };
    this.uEmitTint = { value: new THREE.Color(1, 1, 1) };
  }
  onBeforeCompile(shader) {
    shader.uniforms.uEmitScale = this.uEmitScale;
    shader.uniforms.uEmitTint = this.uEmitTint;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 emit;\nvarying vec3 vEmit;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvEmit = emit;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEmit;\nuniform float uEmitScale;\nuniform vec3 uEmitTint;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vEmit * uEmitTint * uEmitScale;');
  }
  copy(src) {
    super.copy(src);
    this.uEmitScale = { value: src.uEmitScale ? src.uEmitScale.value : 1 };
    this.uEmitTint = { value: src.uEmitTint ? src.uEmitTint.value.clone() : new THREE.Color(1, 1, 1) };
    return this;
  }
}
function bodyMat(rough = 0.6, metal = 0.25) {
  return new EmitMaterial({ vertexColors: true, flatShading: true, roughness: rough, metalness: metal });
}
function additiveMat(opts = {}) {
  return new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, ...opts,
  });
}
const FLASH_K = 0.62;   // emissive white at v=1: reads as a white-hot hit without turning big models into bloom blobs
function flashFn(mats) {
  return (v) => {
    const f = Math.max(0, Math.min(1, v)) * FLASH_K;
    for (let i = 0; i < mats.length; i++) mats[i].emissive.setScalar(f);
  };
}

// =============================================================================
// Caches
// =============================================================================
const GEO = new Map();
const TEX = new Map();
const SHADOW = new Map();
function G(key, fn) {
  let g = GEO.get(key);
  if (!g) { g = fn(); GEO.set(key, g); }
  return g;
}
/** like G() but fn returns a GB; also caches the GB for wreck derivation */
const GBS = new Map();
function GG(key, fn) {
  let g = GEO.get(key);
  if (!g) { const b = fn(); GBS.set(key, b); g = b.build(); GEO.set(key, g); }
  return g;
}
function gbOf(key, fn) { GG(key, fn); return GBS.get(key); }

// =============================================================================
// Palettes
// =============================================================================
const PL = { // player — albedos capped so sun-lit faces stay under the bloom threshold
  crimson: lit('#b0111b'), crimsonLt: lit('#cf222b'), crimsonDk: lit('#5e0810'), crimsonMd: lit('#870c15'),
  white: lit('#dde2e8'), steel: lit('#96a0ac'), steelDk: lit('#515964'),
  belly: lit('#59616c'), bellyDk: lit('#3a4048'), gunDk: lit('#202429'), black: lit('#0b0d10'),
  radome: lit('#2a2f36'), nozzle: lit('#353a42'),
  glass: S(lin('#119bd8'), rgb(0.01, 0.1, 0.19)), glassLt: S(lin('#74d4fb'), rgb(0.03, 0.22, 0.32)),
  intake: lit('#0a0b0e'),
};
const EN = { // generic enemy palette
  gun: lit('#48505b'), gunLt: lit('#6c7581'), gunDk: lit('#2b3038'), gunXDk: lit('#1b1e23'),
  edge: lit('#b4bcc6'), edgeLt: lit('#d9dee4'),
  olive: lit('#5f6b3a'), oliveLt: lit('#7e8a50'), oliveDk: lit('#3d4526'),
  sand: lit('#b9a878'), sandLt: lit('#d8c998'), sandDk: lit('#857752'),
  orange: lit('#f07a16'), orangeDk: lit('#b8540c'), black: lit('#161616'),
  concrete: lit('#9c9b93'), concreteLt: lit('#b8b7ae'), concreteDk: lit('#6f6e68'), pit: lit('#35352f'),
  navy: lit('#465363'), navyDk: lit('#2b3440'), deck: lit('#a2a9b1'), deckDk: lit('#7a828c'), hullRed: lit('#8a2a22'),
  yellow: lit('#f2c02a'), yellowDk: lit('#c3951a'), khaki: lit('#5c6a30'),
  white: lit('#e9ecef'), glassDk: S(lin('#1c3140'), rgb(0.01, 0.04, 0.06)),
};
const BO = { // boss — blackened steel; bright trims carry the silhouette on a dark dusk sea
  steel: lit('#2e323a'), steelDk: lit('#1f2228'), steelXDk: lit('#131519'),
  plate: lit('#393e48'), panel: lit('#4a505c'), trim: lit('#8a94a6'), trimLt: lit('#b3bcca'),
  hazard: lit('#8e1a2d'), black: lit('#0c0d10'),
};

// =============================================================================
// PLAYER — "CRIMSON BOLT"
// =============================================================================
const P_FUS = [ // z, halfWidth, top, bottom, chineY
  [-0.97, 0.004, 0.004, 0.004, 0.000],
  [-0.87, 0.040, 0.032, 0.026, -0.004],
  [-0.75, 0.074, 0.064, 0.046, -0.008],
  [-0.58, 0.106, 0.092, 0.060, -0.010],
  [-0.40, 0.138, 0.114, 0.071, -0.012],
  [-0.22, 0.164, 0.124, 0.079, -0.012],
  [-0.19, 0.167, 0.125, 0.080, -0.012],
  [0.02, 0.188, 0.122, 0.085, -0.010],
  [0.24, 0.196, 0.117, 0.086, -0.008],
  [0.27, 0.196, 0.116, 0.086, -0.008],
  [0.46, 0.188, 0.109, 0.082, -0.006],
  [0.64, 0.176, 0.099, 0.078, -0.005],
  [0.74, 0.168, 0.093, 0.075, -0.005],
];
const P_SEG = ['radome', 'nose', 'nose', 'canopy', 'canopy', 'line', 'mid', 'mid', 'line', 'aft', 'aft', 'aft'];
function pTopAt(z) {
  for (let i = 0; i < P_FUS.length - 1; i++) {
    const a = P_FUS[i], b = P_FUS[i + 1];
    if (z >= a[0] && z <= b[0]) { const t = (z - a[0]) / (b[0] - a[0]); return a[2] + (b[2] - a[2]) * t; }
  }
  return 0.09;
}
function buildPlayer() {
  const b = new GB();
  // ---- fuselage (chined, 10-sided)
  const ring = ([z, w, tp, bt, ch]) => [
    [0, tp, z], [w * 0.22, tp * 0.985, z], [w * 0.62, tp * 0.82, z], [w, ch, z], [w * 0.6, -bt * 0.9, z],
    [0, -bt, z], [-w * 0.6, -bt * 0.9, z], [-w, ch, z], [-w * 0.62, tp * 0.82, z], [-w * 0.22, tp * 0.985, z]];
  b.loft(P_FUS.map(ring), (i, j) => {
    const tag = P_SEG[i];
    if (tag === 'radome') return PL.radome;
    const spine = j === 0 || j === 9, sh = j === 1 || j === 8, up = j === 2 || j === 7, lo = j === 3 || j === 6;
    if (tag === 'line') return spine ? PL.steel : (sh || up) ? PL.crimsonDk : lo ? PL.crimsonDk : PL.bellyDk;
    if (spine) return tag === 'canopy' ? PL.crimson : PL.white;
    if (sh) return PL.crimson;
    if (up) return PL.crimsonMd;
    if (lo) return PL.crimsonDk;
    return PL.belly;
  }, null, PL.gunDk);

  // ---- canopy (faceted bubble)
  const CN = [[-0.67, 0.006, 0.003], [-0.58, 0.052, 0.038], [-0.47, 0.078, 0.064], [-0.35, 0.087, 0.074],
    [-0.32, 0.087, 0.074], [-0.22, 0.078, 0.062], [-0.11, 0.05, 0.034], [-0.02, 0.012, 0.006]];
  const cring = ([z, cw, ch]) => {
    const y0 = pTopAt(z) - 0.014;
    return [[-cw, y0, z], [-cw * 0.8, y0 + ch * 0.56, z], [-cw * 0.42, y0 + ch * 0.93, z], [0, y0 + ch, z],
      [cw * 0.42, y0 + ch * 0.93, z], [cw * 0.8, y0 + ch * 0.56, z], [cw, y0, z], [0, y0 - 0.03, z]];
  };
  b.loft(CN.map(cring), (i, j) => {
    if (j >= 6) return null;
    if (i === 3) return PL.steel;                     // canopy bow frame
    if (i <= 1) return (j === 2 || j === 3) ? PL.glassLt : PL.glass;   // windscreen glint
    if (i === 4 && (j === 2 || j === 3)) return PL.glassLt;
    return PL.glass;
  });

  // ---- intakes (right, mirrored)
  const f0 = b.n;
  const IN = [[-0.25, 0.12, 0.288, -0.068, 0.062], [-0.22, 0.12, 0.288, -0.068, 0.062],
    [0.06, 0.12, 0.282, -0.066, 0.058], [0.36, 0.12, 0.2, -0.05, 0.03]];
  const iring = ([z, xi, xo, yb, yt]) => [[xi, yb, z], [xo, yb, z], [xo, yt - 0.03, z], [xo - 0.032, yt, z], [xi, yt, z]];
  b.loft(IN.map(iring), (i, j) => {
    if (j === 4) return null;
    if (i === 0) return j === 0 ? PL.steelDk : PL.white;   // inlet lip
    if (j === 0) return PL.belly;
    if (j === 1) return PL.crimsonDk;
    if (j === 2) return i === 1 ? PL.white : PL.crimsonMd;  // chamfer: white stripe on the intake
    return PL.crimson;
  }, PL.intake, null);

  // ---- main wing: cranked arrow with a leading-edge strake
  const w0 = b.n;
  b.wing([
    { x: 0.13, y: -0.016, zl: -0.3, zt: 0.62, t: 0.058 },
    { x: 0.24, y: -0.013, zl: -0.12, zt: 0.61, t: 0.052 },
    { x: 0.46, y: -0.007, zl: 0.065, zt: 0.59, t: 0.04 },
    { x: 0.64, y: -0.001, zl: 0.215, zt: 0.57, t: 0.03 },
    { x: 0.8, y: 0.005, zl: 0.35, zt: 0.55, t: 0.02 },
  ], (i, j) => {
    if (j >= 4) return PL.belly;
    if (j === 0) return i === 0 ? PL.steel : PL.white;       // bright leading edge
    if (j === 3) return i === 2 ? PL.crimsonMd : PL.crimsonDk; // flaps / aileron
    if (i === 3 && j === 1) return PL.crimsonLt;
    return PL.crimson;
  }, null, PL.crimsonDk);
  const w1 = b.n;
  // livery: white lightning bolt draped over the wing skin
  const bolt = [[0.19, 0.5], [0.43, 0.23], [0.47, 0.39], [0.735, 0.43]];
  const quads = [];
  for (let k = 0; k < bolt.length - 1; k++) {
    const [ax, az] = bolt[k], [bx, bz] = bolt[k + 1];
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    const w = k === 1 ? 0.036 : 0.042, nx = -uz * w, nz = ux * w, e = 0.018;
    const A = [ax - ux * e, az - uz * e], B = [bx + ux * e, bz + uz * e];
    quads.push([[A[0] + nx, A[1] + nz], [B[0] + nx, B[1] + nz], [B[0] - nx, B[1] - nz], [A[0] - nx, A[1] - nz]]);
  }
  b.drape(quads, PL.white, w0, w1, 0.0035, 4);
  // wing gun: short barrel poking out of the strake crank
  b.lathe([0.27, 0.004, 0.0], [0, 0, -1], [[0, 0.022], [0.1, 0.02], [0.1, 0.014], [0.17, 0.014]], 6,
    (i) => (i === 0 ? PL.steelDk : PL.gunDk), null, PL.black, { phase: Math.PI / 6 });
  // wingtip missile
  b.lathe([0.8, 0.006, 0.58], [0, 0, -1], [[0, 0.012], [0.04, 0.026], [0.42, 0.026], [0.52, 0.017], [0.6, 0.002]], 6,
    (i) => (i >= 3 ? PL.crimson : i === 0 ? PL.steelDk : PL.white), PL.gunDk, null, { phase: Math.PI / 6 });
  // canard
  b.wing([{ x: 0.1, y: 0.03, zl: -0.61, zt: -0.41, t: 0.022 }, { x: 0.33, y: 0.038, zl: -0.48, zt: -0.41, t: 0.01 }],
    (i, j) => (j >= 4 ? PL.belly : j === 0 ? PL.steel : PL.white), null, PL.white);
  // horizontal stabiliser
  b.wing([{ x: 0.15, y: -0.004, zl: 0.45, zt: 0.8, t: 0.026 }, { x: 0.38, zl: 0.62, zt: 0.83, t: 0.018 }, { x: 0.48, zl: 0.7, zt: 0.84, t: 0.012 }],
    (i, j) => (j >= 4 ? PL.belly : i === 1 ? PL.white : j === 0 ? PL.white : j === 3 ? PL.crimsonDk : PL.crimson), null, PL.white);
  // canted twin tail
  const f2 = b.n;
  b.wing([{ x: 0, zl: 0.33, zt: 0.74, t: 0.036 }, { x: 0.22, zl: 0.54, zt: 0.78, t: 0.022 }, { x: 0.31, zl: 0.62, zt: 0.8, t: 0.015 }],
    (i, j) => (i === 1 ? PL.white : j === 0 ? PL.crimsonLt : j >= 3 ? PL.crimsonDk : PL.crimson), null, PL.white);
  b.xform(f2, M(0.11, 0.08, 0, 0, 0, 62 * DEG));
  // engine nozzle with glowing core
  b.lathe([0.095, 0.0, 0.6], [0, 0, 1], [[0, 0.086], [0.14, 0.09], [0.17, 0.085], [0.3, 0.075], [0.3, 0.05]], 8,
    (i) => (i === 0 ? PL.gunDk : i === 1 ? PL.steel : i === 2 ? PL.nozzle : PL.gunDk), null, GL(EM.engineHot, 0.7), { phase: Math.PI / 8 });
  b.mirrorX(f0);
  return b;
}

function buildPlayerFlame() {
  const pos = [], col = [];
  const cone = (x, y, r, len, cb, ct, sides) => {
    for (let k = 0; k < sides; k++) {
      const a0 = (TAU * k) / sides, a1 = (TAU * (k + 1)) / sides;
      pos.push(x + Math.cos(a0) * r, y + Math.sin(a0) * r, 0, x + Math.cos(a1) * r, y + Math.sin(a1) * r, 0, x, y, len);
      col.push(...cb, ...cb, ...ct);
    }
  };
  for (const x of [-0.095, 0.095]) {
    cone(x, 0, 0.066, 0.62, rgb(1.0, 0.42, 0.1, 1.6), rgb(0.5, 0.05, 0.0, 0.0), 7);
    cone(x, 0, 0.04, 0.36, rgb(1.0, 0.85, 0.6, 2.6), rgb(1.0, 0.4, 0.1, 0.2), 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

function buildHitbox() {
  const pos = [], col = [];
  const core = rgb(1, 0.92, 0.96, 1.8), ring = rgb(1.0, 0.3, 0.6, 1.2);
  const r = 0.07;
  const V = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]];
  const F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  for (const f of F) for (const k of f) { pos.push(...V[k]); col.push(...core); }
  const N = 32, r0 = 0.285, r1 = 0.31;
  for (let k = 0; k < N; k++) {
    const a0 = (TAU * k) / N, a1 = (TAU * (k + 1)) / N;
    const p = (rr, a) => [Math.cos(a) * rr, 0, Math.sin(a) * rr];
    pos.push(...p(r0, a0), ...p(r1, a0), ...p(r1, a1), ...p(r0, a0), ...p(r1, a1), ...p(r0, a1));
    for (let q = 0; q < 6; q++) col.push(...ring);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

export function createPlayer() {
  const g = new THREE.Group(); g.name = 'player';
  const pivot = new THREE.Group(); pivot.name = 'bank'; g.add(pivot);
  const mat = bodyMat(0.5, 0.12);
  const body = new THREE.Mesh(GG('player', buildPlayer), mat); body.name = 'body';
  pivot.add(body);
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(G('player.flame', buildPlayerFlame), flameMat); flame.name = 'flame';
  flame.position.set(0, 0, 0.9); flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  const hb = new THREE.Mesh(G('player.hitbox', buildHitbox), new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  // at the collision centre on the plane (it ignores depth, so it never needs lifting above the canopy —
  // a lifted marker would project ~0.1 off the real hitbox under the tilted game camera)
  hb.name = 'hitbox'; hb.renderOrder = 50; hb.userData.noShadow = true;
  g.add(hb);

  const ud = g.userData;
  ud.kind = 'player';
  ud.radius = 0.3;
  ud.grazeRadius = 1.0;
  ud.debrisColor = new THREE.Color('#c41c26');
  ud.muzzles = [new THREE.Vector3(0, 0, -1.0), new THREE.Vector3(-0.27, 0, -0.2), new THREE.Vector3(0.27, 0, -0.2)];
  ud.hitboxMarker = hb;
  ud.bankPivot = pivot;
  let thrust = 0.5, bank = 0;
  // b > 0 rolls RIGHT (right wing down, 35° at b = 1): pass +1 while strafing toward +x.
  ud.setBank = (b) => { bank = Math.max(-1, Math.min(1, b)); pivot.rotation.z = -bank * 35 * DEG; };
  ud.setThrust = (t) => { thrust = Math.max(0, Math.min(1, t)); };
  ud.setFlash = flashFn([mat]);
  ud.update = (dt, t) => {
    const fl = 1 + Math.sin(t * 53) * 0.07 + Math.sin(t * 31.7) * 0.05;
    flame.scale.set(0.9 + thrust * 0.25, 1, (0.35 + thrust * 1.0) * fl);
    flameMat.color.setScalar(0.75 + thrust * 0.35 + Math.sin(t * 41) * 0.06);
    mat.uEmitScale.value = 0.85 + thrust * 0.3 + Math.sin(t * 47) * 0.05;
    hb.material.opacity = 0.85 + Math.sin(t * 9) * 0.15;
  };
  ud.dispose = () => { mat.dispose(); flameMat.dispose(); hb.material.dispose(); };
  ud.setThrust(0.5);
  ud.update(0, 0);
  return g;
}

// =============================================================================
// Shared enemy helpers
// =============================================================================
/** standard enemy wrapper: group → pivot → meshes (pivot is free for idle anim) */
function enemyShell(kind, radius, debris) {
  const g = new THREE.Group(); g.name = kind;
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  g.userData.kind = kind;
  g.userData.radius = radius;
  g.userData.debrisColor = new THREE.Color(debris);
  g.userData.muzzles = [];
  return { g, pivot, ud: g.userData };
}
/** keep group-space muzzles in sync with a y-rotating turret */
function syncMuzzles(out, local, turret) {
  const c = Math.cos(turret.rotation.y), s = Math.sin(turret.rotation.y), p = turret.position;
  for (let i = 0; i < local.length; i++) {
    const v = local[i];
    out[i].set(p.x + v.x * c + v.z * s, p.y + v.y, p.z - v.x * s + v.z * c);
  }
}
function hazardStrip(b, x0, z0, x1, z1, y, width, n, dir = [0, 1, 0], cA = EN.orange, cB = EN.black) {
  // n diagonal stripes along the segment (x0,z0)→(x1,z1), width across
  const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz) || 1;
  const ux = dx / L, uz = dz / L, px = -uz * width / 2, pz = ux * width / 2;
  const step = L / n, sk = width * 0.5;
  for (let k = 0; k < n; k++) {
    const a = k * step, c = (k + 1) * step;
    const p = (s, side) => [x0 + ux * (s + side * sk) + px * side, y, z0 + uz * (s + side * sk) + pz * side];
    b.decal([p(a, -1), p(c, -1), p(c, 1), p(a, 1)], k % 2 ? cB : cA, dir);
  }
}

// =============================================================================
// DART — small fast interceptor
// =============================================================================
function buildDart() {
  const b = new GB();
  const ST = [[-0.72, 0.004, 0.004, 0.004], [-0.54, 0.07, 0.058, 0.04], [-0.24, 0.125, 0.098, 0.06],
    [0.16, 0.15, 0.1, 0.07], [0.5, 0.12, 0.08, 0.06], [0.64, 0.1, 0.066, 0.05]];
  const ring = ([z, w, tp, bt]) => [[0, tp, z], [w * 0.55, tp * 0.72, z], [w, 0, z], [w * 0.45, -bt, z],
    [-w * 0.45, -bt, z], [-w, 0, z], [-w * 0.55, tp * 0.72, z]];
  b.loft(ST.map(ring), (i, j) => {
    if (i === 0) return EN.edgeLt;                      // light nose cone (contrast)
    if (j === 0 || j === 6) return i === 1 ? EN.gunLt : EN.gun;
    if (j === 1 || j === 5) return EN.gunDk;
    return EN.gunXDk;
  }, null, GL(EM.eyeOrange, 0.5));
  // glowing V-visor eye
  const ey = 0.078;
  b.decal([[0, ey + 0.012, -0.47], [0.075, ey, -0.29], [0.04, ey + 0.004, -0.22], [0, ey + 0.012, -0.33]], GL(EM.eyeRed));
  b.decal([[0, ey + 0.012, -0.47], [-0.075, ey, -0.29], [-0.04, ey + 0.004, -0.22], [0, ey + 0.012, -0.33]], GL(EM.eyeRed));
  // exhaust glow cone
  b.lathe([0, 0, 0.64], [0, 0, 1], [[0, 0.065], [0.18, 0.0]], 6, GL(EM.engine, 0.5));
  const f0 = b.n;
  // swept wing
  b.wing([{ x: 0.07, y: -0.01, zl: -0.3, zt: 0.56, t: 0.05 }, { x: 0.44, y: 0.0, zl: 0.26, zt: 0.62, t: 0.028 },
    { x: 0.7, y: 0.01, zl: 0.5, zt: 0.7, t: 0.014 }], (i, j) => {
    if (j >= 4) return EN.gunXDk;
    if (j === 0) return EN.edge;                         // bright leading edge
    if (i === 1) return j === 3 ? EN.orangeDk : EN.orange; // hazard tip
    return j === 3 ? EN.gunDk : EN.gun;
  }, null, EN.orange);
  // hazard black bar across the tip panel
  b.decal([[0.44, 0.03, 0.3], [0.5, 0.028, 0.37], [0.51, 0.03, 0.62], [0.45, 0.03, 0.62]], EN.black);
  // wingtip fin (down-canted)
  const f1 = b.n;
  b.wing([{ x: 0, zl: 0.44, zt: 0.72, t: 0.02 }, { x: 0.14, zl: 0.6, zt: 0.74, t: 0.01 }], (i, j) => (j === 0 ? EN.edge : EN.gunDk), null, EN.edge);
  b.xform(f1, M(0.7, 0.01, 0, 0, 0, -70 * DEG));
  // canted tail fin
  const f2 = b.n;
  b.wing([{ x: 0, zl: 0.2, zt: 0.6, t: 0.03 }, { x: 0.24, zl: 0.46, zt: 0.66, t: 0.014 }], (i, j) => (j === 0 ? EN.edge : j >= 3 ? EN.gunDk : EN.gun), null, EN.orange);
  b.xform(f2, M(0.07, 0.05, 0, 0, 0, 55 * DEG));
  // intake scoops
  b.block({ x: 0.15, y: -0.04, z: -0.02, w: 0.08, d: 0.28, h: 0.08, tw: 0.06, td: 0.22, oz: 0.03, top: EN.gunLt, side: EN.gunDk, front: EN.black });
  b.mirrorX(f0);
  return b.xform(0, M(0, 0, 0, 0, 0, 0, 0.92));
}

// =============================================================================
// HORNET — rotor gunship drone
// =============================================================================
function buildHornet() {
  const b = new GB();
  const ring = ([z, w, h, yc]) => {
    const r = [];
    for (let k = 0; k < 8; k++) { const th = Math.PI / 8 + (k * TAU) / 8; r.push([Math.cos(th) * w, yc + Math.sin(th) * h, z]); }
    return r;
  };
  const ST = [[-0.62, 0.05, 0.04, 0.03], [-0.5, 0.22, 0.17, 0.03], [-0.3, 0.33, 0.25, 0.05], [0.04, 0.35, 0.26, 0.06],
    [0.32, 0.27, 0.2, 0.05], [0.52, 0.12, 0.1, 0.05]];
  // edges: 0 right-upper(22.5→67.5) 1 top-right 2 top-left 3 left-upper ... (θ from π/8)
  b.loft(ST.map(ring), (i, j) => {
    const top = j === 1 || j === 2, upper = j === 0 || j === 3, lower = j === 4 || j === 7;
    if (top) return i === 2 ? EN.sandLt : EN.sand;
    if (upper) return i === 3 ? EN.orange : EN.olive;
    if (lower) return EN.oliveDk;
    return EN.gunXDk;
  }, null, EN.oliveDk);
  // compound eye (big, red, faceted)
  b.lathe([0, 0.07, -0.42], [0, 0.18, -1], [[0, 0.17], [0.1, 0.15], [0.18, 0.09], [0.22, 0.0]], 8,
    (i, j) => GL(((i + j) & 1) ? EM.eyeRed : scl(EM.eyeRed, 0.65), 0.45), null, null, { phase: Math.PI / 8 });
  // tail boom + tail
  b.lathe([0, 0.06, 0.48], [0, 0, 1], [[0, 0.075], [0.44, 0.045]], 6, (i, j) => (j === 1 ? EN.sand : EN.olive), null, EN.oliveDk, { phase: Math.PI / 6 });
  b.plate([[-0.3, 0.8], [0.3, 0.8], [0.26, 0.95], [-0.26, 0.95]], 0.05, 0.08, EN.sand, EN.oliveDk);
  b.decal([[0.2, 0.082, 0.8], [0.3, 0.082, 0.8], [0.26, 0.082, 0.95], [0.18, 0.082, 0.95]], EN.orange);
  b.decal([[-0.2, 0.082, 0.8], [-0.3, 0.082, 0.8], [-0.26, 0.082, 0.95], [-0.18, 0.082, 0.95]], EN.orange);
  b.block({ x: 0, y: 0.08, z: 0.86, w: 0.03, d: 0.18, h: 0.2, td: 0.1, oz: 0.04, top: EN.orange, side: EN.olive });
  // rotor mast
  b.lathe([0, 0.28, -0.02], [0, 1, 0], [[0, 0.09], [0.1, 0.07], [0.16, 0.05]], 6, EN.gunDk, null, EN.gun);
  // exhaust vents
  for (const sg of [-1, 1]) for (const z of [0.2, 0.3]) {
    b.decal([[0.1 * sg, 0.302, z], [0.2 * sg, 0.272, z], [0.19 * sg, 0.265, z + 0.045], [0.095 * sg, 0.295, z + 0.045]], GL(scl(EM.engine, 0.55), 0.3), [0.2 * sg, 1, 0]);
  }
  const f0 = b.n;
  // stub wing
  b.wing([{ x: 0.26, y: 0.02, zl: -0.14, zt: 0.2, t: 0.06 }, { x: 0.68, y: 0.06, zl: -0.1, zt: 0.16, t: 0.04 }],
    (i, j) => (j >= 4 ? EN.oliveDk : j === 0 ? EN.sandLt : EN.olive), null, EN.oliveDk);
  // gun pod
  b.lathe([0.76, 0.04, 0.34], [0, 0, -1], [[0, 0.05], [0.08, 0.105], [0.36, 0.105], [0.46, 0.105], [0.62, 0.085],
    [0.62, 0.04], [0.86, 0.036], [0.92, 0.05]], 6, (i, j) => {
    if (i === 2) return (j === 1 || j === 2) ? EN.orange : EN.orangeDk;           // hazard band
    if (i >= 5) return i === 6 ? EN.gunLt : EN.gunXDk;
    return (j === 1 || j === 2) ? EN.gunLt : EN.gun;
  }, EN.gunDk, GL(EM.eyeOrange, 0.4), { phase: Math.PI / 6 });
  b.mirrorX(f0);
  return b;
}
function buildRotorBlades() {
  const b = new GB();
  for (let k = 0; k < 3; k++) {
    const f = b.n;
    b.block({ x: 0.46, y: -0.012, z: 0, w: 0.72, d: 0.085, h: 0.024, tw: 0.72, td: 0.06, top: EN.gunDk, side: EN.gunXDk });
    b.block({ x: 0.8, y: -0.011, z: 0, w: 0.12, d: 0.087, h: 0.026, top: EN.orange, side: EN.orangeDk });
    b.xform(f, M(0, 0, 0, 0, (k * TAU) / 3, 0));
  }
  b.lathe([0, -0.03, 0], [0, 1, 0], [[0, 0.1], [0.05, 0.1], [0.08, 0.05]], 6, EN.gun, null, EN.gunLt);
  return b;
}
/** Motion-blur disc: smoky and almost clear over the hub (the drone body must stay
 *  readable through it), with three trailing blade-sweep lobes that turn with the
 *  rotor, and a thin hazard-orange tip ring. Vertex RGBA, 160 triangles. */
function buildRotorDisc() {
  const N = 20, R = [0.14, 0.52, 0.78, 0.82, 0.87];
  const A = [0.0, 0.05, 0.1, 0.3, 0.3];                  // radial alpha
  const C = [[0.5, 0.55, 0.58], [0.55, 0.6, 0.63], [0.62, 0.66, 0.68], [1.0, 0.5, 0.14], [1.0, 0.5, 0.14]];
  // blade sweep: 3 lobes. update() spins the rotor toward +angle (rotation.y decreases), so each
  // lobe has its sharp leading edge at the high-angle end and a soft tail trailing behind it.
  const sweep = (a) => {
    const f = ((a * 3) / TAU) % 1;                        // 0..1 within one lobe
    return 0.35 + 0.65 * Math.pow(f, 2.2);
  };
  const pos = [], col = [];
  for (let r = 0; r < R.length - 1; r++) {
    for (let k = 0; k < N; k++) {
      const a0 = (TAU * k) / N, a1 = (TAU * (k + 1)) / N;
      const P = (ri, a) => [Math.cos(a) * R[ri], 0, Math.sin(a) * R[ri]];
      const Cc = (ri, a) => [...C[ri], A[ri] * (ri >= 3 ? 1 : sweep(a))];
      pos.push(...P(r, a0), ...P(r + 1, a1), ...P(r + 1, a0), ...P(r, a0), ...P(r, a1), ...P(r + 1, a1));
      col.push(...Cc(r, a0), ...Cc(r + 1, a1), ...Cc(r + 1, a0), ...Cc(r, a0), ...Cc(r, a1), ...Cc(r + 1, a1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}

// =============================================================================
// TANK
// =============================================================================
function trackLoft(b, xc, width, height, z0, z1, nSeg, colors) {
  // hex cross-section; sloped ends; tread bands on the top face
  const xi = xc - width / 2, xo = xc + width / 2;
  const sec = (z, k) => {
    const lo = 0.02 + (1 - k) * height * 0.28, hi = height - (1 - k) * height * 0.22;
    const mdl = (lo + hi) / 2;
    return [[xi, lo, z], [xo, lo, z], [xo + 0.02, mdl, z], [xo, hi, z], [xi, hi, z], [xi - 0.02, mdl, z]];
  };
  const len = z1 - z0, endL = Math.min(0.12, len * 0.08);
  const rings = [sec(z0, 0)];
  for (let s = 0; s <= nSeg; s++) rings.push(sec(z0 + endL + ((len - 2 * endL) * s) / nSeg, 1));
  rings.push(sec(z1, 0));
  b.loft(rings, (i, j) => {
    if (j === 3) return (i === 0 || i === nSeg + 1) ? colors.end : (i & 1 ? colors.treadA : colors.treadB);   // top treads
    if (j === 2 || j === 5) return (i & 1) ? colors.side : colors.sideB;
    if (j === 0) return colors.bottom;
    return colors.side;
  }, colors.end, colors.end);
}
const TRACK_COL = { treadA: lit('#44474b'), treadB: lit('#26282b'), side: lit('#2c2e31'), sideB: lit('#3a3c3f'), bottom: lit('#1a1b1d'), end: lit('#34363a') };
function buildTankHull() {
  const b = new GB();
  trackLoft(b, 0.5, 0.28, 0.3, -0.85, 0.85, 9, TRACK_COL);
  trackLoft(b, -0.5, 0.28, 0.3, -0.85, 0.85, 9, TRACK_COL);
  // hull
  const ring = (z, w, lo, hi) => [[-w, lo, z], [w, lo, z], [w + 0.02, hi - 0.06, z], [w - 0.06, hi, z], [-w + 0.06, hi, z], [-w - 0.02, hi - 0.06, z]];
  b.loft([ring(-0.8, 0.28, 0.12, 0.2), ring(-0.52, 0.36, 0.08, 0.39), ring(0.7, 0.36, 0.08, 0.39), ring(0.8, 0.32, 0.1, 0.32)], (i, j) => {
    if (j === 3) return i === 0 ? EN.oliveLt : EN.olive;         // top
    if (j === 2 || j === 4) return EN.sandLt;                    // bright edge bevels
    if (j === 0) return null;
    return EN.oliveDk;
  }, EN.oliveDk, EN.oliveDk);
  // fenders over tracks (front/back mud guards)
  for (const s of [-1, 1]) {
    b.block({ x: 0.5 * s, y: 0.3, z: -0.72, w: 0.32, d: 0.2, h: 0.03, top: EN.oliveDk, side: EN.sandDk });
    b.block({ x: 0.5 * s, y: 0.3, z: 0.74, w: 0.32, d: 0.16, h: 0.03, top: EN.oliveDk, side: EN.sandDk });
  }
  // engine deck grille + hazard stripes
  for (let k = 0; k < 4; k++) b.decal([[-0.22, 0.392, 0.42 + k * 0.07], [0.22, 0.392, 0.42 + k * 0.07], [0.22, 0.392, 0.45 + k * 0.07], [-0.22, 0.392, 0.45 + k * 0.07]], EN.gunXDk);
  hazardStrip(b, -0.3, 0.72, 0.3, 0.72, 0.393, 0.08, 6);
  // headlights
  b.decal([[0.18, 0.3, -0.66], [0.26, 0.3, -0.66], [0.26, 0.27, -0.7], [0.18, 0.27, -0.7]], GL(EM.eyeOrange), [0, 0.6, -1]);
  b.decal([[-0.18, 0.3, -0.66], [-0.26, 0.3, -0.66], [-0.26, 0.27, -0.7], [-0.18, 0.27, -0.7]], GL(EM.eyeOrange), [0, 0.6, -1]);
  return b;
}
function buildTankTurret() {
  const b = new GB();
  const ring = (z, w, h) => [[-w, 0, z], [w, 0, z], [w * 1.04, h * 0.5, z], [w * 0.72, h, z], [-w * 0.72, h, z], [-w * 1.04, h * 0.5, z]];
  const t0 = b.n;
  b.loft([ring(-0.36, 0.2, 0.12), ring(-0.26, 0.3, 0.2), ring(0.22, 0.32, 0.21), ring(0.36, 0.26, 0.16)], (i, j) => {
    if (j === 0) return null;
    if (j === 3) return EN.olive;                                // dark olive top reads on tan dirt lanes
    if (j === 2 || j === 4) return i === 1 ? EN.sandLt : EN.oliveDk; // thin light rim
    return EN.oliveDk;
  }, EN.oliveDk, EN.oliveDk);
  const t1 = b.n;
  // barrel with muzzle brake
  b.lathe([0, 0.1, -0.3], [0, 0, -1], [[0, 0.062], [0.06, 0.05], [0.62, 0.042], [0.62, 0.058], [0.74, 0.058], [0.74, 0.03]], 6,
    (i) => (i === 3 ? EN.gunLt : i >= 2 ? EN.gunDk : EN.gun), null, EN.black, { phase: Math.PI / 6 });
  // commander hatch
  b.lathe([0.1, 0.2, 0.08], [0, 1, 0], [[0, 0.085], [0.04, 0.075], [0.055, 0.0]], 6, EN.oliveDk, null, null);
  // sensor eye (draped onto the roof: a flat decal at the roof height was buried and never showed)
  b.drape([[[-0.14, -0.25], [0.14, -0.25], [0.11, -0.18], [-0.11, -0.18]]], GL(EM.eyeRed), t0, t1, 0.005, 1);
  // hazard on the rear
  hazardStrip(b, -0.16, 0.3, 0.16, 0.3, 0.214, 0.06, 4);
  return b;
}

// =============================================================================
// TURRET — AA bunker on a concrete pad
// =============================================================================
function buildTurretBase() {
  const b = new GB();
  const oct = (r, ph = Math.PI / 8) => Array.from({ length: 8 }, (_, k) => [Math.cos(ph + (k * TAU) / 8) * r, Math.sin(ph + (k * TAU) / 8) * r]);
  b.plate(oct(0.94), 0, 0.14, EN.concrete, EN.concreteDk);
  // hazard ring (16 alternating segments)
  for (let k = 0; k < 16; k++) {
    const a0 = Math.PI / 8 + (k * TAU) / 16, a1 = Math.PI / 8 + ((k + 1) * TAU) / 16;
    const r0 = 0.74, r1 = 0.88, y = 0.141;
    const q = (r, a) => [Math.cos(a) * r, y, Math.sin(a) * r];
    b.decal([q(r0, a0), q(r1, a0), q(r1, a1), q(r0, a1)], k & 1 ? EN.black : EN.orange);
  }
  // corner bolts / light rim
  b.decal(oct(0.66).map(([x, z]) => [x, 0.142, z]), EN.pit);
  // armoured drum
  b.lathe([0, 0.14, 0], [0, 1, 0], [[0, 0.58], [0.16, 0.56], [0.2, 0.5], [0.27, 0.46]], 8,
    (i) => (i === 1 ? EN.edge : i === 0 ? EN.gunDk : EN.gun), null, EN.gunDk, { phase: Math.PI / 8 });
  return b;
}
function buildTurretHead() {
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.44], [0.12, 0.43], [0.22, 0.33], [0.28, 0.16], [0.29, 0.0]], 8,
    (i, j) => (i === 1 ? ((j === 1 || j === 2) ? EN.sandLt : EN.sand) : i === 0 ? EN.oliveDk : i === 2 ? EN.olive : EN.oliveLt),
    null, null, { phase: Math.PI / 8 });
  // barrel housing
  b.block({ x: 0, y: 0.06, z: -0.32, w: 0.42, d: 0.3, h: 0.17, tw: 0.36, td: 0.26, oz: 0.02, bev: 0.03, top: EN.gun, bevS: EN.edge, side: EN.gunDk, front: EN.gunXDk });
  for (const x of [-0.11, 0.11]) {
    b.lathe([x, 0.15, -0.44], [0, 0, -1], [[0, 0.05], [0.56, 0.04], [0.56, 0.052], [0.66, 0.052], [0.66, 0.02]], 6,
      (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black, { phase: Math.PI / 6 });
  }
  // sensor eye
  b.decal([[-0.07, 0.3, -0.25], [0.07, 0.3, -0.25], [0.05, 0.31, -0.16], [-0.05, 0.31, -0.16]], GL(EM.eyeRed), [0, 1, -0.4]);
  hazardStrip(b, -0.14, 0.22, 0.14, 0.22, 0.335, 0.08, 4);
  return b;
}

// =============================================================================
// GUNBOAT
// =============================================================================
function buildGunboatHull() {
  const b = new GB();
  const ring = ([z, w, dk, kl]) => [[0, dk + 0.02, z], [w, dk, z], [w * 0.97, 0.1, z], [w * 0.78, -0.08, z], [0, kl, z],
    [-w * 0.78, -0.08, z], [-w * 0.97, 0.1, z], [-w, dk, z]];
  const ST = [[-2.0, 0.02, 0.46, -0.02], [-1.62, 0.42, 0.4, -0.18], [-1.0, 0.7, 0.36, -0.22], [-0.2, 0.8, 0.34, -0.22],
    [1.0, 0.78, 0.34, -0.22], [1.7, 0.7, 0.34, -0.2], [2.0, 0.64, 0.34, -0.16]];
  const d0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    if (j === 0 || j === 7) return i === 0 ? EN.orange : EN.deckDk;   // deck plating (bow hazard)
    if (j === 1 || j === 6) return i === 0 ? EN.white : EN.navy;                          // topsides
    if (j === 2 || j === 5) return EN.hullRed;                                            // boot stripe
    return EN.navyDk;
  }, null, EN.navyDk);
  const d1 = b.n;
  // deck markings are draped onto the crowned deck (flat decals sank under its centre ridge)
  // bow hazard chevrons
  hazardDrape(b, -0.3, -1.45, 0.3, -1.45, 0.12, 5, EN.orange, EN.black, d0, d1, 0.009, 1);
  // walkway lines + bow marker
  b.drape([[[-0.68, -0.9], [-0.56, -0.9], [-0.56, 1.75], [-0.68, 1.75]], [[0.56, -0.9], [0.68, -0.9], [0.68, 1.75], [0.56, 1.75]]], EN.deck, d0, d1, 0.005, 1);
  b.drape([[[-0.22, -1.61], [0, -1.61], [0, -1.565], [-0.22, -1.565]], [[0, -1.61], [0.22, -1.61], [0.22, -1.565], [0, -1.565]]], EN.white, d0, d1, 0.005, 1);
  // bridge
  b.block({ x: 0, y: 0.34, z: 0.35, w: 0.9, d: 1.1, h: 0.34, tw: 0.8, td: 0.94, oz: 0.05, bev: 0.05, top: EN.white, bevS: EN.edgeLt, side: EN.deckDk, front: EN.deck });
  b.block({ x: 0, y: 0.68, z: 0.22, w: 0.62, d: 0.5, h: 0.16, tw: 0.5, td: 0.4, oz: 0.04, bev: 0.03, top: EN.edgeLt, bevS: EN.white, side: EN.deck });
  // glowing bridge windows
  b.decal([[-0.28, 0.8, -0.03], [0.28, 0.8, -0.03], [0.26, 0.74, -0.05], [-0.26, 0.74, -0.05]], GL(EM.eyeOrange), [0, 0.3, -1]);
  // mast + radar
  b.lathe([0, 0.84, 0.32], [0, 1, 0], [[0, 0.04], [0.4, 0.025]], 5, EN.gunDk, null, EN.gun);
  b.block({ x: 0, y: 1.14, z: 0.32, w: 0.46, d: 0.07, h: 0.05, top: EN.edgeLt, side: EN.gun });
  // funnel with warning band
  b.lathe([0, 0.34, 1.12], [0, 1, 0], [[0, 0.17], [0.22, 0.15], [0.28, 0.15], [0.34, 0.14]], 6,
    (i) => (i === 1 ? EN.orange : EN.gunDk), null, S(lin('#141414'), EM.emberDim.map((v) => v * 0.4)), { sx: 1, sy: 1.4 });
  // aft AA mount (static, facing aft)
  b.lathe([0, 0.34, 1.6], [0, 1, 0], [[0, 0.2], [0.1, 0.18], [0.14, 0.12]], 6, EN.gun, null, EN.gunLt);
  for (const x of [-0.06, 0.06]) b.lathe([x, 0.44, 1.64], [0, 0, 1], [[0, 0.03], [0.4, 0.025]], 5, EN.gunDk, null, EN.black);
  // life rafts (orange canisters) + ammo lockers either side of the bridge
  for (const sg of [-1, 1]) {
    for (const z of [-0.05, 0.28, 0.61]) b.lathe([0.58 * sg, 0.4, z - 0.12], [0, 0, 1], [[0, 0.055], [0.24, 0.055]], 5, (i, j) => (j <= 1 ? EN.orange : EN.orangeDk), EN.white, null, { phase: Math.PI / 2 });
    b.block({ x: 0.5 * sg, y: 0.34, z: -0.62, w: 0.22, d: 0.3, h: 0.14, bev: 0.02, top: EN.navy, bevS: EN.edge, side: EN.navyDk });
    b.block({ x: 0.5 * sg, y: 0.34, z: 1.35, w: 0.2, d: 0.34, h: 0.12, bev: 0.02, top: EN.gunLt, bevS: EN.edge, side: EN.gunDk });
  }
  // stern: depth-charge racks, hazard band, light
  for (const sg of [-1, 1]) {
    b.block({ x: 0.32 * sg, y: 0.34, z: 1.78, w: 0.3, d: 0.16, h: 0.1, top: EN.gunLt, side: EN.gunDk });
    b.decal([[0.24 * sg, 0.442, 1.72], [0.28 * sg, 0.442, 1.72], [0.28 * sg, 0.442, 1.84], [0.24 * sg, 0.442, 1.84]], EN.gunXDk);
    b.decal([[0.36 * sg, 0.442, 1.72], [0.4 * sg, 0.442, 1.72], [0.4 * sg, 0.442, 1.84], [0.36 * sg, 0.442, 1.84]], EN.gunXDk);
  }
  hazardDrape(b, -0.55, 1.93, 0.55, 1.93, 0.07, 7, EN.orange, EN.black, d0, d1, 0.005, 1);
  b.drape([[[-0.09, 1.815], [0.09, 1.815], [0.09, 1.855], [-0.09, 1.855]]], GL(EM.eyeRed), d0, d1, 0.006, 1);
  return b;
}
function buildGunboatTurret() {
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.34], [0.08, 0.33], [0.12, 0.26]], 8, (i) => (i === 0 ? EN.gun : EN.edge), null, EN.gun, { phase: Math.PI / 8 });
  b.block({ x: 0, y: 0.1, z: 0.02, w: 0.44, d: 0.5, h: 0.2, tw: 0.36, td: 0.4, oz: 0.03, bev: 0.03, top: EN.deck, bevS: EN.edgeLt, side: EN.deckDk, front: EN.gunDk });
  for (const x of [-0.08, 0.08]) {
    b.lathe([x, 0.2, -0.2], [0, 0, -1], [[0, 0.045], [0.52, 0.036], [0.52, 0.046], [0.6, 0.046], [0.6, 0.02]], 6,
      (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black, { phase: Math.PI / 6 });
  }
  b.decal([[-0.12, 0.305, -0.16], [0.12, 0.305, -0.16], [0.1, 0.305, -0.1], [-0.1, 0.305, -0.1]], GL(EM.eyeRed));
  return b;
}

// =============================================================================
// CARRIER — friendly-looking item transport
// =============================================================================
function buildCarrier() {
  const b = new GB();
  const ring = ([z, w, h, yc]) => {
    const r = [];
    for (let k = 0; k < 8; k++) { const th = Math.PI / 8 + (k * TAU) / 8; r.push([Math.cos(th) * w, yc + Math.sin(th) * h, z]); }
    return r;
  };
  const ST = [[-1.0, 0.1, 0.08, 0.02], [-0.9, 0.3, 0.24, 0.03], [-0.62, 0.42, 0.32, 0.04], [0.5, 0.42, 0.32, 0.04],
    [0.8, 0.3, 0.24, 0.06], [1.0, 0.16, 0.12, 0.08]];
  const c0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    const top = j === 1 || j === 2, upper = j === 0 || j === 3;
    if (top) return EN.yellow;
    if (upper) return i === 0 ? EN.yellow : EN.yellowDk;
    return EN.khaki;
  }, EN.khaki, EN.khaki);
  const c1 = b.n;
  // olive chevrons across the back (friendly "cargo" livery)
  for (let k = 0; k < 3; k++) {
    const z = -0.3 + k * 0.28, y = 0.362;
    b.decal([[-0.16, y, z + 0.12], [0, y, z], [0, y, z + 0.1], [-0.16, y, z + 0.22]], EN.khaki);
    b.decal([[0.16, y, z + 0.12], [0, y, z], [0, y, z + 0.1], [0.16, y, z + 0.22]], EN.khaki);
  }
  // big friendly cockpit
  b.lathe([0, 0.14, -0.66], [0, 0.35, -1], [[0, 0.22], [0.1, 0.19], [0.2, 0.11], [0.25, 0.0]], 8,
    (i, j) => (j === 1 || j === 2 ? S(lin('#7fe7ff'), rgb(0.05, 0.3, 0.4)) : S(lin('#2aa9d6'), rgb(0.01, 0.1, 0.16))), null, null, { phase: Math.PI / 8, sy: 0.8 });
  // cabin windows along the shoulders (draped onto the sloped shoulder facet; flat quads floated ~7 cm off it)
  const WIN = S(lin('#2aa9d6'), rgb(0.02, 0.12, 0.2)), winQ = [];
  for (const sg of [-1, 1]) for (let k = 0; k < 3; k++) {
    const z = -0.5 + k * 0.14;
    winQ.push([[0.21 * sg, z], [0.35 * sg, z], [0.35 * sg, z + 0.08], [0.21 * sg, z + 0.08]]);
  }
  b.drape(winQ, WIN, c0, c1, 0.004, 1);
  // cargo hatch outline
  b.decal([[-0.2, 0.362, 0.55], [0.2, 0.362, 0.55], [0.2, 0.362, 0.62], [-0.2, 0.362, 0.62]], EN.yellowDk);
  // tail
  b.block({ x: 0, y: 0.18, z: 0.92, w: 0.05, d: 0.26, h: 0.26, td: 0.14, oz: 0.06, top: EN.yellow, side: EN.khaki });
  const f0 = b.n;
  // stub wing
  b.wing([{ x: 0.36, y: 0.06, zl: -0.14, zt: 0.26, t: 0.08 }, { x: 0.56, y: 0.08, zl: -0.12, zt: 0.24, t: 0.06 }],
    (i, j) => (j >= 4 ? EN.khaki : j === 0 ? EN.white : EN.yellow), null, EN.khaki);
  // ducted lift fan ring
  b.lathe([0.8, -0.06, 0.06], [0, 1, 0], [[0, 0.32], [0.06, 0.34], [0.18, 0.32], [0.2, 0.27], [0.02, 0.26]], 12,
    (i, j) => (i === 1 ? (j % 3 === 0 ? EN.khaki : EN.yellow) : i === 2 ? EN.edge : i === 3 ? EN.khaki : EN.yellowDk), null, null);
  // beacon on duct
  b.block({ x: 1.13, y: 0.1, z: 0.06, w: 0.06, d: 0.1, h: 0.05, top: GL(EM.green), side: GL(EM.green, 0.5) });
  // tailplane
  b.wing([{ x: 0.05, y: 0.12, zl: 0.78, zt: 1.0, t: 0.03 }, { x: 0.36, y: 0.14, zl: 0.86, zt: 1.02, t: 0.02 }],
    (i, j) => (j === 0 ? EN.white : EN.yellow), null, EN.khaki);
  // engine glows on the rear of the body
  b.decal([[0.12, 0.24, 0.98], [0.2, 0.22, 0.97], [0.2, 0.18, 0.99], [0.12, 0.2, 1.0]], GL(scl(EM.amber, 0.6)), [0, 0, 1]);
  b.mirrorX(f0);
  return b;
}
function buildCarrierFan() {
  const b = new GB();
  for (let k = 0; k < 5; k++) {
    const f = b.n;
    b.block({ x: 0.14, y: 0, z: 0, w: 0.24, d: 0.07, h: 0.018, top: EN.gunDk, side: EN.gunXDk });
    b.xform(f, M(0, 0, 0, 0.35, (k * TAU) / 5, 0));
  }
  b.lathe([0, -0.02, 0], [0, 1, 0], [[0, 0.07], [0.05, 0.06], [0.07, 0.0]], 6, (i, j) => (j & 1 ? EN.gunLt : GL(scl(EM.amber, 0.4), 0.4)));
  return b;
}

// =============================================================================
// BOMBER — heavy wide-wing bomber, 4 glowing engines
// =============================================================================
function buildBomber() {
  const b = new GB();
  const ring = ([z, w, tp, bt]) => [[0, tp, z], [w * 0.5, tp * 0.9, z], [w, tp * 0.35, z], [w, -bt * 0.3, z], [w * 0.55, -bt, z],
    [-w * 0.55, -bt, z], [-w, -bt * 0.3, z], [-w, tp * 0.35, z], [-w * 0.5, tp * 0.9, z]];
  const ST = [[-1.78, 0.02, 0.02, 0.02], [-1.6, 0.16, 0.14, 0.1], [-1.3, 0.3, 0.26, 0.2], [-0.8, 0.38, 0.32, 0.26],
    [-0.76, 0.38, 0.32, 0.26], [0.4, 0.38, 0.3, 0.26], [0.44, 0.38, 0.3, 0.26], [1.2, 0.3, 0.24, 0.22], [1.72, 0.16, 0.16, 0.14]];
  const s0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    const line = i === 3 || i === 5;
    if (i === 0) return EN.gunDk;
    if (j === 0 || j === 8) return line ? EN.gunXDk : EN.gunLt;
    if (j === 1 || j === 7) return line ? EN.gunXDk : EN.edge;
    if (j === 2 || j === 6) return EN.gun;
    return EN.gunXDk;
  }, null, EN.gunDk);
  const s1 = b.n;
  // menacing eye slits on the nose (draped: flat quads half-sank into the curved nose)
  //  kept inside the top facet (|x| < ½·halfwidth) so the quad never spans the shoulder crease
  b.drape([[[0.03, -1.41], [0.135, -1.35], [0.14, -1.27], [0.03, -1.32]], [[-0.03, -1.32], [-0.14, -1.27], [-0.135, -1.35], [-0.03, -1.41]]],
    GL(EM.eyeRed), s0, s1, 0.008, 1);
  // dorsal turret
  b.lathe([0, 0.3, -0.4], [0, 1, 0], [[0, 0.2], [0.07, 0.18], [0.12, 0.1]], 8, EN.gunDk, null, EN.gun, { phase: Math.PI / 8 });
  b.decal([[-0.05, 0.43, -0.52], [0.05, 0.43, -0.52], [0.05, 0.43, -0.44], [-0.05, 0.43, -0.44]], GL(EM.eyeOrange));
  for (const x of [-0.05, 0.05]) b.lathe([x, 0.38, -0.5], [0, 0, -1], [[0, 0.025], [0.3, 0.02]], 5, EN.gunXDk, null, EN.black);
  // spine hazard (draped onto the tapering spine)
  hazardDrape(b, 0, 0.55, 0, 1.05, 0.16, 5, EN.orange, EN.black, s0, s1, 0.017, 1);   // lift covers the ridge sag of 1-cell quads
  const f0 = b.n;
  // big swept wing
  b.wing([{ x: 0.3, y: -0.02, zl: -0.62, zt: 0.72, t: 0.13 }, { x: 1.35, y: 0.02, zl: -0.07, zt: 0.82, t: 0.1 },
    { x: 1.4, y: 0.02, zl: -0.04, zt: 0.82, t: 0.1 }, { x: 2.2, y: 0.07, zl: 0.38, zt: 0.94, t: 0.06 }, { x: 2.52, y: 0.09, zl: 0.62, zt: 0.98, t: 0.04 }],
  (i, j) => {
    if (j >= 4) return EN.gunXDk;
    if (i === 1) return j === 0 ? EN.edge : EN.gunXDk;                            // panel line
    if (i === 3) return j === 3 ? EN.black : ((j & 1) ? EN.black : EN.orange);   // hazard tip
    if (j === 0) return EN.edgeLt;
    if (j === 3) return EN.gunDk;
    return i === 2 ? EN.gunLt : EN.gun;
  }, null, EN.orange);
  // engine nacelles
  for (const x of [0.95, 1.75]) {
    b.lathe([x, -0.06, -0.7], [0, 0, 1], [[0, 0.1], [0.08, 0.165], [1.3, 0.16], [1.55, 0.12], [1.62, 0.12]], 6, (i, j) => {
      if (i === 0) return EN.edgeLt;
      if (i === 2) return EN.gunDk;
      return (j === 1) ? EN.gunLt : EN.gun;
    }, EN.gunXDk, GL(EM.engineHot, 0.6), { phase: Math.PI / 6 });
    b.lathe([x, -0.06, 0.92], [0, 0, 1], [[0, 0.1], [0.34, 0.0]], 6, GL(EM.engine, 0.5));
  }
  // tail fins + tailplane
  const f1 = b.n;
  b.wing([{ x: 0, zl: 1.1, zt: 1.72, t: 0.06 }, { x: 0.46, zl: 1.4, zt: 1.78, t: 0.03 }], (i, j) => (j === 0 ? EN.edge : EN.gunDk), null, EN.orange);
  b.xform(f1, M(0.22, 0.18, 0, 0, 0, 58 * DEG));
  b.wing([{ x: 0.15, y: 0.02, zl: 1.2, zt: 1.72, t: 0.05 }, { x: 0.95, y: 0.06, zl: 1.5, zt: 1.8, t: 0.03 }],
    (i, j) => (j >= 4 ? EN.gunXDk : j === 0 ? EN.edge : EN.gun), null, EN.gunDk);
  b.mirrorX(f0);
  return b;
}

// =============================================================================
// CRAWLER — mid-boss siege tank (6 × 5)
// =============================================================================
const CR_TRACK = { treadA: lit('#4a4c4f'), treadB: lit('#2a2b2e'), side: lit('#303236'), sideB: lit('#3f4145'), bottom: lit('#1a1b1d'), end: lit('#393b3f') };
function buildCrawlerHull() {
  const b = new GB();
  trackLoft(b, 2.35, 1.15, 1.0, -2.5, 2.5, 13, CR_TRACK);
  trackLoft(b, -2.35, 1.15, 1.0, -2.5, 2.5, 13, CR_TRACK);
  // armoured skirts over the outer track edge
  for (const s of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z = -1.8 + k * 1.2;
      b.block({ x: 2.98 * s, y: 0.35, z, w: 0.12, d: 1.1, h: 0.62, tw: 0.08, td: 1.04, top: EN.sandLt, side: k & 1 ? EN.sandDk : EN.sand });
    }
    hazardStrip(b, 2.35 * s - 0.5, -2.28, 2.35 * s + 0.5, -2.28, 1.005, 0.2, 6);
  }
  // lower hull
  const ring = (z, w, lo, hi) => [[-w, lo, z], [w, lo, z], [w + 0.05, hi - 0.18, z], [w - 0.18, hi, z], [-w + 0.18, hi, z], [-w - 0.05, hi - 0.18, z]];
  b.loft([ring(-2.45, 1.3, 0.3, 0.7), ring(-1.9, 1.72, 0.22, 1.18), ring(2.1, 1.72, 0.22, 1.18), ring(2.4, 1.55, 0.3, 0.95)], (i, j) => {
    if (j === 0) return null;
    if (j === 3) return i === 0 ? EN.sandLt : EN.sand;
    if (j === 2 || j === 4) return EN.edgeLt;
    return EN.sandDk;
  }, EN.sandDk, EN.sandDk);
  // front hazard + glowing sensor slits (eyes)
  hazardStrip(b, -1.25, -2.2, 1.25, -2.2, 0.72, 0.22, 10, [0, 1, -0.9]);
  for (const s of [-1, 1]) {
    b.decal([[0.55 * s, 1.0, -1.98], [1.15 * s, 1.0, -1.98], [1.1 * s, 0.94, -2.06], [0.6 * s, 0.94, -2.06]], GL(EM.eyeRed), [0, 0.5, -1]);
  }
  // raised armour plates on deck + camo + plate seams
  b.block({ x: 0, y: 1.18, z: -1.4, w: 2.4, d: 0.9, h: 0.1, tw: 2.2, td: 0.78, top: EN.sand, side: EN.edge });
  const CAMO = [lit('#8a7a4e'), lit('#6f7a45')];
  const camo = [[[-1.5, -0.6], [-0.7, -0.9], [-0.5, -0.2], [-1.3, 0.1]], [[0.8, 0.3], [1.55, 0.1], [1.5, 0.9], [0.9, 1.1]],
    [[-1.4, 0.9], [-0.9, 0.7], [-0.8, 1.2], [-1.5, 1.3]], [[1.0, -1.0], [1.5, -1.1], [1.55, -0.5], [1.1, -0.45]]];
  camo.forEach((q, k) => b.decal(q.map(([x, z]) => [x, 1.183, z]), CAMO[k & 1]));
  for (const z of [-0.85, 1.3]) b.decal([[-1.52, 1.184, z], [1.52, 1.184, z], [1.52, 1.184, z + 0.04], [-1.52, 1.184, z + 0.04]], EN.sandDk);
  for (const sg of [-1, 1]) b.decal([[1.52 * sg, 1.184, -1.85], [1.56 * sg, 1.184, -1.85], [1.56 * sg, 1.184, 2.0], [1.52 * sg, 1.184, 2.0]], EN.edgeLt);
  // rear engine deck: vents with glow
  for (let k = 0; k < 5; k++) {
    const z = 1.45 + k * 0.16;
    const vs = k === 2 ? GL(scl(EM.engine, 0.5), 0.3) : EN.gunXDk;
    b.decal([[-1.2, 1.185, z], [-0.2, 1.185, z], [-0.2, 1.185, z + 0.08], [-1.2, 1.185, z + 0.08]], vs);
    b.decal([[0.2, 1.185, z], [1.2, 1.185, z], [1.2, 1.185, z + 0.08], [0.2, 1.185, z + 0.08]], vs);
  }
  // exhaust stacks
  for (const s of [-1, 1]) {
    b.lathe([1.45 * s, 1.1, 2.0], [0, 1, 0], [[0, 0.2], [0.5, 0.18], [0.55, 0.2], [0.62, 0.2]], 6, (i) => (i === 1 ? EN.gunLt : EN.gunDk), null, S(lin('#161412'), EM.emberDim.map((v) => v * 0.66)));
  }
  // sponson mounts for the side guns
  for (const s of [-1, 1]) b.lathe([1.45 * s, 1.1, -1.55], [0, 1, 0], [[0, 0.52], [0.1, 0.5]], 8, EN.gunDk, null, EN.gun, { phase: Math.PI / 8 });
  return b;
}
function buildCrawlerTurret() {
  const b = new GB();
  const oct = (r, y, sc = 1) => Array.from({ length: 8 }, (_, k) => {
    const a = Math.PI / 8 + (k * TAU) / 8; return [Math.cos(a) * r, y, Math.sin(a) * r * sc];
  });
  b.loft([oct(1.3, 0, 1.0), oct(1.28, 0.3, 1.0), oct(1.08, 0.55, 0.95), oct(0.7, 0.62, 0.9)], (i, j) => {
    if (i === 0) return (j & 1) ? EN.sandDk : EN.sand;
    if (i === 1) return (j === 1 || j === 2) ? EN.sandLt : EN.sand;
    return EN.sandLt;
  }, null, EN.sand);
  // main cannon mantlet + twin rail barrels
  b.block({ x: 0, y: 0.1, z: -1.2, w: 1.1, d: 0.6, h: 0.42, tw: 0.9, td: 0.5, oz: 0.04, bev: 0.06, top: EN.gun, bevS: EN.edge, side: EN.gunDk, front: EN.gunXDk });
  for (const x of [-0.26, 0.26]) {
    b.lathe([x, 0.3, -1.45], [0, 0, -1], [[0, 0.17], [0.3, 0.15], [0.35, 0.15], [0.45, 0.15], [0.8, 0.14], [0.85, 0.14], [0.95, 0.14], [1.4, 0.13], [1.45, 0.13], [1.55, 0.13], [1.75, 0.16], [1.95, 0.16], [1.95, 0.08]], 8, (i, j) => {
      if (i === 2 || i === 5 || i === 8) return GL(scl(EM.eyeOrange, 0.6), 0.4);   // glowing coils
      if (i === 10) return EN.edge;
      return (j === 1 || j === 2) ? EN.gunLt : EN.gunDk;
    }, null, GL(EM.eyeRed, 0.3), { phase: Math.PI / 8 });
  }
  // camo patches + engine grille on the turret roof
  b.decal([[-0.65, 0.626, -0.2], [-0.2, 0.626, -0.35], [-0.1, 0.626, 0.1], [-0.55, 0.626, 0.25]], lit('#8a7a4e'));
  b.decal([[0.15, 0.626, 0.35], [0.6, 0.626, 0.2], [0.62, 0.626, 0.6], [0.25, 0.626, 0.7]], lit('#6f7a45'));
  for (let k = 0; k < 3; k++) b.decal([[-0.45, 0.627, 0.45 + k * 0.1], [-0.05, 0.627, 0.45 + k * 0.1], [-0.05, 0.627, 0.49 + k * 0.1], [-0.45, 0.627, 0.49 + k * 0.1]], EN.gunXDk);
  // eye strip + hatch + hazard on turret rear
  b.decal([[-0.5, 0.63, -0.52], [0.5, 0.63, -0.52], [0.44, 0.63, -0.4], [-0.44, 0.63, -0.4]], GL(EM.eyeRed));
  b.lathe([0.35, 0.62, 0.25], [0, 1, 0], [[0, 0.24], [0.06, 0.22], [0.09, 0.0]], 6, EN.oliveDk);
  hazardStrip(b, -0.6, 0.95, 0.6, 0.95, 0.625, 0.18, 6);
  return b;
}
function buildCrawlerGun() {
  const b = new GB();
  b.lathe([0, 0, 0], [0, 1, 0], [[0, 0.48], [0.14, 0.46], [0.24, 0.34], [0.28, 0.0]], 8,
    (i, j) => (i === 1 ? ((j === 1 || j === 2) ? EN.sandLt : EN.sand) : i === 0 ? EN.sandDk : EN.sandLt), null, null, { phase: Math.PI / 8 });
  for (const x of [-0.12, 0.12]) {
    b.lathe([x, 0.14, -0.3], [0, 0, -1], [[0, 0.07], [0.6, 0.055], [0.6, 0.07], [0.72, 0.07], [0.72, 0.03]], 6,
      (i) => (i === 2 ? EN.edge : EN.gunDk), null, EN.black, { phase: Math.PI / 6 });
  }
  b.decal([[-0.1, 0.285, -0.2], [0.1, 0.285, -0.2], [0.08, 0.285, -0.1], [-0.08, 0.285, -0.1]], GL(EM.eyeRed));
  return b;
}

// =============================================================================
// Destructible part helper (boss + crawler)
// =============================================================================
/**
 * Wraps meshes in an Object3D part with radius / setFlash / setDestroyed /
 * muzzles. Destroying swaps each mesh's geometry to its wreck version (no
 * allocation) and gives it a slight sag.
 */
function makePart(name, radius, entries, muzzles, opts = {}) {
  const part = new THREE.Object3D(); part.name = name;
  const mats = [];
  for (const en of entries) {
    if (!en.mesh.parent) part.add(en.mesh);      // meshes already parented (e.g. on a hinge) stay put
    if (!mats.includes(en.mesh.material)) mats.push(en.mesh.material);
  }
  const ud = part.userData;
  ud.radius = radius;
  ud.muzzles = muzzles;
  ud.destroyed = false;
  ud.setFlash = flashFn(mats);
  ud.materials = mats;
  ud.setDestroyed = (d) => {
    d = !!d; ud.destroyed = d;
    for (const en of entries) {
      if (en.wreck) en.mesh.geometry = d ? en.wreck : en.intact;
      else if (en.hideOnDestroy) en.mesh.visible = !d;
      if (en.sag) {
        en.mesh.rotation.set(d ? en.sag[0] : 0, 0, d ? en.sag[2] : 0);
        en.mesh.position.y = d ? (en.sag[1] || 0) : 0;
      }
    }
    if (opts.onDestroyed) opts.onDestroyed(d);
  };
  return part;
}

export function createEnemy(type) {
  switch (type) {
    case 'dart': {
      const { g, pivot, ud } = enemyShell('dart', 0.6, '#48505b');
      const mat = bodyMat(0.55, 0.3);
      pivot.add(new THREE.Mesh(GG('dart', buildDart), mat));
      ud.muzzles = [new THREE.Vector3(0, 0, -0.68)];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => { mat.uEmitScale.value = 0.85 + Math.sin(t * 17) * 0.15; pivot.rotation.z = Math.sin(t * 2.3) * 0.06; };
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'hornet': {
      const { g, pivot, ud } = enemyShell('hornet', 0.8, '#5f6b3a');
      const mat = bodyMat(0.6, 0.2);
      pivot.add(new THREE.Mesh(GG('hornet', buildHornet), mat));
      const rotor = new THREE.Group(); rotor.name = 'rotor'; rotor.position.set(0, 0.46, -0.02);
      rotor.add(new THREE.Mesh(GG('hornet.blades', buildRotorBlades), mat));
      const discMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const disc = new THREE.Mesh(G('hornet.disc', buildRotorDisc), discMat); disc.userData.noShadow = true; disc.renderOrder = 1;
      rotor.add(disc);
      pivot.add(rotor);
      ud.rotor = rotor;
      ud.muzzles = [new THREE.Vector3(-0.76, 0.04, -0.62), new THREE.Vector3(0.76, 0.04, -0.62)];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        rotor.rotation.y -= dt * 24;
        pivot.position.y = Math.sin(t * 3.1) * 0.05;
        pivot.rotation.x = Math.sin(t * 2.2) * 0.04;
        mat.uEmitScale.value = 0.8 + Math.sin(t * 6) * 0.2;
      };
      ud.dispose = () => { mat.dispose(); discMat.dispose(); };
      return g;
    }
    case 'tank': {
      const { g, pivot, ud } = enemyShell('tank', 0.7, '#5f6b3a');
      const mat = bodyMat(0.72, 0.15);
      pivot.add(new THREE.Mesh(GG('tank.hull', buildTankHull), mat));
      const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.39, 0.06);
      turret.add(new THREE.Mesh(GG('tank.turret', buildTankTurret), mat));
      pivot.add(turret);
      ud.turret = turret;
      const local = [new THREE.Vector3(0, 0.1, -1.06)];
      turret.userData.muzzles = local;
      ud.muzzles = [new THREE.Vector3()];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => { syncMuzzles(ud.muzzles, local, turret); mat.uEmitScale.value = 0.8 + Math.sin(t * 5) * 0.2; };
      syncMuzzles(ud.muzzles, local, turret);
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'turret': {
      const { g, pivot, ud } = enemyShell('turret', 0.8, '#9c9b93');
      const mat = bodyMat(0.75, 0.12);
      pivot.add(new THREE.Mesh(GG('turret.base', buildTurretBase), mat));
      const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.41, 0);
      turret.add(new THREE.Mesh(GG('turret.head', buildTurretHead), mat));
      pivot.add(turret);
      ud.turret = turret;
      const local = [new THREE.Vector3(-0.11, 0.15, -1.12), new THREE.Vector3(0.11, 0.15, -1.12)];
      turret.userData.muzzles = local;
      ud.muzzles = [new THREE.Vector3(), new THREE.Vector3()];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => { syncMuzzles(ud.muzzles, local, turret); mat.uEmitScale.value = 0.75 + Math.sin(t * 4) * 0.25; };
      syncMuzzles(ud.muzzles, local, turret);
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'gunboat': {
      const { g, pivot, ud } = enemyShell('gunboat', 1.1, '#465363');
      ud.halfExtents = { x: 0.8, z: 2.0 };
      const mat = bodyMat(0.65, 0.2);
      pivot.add(new THREE.Mesh(GG('gunboat.hull', buildGunboatHull), mat));
      const turret = new THREE.Group(); turret.name = 'turret'; turret.position.set(0, 0.36, -1.05);
      turret.add(new THREE.Mesh(GG('gunboat.turret', buildGunboatTurret), mat));
      pivot.add(turret);
      ud.turret = turret;
      const local = [new THREE.Vector3(-0.08, 0.2, -0.82), new THREE.Vector3(0.08, 0.2, -0.82)];
      turret.userData.muzzles = local;
      ud.muzzles = [new THREE.Vector3(), new THREE.Vector3()];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        syncMuzzles(ud.muzzles, local, turret);
        pivot.rotation.z = Math.sin(t * 1.3) * 0.025; pivot.rotation.x = Math.sin(t * 0.9) * 0.012;
        mat.uEmitScale.value = 0.85 + Math.sin(t * 3) * 0.15;
      };
      syncMuzzles(ud.muzzles, local, turret);
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'carrier': {
      const { g, pivot, ud } = enemyShell('carrier', 1.0, '#f2c02a');
      const mat = bodyMat(0.55, 0.15);
      pivot.add(new THREE.Mesh(GG('carrier', buildCarrier), mat));
      const fanGeo = GG('carrier.fan', buildCarrierFan);
      const fanL = new THREE.Mesh(fanGeo, mat), fanR = new THREE.Mesh(fanGeo, mat);
      fanL.position.set(-0.8, 0.0, 0.06); fanR.position.set(0.8, 0.0, 0.06);
      pivot.add(fanL, fanR);
      ud.muzzles = [new THREE.Vector3(0, 0, -1.0)];
      ud.fans = [fanL, fanR];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        fanL.rotation.y += dt * 18; fanR.rotation.y -= dt * 18;
        pivot.position.y = Math.sin(t * 2) * 0.06;
        pivot.rotation.z = Math.sin(t * 1.4) * 0.05;
        mat.uEmitScale.value = (Math.sin(t * 5) > 0.3 ? 1.25 : 0.55);
      };
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'bomber': {
      const { g, pivot, ud } = enemyShell('bomber', 1.9, '#48505b');
      ud.halfExtents = { x: 2.5, z: 1.7 };
      const mat = bodyMat(0.6, 0.3);
      pivot.add(new THREE.Mesh(GG('bomber', buildBomber), mat));
      ud.muzzles = [new THREE.Vector3(0, 0.38, -0.84), new THREE.Vector3(-0.95, -0.06, -0.78), new THREE.Vector3(0.95, -0.06, -0.78)];
      ud.setFlash = flashFn([mat]);
      ud.update = (dt, t) => {
        mat.uEmitScale.value = 0.9 + Math.sin(t * 23) * 0.06 + Math.sin(t * 2) * 0.1;
        pivot.rotation.z = Math.sin(t * 0.9) * 0.03;
      };
      ud.dispose = () => mat.dispose();
      return g;
    }
    case 'crawler': return createCrawler();
    default: throw new Error(`models.createEnemy: unknown type "${type}"`);
  }
}

function createCrawler() {
  const { g, pivot, ud } = enemyShell('crawler', 2.6, '#b9a878');
  ud.halfExtents = { x: 3.0, z: 2.5 };
  const hullMat = bodyMat(0.72, 0.18);
  pivot.add(new THREE.Mesh(GG('crawler.hull', buildCrawlerHull), hullMat));
  const mkPart = (key, build, name, radius, pos, muzzles, wreckKeep, sag) => {
    const mat = bodyMat(0.68, 0.2);
    const intact = GG(key, build);
    const wreck = G(key + '.wreck', () => wreckOf(gbOf(key, build), wreckKeep).build());
    const mesh = new THREE.Mesh(intact, mat);
    const part = makePart(name, radius, [{ mesh, intact, wreck, sag }], muzzles);
    part.position.copy(pos);
    return part;
  };
  const turret = mkPart('crawler.turret', buildCrawlerTurret, 'turret', 1.2, new THREE.Vector3(0, 1.18, 0.45),
    [new THREE.Vector3(-0.26, 0.3, -3.42), new THREE.Vector3(0.26, 0.3, -3.42)],
    { keep: (x, y, z) => 1.9 + z, crumple: 0.12, seed: 3, dir: [0, 0, -1], shards: 12, shardSize: 0.3, band: 0.5 }, [0.04, -0.04, 0.02]);
  const gunL = mkPart('crawler.gun', buildCrawlerGun, 'gunL', 0.6, new THREE.Vector3(-1.45, 1.2, -1.55),
    [new THREE.Vector3(-0.12, 0.14, -1.04), new THREE.Vector3(0.12, 0.14, -1.04)],
    { keep: (x, y, z) => 0.45 + z, crumple: 0.08, seed: 5, dir: [0, 0, -1], shards: 7, shardSize: 0.16, band: 0.3 }, [0.1, -0.05, 0.08]);
  const gunR = mkPart('crawler.gun', buildCrawlerGun, 'gunR', 0.6, new THREE.Vector3(1.45, 1.2, -1.55),
    [new THREE.Vector3(-0.12, 0.14, -1.04), new THREE.Vector3(0.12, 0.14, -1.04)],
    { keep: (x, y, z) => 0.45 + z, crumple: 0.08, seed: 5, dir: [0, 0, -1], shards: 7, shardSize: 0.16, band: 0.3 }, [0.1, -0.05, -0.08]);
  pivot.add(turret, gunL, gunR);
  ud.parts = { turret, gunL, gunR };
  ud.turret = turret;
  const mats = [hullMat, ...turret.userData.materials, ...gunL.userData.materials, ...gunR.userData.materials];
  ud.setFlash = flashFn(mats);
  ud.muzzles = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const sync = () => {
    const tm = turret.userData.muzzles, lm = gunL.userData.muzzles, rm = gunR.userData.muzzles;
    const o = ud.muzzles;
    syncMuzzles(TMP_MUZ2, tm, turret); o[0].copy(TMP_MUZ2[0]); o[1].copy(TMP_MUZ2[1]);
    syncMuzzles(TMP_MUZ2, lm, gunL); o[2].copy(TMP_MUZ2[0]); o[3].copy(TMP_MUZ2[1]);
    syncMuzzles(TMP_MUZ2, rm, gunR); o[4].copy(TMP_MUZ2[0]); o[5].copy(TMP_MUZ2[1]);
  };
  sync();
  ud.update = (dt, t) => {
    sync();
    const p = 0.8 + Math.sin(t * 4) * 0.2;
    for (let i = 0; i < mats.length; i++) mats[i].uEmitScale.value = p;
  };
  ud.dispose = () => { for (const m of mats) m.dispose(); };
  return g;
}
const TMP_MUZ2 = [new THREE.Vector3(), new THREE.Vector3()];

// =============================================================================
// BOSS — flying fortress "ARCLIGHT"
// =============================================================================
/** diagonal hazard stripes draped over the surface of triangles [from,to) */
function hazardDrape(b, x0, z0, x1, z1, width, n, cA, cB, from, to, lift = 0.005, sub = 2) {
  const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz) || 1;
  const ux = dx / L, uz = dz / L, px = -uz * width / 2, pz = ux * width / 2;
  const step = L / n, sk = width * 0.45;
  const A = [], B = [];
  for (let k = 0; k < n; k++) {
    const a = k * step, c = (k + 1) * step;
    const p = (q, side) => [x0 + ux * (q + side * sk) + px * side, z0 + uz * (q + side * sk) + pz * side];
    (k % 2 ? B : A).push([p(a, -1), p(c, -1), p(c, 1), p(a, 1)]);
  }
  b.drape(A, cA, from, to, lift, sub); b.drape(B, cB, from, to, lift, sub);
}
/** block whose base sits on the surface of triangles [from,to) at its centre */
function blockOn(b, from, to, o, sink = 0.04) {
  const y = b.surfaceY(o.x, o.z, from, to);
  return b.block({ ...o, y: (y === null ? 0 : y) - sink });
}

function buildBossHull() {
  const b = new GB();
  // ---- central spine (8-sided armoured section)
  const ring = ([z, w, tp, bt]) => [[-w * 0.45, tp, z], [w * 0.45, tp, z], [w, tp * 0.5, z], [w, -bt * 0.4, z], [w * 0.55, -bt, z],
    [-w * 0.55, -bt, z], [-w, -bt * 0.4, z], [-w, tp * 0.5, z]];
  const ST = [[-4.2, 0.2, 0.12, 0.1], [-3.55, 0.85, 0.4, 0.3], [-2.6, 1.35, 0.58, 0.42], [-2.5, 1.38, 0.59, 0.42],
    [-1.4, 1.7, 0.66, 0.48], [2.4, 1.78, 0.66, 0.5], [2.5, 1.76, 0.65, 0.5], [3.5, 1.6, 0.58, 0.45], [4.1, 1.45, 0.5, 0.4]];
  const s0 = b.n;
  b.loft(ST.map(ring), (i, j) => {
    const line = i === 2 || i === 5;
    if (j === 0) return line ? BO.black : (i <= 1 ? BO.panel : BO.plate);
    if (j === 1 || j === 7) return line ? BO.steelDk : BO.trim;           // lit bevels outline the spine
    if (j === 2 || j === 6) return BO.steel;
    return BO.steelXDk;
  }, null, BO.steelDk);
  const s1 = b.n;
  // prow "face": two slanted magenta eye slits
  for (const sg of [-1, 1]) b.drape([[[0.08 * sg, -3.42], [0.46 * sg, -3.02], [0.4 * sg, -2.9], [0.06 * sg, -3.24]]], GL(EM.magenta), s0, s1, 0.006, 2);
  hazardDrape(b, -0.5, -2.62, 0.5, -2.62, 0.16, 7, BO.hazard, BO.black, s0, s1);
  // front armour wedge + crest
  b.block({ x: 0, y: 0.56, z: -1.85, w: 1.7, d: 1.3, h: 0.2, tw: 1.3, td: 1.05, oz: 0.08, bev: 0.06, top: BO.panel, bevS: BO.trimLt, side: BO.steel });
  b.block({ x: 0, y: 0.64, z: -0.85, w: 0.3, d: 0.8, h: 0.16, tw: 0.2, td: 0.7, bev: 0.03, top: GL(scl(EM.magenta, 0.8), 0.4), bevS: BO.trim, side: BO.steelDk });
  // dorsal spikes along the spine shoulders
  for (const sg of [-1, 1]) for (const z of [-1.3, -0.35, 2.05, 2.75]) {
    const x = 1.45 * sg, y = 0.5;
    b.spike([[x - 0.12, y, z - 0.22], [x + 0.12, y, z - 0.22], [x + 0.12 * sg, y, z + 0.22], [x - 0.12 * sg, y, z + 0.18]], [x + 0.22 * sg, y + 0.42, z + 0.1], (k) => (k & 1 ? BO.trim : BO.steel));
  }
  // rear armour deck with violet vents
  b.block({ x: 0, y: 0.6, z: 3.05, w: 2.6, d: 1.3, h: 0.2, tw: 2.4, td: 1.1, bev: 0.05, top: BO.plate, bevS: BO.trim, side: BO.steel });
  for (let k = 0; k < 4; k++) {
    const z = 2.7 + k * 0.2;
    b.decal([[-1.0, 0.802, z], [-0.25, 0.802, z], [-0.25, 0.802, z + 0.09], [-1.0, 0.802, z + 0.09]], k & 1 ? BO.black : GL(EM.violet, 0.3));
    b.decal([[0.25, 0.802, z], [1.0, 0.802, z], [1.0, 0.802, z + 0.09], [0.25, 0.802, z + 0.09]], k & 1 ? BO.black : GL(EM.violet, 0.3));
  }
  // ---- engine block + 5 nozzles
  b.block({ x: 0, y: -0.35, z: 3.9, w: 4.0, d: 0.9, h: 0.8, tw: 3.8, td: 0.8, bev: 0.08, top: BO.plate, bevS: BO.trim, side: BO.steelDk, back: BO.steelXDk });
  for (const x of [-1.5, -0.75, 0, 0.75, 1.5]) {
    b.lathe([x, 0.05, 4.1], [0, 0, 1], [[0, 0.3], [0.2, 0.33], [0.3, 0.33], [0.36, 0.29], [0.5, 0.26], [0.5, 0.17]], 8,
      (i, j) => (i === 1 ? ((j === 1 || j === 2) ? BO.trimLt : BO.trim) : i === 3 ? BO.steelDk : BO.steel), null, GL(EM.violet, 0.6), { phase: Math.PI / 8 });
  }
  const f0 = b.n;
  // ---- inner wing (static)
  b.wing([{ x: 1.5, y: -0.05, zl: -2.0, zt: 3.75, t: 0.62 }, { x: 2.45, y: -0.03, zl: -1.75, zt: 3.55, t: 0.56 },
    { x: 2.52, y: -0.03, zl: -1.73, zt: 3.54, t: 0.56 }, { x: 3.7, y: 0.0, zl: -1.4, zt: 3.2, t: 0.5 }], (i, j) => {
    if (j >= 4) return BO.steelXDk;
    if (i === 1) return BO.black;                         // panel seam
    if (j === 0) return BO.trimLt;
    if (j === 3) return BO.steelDk;
    return j === 1 ? BO.panel : BO.plate;
  }, null, BO.steel);
  const f1 = b.n;
  // armour plates + ribs
  blockOn(b, f0, f1, { x: 2.65, z: -0.75, w: 1.5, d: 1.1, h: 0.16, tw: 1.36, td: 0.96, bev: 0.04, top: BO.panel, bevS: BO.trim, side: BO.steel });
  for (const z of [1.55, 1.85]) blockOn(b, f0, f1, { x: 2.4, z, w: 1.5, d: 0.1, h: 0.12, top: BO.trim, side: BO.steelDk });
  // energy conduits: core → wing, core → pod
  blockOn(b, f0, f1, { x: 2.5, z: 0.7, w: 2.3, d: 0.11, h: 0.12, top: GL(EM.magenta), side: BO.steelDk }, 0.06);
  blockOn(b, f0, f1, { x: 1.9, z: -1.25, w: 1.3, d: 0.12, h: 0.1, ry: 0.55, top: GL(EM.magenta, 0.4), side: BO.steelDk }, 0.05);
  // pod pylon
  b.block({ x: 2.6, y: -0.25, z: -1.6, w: 0.95, d: 1.4, h: 0.55, tw: 0.75, td: 1.2, top: BO.plate, side: BO.steelDk, front: BO.steelXDk });
  // red warning lights near the rear corners
  b.drape([[[3.2, 2.95], [3.45, 2.95], [3.45, 3.1], [3.2, 3.1]]], GL(EM.red), f0, f1, 0.006, 1);
  b.mirrorX(f0);
  return b;
}
function buildBossFlames() {
  const pos = [], col = [];
  for (const x of [-1.5, -0.75, 0, 0.75, 1.5]) {
    const cone = (r, len, cb, ct, sides) => {
      for (let k = 0; k < sides; k++) {
        const a0 = (TAU * k) / sides, a1 = (TAU * (k + 1)) / sides;
        pos.push(x + Math.cos(a0) * r, 0.05 + Math.sin(a0) * r, 0, x + Math.cos(a1) * r, 0.05 + Math.sin(a1) * r, 0, x, 0.05, len);
        col.push(...cb, ...cb, ...ct);
      }
    };
    cone(0.22, 1.1, rgb(0.6, 0.2, 1.0, 1.0), rgb(0.3, 0.0, 0.6, 0), 7);
    cone(0.12, 0.6, rgb(1.0, 0.55, 1.0, 1.5), rgb(0.8, 0.2, 1.0, 0.1), 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
/** core housing: armoured collar ring around the orb well (part-local, origin at part) */
function buildBossCoreFrame() {
  const b = new GB();
  const N = 12;
  const ring = (r, y) => Array.from({ length: N }, (_, k) => { const a = (k * TAU) / N + Math.PI / N; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
  b.loft([ring(1.48, 0.1), ring(1.44, 0.5), ring(1.24, 0.7), ring(1.0, 0.68), ring(0.92, 0.1)], (i, j) => {
    if (i === 0) return (j & 1) ? BO.steel : BO.steelDk;
    if (i === 1) return (j % 3 === 1) ? GL(EM.magenta, 0.4) : BO.trim;
    if (i === 2) return BO.panel;
    return BO.steelXDk;
  });
  b.lathe([0, 0.12, 0], [0, 1, 0], [[0, 0.95], [0, 0.0]], N, BO.black);
  // four buttress claws around the crown
  for (let k = 0; k < 4; k++) {
    const f = b.n, a = Math.PI / 4 + (k * TAU) / 4;
    b.block({ x: 1.55, y: 0.0, z: 0, w: 0.5, d: 0.55, h: 0.62, tw: 0.3, td: 0.4, ox: -0.08, bev: 0.05, top: BO.panel, bevS: BO.trimLt, side: BO.steel });
    b.spike([[1.72, 0.1, -0.22], [1.72, 0.1, 0.22], [1.72, 0.5, 0]], [2.05, 0.18, 0], (q) => (q === 1 ? BO.trim : BO.steelDk));
    b.xform(f, M(0, 0, 0, 0, -a, 0));
  }
  return b;
}
function buildBossOrb() {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(0.64, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const t = i / 9, k = hash3(t, 1.7, 3.1);
    const e = scl(EM.magenta, k > 0.7 ? 0.95 : k > 0.35 ? 0.66 : 0.42);
    const cy = 0.36;
    b.triO([p[i], p[i + 1] + cy, p[i + 2]], [p[i + 3], p[i + 4] + cy, p[i + 5]], [p[i + 6], p[i + 7] + cy, p[i + 8]], [0, cy, 0], GL(e, 0.55));
  }
  geo.dispose();
  return b;
}
function buildBossOrbDead() {
  const b = new GB();
  const geo = new THREE.IcosahedronGeometry(0.55, 1);
  const p = geo.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const t = i / 9, k = hash3(t, 4.7, 1.1);
    const st = k > 0.8 ? GL(EM.emberDim, 0.3) : S(lin(k > 0.4 ? '#1f1a1d' : '#2e2629'));
    const d = (v) => [p[v] * (0.9 + k * 0.15), p[v + 1] * 0.75 + 0.28, p[v + 2] * (0.9 + k * 0.15)];
    b.triO(d(i), d(i + 3), d(i + 6), [0, 0.28, 0], st);
  }
  geo.dispose();
  return b;
}
/** right-hand shutter (the left one is the same mesh with scale.x = −1): quarter-dome shell */
function buildBossShutter() {
  const b = new GB();
  const prof = [[0.0, 1.04], [0.34, 0.99], [0.66, 0.82], [0.9, 0.54], [1.02, 0.2]];     // (x, y) outer arc
  const inner = [[0.0, 0.9], [0.3, 0.86], [0.58, 0.7], [0.8, 0.46], [0.9, 0.2]];
  const zs = [[-1.02, 0.55], [-0.74, 0.88], [-0.3, 1.0], [0.3, 1.0], [0.74, 0.88], [1.02, 0.55]];
  const ringAt = ([z, sc]) => [...prof.map(([x, y]) => [x * sc + 0.012, 0.2 + (y - 0.2) * (0.6 + sc * 0.4), z]),
    ...inner.slice().reverse().map(([x, y]) => [x * sc + 0.012, 0.2 + (y - 0.2) * (0.6 + sc * 0.4), z])];
  const rings = zs.map(ringAt);
  const NP = prof.length;
  b.loft(rings, (i, j) => {
    if (j >= NP) return j === 2 * NP - 1 ? GL(EM.magenta, 0.35) : BO.steelXDk;   // inner lip of the seam glows
    if (j === NP - 1) return BO.steelDk;
    if (i === 0 || i === rings.length - 2) return BO.trim;
    if (j === 0) return BO.trimLt;                             // seam edge
    return (i + j) & 1 ? BO.plate : BO.panel;
  }, BO.steel, BO.steel);
  return b;
}
function buildBossWing() {   // right wing, part-local (part at x=+5, z=+0.6); forward-swept claw
  const b = new GB();
  const w0 = b.n;
  b.wing([{ x: -1.6, y: 0.0, zl: -2.0, zt: 2.6, t: 0.5 }, { x: -0.3, y: 0.02, zl: -2.15, zt: 2.2, t: 0.44 },
    { x: -0.22, y: 0.02, zl: -2.16, zt: 2.16, t: 0.44 }, { x: 1.0, y: 0.05, zl: -2.5, zt: 0.95, t: 0.3 },
    { x: 1.95, y: 0.08, zl: -3.05, zt: -1.3, t: 0.14 }], (i, j) => {
    if (j >= 4) return BO.steelXDk;
    if (i === 1) return BO.black;
    if (j === 0) return BO.trimLt;
    if (j === 3) return BO.steelDk;
    return j === 1 ? BO.panel : BO.plate;
  }, BO.steel, BO.trim);
  const w1 = b.n;
  // claw tip
  b.spike([[1.78, 0.04, -2.75], [2.12, 0.04, -2.75], [1.95, 0.2, -2.7]], [2.22, 0.06, -3.85], (k) => (k === 1 ? BO.trimLt : k === 2 ? BO.trim : BO.steelDk), BO.steelDk);
  // serrated trailing edge
  for (const [x, te] of [[-1.1, 2.42], [-0.05, 1.95], [0.85, 1.2]]) {
    b.spike([[x - 0.3, 0.02, te - 0.35], [x + 0.26, 0.02, te - 0.4], [x - 0.02, 0.2, te - 0.35]], [x + 0.28, 0.03, te + 0.62], (k) => (k === 2 ? BO.trim : BO.steelDk), BO.steelXDk);
  }
  // part boundary: hazard band along the root
  hazardDrape(b, -1.42, -1.5, -1.42, 2.1, 0.2, 9, BO.hazard, BO.black, w0, w1);
  // big cannon nacelle
  b.block({ x: -0.15, y: 0.12, z: -0.25, w: 1.05, d: 2.4, h: 0.42, tw: 0.86, td: 2.1, oz: 0.1, bev: 0.08, top: BO.panel, bevS: BO.trimLt, side: BO.steel, front: BO.steelXDk });
  b.lathe([-0.15, 0.36, -1.4], [0, 0, -1], [[0, 0.25], [0.2, 0.21], [1.05, 0.19], [1.1, 0.25], [1.35, 0.25], [1.35, 0.12]], 8, (i, j) => {
    if (i === 3) return BO.trimLt;
    return (j === 1 || j === 2) ? BO.trim : BO.steel;
  }, null, GL(EM.magentaHot, 0.6), { phase: Math.PI / 8 });
  for (const z of [-1.75, -2.05]) b.lathe([-0.15, 0.36, z], [0, 0, -1], [[0, 0.215], [0.09, 0.215]], 8, GL(EM.magenta, 0.4), null, null, { phase: Math.PI / 8 });
  // engine nozzle at the rear
  b.lathe([-0.15, 0.05, 1.75], [0, 0, 1], [[0, 0.36], [0.3, 0.4], [0.5, 0.34], [0.5, 0.22]], 8, (i) => (i === 1 ? BO.trim : BO.steelDk), null, GL(EM.violet, 0.6), { phase: Math.PI / 8 });
  // energy line root → nacelle, armour plate outboard, tip light
  blockOn(b, w0, w1, { x: -1.0, z: 0.15, w: 0.75, d: 0.1, h: 0.1, top: GL(EM.magenta), side: BO.steelDk }, 0.05);
  blockOn(b, w0, w1, { x: 0.95, z: -0.9, w: 0.8, d: 1.1, h: 0.12, tw: 0.7, td: 1.0, top: BO.panel, side: BO.trim }, 0.05);
  b.drape([[[1.62, -2.35], [1.86, -2.5], [1.92, -2.3], [1.7, -2.18]]], GL(EM.red), w0, w1, 0.006, 1);
  return b;
}
function buildBossPod() {    // part-local (part at x=±2.6, z=−2.8); symmetric forked mandible cannon
  const b = new GB();
  const ring = ([z, w, tp, bt]) => [[-w * 0.5, tp, z], [w * 0.5, tp, z], [w, tp * 0.4, z], [w * 0.8, -bt, z], [-w * 0.8, -bt, z], [-w, tp * 0.4, z]];
  const s0 = b.n;
  b.loft([[-1.15, 0.44, 0.34, 0.28], [-0.95, 0.58, 0.46, 0.36], [0.25, 0.64, 0.5, 0.4], [0.35, 0.64, 0.5, 0.4], [1.1, 0.6, 0.46, 0.38], [1.55, 0.42, 0.32, 0.28]].map(ring), (i, j) => {
    const line = i === 2;
    if (j === 0) return line ? BO.black : (i === 0 ? BO.trimLt : BO.panel);
    if (j === 1 || j === 5) return line ? BO.steelDk : BO.trim;
    if (j === 2 || j === 4) return BO.steelDk;
    return BO.steelXDk;
  }, BO.steelDk, BO.steelDk);
  const s1 = b.n;
  // prongs with blade tips
  for (const sg of [-1, 1]) {
    b.block({ x: 0.32 * sg, y: -0.24, z: -1.5, w: 0.3, d: 1.0, h: 0.5, tw: 0.22, td: 0.9, oz: 0.05, bev: 0.05, top: BO.plate, bevS: BO.trimLt, side: BO.steelDk, front: BO.steel });
    b.spike([[0.32 * sg - 0.14, -0.2, -1.98], [0.32 * sg + 0.14, -0.2, -1.98], [0.32 * sg, 0.2, -1.98]], [0.32 * sg - 0.06 * sg, 0.0, -2.5], (k) => (k === 2 ? BO.trimLt : BO.steel));
  }
  // energy lens between the prongs
  b.lathe([0, 0.02, -1.3], [0, 0, -1], [[0, 0.21], [0.14, 0.19], [0.3, 0.0]], 8, (i, j) => GL((j & 1) ? EM.magentaHot : EM.magenta, 0.5), null, null, { phase: Math.PI / 8 });
  // hazard chevrons on top mark it as a separate target
  hazardDrape(b, 0, -0.6, 0, 0.1, 0.5, 5, BO.hazard, BO.black, s0, s1);
  // side vents
  for (const sg of [-1, 1]) for (let k = 0; k < 3; k++) {
    const z = 0.45 + k * 0.24;
    b.drape([[[0.2 * sg, z], [0.5 * sg, z], [0.5 * sg, z + 0.1], [0.2 * sg, z + 0.1]]], k === 1 ? GL(EM.magenta, 0.4) : BO.black, s0, s1, 0.005, 2);
  }
  return b;
}
function buildBossTurret() { // part-local; barrels along −z
  const b = new GB();
  b.lathe([0, -0.22, 0], [0, 1, 0], [[0, 0.66], [0.16, 0.64], [0.21, 0.54], [0.24, 0.0]], 10,
    (i, j) => (i === 0 ? BO.steelDk : i === 1 ? ((j & 1) ? BO.trim : BO.trimLt) : BO.steelXDk), null, null, { phase: Math.PI / 10 });
  b.block({ x: 0, y: 0.0, z: 0.04, w: 0.82, d: 0.92, h: 0.36, tw: 0.64, td: 0.76, oz: 0.05, bev: 0.06, top: BO.panel, bevS: BO.trimLt, side: BO.steel, front: BO.steelDk });
  for (const x of [-0.14, 0.14]) {
    b.lathe([x, 0.2, -0.4], [0, 0, -1], [[0, 0.08], [0.62, 0.065], [0.62, 0.085], [0.76, 0.085], [0.76, 0.04]], 6,
      (i) => (i === 2 ? BO.trimLt : BO.steelDk), null, GL(EM.magentaHot, 0.5), { phase: Math.PI / 6 });
  }
  b.decal([[-0.2, 0.365, -0.24], [0.2, 0.365, -0.24], [0.15, 0.365, -0.13], [-0.15, 0.365, -0.13]], GL(EM.magenta));
  b.decal([[-0.22, 0.365, 0.2], [0.22, 0.365, 0.2], [0.22, 0.365, 0.3], [-0.22, 0.365, 0.3]], BO.hazard);
  return b;
}

export function createBoss() {
  const g = new THREE.Group(); g.name = 'boss';
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = 'boss';
  ud.radius = 3.0;
  ud.debrisColor = new THREE.Color('#3b404b');

  const hullMat = bodyMat(0.55, 0.35);
  const hull = new THREE.Mesh(GG('boss.hull', buildBossHull), hullMat); hull.name = 'hull';
  pivot.add(hull);
  const flameMat = additiveMat();
  const flames = new THREE.Mesh(G('boss.flames', buildBossFlames), flameMat); flames.name = 'flames';
  flames.position.set(0, 0, 4.6); flames.userData.noShadow = true; flames.renderOrder = 2;
  pivot.add(flames);

  const allMats = [hullMat];
  const partMat = () => { const m = bodyMat(0.55, 0.35); allMats.push(m); return m; };

  // ---- core (armoured dome with clamshell shutters)
  const coreMat = partMat();
  const frameGeo = GG('boss.coreFrame', buildBossCoreFrame);
  const frameWreck = G('boss.coreFrame.wreck', () => wreckOf(gbOf('boss.coreFrame', buildBossCoreFrame),
    { keep: () => 1, crumple: 0.14, seed: 7, shards: 14, shardSize: 0.3, band: 2, dir: [0, 1, 0] }).build());
  const frame = new THREE.Mesh(frameGeo, coreMat);
  const orbGeo = GG('boss.orb', buildBossOrb), orbDead = GG('boss.orbDead', buildBossOrbDead);
  const orbMat = bodyMat(0.5, 0.1); allMats.push(orbMat);
  const orb = new THREE.Mesh(orbGeo, orbMat);
  const shutterGeo = G('boss.shutter', () => buildBossShutter().build());
  // left shutter = same geometry mirrored by scale.x = −1 (three flips the winding for us)
  const hingeR = new THREE.Object3D(); hingeR.position.set(1.02, 0.2, 0);
  const hingeL = new THREE.Object3D(); hingeL.position.set(-1.02, 0.2, 0);
  const shR = new THREE.Mesh(shutterGeo, coreMat); shR.position.set(-1.02, -0.2, 0);
  const shL = new THREE.Mesh(shutterGeo, coreMat); shL.position.set(1.02, -0.2, 0); shL.scale.x = -1;
  hingeR.add(shR); hingeL.add(shL);
  const core = makePart('core', 1.3, [
    { mesh: frame, intact: frameGeo, wreck: frameWreck },
    { mesh: orb, intact: orbGeo, wreck: orbDead },
    { mesh: shR, hideOnDestroy: true }, { mesh: shL, hideOnDestroy: true },
  ], [new THREE.Vector3(0, 0.9, 0)]);
  core.add(hingeR, hingeL);
  core.userData.materials.push(orbMat);
  core.userData.setFlash = flashFn([coreMat, orbMat]);
  core.position.set(0, 0.3, 0.8);
  let openT = 0;
  core.userData.open = 0;
  core.userData.setOpen = (t) => {
    openT = Math.max(0, Math.min(1, t)); core.userData.open = openT;
    const e = openT < 0.5 ? 2 * openT * openT : 1 - Math.pow(-2 * openT + 2, 2) / 2;   // ease in-out
    hingeR.rotation.z = -e * 118 * DEG; hingeL.rotation.z = e * 118 * DEG;
  };
  // ---- wings
  const wingKeep = { keep: (x) => -0.4 - x, crumple: 0.16, seed: 11, dir: [1, 0, 0], shards: 16, shardSize: 0.42, band: 0.7 };
  const mkWing = (side) => {
    const m = partMat();
    const intact = GG('boss.wing', buildBossWing);
    const wreck = G('boss.wing.wreck', () => wreckOf(gbOf('boss.wing', buildBossWing), wingKeep).build());
    const mesh = new THREE.Mesh(intact, m);
    if (side < 0) mesh.scale.x = -1;
    const part = makePart(side < 0 ? 'wingL' : 'wingR', 1.5, [{ mesh, intact, wreck, sag: [0.05, -0.12, -0.1 * side] }],
      [new THREE.Vector3(-0.15 * side, 0.36, -2.8)]);
    part.position.set(5 * side, 0, 0.6);
    return part;
  };
  const wingL = mkWing(-1), wingR = mkWing(1);
  // ---- pods
  const podKeep = { keep: (x, y, z) => z + 0.1, crumple: 0.14, seed: 13, dir: [0, 0, -1], shards: 12, shardSize: 0.3, band: 0.5 };
  const mkPod = (side) => {
    const m = partMat();
    const intact = GG('boss.pod', buildBossPod);
    const wreck = G('boss.pod.wreck', () => wreckOf(gbOf('boss.pod', buildBossPod), podKeep).build());
    const part = makePart(side < 0 ? 'podL' : 'podR', 1.0, [{ mesh: new THREE.Mesh(intact, m), intact, wreck, sag: [0.1, -0.1, 0.06 * side] }],
      [new THREE.Vector3(0, 0.02, -1.66)]);
    part.position.set(2.6 * side, 0, -2.8);
    return part;
  };
  const podL = mkPod(-1), podR = mkPod(1);
  // ---- turrets
  const turKeep = { keep: (x, y, z) => z + 0.42, crumple: 0.1, seed: 17, dir: [0, 0.4, -1], shards: 8, shardSize: 0.2, band: 0.35 };
  const TPOS = [[-1.8, 0.6, -0.6], [1.8, 0.6, -0.6], [-3.4, 0.4, 2.2], [3.4, 0.4, 2.2]];
  const turrets = TPOS.map((p, k) => {
    const m = partMat();
    const intact = GG('boss.turret', buildBossTurret);
    const wreck = G('boss.turret.wreck', () => wreckOf(gbOf('boss.turret', buildBossTurret), turKeep).build());
    const part = makePart('t' + k, 0.6, [{ mesh: new THREE.Mesh(intact, m), intact, wreck, sag: [0.12, -0.08, 0.1 * (k & 1 ? 1 : -1)] }],
      [new THREE.Vector3(-0.14, 0.2, -1.2), new THREE.Vector3(0.14, 0.2, -1.2)]);
    part.position.set(p[0], p[1], p[2]);
    return part;
  });
  pivot.add(core, wingL, wingR, podL, podR, ...turrets);
  ud.parts = { core, wingL, wingR, podL, podR, turrets };
  ud.muzzles = [new THREE.Vector3(0, 0.5, -3.4)];
  ud.setFlash = flashFn(allMats);
  core.userData.setOpen(0);
  ud.update = (dt, t) => {
    const pulse = 0.8 + Math.sin(t * 3.2) * 0.2;
    for (let i = 0; i < allMats.length; i++) allMats[i].uEmitScale.value = pulse;
    orbMat.uEmitScale.value = core.userData.destroyed ? 0.8 : (0.3 + openT * 0.8) * (1 + Math.sin(t * 9) * 0.12);
    orb.rotation.y += dt * (0.5 + openT * 2.5);
    const fl = 1 + Math.sin(t * 37) * 0.08 + Math.sin(t * 23) * 0.05;
    flames.scale.set(1, 1, fl);
    flameMat.color.setScalar(0.9 + Math.sin(t * 29) * 0.1);
    pivot.position.y = Math.sin(t * 0.8) * 0.12;
  };
  ud.dispose = () => { for (const m of allMats) m.dispose(); flameMat.dispose(); };
  return g;
}

// =============================================================================
// ITEMS
// =============================================================================
function glyphTex(text) {
  const key = 'glyph:' + text;
  let tex = TEX.get(key);
  if (tex) return tex;
  const wide = text.length > 1;
  const W = wide ? 256 : 128, H = 128;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const size = wide ? 94 : 104;
  g.font = `900 ${size}px "Arial Black", "Segoe UI Black", "Helvetica Neue", Arial, system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const m = g.measureText(text);
  const asc = m.actualBoundingBoxAscent || size * 0.72, desc = m.actualBoundingBoxDescent || 0;
  const y = H / 2 + (asc - desc) / 2;
  g.lineJoin = 'round'; g.miterLimit = 2;
  g.lineWidth = wide ? 30 : 28; g.strokeStyle = 'rgba(5,6,12,0.95)'; g.strokeText(text, W / 2, y);
  const gr = g.createLinearGradient(0, y - asc, 0, y);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#e6ecf5');
  g.fillStyle = gr; g.fillText(text, W / 2, y);
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  TEX.set(key, tex);
  return tex;
}
function haloTex() {
  let tex = TEX.get('halo');
  if (tex) return tex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.14)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  TEX.set('halo', tex);
  return tex;
}

const ITEM_COL = {
  red: { body: '#ff3a2e', glow: rgb(1.0, 0.16, 0.08, 1.6), halo: rgb(1.0, 0.2, 0.1) },
  blue: { body: '#3a86ff', glow: rgb(0.14, 0.45, 1.0, 1.6), halo: rgb(0.2, 0.5, 1.0) },
  H: { body: '#2fe060', glow: rgb(0.14, 1.0, 0.32, 1.3), halo: rgb(0.14, 0.7, 0.24) },
  N: { body: '#b64cff', glow: rgb(0.66, 0.2, 1.0, 1.6), halo: rgb(0.65, 0.25, 1.0) },
  B: { body: '#ff8a1c', glow: rgb(1.0, 0.46, 0.06, 1.6), halo: rgb(1.0, 0.5, 0.12) },
  medal: { body: '#ffffff', glow: rgb(1.0, 0.7, 0.18, 1.0), halo: rgb(1.0, 0.72, 0.2) },
  '1UP': { body: '#2fd84e', glow: rgb(0.25, 1.0, 0.3, 0.6), halo: rgb(0.16, 0.5, 0.16) },
};
const SILVER = lit('#c9d0d9'), SILVER_DK = lit('#7d8793'), ITEM_DARK = lit('#23272e');
/** facet shades: albedo is tinted by material.color, emission by uEmitTint */
const FAC = (k, e) => S([k, k, k], [e, e, e]);

function buildGem() {         // power crystal: brilliant-cut gem lying flat, long axis z
  const b = new GB();
  const hex = (y, sx, sz) => Array.from({ length: 6 }, (_, k) => {
    const a = (k * TAU) / 6 + Math.PI / 6; return [Math.cos(a) * sx, y, Math.sin(a) * sz];
  });
  const R = [hex(-0.22, 0.001, 0.001), hex(0.0, 0.34, 0.46), hex(0.09, 0.3, 0.4), hex(0.15, 0.17, 0.23)];
  b.loft(R, (i, j) => (i === 0 ? FAC((j & 1) ? 0.55 : 0.4, 0.5) : i === 1 ? FAC(1, 0.35) : FAC((j & 1) ? 0.95 : 0.72, (j & 1) ? 0.9 : 0.45)),
    null, FAC(0.9, 0.95));
  return b;
}
function buildCapsule() {     // pill along x with a glowing belt
  const b = new GB();
  b.lathe([-0.48, 0, 0], [1, 0, 0], [[0, 0], [0.05, 0.14], [0.13, 0.22], [0.22, 0.26], [0.27, 0.26], [0.69, 0.26], [0.74, 0.26], [0.83, 0.22], [0.91, 0.14], [0.96, 0]], 10, (i, j) => {
    if (i === 3 || i === 5) return ITEM_DARK;
    if (i === 4) return S([0.5, 0.5, 0.5], (j & 1) ? [1.25, 1.25, 1.25] : [0.8, 0.8, 0.8]);
    return (j & 1) ? SILVER : SILVER_DK;
  });
  return b;
}
function buildBombItem() {    // cartoon bomb: round orange body, silver tail fins, nose along −z
  const b = new GB();
  b.lathe([0, 0, 0.3], [0, 0, -1], [[0, 0.0], [0.03, 0.16], [0.1, 0.25], [0.24, 0.31], [0.4, 0.3], [0.52, 0.24], [0.6, 0.14], [0.64, 0.0]], 10, (i, j) => {
    if (i === 0) return SILVER_DK;
    if (i === 2) return S([0.45, 0.45, 0.45], [1.1, 1.1, 1.1]);
    return S((j & 1) ? [1, 1, 1] : [0.78, 0.78, 0.78], [0.18, 0.18, 0.18]);
  }, null, null, { phase: Math.PI / 10 });
  b.lathe([0, 0, 0.26], [0, 0, 1], [[0, 0.13], [0.16, 0.1]], 8, SILVER_DK, null, ITEM_DARK);
  for (let k = 0; k < 4; k++) {
    const f = b.n;
    b.block({ x: 0.2, y: -0.014, z: 0.36, w: 0.24, d: 0.22, h: 0.028, tw: 0.24, td: 0.12, oz: 0.05, top: SILVER, side: SILVER_DK });
    b.xform(f, M(0, 0, 0, 0, 0, (k * TAU) / 4 + Math.PI / 4));
  }
  return b;
}
function buildMedal() {       // coin facing +y: gold rim, raised star; tinted gold by vertex colour
  const b = new GB();
  const G0 = lin('#ffc21a'), G1 = lin('#ffe07a'), G2 = lin('#b37a06');
  const GOLD = S(G0, rgb(1, 0.6, 0.08, 0.28)), GOLD_LT = S(G1, rgb(1, 0.8, 0.3, 0.7)), GOLD_DK = S(G2, rgb(0.6, 0.32, 0.03, 0.12));
  b.lathe([0, -0.06, 0], [0, 1, 0], [[0, 0], [0, 0.33], [0.02, 0.43], [0.1, 0.43], [0.12, 0.33], [0.12, 0]], 16,
    (i, j) => (i === 0 || i === 4 ? GOLD_DK : i === 2 ? ((j & 1) ? GOLD_LT : GOLD) : GOLD), null, null);
  const star = (y, dir) => {
    const pts = [];
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * TAU) / 10, r = k & 1 ? 0.12 : 0.29; pts.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
    const apex = [0, y + 0.06 * dir, 0];
    for (let k = 0; k < 10; k++) b.triN(pts[k], pts[(k + 1) % 10], apex, [0, dir, 0], k & 1 ? GOLD : GOLD_LT);
  };
  star(0.061, 1); star(-0.061, -1);
  return b;
}
function buildOneUp() {       // bevelled emerald hexagon badge
  const b = new GB();
  b.lathe([0, -0.08, 0], [0, 1, 0], [[0, 0], [0, 0.4], [0.035, 0.47], [0.125, 0.47], [0.16, 0.4], [0.16, 0]], 6,
    (i, j) => (i === 2 ? FAC((j & 1) ? 1 : 0.8, 0.55) : i === 4 ? FAC(0.9, 0.9) : i === 3 ? FAC(0.85, 0.7) : FAC(0.6, 0.4)),
    null, null, { phase: Math.PI / 6 });
  return b;
}

function itemSprite(tex, sx, sy) {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(m); s.scale.set(sx, sy, 1);
  return s;
}
const LETTER_Y = 0.36, LETTER_Z = 0.1;   // hover over the body, nudged toward the camera so it stays centred on screen

export function createItem(kind) {
  const g = new THREE.Group(); g.name = 'item:' + kind;
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  const ud = g.userData;
  ud.kind = kind; ud.radius = 0.6; ud.muzzles = [];
  const phase = Math.random() * TAU;
  const halo = itemSprite(haloTex(), 1.55, 1.55);
  halo.material.blending = THREE.AdditiveBlending;
  halo.position.y = -0.25; halo.renderOrder = 3; halo.userData.noShadow = true;
  g.add(halo);
  let letter = null;
  let mat, mesh, spin = () => {};
  let haloK = 0.36;
  ud.debrisColor = new THREE.Color();
  const setHue = (key) => {
    const c = ITEM_COL[key];
    mat.color.set(c.body);
    mat.uEmitTint.value.setRGB(c.glow[0], c.glow[1], c.glow[2]);
    halo.material.color.setRGB(c.halo[0], c.halo[1], c.halo[2]);
    ud.debrisColor.set(key === 'medal' ? '#ffc21a' : c.body);
  };
  switch (kind) {
    case 'P': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.gem', buildGem), mat);
      letter = itemSprite(glyphTex('P'), 0.7, 0.7);
      ud.color = 'red';
      ud.setColor = (c) => { ud.color = c === 'blue' ? 'blue' : 'red'; setHue(ud.color); };
      ud.setColor('red');
      spin = (dt, t) => { mesh.rotation.z = Math.sin(t * 2.4 + phase) * 0.9; mesh.rotation.y += dt * 0.6; };
      break;
    }
    case 'S': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.capsule', buildCapsule), mat);
      const texH = glyphTex('H'), texN = glyphTex('N');
      letter = itemSprite(texH, 0.68, 0.68);
      ud.subKind = 'H';
      ud.setKind = (k) => {
        ud.subKind = k === 'N' ? 'N' : 'H'; setHue(ud.subKind);
        letter.material.map = ud.subKind === 'N' ? texN : texH; // body keeps its green/purple hue
      };
      ud.setKind('H');
      spin = (dt) => { mesh.rotation.x += dt * 3.2; };
      break;
    }
    case 'B': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.bomb', buildBombItem), mat);
      letter = itemSprite(glyphTex('B'), 0.68, 0.68);
      setHue('B');
      spin = (dt, t) => { mesh.rotation.z += dt * 2.2; mesh.rotation.y = Math.sin(t * 1.7 + phase) * 0.35; };
      break;
    }
    case 'medal': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.medal', buildMedal), mat);
      setHue('medal');
      haloK = 0.34;
      halo.scale.setScalar(1.35);
      spin = (dt, t) => { mesh.rotation.z = Math.sin(t * 3 + phase) * 1.0; }; // wobble, never edge-on
      pivot.rotation.x = 0.33;          // face the camera
      break;
    }
    case '1UP': {
      mat = bodyMat(0.5, 0.1);   // contract range: roughness 0.5–0.85, metalness 0.1–0.5
      mesh = new THREE.Mesh(GG('item.oneup', buildOneUp), mat);
      letter = itemSprite(glyphTex('1UP'), 1.04, 0.52);
      setHue('1UP');
      pivot.rotation.x = 0.33;
      spin = (dt, t) => { mesh.rotation.y += dt * 1.4; mesh.rotation.z = Math.sin(t * 2 + phase) * 0.25; };
      break;
    }
    default: throw new Error(`models.createItem: unknown kind "${kind}"`);
  }
  pivot.add(mesh);
  if (letter) {
    letter.material.color.setScalar(0.9);
    letter.position.set(0, LETTER_Y, LETTER_Z); letter.renderOrder = 4; letter.userData.noShadow = true;
    g.add(letter);
  }
  ud.letter = letter;
  ud.halo = halo;
  ud.setFlash = (v) => mat.emissive.setScalar(Math.max(0, Math.min(1, v)) * FLASH_K);
  ud.update = (dt, t) => {
    spin(dt, t);
    const bob = Math.sin(t * 3.4 + phase) * 0.07;
    pivot.position.y = bob;
    if (letter) letter.position.y = LETTER_Y + bob;
    halo.material.opacity = haloK + Math.sin(t * 6 + phase) * 0.1;
    mat.uEmitScale.value = 1 + Math.sin(t * 6 + phase) * 0.18;
  };
  ud.dispose = () => { mat.dispose(); halo.material.dispose(); if (letter) letter.material.dispose(); };
  ud.update(0, 0);
  return g;
}

// =============================================================================
// SHADOWS — soft baked silhouette on one quad per model type
// =============================================================================
const _m4a = new THREE.Matrix4(), _m4b = new THREE.Matrix4(), _v3 = new THREE.Vector3();
function shadowKey(model) {
  const ud = model.userData;
  return ud.kind || model.name || model.uuid;
}
function pristineOf(kind) {
  try {
    if (kind === 'player') return createPlayer();
    if (kind === 'boss') return createBoss();
    if (ENEMY_TYPES.includes(kind)) return createEnemy(kind);
    if (ITEM_KINDS.includes(kind)) return createItem(kind);
  } catch (_) { /* fall back to the model itself */ }
  return null;
}
function bakeShadow(model) {
  model.updateWorldMatrix(true, true);
  _m4a.copy(model.matrixWorld).invert();
  const tris = [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  model.traverse((o) => {
    if (!o.isMesh || o.userData.noShadow) return;
    for (let p = o; p && p !== model; p = p.parent) if (!p.visible) return;
    _m4b.multiplyMatrices(_m4a, o.matrixWorld);
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const count = idx ? idx.count : pos.count;
    const arr = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      _v3.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(_m4b);
      arr[i * 2] = _v3.x; arr[i * 2 + 1] = _v3.z;
      if (_v3.x < x0) x0 = _v3.x; if (_v3.x > x1) x1 = _v3.x;
      if (_v3.z < z0) z0 = _v3.z; if (_v3.z > z1) z1 = _v3.z;
    }
    tris.push(arr);
  });
  if (!tris.length) { x0 = z0 = -0.5; x1 = z1 = 0.5; }
  const size = Math.max(x1 - x0, z1 - z0);
  const margin = Math.max(0.12, size * 0.06);
  x0 -= margin; x1 += margin; z0 -= margin; z1 += margin;
  const ppu = Math.min(64, 256 / Math.max(x1 - x0, z1 - z0));
  const W = Math.max(8, Math.ceil((x1 - x0) * ppu)), H = Math.max(8, Math.ceil((z1 - z0) * ppu));
  x1 = x0 + W / ppu; z1 = z0 + H / ppu;            // quad matches the texel grid exactly
  // Rasterise the projected triangles in JS on a supersampled grid. (Canvas 2D +
  // getImageData was ~10× slower and forces a GPU read-back on phones.)
  const SS = ppu >= 40 ? 3 : 2, SW = W * SS, SH = H * SS, sp = ppu * SS;
  const mask = new Uint8Array(SW * SH);
  for (const arr of tris) {
    for (let i = 0; i < arr.length; i += 6) {
      const ax = (arr[i] - x0) * sp, ay = (arr[i + 1] - z0) * sp;
      const bx = (arr[i + 2] - x0) * sp, by = (arr[i + 3] - z0) * sp;
      const cx = (arr[i + 4] - x0) * sp, cy = (arr[i + 5] - z0) * sp;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-4) continue;          // edge-on (vertical) faces cast no footprint
      const sg = area > 0 ? 1 : -1;
      const mnx = Math.max(0, Math.floor(Math.min(ax, bx, cx))), mxx = Math.min(SW - 1, Math.ceil(Math.max(ax, bx, cx)));
      const mny = Math.max(0, Math.floor(Math.min(ay, by, cy))), mxy = Math.min(SH - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = mny; y <= mxy; y++) {
        const py = y + 0.5;
        for (let x = mnx; x <= mxx; x++) {
          const px = x + 0.5;
          if (sg * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0) continue;
          if (sg * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) < 0) continue;
          if (sg * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) < 0) continue;
          mask[y * SW + x] = 1;
        }
      }
    }
  }
  // box-downsample to coverage, then soften with two separable box-blur passes
  const rad = Math.max(1, Math.round(ppu * 0.05));
  const buf = new Float32Array(W * H), tmp = new Float32Array(W * H);
  const k255 = 255 / (SS * SS);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let j = 0; j < SS; j++) { const row = (y * SS + j) * SW + x * SS; for (let i = 0; i < SS; i++) s += mask[row + i]; }
    buf[y * W + x] = s * k255;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += buf[y * W + xx]; n++; } }
      tmp[y * W + x] = s / n;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } }
      buf[y * W + x] = s / n;
    }
  }
  // RGBA (alphaMap samples .g). DataTexture rows run bottom-up (v=0 ↔ +z), grid rows top-down (z0 first).
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const dst = (H - 1 - y) * W * 4;
    for (let x = 0; x < W; x++) {
      const v = Math.min(255, Math.round(buf[y * W + x])), o = dst + x * 4;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geo.rotateX(-Math.PI / 2);
  geo.translate((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, alphaMap: tex,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  return { geo, mat, tex };
}
/**
 * Flattened dark silhouette of `model` for the ground. One draw call: the
 * silhouette (all shadow-casting meshes projected on XZ) is baked once per
 * model type into a small soft alpha mask on a quad, so overlapping parts never
 * double-darken. All shadows of a type share ONE material. Core positions it on
 * the ground and copies model.rotation.y.
 */
export function createShadow(model) {
  const key = shadowKey(model);
  let s = SHADOW.get(key);
  if (!s) {
    // Bake from a pristine instance of the same kind, so the cached silhouette never
    // depends on the pose of the model passed in (banked, turret yawed, parts destroyed…).
    const ref = pristineOf(model.userData.kind);
    s = bakeShadow(ref || model);
    if (ref && ref.userData.dispose) ref.userData.dispose();
    SHADOW.set(key, s);
  }
  const m = new THREE.Mesh(s.geo, s.mat);
  m.name = 'shadow:' + key;
  m.renderOrder = -1;
  m.userData.noShadow = true;
  return m;
}

// =============================================================================
// housekeeping
// =============================================================================
export function disposeAll() {
  for (const g of GEO.values()) g.dispose();
  for (const t of TEX.values()) t.dispose();
  for (const s of SHADOW.values()) { s.geo.dispose(); s.mat.dispose(); s.tex.dispose(); }
  GEO.clear(); GBS.clear(); TEX.clear(); SHADOW.clear();
}

/** exposed for dev tools / core warm-up */
export const ENEMY_TYPES = ['dart', 'hornet', 'tank', 'turret', 'gunboat', 'carrier', 'bomber', 'crawler'];
export const ITEM_KINDS = ['P', 'S', 'B', 'medal', '1UP'];
export const GROUND_TYPES = ['tank', 'turret', 'gunboat', 'crawler'];

/** mesh / triangle counts of an object (visible drawables only) */
export function modelStats(obj) {
  let meshes = 0, tris = 0, sprites = 0;
  obj.traverseVisible((o) => {
    if (o.isMesh) {
      meshes++;
      const gg = o.geometry;
      tris += (gg.index ? gg.index.count : gg.attributes.position.count) / 3;
    } else if (o.isSprite) { sprites++; tris += 2; }
  });
  return { meshes, sprites, drawCalls: meshes + sprites, tris: Math.round(tris) };
}
