// stage5.js — STAGE 5 "ORBITAL FINALE" (軌道決戰), the final stage.
// ╔══════════════════════════════════════════════════════════════════════════════════════════╗
// ║ PLACEHOLDER (framework task) so the 1 → 2 → 3 → 4 → 5 flow runs end to end. The stage-5   ║
// ║ task replaces this whole file: its own air enemies in ENEMY, an orbital timeline, the air  ║
// ║ mid-boss HYDRA and the final boss OMEGA. Until then: stage-1 air units, a bomber formation ║
// ║ as the mid-boss and ARCLIGHT as the boss.                                                  ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════╝
// Contract (see stage.js for the helpers and the ENEMY field list):
//   ENEMY  only the types this stage introduces (keys must not collide with other stages;
//          name them clearly: 'hydra', 'omega', others 's5_*')
//   STAGE  { ...STAGE_META[4], timeline, midbossAt, bossAt, spawnBoss(g), hpSeg(d), scroll,
//            warnScroll, bossScroll }
// World 'orbit' (world.js): no ground at all — AIR UNITS ONLY. The planet far below, a starfield,
// drifting debris kept out of the lanes. Bands by light: earth-lit blue 0–420 · debris storm
// 420–800 · station approach 800–1240 · the core arena 1240+ (deep space, the planet's limb).
// Models: models_s5.js (cache keys 'ext:s5:*').
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
  // EARTH-LIT ORBIT
  at(24, (g) => W.swoop(g, 1));
  at(46, (g) => W.swoop(g, -1));
  at(70, (g) => W.carrier(g, 0, ['P']));
  at(92, (g) => W.vee(g, 0));
  at(118, (g) => { W.hornet(g, -5, 0.28); g.later(0.8, () => W.hornet(g, 5, 0.34)); });
  at(146, (g) => W.dive(g, [-5, 3, -1, 5]));
  at(172, (g) => { W.snake(g, -3.5); g.later(1, () => W.snake(g, 3.5)); });
  at(204, (g) => W.carrier(g, 3, ['P', 'S']));
  at(232, (g) => { W.rise(g, -1); g.later(0.6, () => W.rise(g, 1)); });
  at(262, (g) => W.bomber(g, 0, ['S']));
  at(306, (g) => { W.hornet(g, -6, 0.26); W.hornet(g, 0, 0.2); W.hornet(g, 6, 0.26); });
  at(344, (g) => { W.swoop(g, -1, 4); g.later(1, () => W.swoop(g, 1, 4)); });
  at(384, (g) => W.vee(g, -2));
  // DEBRIS STORM
  at(430, (g) => W.dive(g, [-6, -2, 2, 6, 0]));
  at(462, (g) => W.carrier(g, -2, ['P']));
  at(494, (g) => { W.snake(g, -4); W.snake(g, 4); });
  at(530, (g) => { W.hornet(g, -4, 0.3); W.hornet(g, 4, 0.3); });
  at(560, (g) => W.carrier(g, 2, ['B']));
  at(MIDBOSS_AT, (g) => midbossEvent(g, spawnFormation));
  at(648, (g) => { W.swoop(g, 1); g.later(0.9, () => W.swoop(g, -1)); });
  at(690, (g) => W.carrier(g, -3, ['S']));
  at(730, (g) => { W.hornet(g, -5, 0.3); W.hornet(g, 5, 0.3); g.later(1.2, () => W.hornet(g, 0, 0.18)); });
  at(770, (g) => W.dive(g, [-6, -3, 0, 3, 6]));
  // STATION APPROACH
  at(820, (g) => W.bomber(g, 0, ['P', 'B']));
  at(870, (g) => { W.vee(g, 0); g.later(1.2, () => W.swoop(g, -1, 4)); });
  at(916, (g) => { W.rise(g, -1, 4); g.later(0.6, () => W.rise(g, 1, 4)); });
  at(960, (g) => { W.hornet(g, -6, 0.24); W.hornet(g, -2, 0.32); W.hornet(g, 2, 0.32); W.hornet(g, 6, 0.24); });
  at(1010, (g) => W.carrier(g, 0, ['1UP']));
  at(1050, (g) => { W.bomber(g, -4, ['P']); g.later(1.5, () => W.bomber(g, 4, ['B'])); });
  at(1110, (g) => { W.snake(g, 0, 10, 0.25); });
  at(1150, (g) => { W.swoop(g, -1); g.later(0.8, () => W.swoop(g, 1)); });
  at(1190, (g) => W.dive(g, [-6, -3, 0, 3, 6, -1]));
  at(1214, (g) => W.carrier(g, 0, ['B']));
});

export const STAGE = {
  ...STAGE_META[4],
  placeholder: true,
  timeline: TIMELINE,
  midbossAt: MIDBOSS_AT, bossAt: BOSS_AT,
  spawnBoss: (g) => spawnBoss(g), // stand-in for OMEGA
  hpSeg: (d) => (d < 420 ? 1 : d < 800 ? 1.15 : 1.3),
  scroll: 7, warnScroll: 3, bossScroll: 2.2,
};
