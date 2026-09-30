// fx.js — sprite batching, particles, debris and camera shake.
// Everything that glows (bullets, explosions, trails) is drawn through a few instanced
// "sprite batches" so the whole effect layer costs a handful of draw calls.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural sprite atlas (4 x 4 cells of 128 px; frames 0-9 used, 10-15 free).
// Channel meaning: R = coloured body, G = white-hot core, A = coverage (normal blend).
// Frame space: u = quad x, v = -1 at the quad's +Y edge, i.e. the direction of travel of a
// flat quad rotated with flatRot (ARC's apex points that way).
// ---------------------------------------------------------------------------
export const F = { GLOW: 0, ORB: 1, STREAK: 2, SMOKE: 3, RING: 4, FLARE: 5, FIRE: 6, SHARD: 7, ARC: 8, RETICLE: 9 };
const ATLAS_S = 128, ATLAS_C = 4, ATLAS_R = 4;

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * s(xf) + (c - a) * s(yf) + (a - b - c + d) * s(xf) * s(yf);
}
function fbm(x, y) { return vnoise(x, y) * 0.55 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.15; }
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };

function frameFn(i, u, v) {
  // u, v in [-1, 1]; returns [body, core, alpha]
  const r = Math.hypot(u, v);
  switch (i) {
    case F.GLOW: { const g = Math.exp(-r * r * 4.5); return [g, Math.exp(-r * r * 22) * 0.6, g]; }
    case F.ORB: {
      const body = smooth(1.0, 0.55, r) * 0.9 + Math.exp(-r * r * 6) * 0.35;
      const core = smooth(0.38, 0.2, r);
      return [sat(body), core, sat(body + core)];
    }
    case F.STREAK: {
      const w = Math.exp(-u * u * 18) * smooth(1.0, 0.55, Math.abs(v));
      const c = Math.exp(-u * u * 90) * smooth(0.95, 0.35, Math.abs(v));
      return [w, c, w];
    }
    case F.SMOKE: {
      const n = fbm(u * 2.2 + 7, v * 2.2 + 3);
      const a = sat(smooth(1.0, 0.35, r + (n - 0.5) * 0.55)) * (0.55 + n * 0.45);
      return [0.55 + n * 0.45, 0, a];
    }
    case F.RING: { const d = Math.abs(r - 0.78); const g = Math.exp(-d * d * 260) + Math.exp(-d * d * 30) * 0.25; return [sat(g), Math.exp(-d * d * 900) * 0.7, sat(g)]; }
    case F.FLARE: {
      const star = Math.exp(-Math.abs(u) * 14) * smooth(1, 0, Math.abs(v)) + Math.exp(-Math.abs(v) * 14) * smooth(1, 0, Math.abs(u));
      const g = Math.exp(-r * r * 10);
      return [sat(star * 0.8 + g * 0.6), sat(Math.exp(-r * r * 40)), sat(star + g)];
    }
    case F.FIRE: {
      const n = fbm(u * 3 + 11, v * 3 + 5);
      const shape = smooth(1.0, 0.2, r + (n - 0.5) * 0.7);
      return [sat(shape * (0.6 + n * 0.6)), sat(shape * shape * smooth(0.6, 0.0, r) * 1.2), sat(shape)];
    }
    case F.SHARD: {
      // small diamond / hex medal glint
      const d = Math.abs(u) * 0.85 + Math.abs(v);
      const b = smooth(0.95, 0.75, d);
      return [b, smooth(0.55, 0.2, d), b];
    }
    case F.ARC: {
      // crescent (WAVE): the band inside a leading circle and outside a trailing one, apex at
      // v -0.5 (front), 0.14 thick there, tapering to points at (±0.82, 0); a narrow glow around
      // it and a white-hot leading edge that fades toward the tips
      const d1 = Math.hypot(u, v - 0.4224) - 0.9224; // < 0 inside the leading circle
      const d2 = Math.hypot(u, v - 0.754) - 1.114;   // > 0 outside the trailing circle
      const sd = Math.max(d1, -d2);                  // < 0 inside the crescent
      const span = sat(1 - (u * u) / 0.64);          // 1 at the apex … 0 at the tips
      const body = sd < 0 ? 1 : Math.exp(-sd * sd * 260) * 0.8;
      const halo = Math.exp(-Math.max(sd, 0) * 16) * 0.12 * span;
      const edge = Math.exp(-(d1 + 0.03) * (d1 + 0.03) * 1600) * Math.sqrt(span);
      return [sat(body * (0.45 + 0.55 * Math.sqrt(span)) + halo), sat(edge * (sd < 0.02 ? 1 : 0.3)), sat(body * (0.35 + 0.65 * span) + halo)];
    }
    case F.RETICLE: {
      // lock-on reticle: a thin ring broken into four corner arcs, four short ticks pointing in
      const a = Math.atan2(v, u);
      const d = r - 0.72;
      const arcs = smooth(0.35, 0.6, Math.abs(Math.sin(a * 2)));
      const ring = (Math.exp(-d * d * 2600) + Math.exp(-d * d * 140) * 0.22) * arcs;
      const inTick = (s) => smooth(0.36, 0.42, s) * smooth(0.64, 0.58, s);
      const tick = Math.exp(-v * v * 2200) * inTick(Math.abs(u)) + Math.exp(-u * u * 2200) * inTick(Math.abs(v));
      const dot = Math.exp(-r * r * 900) * 0.8;
      return [sat(ring + tick + dot), sat(Math.exp(-d * d * 9000) * arcs * 0.7 + tick * 0.5), sat(ring + tick + dot)];
    }
    default: return [0, 0, 0];
  }
}

