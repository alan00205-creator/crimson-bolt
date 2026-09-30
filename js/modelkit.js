// =============================================================================
// CRIMSON BOLT (赤電) — model toolkit
// -----------------------------------------------------------------------------
// The shared building blocks of every procedural model: the GB triangle-soup
// builder and its primitives, the wreck generator, the emissive material, the
// geometry / texture caches, the palettes and the small assembly helpers.
// models.js (the registry + the stage-1 models) and the extension files
// (models_ships.js, models_s2.js, models_s3.js) all build from here, so there is
// no import cycle and every file shares ONE set of caches.
//
// House style (every model follows it):
//   * every factory returns a new THREE.Group, nose/front toward −z, up +y;
//     air units are centred on the origin, ground units have their base at y=0
//   * geometry is built once per cache key (G / GG) and shared; materials are
//     created per instance (bodyMat) so every instance can flash on its own
//   * static sub-parts are merged into one GB: per-face vertex colours ("panel
//     lines" are colour bands) + a per-vertex HDR `emit` attribute, so glowing
//     eyes / engines / energy lines live in the SAME mesh as the hull that
//     carries them. Separate meshes only for animated, destructible or additive
//     pieces — that keeps every model at 1–4 draw calls.
//   * glow values are > 1.0 linear (EM table, GL()) so the bloom pass catches
//     them; albedos stay under the bloom threshold; wreck embers stay ≤ 1
//   * roughness 0.5–0.85, metalness 0.1–0.5
//   * mirrorX convention: build centre-line parts first, record `const f0 = b.n`,
//     build the +x side, then `b.mirrorX(f0)`; whole meshes mirror with scale.x = −1
//
// Rules for extension files:
//   * cache keys are GLOBAL and first-build-wins: name every key
//     'ext:<file>:<name>' (e.g. 'ext:ships:gale', 'ext:s2:behemoth.hull',
//     'ext:s2:behemoth.turret.wreck') so nothing collides with the stage-1 keys
//   * reuse bodyMat / additiveMat: all EmitMaterial instances share one GPU
//     program, so a new model adds no shader compile. Any other material kind
//     (new onBeforeCompile, RGBA vertex colours, a MeshBasic variant) is a new
//     program and must be on a pooled mesh so main.js precompile() sees it
//   * never import models.js from here or from an extension file (cycle)
// =============================================================================
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// ----------------------------------------------------------------- colours ---
const _col = new THREE.Color();
/** sRGB hex → linear rgb triple (optionally scaled) */
export function lin(hex, k = 1) { _col.set(hex); return [_col.r * k, _col.g * k, _col.b * k]; }
export function rgb(r, g, b, k = 1) { return [r * k, g * k, b * k]; }
export const Z3 = [0, 0, 0];
/** a face style: albedo + HDR emission */
export function S(c, e = Z3) { return { c, e }; }
export function lit(hex, k = 1) { return S(lin(hex, k)); }
/** glowing face: albedo is a dim copy of the hue, emission carries the light */
export function GL(e, k = 0.35) {
  const m = Math.max(e[0], e[1], e[2]) || 1;
  return S([Math.min(1, (e[0] / m) * k), Math.min(1, (e[1] / m) * k), Math.min(1, (e[2] / m) * k)], e);
}
export function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// HDR emission colours (linear). > 1 so bloom (threshold ≈ 0.85) catches them.
export const EM = {
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
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
export function centroid(pts) {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
  const n = pts.length; return [x / n, y / n, z / n];
}
export function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
/** build-time matrix helper: translate + euler(xyz) + uniform/vec scale */
export function M(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  const sv = Array.isArray(s) ? new THREE.Vector3(s[0], s[1], s[2]) : new THREE.Vector3(s, s, s);
  return new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), sv);
}

