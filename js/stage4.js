// stage4.js — STAGE 4 "ORBITAL FRONT" (軌道戰線): Earth orbit, air units only.
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (framework task) so the 1 → … → 8 flow runs end to end. The stage-4 task       ║
// ║ replaces this whole file: its own enemies in ENEMY (orbital drones, laser satellites,      ║
// ║ space frigates, mine pods), an orbital timeline, the mid-boss HYDRA and the boss AEGIS     ║
// ║ (軌道防衛砲台, the orbital defense platform). Until then: stage-1 air units, stage 3's      ║
// ║ VALKYRIE as the mid-boss and its SERAPH as the boss.                                       ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages:
//          'hydra', 'aegis', others 's4_*')
//   STAGE  { ...STAGE_META[3], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll, bulletRim? }
// World 'orbit' (world.js): no ground at all — AIR UNITS ONLY. Earth far below (day side →
// terminator → night side with city lights), stars, drifting satellites and debris kept out of the
// lanes; an enemy orbital station passes below near the end. Bands: earth-lit 0–420 · debris storm
// 420–800 · station approach 800–1240 · arena 1240+ (the planet's limb).
// Models: models_s4.js (cache keys 'ext:s4:*').
import { STAGE_META } from './defs.js';
import { W, makeTimeline, midbossEvent } from './stage.js';
import * as S3 from './stage3.js';

export const ENEMY = {};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// Stand-ins borrowed from stage 3 (air units, no ground needed): its mid-boss event (VALKYRIE,
// which sets g.midbossDone on death and on retreat) and its boss (SERAPH).
const S3_MID = S3.STAGE.timeline.find((ev) => ev.d === S3.STAGE.midbossAt);
const standInMidboss = (g) => (S3_MID ? S3_MID.run(g) : midbossEvent(g, () => null));

const TIMELINE = makeTimeline((at) => {
  // EARTH-LIT ORBIT
  at(24, (g) => W.swoop(g, 1));
  at(52, (g) => W.carrier(g, 0, ['P']));
  at(84, (g) => W.vee(g, 0));
  at(118, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
  at(160, (g) => W.dive(g, [-5, 3, -1, 5]));
  at(204, (g) => W.carrier(g, 3, ['P', 'S']));
  at(250, (g) => { W.snake(g, -3.5); g.later(1, () => W.snake(g, 3.5)); });
  at(300, (g) => W.bomber(g, 0, ['S']));
  at(360, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
  // DEBRIS STORM
  at(430, (g) => W.dive(g, [-6, -2, 2, 6, 0]));
  at(476, (g) => W.carrier(g, -2, ['P']));
  at(520, (g) => { W.hornet(g, -4, 0.3); W.hornet(g, 4, 0.3); });
  at(556, (g) => W.carrier(g, 2, ['B']));
  at(MIDBOSS_AT, standInMidboss);
  at(660, (g) => { W.swoop(g, 1); g.later(0.9, () => W.swoop(g, -1)); });
  at(720, (g) => W.bomber(g, 0, ['P', 'B']));
  // STATION APPROACH
  at(820, (g) => { W.vee(g, 0); g.later(1.2, () => W.swoop(g, -1, 4)); });
  at(880, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(960, (g) => W.carrier(g, 0, ['1UP']));
  at(1030, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  at(1100, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['S'])); });
  at(1170, (g) => W.snake(g, 0, 8, 0.25));
  at(1214, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[3],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => S3.STAGE.spawnBoss(g), // stand-in for AEGIS
  hpSeg: (d) => (d < 420 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
