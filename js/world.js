// =============================================================================
// world.js — CRIMSON BOLT (赤電) scrolling stage world
//
// Builds and scrolls the terrain under the gameplay plane. Three stage worlds (WORLD_STAGES,
// picked with world.setStage(id) before reset(d)):
//   coastal  ocean (0–300) → coast (300–380) → country (380–640) → city (640–960)
//            → airbase (960–1240) → endless dusk sea (1240–∞)
//   canyon   dunes (0–260) → canyon (260–560) → mesa plateau (560–780) → refinery (780–1000)
//            → desert fortress / airstrip (1000–1240) → endless dry lakebed (1240–∞)
//   skies    a cloud-sea deck, no ground: stratosphere (0–420) → storm band (420–800)
//            → golden high altitude (800–1240) → near-space dusk (1240–∞)
// Stage data lives in one table per stage (see "stage table" at the end); the hot free
// functions read it through the module pointer S, so switching stages allocates nothing.
//
// How it works
//   • The stage is cut into 40-unit chunks along the stage distance d. A chunk is one
//     opaque mesh (ground grid + flat decals + every prop, merged, vertex-coloured and
//     atlas-mapped) plus one translucent mesh with its drop shadows. Five chunk slots
//     are recycled; content is generated deterministically from the chunk index, so
//     reset(d) and recycling always rebuild exactly the same terrain.
//   • A feature at stage position d is drawn at z = distance − d (see CONTRACT.md).
//   • Water is ONE static plane with a ShaderMaterial. Its shape comes from a ring-buffer
//     DataTexture ("mask", 128×512 texels = 80×320 units) that each chunk writes when it
//     is built: terrain height (shore foam, shallows), wake foam and "calm water". The waves
//     are a directional, sharpened-crest spectrum (3 layers) lit from the sun side, with a
//     narrow sun path of glitter; all frequencies are commensurate with the 256-unit stage
//     wrap and the 1000 s time wrap, so the sea never jumps (see the note above WATER_FRAG).
//   • Low clouds (and their shadows) are an instanced layer at y≈−2 that scrolls ~30%
//     faster than the ground; soft billowed cumulus, self-shadowed toward the sun. Radar
//     dishes and wind-turbine rotors are instanced spinners. Both run on an unbounded clock.
//   • Time of day (sun/hemi colours, fog, water and cloud tint) is keyed on distance.
//     The sun's DIRECTION never changes (core fakes aircraft shadows with a fixed offset);
//     the water glint uses its own "glint direction" so the sun path is on screen.
//   • update() creates no objects: per-frame scalars go into Vector uniforms / typed arrays.
//   • The chunk ahead of the view is built in three slices (ground / props / water mask)
//     on consecutive frames, so no single frame pays for a whole chunk.
//   • Every prop taller than 0.25 is self-checked against the clear zones and the height
//     limit while it is emitted; world.info().violations must stay 0 (dev/world.html shows it).
//
// Rules this module guarantees (see CONTRACT.md):
//   • nothing solid above y = −1.8;  • lanes x∈LANES_X±1 and cross roads (d≡20 mod 40,
//     width 3) are clear of anything taller than 0.25 in land biomes (coastal from d≥330,
//     canyon from d≥260 up to 1240, where the canyon terrain is also kept flat: h = 0);
//   • the mid-boss path is clear the same way (coastal |x| < 4.6, d 570–780, see CRAWLER;
//     canyon |x| < 5.5, d 560–780) and so is the canyon's lakebed boss arena (|x| < 9, d ≥ 1240);
//   • ocean islands keep their land at |x| ≥ 8.2 (contract: > 7; core sails gunboats at ±7),
//     decorative ships keep their hulls at |x| ≥ 8.4;
//   • ≤ 5 generated textures (atlas 512², noise 256², waves 256², mask 128×512, clouds 256²);
//     the sky stage's cloud deck reuses the noise texture.
// =============================================================================
import * as THREE from 'three';

export const GROUND_Y = -6;
// coastal (stage 1) layout; every stage's layout is WORLD_STAGES[id].layout
export const LAYOUT = [
  { biome: 'ocean',   from: 0,    to: 300 },
  { biome: 'coast',   from: 300,  to: 380 },
  { biome: 'country', from: 380,  to: 640 },
  { biome: 'city',    from: 640,  to: 960 },
  { biome: 'base',    from: 960,  to: 1240 },
  { biome: 'sea',     from: 1240, to: Infinity },
];
export const LANES_X = [-5.5, 0, 5.5];
export const CROSS_ROAD_PERIOD = 40;

// -----------------------------------------------------------------------------
// constants
// -----------------------------------------------------------------------------
const CHUNK = 40;
const SLOTS = 5;
const LANE_HALF = 1.0, CROSS_HALF = 1.5;
const COL_SCALE = 1.25, COL_Q = 255 / COL_SCALE;  // vertex colours up to 1.25 fit in a byte
const CLEAR_FROM = 330, CLEAR_TO = 1240;   // lanes / cross roads guaranteed clear here
const TALL = 0.25;                          // "taller than" threshold for the clear zones
const MAX_H = 4.15;                         // nothing above GROUND_Y + 4.15 (= −1.85)
const WATER_REL = -0.08;
const WATER_Y = GROUND_Y + WATER_REL;
const MASK_W = 128, MASK_H = 512, MASK_RES = 0.625, MASK_SPAN = MASK_H * MASK_RES; // 320
const ROWS_PER_CHUNK = CHUNK / MASK_RES;   // 64
const NOISE_SPAN = 256;                     // world period of the detail-noise lookups
const TIME_WRAP = 1000;                     // shader time wraps (all scroll speeds are k/1000)
const CAP_HIGH = 96000, CAP_LOW = 60000;    // vertices per chunk
const SH_CAP = 30000;                        // shadow vertices per chunk
// mid-boss corridor: core's crawler (6×5) spawns at MIDBOSS_AT(590)+~40, sways x = ±3.2 (hull to
// |x| 6.2) and can fight until ground d ≈ 755, then retreats to ≈ 775. Lanes cover |x| ≥ 4.5,
// so clearing |x| < 4.6 over [570, 780] keeps its whole path free of anything tall.
const CRAWLER = { d0: 570, d1: 780, x: 4.6 };

// The current stage world (an entry of WORLD_STAGES, set at the end of the module and by
// World.setStage). Module state like the emitter below: one World per page.
let S = null;

// y layers above the ground for flat decals (relative to GROUND_Y)
const L_BASE = 0.006, L_ROAD = 0.014, L_WALK = 0.02, L_MARK = 0.026, L_SHADOW = 0.046;

// atlas tiles (4×4 grid of 128 px cells; index = row*4 + col, row 0 = top of canvas)
const T_WHITE = 0, T_OFFICE = 1, T_RESID = 2, T_BRICK = 3, T_ROWS = 4, T_CORR = 5, T_ROOF = 6,
  T_GLASS = 7, T_PARK = 8, T_SLAB = 9, T_HELI = 10, T_R36 = 11, T_R18 = 12, T_PITCH = 13,
  T_SHUTTER = 14, T_GRAVEL = 15;

// -----------------------------------------------------------------------------
// small math
// -----------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function sstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
const TAU = Math.PI * 2;

// seeded RNG (mulberry32) — module state so generators need no closures
let _rs = 1;
function srand(s) { _rs = (Math.imul(s | 0, 2654435761) ^ 0x5bd1e995) | 0; rand(); rand(); }
function rand() {
  _rs = (_rs + 0x6D2B79F5) | 0;
  let t = Math.imul(_rs ^ (_rs >>> 15), 1 | _rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rr = (a, b) => a + (b - a) * rand();
const pick = (arr) => arr[(rand() * arr.length) | 0];

// stateless hash / value noise (terrain shape must not depend on generation order)
function hash2(ix, iy) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y) {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.07 + 17.3, y * 2.07 - 9.1) * 0.3 + vnoise(x * 4.3 - 5.2, y * 4.3 + 3.7) * 0.15;
}

// -----------------------------------------------------------------------------
// palette (authored as sRGB hex, stored linear)
// -----------------------------------------------------------------------------
const _c = new THREE.Color();
function C(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }
const P = {
  white: C(0xffffff),
  sand: C(0xb4a17c), sandWet: C(0x8c7f62), sandDry: C(0xc0ad88),
  grassCoast: C(0x6f8150), grass: C(0x647a4a), grassL: C(0x72864f), grassD: C(0x566b40),
  forest: C(0x4a5e3a), dry: C(0x7f7e57), dryL: C(0x8d8b63), mud: C(0x6c6049), jungle: C(0x55733f),
  urban: C(0x837f76), rock: C(0x7a766c), rockD: C(0x5f5c56),
  asphalt: C(0x505357), asphaltD: C(0x45484c), runway: C(0x6f6f6a), dirt: C(0x958667), gravel: C(0x9a8f74),
  walk: C(0x9d9a91), paving: C(0x8e8b83), concrete: C(0x9a978e), concreteD: C(0x7f7c75),
  paint: C(0xd8d5cc), yellow: C(0xc4a042), redPaint: C(0xa04a3c),
  // crops
  cropG: C(0x6d8748), cropY: C(0xa89a5c), cropGold: C(0xb09a5a), plough: C(0x77644a), fallow: C(0x817b52),
  mustard: C(0xa59c52), cabbage: C(0x587244), lavender: C(0x7d7488),
  // trees
  tree1: C(0x5e7a44), tree2: C(0x557040), tree3: C(0x6a8246), pine: C(0x47603c), olive: C(0x6e7a3f),
  autumn: C(0x8a7a3e), palm: C(0x5f7a3c), bush: C(0x4f6a3a),
  // buildings
  wallW: C(0xd8d3c7), wallB: C(0xc9bfae), wallG: C(0xa7a59f), wallBlue: C(0x98a3ad), wallBrick: C(0x9c6f5a),
  wallSand: C(0xc2b08d), wallDark: C(0x6f747b), wallCream: C(0xd6ccb4), wallPink: C(0xc9a69a),
  roofTerra: C(0x9a6452), roofBrown: C(0x7d6250), roofGrey: C(0x7c7f82), roofDark: C(0x5a5d61),
  roofSlate: C(0x66707b), roofGreen: C(0x62725d), roofTar: C(0x6f6c67), roofLight: C(0x9c9a93),
  barn: C(0x8a4c3c), metal: C(0x9ca2a6), metalD: C(0x6f757a), glass: C(0x5c6d7d), glassL: C(0x9fb4c4),
  olive: C(0x6b6f4a), oliveD: C(0x55593c), camo: C(0x6f7050), khaki: C(0x9a8f68),
  // vehicles / ships
  hullDark: C(0x3b4450), hullRed: C(0x7c4038), deckRust: C(0x8a6448), deckGreen: C(0x5b6d5a),
  deckGrey: C(0x8a8e90), shipWhite: C(0xdedbd2), navy: C(0x4c5763),
  cont: [C(0x9a5a44), C(0x4f6d86), C(0x6f8a5a), C(0xb09050), C(0x8a8e92), C(0x7a4a5a), C(0x4d7d7a)],
  car: [C(0xd9d6cf), C(0x9ea3a8), C(0x3d4450), C(0x8a4a44), C(0x4d6480), C(0xb8a58a), C(0x2f3136), C(0x6d7d6a)],
  umbrella: [C(0xb8695e), C(0x6a8aa8), C(0xcdb77a), C(0xe0dcd2), C(0x74a096)],
};

// -----------------------------------------------------------------------------
// biome lookup
// -----------------------------------------------------------------------------
function biomeOf(d) {
  const L = S.layout;
  if (d < L[0].from) return L[0].biome;
  for (let i = 0; i < L.length; i++) if (d >= L[i].from && d < L[i].to) return L[i].biome;
  return L[L.length - 1].biome;
}

// -----------------------------------------------------------------------------
// geography (stateless: terrain must agree across chunk seams)
// -----------------------------------------------------------------------------
const HARBOR_X0 = 7, HARBOR_D1 = 329;          // basin: x > 9, from the shore up to d = 329
const BW = { x0: 22, x1: 40, d0: 298.5, d1: 300.5 }; // breakwater
const RIVER_C = 471;
const BASE_END = 1234;                          // seawall at the end of the airbase
const PONDS = [
  { x: -11.5, d: 430, rx: 2.8, rd: 2.1 },
  { x: 11.8, d: 548, rx: 2.3, rd: 2.9 },
  { x: -12.5, d: 603, rx: 2.0, rd: 1.7 },
  { x: 14.2, d: 750.5, rx: 4.2, rd: 3.0 },       // city park lake
];
const PARK = { x0: 7.3, x1: 21.5, d0: 721.7, d1: 758.3 };

function shoreD(x) {
  let s = 307.5 + 1.6 * Math.sin(x * 0.23 + 0.7) + 1.1 * Math.sin(x * 0.61 + 2.1);
  s -= 9 * sstep(-8.5, -15, x);                 // rocky headland on the left
  return s;
}
function riverD(x) { return RIVER_C + 3.0 * Math.sin(x * 0.14 + 0.4) + 1.1 * Math.sin(x * 0.37 + 1.3); }
function forestF(x, d) { return fbm(x * 0.075 + 11.3, d * 0.045 - 3.7); }
function crossDist(d) { const m = ((d % CHUNK) + CHUNK) % CHUNK; return Math.abs(m - 20); }

// islands in the open ocean. Land always stays at |x| ≥ ISL_X: the contract allows islands only
// at |x| > 7, and core sails gunboats (1.6 wide) along x = ±7, so keep a margin beyond 7.8.
// Shapes are ellipses (sx across, sd along the flight direction) with a wobbly outline; land
// reaches at most ~1.22·R·s from the centre (q < 0.98 at the widest wobble).
const ISL = [];
const ISL_X = 8.2;
(function genIslands() {
  // each flank of each chunk is filled with a run of islands and islets separated by channels,
  // their centre-facing shores just outside ISL_X so the edges of the screen read as archipelago
  srand(9107);
  for (let k = -2; k <= 6; k++) {
    const d0 = k * CHUNK;
    for (let side = -1; side <= 1; side += 2) {
      let dc = d0 + rr(0, 4);
      while (dc < d0 + CHUNK) {
        const kind = rand();
        const big = kind < 0.28, mid = !big && kind < 0.68;
        const R = big ? rr(4.2, 5.6) : mid ? rr(2.6, 3.6) : rr(1.3, 2.1);
        const sx = rr(0.8, 1.0), sd = big ? rr(1.0, 1.3) : rr(1.0, 1.5);
        const m = R * sd * 1.25 + 0.3;                   // half-extent along d incl. the reef slope
        const d = dc + m;
        if (d + m > d0 + CHUNK || d > 262) break;
        if (rand() < 0.2) { dc += rr(4, 9); continue; } // an open stretch
        const x = side * (ISL_X + 1.22 * R * sx + rr(0.05, big ? 0.5 : 0.9));
        ISL.push({ x, d, R, sx, sd, top: rr(0.5, big ? 1.35 : mid ? 0.95 : 0.55), p1: rr(0, TAU), p2: rr(0, TAU), k, big, mid,
          house: mid && rand() < 0.45, light: big && rand() < 0.5, village: big && rand() < 0.65 });
        dc = d + m + rr(0.5, 4);
      }
    }
  }
})();

function seaFloor(x, d) {
  let h = -2.6 + 1.3 * sstep(225, 305, d);        // shoaling toward the coast
  // coral shoals: always under water; only the ones off the flight lanes come up to the surf
  const r = vnoise(x * 0.11 + 3.1, d * 0.11 - 7.7) * 0.7 + vnoise(x * 0.27 - 4.4, d * 0.27 + 1.9) * 0.3;
  if (r > 0.62) {
    const top = -1.0 + 0.42 * sstep(6.5, 9.5, Math.abs(x));
    h = Math.max(h, -2.6 + (top + 2.6) * sstep(0.62, 0.8, r));
  }
  return h;
}
function islandRho(I, x, d) {
  const dx = (x - I.x) / I.sx, dd = (d - I.d) / I.sd;
  const a = Math.atan2(dd, dx);
  return Math.sqrt(dx * dx + dd * dd) / (I.R * (1 + 0.16 * Math.sin(3 * a + I.p1) + 0.09 * Math.sin(5 * a + I.p2)));
}
function islandH(I, x, d) {
  const q = islandRho(I, x, d);
  if (q > 1.9) return -9;
  let h = 0.12 - Math.max(0, q - 0.93) * 4.2;
  if (q < 0.93) h += I.top * sstep(0.9, 0.35, q) * (0.7 + 0.6 * vnoise(x * 0.45 + I.p1, d * 0.45));
  return h;
}
function oceanH(x, d) {
  let h = seaFloor(x, d);
  for (let i = 0; i < ISL.length; i++) {
    const I = ISL[i];
    const ex = I.R * 2.0 * I.sx, ed = I.R * 2.0 * I.sd;
    if (d < I.d - ed || d > I.d + ed || x < I.x - ex || x > I.x + ex) continue;
    const ih = islandH(I, x, d);
    if (ih > h) h = ih;
  }
  return h;
}
function coastH(x, d) {
  const s = shoreD(x);
  let h;
  if (d >= s) h = Math.min(0, WATER_REL + 0.05 + (d - s) * 0.07);
  else h = Math.max(seaFloor(x, d), WATER_REL - (s - d) * 0.17);
  if (x > HARBOR_X0 && d < HARBOR_D1 && d > s - 8) h = Math.min(h, lerp(h, -2.1, sstep(s - 8, s - 1, d) * sstep(HARBOR_X0, HARBOR_X0 + 1.5, x)));
  if (x > BW.x0 && d > BW.d0 && d < BW.d1) h = 0.1;
  return h;
}
function inlandH(x, d) {
  let h = 0;
  if (d > 460 && d < 482) {
    const a = Math.abs(d - riverD(x));
    if (a < 2.6) h = -1.2 * sstep(2.6, 1.25, a);
  }
  for (let i = 0; i < PONDS.length; i++) {
    const p = PONDS[i];
    const ex = (x - p.x) / p.rx, ed = (d - p.d) / p.rd;
    const e = ex * ex + ed * ed;
    if (e < 1.7) h = Math.min(h, -1.1 * sstep(1.35, 0.8, e));
  }
  if (d > CANAL_C - 2.2 && d < CANAL_C + 2.2 && Math.abs(d - CANAL_C) < 1.95) h = -1.1;
  if (d > 392 && d < 630) {
    const ax = Math.abs(x);
    if (ax > 8.2) {
      const f = forestF(x, d);
      if (f > 0.5) {
        let k = (f - 0.5) * 2.4 * sstep(8.2, 11.5, ax) * sstep(2.2, 5, crossDist(d));
        k *= sstep(3.2, 6.5, Math.abs(d - riverD(x)));
        for (let i = 0; i < PONDS.length; i++) {
          const p = PONDS[i];
          if (Math.abs(d - p.d) < 8) k *= sstep(p.rx + 1, p.rx + 4, Math.hypot(x - p.x, (d - p.d) * p.rx / p.rd));
        }
        h += k;
      }
    }
  }
  return h;
}
const CANAL_C = 877;                            // city canal (between the 860 and 900 cross roads)
// coastal ground height (relative to GROUND_Y); the world asks S.terrainH
function coastalH(x, d) {
  if (d < 240) return oceanH(x, d);
  if (d < 400) return d < 280 ? Math.max(oceanH(x, d), coastH(x, d)) : coastH(x, d);
  if (d < 1228) return inlandH(x, d);
  if (d < 1250) return d < BASE_END ? 0 : Math.max(-2.6, WATER_REL - 0.9 - (d - BASE_END) * 0.6);
  return -2.6;
}

// base land colour along the stage (before local modifiers)
const LAND_KEYS = [
  [300, P.grassCoast], [390, P.grassCoast], [430, P.grass], [620, P.grass],
  [665, P.urban], [940, P.urban], [985, P.dry], [1300, P.dry],
];
function landBase(d, out) {
  let i = 0;
  while (i < LAND_KEYS.length - 2 && d > LAND_KEYS[i + 1][0]) i++;
  const a = LAND_KEYS[i], b = LAND_KEYS[i + 1];
  const t = sstep(a[0], b[0], d);
  out[0] = lerp(a[1][0], b[1][0], t); out[1] = lerp(a[1][1], b[1][1], t); out[2] = lerp(a[1][2], b[1][2], t);
}
function mixInto(out, c, t) { out[0] += (c[0] - out[0]) * t; out[1] += (c[1] - out[1]) * t; out[2] += (c[2] - out[2]) * t; }

function coastalColor(x, d, h, out) {
  if (d < 280) {                                 // islands
    if (h < 0.28) { out[0] = P.sand[0]; out[1] = P.sand[1]; out[2] = P.sand[2]; if (h < 0.02) mixInto(out, P.sandWet, sstep(0.02, -0.25, h)); }
    else { out[0] = P.jungle[0]; out[1] = P.jungle[1]; out[2] = P.jungle[2]; mixInto(out, P.grassL, vnoise(x * 0.4, d * 0.4) * 0.45); mixInto(out, P.sand, sstep(0.45, 0.28, h)); }
  } else {
    landBase(d, out);
    const n = fbm(x * 0.11 + 5.1, d * 0.11 - 2.3);
    if (d < 1000) {
      if (d < 640) mixInto(out, n > 0.5 ? P.grassL : P.grassD, Math.abs(n - 0.5) * 1.1);
      else mixInto(out, P.concreteD, (n - 0.35) * 0.4);
    } else mixInto(out, n > 0.5 ? P.dryL : P.grassD, Math.abs(n - 0.5) * 0.9);
    if (d < 400) {                               // beach
      const t = d - shoreD(x);
      const bw = 6.5 + 2.5 * vnoise(x * 0.2, 3.3);
      mixInto(out, P.sand, sstep(bw + 1.2, bw - 1.2, t) * (x > HARBOR_X0 - 0.5 ? 0.0 : 1));
      if (x > HARBOR_X0 - 0.5 && d < 362) mixInto(out, P.paving, 0.85);
      if (x < -8.5) mixInto(out, P.rock, sstep(3, 0.5, t) * 0.7);
    }
    if (h < -0.02) mixInto(out, P.sandWet, 0.8);
    if (d > 390 && d < 640) {                    // forest floor, river banks
      const f = forestF(x, d);
      if (f > 0.46 && Math.abs(x) > 7.8) mixInto(out, P.forest, sstep(0.46, 0.6, f) * sstep(7.8, 10, Math.abs(x)) * sstep(2, 4.5, crossDist(d)));
      const a = Math.abs(d - riverD(x));
      if (a < 4.5) mixInto(out, P.mud, sstep(4.5, 2.2, a) * 0.8);
    }
    for (let i = 0; i < PONDS.length; i++) {
      const p = PONDS[i];
      const ex = (x - p.x) / (p.rx + 1.3), ed = (d - p.d) / (p.rd + 1.3);
      const e = ex * ex + ed * ed;
      if (e < 1) mixInto(out, i === 3 ? P.grassD : P.mud, sstep(1, 0.55, e) * 0.7);
    }
    if (x > PARK.x0 - 0.3 && x < PARK.x1 + 0.3 && d > PARK.d0 - 0.3 && d < PARK.d1 + 0.3) mixInto(out, P.grassL, 0.85);
  }
  const g = 0.94 + 0.12 * vnoise(x * 0.9 + 1.7, d * 0.9 + 4.1);
  out[0] *= g; out[1] *= g; out[2] *= g;
}

// =============================================================================
// Geometry emitter — writes straight into the current chunk's typed arrays.
// Local frame (FX, FD, rot) lets composite props be placed and rotated.
// =============================================================================
let BP = null, BCOL = null, BU = null, BT = null, BN = 0, BCAP = 0, BZ0 = 0;
let SP = null, SN = 0, SCAP = 0;
let FX = 0, FD = 0, FC = 1, FS = 0;
let TU = 0, TV = 3;                // atlas cell of the next vertices (shader space: v from bottom)
let SHK = 1;                       // shadow length multiplier of the chunk being built
let LOWQ = false;
let VIOL = 0;                      // clear-zone violations found by the self-check
let VIOL_LOG = null;

function setTile(i) { TU = i & 3; TV = 3 - (i >> 2); }
function frame(x, d, rot) {
  FX = x; FD = d;
  if (rot) { FC = Math.cos(rot); FS = Math.sin(rot); } else { FC = 1; FS = 0; }
}
function frameId() { FX = 0; FD = 0; FC = 1; FS = 0; }
const wx = (lx, ld) => FX + lx * FC - ld * FS;
const wd = (lx, ld) => FD + lx * FS + ld * FC;
const room = (n) => BN + n <= BCAP;

function vtx(lx, y, ld, c, k, u, v) {
  const i = BN * 3, j = BN * 2;
  BP[i] = FX + lx * FC - ld * FS;
  BP[i + 1] = y;
  BP[i + 2] = BZ0 - (FD + lx * FS + ld * FC);
  // colours are stored as normalized bytes scaled by 1/COL_SCALE (the material colour undoes it)
  const r = c[0] * k * COL_Q + 0.5, g = c[1] * k * COL_Q + 0.5, b = c[2] * k * COL_Q + 0.5;
  BCOL[i] = r > 255 ? 255 : r; BCOL[i + 1] = g > 255 ? 255 : g; BCOL[i + 2] = b > 255 ? 255 : b;
  BU[j] = u; BU[j + 1] = v; BT[j] = TU; BT[j + 1] = TV;
  BN++;
}

// --- clear-zone test (world coordinates) ---------------------------------------
function blocked(x0, x1, dA, dB, m) {
  const cf = S.clear.from, ct = S.clear.to;
  if (dB > cf - m && dA < ct + m) {
    for (let i = 0; i < 3; i++) {
      const lx = LANES_X[i];
      if (x1 > lx - LANE_HALF - m && x0 < lx + LANE_HALF + m) return true;
    }
    const k = Math.ceil((dA - CROSS_HALF - m - 20) / CHUNK);
    const c = k * CHUNK + 20;
    if (c <= dB + CROSS_HALF + m && c >= cf && c < ct) return true;
  }
  // mid-boss / boss corridors of the stage ({ d0, d1, x }: |x| < x over d0..d1)
  const cor = S.corridors;
  for (let i = 0; i < cor.length; i++) {
    const c = cor[i];
    if (dB > c.d0 && dA < c.d1 && x1 > -c.x - m && x0 < c.x + m) return true;
  }
  return false;
}
// can a round prop of radius r stand at world (x,d)?
const canPlace = (x, d, r) => !blocked(x - r, x + r, d - r, d + r, 0.12);
const canRect = (x0, x1, dA, dB) => !blocked(x0, x1, dA, dB, 0.12);

// self-check for anything that rises above TALL: record a violation (never blocks)
function checkTall(lx0, ld0, lx1, ld1, top) {
  if (top <= TALL + 1e-4) return;
  let xa = Infinity, xb = -Infinity, da = Infinity, db = -Infinity;
  for (let i = 0; i < 4; i++) {
    const lx = i & 1 ? lx1 : lx0, ld = i & 2 ? ld1 : ld0;
    const x = wx(lx, ld), d = wd(lx, ld);
    if (x < xa) xa = x; if (x > xb) xb = x; if (d < da) da = d; if (d > db) db = d;
  }
  if (blocked(xa, xb, da, db, -0.02)) { VIOL++; if (VIOL_LOG && VIOL_LOG.length < 40) VIOL_LOG.push([+xa.toFixed(2), +xb.toFixed(2), +da.toFixed(2), +db.toFixed(2), +top.toFixed(2)]); }
  if (top > MAX_H + 1e-3) { VIOL++; if (VIOL_LOG && VIOL_LOG.length < 40) VIOL_LOG.push(['height', +top.toFixed(2)]); }
}

// same check for round things (lathes, cylinders, cones): world centre + radius
function checkTallRound(lx, ld, r, top) {
  if (top <= TALL + 1e-4) return;
  const x = wx(lx, ld), d = wd(lx, ld);
  if (blocked(x - r, x + r, d - r, d + r, -0.02)) { VIOL++; if (VIOL_LOG && VIOL_LOG.length < 40) VIOL_LOG.push([+(x - r).toFixed(2), +(x + r).toFixed(2), +(d - r).toFixed(2), +(d + r).toFixed(2), +top.toFixed(2)]); }
  if (top > MAX_H + 1e-3) { VIOL++; if (VIOL_LOG && VIOL_LOG.length < 40) VIOL_LOG.push(['height', +top.toFixed(2)]); }
}

// visibility cull for vertical faces: the camera sits at x≈0 and far toward +z (low d),
// so faces whose normal points up-screen (+d) and away from the centre line are never seen.
function wallHidden(nx, nd, px) { return nd >= -0.02 && nx * px >= 0.45 * Math.abs(nx); }

// --- flat pieces --------------------------------------------------------------------
// uv mode: us=0 → constant uv; else (x/us, d/vs) in LOCAL coords, or swapped when sw
let UVS = 0, UVV = 0, UVSW = false, UVX = 0, UVD = 0, UVC = 1, UVN = 0;
function uvMode(us, vs, sw = false, ox = 0, od = 0, rot = 0) { UVS = us; UVV = vs; UVSW = sw; UVX = ox; UVD = od; UVC = Math.cos(rot); UVN = Math.sin(rot); }
function fv(lx, y, ld, c, k) {
  if (UVS === 0) { vtx(lx, y, ld, c, k, 0, 0); return; }
  const px = lx - UVX, pd = ld - UVD;
  const rx = px * UVC + pd * UVN, rd = pd * UVC - px * UVN;
  if (UVSW) vtx(lx, y, ld, c, k, rd / UVS, rx / UVV);
  else vtx(lx, y, ld, c, k, rx / UVS, rd / UVV);
}
// rectangle decal (local frame) at relative height lay
function flat(x0, d0, x1, d1, lay, c, k = 1) {
  if (!room(6)) return;
  const y = GROUND_Y + lay;
  fv(x0, y, d0, c, k); fv(x1, y, d0, c, k); fv(x1, y, d1, c, k);
  fv(x0, y, d0, c, k); fv(x1, y, d1, c, k); fv(x0, y, d1, c, k);
}
// quad with 4 arbitrary local corners (CCW from above) at one height
function flat4(ax, ad, bx, bd, cx, cd, dx, dd, lay, c, k = 1) {
  if (!room(6)) return;
  const y = GROUND_Y + lay;
  fv(ax, y, ad, c, k); fv(bx, y, bd, c, k); fv(cx, y, cd, c, k);
  fv(ax, y, ad, c, k); fv(cx, y, cd, c, k); fv(dx, y, dd, c, k);
}
function disc(cx, cd, rx, rd, lay, c, segs = 12, k = 1) {
  if (!room(segs * 3)) return;
  const y = GROUND_Y + lay;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    fv(cx, y, cd, c, k);
    fv(cx + Math.cos(a0) * rx, y, cd + Math.sin(a0) * rd, c, k);
    fv(cx + Math.cos(a1) * rx, y, cd + Math.sin(a1) * rd, c, k);
  }
}
// annulus of an ellipse or stadium; str > 0 adds straight sections of that half-length (along d)
function ring(cx, cd, rx, rd, w, lay, c, segs = 24, str = 0, k = 1) {
  if (!room(segs * 6)) return;
  const y = GROUND_Y + lay;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const s0 = Math.sin(a0) >= 0 ? str : -str, s1 = Math.sin(a1) >= 0 ? str : -str;
    const ox0 = Math.cos(a0), od0 = Math.sin(a0), ox1 = Math.cos(a1), od1 = Math.sin(a1);
    const ax = cx + ox0 * rx, ad = cd + od0 * rd + s0, bx = cx + ox1 * rx, bd = cd + od1 * rd + s1;
    const cx2 = cx + ox1 * (rx + w), cd2 = cd + od1 * (rd + w) + s1, dx2 = cx + ox0 * (rx + w), dd2 = cd + od0 * (rd + w) + s0;
    fv(ax, y, ad, c, k); fv(dx2, y, dd2, c, k); fv(cx2, y, cd2, c, k);
    fv(ax, y, ad, c, k); fv(cx2, y, cd2, c, k); fv(bx, y, bd, c, k);
  }
  if (str) {
    // fill the straights on both sides
    for (const sx of [-1, 1]) {
      const x0 = cx + sx * rx, x1 = cx + sx * (rx + w);
      if (sx < 0) { fv(x1, y, cd - str, c, k); fv(x0, y, cd - str, c, k); fv(x0, y, cd + str, c, k); fv(x1, y, cd - str, c, k); fv(x0, y, cd + str, c, k); fv(x1, y, cd + str, c, k); }
      else { fv(x0, y, cd - str, c, k); fv(x1, y, cd - str, c, k); fv(x1, y, cd + str, c, k); fv(x0, y, cd - str, c, k); fv(x1, y, cd + str, c, k); fv(x0, y, cd + str, c, k); }
    }
  }
}

// --- solids -------------------------------------------------------------------------
// side/top texture styles for boxes & prisms
let SIDE_T = 0, SIDE_U = 0, SIDE_V = 0, TOP_T = 0, TOP_U = 0, TOP_V = 0, AO = 0.72;
function sideStyle(t = 0, u = 0, v = 0) { SIDE_T = t; SIDE_U = u; SIDE_V = v; }
function topStyle(t = 0, u = 0, v = 0) { TOP_T = t; TOP_U = u; TOP_V = v; }
function plain() { SIDE_T = 0; SIDE_U = 0; TOP_T = 0; TOP_U = 0; AO = 0.72; }

// vertical wall along local edge a→b (outside on the right of a→b when CCW from above)
function wall(ax, ad, bx, bd, y0, y1, c, u0, gnd) {
  const ex = bx - ax, ed = bd - ad;
  const len = Math.hypot(ex, ed);
  if (len < 1e-5) return u0;
  const nxl = ed / len, ndl = -ex / len;
  const nx = nxl * FC - ndl * FS, nd = nxl * FS + ndl * FC;
  const px = wx((ax + bx) * 0.5, (ad + bd) * 0.5);
  if (wallHidden(nx, nd, px) || !room(6)) return u0 + len;
  setTile(SIDE_T);
  const kb = gnd ? AO : 0.92;
  let ua = 0, ub = 0, va = 0, vb = 0;
  if (SIDE_U) { ua = u0 / SIDE_U; ub = (u0 + len) / SIDE_U; va = 0; vb = (y1 - y0) / SIDE_V; }
  vtx(ax, y0, ad, c, kb, ua, va); vtx(bx, y0, bd, c, kb, ub, va); vtx(bx, y1, bd, c, 1, ub, vb);
  vtx(ax, y0, ad, c, kb, ua, va); vtx(bx, y1, bd, c, 1, ub, vb); vtx(ax, y1, ad, c, 1, ua, vb);
  return u0 + len;
}
// axis box in the local frame, rel heights h0..h1 above GROUND_Y
function box(x0, d0, x1, d1, h0, h1, cs, ct = cs, top = true) {
  checkTall(x0, d0, x1, d1, h1);
  const y0 = GROUND_Y + h0, y1 = GROUND_Y + h1, g = h0 < 0.05;
  let u = 0;
  u = wall(x0, d0, x1, d0, y0, y1, cs, u, g);
  u = wall(x1, d0, x1, d1, y0, y1, cs, u, g);
  u = wall(x1, d1, x0, d1, y0, y1, cs, u, g);
  wall(x0, d1, x0, d0, y0, y1, cs, u, g);
  if (top && room(6)) {
    setTile(TOP_T);
    const u0 = TOP_U ? x0 / TOP_U : 0, u1 = TOP_U ? x1 / TOP_U : 0, v0 = TOP_V ? d0 / TOP_V : 0, v1 = TOP_V ? d1 / TOP_V : 0;
    vtx(x0, y1, d0, ct, 1, u0, v0); vtx(x1, y1, d0, ct, 1, u1, v0); vtx(x1, y1, d1, ct, 1, u1, v1);
    vtx(x0, y1, d0, ct, 1, u0, v0); vtx(x1, y1, d1, ct, 1, u1, v1); vtx(x0, y1, d1, ct, 1, u0, v1);
  }
  setTile(0);
}
// convex prism from a local polygon (CCW from above) stored in PX/PD[0..n)
const PX = new Float32Array(32), PD = new Float32Array(32);
function prism(n, h0, h1, cs, ct = cs) {
  let xa = Infinity, xb = -Infinity, da = Infinity, db = -Infinity;
  for (let i = 0; i < n; i++) { xa = Math.min(xa, PX[i]); xb = Math.max(xb, PX[i]); da = Math.min(da, PD[i]); db = Math.max(db, PD[i]); }
  checkTall(xa, da, xb, db, h1);
  const y0 = GROUND_Y + h0, y1 = GROUND_Y + h1, g = h0 < 0.05;
  let u = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; u = wall(PX[i], PD[i], PX[j], PD[j], y0, y1, cs, u, g); }
  if (!room((n - 2) * 3)) return;
  setTile(0);
  for (let i = 1; i < n - 1; i++) {
    vtx(PX[0], y1, PD[0], ct, 1, 0, 0); vtx(PX[i], y1, PD[i], ct, 1, 0, 0); vtx(PX[i + 1], y1, PD[i + 1], ct, 1, 0, 0);
  }
}
// gable roof over a local rect, ridge along d (alongD) or along x
function gable(x0, d0, x1, d1, h0, rh, c, alongD = true, k2 = 0.86) {
  checkTall(x0, d0, x1, d1, h0 + rh);
  if (!room(24)) return;
  const y0 = GROUND_Y + h0, y1 = y0 + rh;
  const tex = TOP_T !== 0, us = tex ? TOP_U || 1 : 1, vs = tex ? TOP_V || 1 : 1, m = tex ? 1 : 0;
  setTile(TOP_T);
  if (alongD) {
    const xm = (x0 + x1) / 2, sl = Math.hypot(xm - x0, rh) / vs * m;
    const a = d0 / us * m, b = d1 / us * m;
    // right slope: (x1,d0)→(x1,d1)→(xm,d1)→(xm,d0)
    vtx(x1, y0, d0, c, 1, a, 0); vtx(x1, y0, d1, c, 1, b, 0); vtx(xm, y1, d1, c, 1, b, sl);
    vtx(x1, y0, d0, c, 1, a, 0); vtx(xm, y1, d1, c, 1, b, sl); vtx(xm, y1, d0, c, 1, a, sl);
    // left slope: (x0,d1)→(x0,d0)→(xm,d0)→(xm,d1)
    vtx(x0, y0, d1, c, k2, b, 0); vtx(x0, y0, d0, c, k2, a, 0); vtx(xm, y1, d0, c, k2, a, sl);
    vtx(x0, y0, d1, c, k2, b, 0); vtx(xm, y1, d0, c, k2, a, sl); vtx(xm, y1, d1, c, k2, b, sl);
    setTile(0);
    vtx(x0, y0, d0, c, 0.8, 0, 0); vtx(x1, y0, d0, c, 0.8, 0, 0); vtx(xm, y1, d0, c, 0.8, 0, 0);
    vtx(x1, y0, d1, c, 0.8, 0, 0); vtx(x0, y0, d1, c, 0.8, 0, 0); vtx(xm, y1, d1, c, 0.8, 0, 0);
  } else {
    const dm = (d0 + d1) / 2, sl = Math.hypot(dm - d0, rh) / vs * m;
    const a = x0 / us * m, b = x1 / us * m;
    // front slope (facing −d): (x0,d0)→(x1,d0)→(x1,dm)→(x0,dm)
    vtx(x0, y0, d0, c, 1, a, 0); vtx(x1, y0, d0, c, 1, b, 0); vtx(x1, y1, dm, c, 1, b, sl);
    vtx(x0, y0, d0, c, 1, a, 0); vtx(x1, y1, dm, c, 1, b, sl); vtx(x0, y1, dm, c, 1, a, sl);
    // back slope: (x1,d1)→(x0,d1)→(x0,dm)→(x1,dm)
    vtx(x1, y0, d1, c, k2, b, 0); vtx(x0, y0, d1, c, k2, a, 0); vtx(x0, y1, dm, c, k2, a, sl);
    vtx(x1, y0, d1, c, k2, b, 0); vtx(x0, y1, dm, c, k2, a, sl); vtx(x1, y1, dm, c, k2, b, sl);
    setTile(0);
    vtx(x1, y0, d0, c, 0.8, 0, 0); vtx(x1, y0, d1, c, 0.8, 0, 0); vtx(x1, y1, dm, c, 0.8, 0, 0);
    vtx(x0, y0, d1, c, 0.8, 0, 0); vtx(x0, y0, d0, c, 0.8, 0, 0); vtx(x0, y1, dm, c, 0.8, 0, 0);
  }
  setTile(0);
}
// hip roof (4 slopes)
function hip(x0, d0, x1, d1, h0, rh, c) {
  checkTall(x0, d0, x1, d1, h0 + rh);
  if (!room(18)) return;
  const y0 = GROUND_Y + h0, y1 = y0 + rh;
  const w = x1 - x0, l = d1 - d0, xm = (x0 + x1) / 2, dm = (d0 + d1) / 2;
  let ax, ad, bx, bd; // ridge ends
  if (l >= w) { ax = xm; bx = xm; ad = d0 + w / 2; bd = d1 - w / 2; } else { ad = dm; bd = dm; ax = x0 + l / 2; bx = x1 - l / 2; }
  setTile(0);
  if (l >= w) {
    vtx(x0, y0, d0, c, 1.0, 0, 0); vtx(x1, y0, d0, c, 1.0, 0, 0); vtx(ax, y1, ad, c, 1.0, 0, 0);           // front
    vtx(x1, y0, d0, c, 0.9, 0, 0); vtx(x1, y0, d1, c, 0.9, 0, 0); vtx(bx, y1, bd, c, 0.9, 0, 0);           // right
    vtx(x1, y0, d0, c, 0.9, 0, 0); vtx(bx, y1, bd, c, 0.9, 0, 0); vtx(ax, y1, ad, c, 0.9, 0, 0);
    vtx(x1, y0, d1, c, 0.85, 0, 0); vtx(x0, y0, d1, c, 0.85, 0, 0); vtx(bx, y1, bd, c, 0.85, 0, 0);        // back
    vtx(x0, y0, d1, c, 1.0, 0, 0); vtx(x0, y0, d0, c, 1.0, 0, 0); vtx(ax, y1, ad, c, 1.0, 0, 0);           // left
    vtx(x0, y0, d1, c, 1.0, 0, 0); vtx(ax, y1, ad, c, 1.0, 0, 0); vtx(bx, y1, bd, c, 1.0, 0, 0);
  } else {
    vtx(x0, y0, d0, c, 1.0, 0, 0); vtx(x1, y0, d0, c, 1.0, 0, 0); vtx(bx, y1, bd, c, 1.0, 0, 0);           // front
    vtx(x0, y0, d0, c, 1.0, 0, 0); vtx(bx, y1, bd, c, 1.0, 0, 0); vtx(ax, y1, ad, c, 1.0, 0, 0);
    vtx(x1, y0, d0, c, 0.9, 0, 0); vtx(x1, y0, d1, c, 0.9, 0, 0); vtx(bx, y1, bd, c, 0.9, 0, 0);           // right
    vtx(x1, y0, d1, c, 0.85, 0, 0); vtx(x0, y0, d1, c, 0.85, 0, 0); vtx(ax, y1, ad, c, 0.85, 0, 0);        // back
    vtx(x1, y0, d1, c, 0.85, 0, 0); vtx(ax, y1, ad, c, 0.85, 0, 0); vtx(bx, y1, bd, c, 0.85, 0, 0);
    vtx(x0, y0, d1, c, 1.0, 0, 0); vtx(x0, y0, d0, c, 1.0, 0, 0); vtx(ax, y1, ad, c, 1.0, 0, 0);           // left
  }
}
// vertical cylinder (open bottom)
function cyl(cx, cd, r, h0, h1, segs, cs, ct = cs, top = true) {
  checkTallRound(cx, cd, r, h1);
  const y0 = GROUND_Y + h0, y1 = GROUND_Y + h1, g = h0 < 0.05;
  let u = 0;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    u = wall(cx + Math.cos(a0) * r, cd + Math.sin(a0) * r, cx + Math.cos(a1) * r, cd + Math.sin(a1) * r, y0, y1, cs, u, g);
  }
  if (!top || !room(segs * 3)) return;
  setTile(0);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    vtx(cx, y1, cd, ct, 1, 0, 0); vtx(cx + Math.cos(a0) * r, y1, cd + Math.sin(a0) * r, ct, 1, 0, 0); vtx(cx + Math.cos(a1) * r, y1, cd + Math.sin(a1) * r, ct, 1, 0, 0);
  }
}
// cone / pyramid
function cone(cx, cd, r, h0, h1, segs, c, rot = 0) {
  checkTallRound(cx, cd, r, h1);
  if (!room(segs * 3)) return;
  setTile(0);
  const y0 = GROUND_Y + h0, y1 = GROUND_Y + h1;
  for (let i = 0; i < segs; i++) {
    const a0 = rot + (i / segs) * TAU, a1 = rot + ((i + 1) / segs) * TAU;
    const k = 0.82 + 0.18 * Math.cos((a0 + a1) * 0.5 - 2.4);
    vtx(cx + Math.cos(a0) * r, y0, cd + Math.sin(a0) * r, c, k * 0.85, 0, 0);
    vtx(cx + Math.cos(a1) * r, y0, cd + Math.sin(a1) * r, c, k * 0.85, 0, 0);
    vtx(cx, y1, cd, c, k * 1.05, 0, 0);
  }
}
// lathe: rings (radius R[i], rel height H[i], shade K[i]) — R=0 makes an apex
const LR = new Float32Array(8), LH = new Float32Array(8), LK = new Float32Array(8);
const LCX = new Float32Array(17), LSN = new Float32Array(17), LLT = new Float32Array(16), LJ = new Float32Array(8 * 17);
let LSEED = 0;
function lathe(cx, cd, n, segs, c, rot, sx = 1, sd = 1, jitter = 0) {
  let top = 0, rm = 0;
  for (let i = 0; i < n; i++) { top = Math.max(top, LH[i]); rm = Math.max(rm, LR[i]); }
  checkTallRound(cx, cd, rm * Math.max(sx, sd) * (1 + jitter * 0.5), top);
  if (!room((n - 1) * segs * 6)) return;
  setTile(0);
  // per-segment trig, light factor and per-vertex jitter, computed once
  for (let i = 0; i <= segs; i++) { const a = rot + (i / segs) * TAU; LCX[i] = Math.cos(a); LSN[i] = Math.sin(a); }
  for (let i = 0; i < segs; i++) LLT[i] = 0.86 + 0.14 * Math.cos(rot + ((i + 0.5) / segs) * TAU - 2.4);
  LSEED = (LSEED + 7) & 1023;
  for (let r = 0; r < n; r++) for (let i = 0; i <= segs; i++) LJ[r * 17 + i] = jitter ? 1 + (hash2(i % segs + LSEED, r + 7) - 0.5) * jitter : 1;
  for (let r = 0; r < n - 1; r++) {
    const ra = LR[r], rb = LR[r + 1], ya = GROUND_Y + LH[r], yb = GROUND_Y + LH[r + 1];
    const ka = LK[r], kb = LK[r + 1];
    for (let i = 0; i < segs; i++) {
      const lt = LLT[i];
      const ja0 = LJ[r * 17 + i], ja1 = LJ[r * 17 + i + 1], jb0 = LJ[(r + 1) * 17 + i], jb1 = LJ[(r + 1) * 17 + i + 1];
      const c0 = LCX[i], s0 = LSN[i], c1 = LCX[i + 1], s1 = LSN[i + 1];
      const ax = cx + c0 * ra * sx * ja0, ad = cd + s0 * ra * sd * ja0, bx = cx + c1 * ra * sx * ja1, bd = cd + s1 * ra * sd * ja1;
      const ex = cx + c1 * rb * sx * jb1, ed = cd + s1 * rb * sd * jb1, fx = cx + c0 * rb * sx * jb0, fd = cd + s0 * rb * sd * jb0;
      if (ra > 1e-4) { vtx(ax, ya, ad, c, ka * lt, 0, 0); vtx(bx, ya, bd, c, ka * lt, 0, 0); vtx(ex, yb, ed, c, kb * lt, 0, 0); }
      if (rb > 1e-4) { vtx(ax, ya, ad, c, ka * lt, 0, 0); vtx(ex, yb, ed, c, kb * lt, 0, 0); vtx(fx, yb, fd, c, kb * lt, 0, 0); }
    }
  }
}

// --- shadows (translucent layer) ----------------------------------------------------
const HX = new Float32Array(24), HD = new Float32Array(24), HO = new Int32Array(48);
function shadowPush(x, d, y) {
  const i = SN * 3;
  SP[i] = x; SP[i + 1] = y; SP[i + 2] = BZ0 - d;
  SN++;
}
// convex hull (monotone chain) of HX/HD[0..n) → fan triangles at height y
function shadowHull(n, y) {
  // sort indices by x then d (insertion sort, n ≤ 24)
  for (let i = 0; i < n; i++) HO[i] = i;
  for (let i = 1; i < n; i++) {
    const t = HO[i]; let j = i - 1;
    while (j >= 0 && (HX[HO[j]] > HX[t] || (HX[HO[j]] === HX[t] && HD[HO[j]] > HD[t]))) { HO[j + 1] = HO[j]; j--; }
    HO[j + 1] = t;
  }
  const H = HO; // reuse tail region for the hull
  let k = 0; const base = 24;
  const cross = (o, a, b) => (HX[a] - HX[o]) * (HD[b] - HD[o]) - (HD[a] - HD[o]) * (HX[b] - HX[o]);
  for (let i = 0; i < n; i++) { const p = HO[i]; while (k >= 2 && cross(H[base + k - 2], H[base + k - 1], p) <= 0) k--; H[base + k++] = p; }
  for (let i = n - 2, t = k + 1; i >= 0; i--) { const p = HO[i]; while (k >= t && cross(H[base + k - 2], H[base + k - 1], p) <= 0) k--; H[base + k++] = p; }
  k--;
  if (k < 3 || SN + (k - 2) * 3 > SCAP) return;
  const a = H[base];
  for (let i = 1; i < k - 1; i++) {
    shadowPush(HX[a], HD[a], y);
    shadowPush(HX[H[base + i]], HD[H[base + i]], y);
    shadowPush(HX[H[base + i + 1]], HD[H[base + i + 1]], y);
  }
}
const SUNX = 0.467, SUND = 0.333; // ground offset per unit height (matches core's aircraft shadows)
// shadow of a local-frame rect prism of height h standing at rel. height base
function shadowBox(x0, d0, x1, d1, h, base = 0) {
  if (h < 0.05) return;
  const ox = h * SUNX * SHK, od = h * SUND * SHK;
  for (let i = 0; i < 4; i++) {
    const lx = i === 0 || i === 3 ? x0 : x1, ld = i < 2 ? d0 : d1;
    const x = wx(lx, ld), d = wd(lx, ld);
    HX[i] = x; HD[i] = d; HX[i + 4] = x + ox; HD[i + 4] = d + od;
  }
  shadowHull(8, GROUND_Y + base + L_SHADOW);
}
function shadowDisc(x, d, r, h, base = 0, stretch = 1) {
  if (h < 0.05) return;
  const ox = h * SUNX * SHK, od = h * SUND * SHK;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    HX[i] = x + Math.cos(a) * r; HD[i] = d + Math.sin(a) * r;
    HX[i + 8] = x + ox * stretch + Math.cos(a) * r; HD[i + 8] = d + od * stretch + Math.sin(a) * r;
  }
  shadowHull(16, GROUND_Y + base + L_SHADOW);
}
// soft round blob under a tree canopy (offset toward the sun's shadow side)
function shadowBlob(x, d, r, h, base = 0) {
  const ox = h * SUNX * SHK * 0.55, od = h * SUND * SHK * 0.55;
  if (SN + 18 > SCAP) return;
  const y = GROUND_Y + base + L_SHADOW;
  const cx = x + ox, cd = d + od;
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * TAU + 0.3, a1 = ((i + 1) / 6) * TAU + 0.3;
    shadowPush(cx, cd, y);
    shadowPush(cx + Math.cos(a0) * r * 1.15, cd + Math.sin(a0) * r, y);
    shadowPush(cx + Math.cos(a1) * r * 1.15, cd + Math.sin(a1) * r, y);
  }
}

// =============================================================================
// Prop library (all in world coordinates unless noted; each resets the frame)
// =============================================================================
const TC = [0, 0, 0], TC2 = [0, 0, 0], TC3 = [0, 0, 0];
function jit(c, a, out = TC) {
  const k = 1 + (rand() - 0.5) * a;
  out[0] = c[0] * k * (1 + (rand() - 0.5) * a * 0.3);
  out[1] = c[1] * k * (1 + (rand() - 0.5) * a * 0.3);
  out[2] = c[2] * k * (1 + (rand() - 0.5) * a * 0.3);
  return out;
}
function tint(c, t, k, out = TC) { out[0] = lerp(c[0], t[0], k); out[1] = lerp(c[1], t[1], k); out[2] = lerp(c[2], t[2], k); return out; }

function treeRound(x, d, r, h, c, base = 0) {
  if (base + h > TALL && !canPlace(x, d, r * 1.13)) return;
  frame(x, d, rand() * TAU);
  const b = base + 0.05;
  LR[0] = 0; LH[0] = b + h * 0.12; LK[0] = 0.62;
  LR[1] = r; LH[1] = b + h * 0.42; LK[1] = 0.88;
  LR[2] = r * 0.66; LH[2] = b + h * 0.8; LK[2] = 1.02;
  LR[3] = 0; LH[3] = b + h; LK[3] = 1.12;
  lathe(0, 0, 4, LOWQ ? 4 : 5, c, 0, 1, 1, 0.25);
  frameId();
  shadowBlob(x, d, r * 0.95, h, base);
}
function treeCone(x, d, r, h, c, base = 0) {
  if (base + h > TALL && !canPlace(x, d, r * 1.02)) return;
  frame(x, d, rand() * TAU);
  LR[0] = r; LH[0] = base + h * 0.12; LK[0] = 0.7;
  LR[1] = 0; LH[1] = base + h * 0.72; LK[1] = 1.0;
  lathe(0, 0, 2, 6, c, 0);
  LR[0] = r * 0.7; LH[0] = base + h * 0.45; LK[0] = 0.8;
  LR[1] = 0; LH[1] = base + h; LK[1] = 1.12;
  lathe(0, 0, 2, 6, c, 0.5);
  frameId();
  shadowBlob(x, d, r * 0.8, h, base);
}
function bush(x, d, r, c, base = 0) {
  if (base + r > TALL && !canPlace(x, d, r * 1.2)) return;
  frame(x, d, rand() * TAU);
  LR[0] = r; LH[0] = base + 0.02; LK[0] = 0.7;
  LR[1] = r * 0.6; LH[1] = base + r * 0.7; LK[1] = 0.95;
  LR[2] = 0; LH[2] = base + r * 0.95; LK[2] = 1.1;
  lathe(0, 0, 3, 5, c, 0, 1, 1, 0.3);
  frameId();
}
function palm(x, d, h, base = 0) {
  const lean = rr(-0.25, 0.25), leanD = rr(-0.25, 0.25);
  if (!canPlace(x, d, 1.25)) return;
  frame(x, d, 0);
  const tx = lean, td = leanD, top = base + h;
  const c = jit(P.palm, 0.15, TC2);
  checkTall(-0.9 + tx, -0.9 + td, 0.9 + tx, 0.9 + td, top + 0.12);
  if (!room(18 + 7 * 9)) { frameId(); return; }
  // trunk (3-sided, tapering)
  setTile(0);
  const tr = [0.09, 0.06];
  for (let i = 0; i < 3; i++) {
    const a0 = (i / 3) * TAU + 0.5, a1 = ((i + 1) / 3) * TAU + 0.5;
    const ax = Math.cos(a0) * tr[0], ad = Math.sin(a0) * tr[0], bx = Math.cos(a1) * tr[0], bd = Math.sin(a1) * tr[0];
    const cx = tx + Math.cos(a1) * tr[1], cd = td + Math.sin(a1) * tr[1], dx = tx + Math.cos(a0) * tr[1], dd = td + Math.sin(a0) * tr[1];
    vtx(ax, GROUND_Y + base, ad, P.mud, 0.8, 0, 0); vtx(bx, GROUND_Y + base, bd, P.mud, 0.8, 0, 0); vtx(cx, GROUND_Y + top, cd, P.mud, 1, 0, 0);
    vtx(ax, GROUND_Y + base, ad, P.mud, 0.8, 0, 0); vtx(cx, GROUND_Y + top, cd, P.mud, 1, 0, 0); vtx(dx, GROUND_Y + top, dd, P.mud, 1, 0, 0);
  }
  // fronds: 7 drooping blades
  const n = 7, a0 = rand() * TAU;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU + rr(-0.2, 0.2);
    const ca = Math.cos(a), sa = Math.sin(a), L = rr(0.75, 0.95), w = 0.2;
    const mx = tx + ca * L * 0.55, md = td + sa * L * 0.55, ex = tx + ca * L, ed = td + sa * L;
    const px = -sa * w, pd = ca * w;
    const yt = GROUND_Y + top + 0.05, ym = GROUND_Y + top + 0.12, ye = GROUND_Y + top - 0.28;
    vtx(tx, yt, td, c, 0.95, 0, 0); vtx(mx - px, ym, md - pd, c, 0.95, 0, 0); vtx(mx + px, ym, md + pd, c, 1.1, 0, 0);
    vtx(mx - px, ym, md - pd, c, 0.9, 0, 0); vtx(ex, ye, ed, c, 0.8, 0, 0); vtx(mx + px, ym, md + pd, c, 1.05, 0, 0);
    vtx(tx, yt, td, c, 0.7, 0, 0); vtx(mx + px, ym, md + pd, c, 0.7, 0, 0); vtx(mx - px, ym, md - pd, c, 0.7, 0, 0);
  }
  frameId();
  shadowBlob(x + tx, d + td, 0.7, h, base);
}
function rock(x, d, r, base = -0.3, hgt = 0.5, c = P.rock) {
  frame(x, d, rand() * TAU);
  LR[0] = r; LH[0] = base; LK[0] = 0.75;
  LR[1] = r * 0.8; LH[1] = base + hgt * 0.65; LK[1] = 0.95;
  LR[2] = r * 0.3; LH[2] = base + hgt; LK[2] = 1.08;
  lathe(0, 0, 3, 6, jit(c, 0.18, TC3), 0, rr(0.8, 1.2), rr(0.8, 1.2), 0.45);
  frameId();
  if (base + hgt > 0.1) shadowDisc(x, d, r * 0.55, (base + hgt) * 0.7, 0);
}
function tree(x, d, s = 1, kind = -1, base = 0) {
  if (kind < 0) kind = rand() < 0.28 ? 1 : 0;
  if (kind === 1) treeCone(x, d, rr(0.42, 0.56) * s, rr(1.4, 2.0) * s, jit(P.pine, 0.18), base);
  else {
    const r = rand();
    const c = r < 0.4 ? P.tree1 : r < 0.72 ? P.tree2 : r < 0.93 ? P.tree3 : P.autumn;
    treeRound(x, d, rr(0.5, 0.78) * s, rr(1.0, 1.45) * s, jit(c, 0.2), base);
  }
}

// house: box + hip or gable roof, local rect centred on (x, d) with rotation
function house(x, d, w, l, h, rot, wallC, roofC, roofKind = 0, rh = 0, base = 0) {
  frame(x, d, rot);
  plain();
  sideStyle(T_RESID, 1.2, 0.55);
  box(-w / 2, -l / 2, w / 2, l / 2, base, base + h, wallC, wallC, false);
  plain();
  rh = rh || Math.min(w, l) * 0.42;
  if (roofKind === 0) hip(-w / 2 - 0.06, -l / 2 - 0.06, w / 2 + 0.06, l / 2 + 0.06, base + h, rh, roofC);
  else { topStyle(T_ROOF, 0.6, 0.5); gable(-w / 2 - 0.06, -l / 2 - 0.06, w / 2 + 0.06, l / 2 + 0.06, base + h, rh, roofC, l >= w); plain(); }
  shadowBox(-w / 2, -l / 2, w / 2, l / 2, h + rh * 0.6, base);
  frameId();
}
function car(x, d, rot, c) {
  frame(x, d, rot);
  plain();
  box(-0.17, -0.36, 0.17, 0.36, 0.0, 0.12, c, c);
  box(-0.14, -0.16, 0.14, 0.14, 0.12, 0.2, c, tint(c, P.glass, 0.6, TC3));
  frameId();
}
function truck(x, d, rot, c) {
  frame(x, d, rot);
  plain();
  box(-0.21, 0.28, 0.21, 0.6, 0, 0.26, c, c);
  box(-0.23, -0.6, 0.23, 0.22, 0, 0.3, P.oliveD, jit(P.khaki, 0.1, TC3));
  shadowBox(-0.22, -0.6, 0.22, 0.6, 0.3);
  frameId();
}
function container(x, d, rot, lvl, c) {
  frame(x, d, rot);
  sideStyle(T_CORR, 0.25, 1);
  box(-0.26, -0.62, 0.26, 0.62, lvl * 0.28, lvl * 0.28 + 0.27, c, tint(c, P.white, 0.12, TC3));
  plain();
  frameId();
}
// low-poly parked jet (nose toward local +d)
function jet(x, d, rot, c = P.metal, s = 1) {
  frame(x, d, rot);
  plain();
  const L = 0.9 * s, W = 0.8 * s;
  checkTall(-W, -L, W, L, 0.36 * s);
  if (room(60)) {
    const y0 = GROUND_Y + 0.12 * s, y1 = GROUND_Y + 0.3 * s, yc = GROUND_Y + 0.36 * s;
    const cd = tint(c, P.glass, 0.85, TC3);
    // fuselage (diamond cross-section): 4 top faces
    const F = [[0, L], [0.13 * s, 0.35 * s], [0.13 * s, -L * 0.8], [0, -L * 0.95]];
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const a = F[i], b = F[i + 1];
        const ax = a[0] * sx, bx = b[0] * sx;
        if (sx > 0) { vtx(ax, y0, a[1], c, 0.85, 0, 0); vtx(bx, y0, b[1], c, 0.85, 0, 0); vtx(0, y1, b[1], c, 1.05, 0, 0); vtx(ax, y0, a[1], c, 0.85, 0, 0); vtx(0, y1, b[1], c, 1.05, 0, 0); vtx(0, y1, a[1] - (i === 0 ? 0.02 : 0), c, 1.05, 0, 0); }
        else { vtx(bx, y0, b[1], c, 0.9, 0, 0); vtx(ax, y0, a[1], c, 0.9, 0, 0); vtx(0, y1, a[1] - (i === 0 ? 0.02 : 0), c, 1.1, 0, 0); vtx(bx, y0, b[1], c, 0.9, 0, 0); vtx(0, y1, a[1] - (i === 0 ? 0.02 : 0), c, 1.1, 0, 0); vtx(0, y1, b[1], c, 1.1, 0, 0); }
      }
    }
    // canopy
    vtx(-0.07 * s, y1 - 0.01, 0.2 * s, cd, 1, 0, 0); vtx(0.07 * s, y1 - 0.01, 0.2 * s, cd, 1, 0, 0); vtx(0, yc, 0.55 * s, cd, 1.2, 0, 0);
    vtx(0.07 * s, y1 - 0.01, 0.2 * s, cd, 1, 0, 0); vtx(-0.07 * s, y1 - 0.01, 0.2 * s, cd, 1, 0, 0); vtx(0, yc, 0.02 * s, cd, 0.9, 0, 0);
    // wings (delta)
    const yw = GROUND_Y + 0.16 * s;
    vtx(-W, yw, -0.35 * s, c, 0.95, 0, 0); vtx(-0.1 * s, yw, -0.45 * s, c, 0.95, 0, 0); vtx(-0.1 * s, yw + 0.02, 0.35 * s, c, 1.0, 0, 0);
    vtx(0.1 * s, yw, -0.45 * s, c, 0.95, 0, 0); vtx(W, yw, -0.35 * s, c, 0.95, 0, 0); vtx(0.1 * s, yw + 0.02, 0.35 * s, c, 1.0, 0, 0);
    // tailplanes + fin
    vtx(-0.38 * s, yw, -0.92 * s, c, 0.9, 0, 0); vtx(-0.08 * s, yw, -0.9 * s, c, 0.9, 0, 0); vtx(-0.08 * s, yw, -0.6 * s, c, 0.9, 0, 0);
    vtx(0.08 * s, yw, -0.9 * s, c, 0.9, 0, 0); vtx(0.38 * s, yw, -0.92 * s, c, 0.9, 0, 0); vtx(0.08 * s, yw, -0.6 * s, c, 0.9, 0, 0);
    vtx(0, y1, -0.5 * s, c, 0.8, 0, 0); vtx(0, y1, -0.92 * s, c, 0.8, 0, 0); vtx(0, GROUND_Y + 0.62 * s, -0.95 * s, c, 1.1, 0, 0);
    vtx(0, y1, -0.92 * s, c, 0.8, 0, 0); vtx(0, y1, -0.5 * s, c, 0.8, 0, 0); vtx(0, GROUND_Y + 0.62 * s, -0.95 * s, c, 0.7, 0, 0);
  }
  // shadow: fuselage + wings
  for (let i = 0; i < 3; i++) { const ld = [L, -0.35 * s, -0.95 * s][i]; HX[i] = wx(0, ld); HD[i] = wd(0, ld); }
  HX[3] = wx(-W, -0.35 * s); HD[3] = wd(-W, -0.35 * s); HX[4] = wx(W, -0.35 * s); HD[4] = wd(W, -0.35 * s);
  const ox = 0.25 * s * SUNX * SHK, od = 0.25 * s * SUND * SHK;
  for (let i = 0; i < 5; i++) { HX[i + 5] = HX[i] + ox; HD[i + 5] = HD[i] + od; }
  shadowHull(10, GROUND_Y + L_SHADOW);
  frameId();
}
// helicopter (nose toward local +d)
function heli(x, d, rot, c) {
  frame(x, d, rot);
  plain();
  box(-0.2, -0.3, 0.2, 0.45, 0.05, 0.36, c, c);
  box(-0.06, -1.1, 0.06, -0.3, 0.2, 0.3, c, c);
  box(-0.14, 0.2, 0.14, 0.44, 0.3, 0.38, tint(c, P.glass, 0.7, TC3), tint(c, P.glass, 0.7, TC3));
  // rotor blades (thin crossed quads)
  const y = 0.44;
  flat4(-0.04, -0.9, 0.04, -0.9, 0.04, 0.9, -0.04, 0.9, y, P.rockD);
  flat4(-0.9, -0.04, 0.9, -0.04, 0.9, 0.04, -0.9, 0.04, y + 0.005, P.rockD);
  shadowBox(-0.2, -1.1, 0.2, 0.45, 0.4);
  frameId();
}

// ship hull: pointed bow toward local +d. Returns the stern local d.
function hull(L, W, h, cHull, cDeck, bow = 0.26) {
  const b = L * bow;
  PX[0] = -W / 2; PD[0] = -L / 2;
  PX[1] = W / 2; PD[1] = -L / 2;
  PX[2] = W / 2; PD[2] = L / 2 - b;
  PX[3] = W * 0.22; PD[3] = L / 2 - b * 0.25;
  PX[4] = 0; PD[4] = L / 2;
  PX[5] = -W * 0.22; PD[5] = L / 2 - b * 0.25;
  PX[6] = -W / 2; PD[6] = L / 2 - b;
  prism(7, WATER_REL - 0.1, h, cHull, cDeck);
}

// =============================================================================
// Chunk slot
// =============================================================================
class Chunk {
  constructor(world, cap) {
    this.cap = cap;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(cap * 3);
    this.col = new Uint8Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.tile = new Uint8Array(cap * 2);
    const mk = (a, n, norm = false) => { const b = new THREE.BufferAttribute(a, n, norm); b.setUsage(THREE.DynamicDrawUsage); return b; };
    g.setAttribute('position', mk(this.pos, 3));
    g.setAttribute('color', mk(this.col, 3, true));
    g.setAttribute('uv', mk(this.uv, 2));
    g.setAttribute('tile', mk(this.tile, 2));
    g.setDrawRange(0, 0);
    // tight bounds (content beyond |x|>27 is never on screen)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, GROUND_Y + 1.5, -CHUNK / 2), 35);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-40, GROUND_Y - 3, -CHUNK - 3), new THREE.Vector3(40, GROUND_Y + MAX_H, 3));
    this.geo = g;
    this.mesh = new THREE.Mesh(g, world.landMat);
    this.mesh.name = 'world-chunk';
    this.mesh.visible = false;

    const sg = new THREE.BufferGeometry();
    this.spos = new Float32Array(SH_CAP * 3);
    sg.setAttribute('position', mk(this.spos, 3));
    sg.setDrawRange(0, 0);
    sg.boundingSphere = g.boundingSphere;
    this.sgeo = sg;
    this.smesh = new THREE.Mesh(sg, world.shadowMat);
    this.smesh.name = 'world-chunk-shadows';
    this.smesh.renderOrder = -3;
    this.smesh.visible = false;

    this.k = null; this.phase = 0; this.ms = 0;
    this.n = 0; this.sn = 0;
    this.hasWater = false;
    this.viol = 0;
    // spinners: type, x, y, d, phase, speed, yaw
    this.spin = new Float32Array(16 * 7); this.nspin = 0;
    // wakes for the water mask: x, d, dirX, dirD, len, width
    this.wakes = new Float32Array(8 * 6); this.nwake = 0;
    // soft cloud-tower sprites (sky stage): x, y, d, size, squash, alpha, variant, yaw, shadow
    this.puff = new Float32Array(PUFF_PER * 9); this.npuff = 0;
  }
}

// =============================================================================
// textures
// =============================================================================
function tileNoise(S, L, seed) {
  const g = new Float32Array(L * L);
  srand(seed);
  for (let i = 0; i < L * L; i++) g[i] = rand();
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const fy = (y / S) * L, iy = Math.floor(fy), ty = fy - iy, uy = ty * ty * (3 - 2 * ty);
    const y0 = iy % L, y1 = (iy + 1) % L;
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * L, ix = Math.floor(fx), tx = fx - ix, ux = tx * tx * (3 - 2 * tx);
      const x0 = ix % L, x1 = (ix + 1) % L;
      const a = g[y0 * L + x0], b = g[y0 * L + x1], c = g[y1 * L + x0], d = g[y1 * L + x1];
      out[y * S + x] = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    }
  }
  return out;
}
function dataTex(data, w, h, { srgb = false, mip = true, repeat = true } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mip;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
// ground detail noise: R fine grain, G macro blotches, B medium, A grain 2
function makeNoiseTex() {
  const S = 256;
  const a = tileNoise(S, 64, 11), a2 = tileNoise(S, 128, 12), b = tileNoise(S, 8, 13), b2 = tileNoise(S, 16, 14), c = tileNoise(S, 32, 15);
  const d = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    d[i * 4] = clamp((a[i] * 0.6 + a2[i] * 0.4) * 255, 0, 255);
    d[i * 4 + 1] = clamp((b[i] * 0.65 + b2[i] * 0.35) * 255, 0, 255);
    d[i * 4 + 2] = clamp((c[i] * 0.7 + a[i] * 0.3) * 255, 0, 255);
    d[i * 4 + 3] = 255;
  }
  return dataTex(d, S, S);
}
// water: RG = height gradient (d/dx, d/dy; 0.5 = flat, ±0.5 ≈ ±3.5 rms), B = height, A = foam noise.
// Directional spectrum: ~30 sharpened (peaky-crest) waves travelling up-right on screen within
// ±45°, so the sea reads as wind-driven waves rather than isotropic noise. Integer wave numbers
// keep the tile seamless.
function makeWaveTex() {
  const S = 256;
  const hgt = new Float32Array(S * S);
  srand(77);
  const NW = 30, WK = new Float32Array(NW * 5);
  const wind = Math.atan2(0.9, 0.42);
  for (let n = 0; n < NW;) {
    const k = rr(2.6, 15);
    const a = wind + (rand() + rand() - 1) * 0.8;
    const kx = Math.round(Math.cos(a) * k), ky = Math.round(Math.sin(a) * k);
    if (kx * kx + ky * ky < 6) continue;
    const o = n * 5;
    WK[o] = kx; WK[o + 1] = ky; WK[o + 2] = Math.pow(Math.hypot(kx, ky), -1.3); WK[o + 3] = rand() * TAU; WK[o + 4] = 1.4 + rand() * 1.1;
    n++;
  }
  const n1 = tileNoise(S, 16, 78), n2 = tileNoise(S, 64, 80);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let h = 0;
    for (let n = 0; n < NW; n++) {
      const o = n * 5;
      const s = 0.5 + 0.5 * Math.sin(TAU * (WK[o] * u + WK[o + 1] * v) + WK[o + 3]);
      h += WK[o + 2] * (2 * Math.pow(s, WK[o + 4]) - 1);
    }
    const i = y * S + x;
    h += (n1[i] - 0.5) * 0.22 + (n2[i] - 0.5) * 0.06;
    hgt[i] = h; lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  const foam = tileNoise(S, 32, 81), foam2 = tileNoise(S, 64, 82);
  const d = new Uint8Array(S * S * 4);
  const gx = new Float32Array(S * S), gy = new Float32Array(S * S);
  let ss = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    gx[i] = hgt[y * S + ((x + 1) % S)] - hgt[y * S + ((x + S - 1) % S)];
    gy[i] = hgt[((y + 1) % S) * S + x] - hgt[((y + S - 1) % S) * S + x];
    ss += gx[i] * gx[i] + gy[i] * gy[i];
  }
  const gs = 127 / (3.5 * Math.sqrt(ss / (2 * S * S)));
  for (let i = 0; i < S * S; i++) {
    d[i * 4] = clamp(128 + gx[i] * gs, 0, 255);
    d[i * 4 + 1] = clamp(128 + gy[i] * gs, 0, 255);
    d[i * 4 + 2] = clamp(((hgt[i] - lo) / (hi - lo)) * 255, 0, 255);
    d[i * 4 + 3] = clamp((foam[i] * 0.65 + foam2[i] * 0.35) * 255, 0, 255);
  }
  return dataTex(d, S, S);
}
// clouds: 4 variants in quadrants. R = density, G = light (lit from the sun side)
// Each cloud is a cluster of soft gaussian billows, eroded by noise and mapped through a soft
// saturation curve, so edges thin out gradually (wispy) instead of ending in a hard outline.
function makeCloudTex() {
  const S = 256, H = 128;
  const d = new Uint8Array(S * S * 4);
  const dens = new Float32Array(H * H);
  srand(4242);
  for (let q = 0; q < 4; q++) {
    dens.fill(0);
    // variants: 0 cumulus cluster, 1 long stratocumulus band, 2 broken puffs, 3 big cumulus
    const ax = q === 1 ? 1.75 : q === 3 ? 1.2 : 1.3, ay = q === 1 ? 0.52 : q === 3 ? 0.9 : 0.8;
    const lobes = q === 1 ? 6 : q === 2 ? 8 : q === 3 ? 5 : 4;
    for (let c = 0; c < lobes; c++) {
      const ca = rand() * TAU, cr = q === 2 ? rr(12, 33) : rr(0, 23);
      const cx = 64 + Math.cos(ca) * cr * ax, cy = 64 + Math.sin(ca) * cr * ay;
      const n = q === 2 ? 5 + ((rand() * 5) | 0) : 10 + ((rand() * 9) | 0);
      const spread = q === 2 ? 9 : 18;
      for (let i = 0; i < n; i++) {
        const a = rand() * TAU, rad = Math.sqrt(rand()) * spread;
        const px = cx + Math.cos(a) * rad * ax, py = cy + Math.sin(a) * rad * ay;
        const fall = 1 - Math.min(0.7, Math.hypot((px - 64) / ax, (py - 64) / ay) / 62);
        const r = (q === 2 ? rr(5, 10) : rr(6.5, 14)) * fall;
        const kk = 1 / (r * r * 0.5), wgt = rr(0.45, 0.8), R = r * 2.3;
        const y0 = Math.max(0, (py - R) | 0), y1 = Math.min(H - 1, (py + R) | 0);
        const x0 = Math.max(0, (px - R) | 0), x1 = Math.min(H - 1, (px + R) | 0);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const dx = x - px, dy = y - py;
          dens[y * H + x] += wgt * Math.exp(-(dx * dx + dy * dy) * kk);
        }
      }
    }
    // erode with noise, soft saturation, fade out well inside the cell
    const nz = tileNoise(H, 8, 900 + q), nz2 = tileNoise(H, 16, 950 + q), nz3 = tileNoise(H, 32, 990 + q);
    for (let y = 0; y < H; y++) for (let x = 0; x < H; x++) {
      const i = y * H + x;
      const edge = sstep(63, 44, Math.hypot(x - 64, (y - 64) * 1.1));
      const e = dens[i] * (0.45 + 0.55 * nz[i] + 0.35 * nz2[i] + 0.2 * nz3[i]) - 0.24;
      dens[i] = e > 0 ? (1 - Math.exp(-e * 1.7)) * edge : 0;
    }
    // light: optical depth toward the sun (screen lower-left = texture −x, −y)
    const ox = (q & 1) * H, oy = (q >> 1) * H;
    for (let y = 0; y < H; y++) for (let x = 0; x < H; x++) {
      const i = y * H + x;
      const s = dens[i];
      let od = 0;
      for (let k = 1; k <= 5; k++) {
        const xs = x - k * 2.2, ys = y - k * 1.6;
        if (xs >= 0 && ys >= 0) od += dens[((ys | 0) * H) + (xs | 0)];
      }
      const light = clamp(Math.exp(-od * 0.42) * (0.8 + 0.2 * s) + 0.12 * (1 - s), 0, 1);
      const o = ((oy + y) * S + ox + x) * 4;
      d[o] = clamp(s * 255, 0, 255);
      d[o + 1] = clamp(light * 255, 0, 255);
      d[o + 2] = 0; d[o + 3] = 255;
    }
  }
  return dataTex(d, S, S, { repeat: false });
}
// texture atlas (4×4 cells of 128 px, 4 px wrap padding), drawn on a 2D canvas
function makeAtlas() {
  const S = 512, T = 128, PAD = 4, IN = T - PAD * 2;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const tc = document.createElement('canvas'); tc.width = tc.height = IN;
  const t = tc.getContext('2d', { willReadFrequently: true });
  const put = (idx) => {
    const ox = (idx & 3) * T, oy = (idx >> 2) * T;
    g.save(); g.beginPath(); g.rect(ox, oy, T, T); g.clip();
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) g.drawImage(tc, ox + PAD + a * IN, oy + PAD + b * IN);
    g.restore();
  };
  const fill = (c) => { t.fillStyle = c; t.fillRect(0, 0, IN, IN); };
  srand(31337);
  const grain = (a, lo = 0, hi = 255) => {
    const im = t.getImageData(0, 0, IN, IN);
    for (let i = 0; i < im.data.length; i += 4) {
      const n = (rand() - 0.5) * a;
      im.data[i] = clamp(im.data[i] + n, lo, hi); im.data[i + 1] = clamp(im.data[i + 1] + n, lo, hi); im.data[i + 2] = clamp(im.data[i + 2] + n, lo, hi);
    }
    t.putImageData(im, 0, 0);
  };
  // 0 white
  fill('#ffffff'); put(T_WHITE);
  // 1 office: 4×3 glass panes with light mullions
  fill('#e9e9e6');
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    const x = c * 30 + 3, y = r * 40 + 7;
    const k = 0.85 + rand() * 0.3;
    const gr = t.createLinearGradient(x, y, x + 24, y + 30);
    gr.addColorStop(0, `rgb(${(96 * k) | 0},${(116 * k) | 0},${(136 * k) | 0})`);
    gr.addColorStop(1, `rgb(${(70 * k) | 0},${(86 * k) | 0},${(104 * k) | 0})`);
    t.fillStyle = gr; t.fillRect(x, y, 25, 30);
    t.fillStyle = 'rgba(255,255,255,0.12)'; t.fillRect(x, y, 25, 4);
  }
  put(T_OFFICE);
  // 2 residential: 3×3 windows with sills
  fill('#f1efe9');
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const x = c * 40 + 11, y = r * 40 + 10;
    t.fillStyle = '#5f6972'; t.fillRect(x, y, 18, 20);
    t.fillStyle = '#7d8993'; t.fillRect(x + 2, y + 2, 6, 16);
    t.fillStyle = '#c9c6bf'; t.fillRect(x - 3, y + 20, 24, 4);
  }
  grain(10); put(T_RESID);
  // 3 brick / industrial: ribbon windows over a brick hatch
  fill('#dcd3c9');
  t.fillStyle = 'rgba(120,90,70,0.18)';
  for (let y = 0; y < IN; y += 8) { t.fillRect(0, y, IN, 1); for (let x = (y / 8) % 2 ? 0 : 10; x < IN; x += 20) t.fillRect(x, y, 1, 8); }
  t.fillStyle = '#5a646c'; t.fillRect(0, 22, IN, 22); t.fillRect(0, 82, IN, 22);
  t.fillStyle = '#c8c0b4'; for (let x = 0; x < IN; x += 20) { t.fillRect(x, 22, 3, 22); t.fillRect(x, 82, 3, 22); }
  grain(12); put(T_BRICK);
  // 4 crop rows (horizontal stripes)
  for (let y = 0; y < IN; y++) {
    const v = 0.8 + 0.2 * Math.sin((y / IN) * TAU * 10);
    t.fillStyle = `rgb(${(255 * v) | 0},${(255 * v) | 0},${(255 * v) | 0})`; t.fillRect(0, y, IN, 1);
  }
  grain(26, 150, 255); put(T_ROWS);
  // 5 corrugated metal (vertical ridges)
  for (let x = 0; x < IN; x++) {
    const v = 0.78 + 0.22 * Math.sin((x / IN) * TAU * 12);
    t.fillStyle = `rgb(${(255 * v) | 0},${(255 * v) | 0},${(255 * v) | 0})`; t.fillRect(x, 0, 1, IN);
  }
  grain(10, 160, 255); put(T_CORR);
  // 6 roof tiles (courses)
  fill('#f2f2f2');
  for (let y = 0; y < IN; y += 12) {
    t.fillStyle = 'rgba(0,0,0,0.22)'; t.fillRect(0, y + 10, IN, 2);
    t.fillStyle = 'rgba(0,0,0,0.1)'; for (let x = (y / 12) % 2 ? 0 : 7.5; x < IN; x += 15) t.fillRect(x, y, 1, 10);
  }
  grain(18, 120, 255); put(T_ROOF);
  // 7 glass grid (greenhouses / solar)
  fill('#f4f7f8');
  t.fillStyle = '#b9c4ca';
  for (let x = 0; x < IN; x += 20) t.fillRect(x, 0, 2, IN);
  for (let y = 0; y < IN; y += 30) t.fillRect(0, y, IN, 2);
  put(T_GLASS);
  // 8 parking lot (full colour): asphalt + stall lines
  fill('#4a4d52'); grain(14);
  t.fillStyle = '#c9c6bd';
  for (let x = 0; x < IN; x += 20) { t.fillRect(x, 6, 2, 46); t.fillRect(x, 68, 2, 46); }
  put(T_PARK);
  // 9 concrete slabs (joint grid)
  fill('#f0efec'); grain(16, 170, 255);
  t.fillStyle = 'rgba(40,40,40,0.28)';
  t.fillRect(0, 0, IN, 2); t.fillRect(0, IN / 2, IN, 2); t.fillRect(0, 0, 2, IN); t.fillRect(IN / 2, 0, 2, IN);
  put(T_SLAB);
  // 10 helipad (full colour)
  fill('#8e8c86'); grain(10);
  t.strokeStyle = '#d4b24c'; t.lineWidth = 7; t.beginPath(); t.arc(IN / 2, IN / 2, IN / 2 - 10, 0, TAU); t.stroke();
  t.fillStyle = '#e8e6de'; t.fillRect(38, 30, 12, 60); t.fillRect(70, 30, 12, 60); t.fillRect(38, 54, 44, 12);
  put(T_HELI);
  // 11/12 runway numbers (full colour, white on asphalt)
  for (const [idx, txt] of [[T_R36, '36'], [T_R18, '18']]) {
    fill('#6f6f6a'); grain(8);                      // = P.runway, so the digits sit on the runway itself
    t.fillStyle = '#dcdad2'; t.font = 'bold 96px sans-serif'; t.textAlign = 'center'; t.textBaseline = 'middle';
    t.save(); t.translate(IN / 2, IN / 2); t.scale(0.7, 1.12); t.fillText(txt, 0, 4); t.restore();
    put(idx);
  }
  // 13 football pitch (full colour)
  for (let y = 0; y < IN; y++) { t.fillStyle = (Math.floor(y / 10) % 2) ? '#5f7c47' : '#56733f'; t.fillRect(0, y, IN, 1); }
  t.strokeStyle = '#d9dcd0'; t.lineWidth = 2;
  t.strokeRect(10, 6, IN - 20, IN - 12); t.beginPath(); t.moveTo(10, IN / 2); t.lineTo(IN - 10, IN / 2); t.stroke();
  t.beginPath(); t.arc(IN / 2, IN / 2, 14, 0, TAU); t.stroke();
  t.strokeRect(IN / 2 - 26, 6, 52, 18); t.strokeRect(IN / 2 - 26, IN - 24, 52, 18);
  put(T_PITCH);
  // 14 shutter / hangar door panels
  fill('#e8e8e8');
  t.fillStyle = 'rgba(0,0,0,0.2)'; for (let y = 0; y < IN; y += 10) t.fillRect(0, y, IN, 2);
  t.fillStyle = 'rgba(0,0,0,0.12)'; for (let x = 0; x < IN; x += 40) t.fillRect(x, 0, 2, IN);
  grain(8); put(T_SHUTTER);
  // 15 gravel roof
  fill('#eeeeee'); grain(60, 140, 255); put(T_GRAVEL);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}

// =============================================================================
// shaders
// =============================================================================
const WATER_VERT = /* glsl */`
varying vec3 vW;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
// Seamless scrolling: st.y wraps every NOISE_SPAN (256) stage units and uTime every TIME_WRAP
// (1000 s). So every texture frequency along st.y is k/256 and every sine frequency along it is
// 2πk/256; every texture drift speed is k/1000 per second and every sine speed 2πk/1000.
// (A frequency that breaks this makes the whole sea visibly jump once per wrap.)
const WATER_FRAG = /* glsl */`
uniform sampler2D uWave;
uniform sampler2D uMask;
uniform vec3 uScroll;             // (time, d mod mask span, d mod noise span): vector fields, so
uniform vec4 uLook;               // per-frame writes don't box doubles on the JS side
uniform float uWaterRel;
uniform vec3 uDeep, uShallow, uSky, uFoam, uGlint, uGlintDir, uInland;
#define uTime uScroll.x
#define uDM uScroll.y
#define uDN uScroll.z
#define uCaps uLook.x
#define uRelief uLook.y
#define uSpark uLook.z
#define uSheen uLook.w
varying vec3 vW;
#include <fog_pars_fragment>
void main() {
  vec2 st = vec2(vW.x, uDN - vW.z);                       // stage coordinates (x, d mod 256)
  vec4 m = texture2D(uMask, vec2((vW.x + 40.0) / 80.0, (uDM - vW.z) / ${MASK_SPAN.toFixed(1)}));
  float h = (m.r - 0.5) * 4.0;
  float depth = max(uWaterRel - h, 0.0);
  float calm = m.b;
  float open = 1.0 - calm;
  float t = uTime;
  // wave layers (gradients in stage space (d/dx, d/dd)): long swell, a chop rotated 36.87°
  // (the 3-4-5 rotation keeps its st.y coefficients at k/256) and fine ripples on HIGH
  vec4 w1 = texture2D(uWave, st * 0.03125 - vec2(0.009, 0.019) * t);
  vec4 w2 = texture2D(uWave, vec2(dot(st, vec2(16.0, -12.0)), dot(st, vec2(12.0, 16.0))) * 0.00390625 - vec2(0.013, 0.024) * t);
  vec2 g2 = (w2.xy - 0.5) * 2.0;
  vec2 g = (w1.xy - 0.5) * 2.0 + vec2(g2.x * 0.8 + g2.y * 0.6, g2.y * 0.8 - g2.x * 0.6) * 0.75;
  float hgt = w1.b * 0.6 + w2.b * 0.4;
  float fn = w1.a * 0.6 + w2.a * 0.4;
#ifndef LOW
  vec4 w3 = texture2D(uWave, st * 0.125 - vec2(0.017, 0.036) * t);
  g += (w3.xy - 0.5) * 1.2;
  float fine = w3.b;
#else
  float fine = w2.b;
#endif
  float sh = smoothstep(0.0, 1.9, depth);
  float amp = mix(1.0, 0.35, calm) * mix(0.3, 1.0, smoothstep(0.03, 0.9, depth));
  // body colour: shallow → deep; calm inland water is darker/greener; slow large-scale patches
  vec3 col = mix(uShallow, uDeep, sh);
  col = mix(col, uInland, calm * 0.65);
  float macro = texture2D(uWave, st * 0.0078125 - vec2(0.002, 0.004) * t).b;
  col *= 0.92 + 0.16 * macro * open;
  // long swell bands (open water only)
  float swell = sin(st.y * 0.53996 + st.x * 0.18 + fn * 2.6 + t * 0.55292) * 0.5 + 0.5;
  col *= 1.0 + (swell - 0.5) * 0.1 * open * sh;
  // wave relief: facets tilted toward the sun (screen lower-left) are lit, the others shaded
  float relief = dot(g, vec2(0.814, 0.581)) * amp;
  col *= 1.0 + clamp(relief, -1.2, 1.2) * uRelief;
  col = mix(col, uSky, 0.07 * amp);
  // sun path: a soft sheen where the mean surface mirrors the glint direction, and glitter
  // from the wave facets that mirror it (spread around that point by the wave slopes)
  vec3 V = normalize(cameraPosition - vW);
  vec3 Dv = V - vec3(-uGlintDir.x, uGlintDir.y, -uGlintDir.z);
  float dq = Dv.y * Dv.y + Dv.z * Dv.z;
  float lobe = exp(-Dv.x * Dv.x * 700.0 - dq * 9.0);          // soft path glow
  float path = exp(-Dv.x * Dv.x * 1300.0 - dq * 10.0);        // where glitter may appear
  float sheen = lobe * (0.35 + 0.65 * smoothstep(0.35, 0.8, hgt * 0.5 + fine * 0.5)) * uSheen;
  vec3 N = normalize(vec3(-g.x * amp * 0.42, 1.0, g.y * amp * 0.42));
  float s = max(dot(N, normalize(V + uGlintDir)), 0.0);
#ifndef LOW
  float spark = pow(s, 1300.0) * smoothstep(0.03, 0.5, path);
#else
  float spark = pow(s, 700.0) * smoothstep(0.03, 0.5, path) * 0.7;
#endif
  col += uGlint * (sheen + spark * uSpark) * (1.0 - calm * 0.75);
  // foam: shoreline, incoming surf bands, wakes, small crisp whitecaps on the crests
  float shoreLine = 1.0 - smoothstep(0.0, 0.08 + 0.14 * fn, depth);
  float bands = smoothstep(0.7, 0.95, sin(depth * 7.0 - t * 1.50168 + fn * 5.0) * 0.5 + 0.5)
              * (1.0 - smoothstep(0.05, 0.6, depth)) * (1.0 - calm * 0.8) * smoothstep(0.35, 0.65, fn);
  float wake = m.g * smoothstep(0.3, 0.72, fn + m.g * 0.3);
  float crest = fine * 0.55 + hgt * 0.45;
  float caps = smoothstep(0.76, 0.82, crest) * smoothstep(0.52, 0.72, fn) * uCaps * open * sh;
  float foam = clamp(shoreLine * mix(0.8, 0.45, calm) + bands * 0.5 + wake * 0.7 + caps * 0.6, 0.0, 1.0);
  col = mix(col, uFoam, foam);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
const CLOUD_VERT = /* glsl */`
attribute float aAlpha;
attribute vec2 aVar;
varying vec2 vUv;
varying float vA;
#include <fog_pars_vertex>
void main() {
  vUv = uv * 0.5 + aVar;
  vA = aAlpha;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const CLOUD_FRAG = /* glsl */`
uniform sampler2D uTex;
uniform vec3 uLit, uShade;
uniform float uK;
varying vec2 vUv;
varying float vA;
#include <fog_pars_fragment>
void main() {
  vec4 c = texture2D(uTex, vUv);
  float a = c.r * vA * uK;
  if (a < 0.003) discard;
#ifdef SHADOW
  gl_FragColor = vec4(uShade, a);
#else
  gl_FragColor = vec4(mix(uShade, uLit, smoothstep(0.15, 0.85, c.g)), a);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
// Cloud-sea deck (sky stage). Same seam rules as the water: st.y = d mod 256 and uTime wraps at
// 1000 s, so every noise frequency along st.y is k/256 and every drift k/1000. The lower layer
// seen through the gaps scrolls with its own 0.62·d mod 256 (slower = deeper) under the same rule.
// Two fetches give three octaves each (noise G: masses/gaps, B: billow cells, R: lumps); a 3-4-5
// rotated fetch keeps the value-noise lattice from lining up. Billow noise |2n − 1| turns the
// value noise into rounded cumulus cells with dark creases between them; a second pair of taps
// toward the sun lights them (a surface is lit where it rises away from the sun).
const DECK_FRAG = /* glsl */`
uniform sampler2D uNoise;
uniform vec3 uScroll;             // (time, d mod 256, 0.62·d mod 256)
uniform vec4 uLook;               // (cover, -, -, -)
uniform vec3 uFlash;              // lightning under the deck: world x, world z, strength
uniform vec3 uLit, uShade, uAbyss, uRim;
varying vec3 vW;
#include <fog_pars_fragment>
// billow noise shaped into soft domes: 0 in the creases, rounded valleys and tops
float dome(float n) { return smoothstep(0.0, 0.85, abs(n * 2.0 - 1.0)); }
void main() {
  float t = uScroll.x;
  vec2 st = vec2(vW.x, uScroll.y - vW.z);                                  // stage coordinates
  vec2 um = st * 0.00390625 + vec2(0.003, 0.002) * t;                         // period 256 u
  vec2 ur = vec2(dot(st, vec2(4.0, -3.0)), dot(st, vec2(3.0, 4.0))) * 0.00390625 + vec2(-0.004, 0.006) * t;   // 51.2 u
  vec4 m = texture2D(uNoise, um);
  // taps 0.8 units toward the sun (screen lower-left = stage −x, −d)
  const vec2 so = vec2(-0.6512, -0.4648);
  vec4 ms = texture2D(uNoise, um + so * 0.00390625);
  // the macro fetch warps the rotated one (≈ ±2 u): value noise has no gradient across its lattice
  // lines, and unwarped they show up as long straight creases
  vec4 r = texture2D(uNoise, ur + (m.rb - 0.5) * 0.075);
  vec4 rs = texture2D(uNoise, ur + vec2(dot(so, vec2(4.0, -3.0)), dot(so, vec2(3.0, 4.0))) * 0.00390625 + (ms.rb - 0.5) * 0.075);
  // billow height: rounded 6.4/3.2 u cells and 1.6 u lumps from the rotated fetch (5 texels per
  // unit: smooth creases), riding on the 8/4 u swell of the unrotated one
  float cell = dome(r.g), cell1 = dome(rs.g);
  float h0 = cell * 0.66 + dome(r.b) * 0.12 + m.b * 0.22;
  float h1 = cell1 * 0.66 + dome(rs.b) * 0.12 + ms.b * 0.22;
  // coverage: 32/16 u masses with gaps between them (edges follow the billows); uLook.x = cover
  float mass = m.g * 0.8 + h0 * 0.2;
  float mass1 = ms.g * 0.8 + h1 * 0.2;
  float edge = mix(0.72, 0.36, uLook.x);
  float thick = smoothstep(edge - 0.03, edge + 0.07, mass);
  float lit = clamp(0.52 + (h0 - h1) * 2.3 + (mass - mass1) * 3.0, 0.0, 1.0);
  lit = lit * lit * (3.0 - 2.0 * lit);
  vec3 top = mix(uShade, uLit, lit);
  top *= mix(0.78, 1.0, smoothstep(0.0, 0.55, cell));                         // soft creases between the cells
  top += uRim * thick * (1.0 - thick) * 2.4 * (0.25 + 0.75 * lit) * 0.35;     // bright thin edges
  // the lower layer far below (slower, finer, bluer), shaded where the deck hangs sunward of it
#ifndef LOW
  vec2 s2 = vec2(vW.x * 1.25, uScroll.z - vW.z * 1.25);
  vec4 l = texture2D(uNoise, s2 * 0.0078125 + vec2(0.002, -0.003) * t);
  float lc = smoothstep(0.34, 0.72, l.g) * (0.45 + 0.55 * dome(l.b));
  vec3 lower = mix(uAbyss, mix(uAbyss, uShade, 0.5), lc);
  float over = smoothstep(edge - 0.03, edge + 0.07, texture2D(uNoise, um + vec2(-3.26, -2.32) * 0.00390625).g * 0.8 + 0.1);
  lower *= mix(1.0, 0.62, over);
#else
  float lc = smoothstep(0.3, 0.8, m.r) * 0.5;                                // LOW: 4 fetches in all
  vec3 lower = mix(uAbyss, mix(uAbyss, uShade, 0.5), lc);
#endif
  vec3 col = mix(lower, top, thick);
  // lightning inside the storm band: a brief glow from under the deck
  vec2 fd = vW.xz - uFlash.xy;
  float fl = uFlash.z * exp(-dot(fd, fd) * 0.0065);
  col += vec3(0.62, 0.7, 1.0) * fl * (0.6 + 0.5 * (1.0 - thick) + 0.2 * lc) * (0.6 + 0.4 * (1.0 - lit));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// =============================================================================
// time of day
// =============================================================================
const TOD_SRC = [
  { d: -60, sun: 0xffdcb8, sunI: 2.05, sky: 0xb7cbe6, gnd: 0x4a4038, hemiI: 1.05, fog: 0xa3b9cf, near: 44, far: 150,
    deep: 0x22485e, shallow: 0x2f777b, wsky: 0x7e9cb8, foam: 0xd7dfe0, inland: 0x3d5a55, glint: 0xffe2c2, glintI: 1.1, gdir: [0.13, 0.85, -0.5],
    cLit: 0xf2ebe2, cShade: 0x8d9bb2, shadow: 0x1c2638, shA: 0.34, shK: 1.25, caps: 0.55, cloud: 1.0, relief: 0.3, spark: 0.5, sheen: 0.12 },
  { d: 240, sun: 0xffeedb, sunI: 2.3, sky: 0xc2d6ef, gnd: 0x463e34, hemiI: 1.08, fog: 0xa8c1d8, near: 50, far: 158,
    deep: 0x1f4a61, shallow: 0x2e7f82, wsky: 0x83a4c2, foam: 0xdbe3e4, inland: 0x3d5b52, glint: 0xfff0dc, glintI: 1.0, gdir: [0.08, 0.86, -0.5],
    cLit: 0xf7f4ee, cShade: 0x93a3b8, shadow: 0x1c2638, shA: 0.34, shK: 1.1, caps: 0.5, cloud: 0.9, relief: 0.3, spark: 0.48, sheen: 0.11 },
  { d: 500, sun: 0xfff5e8, sunI: 2.45, sky: 0xcddff5, gnd: 0x423c32, hemiI: 1.1, fog: 0xaac5dc, near: 56, far: 168,
    deep: 0x244d5f, shallow: 0x2f7478, wsky: 0x8aabc6, foam: 0xdde4e3, inland: 0x405c50, glint: 0xfff6ea, glintI: 0.9, gdir: [0.0, 0.92, -0.39],
    cLit: 0xfaf8f4, cShade: 0x98a8bc, shadow: 0x1a2432, shA: 0.36, shK: 0.95, caps: 0.45, cloud: 0.72, relief: 0.28, spark: 0.5, sheen: 0.1 },
  { d: 790, sun: 0xffecd4, sunI: 2.4, sky: 0xc7d6ea, gnd: 0x453c31, hemiI: 1.07, fog: 0xb1c1d1, near: 54, far: 164,
    deep: 0x264a5c, shallow: 0x327274, wsky: 0x8ea8bf, foam: 0xdfe2de, inland: 0x425a4e, glint: 0xfff0dc, glintI: 0.9, gdir: [-0.08, 0.86, -0.5],
    cLit: 0xfaf3ea, cShade: 0x9aa4b6, shadow: 0x1e2230, shA: 0.36, shK: 1.05, caps: 0.4, cloud: 0.5, relief: 0.28, spark: 0.5, sheen: 0.1 },
  { d: 1090, sun: 0xffd3a4, sunI: 2.35, sky: 0xc4c4d8, gnd: 0x4a3c30, hemiI: 1.0, fog: 0xc0ae9c, near: 52, far: 160,
    deep: 0x2b4556, shallow: 0x3d6a6a, wsky: 0xa89aa5, foam: 0xe6dccf, inland: 0x4a5448, glint: 0xffd6a8, glintI: 1.1, gdir: [-0.1, 0.82, -0.56],
    cLit: 0xffe2c6, cShade: 0x9a8ea4, shadow: 0x261d2e, shA: 0.38, shK: 1.35, caps: 0.45, cloud: 0.62, relief: 0.3, spark: 0.55, sheen: 0.12 },
  { d: 1275, sun: 0xff9f70, sunI: 1.85, sky: 0x8c84ad, gnd: 0x3b2a33, hemiI: 0.92, fog: 0x7a6a8c, near: 46, far: 150,
    deep: 0x223454, shallow: 0x2e4f63, wsky: 0x76699a, foam: 0xa89cb0, inland: 0x33404a, glint: 0xffb488, glintI: 1.05, gdir: [-0.08, 0.8, -0.6],
    cLit: 0xf2c1b4, cShade: 0x5e5684, shadow: 0x1a1230, shA: 0.4, shK: 1.5, caps: 0.22, cloud: 0.78, relief: 0.32, spark: 0.6, sheen: 0.14 },
];
// dLit/dShade/dAbyss/dRim, cover and flash drive the sky stage's cloud deck (lit tops, shaded
// billows, what shows through the gaps, the silver lining; deck coverage, lightning strength)
const TOD_COLS = ['sun', 'sky', 'gnd', 'fog', 'deep', 'shallow', 'wsky', 'foam', 'inland', 'glint', 'cLit', 'cShade', 'shadow',
  'dLit', 'dShade', 'dAbyss', 'dRim'];
const TOD_NUMS = ['sunI', 'hemiI', 'near', 'far', 'glintI', 'shA', 'shK', 'caps', 'cloud', 'relief', 'spark', 'sheen', 'cover', 'flash'];
// indices into the interpolated numeric array (order of TOD_NUMS)
const N_SUNI = 0, N_HEMII = 1, N_NEAR = 2, N_FAR = 3, N_GLINTI = 4, N_SHA = 5, N_CAPS = 7, N_CLOUD = 8,
  N_RELIEF = 9, N_SPARK = 10, N_SHEEN = 11, N_COVER = 12, N_FLASH = 13;
// fields a stage's keys may leave out (water on dry stages, the deck on non-sky stages)
const TOD_DEFAULTS = {
  deep: 0x1f4a61, shallow: 0x2e7f82, wsky: 0x83a4c2, foam: 0xdbe3e4, inland: 0x3d5b52, glint: 0xfff0dc, glintI: 1.0, gdir: [0.08, 0.86, -0.5],
  caps: 0.5, relief: 0.3, spark: 0.48, sheen: 0.11,
  dLit: 0xf2f5fa, dShade: 0x9aabc6, dAbyss: 0x1d4274, dRim: 0xffffff, cover: 0.7, flash: 0,
};
function makeTod(src) {
  return src.map((k0) => {
    const k = { ...TOD_DEFAULTS, ...k0 };
    const o = { d: k.d, gdir: new THREE.Vector3().fromArray(k.gdir).normalize(), n: new Float64Array(TOD_NUMS.length) };
    for (const c of TOD_COLS) o[c] = new THREE.Color(k[c]);
    for (let i = 0; i < TOD_NUMS.length; i++) { o[TOD_NUMS[i]] = k[TOD_NUMS[i]]; o.n[i] = k[TOD_NUMS[i]]; }
    return o;
  });
}
function todShadowK(d) {
  const TOD = S.tod;
  let i = 0;
  while (i < TOD.length - 2 && d > TOD[i + 1].d) i++;
  return lerp(TOD[i].shK, TOD[i + 1].shK, sstep(TOD[i].d, TOD[i + 1].d, d));
}
// cloud density per biome (multiplied with the time-of-day cloud factor)
const CLOUD_BIOME = { ocean: 1.0, coast: 0.85, country: 0.75, city: 0.45, base: 0.6, sea: 0.85 };

// debugging hooks for the dev page (not part of the game contract)
export const __worldDebug = {
  ISL, biomeOf, terrainH: (x, d) => S.terrainH(x, d), stage: () => S.id,
  blocked: (x0, x1, d0, d1) => blocked(x0, x1, d0, d1, 0),
};

// =============================================================================
// World
// =============================================================================
const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4();
const _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _s3 = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const CLOUD_MAX = 14;
const PUFF_PER = 28, PUFF_MAX = 112;      // cloud-tower sprites per chunk / in all (≤ 4 chunks are laid out)

export class World {
  constructor({ scene, renderer = null, sun = null, hemi = null, quality = 'high', stage = 'coastal' } = {}) {
    this.scene = scene; this.renderer = renderer; this.sun = sun; this.hemi = hemi;
    this.quality = quality === 'low' ? 'low' : 'high';
    S = WORLD_STAGES[stage] || WORLD_STAGES.coastal;
    this._d = 0; this._t = 0; this._clock = 0; this._todD = NaN;
    this.root = new THREE.Group();
    this.root.name = 'World';
    scene.add(this.root);
    if (!scene.fog) scene.fog = new THREE.Fog(0xa8c1d8, 50, 160);
    this._bg = new THREE.Color(0xa8c1d8);
    scene.background = this._bg;

    // textures (5)
    this.tex = { atlas: makeAtlas(), noise: makeNoiseTex(), wave: makeWaveTex(), cloud: makeCloudTex(), mask: null };
    this.maskData = new Uint8Array(MASK_W * MASK_H * 4);
    for (let i = 0; i < MASK_W * MASK_H; i++) { this.maskData[i * 4] = 0; this.maskData[i * 4 + 3] = 255; }
    this.tex.mask = dataTex(this.maskData, MASK_W, MASK_H, { mip: false });
    this.tex.mask.wrapS = THREE.ClampToEdgeWrapping;
    this.tex.mask.wrapT = THREE.RepeatWrapping;
    this._maskSlot = new Int32Array(MASK_H / ROWS_PER_CHUNK).fill(-99999);
    this._maskDirty = false;

    // shared uniforms
    this.uDN = { value: new THREE.Vector2() };
    // land material: vertex colours × tiled atlas × world-space detail noise. Most ground is the
    // white tile 0 (cell (0, 3) in shader space) with a constant uv: with zero gradients
    // textureGrad would read one white texel at LOD 0, so those pixels skip the fetch (the
    // derivatives stay outside the branch; tile 0 with a varying uv still samples as before)
    const landMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, map: this.tex.atlas, color: new THREE.Color(COL_SCALE, COL_SCALE, COL_SCALE) });
    landMat.onBeforeCompile = (sh) => {
      sh.uniforms.uNoise = { value: this.tex.noise };
      sh.uniforms.uDN = this.uDN;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 tile;\nvarying vec2 vTile;\nvarying vec2 vStage;\nuniform vec2 uDN;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tvTile = tile;\n\t{ vec4 cbw = modelMatrix * vec4(transformed, 1.0); vStage = vec2(cbw.x, uDN.x - cbw.z); }');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTile;\nvarying vec2 vStage;\nuniform sampler2D uNoise;')
        .replace('#include <map_fragment>', /* glsl */`
#ifdef USE_MAP
  {
    vec2 cbF = fract(vMapUv);
    vec2 cbDx = dFdx(vMapUv) * (120.0 / 512.0), cbDy = dFdy(vMapUv) * (120.0 / 512.0);
    if (vTile.x > 0.5 || vTile.y < 2.5 || cbDx != vec2(0.0) || cbDy != vec2(0.0)) {
      vec2 cbA = (vTile * 128.0 + 4.0 + cbF * 120.0) / 512.0;
      diffuseColor *= textureGrad(map, cbA, cbDx, cbDy);
    }
  }
#endif
  {
    float cbN = texture2D(uNoise, vStage * (1.0 / 32.0)).r;
    float cbM = texture2D(uNoise, vStage * (1.0 / 128.0)).g;
    diffuseColor.rgb *= (0.88 + 0.24 * cbN) * (0.93 + 0.14 * cbM);
  }`);
    };
    landMat.customProgramCacheKey = () => 'crimson-bolt-land-v3';
    this.landMat = landMat;
    this.shadowMat = new THREE.MeshBasicMaterial({ color: 0x1a2432, transparent: true, opacity: 0.34, depthWrite: false });
    this.propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

    // chunks
    this.chunks = [];
    for (let i = 0; i < SLOTS; i++) {
      const ch = new Chunk(this, CAP_HIGH);
      this.chunks.push(ch);
      this.root.add(ch.mesh, ch.smesh);
    }

    // water
    this._initWater();
    // cloud-sea deck (sky stage)
    this._initDeck();
    // clouds
    this._initClouds();
    this._initPuffs();
    // spinners
    this._initSpinners();

    // time of day scratch
    this._tod = {};
    for (const c of TOD_COLS) this._tod[c] = new THREE.Color();
    this._tod.gdir = new THREE.Vector3();
    this._todN = new Float64Array(TOD_NUMS.length);
    this._sunDir = new THREE.Vector3(-14, 30, 10).normalize();
    this.stats = { builds: 0, lastBuildMs: 0, maxBuildMs: 0, maxSliceMs: 0, violations: 0, violationLog: [] };
    VIOL_LOG = this.stats.violationLog;

    this.setQuality(this.quality, true);
    this.reset(0);
  }

  get distance() { return this._d; }
  // current stage world id ('coastal' | 'canyon' | 'skies') and its biome layout
  get stage() { return S.id; }
  get layout() { return S.layout; }

  biomeAt(d) { return biomeOf(d); }

  // Switch the stage world. Call it BEFORE reset(d): it drops every chunk (reset rebuilds them;
  // without a reset, update() rebuilds the visible ones on its next call). Same stage = no-op.
  setStage(id) {
    const st = WORLD_STAGES[id];
    if (!st) console.warn(`[world] unknown stage '${id}', using coastal`);
    const next = st || WORLD_STAGES.coastal;
    if (next === S) return false;
    S = next;
    for (const ch of this.chunks) { ch.k = null; ch.phase = 0; ch.mesh.visible = false; ch.smesh.visible = false; ch.nspin = 0; ch.npuff = 0; }
    this._maskSlot.fill(-99999);
    this.water.visible = false;
    this.deck.visible = S.deck;
    this.puffs.visible = S.deck; this.puffShadows.visible = S.deck;
    this.radars.count = 0; this.rotors.count = 0; this.puffs.count = 0; this.puffShadows.count = 0;
    this._applyTod();
    return true;
  }

  // ---------------------------------------------------------------------------
  _initWater() {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uWave: { value: null }, uMask: { value: null }, uScroll: { value: new THREE.Vector3() },
      uWaterRel: { value: WATER_REL }, uLook: { value: new THREE.Vector4(0.5, 0.3, 0.5, 0.1) },
      uDeep: { value: new THREE.Color() }, uShallow: { value: new THREE.Color() }, uSky: { value: new THREE.Color() },
      uFoam: { value: new THREE.Color() }, uGlint: { value: new THREE.Color() }, uInland: { value: new THREE.Color() },
      uGlintDir: { value: new THREE.Vector3(0, 1, 0) },
    }]);
    uniforms.uWave.value = this.tex.wave;
    uniforms.uMask.value = this.tex.mask;
    this.waterMat = new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, fog: true });
    const g = new THREE.PlaneGeometry(84, 124, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(g, this.waterMat);
    this.water.name = 'world-water';
    this.water.position.set(0, WATER_Y, -12);
    this.water.renderOrder = 1;       // after opaque terrain: early-z skips hidden water
    this.root.add(this.water);
  }

  // The sky stage's "ground": a sunlit cloud sea at GROUND_Y (so core's aircraft shadows lie on
  // it), one opaque plane like the water. Hidden on the other stages; three's compile() walks
  // hidden objects too, so main.js's precompile still builds both LOW/HIGH programs for it.
  _initDeck() {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uNoise: { value: null }, uScroll: { value: new THREE.Vector3() }, uLook: { value: new THREE.Vector4(0.7, 0, 0, 0) },
      uFlash: { value: new THREE.Vector3() },
      uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uAbyss: { value: new THREE.Color() }, uRim: { value: new THREE.Color() },
    }]);
    uniforms.uNoise.value = this.tex.noise;
    this.deckMat = new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VERT, fragmentShader: DECK_FRAG, fog: true });
    const g = new THREE.PlaneGeometry(84, 124, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.deck = new THREE.Mesh(g, this.deckMat);
    this.deck.name = 'world-cloud-deck';
    this.deck.position.set(0, GROUND_Y, -12);
    this.deck.visible = S.deck;
    this.root.add(this.deck);
  }

  _initClouds() {
    const base = new THREE.PlaneGeometry(1, 1);
    base.rotateX(-Math.PI / 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.cloudAlpha = new Float32Array(CLOUD_MAX);
    this.cloudVar = new Float32Array(CLOUD_MAX * 2);
    const aA = new THREE.InstancedBufferAttribute(this.cloudAlpha, 1); aA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', aA);
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(this.cloudVar, 2));
    this.cloudGeo = geo;
    const mkMat = (shadow) => {
      const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTex: { value: null }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uK: { value: 1 } }]);
      u.uTex.value = this.tex.cloud;
      return new THREE.ShaderMaterial({
        uniforms: u, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, fog: true,
        transparent: true, depthWrite: false, defines: shadow ? { SHADOW: '' } : {},
      });
    };
    this.cloudMat = mkMat(false);
    this.cloudShadowMat = mkMat(true);
    this.clouds = new THREE.InstancedMesh(geo, this.cloudMat, CLOUD_MAX);
    this.clouds.name = 'world-clouds';
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 1;      // after core's aircraft shadows (0), before fx/bullets (2..10)
    this.cloudShadows = new THREE.InstancedMesh(geo, this.cloudShadowMat, CLOUD_MAX);
    this.cloudShadows.name = 'world-cloud-shadows';
    this.cloudShadows.frustumCulled = false;
    this.cloudShadows.renderOrder = -2;
    this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cloudShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.clouds, this.cloudShadows);
    // per-cloud state: stage position, x, y, size, alpha, rotation
    this.cl = { cd: new Float64Array(CLOUD_MAX), x: new Float32Array(CLOUD_MAX), y: new Float32Array(CLOUD_MAX),
      s: new Float32Array(CLOUD_MAX), a: new Float32Array(CLOUD_MAX), r: new Float32Array(CLOUD_MAX), sq: new Float32Array(CLOUD_MAX) };
    this.cloudN = CLOUD_MAX;
  }

  // Cloud towers of the sky stage: stacks of soft, sun-lit cloud sprites that the chunks register
  // (like spinners) and _placePuffs lays out each frame; real heights, so the camera's perspective
  // gives them depth. Same shader as the low clouds (one program), plus soft shadows on the deck.
  _initPuffs() {
    const base = this.cloudGeo;
    const mkGeo = (alpha, vari) => {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = base.index;
      geo.setAttribute('position', base.getAttribute('position'));
      geo.setAttribute('uv', base.getAttribute('uv'));
      const aA = new THREE.InstancedBufferAttribute(alpha, 1); aA.setUsage(THREE.DynamicDrawUsage);
      const aV = new THREE.InstancedBufferAttribute(vari, 2); aV.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAlpha', aA);
      geo.setAttribute('aVar', aV);
      return geo;
    };
    this.puffAlpha = new Float32Array(PUFF_MAX); this.puffVar = new Float32Array(PUFF_MAX * 2);
    this.puffShAlpha = new Float32Array(PUFF_MAX); this.puffShVar = new Float32Array(PUFF_MAX * 2);
    this.puffGeo = mkGeo(this.puffAlpha, this.puffVar);
    this.puffShGeo = mkGeo(this.puffShAlpha, this.puffShVar);
    const mkMat = (shadow) => new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTex: { value: null }, uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uK: { value: shadow ? 0.3 : 1 } }]),
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, fog: true, transparent: true, depthWrite: false, defines: shadow ? { SHADOW: '' } : {},
    });
    this.puffMat = mkMat(false); this.puffMat.uniforms.uTex.value = this.tex.cloud;
    this.puffShadowMat = mkMat(true); this.puffShadowMat.uniforms.uTex.value = this.tex.cloud;
    this.puffs = new THREE.InstancedMesh(this.puffGeo, this.puffMat, PUFF_MAX);
    this.puffShadows = new THREE.InstancedMesh(this.puffShGeo, this.puffShadowMat, PUFF_MAX);
    this.puffs.name = 'world-cloud-towers'; this.puffShadows.name = 'world-cloud-tower-shadows';
    this.puffs.renderOrder = 0.5;          // over core's aircraft shadows (0), under the low clouds (1)
    this.puffShadows.renderOrder = -2;
    for (const m of [this.puffs, this.puffShadows]) {
      m.frustumCulled = false; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.visible = S.deck;
      this.root.add(m);
    }
  }

  _placePuffs(d) {
    const C = this.chunks, pa = this.puffAlpha, pv = this.puffVar, sa = this.puffShAlpha, sv = this.puffShVar;
    let n = 0, ns = 0;
    for (let ci = 0; ci < C.length; ci++) {
      const ch = C[ci];
      if (ch.k === null || ch.phase < 3 || ch.npuff === 0) continue;
      if (ch.k * CHUNK > d + 62 || ch.k * CHUNK + CHUNK < d - 34) continue;
      const P = ch.puff;
      for (let i = 0; i < ch.npuff && n < PUFF_MAX; i++) {
        const o = i * 9;
        const z = d - P[o + 2], s = P[o + 3];
        const a = P[o + 5] * sstep(-64, -46, z);                         // fade in above the top edge
        const v = P[o + 6], vu = (v & 1) * 0.5, vv = (v >> 1) * 0.5;
        _q.setFromAxisAngle(_Y, P[o + 7]);
        _s3.set(s, 1, s * P[o + 4]);
        _v3.set(P[o], GROUND_Y + P[o + 1], z);
        _m4.compose(_v3, _q, _s3);
        this.puffs.setMatrixAt(n, _m4);
        pa[n] = a; pv[n * 2] = vu; pv[n * 2 + 1] = vv;
        n++;
        const hgt = P[o + 8];
        if (hgt > 0) {
          // the tower's soft shadow under its base sprite, offset along the fixed sun direction
          _v3.set(P[o] + hgt * SUNX, GROUND_Y + L_SHADOW + 0.03, z - hgt * SUND);
          _m4.compose(_v3, _q, _s3);
          this.puffShadows.setMatrixAt(ns, _m4);
          sa[ns] = a; sv[ns * 2] = vu; sv[ns * 2 + 1] = vv;
          ns++;
        }
      }
    }
    this.puffs.count = n; this.puffShadows.count = ns;
    if (n) {
      this.puffs.instanceMatrix.needsUpdate = true;
      this.puffGeo.getAttribute('aAlpha').needsUpdate = true; this.puffGeo.getAttribute('aVar').needsUpdate = true;
    }
    if (ns) {
      this.puffShadows.instanceMatrix.needsUpdate = true;
      this.puffShGeo.getAttribute('aAlpha').needsUpdate = true; this.puffShGeo.getAttribute('aVar').needsUpdate = true;
    }
  }

  _spawnCloud(i, cdist, zTop) {
    const c = this.cl;
    // place it so it appears above the top edge (z = cdist - cd)
    c.cd[i] = cdist - zTop + Math.random() * 6;
    c.x[i] = (Math.random() * 2 - 1) * 15;
    c.y[i] = GROUND_Y + 2.9 + Math.random() * 1.4;       // −3.1 … −1.7
    c.s[i] = 9 + Math.random() * 10;
    c.sq[i] = 0.55 + Math.random() * 0.35;
    c.a[i] = 0.34 + Math.random() * 0.21;                 // ≤ 0.55 (contract)
    c.r[i] = (Math.random() - 0.5) * 0.9;
    const v = (Math.random() * 4) | 0;
    this.cloudVar[i * 2] = (v & 1) * 0.5; this.cloudVar[i * 2 + 1] = (v >> 1) * 0.5;
  }

  _initSpinners() {
    // radar dish (rotates about y) and wind-turbine rotor (rotates about local z)
    const mkGeo = (fn) => {
      const cap = 600;
      const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 3), uv = new Float32Array(cap * 2), tl = new Float32Array(cap * 2);
      BP = pos; BCOL = col; BU = uv; BT = tl; BN = 0; BCAP = cap; BZ0 = 0; frameId();
      fn();
      for (let i = 0; i < BN * 3; i++) col[i] /= COL_Q;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, BN * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(col.slice(0, BN * 3), 3));
      g.translate(0, -GROUND_Y, 0);
      BP = null;
      return g;
    };
    const saved = VIOL; const savedLog = VIOL_LOG; VIOL_LOG = null;
    this.radarGeo = mkGeo(() => {
      // dish: shallow bowl facing local −d, tilted up; mast
      box(-0.05, -0.05, 0.05, 0.05, 0, 0.35, P.metalD, P.metalD);
      const cD = P.shipWhite;
      const n = 10;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
        const r = 0.62;
        const p = (a) => [Math.cos(a) * r, 0.62 + Math.sin(a) * r * 0.62, -0.18 + Math.sin(a) * 0.14];
        const A = p(a0), B = p(a1);
        vtx(0, GROUND_Y + 0.62, 0.08, cD, 0.8, 0, 0); vtx(A[0], GROUND_Y + A[1], A[2], cD, 1.0, 0, 0); vtx(B[0], GROUND_Y + B[1], B[2], cD, 1.0, 0, 0);
        vtx(0, GROUND_Y + 0.62, 0.08, cD, 0.7, 0, 0); vtx(B[0], GROUND_Y + B[1], B[2], cD, 0.75, 0, 0); vtx(A[0], GROUND_Y + A[1], A[2], cD, 0.75, 0, 0);
      }
      box(-0.03, 0.05, 0.03, 0.35, 0.58, 0.66, P.metalD, P.metalD);
    });
    this.rotorGeo = mkGeo(() => {
      const c = P.shipWhite;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        // blade in the x/y plane (rotor faces −d)
        const L = 1.25, w0 = 0.09, w1 = 0.03;
        const px = -sa, py = ca;
        const bx0 = px * w0, by0 = py * w0, tx = ca * L, ty = sa * L;
        vtx(bx0, GROUND_Y + by0, 0, c, 1, 0, 0); vtx(-bx0, GROUND_Y - by0, 0, c, 1, 0, 0); vtx(tx + px * w1, GROUND_Y + ty + py * w1, 0, c, 1, 0, 0);
        vtx(-bx0, GROUND_Y - by0, 0, c, 0.9, 0, 0); vtx(bx0, GROUND_Y + by0, 0, c, 0.9, 0, 0); vtx(tx + px * w1, GROUND_Y + ty + py * w1, 0, c, 0.9, 0, 0);
      }
      box(-0.08, -0.08, 0.08, 0.08, -0.08, 0.08, P.metal, P.metal);
    });
    VIOL = saved; VIOL_LOG = savedLog;
    this.radars = new THREE.InstancedMesh(this.radarGeo, this.propMat, 16);
    this.rotors = new THREE.InstancedMesh(this.rotorGeo, this.propMat, 16);
    for (const m of [this.radars, this.rotors]) {
      m.frustumCulled = false; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(m);
    }
    this.radars.name = 'world-radars'; this.rotors.name = 'world-rotors';
  }

  // ---------------------------------------------------------------------------
  setQuality(q, force = false) {
    q = q === 'low' ? 'low' : 'high';
    if (q === this.quality && !force) return;
    this.quality = q;
    const low = q === 'low';
    if (low) this.waterMat.defines.LOW = ''; else delete this.waterMat.defines.LOW;
    this.waterMat.needsUpdate = true;
    if (low) this.deckMat.defines.LOW = ''; else delete this.deckMat.defines.LOW;
    this.deckMat.needsUpdate = true;
    this.cloudN = low ? 7 : CLOUD_MAX;
    this.cloudShadows.visible = !low;
    if (!force) {
      for (const ch of this.chunks) { ch.k = null; ch.phase = 0; ch.mesh.visible = false; ch.smesh.visible = false; }
      this._maskSlot.fill(-99999);
      this._ensureChunks(true);
    }
  }

  reset(distance = 0) {
    distance = +distance;
    if (!Number.isFinite(distance)) distance = 0;
    this._d = distance;
    for (const ch of this.chunks) { ch.k = null; ch.phase = 0; ch.mesh.visible = false; ch.smesh.visible = false; }
    this._maskSlot.fill(-99999);
    this._ensureChunks(true);
    // scatter clouds over the whole view
    const cdist = distance * 1.3 + this._clock * 0.35;   // same frame as _updateClouds
    for (let i = 0; i < CLOUD_MAX; i++) { this._spawnCloud(i, cdist, 0); this.cl.cd[i] = cdist - (Math.random() * 90 - 60); }
    this._applyTod();
    this._place(0);
  }

  update(dt, speed) {
    dt = +dt; speed = +speed;         // never let a bad argument turn the distance into NaN
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    if (!Number.isFinite(speed)) speed = 0;
    this._d += speed * dt;
    this._t += dt;
    this._clock += dt;               // never wraps: cloud drift and spinners
    if (this._t > TIME_WRAP) this._t -= TIME_WRAP;
    this._ensureChunks(false);
    if (this._d !== this._todD) this._applyTod();   // lights/fog only change with distance
    this._place(dt);
  }

  // which chunks must exist: visible stage range is roughly [d−19, d+44]
  _ensureChunks(all) {
    const d = this._d;
    const kLo = Math.floor((d - 22) / CHUNK), kHi = Math.floor((d + 46) / CHUNK) + 1;  // +1 = built ahead
    // release slots outside [kLo, kHi]
    const C = this.chunks;
    for (let i = 0; i < C.length; i++) { const ch = C[i]; if (ch.k !== null && (ch.k < kLo || ch.k > kHi)) { ch.k = null; ch.phase = 0; ch.mesh.visible = false; ch.smesh.visible = false; ch.nspin = 0; ch.npuff = 0; } }
    // Chunks overlapping the view are built at once. The one ahead of the view is built in
    // three slices (ground, props, water mask + upload) on consecutive frames, and only on a
    // frame that did no other build — so a phone never pays for a whole chunk in one frame.
    let built = 0;
    for (let k = kLo; k <= kHi; k++) {
      let ch = null;
      for (let i = 0; i < C.length; i++) if (C[i].k === k) { ch = C[i]; break; }
      const needed = k < kHi || all;
      if (ch && ch.phase === 3) continue;
      if (!needed && built > 0) continue;
      if (!ch) {
        for (let i = 0; i < C.length; i++) if (C[i].k === null) { ch = C[i]; break; }
        if (!ch) break;
        this._begin(ch, k);
      }
      const t0 = performance.now();
      if (needed) { while (ch.phase < 3) this._step(ch); }
      else this._step(ch);
      const ms = performance.now() - t0;
      if (ms > this.stats.maxSliceMs) this.stats.maxSliceMs = ms;
      built++;
    }
    if (this._maskDirty) { this.tex.mask.needsUpdate = true; this._maskDirty = false; }
  }

  // ---------------------------------------------------------------------------
  _begin(ch, k) {
    ch.k = k; ch.phase = 0; ch.n = 0; ch.sn = 0;
    ch.nspin = 0; ch.npuff = 0; ch.nwake = 0; ch.viol = 0; ch.ms = 0;
    ch.mesh.visible = false; ch.smesh.visible = false;
  }
  // point the emitter at a chunk (state is saved on the chunk between slices)
  _target(ch) {
    BP = ch.pos; BCOL = ch.col; BU = ch.uv; BT = ch.tile; BN = ch.n; BCAP = this.quality === 'low' ? CAP_LOW : CAP_HIGH; BZ0 = ch.k * CHUNK;
    SP = ch.spos; SN = ch.sn; SCAP = SH_CAP;
    LOWQ = this.quality === 'low';
    SHK = todShadowK(ch.k * CHUNK + 20);
    frameId(); plain(); setTile(0); uvMode(0, 0);
  }
  _step(ch) {
    const t0 = performance.now();
    const k = ch.k, d0 = k * CHUNK;
    const v0 = VIOL;
    // per-stage salt: every stage has its own random stream per chunk (coastal's salt is 0)
    if (ch.phase === 0) {
      this._target(ch);
      srand(k * 7919 + 1013 + S.salt);
      if (S.hasGround(k, d0)) this._ground(d0);
    } else if (ch.phase === 1) {
      this._target(ch);
      srand(k * 7919 + 2027 + S.salt);
      LSEED = (k * 131 + S.salt) & 1023;
      S.gen(this, ch, k, d0);
    } else {
      this._writeMask(ch, k, d0);
      this._upload(ch);
    }
    if (ch.phase < 2) { ch.n = BN; ch.sn = SN; BP = null; SP = null; }
    ch.viol += VIOL - v0;
    this.stats.violations = VIOL;
    ch.ms += performance.now() - t0;
    ch.phase++;
    if (ch.phase === 3) {
      this.stats.builds++; this.stats.lastBuildMs = ch.ms; this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, ch.ms);
    }
  }
  _upload(ch) {
    const g = ch.geo;
    g.setDrawRange(0, ch.n);
    for (let i = 0; i < ATTRS.length; i++) {
      const a = g.getAttribute(ATTRS[i]);
      a.clearUpdateRanges(); a.addUpdateRange(0, ch.n * a.itemSize); a.needsUpdate = true;
    }
    ch.sgeo.setDrawRange(0, ch.sn);
    const sa = ch.sgeo.getAttribute('position');
    sa.clearUpdateRanges(); sa.addUpdateRange(0, ch.sn * 3); sa.needsUpdate = true;
    ch.mesh.visible = ch.n > 0; ch.smesh.visible = ch.sn > 0;
  }
  // synchronous full build (tools / profiling)
  _build(ch, k) { this._begin(ch, k); while (ch.phase < 3) this._step(ch); }

  // ground grid (skips cells that are entirely under water). Terrain is not a prop, so on stages
  // whose ground units need flat lanes/roads/corridors (S.flatCheck) every grid vertex inside a
  // clear zone is self-checked here instead: |h| > 0.04 there, or any h > MAX_H, is a violation.
  _ground(d0) {
    const GX = GROUND_XS, NX = GX.length, NZ = CHUNK + 1;
    const H = GRID_H, Cc = GRID_C;
    const terrainH = S.terrainH, groundColor = S.groundColor, flatCheck = S.flatCheck;
    for (let j = 0; j < NZ; j++) {
      const d = d0 + j;
      for (let i = 0; i < NX; i++) {
        const x = GX[i];
        const h = terrainH(x, d);
        H[j * NX + i] = h;
        groundColor(x, d, h, TC);
        const o = (j * NX + i) * 3;
        Cc[o] = TC[0]; Cc[o + 1] = TC[1]; Cc[o + 2] = TC[2];
        if (flatCheck && (h > MAX_H || ((h > 0.04 || h < -0.04) && blocked(x, x, d, d, 0)))) {
          VIOL++; if (VIOL_LOG && VIOL_LOG.length < 40) VIOL_LOG.push(['ground', x, d, +h.toFixed(3)]);
        }
      }
    }
    setTile(0);
    const wet = S.water !== null;        // dry stages never skip a cell (the mesa valley is low ground, not sea)
    const deep = WATER_REL - 0.3;
    const cc = [0, 0, 0];
    const put = (i, j) => {
      const o = (j * NX + i) * 3;
      cc[0] = Cc[o]; cc[1] = Cc[o + 1]; cc[2] = Cc[o + 2];
      vtx(GX[i], GROUND_Y + H[j * NX + i], d0 + j, cc, 1, 0, 0);
    };
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = H[j * NX + i], b = H[j * NX + i + 1], c = H[(j + 1) * NX + i + 1], e = H[(j + 1) * NX + i];
        if (wet && a < deep && b < deep && c < deep && e < deep) continue;
        if (!room(6)) return;
        if ((i + j) & 1) { put(i, j); put(i + 1, j); put(i + 1, j + 1); put(i, j); put(i + 1, j + 1); put(i, j + 1); }
        else { put(i, j); put(i + 1, j); put(i, j + 1); put(i + 1, j); put(i + 1, j + 1); put(i, j + 1); }
      }
    }
  }

  _writeMask(ch, k, d0) {
    const W = S.water;
    if (W === null) { ch.hasWater = false; return; }      // dry / sky stage: the mask is never read
    const terrainH = S.terrainH;
    const slot = ((k % 8) + 8) % 8;
    let hasWater = false;
    const sea = k >= W.seaFromK;
    if (sea && this._maskSlot[slot] === -1) { ch.hasWater = true; return; } // already "open sea"
    const base = slot * ROWS_PER_CHUNK;
    const M = this.maskData;
    const wk = ch.wakes, nw = ch.nwake;
    for (let j = 0; j < ROWS_PER_CHUNK; j++) {
      const d = d0 + (j + 0.5) * MASK_RES;
      const row = (base + j) * MASK_W * 4;
      for (let i = 0; i < MASK_W; i++) {
        const x = -40 + (i + 0.5) * MASK_RES;
        const h = sea ? -2.6 : terrainH(x, d);
        let g = 0, calm = 0;
        if (h < WATER_REL) {
          if (Math.abs(x) < 20) hasWater = true;
          for (let w = 0; w < nw; w++) {
            const o = w * 6;
            const rx = x - wk[o], rd = d - wk[o + 1];
            const along = -(rx * wk[o + 2] + rd * wk[o + 3]);
            if (along < 0 || along > wk[o + 4]) continue;
            const across = Math.abs(rx * wk[o + 3] - rd * wk[o + 2]);
            const t = along / wk[o + 4];
            const half = wk[o + 5] * (0.5 + along * 0.18);
            const edge = Math.exp(-((across - half) ** 2) / 0.05) * 0.8;
            const core = Math.exp(-(across * across) / (0.3 * wk[o + 5])) * (1 - t);
            g = Math.max(g, clamp((edge + core) * (1 - t) * 1.2, 0, 1));
          }
          // calm (inland) water: harbour basin, river, ponds, canal
          calm = W.calm(x, d);
        }
        const o = row + i * 4;
        M[o] = clamp(Math.round((h * 0.25 + 0.5) * 255), 0, 255);
        M[o + 1] = Math.round(g * 255);
        M[o + 2] = Math.round(calm * 255);
        M[o + 3] = 255;
      }
    }
    this._maskSlot[slot] = sea ? -1 : k;
    this._maskDirty = true;
    ch.hasWater = hasWater || sea || k <= W.alwaysK;
  }

  // ---------------------------------------------------------------------------
  _place(dt) {
    const d = this._d;
    let water = false;
    let nr = 0, nt = 0;
    const t = this._t, C = this.chunks;
    for (let ci = 0; ci < C.length; ci++) {
      const ch = C[ci];
      if (ch.k === null || ch.phase < 3) continue;
      const z = d - ch.k * CHUNK;
      ch.mesh.position.z = z; ch.smesh.position.z = z;
      // chunk overlaps the visible range?
      const vis = ch.k * CHUNK < d + 46 && ch.k * CHUNK + CHUNK > d - 22;
      if (vis && ch.hasWater) water = true;
      for (let i = 0; i < ch.nspin; i++) {
        const o = i * 7;
        const type = ch.spin[o], x = ch.spin[o + 1], y = ch.spin[o + 2], sd = ch.spin[o + 3];
        const ang = ch.spin[o + 4] + ((this._clock * ch.spin[o + 5]) % TAU);
        const wz = d - sd;
        if (type === 0) {
          if (nr >= 16) continue;
          _m4.makeRotationY(ang); _m4.setPosition(x, y, wz);
          this.radars.setMatrixAt(nr++, _m4);
        } else {
          if (nt >= 16) continue;
          _m4b.makeRotationZ(ang); _m4.makeRotationY(ch.spin[o + 6]); _m4.multiply(_m4b); _m4.setPosition(x, y, wz);
          this.rotors.setMatrixAt(nt++, _m4);
        }
      }
    }
    this.radars.count = nr; this.rotors.count = nt;
    if (nr) this.radars.instanceMatrix.needsUpdate = true;
    if (nt) this.rotors.instanceMatrix.needsUpdate = true;
    this.water.visible = S.water !== null && (water || S.water.open(biomeOf(d)));
    // shader scroll uniforms
    const u = this.waterMat.uniforms;
    const dn = ((d % NOISE_SPAN) + NOISE_SPAN) % NOISE_SPAN;
    u.uScroll.value.set(t, ((d % MASK_SPAN) + MASK_SPAN) % MASK_SPAN, dn);
    this.uDN.value.x = dn;
    if (S.deck) { this._placeDeck(t, d, dn); this._placePuffs(d); }
    this._updateClouds(dt);
  }

  // cloud-deck scroll (the lower layer at 0.62·d reads as deeper) and storm lightning: short
  // double-flickers at a deterministic pseudo-random place/time, strength from the TOD 'flash'
  _placeDeck(t, d, dn) {
    const du = this.deckMat.uniforms;
    const d2 = d * 0.62;
    du.uScroll.value.set(t, dn, ((d2 % NOISE_SPAN) + NOISE_SPAN) % NOISE_SPAN);
    const fa = this._todN[N_FLASH], f = du.uFlash.value;
    let s = 0;
    if (fa > 0.01) {
      const T = this._clock / 2.6, i = Math.floor(T);
      const e = (T - i) * 2.6 - 0.2 - hash2(i, 91) * 1.7;          // seconds since this period's strike
      if (e > 0 && e < 0.45 && hash2(i, 37) < 0.72) {
        s = e < 0.06 ? 1 : e < 0.11 ? 0.2 : e < 0.17 ? 0.8 : 0.8 * (1 - (e - 0.17) / 0.28);
        f.x = (hash2(i, 53) - 0.5) * 26;
        f.y = -4 - hash2(i, 59) * 38;
      }
    }
    f.z = s * fa;
  }

  _updateClouds() {
    const c = this.cl, d = this._d;
    const cdist = d * 1.3 + this._clock * 0.35;
    const n = this.cloudN;
    const sy = GROUND_Y + L_SHADOW + 0.02;
    const tod = this._todN[N_CLOUD], alpha = this.cloudAlpha;
    for (let i = 0; i < CLOUD_MAX; i++) {
      let z = cdist - c.cd[i];
      if (z > 34) { this._spawnCloud(i, cdist, -52); z = cdist - c.cd[i]; }
      const s = c.s[i];
      // alpha straight into the typed array (no Smi/double phi, no Math.min builtin call: both box
      // doubles in V8's lower tiers). Stage position under the cloud ≈ d − z; fades in above the top.
      alpha[i] = 0;
      if (i < n) {
        const v = c.a[i] * S.cloud[biomeOf(d - z)] * tod * sstep(-60, -40, z);
        alpha[i] = v < 0.55 ? v : 0.55;
      }
      _q.setFromAxisAngle(_Y, c.r[i]);
      _s3.set(s, 1, s * c.sq[i]);
      _v3.set(c.x[i], c.y[i], z);
      _m4.compose(_v3, _q, _s3);
      this.clouds.setMatrixAt(i, _m4);
      const hgt = c.y[i] - GROUND_Y;
      _v3.set(c.x[i] + hgt * SUNX, sy, z - hgt * SUND);
      _m4.compose(_v3, _q, _s3);
      this.cloudShadows.setMatrixAt(i, _m4);
    }
    this.clouds.instanceMatrix.needsUpdate = true;
    this.cloudShadows.instanceMatrix.needsUpdate = true;
    this.cloudGeo.getAttribute('aAlpha').needsUpdate = true;
    const uk = this.cloudShadowMat.uniforms.uK;
    const k = S.cloudShadowK(biomeOf(d));
    if (uk.value !== k) uk.value = k;
  }

  // ---------------------------------------------------------------------------
  _applyTod() {
    const d = this._d, TOD = S.tod;
    this._todD = d;
    let i = 0;
    while (i < TOD.length - 2 && d > TOD[i + 1].d) i++;
    const a = TOD[i], b = TOD[i + 1];
    const t = sstep(a.d, b.d, d);
    const o = this._tod, N = this._todN;
    for (let j = 0; j < TOD_COLS.length; j++) { const c = TOD_COLS[j]; o[c].copy(a[c]).lerp(b[c], t); }
    for (let j = 0; j < N.length; j++) N[j] = lerp(a.n[j], b.n[j], t);
    o.gdir.copy(a.gdir).lerp(b.gdir, t).normalize();
    if (this.sun) { this.sun.color.copy(o.sun); this.sun.intensity = N[N_SUNI]; }
    if (this.hemi) { this.hemi.color.copy(o.sky); this.hemi.groundColor.copy(o.gnd); this.hemi.intensity = N[N_HEMII]; }
    const fog = this.scene.fog;
    if (fog) { fog.color.copy(o.fog); if (fog.isFog) { fog.near = N[N_NEAR]; fog.far = N[N_FAR]; } }
    this._bg.copy(o.fog);
    if (this.scene.background !== this._bg) this.scene.background = this._bg;
    const u = this.waterMat.uniforms;
    // water tint follows the light a little (dusk water is darker / warmer)
    u.uDeep.value.copy(o.deep); u.uShallow.value.copy(o.shallow); u.uSky.value.copy(o.wsky);
    u.uFoam.value.copy(o.foam); u.uInland.value.copy(o.inland);
    u.uGlint.value.copy(o.glint).multiplyScalar(N[N_GLINTI]);
    u.uGlintDir.value.copy(o.gdir);
    u.uLook.value.set(N[N_CAPS], N[N_RELIEF], N[N_SPARK], N[N_SHEEN]);
    const cu = this.cloudMat.uniforms;
    cu.uLit.value.copy(o.cLit).multiplyScalar(0.93);
    cu.uShade.value.copy(o.cShade).multiplyScalar(0.78);
    this.cloudShadowMat.uniforms.uShade.value.copy(o.shadow);
    this.shadowMat.color.copy(o.shadow);
    this.shadowMat.opacity = N[N_SHA];
    if (S.deck) {
      const du = this.deckMat.uniforms;
      du.uLit.value.copy(o.dLit); du.uShade.value.copy(o.dShade); du.uAbyss.value.copy(o.dAbyss); du.uRim.value.copy(o.dRim);
      du.uLook.value.x = N[N_COVER];
      // the towers stand up into the sunlight: a touch brighter than the deck, same shade family
      const pu = this.puffMat.uniforms;
      pu.uLit.value.copy(o.dLit).lerp(o.dRim, 0.25); pu.uShade.value.copy(o.dShade).lerp(o.dLit, 0.12);
      this.puffShadowMat.uniforms.uShade.value.copy(o.shadow);
    }
  }

  // debugging / tooling -----------------------------------------------------------
  info() {
    let verts = 0, sverts = 0, active = 0;
    for (const ch of this.chunks) if (ch.k !== null && ch.phase === 3) { active++; verts += ch.n; sverts += ch.sn; }
    return { stage: S.id, distance: this._d, biome: biomeOf(this._d), activeChunks: active, triangles: (verts + sverts) / 3,
      violations: this.stats.violations, violationLog: this.stats.violationLog.slice(0, 12), lastBuildMs: this.stats.lastBuildMs, maxBuildMs: this.stats.maxBuildMs, builds: this.stats.builds,
      water: this.water.visible, deck: this.deck.visible, maxSliceMs: this.stats.maxSliceMs };
  }

  dispose() {
    this.scene.remove(this.root);
    for (const ch of this.chunks) { ch.geo.dispose(); ch.sgeo.dispose(); }
    this.water.geometry.dispose(); this.waterMat.dispose();
    this.deck.geometry.dispose(); this.deckMat.dispose();
    this.puffGeo.dispose(); this.puffShGeo.dispose(); this.puffMat.dispose(); this.puffShadowMat.dispose();
    this.puffs.dispose(); this.puffShadows.dispose();
    this.cloudGeo.dispose(); this.cloudMat.dispose(); this.cloudShadowMat.dispose();
    this.radarGeo.dispose(); this.rotorGeo.dispose(); this.radars.dispose(); this.rotors.dispose();
    this.landMat.dispose(); this.shadowMat.dispose(); this.propMat.dispose();
    for (const k in this.tex) if (this.tex[k]) this.tex[k].dispose();
    if (this.scene.background === this._bg) this.scene.background = null;
    this.chunks.length = 0;
  }
}

// ground grid x positions: fine in the playfield, coarse at the far sides
const ATTRS = ['position', 'color', 'uv', 'tile'];
const GROUND_XS = (() => {
  const a = [];
  for (let x = -40; x < -24; x += 4) a.push(x);
  for (let x = -24; x <= 24; x += 1) a.push(x);
  for (let x = 28; x <= 40; x += 4) a.push(x);
  return new Float32Array(a);
})();
const GRID_H = new Float32Array(GROUND_XS.length * (CHUNK + 1));
const GRID_C = new Float32Array(GROUND_XS.length * (CHUNK + 1) * 3);

// spinner registration (called from generators)
function addSpinner(ch, type, x, y, d, speed, yaw = 0) {
  if (ch.nspin >= 16) return;
  const o = ch.nspin++ * 7;
  ch.spin[o] = type; ch.spin[o + 1] = x; ch.spin[o + 2] = y; ch.spin[o + 3] = d;
  ch.spin[o + 4] = rand() * TAU; ch.spin[o + 5] = speed; ch.spin[o + 6] = yaw;
}
function addWake(ch, x, d, dirX, dirD, len, w) {
  if (ch.nwake >= 8) return;
  const o = ch.nwake++ * 6;
  ch.wakes[o] = x; ch.wakes[o + 1] = d; ch.wakes[o + 2] = dirX; ch.wakes[o + 3] = dirD; ch.wakes[o + 4] = len; ch.wakes[o + 5] = w;
}

// =============================================================================
// Shared land pieces: lanes & cross roads
// =============================================================================
// lane road segment [dA, dB] for lane x with a style
function laneRoad(lx, dA, dB, style) {
  if (dB <= dA) return;
  frameId(); setTile(0); uvMode(0, 0);
  if (style === 'dirt') {
    flat(lx - 0.95, dA, lx + 0.95, dB, L_ROAD, P.dirt);
    flat(lx - 0.6, dA, lx - 0.4, dB, L_WALK, P.dirt, 0.9);
    flat(lx + 0.4, dA, lx + 0.6, dB, L_WALK, P.dirt, 0.9);
    return;
  }
  const w = style === 'avenue' ? 1.05 : style === 'taxi' ? 1.2 : 1.1;
  flat(lx - w, dA, lx + w, dB, L_ROAD, style === 'taxi' ? P.asphaltD : P.asphalt);
  if (style === 'avenue') {
    flat(lx - w - 0.32, dA, lx - w, dB, L_WALK, P.walk);
    flat(lx + w, dA, lx + w + 0.32, dB, L_WALK, P.walk);
  }
  if (style === 'taxi') {
    flat(lx - 0.05, dA, lx + 0.05, dB, L_MARK, P.yellow);
    flat(lx - w, dA, lx - w + 0.08, dB, L_MARK, P.yellow, 0.8);
    flat(lx + w - 0.08, dA, lx + w, dB, L_MARK, P.yellow, 0.8);
    return;
  }
  // centre dashes (skipping the cross-road intersection)
  for (let d = Math.ceil(dA / 2.5) * 2.5; d < dB - 1.3; d += 2.5) {
    if (crossDist(d + 0.6) < 2.4) continue;
    flat(lx - 0.06, d, lx + 0.06, d + 1.2, L_MARK, P.paint, 0.85);
  }
}
function crossRoad(c, style, x0 = -40, x1 = 40) {
  frameId(); setTile(0); uvMode(0, 0);
  if (style === 'gravel') {
    // gravel road between the paved centre lane; wheel ruts stop at every lane
    flat(x0, c - 1.5, -1.1, c + 1.5, L_ROAD, P.gravel);
    flat(1.1, c - 1.5, x1, c + 1.5, L_ROAD, P.gravel);
    const segs = [[x0, -6.5], [-4.5, -1.1], [1.1, 4.5], [6.5, x1]];
    for (const [a, b] of segs) { flat(a, c - 0.75, b, c - 0.5, L_WALK, P.dirt, 0.92); flat(a, c + 0.5, b, c + 0.75, L_WALK, P.dirt, 0.92); }
    return;
  }
  const taxi = style === 'taxi';
  flat(x0, c - 1.5, x1, c + 1.5, L_ROAD, taxi ? P.asphaltD : P.asphalt);
  if (taxi) {
    flat(x0, c - 0.05, x1, c + 0.05, L_MARK, P.yellow);
    // hold-short bars before the runway and yellow/black guidance boards
    for (const sx of [-1, 1]) {
      flat(sx * 3.3 - 0.06, c - 1.4, sx * 3.3 + 0.06, c + 1.4, L_MARK, P.yellow, 0.95);
      flat(sx * 3.55 - 0.06, c - 1.4, sx * 3.55 + 0.06, c + 1.4, L_MARK, P.yellow, 0.95);
      box(sx * 3.9 - 0.3, c + 2.1, sx * 3.9 + 0.3, c + 2.22, 0, 0.26, P.yellow, P.hullDark);
      box(sx * 7.3 - 0.3, c - 2.2, sx * 7.3 + 0.3, c - 2.08, 0, 0.26, P.hullDark, P.yellow);
    }
    return;
  }
  // dashed centre line, skipping the lane intersections
  for (let x = Math.ceil(x0 / 2.5) * 2.5; x < x1 - 1.2; x += 2.5) {
    let skip = false;
    for (let i = 0; i < 3; i++) if (Math.abs(x + 0.6 - LANES_X[i]) < 2.2) skip = true;
    if (!skip) flat(x, c - 0.05, x + 1.2, c + 0.05, L_MARK, P.paint, 0.85);
  }
  if (style === 'main') {
    // sidewalks between the avenues + zebra crossings on every approach
    const segs = [[x0, -6.55], [-4.45, -1.05], [1.05, 4.45], [6.55, x1]];
    for (const [a, b] of segs) { flat(a, c - 1.85, b, c - 1.5, L_WALK, P.walk); flat(a, c + 1.5, b, c + 1.85, L_WALK, P.walk); }
    for (let i = 0; i < 3; i++) zebraAcrossLane(LANES_X[i], c);
  }
}
function zebraAcrossLane(lx, c) {
  if (LOWQ) return;
  for (const s of [-1, 1]) {
    const dd = c + s * 2.2;
    for (let x = lx - 1.05; x < lx + 1.0; x += 0.3) flat(x, dd - 0.35, x + 0.16, dd + 0.35, L_MARK, P.paint, 0.9);
  }
}

// =============================================================================
// OCEAN (d < 280)
// =============================================================================
function genOcean(w, ch, k, d0) {
  for (let i = 0; i < ISL.length; i++) if (ISL[i].k === k) islandProps(ch, ISL[i]);
  // shipping on both flanks; every hull stays at |x| ≥ 8.4, clear of core's gunboat lanes
  const nShip = rand() < 0.6 ? 1 : 2;
  for (let s = 0; s < nShip; s++) {
    const side = rand() < 0.5 ? -1 : 1, d = d0 + rr(8, 32), r = rand();
    if (r < 0.36) { const x = side * rr(10.2, 12.5); if (!nearIsland(x, d, 4.4)) containerShip(ch, x, d, rand() < 0.5 ? 0 : Math.PI, 1); }
    else if (r < 0.52) { const x = side * rr(10.6, 12.5); if (!nearIsland(x, d, 4.8)) tanker(ch, x, d, rand() < 0.5 ? 0.08 : Math.PI - 0.08); }
    else if (r < 0.84) { const x = side * rr(9.7, 13.5); if (!nearIsland(x, d, 2.2)) trawler(ch, x, d, rr(0, TAU)); }
    else { const x = side * rr(9.3, 13.5); if (!nearIsland(x, d, 1.8)) sailboat(ch, x, d, rr(0, TAU)); }
  }
  // sea stacks / rocks
  const nr = 1 + ((rand() * 3) | 0);
  for (let i = 0; i < nr; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const x = side * rr(9.5, 14), d = d0 + rr(3, 37);
    if (nearIsland(x, d, 1.6)) continue;
    rock(x, d, rr(0.35, 0.7), -0.35, rr(0.35, 0.7));
    if (rand() < 0.6) rock(x + side * rr(0, 0.9), d + rr(-0.9, 0.9), rr(0.2, 0.4), -0.3, rr(0.25, 0.45));
  }
  // offshore platforms as landmarks
  if (k === 5) oilRig(ch, 11.4, 222);
  if (k === 2) oilRig(ch, -12.4, 98);
  // near the coast: fishing boats
  if (k >= 5) for (let i = 0; i < 2; i++) { const x = (rand() < 0.5 ? -1 : 1) * rr(9.7, 14); const d = d0 + rr(5, 35); if (!nearIsland(x, d, 2.2)) trawler(ch, x, d, rr(0, TAU), 0.8); }
  for (let i = 0; i < 2; i++) buoy(rr(-16, 16), d0 + rr(2, 38));
}
function nearIsland(x, d, m) {
  for (let i = 0; i < ISL.length; i++) {
    const I = ISL[i];
    if (Math.abs(d - I.d) > I.R * I.sd * 1.3 + m || Math.abs(x - I.x) > I.R * I.sx * 1.3 + m) continue;
    if (islandRho(I, x, d) < 1.3 + m / I.R) return true;
  }
  return false;
}
// x where the island's shore meets the water on the side facing the centre line, at stage d
function islandShoreX(I, d) {
  const sgn = I.x < 0 ? -1 : 1;
  let x = I.x;
  for (let i = 0; i < 40 && coastalH(x, d) > WATER_REL; i++) x -= sgn * 0.2;
  return x;
}
function oilRig(ch, x, d) {
  if (nearIsland(x, d, 4)) return;
  frameId();
  // legs, two decks, helipad, crane, derrick, flare boom
  for (const [ox, od] of [[-1.3, -1.1], [1.3, -1.1], [-1.3, 1.1], [1.3, 1.1]]) cyl(x + ox, d + od, 0.22, WATER_REL - 0.1, 0.9, 6, P.redPaint, P.redPaint, false);
  box(x - 1.6, d - 1.4, x + 1.6, d + 1.4, 0.9, 1.15, P.metalD, P.deckGrey);
  box(x - 1.5, d - 1.3, x + 0.2, d + 1.3, 1.15, 1.7, P.shipWhite, P.roofLight);
  setTile(T_HELI); uvMode(1.5, 1.5, false, x - 1.45, d - 1.25);
  flat(x - 1.45, d - 1.25, x + 0.05, d + 0.25, 1.72, P.white); setTile(0); uvMode(0, 0);
  box(x + 0.5, d - 0.3, x + 1.3, d + 0.5, 1.15, 1.4, P.yellow, P.metalD);
  for (const [ox, od] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) box(x + 0.9 + ox - 0.04, d + 0.1 + od - 0.04, x + 0.9 + ox + 0.04, d + 0.1 + od + 0.04, 1.4, 3.3, P.metal, P.metal);
  box(x + 0.6, d - 0.2, x + 1.2, d + 0.4, 3.3, 3.45, P.metal, P.metal);
  box(x + 1.5, d + 1.0, x + 3.2, d + 1.18, 1.1, 1.22, P.metal, P.metal);
  box(x - 0.2, d + 1.25, x + 0.05, d + 3.0, 1.7, 1.82, P.yellow, P.yellow);
  shadowBox(x - 1.6, d - 1.4, x + 1.6, d + 1.4, 1.6, WATER_REL);
  shadowBox(x + 0.6, d - 0.2, x + 1.2, d + 0.4, 3.3, WATER_REL);
}
function buoy(x, d) {
  cyl(x, d, 0.09, WATER_REL - 0.05, 0.14, 5, P.redPaint, P.paint);
}
const ISLE_WALLS = [P.wallW, P.wallW, P.wallCream, P.wallPink, P.wallSand];
const ISLE_ROOFS = [P.roofTerra, P.roofTerra, P.roofBrown, P.roofSlate, P.roofGreen];
function islandProps(ch, I) {
  const R = I.R, sgn = I.x < 0 ? -1 : 1;
  // village clearing on the side facing the centre line (big islands)
  const vx = I.x - sgn * R * I.sx * 0.32, vd = I.d + rr(-0.2, 0.2) * R * I.sd;
  // palms on the beach ring, jungle inside
  const n = Math.round(R * R * I.sx * I.sd * (LOWQ ? 1.2 : 2.3));
  for (let i = 0; i < n; i++) {
    const a = rand() * TAU, q = Math.sqrt(rand()) * 0.95;
    const x = I.x + Math.cos(a) * q * R * I.sx, d = I.d + Math.sin(a) * q * R * I.sd;
    const rho = islandRho(I, x, d);
    if (rho > 0.9) continue;
    const h = coastalH(x, d);
    if (h < 0.05) continue;
    if (I.village && Math.hypot(x - vx, d - vd) < 2.3) continue;
    if (rho > 0.62) { if (rand() < 0.55) palm(x, d, rr(0.9, 1.25), h - 0.02); }
    else if (rand() < 0.8) treeRound(x, d, rr(0.5, 0.8), rr(0.9, 1.4), jit(rand() < 0.5 ? P.jungle : P.tree1, 0.2), h - 0.05);
    else palm(x, d, rr(1.0, 1.35), h - 0.02);
  }
  // shore rocks (never reaching toward the gunboat lanes)
  const nr = Math.round(R * 0.75 * (I.sx + I.sd));
  for (let i = 0; i < nr; i++) {
    const a = rand() * TAU;
    const x = I.x + Math.cos(a) * R * I.sx * rr(0.92, 1.08), d = I.d + Math.sin(a) * R * I.sd * rr(0.92, 1.08);
    if (Math.abs(x) - 0.8 < ISL_X) continue;
    rock(x, d, rr(0.25, 0.55), -0.3, rr(0.3, 0.6));
  }
  if (I.village) {
    // a fishing village: whitewashed houses round a little square, a jetty with boats
    frameId();
    for (let i = 0; i < 9; i++) {
      const gx = (i % 3) - 1, gd = ((i / 3) | 0) - 1;
      if (rand() < 0.2) continue;
      const x = vx + gx * 1.15 + rr(-0.2, 0.2), d = vd + gd * 1.3 + rr(-0.2, 0.2);
      if (islandRho(I, x, d) > 0.78) continue;
      const h = coastalH(x, d);
      if (h < 0.1) continue;
      house(x, d, rr(0.62, 0.85), rr(0.55, 0.75), rr(0.32, 0.45), rr(-0.3, 0.3), jit(pick(ISLE_WALLS), 0.06, TC2), jit(pick(ISLE_ROOFS), 0.1, TC3), rand() < 0.5 ? 0 : 1, 0.26, h - 0.04);
    }
    const jd = vd + rr(-1, 1), sx0 = islandShoreX(I, jd);
    if (Math.abs(sx0) - 0.3 > ISL_X - 0.2) {
      frame(sx0, jd, 0); box(-0.16, -1.3, 0.16, 1.3, -0.3, 0.1, P.roofBrown, P.dirt); frameId();
      shadowBox(sx0 - 0.16, jd - 1.3, sx0 + 0.16, jd + 1.3, 0.12, WATER_REL);
    }
  }
  if (I.house) {
    // a hut on the beach, facing the centre line
    const hd = I.d + rr(-0.3, 0.3) * R * I.sd;
    const sx0 = islandShoreX(I, hd);
    const x = sx0 + sgn * 1.1, h = coastalH(x, hd);
    if (h > 0.02) house(x, hd, 0.8, 0.65, 0.4, rr(-0.3, 0.3), P.wallCream, P.roofBrown, 1, 0.28, h - 0.03);
  }
  if (I.light) {
    // a small lighthouse on the island tip
    const td = I.d + (rand() < 0.5 ? -1 : 1) * R * I.sd * 0.62, tx = I.x + sgn * R * I.sx * 0.1;
    const h = coastalH(tx, td);
    if (h > 0.05) lighthouse(tx, td, h - 0.05, 0.8);
  }
}
function lighthouse(x, d, base, s = 1) {
  frame(0, 0, 0);
  cyl(x, d, 0.55 * s, base, base + 0.35, 8, P.concreteD, P.concrete);
  const top = base + 3.0 * s;
  for (let i = 0; i < 4; i++) {
    const a = base + 0.35 + (i * (top - base - 0.35)) / 4, b = base + 0.35 + ((i + 1) * (top - base - 0.35)) / 4;
    cyl(x, d, 0.36 * s * (1 - i * 0.06), a, b, 8, i % 2 ? P.redPaint : P.shipWhite, P.shipWhite, false);
  }
  cyl(x, d, 0.32 * s, top, top + 0.35 * s, 8, P.glassL, P.glassL, false);
  cone(x, d, 0.38 * s, top + 0.35 * s, top + 0.62 * s, 8, P.redPaint);
  shadowDisc(x, d, 0.3 * s, top + 0.5, base);
}

// ---- ships ------------------------------------------------------------------------
function containerShip(ch, x, d, rot, s = 1) {
  const L = 7.2 * s, W = 1.35 * s;
  frame(x, d, rot);
  hull(L, W, 0.36, P.hullDark, P.deckRust);
  // container rows
  for (let r = 0; r < 5; r++) {
    const dd = -L / 2 + 1.7 + r * 0.95;
    for (let c = -1; c <= 1; c++) {
      const lv = 1 + ((hash2(r * 3 + c, Math.round(x * 10)) * 3) | 0);
      const col = P.cont[(hash2(r, c + 9 + Math.round(d)) * P.cont.length) | 0];
      sideStyle(T_CORR, 0.12, 1);
      box(c * 0.4 - 0.19, dd - 0.42, c * 0.4 + 0.19, dd + 0.42, 0.36, 0.36 + lv * 0.2, col, tint(col, P.white, 0.1, TC3));
    }
  }
  plain();
  // bridge at the stern
  sideStyle(T_RESID, 0.5, 0.25);
  box(-W * 0.42, -L / 2 + 0.25, W * 0.42, -L / 2 + 1.1, 0.36, 1.25, P.shipWhite, P.shipWhite);
  plain();
  box(-0.12, -L / 2 + 0.35, 0.12, -L / 2 + 0.6, 1.25, 1.5, P.redPaint, P.hullDark);
  shadowBox(-W / 2, -L / 2, W / 2, L / 2, 0.9, WATER_REL);
  frameId();
  shipWake(ch, x, d, rot, L, W);
}
function tanker(ch, x, d, rot) {
  const L = 8.2, W = 1.5;
  frame(x, d, rot);
  hull(L, W, 0.32, P.hullRed, P.deckGreen);
  // pipe run + manifold
  box(-0.05, -L / 2 + 1.5, 0.05, L / 2 - 1.8, 0.32, 0.4, P.metal, P.metal);
  for (let i = 0; i < 4; i++) box(-0.4, -1.5 + i * 1.1, 0.4, -1.4 + i * 1.1, 0.32, 0.38, P.metalD, P.metalD);
  sideStyle(T_RESID, 0.5, 0.25);
  box(-W * 0.42, -L / 2 + 0.2, W * 0.42, -L / 2 + 1.2, 0.32, 1.2, P.shipWhite, P.shipWhite);
  plain();
  box(-0.13, -L / 2 + 0.3, 0.13, -L / 2 + 0.6, 1.2, 1.45, P.hullDark, P.hullDark);
  shadowBox(-W / 2, -L / 2, W / 2, L / 2, 0.8, WATER_REL);
  frameId();
  shipWake(ch, x, d, rot, L, W);
}
function trawler(ch, x, d, rot, s = 1) {
  const L = 2.3 * s, W = 0.75 * s;
  frame(x, d, rot);
  hull(L, W, 0.22, rand() < 0.5 ? P.navy : P.hullRed, P.deckGrey, 0.3);
  box(-0.25 * s, -0.25 * s, 0.25 * s, 0.35 * s, 0.22, 0.55, P.shipWhite, P.shipWhite);
  box(-0.03, -0.8 * s, 0.03, -0.74 * s, 0.22, 0.95, P.metalD, P.metalD);
  shadowBox(-W / 2, -L / 2, W / 2, L / 2, 0.45, WATER_REL);
  frameId();
  shipWake(ch, x, d, rot, L, W);
}
function sailboat(ch, x, d, rot) {
  frame(x, d, rot);
  hull(1.2, 0.42, 0.14, P.shipWhite, P.deckRust, 0.35);
  // sail: a vertical triangle
  if (room(6)) {
    const c = P.shipWhite;
    checkTall(-0.05, -0.35, 0.05, 0.3, 1.25);
    vtx(0, GROUND_Y + 0.2, -0.35, c, 0.9, 0, 0); vtx(0, GROUND_Y + 0.2, 0.3, c, 0.9, 0, 0); vtx(0.02, GROUND_Y + 1.25, 0.28, c, 1.1, 0, 0);
    vtx(0, GROUND_Y + 0.2, 0.3, c, 0.8, 0, 0); vtx(0, GROUND_Y + 0.2, -0.35, c, 0.8, 0, 0); vtx(0.02, GROUND_Y + 1.25, 0.28, c, 0.8, 0, 0);
  }
  shadowBox(-0.05, -0.35, 0.05, 0.3, 1.0, WATER_REL);
  frameId();
  shipWake(ch, x, d, rot, 1.2, 0.4);
}
function shipWake(ch, x, d, rot, L, W) {
  const hx = -Math.sin(rot), hd = Math.cos(rot); // heading (local +d)
  addWake(ch, x - hx * L * 0.45, d - hd * L * 0.45, hx, hd, Math.min(12, L * 1.6 + 3), W * 0.55);
}

// =============================================================================
// COAST (280–400): beach, harbour, headland, seaside town
// =============================================================================
function genCoast(w, ch, k, d0) {
  const d1 = d0 + CHUNK;
  if (k === 7) {
    // sea part: fishing boats, a sailboat, the breakwater + harbour mouth
    trawler(ch, rr(-15, -10), d0 + rr(2, 10), rr(0, TAU), 0.85);
    sailboat(ch, rr(9.5, 12), d0 + rr(2, 8), rr(-0.6, 0.6));
    breakwater();
    // headland rocks + lighthouse
    for (let i = 0; i < 16; i++) {
      const x = rr(-17, -8.5), s = shoreD(x);
      const d = s + rr(-0.6, 1.4);
      if (d < d0 || d > d1 - 1) continue;
      rock(x, d, rr(0.3, 0.7), -0.35, rr(0.35, 0.75), rand() < 0.5 ? P.rock : P.rockD);
    }
    lighthouse(-12.8, 303.8, 0, 0.9);
    frame(-12.8, 303.8, 0); box(-1.3, 0.5, -0.4, 1.3, 0, 0.45, P.wallW, P.roofTerra); shadowBox(-1.3, 0.5, -0.4, 1.3, 0.45); frameId();
    beachStuff(d0, d1);
    harbor(ch, d0, d1);
    promenade(d0, d1);
  } else if (k === 8) {
    beachStuff(d0, d1);
    harbor(ch, d0, d1);
    promenade(d0, d1);
    for (let i = 0; i < 3; i++) laneRoad(LANES_X[i], 324.6, d1, 'asphalt');
    crossRoad(340, 'main', -30, HARBOR_X0 + 22);
    coastTown(d0, d1);
    // headland pines + rocks
    for (let i = 0; i < 18; i++) {
      const x = rr(-18, -9), d = rr(d0, 333);
      if (d < shoreD(x) + 1.5) continue;
      if (rand() < 0.5) treeCone(x, d, rr(0.38, 0.5), rr(1.2, 1.7), jit(P.pine, 0.15)); else bush(x, d, rr(0.25, 0.4), P.bush);
    }
  } else {
    for (let i = 0; i < 3; i++) laneRoad(LANES_X[i], d0, 380, 'asphalt');
    laneRoad(0, 380, d1, 'asphalt');
    laneRoad(-5.5, 380, d1, 'dirt'); laneRoad(5.5, 380, d1, 'dirt');
    crossRoad(380, 'asphalt');
    coastTown(d0, 378);
    countryParcels(w, ch, 381.6, d1, k);
  }
}
function breakwater() {
  // concrete crest + tetrapods along the harbour breakwater
  frameId();
  box(BW.x0, BW.d0 + 0.3, 40, BW.d1 - 0.3, -0.2, 0.2, P.concreteD, P.concrete);
  for (let x = BW.x0 + 0.3; x < 30; x += 0.55) {
    rock(x + rr(-0.1, 0.1), BW.d0 + rr(-0.1, 0.25), rr(0.22, 0.3), -0.25, 0.32, P.concrete);
    rock(x + rr(-0.1, 0.1), BW.d1 + rr(-0.25, 0.1), rr(0.22, 0.3), -0.25, 0.32, P.concrete);
  }
  cyl(BW.x0 + 0.4, (BW.d0 + BW.d1) / 2, 0.22, 0.2, 1.0, 6, P.redPaint, P.shipWhite);
}
function beachStuff(d0, d1) {
  // umbrellas + towels on the sand, only where lanes are not required clear (d < 324)
  const n = LOWQ ? 7 : 14;
  for (let i = 0; i < n; i++) {
    const x = rr(-8.2, 8.2);
    const s = shoreD(x);
    const d = rr(s + 1.6, 321.3);
    if (d < d0 || d > d1 || d < s + 1.4) continue;
    const c = pick(P.umbrella);
    if (rand() < 0.35) { frame(x, d, rr(-0.4, 0.4)); flat(-0.16, -0.32, 0.16, 0.32, L_ROAD, c); frameId(); continue; }
    cyl(x, d, 0.025, 0, 0.38, 3, P.shipWhite, P.shipWhite, false);
    LR[0] = 0.33; LH[0] = 0.33; LK[0] = 0.85; LR[1] = 0; LH[1] = 0.45; LK[1] = 1.1;
    frame(x, d, rand()); lathe(0, 0, 2, 6, c, 0); frameId();
    shadowDisc(x, d, 0.3, 0.45);
  }
  // lifeguard tower
  if (d0 <= 316 && d1 > 316) {
    frame(-3.2, 316.4, 0);
    for (const [a, b] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) box(a - 0.04, b - 0.04, a + 0.04, b + 0.04, 0, 0.7, P.mud, P.mud);
    box(-0.38, -0.38, 0.38, 0.38, 0.7, 1.05, P.shipWhite, P.redPaint);
    shadowBox(-0.38, -0.38, 0.38, 0.38, 1.05);
    frameId();
  }
}
function promenade(d0, d1) {
  // seaside road + palm row, just inland of the beach
  const a = Math.max(d0, 321.8), b = Math.min(d1, 324.6);
  if (b <= a) return;
  frameId(); uvMode(0, 0);
  flat(-11, 321.8, HARBOR_X0, 322.4, L_WALK, P.walk);
  flat(-11, 322.4, HARBOR_X0, 324.6, L_ROAD, P.asphalt);
  for (let x = -10; x < HARBOR_X0 - 1; x += 2.5) flat(x, 323.45, x + 1.2, 323.55, L_MARK, P.paint, 0.85);
  for (let x = -9.5; x < HARBOR_X0 - 0.5; x += 1.9) {
    if (Math.abs(x) < 1.5 || Math.abs(Math.abs(x) - 5.5) < 1.5) continue;
    palm(x + rr(-0.2, 0.2), 321.3, rr(1.0, 1.3));
  }
}
function harbor(ch, d0, d1) {
  // quay walls, pier, moored boats, cranes, containers, warehouses — right side (x > 9)
  frameId(); uvMode(0, 0);
  const X0 = HARBOR_X0;
  if (d0 < HARBOR_D1) {
    const a = Math.max(d0, shoreD(X0) - 0.5), b = Math.min(d1, HARBOR_D1);
    // left quay (x = 9), top quay (d = 329)
    if (b > a) { plain(); box(X0 - 0.5, a, X0 + 0.35, b, -0.6, 0.1, P.concreteD, P.concrete); }
    if (d1 >= HARBOR_D1 - 0.5 && d0 < HARBOR_D1 + 1) box(X0 - 0.5, HARBOR_D1 - 0.35, 40, HARBOR_D1 + 0.3, -0.6, 0.1, P.concreteD, P.concrete);
    // pier out into the basin (x 10.4 – 12.0)
    const pa = Math.max(d0, 304), pb = Math.min(d1, HARBOR_D1);
    if (pb > pa) {
      box(10.4, pa, 12.0, pb, -0.5, 0.12, P.concreteD, P.concrete);
      for (let d = Math.ceil(pa / 3) * 3; d < pb; d += 3) { cyl(10.55, d, 0.06, 0.12, 0.22, 4, P.hullDark, P.hullDark); cyl(11.85, d, 0.06, 0.12, 0.22, 4, P.hullDark, P.hullDark); }
      shadowBox(10.4, pa, 12.0, pb, 0.18, WATER_REL);
    }
    // moored boats between quay and pier, a cargo ship right of the pier
    if (d0 <= 310 && d1 > 310) {
      trawler(ch, 8.8, 309, Math.PI, 0.9); trawler(ch, 9.3, 314.5, 0, 0.8);
      containerShip(ch, 14.1, 316, 0, 0.95);
      ch.nwake = 0; // moored: no wakes
    }
    if (d0 <= 322 && d1 > 322) { trawler(ch, 8.7, 321.5, Math.PI, 0.85); sailboat(ch, 9.6, 325.2, 1.4); ch.nwake = 0; }
    // tug
    if (d0 <= 300 && d1 > 300) trawler(ch, 12.8, 301.5, 0.4, 0.7);
  }
  // quay yard: gantry cranes, containers, warehouses
  const ya = Math.max(d0, HARBOR_D1 + 0.4), yb = Math.min(d1, 378);
  if (yb > ya) {
    uvMode(8, 8);
    flat(X0 - 0.3, ya, 22, yb, L_BASE, P.paving);
    uvMode(0, 0);
    // rail tracks along the quay
    if (ya < 333) { flat(7.4, 329.6, 22, 329.75, L_WALK, P.metalD); flat(7.4, 331.2, 22, 331.35, L_WALK, P.metalD); }
    if (d0 <= 330 && d1 > 330) { gantry(8.7, 330.5); gantry(13.2, 330.5); }
    // container stacks
    for (let blk = 0; blk < 4; blk++) {
      const bx = 7.5 + blk * 2.4, bd = 332.6;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
        const lv = (hash2(blk * 7 + r, c) * 3.2) | 0;
        for (let l = 0; l <= lv; l++) {
          if (bd + r * 1.3 + 0.7 > 338.2) continue;
          container(bx + c * 0.56, bd + r * 1.32, 0, l, P.cont[(hash2(blk + r * 5, c * 3 + l) * P.cont.length) | 0]);
        }
        if (bd + r * 1.3 + 0.7 <= 338.2) shadowBox(bx + c * 0.56 - 0.26, bd + r * 1.32 - 0.62, bx + c * 0.56 + 0.26, bd + r * 1.32 + 0.62, (lv + 1) * 0.28);
      }
    }
    // warehouses behind the cross road
    for (let i = 0; i < 3; i++) {
      const wd0 = 342.4 + i * 5.2;
      if (wd0 < d0 || wd0 + 4.4 > d1) continue;
      warehouse(7.1, wd0, 11.4, wd0 + 4.4, rr(0.9, 1.3));
      warehouse(12.2, wd0, 17.6, wd0 + 4.4, rr(0.9, 1.4));
    }
  }
}
function gantry(x, d) {
  // ship-to-shore crane: two leg frames straddling the rail, boom over the water
  const h = 2.8;
  frameId();
  for (const lx of [x - 0.55, x + 0.55]) {
    box(lx - 0.07, d - 0.9, lx + 0.07, d - 0.76, 0, h, P.redPaint, P.redPaint);
    box(lx - 0.07, d + 0.76, lx + 0.07, d + 0.9, 0, h, P.redPaint, P.redPaint);
  }
  box(x - 0.65, d - 0.95, x + 0.65, d + 0.95, h, h + 0.35, P.redPaint, P.shipWhite);
  box(x - 0.2, d - 4.6, x + 0.2, d + 1.4, h + 0.35, h + 0.55, P.redPaint, P.redPaint);
  box(x - 0.35, d - 0.6, x + 0.35, d + 0.2, h + 0.55, h + 0.9, P.shipWhite, P.shipWhite);
  shadowBox(x - 0.65, d - 0.95, x + 0.65, d + 0.95, h + 0.3);
  shadowBox(x - 0.2, d - 4.6, x + 0.2, d + 1.4, h + 0.5);
}
function warehouse(x0, d0, x1, d1, h) {
  frameId();
  const c = jit(pick([P.wallB, P.wallG, P.wallSand, P.metal]), 0.1, TC2);
  sideStyle(T_CORR, 0.3, 1);
  box(x0, d0, x1, d1, 0, h, c, c, false);
  plain();
  topStyle(T_CORR, 0.25, 1);
  gable(x0 - 0.05, d0 - 0.05, x1 + 0.05, d1 + 0.05, h, 0.35, jit(pick([P.roofGrey, P.roofSlate, P.metalD, P.roofGreen]), 0.1, TC3), false);
  plain();
  shadowBox(x0, d0, x1, d1, h + 0.25);
}
// small town on the coast: houses between/around the lanes
function coastTown(dA, dB) {
  const bands = [[-4.35, -1.15], [1.15, 4.35], [6.75, 8.6], [-9.6, -6.75], [-17, -10]];
  const halves = [];
  for (let c = Math.floor(dA / CHUNK) * CHUNK + 20; c < dB + 20; c += CHUNK) { halves.push([c - 18.2, c - 1.9]); halves.push([c + 1.9, c + 18.2]); }
  for (const [ha, hb] of halves) {
    const a = Math.max(ha, dA, 326.2), b = Math.min(hb, dB);
    if (b - a < 2.2) continue;
    for (const [x0, x1] of bands) {
      if (x0 > 6 && a < HARBOR_D1 + 12) continue; // harbour yard there
      let d = a + rr(0, 0.6);
      while (d < b - 1.6) {
        const l = rr(1.6, 2.6), wdt = Math.min(x1 - x0 - 0.3, rr(1.6, 2.4));
        if (d + l > b) break;
        const cx = (x0 + x1) / 2 + rr(-0.15, 0.15) * (x1 - x0 - wdt), cd = d + l / 2;
        const r = rand();
        if (r < 0.14 && canPlace(cx, cd, 0.8)) { tree(cx, cd, 0.9); d += 2.0; continue; }
        if (r < 0.2) { gardenPatch(cx, cd, wdt, l); d += l + 0.4; continue; }
        if (canRect(cx - wdt / 2 - 0.1, cx + wdt / 2 + 0.1, cd - l / 2 - 0.1, cd + l / 2 + 0.1)) {
          house(cx, cd, wdt, l, rr(0.55, 0.9), 0, jit(pick([P.wallW, P.wallCream, P.wallPink, P.wallSand]), 0.08, TC2),
            jit(pick([P.roofTerra, P.roofTerra, P.roofBrown, P.roofSlate]), 0.1, TC3), rand() < 0.6 ? 0 : 1);
        }
        d += l + rr(0.35, 0.9);
      }
    }
  }
}
function gardenPatch(cx, cd, w, l) {
  frame(cx, cd, 0);
  flat(-w / 2, -l / 2, w / 2, l / 2, L_BASE, jit(P.grassL, 0.1, TC3));
  frameId();
  for (let i = 0; i < 3; i++) { const x = cx + rr(-w / 2 + 0.3, w / 2 - 0.3), d = cd + rr(-l / 2 + 0.3, l / 2 - 0.3); if (canPlace(x, d, 0.3)) bush(x, d, rr(0.2, 0.3), P.bush); }
}

// =============================================================================
// COUNTRY (380–640): fields, forests, farms, river, village
// =============================================================================
const CROPS = [P.cropG, P.cropY, P.cropGold, P.plough, P.fallow, P.mustard, P.cabbage, P.cropG, P.cropY];
function genCountry(w, ch, k, d0) {
  const d1 = d0 + CHUNK, cr = d0 + 20;
  // lanes: paved centre road, dirt tracks on the sides (wide in the siege-tank corridor)
  laneRoad(0, d0, d1, 'asphalt');
  laneRoad(-5.5, d0, d1, 'dirt'); laneRoad(5.5, d0, d1, 'dirt');
  crossRoad(cr, 'gravel');
  // field hedge path on the chunk seam
  frameId(); flat(-40, d0, 40, d0 + 0.35, L_BASE, P.dirt, 0.9); flat(-40, d1 - 0.35, 40, d1, L_BASE, P.dirt, 0.9);
  if (d0 <= RIVER_C && RIVER_C < d1) river(ch, d0, d1);
  countryParcels(w, ch, d0 + 0.4, d1 - 0.4, k);
  if (k === 12) { windTurbine(ch, 11.8, 491); windTurbine(ch, 14.6, 509.5); windTurbine(ch, -13.2, 513); }
  if (k === 13) village(ch, d0, d1);
  if (k === 15) outskirts(ch, d0, d1);
}
// fields / forests / farms between d = dA..dB (split by the cross roads)
function countryParcels(w, ch, dA, dB, k) {
  const halves = [];
  for (let c = Math.floor(dA / CHUNK) * CHUNK + 20; c < dB + 20; c += CHUNK) { halves.push([c - 19.6, c - 1.6]); halves.push([c + 1.6, c + 19.6]); }
  const inner = [[-4.4, -1.1], [1.1, 4.4]];
  let farm = k % 2 ? -1 : 1;
  for (const [ha, hb] of halves) {
    const a = Math.max(ha, dA), b = Math.min(hb, dB);
    if (b - a < 2) continue;
    // inner bands: long strip fields
    for (const [x0, x1] of inner) {
      if (k === 13 && x0 < 0 && rand() < 0.5) continue;
      if (rand() < 0.14 && b - a > 9 && canRect(x0 + 0.3, x1 - 0.3, a + 1, a + 7)) { smallFarm(x0, x1, a, b); continue; }
      splitField(x0, x1, a, b, 0);
    }
    // outer: per side, columns of fields/forest
    for (const side of [-1, 1]) {
      let x = 6.6;
      const cols = [];
      while (x < 26) { const wd = x < 8 ? rr(4.2, 6.5) : rr(4.5, 8); cols.push([x, Math.min(x + wd, 30)]); x += wd; }
      for (let ci = 0; ci < cols.length; ci++) {
        let [c0, c1] = cols[ci];
        const xa = side < 0 ? -c1 : c0, xb = side < 0 ? -c0 : c1;
        const cx = (xa + xb) / 2, cd = (a + b) / 2;
        if (k === 13 && side < 0 && ci < 2) continue; // village
        if (k === 15 && ci === 0) continue;           // outskirts
        const f = forestF(cx, cd);
        const riverNear = Math.abs(cd - riverD(cx)) < 12 && k === 11;
        if (f > 0.5 && Math.abs(cx) > 8 && !riverNear) { forest(xa, xb, a, b); continue; }
        if (farm === side && ci >= 1 && ci <= 2 && b - a > 12 && !riverNear) { farmstead(xa, xb, a, b); farm = 0; continue; }
        const r = rand();
        if (r < 0.1 && !riverNear) orchard(xa, xb, a, b);
        else if (r < 0.16 && !riverNear && Math.abs(cx) < 16) greenhouses(xa, xb, a, b);
        else splitField(xa, xb, a, b, 1);
      }
    }
  }
}
function splitField(x0, x1, a, b, outer) {
  // one to three fields along d, separated by hedge rows or farm paths
  const n = b - a > 11 ? (rand() < 0.45 ? 2 : rand() < 0.3 ? 3 : 1) : 1;
  let fa = a;
  for (let i = 0; i < n; i++) {
    const fb = i === n - 1 ? b : rr(fa + (b - a) / n * 0.7, fa + (b - a) / n * 1.25);
    field(x0 + 0.12, x1 - 0.12, fa + 0.12, fb - 0.12);
    if (i < n - 1) {
      if (outer && rand() < 0.7) hedge(x0 + 0.3, x1 - 0.3, fb + 0.1, true);
      else { frameId(); flat(x0, fb - 0.05, x1, fb + 0.25, L_BASE + 0.002, P.dirt, 0.95); }
    }
    fa = fb + 0.2;
  }
  if (outer && rand() < 0.7) hedge(x1 - 0.05, x1 - 0.05, a + 0.3, false, b - 0.3);
  if (outer) for (let i = 0; i < 2; i++) if (rand() < 0.45) { const x = rand() < 0.5 ? x0 + 0.5 : x1 - 0.5; const d = rr(a + 0.8, b - 0.8); tree(x, d, rr(0.95, 1.15), rand() < 0.2 ? 1 : 0); }
}
function field(x0, x1, a, b) {
  const base = pick(CROPS);
  const c = jit(base, 0.12, TC2);
  const xm = (x0 + x1) / 2;
  if (Math.abs(a - riverD(xm)) < 3.6 || Math.abs(b - riverD(xm)) < 3.6) return;
  const long = (x1 - x0) < (b - a);
  const rows = long ? rand() < 0.75 : rand() < 0.25;
  const diag = rand() < 0.18 ? (rand() < 0.5 ? 0.6 : -0.6) : 0;
  setTile(base === P.fallow ? 0 : T_ROWS);
  uvMode(rr(1.3, 2.2), 1, rows, 0, 0, diag);
  frameId();
  let fa = a, fb = b;
  const rc = riverD(xm);
  if (fa < rc + 3.8 && fb > rc - 3.8) { if (rc - 3.8 - fa > fb - rc - 3.8) fb = rc - 3.8; else fa = rc + 3.8; }
  if (fb - fa > 0.6) {
    // some fields are harvested in two passes: two tones
    if (!LOWQ && rand() < 0.2 && fb - fa > 4) {
      const m = rr(fa + 1.5, fb - 1.5);
      flat(x0, fa, x1, m, L_BASE, c);
      flat(x0, m, x1, fb, L_BASE, tint(c, P.cropY, 0.45, TC3));
    } else flat(x0, fa, x1, fb, L_BASE, c);
  }
  setTile(0); uvMode(0, 0);
  // hay bales on golden fields
  if (!LOWQ && (base === P.cropY || base === P.cropGold) && rand() < 0.45) {
    for (let i = 0; i < 6; i++) {
      const x = rr(x0 + 0.4, x1 - 0.4), d = rr(fa + 0.4, fb - 0.4);
      cyl(x, d, 0.14, 0, 0.18, 6, P.cropGold, P.cropY);
    }
  }
}
// barn, silo and a yard squeezed between two lanes
function smallFarm(x0, x1, a, b) {
  const cx = (x0 + x1) / 2;
  frameId();
  flat(x0 + 0.15, a + 0.4, x1 - 0.15, a + 7.2, L_BASE, jit(P.dirt, 0.08, TC3), 0.95);
  frame(cx, a + 3.2, 0);
  sideStyle(T_SHUTTER, 0.8, 0.5);
  box(-0.95, -1.4, 0.95, 1.4, 0, 0.85, P.barn, P.barn, false);
  plain(); topStyle(T_CORR, 0.25, 1);
  gable(-1.05, -1.5, 1.05, 1.5, 0.85, 0.6, P.roofGrey, true);
  plain(); shadowBox(-0.95, -1.4, 0.95, 1.4, 1.3);
  frameId();
  const sx = cx + (x0 < 0 ? 0.7 : -0.7), sd = a + 5.6;
  cyl(sx, sd, 0.34, 0, 1.5, 8, P.metal, P.metal, false);
  LR[0] = 0.34; LH[0] = 1.5; LK[0] = 1; LR[1] = 0; LH[1] = 1.78; LK[1] = 1.1;
  frame(sx, sd, 0); lathe(0, 0, 2, 8, P.metalD, 0); frameId();
  shadowDisc(sx, sd, 0.34, 1.7);
  splitField(x0, x1, a + 7.6, b, 0);
}
function hedge(x0, x1, d, alongX, d1 = d) {
  const step = LOWQ ? 1.4 : 0.8;
  if (alongX) for (let x = x0; x < x1; x += step) { const xx = x + rr(-0.1, 0.1); if (canPlace(xx, d, 0.4)) treeRound(xx, d + rr(-0.1, 0.1), rr(0.3, 0.42), rr(0.5, 0.7), jit(P.bush, 0.15)); }
  else for (let dd = d; dd < d1; dd += step) { const z = dd + rr(-0.1, 0.1); if (canPlace(x0, z, 0.4)) treeRound(x0 + rr(-0.1, 0.1), z, rr(0.3, 0.42), rr(0.5, 0.7), jit(P.bush, 0.15)); }
}
function forest(x0, x1, a, b) {
  const step = LOWQ ? 1.45 : 1.08;
  for (let d = a + 0.4; d < b - 0.2; d += step * 0.87) {
    for (let x = x0 + 0.3 + ((d * 1.7) % step); x < x1 - 0.2; x += step) {
      const xx = x + rr(-0.3, 0.3), dd = d + rr(-0.3, 0.3);
      if (Math.abs(xx) > 22) continue;
      const f = forestF(xx, dd);
      if (f < 0.47 && rand() < 0.7) continue;
      if (!canPlace(xx, dd, 0.7)) continue;
      const h = coastalH(xx, dd);
      if (h < -0.02) continue;
      tree(xx, dd, rr(0.9, 1.15), rand() < 0.35 ? 1 : 0, h);
    }
  }
}
function orchard(x0, x1, a, b) {
  frameId();
  flat(x0 + 0.1, a + 0.1, x1 - 0.1, b - 0.1, L_BASE, jit(P.grassL, 0.08, TC3));
  for (let d = a + 0.7; d < b - 0.5; d += 1.1) for (let x = x0 + 0.6; x < x1 - 0.5; x += 1.0) {
    if (canPlace(x, d, 0.4)) treeRound(x, d, rr(0.32, 0.4), rr(0.55, 0.7), jit(P.tree3, 0.12));
  }
}
function greenhouses(x0, x1, a, b) {
  const w = 0.9;
  for (let x = x0 + 0.3; x + w < x1 - 0.2; x += w + 0.35) {
    const la = a + 0.5, lb = Math.min(b - 0.5, la + rr(5, 9));
    if (!canRect(x, x + w, la, lb)) continue;
    frameId();
    sideStyle(T_GLASS, 0.5, 0.4); topStyle(T_GLASS, 0.45, 0.6);
    box(x, la, x + w, lb, 0, 0.32, P.glassL, P.glassL, false);
    gable(x - 0.02, la, x + w + 0.02, lb, 0.32, 0.2, P.glassL, true, 0.9);
    plain();
    shadowBox(x, la, x + w, lb, 0.45);
  }
}
function farmstead(x0, x1, a, b) {
  const cx = (x0 + x1) / 2, cd = (a + b) / 2;
  frameId();
  flat(x0 + 0.2, a + 0.2, x1 - 0.2, b - 0.2, L_BASE, jit(P.dirt, 0.1, TC3), 0.95);
  // farm house, barn, silos, trees
  const rot = rr(-0.08, 0.08);
  house(cx - 1.1, cd + 2.2, 1.7, 1.4, 0.75, rot, jit(P.wallCream, 0.06, TC2), jit(P.roofTerra, 0.1, TC3), 0);
  // barn
  frame(cx + 0.9, cd - 1.2, rot);
  sideStyle(T_SHUTTER, 0.8, 0.5);
  box(-1.1, -1.6, 1.1, 1.6, 0, 1.0, P.barn, P.barn, false);
  plain(); topStyle(T_CORR, 0.25, 1);
  gable(-1.2, -1.7, 1.2, 1.7, 1.0, 0.75, P.roofGrey, true);
  plain();
  shadowBox(-1.1, -1.6, 1.1, 1.6, 1.5);
  frameId();
  for (let i = 0; i < 2; i++) {
    const sx = cx - 1.6 + i * 0.9, sd = cd - 2.6;
    cyl(sx, sd, 0.36, 0, 1.7, 8, P.metal, P.metal, false);
    LR[0] = 0.36; LH[0] = 1.7; LK[0] = 1; LR[1] = 0; LH[1] = 2.0; LK[1] = 1.1;
    frame(sx, sd, 0); lathe(0, 0, 2, 8, P.metalD, 0); frameId();
    shadowDisc(sx, sd, 0.36, 1.9);
  }
  // tractor
  truck(cx + rr(-1, 1), cd + 0.8, rr(0, TAU), P.redPaint);
  for (let i = 0; i < 5; i++) { const x = rr(x0 + 0.4, x1 - 0.4), d = rr(a + 0.4, b - 0.4); if (canPlace(x, d, 0.9) && Math.hypot(x - cx, d - cd) > 2.8) tree(x, d, 1.1, 0); }
}
function river(ch, d0, d1) {
  // reeds and bank trees; bridges where the lanes cross
  for (let x = -24; x < 24; x += LOWQ ? 1.2 : 0.7) {
    const c = riverD(x);
    for (const s of [-1, 1]) {
      const d = c + s * rr(2.1, 2.7);
      if (!canPlace(x, d, 0.3)) continue;
      if (rand() < 0.55) cone(x + rr(-0.2, 0.2), d, rr(0.12, 0.2), -0.1, rr(0.22, 0.34), 4, jit(P.cropG, 0.2, TC3));
      const td = c + s * rr(3.4, 4.6);
      if (rand() < 0.4 && canPlace(x, td, 0.75)) tree(x, td, rr(0.9, 1.15), rand() < 0.2 ? 1 : 0);
    }
  }
  for (let i = 0; i < 3; i++) {
    const lx = LANES_X[i];
    let lo = Infinity, hi = -Infinity;
    for (let x = lx - 1.4; x <= lx + 1.4; x += 0.35) { const c = riverD(x); lo = Math.min(lo, c); hi = Math.max(hi, c); }
    const a = lo - 2.9, b = hi + 2.9;
    frameId();
    box(lx - 1.35, a, lx + 1.35, b, -0.9, 0.06, P.concreteD, P.concrete);
    uvMode(0, 0);
    if (i === 1) { flat(lx - 1.1, a, lx + 1.1, b, 0.075, P.asphalt); for (let d = a + 0.4; d < b - 1; d += 2.5) flat(lx - 0.05, d, lx + 0.05, d + 1.2, 0.085, P.paint, 0.85); }
    else flat(lx - 1.1, a, lx + 1.1, b, 0.075, P.roofBrown);
    box(lx - 1.35, a, lx - 1.2, b, 0.06, 0.22, P.concrete, P.concrete);
    box(lx + 1.2, a, lx + 1.35, b, 0.06, 0.22, P.concrete, P.concrete);
    shadowBox(lx - 1.35, a + 0.4, lx + 1.35, b - 0.4, 0.25, WATER_REL);
  }
}
function windTurbine(ch, x, d) {
  const h = 2.55;
  cyl(x, d, 0.12, 0, h, 6, P.shipWhite, P.shipWhite, false);
  frame(x, d, 0); box(-0.12, -0.2, 0.12, 0.3, h - 0.05, h + 0.18, P.shipWhite, P.shipWhite); frameId();
  shadowDisc(x, d, 0.12, h);
  // rotor faces the camera side (−d); spins about its axis
  addSpinner(ch, 1, x, GROUND_Y + h + 0.06, d - 0.28, rr(0.9, 1.3));
}
function village(ch, d0, d1) {
  // cluster of houses and a church on the left
  const cx = -10.5, cd = 548;
  frameId();
  uvMode(6, 6);
  setTile(T_SLAB); flat(-14.5, 529.5, -7.2, 533.5, L_BASE, P.paving); setTile(0); uvMode(0, 0);
  // church: nave + tower with spire
  frame(cx, cd, 0.05);
  sideStyle(T_BRICK, 1.4, 1.2);
  box(-0.9, -2.2, 0.9, 1.4, 0, 1.2, P.wallCream, P.wallCream, false);
  plain(); topStyle(T_ROOF, 0.5, 0.45);
  gable(-1.0, -2.3, 1.0, 1.5, 1.2, 0.8, P.roofSlate, true); plain();
  box(-0.55, 1.4, 0.55, 2.5, 0, 2.3, P.wallCream, P.wallCream);
  cone(0, 1.95, 0.62, 2.3, 3.9, 4, P.roofSlate, Math.PI / 4);
  shadowBox(-0.9, -2.2, 0.9, 1.4, 1.7); shadowBox(-0.55, 1.4, 0.55, 2.5, 3.2);
  frameId();
  for (let i = 0; i < 26; i++) {
    const x = rr(-19, -7.3), d = rr(d0 + 2, d1 - 2);
    if (Math.hypot(x - cx, d - cd) < 3.6 || (d > 529 && d < 534 && x > -14.5)) continue;
    if (!canRect(x - 1.2, x + 1.2, d - 1.2, d + 1.2)) continue;
    const wdt = rr(1.3, 2.0), l = rr(1.2, 1.9);
    house(x, d, wdt, l, rr(0.55, 0.85), rr(-0.25, 0.25), jit(pick([P.wallW, P.wallCream, P.wallSand, P.wallPink]), 0.08, TC2),
      jit(pick([P.roofTerra, P.roofBrown, P.roofSlate]), 0.1, TC3), rand() < 0.5 ? 0 : 1);
    if (rand() < 0.5) { const tx = x + rr(-1.4, 1.4), td = d + rr(-1.4, 1.4); if (canPlace(tx, td, 0.7)) tree(tx, td, 0.9, 0); }
  }
  // a few houses along the inner left band too
  for (let d = d0 + 2.5; d < d1 - 2; d += rr(2.6, 3.6)) {
    if (crossDist(d) < 3.2) continue;
    if (canRect(-4.3, -1.25, d - 1, d + 1)) house(-2.75, d, rr(1.6, 2.4), rr(1.5, 1.9), rr(0.5, 0.8), 0, jit(P.wallCream, 0.08, TC2), jit(P.roofTerra, 0.1, TC3), 0);
  }
}
function outskirts(ch, d0, d1) {
  // edge of town: gas station, sheds, rows of houses, parking
  for (const side of [-1, 1]) {
    for (let d = d0 + 2.2; d < d1 - 2; d += rr(2.5, 3.4)) {
      if (crossDist(d) < 3.3) continue;
      const x = side * rr(8.2, 9.6);
      if (!canRect(x - 1.3, x + 1.3, d - 1.1, d + 1.1)) continue;
      if (rand() < 0.2) { tree(x, d, 1); continue; }
      house(x, d, rr(1.6, 2.2), rr(1.5, 2.0), rr(0.6, 0.95), 0, jit(pick([P.wallW, P.wallCream, P.wallB]), 0.08, TC2), jit(pick([P.roofTerra, P.roofSlate, P.roofGrey]), 0.1, TC3), rand() < 0.5 ? 0 : 1);
    }
  }
  // gas station
  frameId();
  uvMode(0, 0);
  flat(10.8, 605, 16.5, 611.5, L_ROAD, P.asphalt);
  box(11.4, 609.2, 13.8, 610.9, 0, 0.6, P.wallW, P.roofLight);
  for (const px of [12.2, 14.6]) for (const pd of [606.4, 607.8]) box(px - 0.08, pd - 0.08, px + 0.08, pd + 0.08, 0, 0.8, P.metal, P.metal);
  box(11.8, 605.8, 15.4, 608.4, 0.8, 0.92, P.redPaint, P.shipWhite);
  shadowBox(11.8, 605.8, 15.4, 608.4, 0.9); shadowBox(11.4, 609.2, 13.8, 610.9, 0.6);
  car(12.9, 607.1, 0, P.car[0]); car(14.9, 606.5, 0.2, P.car[3]);
  warehouse(-16, 624, -10.5, 628.5, 1.2);
  warehouse(10.4, 623, 15.8, 628.2, 1.1);
}

// =============================================================================
// CITY (640–960)
// =============================================================================
function urbanI(d) { return sstep(640, 720, d) * (1 - 0.5 * sstep(915, 960, d)) * (0.7 + 0.3 * sstep(750, 830, d)); }
// city: avenues on the three lanes, main streets on the cross roads, and everything else is
// building lots separated by narrow alleys (no filler roads — the city reads as rooftops)
function genCity(w, ch, k, d0) {
  const d1 = d0 + CHUNK, cr = d0 + 20;
  for (let i = 0; i < 3; i++) laneRoad(LANES_X[i], d0, d1, 'avenue');
  if (cr === 820) highway(ch, cr); else crossRoad(cr, 'main');
  const I = urbanI(cr);
  const half = cr === 820 ? 4.0 : 1.95;
  const halves = [[d0, cr - half], [cr + half, k === 21 ? CANAL_C - 2.5 : d1]];
  if (k === 21) canal(ch);
  for (let hi = 0; hi < 2; hi++) {
    const [a, b] = halves[hi];
    for (const side of [-1, 1]) {
      // inner band between lane 0 and lane ±5.5
      const ix0 = side < 0 ? -4.1 : 1.4, ix1 = side < 0 ? -1.4 : 4.1;
      if (a < CRAWLER.d1 || k === 16) medianGarden(ix0, ix1, a, b);
      else lotRow(ix0, ix1, a, b, I * 0.8, true);
      // outer district
      const ox0 = side < 0 ? -24 : 6.9, ox1 = side < 0 ? -6.9 : 24;
      if (k === 18 && side > 0) { if (hi === 0) cityPark(ch); continue; }
      if (k === 22 && side < 0 && hi === 0) { stadium(-20.5, -6.9, a + 0.2, b - 0.2); continue; }
      if (k === 16) { suburb(ox0, ox1, a, b, side); continue; }
      let x = 6.9;
      let col = 0;
      while (x < 23) {
        const wdt = x < 8 ? rr(3.8, 5.4) : rr(3.2, 5.6);
        const xa = side < 0 ? -(x + wdt) : x, xb = side < 0 ? -x : x + wdt;
        const r = hash2(k * 31 + col * 7 + (side + 1), hi * 13 + 5);
        if (k === 21 && side > 0 && hi === 1 && col === 0) plaza(xa, xb, a, b);
        else if (r < 0.09 && col > 0) parking(xa, xb, a + 0.3, b - 0.3);
        else if (r < 0.15) pocketPark(xa, xb, a + 0.3, b - 0.3);
        else lotRow(xa, xb, a, b, I * (col === 0 ? 1 : 0.85), false);
        x += wdt + 0.35; col++;
      }
    }
  }
}
// canal across the city: stone embankments, bridges on the lanes, boats, trees
function canal(ch) {
  const c = CANAL_C;
  frameId(); uvMode(0, 0);
  for (const s of [-1, 1]) {
    const e = c + s * 2.0;
    box(-40, Math.min(e - s * 0.35, e + s * 0.3), 40, Math.max(e - s * 0.35, e + s * 0.3), -0.9, 0.1, P.concreteD, P.walk);
    for (let x = -22; x < 22; x += 1.5) {
      let skip = false;
      for (let i = 0; i < 3; i++) if (Math.abs(x - LANES_X[i]) < 1.9) skip = true;
      if (!skip) treeRound(x + rr(-0.2, 0.2), e + s * 0.95, rr(0.4, 0.5), rr(0.75, 0.95), jit(P.tree1, 0.12));
    }
  }
  for (let i = 0; i < 3; i++) {
    const lx = LANES_X[i];
    box(lx - 1.3, c - 2.4, lx + 1.3, c + 2.4, -0.9, 0.06, P.concreteD, P.concrete);
    flat(lx - 1.05, c - 2.4, lx + 1.05, c + 2.4, 0.075, P.asphalt);
    box(lx - 1.3, c - 2.4, lx - 1.15, c + 2.4, 0.06, 0.22, P.walk, P.walk);
    box(lx + 1.15, c - 2.4, lx + 1.3, c + 2.4, 0.06, 0.22, P.walk, P.walk);
    shadowBox(lx - 1.3, c - 2.0, lx + 1.3, c + 2.0, 0.3, WATER_REL);
  }
  // moored and moving boats (outside the bridges)
  trawler(ch, -9.2, c - 0.6, Math.PI / 2, 0.75);
  trawler(ch, 10.5, c + 0.5, -Math.PI / 2, 0.7);
  frame(-15, c + 0.7, Math.PI / 2); hull(1.8, 0.55, 0.14, P.shipWhite, P.deckRust, 0.3); box(-0.18, -0.4, 0.18, 0.3, 0.14, 0.34, P.shipWhite, P.roofLight); frameId();
  ch.nwake = 0;
}
const BED_COLS = [P.mustard, P.lavender, C(0x9a6c66), P.cabbage, P.cropGold, C(0x8a7894)];
function medianGarden(x0, x1, a, b) {
  // a formal garden strip down the boulevard: promenade, fountain plazas, flower beds framed by
  // low clipped hedges, benches. Nothing rises above 0.2, so the siege tank's path stays clear.
  frameId(); setTile(0); uvMode(0, 0);
  const cx = (x0 + x1) / 2;
  flat(x0 + 0.05, a + 0.2, x1 - 0.05, b - 0.2, L_BASE, jit(P.grassL, 0.05, TC3));
  flat(x0 + 0.05, a + 0.2, x0 + 0.2, b - 0.2, L_ROAD, P.walk, 0.95);
  flat(x1 - 0.2, a + 0.2, x1 - 0.05, b - 0.2, L_ROAD, P.walk, 0.95);
  flat(cx - 0.19, a + 0.2, cx + 0.19, b - 0.2, L_ROAD, P.gravel, 0.95);
  const L = b - a - 0.4;
  if (L < 3) return;
  const nSeg = Math.max(1, Math.round(L / 9)), seg = L / nSeg;
  const hc = jit(P.bush, 0.06, TC2);
  for (let i = 0; i < nSeg; i++) {
    const s0 = a + 0.2 + i * seg, s1 = s0 + seg, sm = (s0 + s1) * 0.5;
    // plaza with a round fountain basin
    disc(cx, sm, 0.95, 0.95, L_WALK, P.paving, 14);
    cyl(cx, sm, 0.55, 0, 0.14, 12, P.concrete, P.concrete, false);
    disc(cx, sm, 0.5, 0.5, 0.12, P.glassL, 12, 0.9);
    cyl(cx, sm, 0.07, 0.12, 0.2, 5, P.concrete, P.paint);
    if (!LOWQ) for (const sd of [-1, 1]) box(cx + sd * 0.78 - 0.08, sm - 0.22, cx + sd * 0.78 + 0.08, sm + 0.22, 0, 0.08, P.roofBrown, P.roofBrown);
    // beds either side of the promenade, before and after the plaza
    for (let hh = 0; hh < 2; hh++) {
      const da = hh ? sm + 1.2 : s0 + 0.45, db = hh ? s1 - 0.45 : sm - 1.2;
      if (db - da < 1.2) continue;
      for (let sx = -1; sx <= 1; sx += 2) {
        const bx0 = sx < 0 ? x0 + 0.42 : cx + 0.36, bx1 = sx < 0 ? cx - 0.36 : x1 - 0.42;
        if (bx1 - bx0 < 0.5) continue;
        setTile(T_ROWS); uvMode(1.0, 0.9);
        flat(bx0, da, bx1, db, L_WALK, jit(pick(BED_COLS), 0.08, TC3));
        setTile(0); uvMode(0, 0);
        if (LOWQ) continue;
        box(bx0 - 0.07, da - 0.07, bx1 + 0.07, da + 0.05, 0, 0.16, hc, hc);
        box(bx0 - 0.07, db - 0.05, bx1 + 0.07, db + 0.07, 0, 0.16, hc, hc);
        box(bx0 - 0.07, da + 0.05, bx0 + 0.05, db - 0.05, 0, 0.16, hc, hc);
        box(bx1 - 0.05, da + 0.05, bx1 + 0.07, db - 0.05, 0, 0.16, hc, hc);
      }
    }
  }
}
// a strip of building lots along d inside [x0,x1]
function lotRow(x0, x1, a, b, I, inner) {
  frameId();
  uvMode(4, 4); setTile(T_SLAB);
  flat(x0, a, x1, b, L_BASE, jit(P.paving, 0.06, TC3));
  setTile(0); uvMode(0, 0);
  let d = a + 0.25;
  while (d < b - 1.0) {
    let l = rr(2.6, inner ? 4.6 : 6.2);
    if (b - (d + l) < 2.2) l = b - d - 0.25;
    if (l < 1) break;
    const sx0 = rr(0.08, 0.22), sx1 = rr(0.08, 0.22);
    const fa = d, fb = d + l;
    const r = rand();
    if (!inner && r < 0.07) courtyard(x0 + sx0, x1 - sx1, fa, fb);
    else building(x0 + sx0, x1 - sx1, fa, fb, I, inner);
    d += l + rr(0.22, 0.4);
  }
}
function courtyard(x0, x1, a, b) {
  frameId();
  flat(x0, a, x1, b, L_WALK, jit(P.grassL, 0.1, TC3));
  for (let i = 0; i < 3; i++) { const x = rr(x0 + 0.5, x1 - 0.5), d = rr(a + 0.5, b - 0.5); if (canPlace(x, d, 0.6)) tree(x, d, 0.85, 0); }
}
function building(x0, x1, a, b, I, inner) {
  if (!canRect(x0, x1, a, b)) return;
  const w = x1 - x0, l = b - a;
  const tall = rand() < I * (inner ? 0.45 : 0.8);
  let h = tall ? rr(2.0, 2.9) + I * 0.75 : rr(0.7, 1.5) + I * 0.7;
  if (inner) h = Math.min(h, 2.6);
  h = Math.min(h, 3.6);
  const r = rand();
  let wallC, tile, tu, tv;
  if (tall && r < 0.55) { wallC = pick([P.wallBlue, P.wallG, P.glassL, P.wallBlue, P.wallDark]); tile = T_OFFICE; tu = 1.5; tv = 1.25; }
  else if (r < 0.75) { wallC = pick([P.wallW, P.wallB, P.wallCream, P.wallSand, P.wallPink]); tile = T_RESID; tu = 1.3; tv = 1.3; }
  else { wallC = pick([P.wallBrick, P.wallB, P.wallSand, P.wallG]); tile = T_BRICK; tu = 1.8; tv = 1.1; }
  const wc = jit(wallC, 0.1, TC2);
  const rk = rand();
  const roofC = jit(rk < 0.22 ? P.roofTar : rk < 0.48 ? P.roofLight : rk < 0.6 ? P.roofGrey : rk < 0.7 ? P.roofSlate : rk < 0.78 ? P.roofGreen : rk < 0.9 ? P.concrete : P.roofTerra, 0.08, TC3);
  frameId();
  sideStyle(tile, tu, tv);
  topStyle(T_GRAVEL, 1.5, 1.5);
  if (tall && w > 1.9 && l > 1.9 && rand() < 0.55) {
    // podium + tower with a setback
    const ph = rr(0.5, 0.9);
    box(x0, a, x1, b, 0, ph, wc, roofC);
    const ix = Math.min(rr(0.25, 0.5), w * 0.2), id = Math.min(rr(0.25, 0.6), l * 0.2);
    const tx0 = x0 + ix, tx1 = x1 - ix, ta = a + id, tb = b - id;
    box(tx0, ta, tx1, tb, ph, h, wc, roofC);
    plain();
    if (!LOWQ && ph < h - 0.5 && rand() < 0.5) roofGarden(x0 + 0.1, x1 - 0.1, a + 0.1, ta - 0.08, ph);
    roofDetails(tx0, tx1, ta, tb, h);
    shadowBox(x0, a, x1, b, ph); shadowBox(tx0, ta, tx1, tb, h);
  } else {
    box(x0, a, x1, b, 0, h, wc, roofC);
    plain();
    if (!LOWQ && w > 1 && l > 1) { const p = 0.07; box(x0, a, x1, a + p, h, h + 0.08, wc, wc); box(x0, b - p, x1, b, h, h + 0.08, wc, wc); box(x0, a, x0 + p, b, h, h + 0.08, wc, wc); }
    roofDetails(x0, x1, a, b, h);
    shadowBox(x0, a, x1, b, h);
  }
  plain();
}
function roofGarden(x0, x1, a, b, h) {
  if (x1 - x0 < 0.5 || b - a < 0.3) return;
  frameId();
  flat(x0, a, x1, b, h + 0.015, jit(P.grassL, 0.1, TC3));
}
function roofDetails(x0, x1, a, b, h) {
  if (LOWQ) return;
  const w = x1 - x0, l = b - a;
  const top = MAX_H - 0.05;
  const r = rand();
  const cx = (x0 + x1) / 2, cd = (a + b) / 2;
  if (r < 0.12 && w > 1.2 && l > 1.2) {                       // roof garden with small trees
    roofGarden(x0 + 0.15, x1 - 0.15, a + 0.15, b - 0.15, h);
    for (let i = 0; i < 3; i++) { const x = rr(x0 + 0.4, x1 - 0.4), d = rr(a + 0.4, b - 0.4); if (h + 0.5 < top) treeRound(x, d, rr(0.22, 0.3), rr(0.38, 0.5), jit(P.tree1, 0.1), h); }
    return;
  }
  if (r < 0.2 && w > 1.3 && l > 1.8) {                        // solar array
    frameId(); setTile(T_GLASS); uvMode(0.5, 0.6);
    for (let d = a + 0.3; d < b - 0.6; d += 0.62) flat(x0 + 0.25, d, x1 - 0.25, d + 0.45, h + 0.03, P.navy, 1.05);
    setTile(0); uvMode(0, 0);
  } else if (r < 0.26 && w > 1.4 && l > 1.4) {                // rooftop pool
    frameId();
    flat(cx - 0.45, cd - 0.6, cx + 0.45, cd + 0.6, h + 0.012, P.paving, 1.1);
    flat(cx - 0.35, cd - 0.5, cx + 0.35, cd + 0.5, h + 0.02, P.glassL, 1.2);
  } else if (r < 0.34 && w > 1.2 && l > 1.2) {                // skylights
    for (let d = a + 0.4; d < b - 0.4; d += 0.7) box(cx - 0.3, d, cx + 0.3, d + 0.35, h, h + 0.08, P.metal, P.glassL);
  }
  // AC units in a row, stair house, water tank on legs
  if (w > 0.8 && l > 1.0) {
    const n = 1 + ((rand() * 3) | 0), ax = rr(x0 + 0.25, x1 - 0.45), ad = rr(a + 0.25, b - 0.35 - n * 0.32);
    for (let i = 0; i < n; i++) box(ax, ad + i * 0.32, ax + 0.22, ad + i * 0.32 + 0.24, h, Math.min(top, h + 0.14), P.metal, P.concrete);
  }
  if (rand() < 0.55 && w > 1 && l > 1) { const x = rr(x0 + 0.35, x1 - 0.35), d = rr(a + 0.35, b - 0.35); box(x - 0.25, d - 0.3, x + 0.25, d + 0.3, h, Math.min(top, h + 0.3), P.wallG, P.roofDark); }
  if (rand() < 0.3 && h + 0.7 < top && w > 1.1 && l > 1.1) {
    const x = rr(x0 + 0.4, x1 - 0.4), d = rr(a + 0.4, b - 0.4);
    for (const [ox, od] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]]) box(x + ox - 0.025, d + od - 0.025, x + ox + 0.025, d + od + 0.025, h, h + 0.3, P.hullDark, P.hullDark);
    cyl(x, d, 0.24, h + 0.3, h + 0.58, 7, P.roofBrown, P.roofBrown);
    cone(x, d, 0.26, h + 0.58, h + 0.7, 7, P.roofDark);
  }
  if (h > 2.9 && w > 1.9 && l > 1.9 && rand() < 0.4) {
    setTile(T_HELI); uvMode(1.6, 1.6, false, cx - 0.8, cd - 0.8);
    flat(cx - 0.8, cd - 0.8, cx + 0.8, cd + 0.8, h + 0.02, P.white);
    setTile(0); uvMode(0, 0);
  } else if (h > 2.6 && rand() < 0.35) {
    const x = rr(x0 + 0.2, x1 - 0.2), d = rr(a + 0.2, b - 0.2);
    box(x - 0.03, d - 0.03, x + 0.03, d + 0.03, h, Math.min(top, h + 0.5), P.metal, P.metal);
  }
}
function suburb(x0, x1, a, b, side) {
  // detached houses with gardens on the city outskirts
  frameId();
  flat(x0, a + 0.1, x1, b - 0.1, L_BASE, jit(P.grassL, 0.06, TC3));
  const ax = Math.min(Math.abs(x0), Math.abs(x1));
  for (let col = 0; col < 3; col++) {
    const cx = side * (ax + 1.5 + col * 3.1);
    let d = a + 0.5;
    while (d < b - 2) {
      const l = rr(2.2, 3.0);
      if (d + l > b - 0.3) break;
      const cd = d + l / 2;
      if (rand() < 0.18) tree(cx + rr(-0.6, 0.6), cd, 1);
      else if (canRect(cx - 1.1, cx + 1.1, cd - 1, cd + 1)) {
        frameId(); flat(cx - 1.35, cd - l / 2, cx + 1.35, cd + l / 2, L_ROAD - 0.004, jit(P.grass, 0.1, TC3));
        house(cx + rr(-0.2, 0.2), cd, rr(1.5, 2.0), rr(1.4, 1.8), rr(0.55, 0.85), rr(-0.06, 0.06), jit(pick([P.wallW, P.wallCream, P.wallPink, P.wallB]), 0.08, TC2), jit(pick([P.roofTerra, P.roofSlate, P.roofBrown, P.roofGrey]), 0.1, TC3), rand() < 0.5 ? 0 : 1);
        if (rand() < 0.6) { const tx = cx + (rand() < 0.5 ? -1 : 1) * 1.2, td = cd + rr(-0.8, 0.8); treeRound(tx, td, rr(0.4, 0.55), rr(0.8, 1.1), jit(P.tree1, 0.15)); }
        if (rand() < 0.4) car(cx + 1.05, cd - 0.6, 0, pick(P.car));
      }
      d += l + 0.25;
    }
  }
}
function parking(x0, x1, a, b) {
  frameId();
  setTile(T_PARK); uvMode(1.1, 2.1, false, x0, a);
  flat(x0 + 0.1, a + 0.1, x1 - 0.1, b - 0.1, L_ROAD, P.white);
  setTile(0); uvMode(0, 0);
  for (let d = a + 0.55; d < b - 0.5; d += 1.05) {
    for (let x = x0 + 0.35; x < x1 - 0.3; x += 0.55) {
      if (rand() < 0.4) continue;
      const row = ((d - a) / 1.05) | 0;
      car(x + 0.12, d + (row % 2 ? 0.1 : 0.4), 0, pick(P.car));
    }
  }
}
function pocketPark(x0, x1, a, b) {
  frameId();
  flat(x0 + 0.1, a + 0.1, x1 - 0.1, b - 0.1, L_BASE, jit(P.grassL, 0.08, TC3));
  ring((x0 + x1) / 2, (a + b) / 2, (x1 - x0) * 0.26, (b - a) * 0.3, 0.22, L_WALK, P.gravel, 16);
  const n = Math.round((x1 - x0) * (b - a) * 0.12);
  for (let i = 0; i < n; i++) { const x = rr(x0 + 0.6, x1 - 0.6), d = rr(a + 0.6, b - 0.6); tree(x, d, 0.95, 0); }
}
function plaza(x0, x1, a, b) {
  frameId();
  setTile(T_SLAB); uvMode(0.8, 0.8);
  flat(x0, a, x1, b, L_BASE, P.concrete);
  setTile(0); uvMode(0, 0);
  const cx = (x0 + x1) / 2, cd = (a + b) / 2;
  ring(cx, cd, 1.1, 1.1, 0.2, L_WALK, P.concreteD, 16);
  disc(cx, cd, 1.1, 1.1, L_WALK - 0.002, P.glassL, 16, 0.9);
  cyl(cx, cd, 0.2, 0, 0.45, 6, P.concrete, P.glassL);
  for (let dd = -6; dd <= 6; dd += 3) for (const dx of [-1.7, 1.7]) {
    const x = cx + dx, d = cd + dd;
    if (d < a + 0.6 || d > b - 0.6 || Math.abs(dd) < 2) continue;
    disc(x, d, 0.42, 0.42, L_WALK, P.concreteD, 8);
    treeRound(x, d, 0.45, 0.8, jit(P.tree1, 0.12));
  }
}
function cityPark(ch) {
  const { x0, x1, d0: a, d1: b } = PARK;
  frameId();
  flat(x0, a, x1, b, L_BASE, jit(P.grassL, 0.05, TC3));
  // curving gravel path
  for (let i = 0; i < 44; i++) {
    const t = i / 44;
    const x = lerp(x0 + 0.5, x1 - 0.5, t), d = 730 + Math.sin(t * 5.2) * 3.5;
    frame(x, d, Math.atan2(Math.cos(t * 5.2) * 3.5 * 5.2 / (x1 - x0), 1) - Math.PI / 2);
    flat(-0.2, -0.22, 0.2, 0.22, L_WALK, P.gravel);
  }
  frameId();
  const p = PONDS[3];
  ring(p.x, p.d, p.rx + 0.3, p.rd + 0.3, 0.3, L_WALK, P.gravel, 20);
  const n = LOWQ ? 34 : 70;
  for (let i = 0; i < n; i++) {
    const x = rr(x0 + 0.5, x1 - 0.5), d = rr(a + 0.5, b - 0.5);
    if (((x - p.x) / (p.rx + 1.1)) ** 2 + ((d - p.d) / (p.rd + 1.1)) ** 2 < 1) continue;
    if (Math.abs(d - (730 + Math.sin(((x - x0) / (x1 - x0)) * 5.2) * 3.5)) < 0.7) continue;
    tree(x, d, rr(0.95, 1.2), rand() < 0.3 ? 1 : 0);
  }
  // gazebo on the lake shore + a pier
  cyl(9.2, 747.2, 0.55, 0, 0.35, 8, P.wallW, P.wallW, false);
  cone(9.2, 747.2, 0.72, 0.35, 0.8, 8, P.roofSlate);
  box(p.x - 0.25, p.d - p.rd - 0.6, p.x + 0.25, p.d - p.rd + 1.3, -0.3, 0.06, P.roofBrown, P.dirt);
}
function stadium(x0, x1, a, b) {
  const cx = (x0 + x1) / 2, cd = (a + b) / 2;
  frameId();
  flat(x0, a, x1, b, L_BASE, P.paving);
  ring(cx, cd, 3.0, 3.0, 1.0, L_ROAD, jit(P.redPaint, 0.05, TC3), 20, 3.0);
  setTile(T_PITCH); uvMode(6.0, 6.0 * 1.55, false, cx - 3.0, cd - 3.0 - 1.65);
  flat(cx - 3.0, cd - 3.0 - 1.6, cx + 3.0, cd + 3.0 + 1.6, L_ROAD, P.white);
  setTile(0); uvMode(0, 0);
  sideStyle(T_SHUTTER, 0.6, 0.3);
  box(cx + 4.2, cd - 5.5, cx + 5.4, cd + 5.5, 0, 0.9, P.concrete, P.concreteD);
  box(cx - 5.4, cd - 5.5, cx - 4.2, cd + 5.5, 0, 0.9, P.concrete, P.concreteD);
  box(cx - 4.2, cd + 6.3, cx + 4.2, cd + 7.1, 0, 0.7, P.concrete, P.concreteD);
  plain();
  shadowBox(cx + 4.2, cd - 5.5, cx + 5.4, cd + 5.5, 0.9); shadowBox(cx - 5.4, cd - 5.5, cx - 4.2, cd + 5.5, 0.9); shadowBox(cx - 4.2, cd + 6.3, cx + 4.2, cd + 7.1, 0.7);
  for (const [dx, dd] of [[-5, -6.4], [5, -6.4], [-5, 6.4], [5, 6.4]]) {
    const x = cx + dx, d = cd + dd;
    if (!canPlace(x, d, 0.35)) continue;
    box(x - 0.07, d - 0.07, x + 0.07, d + 0.07, 0, 3.0, P.metal, P.metal);
    box(x - 0.3, d - 0.08, x + 0.3, d + 0.08, 3.0, 3.35, P.metalD, P.glassL);
    shadowBox(x - 0.07, d - 0.07, x + 0.07, d + 0.07, 3.2);
  }
}
function highway(ch, c) {
  // 6-lane at-grade highway replacing the main cross road at d = 820
  frameId(); uvMode(0, 0);
  flat(-40, c - 3.6, 40, c + 3.6, L_ROAD, P.asphaltD);
  flat(-40, c - 4.0, 40, c - 3.6, L_WALK, P.concrete); flat(-40, c + 3.6, 40, c + 4.0, L_WALK, P.concrete);
  flat(-40, c - 0.12, 40, c - 0.04, L_MARK, P.yellow); flat(-40, c + 0.04, 40, c + 0.12, L_MARK, P.yellow);
  for (const off of [-2.4, -1.2, 1.2, 2.4]) for (let x = -40; x < 40; x += 3) flat(x, c + off - 0.04, x + 1.5, c + off + 0.04, L_MARK, P.paint, 0.9);
  flat(-40, c - 3.45, 40, c - 3.38, L_MARK, P.paint, 0.9); flat(-40, c + 3.38, 40, c + 3.45, L_MARK, P.paint, 0.9);
  const n = LOWQ ? 10 : 22;
  for (let i = 0; i < n; i++) {
    const x = rr(-22, 22);
    let skip = false;
    for (let j = 0; j < 3; j++) if (Math.abs(x - LANES_X[j]) < 1.6) skip = true;
    if (skip) continue;
    const side = rand() < 0.5 ? -1 : 1;
    const lane = pick([1.8, 3.0]);
    car(x, c + side * lane, side < 0 ? -Math.PI / 2 : Math.PI / 2, pick(P.car));
  }
}

// =============================================================================
// AIRBASE (960–1240)
// =============================================================================
const RW_A = 1000, RW_B = 1136;      // runway; beyond it the centre becomes the flight-line apron
function genBase(w, ch, k, d0) {
  const d1 = d0 + CHUNK, cr = d0 + 20;
  // lanes: taxiways (±5.5); lane 0 is the runway centre line, then a taxi line on the apron
  for (const lx of [-5.5, 5.5]) {
    if (d0 < 980) laneRoad(lx, d0, Math.min(d1, 980), 'avenue');
    laneRoad(lx, Math.max(d0, 980), Math.min(d1, BASE_END - 0.5), 'taxi');
  }
  if (d0 < RW_A) laneRoad(0, d0, RW_A - 0.5, 'asphalt');
  runway(Math.max(d0, RW_A - 3), Math.min(d1, RW_B + 4));
  if (d1 > RW_B + 4) flightLine(ch, Math.max(d0, RW_B + 4), Math.min(d1, BASE_END - 0.5));
  if (cr < BASE_END) crossRoad(cr, k === 24 ? 'main' : 'taxi');
  // runway / taxiway edge lights in the grass strips
  frameId();
  if (d0 >= 980) for (const s of [-1, 1]) {
    for (let d = Math.max(d0, 982) + 0.8; d < Math.min(d1, RW_B + 3); d += 3) {
      if (crossDist(d) < 1.9) continue;
      box(s * 3.1 - 0.05, d - 0.05, s * 3.1 + 0.05, d + 0.05, 0, 0.1, P.paint, P.white);
      box(s * 4.2 - 0.05, d + 1.5 - 0.05, s * 4.2 + 0.05, d + 1.5 + 0.05, 0, 0.1, P.wallBlue, P.glassL);
    }
  }
  if (k === 24) baseEntrance(ch, d0, d1);
  const plan = BASE_PLAN[k] || [];
  for (let hi = 0; hi < 2; hi++) {
    const a = hi ? cr + 2.0 : d0 + 1.2, b = hi ? d1 - 1.2 : cr - 2.0;
    for (const side of [-1, 1]) {
      const kind = plan[(side < 0 ? 0 : 2) + hi];
      if (kind) baseLot(ch, kind, side, a, b);
    }
  }
  if (k === 30) baseEnd(ch, d0, d1);
}
// the flight line: concrete apron across the centre, jets parked between the lanes
function flightLine(ch, a, b) {
  if (b <= a) return;
  frameId();
  setTile(T_SLAB); uvMode(2.5, 2.5);
  flat(-4.4, a, 4.4, b, L_ROAD - 0.004, P.concrete);
  setTile(0); uvMode(0, 0);
  flat(-0.06, a, 0.06, b, L_MARK, P.yellow);
  for (const side of [-1, 1]) {
    for (let d = Math.ceil((a - 1.5) / 3.1) * 3.1 + 1.5; d < b - 1.2; d += 3.1) {
      if (crossDist(d) < 3.2 || d < a + 1.2) continue;
      const x = side * 2.75;
      // stand markings + a parked jet nosed toward the centre taxi line
      flat(x - 1.05, d - 1.25, x + 1.05, d - 1.19, L_MARK, P.yellow, 0.9);
      flat(side < 0 ? x : 0.1, d - 0.03, side < 0 ? -0.1 : x, d + 0.03, L_MARK, P.yellow, 0.75);
      if (hash2(Math.round(d * 3), side) < 0.82) jet(x, d, side < 0 ? -Math.PI / 2 : Math.PI / 2, pick([P.metal, P.deckGrey, P.wallBlue]), 1.08);
      if (!LOWQ && rand() < 0.6) box(x + side * 1.05 - 0.14, d + 0.6, x + side * 1.05 + 0.14, d + 0.95, 0, 0.18, P.yellow, P.yellow);
    }
  }
}
// per chunk: [left-lower, left-upper, right-lower, right-upper]
const BASE_PLAN = {
  24: [null, 'barracks', null, 'motorpool'],
  25: ['tower', 'jets', 'hangars', 'jets'],
  26: ['fuel', 'radar', 'jets', 'hangars'],
  27: ['heli', 'shelters', 'shelters', 'transport'],
  28: ['jets', 'hangars', 'sam', 'jets'],
  29: ['bunkers', 'fuel', 'hangars', 'radar'],
  30: ['jets', null, 'heli', null],
};
function runway(a, b) {
  if (b <= a) return;
  frameId(); uvMode(0, 0);
  const W = 2.8;
  flat(-W - 0.35, a, W + 0.35, b, L_ROAD - 0.004, P.asphaltD);
  flat(-W, a, W, b, L_ROAD, P.runway);
  // rubber deposits in the touchdown zones
  if (!LOWQ) for (let i = 0; i < 26; i++) {
    const zone = i < 13 ? rr(RW_A + 4, RW_A + 40) : rr(RW_B - 36, RW_B - 5);
    if (zone < a || zone + 3 > b) continue;
    const x = rr(-1.3, 1.3) * (rand() < 0.5 ? 0.45 : 1);
    flat(x - rr(0.05, 0.13), zone, x + rr(0.05, 0.13), zone + rr(1.5, 3.5), L_ROAD + 0.003, P.runway, rr(0.62, 0.8));
  }
  // aiming-point blocks, arresting cables, distance-remaining boards, windsock, glideslope mast
  for (const [ap, dir] of [[RW_A + 22, 1], [RW_B - 22 - 3, -1]]) if (ap > a && ap + 3 < b) for (const sx of [-1, 1]) flat(sx * 1.55 - 0.42, ap, sx * 1.55 + 0.42, ap + 3, L_MARK, P.paint, 0.95);
  for (const cd of [RW_A + 48, RW_B - 48]) if (cd > a && cd < b) {
    flat(-2.8, cd - 0.04, 2.8, cd + 0.04, L_MARK, P.hullDark, 0.9);
    for (const sx of [-1, 1]) box(sx * 3.35 - 0.12, cd - 0.15, sx * 3.35 + 0.12, cd + 0.15, 0, 0.14, P.yellow, P.hullDark);
  }
  for (let d = Math.ceil((a - RW_A) / 20) * 20 + RW_A + 10; d < Math.min(b, RW_B - 5); d += 20) {
    if (crossDist(d) < 2.2) continue;
    for (const sx of [-1, 1]) box(sx * 3.75 - 0.28, d - 0.06, sx * 3.75 + 0.28, d + 0.06, 0, 0.26, P.hullDark, P.paint);
  }
  if (a <= RW_A + 30 && b > RW_A + 30) {
    const x = -3.7, d = RW_A + 30;
    box(x - 0.03, d - 0.03, x + 0.03, d + 0.03, 0, 0.8, P.metal, P.metal);
    frame(x, d + 0.03, 0.5); box(-0.06, 0, 0.06, 0.55, 0.62, 0.76, P.redPaint, P.redPaint); frameId();
    shadowBox(x - 0.03, d - 0.03, x + 0.03, d + 0.03, 0.8);
  }
  if (a <= RW_A + 14 && b > RW_A + 14) {
    const x = 3.75, d = RW_A + 14;
    box(x - 0.2, d - 0.2, x + 0.2, d + 0.2, 0, 0.3, P.shipWhite, P.redPaint);
    box(x - 0.03, d - 0.03, x + 0.03, d + 0.03, 0.3, 1.3, P.redPaint, P.shipWhite);
    shadowBox(x - 0.2, d - 0.2, x + 0.2, d + 0.2, 0.3); shadowBox(x - 0.03, d - 0.03, x + 0.03, d + 0.03, 1.3);
  }
  // PAPI light bars beside both thresholds
  for (const pd of [RW_A + 12, RW_B - 12]) if (pd > a && pd < b) for (let i = 0; i < 4; i++) box(-3.5 - i * 0.28, pd - 0.08, -3.3 - i * 0.28, pd + 0.08, 0, 0.1, P.hullDark, i < 2 ? P.redPaint : P.paint);
  flat(-W + 0.12, a, -W + 0.22, b, L_MARK, P.paint, 0.9); flat(W - 0.22, a, W - 0.12, b, L_MARK, P.paint, 0.9);
  for (let d = Math.ceil(a / 3.5) * 3.5; d < b - 1.8; d += 3.5) {
    if (d < RW_A + 16 || d > RW_B - 16) continue;
    if (crossDist(d + 0.9) < 2) continue;
    flat(-0.07, d, 0.07, d + 1.8, L_MARK, P.paint, 0.9);
  }
  // thresholds: piano keys + numbers; touchdown bars
  const ends = [[RW_A + 1.5, 1, T_R36], [RW_B - 1.5, -1, T_R18]];
  for (const [t, dir, tile] of ends) {
    if (t < a - 8 || t > b + 8) continue;
    for (let i = 0; i < 8; i++) {
      const x = -2.4 + i * 0.62 + (i >= 4 ? 0.3 : 0);
      if (i === 4) continue;
      const d = dir > 0 ? t : t - 3;
      flat(x - 0.2, Math.max(a, d), x + 0.2, Math.min(b, d + 3), L_MARK, P.paint, 0.95);
    }
    const nd = dir > 0 ? t + 3.6 : t - 3.6 - 2.2;
    if (nd > a && nd + 2.2 < b) {
      setTile(tile); uvMode(1.8, 2.2, false, -0.9, nd);
      if (dir > 0) flat(-0.9, nd, 0.9, nd + 2.2, L_MARK, P.white);
      else { frame(0, nd + 1.1, Math.PI); uvMode(1.8, 2.2, false, -0.9, -1.1); flat(-0.9, -1.1, 0.9, 1.1, L_MARK, P.white); frameId(); }
      setTile(0); uvMode(0, 0);
    }
    if (dir < 0) for (let i = 0; i < 2; i++) {
      const d = t + 2.2 + i * 1.8;
      if (d < a || d + 1.5 > b) continue;
      flat4(-2.6, d, -2.1, d, 0, d + 1.0, 0, d + 1.5, L_MARK, P.yellow);
      flat4(0, d + 1.0, 2.1, d, 2.6, d, 0, d + 1.5, L_MARK, P.yellow);
    }
    for (let j = 0; j < 3; j++) {
      const d = dir > 0 ? t + 7 + j * 2.2 : t - 7 - j * 2.2 - 1.2;
      if (d < a || d + 1.2 > b) continue;
      for (const s of [-1, 1]) flat(s * 1.0 - 0.25, d, s * 1.0 + 0.25, d + 1.2, L_MARK, P.paint, 0.9);
    }
  }
}
function baseEntrance(ch, d0, d1) {
  // city fades into the perimeter fence (d = 972) with gates, guard posts, then the base
  frameId();
  const fd = 972;
  for (const [x0, x1] of [[-26, -6.9], [-4.1, -1.35], [1.35, 4.1], [6.9, 26]]) {
    for (let x = x0; x < x1 - 0.1; x += 1.1) box(x - 0.04, fd - 0.04, x + 0.04, fd + 0.04, 0, 0.42, P.metalD, P.metalD);
    if (room(6)) {
      const y0 = GROUND_Y + 0.08, y1 = GROUND_Y + 0.4;
      vtx(x0, y0, fd, P.metalD, 0.8, 0, 0); vtx(x1, y0, fd, P.metalD, 0.8, 0, 0); vtx(x1, y1, fd, P.metalD, 0.9, 0, 0);
      vtx(x0, y0, fd, P.metalD, 0.8, 0, 0); vtx(x1, y1, fd, P.metalD, 0.9, 0, 0); vtx(x0, y1, fd, P.metalD, 0.9, 0, 0);
    }
  }
  for (const gx of [-7.6, 7.6, 1.9]) { frame(gx, fd - 0.9, 0); box(-0.45, -0.45, 0.45, 0.45, 0, 0.6, P.wallW, P.roofDark); shadowBox(-0.45, -0.45, 0.45, 0.45, 0.6); frameId(); }
  // last low city blocks before the fence
  for (const [x0, x1] of [[-22, -16.8], [-16.4, -11.6], [-11.2, -6.9], [6.9, 11.2], [11.6, 16.4], [16.8, 22]]) lotRow(x0, x1, 960.2, 970.6, 0.2, false);
  for (const [x0, x1] of [[-4.1, -1.4], [1.4, 4.1]]) medianGarden(x0, x1, 960, 970.6);
  // water tower
  const tx = -11, td = 994;
  for (const [a, b] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) box(tx + a - 0.05, td + b - 0.05, tx + a + 0.05, td + b + 0.05, 0, 2.2, P.metalD, P.metalD);
  cyl(tx, td, 0.75, 2.2, 3.1, 10, P.shipWhite, P.metal);
  cone(tx, td, 0.78, 3.1, 3.5, 10, P.metal);
  shadowDisc(tx, td, 0.7, 3.2);
}
// one quarter of an airbase chunk: side ±1, stage range [a, b]; content is packed into
// |x| ∈ [6.7, 16] so it is on screen, with larger things further out
function baseLot(ch, kind, side, a, b) {
  const x0 = side < 0 ? -24 : 6.7, x1 = side < 0 ? -6.7 : 24;
  const cd = (a + b) / 2, inner = side < 0 ? x1 : x0;
  const X = (o) => inner + side * o;          // x at an offset from the taxiway edge
  frameId();
  const paved = kind !== 'bunkers' && kind !== 'sam' && kind !== 'barracks';
  if (paved) { setTile(T_SLAB); uvMode(2.5, 2.5); flat(x0, a, x1, b, L_BASE, P.concrete); setTile(0); uvMode(0, 0); }
  else { setTile(T_SLAB); uvMode(2.5, 2.5); flat(Math.min(X(0), X(1.6)), a, Math.max(X(0), X(1.6)), b, L_BASE, P.concrete); setTile(0); uvMode(0, 0); }
  // taxi lead-in line from the taxiway
  flat(Math.min(inner, side * 6.5), cd - 0.05, Math.max(inner, side * 6.5), cd + 0.05, L_MARK, P.yellow);
  const lamp = (x, d) => { box(x - 0.04, d - 0.04, x + 0.04, d + 0.04, 0, 1.4, P.metalD, P.metalD); box(x - 0.12, d - 0.06, x + 0.12, d + 0.06, 1.4, 1.48, P.metal, P.glassL); shadowBox(x - 0.04, d - 0.04, x + 0.04, d + 0.04, 1.4); };
  switch (kind) {
    case 'hangars': {
      hangar(X(2.5), cd + 1.2, side);
      hangar(X(6.4), cd + 1.2, side);
      box(Math.min(X(8.7), X(10.9)), cd - 5.2, Math.max(X(8.7), X(10.9)), cd - 3.0, 0, 0.7, P.wallSand, P.roofTar);
      shadowBox(Math.min(X(8.7), X(10.9)), cd - 5.2, Math.max(X(8.7), X(10.9)), cd - 3.0, 0.7);
      truck(X(1.0), cd - 4.2, 0.3, P.olive);
      box(X(4.4) - 0.2, cd - 4.8, X(4.4) + 0.2, cd - 4.4, 0, 0.2, P.yellow, P.yellow);
      lamp(X(0.5), cd + 5.5);
      break;
    }
    case 'jets': {
      // echelon parking, noses angled toward the taxiway
      for (let i = 0; i < 5; i++) {
        const x = X(1.7 + (i % 3) * 2.2 + (i >= 3 ? 1.1 : 0)), d = cd - 4.2 + i * 2.1;
        if (d < a + 1 || d > b - 1) continue;
        flat(x - 1.0, d - 1.15, x + 1.0, d - 1.09, L_MARK, P.yellow, 0.9);
        jet(x, d, side < 0 ? -Math.PI / 2 - 0.5 : Math.PI / 2 + 0.5, pick([P.metal, P.deckGrey, P.wallBlue, P.metal]), 1.05);
        if (!LOWQ) box(x + side * 0.85 - 0.12, d + 0.5, x + side * 0.85 + 0.12, d + 0.8, 0, 0.16, P.yellow, P.yellow);
      }
      truck(X(8.2), cd + 3.8, side < 0 ? Math.PI / 2 : -Math.PI / 2, P.olive);
      hangar(X(11.5), cd, side);
      lamp(X(0.4), cd + 5.8); lamp(X(0.4), cd - 5.8);
      break;
    }
    case 'transport': {
      bigPlane(X(4.6), cd + 0.4);
      for (let i = 0; i < 4; i++) box(X(8.6) - 0.3, cd - 4.8 + i * 0.8, X(8.6) + 0.3, cd - 4.3 + i * 0.8, 0, 0.3, P.olive, P.khaki);
      truck(X(9.8), cd - 3.2, 0, P.olive); truck(X(9.8), cd - 1.6, 0, P.olive);
      lamp(X(0.4), cd + 5.5);
      break;
    }
    case 'shelters': {
      for (let i = 0; i < 2; i++) {
        const x = X(2.9 + i * 5.8);
        shelter(x, cd + 1.4);
        flat(x - 0.9, cd - 3.9, x + 0.9, cd - 1.1, L_ROAD, P.concreteD);
        jet(x, cd - 2.4, Math.PI, P.deckGrey, 1.0);
      }
      break;
    }
    case 'tower': {
      controlTower(ch, X(3.0), cd + 2.0);
      // fire station
      frameId();
      sideStyle(T_SHUTTER, 0.7, 0.45);
      box(Math.min(X(5.4), X(9.8)), cd - 5.0, Math.max(X(5.4), X(9.8)), cd - 2.6, 0, 0.8, P.redPaint, P.roofTar);
      plain(); shadowBox(Math.min(X(5.4), X(9.8)), cd - 5.0, Math.max(X(5.4), X(9.8)), cd - 2.6, 0.8);
      for (let i = 0; i < 3; i++) truck(X(6.1 + i * 1.3), cd - 1.8, Math.PI, P.redPaint);
      // car park + trees
      flat(Math.min(X(6.0), X(11.5)), cd + 1.2, Math.max(X(6.0), X(11.5)), cd + 5.2, L_ROAD, P.asphalt);
      for (let i = 0; i < 10; i++) if (rand() < 0.7) car(X(6.5 + (i % 5) * 1.0), cd + 2.0 + ((i / 5) | 0) * 2.1, 0, pick(P.car));
      for (let i = 0; i < 4; i++) tree(X(12.3 + rr(-0.3, 0.3)), cd - 4 + i * 2.6, 1.0, 0);
      break;
    }
    case 'fuel': {
      frameId(); flat(Math.min(X(0.6), X(12)), a + 0.6, Math.max(X(0.6), X(12)), b - 0.6, L_ROAD, P.concreteD);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
        const x = X(2.1 + i * 2.9), d = cd + (j ? 2.3 : -2.5);
        if (!canPlace(x, d, 1.3)) continue;
        box(x - 1.3, d - 1.3, x + 1.3, d - 1.2, 0, 0.14, P.concreteD, P.concrete);
        box(x - 1.3, d + 1.2, x + 1.3, d + 1.3, 0, 0.14, P.concreteD, P.concrete);
        box(x - 1.3, d - 1.2, x - 1.2, d + 1.2, 0, 0.14, P.concreteD, P.concrete);
        cyl(x, d, 1.02, 0, 0.95, 12, P.shipWhite, P.metal);
        disc(x, d, 0.55, 0.55, 0.955, P.metalD, 10);
        shadowDisc(x, d, 1.0, 0.95);
      }
      flat(Math.min(X(0.8), X(10)), cd - 0.1, Math.max(X(0.8), X(10)), cd + 0.1, L_WALK, P.metalD);
      truck(X(1.2), cd - 0.9, 0, P.olive); truck(X(1.2), cd + 0.9, 0, P.shipWhite);
      break;
    }
    case 'radar': {
      frameId();
      const rx = X(3.0), rd = cd - 2.0;
      box(rx - 1.0, rd - 0.8, rx + 1.0, rd + 0.8, 0, 0.6, P.wallG, P.roofDark);
      shadowBox(rx - 1.0, rd - 0.8, rx + 1.0, rd + 0.8, 0.6);
      addSpinner(ch, 0, rx, GROUND_Y + 0.6, rd, 1.4);
      const gx = X(7.6), gd = cd + 1.8;
      box(gx - 0.75, gd - 0.75, gx + 0.75, gd + 0.75, 0, 1.3, P.wallW, P.roofDark);
      LR[0] = 0.9; LH[0] = 1.3; LK[0] = 0.8; LR[1] = 0.84; LH[1] = 1.78; LK[1] = 0.95; LR[2] = 0.52; LH[2] = 2.18; LK[2] = 1.05; LR[3] = 0; LH[3] = 2.34; LK[3] = 1.12;
      frame(gx, gd, 0); lathe(0, 0, 4, 10, P.shipWhite, 0); frameId();
      shadowDisc(gx, gd, 0.85, 2.2);
      const mx = X(5.2), md = cd + 4.8;
      box(mx - 0.05, md - 0.05, mx + 0.05, md + 0.05, 0, 3.4, P.metal, P.metal);
      box(mx - 0.4, md - 0.02, mx + 0.4, md + 0.02, 2.8, 2.86, P.metal, P.metal);
      shadowBox(mx - 0.05, md - 0.05, mx + 0.05, md + 0.05, 3.4);
      addSpinner(ch, 0, X(9.8), GROUND_Y + 0.25, cd - 3.2, 2.1);
      box(X(9.8) - 0.5, cd - 3.7, X(9.8) + 0.5, cd - 2.7, 0, 0.25, P.olive, P.oliveD);
      break;
    }
    case 'heli': {
      for (let i = 0; i < 2; i++) {
        const x = X(2.7 + i * 4.3), d = cd + (i ? 1.2 : -1.0);
        setTile(T_HELI); uvMode(2.6, 2.6, false, x - 1.3, d - 1.3);
        flat(x - 1.3, d - 1.3, x + 1.3, d + 1.3, L_ROAD, P.white);
        setTile(0); uvMode(0, 0);
        if (i === 0 || rand() < 0.7) heli(x, d, rr(-0.5, 0.5) + Math.PI, pick([P.olive, P.deckGrey]));
      }
      frameId();
      sideStyle(T_CORR, 0.3, 1);
      box(Math.min(X(9.4), X(13)), cd - 3.5, Math.max(X(9.4), X(13)), cd + 3.5, 0, 1.1, P.metal, P.roofSlate);
      plain(); shadowBox(Math.min(X(9.4), X(13)), cd - 3.5, Math.max(X(9.4), X(13)), cd + 3.5, 1.1);
      break;
    }
    case 'bunkers': {
      for (let i = 0; i < 3; i++) {
        const x = X(2.6 + i * 3.8), d = cd + (i % 2 ? 1.4 : -1.2);
        if (!canPlace(x, d, 1.6)) continue;
        LR[0] = 1.5; LH[0] = 0; LK[0] = 0.85; LR[1] = 1.1; LH[1] = 0.55; LK[1] = 1.0; LR[2] = 0; LH[2] = 0.75; LK[2] = 1.08;
        frame(x, d, 0); lathe(0, 0, 3, 8, jit(P.grassD, 0.1, TC3), 0.2, 1.0, 1.25); frameId();
        frame(x, d - 1.6, 0); box(-0.45, -0.25, 0.45, 0.2, 0, 0.5, P.concrete, P.concreteD); frameId();
        shadowDisc(x, d, 1.1, 0.6);
      }
      // guard tower
      const gx = X(1.0), gd = cd + 5.0;
      for (const [ox, od] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) box(gx + ox - 0.04, gd + od - 0.04, gx + ox + 0.04, gd + od + 0.04, 0, 1.5, P.metalD, P.metalD);
      box(gx - 0.4, gd - 0.4, gx + 0.4, gd + 0.4, 1.5, 1.95, P.olive, P.oliveD);
      shadowBox(gx - 0.4, gd - 0.4, gx + 0.4, gd + 0.4, 1.9);
      break;
    }
    case 'sam': {
      frameId();
      for (let i = 0; i < 3; i++) {
        const x = X(2.4 + i * 3.4), d = cd + (i === 1 ? 2.0 : -1.2);
        if (!canPlace(x, d, 1.2)) continue;
        ring(x, d, 0.9, 0.9, 0.3, 0.12, P.khaki, 10);
        frame(x, d, rr(-0.5, 0.5));
        box(-0.35, -0.5, 0.35, 0.5, 0, 0.25, P.olive, P.oliveD);
        for (const s of [-0.18, 0.18]) box(s - 0.08, -0.45, s + 0.08, 0.45, 0.25, 0.42, P.oliveD, P.olive);
        frameId();
        shadowBox(x - 0.35, d - 0.5, x + 0.35, d + 0.5, 0.42);
      }
      truck(X(6.0), cd + 5.0, 0.4, P.olive);
      addSpinner(ch, 0, X(8.6), GROUND_Y + 0.3, cd + 4.6, 1.8);
      box(X(8.6) - 0.45, cd + 4.1, X(8.6) + 0.45, cd + 5.1, 0, 0.3, P.olive, P.oliveD);
      break;
    }
    case 'barracks': {
      for (let i = 0; i < 3; i++) {
        const x = X(1.7 + i * 2.5);
        const la = a + 1.0, lb = b - 1.0;
        if (!canRect(x - 0.85, x + 0.85, la, lb)) continue;
        frameId();
        flat(x - 1.0, la - 0.2, x + 1.0, lb + 0.2, L_WALK - 0.004, P.concrete);
        sideStyle(T_RESID, 1.2, 0.6);
        box(x - 0.8, la, x + 0.8, lb, 0, 0.6, P.wallSand, P.wallSand, false);
        plain(); topStyle(T_CORR, 0.25, 1);
        gable(x - 0.88, la - 0.05, x + 0.88, lb + 0.05, 0.6, 0.32, P.roofGreen, true);
        plain();
        shadowBox(x - 0.8, la, x + 0.8, lb, 0.8);
      }
      for (let i = 0; i < 5; i++) tree(X(9.4 + rr(-0.4, 0.4)), a + 1.5 + i * ((b - a - 3) / 4), 1.0, 0);
      break;
    }
    case 'motorpool': {
      frameId(); flat(Math.min(X(0.4), X(11)), a + 0.4, Math.max(X(0.4), X(11)), b - 0.4, L_ROAD, P.asphalt);
      for (let i = 0; i < 12; i++) truck(X(1.3 + (i % 6) * 1.0), cd + (i < 6 ? -2 : 1.4), 0, jit(P.olive, 0.1, TC2));
      warehouse(Math.min(X(7.6), X(12)), cd + 3.4, Math.max(X(7.6), X(12)), cd + 7.5, 1.1);
      break;
    }
  }
}
function hangar(x, d, side) {
  // arched hangar, doors facing the taxiway (toward the centre)
  const w = 3.6, l = 4.6, h = 1.7;
  frame(x, d, 0);
  checkTall(-w / 2, -l / 2, w / 2, l / 2, h);
  const segs = 7;
  const c = jit(P.metal, 0.08, TC2);
  if (room(segs * 12 + 12)) {
    setTile(T_CORR);
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI, a1 = ((i + 1) / segs) * Math.PI;
      const x0 = Math.cos(a0) * w / 2, y0 = Math.sin(a0) * h, x1 = Math.cos(a1) * w / 2, y1 = Math.sin(a1) * h;
      const k = 0.8 + 0.25 * Math.cos((a0 + a1) / 2 - 2.2);
      // arc panel from x0 → x1 (going over the top, right to left): CCW seen from outside
      vtx(x1, GROUND_Y + y1, -l / 2, c, k, i / 2, 0); vtx(x0, GROUND_Y + y0, -l / 2, c, k, (i + 1) / 2, 0); vtx(x0, GROUND_Y + y0, l / 2, c, k, (i + 1) / 2, l);
      vtx(x1, GROUND_Y + y1, -l / 2, c, k, i / 2, 0); vtx(x0, GROUND_Y + y0, l / 2, c, k, (i + 1) / 2, l); vtx(x1, GROUND_Y + y1, l / 2, c, k, i / 2, l);
    }
    setTile(0);
    // front (−d) wall with dark door opening
    const dk = P.hullDark;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI, a1 = ((i + 1) / segs) * Math.PI;
      const x0 = Math.cos(a0) * w / 2, y0 = Math.sin(a0) * h, x1 = Math.cos(a1) * w / 2, y1 = Math.sin(a1) * h;
      vtx(0, GROUND_Y, -l / 2, dk, 1, 0, 0); vtx(x0, GROUND_Y + y0, -l / 2, dk, 1, 0, 0); vtx(x1, GROUND_Y + y1, -l / 2, dk, 1, 0, 0);
    }
  }
  flat(-w / 2 + 0.2, -l / 2 - 1.6, w / 2 - 0.2, -l / 2, L_ROAD, P.concreteD);
  shadowBox(-w / 2, -l / 2, w / 2, l / 2, h * 0.85);
  frameId();
}
function shelter(x, d) {
  // hardened aircraft shelter: low arched concrete, dark mouth facing −d
  frame(x, d, 0);
  LR[0] = 2.0; LH[0] = 0; LK[0] = 0.85; LR[1] = 1.7; LH[1] = 0.75; LK[1] = 1.0; LR[2] = 0.9; LH[2] = 1.15; LK[2] = 1.05; LR[3] = 0; LH[3] = 1.25; LK[3] = 1.08;
  lathe(0, 0, 4, 8, jit(P.camo, 0.08, TC2), 0.39, 1.0, 1.25);
  box(-1.0, -2.55, 1.0, -2.3, 0, 0.75, P.concreteD, P.concrete);
  flat(-0.85, -2.6, 0.85, -2.56, 0.7, P.hullDark);
  shadowDisc(0, 0, 1.6, 1.1);
  frameId();
}
function controlTower(ch, x, d) {
  frameId();
  sideStyle(T_OFFICE, 1.4, 1.1);
  box(x - 1.2, d - 1.0, x + 1.2, d + 1.0, 0, 0.9, P.wallSand, P.roofTar);
  plain();
  cyl(x, d, 0.42, 0.9, 3.0, 8, P.wallSand, P.wallSand, false);
  cyl(x, d, 0.78, 3.0, 3.1, 8, P.concreteD, P.concrete);
  cyl(x, d, 0.72, 3.1, 3.55, 8, P.glass, P.glass, false);
  cyl(x, d, 0.82, 3.55, 3.68, 8, P.concreteD, P.roofDark);
  box(x - 0.02, d - 0.02, x + 0.02, d + 0.02, 3.68, 4.1, P.metal, P.metal);
  shadowBox(x - 1.2, d - 1.0, x + 1.2, d + 1.0, 0.9);
  shadowDisc(x, d, 0.7, 3.6);
}
function bigPlane(x, d) {
  // four-engine transport, nose toward −d (pointing at the taxiway lead line)
  frame(x, d, Math.PI);
  const c = jit(P.deckGrey, 0.05, TC2);
  plain();
  box(-0.38, -3.1, 0.38, 2.8, 0.1, 0.72, c, c);
  box(-0.3, 2.8, 0.3, 3.5, 0.15, 0.62, c, c);
  box(-3.15, -0.2, 3.15, 0.75, 0.55, 0.66, c, c);
  box(-1.3, -2.95, 1.3, -2.5, 0.55, 0.62, c, c);
  box(-0.05, -3.05, 0.05, -2.2, 0.72, 1.4, c, c);
  for (const s of [-2.1, -1.1, 1.1, 2.1]) box(s - 0.14, 0.55, s + 0.14, 1.2, 0.35, 0.58, P.metalD, P.metalD);
  box(-0.22, 2.3, 0.22, 2.75, 0.72, 0.76, P.glass, P.glass);
  shadowBox(-0.38, -3.1, 0.38, 3.5, 0.6); shadowBox(-3.15, -0.2, 3.15, 0.75, 0.62);
  frameId();
}
function baseEnd(ch, d0, d1) {
  // overrun chevrons, approach lights, seawall with tetrapods; the sea begins
  frameId(); uvMode(0, 0);
  for (let x = -24; x < 24; x += 0.9) flat(x, BASE_END - 1.3, x + 0.45, BASE_END - 0.9, L_MARK, P.yellow, 0.9);
  // seawall along the whole width
  box(-40, BASE_END - 0.45, 40, BASE_END + 0.45, -0.8, 0.12, P.concreteD, P.concrete);
  for (let x = -24; x < 24; x += 0.62) {
    let skip = false;
    for (let i = 0; i < 3; i++) if (Math.abs(x - LANES_X[i]) < 1.35) skip = true;
    if (skip) continue;
    rock(x + rr(-0.12, 0.12), BASE_END + 0.75 + rr(-0.1, 0.25), rr(0.24, 0.32), -0.3, 0.34, P.concrete);
  }
  // beacon posts at the pier ends of the lanes (low)
  for (let i = 0; i < 3; i++) for (let d = 1229; d < BASE_END - 0.8; d += 1.2) {
    const lx = LANES_X[i];
    if (i === 1) continue;
    flat(lx - 0.4, d, lx + 0.4, d + 0.12, L_MARK, P.paint, 0.9);
  }
}

// =============================================================================
// SCORCHED CANYON (stage 2)
//   dunes 0–260 · canyon 260–560 (wall foot at |x| 7.75–10.25) · mesa plateau 560–780 (mid-boss;
//   the plateau drops into a valley beyond |x| 8–10.8) · refinery 780–1000 · desert fortress and
//   airstrip 1000–1240 · endless dry lakebed 1240+ (boss arena).
// Ground units run on the flat GROUND_Y plane, so the terrain itself is h = 0 on the lanes (always),
// on the cross roads (from 256: side slots through the canyon walls, causeways over the valley),
// on the mid-boss plateau and in the boss arena; _ground self-checks it (flatCheck). Canyon walls,
// buttes and rims are stacked strata-banded prisms (rockBlock) over a smooth terrain ramp, so the
// rock layers stay crisp on the 1-unit ground grid.
// =============================================================================
const CANYON_LAYOUT = [
  { biome: 'dunes',    from: 0,    to: 260 },
  { biome: 'canyon',   from: 260,  to: 560 },
  { biome: 'mesa',     from: 560,  to: 780 },
  { biome: 'refinery', from: 780,  to: 1000 },
  { biome: 'fortress', from: 1000, to: 1240 },
  { biome: 'lakebed',  from: 1240, to: Infinity },
];
const CY_REF = 780, CY_FORT = 1000, CY_LAKE = 1240;
const CY_ROADS = 256;          // cross roads are flat and clear from here on (the first is at 260)
const CY_VALLEY = -2.6;        // valley floor around the mesa plateau
const CY_MIDBOSS = { d0: 560, d1: 780, x: 5.5 };
const CY_ARENA = { d0: 1240, d1: Infinity, x: 9 };
const CY_STRIP_A = 1028, CY_STRIP_B = 1214;   // the fortress airstrip along lane 0

// desert palette
// (kept mid-toned and saturated: pale sand under a desert sun washes the enemy bullets out)
const CP = {
  sandL: C(0xc39f72), sandM: C(0xb28a5e), sandD: C(0x93704c), sandR: C(0xab7650), dune: C(0xcaa678),
  track: C(0xa48662), trackL: C(0xb6966d), rut: C(0x80644a), wash: C(0x8f7458),
  slick: C(0xb9825a), slickL: C(0xc89a70), joint: C(0x6e4a35), lichen: C(0x6c6149), valley: C(0x96643f),
  gravel: C(0x958977), stain: C(0x5b544d), pad: C(0xa8a195), padD: C(0x8c867c),
  asphalt: C(0x6b645b), asphaltL: C(0x7d7568),
  clay: C(0x6e7985), salt: C(0x9fabb6), saltL: C(0xc2ccd4), crack: C(0x59616b), tread: C(0x5e6670), lakeRim: C(0x8a806f),
  rimTop: C(0xc49c70),
  scrub: C(0x878556), sage: C(0x95997a), cactus: C(0x5d7c4b), deadwood: C(0x8a735a), palm: C(0x6a7a3c),
  adobe: C(0xc6a07b), adobeL: C(0xdabb96), adobeD: C(0xa48262), dark: C(0x2e2824),
  sandbag: C(0xb79f78), tent: C(0xa99a72), camo: C(0xb29c70), camoD: C(0x8b7854), burnt: C(0x4b413b), rust: C(0x8c5a3e),
  tankW: C(0xe0ded8), tankS: C(0xb5b9bb), tankR: C(0x9c6a4e), steel: C(0x8e9499), steelD: C(0x5d6368),
  pipeY: C(0xc6a24e), pipeR: C(0xa24a3c), pipeG: C(0x9ea3a6), flame: C(0xffb24a),
};
// sandstone strata, bottom to top (repeating): bands 0.55 tall, gently tilted along the stage
const STRATA = [C(0xb4704a), C(0xdbb88c), C(0xc88a5b), C(0x9f5d3e), C(0xe4cba4), C(0xb06d4e), C(0xd19f6f), C(0x8f604b)];
const STRATA_H = 0.55;
function strataPhase(x, d) { return 3.4 + 0.22 * Math.sin(d * 0.019 + 0.7) + 0.12 * Math.sin(x * 0.061 + d * 0.011 + 2.1); }
function strataCol(h, x, d, out) {
  const b = (h + strataPhase(x, d)) / STRATA_H, i = Math.floor(b), f = b - i, n = STRATA.length;
  const c0 = STRATA[((i % n) + n) % n], c1 = STRATA[(((i + 1) % n) + n) % n];
  const t = sstep(0.82, 1, f);
  out[0] = lerp(c0[0], c1[0], t); out[1] = lerp(c0[1], c1[1], t); out[2] = lerp(c0[2], c1[2], t);
  return out;
}
function cset(out, c) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }

// soft section weights along the stage (a partition of unity), shared by height and colour
const CYW = new Float64Array(6);
function cyWeights(d) {
  const a = sstep(236, 276, d), b = sstep(545, 585, d), c = sstep(768, 800, d), e = sstep(985, 1015, d), f = sstep(1230, 1260, d);
  CYW[0] = 1 - a; CYW[1] = a * (1 - b); CYW[2] = b * (1 - c); CYW[3] = c * (1 - e); CYW[4] = e * (1 - f); CYW[5] = f;
}
// 0 where ground units need flat ground (lanes ±1.08, cross roads ±1.58 from CY_ROADS), 1 away from it
function cyFlatK(x, d) {
  let k = 1;
  for (let i = 0; i < 3; i++) {
    const a = Math.abs(x - LANES_X[i]);
    if (a < 2.05) { const s = sstep(1.08, 2.05, a); if (s < k) k = s; }
  }
  if (d > CY_ROADS - 3) {
    const r = 1 - sstep(1.58, 3.5, crossDist(d));
    if (r > 0) k *= 1 - r * sstep(CY_ROADS - 3, CY_ROADS, d);
  }
  return k;
}
function laneFree(x, r) {
  for (let i = 0; i < 3; i++) if (Math.abs(x - LANES_X[i]) < LANE_HALF + 0.12 + r) return false;
  return true;
}
// canPlace, plus lane clearance before the clear zone starts (the dune tracks are lanes too)
const cyFree = (x, d, r) => canPlace(x, d, r) && (d >= S.clear.from + 2 || laneFree(x, r));

// canyon wall foot |x| (s: 0 left, 1 right), 7.75 … 10.25, and the rim height 3.3 … 3.75
function cyEdge(d, s) {
  return 9 + 0.5 * Math.sin(d * 0.071 + s * 2.3) + 0.35 * Math.sin(d * 0.163 + 1.1 + s * 4.1) + 0.8 * (vnoise(d * 0.09 + s * 31.7, 5.5) - 0.5);
}
function cyRim(d, s) { return 3.3 + 0.45 * vnoise(d * 0.045 + s * 13.1, 7.7); }
// mesa plateau edge |x|, 7.65 … 9.95 (close enough to the centre that the drop shows on screen)
function cyMesaEdge(d, s) {
  return 8.8 + 0.5 * Math.sin(d * 0.093 + s * 1.7) + 0.35 * Math.sin(d * 0.21 + 0.4 + s * 3.3) + 0.6 * (vnoise(d * 0.12 + s * 17.3, 3.3) - 0.5);
}
// dune phase: 0 → 0.7 is the long windward slope, 0.7 → 1 the slip face (it faces away from the sun)
function cyDuneF(x, d) {
  const u = x * 0.068 + d * 0.058 + 0.55 * fbm(x * 0.05 + 7.1, d * 0.05 - 3.3);
  return u - Math.floor(u);
}
function cyDuneH(x, d) {
  const ax = Math.abs(x);
  const f = cyDuneF(x, d);
  const ridge = f < 0.7 ? sstep(0, 0.7, f) : sstep(1, 0.7, f);            // long windward slope, steep slip face
  const amp = 0.24 + 1.15 * sstep(6.8, 15, ax) + 0.22 * vnoise(x * 0.13 + 2.2, d * 0.13);
  return amp * ridge * (0.7 + 0.3 * vnoise(x * 0.31 + 1.3, d * 0.31 - 4.1));
}
function cyCanyonH(x, d) {
  const s = x < 0 ? 0 : 1, e = Math.abs(x) - cyEdge(d, s);
  if (e < -0.35) return 0;
  let h = cyRim(d, s) * (0.1 * sstep(-0.35, 0.5, e) + 0.9 * sstep(0.3, 2.5, e));
  if (e > 2.5) h += 0.28 * (fbm(x * 0.21 + 2.2, d * 0.21 + 9.4) - 0.5);
  return h;
}
function cyMesaH(x, d) {
  const s = x < 0 ? 0 : 1, e = Math.abs(x) - cyMesaEdge(d, s);
  if (e <= 0) return 0;
  return CY_VALLEY * (0.45 * sstep(0, 0.8, e) + 0.55 * sstep(1.2, 2.3, e)) + 0.3 * sstep(2.5, 5, e) * fbm(x * 0.17 + 1.3, d * 0.17 + 5.5);
}
function cyBluffH(x, x0, amp, d) {
  const ax = Math.abs(x);
  if (ax <= x0) return 0;
  return amp * sstep(x0, x0 + 5, ax) * (0.7 + 0.6 * fbm(x * 0.09 + 3.1, d * 0.09 - 1.7));
}
function canyonH(x, d) {
  cyWeights(d);
  let h = 0;
  if (CYW[0] > 0) h += CYW[0] * cyDuneH(x, d);
  if (CYW[1] > 0) h += CYW[1] * cyCanyonH(x, d);
  if (CYW[2] > 0) h += CYW[2] * cyMesaH(x, d);
  if (CYW[3] > 0) h += CYW[3] * cyBluffH(x, 19, 2.0, d);
  if (CYW[4] > 0) h += CYW[4] * cyBluffH(x, 16.5, 1.1, d);
  if (CYW[5] > 0) h += CYW[5] * cyBluffH(x, 21, 0.7, d);
  return h === 0 ? 0 : h * cyFlatK(x, d);
}
// ground colour of one section (s = index into CYW) before rock and grain
function cyFloor(s, x, d, h, n, out) {
  switch (s) {
    case 0: {    // dunes: painted from the dune phase too, so they read even where the ground is flat
      const f = cyDuneF(x, d);
      const crest = f < 0.7 ? sstep(0.2, 0.7, f) : 1 - sstep(0.7, 0.75, f);
      const lee = f > 0.7 ? 1 - sstep(0.93, 1.0, f) : 0;
      cset(out, CP.sandM); mixInto(out, CP.dune, crest * 0.6); mixInto(out, CP.sandD, lee * 0.7 + (1 - n) * 0.15);
      mixInto(out, CP.dune, sstep(0.3, 1.1, h) * 0.3);
      break;
    }
    case 1: {    // canyon floor: reddish sand, a dry wash meandering through it
      cset(out, CP.sandR); mixInto(out, CP.sandM, n * 0.55);
      const a = Math.abs(x - (2.9 * Math.sin(d * 0.043 + 1.3) + 1.3 * Math.sin(d * 0.11 + 0.4)));
      if (a < 1.8) mixInto(out, CP.wash, sstep(1.8, 0.6, a) * 0.55);
      break;
    }
    case 2: {    // mesa top: banded red slickrock, sand pockets, lichen
      cset(out, CP.slick);
      mixInto(out, CP.slickL, sstep(0.45, 0.75, vnoise(x * 0.18 + d * 0.06 + 4.2, d * 0.05)) * 0.6);
      mixInto(out, CP.sandM, sstep(0.5, 0.72, n) * 0.6);
      const l = vnoise(x * 0.6 + 3.3, d * 0.6 - 1.1);
      if (l > 0.7) mixInto(out, CP.lichen, (l - 0.7) * 1.6);
      break;
    }
    case 3: {    // refinery: graded gravel with oil stains
      cset(out, CP.gravel); mixInto(out, CP.sandM, n * 0.45);
      const st = fbm(x * 0.35 + 9.1, d * 0.35 - 2.2);
      if (st > 0.6) mixInto(out, CP.stain, sstep(0.6, 0.8, st) * 0.5);
      break;
    }
    case 4: {    // fortress: packed sand and gravel
      cset(out, CP.sandM); mixInto(out, CP.gravel, 0.3 + n * 0.3);
      break;
    }
    default: {   // dry lakebed: cool grey clay, salt crust in drifts, damp dark hollows, sandy shore far out
      cset(out, CP.clay);
      const m = lakeSalt(x, d);
      mixInto(out, CP.salt, sstep(0.44, 0.6, m) * 0.9);
      mixInto(out, CP.crack, sstep(0.36, 0.2, m) * 0.45);
      mixInto(out, CP.salt, sstep(0.55, 0.8, vnoise(x * 0.35 + d * 0.12, d * 0.1 - x * 0.05)) * 0.25);   // streaks
      // old shorelines: faint pale terraces toward the edges of the pan (the arena centre stays calm)
      const ax = Math.abs(x), sb = Math.sin((ax + 3.2 * fbm(x * 0.03 + 4.4, d * 0.03)) * 1.25) * 0.5 + 0.5;
      mixInto(out, CP.saltL, sstep(0.72, 0.95, sb) * sstep(9.5, 14, ax) * 0.5);
      mixInto(out, CP.lakeRim, sstep(18, 26, ax));
    }
  }
}
function lakeSalt(x, d) { return fbm(x * 0.045 + 1.9, d * 0.045 + 6.6); }        // salt-crust mask of the lakebed
function canyonColor(x, d, h, out) {
  cyWeights(d);
  const n = fbm(x * 0.11 + 5.1, d * 0.11 - 2.3);
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (let s = 0; s < 6; s++) {
    const w = CYW[s];
    if (w <= 0) continue;
    cyFloor(s, x, d, h, n, TC2);
    out[0] += TC2[0] * w; out[1] += TC2[1] * w; out[2] += TC2[2] * w;
  }
  // exposed rock (walls, rims, the mesa cliffs and valley, far bluffs) — not the dunes
  const ah = h < 0 ? -h : h;
  const rw = (1 - CYW[0]) * sstep(0.1, 0.45, ah) * (1 - CYW[5] * 0.6);
  if (rw > 0) mixInto(out, strataCol(h, x, d, TC2), rw);
  if (h > 3.0) mixInto(out, CP.rimTop, sstep(3.0, 3.6, h) * 0.45 * (0.6 + 0.4 * n));      // weathered rim tops
  if (h < -0.1) {                                                                        // below the mesa rim:
    mixInto(out, CP.valley, sstep(-2.2, -2.55, h) * 0.55);                               // dusty valley floor,
    const k = 1 - 0.34 * sstep(-0.1, -1.4, h);                                           // deeper = darker
    out[0] *= k; out[1] *= k; out[2] *= k;
  }
  const g = 0.94 + 0.12 * vnoise(x * 0.9 + 1.7, d * 0.9 + 4.1);
  out[0] *= g; out[1] *= g; out[2] *= g;
}

// ---- desert prop library -------------------------------------------------------------
const BX = new Float32Array(10), BD = new Float32Array(10);
// A stepped block of layered rock: a jittered n-gon footprint (rx across, rd along, rotated) stacked
// in the world strata bands from h0 to h1; now and then a band steps back (a ledge). A row of them
// reads as a stepped sandstone cliff; one alone is a butte. shBase = ground height for its shadow.
function rockBlock(x, d, rx, rd, h0, h1, rot, n = 6, shBase = 0) {
  if (h1 - h0 < 0.08) return;
  frame(x, d, rot);
  const a0 = rand() * TAU;
  for (let i = 0; i < n; i++) {
    const a = a0 + ((i + rr(-0.2, 0.2)) / n) * TAU, q = rr(0.86, 1.06);
    BX[i] = Math.cos(a) * rx * q; BD[i] = Math.sin(a) * rd * q;
  }
  const ph = strataPhase(x, d);
  let y = h0, sc = 1;
  while (y < h1 - 0.02) {
    let yb = (Math.floor((y + ph) / STRATA_H + 1e-3) + 1) * STRATA_H - ph;   // next strata boundary
    if (yb > h1 - 0.12) yb = h1;
    for (let i = 0; i < n; i++) { PX[i] = BX[i] * sc; PD[i] = BD[i] * sc; }
    const c = jit(strataCol((y + yb) * 0.5, x, d, TC2), 0.06, TC3);
    prism(n, y, yb, c, yb >= h1 ? tint(c, CP.rimTop, 0.3, TC2) : c);
    y = yb;
    if (rand() < 0.45) sc *= rr(0.84, 0.94);                                  // a ledge: the next band steps back
  }
  const hh = h1 - shBase, ox = hh * SUNX * SHK, od = hh * SUND * SHK;
  for (let i = 0; i < n; i++) {
    const px = wx(BX[i], BD[i]), pd = wd(BX[i], BD[i]);
    HX[i] = px; HD[i] = pd; HX[i + n] = px + ox; HD[i + n] = pd + od;
  }
  shadowHull(2 * n, GROUND_Y + shBase + L_SHADOW);
  frameId();
}
// can a rockBlock of this footprint (rotated by ≤ rot) stand at (x, d)?
function blockFits(x, d, rx, rd, rot) {
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const ex = (c * rx + s * rd) * 1.08, ed = (s * rx + c * rd) * 1.08;
  return canRect(x - ex, x + ex, d - ed, d + ed);
}
// horizontal pipe along local d at centre height yc (rel.), radius r; undersides are skipped
function pipeD(x, a, b, yc, r, c, segs = 6) {
  checkTall(x - r, a, x + r, b, yc + r);
  if (!room(segs * 6)) return;
  setTile(0);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU, am = (a0 + a1) * 0.5;
    const up = Math.sin(am);
    if (up < -0.35) continue;
    const x0 = x + Math.cos(a0) * r, y0 = GROUND_Y + yc + Math.sin(a0) * r;
    const x1 = x + Math.cos(a1) * r, y1 = GROUND_Y + yc + Math.sin(a1) * r;
    const k = 0.8 + 0.2 * up - 0.06 * Math.cos(am);
    vtx(x0, y0, a, c, k, 0, 0); vtx(x0, y0, b, c, k, 0, 0); vtx(x1, y1, b, c, k, 0, 0);
    vtx(x0, y0, a, c, k, 0, 0); vtx(x1, y1, b, c, k, 0, 0); vtx(x1, y1, a, c, k, 0, 0);
  }
}
// a thin ribbon between two points in the air (wires); both ends at rel. heights
function wire(x0, d0, h0, x1, d1, h1, w, c) {
  if (!room(6)) return;
  const L = Math.hypot(x1 - x0, d1 - d0) || 1, nx = -(d1 - d0) / L * w, nd = (x1 - x0) / L * w;
  vtx(x0 - nx, GROUND_Y + h0, d0 - nd, c, 1, 0, 0); vtx(x1 - nx, GROUND_Y + h1, d1 - nd, c, 1, 0, 0); vtx(x1 + nx, GROUND_Y + h1, d1 + nd, c, 1, 0, 0);
  vtx(x0 - nx, GROUND_Y + h0, d0 - nd, c, 1, 0, 0); vtx(x1 + nx, GROUND_Y + h1, d1 + nd, c, 1, 0, 0); vtx(x0 + nx, GROUND_Y + h0, d0 + nd, c, 1, 0, 0);
}
function stratum(h, x, d) { return jit(strataCol(h, x, d, TC2), 0.1, TC3); }
function boulder(x, d, r, base) {
  frameId();
  rock(x, d, r, base - r * 0.45, r * rr(0.9, 1.3), STRATA[(rand() * STRATA.length) | 0]);
}
function hoodoo(x, d, h, base) {
  const r = rr(0.26, 0.38);
  frame(x, d, rand() * TAU);
  LR[0] = r * 1.3; LH[0] = base - 0.08; LK[0] = 0.72;
  LR[1] = r; LH[1] = base + h * 0.3; LK[1] = 0.86;
  LR[2] = r * 0.7; LH[2] = base + h * 0.7; LK[2] = 0.95;
  LR[3] = r * 0.82; LH[3] = base + h * 0.86; LK[3] = 1.0;
  lathe(0, 0, 4, 6, stratum(base + h * 0.4, x, d), 0, 1, 1, 0.2);
  LR[0] = r * 1.3; LH[0] = base + h * 0.84; LK[0] = 0.8;
  LR[1] = r * 1.42; LH[1] = base + h; LK[1] = 1.02;
  LR[2] = 0; LH[2] = base + h + 0.1; LK[2] = 1.08;
  lathe(0, 0, 3, 6, STRATA[3], 0.3, 1, 1, 0.2);
  frameId();
  shadowDisc(x, d, r, h, base);
}
function saguaro(x, d, h, base = 0) {
  const c = jit(CP.cactus, 0.12, TC2);
  cyl(x, d, 0.085, base, base + h, 6, c, c);
  cone(x, d, 0.085, base + h, base + h + 0.08, 6, c);
  const na = rand() < 0.3 ? 1 : 2, a0 = rand() * TAU;
  for (let i = 0; i < na; i++) {
    const a = a0 + i * Math.PI + rr(-0.4, 0.4), ay = base + h * rr(0.38, 0.55), ca = Math.cos(a), sa = Math.sin(a);
    frame(x, d, Math.atan2(sa, ca) - Math.PI / 2);
    box(-0.05, 0.05, 0.05, 0.3, ay - 0.05, ay + 0.05, c, c);                  // elbow out…
    frameId();
    const ex = x + ca * 0.3, ed = d + sa * 0.3, top = ay + h * rr(0.25, 0.4);
    cyl(ex, ed, 0.06, ay - 0.05, top, 5, c, c);                                // …and up
    cone(ex, ed, 0.06, top, top + 0.06, 5, c);
  }
  shadowDisc(x, d, 0.12, h, base);
}
function barrelCactus(x, d, base = 0) {
  frame(x, d, 0);
  LR[0] = 0.12; LH[0] = base; LK[0] = 0.8; LR[1] = 0.14; LH[1] = base + 0.12; LK[1] = 0.95; LR[2] = 0; LH[2] = base + 0.22; LK[2] = 1.1;
  lathe(0, 0, 3, 6, jit(CP.cactus, 0.15, TC2), 0);
  frameId();
}
function deadTree(x, d, h, base = 0) {
  const c = CP.deadwood;
  box(x - 0.05, d - 0.05, x + 0.05, d + 0.05, base, base + h, c, c);
  for (let i = 0; i < 3; i++) {
    const a = rand() * TAU, y = base + h * rr(0.45, 0.9), L = rr(0.25, 0.45);
    frame(x, d, a);
    box(-0.025, 0, 0.025, L, y - 0.025, y + 0.025, c, c);
    frameId();
  }
  shadowBox(x - 0.05, d - 0.05, x + 0.05, d + 0.05, h, base);
}
// flat-roofed mud-brick house with a parapet lip and a dark doorway on the −d side
function adobe(x, d, w, l, h, rot, c, base = 0) {
  frame(x, d, rot);
  plain();
  box(-w / 2, -l / 2, w / 2, l / 2, base, base + h, c, tint(c, CP.adobeL, 0.45, TC3));
  const p = 0.07, t = base + h + 0.08;
  box(-w / 2, -l / 2, w / 2, -l / 2 + p, base + h, t, c, c); box(-w / 2, l / 2 - p, w / 2, l / 2, base + h, t, c, c);
  box(-w / 2, -l / 2 + p, -w / 2 + p, l / 2 - p, base + h, t, c, c); box(w / 2 - p, -l / 2 + p, w / 2, l / 2 - p, base + h, t, c, c);
  box(-0.1, -l / 2 - 0.02, 0.1, -l / 2 + 0.02, base, base + Math.min(0.3, h * 0.7), CP.dark, CP.dark);
  shadowBox(-w / 2, -l / 2, w / 2, l / 2, h + 0.08, base);
  frameId();
}
function tent(x, d, rot, w, l) {
  frame(x, d, rot);
  plain();
  box(-w / 2, -l / 2, w / 2, l / 2, 0, 0.16, CP.tent, CP.tent, false);
  gable(-w / 2 - 0.04, -l / 2, w / 2 + 0.04, l / 2, 0.16, w * 0.4, jit(CP.tent, 0.08, TC3), true);
  shadowBox(-w / 2, -l / 2, w / 2, l / 2, 0.16 + w * 0.3);
  frameId();
}
// a line of sandbags (0.22 tall: never counts as tall) in the local frame, along local x
function sandbags(x, d, rot, len) {
  frame(x, d, rot);
  for (let s = -len / 2; s < len / 2 - 0.05; s += 0.34) box(s, -0.14, Math.min(s + 0.32, len / 2), 0.14, 0, rr(0.18, 0.22), CP.sandbag, jit(CP.sandbag, 0.08, TC3));
  frameId();
}
function crates(x, d, rot, n) {
  frame(x, d, rot);
  for (let i = 0; i < n; i++) {
    const cx = (i % 3) * 0.34 - 0.34, cd = ((i / 3) | 0) * 0.34, lv = i >= 6 ? 1 : 0;
    box(cx - 0.15, cd - 0.15, cx + 0.15, cd + 0.15, lv * 0.26, lv * 0.26 + 0.26, CP.camoD, jit(CP.camo, 0.1, TC3));
  }
  frameId();
  shadowBox(x - 0.5, d - 0.2, x + 0.5, d + 0.5, n > 6 ? 0.52 : 0.26);
}
function drums(x, d, n, c = CP.rust) {
  for (let i = 0; i < n; i++) {
    const a = i * 2.4, q = i ? 0.2 + i * 0.03 : 0;
    cyl(x + Math.cos(a) * q, d + Math.sin(a) * q, 0.075, 0, 0.22, 6, jit(c, 0.15, TC2), P.metalD);
  }
}
// burnt-out vehicle hulks
function wreckTruck(x, d, rot) {
  frame(x, d, rot);
  flat(-0.5, -0.9, 0.5, 0.9, L_BASE + 0.004, CP.burnt, 0.75);
  box(-0.21, 0.28, 0.21, 0.6, 0, 0.24, CP.burnt, CP.rust);
  box(-0.23, -0.6, 0.23, 0.2, 0.04, 0.16, CP.rust, CP.burnt);
  shadowBox(-0.22, -0.6, 0.22, 0.6, 0.24);
  frameId();
}
function wreckTank(x, d, rot) {
  frame(x, d, rot);
  flat(-0.8, -1.0, 0.8, 1.0, L_BASE + 0.004, CP.burnt, 0.7);
  box(-0.42, -0.62, 0.42, 0.62, 0, 0.22, CP.burnt, CP.camoD);
  frame(x, d, rot + 0.7);
  box(-0.25, -0.28, 0.25, 0.22, 0.22, 0.38, CP.rust, CP.burnt);
  box(-0.04, 0.22, 0.04, 0.95, 0.28, 0.34, CP.burnt, CP.burnt);
  frameId();
  shadowDisc(x, d, 0.55, 0.38);
}
function wreckJet(x, d, rot, s = 1) {
  frame(x, d, rot);
  disc(0, 0, 1.3 * s, 1.7 * s, L_BASE + 0.004, CP.burnt, 10, 0.8);
  box(-0.16 * s, -0.95 * s, 0.16 * s, 0.35 * s, 0, 0.26 * s, P.metalD, P.metal);                   // fuselage
  frame(x + 0.25 * s, d + 0.9 * s, rot + 0.5);
  box(-0.13 * s, -0.4 * s, 0.13 * s, 0.25 * s, 0, 0.2 * s, CP.burnt, P.metalD);                     // broken nose
  frame(x, d, rot);
  flat4(-1.0 * s, -0.25 * s, -0.12 * s, -0.4 * s, -0.12 * s, 0.1 * s, -0.8 * s, 0.05 * s, 0.1, P.metal, 0.9);   // wing
  box(-0.03, -1.05 * s, 0.03, -0.7 * s, 0.2 * s, 0.62 * s, P.metalD, P.metalD);                    // fin
  shadowBox(-0.16 * s, -0.95 * s, 0.16 * s, 0.35 * s, 0.3 * s);
  frameId();
}
// the crude oil line from the desert wells to the refinery, on stanchions along the left flank; it
// dives under every flat cross road with a concrete collar on each side
const PIPE_X = -7.35, PIPE_Y = 0.52, PIPE_R = 0.19;
function pipeSegment(a, b) {
  if (b - a < 0.6) return;
  frameId();
  pipeD(PIPE_X, a, b, PIPE_Y, PIPE_R, CP.pipeG, LOWQ ? 5 : 7);
  for (let d = Math.ceil(a / 2.6) * 2.6 + 0.8; d < b - 0.4; d += 2.6) {
    const g = canyonH(PIPE_X, d);
    if (g < PIPE_Y - PIPE_R - 0.04) box(PIPE_X - 0.05, d - 0.05, PIPE_X + 0.05, d + 0.05, g - 0.06, PIPE_Y - PIPE_R + 0.02, CP.steelD, CP.steelD);
    if (!LOWQ && ((d / 2.6) | 0) % 6 === 0) box(PIPE_X - 0.25, d - 0.06, PIPE_X + 0.25, d + 0.06, PIPE_Y - 0.25, PIPE_Y + 0.25, CP.pipeY, CP.pipeY);  // flange
  }
  shadowBox(PIPE_X - PIPE_R, a, PIPE_X + PIPE_R, b, PIPE_Y + PIPE_R * 0.5);
}
function pipeCollar(d) {
  frameId();
  box(PIPE_X - 0.32, d - 0.28, PIPE_X + 0.32, d + 0.28, 0, PIPE_Y + 0.12, CP.padD, CP.pad);
  shadowBox(PIPE_X - 0.32, d - 0.28, PIPE_X + 0.32, d + 0.28, PIPE_Y + 0.12);
}
function cyPipeline(d0, d1) {
  const a = Math.max(d0, -80), b = Math.min(d1, CY_REF + 12);
  if (b <= a) return;
  const c = Math.floor(d0 / CHUNK) * CHUNK + 20;
  if (c >= CY_ROADS) {
    pipeSegment(a, Math.min(b, c - 2.1)); if (c - 2.1 > a && c - 2.1 < b) pipeCollar(c - 2.1);
    pipeSegment(Math.max(a, c + 2.1), b); if (c + 2.1 > a && c + 2.1 < b) pipeCollar(c + 2.1);
  } else pipeSegment(a, b);
  if (b === CY_REF + 12) pipeCollar(b);                                          // into the refinery tank farm
}

// plain() leaves SIDE_V / TOP_V as the last sideStyle/topStyle set them, so an untextured box
// top would take its v scale from the previous chunk: a chunk's bytes would then depend on build
// order. The canyon and sky generators start from a fully reset style (coastal keeps its bytes).
function styleReset() { plain(); SIDE_V = 0; TOP_V = 0; }

// ---- canyon chunks ---------------------------------------------------------------------
function genCanyon(w, ch, k, d0) {
  const d1 = d0 + CHUNK;
  styleReset();
  cyRoads(d0, d1);
  if (d0 < 262) cyDunes(ch, k, d0, Math.min(d1, 262));
  if (d1 > 238 && d0 < 586) cyCanyon(ch, k, Math.max(d0, 238), Math.min(d1, 586));
  if (d1 > 560 && d0 < CY_REF + 2) cyMesa(ch, k, Math.max(d0, 560), Math.min(d1, CY_REF + 2));
  if (d1 > CY_REF && d0 < CY_FORT) cyRefinery(ch, k, d0, d1);
  if (d1 > CY_FORT && d0 < CY_LAKE) cyFortress(ch, k, d0, d1);
  if (d1 > CY_LAKE) cyLake(ch, k, Math.max(d0, CY_LAKE), d1);
  if (d0 < CY_REF + 12) cyPipeline(d0, d1);
}

// lanes: sand tracks up to the refinery gate, asphalt through the refinery, taxiways and the
// airstrip in the fortress; cross roads (from 260) in the same styles
function sandTrack(lx, a, b) {
  if (b <= a) return;
  flat(lx - 1.12, a, lx + 1.12, b, L_BASE + 0.003, CP.trackL, 0.98);
  flat(lx - 0.96, a, lx + 0.96, b, L_ROAD, CP.track);
  flat(lx - 0.58, a, lx - 0.4, b, L_WALK, CP.rut);
  flat(lx + 0.4, a, lx + 0.58, b, L_WALK, CP.rut);
}
function sandCross(c) {
  flat(-40, c - 1.38, 40, c + 1.38, L_ROAD - 0.004, CP.track);
  flat(-40, c - 0.58, 40, c - 0.4, L_WALK - 0.004, CP.rut);
  flat(-40, c + 0.4, 40, c + 0.58, L_WALK - 0.004, CP.rut);
}
// refinery roads: warm, sand-dusted asphalt (the cross road sits a hair under the lanes)
function dustRoad(lx, a, b) {
  if (b <= a) return;
  flat(lx - 1.14, a, lx + 1.14, b, L_ROAD - 0.003, CP.asphaltL);
  flat(lx - 0.98, a, lx + 0.98, b, L_ROAD, CP.asphalt);
  for (let d = Math.ceil(a / 2.5) * 2.5; d < b - 1.3; d += 2.5) {
    if (crossDist(d + 0.6) < 2.4) continue;
    flat(lx - 0.06, d, lx + 0.06, d + 1.2, L_MARK, P.paint, 0.78);
  }
}
function dustCross(c) {
  flat(-40, c - 1.62, 40, c + 1.62, L_ROAD - 0.006, CP.asphaltL);
  flat(-40, c - 1.46, 40, c + 1.46, L_ROAD - 0.004, CP.asphalt);
  for (let x = -40; x < 38.8; x += 2.5) {
    let skip = false;
    for (let i = 0; i < 3; i++) if (Math.abs(x + 0.6 - LANES_X[i]) < 2.2) skip = true;
    if (!skip) flat(x, c - 0.05, x + 1.2, c + 0.05, L_MARK - 0.004, P.paint, 0.78);
  }
}
function fortCross(c) {
  // concrete taxi connector with a yellow line; split around the airstrip
  const onStrip = c > CY_STRIP_A && c < CY_STRIP_B;
  for (const [a, b] of onStrip ? [[-26, -3.1], [3.1, 26]] : [[-26, 26]]) {
    flat(a, c - 1.45, b, c + 1.45, L_ROAD - 0.004, P.concreteD);
    flat(a, c - 0.05, b, c + 0.05, L_MARK - 0.004, P.yellow, 0.9);
  }
}
// lane 0 in the fortress: a concrete road outside the airstrip, the strip itself inside
function fortCentre(a, b) {
  const A = CY_STRIP_A, B = CY_STRIP_B;
  if (a < A) { flat(-1.1, a, 1.1, Math.min(b, A), L_ROAD, P.concrete); flat(-0.05, a, 0.05, Math.min(b, A), L_MARK, P.yellow, 0.9); }
  if (b > B) { flat(-1.1, Math.max(a, B), 1.1, b, L_ROAD, P.concrete); flat(-0.05, Math.max(a, B), 0.05, b, L_MARK, P.yellow, 0.9); }
  const s = Math.max(a, A), e = Math.min(b, B);
  if (e <= s) return;
  const W = 2.75;
  flat(-W - 0.32, s, W + 0.32, e, L_ROAD - 0.002, P.asphaltD);
  flat(-W, s, W, e, L_ROAD, P.runway);
  flat(-W + 0.12, s, -W + 0.22, e, L_MARK, P.paint, 0.9); flat(W - 0.22, s, W - 0.12, e, L_MARK, P.paint, 0.9);
  for (let d = Math.ceil(s / 3.5) * 3.5; d < e - 1.8; d += 3.5) {
    if (d < A + 14 || d > B - 14 || crossDist(d + 0.9) < 2.2) continue;
    flat(-0.07, d, 0.07, d + 1.8, L_MARK, P.paint, 0.9);
  }
  // threshold piano keys + runway numbers at both ends, sand drifting over the tarmac edges
  for (const [t, dir, tile] of [[A + 1.2, 1, T_R36], [B - 1.2, -1, T_R18]]) {
    const kd = dir > 0 ? t : t - 2.6;
    if (kd >= s && kd + 2.6 <= e) for (let i = 0; i < 8; i++) {
      if (i === 4) continue;
      const x = -2.4 + i * 0.62 + (i >= 4 ? 0.3 : 0);
      flat(x - 0.2, kd, x + 0.2, kd + 2.6, L_MARK, P.paint, 0.95);
    }
    const nd = dir > 0 ? t + 3.4 : t - 3.4 - 2.2;
    if (nd >= s && nd + 2.2 <= e) {
      setTile(tile);
      if (dir > 0) { uvMode(1.8, 2.2, false, -0.9, nd); flat(-0.9, nd, 0.9, nd + 2.2, L_MARK, P.white); }
      else { frame(0, nd + 1.1, Math.PI); uvMode(1.8, 2.2, false, -0.9, -1.1); flat(-0.9, -1.1, 0.9, 1.1, L_MARK, P.white); frameId(); }
      setTile(0); uvMode(0, 0);
    }
  }
  for (let d = Math.ceil(s / 3) * 3 + 1; d < e; d += 3) {
    if (crossDist(d) < 1.9) continue;
    for (const sx of [-1, 1]) box(sx * 3.2 - 0.05, d - 0.05, sx * 3.2 + 0.05, d + 0.05, 0, 0.1, P.paint, P.glassL);   // edge lights
  }
}
function cyRoads(d0, d1) {
  frameId(); setTile(0); uvMode(0, 0);
  for (let i = 0; i < 3; i++) {
    const lx = LANES_X[i];
    if (d0 < CY_REF) sandTrack(lx, d0, Math.min(d1, CY_REF));
    if (d1 > CY_REF && d0 < CY_FORT) dustRoad(lx, Math.max(d0, CY_REF), Math.min(d1, CY_FORT));
    if (d1 > CY_FORT && d0 < FORT_REAR + 0.8) {                                // the roads end at the rear gates
      const a = Math.max(d0, CY_FORT), b = Math.min(d1, FORT_REAR + 0.8);
      if (i === 1) fortCentre(a, b); else laneRoad(lx, a, b, 'taxi');
    }
    frameId(); setTile(0); uvMode(0, 0);
  }
  const c = d0 + 20;
  if (c >= 260 && c < CY_LAKE) {
    if (c < CY_REF) sandCross(c);
    else if (c < CY_FORT) dustCross(c);
    else fortCross(c);
  }
}

// dunes 0–260: wind-sculpted sand, scrub, an oasis compound now and then, wrecks, a telegraph line
function cyDunes(ch, k, a, b) {
  if (b <= a) return;
  const nb = LOWQ ? 12 : 26;
  for (let i = 0; i < nb; i++) {
    const x = i < nb / 2 ? rr(-9, 9) : rr(-17, 17), d = rr(a, b);                // half of them on screen
    if (!laneFree(x, 0.3)) continue;
    bush(x, d, rr(0.12, 0.26), jit(rand() < 0.6 ? CP.scrub : CP.sage, 0.15, TC2), canyonH(x, d) - 0.03);
  }
  if (!LOWQ) for (let i = 0; i < 10; i++) {                                     // pebbles and stones
    const x = rr(-9, 9), d = rr(a, b);
    if (laneFree(x, 0.2)) rock(x, d, rr(0.08, 0.16), canyonH(x, d) - 0.06, rr(0.1, 0.18), STRATA[(rand() * STRATA.length) | 0]);
  }
  for (let i = 0; i < 4; i++) {
    const x = (rand() < 0.5 ? -1 : 1) * rr(7.6, 17), d = rr(a, b);
    if (laneFree(x, 0.7)) boulder(x, d, rr(0.25, 0.55), canyonH(x, d));
  }
  // an oasis every other chunk: palms round a dry spring, a ruined mud-brick compound
  if ((k & 1) === 0 && b - a > 30) {
    const side = ((k >> 1) & 1) ? 1 : -1, cx = side * rr(9.6, 11.5), cd = rr(a + 10, b - 10);
    frameId();
    disc(cx, cd, 1.7, 1.25, L_BASE + 0.004, CP.wash, 12, 0.95);
    disc(cx, cd, 1.0, 0.7, L_ROAD, CP.valley, 10, 0.8);
    for (let i = 0; i < 7; i++) {
      const an = rand() * TAU, q = rr(1.5, 3.2), x = cx + Math.cos(an) * q, d = cd + Math.sin(an) * q * 0.8;
      if (laneFree(x, 1.3)) palm(x, d, rr(1.0, 1.4), canyonH(x, d) - 0.03);
    }
    for (let i = 0; i < 5; i++) {
      const x = cx + rr(-2.5, 2.5), d = cd + rr(-2.5, 2.5);
      if (laneFree(x, 0.3)) bush(x, d, rr(0.18, 0.3), jit(CP.palm, 0.15, TC2), canyonH(x, d) - 0.03);
    }
    const hx = cx + side * 3.2, hd = cd + rr(-3, 3);
    if (laneFree(hx, 1.2)) {
      adobe(hx, hd, 1.1, 0.9, 0.42, rr(-0.2, 0.2), jit(CP.adobe, 0.06, TC2), canyonH(hx, hd) - 0.05);
      const rx = hx + side * 1.6, rd = hd + 1.4;
      frame(rx, rd, rr(-0.3, 0.3));                                             // roofless ruin
      const g = canyonH(rx, rd) - 0.05;
      box(-0.8, -0.7, 0.8, -0.58, g, g + 0.36, CP.adobeD, CP.adobe); box(-0.8, -0.58, -0.68, 0.7, g, g + 0.5, CP.adobeD, CP.adobe);
      box(0.2, 0.58, 0.8, 0.7, g, g + 0.22, CP.adobeD, CP.adobe);
      frameId();
    }
  }
  // landmarks: a burnt convoy on the right track shoulder, a crashed fighter out on the dunes
  if (k === 1 || k === 4) { wreckTruck(7.4, a + 12, 0.25); wreckTruck(7.2, a + 16.5, -0.4); wreckTank(8.6, a + 24, 1.2); }
  if (k === 3) wreckJet(-11.5, a + 21, 0.7, 1.15);
  if (k === 5) { crates(-8.2, a + 8, 0.2, 7); drums(-8.4, a + 11, 5); tent(-10.5, a + 9, 0.3, 1.1, 1.6); }
  // telegraph line along the right flank (poles at d ≡ 1 mod 6; each chunk strings the wires from
  // the last pole before it, so the line runs on across the chunk seams)
  const tx = 8.7;
  let pd = NaN, ph = 0;
  for (let d = Math.floor((a - 1) / 6) * 6 + 1; d < b; d += 6) {
    const g = canyonH(tx, d);
    if (d >= a) {
      box(tx - 0.04, d - 0.04, tx + 0.04, d + 0.04, g - 0.05, g + 1.45, CP.deadwood, CP.deadwood);
      box(tx - 0.3, d - 0.03, tx + 0.3, d + 0.03, g + 1.3, g + 1.36, CP.deadwood, CP.deadwood);
      shadowBox(tx - 0.04, d - 0.04, tx + 0.04, d + 0.04, 1.45, g);
      if (pd === pd && !LOWQ) for (const o of [-0.26, 0.26]) wire(tx + o, pd, ph, tx + o, d, g + 1.37, 0.012, P.hullDark);
    }
    pd = d; ph = g + 1.37;
  }
}

// canyon 260–560: stepped strata cliffs on both sides (tapering into every side slot), talus,
// hoodoos on the rims, desert plants and an outpost or two on the floor
function cyCanyon(ch, k, a, b) {
  for (let s = 0; s < 2; s++) {
    const side = s ? 1 : -1;
    let d = a + rr(0, 1.2);
    while (d < b) {
      const len = rr(1.7, 2.7), dc = d + len * 0.5;
      cyWeights(dc);
      const wC = CYW[1];
      const slot = dc >= CY_ROADS ? sstep(2.3, 6.5, crossDist(dc)) : 1;
      const top = (cyRim(dc, s) + rr(-0.45, 0.1)) * wC * (0.22 + 0.78 * slot);
      const rx = rr(0.95, 1.45), rd = len * rr(0.6, 0.72), rot = rr(-0.2, 0.2);
      const cx = side * (cyEdge(dc, s) + rx * 0.78 + rr(0, 0.35));
      if (top > 0.3 && blockFits(cx, dc, rx, rd, rot)) rockBlock(cx, dc, rx, rd, -0.15, top, rot, LOWQ ? 5 : 6);
      // a second block behind it fills the rim (mostly at the screen edge)
      if (!LOWQ && top > 1.5) {
        const bx = cx + side * rr(1.4, 2.0);
        if (blockFits(bx, dc, rx, rd, rot)) rockBlock(bx, dc + rr(-0.5, 0.5), rx * rr(0.9, 1.2), rd, top * 0.6, Math.min(3.85, top + rr(-0.1, 0.25)), rot, 5);
      }
      d += len * rr(0.7, 0.92);
    }
    // talus boulders at the wall foot, scrub, hoodoos up on the rim
    const nr = LOWQ ? 4 : 8;
    for (let i = 0; i < nr; i++) {
      const dd = rr(a, b), x = side * (cyEdge(dd, s) - rr(-0.2, 1.0)), r = rr(0.16, 0.48);
      cyWeights(dd);
      if (CYW[1] > 0.4 && cyFree(x, dd, r * 1.2)) boulder(x, dd, r, canyonH(x, dd));
    }
    for (let i = 0; i < (LOWQ ? 2 : 4); i++) {
      const dd = rr(a, b), x = side * (cyEdge(dd, s) + rr(2.9, 5.5));
      cyWeights(dd);
      if (CYW[1] > 0.8 && cyFree(x, dd, 0.5)) {
        const g = canyonH(x, dd);
        if (g > 2.8 && g + 0.9 < MAX_H) hoodoo(x, dd, Math.min(MAX_H - g - 0.12, rr(0.5, 0.85)), g);
      }
    }
  }
  // floor texture: loose patches of desert-pavement gravel (atlas grain), close to the floor tone
  frameId();
  for (let i = 0; i < (LOWQ ? 2 : 6); i++) {
    const x = rr(-7.2, 7.2), d = rr(Math.max(a, 262) + 1.5, b - 1.5);
    if (d >= b - 1.5) continue;
    setTile(T_GRAVEL); uvMode(1.1, 1.1);
    for (let j = 0; j < 3; j++) {
      const px = x + rr(-0.9, 0.9), pd = d + rr(-0.9, 0.9), rx = rr(0.5, 1.2), rd = rr(0.4, 1.0);
      if (Math.abs(px) + rx > cyEdge(pd, px < 0 ? 0 : 1) - 0.45) continue;
      disc(px, pd, rx, rd, L_BASE + 0.001 + j * 0.0008, jit(CP.sandR, 0.05, TC3), 10, 0.9);
    }
  }
  setTile(0); uvMode(0, 0);
  // floor: scrub, saguaros, barrel cacti and pebbles off the lanes
  const nf = LOWQ ? 8 : 16;
  for (let i = 0; i < nf; i++) {
    const x = rr(-8.2, 8.2), d = rr(a, b);
    const r = rand();
    if (Math.abs(x) > cyEdge(d, x < 0 ? 0 : 1) - 0.35) continue;                // not inside the cliff
    if (r < 0.5) { if (cyFree(x, d, 0.3)) bush(x, d, rr(0.14, 0.26), jit(rand() < 0.5 ? CP.scrub : CP.sage, 0.15, TC2), -0.03); }
    else if (r < 0.66) { if (cyFree(x, d, 0.45) && Math.abs(x) > 6.7) saguaro(x, d, rr(0.7, 1.05)); }
    else if (r < 0.82) { if (cyFree(x, d, 0.16)) barrelCactus(x, d); }
    else if (cyFree(x, d, 0.2)) rock(x, d, rr(0.1, 0.18), -0.06, rr(0.12, 0.2), STRATA[(rand() * STRATA.length) | 0]);
  }
  if (!LOWQ && rand() < 0.6) { const x = (rand() < 0.5 ? -1 : 1) * rr(6.8, 7.4), d = rr(a + 2, b - 2); if (cyFree(x, d, 0.45)) deadTree(x, d, rr(0.5, 0.8)); }
  // outposts by the side slots: sandbag nests, crates, a burnt-out tank
  const c = Math.floor(a / CHUNK) * CHUNK + 20;
  if (c > a && c < b && c >= 300 && c < 540) {
    const side = (k & 1) ? 1 : -1, nx = side * 7.3, nd = c + 3.4 * ((k >> 1) & 1 ? 1 : -1);
    if (cyFree(nx, nd, 0.5)) { sandbags(nx, nd, Math.PI / 2, 1.2); crates(nx + side * 0.2, nd + (nd > c ? 1.0 : -1.3), 0.1, 4); }
  }
  if (k === 9) wreckTank(-7.3, 377, 2.2);
  if (k === 12) { drums(7.1, 498, 6); tent(7.9, 503, 0.2, 1.0, 1.4); }
}

// mesa plateau 560–780: slickrock, rim rocks along the drop, buttes rising from the valley, a
// relay station on the rim; the mid-boss corridor (|x| < 5.5) only gets flat detail
function cyMesa(ch, k, a, b) {
  frameId();
  // slickrock: two sets of long straight joints and weathering pits on the plateau (flat)
  const onTop = (x, d) => Math.abs(x) < cyMesaEdge(d, x < 0 ? 0 : 1) - 0.3;
  for (let i = 0; i < (LOWQ ? 7 : 14); i++) {
    const th = (rand() < 0.6 ? 0.38 : 0.38 + Math.PI / 2) + rr(-0.05, 0.05), L = rr(3, 10);
    const cx = rr(-9.5, 9.5), cd = rr(a + 2, b - 2), ux = Math.cos(th) * L / 2, ud = Math.sin(th) * L / 2;
    if (onTop(cx - ux, cd - ud) && onTop(cx + ux, cd + ud)) crackEdge(cx - ux, cd - ud, cx + ux, cd + ud, 0.045, CP.joint, L_BASE + 0.004);
  }
  for (let i = 0; i < (LOWQ ? 3 : 7); i++) {
    const x = rr(-8.5, 8.5), d = rr(a + 1, b - 1), r = rr(0.16, 0.42);
    if (!onTop(x, d)) continue;
    disc(x, d, r, r * rr(0.7, 1), L_BASE + 0.004, CP.joint, 8, 0.95);
    disc(x, d, r * 0.55, r * 0.45, L_BASE + 0.006, CP.lichen, 6, 0.8);
  }
  for (let i = 0; i < (LOWQ ? 6 : 12); i++) {
    const x = rr(-9, 9), d = rr(a, b);
    if (cyFree(x, d, 0.32) && canyonH(x, d) > -0.05) bush(x, d, rr(0.13, 0.26), jit(CP.sage, 0.15, TC2), -0.03);
  }
  for (let s = 0; s < 2; s++) {
    const side = s ? 1 : -1;
    // rocks along the plateau edge: now a lone boulder, now a cluster
    for (let d = a + rr(0, 3); d < b; d += rr(2.4, 5.5)) {
      cyWeights(d);
      if (CYW[2] < 0.5) continue;
      const x = side * (cyMesaEdge(d, s) - rr(0.2, 0.8)), r = rr(0.25, 0.65);
      if (!cyFree(x, d, r * 1.2)) continue;
      boulder(x, d, r, 0);
      if (rand() < 0.5) { const x2 = x + side * rr(0.2, 0.6), d2 = d + rr(-0.9, 0.9); if (cyFree(x2, d2, 0.35)) boulder(x2, d2, rr(0.14, 0.3), 0); }
    }
    // buttes out in the valley (stacked strata rising from the valley floor)
    for (let d = a + rr(3, 12); d < b - 2; d += rr(11, 20)) {
      cyWeights(d);
      if (CYW[2] < 0.7) continue;
      const r = rr(1.5, 2.8), rx = r * rr(0.8, 1.05), rd = r * rr(0.95, 1.4), rot = rr(-0.5, 0.5);
      const x = side * (cyMesaEdge(d, s) + 3.1 + r * 1.2 + rr(0, 4));
      if (blockFits(x, d, rx, rd, rot)) rockBlock(x, d, rx, rd, CY_VALLEY - 0.1, rr(0.8, 3.7), rot, 7, CY_VALLEY);
    }
    for (let i = 0; i < (LOWQ ? 3 : 6); i++) {                                   // valley scrub
      const d = rr(a, b), x = side * (cyMesaEdge(d, s) + rr(3, 9)), g = canyonH(x, d);
      if (g < -2.2 && cyFree(x, d, 0.3)) bush(x, d, rr(0.18, 0.3), jit(CP.scrub, 0.15, TC2), g - 0.03);
    }
  }
  // cairns (low) beside the corridor
  if (!LOWQ) for (let i = 0; i < 2; i++) {
    const x = (rand() < 0.5 ? -1 : 1) * rr(6.8, 7.6), d = rr(a + 2, b - 2);
    if (cyFree(x, d, 0.25)) { rock(x, d, 0.2, -0.05, 0.16, P.rock); rock(x + 0.03, d, 0.13, 0.1, 0.12, P.rockD); }
  }
  // relay station on the right rim (where the plateau is widest), a stone watchtower ruin on the
  // left, a downed helicopter
  if (k === 15) {
    let bd = 606, be = 0;
    for (let d = 606; d < 634; d += 2) { const e = cyMesaEdge(d, 1); if (e > be) { be = e; bd = d; } }
    relayStation(ch, be - 1.05, bd);
  }
  if (k === 17) watchRuin(-7.6, 706);
  if (k === 18 && cyFree(-7.9, 752, 1.15)) { frame(-7.9, 752, 2.3); flat(-0.8, -1.0, 0.8, 1.0, L_BASE + 0.004, CP.burnt, 0.7); frameId(); heli(-7.9, 752, 2.3, CP.camoD); }
}
function relayStation(ch, x, d) {
  if (!cyFree(x, d, 0.9)) return;
  adobe(x + 0.3, d, 0.9, 1.1, 0.5, 0, jit(CP.adobeL, 0.05, TC2));
  const mx = x - 0.45, md = d + 1.2;
  box(mx - 0.04, md - 0.04, mx + 0.04, md + 0.04, 0, 3.3, P.metal, P.metal);
  for (let y = 0.8; y < 3.2; y += 0.8) box(mx - 0.18, md - 0.02, mx + 0.18, md + 0.02, y, y + 0.05, P.metal, P.metal);
  shadowBox(mx - 0.04, md - 0.04, mx + 0.04, md + 0.04, 3.3);
  addSpinner(ch, 0, x + 0.3, GROUND_Y + 0.58, d, 1.1);
  sandbags(x + 0.3, d - 1.0, 0, 1.3);
}
function watchRuin(x, d) {
  if (!cyFree(x, d, 0.8)) return;
  frameId();
  box(x - 0.55, d - 0.55, x + 0.55, d + 0.55, 0, 1.2, CP.adobeD, CP.adobe);
  box(x - 0.55, d - 0.55, x + 0.1, d + 0.55, 1.2, 1.55, CP.adobeD, CP.adobe);           // broken top
  box(x - 0.1, d - 0.57, x + 0.1, d - 0.53, 0.5, 0.8, CP.dark, CP.dark);
  shadowBox(x - 0.55, d - 0.55, x + 0.55, d + 0.55, 1.3);
  for (let i = 0; i < 4; i++) boulder(x + rr(-1, 1), d + rr(-1.2, 1.2), rr(0.12, 0.22), 0);
}

// refinery 780–1000: pipe corridors in both lane gaps, process lots on the flanks (per chunk:
// [left-lower, left-upper, right-lower, right-upper] like the airbase plan)
const REF_PLAN = {
  19: [null, 'terminal', null, 'gate'],
  20: ['tanks', 'columns', 'spheres', 'tanks'],
  21: ['cooling', 'unit', 'tanks', 'flare'],
  22: ['unit', 'tanks', 'columns', 'spheres'],
  23: ['tanks', 'flare', 'unit', 'cooling'],
  24: ['spheres', 'loading', 'tanks', 'unit'],
};
function cyRefinery(ch, k, d0, d1) {
  const cr = d0 + 20;
  const a = Math.max(d0, CY_REF), b = Math.min(d1, CY_FORT);
  // pipes on sleepers in the lane gaps, diving under the cross road (valves at the road ends and
  // where the pipes stop before the fortress)
  if (cr > a) refPipes(a, cr - 2.0, false, true);
  if (cr + 2.0 < b) refPipes(cr + 2.0, b, true, b >= CY_FORT);
  const plan = REF_PLAN[k] || [];
  for (let hi = 0; hi < 2; hi++) {
    const la = hi ? cr + 2.0 : d0 + 1.2, lb = hi ? d1 - 1.2 : cr - 2.0;
    if (la < CY_REF || lb > CY_FORT) continue;
    for (const side of [-1, 1]) { const kind = plan[(side < 0 ? 0 : 2) + hi]; if (kind) refLot(ch, kind, side, la, lb); }
  }
}
const REF_PIPES = [[1.72, 0.12, 0.27], [2.3, 0.09, 0.22], [3.02, 0.15, 0.3], [3.72, 0.08, 0.2]];   // x, r, centre height
function refPipes(a, b, valveA, valveB) {
  if (b - a < 1) return;
  frameId();
  const cols = [CP.pipeG, CP.pipeY, CP.steel, CP.pipeR];
  for (const side of [-1, 1]) {
    for (let d = Math.ceil(a / 2.2) * 2.2 + 0.4; d < b - 0.3; d += 2.2) box(side < 0 ? -4.0 : 1.45, d - 0.12, side < 0 ? -1.45 : 4.0, d + 0.12, 0, 0.1, P.concreteD, P.concrete);
    for (let i = 0; i < REF_PIPES.length; i++) {
      const [px, r, y] = REF_PIPES[i];
      if (LOWQ && i === 3) continue;
      pipeD(side * px, a, b, y, r, cols[i], LOWQ ? 5 : 6);
    }
    shadowBox(side < 0 ? -3.87 : 1.6, a, side < 0 ? -1.6 : 3.87, b, 0.34);
    // valve stations where the pipes dive under the road
    for (const e of [valveA ? a + 0.35 : NaN, valveB ? b - 0.35 : NaN]) {
      if (e !== e) continue;
      box(side * 2.1 - 0.34, e - 0.22, side * 2.1 + 0.34, e + 0.22, 0, 0.42, CP.pipeY, P.metalD);
      if (!LOWQ) disc(side * 2.1, e, 0.14, 0.14, 0.44, CP.pipeR, 8);
    }
  }
}
function storageTank(x, d, r, h, c, floating) {
  const segs = LOWQ ? 10 : 14;
  if (floating) {
    cyl(x, d, r, 0, h, segs, c, c, false);
    disc(x, d, r * 0.97, r * 0.97, h - 0.22, CP.steel, segs, 0.92);           // floating roof inside the shell
    disc(x, d, r * 0.18, r * 0.18, h - 0.215, CP.steelD, 8);
    ring(x, d, r * 0.97, r * 0.97, 0.05, h + 0.003, tint(c, P.white, 0.3, TC3), segs);
  } else {
    cyl(x, d, r, 0, h, segs, c, tint(c, P.white, 0.2, TC3));
    if (!LOWQ) ring(x, d, r * 0.62, r * 0.62, 0.04, h + 0.008, CP.steel, 12);
    disc(x, d, r * 0.2, r * 0.2, h + 0.01, CP.steelD, 8);
  }
  frameId();
  box(x + r * 0.62, d - r * 0.7 - 0.12, x + r * 0.62 + 0.14, d - r * 0.7 + 0.12, 0, h, CP.steelD, CP.steel);   // stair tower
  shadowDisc(x, d, r * 0.96, h);
}
function sphereTank(x, d, r, c) {
  const yc = r + 0.32;
  frame(x, d, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3, lx = Math.cos(a) * r * 0.8, ld = Math.sin(a) * r * 0.8;
    box(lx - 0.05, ld - 0.05, lx + 0.05, ld + 0.05, 0, yc, CP.steelD, CP.steelD);
  }
  LR[0] = 0; LH[0] = yc - r; LK[0] = 0.6;
  LR[1] = r * 0.71; LH[1] = yc - r * 0.71; LK[1] = 0.74;
  LR[2] = r; LH[2] = yc; LK[2] = 0.9;
  LR[3] = r * 0.71; LH[3] = yc + r * 0.71; LK[3] = 1.02;
  LR[4] = 0; LH[4] = yc + r; LK[4] = 1.1;
  lathe(0, 0, 5, LOWQ ? 8 : 12, c, 0);
  frameId();
  shadowDisc(x, d, r * 0.9, yc + r * 0.4);
}
function column(x, d, r, h, c) {
  cyl(x, d, r, 0, h, 8, c, CP.steel);
  for (let y = 0.75; y < h - 0.35; y += 0.85) ring(x, d, r, r, 0.14, y, CP.steelD, 10);
  cone(x, d, r * 1.02, h, h + r * 0.55, 8, CP.steel);
  shadowDisc(x, d, r, h);
}
function coolingTower(x, d, r, h) {
  frame(x, d, 0);
  LR[0] = r; LH[0] = 0; LK[0] = 0.8; LR[1] = r * 0.8; LH[1] = h * 0.45; LK[1] = 0.92;
  LR[2] = r * 0.66; LH[2] = h * 0.82; LK[2] = 1.0; LR[3] = r * 0.7; LH[3] = h; LK[3] = 1.04;
  lathe(0, 0, 4, LOWQ ? 12 : 16, jit(CP.pad, 0.04, TC3), 0);
  disc(0, 0, r * 0.69, r * 0.69, h - 0.04, CP.dark, LOWQ ? 12 : 16);        // the dark throat seen from above
  frameId();
  shadowDisc(x, d, r * 0.85, h);
}
function flareStack(x, d, h) {
  cyl(x, d, 0.1, 0, h, 6, CP.steel, CP.burnt);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4, lx = x + Math.cos(a) * 0.3, ld = d + Math.sin(a) * 0.3;
    box(lx - 0.035, ld - 0.035, lx + 0.035, ld + 0.035, 0, h * 0.82, CP.pipeR, CP.pipeR);
  }
  ring(x, d, 0.14, 0.14, 0.24, h * 0.42, CP.steelD, 8); ring(x, d, 0.14, 0.14, 0.24, h * 0.82, CP.steelD, 8);
  // the flame: a tongue of the brightest vertex colour (it catches the bloom on HIGH)
  frame(x, d, 0);
  LR[0] = 0.1; LH[0] = h; LK[0] = 1.0; LR[1] = 0.19; LH[1] = h + 0.1; LK[1] = 1.2; LR[2] = 0; LH[2] = h + 0.34; LK[2] = 1.25;
  lathe(0, 0, 3, 6, CP.flame, 0, 1.3, 1, 0.3);
  frameId();
  shadowDisc(x, d, 0.3, h * 0.85);
}
function tankerTruck(x, d, rot) {
  frame(x, d, rot);
  plain();
  box(-0.2, 0.52, 0.2, 0.86, 0, 0.3, CP.tankW, P.glass);
  box(-0.18, -0.9, 0.18, 0.5, 0.04, 0.12, P.hullDark, P.hullDark);
  pipeD(0, -0.9, 0.46, 0.3, 0.19, CP.tankS, 6);
  shadowBox(-0.2, -0.9, 0.2, 0.86, 0.45);
  frameId();
}
// one refinery lot: side ±1, stage range [a, b]; content packed into |x| ∈ [7.2, 17] (on screen first)
function refLot(ch, kind, side, a, b) {
  const x0 = side < 0 ? -20 : 7.2, x1 = side < 0 ? -7.2 : 20, inner = side < 0 ? x1 : x0;
  const X = (o) => inner + side * o, cd = (a + b) / 2;
  const lo = (p, q) => Math.min(X(p), X(q)), hi = (p, q) => Math.max(X(p), X(q));
  frameId();
  setTile(T_SLAB); uvMode(2.5, 2.5);
  flat(x0, a, x1, b, L_BASE + 0.002, CP.pad);
  setTile(0); uvMode(0, 0);
  flat(lo(0, 0.15), a, hi(0, 0.15), b, L_WALK, P.yellow, 0.8);                // kerb line along the lane
  switch (kind) {
    case 'tanks': {
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        const r = rr(1.35, 1.55), x = X(1.95 + j * 3.55), d = cd + (i ? 3.9 : -3.9);
        const c = pick([CP.tankW, CP.tankW, CP.tankS, CP.tankR]);
        storageTank(x, d, r, rr(0.85, 1.25), jit(c, 0.04, TC2), rand() < 0.4);
      }
      // bund wall round the farm
      const bx0 = lo(0.2, 7.3), bx1 = hi(0.2, 7.3);
      box(bx0, a + 0.2, bx1, a + 0.32, 0, 0.14, CP.padD, CP.pad); box(bx0, b - 0.32, bx1, b - 0.2, 0, 0.14, CP.padD, CP.pad);
      box(bx0, a + 0.32, bx0 + 0.12, b - 0.32, 0, 0.14, CP.padD, CP.pad); box(bx1 - 0.12, a + 0.32, bx1, b - 0.32, 0, 0.14, CP.padD, CP.pad);
      break;
    }
    case 'spheres': {
      for (let i = 0; i < 3; i++) sphereTank(X(i === 1 ? 4.4 : 1.75), cd + (i - 1) * 4.6, rr(0.95, 1.05), jit(CP.tankW, 0.03, TC2));
      frameId();
      pipeD(X(3.1), cd - 6, cd + 6, 0.25, 0.1, CP.pipeY, 6);
      break;
    }
    case 'columns': {
      for (let i = 0; i < 3; i++) column(X(1.3 + i * 1.3), cd - 4.2 + (i % 2) * 0.9, rr(0.3, 0.44), rr(2.6, 3.5), jit(CP.tankS, 0.05, TC2));
      processUnit(lo(0.6, 5.8), hi(0.6, 5.8), cd + 0.4, cd + 6.6);
      frameId();
      box(lo(6.3, 7.8), cd - 6, hi(6.3, 7.8), cd - 3.6, 0, 0.9, CP.rust, CP.steelD);                // fired heater
      cyl(X(7.05), cd - 4.8, 0.2, 0.9, 3.6, 8, CP.steelD, CP.burnt);
      shadowBox(lo(6.3, 7.8), cd - 6, hi(6.3, 7.8), cd - 3.6, 0.9); shadowDisc(X(7.05), cd - 4.8, 0.2, 3.6);
      break;
    }
    case 'unit': {
      processUnit(lo(0.6, 6.4), hi(0.6, 6.4), cd - 6.4, cd + 1.6);
      for (let i = 0; i < 2; i++) column(X(1.6 + i * 3.2), cd + 4.8, rr(0.34, 0.42), rr(2.2, 3.0), jit(CP.tankW, 0.04, TC2));
      break;
    }
    case 'flare': {
      flareStack(X(3.6), cd + 1.5, 3.72);
      frameId();
      disc(X(3.6), cd + 1.5, 1.5, 1.5, L_BASE + 0.005, CP.burnt, 12, 0.8);      // scorched pad
      frame(X(2.0), cd - 4.2, Math.PI / 2); pipeD(0, -1.2, 1.2, 0.42, 0.34, CP.tankS, 8); frameId();   // knockout drum
      box(lo(1.2, 2.8), cd - 4.5, hi(1.2, 2.8), cd - 3.9, 0, 0.1, CP.padD, CP.padD);
      shadowBox(lo(0.8, 3.2), cd - 4.55, hi(0.8, 3.2), cd - 3.85, 0.76);
      break;
    }
    case 'cooling': {
      coolingTower(X(2.9), cd - 1.5, 1.85, 2.5);
      frameId();
      box(lo(0.5, 2.2), cd + 4.2, hi(0.5, 2.2), cd + 6.4, 0, 0.55, P.wallB, P.roofTar);                // pump house
      shadowBox(lo(0.5, 2.2), cd + 4.2, hi(0.5, 2.2), cd + 6.4, 0.55);
      pipeD(X(3.4), cd + 1.0, cd + 5.8, 0.22, 0.13, CP.pipeG, 6);
      break;
    }
    case 'loading': {
      const cx0 = lo(0.8, 6.2), cx1 = hi(0.8, 6.2);
      for (const x of [cx0 + 0.1, cx1 - 0.1]) for (const d of [cd - 4, cd, cd + 4]) box(x - 0.06, d - 0.06, x + 0.06, d + 0.06, 0, 1.05, CP.steel, CP.steel);
      box(cx0, cd - 4.6, cx1, cd + 4.6, 1.05, 1.14, CP.steelD, jit(CP.tankW, 0.04, TC2));             // canopy
      shadowBox(cx0, cd - 4.6, cx1, cd + 4.6, 1.14);
      for (let i = 0; i < 3; i++) tankerTruck(X(1.9 + (i % 2) * 2.4), cd - 3 + i * 3, side < 0 ? 0 : Math.PI);
      break;
    }
    case 'terminal': {
      // where the crude line from the desert ends: pig launcher, manifold, valves
      frameId();
      box(lo(0.3, 3.4), a + 2.2, hi(0.3, 3.4), a + 5.4, 0, 0.12, CP.padD, CP.pad);
      frame(X(1.8), a + 3.8, Math.PI / 2); pipeD(0, -1.3, 1.3, 0.5, 0.26, CP.pipeG, 7); frameId();
      for (let i = 0; i < 4; i++) box(X(0.9 + i * 0.6) - 0.12, a + 6.2, X(0.9 + i * 0.6) + 0.12, a + 6.5, 0, 0.55, CP.pipeY, CP.pipeR);
      storageTank(X(5.0), cd + 1.5, 1.5, 1.1, jit(CP.tankR, 0.04, TC2), false);
      break;
    }
    case 'gate': {
      // perimeter fence, a gatehouse and the refinery sign facing the road
      frameId();
      for (let d = a + 0.3; d < b - 0.2; d += 1.2) box(X(0.35) - 0.03, d - 0.03, X(0.35) + 0.03, d + 0.03, 0, 0.5, P.metalD, P.metalD);
      wire(X(0.35), a + 0.3, 0.46, X(0.35), b - 0.2, 0.46, 0.015, P.metalD);
      adobe(X(1.4), a + 3.2, 1.1, 1.3, 0.48, 0, jit(P.wallB, 0.05, TC2));
      for (const d of [cd + 1.2, cd + 3.8]) box(X(3.2) - 0.05, d - 0.05, X(3.2) + 0.05, d + 0.05, 0, 1.3, P.metalD, P.metalD);
      box(X(3.2) - 0.06, cd + 1.0, X(3.2) + 0.06, cd + 4.0, 1.3, 2.1, CP.pipeR, CP.tankW);               // sign board
      shadowBox(X(3.2) - 0.06, cd + 1.0, X(3.2) + 0.06, cd + 4.0, 2.1);
      for (let i = 0; i < 3; i++) tankerTruck(X(5.2), cd - 5 + i * 1.6, Math.PI / 2 * side);
      break;
    }
  }
  frameId();
}
// open steel structure: a grid of posts, a grating deck and a partial upper deck, drums on top
function processUnit(x0, x1, a, b) {
  frameId();
  const w = x1 - x0, l = b - a;
  for (let i = 0; i <= 3; i++) for (let j = 0; j <= 4; j++) {
    const x = x0 + (w * i) / 3, d = a + (l * j) / 4;
    box(x - 0.05, d - 0.05, x + 0.05, d + 0.05, 0, 1.9, CP.steelD, CP.steelD);
  }
  topStyle(T_GRAVEL, 0.5, 0.5);
  box(x0, a, x1, b, 1.0, 1.06, CP.steelD, CP.steel);
  box(x0 + w * 0.34, a, x1, a + l * 0.62, 1.86, 1.92, CP.steelD, CP.steel);
  plain();
  for (let i = 0; i < 3; i++) cyl(x0 + w * (0.18 + i * 0.3), a + l * 0.82, 0.24, 1.06, 1.06 + rr(0.9, 1.6), 8, jit(CP.tankS, 0.05, TC2), CP.steel);
  frame(x0 + w * 0.62, a + l * 0.3, Math.PI / 2); pipeD(0, -w * 0.28, w * 0.28, 2.1, 0.18, CP.tankW, 7); frameId();
  cyl(x0 + w * 0.12, a + l * 0.2, 0.14, 1.92, 3.4, 6, CP.steelD, CP.burnt);                             // vent stack
  shadowBox(x0, a, x1, b, 1.4);
  shadowDisc(x0 + w * 0.12, a + l * 0.2, 0.14, 3.4);
}

// desert fortress 1000–1240: crenellated mud-brick walls (gates at the lanes, gaps at the cross
// roads), the airstrip down lane 0, revetments, hangars, flak and missile sites on the flanks
const FORT_FRONT = 1007, FORT_REAR = 1233, FORT_SIDE = 14;
const FORT_PLAN = {
  25: [null, 'barracks', null, 'motorpool'],
  26: ['tower', 'revet', 'hangar', 'aa'],
  27: ['radar', 'revet', 'revet', 'sam'],
  28: ['fuel', 'hangar', 'aa', 'revet'],
  29: ['revet', 'tents', 'hangar', 'radar'],
  30: ['aa', null, 'fuel', null],
};
function cyFortress(ch, k, d0, d1) {
  const cr = d0 + 20;
  if (d0 <= FORT_FRONT && d1 > FORT_FRONT) { fortGateWall(FORT_FRONT, -1); fortOuter(Math.max(d0, CY_FORT) + 0.6, FORT_FRONT - 1.2); }
  if (d0 <= FORT_REAR && d1 > FORT_REAR) fortGateWall(FORT_REAR, 1);
  for (const side of [-1, 1]) {
    const a = Math.max(d0, FORT_FRONT), b = Math.min(d1, FORT_REAR);
    if (b <= a) continue;
    if (cr > a && cr < b) {
      fortWallD(side, a, cr - 1.75); fortWallD(side, cr + 1.75, b);
      fortTower(side * FORT_SIDE, cr - 2.35, 0.5, 1.15); fortTower(side * FORT_SIDE, cr + 2.35, 0.5, 1.15);
    } else fortWallD(side, a, b);
  }
  const plan = FORT_PLAN[k] || [];
  for (let hi = 0; hi < 2; hi++) {
    const la = hi ? cr + 2.0 : d0 + 1.2, lb = hi ? d1 - 1.2 : cr - 2.0;
    if (la < FORT_FRONT + 1 || lb > FORT_REAR - 1) continue;
    for (const side of [-1, 1]) { const kind = plan[(side < 0 ? 0 : 2) + hi]; if (kind) fortLot(ch, kind, side, la, lb); }
  }
}
const FORT_H = 0.78;
// wall along x at d; merlons on the outer face (out = −1: toward −d, +1: toward +d)
function fortWallX(x0, x1, d, out) {
  if (x1 - x0 < 0.2) return;
  frameId(); plain();
  box(x0, d - 0.3, x1, d + 0.3, 0, FORT_H, CP.adobeD, CP.adobe);
  const m0 = out < 0 ? d - 0.3 : d + 0.1, m1 = m0 + 0.2, step = LOWQ ? 1.1 : 0.55;
  for (let x = x0 + 0.1; x < x1 - 0.2; x += step) box(x, m0, x + 0.27, m1, FORT_H, FORT_H + 0.17, CP.adobeD, CP.adobeL);
  shadowBox(x0, d - 0.3, x1, d + 0.3, FORT_H + 0.08);
}
// wall along d at x = side·14, merlons outside
function fortWallD(side, a, b) {
  if (b - a < 0.2) return;
  frameId(); plain();
  const x = side * FORT_SIDE;
  box(x - 0.3, a, x + 0.3, b, 0, FORT_H, CP.adobeD, CP.adobe);
  const m0 = side < 0 ? x - 0.3 : x + 0.1, step = LOWQ ? 1.1 : 0.55;
  for (let d = a + 0.1; d < b - 0.2; d += step) box(m0, d, m0 + 0.2, d + 0.27, FORT_H, FORT_H + 0.17, CP.adobeD, CP.adobeL);
  shadowBox(x - 0.3, a, x + 0.3, b, FORT_H + 0.08);
}
function fortTower(x, d, s, h) {
  frameId(); plain();
  box(x - s, d - s, x + s, d + s, 0, h, CP.adobeD, CP.adobe);
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(x + cx * s - (cx > 0 ? 0.22 : 0), d + cz * s - (cz > 0 ? 0.22 : 0), x + cx * s + (cx < 0 ? 0.22 : 0), d + cz * s + (cz < 0 ? 0.22 : 0), h, h + 0.2, CP.adobeD, CP.adobeL);
  box(x - 0.07, d - s - 0.02, x + 0.07, d - s + 0.02, h * 0.45, h * 0.75, CP.dark, CP.dark);    // arrow slit
  shadowBox(x - s, d - s, x + s, d + s, h + 0.1);
}
// a wall across the stage with gates at the three lanes (towers either side) and corner towers
function fortGateWall(d, out) {
  const segs = [[-FORT_SIDE, -6.8], [-4.2, -1.3], [1.3, 4.2], [6.8, FORT_SIDE]];
  for (const [x0, x1] of segs) fortWallX(x0, x1, d, out);
  for (let i = 0; i < 3; i++) {
    const lx = LANES_X[i];
    fortTower(lx - 1.75, d, 0.45, 1.3); fortTower(lx + 1.75, d, 0.45, 1.3);
    frameId(); flat(lx - 1.1, d - 0.6, lx + 1.1, d + 0.6, L_ROAD + 0.002, P.concreteD);          // gate sill
  }
  fortTower(-FORT_SIDE, d, 0.7, 1.5); fortTower(FORT_SIDE, d, 0.7, 1.5);
}
// the approach: anti-tank ditch (flat) and steel hedgehogs in the lane gaps and on the flanks
function fortOuter(a, b) {
  if (b <= a) return;
  frameId();
  const dd = (a + b) / 2;
  for (const [x0, x1] of [[-16, -6.6], [-4.4, -1.1], [1.1, 4.4], [6.6, 16]]) flat(x0, dd - 0.35, x1, dd + 0.35, L_ROAD, CP.dark, 0.9);
  for (const d of [a + 0.2, b - 0.2]) for (const x of [-12.4, -11, -9.6, -8.2, -3.4, -2.1, 2.1, 3.4, 8.2, 9.6, 11, 12.4]) {
    const hx = x + rr(-0.2, 0.2);
    if (!canPlace(hx, d, 0.35)) continue;
    frame(hx, d, rand() * TAU);
    box(-0.3, -0.035, 0.3, 0.035, 0, 0.3, P.hullDark, P.metalD); box(-0.035, -0.3, 0.035, 0.3, 0, 0.3, P.hullDark, P.metalD);
    frameId();
  }
}
function armyTruck(x, d, rot) {
  frame(x, d, rot);
  plain();
  box(-0.2, 0.34, 0.2, 0.62, 0, 0.28, CP.camoD, CP.camo);
  box(-0.22, -0.6, 0.22, 0.3, 0.04, 0.16, CP.camoD, CP.camoD);
  gable(-0.23, -0.6, 0.23, 0.26, 0.16, 0.16, jit(CP.tent, 0.08, TC3), true);
  shadowBox(-0.22, -0.6, 0.22, 0.62, 0.32);
  frameId();
}
function revetment(x, d, side) {
  // sandbagged earth walls on three sides, open toward the taxiway, a desert-camo jet inside
  frameId();
  const w = 2.2, l = 2.5, far = x + side * w / 2;
  box(Math.min(far, far + side * 0.32), d - l / 2 - 0.3, Math.max(far, far + side * 0.32), d + l / 2 + 0.3, 0, 0.42, CP.sandbag, CP.camo);
  box(x - w / 2, d - l / 2 - 0.3, x + w / 2, d - l / 2, 0, 0.36, CP.sandbag, CP.camo);
  box(x - w / 2, d + l / 2, x + w / 2, d + l / 2 + 0.3, 0, 0.36, CP.sandbag, CP.camo);
  shadowBox(x - w / 2, d - l / 2 - 0.3, x + w / 2, d + l / 2 + 0.3, 0.3);
  jet(x - side * 0.05, d, side > 0 ? Math.PI / 2 : -Math.PI / 2, jit(CP.camo, 0.06, TC2), 0.95);
}
function aaPit(x, d, rot) {
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue;                                                        // the entrance
    const a = (i / 9) * TAU;
    frame(x + Math.cos(a) * 0.85, d + Math.sin(a) * 0.85, a + Math.PI / 2);
    box(-0.27, -0.12, 0.27, 0.12, 0, 0.22, CP.sandbag, jit(CP.sandbag, 0.06, TC3));
  }
  frame(x, d, rot);
  box(-0.22, -0.22, 0.22, 0.22, 0, 0.26, CP.camoD, CP.camo);
  box(-0.1, 0.1, -0.05, 0.86, 0.26, 0.32, P.hullDark, P.hullDark);
  box(0.05, 0.1, 0.1, 0.86, 0.26, 0.32, P.hullDark, P.hullDark);
  frameId();
  shadowDisc(x, d, 0.3, 0.32);
}
function samLauncher(x, d, rot) {
  frame(x, d, rot);
  plain();
  box(-0.22, -0.7, 0.22, 0.5, 0, 0.2, CP.camoD, CP.camo);
  box(-0.2, 0.5, 0.2, 0.8, 0, 0.3, CP.camoD, P.glass);
  for (const s of [-0.1, 0.1]) box(s - 0.07, -0.78, s + 0.07, 0.36, 0.22, 0.37, P.metal, CP.tankW);
  shadowBox(-0.22, -0.78, 0.22, 0.8, 0.37);
  frameId();
}
function bladder(x, d, sx, sd) {
  frame(x, d, 0);
  LR[0] = 1; LH[0] = 0; LK[0] = 0.72; LR[1] = 0.92; LH[1] = 0.14; LK[1] = 0.95; LR[2] = 0.5; LH[2] = 0.22; LK[2] = 1.05; LR[3] = 0; LH[3] = 0.24; LK[3] = 1.1;
  lathe(0, 0, 4, 10, P.hullDark, 0, sx, sd);
  frameId();
}
// one fortress lot: side ±1, stage range [a, b]; |x| ∈ [7.2, 13.4] (inside the side wall)
function fortLot(ch, kind, side, a, b) {
  const inner = side < 0 ? -7.2 : 7.2;
  const X = (o) => inner + side * o, cd = (a + b) / 2;
  const lo = (p, q) => Math.min(X(p), X(q)), hi = (p, q) => Math.max(X(p), X(q));
  frameId();
  switch (kind) {
    case 'revet': {
      setTile(T_SLAB); uvMode(2.5, 2.5); flat(lo(0, 3.6), a + 0.4, hi(0, 3.6), b - 0.4, L_BASE + 0.002, P.concrete); setTile(0); uvMode(0, 0);
      revetment(X(1.75), cd - 4.0, side); revetment(X(1.75), cd + 4.0, side);
      armyTruck(X(4.8), cd, 0.2);
      break;
    }
    case 'hangar': {
      setTile(T_SLAB); uvMode(2.5, 2.5); flat(lo(0, 5.8), a + 0.4, hi(0, 5.8), b - 0.4, L_BASE + 0.002, P.concrete); setTile(0); uvMode(0, 0);
      hangar(X(3.0), cd + 1.8, side);
      jet(X(2.4), cd - 4.6, side > 0 ? Math.PI / 2 + 0.4 : -Math.PI / 2 - 0.4, jit(CP.camo, 0.05, TC2), 1.0);
      break;
    }
    case 'aa': {
      aaPit(X(1.6), cd - 3.6, rr(0, TAU)); aaPit(X(4.3), cd + 2.9, rr(0, TAU));
      crates(X(4.4), cd - 4.6, 0.3, 6); sandbags(X(2.8), cd + 6.4, 0, 2.2);
      break;
    }
    case 'sam': {
      for (let i = 0; i < 3; i++) samLauncher(X(1.7 + (i % 2) * 2.2), cd - 4.8 + i * 3.6, side > 0 ? 0.35 : -0.35);
      box(lo(4.6, 5.8), cd + 3.4, hi(4.6, 5.8), cd + 5.4, 0, 0.42, CP.camoD, CP.camo);
      shadowBox(lo(4.6, 5.8), cd + 3.4, hi(4.6, 5.8), cd + 5.4, 0.42);
      addSpinner(ch, 0, X(5.2), GROUND_Y + 0.42, cd + 4.4, 1.9);
      break;
    }
    case 'radar': {
      const rx = X(2.2), rd = cd - 3.2;
      box(rx - 0.8, rd - 0.7, rx + 0.8, rd + 0.7, 0, 0.55, CP.adobeD, CP.adobe);
      shadowBox(rx - 0.8, rd - 0.7, rx + 0.8, rd + 0.7, 0.55);
      addSpinner(ch, 0, rx, GROUND_Y + 0.55, rd, 1.4);
      const gx = X(3.4), gd = cd + 3.2;
      box(gx - 0.7, gd - 0.7, gx + 0.7, gd + 0.7, 0, 1.1, CP.adobeD, CP.adobe);
      LR[0] = 0.84; LH[0] = 1.1; LK[0] = 0.8; LR[1] = 0.8; LH[1] = 1.6; LK[1] = 0.95; LR[2] = 0.5; LH[2] = 2.0; LK[2] = 1.05; LR[3] = 0; LH[3] = 2.16; LK[3] = 1.12;
      frame(gx, gd, 0); lathe(0, 0, 4, 10, P.shipWhite, 0); frameId();
      shadowDisc(gx, gd, 0.8, 2.0);
      break;
    }
    case 'tower': {
      controlTower(ch, X(2.8), cd + 2.4);
      for (let i = 0; i < 6; i++) if (rand() < 0.75) armyTruck(X(1.0 + (i % 3) * 0.9), cd - 5.2 + ((i / 3) | 0) * 1.7, 0);
      frameId();
      box(X(5.0) - 0.03, cd - 4.0 - 0.03, X(5.0) + 0.03, cd - 4.0 + 0.03, 0, 1.2, P.metal, P.metal);       // windsock
      frame(X(5.0), cd - 3.97, 0.6); box(-0.06, 0, 0.06, 0.5, 1.02, 1.14, CP.pipeR, CP.tankW); frameId();
      break;
    }
    case 'barracks': {
      for (let i = 0; i < 3; i++) adobe(X(1.2 + i * 1.9), cd + rr(-0.4, 0.4), 1.3, 3.8, 0.55, 0, jit(CP.adobe, 0.05, TC2));
      frameId();
      box(X(0.6) - 0.03, cd + 6 - 0.03, X(0.6) + 0.03, cd + 6 + 0.03, 0, 1.8, P.metal, P.metal);         // flagpole
      box(X(0.6), cd + 5.97, X(0.6) + side * 0.5, cd + 6.03, 1.45, 1.78, CP.pipeR, CP.pipeR);
      break;
    }
    case 'motorpool': {
      frameId(); flat(lo(0.3, 5.9), a + 0.5, hi(0.3, 5.9), b - 0.5, L_ROAD, P.asphaltD);
      for (let i = 0; i < 10; i++) armyTruck(X(0.9 + (i % 5) * 1.0), cd + (i < 5 ? -3.2 : 0.4), 0);
      warehouse(lo(0.6, 5.6), cd + 3.6, hi(0.6, 5.6), cd + 7.6, 0.95);
      break;
    }
    case 'fuel': {
      box(lo(0.4, 5.6), a + 0.6, hi(0.4, 5.6), a + 0.9, 0, 0.3, CP.sandbag, CP.camo);                   // berm
      box(lo(0.4, 5.6), b - 0.9, hi(0.4, 5.6), b - 0.6, 0, 0.3, CP.sandbag, CP.camo);
      for (let i = 0; i < 4; i++) bladder(X(1.6 + (i % 2) * 2.6), cd + (i < 2 ? -3.4 : 2.6), 1.1, 2.0);
      tankerTruck(X(4.8), cd + 6.6, Math.PI / 2 * side);
      break;
    }
    case 'tents': {
      for (let i = 0; i < 6; i++) tent(X(1.1 + (i % 2) * 2.0), cd - 5 + ((i / 2) | 0) * 3.4, 0, 1.2, 1.9);
      drums(X(5.2), cd + 4, 6, CP.camoD);
      break;
    }
  }
  frameId();
}

// endless dry lakebed 1240+: the boss arena — flat mud-cracked clay and salt, the treads of
// something enormous, and very sparse props out beyond |x| 9.6
const crackX = (i, j, cs) => (i + (hash2(i, j + 7777) - 0.5) * 0.7) * cs;
const crackD = (i, j, cs) => (j + (hash2(i + 913, j) - 0.5) * 0.7) * cs;
function crackEdge(ax, ad, bx, bd, w, c, lay) {
  const L = Math.hypot(bx - ax, bd - ad) || 1, nx = -(bd - ad) / L * w, nd = (bx - ax) / L * w;
  flat4(ax - nx, ad - nd, bx - nx, bd - nd, bx + nx, bd + nd, ax + nx, ad + nd, lay, c, 0.92);
}
// the boss's own track gauge: BEHEMOTH runs 1.62-wide tracks at x = ±3.94 from its hull axis
const LAKE_TREAD_X = [-3.94, 3.94], LAKE_TREAD_W = 0.75;
function cyLake(ch, k, a, b) {
  frameId();
  // the treads of something enormous running on up the pan: two wide compacted bands with cleat
  // marks (stateless in d, so they run on across chunks). The line wanders ±2.2 about the arena
  // centre, where the boss sways, so the bands stay inside |x| < 7
  const tread = (d) => 1.6 * Math.sin(d * 0.021 + 0.8) + 0.6 * Math.sin(d * 0.057 + 2.0);
  const step = LOWQ ? 2 : 1;
  for (let d = a; d < b - 0.01; d += step) {
    const e = Math.min(b, d + step), xa = tread(d), xb = tread(e);
    for (const o of LAKE_TREAD_X) crackEdge(xa + o, d, xb + o, e, LAKE_TREAD_W, CP.tread, L_ROAD);
  }
  if (!LOWQ) for (let d = Math.ceil(a / 0.75) * 0.75; d < b - 0.2; d += 0.75) {
    const xc = tread(d + 0.08);
    for (const o of LAKE_TREAD_X) flat(xc + o - 0.66, d, xc + o + 0.66, d + 0.18, L_WALK, CP.crack, 0.95);
  }
  // hollows of polygonal mud cracks (a jittered lattice clipped to a disc), low contrast
  for (let p = 0, np = LOWQ ? 1 : 2 + ((rand() * 2) | 0); p < np; p++) {
    const cx = rr(-14, 14), cd = rr(a + 4, b - 4), R = rr(2.4, 4.4), cs = 1.25, sj = k * 17 + p * 31;
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
      const px = cx + crackX(i, j + sj, cs), pd = cd + crackD(i, j + sj, cs);
      if (Math.hypot(px - cx, (pd - cd) / 0.9) > R) continue;
      for (let e = 0; e < 2; e++) {
        const qx = cx + crackX(i + 1 - e, j + e + sj, cs), qd = cd + crackD(i + 1 - e, j + e + sj, cs);
        if (Math.hypot(qx - cx, (qd - cd) / 0.9) <= R) crackEdge(px, pd, qx, qd, 0.028, CP.crack, L_BASE + 0.005);
      }
    }
  }
  // very sparse props, never inside the arena
  for (const side of [-1, 1]) {
    if (rand() < 0.45) {
      const x = side * rr(9.9, 15), d = rr(a + 2, b - 2);
      if (canPlace(x, d, 0.8)) { boulder(x, d, rr(0.3, 0.65), 0); if (rand() < 0.6) boulder(x + rr(-0.8, 0.8), d + rr(-0.8, 0.8), rr(0.14, 0.28), 0); }
    }
  }
  const r = rand(), side = rand() < 0.5 ? -1 : 1;
  const x = side * rr(10.6, 13), d = rr(a + 5, b - 5);
  if (r < 0.14) { if (canPlace(x, d, 1.8)) wreckJet(x, d, rr(0, TAU), 1.2); }
  else if (r < 0.3) { if (canPlace(x, d, 1.0)) wreckTruck(x, d, rr(0, TAU)); }
  else if (r < 0.42) { if (canPlace(x, d, 0.5)) deadTree(x, d, rr(0.6, 0.9)); }
  else if (r < 0.5) { if (canPlace(x, d, 0.6)) drums(x, d, 4); }
}

// dusty desert light: a warm morning, a bleached noon over the canyon, refinery haze, a copper
// afternoon at the fortress, and a violet dusk over the lakebed (cool fill keeps the pale clay from
// turning the same orange as the enemy bullets)
const CANYON_TOD_SRC = [
  { d: -60, sun: 0xffd6a6, sunI: 2.2, sky: 0xbccce2, gnd: 0x6a4c34, hemiI: 1.0, fog: 0xcfb592, near: 48, far: 152,
    cLit: 0xfff1e0, cShade: 0xb6a293, shadow: 0x3b2618, shA: 0.38, shK: 1.35, cloud: 0.8 },
  { d: 240, sun: 0xffe4c0, sunI: 2.3, sky: 0xbacce6, gnd: 0x684a32, hemiI: 1.0, fog: 0xd1b999, near: 52, far: 160,
    cLit: 0xfff6ea, cShade: 0xb2a39a, shadow: 0x3a2418, shA: 0.4, shK: 1.15, cloud: 0.7 },
  { d: 520, sun: 0xffefd8, sunI: 2.4, sky: 0xb6cbe6, gnd: 0x6c4e36, hemiI: 0.98, fog: 0xd0bea2, near: 56, far: 168,
    cLit: 0xfffaf2, cShade: 0xb4aaa4, shadow: 0x38221a, shA: 0.42, shK: 0.92, cloud: 0.6 },
  { d: 800, sun: 0xffe2c0, sunI: 2.25, sky: 0xc0c6d0, gnd: 0x664a3a, hemiI: 1.02, fog: 0xc2ab8f, near: 46, far: 150,
    cLit: 0xf5ece0, cShade: 0xa89c94, shadow: 0x34221c, shA: 0.38, shK: 1.0, cloud: 0.7 },
  { d: 1060, sun: 0xffc690, sunI: 2.2, sky: 0xb2b0c8, gnd: 0x644330, hemiI: 0.98, fog: 0xc79e80, near: 50, far: 158,
    cLit: 0xffe6cc, cShade: 0xa48e96, shadow: 0x391d1c, shA: 0.42, shK: 1.35, cloud: 0.65 },
  { d: 1275, sun: 0xffd2b8, sunI: 1.35, sky: 0x7088cc, gnd: 0x383a4c, hemiI: 1.36, fog: 0x5a6892, near: 52, far: 162,
    cLit: 0xffd6c2, cShade: 0x646c9a, shadow: 0x121630, shA: 0.46, shK: 1.6, cloud: 0.8 },
];
const CANYON_CLOUD = { dunes: 0.4, canyon: 0.3, mesa: 0.45, refinery: 0.5, fortress: 0.35, lakebed: 0.55 };

// =============================================================================
// SKY CITADEL (stage 3): no ground at all — a sunlit cloud sea (the deck shader at GROUND_Y) with
// gaps down to a lower layer, low clouds drifting above it, and towering cumulus framing the play
// area. Four lighting bands: bright stratosphere 0–420 · storm band 420–800 (lightning under the
// deck) · golden high altitude 800–1240 · near-space dusk 1240+ (boss arena).
// =============================================================================
const SKIES_LAYOUT = [
  { biome: 'stratosphere', from: 0,    to: 420 },
  { biome: 'storm',        from: 420,  to: 800 },
  { biome: 'golden',       from: 800,  to: 1240 },
  { biome: 'nearspace',    from: 1240, to: Infinity },
];
const SKY_LANE = { d0: -Infinity, d1: Infinity, x: 5 };   // no solid props here (the sky has none at all)
const SKY_GND = C(0xd8dde6);
// one soft cloud sprite (see World._placePuffs); y = height above the deck, sh > 0 = casts the
// tower's shadow from that height
function addPuff(ch, x, y, d, s, sq, a, v, yaw, sh) {
  if (ch.npuff >= PUFF_PER) return;
  const o = ch.npuff++ * 9, P = ch.puff;
  P[o] = x; P[o + 1] = y; P[o + 2] = d; P[o + 3] = s; P[o + 4] = sq; P[o + 5] = a; P[o + 6] = v; P[o + 7] = yaw; P[o + 8] = sh;
}
// a cumulus tower: a broad base sprite, then smaller billows stacked higher (perspective does
// the rest); the texture's baked light assumes the sun at screen lower-left, so yaw stays small
function puffTower(ch, x, d, s, h, a, layers) {
  const v0 = (rand() * 4) | 0;
  for (let i = 0; i < layers; i++) {
    const t = layers > 1 ? i / (layers - 1) : 0;
    addPuff(ch, x + rr(-0.12, 0.12) * s * t, 0.3 + t * h, d + rr(-0.12, 0.12) * s * t, s * (1 - 0.46 * t), rr(0.78, 1.0),
      a * (1 - 0.12 * t), (v0 + i) & 3, rr(-0.3, 0.3), i === 0 ? 0.3 + h * 0.55 : 0);
  }
}
// sky chunks hold no geometry at all: just cloud towers framing the play area, taller and
// denser in the storm band, sparse and low in near-space
function genSkies(w, ch, k, d0) {
  const d1 = d0 + CHUNK;
  styleReset();
  for (let s = 0; s < 2; s++) {
    const side = s ? 1 : -1;
    let d = d0 + rr(0, 10);
    while (d < d1) {
      const b = biomeOf(d);
      let sz, h, gap, a, layers;
      if (b === 'stratosphere') { sz = rr(6, 9); h = rr(1.4, 2.6); gap = rr(12, 20); a = 0.82; layers = 3; }
      else if (b === 'storm') { sz = rr(7.5, 11); h = rr(2.4, 3.4); gap = rr(9, 15); a = 0.92; layers = 4; }
      else if (b === 'golden') { sz = rr(5.5, 8.5); h = rr(1.2, 2.8); gap = rr(12, 22); a = 0.8; layers = 3; }
      else { sz = rr(4, 6.5); h = rr(0.4, 1.2); gap = rr(18, 32); a = 0.62; layers = 2; }
      if (LOWQ) layers = Math.max(2, layers - 1);
      const x = side * (SKY_LANE.x + 0.4 + sz * 0.42 + rr(0, 4.5));
      puffTower(ch, x, d, sz, h, a, layers);
      d += gap;
    }
  }
}
// (deck colours are kept below white: glowing bullets need something darker than themselves)
const SKIES_TOD_SRC = [
  { d: -60, sun: 0xfff6ea, sunI: 2.5, sky: 0xa6c6ee, gnd: 0xd4dce8, hemiI: 1.1, fog: 0x86acdc, near: 56, far: 176,
    cLit: 0xf6f8fc, cShade: 0xa6b6d0, shadow: 0x3f5886, shA: 0.22, shK: 1.2, cloud: 0.95,
    dLit: 0xd6dfec, dShade: 0x7a90b6, dAbyss: 0x21508c, dRim: 0xf2f6ff, cover: 0.7, flash: 0 },
  { d: 385, sun: 0xfff3e4, sunI: 2.45, sky: 0xa2c0ea, gnd: 0xcfd6e2, hemiI: 1.08, fog: 0x82a8d8, near: 54, far: 172,
    cLit: 0xf4f6fa, cShade: 0xa0b0ca, shadow: 0x3c5482, shA: 0.23, shK: 1.2, cloud: 0.95,
    dLit: 0xd2dbe8, dShade: 0x768cb2, dAbyss: 0x1d4884, dRim: 0xf0f4ff, cover: 0.74, flash: 0 },
  { d: 455, sun: 0xc9d2e2, sunI: 1.3, sky: 0x6c7690, gnd: 0x4c5466, hemiI: 0.95, fog: 0x565f74, near: 44, far: 142,
    cLit: 0xb4bccb, cShade: 0x566078, shadow: 0x161c2c, shA: 0.3, shK: 1.1, cloud: 1.0,
    dLit: 0x939cb0, dShade: 0x535c72, dAbyss: 0x0d1321, dRim: 0xb8c4d8, cover: 0.86, flash: 1 },
  { d: 765, sun: 0xcfd4e2, sunI: 1.35, sky: 0x707890, gnd: 0x505668, hemiI: 0.95, fog: 0x5a6276, near: 44, far: 142,
    cLit: 0xb6becc, cShade: 0x58627a, shadow: 0x161c2c, shA: 0.3, shK: 1.1, cloud: 1.0,
    dLit: 0x959eb2, dShade: 0x555e74, dAbyss: 0x0f1524, dRim: 0xbac6da, cover: 0.84, flash: 1 },
  { d: 835, sun: 0xffc47c, sunI: 2.4, sky: 0xbfaac6, gnd: 0xe2c6aa, hemiI: 1.0, fog: 0xcf9e7c, near: 50, far: 160,
    cLit: 0xffe2bc, cShade: 0xa48aa0, shadow: 0x42243e, shA: 0.28, shK: 1.4, cloud: 0.85,
    dLit: 0xecc79a, dShade: 0x866c8a, dAbyss: 0x31244c, dRim: 0xffe4c0, cover: 0.62, flash: 0 },
  { d: 1205, sun: 0xffb872, sunI: 2.3, sky: 0xb49fc4, gnd: 0xdcbca4, hemiI: 0.98, fog: 0xc69478, near: 50, far: 160,
    cLit: 0xffd8b4, cShade: 0x9c829a, shadow: 0x402240, shA: 0.29, shK: 1.45, cloud: 0.8,
    dLit: 0xe6bd92, dShade: 0x80668c, dAbyss: 0x2e2450, dRim: 0xffdcbc, cover: 0.6, flash: 0 },
  { d: 1275, sun: 0xff9e7e, sunI: 1.7, sky: 0x3c4280, gnd: 0x6e5e8e, hemiI: 0.9, fog: 0x252e62, near: 44, far: 150,
    cLit: 0xd4a4c0, cShade: 0x3a3d7a, shadow: 0x0a0e2c, shA: 0.32, shK: 1.6, cloud: 0.6,
    dLit: 0xa988b0, dShade: 0x55558c, dAbyss: 0x060a22, dRim: 0xf0a896, cover: 0.44, flash: 0 },
];
const SKIES_CLOUD = { stratosphere: 0.95, storm: 1.0, golden: 0.8, nearspace: 0.5 };

// =============================================================================
// stage table
// =============================================================================
function genCoastal(w, ch, k, d0) {
  if (k <= 6) genOcean(w, ch, k, d0);
  else if (k <= 9) genCoast(w, ch, k, d0);
  else if (k <= 15) genCountry(w, ch, k, d0);
  else if (k <= 23) genCity(w, ch, k, d0);
  else if (k <= 30) genBase(w, ch, k, d0);
}
// calm (inland) water: harbour basin, river, ponds, canal
function coastalCalm(x, d) {
  if (d > 400 && d < BASE_END - 1) return 1;
  if (d > 290 && d < HARBOR_D1 + 1 && x > HARBOR_X0 - 1) return 0.55 * sstep(shoreD(x) - 6, shoreD(x) + 6, d) * sstep(HARBOR_X0 - 1, HARBOR_X0 + 2.5, x);
  return 0;
}

// Every stage world: layout (biome ranges, shared with the stage timelines), salt (mixed into the
// per-chunk seeds), clear (lanes + cross roads guaranteed clear over [from, to)), corridors (mid-boss
// and boss paths, |x| < x over [d0, d1)), terrainH / groundColor (stateless), hasGround(k, d0),
// gen(world, chunk, k, d0), water (null = the stage never shows water), flatCheck (self-check
// terrain flatness in the clear zones), tod (time-of-day keys), cloud (low-cloud density per
// biome), cloudShadowK(biome), deck (show the cloud-sea deck).
export const WORLD_STAGES = {
  coastal: {
    id: 'coastal', layout: LAYOUT, salt: 0,
    clear: { from: CLEAR_FROM, to: CLEAR_TO }, corridors: [CRAWLER],
    terrainH: coastalH, groundColor: coastalColor,
    hasGround: (k, d0) => k <= 6 || (d0 + CHUNK > 280 && d0 < BASE_END + 6),
    gen: genCoastal,
    water: { seaFromK: 31, alwaysK: 6, calm: coastalCalm, open: (b) => b === 'ocean' || b === 'sea' },
    flatCheck: false,
    tod: makeTod(TOD_SRC), cloud: CLOUD_BIOME,
    cloudShadowK: (b) => (b === 'city' || b === 'ocean' || b === 'sea' ? 0.16 : 0.32),
    deck: false,
  },
  canyon: {
    id: 'canyon', layout: CANYON_LAYOUT, salt: 7654321,
    clear: { from: 260, to: CY_LAKE }, corridors: [CY_MIDBOSS, CY_ARENA],
    midboss: CY_MIDBOSS, arena: CY_ARENA,
    terrainH: canyonH, groundColor: canyonColor,
    hasGround: () => true,
    gen: genCanyon,
    water: null, flatCheck: true,
    tod: makeTod(CANYON_TOD_SRC), cloud: CANYON_CLOUD,
    cloudShadowK: () => 0.22,
    deck: false,
  },
  skies: {
    id: 'skies', layout: SKIES_LAYOUT, salt: 3141593,
    clear: { from: Infinity, to: -Infinity }, corridors: [SKY_LANE],    // no ground units in the sky
    terrainH: () => 0, groundColor: (x, d, h, out) => cset(out, SKY_GND),
    hasGround: () => false,
    gen: genSkies,
    water: null, flatCheck: false,
    tod: makeTod(SKIES_TOD_SRC), cloud: SKIES_CLOUD,
    cloudShadowK: () => 0.2,
    deck: true,
  },
};
// an unknown biome name would turn the low-cloud alpha into NaN (→ full opacity): check the tables
for (const id in WORLD_STAGES) {
  const st = WORLD_STAGES[id];
  for (const L of st.layout) if (!(st.cloud[L.biome] >= 0)) console.error(`[world] stage '${id}': no cloud density for biome '${L.biome}'`);
}
S = WORLD_STAGES.coastal;
