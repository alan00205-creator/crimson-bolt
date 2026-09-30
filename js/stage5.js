// stage5.js — STAGE 5 "LUNAR SIEGE" (月面攻防): the Moon, ground and air units.
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (framework task) so the 1 → … → 8 flow runs end to end. The stage-5 task       ║
// ║ replaces this whole file: its own enemies in ENEMY (lunar rovers, walkers, crater turrets, ║
// ║ landers), a lunar timeline, the mid-boss SELENITE and the boss SELENE (月面要塞, the lunar ║
// ║ fortress). Until then: stage-1/2 units, stage 2's SCORPION as the mid-boss and its         ║
// ║ BEHEMOTH as the boss (both ground units, which the moon's corridors are laid out for).     ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages:
//          'selenite', 'selene', others 's5_*')
//   STAGE  { ...STAGE_META[4], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll, bulletRim? (if the regolith is bright enough to need it) }
// World 'moon' (world.js): a GROUND stage — grey regolith, craters, rilles, boulders, a lunar base
// (domes, landing pads, antenna arrays, mass-driver rail); black space beyond the surface edge, a
// hard sun and long black shadows. Ground units run only on the lanes (LANES_X) and the cross roads
// (d ≡ 20 mod 40) within 300..1240, which world.js keeps flat and clear; mid-boss corridor
// d 560–780 clear |x| < 5.5; flat mare arena 1240+ clear |x| < 9 (boss).
// Models: models_s5.js (cache keys 'ext:s5:*'; ground units userData.ground = true).
import { STAGE_META } from './defs.js';
import { W, makeTimeline, midbossEvent } from './stage.js';
import * as S2 from './stage2.js';

const { W2 } = S2;

export const ENEMY = {};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// Stand-ins borrowed from stage 2: its mid-boss event (SCORPION, which sets g.midbossDone on death
// and on retreat) and its boss (BEHEMOTH).
const S2_MID = S2.STAGE.timeline.find((ev) => ev.d === S2.STAGE.midbossAt);
const standInMidboss = (g) => (S2_MID ? S2_MID.run(g) : midbossEvent(g, () => null));

const TIMELINE = makeTimeline((at) => {
  // APPROACH over the craters (air only until the base lanes start at 300)
  at(24, (g) => W.swoop(g, -1));
  at(54, (g) => W2.strikers(g, [-4, 4], 0.3));
  at(84, (g) => W.carrier(g, 0, ['P']));
  at(118, (g) => W.vee(g, 0));
  at(156, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); });
  at(196, (g) => W.dive(g, [-5, 3, -1, 5, 0]));
  at(236, (g) => W.carrier(g, 2, ['S']));
  at(270, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
  // LUNAR BASE (ground units on the lanes and cross roads from 300)
  at(318, (g) => W.turrets(g, [0, 2]));
  at(346, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2, 1, 0, 2.5); });
  at(380, (g) => W2.strikers(g, [-3, 3], 0.35));
  at(414, (g) => W.carrier(g, -2, ['P']));
  at(446, (g) => W.lane(g, 1, 3, 3));
  at(480, (g) => W.cross(g, [1, -1]));
  at(516, (g) => W2.gunship(g, 0, 0.24));
  at(548, (g) => W.carrier(g, 0, ['B']));
  at(MIDBOSS_AT, standInMidboss);
  at(660, (g) => { W.swoop(g, -1); g.later(0.9, () => W.swoop(g, 1)); });
  at(700, (g) => { W2.mlrs(g, 0); W.lane(g, 2, 2); });
  at(740, (g) => W.bomber(g, 0, ['S', 'B']));
  at(800, (g) => W.turrets(g, [0, 1, 2]));
  at(846, (g) => { W2.rush(g, 0, 2); g.later(1.2, () => W2.rush(g, 2, 2)); });
  at(900, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(960, (g) => W.carrier(g, 0, ['1UP']));
  at(1010, (g) => { W2.mlrs(g, 0); W2.mlrs(g, 2); g.later(1.2, () => W2.mlrs(g, 1)); });
  at(1070, (g) => W2.strikers(g, [-6, -2, 2, 6], 0.35));
  at(1120, (g) => { W.lane(g, 0, 2); W.lane(g, 2, 2); W.turrets(g, [1]); });
  at(1170, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(1214, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[4],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => S2.STAGE.spawnBoss(g), // stand-in for SELENE
  hpSeg: (d) => (d < 300 ? 1 : d < 780 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
