// stage8.js — STAGE 8 "EDGE OF INFINITY" (宇宙盡頭), the final stage: the edge of the Universe,
// air units only.
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (framework task) so the 1 → … → 8 flow runs end to end. The stage-8 task       ║
// ║ replaces this whole file: its own enemies in ENEMY (cosmic sentinels, void wraiths,        ║
// ║ fractal constructs, singularity mines), a cosmic timeline, the mid-boss SENTINEL and the   ║
// ║ final boss OMEGA (終焉之核, 4 phases — the grand finale). Until then: stage-1/2 air units,  ║
// ║ stage 3's VALKYRIE as the mid-boss and its SERAPH as the boss.                             ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages:
//          'sentinel', 'omega', others 's8_*')
//   STAGE  { ...STAGE_META[7], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll, bulletRim? }
// World 'cosmos' (world.js): no ground at all — AIR UNITS ONLY. Cosmic web filaments, sparse
// ancient galaxies, warped space; a black hole with an accretion disk as the final arena
// backdrop (1240+).
// Models: models_s8.js (cache keys 'ext:s8:*').
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
  // COSMIC WEB
  at(24, (g) => W.vee(g, 0));
  at(56, (g) => W2.strikers(g, [-4, 4], 0.3));
  at(88, (g) => W.carrier(g, 0, ['P']));
  at(124, (g) => { W.snake(g, -3.5); g.later(1, () => W.snake(g, 3.5)); });
  at(166, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
  at(208, (g) => W.carrier(g, -3, ['P', 'S']));
  at(252, (g) => W.dive(g, [-6, -2, 2, 6, 0]));
  at(300, (g) => W.bomber(g, 0, ['S']));
  // ANCIENT GALAXIES
  at(352, (g) => { W.swoop(g, -1, 6); g.later(1, () => W.swoop(g, 1, 6)); });
  at(404, (g) => W2.strikers(g, [-6, -2, 2, 6], 0.35));
  at(452, (g) => W.carrier(g, 2, ['P']));
  at(500, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(556, (g) => W.carrier(g, -2, ['B']));
  at(MIDBOSS_AT, standInMidboss);
  at(664, (g) => { W.rise(g, -1, 4); g.later(0.6, () => W.rise(g, 1, 4)); });
  at(716, (g) => W.bomber(g, 0, ['P', 'B']));
  // WARPED SPACE
  at(790, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(846, (g) => { W2.gunship(g, -6, 0.26); W2.gunship(g, 0, 0.2); W2.gunship(g, 6, 0.26); });
  at(908, (g) => { W.vee(g, -2); g.later(1.2, () => W.vee(g, 2)); });
  at(960, (g) => W.carrier(g, 0, ['1UP']));
  // EVENT HORIZON
  at(1020, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['B'])); });
  at(1080, (g) => W.snake(g, 0, 10, 0.25));
  at(1130, (g) => { W.hornet(g, -6, 0.24); W.hornet(g, -2, 0.32); W.hornet(g, 2, 0.32); W.hornet(g, 6, 0.24); });
  at(1180, (g) => W.dive(g, [-6, -3, 0, 3, 6, -1]));
  at(1214, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[7],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => S3.STAGE.spawnBoss(g), // stand-in for OMEGA
  hpSeg: (d) => (d < 400 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