let atlasTexture = null;
function getAtlas() {
  if (atlasTexture) return atlasTexture;
  const S = ATLAS_S, C = ATLAS_C, R = ATLAS_R;
  const cv = document.createElement('canvas');
  cv.width = S * C; cv.height = S * R;
  const g = cv.getContext('2d');
  const img = g.createImageData(cv.width, cv.height); // starts transparent: free cells stay empty
  const used = Object.keys(F).length;
  for (let f = 0; f < used; f++) {
    const ox = (f % C) * S, oy = Math.floor(f / C) * S;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = ((x + 0.5) / S) * 2 - 1, v = ((y + 0.5) / S) * 2 - 1;
        const [b0, c0, a0] = frameFn(f, u, v);
        const w = smooth(1.0, 0.8, Math.hypot(u, v)); // radial window: no straight quad edges
        const b = b0 * w, c = c0 * w, a = a0 * w;
        const k = ((oy + y) * cv.width + ox + x) * 4;
        img.data[k] = Math.round(sat(b) * 255);
        img.data[k + 1] = Math.round(sat(c) * 255);
        img.data[k + 2] = 0;
        img.data[k + 3] = Math.round(sat(a) * 255);
      }
    }
  }
  g.putImageData(img, 0, 0);
  atlasTexture = new THREE.CanvasTexture(cv);
  atlasTexture.colorSpace = THREE.NoColorSpace;
  atlasTexture.premultiplyAlpha = false;
  atlasTexture.generateMipmaps = true;
  atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
  return atlasTexture;
}