// =============================================================================
// GB — tiny geometry builder: non-indexed triangle soup with per-face colours.
// Every primitive orients its faces outward automatically (per-face test
// against a reference point / direction), so winding bugs can't cause holes.
// =============================================================================
export class GB {
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
export function foil({ x, y = 0, zl, zt, t, tb = 0.5 }) {
  const c = zt - zl;
  return [[x, y, zl], [x, y + t * 0.55, zl + 0.16 * c], [x, y + t, zl + 0.42 * c], [x, y + t * 0.5, zl + 0.78 * c], [x, y, zt], [x, y - t * tb, zl + 0.45 * c]];
}

/**
 * Wreck generator: keeps the triangles where keep(cx,cy,cz) ≥ 0, crumples
 * vertices (position-hashed so the shell stays closed), scorches the albedo,
 * adds smouldering embers and jagged torn-metal shards along the cut band.
 */
export function wreckOf(src, opt) {
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
export class EmitMaterial extends THREE.MeshStandardMaterial {
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
export function bodyMat(rough = 0.6, metal = 0.25) {
  return new EmitMaterial({ vertexColors: true, flatShading: true, roughness: rough, metalness: metal });
}
export function additiveMat(opts = {}) {
  return new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, ...opts,
  });
}
export const FLASH_K = 0.62;   // emissive white at v=1: reads as a white-hot hit without turning big models into bloom blobs
export function flashFn(mats) {
  return (v) => {
    const f = Math.max(0, Math.min(1, v)) * FLASH_K;
    for (let i = 0; i < mats.length; i++) mats[i].emissive.setScalar(f);
  };
}

// =============================================================================
// Caches
// =============================================================================
export const GEO = new Map();
export const TEX = new Map();
export function G(key, fn) {
  let g = GEO.get(key);
  if (!g) { g = fn(); GEO.set(key, g); }
  return g;
}
/** like G() but fn returns a GB; also caches the GB for wreck derivation */
export const GBS = new Map();
export function GG(key, fn) {
  let g = GEO.get(key);
  if (!g) { const b = fn(); GBS.set(key, b); g = b.build(); GEO.set(key, g); }
  return g;
}
export function gbOf(key, fn) { GG(key, fn); return GBS.get(key); }

/** wreck geometry of a cached GB: G(key + '.wreck') = wreckOf(GG(key, build)'s GB, opts) */
export function wreckGeo(key, build, keep) {
  return G(key + '.wreck', () => wreckOf(gbOf(key, build), keep).build());
}

// =============================================================================
// Palettes
// =============================================================================
export const PL = { // player — albedos capped so sun-lit faces stay under the bloom threshold
  crimson: lit('#b0111b'), crimsonLt: lit('#cf222b'), crimsonDk: lit('#5e0810'), crimsonMd: lit('#870c15'),
  white: lit('#dde2e8'), steel: lit('#96a0ac'), steelDk: lit('#515964'),
  belly: lit('#59616c'), bellyDk: lit('#3a4048'), gunDk: lit('#202429'), black: lit('#0b0d10'),
  radome: lit('#2a2f36'), nozzle: lit('#353a42'),
  glass: S(lin('#119bd8'), rgb(0.01, 0.1, 0.19)), glassLt: S(lin('#74d4fb'), rgb(0.03, 0.22, 0.32)),
  intake: lit('#0a0b0e'),
};
export const EN = { // generic enemy palette
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
export const BO = { // boss — blackened steel; bright trims carry the silhouette on a dark dusk sea
  steel: lit('#2e323a'), steelDk: lit('#1f2228'), steelXDk: lit('#131519'),
  plate: lit('#393e48'), panel: lit('#4a505c'), trim: lit('#8a94a6'), trimLt: lit('#b3bcca'),
  hazard: lit('#8e1a2d'), black: lit('#0c0d10'),
};

// =============================================================================
// Paint schemes (hangar liveries)
// -----------------------------------------------------------------------------
// A paint is a RECOLOUR of an aircraft's cached body GB: same triangles in the
// same order (same silhouette, same shadow, same budget), new face styles. The
// factory scheme ('std') never goes through here, so it stays byte-identical.
// Faces are matched to the palette role they were built with by exact colour
// (+ emission), so a paint is plain data: { role: newStyle | fn }. Cache every
// painted body under its own key: GG(key + '.' + paint, () => repaint(…)).
// =============================================================================
const styleKey = (C, E, i) => C[i] + ',' + C[i + 1] + ',' + C[i + 2] + '|' + E[i] + ',' + E[i + 1] + ',' + E[i + 2];
/**
 * A recoloured copy of `src` (a GB). pal = the palette src was built with ({ role: style }, add any inline
 * styles the builder used, e.g. { hot: GL(EM.engineHot, 0.7) }); map = { role: style | fn(st, c, n, t) }:
 * st is the face's current style { c, e }, c its centroid [x, y, z], n its unit normal, t its triangle
 * index; fn returns a style, or null to keep the face. '*' catches every face whose role has no entry
 * (and colours not in pal). Unmapped faces keep their style. (st / c / n are reused: copy what you keep.)
 */
export function repaint(src, pal, map) {
  const role = new Map();
  for (const [k, s] of Object.entries(pal)) {
    const key = s.c.join(',') + '|' + s.e.join(',');    // same text as styleKey (numbers print the same)
    if (!role.has(key)) role.set(key, k);
  }
  const out = new GB();
  out.p = src.p.slice(); out.c = src.c.slice(); out.e = src.e.slice();
  const P = src.p, C = src.c, E = src.e, st = { c: [0, 0, 0], e: [0, 0, 0] }, cen = [0, 0, 0], nor = [0, 0, 0];
  for (let t = 0; t < src.n; t++) {
    const i = t * 9;
    const r = role.get(styleKey(C, E, i));
    let m = r !== undefined && Object.prototype.hasOwnProperty.call(map, r) ? map[r] : map['*'];
    if (!m) continue;
    if (typeof m === 'function') {
      st.c[0] = C[i]; st.c[1] = C[i + 1]; st.c[2] = C[i + 2]; st.e[0] = E[i]; st.e[1] = E[i + 1]; st.e[2] = E[i + 2];
      cen[0] = (P[i] + P[i + 3] + P[i + 6]) / 3; cen[1] = (P[i + 1] + P[i + 4] + P[i + 7]) / 3; cen[2] = (P[i + 2] + P[i + 5] + P[i + 8]) / 3;
      const ux = P[i + 3] - P[i], uy = P[i + 4] - P[i + 1], uz = P[i + 5] - P[i + 2];
      const vx = P[i + 6] - P[i], vy = P[i + 7] - P[i + 1], vz = P[i + 8] - P[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
      nor[0] = nx / l; nor[1] = ny / l; nor[2] = nz / l;
      m = m(st, cen, nor, t);
      if (!m) continue;
    }
    for (let k = 0; k < 9; k += 3) {
      out.c[i + k] = m.c[0]; out.c[i + k + 1] = m.c[1]; out.c[i + k + 2] = m.c[2];
      out.e[i + k] = m.e[0]; out.e[i + k + 1] = m.e[1]; out.e[i + k + 2] = m.e[2];
    }
  }
  return out;
}
/** relative luminance of a linear rgb triple */
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** peak of a style's emission (glowing faces are ≳ 1, tinted glass ≈ 0.1–0.3, plain paint 0) */
export const glowOf = (st) => Math.max(st.e[0], st.e[1], st.e[2]);
/**
 * Luminance ramp: fn(st) → a style whose colour follows the face's original brightness along
 * stops [[luminance, hex], …] (ascending), so a scheme keeps the model's light / dark panel pattern.
 * Styles are cached per stop segment and quantised to 16 steps (few distinct colours, no banding noise).
 */
export function ramp(stops) {
  const L = stops.map(([l]) => l), K = stops.map(([, h]) => lin(h)), cache = new Map();
  return (st) => {
    const l = lum(st.c);
    let k = 0;
    while (k < L.length - 2 && l > L[k + 1]) k++;
    const u = Math.max(0, Math.min(1, (l - L[k]) / ((L[k + 1] - L[k]) || 1)));
    const q = k * 16 + Math.round(u * 15);
    let s = cache.get(q);
    if (!s) { s = S(mix3(K[k], K[k + 1], Math.round(u * 15) / 15)); cache.set(q, s); }
    return s;
  };
}
/** a glowing face re-tinted to the HDR hue `e` at its peak brightness × gain (albedo k as in GL). Saturated
 *  reds want gain < 1: ACES pushes bright reds toward peach */
export function retint(st, e, k = 0.4, gain = 1) {
  const g = glowOf(st) * gain, m = Math.max(e[0], e[1], e[2]) || 1;
  return GL([(e[0] / m) * g, (e[1] / m) * g, (e[2] / m) * g], k);
}
/** smooth 2D value noise in [0, 1] (build-time only: camouflage blotches, weathering) */
export function noise2(x, z, seed = 0) {
  const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const h = (a, b) => hash3(a + seed * 17.3, b, seed * 3.1);
  const a = h(x0, z0), b = h(x0 + 1, z0), c = h(x0, z0 + 1), d = h(x0 + 1, z0 + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * 黃金 GOLD — shared by every aircraft. The game has no environment map, so a metal would render dark:
 * the "mirror" is baked instead. Each face keeps the model's light / dark panel pattern (a luminance ramp
 * from deep bronze to pale gold) and is lit by a fake reflection of a sky / horizon / ground gradient
 * picked by its normal (upward facets catch a bright sky, flanks a glint at the horizon, the belly the
 * dark ground), plus a faint warm self-glow so the shadow side never goes brown. Accent lines glow.
 */
const GOLD_RAMP = [[0, '#3a2206'], [0.012, '#6a430c'], [0.05, '#a8741a'], [0.16, '#d59f2c'], [0.4, '#e9bd4a'], [0.75, '#f5d676']];
const goldCache = new Map();
export const GOLD = {
  glass: S(lin('#4a2a04'), rgb(0.12, 0.06, 0.0)), glassLt: S(lin('#f0b850'), rgb(0.34, 0.2, 0.04)),
  glow: rgb(1.0, 0.72, 0.32, 3.0),                      // retint target for glowing edges / lights
  line: GL(rgb(1.0, 0.56, 0.14, 0.72), 0.52),          // warm glowing accent line (bright, but no white-out)
  hot: GL(rgb(1.0, 0.84, 0.55, 4.2), 0.7),             // nozzle cores
  rough: 0.3, metal: 0.3,
  debris: '#e2b54a',
  trail: [2.8, 1.75, 0.55],                             // warm exhaust sprite
  /** '*' mapper: glows → warm gold at the same brightness, faint self-lit faces → amber glass, the rest → mirror gold */
  face: (st, c, n) => {
    const g = glowOf(st);
    if (g >= 0.45) return retint(st, GOLD.glow, 0.5, 0.75);
    if (g > 0) return GOLD.glass;
    return GOLD.mirror(lum(st.c), n);
  },
  /** mirror gold for a face of original luminance l and normal n (styles cached on a coarse grid) */
  mirror(l, n) {
    // view from above and a little behind (the game camera); reflect it about the face normal
    const vy = -0.94, vz = -0.34, d = n[1] * vy + n[2] * vz, ry = vy - 2 * d * n[1];
    // sky (bright) above, a hot glint band at the horizon, dark ground below; faces turned away from the
    // camera (the belly, seen only in a bank) reflect the ground
    const env = d > 0 ? 0.6 : ry > 0.12 ? 1.0 + 0.12 * (1 - ry) : ry > -0.12 ? 1.28 : 0.6 + 0.2 * (1 + ry);
    let k = 0; while (k < GOLD_RAMP.length - 2 && l > GOLD_RAMP[k + 1][0]) k++;
    const u = Math.round(Math.max(0, Math.min(1, (l - GOLD_RAMP[k][0]) / (GOLD_RAMP[k + 1][0] - GOLD_RAMP[k][0]))) * 7) / 7;
    const e = Math.round(env * 10) / 10, key = k * 8 + u * 7 + e * 1000;
    let s = goldCache.get(key);
    if (!s) {
      const base = mix3(lin(GOLD_RAMP[k][1]), lin(GOLD_RAMP[k + 1][1]), u);
      const c = [Math.min(0.9, base[0] * e), Math.min(0.9, base[1] * e), Math.min(0.9, base[2] * e)];
      s = S(c, [base[0] * 0.07, base[1] * 0.06, base[2] * 0.04]);
      goldCache.set(key, s);
    }
    return s;
  },
};
/** the painted body of a paint entry pt ({ map }) of the model cached under `key` (built by `build` with `pal`) */
export function paintedBody(key, build, pal, paint, pt) {
  return GG(key + '.paint.' + paint, () => repaint(gbOf(key, build), pal, pt.map));
}
/** 黃金 exhaust: a golden sheath around a white-hot core (same shape as FLAME_JET) */
export const FLAME_GOLD = [
  { r: 0.066, len: 0.62, base: rgb(1.0, 0.7, 0.22, 1.6), tip: rgb(0.55, 0.25, 0.0, 0.0), sides: 7 },
  { r: 0.04, len: 0.36, base: rgb(1.0, 0.93, 0.72, 2.6), tip: rgb(1.0, 0.62, 0.18, 0.2), sides: 6 },
];
/** retint a flame preset: every cone's base / tip colour mapped by fn(rgb) → rgb */
export function flameTint(cones, fn) { return cones.map((c) => ({ ...c, base: fn(c.base), tip: fn(c.tip) })); }
/** a flame preset with the cone shapes of `shape` and the colours of `colours` (cone by cone, the last one repeats) */
export function flameRecolour(shape, colours) {
  return shape.map((c, i) => { const k = colours[Math.min(i, colours.length - 1)]; return { ...c, base: k.base, tip: k.tip }; });
}

// =============================================================================
// Engine flames (additive cones, one geometry per nozzle layout)
// =============================================================================
/** CRIMSON BOLT jet flame: hot orange sheath + white-hot core */
export const FLAME_JET = [
  { r: 0.066, len: 0.62, base: rgb(1.0, 0.42, 0.1, 1.6), tip: rgb(0.5, 0.05, 0.0, 0.0), sides: 7 },
  { r: 0.04, len: 0.36, base: rgb(1.0, 0.85, 0.6, 2.6), tip: rgb(1.0, 0.4, 0.1, 0.2), sides: 6 },
];
/** ARCLIGHT violet plasma flame */
export const FLAME_VIOLET = [
  { r: 0.22, len: 1.1, base: rgb(0.6, 0.2, 1.0, 1.0), tip: rgb(0.3, 0.0, 0.6, 0), sides: 7 },
  { r: 0.12, len: 0.6, base: rgb(1.0, 0.55, 1.0, 1.5), tip: rgb(0.8, 0.2, 1.0, 0.1), sides: 6 },
];
/**
 * Additive flame cones pointing +z from the z = 0 plane, one set per nozzle.
 * nozzles = [[x, y, scale = 1], …]; cones = [{ r, len, base, tip, sides }, …]
 * (base/tip are HDR vertex colours). Use with additiveMat() on a mesh placed at
 * the nozzle exits; cache it: G('ext:ships:gale.flame', () => buildFlame(…)).
 */
export function buildFlame(nozzles, cones = FLAME_JET) {
  const pos = [], col = [];
  const cone = (x, y, r, len, cb, ct, sides) => {
    for (let k = 0; k < sides; k++) {
      const a0 = (TAU * k) / sides, a1 = (TAU * (k + 1)) / sides;
      pos.push(x + Math.cos(a0) * r, y + Math.sin(a0) * r, 0, x + Math.cos(a1) * r, y + Math.sin(a1) * r, 0, x, y, len);
      col.push(...cb, ...cb, ...ct);
    }
  };
  for (const [x, y = 0, s = 1] of nozzles) {
    for (const c of cones) cone(x, y, c.r * s, c.len * s, c.base, c.tip, c.sides);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

// =============================================================================
// Player aircraft assembly
// =============================================================================
/** hitbox marker geometry: octahedron core (r 0.07) + flat ring (0.285–0.31), HDR vertex colours */
export function buildHitbox() {
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
/** the visible hitbox marker every aircraft carries (one shared geometry; the game scales it) */
export function makeHitboxMarker() {
  const hb = new THREE.Mesh(G('player.hitbox', buildHitbox), new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
  // at the collision centre on the plane (it ignores depth, so it never needs lifting above the canopy —
  // a lifted marker would project ~0.1 off the real hitbox under the tilted game camera)
  hb.name = 'hitbox'; hb.renderOrder = 50; hb.userData.noShadow = true;
  return hb;
}

/**
 * Standard player-aircraft assembly (the CRIMSON BOLT contract):
 *   group → 'bank' pivot → body mesh + additive flame mesh; hitbox marker on the group
 * o = {
 *   body:  BufferGeometry (GG-cached GB),            rough = 0.5, metal = 0.12,
 *   flame: BufferGeometry (buildFlame, G-cached),    flameZ = 0.9 (local z of the nozzle exits),
 *   name = 'player', kind = 'player' (the registry overwrites it with 'player:<id>'),
 *   radius = 0.3, grazeRadius = 1.0, debris = '#c41c26',
 *   muzzles = [[x, y, z], …] (local gun points), muzzleZ = −1.0 (local z of the gun line),
 *   trail = [[x, z], …] (local engine-exhaust points for the game's engine sprite),
 *   bankDeg = 35 (roll at full bank),
 * }
 * userData: kind, radius, grazeRadius, debrisColor, muzzles, muzzleZ, trail, hitboxMarker,
 *   bankPivot, setBank(b) (b > 0 rolls RIGHT: pass +1 while strafing toward +x), setThrust(0..1),
 *   setFlash(0..1), update(dt, t), dispose().
 * Extra animated sub-meshes: add them to ud.bankPivot after this call and wrap ud.update /
 * ud.setFlash / ud.dispose (keep the total at ≤ 4 draw calls, ≤ 1500 triangles).
 */
export function assemblePlayer(o) {
  const g = new THREE.Group(); g.name = o.name ?? 'player';
  const pivot = new THREE.Group(); pivot.name = 'bank'; g.add(pivot);
  const mat = bodyMat(o.rough ?? 0.5, o.metal ?? 0.12);
  const body = new THREE.Mesh(o.body, mat); body.name = 'body';
  pivot.add(body);
  const flameMat = additiveMat();
  const flame = new THREE.Mesh(o.flame, flameMat); flame.name = 'flame';
  flame.position.set(0, 0, o.flameZ ?? 0.9); flame.userData.noShadow = true; flame.renderOrder = 2;
  pivot.add(flame);
  const hb = makeHitboxMarker();
  g.add(hb);

  const ud = g.userData;
  ud.kind = o.kind ?? 'player';
  ud.radius = o.radius ?? 0.3;
  ud.grazeRadius = o.grazeRadius ?? 1.0;
  ud.debrisColor = new THREE.Color(o.debris ?? '#c41c26');
  ud.muzzles = (o.muzzles ?? [[0, 0, -1.0]]).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  ud.muzzleZ = o.muzzleZ ?? -1.0;
  ud.trail = (o.trail ?? [[0, (o.flameZ ?? 0.9) + 0.05]]).map(([x, z]) => [x, z]);
  ud.hitboxMarker = hb;
  ud.bankPivot = pivot;
  const bankDeg = o.bankDeg ?? 35;
  let thrust = 0.5, bank = 0;
  ud.setBank = (b) => { bank = Math.max(-1, Math.min(1, b)); pivot.rotation.z = -bank * bankDeg * DEG; };
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
export function enemyShell(kind, radius, debris) {
  const g = new THREE.Group(); g.name = kind;
  const pivot = new THREE.Group(); pivot.name = 'pivot'; g.add(pivot);
  g.userData.kind = kind;
  g.userData.radius = radius;
  g.userData.debrisColor = new THREE.Color(debris);
  g.userData.muzzles = [];
  return { g, pivot, ud: g.userData };
}
/** keep group-space muzzles in sync with a y-rotating turret */
export function syncMuzzles(out, local, turret) {
  const c = Math.cos(turret.rotation.y), s = Math.sin(turret.rotation.y), p = turret.position;
  for (let i = 0; i < local.length; i++) {
    const v = local[i];
    out[i].set(p.x + v.x * c + v.z * s, p.y + v.y, p.z - v.x * s + v.z * c);
  }
}
export function hazardStrip(b, x0, z0, x1, z1, y, width, n, dir = [0, 1, 0], cA = EN.orange, cB = EN.black) {
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

export function trackLoft(b, xc, width, height, z0, z1, nSeg, colors) {
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
export const TRACK_COL = { treadA: lit('#44474b'), treadB: lit('#26282b'), side: lit('#2c2e31'), sideB: lit('#3a3c3f'), bottom: lit('#1a1b1d'), end: lit('#34363a') };

/** diagonal hazard stripes draped over the surface of triangles [from,to) */
export function hazardDrape(b, x0, z0, x1, z1, width, n, cA, cB, from, to, lift = 0.005, sub = 2) {
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
export function blockOn(b, from, to, o, sink = 0.04) {
  const y = b.surfaceY(o.x, o.z, from, to);
  return b.block({ ...o, y: (y === null ? 0 : y) - sink });
}

// =============================================================================
// Destructible part helper (boss + crawler)
// =============================================================================
/**
 * Wraps meshes in an Object3D part with radius / setFlash / setDestroyed /
 * muzzles. Destroying swaps each mesh's geometry to its wreck version (no
 * allocation) and gives it a slight sag.
 */
export function makePart(name, radius, entries, muzzles, opts = {}) {
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

/**
 * One-mesh destructible part from a cached GB: intact = GG(key, build), wreck = wreckOf(gb, wreck)
 * cached under key + '.wreck'. wreck = wreckOf options { keep(x, y, z), crumple, scorch, seed, band,
 * dir, shards, shardSize }, or just the keep function. pos = Vector3 | [x, y, z] (part origin in the
 * parent); sag = [rx, y, rz] pose when destroyed. mat defaults to a fresh bodyMat(0.68, 0.2) (each part
 * flashes on its own). Returns the makePart Object3D (userData.radius / muzzles / setFlash / setDestroyed).
 */
export function destructiblePart({ key, build, name, radius, muzzles = [], wreck, sag = null, pos = null, mat = bodyMat(0.68, 0.2) }) {
  const intact = GG(key, build);
  const wreckG = wreckGeo(key, build, typeof wreck === 'function' ? { keep: wreck } : wreck);
  const mesh = new THREE.Mesh(intact, mat);
  const part = makePart(name, radius, [{ mesh, intact, wreck: wreckG, sag }], muzzles);
  if (pos) { if (Array.isArray(pos)) part.position.set(pos[0], pos[1], pos[2]); else part.position.copy(pos); }
  return part;
}

// =============================================================================
// Canvas textures (item glyphs, soft halo)
// =============================================================================
export function glyphTex(text) {
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
export function haloTex() {
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

// =============================================================================
// Budgets
// =============================================================================
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
