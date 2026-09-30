// defs.js — shared game data: aircraft, weapons, stages and money. No imports, no side effects,
// so every module (game, stages, models, ui, main) can read it without creating import cycles.

// --- money ------------------------------------------------------------------------------
// Earnings are counted during the run (so a continue, which zeroes the score, loses nothing)
// and banked into the wallet at results, game over, quit and page hide.
export const MONEY = {
  label: 'CR',
  perScore: 1 / 40,                  // every point scored is worth 1/40 CR
  stageClear: [0, 1500, 2500, 4000], // extra CR for clearing stage n (index = stage number)
};

// --- aircraft ------------------------------------------------------------------------------
// stats.* are the 1-5 bars shown in the hangar (hitbox: 5 = smallest = best).
export const AIRCRAFT = [
  {
    id: 'bolt', name: 'CRIMSON BOLT', zh: '赤電', price: 0, color: '#ff4a55', hex: 0xff4a55,
    speed: 13.5, slow: 6.5, hitR: 0.30, grazeR: 1.05, bombs: 3, bombCap: 5, dmg: 1.0, startLevel: 1, options: 0,
    desc: '均衡型主力機。速度、火力、炸彈都中規中矩，最容易上手。',
    stats: { speed: 3, power: 3, bombs: 3, hitbox: 3 },
  },
  {
    id: 'gale', name: 'GALE', zh: '疾風', price: 8000, color: '#46e0ff', hex: 0x46e0ff,
    speed: 16.5, slow: 7.2, hitR: 0.22, grazeR: 1.2, bombs: 2, bombCap: 4, dmg: 0.9, startLevel: 1, options: 0,
    desc: '高速攔截機。中彈判定最小、擦彈範圍最大，但火力稍弱、炸彈較少。',
    stats: { speed: 5, power: 2, bombs: 2, hitbox: 5 },
  },
  {
    id: 'titan', name: 'TITAN', zh: '重鎚', price: 15000, color: '#e8b24a', hex: 0xe8b24a,
    speed: 11.5, slow: 5.6, hitR: 0.36, grazeR: 0.95, bombs: 4, bombCap: 6, dmg: 1.3, startLevel: 2, options: 0,
    desc: '重裝攻擊機。火力最強、多帶一顆炸彈、開局火力 Lv2；代價是速度慢、判定大。',
    stats: { speed: 2, power: 5, bombs: 5, hitbox: 2 },
  },
  {
    id: 'phantom', name: 'PHANTOM', zh: '幻影', price: 30000, color: '#b98cff', hex: 0xb98cff,
    speed: 13.5, slow: 6.5, hitR: 0.28, grazeR: 1.05, bombs: 3, bombCap: 5, dmg: 0.95, startLevel: 1, options: 2,
    desc: '僚機指揮機。兩架小僚機跟隨射擊；按住慢速或集中鍵時僚機收攏、集中火力。',
    stats: { speed: 3, power: 4, bombs: 3, hitbox: 3 },
  },
];
export const AIRCRAFT_BY_ID = Object.fromEntries(AIRCRAFT.map((a) => [a.id, a]));
export const DEFAULT_AIRCRAFT = 'bolt';

