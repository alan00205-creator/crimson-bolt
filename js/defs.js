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
    desc: '僚機指揮機。兩架小僚機跟隨射擊；按住慢速時僚機收攏、集中火力。',
    stats: { speed: 3, power: 4, bombs: 3, hitbox: 3 },
  },
];
export const AIRCRAFT_BY_ID = Object.fromEntries(AIRCRAFT.map((a) => [a.id, a]));
export const DEFAULT_AIRCRAFT = 'bolt';

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
