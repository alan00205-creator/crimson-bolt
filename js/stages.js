// stages.js — the three stages in play order plus the merged enemy table.
// stage.js holds stage 1 and the shared toolkit; stage2.js / stage3.js add their own enemy
// types (ENEMY) and definitions (STAGE). game.js reads only this module.
import * as S1 from './stage.js';
import * as S2 from './stage2.js';
import * as S3 from './stage3.js';

// enemy keys are pool keys and e.type: a clash would silently swap one stage's unit for another's.
// Stage-1 names win (so stage 1 can never break), and stage 3 wins over stage 2 — as in models.js.
for (const [name, mod] of [['stage2.js', S2], ['stage3.js', S3]]) {
  for (const k of Object.keys(mod.ENEMY || {})) {
    if (Object.prototype.hasOwnProperty.call(S1.ENEMY, k)) console.error(`stages: ${name} enemy "${k}" collides with a stage-1 enemy and is ignored`);
    if (mod === S3 && Object.prototype.hasOwnProperty.call(S2.ENEMY || {}, k)) console.error(`stages: enemy "${k}" is defined in both stage2.js and stage3.js (stage3.js wins)`);
  }
}

export const ENEMY = { ...(S2.ENEMY || {}), ...(S3.ENEMY || {}), ...S1.ENEMY };
export const STAGES = [S1.STAGE, S2.STAGE, S3.STAGE];
