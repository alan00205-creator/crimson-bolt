// stages.js — the eight stages in play order plus the merged enemy table.
// stage.js holds stage 1 and the shared toolkit; stage2.js … stage8.js add their own enemy
// types (ENEMY) and definitions (STAGE). game.js reads only this module.
import * as S1 from './stage.js';
import * as S2 from './stage2.js';
import * as S3 from './stage3.js';
import * as S4 from './stage4.js';
import * as S5 from './stage5.js';
import * as S6 from './stage6.js';
import * as S7 from './stage7.js';
import * as S8 from './stage8.js';

// enemy keys are pool keys and e.type: a clash would silently swap one stage's unit for another's.
// Stage-1 names win (so stage 1 can never break), and a later stage wins over an earlier one — as
// in models.js.
const EXT = [['stage2.js', S2], ['stage3.js', S3], ['stage4.js', S4], ['stage5.js', S5], ['stage6.js', S6],
  ['stage7.js', S7], ['stage8.js', S8]];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
EXT.forEach(([name, mod], i) => {
  for (const k of Object.keys(mod.ENEMY || {})) {
    if (own(S1.ENEMY, k)) { console.error(`stages: ${name} enemy "${k}" collides with a stage-1 enemy and is ignored`); continue; }
    for (const [prev, pm] of EXT.slice(0, i)) {
      if (own(pm.ENEMY || {}, k)) console.error(`stages: enemy "${k}" is defined in both ${prev} and ${name} (${name} wins)`);
    }
  }
});

export const ENEMY = Object.assign({}, ...EXT.map(([, mod]) => mod.ENEMY || {}), S1.ENEMY);
export const STAGES = [S1.STAGE, S2.STAGE, S3.STAGE, S4.STAGE, S5.STAGE, S6.STAGE, S7.STAGE, S8.STAGE];
// each stage carries its own STAGE_META entry (n = its place in the order): a stage file that
// spread the wrong entry would show another stage's name, music and boss
STAGES.forEach((st, i) => { if (!st || st.n !== i + 1) console.error(`stages: STAGES[${i}] is stage ${st && st.n} (expected ${i + 1})`); });
