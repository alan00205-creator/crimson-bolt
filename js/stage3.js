// stage3.js — STAGE 3 "SKY CITADEL" (天空要塞).
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (engine task A2a) so the 1 → 2 → 3 flow runs end to end. The stage-3 task      ║
// ║ replaces this whole file: its own air enemies in ENEMY, an air-only timeline, an air       ║
// ║ mid-boss and the mothership SERAPH. Until then: stage-1 air units, a bomber formation as   ║
// ║ the mid-boss and ARCLIGHT (without the sea splash) as the boss.                            ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages)
//   STAGE  { ...STAGE_META[2], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll }
// World 'skies' (world.js): a cloud sea, no ground at all — air units only. Biomes by light:
// stratosphere 0–420 · storm band 420–800 · golden high altitude 800–1240 · dusk 1240+ (boss).
import { STAGE_META } from './defs.js';
import { W, makeTimeline, midbossEvent, spawnBoss } from './stage.js';

export const ENEMY = {};

const MIDBOSS_AT = 590;
const BOSS_AT = 1275;

// Mid-boss stand-in: two heavy bombers with a hornet escort. The fight ends (g.midbossDone) once
// every member is destroyed or has left the screen.
function spawnFormation(g) {
  const units = [W.bomber(g, -3.5, ['P']), W.bomber(g, 3.5, ['B'])];
  g.later(2.5, () => { units.push(W.hornet(g, -6, 0.42, 9), W.hornet(g, 6, 0.42, 9)); });
  const watch = () => {
    if (units.every((e) => !e.alive)) { g.midbossDone = true; return; }
    g.later(0.25, watch);
  };
  g.later(3, watch); // after the escort has joined
  return { formation: units };
}

const TIMELINE = makeTimeline((at) => {
  // STRATOSPHERE
  at(26, (g) => W.swoop(g, -1));
  at(52, (g) => W.swoop(g, 1));
  at(84, (g) => W.vee(g, 0));
  at(118, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
  at(160, (g) => W.carrier(g, 0, ['P']));
  at(196, (g) => W.dive(g, [-5, 3, -1, 5]));
  at(236, (g) => { W.snake(g, -3.5); g.later(1, () => W.snake(g, 3.5)); });
  at(290, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
  at(330, (g) => W.bomber(g, 0, ['S']));
  at(380, (g) => W.vee(g, -2));
  // STORM BAND
  at(430, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(480, (g) => W.carrier(g, 2, ['P']));
  at(520, (g) => { W.swoop(g, -1, 4); g.later(1, () => W.swoop(g, 1, 4)); });
  at(556, (g) => W.dive(g, [-6, -2, 2, 6, 0]));
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnFormation));
  at(650, (g) => { W.snake(g, -4); W.snake(g, 4); });
  at(700, (g) => W.carrier(g, -3, ['B']));
  at(750, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); });
  // GOLDEN HIGH ALTITUDE
  at(820, (g) => W.bomber(g, 0, ['P', 'B']));
  at(900, (g) => { W.vee(g, 0); g.later(1.2, () => W.swoop(g, -1, 4)); });
  at(960, (g) => { W.rise(g, -1, 4); g.later(0.6, () => W.rise(g, 1, 4)); });
  at(1020, (g) => { W.hornet(g, -6, 0.24); W.hornet(g, -2, 0.32); W.hornet(g, 2, 0.32); W.hornet(g, 6, 0.24); });
  at(1080, (g) => W.carrier(g, 0, ['1UP']));
  at(1120, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['B'])); });
  at(1190, (g) => W.dive(g, [-6, -3, 0, 3, 6, -1]));
});

export const STAGE = {
  ...STAGE_META[2],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => spawnBoss(g, { splash: false }), // stand-in for SERAPH (clouds below)
  hpSeg: (d) => (d < 420 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
