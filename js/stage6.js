// stage6.js — STAGE 6 "SOLAR VOYAGE" (太陽系航線): across the Solar System, air units only.
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (framework task) so the 1 → … → 8 flow runs end to end. The stage-6 task       ║
// ║ replaces this whole file: its own enemies in ENEMY (asteroid-riding raiders, solar-sail    ║
// ║ fighters, comet bombers, ring skimmers), a solar timeline, the mid-boss BASILISK and the   ║
// ║ boss HELIOS (日冕戰艦, the corona battleship). Until then: stage-1/2 air units, stage 3's   ║
// ║ VALKYRIE as the mid-boss and its SERAPH as the boss.                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages:
//          'basilisk', 'helios', others 's6_*')
//   STAGE  { ...STAGE_META[5], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll, bulletRim? }
// World 'solar' (world.js): no ground at all — AIR UNITS ONLY. Past Mars (the red planet far
// below) 0–320 · the asteroid belt (tumbling rocks at the sides, never in the lanes) 320–700 ·
// Jupiter's banded clouds below 700–1000 · Saturn's ring plane 1000–1240 · the Sun's corona glare
// 1240+ (boss arena).
// Models: models_s6.js (cache keys 'ext:s6:*').
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
  // MARS
  at(24, (g) => W.swoop(g, -1));
  at(50, (g) => W2.strikers(g, [-4, 4], 0.3));
  at(80, (g) => W.carrier(g, 0, ['P']));
  at(116, (g) => W.dive(g, [-5, -1, 3, 5]));
  at(156, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
  at(200, (g) => W.carrier(g, -3, ['S']));
  at(246, (g) => W.vee(g, 2));
  at(290, (g) => W2.strikers(g, [-5, 0, 5], 0.5));
  // ASTEROID BELT
  at(336, (g) => { W.snake(g, -3.5); g.later(1, () => W.snake(g, 3.5)); });
  at(380, (g) => W.bomber(g, 0, ['P']));
  at(430, (g) => { W.rise(g, 1); g.later(0.6, () => W.rise(g, -1)); });
  at(476, (g) => W.carrier(g, 2, ['P', 'S']));
  at(520, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(556, (g) => W.carrier(g, -2, ['B']));
  at(MIDBOSS_AT, standInMidboss);
  at(660, (g) => { W.swoop(g, -1); g.later(0.9, () => W.swoop(g, 1)); });
  // JUPITER
  at(716, (g) => W2.strikers(g, [-6, -2, 2, 6], 0.35));
  at(770, (g) => W.bomber(g, 0, ['P', 'B']));
  at(836, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(900, (g) => { W2.gunship(g, -5, 0.28); W2.gunship(g, 5, 0.28); });
  at(960, (g) => W.carrier(g, 0, ['1UP']));
  // SATURN'S RINGS
  at(1016, (g) => { W.vee(g, 0); g.later(1.2, () => W.swoop(g, 1, 4)); });
  at(1070, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['S'])); });
  at(1130, (g) => { W.hornet(g, -6, 0.24); W.hornet(g, -2, 0.32); W.hornet(g, 2, 0.32); W.hornet(g, 6, 0.24); });
  at(1180, (g) => W.dive(g, [-6, -3, 0, 3, 6, -1]));
  at(1214, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[5],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => S3.STAGE.spawnBoss(g), // stand-in for HELIOS
  hpSeg: (d) => (d < 320 ? 1 : d < 700 ? 1.12 : d < 1000 ? 1.24 : 1.36),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
