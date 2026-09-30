// stage4.js — STAGE 4 "FROZEN FRONTIER" (冰原戰線).
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (framework task) so the 1 → 2 → 3 → 4 → 5 flow runs end to end. The stage-4   ║
// ║ task replaces this whole file: its own enemies in ENEMY, an arctic timeline, the sea       ║
// ║ mid-boss ICEBREAKER and the polar fortress NORTHSTAR. Until then: stage-1 enemy types,     ║
// ║ the CRAWLER mid-boss and ARCLIGHT as the boss.                                             ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages;
//          name them clearly: 'icebreaker', 'northstar', others 's4_*')
//   STAGE  { ...STAGE_META[3], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll, bulletRim? }
// World 'arctic' (world.js): frozen sea with ice floes and icebergs 0–300 (open water lanes
// |x| ≤ 7 for boats) · glacier fjord 300–560 (ice cliffs beyond |x| ≈ 10, dark water channel) ·
// mid-boss channel 560–780 (open water corridor |x| < 6: the ICEBREAKER is a sea unit) · arctic
// naval base / radar station 780–1000 · snow fortress 1000–1240 · endless frozen lake 1240+ (boss
// arena, flat ice, clear |x| < 9). Ground units run only on the lanes (LANES_X) and the cross
// roads (d ≡ 20 mod 40) within 780..1240, which world.js keeps flat and clear.
// Models: models_s4.js (cache keys 'ext:s4:*').
import { STAGE_META } from './defs.js';
import { W, makeTimeline, midbossEvent, spawnMidboss, spawnBoss } from './stage.js';

export const ENEMY = {};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

const TIMELINE = makeTimeline((at) => {
  // FROZEN SEA (air + gunboats in the open water lanes |x| ≤ 7)
  at(26, (g) => W.swoop(g, -1));
  at(50, (g) => W.boats(g, [-5, 5]));
  at(72, (g) => W.carrier(g, 0, ['P']));
  at(96, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
  at(124, (g) => W.boats(g, [-6, 0, 6], 4));
  at(150, (g) => W.vee(g, 0));
  at(178, (g) => W.dive(g, [-5, 3, -1, 5]));
  at(206, (g) => W.carrier(g, 3, ['P', 'S']));
  at(232, (g) => { W.boats(g, [-4, 5], 5); W.swoop(g, 1, 4); });
  at(262, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  // GLACIER FJORD (air only: ice cliffs close in)
  at(312, (g) => { W.snake(g, -3.5); g.later(1, () => W.snake(g, 3.5, 4)); });
  at(346, (g) => W.bomber(g, 0, ['S']));
  at(384, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
  at(414, (g) => W.carrier(g, -2, ['P']));
  at(446, (g) => { W.hornet(g, -4, 0.3); W.hornet(g, 4, 0.3); });
  at(480, (g) => W.dive(g, [-6, -2, 2, 6, 0]));
  at(516, (g) => { W.swoop(g, -1, 4); g.later(1, () => W.swoop(g, 1, 4)); });
  at(552, (g) => W.carrier(g, 2, ['B']));
  // CHANNEL: mid-boss (stand-in for the ICEBREAKER)
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnMidboss));
  at(640, (g) => W.boats(g, [-3, 3], 4));
  at(668, (g) => { W.swoop(g, 1); g.later(0.9, () => W.swoop(g, -1)); });
  at(700, (g) => W.bomber(g, 0, ['P', 'B']));
  at(744, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); });
  // NAVAL BASE (ground units from here on)
  at(800, (g) => W.turrets(g, [0, 2]));
  at(820, (g) => { W.lane(g, 0, 2); W.lane(g, 2, 2); });
  at(846, (g) => W.carrier(g, -3, ['P']));
  at(870, (g) => W.cross(g, [1, -1]));
  at(900, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(930, (g) => W.lane(g, 1, 3, 3));
  at(962, (g) => W.bomber(g, 3, ['S']));
  // SNOW FORTRESS
  at(1010, (g) => W.turrets(g, [0, 1, 2]));
  at(1040, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(1066, (g) => { W.lane(g, 0, 3, 3); W.lane(g, 2, 3, 3); });
  at(1100, (g) => W.carrier(g, 0, ['1UP']));
  at(1124, (g) => W.cross(g, [1, -1, 1]));
  at(1150, (g) => W.turrets(g, [0, 2]));
  at(1176, (g) => { W.swoop(g, -1); g.later(0.8, () => W.swoop(g, 1)); });
  at(1206, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[3],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => spawnBoss(g), // stand-in for NORTHSTAR
  hpSeg: (d) => (d < 300 ? 1 : d < 780 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