// ---------------------------------------------------------------------------
// SpriteBatch: one instanced draw call. Instances are camera-facing billboards or
// quads lying flat on the XZ plane (flat=1), rotated by `rot`.
// ---------------------------------------------------------------------------
const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec2 iScale;
attribute vec4 iColor;
attribute vec4 iMisc; // rot, frame, flat, core
uniform vec2 uGrid;
varying vec2 vUv;
varying vec4 vColor;
varying float vCore;
#include <fog_pars_vertex>
void main() {
  vec2 p = position.xy;
  float c = cos(iMisc.x), s = sin(iMisc.x);
  vec2 q = vec2(p.x * iScale.x, p.y * iScale.y);
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  vec4 mvPosition;
  if (iMisc.z > 0.5) {
    mvPosition = modelViewMatrix * vec4(iPos + vec3(q.x, 0.0, -q.y), 1.0);
  } else {
    mvPosition = modelViewMatrix * vec4(iPos, 1.0);
    mvPosition.xy += q;
  }
  gl_Position = projectionMatrix * mvPosition;
  float f = iMisc.y;
  vec2 cell = vec2(mod(f, uGrid.x), uGrid.y - 1.0 - floor(f / uGrid.x));
  vUv = (uv * (1.0 - 2.0 / 128.0) + 1.0 / 128.0 + cell) / uGrid; // 1-texel inset: no bleeding between cells
  vColor = iColor;
  vCore = iMisc.w;
  #include <fog_vertex>
}`;

const FRAG_ADD = /* glsl */`
uniform sampler2D uMap;
uniform float uCore;
varying vec2 vUv;
varying vec4 vColor;
varying float vCore;
void main() {
  vec4 t = texture2D(uMap, vUv);
  vec3 col = (vColor.rgb * t.r + vec3(t.g) * uCore * vCore * (0.6 + 0.4 * max(vColor.r, max(vColor.g, vColor.b)))) * vColor.a;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const FRAG_NORMAL = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * (0.75 + 0.25 * t.r), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class SpriteBatch {
  constructor(max, { additive = true, depthTest = false, renderOrder = 0, core = 1.4, fog = false } = {}) {
    this.max = max;
    this.count = 0;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.pos = new Float32Array(max * 3);
    this.scale = new Float32Array(max * 2);
    this.color = new Float32Array(max * 4);
    this.misc = new Float32Array(max * 4);
    const mk = (arr, n) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(this.pos, 3); this.aScale = mk(this.scale, 2); this.aColor = mk(this.color, 4); this.aMisc = mk(this.misc, 4);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iScale', this.aScale);
    geo.setAttribute('iColor', this.aColor);
    geo.setAttribute('iMisc', this.aMisc);
    geo.instanceCount = 0;
    this.geo = geo;
    this.attrs = [[this.aPos, 3], [this.aScale, 2], [this.aColor, 4], [this.aMisc, 4]];
    const uniforms = THREE.UniformsUtils.merge([fog ? THREE.UniformsLib.fog : {}, {
      uMap: { value: getAtlas() }, uGrid: { value: new THREE.Vector2(ATLAS_C, ATLAS_R) }, uCore: { value: core },
    }]);
    uniforms.uMap.value = getAtlas();
    this.mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: additive ? FRAG_ADD : FRAG_NORMAL,
      transparent: true, depthWrite: false, depthTest,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: !additive && fog,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }
  begin() { this.count = 0; }
  push(x, y, z, sx, sy, rot, frame, flat, r, g, b, a, core = 1) {
    if (this.count >= this.max) return;
    const i = this.count++;
    let k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    k = i * 4; this.misc[k] = rot; this.misc[k + 1] = frame; this.misc[k + 2] = flat; this.misc[k + 3] = core;
    k = i * 2; this.scale[k] = sx; this.scale[k + 1] = sy;
    k = i * 4; this.color[k] = r; this.color[k + 1] = g; this.color[k + 2] = b; this.color[k + 3] = a;
  }
  end() {
    const n = this.count;
    this.geo.instanceCount = n;
    if (n === 0) return;
    for (const [a, size] of this.attrs) {
      a.clearUpdateRanges(); a.addUpdateRange(0, n * size); a.needsUpdate = true;
    }
  }
}

// Rotation for a flat quad whose +Y axis should point along plane velocity (vx, vz).
export function flatRot(vx, vz) { return Math.atan2(-vx, -vz); }

// ---------------------------------------------------------------------------
// Particles (SoA pool). Each particle renders into the additive or normal batch.
// ---------------------------------------------------------------------------
const P_MAX = 2600;
export class Particles {
  constructor() {
    const n = P_MAX;
    this.n = 0;
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.s0 = new Float32Array(n); this.s1 = new Float32Array(n);
    this.stretch = new Float32Array(n);
    this.c0 = new Float32Array(n * 4); this.c1 = new Float32Array(n * 4);
    this.frame = new Uint8Array(n); this.layer = new Uint8Array(n); // 0 add-air, 1 add-ground, 2 smoke
    this.flat = new Uint8Array(n); this.scroll = new Uint8Array(n);
    this.drag = new Float32Array(n); this.grav = new Float32Array(n);
    this.rot = new Float32Array(n); this.vrot = new Float32Array(n);
  }
  clear() { this.n = 0; }
  // o: {x,y,z,vx,vy,vz,life,s0,s1,c0:[r,g,b,a],c1,frame,layer,flat,scroll,drag,grav,rot,vrot,stretch}
  emit(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, frame, layer, opts) {
    if (this.n >= P_MAX) return;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.max[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    const k = i * 4;
    this.c0[k] = c0[0]; this.c0[k + 1] = c0[1]; this.c0[k + 2] = c0[2]; this.c0[k + 3] = c0[3];
    this.c1[k] = c1[0]; this.c1[k + 1] = c1[1]; this.c1[k + 2] = c1[2]; this.c1[k + 3] = c1[3];
    this.frame[i] = frame; this.layer[i] = layer;
    this.flat[i] = opts && opts.flat ? 1 : 0;
    this.scroll[i] = opts && opts.scroll ? 1 : 0;
    this.drag[i] = opts && opts.drag !== undefined ? opts.drag : 2.0;
    this.grav[i] = opts && opts.grav !== undefined ? opts.grav : 0;
    this.rot[i] = opts && opts.rot !== undefined ? opts.rot : Math.random() * 6.283;
    this.vrot[i] = opts && opts.vrot !== undefined ? opts.vrot : 0;
    this.stretch[i] = opts && opts.stretch ? opts.stretch : 0;
  }
  update(dt, groundScroll) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this._kill(i); continue; }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= d; this.vy[i] = this.vy[i] * d - this.grav[i] * dt; this.vz[i] *= d;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt + (this.scroll[i] ? groundScroll * dt : 0);
      this.rot[i] += this.vrot[i] * dt;
      i++;
    }
  }
  _kill(i) {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.z[i] = this.z[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    for (let c = 0; c < 4; c++) { this.c0[i * 4 + c] = this.c0[j * 4 + c]; this.c1[i * 4 + c] = this.c1[j * 4 + c]; }
    this.frame[i] = this.frame[j]; this.layer[i] = this.layer[j]; this.flat[i] = this.flat[j]; this.scroll[i] = this.scroll[j];
    this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j]; this.rot[i] = this.rot[j]; this.vrot[i] = this.vrot[j];
    this.stretch[i] = this.stretch[j];
  }
  draw(addAir, addGround, smoke) {
    for (let i = 0; i < this.n; i++) {
      const t = 1 - this.life[i] / this.max[i];
      const e = t; // linear blend; sizes use ease-out below
      const so = 1 - (1 - t) * (1 - t);
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * so;
      const k = i * 4;
      const r = this.c0[k] + (this.c1[k] - this.c0[k]) * e;
      const g = this.c0[k + 1] + (this.c1[k + 1] - this.c0[k + 1]) * e;
      const b = this.c0[k + 2] + (this.c1[k + 2] - this.c0[k + 2]) * e;
      const a = this.c0[k + 3] + (this.c1[k + 3] - this.c0[k + 3]) * e;
      const layer = this.layer[i];
      const batch = layer === 2 ? smoke : layer === 1 ? addGround : addAir;
      let sx = s, sy = s, rot = this.rot[i], flat = this.flat[i];
      if (this.stretch[i] > 0) {
        const sp = Math.hypot(this.vx[i], this.vz[i]);
        sy = s + sp * this.stretch[i];
        sx = s * 0.35;
        rot = flatRot(this.vx[i], this.vz[i]);
        flat = 1;
      }
      batch.push(this.x[i], this.y[i], this.z[i], sx, sy, rot, this.frame[i], flat, r, g, b, a);
    }
  }
}

