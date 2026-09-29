// stage2.js — STAGE 2 "SCORCHED CANYON" (灼熱峽谷).
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (engine task A2a) so the 1 → 2 → 3 flow runs end to end. The stage-2 task      ║
// ║ replaces this whole file: its own enemies in ENEMY, a canyon timeline, its own mid-boss    ║
// ║ and the land battleship BEHEMOTH. Until then: stage-1 enemy types, the CRAWLER mid-boss    ║
// ║ and ARCLIGHT (without the sea splash) as the boss.                                         ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages)
//   STAGE  { ...STAGE_META[1], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll }
// World 'canyon' (world.js): dunes 0–260 · canyon 260–560 (walls beyond |x| ≈ 10) · mesa
// 560–780 (mid-boss plateau, clear |x| < 5.5) · refinery 780–1000 · fortress 1000–1240 · dry
// lakebed 1240+ (boss arena). Lanes and cross roads are flat and clear within 300–1240.
import { STAGE_META } from './defs.js';
import { W, makeTimeline, midbossEvent, spawnMidboss, spawnBoss } from './stage.js';

export const ENEMY = {};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

const TIMELINE = makeTimeline((at) => {
  // DUNES (air only)
  at(26, (g) => W.swoop(g, 1));
  at(58, (g) => W.vee(g, 0));
  at(96, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
  at(140, (g) => W.carrier(g, 0, ['P']));
  at(176, (g) => W.dive(g, [-5, 3, -1, 5]));
  at(214, (g) => { W.snake(g, -3.5); g.later(1, () => W.snake(g, 3.5, 4)); });
  // CANYON (lanes only: the walls close in beyond |x| ≈ 10, so no cross roads here)
  at(300, (g) => { W.lane(g, 0, 2); W.lane(g, 2, 2); });
  at(336, (g) => W.swoop(g, -1));
  at(372, (g) => W.turrets(g, [0, 2]));
  at(412, (g) => W.carrier(g, 2, ['S']));
  at(452, (g) => { W.hornet(g, -4, 0.3); W.hornet(g, 4, 0.3); });
  at(500, (g) => W.lane(g, 1, 3, 3));
  at(540, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
  // MESA: mid-boss
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnMidboss));
  // REFINERY
  at(650, (g) => { W.swoop(g, 1); g.later(0.9, () => W.swoop(g, -1)); });
  at(700, (g) => W.bomber(g, 0, ['P', 'B']));
  at(800, (g) => { W.turrets(g, [0, 1, 2]); W.cross(g, [1, -1]); });
  at(860, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(930, (g) => W.carrier(g, -3, ['P']));
  // FORTRESS
  at(1010, (g) => { W.lane(g, 0, 3, 3); W.lane(g, 2, 3, 3); });
  at(1060, (g) => W.bomber(g, 3, ['B']));
  at(1130, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(1190, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[1],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => spawnBoss(g, { splash: false }), // stand-in for BEHEMOTH (dry ground below)
  hpSeg: (d) => (d < 300 ? 1 : d < 780 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
