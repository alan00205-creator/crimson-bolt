// =============================================================================
// CRIMSON BOLT (赤電) — extension models: hangar aircraft + option drones
// -----------------------------------------------------------------------------
// models.js registers these tables: createPlayer(id) uses PLAYERS[id],
// createOption(id) uses OPTIONS[id]. Each entry is a factory () => THREE.Group
// that returns a NEW instance per call (pools build several).
//
//   export const PLAYERS = { gale, titan, phantom };   // keys = AIRCRAFT ids in defs.js ('bolt' lives in models.js)
//   export const OPTIONS = { phantom };                 // the option drone of that aircraft
//
// Until an id is filled in, createPlayer(id) falls back to the bolt jet (with a
// console warning) and createOption(id) to a placeholder pod.
//
// Imports: only 'three', './modelkit.js' (and './defs.js' for colours) — never
// models.js (import cycle). House style and helpers: see the modelkit.js header.
//
// Player contract — build a body GB, then call modelkit.assemblePlayer({...}):
//   * nose toward −z, up +y, centred on the origin (= the collision centre)
//   * userData: kind (the registry sets 'player:<id>'), radius, grazeRadius, debrisColor,
//     muzzles (local Vector3[]), muzzleZ (local z of the gun line; bolt −1.0),
//     trail [[x, z], …] (local engine-exhaust points for the game's engine sprite; bolt
//     [[±0.095, 0.95]]), hitboxMarker (makeHitboxMarker(); the game hides / scales it),
//     bankPivot, setBank(b) (−1..1, b > 0 rolls RIGHT), setThrust(0..1), setFlash(0..1),
//     update(dt, t), dispose() (frees materials only; geometry stays cached)
//   * gameplay numbers (speed, hitR, grazeR, bombs, damage) live in defs.js AIRCRAFT, not here
//   * size close to the bolt (≈ 1.9 long, 1.6 wide) so the hitbox marker and shots line up
//   * budget: ≤ 4 draw calls, ≤ 1500 triangles (dev/models.html checks it)
//   * a distinct silhouette per aircraft: the shadow is baked per kind from a pristine instance
// Option contract (small escort drone; the game spawns AIRCRAFT.options of them):
//   * nose −z, up +y, centred; ≈ 0.7 long
//   * userData: kind (the registry sets 'option:<id>'), radius, debrisColor, muzzles (local),
//     setFlash(v), update(dt, t), dispose(); optional setThrust(0..1)
//   * budget: ≤ 3 draw calls, ≤ 500 triangles
// Cache keys: 'ext:ships:<name>' — e.g. 'ext:ships:gale', 'ext:ships:gale.flame' — so
// nothing collides with the stage-1 keys ('player', 'player.flame', …).
// =============================================================================
import * as THREE from 'three';
import { GB, GG, G, M, S, lit, lin, rgb, GL, EM, PL, bodyMat, additiveMat, flashFn, buildFlame, FLAME_JET, assemblePlayer } from './modelkit.js';

export const PLAYERS = {};
export const OPTIONS = {};
