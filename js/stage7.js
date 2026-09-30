// stage7.js — STAGE 7 "GALACTIC STORM" (銀河風暴): through the Galaxy, air units only.
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (framework task) so the 1 → … → 8 flow runs end to end. The stage-7 task       ║
// ║ replaces this whole file: its own enemies in ENEMY (alien bio-mechanical swarms, nebula    ║
// ║ stingers, crystal ships, warp gates), a galactic timeline, the mid-boss LEVIATHAN and the  ║
// ║ boss NEMESIS (異星母艦, the alien mothership). Until then: stage-1/2 air units, stage 3's   ║
// ║ VALKYRIE as the mid-boss and its SERAPH as the boss.                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages:
//          'leviathan', 'nemesis', others 's7_*')
//   STAGE  { ...STAGE_META[6], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll, bulletRim? }
// World 'galaxy' (world.js): no ground at all — AIR UNITS ONLY. Colourful nebula gas layers
// (parallax), star clusters, dust lanes and drifting alien structures, the glowing galactic core
// ahead toward the boss arena (1240+).
// Models: models_s7.js (cache keys 'ext:s7:*').
import { STAGE_META } from './defs.js';
import { W, makeTimeline, midbossEvent } from './stage.js';
import { W2 } from './stage2.js';
import * as S3 from './stage3.js';

export const ENEMY = {};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// Stand-ins borrowed from stage 3 (air units, no ground needed): its mid-boss event (VALKYRIE,
// which sets g.midbossDone on death and on retreat) and its boss (SERAPH).
const S3_MID = S3.STAGE.timeline.find((ev) => ev.d === S3.STAGE.midbossAt);
const standInMidboss = (g) => (S3_MID ? S3_MID.run(g) : midbossEvent(g, () => null));

const TIMELINE = makeTimeline((at) => {
  // NEBULA
  at(24, (g) => { W.swoop(g, 1); g.later(0.9, () => W.swoop(g, -1)); });
  at(60, (g) => W.carrier(g, 0, ['P']));
  at(94, (g) => { W.snake(g, -4); W.snake(g, 4); });
  at(136, (g) => W2.strikers(g, [-5, 0, 5], 0.45));
  at(176, (g) => W.carrier(g, 3, ['P', 'S']));
  at(220, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); g.later(1.2, () => W.hornet(g, 0, 0.18)); });
  at(270, (g) => W.dive(g, [-6, -2, 2, 6, 0]));
  at(320, (g) => W.bomber(g, 0, ['S']));
  // STAR CLUSTERS
  at(370, (g) => { W.vee(g, -2); g.later(1.2, () => W.vee(g, 2)); });
  at(420, (g) => W.carrier(g, -2, ['P']));
  at(466, (g) => { W.rise(g, -1, 4); g.later(0.6, () => W.rise(g, 1, 4)); });
  at(512, (g) => W2.strikers(g, [-6, -2, 2, 6], 0.35));
  at(556, (g) => W.carrier(g, 2, ['B']));
  at(MIDBOSS_AT, standInMidboss);
  at(664, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(720, (g) => W.bomber(g, 0, ['P', 'B']));
  // DUST LANES
  at(790, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(850, (g) => { W2.gunship(g, -5, 0.28); g.later(0.7, () => W2.gunship(g, 5, 0.3)); });
  at(910, (g) => { W.snake(g, 0, 10, 0.25); });
  at(960, (g) => W.carrier(g, 0, ['1UP']));
  // THE CORE
  at(1020, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['B'])); });
  at(1080, (g) => { W.swoop(g, -1, 6); g.later(1, () => W.swoop(g, 1, 6)); });
  at(1136, (g) => { W.hornet(g, -6, 0.24); W.hornet(g, -2, 0.32); W.hornet(g, 2, 0.32); W.hornet(g, 6, 0.24); });
  at(1184, (g) => W.dive(g, [-6, -3, 0, 3, 6, -1]));
  at(1214, (g) => W.carrier(g, 0, ['S']));
});

export const STAGE = {
  ...STAGE_META[6],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => S3.STAGE.spawnBoss(g), // stand-in for NEMESIS
  hpSeg: (d) => (d < 360 ? 1 : d < 780 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
