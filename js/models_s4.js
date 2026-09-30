// =============================================================================
// CRIMSON BOLT (赤電) — extension models: stage 4 "FROZEN FRONTIER" (冰原戰線)
// -----------------------------------------------------------------------------
// STUB (framework task): valid empty tables so the registry and the stage framework run; the
// stage-4 task fills them. models.js registers these tables: createEnemy(type) falls back to
// ENEMIES[type], createBoss(id) to BOSSES[id]. Each entry is a factory () => THREE.Group that
// returns a NEW instance per call (pools build several).
//
//   export const ENEMIES = { <type>: factory };  // type = the ENEMY def key in stage4.js (or its `model`)
//   export const BOSSES = { <id>: factory };     // id = the boss ENEMY def `model` (e.g. 'northstar')
//
// Names must not collide with stage-1 types (dart hornet tank turret gunboat carrier
// bomber crawler, arclight) or with models_s2 / s3 / s5; the registry reports collisions.
// Name them clearly: 'icebreaker', 'northstar', others 's4_*'.
//
// Imports: only 'three', './modelkit.js' (and './defs.js') — never models.js
// (import cycle). House style and helpers: see the modelkit.js header.
//
// Enemy contract — enemyShell(kind, radius, debrisHex) + bodyMat + GG(key, buildXxx):
//   * nose/front toward −z (the game yaws units that face the player by π), up +y;
//     air units centred on the origin; ground / sea units with their base (waterline) at
//     y = 0 AND userData.ground = true (the registry adds them to GROUND_TYPES: no air shadow)
//   * userData: kind (the registry sets it to the type), radius, debrisColor, muzzles
//     (group-local Vector3[], refreshed in update() when they move), setFlash(v),
//     update(dt, t), dispose() (materials only)
//   * turreted units: userData.turret (a Group rotating about y only) with
//     turret.userData.muzzles (turret-local), kept in sync by syncMuzzles() in update()
//   * long units: userData.halfExtents { x, z }
//   * gameplay numbers (hp, score, collision radius) live in the stage's ENEMY def, not here
//   * budget: enemy ≤ 4 draw calls / 700 triangles; mid-boss ≤ 6 / 2500 (mark it
//     userData.midboss = true so dev/models.html applies that budget)
// Mid-boss / boss contract:
//   * destructible parts built with makePart / destructiblePart, exposed as
//     userData.parts = { key: part | [part, …] }; part.userData: radius, muzzles
//     (part-local), setFlash, setDestroyed(d) — setDestroyed(false) must fully restore
//     the pose. The stage's ENEMY def `parts` names these keys; a core may add setOpen(0..1)
//   * one bodyMat per part so parts flash on their own; userData.setFlash flashes all
//   * mirrored parts share geometry + wreck with mesh.scale.x = −1
//   * boss budget ≤ 24 draw calls / 8000 triangles; the registry sets kind 'boss:<id>'
//   * stage 4 is cold and bright: frozen sea, ice floes, glacier walls, snow, steel and dark
//     water, a low grey sun. Keep silhouettes dark-edged and glows saturated so units read on
//     white snow as well as on dark water (the mid-boss ICEBREAKER is a sea unit)
// Cache keys: 'ext:s4:<name>' — e.g. 'ext:s4:northstar.hull', 'ext:s4:icebreaker.bow.wreck'.
// =============================================================================
import * as THREE from 'three';
import {
  GB, GG, G, M, S, lit, lin, rgb, GL, EM, EN, BO, scl, bodyMat, additiveMat, flashFn, enemyShell, syncMuzzles,
  hazardStrip, hazardDrape, blockOn, trackLoft, makePart, destructiblePart, wreckGeo, buildFlame,
} from './modelkit.js';

export const ENEMIES = {};
export const BOSSES = {};