// ---------------------------------------------------------------------------
// 3D debris chunks that tumble and fall toward the ground (sells the depth).
// ---------------------------------------------------------------------------
const D_MAX = 220;
export class Debris {
  constructor(scene) {
    const geo = new THREE.TetrahedronGeometry(0.22, 0);
    const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7, metalness: 0.3 });
    this.mesh = new THREE.InstancedMesh(geo, mat, D_MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.n = 0;
    this.p = new Float32Array(D_MAX * 3); this.v = new Float32Array(D_MAX * 3);
    this.axis = new Float32Array(D_MAX * 3); this.ang = new Float32Array(D_MAX); this.spin = new Float32Array(D_MAX);
    this.life = new Float32Array(D_MAX); this.size = new Float32Array(D_MAX);
    this.col = new Float32Array(D_MAX * 3);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
    this._pos = new THREE.Vector3(); this._ax = new THREE.Vector3(); this._c = new THREE.Color();
  }
  clear() { this.n = 0; this.mesh.count = 0; }
  spawn(x, y, z, count, color, power = 1) {
    for (let c = 0; c < count && this.n < D_MAX; c++) {
      const i = this.n++;
      const a = Math.random() * Math.PI * 2, sp = (2 + Math.random() * 6) * power;
      this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
      this.v[i * 3] = Math.cos(a) * sp; this.v[i * 3 + 1] = 3 + Math.random() * 6 * power; this.v[i * 3 + 2] = Math.sin(a) * sp;
      const ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5, l = Math.hypot(ax, ay, az) || 1;
      this.axis[i * 3] = ax / l; this.axis[i * 3 + 1] = ay / l; this.axis[i * 3 + 2] = az / l;
      this.ang[i] = Math.random() * 6; this.spin[i] = (Math.random() * 2 - 1) * 12;
      this.life[i] = 1.6 + Math.random() * 1.0; this.size[i] = (0.5 + Math.random() * 1.1) * Math.min(1.6, 0.6 + power * 0.5);
      const shade = 0.55 + Math.random() * 0.45;
      this.col[i * 3] = color.r * shade; this.col[i * 3 + 1] = color.g * shade; this.col[i * 3 + 2] = color.b * shade;
    }
  }
  update(dt, groundY, groundScroll) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      const k = i * 3;
      if (this.life[i] <= 0 || this.p[k + 1] < groundY - 0.3) {
        const j = --this.n;
        if (i !== j) {
          for (let c = 0; c < 3; c++) { this.p[k + c] = this.p[j * 3 + c]; this.v[k + c] = this.v[j * 3 + c]; this.axis[k + c] = this.axis[j * 3 + c]; this.col[k + c] = this.col[j * 3 + c]; }
          this.ang[i] = this.ang[j]; this.spin[i] = this.spin[j]; this.life[i] = this.life[j]; this.size[i] = this.size[j];
        }
        continue;
      }
      this.v[k + 1] -= 22 * dt;
      const d = 1 - 0.6 * dt;
      this.v[k] *= d; this.v[k + 2] *= d;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += (this.v[k + 2] + groundScroll * 0.3) * dt;
      this.ang[i] += this.spin[i] * dt;
      i++;
    }
    for (let j = 0; j < this.n; j++) {
      const k = j * 3;
      this._ax.set(this.axis[k], this.axis[k + 1], this.axis[k + 2]);
      this._q.setFromAxisAngle(this._ax, this.ang[j]);
      const s = this.size[j] * Math.min(1, this.life[j] * 2);
      this._s.set(s, s, s);
      this._pos.set(this.p[k], this.p[k + 1], this.p[k + 2]);
      this._m.compose(this._pos, this._q, this._s);
      this.mesh.setMatrixAt(j, this._m);
      this._c.setRGB(this.col[k], this.col[k + 1], this.col[k + 2]);
      this.mesh.setColorAt(j, this._c);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// FX facade: owns the batches + particles + debris, and the explosion "recipes".
// ---------------------------------------------------------------------------
const rnd = (a, b) => a + Math.random() * (b - a);
const WHITE_HOT = [2.4, 1.7, 0.9, 1];
const FIRE_A = [1.3, 0.38, 0.07, 1];
const FIRE_B = [0.5, 0.07, 0.02, 0];
const SMOKE_A = [0.10, 0.09, 0.085, 0.9];
const SMOKE_B = [0.09, 0.085, 0.08, 0];
const ROCKET_SMOKE_A = [0.62, 0.64, 0.7, 0.34];
const ROCKET_SMOKE_B = [0.5, 0.5, 0.55, 0];
const rgba = (a, r, g, b, al) => { a[0] = r; a[1] = g; a[2] = b; a[3] = al; return a; };

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.smoke = new SpriteBatch(900, { additive: false, depthTest: true, renderOrder: 2, fog: false });
    this.addGround = new SpriteBatch(1200, { additive: true, depthTest: true, renderOrder: 3, core: 0.7 });
    this.addAir = new SpriteBatch(2400, { additive: true, depthTest: false, renderOrder: 8, core: 0.7 });
    // player beams / waves / rockets (weapons.js): own batch so a screen full of beam segments
    // can never crowd enemy bullets out of `bullets`; drawn under the enemy-bullet underlay so
    // the bullets' dark halos stay readable on top of a plasma beam
    this.beams = new SpriteBatch(900, { additive: true, depthTest: false, renderOrder: 8.5, core: 1.6 });
    this.underlay = new SpriteBatch(900, { additive: false, depthTest: false, renderOrder: 9 });
    this.bullets = new SpriteBatch(1400, { additive: true, depthTest: false, renderOrder: 10, core: 1.6 });
    for (const b of [this.smoke, this.addGround, this.addAir, this.beams, this.underlay, this.bullets]) scene.add(b.mesh);
    this.p = new Particles();
    this.debris = new Debris(scene);
    this.lowQuality = false;
    // scratch colour / option objects for recipes called many times a frame (emit copies them)
    this._c0 = [0, 0, 0, 0]; this._c1 = [0, 0, 0, 0];
    this._o = { drag: 0, vrot: 0 }; this._os = { drag: 6, stretch: 0.04 };
  }
  clear() { this.p.clear(); this.debris.clear(); }
  setQuality(q) { this.lowQuality = q === 'low'; }

  // Begin a frame: clear batches that game code pushes into directly.
  begin() {
    this.smoke.begin(); this.addGround.begin(); this.addAir.begin(); this.beams.begin(); this.underlay.begin(); this.bullets.begin();
  }
  update(dt, groundY, groundScroll) {
    this.p.update(dt, groundScroll);
    this.debris.update(dt, groundY, groundScroll);
  }
  end() {
    this.p.draw(this.addAir, this.addGround, this.smoke);
    this.smoke.end(); this.addGround.end(); this.addAir.end(); this.beams.end(); this.underlay.end(); this.bullets.end();
  }

  // --- recipes -------------------------------------------------------------
  // size: 0.6 small .. 1 medium .. 2 large .. 4 huge. ground: explosion on the ground layer.
  explosion(x, y, z, size = 1, { ground = false, color = null, debris = 0 } = {}) {
    const q = this.lowQuality ? 0.6 : 1;
    const layer = ground ? 1 : 0;
    const scroll = ground;
    const p = this.p;
    // flash
    p.emit(x, y + 0.3, z, 0, 0, 0, 0.13, 1.0 * size, 1.6 * size, WHITE_HOT, [1.6, 0.6, 0.2, 0], F.GLOW, layer, { scroll });
    p.emit(x, y + 0.3, z, 0, 0, 0, 0.18, 0.6 * size, 3.0 * size, [1.3, 0.9, 0.55, 0.8], [0.8, 0.3, 0.1, 0], F.FLARE, layer, { scroll, vrot: 3 });
    // fireballs
    const nf = Math.round((5 + 5 * size) * q);
    for (let i = 0; i < nf; i++) {
      const a = Math.random() * 6.283, sp = rnd(1.0, 4.2) * Math.sqrt(size);
      const life = rnd(0.35, 0.75) * (0.8 + size * 0.2);
      p.emit(x + rnd(-0.3, 0.3) * size, y + rnd(0, 0.6), z + rnd(-0.3, 0.3) * size,
        Math.cos(a) * sp, rnd(0.5, 2.5), Math.sin(a) * sp, life, rnd(0.6, 1.1) * size, rnd(1.6, 2.6) * size,
        FIRE_A, FIRE_B, F.FIRE, layer, { scroll, drag: 3.5, vrot: rnd(-2, 2) });
    }
    // sparks
    const ns = Math.round((6 + 8 * size) * q);
    for (let i = 0; i < ns; i++) {
      const a = Math.random() * 6.283, sp = rnd(6, 16) * (0.7 + size * 0.3);
      p.emit(x, y + 0.2, z, Math.cos(a) * sp, rnd(-1, 3), Math.sin(a) * sp, rnd(0.25, 0.55), 0.22, 0.08,
        [3, 2.2, 1.2, 1], [2, 0.6, 0.1, 0], F.STREAK, layer, { scroll, drag: 4.5, stretch: 0.05 });
    }
    // smoke
    const nm = Math.round((3 + 4 * size) * q);
    for (let i = 0; i < nm; i++) {
      const a = Math.random() * 6.283, sp = rnd(0.5, 2.2) * Math.sqrt(size);
      p.emit(x + rnd(-0.4, 0.4) * size, y - 0.2, z + rnd(-0.4, 0.4) * size, Math.cos(a) * sp, rnd(0.3, 1.2), Math.sin(a) * sp,
        rnd(1.4, 2.4) * (0.8 + size * 0.2), rnd(0.8, 1.2) * size, rnd(2.2, 3.4) * size,
        SMOKE_A, SMOKE_B, F.SMOKE, 2, { scroll: true, drag: 1.5, vrot: rnd(-0.8, 0.8) });
    }
    if (size >= 1.4) {
      p.emit(x, y + 0.1, z, 0, 0, 0, 0.45, 0.6 * size, 5.5 * size, [2.2, 1.4, 0.9, 0.9], [1.0, 0.3, 0.1, 0], F.RING, layer, { scroll, flat: true, rot: 0 });
    }
    if (ground) {
      // scorch mark that scrolls away with the ground
      p.emit(x, y + 0.02, z, 0, 0, 0, 5.5, 1.3 * size, 1.5 * size, [0.03, 0.025, 0.02, 0.75], [0.03, 0.025, 0.02, 0], F.SMOKE, 2, { scroll: true, flat: true, drag: 0 });
    }
    if (debris > 0 && color) this.debris.spawn(x, y, z, Math.round(debris * q), color, size);
  }
  // Short burst when a bullet hits something.
  hitSpark(x, y, z, r = 1.0, g = 0.8, b = 0.4, n = 3) {
    const p = this.p;
    p.emit(x, y, z, 0, 0, 0, 0.08, 0.5, 0.9, [r * 2.4, g * 2.4, b * 2.4, 1], [r, g * 0.5, b * 0.2, 0], F.GLOW, 0, null);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, sp = rnd(5, 11);
      p.emit(x, y, z, Math.cos(a) * sp, 0, Math.sin(a) * sp - 4, rnd(0.12, 0.25), 0.16, 0.05,
        [r * 3, g * 3, b * 3, 1], [r, g * 0.4, 0, 0], F.STREAK, 0, { drag: 6, stretch: 0.04 });
    }
  }
  armorSpark(x, y, z) {
    const p = this.p;
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * 6.283, sp = rnd(6, 12);
      p.emit(x, y, z, Math.cos(a) * sp, 0, Math.sin(a) * sp - 3, rnd(0.1, 0.2), 0.14, 0.04, [2.4, 2.6, 3, 1], [0.4, 0.5, 1, 0], F.STREAK, 0, { drag: 6, stretch: 0.04 });
    }
  }
  muzzle(x, z, r, g, b, s = 0.7) {
    this.p.emit(x, 0.05, z, 0, 0, -6, 0.05, s, s * 1.4, [r, g, b, 1], [r, g, b, 0], F.FLARE, 0, { rot: Math.random() * 6, drag: 0 });
  }
  shockwave(x, y, z, size, color = [2, 1.6, 1.2, 1], life = 0.6) {
    this.p.emit(x, y, z, 0, 0, 0, life, 0.5, size, color, [color[0] * 0.3, color[1] * 0.3, color[2] * 0.3, 0], F.RING, 0, { flat: true, rot: 0, drag: 0 });
  }
  sparkle(x, z, r, g, b, s = 0.6, life = 0.35) {
    this.p.emit(x, 0.1, z, 0, 0, -1.5, life, s, s * 0.2, [r, g, b, 1], [r, g, b, 0], F.FLARE, 0, { vrot: 4, drag: 0 });
  }
  trail(x, y, z, r, g, b, a = 0.6, s = 0.35, life = 0.35) {
    this.p.emit(x, y, z, rnd(-0.3, 0.3), 0, rnd(0.5, 1.5), life, s, s * 2.2, [r, g, b, a], [r * 0.3, g * 0.3, b * 0.3, 0], F.GLOW, 0, { drag: 1 });
  }
  missileTrail(x, z, r, g, b) {
    this.p.emit(x, 0.02, z, rnd(-0.2, 0.2), 0, rnd(0.3, 0.8), 0.42, 0.5, 1.15, [0.6, 0.6, 0.66, 0.42], [0.45, 0.45, 0.5, 0], F.SMOKE, 2, { drag: 1.5, vrot: rnd(-2, 2) });
    this.p.emit(x, 0.05, z, 0, 0, 0, 0.14, 0.42, 0.18, [r, g, b, 0.9], [r * 0.4, g * 0.4, b * 0.4, 0], F.GLOW, 0, { drag: 0 });
  }
  // MULTI rocket: a thinner, shorter smoke thread than the missiles' plus an exhaust spark
  // (emitted many times a second: colours go through scratch arrays, emit() copies them)
  rocketTrail(x, z, r, g, b) {
    const p = this.p, o = this._o;
    o.drag = 1.5; o.vrot = rnd(-2, 2);
    p.emit(x, 0.02, z, rnd(-0.15, 0.15), 0, rnd(0.2, 0.6), 0.3, 0.3, 0.72, ROCKET_SMOKE_A, ROCKET_SMOKE_B, F.SMOKE, 2, o);
    o.drag = 0; o.vrot = 0;
    p.emit(x, 0.05, z, 0, 0, 0, 0.1, 0.34, 0.12, rgba(this._c0, r, g, b, 0.9), rgba(this._c1, r * 0.4, g * 0.4, b * 0.4, 0), F.GLOW, 0, o);
  }
  // Small impact pop (rockets, waves): flash, a short flare and a few sparks — no smoke or debris.
  pop(x, y, z, s, r, g, b) {
    const p = this.p, o = this._o, c0 = this._c0, c1 = this._c1;
    o.drag = 0; o.vrot = 5;
    p.emit(x, y, z, 0, 0, 0, 0.1, 0.6 * s, 1.5 * s, rgba(c0, r * 2.2, g * 2.2, b * 2.2, 1), rgba(c1, r, g * 0.5, b * 0.3, 0), F.GLOW, 0, o);
    p.emit(x, y, z, 0, 0, 0, 0.14, 0.5 * s, 1.8 * s, rgba(c0, 1.6, 1.2, 0.8, 0.8), rgba(c1, r * 0.5, g * 0.3, b * 0.2, 0), F.FLARE, 0, o);
    const n = this.lowQuality ? 2 : 4;
    rgba(c0, r * 3, g * 3, b * 3, 1); rgba(c1, r, g * 0.4, 0, 0);
    const os = this._os;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, sp = rnd(5, 12);
      p.emit(x, y, z, Math.cos(a) * sp, 0, Math.sin(a) * sp - 3, rnd(0.12, 0.26), 0.16, 0.05, c0, c1, F.STREAK, 0, os);
    }
  }
  smokePuff(x, y, z, s = 0.5, life = 0.7) {
    this.p.emit(x, y, z, rnd(-0.4, 0.4), 0.3, rnd(0.8, 1.6), life, s, s * 2.6, [0.3, 0.3, 0.32, 0.45], [0.2, 0.2, 0.2, 0], F.SMOKE, 2, { drag: 1, vrot: rnd(-1, 1) });
  }
  splash(x, y, z, size = 2) {
    const p = this.p;
    const k = Math.min(size, 3.5);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.283, sp = rnd(1, 5) * size * 0.5;
      const s1 = rnd(1.4, 2.2) * k * 0.5;
      p.emit(x + Math.cos(a) * size * 0.4, y + 0.4 * s1, z + Math.sin(a) * size * 0.4, Math.cos(a) * sp, rnd(4, 11), Math.sin(a) * sp,
        rnd(0.6, 1.0), rnd(0.5, 1.0) * k * 0.5, s1, [0.85, 0.92, 1.0, 0.5], [0.8, 0.9, 1, 0], F.SMOKE, 2,
        { scroll: true, grav: 14, drag: 0.6 });
    }
    p.emit(x, y + 0.05, z, 0, 0, 0, 1.4, size, size * 5, [1.2, 1.4, 1.6, 0.8], [0.4, 0.5, 0.6, 0], F.RING, 1, { flat: true, rot: 0, scroll: true, drag: 0 });
  }
}

// ---------------------------------------------------------------------------
// Trauma-based screen shake (Squirrel Eiserloh style).
// ---------------------------------------------------------------------------
export class Shake {
  constructor() { this.trauma = 0; this.t = 0; this.enabled = true; this.x = 0; this.y = 0; this.z = 0; }
  add(v) { this.trauma = Math.min(1, this.trauma + v); }
  update(dt) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.enabled ? this.trauma * this.trauma : 0;
    const t = this.t * 38;
    this.x = s * 0.9 * (Math.sin(t * 1.13) * 0.6 + Math.sin(t * 2.71 + 1.3) * 0.4);
    this.y = s * 0.5 * (Math.sin(t * 1.71 + 2.1) * 0.6 + Math.sin(t * 3.07) * 0.4);
    this.z = s * 0.9 * (Math.sin(t * 1.37 + 4.2) * 0.6 + Math.sin(t * 2.33 + 0.7) * 0.4);
  }
}