// --- hangar shop: paints -----------------------------------------------------------------
// Per aircraft; index 0 ('std') is the free factory scheme. The models build every scheme
// (createPlayer(id, paint)); game.setAircraft(id, paint) swaps it in. UI swatch: `swatch` is
// [body, trim] (CSS, for a two-tone chip); `col` / `hex` is the scheme's accent (its glow; the same
// as the models' paint accent, and for 'std' the aircraft's own colour), which also tints the
// option drones' exhaust.
export const PAINTS = {
  bolt: [
    { id: 'std', zh: '赤電', price: 0, desc: '出廠塗裝。赤紅機身，白色閃電塗紋。', swatch: ['#c81f2a', '#e3e7ec'], col: '#ff4a55', hex: 0xff4a55 },
    { id: 'raven', zh: '夜鴉', price: 4000, desc: '消光黑機身，赤紅發光線條。', swatch: ['#1d1e23', '#ff2a3c'], col: '#ff2a3c', hex: 0xff2a3c },
    { id: 'egret', zh: '白鷺', price: 4000, desc: '純白機身，金色飾線。', swatch: ['#e2e2de', '#c9962f'], col: '#f1ead8', hex: 0xf1ead8 },
    { id: 'gold', zh: '黃金', price: 25000, desc: '全機鏡面黃金，散發暖光。', swatch: ['#d9a53a', '#fff0b8'], col: '#f0c75a', hex: 0xf0c75a },
  ],
  gale: [
    { id: 'std', zh: '冰藍', price: 0, desc: '出廠塗裝。珍珠白機身配冰藍飾色。', swatch: ['#eef4f8', '#2fb6de'], col: '#46e0ff', hex: 0x46e0ff },
    { id: 'dusk', zh: '黃昏', price: 5000, desc: '機首夕陽橘，漸層到機尾暮紫。', swatch: ['#e2601c', '#5a2f78'], col: '#ff8a3d', hex: 0xff8a3d },
    { id: 'ghost', zh: '幽靈', price: 5000, desc: '低可視度的深淺灰。', swatch: ['#a2a9b0', '#5f666f'], col: '#aab3bc', hex: 0xaab3bc },
    { id: 'gold', zh: '黃金', price: 25000, desc: '全機鏡面黃金，散發暖光。', swatch: ['#d9a53a', '#fff0b8'], col: '#f0c75a', hex: 0xf0c75a },
  ],
  titan: [
    { id: 'std', zh: '沙金', price: 0, desc: '出廠塗裝。槍灰機身配琥珀飾條。', swatch: ['#565d67', '#e8b24a'], col: '#e8b24a', hex: 0xe8b24a },
    { id: 'jungle', zh: '叢林', price: 6000, desc: '橄欖綠迷彩，卡其色標誌。', swatch: ['#5f6b3a', '#a89a62'], col: '#7f9a45', hex: 0x7f9a45 },
    { id: 'steel', zh: '鋼灰', price: 6000, desc: '深鋼灰機身，紅色條紋。', swatch: ['#353b43', '#cf2630'], col: '#e0303a', hex: 0xe0303a },
    { id: 'gold', zh: '黃金', price: 25000, desc: '全機鏡面黃金，散發暖光。', swatch: ['#d9a53a', '#fff0b8'], col: '#f0c75a', hex: 0xf0c75a },
  ],
  phantom: [
    { id: 'std', zh: '紫晶', price: 0, desc: '出廠塗裝。黑色機身，紫晶光邊。', swatch: ['#1d1728', '#b98cff'], col: '#b98cff', hex: 0xb98cff },
    { id: 'blood', zh: '血月', price: 8000, desc: '紅黑機身，血紅光邊。', swatch: ['#2e1719', '#ff2436'], col: '#ff2436', hex: 0xff2436 },
    { id: 'aurora', zh: '極光', price: 8000, desc: '珍珠白機身，青綠極光光邊。', swatch: ['#d8e1e5', '#3ff0c8'], col: '#3ff0c8', hex: 0x3ff0c8 },
    { id: 'gold', zh: '黃金', price: 25000, desc: '全機鏡面黃金，散發暖光。', swatch: ['#d9a53a', '#fff0b8'], col: '#f0c75a', hex: 0xf0c75a },
  ],
};
export const DEFAULT_PAINT = 'std';
// The PAINTS entry of aircraft `ac` named `id`, or null (own-property safe: unknown ids → null).
export function paintOf(ac, id) {
  const list = Object.prototype.hasOwnProperty.call(PAINTS, ac) ? PAINTS[ac] : null;
  if (!list) return null;
  for (const p of list) if (p.id === id) return p;
  return null;
}

// --- hangar shop: permanent upgrades -------------------------------------------------------
// Shared by every aircraft. prices[i] = cost of level i+1, so the max level is prices.length.
// game.setUpgrades({ id: level }) applies them from the next stage start / continue; `step` is the
// per-level factor game.js uses (magnet radius, CR multiplier).
export const UPGRADES = [
  { id: 'bombs', zh: '起始炸彈', desc: '開局多帶 1 顆炸彈', prices: [6000, 14000] },
  { id: 'power', zh: '起始火力', desc: '開局主武器 +1 級', prices: [8000, 18000] },
  { id: 'life', zh: '預備機', desc: '開局與接關多 1 條命', prices: [20000] },
  { id: 'magnet', zh: '道具磁吸', desc: '撿道具與勳章的範圍變大', prices: [4000, 9000], step: 0.35 },
  { id: 'shield', zh: '能量護盾', desc: '每一關可抵擋一次中彈', prices: [30000], col: '#8fe6ff' },
  { id: 'bonus', zh: '收益加成', desc: 'CR 收入 +10%／+20%／+30%', prices: [5000, 12000, 25000], step: 0.1 },
];
export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

// --- weapons ------------------------------------------------------------------------------
// Main weapons come from P items, which cycle through MAIN_ORDER; sub-weapons from S items (SUB_ORDER).
export const MAIN_WEAPONS = {
  red: { name: 'VULCAN', zh: '散射火神砲', col: '#ff6a4a', hex: 0xff6a4a },
  blue: { name: 'LASER', zh: '雷射', col: '#45e3ff', hex: 0x45e3ff },
  pink: { name: 'PLASMA', zh: '電漿鎖定光束', col: '#ff5ad9', hex: 0xff5ad9 },
  gold: { name: 'WAVE', zh: '穿透波動砲', col: '#ffd84a', hex: 0xffd84a },
};
export const MAIN_ORDER = ['red', 'blue', 'pink', 'gold'];
export const SUB_WEAPONS = {
  H: { name: 'HOMING', zh: '追蹤飛彈', col: '#8cff5a', hex: 0x2fe060 },
  N: { name: 'NUKE', zh: '核子飛彈', col: '#b77bff', hex: 0xb64cff },
  M: { name: 'MULTI', zh: '散射飛彈', col: '#7ab8ff', hex: 0x4d9dff },
};
export const SUB_ORDER = ['H', 'N', 'M'];
export const MAX_LEVEL = 8;     // main weapon power levels 1..8
export const MAX_SUB_LEVEL = 4; // sub-weapon levels 1..4

// --- stages ------------------------------------------------------------------------------
// Presentation data only; the playable definitions (timeline, bosses, enemies) live in
// stage.js / stage2.js / stage3.js and are assembled by stages.js.
export const STAGE_META = [
  {
    n: 1, name: 'COASTAL FRONT', zh: '沿岸前線', world: 'coastal',
    boss: 'ARCLIGHT', bossZh: '要塞', music: 'stage', bossMusic: 'boss', startSfx: 'stageStart',
    warn: { e: 'HUGE FORTRESS APPROACHING', s: '巨大要塞 接近中' },
    mission: '擊破巨大要塞 ARCLIGHT',
  },
  {
    n: 2, name: 'SCORCHED CANYON', zh: '灼熱峽谷', world: 'canyon',
    boss: 'BEHEMOTH', bossZh: '陸上戰艦', music: 'stage2', bossMusic: 'boss2', startSfx: 'stageStart2',
    warn: { e: 'LAND BATTLESHIP APPROACHING', s: '陸上戰艦 接近中' },
    mission: '擊破陸上戰艦 BEHEMOTH',
  },
  {
    n: 3, name: 'SKY CITADEL', zh: '天空要塞', world: 'skies',
    boss: 'SERAPH', bossZh: '空中母艦', music: 'stage3', bossMusic: 'boss3', startSfx: 'stageStart3',
    warn: { e: 'AERIAL MOTHERSHIP APPROACHING', s: '空中母艦 接近中' },
    mission: '擊破空中母艦 SERAPH',
  },
];
export const STAGE_COUNT = STAGE_META.length;
