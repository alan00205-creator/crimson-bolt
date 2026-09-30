// CRIMSON BOLT (赤電) — synthesized audio system. WebAudio only: no files, no fetch.
//
//   import { audio } from './audio.js';
//   audio.init();                      // from a user gesture (safe to call on every tap)
//   audio.music('stage');              // 'title' | 'stage' | 'boss' | 'stage2' … 'stage8'
//                                      //  | 'boss2' … 'boss8' | 'clear' | 'gameover' | null
//   audio.play('explodeM', { pitch: -2, vol: 0.8, pan: 0.3 });
//   audio.suspend(); audio.resume();   // game pause (song freezes on the beat, resumes there)
//
// Signal flow (one Engine per AudioContext; the test hooks build one on an OfflineAudioContext):
//
//   sfx voice ─► voice gain (vol, density) ─► [pan] ─► sfxVol ───────────┐
//             └► voice verb gain ─► sfxVerb ─┐                           │
//   music track ─► track out (crossfade) ◄─ echo (dotted 8th)           ├─► master ─► compressor
//               └► track verb (crossfade) ─► musicVerbVol ─► reverb ─────┘   ─► trim ─► soft clip ─► mute ─► out
//
// * Limiter: DynamicsCompressor (glue, -8 dB, 6:1) + trim that cancels its automatic make-up
//   gain + a tanh soft clipper whose ceiling is 0.98: the final bus cannot exceed 1.0.
// * Voice limiting: per-name minimum gap, per-name voice cap (oldest stolen), global
//   polyphony cap with priority stealing, density attenuation when one name piles up, and
//   streak attenuation (hits / armour pings fired as a sustained stream settle 5-7 dB lower).
//   Finished voices are detached from the graph (onended / voice pool), so a long session
//   never accumulates dead nodes.
// * Mix: every SFX has a level in the SFX table, calibrated against the music at the game's
//   default volumes AND the per-call vol js/game.js passes (hit 0.35, graze 0.4, …): weapons
//   ~10 dB under the music, pickups at music level, explosions +2…+7 dB, bomb/death/boss
//   kill as loud as the limiter allows. Checked on a phone-speaker proxy too (explosions
//   carry a mid-band punch layer; the kick a "knock").
// * 'laser' and 'plasma' are sustained voices: the game calls play('laser') every frame, and
//   every call within 0.09 s keeps the same voice alive (no new nodes), so it is one steady beam.
// * 'medal' snaps opts.pitch up to E G A B C D E, so the chain (pitch = step × 2) climbs a
//   line that sits in the music's keys instead of a whole-tone run. E minor, B phrygian, A minor
//   and C lydian contain the whole line; under a theme whose key lacks one of those notes (the
//   D-minor themes' B-flat, stages 4-8 and their bosses) the chain snaps to that theme's own
//   scale instead (see compileSong: song.snap; a section that modulates brings its own).
// * 'stageStart' … 'stageStart8' are locked to their stage theme's 16th grid and key: the game
//   fires each together with music('stage' … 'stage8'), and the theme starts on the fanfare's
//   clock even when music() runs a few render quanta later (see Engine.music).
// * Stage and boss themes are battle music: 158-175 BPM, relentless kit (four-on-the-floor,
//   double kick, militant snare drags and 32nd rolls, thrash skank and hammer blasts, drum &
//   bass two-step, hemiola and 2+2+3 machine grooves, tom fills, crashes on phrase starts),
//   pumping 16th / octave bass, double-tracked distorted power-chord guitars (baked stereo),
//   baked brass "power hits", a noise riser into every loop point.
// * init() without any user gesture on the page yet (e.g. a gamepad press seen in the game
//   loop) returns false and waits for the first real gesture instead of creating a context
//   the browser would refuse (and warn about). Sounds requested in the few hundred ms while a
//   new context is still starting are kept, not dropped.
// * Instruments are small subtractive/FM patches. The busiest ones (drums and the steel clank,
//   FM bass, arps, bells, oud plucks, power-chord guitars and brass hits, auto-fire and
//   explosion SFX, glass tines) are baked once into
//   AudioBuffers at init, in the background, by running the very same patches on an
//   OfflineAudioContext (each entry created just in time); until the bake lands everything
//   is synthesized live. Playing a baked note costs 2 nodes instead of ~8.
// * Music: lookahead step sequencer (25 ms timer, adaptive lookahead) over songs compiled once
//   from compact text notation (melodies, chord symbols, bass/drum/arp patterns). Each loop
//   plays twice with different orchestration (harmony, doubling, busier drums, other arps)
//   before repeating. Fills close every 8-bar phrase.
// * Every public call is wrapped in try/catch and is a silent no-op until init() succeeded.
//   Settings made before init() (volumes, mute, last requested track) are remembered.
// * Volumes map perceptually (gain = v²). setMusicDuck(v): v = music LEVEL while ducked,
//   a plain gain factor: 1 = normal (no duck), 0.35 = 35 % (pause menu), 0 = silent. Smoothed.
// * Pause: suspend() freezes the song on the step being heard and fades SFX (a sound fired in
//   the same frame, e.g. 'pause', is kept). play() still works while paused (menu blips);
//   after 1.5 s of quiet the AudioContext is suspended for battery. Hidden tabs auto-suspend.

const MUSIC_BASE = 0.9;
const SFX_BASE = 1.0;
const MAX_VOICES = 26;
const MUSIC_LEAD = 0.05;           // a new song's first step starts this long after music()
const STEPS = 16;                  // 16th-note steps per bar (all songs are 4/4)

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const semis = (s) => Math.pow(2, s / 12);

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- shared resources

function makeNoise(ctx, seconds, seed) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = mulberry(seed);
  for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  return buf;
}

// Sparse random impulses with tiny decays: the "crackle" of burning debris.
function makeCrackle(ctx, seconds, seed) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = mulberry(seed);
  let i = 0;
  while (i < len) {
    i += Math.floor(sr * (0.004 + r() * 0.03));
    const amp = (0.35 + r() * 0.65) * (r() < 0.5 ? -1 : 1);
    const n = Math.floor(sr * (0.0015 + r() * 0.004));
    for (let k = 0; k < n && i + k < len; k++) d[i + k] += amp * Math.exp(-k / (n * 0.3)) * (r() * 2 - 1);
  }
  return buf;
}

// Small, dark room: 0.8 s mono exponential tail, 12 ms pre-delay, unit energy. (Mono = one
// convolution; the engine widens it with a short Haas delay on the right channel.)
function makeIR(ctx, seed) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.8);
  const buf = ctx.createBuffer(1, len, sr);
  const r = mulberry(seed);
  const pre = Math.floor(sr * 0.012);
  const d = buf.getChannelData(0);
  let lp = 0, energy = 0;
  for (let i = pre; i < len; i++) {
    const t = (i - pre) / sr;
    lp += ((r() * 2 - 1) - lp) * (0.55 - 0.35 * Math.min(1, t)); // darker as it decays
    const v = lp * Math.exp(-t / 0.24);
    d[i] = v;
    energy += v * v;
  }
  const k = 1 / Math.sqrt(energy || 1);
  for (let i = 0; i < len; i++) d[i] *= k;
  return buf;
}

// Band-limited pulse wave via Fourier series (duty 0..1).
function makePulse(ctx, duty) {
  const N = 48;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let n = 1; n < N; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  return ctx.createPeriodicWave(re, im);
}

// Soft clipper: linear to 0.7, tanh knee above, ceiling 0.98. Fed at half gain, so the
// curve's domain covers ±2.0 of real signal before it flattens.
function makeClipCurve() {
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    const y = a < 0.7 ? a : 0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

// smallest scale tone >= p (semitones; scale = offsets within one octave, ascending)
function snapUp(p, sc) {
  const o = Math.floor(p / 12), r = p - o * 12;
  for (let i = 0; i < sc.length; i++) if (sc[i] >= r - 1e-6) return o * 12 + sc[i];
  return (o + 1) * 12 + sc[0];
}

// ---------------------------------------------------------------- envelope helpers

// Instant attack then exponential decay toward zero.
function pluck(p, t, peak, tau, atk) {
  const a = atk || 0.002;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(0, t + a, tau);
}

// Attack / decay to sustain / release starting at `end`.
function adsr(p, t, a, peak, d, sus, end, rel) {
  const e = Math.max(end, t + a + 0.004);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(peak * sus, t + a, d);
  p.setTargetAtTime(0, e, rel);
}

// ---------------------------------------------------------------- synth + engine

let SHARED = null;   // context-independent buffers (noise, crackle), made once per sample rate

// onended handler shared by every voice: detach the voice's output nodes (see Synth.fin)
function onVoiceEnded() {
  try {
    if (this._f1) this._f1.disconnect();
    if (this._f2) this._f2.disconnect();
    if (this._f3) this._f3.disconnect();
    this._f1 = this._f2 = this._f3 = null;
    this.onended = null;
  } catch (e) { /* ignore */ }
}

// Node factories + per-context resources. Engine extends it; sample baking runs the very same
// instrument functions on a bare Synth over an OfflineAudioContext.
class Synth {
  constructor(ctx) {
    this.ctx = ctx;
    this.hasPan = typeof ctx.createStereoPanner === 'function';
    if (!SHARED || SHARED.sr !== ctx.sampleRate) {
      SHARED = { sr: ctx.sampleRate, noise: makeNoise(ctx, 2, 1), crackle: makeCrackle(ctx, 2, 2) };
    }
    this.noiseBuf = SHARED.noise;
    this.crackleBuf = SHARED.crackle;
    this.p25 = makePulse(ctx, 0.25);
    this.p12 = makePulse(ctx, 0.125);
    this.smp = null;       // baked samples; null → instruments synthesize live
  }
  osc(type, f, t, stop) {
    const o = this.ctx.createOscillator();
    if (type === 'p25') o.setPeriodicWave(this.p25);
    else if (type === 'p12') o.setPeriodicWave(this.p12);
    else o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.start(t);
    o.stop(stop);
    return o;
  }
  noise(t, stop, rate, buf) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf || this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate || 1;
    s.start(t, Math.random() * 1.8);
    s.stop(stop);
    return s;
  }
  gain(v) { const n = this.ctx.createGain(); n.gain.value = v || 0; return n; }
  filt(type, f, q, t) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.setValueAtTime(f, t || 0);
    b.Q.value = q === undefined ? 0.7 : q;
    return b;
  }
  // connect `node` to `dest`, through a new stereo panner when pan != 0 (returned, else null)
  out(node, dest, pan) {
    if (pan && this.hasPan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan < -1 ? -1 : pan > 1 ? 1 : pan;
      node.connect(p);
      p.connect(dest);
      return p;
    }
    node.connect(dest);
    return null;
  }
  // When `src` ends, disconnect the voice's output nodes so the graph stops pulling them.
  // (Finished-but-connected nodes otherwise keep costing CPU until a GC happens to run.)
  fin(src, a, b, c) {
    src._f1 = a; src._f2 = b || null; src._f3 = c || null;
    src.onended = onVoiceEnded;
  }
  // per-note vibrato LFO (auto-stops with the note, so nothing leaks)
  vibrato(t, stop, delay, cents, targets) {
    const l = this.osc('sine', 5.4 + Math.random() * 0.6, t, stop);
    const d = this.gain(0);
    d.gain.setValueAtTime(0, t + delay);
    d.gain.linearRampToValueAtTime(cents, t + delay + 0.25);
    l.connect(d);
    for (let i = 0; i < targets.length; i++) d.connect(targets[i]);
  }
  // play a baked sample: source (rate) → gain → dest (+ dest2); returns the gain node
  buf(buffer, t, rate, level, dest, dest2) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    if (rate !== 1) s.playbackRate.setValueAtTime(rate, t);
    const g = this.ctx.createGain();
    g.gain.value = level;
    s.connect(g);
    g.connect(dest);
    if (dest2) g.connect(dest2);
    s.start(t);
    this.fin(s, g);
    this.lastSrc = s;
    return g;
  }
}

class Engine extends Synth {
  constructor(ctx, dest, settings) {
    super(ctx);
    const g = (v) => this.gain(v);

    // master chain
    this.master = g(1);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 6;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.comp = comp;
    this.trim = g(TRIM);
    this.clipIn = g(0.5);
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeClipCurve();
    this.shaper.oversample = 'none';
    this.mute = g(settings.muted ? 0 : 1);
    this.master.connect(comp);
    comp.connect(this.trim);
    this.trim.connect(this.clipIn);
    this.clipIn.connect(this.shaper);
    this.shaper.connect(this.mute);
    this.mute.connect(dest);

    // reverb (shared by music + sfx sends): mono in → 1 convolution → L, +13 ms → R
    this.verb = g(1);
    this.verb.channelCount = 1;
    this.verb.channelCountMode = 'explicit';
    this.conv = ctx.createConvolver();
    this.conv.normalize = false;
    this.conv.buffer = makeIR(ctx, 7);
    const haas = ctx.createDelay(0.05);
    haas.delayTime.value = 0.013;
    const wide = ctx.createChannelMerger(2);
    this.verbOut = g(0.6);
    this.verb.connect(this.conv);
    this.conv.connect(wide, 0, 0);
    this.conv.connect(haas);
    haas.connect(wide, 0, 1);
    wide.connect(this.verbOut);
    this.verbOut.connect(this.master);

    // buses
    this.musicVol = g(0);
    this.musicVerbVol = g(0);
    this.sfxVol = g(0);
    this.sfxVerb = g(0);
    this.musicVol.connect(this.master);
    this.musicVerbVol.connect(this.verb);
    this.sfxVol.connect(this.master);
    this.sfxVerb.connect(this.verb);

    // sfx voice pool (preallocated records, reused)
    this.pool = [];
    for (let i = 0; i < MAX_VOICES; i++) this.pool.push({ name: '', pri: 0, start: -1, end: -1, g: null, v: null, p: null, h: null });
    this.grave = [];                                   // detached-later voices (ring buffer)
    for (let i = 0; i < 32; i++) this.grave.push({ g: null, v: null, p: null, at: 0 });
    this.graveI = 0;
    this.last = Object.create(null);
    this.heat = Object.create(null);
    for (const k in SFX) this.heat[k] = 0;
    this.bus = { out: null, verb: null, dly: null };   // scratch bus handed to SFX synth functions

    // music
    this.tracks = [null, null, null, null];
    this.cur = null;
    this.fanSong = null;     // the theme of the stage fanfare fired last, and when (see music())
    this.fanT = -1;

    this.applyLevels(settings, true);
    // Bake the busiest instruments (drums, bass, arps, bells, auto-fire SFX) into samples
    // in the background; until then everything is synthesized live, so nothing waits.
    this.ready = this.bake().then(() => true, () => false);
  }

  applyLevels(s, instant) {
    const t = this.ctx.currentTime;
    const m = s.musicVol * s.musicVol * MUSIC_BASE * clamp01(s.duck);
    const x = s.sfxVol * s.sfxVol * SFX_BASE;
    const set = (p, v, tau) => {
      if (instant) { p.cancelScheduledValues(0); p.setValueAtTime(v, t); }
      else { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, tau); }
    };
    set(this.musicVol.gain, m, 0.12);
    set(this.musicVerbVol.gain, m, 0.12);
    set(this.sfxVol.gain, x, 0.05);
    set(this.sfxVerb.gain, x, 0.05);
  }

  setMuted(b) {
    const t = this.ctx.currentTime;
    const p = this.mute.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(b ? 0 : 1, t, 0.03);
  }

  async bake(upfront) {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) return;
    const sr = this.ctx.sampleRate;
    const offs = [];
    let total = 0;
    for (let i = 0; i < BAKE.length; i++) { offs.push(total); total += BAKE[i][2] + 0.05; }
    const oc = new OAC(2, Math.ceil(total * sr), sr);
    const S = new Synth(oc);
    const bus = { out: oc.destination, verb: null, dly: null };
    // Each entry is created just in time, from a suspend() callback on the render quantum it
    // starts in, so the graph only ever holds the voice being rendered (creating all of them up
    // front made every entry sit in the graph for the whole render: ~5× slower). Engines
    // without OfflineAudioContext.suspend() get everything up front, as before (as does
    // `upfront`, used by __bakeStats to check both ways give the same samples).
    let made = 0;
    const make = (i) => { BAKE[i][1](S, bus, offs[i]); made++; };
    if (typeof oc.suspend === 'function' && !upfront) {
      const q = 128 / sr;
      make(0);
      for (let i = 1; i < BAKE.length; i++) {
        oc.suspend(Math.floor(offs[i] / q) * q).then(() => { try { make(i); } finally { oc.resume(); } }, noop);
      }
    } else for (let i = 0; i < BAKE.length; i++) make(i);
    const rendered = await new Promise((res, rej) => {
      oc.oncomplete = (e) => res(e.renderedBuffer);
      const p = oc.startRendering();
      if (p && p.then) p.then(res, rej);
    });
    if (made !== BAKE.length) throw new Error('bake: ' + made + ' of ' + BAKE.length + ' entries rendered');
    const smp = {};
    const fadeN = Math.floor(sr * 0.006);
    for (let i = 0; i < BAKE.length; i++) {
      const [key, , dur, mono] = BAKE[i];
      const start = Math.round(offs[i] * sr), n = Math.floor(dur * sr);
      const chs = mono ? 1 : 2;
      const b = this.ctx.createBuffer(chs, n, sr);
      for (let c = 0; c < chs; c++) {
        const d = b.getChannelData(c);
        d.set(rendered.getChannelData(c).subarray(start, start + n));
        for (let k = 0; k < fadeN; k++) d[n - 1 - k] *= k / fadeN;   // click-free tail
      }
      smp[key] = b;
    }
    this.smp = smp;
  }
}

// Chrome/WebKit/Gecko DynamicsCompressor adds automatic make-up gain ((1/fullRangeGain)^0.6).
// TRIM cancels it so quiet material passes the master at unity (measured, see dev/audio.html).
const TRIM = 0.724;

// ---------------------------------------------------------------- instruments
// Signature: fn(E, bus, t, midi | midi[], durSeconds, velocity, pan)
// `bus` = { out, verb, dly } (verb/dly may be null). Used by the sequencer and by SFX.

// Route a voice to its bus, panned. Tracks keep one shared panner per pan value (panTo);
// other buses get a per-voice panner.
function dst(E, b, node, pan) {
  if (!pan) node.connect(b.out);
  else if (b.panTo) node.connect(b.panTo(pan));
  else return E.out(node, b.out, pan);
  return null;
}

// Lead: 25 % pulse + detuned saw, resonant low-pass with a snappy envelope, delayed vibrato.
function iLead(E, b, t, m, dur, vel, pan) {
  const f = mtof(m), end = t + dur, stop = end + 0.4;
  const o1 = E.osc('p25', f, t, stop);
  const o2 = E.osc('sawtooth', f, t, stop);
  o2.detune.setValueAtTime(8, t);
  const lp = E.filt('lowpass', 1100, 2.4, t);
  lp.frequency.linearRampToValueAtTime(5400, t + 0.012);
  lp.frequency.setTargetAtTime(2500, t + 0.012, 0.16);
  const s2 = E.gain(0.6);
  const a = E.gain(0);
  adsr(a.gain, t, 0.005, 0.26 * vel, 0.14, 0.72, end, 0.05);
  o1.connect(lp); o2.connect(s2); s2.connect(lp); lp.connect(a);
  if (dur > 0.24) E.vibrato(t, stop, 0.14, 16, [o1.detune, o2.detune]);
  E.fin(o1, a, dst(E, b, a, pan));
  if (b.verb) a.connect(b.verb);
  if (b.dly) a.connect(b.dly);
}

// Brass: 2-operator FM (ratio 1) with index swell + a quiet saw for body.
function iBrass(E, b, t, m, dur, vel, pan) {
  const f = mtof(m), end = t + dur, stop = end + 0.45;
  const car = E.osc('sine', f, t, stop);
  const mod = E.osc('sine', f, t, stop);
  const mi = E.gain(0);
  const ie = Math.max(end, t + 0.06);
  mi.gain.setValueAtTime(f * 0.3, t);
  mi.gain.linearRampToValueAtTime(f * 2.3, t + 0.05);
  mi.gain.setTargetAtTime(f * 1.25, t + 0.05, 0.22);
  mi.gain.setTargetAtTime(f * 0.3, ie, 0.07);
  mod.connect(mi); mi.connect(car.frequency);
  const saw = E.osc('sawtooth', f, t, stop);
  saw.detune.setValueAtTime(-7, t);
  const sg = E.gain(0.22);
  const lp = E.filt('lowpass', 3000, 0.8, t);
  const a = E.gain(0);
  adsr(a.gain, t, 0.03, 0.25 * vel, 0.3, 0.78, end, 0.09);
  car.connect(lp); saw.connect(sg); sg.connect(lp); lp.connect(a);
  if (dur > 0.3) E.vibrato(t, stop, 0.2, 13, [car.detune, saw.detune]);
  E.fin(car, a, dst(E, b, a, pan));
  if (b.verb) a.connect(b.verb);
  if (b.dly) a.connect(b.dly);
}

// Bass: FM "slap" (ratio 1, index 4.5 → 1.1) through a gentle low-pass.
function iBass(E, b, t, m, dur, vel) {
  const end = t + dur;
  if (E.smp) {
    const base = m < 46 ? 40 : 52;
    const g = E.buf(E.smp['bass' + base], t, semis(m - base), vel, b.out);
    g.gain.setValueAtTime(vel, t);
    g.gain.setTargetAtTime(0, Math.max(end - 0.012, t + 0.01), 0.018);
    E.lastSrc.stop(end + 0.15);
    return;
  }
  const f = mtof(m), stop = end + 0.12;
  const car = E.osc('sine', f, t, stop);
  const mod = E.osc('sine', f, t, stop);
  const mi = E.gain(0);
  mi.gain.setValueAtTime(f * 4.6 * vel, t);
  mi.gain.setTargetAtTime(f * 1.15, t, 0.06);
  mod.connect(mi); mi.connect(car.frequency);
  const lp = E.filt('lowpass', 2100, 0.9, t);
  const a = E.gain(0);
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(0.27 * vel, t + 0.004);
  a.gain.setTargetAtTime(0.19 * vel, t + 0.004, 0.14);
  a.gain.setTargetAtTime(0, Math.max(end - 0.012, t + 0.01), 0.018);
  car.connect(lp); lp.connect(a); a.connect(b.out);
  E.fin(car, a);
}

// Arp: thin 12.5 % pulse, plucky.
function iArp(E, b, t, m, dur, vel, pan) {
  if (E.smp) {
    const base = m < 61 ? 55 : m < 73 ? 67 : 79;
    const g = E.buf(E.smp['arp' + base], t, semis(m - base), vel, b.panTo ? b.panTo(pan) : b.out, b.dly);
    return g;
  }
  const o = E.osc('p12', mtof(m), t, t + 0.4);
  const lp = E.filt('lowpass', 4200, 0.6, t);
  lp.frequency.setTargetAtTime(2200, t + 0.005, 0.08);
  const a = E.gain(0);
  pluck(a.gain, t, 0.3 * vel, 0.085);
  o.connect(lp); lp.connect(a);
  E.fin(o, a, dst(E, b, a, pan));
  if (b.dly) a.connect(b.dly);
}

// Bell: FM ratio 3.5 (DX-style inharmonic bell).
function iBell(E, b, t, m, dur, vel, pan) {
  if (E.smp) {
    const base = m < 73 ? 67 : m < 85 ? 79 : 91;
    const g = E.buf(E.smp['bell' + base], t, semis(m - base), vel, b.panTo ? b.panTo(pan) : b.out, b.verb);
    if (b.dly) g.connect(b.dly);
    return;
  }
  const f = mtof(m), stop = t + 1.5;
  const car = E.osc('sine', f, t, stop);
  const mod = E.osc('sine', f * 3.5, t, stop);
  const mi = E.gain(0);
  mi.gain.setValueAtTime(f * 2.0, t);
  mi.gain.setTargetAtTime(0, t, 0.2);
  mod.connect(mi); mi.connect(car.frequency);
  const a = E.gain(0);
  pluck(a.gain, t, 0.11 * vel, 0.34);
  car.connect(a);
  E.fin(car, a, dst(E, b, a, pan));
  if (b.verb) a.connect(b.verb);
  if (b.dly) a.connect(b.dly);
}

// Pad: detuned saw pairs through one slow-moving low-pass (m is an array of midi notes).
function iPad(E, b, t, notes, dur, vel) {
  const end = t + dur, stop = end + 0.9;
  const lp = E.filt('lowpass', 650, 1.1, t);
  lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.55);
  lp.frequency.linearRampToValueAtTime(800, end + 0.3);
  const a = E.gain(0);
  adsr(a.gain, t, 0.22, 0.042 * vel, 0.6, 0.8, end, 0.22);
  const chorus = b.padBus ? b.padBus() : null;   // tracks: one shared chorus instead of detuned pairs
  for (let i = 0; i < notes.length; i++) {
    const f = mtof(notes[i]);
    const x = E.osc('sawtooth', f, t, stop);
    x.detune.setValueAtTime(i % 2 ? 6 : -6, t);
    x.connect(lp);
    if (!chorus) { const y = E.osc('sawtooth', f, t, stop); y.detune.setValueAtTime(i % 2 ? -8 : 8, t); y.connect(lp); }
    if (i === 0) E.fin(x, a);
  }
  lp.connect(a);
  a.connect(chorus || b.out);
  if (b.verb) a.connect(b.verb);
}

// Stab: square chord hit with a closing filter.
function iStab(E, b, t, notes, dur, vel) {
  const stop = t + 0.35;
  const lp = E.filt('lowpass', 3600, 2, t);
  lp.frequency.setTargetAtTime(500, t + 0.01, 0.06);
  const a = E.gain(0);
  pluck(a.gain, t, 0.11 * vel, 0.09);
  for (let i = 0; i < notes.length; i++) {
    const o = E.osc('square', mtof(notes[i] + 12), t, stop);
    o.connect(lp);
    if (i === 0) E.fin(o, a);
  }
  lp.connect(a); a.connect(b.out);
  if (b.verb) a.connect(b.verb);
}

// Reed: a nasal double reed (zurna / shehnai), stage 2's desert voice. A narrow pulse plus a
// quiet saw through a formant peak, a small scoop up into every note and a vibrato quicker
// and deeper than the lead's.
function iReed(E, b, t, m, dur, vel, pan) {
  const f = mtof(m), end = t + dur, stop = end + 0.3;
  const o1 = E.osc('p12', f, t, stop);
  const o2 = E.osc('sawtooth', f, t, stop);
  o1.detune.setValueAtTime(-28, t);
  o1.detune.linearRampToValueAtTime(0, t + 0.028);
  o2.detune.setValueAtTime(-34, t);
  o2.detune.linearRampToValueAtTime(-6, t + 0.028);
  const s2 = E.gain(0.4);
  const pk = E.filt('peaking', 1450, 1.4, t);
  pk.gain.value = 9;
  const lp = E.filt('lowpass', 4300, 0.7, t);
  const a = E.gain(0);
  adsr(a.gain, t, 0.012, 0.22 * vel, 0.12, 0.8, end, 0.045);
  o1.connect(pk); o2.connect(s2); s2.connect(pk); pk.connect(lp); lp.connect(a);
  if (dur > 0.2) E.vibrato(t, stop, 0.09, 24, [o1.detune, o2.detune]);
  E.fin(o1, a, dst(E, b, a, pan));
  if (b.verb) a.connect(b.verb);
  if (b.dly) a.connect(b.dly);
}

// Pluck: an oud-like plucked string. FM (ratio 1) whose index falls within ~80 ms, a pick
// click, and an attack a little sharp that settles onto pitch. Baked in three registers.
function iPluck(E, b, t, m, dur, vel, pan) {
  if (E.smp) {
    const base = m < 61 ? 55 : m < 73 ? 67 : 79;
    return E.buf(E.smp['pluck' + base], t, semis(m - base), vel, b.panTo ? b.panTo(pan) : b.out, b.dly);
  }
  const f = mtof(m), stop = t + 0.75;
  const car = E.osc('sine', f, t, stop);
  const mod = E.osc('sine', f, t, stop);
  const mi = E.gain(0);
  mi.gain.setValueAtTime(f * 2.8, t);
  mi.gain.setTargetAtTime(f * 0.3, t, 0.045);
  mod.connect(mi); mi.connect(car.frequency);
  car.detune.setValueAtTime(20, t);
  car.detune.setTargetAtTime(0, t, 0.012);
  const a = E.gain(0);
  pluck(a.gain, t, 0.18 * vel, 0.15);
  car.connect(a);
  const n = E.noise(t, t + 0.02, 1);
  const bp = E.filt('bandpass', 2600, 1.2, t);
  const c = E.gain(0);
  pluck(c.gain, t, 0.5 * vel, 0.004, 0.0005);
  n.connect(bp); bp.connect(c); c.connect(a);
  E.fin(car, a, dst(E, b, a, pan));
  if (b.dly) a.connect(b.dly);
}

// Choir: an "aah" pad. Saws through two vowel formants (F1 ≈ 750 Hz, F2 ≈ 1200 Hz) with a slow
// swell; the track's chorus gives it width and movement. No per-voice vibrato: modulating
// three oscillators' detune costs a per-sample pitch computation each, which doubled the
// cost of a whole intro. `notes` is an array of midi notes.
function iChoir(E, b, t, notes, dur, vel) {
  const end = t + dur, stop = end + 1.1;
  const f1 = E.filt('bandpass', 760, 2.4, t);
  const f2 = E.filt('bandpass', 1220, 3.4, t);
  const g2 = E.gain(0.55);
  const a = E.gain(0);
  adsr(a.gain, t, 0.32, 0.11 * vel, 0.7, 0.85, end, 0.32);
  for (let i = 0; i < notes.length; i++) {
    const x = E.osc('sawtooth', mtof(notes[i]), t, stop);
    x.detune.value = i % 2 ? 7 : -7;
    x.connect(f1); x.connect(f2);
    if (i === 0) E.fin(x, a);
  }
  f1.connect(a); f2.connect(g2); g2.connect(a);
  const chorus = b.padBus ? b.padBus() : null;
  a.connect(chorus || b.out);
  if (b.verb) a.connect(b.verb);
}

// Glass: a crystal tine (stages 7-8: crystal ships, star clusters). FM on a harmonic ratio (4:1)
// whose index falls within ~50 ms onto a nearly pure sine, and a faint inharmonic shimmer
// partial that dies first: purer and brighter than the bell. Baked in three registers.
function iGlass(E, b, t, m, dur, vel, pan) {
  if (E.smp) {
    const base = m < 73 ? 67 : m < 85 ? 79 : 91;
    const g = E.buf(E.smp['glass' + base], t, semis(m - base), vel, b.panTo ? b.panTo(pan) : b.out, b.verb);
    if (b.dly) g.connect(b.dly);
    return;
  }
  const f = mtof(m), stop = t + 1.1;
  const car = E.osc('sine', f, t, stop);
  const mod = E.osc('sine', f * 4, t, stop);
  const mi = E.gain(0);
  mi.gain.setValueAtTime(f * 2.4, t);
  mi.gain.setTargetAtTime(f * 0.12, t, 0.05);
  mod.connect(mi); mi.connect(car.frequency);
  const a = E.gain(0);
  pluck(a.gain, t, 0.1 * vel, 0.24);
  car.connect(a);
  const sh = E.osc('sine', f * 5.43, t, t + 0.35);
  const sg = E.gain(0);
  pluck(sg.gain, t, 0.3, 0.05);
  sh.connect(sg); sg.connect(a);
  E.fin(car, a, dst(E, b, a, pan));
  if (b.verb) a.connect(b.verb);
  if (b.dly) a.connect(b.dly);
}

// Overdrive transfer curve (tanh, drive 4.2, normalised to ±1), shared by every distorted voice.
// (A WaveShaper copies the curve it is given, so one array serves every node.)
let DRIVE = null;
function driveCurve() {
  if (DRIVE) return DRIVE;
  const n = 1024, c = new Float32Array(n), k = 4.2, nk = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1)) / nk;
  return (DRIVE = c);
}

// Driven lead: a saw plus a quieter square an octave down through an overdrive and a
// cabinet-like low-pass — a distorted guitar-ish solo voice for the boss themes. Every note
// bends up into pitch from a little flat, like a picked string. One shaper per note (a shared
// one would intermodulate the harmony line against the melody).
function iDLead(E, b, t, m, dur, vel, pan) {
  const f = mtof(m), end = t + dur, stop = end + 0.25;
  const o1 = E.osc('sawtooth', f, t, stop);
  const o2 = E.osc('square', f * 0.5, t, stop);
  o1.frequency.setValueAtTime(f * 0.982, t);
  o1.frequency.linearRampToValueAtTime(f, t + 0.03);
  o2.frequency.setValueAtTime(f * 0.491, t);
  o2.frequency.linearRampToValueAtTime(f * 0.5, t + 0.03);
  const s2 = E.gain(0.3);
  const pre = E.gain(0.55);
  const ws = E.ctx.createWaveShaper();
  ws.curve = driveCurve();
  const lp = E.filt('lowpass', 3300, 1.6, t);
  const a = E.gain(0);
  adsr(a.gain, t, 0.004, 0.19 * vel, 0.18, 0.82, end, 0.045);
  o1.connect(pre); o2.connect(s2); s2.connect(pre); pre.connect(ws); ws.connect(lp); lp.connect(a);
  if (dur > 0.24) E.vibrato(t, stop, 0.16, 18, [o1.detune, o2.detune]);
  E.fin(o1, a, dst(E, b, a, pan));
  if (b.verb) a.connect(b.verb);
  if (b.dly) a.connect(b.dly);
}

// --- drums (all baked at init: layers are free at run time)

// Kick: sine sub drop + a short triangle "knock" (what carries it on phone speakers) + beater click.
function dKick(E, b, t, m, dur, vel) {
  if (E.smp) { E.buf(E.smp.kick, t, 1, vel, b.out); return; }
  const mix = E.gain(vel);
  mix.connect(b.out);
  const o = E.osc('sine', 150, t, t + 0.45);
  o.frequency.exponentialRampToValueAtTime(47, t + 0.1);
  const a = E.gain(0);
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(0.4, t + 0.002);
  a.gain.setTargetAtTime(0, t + 0.03, 0.08);
  o.connect(a); a.connect(mix);
  const k = E.osc('triangle', 360, t, t + 0.15);
  k.frequency.exponentialRampToValueAtTime(110, t + 0.05);
  const ka = E.gain(0);
  pluck(ka.gain, t, 0.3, 0.03, 0.001);
  k.connect(ka); ka.connect(mix);
  const n = E.noise(t, t + 0.03, 1);
  const bp = E.filt('bandpass', 3800, 0.9, t);
  const c = E.gain(0);
  pluck(c.gain, t, 0.3, 0.004, 0.0005);
  n.connect(bp); bp.connect(c); c.connect(mix);
  E.fin(o, mix);
}

// Snare: mid-band crack + high sizzle (one noise source) over two tuned body tones.
function dSnare(E, b, t, m, dur, vel) {
  if (E.smp) { E.buf(E.smp.snare, t, 1, vel, b.out, b.verb); return; }
  const mix = E.gain(vel);
  mix.connect(b.out);
  if (b.verb) mix.connect(b.verb);
  const n = E.noise(t, t + 0.42, 1);
  const bp = E.filt('bandpass', 1900, 0.6, t);
  const a = E.gain(0);
  pluck(a.gain, t, 0.8, 0.07, 0.0008);
  n.connect(bp); bp.connect(a); a.connect(mix);
  const hp = E.filt('highpass', 5200, 0.7, t);
  const a2 = E.gain(0);
  pluck(a2.gain, t, 0.36, 0.055, 0.0008);
  n.connect(hp); hp.connect(a2); a2.connect(mix);
  const o = E.osc('triangle', 235, t, t + 0.2);
  o.frequency.exponentialRampToValueAtTime(172, t + 0.05);
  const c = E.gain(0);
  pluck(c.gain, t, 0.55, 0.04);
  o.connect(c); c.connect(mix);
  const o2 = E.osc('sine', 345, t, t + 0.15);
  o2.frequency.exponentialRampToValueAtTime(290, t + 0.04);
  const c2 = E.gain(0);
  pluck(c2.gain, t, 0.22, 0.028);
  o2.connect(c2); c2.connect(mix);
  E.fin(n, mix);
}

// Hi-hats: six square partials (808-style metal) + noise, band-passed high.
const HAT_F = [205.3, 304.4, 369.6, 522.7, 540, 800];
function hatCore(E, b, t, vel, tau, len, pan) {
  const mix = E.gain(0);
  pluck(mix.gain, t, vel, tau, 0.0008);
  const bp = E.filt('bandpass', 9500, 0.9, t);
  const hp = E.filt('highpass', 6800, 0.7, t);
  for (let i = 0; i < HAT_F.length; i++) { const o = E.osc('square', HAT_F[i], t, t + len); o.connect(bp); }
  const mg = E.gain(0.16);
  bp.connect(mg); mg.connect(hp);
  const n = E.noise(t, t + len, 1);
  const ng = E.gain(0.55);
  n.connect(ng); ng.connect(hp);
  hp.connect(mix);
  E.fin(n, mix, E.out(mix, b.out, pan));
}
function dHat(E, b, t, m, dur, vel) {
  if (E.smp) { E.buf(E.smp.hat, t, 1, vel, b.out); return; }
  hatCore(E, b, t, 0.8 * vel, 0.026, 0.16, 0.18);
}
function dOHat(E, b, t, m, dur, vel) {
  if (E.smp) { E.buf(E.smp.ohat, t, 1, vel, b.out); return; }
  hatCore(E, b, t, 0.5 * vel, 0.13, 0.6, 0.18);
}

function dCrash(E, b, t, m, dur, vel) {
  if (E.smp) { E.buf(E.smp.crash, t, 1, vel, b.out, b.verb); return; }
  const n = E.noise(t, t + 2.2, 0.9);
  const hp = E.filt('highpass', 4200, 0.6, t);
  const a = E.gain(0);
  pluck(a.gain, t, 0.18 * vel, 0.5, 0.004);
  n.connect(hp); hp.connect(a);
  E.fin(n, a, E.out(a, b.out, -0.2));
  if (b.verb) a.connect(b.verb);
}

function dTom(E, b, t, m, dur, vel) {
  if (E.smp) { E.buf(E.smp['tom' + m], t, 1, vel, b.out, b.verb); return; }
  const f = mtof(m);
  const o = E.osc('sine', f, t, t + 0.4);
  o.frequency.exponentialRampToValueAtTime(f * 0.62, t + 0.2);
  const a = E.gain(0);
  pluck(a.gain, t, 0.5 * vel, 0.11);
  o.connect(a);
  const pp = E.out(a, b.out, (m - 52) * 0.04);
  if (b.verb) a.connect(b.verb);
  const n = E.noise(t, t + 0.04, 0.7);
  const c = E.gain(0);
  pluck(c.gain, t, 0.07 * vel, 0.008);
  n.connect(c); c.connect(b.out);
  E.fin(o, a, c, pp);
}

// Clank: a struck steel plate, the machinery in boss 2's groove. An inharmonic FM ring, a
// bright square partial and a noise tick.
function dClank(E, b, t, m, dur, vel) {
  if (E.smp) { E.buf(E.smp.clank, t, 1, vel, b.out, b.verb); return; }
  const mix = E.gain(vel);
  mix.connect(b.out);
  if (b.verb) mix.connect(b.verb);
  const f = 587;
  const car = E.osc('sine', f, t, t + 0.42);
  const mod = E.osc('sine', f * 2.41, t, t + 0.42);
  const mi = E.gain(0);
  mi.gain.setValueAtTime(f * 3, t);
  mi.gain.setTargetAtTime(f * 0.5, t, 0.04);
  mod.connect(mi); mi.connect(car.frequency);
  const a = E.gain(0);
  pluck(a.gain, t, 0.22, 0.08, 0.0008);
  car.connect(a); a.connect(mix);
  const o2 = E.osc('square', 1733, t, t + 0.25);
  const bp = E.filt('bandpass', 3400, 2, t);
  const a2 = E.gain(0);
  pluck(a2.gain, t, 0.07, 0.05, 0.0008);
  o2.connect(bp); bp.connect(a2); a2.connect(mix);
  const n = E.noise(t, t + 0.03, 1);
  const hp = E.filt('highpass', 5000, 0.7, t);
  const c = E.gain(0);
  pluck(c.gain, t, 0.3, 0.006, 0.0005);
  n.connect(hp); hp.connect(c); c.connect(mix);
  E.fin(car, mix);
}

// Drag: two snare strokes a 32nd apart inside one 16th step (`dur` = the step), soft then
// strong — the militant rudiment, and a 32nd roll when repeated.
function dDrag(E, b, t, m, dur, vel) {
  dSnare(E, b, t, 0, 0, 0.45 * vel);
  dSnare(E, b, t + dur * 0.5, 0, 0, 0.82 * vel);
}

// --- power chords and brass hits (baked at init, played back transposed)

// Power-chord guitar: one take = root, fifth and octave as slightly detuned saws → a string
// envelope and a pick-bright low-pass → overdrive → speaker cabinet (high-pass, scooped mids,
// presence peak, two low-passes). Open chords ring with a slow decay; palm mutes ("chugs") are
// short and dark (the damped strings: a low-pass closing within ~40 ms before the drive, and a
// fast decay after it). `dest` is one channel of the take.
function gtrTake(E, dest, t, root, mute, side) {
  const len = mute ? 0.34 : 2.1, stop = t + len;
  const mix = E.gain(0);
  mix.gain.setValueAtTime(0, t);
  mix.gain.linearRampToValueAtTime(mute ? 0.5 : 0.42, t + 0.002);
  mix.gain.setTargetAtTime(mute ? 0.1 : 0.2, t + 0.002, mute ? 0.05 : 0.6);
  const iv = [0, 7, 12];
  for (let i = 0; i < 3; i++) {
    const o = E.osc('sawtooth', mtof(root + iv[i]), t, stop);
    o.detune.setValueAtTime((side ? 1 : -1) * (4 + i * 3), t);
    o.connect(mix);
  }
  const pick = E.filt('lowpass', mute ? 1900 : 5200, 0.8, t);
  pick.frequency.setTargetAtTime(mute ? 380 : 2700, t + 0.003, mute ? 0.035 : 0.3);
  const ws = E.ctx.createWaveShaper();
  ws.curve = driveCurve();
  ws.oversample = '2x';
  const hp = E.filt('highpass', mute ? 75 : 95, 0.7, t);
  const scoop = E.filt('peaking', 720, 0.9, t);
  scoop.gain.value = -6;
  const pres = E.filt('peaking', 2500, 1.1, t);
  pres.gain.value = 3.5;
  const cab = E.filt('lowpass', 4200, 1.1, t);
  const cab2 = E.filt('lowpass', 6200, 0.5, t);
  const out = E.gain(0);
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(0.2, t + 0.003);
  if (mute) out.gain.setTargetAtTime(0, t + 0.05, 0.06);
  else { out.gain.setTargetAtTime(0.13, t + 0.003, 0.5); out.gain.setTargetAtTime(0, stop - 0.12, 0.03); }
  mix.connect(pick); pick.connect(ws); ws.connect(hp); hp.connect(scoop); scoop.connect(pres);
  pres.connect(cab); cab.connect(cab2); cab2.connect(out); out.connect(dest);
}
// Double-tracked: two takes (mirrored detune) hard left and right, the right one 7 ms late.
function gtrPatch(E, b, t, root, mute) {
  const mg = E.ctx.createChannelMerger(2), l = E.gain(1), r = E.gain(1);
  l.connect(mg, 0, 0); r.connect(mg, 0, 1);
  mg.connect(b.out);
  gtrTake(E, l, t, root, mute, 0);
  gtrTake(E, r, t + 0.007, root, mute, 1);
}
// Until the bake lands: one lean take (root + fifth, 2 saws) instead of 12 saws and 2 shapers.
function gtrLive(E, b, t, m, dur, vel, mute) {
  const end = t + dur, stop = end + 0.12;
  const pre = E.gain(0.3);
  const o = E.osc('sawtooth', mtof(m), t, stop);
  o.connect(pre);
  E.osc('sawtooth', mtof(m + 7), t, stop).connect(pre);
  const ws = E.ctx.createWaveShaper();
  ws.curve = driveCurve();
  const lp = E.filt('lowpass', mute ? 900 : 3400, 0.9, t);
  const a = E.gain(0);
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(0.1 * vel, t + 0.003);
  a.gain.setTargetAtTime(0, mute ? t + 0.04 : end, mute ? 0.05 : 0.025);
  pre.connect(ws); ws.connect(lp); lp.connect(a);
  E.fin(o, a, dst(E, b, a, 0));
}
// Open power chord on root `m` (E2..D#3), rung for `dur` s, cut with a short release.
// GTR_LV: the guitars' place in the mix, ~3 dB under the lead.
const GTR_LV = 0.72;
function iGtr(E, b, t, m, dur, vel) {
  if (!E.smp) return gtrLive(E, b, t, m, dur, vel, false);
  const base = m < 45 ? 42 : 48, end = t + dur, lv = GTR_LV * vel;
  const g = E.buf(E.smp['gtr' + base], t, semis(m - base), lv, b.out, b.verb);
  g.gain.setValueAtTime(lv, t);
  g.gain.setTargetAtTime(0, Math.max(end - 0.015, t + 0.02), 0.022);
  E.lastSrc.stop(end + 0.15);
}
// Palm-muted chug on root `m`.
function iChug(E, b, t, m, dur, vel) {
  if (!E.smp) return gtrLive(E, b, t, m, 0.1, vel, true);
  const base = m < 45 ? 42 : 48;
  E.buf(E.smp['chug' + base], t, semis(m - base), GTR_LV * vel, b.out);
}

// Power hit: a brass-section stab on a voicing with no third (root below, root, fifth,
// octave, twelfth), so it fits major and minor chords alike — FM brass whose index falls fast,
// bright detuned saws under a closing low-pass, a timpani-like thump and a noise bite.
function hitPatch(E, b, t, root) {
  const out = E.gain(1);
  out.connect(b.out);
  const lp = E.filt('lowpass', 5200, 0.9, t);
  lp.frequency.setTargetAtTime(1300, t + 0.02, 0.16);
  const a = E.gain(0);
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(0.095, t + 0.006);
  a.gain.setTargetAtTime(0.055, t + 0.006, 0.09);
  a.gain.setTargetAtTime(0, t + 0.28, 0.12);
  const notes = [root - 12, root, root + 7, root + 12, root + 19];
  for (let i = 0; i < notes.length; i++) {
    const f = mtof(notes[i]), stop = t + 1.1;
    const car = E.osc('sine', f, t, stop), mod = E.osc('sine', f, t, stop), mi = E.gain(0);
    mi.gain.setValueAtTime(f * 3.4, t);
    mi.gain.setTargetAtTime(f * 1.0, t, 0.07);
    mod.connect(mi); mi.connect(car.frequency);
    const saw = E.osc('sawtooth', f, t, stop);
    saw.detune.setValueAtTime(i % 2 ? 9 : -9, t);
    const sg = E.gain(0.45);
    car.connect(a); saw.connect(sg); sg.connect(lp);
  }
  lp.connect(a);
  a.connect(out);
  const o = E.osc('sine', 120, t, t + 0.6);
  o.frequency.exponentialRampToValueAtTime(52, t + 0.12);
  const th = E.gain(0);
  pluck(th.gain, t, 0.24, 0.11, 0.002);
  o.connect(th); th.connect(out);
  const n = E.noise(t, t + 0.12, 1);
  const bp = E.filt('bandpass', 1700, 0.8, t);
  const c = E.gain(0);
  pluck(c.gain, t, 0.22, 0.025, 0.001);
  n.connect(bp); bp.connect(c); c.connect(out);
}
function iHit(E, b, t, m, dur, vel) {
  if (!E.smp) {       // until the bake lands: two brass notes and a kick
    iBrass(E, b, t, m, 0.12, vel, 0);
    iBrass(E, b, t, m + 7, 0.12, 0.8 * vel, 0);
    return dKick(E, b, t, 0, 0, 0.6 * vel);
  }
  const base = m < 48 ? 45 : 51;
  E.buf(E.smp['hit' + base], t, semis(m - base), vel, b.out, b.verb);
}

// Riser: a noise band sweeping up over `dur` s and swelling, cut on the downbeat it leads to
// (the tension build into every loop point). Rare, so it stays live.
function iRiser(E, b, t, m, dur, vel) {
  const end = t + dur;
  const n = E.noise(t, end + 0.03, 1);
  const bp = E.filt('bandpass', 380, 1.4, t);
  bp.frequency.exponentialRampToValueAtTime(7500, end);
  const g = E.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.13 * vel, end - 0.012);
  g.gain.linearRampToValueAtTime(0, end + 0.012);
  n.connect(bp); bp.connect(g);
  E.fin(n, g, dst(E, b, g, 0));
  if (b.verb) g.connect(b.verb);
}

// ---------------------------------------------------------------- sound effects
// Signature: fn(E, bus, t, pitchSemitones, vol) → duration (s). Layered: transient + body + tail.

// Generic explosion. sz ≈ 0 (pop) … 3 (bomb). r = pitch ratio.
function boom(E, b, t, sz, r, v) {
  const body = 0.3 + sz * 0.55;
  // transient crack
  const n0 = E.noise(t, t + 0.06, 1.2);
  const h0 = E.filt('highpass', 1300, 0.7, t);
  const g0 = E.gain(0);
  pluck(g0.gain, t, (0.26 + sz * 0.04) * v, 0.009, 0.001);
  n0.connect(h0); h0.connect(g0); g0.connect(b.out);
  // roaring body: noise through a closing low-pass
  const n1 = E.noise(t, t + body * 3.2, 0.85 * r);
  const l1 = E.filt('lowpass', 3400 * r, 0.9, t);
  l1.frequency.exponentialRampToValueAtTime(Math.max(90, 190 - sz * 30), t + body);
  const g1 = E.gain(0);
  g1.gain.setValueAtTime(0, t);
  g1.gain.linearRampToValueAtTime((0.4 + sz * 0.06) * v, t + 0.004);
  g1.gain.setTargetAtTime(0, t + 0.03, body * 0.42);
  n1.connect(l1); l1.connect(g1); g1.connect(b.out);
  if (b.verb) g1.connect(b.verb);
  // sub thump
  const o = E.osc('sine', 170 * r, t, t + body * 2.5);
  o.frequency.exponentialRampToValueAtTime(34, t + 0.07 + sz * 0.16);
  const g2 = E.gain(0);
  pluck(g2.gain, t, (0.45 + sz * 0.08) * v, 0.05 + sz * 0.11, 0.003);
  o.connect(g2); g2.connect(b.out);
  // mid-band punch (a 700 Hz thud + a falling knock): what carries the hit on phone speakers,
  // which can't reproduce the sub
  const n2 = E.noise(t, t + 0.35 + sz * 0.2, 1);
  const b2 = E.filt('bandpass', 720 * r, 0.8, t);
  const g4 = E.gain(0);
  pluck(g4.gain, t, (0.5 + sz * 0.05) * v, 0.045 + sz * 0.035, 0.001);
  n2.connect(b2); b2.connect(g4); g4.connect(b.out);
  const kn = E.osc('triangle', 440 * r, t, t + 0.3 + sz * 0.2);
  kn.frequency.exponentialRampToValueAtTime(120 * r, t + 0.07 + sz * 0.03);
  const g5 = E.gain(0);
  pluck(g5.gain, t, 0.3 * v, 0.05 + sz * 0.04, 0.002);
  kn.connect(g5); g5.connect(b.out);
  // debris crackle (medium and up)
  if (sz >= 0.6) {
    const c = E.noise(t + 0.02, t + body * 3, 1, E.crackleBuf);
    const bp = E.filt('bandpass', 1700 * r, 0.6, t);
    const g3 = E.gain(0);
    g3.gain.setValueAtTime(0, t);
    g3.gain.linearRampToValueAtTime(0.32 * v, t + 0.05);
    g3.gain.setTargetAtTime(0, t + 0.06, 0.12 + sz * 0.2);
    c.connect(bp); bp.connect(g3); g3.connect(b.out);
  }
  return body * 3;
}

function rumble(E, b, t, len, v) {
  const n = E.noise(t, t + len + 0.5, 0.3);
  const lp = E.filt('lowpass', 320, 0.7, t);
  lp.frequency.exponentialRampToValueAtTime(90, t + len);
  const g = E.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.55 * v, t + 0.08);
  g.gain.setTargetAtTime(0, t + 0.1, len * 0.33);
  n.connect(lp); lp.connect(g); g.connect(b.out);
  if (b.verb) g.connect(b.verb);
}

function sizzle(E, b, t, len, v) {
  const n = E.noise(t, t + len + 0.3, 1);
  const hp = E.filt('highpass', 5200, 0.5, t);
  const g = E.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.06 * v, t + 0.06);
  g.gain.setTargetAtTime(0, t + 0.08, len * 0.3);
  n.connect(hp); hp.connect(g);
  E.out(g, b.out, 0.3);
}

function blip(E, b, t, type, f, f2, len, peak, tau) {
  const o = E.osc(type, f, t, t + len + tau * 6);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + len);
  const g = E.gain(0);
  pluck(g.gain, t, peak, tau);
  o.connect(g); g.connect(b.out);
  return g;
}

const SFXFN = {
  // Vulcan: mostly-noise "tsk" with a soft low thup, random pitch — fatigue-free at 10 Hz.
  shot(E, b, t, p, v) {
    const r = semis(p + (Math.random() - 0.5) * 1.2);
    const n = E.noise(t, t + 0.06, 1);
    const bp = E.filt('bandpass', 2900 * r, 1.1, t);
    bp.frequency.exponentialRampToValueAtTime(1300 * r, t + 0.04);
    const g = E.gain(0);
    pluck(g.gain, t, 0.085 * v, 0.011, 0.001);
    n.connect(bp); bp.connect(g); g.connect(b.out);
    blip(E, b, t, 'triangle', 460 * r, 210 * r, 0.035, 0.07 * v, 0.014);
    return 0.08;
  },
  // Blue laser: a continuous beam voice. The game may call play('laser') every frame: calls
  // within `hold` s keep this one voice alive (no new nodes), so it sounds as a steady 15 Hz
  // stream of soft falling chirps driven by one LFO, independent of the frame rate, and it
  // releases ~0.1 s after the last call. A single call gives one short "tsiu".
  laser(E, b, t, p, v) {
    const r = semis(p), stop = t + 2, src = E.hsrc;
    const env = E.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.setTargetAtTime(v, t, 0.008);
    env.gain.setTargetAtTime(0, t + SFX.laser.hold, 0.03);
    E.henv = env;
    // one rising-ramp LFO: pitch falls across each cycle (detune +150 → -150 cents) and the
    // amplitude decays with it, so every cycle is a little "tsiu"
    const lfo = E.osc('sawtooth', 15, t, stop);
    const pd = E.gain(-150);
    const am = E.gain(0.5);            // 0.5 - 0.42 * ramp → 0.92 … 0.08 per cycle
    const ad = E.gain(-0.42);
    const sm = E.filt('lowpass', 220, 0.5, t);   // round off the ramp's reset: no click per cycle
    lfo.connect(pd); lfo.connect(sm); sm.connect(ad); ad.connect(am.gain);
    const o1 = E.osc('triangle', 1318.5 * r, t, stop);
    const o2 = E.osc('sine', 2637 * r, t, stop);
    o2.detune.setValueAtTime(7, t);
    pd.connect(o1.detune); pd.connect(o2.detune);
    const tg = E.gain(0.55), hg = E.gain(0.16);
    o1.connect(tg); o2.connect(hg); tg.connect(am); hg.connect(am);
    const n = E.noise(t, stop, 1);
    const bp = E.filt('bandpass', 4200 * r, 0.9, t);
    const ng = E.gain(0.3);
    n.connect(bp); bp.connect(ng); ng.connect(am);
    const lp = E.filt('lowpass', 6500, 0.5, t);
    am.connect(lp); lp.connect(env); env.connect(b.out);
    src.push(lfo, o1, o2, n);
    return SFX.laser.hold + 0.2;
  },
  missile(E, b, t, p, v) {
    const r = semis(p + (Math.random() - 0.5) * 1.5);
    const n = E.noise(t, t + 0.6, 1);
    const bp = E.filt('bandpass', 520 * r, 1.8, t);
    bp.frequency.exponentialRampToValueAtTime(2300 * r, t + 0.3);
    const g = E.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13 * v, t + 0.02);
    g.gain.setTargetAtTime(0, t + 0.08, 0.11);
    n.connect(bp); bp.connect(g);
    E.out(g, b.out, 0);
    blip(E, b, t, 'sine', 230 * r, 90 * r, 0.05, 0.13 * v, 0.03);
    return 0.55;
  },
  // Bullet hits an enemy: a crisp "tk" (noise crack + falling pulse tick + a little body).
  hit(E, b, t, p, v) {
    const r = semis(p + (Math.random() - 0.5) * 2);
    const n = E.noise(t, t + 0.06, 1);
    const bp = E.filt('bandpass', 3600 * r, 1.1, t);
    const g = E.gain(0);
    pluck(g.gain, t, 0.2 * v, 0.011, 0.0008);
    n.connect(bp); bp.connect(g); g.connect(b.out);
    blip(E, b, t, 'p25', 2300 * r, 1400 * r, 0.025, 0.07 * v, 0.014);
    blip(E, b, t, 'triangle', 420 * r, 260 * r, 0.03, 0.09 * v, 0.016);
    return 0.07;
  },
  hitArmor(E, b, t, p, v) {
    const r = semis(p + (Math.random() - 0.5) * 1.5);
    const f = 1560 * r;
    const car = E.osc('sine', f, t, t + 0.35);
    const mod = E.osc('sine', f * 1.414, t, t + 0.35);
    const mi = E.gain(0);
    mi.gain.setValueAtTime(f * 1.8, t);
    mi.gain.setTargetAtTime(0, t, 0.05);
    mod.connect(mi); mi.connect(car.frequency);
    const g = E.gain(0);
    pluck(g.gain, t, 0.08 * v, 0.055);
    car.connect(g); g.connect(b.out);
    blip(E, b, t, 'sine', 3900 * r, 0, 0, 0.025 * v, 0.03);
    const n = E.noise(t, t + 0.02, 1);
    const hp = E.filt('highpass', 4200, 0.7, t);
    const c = E.gain(0);
    pluck(c.gain, t, 0.07 * v, 0.003, 0.001);
    n.connect(hp); hp.connect(c); c.connect(b.out);
    return 0.3;
  },
  explodeS(E, b, t, p, v) { return boom(E, b, t, 0.2, semis(p + (Math.random() - 0.5) * 3), v * 0.6); },
  explodeM(E, b, t, p, v) { return boom(E, b, t, 0.8, semis(p + (Math.random() - 0.5) * 2.5), v * 0.66); },
  explodeL(E, b, t, p, v) {
    const r = semis(p + (Math.random() - 0.5) * 2);
    v *= 0.8;
    const d = boom(E, b, t, 1.5, r, v);
    boom(E, b, t + 0.13, 0.5, r * 0.8, v * 0.55);
    return d;
  },
  bomb(E, b, t, p, v) {
    const r = semis(p);
    v *= 0.6;
    // pre-whoosh: noise band rising into the blast
    const n = E.noise(t, t + 0.4, 1);
    const bp = E.filt('bandpass', 300, 1.2, t);
    bp.frequency.exponentialRampToValueAtTime(3200, t + 0.16);
    const g = E.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2 * v, t + 0.14);
    g.gain.linearRampToValueAtTime(0, t + 0.2);
    n.connect(bp); bp.connect(g); g.connect(b.out);
    const t1 = t + 0.14;
    boom(E, b, t1, 2.6, r, v);
    boom(E, b, t1 + 0.28, 1.2, r * 0.75, v * 0.7);
    boom(E, b, t1 + 0.62, 0.9, r * 0.65, v * 0.55);
    const o = E.osc('sine', 62 * r, t1, t1 + 2.6);
    o.frequency.exponentialRampToValueAtTime(24, t1 + 1.6);
    const s = E.gain(0);
    pluck(s.gain, t1, 0.8 * v, 0.55, 0.01);
    o.connect(s); s.connect(b.out);
    rumble(E, b, t1, 3.0, v);
    sizzle(E, b, t1 + 0.1, 2.0, v);
    return 4.2;
  },
  // Pickup: two-step "bling" (E6 → B6) with an octave-down body and a high glint.
  item(E, b, t, p, v) {
    const r = semis(p);
    blip(E, b, t, 'p25', 1318.5 * r, 0, 0, 0.06 * v, 0.03);
    blip(E, b, t, 'triangle', 659.3 * r, 0, 0, 0.07 * v, 0.03);
    blip(E, b, t + 0.055, 'p25', 1975.5 * r, 0, 0, 0.065 * v, 0.08);
    blip(E, b, t + 0.055, 'triangle', 987.8 * r, 0, 0, 0.08 * v, 0.09);
    blip(E, b, t + 0.055, 'sine', 3951 * r, 0, 0, 0.022 * v, 0.09);
    return 0.45;
  },
  powerup(E, b, t, p, v) {
    const r = semis(p);
    const seq = POWERUP_NOTES;
    for (let i = 0; i < seq.length; i++) {
      const tt = t + i * 0.048;
      const f = mtof(seq[i]) * r;
      blip(E, b, tt, 'p12', f, 0, 0, 0.06 * v, i === seq.length - 1 ? 0.16 : 0.045);
      blip(E, b, tt + 0.022, 'p25', f * 1.004, 0, 0, 0.025 * v, 0.04);
    }
    const s = E.osc('sine', 330 * r, t, t + 0.5);
    s.frequency.exponentialRampToValueAtTime(1320 * r, t + 0.3);
    const g = E.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.04 * v, t + 0.05);
    g.gain.setTargetAtTime(0, t + 0.25, 0.06);
    s.connect(g); g.connect(b.out);
    iBell(E, b, t + seq.length * 0.048, 96 + p, 0.4, 0.8 * v, 0.25);
    return 0.9;
  },
  // Gold medal ping: harmonic FM bell; opts.pitch climbs with the chain.
  medal(E, b, t, p, v) {
    const f = 1318.5 * semis(p);
    const car = E.osc('sine', f, t, t + 1);
    const mod = E.osc('sine', f * 2, t, t + 1);
    const mi = E.gain(0);
    mi.gain.setValueAtTime(f * 1.3, t);
    mi.gain.setTargetAtTime(0, t, 0.07);
    mod.connect(mi); mi.connect(car.frequency);
    const g = E.gain(0);
    pluck(g.gain, t, 0.11 * v, 0.2);
    car.connect(g);
    g.connect(b.out);
    if (b.verb) g.connect(b.verb);
    blip(E, b, t, 'sine', f * 2.0, 0, 0, 0.035 * v, 0.1);
    blip(E, b, t + 0.04, 'sine', f * 1.5, 0, 0, 0.025 * v, 0.12);
    const n = E.noise(t, t + 0.05, 1);
    const hp = E.filt('highpass', 7500, 0.7, t);
    const c = E.gain(0);
    pluck(c.gain, t, 0.03 * v, 0.015);
    n.connect(hp); hp.connect(c); c.connect(b.out);
    return 0.9;
  },
  oneup(E, b, t, p, v) {
    const seq = ONEUP_NOTES;
    v *= 0.75;
    for (let i = 0; i < seq.length; i++) {
      const last = i === seq.length - 1;
      iLead(E, b, t + i * 0.075, seq[i] + p, last ? 0.42 : 0.07, 0.9 * v, 0);
      iBell(E, b, t + i * 0.075, seq[i] + 12 + p, 0.2, 0.6 * v, i % 2 ? 0.3 : -0.3);
    }
    return 1.3;
  },
  death(E, b, t, p, v) {
    const r = semis(p);
    v *= 0.85;
    boom(E, b, t, 1.7, r, v);
    boom(E, b, t + 0.38, 1.1, r * 0.82, v * 0.8);
    boom(E, b, t + 0.8, 0.7, r * 0.7, v * 0.55);
    // power-down whine
    const o = E.osc('sawtooth', 900 * r, t, t + 1.6);
    o.frequency.exponentialRampToValueAtTime(48, t + 1.2);
    const lp = E.filt('lowpass', 2400, 1.5, t);
    lp.frequency.exponentialRampToValueAtTime(250, t + 1.2);
    const g = E.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11 * v, t + 0.02);
    g.gain.setTargetAtTime(0, t + 0.5, 0.3);
    o.connect(lp); lp.connect(g); g.connect(b.out);
    rumble(E, b, t, 2.2, v * 0.8);
    sizzle(E, b, t + 0.05, 1.4, v);
    return 3.2;
  },
  // Two-tone klaxon, 8 × 0.375 s = 3 s.
  warning(E, b, t, p, v) {
    const seg = 0.375, n = 8, stop = t + seg * n + 0.1;
    const hi = 830.6 * semis(p), lo = 622.3 * semis(p);
    const o1 = E.osc('sawtooth', hi, t, stop);
    const o2 = E.osc('p25', hi, t, stop);
    const o3 = E.osc('square', hi / 2, t, stop);
    o2.detune.setValueAtTime(10, t);
    const lp = E.filt('lowpass', 2300, 3.5, t);
    const g = E.gain(0);
    const g3 = E.gain(0.35);
    for (let i = 0; i < n; i++) {
      const ts = t + i * seg, f = i % 2 ? lo : hi;
      o1.frequency.setValueAtTime(f * 0.93, ts); o1.frequency.exponentialRampToValueAtTime(f, ts + 0.07);
      o2.frequency.setValueAtTime(f * 0.93, ts); o2.frequency.exponentialRampToValueAtTime(f, ts + 0.07);
      o3.frequency.setValueAtTime(f * 0.465, ts); o3.frequency.exponentialRampToValueAtTime(f / 2, ts + 0.07);
      const pk = 0.085 * v * (i === n - 1 ? 0.7 : 1);
      g.gain.setValueAtTime(0, ts);
      g.gain.linearRampToValueAtTime(pk, ts + 0.03);
      g.gain.linearRampToValueAtTime(pk * 0.75, ts + seg - 0.05);
      g.gain.linearRampToValueAtTime(0, ts + seg - 0.008);
    }
    o1.connect(lp); o2.connect(lp); o3.connect(g3); g3.connect(lp); lp.connect(g); g.connect(b.out);
    if (b.verb) g.connect(b.verb);
    return seg * n + 0.2;
  },
  // Menu cursor: a soft two-layer "tick".
  select(E, b, t, p, v) {
    const r = semis(p);
    blip(E, b, t, 'p25', 1760 * r, 0, 0, 0.07 * v, 0.03);
    blip(E, b, t, 'triangle', 880 * r, 0, 0, 0.12 * v, 0.035);
    blip(E, b, t, 'sine', 3520 * r, 0, 0, 0.025 * v, 0.015);
    return 0.2;
  },
  confirm(E, b, t, p, v) {
    const r = semis(p);
    blip(E, b, t, 'p25', 1046.5 * r, 0, 0, 0.055 * v, 0.03);
    blip(E, b, t + 0.065, 'p25', 1568 * r, 0, 0, 0.065 * v, 0.07);
    iBell(E, b, t + 0.065, 96 + p, 0.3, 0.7 * v, 0);
    return 0.6;
  },
  pause(E, b, t, p, v) {
    const r = semis(p);
    blip(E, b, t, 'triangle', 1568 * r, 0, 0, 0.07 * v, 0.03);
    blip(E, b, t + 0.075, 'triangle', 1046.5 * r, 0, 0, 0.07 * v, 0.06);
    return 0.35;
  },
  bossDown(E, b, t, p, v) {
    const r = semis(p);
    v *= 0.55;
    const seq = BOSSDOWN_SEQ;
    for (let i = 0; i < seq.length; i += 3) boom(E, b, t + seq[i], seq[i + 1], r * seq[i + 2], v * (0.55 + seq[i + 1] * 0.15));
    const tb = t + 2.5;
    const o = E.osc('sine', 58 * r, tb, tb + 4);
    o.frequency.exponentialRampToValueAtTime(22, tb + 2.5);
    const s = E.gain(0);
    pluck(s.gain, tb, 0.85 * v, 0.9, 0.01);
    o.connect(s); s.connect(b.out);
    rumble(E, b, t, 6.5, v);
    sizzle(E, b, tb, 3.5, v);
    return 7.5;
  },
  // "Ta-ta-ta TAAA" in D minor: brass + lead with a third below, power-chord stabs, snare
  // hits, a brass hit and a crash on the last note. Locked to the stage theme's 16th grid: the
  // game fires this and music('stage') in the same frame, and a new song's first step lands
  // MUSIC_LEAD s later, so the fanfare's hits fall on the intro's kicks instead of flamming
  // against them.
  stageStart(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE1); },
  // Bullet grazes the player: a short bright upward "tsing" with a noise shimmer.
  graze(E, b, t, p, v) {
    const r = semis(p);
    blip(E, b, t, 'sine', 2637 * r, 3520 * r, 0.018, 0.1 * v, 0.03);
    blip(E, b, t + 0.012, 'sine', 5274 * r, 0, 0, 0.04 * v, 0.02);
    const n = E.noise(t, t + 0.06, 1);
    const hp = E.filt('highpass', 7000, 0.7, t);
    const g = E.gain(0);
    pluck(g.gain, t, 0.06 * v, 0.012);
    n.connect(hp); hp.connect(g); g.connect(b.out);
    return 0.16;
  },
  // Lock-on / alert blip: two short square "bip"s an octave apart.
  lock(E, b, t, p, v) {
    const r = semis(p);
    const lp = E.filt('lowpass', 5200, 0.7, t);
    lp.connect(b.out);
    const x = { out: lp };
    blip(E, x, t, 'p25', 1760 * r, 0, 0, 0.11 * v, 0.022);
    blip(E, x, t, 'sine', 880 * r, 0, 0, 0.07 * v, 0.02);
    blip(E, x, t + 0.07, 'p25', 1760 * r, 0, 0, 0.11 * v, 0.03);
    blip(E, x, t + 0.07, 'sine', 3520 * r, 0, 0, 0.035 * v, 0.02);
    return 0.2;
  },
  // Pink plasma: a continuous, fat energy beam; a hold voice like 'laser' (same contract).
  // Two beating saws on D3 (a note in every stage and boss key) whose pitch an 8 Hz LFO
  // wobbles a little, so the beam bends, and a throbbing "wow-wow": a fixed dark low-pass plus
  // a resonant band near 1.9 kHz whose level the same LFO sweeps. (Sweeping a filter's cutoff,
  // or modulating detune, costs a per-sample recomputation; a gain and a frequency input in Hz
  // don't.) Plus a band of electric crackle on top for presence on phone speakers.
  plasma(E, b, t, p, v) {
    const r = semis(p), stop = t + 2, src = E.hsrc, f = 146.8 * r;
    const env = E.gain(0);
    env.gain.setValueAtTime(0, t);
    env.gain.setTargetAtTime(v, t, 0.012);
    env.gain.setTargetAtTime(0, t + SFX.plasma.hold, 0.035);
    E.henv = env;
    const lfo = E.osc('sine', 8, t, stop);
    const o1 = E.osc('sawtooth', f, t, stop);
    const o2 = E.osc('sawtooth', f * 1.0081, t, stop);   // +14 cents: slow beating
    const pd = E.gain(f * 0.0105);                        // ±18 cents of wobble, in Hz
    lfo.connect(pd); pd.connect(o1.frequency); pd.connect(o2.frequency);
    const og = E.gain(0.5);
    o1.connect(og); o2.connect(og);
    const lp = E.filt('lowpass', 950, 1.2, t);
    const bp = E.filt('bandpass', 1900, 2.6, t);
    const wah = E.gain(0.9), wd = E.gain(0.9);            // band level 0 … 1.8, following the LFO
    lfo.connect(wd); wd.connect(wah.gain);
    og.connect(lp); og.connect(bp); bp.connect(wah);
    const n = E.noise(t, stop, 1, E.crackleBuf);
    const cb = E.filt('bandpass', 3300 * r, 0.9, t);
    const ng = E.gain(0.5);
    n.connect(cb); cb.connect(ng);
    const hp = E.filt('highpass', 280, 0.7, t);
    lp.connect(hp); wah.connect(hp); ng.connect(hp); hp.connect(env); env.connect(b.out);
    src.push(lfo, o1, o2, n);
    return SFX.plasma.hold + 0.2;
  },
  // Gold wave: one wide "vwum" per shot. A triangle chirps up to A5 and settles on E5, a soft
  // ring a fifth above, and a short rising air whoosh. Soft-edged, so a rapid stream reads as
  // one broad pulsing beam instead of a machine gun.
  wave(E, b, t, p, v) {
    const r = semis(p + (Math.random() - 0.5) * 0.8);
    const o = E.osc('triangle', 392 * r, t, t + 0.17);
    o.frequency.exponentialRampToValueAtTime(880 * r, t + 0.03);
    o.frequency.exponentialRampToValueAtTime(659 * r, t + 0.1);
    const g = E.gain(0);
    pluck(g.gain, t, 0.13 * v, 0.045, 0.004);
    o.connect(g); g.connect(b.out);
    blip(E, b, t + 0.012, 'sine', 1318.5 * r, 988 * r, 0.08, 0.035 * v, 0.04);
    const n = E.noise(t, t + 0.12, 1);
    const bp = E.filt('bandpass', 1100 * r, 1.5, t);
    bp.frequency.exponentialRampToValueAtTime(4200 * r, t + 0.06);
    const gn = E.gain(0);
    pluck(gn.gain, t, 0.09 * v, 0.03, 0.006);
    n.connect(bp); bp.connect(gn); gn.connect(b.out);
    return 0.16;
  },
  // Multi: a fan of straight rockets. Three staggered launch "fft"s (bright noise bands that
  // rise) over one low thump and an ignition tick; tighter and brighter than the homing 'missile'.
  multi(E, b, t, p, v) {
    const r = semis(p + (Math.random() - 0.5) * 1.2);
    for (let i = 0; i < 3; i++) {
      const ti = t + i * 0.028, ri = r * (1 + i * 0.07);
      const n = E.noise(ti, ti + 0.34, 1);
      const bp = E.filt('bandpass', 900 * ri, 2, ti);
      bp.frequency.exponentialRampToValueAtTime(3600 * ri, ti + 0.16);
      const g = E.gain(0);
      g.gain.setValueAtTime(0, ti);
      g.gain.linearRampToValueAtTime((0.1 - i * 0.015) * v, ti + 0.012);
      g.gain.setTargetAtTime(0, ti + 0.04, 0.075);
      n.connect(bp); bp.connect(g); g.connect(b.out);
    }
    blip(E, b, t, 'sine', 260 * r, 95 * r, 0.05, 0.12 * v, 0.03);
    blip(E, b, t, 'square', 1400 * r, 700 * r, 0.03, 0.022 * v, 0.012);
    return 0.5;
  },
  // Results money tick: a tiny bright "tink" (E6 body, E7 + B7 partials), short enough to be
  // fired every frame of the count-up.
  coin(E, b, t, p, v) {
    const r = semis(p);
    blip(E, b, t, 'triangle', 1318.5 * r, 0, 0, 0.06 * v, 0.025);
    blip(E, b, t, 'sine', 2637 * r, 0, 0, 0.06 * v, 0.04);
    blip(E, b, t, 'sine', 3951 * r, 0, 0, 0.03 * v, 0.03);
    const n = E.noise(t, t + 0.02, 1);
    const hp = E.filt('highpass', 6500, 0.7, t);
    const c = E.gain(0);
    pluck(c.gain, t, 0.05 * v, 0.004, 0.0005);
    n.connect(hp); hp.connect(c); c.connect(b.out);
    return 0.2;
  },
  // Purchase: a cash-register "ka-ching" (a latch chunk and a coin shimmer), then a bright
  // D-major bell arpeggio (the title/hangar key) over a warm brass swell.
  buy(E, b, t, p, v) {
    const r = semis(p);
    const n = E.noise(t, t + 0.07, 1);
    const bp = E.filt('bandpass', 1900 * r, 1.1, t);
    const c = E.gain(0);
    pluck(c.gain, t, 0.22 * v, 0.014, 0.0008);
    n.connect(bp); bp.connect(c); c.connect(b.out);
    blip(E, b, t, 'triangle', 240 * r, 120 * r, 0.04, 0.12 * v, 0.03);
    blip(E, b, t + 0.05, 'sine', 2637 * r, 0, 0, 0.05 * v, 0.05);
    blip(E, b, t + 0.05, 'sine', 3951 * r, 0, 0, 0.03 * v, 0.06);
    const seq = BUY_NOTES;
    for (let i = 0; i < seq.length; i++) {
      const tt = t + 0.1 + i * 0.055;
      blip(E, b, tt, 'p25', mtof(seq[i]) * r, 0, 0, 0.04 * v, i === seq.length - 1 ? 0.12 : 0.04);
      iBell(E, b, tt, seq[i] + 12 + p, 0.3, 0.7 * v, 0);
    }
    iBrass(E, b, t + 0.1, 62 + p, 0.45, 0.55 * v, 0);
    iBrass(E, b, t + 0.1, 66 + p, 0.45, 0.4 * v, 0);
    return 1.2;
  },
  // Not enough credits: a short low double buzz ("bzz-bzz"), two saws a semitone apart.
  deny(E, b, t, p, v) {
    const r = semis(p);
    for (let i = 0; i < 2; i++) {
      const ti = t + i * 0.11;
      const o = E.osc('sawtooth', 116.5 * r, ti, ti + 0.13);
      const o2 = E.osc('square', 123.5 * r, ti, ti + 0.13);
      const lp = E.filt('lowpass', 2000, 1.4, ti);
      const g = E.gain(0);
      g.gain.setValueAtTime(0, ti);
      g.gain.linearRampToValueAtTime(0.1 * v, ti + 0.006);
      g.gain.setTargetAtTime(0, ti + 0.07, 0.012);
      o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(b.out);
    }
    return 0.32;
  },
  // Equip: a latch "clack-clack" and a low thunk, then a confirm-like rising pair (G5 → D6)
  // with a bell, so it reads as "installed".
  equip(E, b, t, p, v) {
    const r = semis(p);
    for (let i = 0; i < 2; i++) {
      const ti = t + i * 0.035;
      const n = E.noise(ti, ti + 0.03, 1);
      const bp = E.filt('bandpass', 2600 * r, 1.4, ti);
      const c = E.gain(0);
      pluck(c.gain, ti, (i ? 0.14 : 0.2) * v, 0.006, 0.0005);
      n.connect(bp); bp.connect(c); c.connect(b.out);
    }
    blip(E, b, t, 'triangle', 180 * r, 90 * r, 0.05, 0.14 * v, 0.03);
    blip(E, b, t + 0.09, 'p25', 784 * r, 0, 0, 0.055 * v, 0.03);
    blip(E, b, t + 0.155, 'p25', 1174.7 * r, 0, 0, 0.065 * v, 0.07);
    iBell(E, b, t + 0.155, 90 + p, 0.3, 0.6 * v, 0);
    return 0.7;
  },
  // Shield break (the shield upgrade's charge takes a hit): a glassy snap — a bright noise crack
  // and a cluster of inharmonic FM pings ringing out like shattering crystal — over a short mid
  // thump and a falling discharge whine, so it reads "hit, but saved", never like the death boom.
  shield(E, b, t, p, v) {
    const r = semis(p);
    const n = E.noise(t, t + 0.3, 1);
    const bp = E.filt('bandpass', 6400 * r, 0.8, t);
    bp.frequency.exponentialRampToValueAtTime(2200 * r, t + 0.22);
    const g = E.gain(0);
    pluck(g.gain, t, 0.38 * v, 0.05, 0.001);
    n.connect(bp); bp.connect(g); g.connect(b.out);
    const pings = SHIELD_PINGS;
    for (let i = 0; i < pings.length; i++) {
      const ti = t + i * 0.022, f = pings[i] * r;
      const car = E.osc('sine', f, ti, ti + 0.6);
      const mod = E.osc('sine', f * 1.531, ti, ti + 0.6);
      const mi = E.gain(0);
      mi.gain.setValueAtTime(f * 1.4, ti);
      mi.gain.setTargetAtTime(0, ti, 0.06);
      mod.connect(mi); mi.connect(car.frequency);
      const pg = E.gain(0);
      pluck(pg.gain, ti, (0.1 - i * 0.012) * v, 0.14 + i * 0.03);
      car.connect(pg); E.out(pg, b.out, PING_PAN[i]);
    }
    blip(E, b, t, 'triangle', 330 * r, 110 * r, 0.09, 0.22 * v, 0.06);
    const o = E.osc('sawtooth', 1500 * r, t, t + 0.5);
    o.frequency.exponentialRampToValueAtTime(200 * r, t + 0.36);
    const lp = E.filt('lowpass', 3200, 1.2, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.36);
    const g2 = E.gain(0);
    g2.gain.setValueAtTime(0, t);
    g2.gain.linearRampToValueAtTime(0.05 * v, t + 0.012);
    g2.gain.setTargetAtTime(0, t + 0.08, 0.09);
    o.connect(lp); lp.connect(g2); g2.connect(b.out);
    return 1.0;
  },
  // Stage 2-8 fanfares: same build as 'stageStart', on their own theme's 16th grid and key.
  stageStart2(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE2); },
  stageStart3(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE3); },
  stageStart4(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE4); },
  stageStart5(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE5); },
  stageStart6(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE6); },
  stageStart7(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE7); },
  stageStart8(E, b, t, p, v) { return fanfare(E, b, t, p, v, FANFARE8); },
};

// Stage fanfare (see 'stageStart' for the timing rule). F = { song, seq: [step, melody,
// harmony, length-in-steps]…, pad: final chord, lead: instrument, toms: dum/tek hits instead
// of snares (drags when 'drag', low timpani strokes when 'timp'), gtr: power-chord root under
// every hit, bells: sparkle arpeggio over the last note (voice sparkV, default bell), choir: a
// choir swell on the final chord, v: level }. opts.pitch transposes all of it.
function fanfare(E, b, t, p, v, F) {
  const seq = F.seq, st = 60 / SONGDEF[F.song].bpm / 4;
  // One clock with the theme: when the theme was started first in the same frame, join its
  // first step; otherwise the theme joins this fanfare's (see Engine.music).
  const cur = E.cur;
  if (cur && cur.name === F.song && cur.t0 >= t + 0.002 && Math.abs(cur.t0 - (t + MUSIC_LEAD)) < 0.25) t = cur.t0 - MUSIC_LEAD;
  E.fanSong = F.song;
  E.fanT = t;
  t += MUSIC_LEAD;
  v *= F.v;
  for (let i = 0; i < seq.length; i += 4) {
    const tt = t + seq[i] * st, m = seq[i + 1] + p, h = seq[i + 2] + p, d = seq[i + 3] * st * 0.92, long = d > 0.5;
    F.lead(E, b, tt, m, d, 0.95 * v, -0.1);
    iBrass(E, b, tt, h, d, 0.8 * v, 0.2);
    iBrass(E, b, tt, m - 12, d, 0.6 * v, 0);
    if (F.toms === 'drag') dDrag(E, b, tt, 0, st, (long ? 0.95 : 0.6) * v);
    else if (F.toms === 'timp') {          // timpani: the low tom, a second stroke under a long note
      dTom(E, b, tt, long ? 40 : 45, 0, (long ? 1 : 0.8) * v);
      if (long) dTom(E, b, tt + 2 * st, 40, 0, 0.7 * v);
    } else if (F.toms) dTom(E, b, tt, long ? 45 : 57, 0, (long ? 1 : 0.75) * v);
    else dSnare(E, b, tt, 0, 0, (long ? 0.9 : 0.55) * v);
    if (F.gtr) iGtr(E, b, tt, F.gtr + p, d, (long ? 0.85 : 0.6) * v);
  }
  const tl = t + seq[seq.length - 4] * st;
  dKick(E, b, tl, 0, 0, v);
  dCrash(E, b, tl, 0, 0, 0.9 * v);
  if (F.gtr) iHit(E, b, tl, F.gtr + (F.gtr < 48 ? 12 : 0) + p, 0, 0.8 * v);
  const sv = F.sparkV || iBell;
  if (F.bells) for (let i = 0; i < F.bells.length; i++) sv(E, b, tl + (i + 1) * st, F.bells[i] + p, 0.3, 0.8 * v, 0);
  const pad = [];
  for (let i = 0; i < F.pad.length; i++) pad.push(F.pad[i] + p);
  if (F.choir) iChoir(E, b, tl, pad.map((x) => x + 12), 0.9, 0.9 * v);
  else iPad(E, b, tl, pad, 0.9, 1.4 * v);
  return 2.4;
}

const POWERUP_NOTES = [67, 71, 74, 79, 83, 86, 91];
const ONEUP_NOTES = [76, 81, 85, 88, 93];
// time, size, pitch-ratio triplets
const BOSSDOWN_SEQ = [0, 1.3, 1, 0.3, 0.8, 0.85, 0.62, 1.0, 1.1, 0.95, 0.6, 0.8, 1.3, 1.2, 0.95, 1.75, 0.8, 1.2, 2.5, 2.9, 0.9];
// Fanfares: [step (16ths at the stage tempo), melody, harmony, length-in-steps] quadruplets.
// Stage 1 (D minor): "ta-ta-ta TA — TAAA" landing on beats 2 and 3 of the intro's first bar,
// over D5 power-chord stabs.
const FANFARE1 = {
  song: 'stage', lead: iLead, toms: false, v: 0.55, pad: [50, 57, 62, 65], gtr: 50,
  seq: [0, 62, 57, 1, 1, 62, 57, 1, 2, 62, 57, 1, 4, 65, 62, 3, 8, 69, 65, 8],
};
// Stage 2 (B phrygian, reed over parallel fourths, doumbek toms): "ta-ta-ta TA-ta TAAA",
// B B B D C → B, the phrygian flat 2nd falling home.
const FANFARE2 = {
  song: 'stage2', lead: iReed, toms: true, v: 0.55, pad: [47, 54, 59, 62], gtr: 47,
  seq: [0, 71, 66, 1, 1, 71, 66, 1, 2, 71, 66, 1, 4, 74, 69, 2, 6, 72, 67, 2, 8, 71, 66, 8],
};
// Stage 3 (C lydian, lead and brass): G G G C → G5, an octave-and-a-fifth leap, then a bell
// sparkle up C E F# B (the lydian fourth) over a Cmaj7 pad.
const FANFARE3 = {
  song: 'stage3', lead: iLead, toms: false, v: 0.55, pad: [48, 55, 64, 71], bells: [84, 88, 90, 95], gtr: 48,
  seq: [0, 67, 64, 1, 1, 67, 64, 1, 2, 67, 64, 1, 4, 72, 67, 3, 8, 79, 76, 8],
};
// Stage 4 (G minor, orbit): the theme's rising call as a fanfare — G B-flat D climbing in 16ths
// to G5, then a fifth up to D6 — and a bell sparkle up G B-flat D G (the starfield) over Gm.
const FANFARE4 = {
  song: 'stage4', lead: iLead, toms: false, v: 0.55, pad: [43, 50, 55, 58], bells: [79, 82, 86, 91], gtr: 43,
  seq: [0, 67, 62, 1, 1, 70, 67, 1, 2, 74, 70, 1, 4, 79, 74, 3, 8, 86, 79, 8],
};
// Stage 5 (F# minor, the siege march): F# F# F# A → C#, snare drags on every hit, and a choir
// swelling on the F#m chord.
const FANFARE5 = {
  song: 'stage5', lead: iLead, toms: 'drag', v: 0.55, pad: [42, 49, 54, 57], choir: true, gtr: 42,
  seq: [0, 66, 61, 1, 1, 66, 61, 1, 2, 66, 61, 1, 4, 69, 66, 3, 8, 73, 69, 8],
};
// Stage 6 (C# dorian): the voyage call in the theme's hemiola — a hit every third 16th, on the
// intro's 3+3+3+3+4 kicks — C# C# E F# climbing to G#, parallel fourths below, and a bell
// sparkle up E G# A# C# (the dorian sixth) over C#m.
const FANFARE6 = {
  song: 'stage6', lead: iLead, toms: false, v: 0.55, pad: [49, 56, 61, 64], bells: [88, 92, 94, 97], gtr: 49,
  seq: [0, 73, 68, 2, 3, 73, 68, 2, 6, 76, 71, 2, 9, 78, 73, 2, 12, 80, 76, 8],
};
// Stage 7 (G# minor, drum & bass): G# B D# up the triad in 3+3+4 — the last hit on the
// two-step's second kick — to G#5, then a crystal (glass) sweep up the G#m chord.
const FANFARE7 = {
  song: 'stage7', lead: iLead, toms: false, v: 0.55, pad: [44, 51, 56, 59], bells: [83, 87, 92, 95], sparkV: iGlass, gtr: 44,
  seq: [0, 68, 63, 3, 3, 71, 66, 3, 6, 75, 71, 4, 10, 80, 75, 8],
};
// Stage 8 (B-flat minor): the dawn motif on brass over timpani — B-flat, F, B-flat an octave up,
// then D turning to D-flat (major to minor) — and a choir swelling on B-flat minor.
const FANFARE8 = {
  song: 'stage8', lead: iBrass, toms: 'timp', v: 0.55, pad: [46, 53, 58, 61], choir: true, gtr: 46,
  seq: [0, 70, 65, 4, 4, 77, 70, 4, 8, 82, 77, 3, 11, 86, 82, 1, 12, 85, 82, 8],
};
const BUY_NOTES = [74, 78, 81, 86];
const SHIELD_PINGS = [2349.3, 3322.4, 4186, 5587.7], PING_PAN = [0, 0.35, -0.35, 0.3]; // 'shield' crystal pings (Hz)

// name → { gap: min seconds between starts, max: voices of this name, pri: steal priority,
//          lv: mix level in dB, verb: reverb send (0..1), hold: sustained voice kept alive by
//          repeated calls (seconds after the last call), streak: [heat, k] attenuation of
//          sustained streams (see playSfx), bake: [variants, seconds] pre-rendered
//          at startup (frequent sounds; played back with ±jit semitones of random pitch) }
const SFX = {
  shot:       { gap: 0.045, max: 3, pri: 1, lv: 10, bake: [2, 0.09], jit: 0.6 },
  laser:      { gap: 0.045, max: 1, pri: 2, lv: -14, hold: 0.09 },
  missile:    { gap: 0.06,  max: 4, pri: 2, lv: 6, bake: [1, 0.6], jit: 0.75 },
  hit:        { gap: 0.045, max: 4, pri: 1, lv: 10.5, bake: [2, 0.1], jit: 1, streak: [3, 0.1] },
  hitArmor:   { gap: 0.08,  max: 2, pri: 2, lv: 11, bake: [1, 0.3], jit: 0.75, streak: [2, 0.2] },
  explodeS:   { gap: 0.025, max: 6, pri: 3, lv: 0, verb: 1, bake: [2, 1.1], jit: 1.5 },
  explodeM:   { gap: 0.04,  max: 5, pri: 4, lv: 1, verb: 1, bake: [1, 2.2], jit: 1.25 },
  explodeL:   { gap: 0.07,  max: 3, pri: 6, lv: 2, verb: 1, bake: [1, 3.4], jit: 1 },
  bomb:       { gap: 0.3,   max: 2, pri: 9, lv: 3, verb: 1 },
  item:       { gap: 0.04,  max: 3, pri: 5, lv: 9, bake: [1, 0.5] },
  powerup:    { gap: 0.15,  max: 2, pri: 7, lv: 6.5 },
  // the chain's pitch (0, 2, 4 … 12) is snapped up to E G A B C D E: a rising line that sits
  // in E minor (boss) instead of a whole-tone run (and in B phrygian, A minor and C lydian:
  // stage 2, boss 2, stage 3); a theme whose key lacks one of those notes brings its own
  // scale (song.snap: D minor → E G A Bb C D E, F# minor → E F# G# A B C# D E, …)
  medal:      { gap: 0.035, max: 4, pri: 5, lv: 5.5, verb: 1, bake: [1, 0.9], snap: [0, 3, 5, 7, 8, 10] },
  oneup:      { gap: 0.5,   max: 1, pri: 9, lv: 0, verb: 1 },
  death:      { gap: 0.5,   max: 1, pri: 10, lv: 2, verb: 1 },
  warning:    { gap: 1.0,   max: 1, pri: 9, lv: 4.5, verb: 1 },
  select:     { gap: 0.04,  max: 2, pri: 8, lv: 7.5 },
  confirm:    { gap: 0.08,  max: 2, pri: 8, lv: 3.5, verb: 1 },
  pause:      { gap: 0.1,   max: 1, pri: 8, lv: 11.5 },
  bossDown:   { gap: 1.0,   max: 1, pri: 10, lv: 3, verb: 1 },
  stageStart: { gap: 0.5,   max: 1, pri: 9, lv: 2, verb: 1 },
  graze:      { gap: 0.03,  max: 3, pri: 1, lv: 6.5, bake: [1, 0.18], jit: 1.5, streak: [2, 0.15] },
  lock:       { gap: 0.06,  max: 2, pri: 3, lv: 9, bake: [1, 0.26] },
  // --- stages 2-3, new weapons, hangar / results
  stageStart2: { gap: 0.5,  max: 1, pri: 9, lv: 2, verb: 1 },
  stageStart3: { gap: 0.5,  max: 1, pri: 9, lv: 2, verb: 1 },
  stageStart4: { gap: 0.5,  max: 1, pri: 9, lv: 2, verb: 1 },
  stageStart5: { gap: 0.5,  max: 1, pri: 9, lv: 2, verb: 1 },
  stageStart6: { gap: 0.5,  max: 1, pri: 9, lv: 2, verb: 1 },
  stageStart7: { gap: 0.5,  max: 1, pri: 9, lv: 2, verb: 1 },
  stageStart8: { gap: 0.5,  max: 1, pri: 9, lv: 2, verb: 1 },
  plasma:    { gap: 0.045, max: 1, pri: 2, lv: -14, hold: 0.09 },
  wave:       { gap: 0.05,  max: 3, pri: 1, lv: 2, bake: [2, 0.16], jit: 0.5 },
  multi:      { gap: 0.06,  max: 4, pri: 2, lv: 6, bake: [1, 0.5], jit: 0.75 },
  coin:       { gap: 0.025, max: 3, pri: 5, lv: 4, bake: [1, 0.2], jit: 0.15, streak: [4, 0.06] },
  buy:        { gap: 0.3,   max: 1, pri: 8, lv: -3.5, verb: 1 },
  deny:       { gap: 0.15,  max: 1, pri: 8, lv: 1 },
  equip:      { gap: 0.15,  max: 1, pri: 8, lv: 1, verb: 1 },
  shield:     { gap: 0.5,   max: 1, pri: 9, lv: 6, verb: 1 },
};
for (const k in SFX) { SFX[k].fn = SFXFN[k]; SFX[k].lvg = Math.pow(10, (SFX[k].lv || 0) / 20); }

// Samples baked at startup: [key, render(S, bus, t), seconds, mono]
const BAKE = [
  ['kick', (S, b, t) => dKick(S, b, t, 0, 0, 1), 0.5, true],
  ['snare', (S, b, t) => dSnare(S, b, t, 0, 0, 1), 0.42, true],
  ['hat', (S, b, t) => dHat(S, b, t, 0, 0, 1), 0.16, false],
  ['ohat', (S, b, t) => dOHat(S, b, t, 0, 0, 1), 0.7, false],
  ['crash', (S, b, t) => dCrash(S, b, t, 0, 0, 1), 2.4, false],
  ['tom57', (S, b, t) => dTom(S, b, t, 57, 0, 1), 0.5, false],
  ['tom52', (S, b, t) => dTom(S, b, t, 52, 0, 1), 0.5, false],
  ['tom45', (S, b, t) => dTom(S, b, t, 45, 0, 1), 0.5, false],
  ['bass40', (S, b, t) => iBass(S, b, t, 40, 3.1, 1), 3.2, true],
  ['bass52', (S, b, t) => iBass(S, b, t, 52, 3.1, 1), 3.2, true],
  ['arp55', (S, b, t) => iArp(S, b, t, 55, 0.1, 1, 0), 0.5, true],
  ['arp67', (S, b, t) => iArp(S, b, t, 67, 0.1, 1, 0), 0.5, true],
  ['arp79', (S, b, t) => iArp(S, b, t, 79, 0.1, 1, 0), 0.5, true],
  ['bell67', (S, b, t) => iBell(S, b, t, 67, 0.3, 1, 0), 1.5, true],
  ['bell79', (S, b, t) => iBell(S, b, t, 79, 0.3, 1, 0), 1.5, true],
  ['bell91', (S, b, t) => iBell(S, b, t, 91, 0.3, 1, 0), 1.5, true],
];
for (const k in SFX) {
  const bk = SFX[k].bake;
  if (bk) for (let i = 0; i < bk[0]; i++) BAKE.push([k + i, (S, b, t) => SFXFN[k](S, b, t, 0, 1), bk[1], true]);
}
// Stage 2-3 instruments, appended last. A sample's first render quantum depends on where its
// entry lands in the bake (a filter cutoff scheduled at the note's start is not yet in force
// for the rest of that quantum), so new entries go at the end: every older sample keeps its
// exact offset, and so its exact sound.
BAKE.push(
  ['pluck55', (S, b, t) => iPluck(S, b, t, 55, 0.1, 1, 0), 0.6, true],
  ['pluck67', (S, b, t) => iPluck(S, b, t, 67, 0.1, 1, 0), 0.6, true],
  ['pluck79', (S, b, t) => iPluck(S, b, t, 79, 0.1, 1, 0), 0.6, true],
  ['clank', (S, b, t) => dClank(S, b, t, 0, 0, 1), 0.42, true],
);
// Battle rework: power-chord guitars (stereo: the double-tracked takes), palm-mute chugs,
// brass power hits and a floor tom.
BAKE.push(
  ['gtr42', (S, b, t) => gtrPatch(S, b, t, 42, false), 2.1, false],
  ['gtr48', (S, b, t) => gtrPatch(S, b, t, 48, false), 2.1, false],
  ['chug42', (S, b, t) => gtrPatch(S, b, t, 42, true), 0.34, false],
  ['chug48', (S, b, t) => gtrPatch(S, b, t, 48, true), 0.34, false],
  ['hit45', (S, b, t) => hitPatch(S, b, t, 45), 1.1, true],
  ['hit51', (S, b, t) => hitPatch(S, b, t, 51), 1.1, true],
  ['tom40', (S, b, t) => dTom(S, b, t, 40, 0, 1), 0.5, false],
);
// Stages 6-8: glass tines.
BAKE.push(
  ['glass67', (S, b, t) => iGlass(S, b, t, 67, 0.3, 1, 0), 1.1, true],
  ['glass79', (S, b, t) => iGlass(S, b, t, 79, 0.3, 1, 0), 1.1, true],
  ['glass91', (S, b, t) => iGlass(S, b, t, 91, 0.3, 1, 0), 1.1, true],
);
export const SFX_NAMES = Object.keys(SFX);

// ---------------------------------------------------------------- music notation
// Melody:  "d5:3 a4:1 f5:4 r:4 | ..."  note:duration-in-16ths, r = rest, '|' = bar line (checked).
// Chords:  one symbol per bar ("Dm Bb C A7"); "Gm,A" splits a bar in halves.
// Lists:   "drive*7 fill1" = pattern names per bar.
// Bass:    R root, O octave, F fifth, T third, S seventh, 2 +1, 3 +3, d -1, L -5, U octave
//          down, P / Q the song's tonic (pedal / drone) / an octave up, _ tie, . rest.
// Drums:   k: x, g soft (double-kick runs) | s: x, g ghost, r roll (crescendo), d drag (two
//          32nds), R 32nd roll (crescendo) | h: x, X, g ghost, o open | t: h m l f toms
//          | c: x, g ghost steel clank | y: x, g crash.
// Arp:     digits index the chord-tone ladder, . rest.
// Guitar:  x / X open power chord (rung through '_' ties), m / M palm-muted chug, . rest; the
//          root follows the bar's chord, voiced E2..D#3 (no third: fits any chord quality).
// Stabs:   x square chord stab, H brass power hit.
// Song:    key (tonic pitch class) + minor, or `scale` (offsets) for a mode: the diatonic
//          harmony and the P/Q pedal use them. `vol` trims the whole track (default 1).
//          Section `padV: 'choir'` swaps the pad voice; `rise: n` puts a noise riser over the
//          section's last n bars (it cuts on the downbeat after them); `key` (+ `minor` /
//          `scale`) modulates the section: its harmony, pedal and medal-chain scale follow.

const DRUM = {
  none:   {},
  // title / clear jingle
  tsoft:  { k: 'x.........x.....', h: '..g...g...g...g.' },
  tmain:  { k: 'x.........x.....', s: '....x.......x...', h: 'x.g.x.g.x.g.x.g.' },
  tfill:  { k: 'x.........x.....', s: '....x...........', t: '........h..m..l.' },
  fanA:   { k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
  fanB:   { k: 'x.......x.......', s: '....x...x.xxrrrr' },
  fanEnd: { k: 'x...............' },
  // --- battle kit (every stage and boss theme)
  // intros: kicks on every beat of the first bar, where the stage fanfare's hits land
  bI:     { k: 'x...x...x...x...', h: 'g.x.g.x.g.x.g.x.' },
  bI2:    { k: 'x...x...x...x...', s: '....x.......x.xx', h: 'gxgxgxgxgxgxgxgx' },
  // grooves
  bA:     { k: 'x...x...x...x...', s: '....x.......x...', h: 'X.x.X.x.X.x.X.o.' },   // four-on-the-floor
  bB:     { k: 'x...x...x.x.x...', s: '....x..g....x..g', h: 'XgxgXgxgXgxgXgxg' },   // busier, 16th hats
  bC:     { k: 'x.x.x.x.x.x.x.x.', s: '....x.......x...', h: 'X.x.X.x.X.x.X.x.' },   // eighth double kick
  bD:     { k: 'xgxgxgxgxgxgxgxg', s: '....x.......x...', h: 'X...X...X...X...' },   // 16th double kick
  bG:     { k: 'x.xgx.xgx.xgx.xg', s: '....x.......x...', h: 'X.x.X.x.X.x.X.x.' },   // gallop kick
  bH:     { k: 'x.....x...x.....', s: '........x.......', h: 'x.g.x.g.x.g.x.g.' },   // half time
  // militant: snare drags and ghost notes around the backbeat
  mrA:    { k: 'x...x...x...x...', s: 'g..dx..gg..dx.gg', h: 'X.x.X.x.X.x.X.x.' },
  mrB:    { k: 'x...x...x.x.x...', s: 'g..dx.g.g.gdx.dd', h: 'XgxgXgxgXgxgXgxg' },
  milT:   { k: 'x.......x.......', s: 'x.d.x.d.x.d.x.d.', t: '...l...l...m..hh' },
  milB:   { k: 'x...x...x...x...', s: 'x.dxx.dxx.dxx.dd' },
  // fills (a phrase's last bar)
  fS:     { k: 'x.....x.x.......', s: '....x...x.xxrrrr' },
  fT:     { k: 'x.....x.x.......', s: '....x...........', t: '........hhmmllff' },
  fR:     { k: 'x...x...x...x...', s: 'rrrrrrrrrrrrrrrr' },                           // 16th roll, crescendo
  fD:     { k: 'x...x...x...xxxx', s: 'RRRRRRRRRRRRRRRR' },                           // 32nd roll, crescendo
  fX:     { k: 'x.x.x.x.x.x.xxxx', s: '....x...x.x.RRRR', t: '........hhmm....' },
  // stage 2: 3+3+2 kick, doumbek toms, galloping hats
  dsI:    { k: 'x..x..x.x..x..x.', h: '..x...x...x...x.' },
  dsA:    { k: 'x..x..x.x..x..x.', s: '....x.......x...', t: '.......h......h.', h: 'x.xxx.xxx.xxx.xx' },
  dsB:    { k: 'x..x..x.x.xx..x.', s: '....x..g....x.xg', t: '...h.......h..mh', h: 'X.xgX.xgX.xgX.xg' },
  dsC:    { k: 'x.x.x.x.x.x.x.x.', s: '....x.......x...', t: '..h...h...h...h.', h: 'x.xxx.xxx.xxx.xx' },
  // stage 3: four-on-the-floor, offbeat open hats
  skyI:   { k: 'x...x...x...x...', h: '..o...o...o...o.' },
  skyIS:  { k: 'x...x...x...x...', s: '....x.......x.xx', h: '..o...o...o...o.' },
  skyA:   { k: 'x...x...x...x...', s: '....x.......x...', h: 'g.o.g.o.g.o.g.og' },
  skyB:   { k: 'x...x...x.x.x...', s: '....x..g....x..g', h: 'gxo.gxo.gxo.gxog' },
  // boss 2: the machine, a steel clank on the last 16th of every beat
  mechI:  { k: 'x.......x.......', h: 'x.g.x.g.x.g.x.g.', c: '...x...x...x...x' },
  mA:     { k: 'x.x.x.x.x.x.x.x.', s: '....x.......x...', h: 'xgxgxgxgxgxgxgxg', c: '...x...x...x...x' },
  mB:     { k: 'x.xgx.xgx.xgx.xg', s: '....x.......x..g', h: 'XgxgXgxgXgxgXgxg', c: '...x..gx...x..gx' },
  mHalf:  { k: 'x.....x...x.....', s: '........x.......', c: '..x...x...x...x.', t: '............hml.' },
  // timpani intro (boss 3)
  finI:   { k: 'x.......x.......', t: '..........l.l.ml' },
  // breakdown: crash-stab hits in 3+3+2
  brkY:   { k: 'x.....x.....x.x.', s: '........x.......', y: 'x.....x.........', t: '............ffll' },
  // stage 4: four-on-the-floor under 16th hats accented on the offbeat 8ths (the sequencer pulse)
  orA:    { k: 'x...x...x...x...', s: '....x.....g.x...', h: 'xgXgxgXgxgXgxgXg' },
  orB:    { k: 'x...x...x.x.x...', s: '....x..g..g.x..g', h: 'xgXgxgXgxgXgxgXo' },
  // stage 5: the walkers' stomp — half-time snare, 3+3+2 kicks, floor-tom footsteps
  moonH:  { k: 'x.....x.....x...', s: '........x.......', t: '...f.....f...fff', h: 'x.g.x.g.x.g.x.g.' },
  // stage 6: the orbits' hemiola — kicks in 3+3+3+3+4 under a straight backbeat
  solI:   { k: 'x..x..x..x..x...', h: 'g.x.g.x.g.x.g.x.' },
  solA:   { k: 'x..x..x..x..x...', s: '....x.......x...', h: 'X.x.X.x.X.x.X.x.' },
  solB:   { k: 'x..x..x..x..x.x.', s: '....x..g....x..g', h: 'XgxgXgxgXgxgXgxg' },
  solD:   { k: 'xg.xg.xg.xg.xgxg', s: '....x.......x...', h: 'X.x.X.x.X.x.X.x.' },   // + double kick
  belt:   { k: 'x..x..x..x..x...', s: '........x.......', t: '.f..l..f..l..mhh' },   // tumbling floor toms
  // boss 6: thrash skank (the snare on every offbeat 8th), over double kick; hammer blast
  thA:    { k: 'x...x...x...x...', s: '..x...x...x...x.', h: 'x.x.x.x.x.x.x.x.' },
  thB:    { k: 'x.x.x.x.x.x.x.x.', s: '..x...x...x...x.', h: 'X.x.X.x.X.x.X.x.' },
  thD:    { k: 'xgxgxgxgxgxgxgxg', s: '..x...x...x...x.', h: 'X...X...X...X...' },
  blA:    { k: 'x.x.x.x.x.x.x.x.', s: 'x.x.x.x.x.x.x.x.', h: 'X...X...X...X...' },
  // stage 7: drum & bass two-step (kicks on 1 and the and of 3), ghost snares; half time
  dnbI:   { k: 'x.........x.....', h: 'x.x.x.x.x.x.x.x.' },
  dnbA:   { k: 'x.........x.....', s: '....x..g....x..g', h: 'x.xgx.xgx.xgx.xg' },
  dnbB:   { k: 'x.x.......x..x..', s: '....x..g.g..x.gg', h: 'xgxgxgxgxgxgxgxo' },
  dnbH:   { k: 'x.........x.....', s: '........x.......', h: 'x...x...x...x...' },
  // boss 7: the machine — kicks in 2+2+3 2+2+3 2 under a straight backbeat, steel clanks
  nmI:    { k: 'x.x.x..x.x.x..x.', c: '......x......x..' },
  nmA:    { k: 'x.x.x..x.x.x..x.', s: '....x.......x...', h: 'X.x.X.x.X.x.X.x.', c: '......x......x..' },
  nmB:    { k: 'x.x.xxxx.x.xxxx.', s: '....x.......x...', h: 'XgxgXgxgXgxgXgxg', c: '......g......g..' },
  nmBrk:  { k: 'x.....x...x.....', c: 'x.x.x..x.x.x..x.', y: 'x...............', t: '............ffll' },
  // stage 8: tribal toms under four-on-the-floor; timpani intro; epic half time (16th double
  // kick, the snare on 3)
  cosI:   { k: 'x...x...x...x...', t: '..l...l...l...ff' },
  cosA:   { k: 'x...x...x...x...', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', t: '..l.......l..l..' },
  cosB:   { k: 'x...x...x.x.x...', s: '....x..g....x..g', h: 'XgxgXgxgXgxgXgxg', t: '..l.......l..ll.' },
  cosH:   { k: 'xgxgxgxgxgxgxgxg', s: '........x.......', h: 'X...X...X...X...' },
  // boss 8: timpani (the core waking), the hymn's half time
  omI:    { k: 'x.......x.......', t: '..f.f.....l.l.ff' },
  omH:    { k: 'x.......x.......', s: '........x.......', t: '..........l.l.ll' },
};

const BASS = {
  none:   '................',
  build:  'R.R.R.R.RRRRRRRR',
  hold:   'R_______________',
  halves: 'R_______R_______',
  slow:   'R_______F___O___',
  fan:    'R_R_R_R_O_O_F_R_',
  tres:   'R__R__R_R__O__R_',      // 3+3+2 (tresillo) drive
  drone:  'P_______________',      // tonic pedal under whatever chord
  octP:   'P.Q.P.Q.P.Q.P.Q.',      // octave bounce on the tonic pedal
  riff:   'RROR2RORRROR32Rd',
  chug:   'UUR.UUR.UU3.UU2.',      // octave-down machine chug, minor/chromatic top
  chugM:  'UUR.UUR.UUO.UUF.',      // same, octave/fifth top (major chords)
  grind:  'U..U..U.U..U.2.3',
  gallop: 'R.RRR.RRR.RRO.RR',
  // battle: pumping sixteenths
  p16:    'RRRRRRRRRRRRRRRR',
  ped16:  'PPPPPPPPPPPPPPPP',      // on the tonic pedal
  pump:   'RRORRRORRRORRROR',      // an octave on every beat's last 16th
  oct16:  'RORORORORORORORO',      // 16th octave bounce
  pump3:  'RRORRORRORRORROR',      // the octave closing every 3 16ths (stage 6's hemiola)
  burn:   'RRdRRR2RRROR3R2d',      // chromatic neighbours circling the tonic (boss 6)
  nm:     'R.R.R..R.R.R..O.',      // locked to boss 7's 2+2+3 kick
  fifths: 'RFOFRFOFRFOFRFOF',      // root, fifth, octave, fifth (stage 8's open fifths)
  dnb:    'R_____RRR_____OR',      // two-step: held roots on the kicks
};

// register of each arp voice's chord-tone ladder (the lowest ladder note is this + 0..11)
const ARP_BASE = { arp: 55, bell: 67, pluck: 55, glass: 67 };
const ARP = {
  none:     null,
  arpA:     { v: 'arp',  p: '0.1.2.1.3.1.2.1.', vel: 0.9 },
  arpB:     { v: 'arp',  p: '0123212301232123', vel: 0.8 },
  arpC:     { v: 'arp',  p: '0213243120132431', vel: 0.8 },
  bellA:    { v: 'bell', p: '0.2.1.3.2.4.3.5.', vel: 0.65 },
  bellSlow: { v: 'bell', p: '0...2...4...5...', vel: 0.7 },
  bellDark: { v: 'bell', p: '5..4..3..2..1...', vel: 0.6 },
  arpO:     { v: 'arp',  p: '0123401234012340', vel: 0.72 },    // orbital sequencer: 5-note climbs across the 16ths
  bellMoon: { v: 'bell', p: '0.4.2.5.1.4.3.6.', vel: 0.55 },   // wide leaps echoing over the craters
  bellMoonS: { v: 'bell', p: '0...4...2...5...', vel: 0.62 },  // the same, sparse (the echo fills the gaps)
  pluckA:   { v: 'pluck', p: '0..1..2.0..1..3.', vel: 0.85 },   // oud ostinato, 3+3+2
  pluckB:   { v: 'pluck', p: '0.0.1.0.2.0.1.0.', vel: 0.8 },    // pedal-note picking
  bellSky:  { v: 'bell', p: '0.1.2.3.4.3.2.1.', vel: 0.6 },
  arpM:     { v: 'arp',  p: '0102010201020103', vel: 0.7 },     // machine sequencer
  arpS:     { v: 'arp',  p: '0120120120120123', vel: 0.75 },    // climbs grouped in 3s (stage 6's hemiola)
  bellS3:   { v: 'bell', p: '0..2..4..5..4...', vel: 0.62 },    // sunlight, in 3s
  warp:     { v: 'arp',  p: '0123456701234567', vel: 0.6 },     // two-octave sweeps (stage 7's warp)
  glassA:   { v: 'glass', p: '0.3.1.4.2.5.3.6.', vel: 0.6 },    // crystal clusters
  glassS:   { v: 'glass', p: '0...3...5...4...', vel: 0.66 },   // the same, sparse
  arpQ:     { v: 'arp',  p: '0235023502350235', vel: 0.72 },    // pulsar: root, fifth and their octaves (stage 8)
  bellQ:    { v: 'bell', p: '0...2...3...5...', vel: 0.62 },    // the same in slow bells
};

const STAB = {
  none: '................',
  sA: '..x..x....x..x..', sM: '..x...x...x...x.',
  hA: 'H...............', hB: 'H.......H.......', hC: 'H.....H.....H...', hD: 'H..H..H.H.......',
};

const GTR = {
  none: '................',
  ch8:  'M.m.m.m.M.m.m.m.',   // eighth-note chugs
  ch16: 'MmmmMmmmMmmmMmmm',   // sixteenth chugs (thrash)
  gal:  'M.mmM.mmM.mmM.mm',   // gallop
  trs:  'M..M..M.M..M..M.',   // 3+3+2 (stage 2)
  mch:  'MMm.MMm.MMm.MMm.',   // locked to the machine chug bass (boss 2)
  brkM: 'M..M..M.M..M..MM',   // breakdown chugs
  hold: 'X_______________',
  half: 'X_______X_______',
  push: 'X__X__X_X__X__X_',   // 3+3+2 accents, ringing
  syn:  'X_____X_____X___',
  brk:  'X.....X.....X.X.',   // short stabs
  hit:  'X...............',
  hemM: 'M..m..M..m..M.m.',   // stage 6's hemiola, muted
  hemX: 'X__X__X__X__X___',   // the same, ringing
  nmG:  'M.M.M..M.M.M..M.',   // locked to boss 7's 2+2+3 kick
};

// Modes for `scale` (offsets from the tonic).
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];

// Stage 1: the chorus (soaring answer to the A-section motif), used by sections B and D.
const CHORUS =
  'f5:4 bb5:6 a5:2 g5:2 f5:2 | g5:4 c6:6 bb5:2 a5:2 g5:2 | a5:6 g5:2 f5:4 c5:4 | d5:4 e5:2 f5:2 a5:8 |' +
  'bb5:4 a5:2 g5:2 f5:4 d5:4 | e5:4 f5:2 g5:2 c6:8 | c#6:6 b5:2 a5:4 g5:4 | a5:4 e5:2 c#5:2 e5:2 a5:2 c#6:4';
const STAGE_A =
  'd5:3 a4:1 d5:2 e5:2 f5:4 e5:2 f5:2 | g5:3 f5:1 e5:2 d5:2 c5:6 r:2 |' +
  'e5:3 d5:1 c5:2 d5:2 e5:4 g5:4 |';

// Stage 2: the hijaz lick (over B major) that closes every phrase, the verse's first half and
// the chorus.
const HIJAZ = 'f#5:2 g5:2 f#5:2 e5:2 d#5:2 c5:2 b4:4';
const DESERT_A =
  'b4:3 c5:1 d5:2 c5:2 b4:4 f#4:2 a4:2 | b4:2 c5:2 e5:4 d5:2 c5:2 b4:4 |' +
  'b4:3 c5:1 d5:2 e5:2 f#5:4 e5:2 d5:2 | e5:3 d5:1 c5:2 d5:2 e5:8 |';
const DESERT_CHORUS =
  'b4:2 d5:2 g5:8 a5:2 b5:2 | a5:4 f#5:4 d5:6 e5:2 | g5:4 f#5:2 e5:2 b5:8 | a5:4 g5:2 e5:2 c5:4 e5:4 |' +
  'b4:2 d5:2 g5:8 a5:2 b5:2 | c6:4 a5:2 f#5:2 d5:4 f#5:4 | g5:4 e5:2 g5:2 c6:4 b5:2 a5:2 | ' + HIJAZ;
// Stage 3: the verse's first half (a leap up and a glide down, twice) and the syncopated chorus.
const SKY_A =
  'g4:2 c5:2 g5:8 f#5:2 e5:2 | f#5:4 a5:4 d5:8 | e5:2 g5:2 b5:8 a5:2 g5:2 | a5:4 g5:4 e5:8 |';
const SKY_CHORUS7 =
  'd5:2 g5:4 a5:2 b5:6 d6:2 | d6:4 c6:2 a5:2 f#5:6 a5:2 | g5:4 f#5:2 e5:2 b5:6 g5:2 | a5:6 g5:2 e5:8 |' +
  'd5:2 g5:4 a5:2 b5:6 d6:2 | e6:4 d6:2 a5:2 f#6:6 e6:2 | e6:4 d6:2 c6:2 b5:4 c6:2 d6:2 |';
// Boss 3: the main theme (a repeated-note call climbing Dm → Bb → Gm) and its two endings.
const FINAL_A =
  'd5:2 d5:2 a5:4 g5:2 f5:2 e5:2 f5:2 | d5:4 a4:4 d5:4 f5:4 |' +
  'd5:2 d5:2 bb5:4 a5:2 g5:2 f5:2 g5:2 | f5:4 d5:4 bb4:4 d5:4 |' +
  'g5:2 g5:2 d6:4 c6:2 bb5:2 a5:2 bb5:2 | g5:4 d5:4 g5:4 bb5:4 |';
const FINAL_END = 'a5:4 c#6:4 e6:4 a5:4 | g5:2 f5:2 e5:2 c#5:2 e5:2 g5:2 a5:4';
const FINAL_END2 = 'a5:2 bb5:2 a5:2 g5:2 f5:2 e5:2 f5:2 g5:2 | a5:6 g5:2 f5:2 e5:2 c#5:4';
// Stage 4: the orbit's rising call (G minor: a triad climbing an octave and a half), and the
// chorus's first seven bars (its eighth differs: a fall into the bridge, a climb into the loop).
const ORBIT_A =
  'g4:2 bb4:2 d5:4 g5:6 f5:2 | eb5:4 d5:2 c5:2 bb4:4 g4:4 | a4:2 c5:2 f5:4 a5:6 g5:2 | f5:6 e5:2 d5:8 |';
const ORBIT_CHORUS7 =
  'g5:6 bb5:2 eb6:8 | d6:4 c6:2 bb5:2 f5:8 | a5:4 c6:4 f6:6 eb6:2 | d6:6 c6:2 bb5:4 g5:4 |' +
  'eb6:6 d6:2 eb6:4 g6:4 | f6:6 eb6:2 d6:4 bb5:4 | c6:4 eb6:4 g6:4 f6:2 eb6:2 |';
// Boss 4: the call "da-da DAAA" down the Andalusian cadence (Cm Bb Ab G), twice.
const AEGIS_A =
  'g5:3 g5:1 c6:4 bb5:2 g5:2 eb5:2 f5:2 | d5:3 d5:1 bb5:4 ab5:2 f5:2 d5:2 f5:2 |' +
  'eb5:3 eb5:1 ab5:4 g5:2 f5:2 eb5:2 c5:2 | d5:4 b4:4 g4:4 b4:4 |';
// Stage 5: a militant "ta-ta-ta" hook leaping a fifth, and the chorus (VI VII i, VI VII V).
const LUNAR_A =
  'f#5:2 f#5:1 f#5:1 c#6:4 b5:2 a5:2 g#5:2 a5:2 | f#5:4 d5:4 a5:6 f#5:2 |' +
  'e5:2 e5:1 e5:1 b5:4 a5:2 g#5:2 f#5:2 g#5:2 | g#5:6 e5:2 c#5:8 |';
const LUNAR_CHORUS =
  'a5:6 f#5:2 d6:8 | c#6:4 b5:2 a5:2 b5:4 e5:4 | a5:6 g#5:2 f#5:4 c#6:4 | c#6:4 b5:2 a5:2 g#5:2 a5:2 b5:2 c#6:2 |' +
  'd6:6 c#6:2 a5:8 | b5:4 c#6:2 d6:2 e6:8 | e#6:6 d6:2 c#6:4 b5:4 | c#6:4 g#5:2 e#5:2 g#5:2 c#6:2 e#6:4';
// Boss 5: a 3+3+2 riff-melody over the gallop.
const SELENE_A =
  'b4:3 d5:3 f#5:2 e5:3 d5:3 c#5:2 | d5:3 c#5:3 b4:2 f#4:8 |' +
  'g4:3 b4:3 d5:2 f#5:3 e5:3 d5:2 | e5:3 c#5:3 a4:2 e5:8 |';
// Stage 6: the voyage call, all in 3+3+3+3+4 (the hemiola the groove rides), and the chorus's
// first seven bars (its eighth: a half cadence into the bridge, a climb into the loop).
const SOLAR_A =
  'c#5:3 g#5:3 f#5:3 e5:3 g#5:4 | f#5:3 a#5:3 c#6:6 b5:2 a#5:2 | g#5:3 e5:3 c#5:3 e5:3 g#5:4 | a#5:6 g#5:2 f#5:8 |';
const SOLAR_CHORUS7 =
  'b5:6 g#5:2 e6:8 | d#6:4 c#6:2 b5:2 f#5:8 | a#5:4 c#6:4 f#6:6 e6:2 | e6:6 d#6:2 c#6:4 g#5:4 |' +
  'a5:3 c#6:3 e6:3 f#6:3 e6:4 | g#6:6 f#6:2 e6:4 b5:4 | f#6:6 e6:2 c#6:4 a#5:4 |';
// Boss 6: HELIOS's call — a four-16th rattle on the tonic flaring up to the flat sixth (and, in
// the second half, the Neapolitan G-flat: the corona), then falling away over C7(b9).
const HELIOS_A =
  'f5:1 f5:1 f5:1 f5:1 ab5:2 c6:2 db6:6 c6:2 | bb5:2 ab5:2 g5:2 ab5:2 f5:8 |' +
  'f5:1 f5:1 f5:1 f5:1 ab5:2 db6:2 f6:6 eb6:2 | e6:4 db6:2 bb5:2 g5:4 e5:4 |';
// Stage 7: the storm's call — a turn around the tonic flung up a fifth, twice, the second time
// out into C minor (a major third up: the alien, hexatonic shift), and the chorus.
const GAL_A =
  'g#5:1 a#5:1 g#5:1 f#5:1 g#5:4 d#6:6 c#6:2 | b5:4 e6:4 d#6:2 b5:2 g#5:4 |' +
  'g#5:1 a#5:1 g#5:1 f#5:1 g#5:4 d#6:4 e6:2 f#6:2 | g6:6 d#6:2 c6:8 |';
const GAL_CHORUS7 =
  'd#6:6 c#6:2 b5:4 f#5:4 | a#5:6 c#6:2 f#6:8 | g#6:6 f#6:2 d#6:4 b5:4 | b5:4 e6:4 d#6:4 b5:4 |' +
  'd#6:6 c#6:2 b5:4 d#6:4 | f#6:6 e6:2 c#6:4 a#5:4 | g#5:4 b5:4 e6:4 g#6:4 |';
// Boss 7: NEMESIS's riff-melody in the machine's 2+2+3 groups — the minor triad bent by its
// tritone (A over D# minor), the Neapolitan E, then the tritone chord itself.
const NEMESIS_A =
  'd#5:2 f#5:2 a#5:3 a5:2 f#5:2 d#5:3 e5:2 | e5:2 g#5:2 b5:3 a#5:2 g#5:2 e5:3 f#5:2 |' +
  'd#5:2 f#5:2 a#5:3 d#6:2 c#6:2 a#5:3 a5:2 | e6:6 c#6:2 a5:8 |';
// Stage 8: the call in open fifths (B-flat F B-flat, climbing on to C D-flat F), and the chorus.
const COSMOS_A =
  'bb4:2 f5:2 bb5:4 c6:2 db6:2 f6:4 | eb6:4 db6:2 bb5:2 gb5:8 |' +
  'bb4:2 f5:2 bb5:4 c6:2 db6:2 eb6:2 f6:2 | eb6:6 db6:2 c6:4 ab5:4 |';
const COSMOS_CHORUS7 =
  'bb5:8 db6:4 gb6:4 | f6:8 eb6:4 db6:4 | eb6:8 c6:4 ab5:4 | bb5:6 gb5:2 eb5:8 |' +
  'bb5:6 db6:2 gb6:8 | f6:6 gb6:2 ab6:8 | f6:6 e6:2 c6:4 a5:4 |';
// Boss 8: OMEGA — the core's pulse (D A F D, the flat sixth leaning on the fifth), and the
// Dies irae the brass and choir intone in the intro and the hymn.
const OMEGA_A =
  'd5:2 a5:2 f5:2 d5:2 a5:4 bb5:2 a5:2 | g5:2 f5:2 e5:2 f5:2 d5:8 |' +
  'd5:2 bb5:2 f5:2 d5:2 bb5:4 c6:2 bb5:2 | a5:2 g5:2 e5:2 g5:2 c6:8 |';
const DIES_IRAE = 'f5:4 e5:4 f5:4 d5:4 | e5:4 c5:4 d5:8 |';

// Songs. `intro` sections play once; the `loop` plays twice (second pass applies each
// section's `p2` overrides: harmony, doubling, busier drums, other guitar and arp parts), then
// repeats. Every stage/boss loop ends in a build (32nd snare roll, riser, a lead climbing to
// the leading tone) that resolves with a crash on the loop's first downbeat.
const SONGDEF = {
  // Calm, heroic. D major, 100 BPM. 2-bar intro + 16-bar theme.
  title: {
    bpm: 100, key: 2, minor: false, delay: 0.75, intro: ['I'], loop: ['T'],
    S: {
      I: { chords: 'G A', bass: 'hold*2', drums: 'none tfill', arp: 'bellSlow*2', pad: 1 },
      T: {
        chords: 'D Bm G A D F#m G A Bm G D A G Em Asus4 A', leadV: 'brass',
        lead: 'a4:8 d5:4 e5:4 | f#5:12 e5:4 | d5:6 c#5:2 b4:4 d5:4 | c#5:4 b4:4 a4:8 |' +
              'a4:8 d5:4 e5:4 | f#5:8 a5:4 f#5:4 | g5:6 f#5:2 e5:4 d5:4 | e5:16 |' +
              'f#5:6 e5:2 d5:4 f#5:4 | g5:4 b5:4 a5:4 g5:4 | f#5:4 a5:8 f#5:4 | e5:12 a4:4 |' +
              'b4:4 d5:4 g5:4 f#5:4 | e5:4 g5:4 b5:4 a5:4 | a5:8 g5:4 e5:4 | e5:6 d5:2 c#5:4 b4:4',
        bass: 'slow*16', drums: 'tsoft*7 tfill tmain*7 tfill', crash: [0, 8], arp: 'bellA*16', pad: 1,
        p2: { harm: 1, dbl: 'lead+0', arp: 'arpA*16', drums: 'tmain*15 tfill', crash: [0, 8] },
      },
    },
  },

  // COASTAL FRONT. D minor, 160 BPM: the heroic dotted theme over four-on-the-floor, pumping
  // 16th bass and palm-muted power chords; a ringing guitar wall and brass hits under the
  // chorus; a militant bridge whose brass call echoes the fanfare ("da-da-da DA"); a 32nd-roll
  // and riser build into the loop point. 4-bar intro, 40-bar loop: A1 A2 B(chorus)
  // C(militant bridge) D(chorus').
  stage: {
    bpm: 160, key: 2, minor: true, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'Dm Dm Bb A', lead: 'r:48 e5:2 f5:2 g5:2 a5:2 c#6:4 r:4',
        bass: 'hold ped16 p16 build', drums: 'bI bI2 bB fR', crash: [0], rise: 2,
        gtr: 'none ch16*2 hold', arp: 'arpB*4',
      },
      A1: {
        chords: 'Dm Bb C Am Dm Bb Gm A',
        lead: STAGE_A + 'a5:6 g5:2 e5:8 |' +
              'd5:3 a4:1 d5:2 e5:2 f5:4 e5:2 f5:2 | g5:3 f5:1 e5:2 f5:2 d5:4 bb4:4 |' +
              'd5:3 c5:1 bb4:2 a4:2 g4:4 bb4:2 d5:2 | c#5:4 d5:2 e5:6 r:4',
        bass: 'pump*7 build', drums: 'bA*3 bB bA*3 fS', crash: [0],
        gtr: 'ch8*3 syn ch8*3 push', stab: 'hA none*3 hA none*3', arp: 'arpA*8',
        p2: { harm: 1, drums: 'bB*3 bC bB*3 fS', gtr: 'gal*3 syn gal*3 push', arp: 'arpB*8' },
      },
      A2: {
        chords: 'Dm Bb C Am Dm Bb A Dm',
        lead: STAGE_A + 'a5:4 c6:2 b5:2 a5:4 e5:4 |' +
              'f5:3 e5:1 d5:2 e5:2 f5:4 a5:4 | bb5:3 a5:1 g5:2 f5:2 g5:4 d5:4 |' +
              'e5:3 d5:1 c#5:2 d5:2 e5:4 a5:4 | d5:8 r:2 a4:2 c5:2 d5:2',
        bass: 'pump*7 build', drums: 'bA*3 bB bA*3 fT', crash: [0, 4],
        gtr: 'ch8*3 syn ch8*2 push hit', stab: 'hA none*3 hA none*3', arp: 'arpA*8',
        p2: { dbl: 'bell+12', drums: 'bB*3 bC bB*3 fT', gtr: 'gal*3 syn gal*2 push hit', arp: 'arpC*8' },
      },
      B: {
        chords: 'Bb C F Dm Bb C A A', lead: CHORUS,
        bass: 'oct16*7 build', drums: 'bB*7 fS', crash: [0, 4], gtr: 'half*7 push',
        stab: 'hB none hA none hB none hA hA', arp: 'arpB*8',
        p2: { dbl: 'brass-12', drums: 'bC*7 fS', arp: 'arpC*8' },
      },
      C: {
        chords: 'Gm Dm Gm A Bb F Gm A', leadV: 'brass',
        lead: 'g4:2 g4:1 g4:1 bb4:4 d5:6 c5:2 | a4:4 f4:4 d5:8 | g4:2 g4:1 g4:1 d5:4 g5:6 f5:2 | e5:8 c#5:4 e5:4 |' +
              'd5:2 d5:1 d5:1 f5:4 bb5:6 a5:2 | a5:8 c6:4 a5:4 | g5:4 f5:4 d5:4 bb4:4 | e5:2 a5:2 c#6:2 e6:6 r:4',
        bass: 'halves*4 pump*3 build', drums: 'milT*3 fS milB*3 fD', crash: [0, 4], rise: 2,
        gtr: 'brk*4 ch16*3 hold', arp: 'bellA*4 arpB*4',
        p2: { harm: 1 },
      },
      D: {
        chords: 'Bb C F Dm Bb C A A', lead: CHORUS, harm: 1,
        bass: 'oct16*6 p16 build', drums: 'bC*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 hold', stab: 'hB none hA none hB none hD none', arp: 'arpC*8',
        p2: { dbl: 'bell+12' },
      },
    },
  },

  // ARCLIGHT. E minor with phrygian/chromatic colour, 172 BPM: the relentless 16th FM riff
  // under sixteenth palm-mute chugs and eighth-note double kick, brass hits on the downbeats,
  // the driven lead; a half-time crash-stab breakdown before the climb. 2-bar intro, 24-bar
  // loop: A B C(breakdown → build).
  boss: {
    bpm: 172, key: 4, minor: true, delay: 0.5, intro: ['I'], loop: ['A', 'B', 'C'],
    S: {
      I: {
        chords: 'Em Em', bass: 'riff*2', drums: 'bH fD', crash: [0], rise: 1,
        gtr: 'hold ch16', stab: 'hA none',
      },
      A: {
        chords: 'Em Em C B Em Em C B', leadV: 'dlead',
        lead: 'e5:4 b4:2 e5:2 f5:4 e5:4 | g5:4 f5:2 e5:2 d#5:8 | e5:4 c5:2 e5:2 g5:4 a5:4 |' +
              'b5:6 a5:2 g5:2 f#5:2 d#5:4 | e5:4 b4:2 e5:2 f5:4 e5:4 | g5:4 a5:2 b5:2 c6:8 |' +
              'b5:4 a5:2 g5:2 e5:4 c5:4 | d#5:6 f#5:2 b5:8',
        bass: 'riff*8', drums: 'bC*3 bB bC*3 fS', crash: [0],
        gtr: 'ch16*2 half*2 ch16*2 half push', stab: 'hA none hA hA hA none hA hA',
        p2: { harm: 1, drums: 'bD*3 bB bD*3 fS', gtr: 'gal*2 half*2 gal*2 half push' },
      },
      B: {
        chords: 'Am Am Em Em F F B7 B7', leadV: 'dlead',
        lead: 'a5:8 c6:4 b5:4 | a5:4 e5:4 a5:8 | g5:8 b5:4 g5:4 | e5:12 r:4 |' +
              'f5:4 a5:4 c6:8 | c6:4 a5:4 f5:8 | d#6:8 b5:8 | f#5:4 a5:4 b5:4 d#6:4',
        bass: 'riff*8', drums: 'bB*3 bC bB*3 fX', crash: [0, 4],
        gtr: 'half*6 ch16*2', stab: 'hB none hB none hB none hB hB', arp: 'arpC*8',
        p2: { dbl: 'brass-12', drums: 'bG*3 bD bG*3 fX' },
      },
      C: {
        chords: 'Em Em Em Em C D B B', leadV: 'dlead',
        lead: 'r:64 e5:4 f#5:4 g5:4 a5:4 | b5:4 a5:4 b5:4 d6:4 | d#6:16 | b5:4 a5:4 f#5:4 d#5:4',
        bass: 'riff*8', drums: 'brkY*3 fS bD*3 fD', crash: [4], rise: 2,
        gtr: 'brkM*4 half*2 ch16 hold', stab: 'none*4 hB*2 hD hA', arp: 'bellDark*4 none*4', pad: 0.8,
      },
    },
  },

  // SCORCHED CANYON — desert metal. B phrygian: the flat 2nd (C) against a B drone, and the
  // hijaz lick F# G F# E D# C B over B major closing each phrase. 158 BPM: a 3+3+2 kick with
  // doumbek toms, B5 / C5 power-chord chugs locked to it, the zurna-like reed over the
  // oud-like plucked ostinato. 4-bar intro, 40-bar loop: A1 A2 B(chorus) C(canyon bridge,
  // brass horn call) D(chorus').
  stage2: {
    bpm: 158, key: 11, minor: true, scale: PHRYGIAN, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'Bm Bm C B', leadV: 'reed', lead: 'r:48 ' + HIJAZ,
        bass: 'drone ped16 p16 build', drums: 'bI dsI*2 fR', crash: [0], rise: 2,
        gtr: 'none trs*2 hold', arp: 'none pluckA*3',
      },
      A1: {
        chords: 'Bm C Bm C Am G C B', leadV: 'reed',
        lead: DESERT_A + 'a5:4 g5:2 f#5:2 e5:4 c5:2 e5:2 | g5:3 f#5:1 e5:2 d5:2 b4:4 d5:4 |' +
              'c5:3 d5:1 e5:2 g5:2 f#5:4 e5:4 | ' + HIJAZ,
        bass: 'tres*8', drums: 'dsA*3 dsB dsA*3 fT', crash: [0],
        gtr: 'trs*7 push', stab: 'hA none*3 hA none*3', arp: 'pluckA*8',
        p2: { dbl: 'pluck-12', drums: 'dsB*3 dsC dsB*3 fT', gtr: 'gal*7 push', arp: 'pluckB*8' },
      },
      A2: {
        chords: 'Bm C Bm C Am G C Bm', leadV: 'reed',
        lead: DESERT_A + 'a5:4 c6:2 b5:2 a5:4 e5:4 | g5:3 a5:1 b5:2 a5:2 g5:4 d5:4 |' +
              'e5:3 f#5:1 g5:2 f#5:2 e5:2 d5:2 c5:2 d5:2 | b4:8 r:2 f#4:2 a4:2 b4:2',
        bass: 'tres*7 build', drums: 'dsA*3 dsB dsA*3 fR', crash: [0, 4],
        gtr: 'trs*6 push hit', arp: 'pluckA*8',
        p2: { dbl: 'bell+12', drums: 'dsB*3 dsC dsB*3 fR', gtr: 'gal*6 push hit', arp: 'pluckB*8' },
      },
      B: {
        chords: 'G D Em C G D C Em,B', leadV: 'reed', lead: DESERT_CHORUS,
        bass: 'pump*7 halves', drums: 'dsC*7 fS', crash: [0, 4], gtr: 'half*7 push',
        stab: 'hB none hA none hB none hA hA', arp: 'pluckB*8',
        p2: { dbl: 'brass-12', arp: 'bellA*8' },
      },
      C: {
        chords: 'Bm Bm C C Am Am B B', leadV: 'brass',
        lead: 'f#4:8 b4:4 d5:4 | c5:8 b4:8 | e5:8 g5:4 e5:4 | g5:12 f#5:4 |' +
              'a5:8 g5:4 e5:4 | c6:12 b5:4 | b5:4 a5:4 g5:4 f#5:4 | d#5:2 f#5:2 a5:2 b5:6 r:4',
        bass: 'drone*2 halves*2 tres*3 build', drums: 'bH*2 milT fS dsA*3 fD', crash: [0, 4], rise: 2,
        gtr: 'hold*2 brk*2 trs*3 hold', arp: 'bellSlow*4 pluckA*4', pad: 0.8,
        p2: { dbl: 'bell+12', arp: 'bellSlow*4 pluckB*4' },
      },
      D: {
        chords: 'G D Em C G D C Em,B', leadV: 'reed', lead: DESERT_CHORUS, harm: 1,
        bass: 'pump*6 p16 halves', drums: 'dsC*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 push', stab: 'hB none hA none hB none hD none', arp: 'pluckB*4 bellA*4',
        p2: { dbl: 'bell+12' },
      },
    },
  },

  // BEHEMOTH, the land battleship's engine room. A minor (the harmonic-minor E, a phrygian
  // B-flat in the breakdown), 162 BPM; an octave-down chugging FM bass with palm-mute guitars
  // locked to it, a steel clank on the last 16th of every beat over eighth-note double kick,
  // offbeat square stabs and brass hits, a machine arpeggio under a low brass march doubled
  // by the driven lead. 2-bar intro, 24-bar loop: A B(the climb) C(engine-room breakdown).
  boss2: {
    bpm: 162, key: 9, minor: true, delay: 0.5, intro: ['I'], loop: ['A', 'B', 'C'],
    S: {
      I: {
        chords: 'Am Am', bass: 'grind*2', drums: 'mechI fD', crash: [0], rise: 1,
        gtr: 'hold mch', stab: 'hA none', arp: 'arpM*2',
      },
      A: {
        chords: 'Am Am F E Am Am Dm E', leadV: 'brass',
        lead: 'a4:4 c5:2 a4:2 e5:4 d5:2 c5:2 | b4:4 c5:2 b4:2 a4:4 e4:4 |' +
              'f4:4 a4:2 c5:2 f5:4 e5:2 d5:2 | e5:8 g#4:4 b4:4 |' +
              'a4:4 c5:2 a4:2 e5:4 d5:2 c5:2 | b4:4 c5:2 d5:2 e5:4 a5:4 |' +
              'f5:4 e5:2 d5:2 c5:4 d5:4 | e5:4 d5:2 c5:2 b4:2 g#4:2 e4:4',
        bass: 'chug*2 chugM*2 chug*3 chugM', drums: 'mA*3 mB mA*3 fS', crash: [0],
        gtr: 'mch*2 half*2 mch*3 push', stab: 'sM*8', arp: 'arpM*8',
        p2: { dbl: 'dlead-12', drums: 'mB*7 fS', stab: 'hA sM hA hA hA sM hA hA' },
      },
      B: {
        chords: 'F F G G Am Am E E', leadV: 'brass',
        lead: 'c5:8 f5:4 a5:4 | g5:4 f5:4 e5:4 c5:4 | d5:8 g5:4 b5:4 | a5:4 g5:4 f5:4 d5:4 |' +
              'e5:8 a5:4 c6:4 | b5:4 a5:4 g5:4 e5:4 | g#5:8 b5:4 e6:4 | d6:4 b5:4 g#5:4 e5:4',
        bass: 'chugM*4 chug*2 chugM*2', drums: 'mB*3 mA mB*3 fX', crash: [0, 4],
        gtr: 'half*4 mch*2 half ch16', stab: 'hB sA hB sA hB sA hB hB', arp: 'arpM*8',
        p2: { dbl: 'lead+0' },
      },
      C: {
        chords: 'Am Am Am Am Bb Bb E E', leadV: 'brass',
        lead: 'r:64 bb4:8 d5:4 f5:4 | e5:12 d5:4 | e5:4 f5:4 e5:4 d5:4 | e5:2 f5:2 g#5:2 a5:2 b5:8',
        bass: 'grind*4 chugM*4', drums: 'mHalf*3 fS mA*3 fD', crash: [0, 4], rise: 2,
        gtr: 'brkM*4 hold*2 ch16 hold', stab: 'none*4 hB*4', arp: 'arpM*8', pad: 0.8,
        p2: { dbl: 'bell+12', stab: 'hC*4 hB*4' },
      },
    },
  },

  // SKY CITADEL — sky rock. C lydian (the raised 4th, F#, is the flying colour; the chorus
  // leans to G major), 164 BPM; 16th octave bass under four-on-the-floor with offbeat open
  // hats, bell arpeggios, the pulse lead doubled up high by bells over palm-mute chugs, a
  // ringing guitar wall in the chorus, a brass-and-choir bridge above the clouds. 4-bar
  // intro, 40-bar loop: A1 A2 B(chorus) C(bridge) D(chorus').
  stage3: {
    bpm: 164, key: 0, minor: false, scale: LYDIAN, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'C D C D', lead: 'r:48 d5:2 e5:2 f#5:2 g5:2 a5:4 b5:4',
        bass: 'hold octP oct16 build', drums: 'skyI*2 skyIS fR', crash: [0], rise: 2,
        gtr: 'none ch8*2 hold', arp: 'bellSky*4',
      },
      A1: {
        chords: 'C D Em C Am D G D',
        lead: SKY_A + 'e5:2 a5:2 e6:8 d6:2 c6:2 | d6:4 a5:4 f#5:8 | g5:3 a5:1 b5:2 a5:2 g5:4 d5:4 | e5:4 f#5:4 a5:8',
        bass: 'oct16*8', drums: 'skyA*3 skyB skyA*3 fS', crash: [0],
        gtr: 'ch8*3 syn ch8*3 push', stab: 'hA none*3 hA none*3', arp: 'arpB*8',
        p2: { dbl: 'bell+12', drums: 'skyB*3 bB skyB*3 fS', gtr: 'gal*3 syn gal*3 push', arp: 'bellA*8' },
      },
      A2: {
        chords: 'C D Em C Am D Em D',
        lead: SKY_A + 'e5:2 a5:2 e6:8 d6:2 c6:2 | d6:4 e6:4 f#6:8 | e6:4 d6:2 b5:2 g5:4 b5:4 | a5:8 r:2 d5:2 e5:2 f#5:2',
        bass: 'oct16*7 build', drums: 'skyA*3 skyB skyA*3 fT', crash: [0],
        gtr: 'ch8*3 syn ch8*3 hold', arp: 'arpB*8',
        p2: { dbl: 'bell+12', drums: 'skyB*3 bB skyB*3 fT', gtr: 'gal*3 syn gal*3 hold', arp: 'arpC*8' },
      },
      B: {
        chords: 'G D Em C G D C D', lead: SKY_CHORUS7 + ' d6:12 r:4', dbl: 'bell+12',
        bass: 'pump*7 build', drums: 'skyB*7 fS', crash: [0, 4], gtr: 'half*7 push',
        stab: 'hB none hA none hB none hA none', arp: 'bellA*8',
        p2: { harm: 1 },
      },
      C: {
        chords: 'Em C D Bm Em C D D', leadV: 'brass', padV: 'choir',
        lead: 'e5:8 g5:4 b5:4 | c6:4 b5:4 f#5:8 | a5:8 d6:4 a5:4 | b5:12 f#5:4 |' +
              'g5:8 b5:4 e6:4 | e6:4 d6:4 c6:4 f#5:4 | a5:8 f#5:4 a5:4 | d6:2 c6:2 a5:2 g5:2 f#5:2 e5:2 d5:2 e5:2',
        bass: 'halves*4 pump*2 build*2', drums: 'bH*4 bA*3 fR', crash: [0, 4],
        gtr: 'hold*4 ch16*2 half hold', arp: 'bellSlow*4 arpB*4', pad: 1,
        p2: { harm: 1 },
      },
      D: {
        chords: 'G D Em C G D C D', lead: SKY_CHORUS7 + ' d6:2 e6:2 f#6:2 d6:2 a5:2 b5:2 c6:2 d6:2', harm: 1,
        bass: 'pump*6 p16 build', drums: 'bC*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 hold', stab: 'hB none hA none hB none hD none', arp: 'arpC*8',
        p2: { dbl: 'bell+12' },
      },
    },
  },

  // SERAPH. D minor again (the home key at its darkest: B-flat, G minor and the
  // harmonic-minor A major), 170 BPM: sixteenth double kick, galloping bass and guitars,
  // brass hits, choir "aah" swells, the pulse lead with harmony over brass.
  // 4-bar intro, 32-bar loop: A B C(choir, half time → militant build) A2.
  boss3: {
    bpm: 170, key: 2, minor: true, delay: 0.75, intro: ['I'], loop: ['A', 'B', 'C', 'A2'],
    S: {
      I: {
        chords: 'Dm Dm Bb A', leadV: 'brass', padV: 'choir', pad: 1,
        lead: 'r:48 d5:2 e5:2 f5:2 g5:2 a5:4 c#6:4',
        bass: 'hold*2 halves build', drums: 'finI*3 fD', crash: [0], rise: 2,
        gtr: 'hold*2 half ch16', stab: 'hA none hA none',
      },
      A: {
        chords: 'Dm Dm Bb Bb Gm Gm A A', lead: FINAL_A + FINAL_END,
        bass: 'gallop*8', drums: 'bD*3 bG bD*3 fX', crash: [0, 4],
        gtr: 'gal*8', stab: 'hA none hA none hA none hA hA', arp: 'arpC*8',
        p2: { dbl: 'bell+12', drums: 'bD*7 fX', stab: 'hB*8' },
      },
      B: {
        chords: 'Dm Bb C A Dm Bb Gm A',
        lead: 'f5:6 e5:2 d5:4 a5:4 | bb5:6 a5:2 g5:4 f5:4 | e5:6 f5:2 g5:4 c6:4 | c#6:12 a5:4 |' +
              'd6:6 c6:2 a5:4 f5:4 | g5:6 a5:2 bb5:4 d6:4 | d6:4 c6:4 bb5:4 g5:4 | a5:4 e5:4 c#5:4 e5:4',
        bass: 'gallop*7 build', drums: 'bG*3 bD bG*3 fS', crash: [0, 4],
        gtr: 'half*7 push', stab: 'hB*8', arp: 'arpB*8', pad: 0.6,
        p2: { dbl: 'bell+12', arp: 'bellA*8' },
      },
      C: {
        chords: 'Bb F C Dm Bb F Gm A', leadV: 'brass', padV: 'choir',
        lead: 'f5:12 d5:4 | c5:8 f5:4 a5:4 | g5:12 e5:4 | f5:8 a5:4 d6:4 |' +
              'd6:12 c6:4 | a5:8 f5:4 c6:4 | bb5:8 d6:4 g5:4 | a5:4 c#6:4 e6:8',
        bass: 'halves*4 pump*3 build', drums: 'bH*4 milB*3 fR', crash: [0, 4],
        gtr: 'hold*4 half*3 hold', arp: 'bellSlow*4 bellA*4', pad: 1,
        p2: { dbl: 'bell+12' },
      },
      A2: {
        chords: 'Dm Dm Bb Bb Gm Gm A A', lead: FINAL_A + FINAL_END2, dbl: 'bell+12',
        bass: 'gallop*7 build', drums: 'bD*6 fR fD', crash: [0, 4, 6], rise: 2,
        gtr: 'gal*6 ch16 hold', stab: 'hB*8', arp: 'arpC*8',
        p2: { harm: 1, dbl: null },
      },
    },
  },

  // ORBITAL FRONT — Earth orbit. G minor, 166 BPM: a sequencer arpeggio climbing in fives
  // across the 16ths (into the dotted-8th echo) over four-on-the-floor with offbeat-accented
  // hats, pumping 16th bass and palm-mute chugs; the orbit's rising call on the pulse lead,
  // bells an octave up for the starfield; the chorus over a ringing guitar wall and brass
  // hits; a weightless half-time bridge (brass and choir, the Neapolitan A-flat) building back
  // to the chorus. 4-bar intro, 40-bar loop: A1 A2 B(chorus) C(bridge) D(chorus').
  stage4: {
    bpm: 166, key: 7, minor: true, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'Gm Gm Eb D', lead: 'r:48 a4:2 d5:2 f#5:2 a5:2 d6:4 r:4',
        bass: 'hold ped16 p16 build', drums: 'bI bI2 orB fD', crash: [0], rise: 2,
        gtr: 'none ch16*2 hold', arp: 'arpO*4',
      },
      A1: {
        chords: 'Gm Eb F Dm Gm Eb Cm D',
        lead: ORBIT_A + 'g5:2 a5:2 bb5:4 d6:6 c6:2 | bb5:4 g5:2 eb5:2 g5:4 bb5:4 |' +
              'c6:6 bb5:2 a5:2 g5:2 f#5:4 | a5:4 f#5:4 d5:6 r:2',
        bass: 'pump*7 build', drums: 'orA*3 orB orA*3 fS', crash: [0],
        gtr: 'ch8*3 syn ch8*3 push', stab: 'hA none*3 hA none*3', arp: 'arpO*8',
        p2: { dbl: 'bell+12', drums: 'orB*3 bC orB*3 fS', gtr: 'gal*3 syn gal*3 push', arp: 'arpC*8' },
      },
      A2: {
        chords: 'Gm Eb F Dm Gm Eb D Gm',
        lead: ORBIT_A + 'd6:2 c6:2 bb5:4 d6:6 f6:2 | eb6:4 d6:2 bb5:2 g5:4 bb5:4 |' +
              'a5:3 bb5:1 a5:2 f#5:2 d5:4 f#5:4 | g5:8 r:2 d5:2 eb5:2 f5:2',
        bass: 'pump*7 build', drums: 'orA*3 orB orA*3 fT', crash: [0, 4],
        gtr: 'ch8*3 syn ch8*2 push hit', arp: 'arpO*8',
        p2: { harm: 1, drums: 'orB*3 bC orB*3 fT', gtr: 'gal*3 syn gal*2 push hit', arp: 'bellA*8' },
      },
      B: {
        chords: 'Eb Bb F Gm Eb Bb Cm D', lead: ORBIT_CHORUS7 + ' f#6:4 d6:4 a5:4 f#5:4',
        bass: 'oct16*7 build', drums: 'bC*7 fS', crash: [0, 4], gtr: 'half*7 push',
        stab: 'hB none hA none hB none hA hA', arp: 'arpO*8',
        p2: { dbl: 'brass-12', arp: 'bellSky*8' },
      },
      C: {
        chords: 'Cm Cm Gm Gm Ab Ab D D', leadV: 'brass', padV: 'choir', pad: 1,
        lead: 'c5:8 eb5:4 g5:4 | f5:6 eb5:2 d5:4 c5:4 | d5:8 g5:4 bb5:4 | a5:12 g5:4 |' +
              'ab5:8 c6:4 eb6:4 | eb6:6 c6:2 ab5:4 c6:4 | f#5:4 a5:4 d6:4 f#6:4 | f#6:4 e6:2 d6:2 c6:2 bb5:2 a5:2 f#5:2',
        bass: 'halves*4 pump*3 build', drums: 'bH*4 orA orB*2 fD', crash: [0, 4], rise: 2,
        gtr: 'hold*4 ch16*2 hold*2', arp: 'bellSlow*4 arpO*4',
        p2: { dbl: 'bell+12' },
      },
      D: {
        chords: 'Eb Bb F Gm Eb Bb Cm D', harm: 1,
        lead: ORBIT_CHORUS7 + ' a5:2 d6:2 f#6:2 d6:2 a5:2 c6:2 d6:2 f#6:2',
        bass: 'oct16*6 p16 build', drums: 'bD*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 hold', stab: 'hB none hA none hB none hD none', arp: 'arpC*8',
        p2: { arp: 'arpO*6 arpC*2' },
      },
    },
  },

  // AEGIS, the orbital defence battery. C minor (the stage's key a fourth up), 172 BPM: the
  // call "da-da DAAA" down the Andalusian cadence (Cm Bb Ab G, then the Neapolitan D-flat) on
  // the driven lead, over 16th double-kick blasts, galloping bass and guitars and brass hits on
  // the downbeats; the machine sequencer throughout and square "charging" stabs on the
  // offbeats (the battery powering up in the intro, over a tonic-pedal 16th bass); a half-time
  // choir hymn before the last climb to the leading tone. 4-bar intro, 32-bar loop: A B C A2.
  boss4: {
    bpm: 172, key: 0, minor: true, delay: 0.75, intro: ['I'], loop: ['A', 'B', 'C', 'A2'],
    S: {
      I: {
        chords: 'Cm Cm Ab G', leadV: 'brass',
        lead: 'r:32 ab4:8 c5:4 eb5:4 | d5:4 f5:4 g5:4 b5:4',
        bass: 'ped16*2 halves build', drums: 'bH*2 milT fD', crash: [0], rise: 2,
        gtr: 'hold ch16 half ch16', stab: 'sM*2 hA hC', arp: 'arpM*4',
      },
      A: {
        chords: 'Cm Bb Ab G Cm Bb Db G', leadV: 'dlead',
        lead: AEGIS_A + 'g5:3 g5:1 c6:4 d6:2 eb6:2 d6:2 c6:2 | bb5:3 bb5:1 f6:4 eb6:2 d6:2 c6:2 bb5:2 |' +
              'ab5:3 ab5:1 db6:4 c6:2 bb5:2 ab5:2 f5:2 | g5:4 b5:4 d6:4 f6:4',
        bass: 'gallop*8', drums: 'bD*3 bG bD*3 fX', crash: [0, 4],
        gtr: 'gal*3 half gal*3 push', stab: 'hA hA hA hB hA hA hA hB', arp: 'arpM*8',
        p2: { harm: 1, drums: 'bD*7 fX', stab: 'hA sM hA hB hA sM hA hB' },
      },
      B: {
        chords: 'Fm Fm Cm Cm Db Eb G G', dbl: 'bell+12',
        lead: 'ab5:8 c6:4 f6:4 | eb6:6 db6:2 c6:4 ab5:4 | g5:8 c6:4 eb6:4 | d6:6 c6:2 g5:8 |' +
              'f5:4 ab5:4 db6:6 c6:2 | bb5:4 eb6:4 g6:6 f6:2 | f6:4 d6:2 b5:2 g5:4 b5:4 | d6:2 eb6:2 d6:2 c6:2 b5:2 c6:2 d6:2 f6:2',
        bass: 'pump*6 build*2', drums: 'bG*3 bD bG*3 fS', crash: [0, 4],
        gtr: 'half*6 ch16 hold', stab: 'hB*8', arp: 'bellA*8',
        p2: { harm: 1, dbl: null, arp: 'arpC*8' },
      },
      C: {
        chords: 'Ab Eb Bb Cm Ab Eb Fm G', leadV: 'brass', padV: 'choir', pad: 1,
        lead: 'c5:12 eb5:4 | bb4:8 eb5:4 g5:4 | f5:12 d5:4 | eb5:8 g5:4 c6:4 |' +
              'c6:12 bb5:4 | g5:8 bb5:4 eb6:4 | ab5:4 c6:4 f6:4 eb6:4 | d6:4 b5:4 g5:2 b5:2 d6:2 f6:2',
        bass: 'halves*4 pump*3 build', drums: 'bH*4 milB*3 fR', crash: [0, 4],
        gtr: 'hold*4 half*3 hold', stab: 'hA none*3 hA none hA hB', arp: 'bellSlow*4 arpM*4',
        p2: { dbl: 'bell+12' },
      },
      A2: {
        chords: 'Cm Bb Ab G Cm Bb Db G', leadV: 'dlead', dbl: 'bell+12',
        lead: AEGIS_A + 'c6:3 c6:1 g6:4 f6:2 eb6:2 d6:2 eb6:2 | d6:3 d6:1 bb5:4 f5:4 bb5:4 |' +
              'db6:3 db6:1 f6:4 eb6:2 db6:2 c6:2 ab5:2 | b5:2 c6:2 d6:2 f6:2 g6:8',
        bass: 'gallop*7 build', drums: 'bD*6 fR fD', crash: [0, 4, 6], rise: 2,
        gtr: 'gal*6 ch16 hold', stab: 'hB*8', arp: 'arpM*8',
        p2: { harm: 1, dbl: null },
      },
    },
  },

  // LUNAR SIEGE — the assault on the Moon base. F# minor, 168 BPM: a siege march (militant
  // snare drags over four-on-the-floor, pumping 16th bass, palm-mute chugs) under the pulse
  // lead's "ta-ta-ta" hook leaping a fifth, bells leaping across the craters; the chorus
  // climbs VI VII i / VI VII V over a ringing guitar wall; the bridge is the walkers' stomp
  // (half time, floor-tom footsteps, 3+3+2 guitar and brass stabs) under brass and a choir on
  // the Neapolitan G major, then a militant build. 4-bar intro, 40-bar loop: A1 A2 B(chorus)
  // C(bridge) D(chorus').
  stage5: {
    bpm: 168, key: 6, minor: true, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'F#m F#m D C#', lead: 'r:48 g#4:2 c#5:2 e#5:2 g#5:2 c#6:4 r:4',
        bass: 'hold ped16 p16 build', drums: 'bI milT milB fD', crash: [0], rise: 2,
        gtr: 'none ch16*2 hold', arp: 'bellMoon*4',
      },
      A1: {
        chords: 'F#m D E C#m F#m D Bm C#',
        lead: LUNAR_A + 'f#5:2 f#5:1 f#5:1 c#6:4 b5:2 a5:2 g#5:2 a5:2 | b5:4 a5:2 f#5:2 d6:6 c#6:2 |' +
              'b5:3 a5:1 g#5:2 f#5:2 d5:4 f#5:4 | e#5:4 g#5:4 c#6:6 r:2',
        bass: 'pump*7 build', drums: 'mrA*3 mrB mrA*3 fS', crash: [0],
        gtr: 'ch8*3 syn ch8*3 push', stab: 'hA none*3 hA none*3', arp: 'bellMoonS*8',
        p2: { dbl: 'bell+12', drums: 'mrB*3 bC mrB*3 fS', gtr: 'gal*3 syn gal*3 push', arp: 'arpC*8' },
      },
      A2: {
        chords: 'F#m D E C#m F#m D C# F#m',
        lead: LUNAR_A + 'a5:2 a5:1 a5:1 f#6:4 e6:2 d6:2 c#6:2 d6:2 | e6:4 d6:2 a5:2 f#5:4 a5:4 |' +
              'g#5:3 f#5:1 e#5:2 f#5:2 g#5:4 c#6:4 | f#5:8 r:2 c#5:2 d5:2 e5:2',
        bass: 'pump*7 build', drums: 'mrA*3 mrB mrA*3 fT', crash: [0, 4],
        gtr: 'ch8*3 syn ch8*2 push hit', arp: 'bellMoonS*8',
        p2: { harm: 1, drums: 'mrB*3 bC mrB*3 fT', gtr: 'gal*3 syn gal*2 push hit', arp: 'arpC*8' },
      },
      B: {
        chords: 'D E F#m F#m D E C# C#', lead: LUNAR_CHORUS,
        bass: 'oct16*7 build', drums: 'bC*7 fS', crash: [0, 4], gtr: 'half*7 push',
        stab: 'hB none hA none hB none hA hA', arp: 'arpB*8',
        p2: { harm: 1, arp: 'bellMoon*8' },
      },
      C: {
        chords: 'Bm Bm F#m F#m G G C# C#', leadV: 'brass', padV: 'choir', pad: 1,
        lead: 'b4:8 d5:4 f#5:4 | e5:6 d5:2 c#5:4 b4:4 | c#5:8 f#5:4 a5:4 | g#5:12 f#5:4 |' +
              'g5:8 b5:4 d6:4 | d6:6 b5:2 g5:4 b5:4 | e#5:4 g#5:4 c#6:4 e#6:4 | e#6:4 d6:2 c#6:2 b5:2 a5:2 g#5:2 e#5:2',
        bass: 'halves*4 pump*3 build', drums: 'moonH*3 fT milB*3 fD', crash: [0, 4], rise: 2,
        gtr: 'brk*4 ch16*2 hold*2', stab: 'hC none hC none none*4', arp: 'bellSlow*4 bellA*4',
        p2: { dbl: 'bell+12' },
      },
      D: {
        chords: 'D E F#m F#m D E C# C#', lead: LUNAR_CHORUS, harm: 1,
        bass: 'oct16*6 p16 build', drums: 'bD*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 hold', stab: 'hB none hA none hB none hD none', arp: 'arpC*8',
        p2: { arp: 'bellMoon*6 arpC*2' },
      },
    },
  },

  // SELENE, the lunar fortress. B minor (the stage's key a fourth up; harmonic: A# over F#,
  // the Neapolitan C major for the dark cadence), 174 BPM: galloping kick, bass and guitars,
  // the driven lead on a 3+3+2 riff-melody, brass hits on the downbeats, a machine arpeggio;
  // a breakdown of crash stabs under crater-echo bells and a choir before the double-kick
  // climb. 2-bar intro, 32-bar loop: A B C(breakdown → build) A2.
  boss5: {
    bpm: 174, key: 11, minor: true, delay: 0.5, intro: ['I'], loop: ['A', 'B', 'C', 'A2'],
    S: {
      I: {
        chords: 'Bm Bm', bass: 'gallop*2', drums: 'bG fD', crash: [0], rise: 1,
        gtr: 'hold gal', stab: 'hA none', arp: 'bellMoon*2',
      },
      A: {
        chords: 'Bm Bm G A Bm Bm C F#', leadV: 'dlead',
        lead: SELENE_A + 'b5:3 a5:3 f#5:2 d6:3 c#6:3 b5:2 | c#6:3 b5:3 a5:2 f#5:8 |' +
              'g5:3 e5:3 c5:2 e5:3 g5:3 c6:2 | a#5:4 c#6:4 e6:8',
        bass: 'gallop*8', drums: 'bG*3 bD bG*3 fS', crash: [0],
        gtr: 'gal*2 half*2 gal*2 half push', stab: 'hA none hA hA hA none hA hA', arp: 'arpM*8',
        p2: { harm: 1, drums: 'bD*3 bG bD*3 fS' },
      },
      B: {
        chords: 'Em Em Bm Bm G A F# F#', leadV: 'dlead',
        lead: 'e5:8 g5:4 b5:4 | e6:6 d6:2 b5:4 g5:4 | f#5:8 b5:4 d6:4 | c#6:6 b5:2 f#5:8 |' +
              'g5:6 a5:2 b5:4 d6:4 | e6:6 d6:2 c#6:4 a5:4 | a#5:8 c#6:4 e6:4 | f#6:4 e6:2 c#6:2 a#5:2 f#5:2 c#5:4',
        bass: 'pump*6 build*2', drums: 'bC*3 bD bC*3 fX', crash: [0, 4],
        gtr: 'half*6 ch16 hold', stab: 'hB none hB none hB hB hB hB', arp: 'bellA*8',
        p2: { dbl: 'brass-12' },
      },
      C: {
        chords: 'Bm Bm C C Bm Bm F# F#', leadV: 'dlead', padV: 'choir', pad: 0.8,
        lead: 'r:64 b5:8 a5:4 f#5:4 | d6:8 c#6:4 b5:4 | a#5:4 b5:4 c#6:4 e6:4 | f#6:16',
        bass: 'grind*4 gallop*2 build*2', drums: 'brkY*3 fS bD*3 fD', crash: [4], rise: 2,
        gtr: 'brkM*4 gal*2 ch16 hold', stab: 'hC*4 hB*2 hD hA', arp: 'bellMoon*4 arpC*4',
      },
      A2: {
        chords: 'Bm Bm G A Bm Bm C F#', leadV: 'dlead',
        lead: SELENE_A + 'd6:3 c#6:3 b5:2 f#6:3 e6:3 d6:2 | e6:3 d6:3 c#6:2 b5:8 |' +
              'c6:3 b5:3 g5:2 e5:3 g5:3 b5:2 | a#5:2 c#6:2 e6:2 f#6:2 e6:2 c#6:2 a#5:2 c#6:2',
        bass: 'gallop*7 build', drums: 'bD*6 fR fD', crash: [0, 4], rise: 2,
        gtr: 'gal*6 ch16 hold', stab: 'hB*8', arp: 'arpC*8',
        p2: { harm: 1 },
      },
    },
  },

  // SOLAR VOYAGE — past Mars, through the belt, over Jupiter and Saturn's rings into the
  // corona. C# dorian (the raised sixth, A#, is the sunlight; the aeolian A major borrowed for
  // the lift), 170 BPM: the whole groove rides a 3+3+3+3+4 hemiola — kicks, a 16th bass popping
  // its octave every third step, palm-mutes, a triplet-grouped arpeggio — under the pulse lead's
  // voyage call in the same rhythm; the chorus breaks out into a straight four-on-the-floor under
  // a ringing guitar wall and bells in 3s; the bridge is the asteroid belt (tumbling floor toms,
  // brass calling over an A-lydian chord) building back to the chorus, where the hemiola returns
  // with double kick. 4-bar intro, 40-bar loop: A1 A2 B(chorus) C(the belt) D(chorus').
  stage6: {
    bpm: 170, key: 1, minor: true, scale: DORIAN, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'C#m C#m A G#', lead: 'r:48 g#4:3 b#4:3 d#5:3 f#5:3 g#5:4',
        bass: 'drone pump3*2 build', drums: 'solI solA solB fS', crash: [0], rise: 2,
        gtr: 'none hemM*2 hold', stab: 'none none hC none', arp: 'arpS*4',
      },
      A1: {
        chords: 'C#m F# C#m F# A B C#m G#',
        lead: SOLAR_A + 'e5:3 a5:3 c#6:3 b5:3 a5:4 | f#5:3 b5:3 d#6:6 c#6:2 b5:2 |' +
              'c#6:4 g#5:4 e5:4 g#5:4 | b#5:4 g#5:4 d#5:6 r:2',
        bass: 'pump3*7 build', drums: 'solA*3 solB solA*3 fS', crash: [0],
        gtr: 'hemM*3 hemX hemM*3 hemX', stab: 'hA none*3 hA none*3', arp: 'arpS*8',
        p2: { dbl: 'bell+12', drums: 'solB*3 bC solB*3 fS', arp: 'bellS3*8' },
      },
      A2: {
        chords: 'C#m F# C#m F# A B G# C#m',
        lead: SOLAR_A + 'a5:3 c#6:3 e6:3 c#6:3 a5:4 | b5:3 d#6:3 f#6:6 e6:2 d#6:2 |' +
              'd#6:4 b#5:2 d#6:2 g#6:4 f#6:4 | e6:6 d#6:2 c#6:8',
        bass: 'pump3*7 build', drums: 'solA*3 solB solA*3 fT', crash: [0, 4],
        gtr: 'hemM*3 hemX hemM*2 hemX hit', arp: 'arpS*8',
        p2: { harm: 1, drums: 'solB*3 bC solB*3 fT', arp: 'arpC*8' },
      },
      B: {
        chords: 'E B F# C#m A E F# G#', lead: SOLAR_CHORUS7 + ' g#5:4 b#5:4 d#6:8',
        bass: 'oct16*7 build', drums: 'bB*7 fS', crash: [0, 4], gtr: 'half*7 hemX',
        stab: 'hB none hA none hB none hA hA', arp: 'bellS3*8',
        p2: { dbl: 'brass-12', drums: 'bC*7 fS', arp: 'arpS*8' },
      },
      C: {
        chords: 'C#m C#m A A F# F# G# G#', leadV: 'brass',
        lead: 'c#5:3 c#5:3 c#5:3 e5:3 g#5:4 | f#5:6 e5:2 c#5:8 | a4:3 a4:3 a4:3 c#5:3 e5:4 | d#5:6 c#5:2 a4:8 |' +
              'a#4:3 c#5:3 f#5:3 a#5:3 c#6:4 | b5:6 a#5:2 f#5:8 | g#5:3 b#5:3 d#6:3 g#6:3 f#6:4 | d#6:4 b#5:4 g#5:4 d#5:4',
        bass: 'halves*4 pump3*3 build', drums: 'belt*3 fT solA solB*2 fD', crash: [0, 4], rise: 2,
        gtr: 'hemX*4 hemM*3 hold', stab: 'none*4 hC none hC hB', arp: 'bellS3*4 arpS*4',
        p2: { dbl: 'bell+12' },
      },
      D: {
        chords: 'E B F# C#m A E F# G#', harm: 1,
        lead: SOLAR_CHORUS7 + ' g#5:2 b#5:2 d#6:2 g#6:2 f#6:2 d#6:2 b#5:4',
        bass: 'oct16*6 p16 build', drums: 'solD*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 hold', stab: 'hB none hA none hB none hD none', arp: 'arpC*8',
        p2: { arp: 'bellS3*6 arpC*2' },
      },
    },
  },

  // HELIOS, the corona battleship. F minor (harmonic: C major with its E; the Neapolitan G-flat
  // for the flare), 174 BPM, the most frantic groove yet: a thrash skank (the snare on every
  // offbeat eighth) over a chromatic 16th bass circling the tonic, sixteenth palm-mutes and brass
  // hits; the driven lead's rattle-and-flare call; the climb over sixteenth double kick with brass
  // doubling; a brass-and-choir hymn whose second half rides a hammer blast into the last climb.
  // 2-bar intro, 32-bar loop: A B(the climb) C(hymn → blast) A2.
  boss6: {
    bpm: 174, key: 5, minor: true, delay: 0.5, intro: ['I'], loop: ['A', 'B', 'C', 'A2'],
    S: {
      I: {
        chords: 'Fm C', bass: 'burn build', drums: 'bH fD', crash: [0], rise: 1,
        gtr: 'hold ch16', stab: 'hA hD',
      },
      A: {
        chords: 'Fm Fm Db C Fm Fm Gb C', leadV: 'dlead',
        lead: HELIOS_A + 'c6:1 c6:1 c6:1 c6:1 eb6:2 f6:2 gb6:6 f6:2 | eb6:2 db6:2 c6:2 bb5:2 ab5:4 f5:4 |' +
              'gb5:2 bb5:2 db6:4 gb6:6 f6:2 | e6:4 g6:4 e6:2 c6:2 bb5:2 g5:2',
        bass: 'burn*2 pump*2 burn*2 pump*2', drums: 'thA*3 thB thA*3 fS', crash: [0],
        gtr: 'ch16*2 half*2 ch16*2 half*2', stab: 'hA none hA hA hA none hA hA',
        p2: { harm: 1, drums: 'thB*3 blA thB*3 fS', stab: 'hA sA hA hA hA sA hA hA' },
      },
      B: {
        chords: 'Bbm Bbm Fm Fm Gb Ab C C', leadV: 'dlead',
        lead: 'bb5:6 db6:2 f6:8 | f6:4 eb6:2 db6:2 bb5:4 f5:4 | ab5:6 c6:2 f6:8 | eb6:4 db6:2 c6:2 ab5:4 f5:4 |' +
              'gb5:4 bb5:4 db6:4 gb6:4 | f6:4 eb6:4 c6:4 ab5:4 | g5:4 c6:4 e6:4 g6:4 | g6:6 f6:2 e6:4 db6:2 c6:2',
        bass: 'pump*6 build*2', drums: 'thD*3 thB thD*3 fX', crash: [0, 4],
        gtr: 'half*6 ch16 hold', stab: 'hB none hB none hB hB hB hB', arp: 'arpC*8',
        p2: { dbl: 'brass-12' },
      },
      C: {
        chords: 'Db Db Eb Eb Fm Fm C C', leadV: 'brass', padV: 'choir', pad: 0.8,
        lead: 'f5:12 ab5:4 | db6:8 c6:4 ab5:4 | g5:12 bb5:4 | eb6:8 db6:4 bb5:4 |' +
              'c6:12 ab5:4 | f6:8 eb6:4 c6:4 | e6:8 g6:8 | g6:4 e6:4 c6:4 g5:4',
        bass: 'halves*4 p16*3 build', drums: 'bH*4 blA*3 fD', crash: [0, 4], rise: 2,
        gtr: 'hold*4 ch16*3 hold', stab: 'none*4 hA hA hB hA',
        p2: { dbl: 'bell+12' },
      },
      A2: {
        chords: 'Fm Fm Db C Fm Fm Gb C', leadV: 'dlead',
        lead: HELIOS_A + 'c6:1 c6:1 c6:1 c6:1 eb6:2 f6:2 ab6:6 g6:2 | f6:2 eb6:2 db6:2 c6:2 bb5:2 ab5:2 g5:2 f5:2 |' +
              'gb5:2 bb5:2 db6:2 gb6:2 f6:4 db6:4 | g6:2 e6:2 c6:2 bb5:2 g5:2 e5:2 c5:2 e5:2',
        bass: 'burn*2 pump*2 burn*2 pump build', drums: 'thB*6 fR fD', crash: [0, 4, 6], rise: 2,
        gtr: 'ch16*7 hold', stab: 'hB*8',
        p2: { harm: 1 },
      },
    },
  },

  // GALACTIC STORM — through the nebulae to the galactic core. G# minor (harmonic: D# major;
  // the chromatic-mediant chords E minor and C minor for the alien shifts), 172 BPM: a drum &
  // bass two-step with ghost snares over a pumping 16th bass and sixteenth chugs, the pulse
  // lead's storm call, crystal tines (glass) for the star clusters and arpeggios sweeping two
  // octaves (the warp); the chorus switches to four-on-the-floor; the bridge is the nebula —
  // half time, choir and glass on a cycle of minor chords a major third apart (Em G#m Cm) —
  // then the chorus over double kick. 4-bar intro, 40-bar loop: A1 A2 B(chorus) C(nebula) D(chorus').
  stage7: {
    bpm: 172, key: 8, minor: true, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'G#m Em G#m D#', lead: 'r:48 d#5:1 e5:1 d#5:1 g5:1 a#5:4 d#6:8',
        bass: 'hold dnb p16 build', drums: 'dnbI dnbA dnbB fS', crash: [0], rise: 2,
        gtr: 'none ch16*2 hold', arp: 'glassS warp*3',
      },
      A1: {
        chords: 'G#m E G#m Cm C#m A D# D#',
        lead: GAL_A + 'c#5:1 d#5:1 c#5:1 b4:1 c#5:4 g#5:6 f#5:2 | e5:4 a5:4 g#5:2 e5:2 c#5:4 |' +
              'd#5:4 g5:4 a#5:4 d#6:4 | d#6:2 c#6:2 b5:2 a#5:2 g5:2 a#5:2 d#6:4',
        bass: 'p16*7 build', drums: 'dnbA*3 dnbB dnbA*3 fS', crash: [0],
        gtr: 'ch16*3 syn ch16*3 push', stab: 'hA none*3 hA none*3', arp: 'glassA*8',
        p2: { dbl: 'glass+12', drums: 'dnbB*3 bC dnbB*3 fS', arp: 'warp*8' },
      },
      A2: {
        chords: 'G#m E G#m Cm C#m A D# G#m',
        lead: GAL_A + 'c#6:1 d#6:1 c#6:1 b5:1 c#6:4 e6:6 d#6:2 | c#6:4 a5:4 e6:4 c#6:4 |' +
              'a#5:4 g5:2 a#5:2 d#6:4 g5:4 | g#5:8 r:2 d#5:2 f#5:2 a#5:2',
        bass: 'p16*7 build', drums: 'dnbA*3 dnbB dnbA*3 fT', crash: [0, 4],
        gtr: 'ch16*3 syn ch16*2 push hit', arp: 'glassA*8',
        p2: { harm: 1, drums: 'dnbB*3 bC dnbB*3 fT', arp: 'warp*8' },
      },
      B: {
        chords: 'B F# G#m E B F# E D#', lead: GAL_CHORUS7 + ' g6:8 d#6:4 a#5:4',
        bass: 'oct16*7 build', drums: 'bB*7 fS', crash: [0, 4], gtr: 'half*7 push',
        stab: 'hB none hA none hB none hA hA', arp: 'warp*8',
        p2: { dbl: 'glass+12', drums: 'bC*7 fS', arp: 'glassA*8' },
      },
      C: {
        chords: 'Em Em G#m G#m Cm Cm D# D#', padV: 'choir', pad: 1,
        lead: 'b5:8 g5:4 e5:4 | f#5:6 g5:2 b5:8 | d#6:8 b5:4 g#5:4 | a#5:6 b5:2 d#6:8 |' +
              'g6:8 d#6:4 c6:4 | d6:6 d#6:2 g6:8 | a#5:4 d#6:4 g6:8 | a#5:2 g5:2 d#5:2 g5:2 a#5:2 d#6:2 g6:4',
        bass: 'halves*6 p16 build', drums: 'dnbH*3 dnbA dnbH*2 fR fD', crash: [0, 4], rise: 2,
        gtr: 'hold*4 half*2 ch16 hold', arp: 'glassS*8',
        p2: { dbl: 'glass+12', arp: 'warp*4 glassS*4' },
      },
      D: {
        chords: 'B F# G#m E B F# E D#', harm: 1,
        lead: GAL_CHORUS7 + ' a#5:2 d#6:2 g6:2 d#6:2 a#5:2 g5:2 a#5:2 d#6:2',
        bass: 'oct16*6 p16 build', drums: 'bD*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 hold', stab: 'hB none hA none hB none hD none', arp: 'warp*8',
        p2: { arp: 'glassA*6 warp*2' },
      },
    },
  },

  // NEMESIS, the alien mothership. D# minor (the Neapolitan E and the tritone A for the alien
  // chords; harmonic A# major), 175 BPM: a machine groove in 2+2+3 2+2+3 2 — kick, palm-mutes
  // and bass locked together under a straight backbeat, steel clanks (bio-mechanics), a machine
  // arpeggio — under the driven lead's riff-melody in the same groups; the mothership's hymn
  // (brass doubling the lead, crystal tines); a breakdown of clanks and crash stabs, then the
  // lead climbing the octatonic scale (D# E F# G A A# C C#) to the octave. 2-bar intro, 32-bar
  // loop: A B(hymn) C(breakdown → octatonic climb) A2.
  boss7: {
    bpm: 175, key: 3, minor: true, delay: 0.5, intro: ['I'], loop: ['A', 'B', 'C', 'A2'],
    S: {
      I: {
        chords: 'D#m A#', bass: 'nm build', drums: 'nmI fD', crash: [0], rise: 1,
        gtr: 'nmG ch16', stab: 'hA hD', arp: 'arpM*2',
      },
      A: {
        chords: 'D#m E D#m A B C# A# A#', leadV: 'dlead',
        lead: NEMESIS_A + 'f#5:2 b5:2 d#6:3 c#6:2 b5:2 f#5:3 g#5:2 | g#5:2 c#6:2 e#6:3 d#6:2 c#6:2 g#5:3 b5:2 |' +
              'a#5:4 d6:4 e#6:8 | e#6:2 d6:2 c#6:2 a#5:2 g#5:2 e#5:2 d5:2 e#5:2',
        bass: 'nm*8', drums: 'nmA*3 nmB nmA*3 fS', crash: [0],
        gtr: 'nmG*3 half nmG*3 push', stab: 'hA none hA none hA none hA hA', arp: 'arpM*8',
        p2: { harm: 1, drums: 'nmB*3 bD nmB*3 fS' },
      },
      B: {
        chords: 'B B G#m G#m E E A# A#', leadV: 'dlead', dbl: 'brass-12',
        lead: 'd#6:8 f#6:4 d#6:4 | c#6:6 b5:2 f#5:8 | b5:8 d#6:4 g#6:4 | f#6:6 e6:2 d#6:8 |' +
              'e6:8 g#6:4 e6:4 | d#6:6 b5:2 g#5:8 | e#5:4 a#5:4 d6:4 e#6:4 | e#6:4 d6:4 a#5:4 e#5:4',
        bass: 'pump*6 build*2', drums: 'nmB*3 nmA nmB*3 fX', crash: [0, 4],
        gtr: 'half*6 ch16 hold', stab: 'hB none hB none hB hB hB hB', arp: 'glassS*8',
        p2: { harm: 1, dbl: null },
      },
      C: {
        chords: 'D#m D#m E E D#m D#m A A#', leadV: 'dlead', padV: 'choir', pad: 0.8,
        lead: 'r:64 d#5:4 e5:4 f#5:4 g5:4 | a5:4 a#5:4 c6:4 c#6:4 | d#6:12 e6:4 | a#5:2 d6:2 e#6:2 d6:2 a#5:2 e#5:2 d5:4',
        bass: 'grind*4 nm*2 build*2', drums: 'nmBrk*3 fS nmB*3 fD', crash: [4], rise: 2,
        gtr: 'brkM*4 nmG*2 ch16 hold', stab: 'hC*4 hB*2 hD hA', arp: 'glassS*4 arpM*4',
      },
      A2: {
        chords: 'D#m E D#m A B C# A# A#', leadV: 'dlead',
        lead: NEMESIS_A + 'b5:2 d#6:2 f#6:3 e6:2 d#6:2 b5:3 c#6:2 | c#6:2 e#6:2 g#6:3 f#6:2 e#6:2 c#6:3 d#6:2 |' +
              'e#6:6 d6:2 e#6:4 g#6:4 | a#5:2 d6:2 e#6:2 d6:2 a#5:2 g#5:2 e#5:2 d5:2',
        bass: 'nm*7 build', drums: 'nmB*6 fR fD', crash: [0, 4, 6], rise: 2,
        gtr: 'nmG*6 ch16 hold', stab: 'hB*8', arp: 'arpM*8',
        p2: { harm: 1 },
      },
    },
  },

  // EDGE OF INFINITY — the cosmic web, the ancient galaxies, the black hole. B-flat minor (the
  // dorian E-flat major for the far horizon; F major the dominant), 174 BPM: open fifths
  // everywhere — a pulsar arpeggio of roots, fifths and their octaves, a bass bouncing root,
  // fifth, octave in 16ths — under four-on-the-floor with tribal toms; the lead's call climbs in
  // fifths; the chorus is epic half time (16th double kick, the snare on 3) under the choir; the
  // bridge answers the fanfare's dawn motif on brass over timpani, twice turning a major chord
  // minor (B-flat, E-flat), then a militant build. 4-bar intro, 40-bar loop: A1 A2 B(chorus)
  // C(dawn) D(chorus').
  stage8: {
    bpm: 174, key: 10, minor: true, delay: 0.75, intro: ['I'], loop: ['A1', 'A2', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'Bbm Bbm Gb F', leadV: 'brass',
        lead: 'r:16 bb4:4 f5:4 bb5:8 | gb5:8 f5:4 db5:4 | c5:4 f5:4 a5:4 c6:4',
        bass: 'hold halves fifths build', drums: 'cosI*2 cosA fD', crash: [0], rise: 2,
        gtr: 'hold half ch16 hold', arp: 'none bellQ arpQ*2',
      },
      A1: {
        chords: 'Bbm Gb Bbm Ab Gb Db Eb F',
        lead: COSMOS_A + 'gb5:2 db6:2 gb6:4 f6:2 eb6:2 db6:4 | f6:6 eb6:2 db6:4 ab5:4 |' +
              'g5:4 bb5:4 eb6:4 g6:4 | c6:4 a5:4 f5:4 a5:4',
        bass: 'fifths*7 build', drums: 'cosA*3 cosB cosA*3 fS', crash: [0],
        gtr: 'ch8*3 syn ch8*3 push', stab: 'hA none*3 hA none*3', arp: 'arpQ*8',
        p2: { dbl: 'bell+12', drums: 'cosB*3 bC cosB*3 fS', gtr: 'gal*3 syn gal*3 push', arp: 'bellQ*8' },
      },
      A2: {
        chords: 'Bbm Gb Bbm Ab Gb Db F Bbm',
        lead: COSMOS_A + 'gb5:2 db6:2 gb6:4 f6:2 eb6:2 db6:4 | f6:6 eb6:2 db6:4 f6:4 |' +
              'e6:4 c6:4 a5:4 c6:4 | bb5:8 r:2 f5:2 gb5:2 ab5:2',
        bass: 'fifths*7 build', drums: 'cosA*3 cosB cosA*3 fT', crash: [0, 4],
        gtr: 'ch8*3 syn ch8*2 push hit', arp: 'arpQ*8',
        p2: { harm: 1, drums: 'cosB*3 bC cosB*3 fT', arp: 'bellQ*8' },
      },
      B: {
        chords: 'Gb Db Ab Ebm Gb Db F F', padV: 'choir', pad: 0.8,
        lead: COSMOS_CHORUS7 + ' c6:4 a5:4 f5:8',
        bass: 'oct16*7 build', drums: 'cosH*7 fS', crash: [0, 4], gtr: 'half*7 push',
        stab: 'hB none hA none hB none hA hA', arp: 'bellQ*8',
        p2: { dbl: 'bell+12', arp: 'arpQ*8' },
      },
      C: {
        chords: 'Bb Bb,Bbm Gb Ab Eb Ebm F F', leadV: 'brass',
        lead: 'bb4:4 f5:4 bb5:8 | d6:8 db6:8 | gb5:4 db6:4 gb6:8 | f6:6 eb6:2 c6:8 |' +
              'eb5:4 bb5:4 eb6:8 | gb6:8 f6:4 eb6:4 | c6:4 f6:4 a5:4 c6:4 | f5:2 a5:2 c6:2 f6:2 e6:2 c6:2 a5:2 f5:2',
        bass: 'hold*2 halves*4 p16 build', drums: 'cosI*4 milB*2 fR fD', crash: [0, 4], rise: 2,
        gtr: 'hold*4 half*2 ch16 hold', stab: 'hA hB hA hA none*4', arp: 'bellQ*4 arpQ*4',
        p2: { dbl: 'bell+12' },
      },
      D: {
        chords: 'Gb Db Ab Ebm Gb Db F F', harm: 1,
        lead: COSMOS_CHORUS7 + ' a5:2 c6:2 f6:2 a5:2 c6:2 f6:2 a6:4',
        bass: 'oct16*6 p16 build', drums: 'cosH*6 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'half*6 ch16 hold', stab: 'hB none hA none hB none hD none', arp: 'arpQ*8',
        p2: { arp: 'bellQ*6 arpQ*2' },
      },
    },
  },

  // OMEGA, the core at the end of everything: the grand finale. D minor — the first stage's home
  // key — rising to E minor (the first boss's) for the last climb, 175 BPM, the whole battle
  // kit at once. The intro is the Dies irae on brass and choir over timpani; then the core's
  // pulse on the driven lead over gallop and hammer blasts; the hero's theme returns — stage 1's
  // call on the pulse lead, harmonised, over 16th double kick; the hymn (brass and choir on the
  // Dies irae in rising sequence, half time with timpani, a hammer blast under its second half);
  // and the final ascent in E minor on the pulse lead over blasts and gallop, pivoting home
  // through B-flat and A. 4-bar intro, 32-bar loop: A B(the hero) C(hymn) D(ascent, E minor).
  boss8: {
    bpm: 175, key: 2, minor: true, delay: 0.75, intro: ['I'], loop: ['A', 'B', 'C', 'D'],
    S: {
      I: {
        chords: 'Dm Dm Bb A', leadV: 'brass', padV: 'choir', pad: 1,
        lead: DIES_IRAE + 'd5:4 f5:4 bb5:8 | a5:4 c#6:4 e6:8',
        bass: 'hold*2 halves build', drums: 'omI*2 bH fD', crash: [0], rise: 2,
        gtr: 'hold*2 half ch16', stab: 'hA none hA hD',
      },
      A: {
        chords: 'Dm Dm Bb C Dm Dm Gm A', leadV: 'dlead',
        lead: OMEGA_A + 'd6:2 a5:2 f5:2 a5:2 d6:4 e6:2 f6:2 | e6:2 d6:2 c#6:2 d6:2 a5:8 |' +
              'bb5:2 d6:2 g6:4 f6:2 e6:2 d6:4 | c#6:4 e6:4 g6:4 e6:4',
        bass: 'gallop*8', drums: 'bG*3 blA bG*3 fX', crash: [0, 4],
        gtr: 'gal*3 half gal*3 push', stab: 'hA none hA hA hA none hA hB', arp: 'arpC*8',
        p2: { harm: 1, drums: 'blA bG blA bG blA bG blA fX', stab: 'hA hA hA hB hA hA hA hB' },
      },
      B: {
        chords: 'Dm Bb Gm C Dm Bb A A', harm: 1,
        lead: 'd5:3 a4:1 d5:2 e5:2 f5:4 e5:2 f5:2 | g5:3 f5:1 e5:2 d5:2 c5:6 r:2 |' +
              'bb5:3 a5:1 g5:2 a5:2 bb5:4 d6:4 | c6:3 bb5:1 a5:2 g5:2 e5:4 c5:4 |' +
              'd6:3 a5:1 d6:2 e6:2 f6:4 e6:2 f6:2 | g6:3 f6:1 e6:2 d6:2 bb5:4 d6:4 | c#6:6 d6:2 e6:4 a5:4 | e6:8 c#6:4 a5:4',
        bass: 'pump*7 build', drums: 'bD*3 bC bD*3 fS', crash: [0, 4],
        gtr: 'half*7 push', stab: 'hB none hA none hB none hA hA', arp: 'arpA*8',
        p2: { harm: 0, dbl: 'brass-12', drums: 'bD*3 blA bD*3 fS', arp: 'arpB*8' },
      },
      C: {
        chords: 'Dm Dm Gm Gm Bb A C B', leadV: 'brass', padV: 'choir', pad: 1,
        lead: DIES_IRAE + 'bb5:4 a5:4 bb5:4 g5:4 | a5:4 f5:4 g5:8 |' +
              'd6:4 c6:4 d6:4 bb5:4 | c#6:4 e6:4 a5:8 | e6:4 g6:4 c6:4 e6:4 | d#6:4 f#6:4 b5:4 d#6:4',
        bass: 'halves*4 p16*2 build*2', drums: 'omH*4 blA*2 fR fD', crash: [0, 4], rise: 2,
        gtr: 'hold*4 ch16*2 half hold', stab: 'none*4 hB hB hA hA', arp: 'bellSlow*4 arpC*4',
      },
      D: {
        chords: 'Em C D B Em C Bb A', key: 4, minor: true, harm: 1,
        lead: 'b5:4 e6:4 g6:6 f#6:2 | e6:6 d6:2 c6:4 g5:4 | a5:4 d6:4 f#6:6 e6:2 | f#6:4 d#6:4 b5:4 d#6:4 |' +
              'g6:6 f#6:2 e6:4 b5:4 | c6:4 e6:4 g6:8 | f6:4 d6:4 bb5:4 d6:4 | a5:2 c#6:2 e6:2 g6:2 e6:2 c#6:2 a5:2 c#6:2',
        bass: 'gallop*6 p16 build', drums: 'blA*3 bD blA*2 fR fD', crash: [0, 2, 4, 6], rise: 2,
        gtr: 'gal*6 ch16 hold', stab: 'hB*8', arp: 'arpC*8',
        p2: { drums: 'blA*6 fR fD' },
      },
    },
  },

  // Victory fanfare, D major, 150 BPM, ~6 s, then silence.
  clear: {
    bpm: 150, key: 2, minor: false, delay: 0.5, intro: ['F'], loop: null,
    S: {
      F: {
        chords: 'D G,A D',
        lead: 'd5:2 d5:2 d5:2 a4:2 d5:4 f#5:4 | g5:2 f#5:2 g5:2 b5:2 a5:4 c#6:4 | d6:16', harm: 1,
        bass: 'fan fan hold', drums: 'fanA fanB fanEnd', crash: [2], arp: 'arpB arpB bellA', pad: 1,
      },
    },
  },

  // Short, sad. D minor, 112 BPM, falls to the low tonic.
  gameover: {
    bpm: 112, key: 2, minor: true, delay: 0.75, intro: ['G'], loop: null,
    S: {
      G: {
        chords: 'Dm,Bb Gm,A Dm', leadV: 'brass',
        lead: 'f5:3 e5:1 d5:4 a4:4 bb4:4 | g4:6 a4:2 e4:4 c#4:4 | d4:16',
        bass: 'halves halves hold', drums: 'none*3', arp: 'none none bellSlow', pad: 1,
      },
    },
  },
};

// ---------------------------------------------------------------- song compiler (runs once per song)

const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const QUAL = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  dim: [0, 3, 6], sus4: [0, 5, 7], sus2: [0, 2, 7],
};
const VOICE = { lead: iLead, brass: iBrass, bell: iBell, arp: iArp, reed: iReed, pluck: iPluck, dlead: iDLead, glass: iGlass };
const TOM = { h: 57, m: 52, l: 45, f: 40 };
const pcOf = (x) => ((x % 12) + 12) % 12;

function parseChord(sym, warn) {
  let pc = PC[sym[0].toLowerCase()], i = 1;
  if (sym[1] === '#') { pc++; i = 2; } else if (sym[1] === 'b') { pc--; i = 2; }
  const iv = QUAL[sym.slice(i)];
  if (pc === undefined || !iv) warn.push('bad chord ' + sym);
  pc = pcOf(pc || 0);
  const ivs = iv || QUAL[''];
  let mask = 0;
  for (let k = 0; k < ivs.length; k++) mask |= 1 << pcOf(pc + ivs[k]);
  return { pc, iv: ivs, mask };
}

function noteMidi(n) {
  let pc = PC[n[0]], i = 1;
  if (n[1] === '#') { pc++; i = 2; } else if (n[1] === 'b') { pc--; i = 2; }
  return 12 * (parseInt(n.slice(i), 10) + 1) + pc;
}

function parseMelody(str, warn, where) {
  const notes = [];
  let pos = 0;
  const toks = str.replace(/\|/g, ' | ').trim().split(/\s+/);
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok === '|') { if (pos % STEPS) warn.push(where + ': bar line at step ' + pos); continue; }
    const c = tok.indexOf(':');
    const name = tok.slice(0, c), d = parseInt(tok.slice(c + 1), 10);
    if (!(d > 0)) { warn.push(where + ': bad token ' + tok); continue; }
    if (name !== 'r') {
      const m = noteMidi(name);
      if (!(m > 20 && m < 110)) warn.push(where + ': bad note ' + tok);
      else notes.push({ s: pos, m, d, vel: pos % 4 === 0 ? 0.95 : 0.84 });
    }
    pos += d;
  }
  return { notes, len: pos };
}

function parseList(str, n, warn, where) {
  const out = [];
  const toks = String(str).trim().split(/\s+/);
  for (let k = 0; k < toks.length; k++) {
    const [name, cnt] = toks[k].split('*');
    const c = cnt ? parseInt(cnt, 10) : 1;
    for (let i = 0; i < c; i++) out.push(name);
  }
  if (out.length !== n) warn.push(where + ': ' + out.length + ' entries for ' + n + ' bars');
  return out;
}

function keyMask(key, minor, scale) {
  const sc = scale || (minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]);
  let m = 0;
  for (let i = 0; i < sc.length; i++) m |= 1 << pcOf(key + sc[i]);
  return m;
}

// A third (or the next chord tone) below the melody note, diatonic to the bar's harmony.
function harmony(m, ch, kmask) {
  if (ch.mask & (1 << pcOf(m))) {
    for (let d = 3; d <= 9; d++) if (ch.mask & (1 << pcOf(m - d))) return m - d;
  }
  // scale for this bar: chord tones outside the key (e.g. C# over A in D minor) and a
  // chromatic melody note each replace the natural neighbours they alter
  let mask = kmask;
  for (let x = 0; x < 12; x++) {
    if ((ch.mask & (1 << x)) && !(kmask & (1 << x))) { mask |= 1 << x; mask &= ~(1 << pcOf(x - 1)); }
  }
  const mp = pcOf(m);
  if (!(mask & (1 << mp))) { mask |= 1 << mp; mask &= ~(1 << pcOf(mp - 1)); mask &= ~(1 << pcOf(mp + 1)); }
  let h = m - 3, cnt = 0;
  for (let d = 1; d <= 5; d++) if ((mask & (1 << pcOf(m - d))) && ++cnt === 2) { h = m - d; break; }
  // never a minor ninth against a chord tone (Bb over an A chord): use the minor third instead
  if (m - h === 4 && (ch.mask & (1 << pcOf(h - 1))) && !(ch.mask & (1 << pcOf(h)))) h += 1;
  return h;
}

function voicing(ch, low) {
  let r = low + ch.pc;
  if (ch.pc > 6) r -= 12;
  const third = ch.iv[1];
  const out = [r, r + 7, r + 12 + third];
  if (ch.iv.length > 3) out.push(r + ch.iv[3]);
  return out;
}

// The medal chain's snap scale (E G A B C D, see SFX.medal) for a key that lacks one of its
// notes: the key's own scale, as offsets from E. null = the default line fits.
function snapOf(kmask) {
  const ms = SFX.medal.snap;
  for (let i = 0; i < ms.length; i++) {
    if (kmask & (1 << pcOf(4 + ms[i]))) continue;
    const snap = [];
    for (let x = 0; x < 12; x++) if (kmask & (1 << pcOf(4 + x))) snap.push(x);
    return snap;
  }
  return null;
}

function compileSong(name, def) {
  const warn = [];
  const bars = [];
  const sections = [];
  const kmask = keyMask(def.key, def.minor, def.scale);
  const rnd = mulberry(name.length * 7919 + def.bpm);     // deterministic humanisation

  const addSection = (secName, pass) => {
    const base = def.S[secName];
    const s = pass && base.p2 ? Object.assign({}, base, base.p2) : base;
    const where = name + '.' + secName + (pass ? "'" : '');
    const chordSyms = s.chords.trim().split(/\s+/);
    const n = chordSyms.length;
    const b0 = bars.length;
    const chords = [];
    // a section in another key (a modulation): its own harmony, pedal and medal-chain scale
    const mod = s.key !== undefined;
    const skey = mod ? s.key : def.key, smask = mod ? keyMask(s.key, s.minor, s.scale) : kmask;
    const ssnap = mod ? snapOf(smask) || SFX.medal.snap : null;
    for (let i = 0; i < n; i++) {
      const parts = chordSyms[i].split(',');
      const cs = [];
      for (let k = 0; k < parts.length; k++) cs.push(parseChord(parts[k], warn));
      chords.push(cs);
      bars.push(mod ? { ev: [], chord: chordSyms[i], sec: secName, pass, snap: ssnap } : { ev: [], chord: chordSyms[i], sec: secName, pass });
    }
    sections.push({ name: secName, pass, bar: b0, bars: n });
    const chordAt = (bar, step) => { const c = chords[bar]; return c.length > 1 ? c[Math.floor(step * c.length / STEPS)] : c[0]; };
    const push = (abs, fn, m, d, vel, pan, mel) => {
      const bi = Math.floor(abs / STEPS);
      if (bi >= n) return;
      bars[b0 + bi].ev.push({ s: abs % STEPS, fn, m, d, vel, pan: pan || 0, mel: !!mel });
    };

    // melody (+ harmony / doubling)
    if (s.lead) {
      const mel = parseMelody(s.lead, warn, where);
      if (mel.len !== n * STEPS) warn.push(where + ': melody is ' + mel.len + ' steps, expected ' + n * STEPS);
      let fn = VOICE[s.leadV || 'lead'];
      if (!fn) { warn.push(where + ': unknown leadV ' + s.leadV); fn = iLead; }
      let dfn = null, doct = 0;
      if (s.dbl) { const mm = /^(\w+)([+-]\d+)$/.exec(s.dbl); if (mm) { dfn = VOICE[mm[1]]; doct = parseInt(mm[2], 10); } }
      if (s.dbl && !dfn) warn.push(where + ': bad dbl ' + s.dbl);
      for (let i = 0; i < mel.notes.length; i++) {
        const nt = mel.notes[i];
        push(nt.s, fn, nt.m, nt.d, nt.vel, s.harm ? -0.12 : 0, true);
        if (s.harm) {
          const ch = chordAt(Math.floor(nt.s / STEPS), nt.s % STEPS);
          push(nt.s, fn, harmony(nt.m, ch, smask), nt.d, nt.vel * 0.6, 0.28, true);
        }
        const tine = dfn === iBell || dfn === iGlass;
        if (dfn) push(nt.s, dfn, nt.m + doct, nt.d, nt.vel * (tine ? 0.75 : 0.5), tine ? 0.2 : -0.18, true);
      }
    }

    // bass
    if (s.bass) {
      const list = parseList(s.bass, n, warn, where + ' bass');
      for (let bi = 0; bi < n; bi++) {
        const tpl = BASS[list[bi]];
        if (tpl === undefined) { warn.push(where + ': unknown bass ' + list[bi]); continue; }
        for (let st = 0; st < STEPS; st++) {
          const c = tpl[st];
          if (c === '.' || c === '_') continue;
          let len = 1;
          while (st + len < STEPS && tpl[st + len] === '_') len++;
          const ch = chordAt(bi, st);
          const root = 36 + ch.pc;
          const off = c === 'R' ? 0 : c === 'O' ? 12 : c === 'F' ? 7 : c === 'T' ? ch.iv[1]
            : c === 'S' ? (ch.iv[3] || 10) : c === '2' ? 1 : c === '3' ? 3 : c === 'd' ? -1 : c === 'L' ? -5
              : c === 'U' ? -12 : c === 'P' ? skey - ch.pc : c === 'Q' ? skey - ch.pc + 12 : 0;
          const vel = st === 0 ? 1 : st % 4 === 0 ? 0.9 : 0.74 + rnd() * 0.1;
          push(bi * STEPS + st, iBass, root + off, len * 0.88, vel, 0);
        }
      }
    }

    // drums
    if (s.drums) {
      const list = parseList(s.drums, n, warn, where + ' drums');
      for (let bi = 0; bi < n; bi++) {
        const p = DRUM[list[bi]];
        if (!p) { warn.push(where + ': unknown drums ' + list[bi]); continue; }
        const at = bi * STEPS;
        for (let st = 0; st < STEPS; st++) {
          const k = p.k && p.k[st], sn = p.s && p.s[st], h = p.h && p.h[st], tm = p.t && p.t[st], cl = p.c && p.c[st];
          const cr = p.y && p.y[st];
          if (k === 'x') push(at + st, dKick, 0, 1, 1);
          else if (k === 'g') push(at + st, dKick, 0, 1, 0.62);
          if (cr === 'x') push(at + st, dCrash, 0, 1, 1);
          else if (cr === 'g') push(at + st, dCrash, 0, 1, 0.55);
          if (cl === 'x') push(at + st, dClank, 0, 1, 1);
          else if (cl === 'g') push(at + st, dClank, 0, 1, 0.45);
          if (sn === 'x') push(at + st, dSnare, 0, 1, 1);
          else if (sn === 'g') push(at + st, dSnare, 0, 1, 0.3);
          else if (sn === 'r') push(at + st, dSnare, 0, 1, 0.3 + 0.7 * st / 15);
          else if (sn === 'd') push(at + st, dDrag, 0, 1, 0.8);
          else if (sn === 'R') push(at + st, dDrag, 0, 1, 0.3 + 0.7 * st / 15);
          const hv = 0.88 + rnd() * 0.24;
          if (h === 'x') push(at + st, dHat, 0, 1, 0.8 * hv);
          else if (h === 'X') push(at + st, dHat, 0, 1, 1.05 * hv);
          else if (h === 'g') push(at + st, dHat, 0, 1, 0.42 * hv);
          else if (h === 'o') push(at + st, dOHat, 0, 1, 0.9);
          if (tm && TOM[tm]) push(at + st, dTom, TOM[tm], 1, 1);
        }
      }
    }
    if (s.crash) for (let i = 0; i < s.crash.length; i++) push(s.crash[i] * STEPS, dCrash, 0, 1, 1);

    // arpeggios
    if (s.arp) {
      const list = parseList(s.arp, n, warn, where + ' arp');
      for (let bi = 0; bi < n; bi++) {
        if (!(list[bi] in ARP)) { warn.push(where + ': unknown arp ' + list[bi]); continue; }
        const a = ARP[list[bi]];
        if (!a) continue;
        const fn = VOICE[a.v];
        for (let st = 0; st < STEPS; st++) {
          const c = a.p[st];
          if (c === '.') continue;
          const idx = c.charCodeAt(0) - 48;
          const ch = chordAt(bi, st);
          const nIv = ch.iv.length;
          const base = (ARP_BASE[a.v] || 55) + pcOf(ch.pc - 7);
          const m = base + ch.iv[idx % nIv] + 12 * Math.floor(idx / nIv);
          push(bi * STEPS + st, fn, m, 2, a.vel, st % 4 < 2 ? -0.3 : 0.3);
        }
      }
    }

    // pad (or choir, voiced an octave higher)
    if (s.pad) {
      const choir = s.padV === 'choir', pfn = choir ? iChoir : iPad;
      if (s.padV && !choir) warn.push(where + ': unknown padV ' + s.padV);
      for (let bi = 0; bi < n; bi++) {
        const cs = chords[bi];
        const len = STEPS / cs.length;
        for (let k = 0; k < cs.length; k++) push(bi * STEPS + k * len, pfn, voicing(cs[k], choir ? 60 : 48), len, s.pad, 0);
      }
    }

    // stabs
    if (s.stab) {
      const list = parseList(s.stab, n, warn, where + ' stab');
      for (let bi = 0; bi < n; bi++) {
        const p = STAB[list[bi]];
        if (!p) { warn.push(where + ': unknown stab ' + list[bi]); continue; }
        for (let st = 0; st < STEPS; st++) {
          const c = p[st];
          if (c === '.') continue;
          const ch = chordAt(bi, st);
          const r = 48 + ch.pc - (ch.pc > 6 ? 12 : 0);
          if (c === 'x') push(bi * STEPS + st, iStab, [r, r + ch.iv[1], r + 7], 1, st === 0 ? 1 : 0.8, 0);
          else if (c === 'H') push(bi * STEPS + st, iHit, r, 1, st === 0 ? 1 : 0.85, 0);
          else warn.push(where + ': bad stab ' + list[bi]);
        }
      }
    }

    // power-chord guitar: roots E2..D#3, open chords rung through their '_' ties
    if (s.gtr) {
      const list = parseList(s.gtr, n, warn, where + ' gtr');
      for (let bi = 0; bi < n; bi++) {
        const tpl = GTR[list[bi]];
        if (tpl === undefined) { warn.push(where + ': unknown gtr ' + list[bi]); continue; }
        for (let st = 0; st < STEPS; st++) {
          const c = tpl[st];
          if (c === '.' || c === '_') continue;
          let len = 1;
          while (st + len < STEPS && tpl[st + len] === '_') len++;
          const root = 40 + pcOf(chordAt(bi, st).pc - 4);
          if (c === 'x' || c === 'X') push(bi * STEPS + st, iGtr, root, len * 0.9, c === 'X' ? 1 : 0.8, 0);
          else if (c === 'm' || c === 'M') push(bi * STEPS + st, iChug, root, 1, c === 'M' ? 1 : 0.72, 0);
          else warn.push(where + ': bad gtr ' + list[bi]);
        }
      }
    }

    // riser over the section's last `rise` bars
    if (s.rise) {
      if (!(s.rise > 0 && s.rise <= n)) warn.push(where + ': bad rise ' + s.rise);
      else push((n - s.rise) * STEPS, iRiser, 0, s.rise * STEPS, 1, 0);
    }
  };

  for (let i = 0; i < def.intro.length; i++) addSection(def.intro[i], 0);
  const introBars = bars.length;
  let loopBars = 0;
  if (def.loop) {
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < def.loop.length; i++) addSection(def.loop[i], pass);
    loopBars = (bars.length - introBars) / 2;
  }
  for (let i = 0; i < bars.length; i++) bars[i].ev.sort((a, b) => a.s - b.s);
  const barSec = (60 / def.bpm) * 4;
  if ((def.delay * 60) / def.bpm > 1.5) warn.push(name + ': echo delay longer than 1.5 s');
  const snap = snapOf(kmask);
  return {
    name, bpm: def.bpm, sps: 60 / def.bpm / 4, bars, warn, sections,
    loopFrom: def.loop ? introBars : -1,
    introBars, loopBars,
    delay: (def.delay * 60) / def.bpm,
    introSec: introBars * barSec,
    loopSec: loopBars * barSec,
    totalSec: bars.length * barSec,
    vol: def.vol || 1, key: def.key, minor: !!def.minor, snap,
  };
}

const SONG_CACHE = Object.create(null);
function getSong(name) {
  if (!Object.prototype.hasOwnProperty.call(SONGDEF, name)) return null;
  return SONG_CACHE[name] || (SONG_CACHE[name] = compileSong(name, SONGDEF[name]));
}
export const MUSIC_TRACKS = Object.keys(SONGDEF);

// ---------------------------------------------------------------- sequencer

class Track {
  constructor(E, name, song, when) {
    const ctx = E.ctx;
    this.name = name;
    this.song = song;
    this.out = E.gain(0);           // dry + delay return; doubles as the crossfade gain
    this.fv = E.gain(0);            // reverb-return crossfade
    this.verb = E.gain(0.3);        // reverb send
    this.dly = E.gain(0.2);         // echo send
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = song.delay;
    this.fb = E.gain(0.3);
    this.dlp = E.filt('lowpass', 2600, 0.5);
    this.dly.connect(this.delay);
    this.delay.connect(this.dlp);
    this.dlp.connect(this.fb);
    this.fb.connect(this.delay);
    this.dlp.connect(this.out);
    this.verb.connect(this.fv);
    this.out.connect(E.musicVol);
    this.fv.connect(E.musicVerbVol);
    const t0 = when - 0.03 > 0 ? when - 0.03 : 0;
    this.out.gain.setValueAtTime(0, t0);
    this.out.gain.linearRampToValueAtTime(song.vol, when + 0.02);
    this.fv.gain.setValueAtTime(0, t0);
    this.fv.gain.linearRampToValueAtTime(song.vol, when + 0.02);
    this.bar = 0;
    this.step = 0;
    this.ei = 0;
    this.next = when;
    this.t0 = when;                 // the first step's time, and when music() asked for it (sync checks)
    this.req = when;
    this.loops = 0;
    this.done = false;
    this.endAt = Infinity;
    this.pad = null;
    this.padBus = () => {
      if (this.pad) return this.pad;
      // stereo chorus: dry left-ish, a slowly modulated 9-15 ms copy right-ish
      const inp = E.gain(1), d = ctx.createDelay(0.05), lfo = E.osc('sine', 0.63, ctx.currentTime, 1e9), depth = E.gain(0.003);
      d.delayTime.value = 0.012;
      lfo.connect(depth); depth.connect(d.delayTime);
      inp.connect(this.panTo(-0.45));
      inp.connect(d); d.connect(this.panTo(0.45));
      this.pad = inp;
      this.padNodes = [inp, d, lfo, depth];
      return inp;
    };
    this.pans = [];
    this.panTo = (p) => {
      const ps = this.pans;
      for (let i = 0; i < ps.length; i++) if (ps[i].v === p) return ps[i].n;
      if (!E.hasPan) return this.out;
      const n = E.ctx.createStereoPanner();
      n.pan.value = p < -1 ? -1 : p > 1 ? 1 : p;
      n.connect(this.out);
      ps.push({ v: p, n });
      return n;
    };
  }
  fadeOut(t, dur) {
    for (let i = 0; i < 2; i++) {
      const p = (i ? this.fv : this.out).gain;
      const v = p.value;
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
      p.linearRampToValueAtTime(0, t + dur);
    }
    this.endAt = t + dur;
  }
  kill() {
    try {
      this.out.disconnect(); this.fv.disconnect();
      this.delay.disconnect(); this.fb.disconnect(); this.dlp.disconnect();
      for (let i = 0; i < this.pans.length; i++) this.pans[i].n.disconnect();
      if (this.padNodes) { this.padNodes[2].stop(); for (let i = 0; i < 4; i++) this.padNodes[i].disconnect(); }
    } catch (e) { /* already disconnected */ }
    this.done = true;
    this.endAt = 0;
  }
}

function schedTrack(E, tr, horizon, now) {
  const song = tr.song, sps = song.sps, bars = song.bars;
  const lim = horizon < tr.endAt ? horizon : tr.endAt;
  while (!tr.done && tr.next < lim) {
    const evs = bars[tr.bar].ev;
    const play = tr.next >= now - 0.015;      // skip (don't cram) steps we fell behind on
    while (tr.ei < evs.length && evs[tr.ei].s === tr.step) {
      const e = evs[tr.ei++];
      if (play) e.fn(E, tr, tr.next, e.m, e.d * sps, e.vel, e.pan);
    }
    tr.next += sps;
    if (++tr.step >= STEPS) {
      tr.step = 0;
      tr.ei = 0;
      if (++tr.bar >= bars.length) {
        if (song.loopFrom >= 0) { tr.bar = song.loopFrom; tr.loops++; }
        else tr.done = true;
      }
    }
  }
}

Object.assign(Engine.prototype, {
  // --- music
  music(name, when) {
    const now = when !== undefined ? when : this.ctx.currentTime;
    const song = name ? getSong(name) : null;
    if (song && this.cur && this.cur.name === name && !this.cur.done) {
      if (this.cur.frozen) this.thaw(now);      // same song requested while paused: carry on
      return;
    }
    if (this.cur) {
      if (this.cur.frozen) {                    // paused song: drop it outright
        for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i] === this.cur) this.tracks[i] = null;
        this.cur.kill();
      } else this.cur.fadeOut(now, 0.6);
      this.cur = null;
    }
    if (!song) return;
    let idx = -1;
    for (let i = 0; i < this.tracks.length; i++) if (!this.tracks[i]) { idx = i; break; }
    if (idx < 0) {          // rapid switching filled every slot: drop the one ending soonest
      idx = 0;
      for (let i = 1; i < this.tracks.length; i++) if (this.tracks[i].endAt < this.tracks[idx].endAt) idx = i;
      this.tracks[idx].kill();
    }
    // A stage fanfare fired for this theme a moment ago (main.js: play(startSfx), then
    // music(theme) in the same frame): start on the fanfare's grid, not on this call's clock,
    // which can have moved on by a few render quanta while the fanfare was being built (more
    // so before the bake lands). Should the gap exceed MUSIC_LEAD, the theme joins that grid
    // a few 16ths in, so its beats still fall on the fanfare's hits.
    let at = now + MUSIC_LEAD, skip = 0;
    if (when === undefined && this.fanSong === name && now >= this.fanT && now - this.fanT < 0.25) {
      const t0 = this.fanT + MUSIC_LEAD;
      if (t0 >= now + 0.002) at = t0;
      else { skip = Math.ceil((now + 0.002 - t0) / song.sps); at = t0 + skip * song.sps; }
    }
    this.fanSong = null;
    const tr = new Track(this, name, song, at);
    tr.req = now;
    if (skip) {
      tr.t0 = at - skip * song.sps;
      tr.step = skip % STEPS;
      tr.bar = (skip - tr.step) / STEPS;
      const evs = song.bars[tr.bar].ev;
      while (tr.ei < evs.length && evs[tr.ei].s < tr.step) tr.ei++;
    }
    this.tracks[idx] = tr;
    this.cur = tr;
  },

  // Pause: rewind the current song to the step audible right now and silence it; thaw()
  // continues from exactly there (the notes already queued ahead are discarded with the old
  // output nodes). Finished jingles are left to ring out.
  freeze(now) {
    const tr = this.cur;
    if (!tr || tr.done || tr.frozen) return;
    const song = tr.song;
    let back = Math.ceil((tr.next - now) / song.sps - 1e-6);
    let bar = tr.bar, step = tr.step - (back > 0 ? back : 0);
    while (step < 0) {
      step += STEPS;
      bar--;
      if (bar < 0) { bar = 0; step = 0; break; }
      if (bar < song.loopFrom && tr.loops > 0) { bar = song.bars.length - 1; tr.loops--; }
    }
    const evs = song.bars[bar].ev;
    let ei = 0;
    while (ei < evs.length && evs[ei].s < step) ei++;
    tr.bar = bar; tr.step = step; tr.ei = ei;
    tr.frozen = true;
    for (let i = 0; i < 2; i++) {
      const p = (i ? tr.fv : tr.out).gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + 0.06);
    }
  },

  thaw(now) {
    const old = this.cur;
    if (!old || !old.frozen) return;
    const tr = new Track(this, old.name, old.song, now + 0.08);
    tr.bar = old.bar; tr.step = old.step; tr.ei = old.ei; tr.loops = old.loops;
    for (let i = 0; i < 2; i++) {             // gentle fade back in
      const p = (i ? tr.fv : tr.out).gain;
      p.cancelScheduledValues(0);
      p.setValueAtTime(0, now);
      p.linearRampToValueAtTime(tr.song.vol, now + 0.35);
    }
    for (let i = 0; i < this.tracks.length; i++) if (this.tracks[i] === old) this.tracks[i] = tr;
    old.kill();
    this.cur = tr;
  },

  // quickly fade every SFX voice that started before `keepAfter`
  hush(now, keepAfter) {
    for (let i = 0; i < this.pool.length; i++) {
      const s = this.pool[i];
      if (s.end > now && s.start < keepAfter) this.release(s, now);
    }
  },

  // Schedules every track up to `horizon`; returns false when nothing needs the timer.
  schedule(horizon, now) {
    let active = false;
    for (let i = 0; i < this.tracks.length; i++) {
      const tr = this.tracks[i];
      if (!tr || tr.frozen) continue;
      const faded = tr !== this.cur && now > tr.endAt + 0.3;
      const finished = tr.done && now > tr.next + 5;
      if (faded || finished) {
        tr.kill();
        this.tracks[i] = null;
        if (tr === this.cur) this.cur = null;
        continue;
      }
      schedTrack(this, tr, horizon, now);
      active = true;
    }
    return active;
  },

  // --- sfx with voice limiting
  playSfx(name, opts, now) {
    const def = SFX[name];
    if (!def) return false;
    const pool = this.pool;
    let p = 0, vol = 1, pan = 0;
    if (opts) {
      if (+opts.pitch) p = +opts.pitch < -48 ? -48 : +opts.pitch > 48 ? 48 : +opts.pitch;
      if (opts.vol !== undefined && opts.vol !== null) vol = clamp01(+opts.vol || 0);
      if (+opts.pan) pan = +opts.pan;
    }
    if (def.snap) {                  // the theme's key (a modulating section's, when it has one)
      const tr = this.cur, bb = tr && tr.song.bars[tr.bar];
      p = snapUp(p, (bb && bb.snap) || (tr && tr.song.snap) || def.snap);
    }
    if (def.hold) {
      // sustained sound (laser beam): a call while its voice lives just keeps it alive
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        if (s.h && s.name === name && s.end > now) { this.refresh(s, def, now); return true; }
      }
    }
    const lt = this.last[name];
    if (lt !== undefined && now >= lt && now - lt < def.gap) return false;
    let same = 0, oldest = null, free = null, victim = null;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (s.end <= now) {
        if (s.g && s.end < now - 0.3) this.bury(s, now);   // detach finished voices from the bus
        if (!free) free = s;
        continue;
      }
      if (s.name === name) { same++; if (!oldest || s.start < oldest.start) oldest = s; }
      if (s.pri <= def.pri && (!victim || s.pri < victim.pri || (s.pri === victim.pri && s.start < victim.start))) victim = s;
    }
    const slot = same >= def.max ? oldest : free || victim;
    if (!slot) return false;          // everything busy with more important sounds
    if (slot.end > now) this.release(slot, now);
    if (slot.g) this.bury(slot, now + 0.3);
    const gv = this.grave;
    for (let i = 0; i < gv.length; i++) if (gv[i].g && gv[i].at <= now) this.drop(gv[i]);
    // streak attenuation: a sound fired as a sustained stream (hits on a boss, armour pings)
    // settles 5-7 dB lower than an isolated one, so a long fight doesn't grind
    let sf = 1;
    if (def.streak) {
      const el = lt === undefined ? 1e9 : now - lt;
      const h = (this.heat[name] || 0) * Math.exp(-(el > 0 ? el : 0) / 0.5) + 1;
      this.heat[name] = h;
      if (h > def.streak[0]) sf = 1 / (1 + (h - def.streak[0]) * def.streak[1]);
    }
    this.last[name] = now;

    const stack = same < def.max ? same : def.max - 1;
    const k = vol * def.lvg * sf / (1 + 0.3 * stack);   // mix level; density attenuation for piles
    const g = this.gain(k);
    const pn = this.out(g, this.sfxVol, pan);
    let vg = null;
    if (def.verb) { vg = this.gain(k * def.verb); vg.connect(this.sfxVerb); }
    let dur;
    const bk = def.bake;
    const smp = bk && this.smp ? this.smp[name + (bk[0] > 1 ? (Math.random() * bk[0]) | 0 : 0)] : null;
    slot.h = null;
    if (smp) {
      // baked: one buffer source straight into the voice gain(s)
      const r = semis(p + (def.jit ? (Math.random() * 2 - 1) * def.jit : 0));
      const src = this.ctx.createBufferSource();
      src.buffer = smp;
      if (r !== 1) src.playbackRate.value = r;
      src.connect(g);
      if (vg) src.connect(vg);
      src.start(now);
      dur = smp.duration / r;
    } else {
      const bus = this.bus;
      bus.out = g; bus.verb = vg; bus.dly = null;
      if (def.hold) { this.hsrc = []; this.henv = null; }
      dur = def.fn(this, bus, now, p, 1);
      bus.out = null; bus.verb = null;
      if (def.hold && this.henv) slot.h = { env: this.henv, srcs: this.hsrc, rel: now + def.hold, stopAt: now + 2 };
      this.hsrc = null; this.henv = null;
    }
    slot.name = name; slot.pri = def.pri; slot.start = now; slot.end = now + dur; slot.g = g; slot.v = vg; slot.p = pn;
    return true;
  },

  // keep a sustained voice alive for another `hold` seconds (no allocation)
  refresh(s, def, now) {
    const h = s.h, pr = h.env.gain;
    if (!h.fixed && h.stopAt - now < 0.6) {
      // re-calling stop() moves the stop time (last call wins, per spec). An engine that
      // refuses gets the voice released just before its sources stop; the next call after
      // that simply starts a fresh voice.
      try {
        for (let i = 0; i < h.srcs.length; i++) h.srcs[i].stop(now + 2);
        h.stopAt = now + 2;
      } catch (e) { h.fixed = true; }
    }
    const lim = h.fixed ? h.stopAt - 0.12 : Infinity;
    if (now >= lim) return;                              // ending for good: let it
    pr.cancelScheduledValues(now);                       // drops the pending release
    if (now >= h.rel - 0.002) pr.setTargetAtTime(1, now, 0.01);   // already fading: swell back
    const cap = now + def.hold >= lim;
    h.rel = cap ? lim : now + def.hold;
    pr.setTargetAtTime(0, h.rel, cap ? 0.02 : 0.03);
    s.end = cap ? lim + 0.1 : h.rel + 0.2;
  },

  drop(slot) {
    try {
      slot.g.disconnect();
      if (slot.v) slot.v.disconnect();
      if (slot.p) slot.p.disconnect();
    } catch (e) { /* ignore */ }
    slot.g = slot.v = slot.p = null;
  },

  // hand a voice's nodes to the grave; they are disconnected once `at` has passed
  bury(slot, at) {
    const gv = this.grave[this.graveI];
    this.graveI = (this.graveI + 1) % this.grave.length;
    if (gv.g) this.drop(gv);
    gv.g = slot.g; gv.v = slot.v; gv.p = slot.p; gv.at = at;
    slot.g = slot.v = slot.p = null;
  },

  release(slot, now) {
    for (let i = 0; i < 2; i++) {
      const n = i ? slot.v : slot.g;
      if (!n) continue;
      const p = n.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + 0.02);
    }
    slot.end = now;
  },
});

// ---------------------------------------------------------------- live instance + public API

const settings = { musicVol: 0.8, sfxVol: 0.9, duck: 1, muted: false };
let E = null;
let ctx = null;
let timer = 0;
let lastTick = 0;
let paused = false;          // suspend() called (game paused)
let autoSuspended = false;   // page hidden
let idleTimer = 0;
let wantTrack = null;
let listening = false;
let deferred = false;        // init() is waiting for the first real user gesture
let unlockAt = -1e9;         // performance.now() of the last resume request (see play())
const noop = () => {};

// Would the browser let an AudioContext run right now? (sticky user activation). Creating or
// resuming one before any gesture only earns an autoplay-policy console warning.
function canStart() {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    return !ua || ua.hasBeenActive;
  } catch (e) { return true; }
}
function onDeferredGesture() {
  if (!deferred) return;
  try { if (canStart()) audio.init(); } catch (e) { /* ignore */ }
}

function tick() {
  try {
    if (!E) return;
    const pn = performance.now();
    const gap = lastTick ? (pn - lastTick) / 1000 : 0.03;
    lastTick = pn;
    // throttled timers (background tabs, busy main thread) get a longer lookahead; 0.2 s
    // minimum rides out the frame hitches of a busy 3D page on a phone
    let la = gap * 1.6;
    la = la < 0.2 ? 0.2 : la > 1.0 ? 1.0 : la;
    const now = ctx.currentTime;
    if (!E.schedule(now + la, now)) stopTimer();
  } catch (e) { /* audio must never break the game */ }
}
function startTimer() {
  if (timer || !E) return;
  lastTick = 0;
  timer = setInterval(tick, 25);
  tick();
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = 0; }
}
// while paused, suspend the AudioContext after a quiet spell (battery); play() re-arms it
function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = 0;
    try { if (paused && ctx.state === 'running') ctx.suspend().catch(noop); } catch (e) { /* ignore */ }
  }, 1500);
}
function disarmIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
}
function safeResume() {
  try {
    if (!canStart()) return;
    unlockAt = performance.now();
    const p = ctx.resume();
    if (p && p.catch) p.catch(noop);
  } catch (e) { /* ignore */ }
}
function onGesture() {
  if (ctx && !paused && !autoSuspended && ctx.state !== 'running' && ctx.state !== 'closed') safeResume();
}
function onVisibility() {
  if (!ctx) return;
  if (document.hidden) {
    if (ctx.state === 'running') { autoSuspended = true; stopTimer(); try { ctx.suspend().catch(noop); } catch (e) { /* ignore */ } }
  } else if (autoSuspended) {
    autoSuspended = false;
    if (!paused) { safeResume(); startTimer(); }
  }
}

export const audio = {
  // Create / resume the AudioContext. Call from a user gesture. Safe to call repeatedly.
  init() {
    try {
      if (E && ctx.state === 'closed') { stopTimer(); disarmIdle(); E = null; ctx = null; paused = false; }
    } catch (e) { /* ignore */ }
    if (E) {
      try {
        if (ctx.state !== 'running' && ctx.state !== 'closed') safeResume();
        if (paused) { armIdle(); return true; }   // unlock only; the game resumes via resume()
        E.applyLevels(settings, false);
        if (wantTrack && !E.cur) E.music(wantTrack);
        if (E.cur) startTimer();
      } catch (e) { /* ignore */ }
      return true;
    }
    try {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return false;
      if (!canStart()) {
        // no user gesture yet (e.g. called from a game loop after a gamepad press): wait for
        // the first real one instead of creating a context the browser would refuse to start
        if (!deferred) {
          deferred = true;
          const o = { capture: true, passive: true };
          window.addEventListener('pointerup', onDeferredGesture, o);
          window.addEventListener('touchend', onDeferredGesture, o);
          window.addEventListener('click', onDeferredGesture, o);
          window.addEventListener('keydown', onDeferredGesture, o);
        }
        return false;
      }
      if (deferred) {
        deferred = false;
        const o = { capture: true };
        window.removeEventListener('pointerup', onDeferredGesture, o);
        window.removeEventListener('touchend', onDeferredGesture, o);
        window.removeEventListener('click', onDeferredGesture, o);
        window.removeEventListener('keydown', onDeferredGesture, o);
      }
      let c;
      try { c = new AC({ latencyHint: 'interactive' }); } catch (e) { c = new AC(); }
      ctx = c;
      E = new Engine(ctx, ctx.destination, settings);
      // iOS unlock: start a silent one-sample buffer inside the gesture
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
      safeResume();
      if (!listening && typeof window !== 'undefined') {
        listening = true;
        const o = { capture: true, passive: true };
        window.addEventListener('pointerdown', onGesture, o);
        window.addEventListener('pointerup', onGesture, o);   // touch: pointerdown doesn't unlock
        window.addEventListener('touchend', onGesture, o);
        window.addEventListener('click', onGesture, o);
        window.addEventListener('keydown', onGesture, o);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      }
      if (wantTrack) { E.music(wantTrack); startTimer(); }
      return true;
    } catch (e) {
      try { if (ctx && ctx.close) ctx.close(); } catch (e2) { /* ignore */ }
      E = null;
      ctx = null;
      return false;
    }
  },

  // Pause (pause menu / tab hidden). The song freezes on the step you hear and resume()
  // continues from exactly there; in-flight SFX fade, except one just triggered (e.g. 'pause').
  // UI sounds still work while paused (menus); after ~1.5 s of quiet the AudioContext itself
  // is suspended to save battery, and play() wakes it on demand.
  suspend() {
    try {
      if (!E || paused) return;
      paused = true;
      stopTimer();
      const now = ctx.currentTime;
      E.freeze(now);
      E.hush(now, now - 0.06);
      armIdle();
    } catch (e) { /* ignore */ }
  },

  resume() {
    try {
      if (!E) return;
      paused = false;
      disarmIdle();
      safeResume();
      E.thaw(ctx.currentTime);
      E.applyLevels(settings, false);
      if (E.cur) startTimer();
    } catch (e) { /* ignore */ }
  },

  setMuted(b) {
    try {
      settings.muted = !!b;
      if (E) E.setMuted(settings.muted);
    } catch (e) { /* ignore */ }
  },
  get muted() { return settings.muted; },

  setMusicVolume(v) {
    try {
      settings.musicVol = clamp01(+v || 0);
      if (E) E.applyLevels(settings, false);
    } catch (e) { /* ignore */ }
  },
  setSfxVolume(v) {
    try {
      settings.sfxVol = clamp01(+v || 0);
      if (E) E.applyLevels(settings, false);
    } catch (e) { /* ignore */ }
  },
  get musicVolume() { return settings.musicVol; },
  get sfxVolume() { return settings.sfxVol; },

  // One-shot SFX. opts = { pitch: semitones, vol: 0..1, pan: -1..1 } (all optional).
  play(name, opts) {
    try {
      if (!E || autoSuspended) return;
      if (paused) { armIdle(); if (ctx.state === 'suspended') safeResume(); }
      // A context that is still starting (resume() requested < 1.5 s ago, e.g. the very click
      // that called init()) plays these as soon as it runs. One that stays locked drops them,
      // so nothing piles up into a burst.
      else if (ctx.state !== 'running' && performance.now() - unlockAt > 1500) return;
      E.playSfx(name, opts, ctx.currentTime);
    } catch (e) { /* ignore */ }
  },

  // 'title' | 'stage' | 'boss' | 'stage2' … 'stage8' | 'boss2' … 'boss8' | 'clear' | 'gameover'
  // | null. Crossfades ~0.6 s. An unknown name stops the music.
  // Requesting the track that is already playing does nothing (a finished jingle restarts).
  music(track) {
    try {
      wantTrack = track && getSong(track) ? track : null;
      if (!E) return;
      if (paused && wantTrack) { paused = false; disarmIdle(); safeResume(); }   // new music = we're live again
      E.music(wantTrack);
      if (!paused) startTimer();
    } catch (e) { /* ignore */ }
  },
  get track() { return E && E.cur ? E.cur.name : null; },

  // Music level multiplier: 1 = normal, 0.35 = ducked to 35 % (pause menu), 0 = silent.
  // Smoothed (~0.1 s); null / undefined / NaN mean 1 (no duck).
  setMusicDuck(v) {
    try {
      const x = v === null || v === undefined ? 1 : +v;
      settings.duck = x === x ? clamp01(x) : 1;
      if (E) E.applyLevels(settings, false);
    } catch (e) { /* ignore */ }
  },

  get ready() { return !!E && !!ctx && ctx.state === 'running'; },
};

// ---------------------------------------------------------------- test hooks (dev/audio.html, harness)
// Everything below builds its own Engine on an OfflineAudioContext; the live instance is untouched.

async function renderOffline(name, seconds, o) {
  o = o || {};
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const sr = o.sampleRate || 44100;
  // 0.3 s pre-roll (excluded from the stats): DynamicsCompressor starts from a cold state and
  // under-reads the first ~150 ms, which would flatter the numbers.
  const PRE = 0.3;
  const len = Math.max(128, Math.ceil(sr * (seconds + PRE)));
  const t0 = performance.now();
  const octx = new OAC(4, len, sr);
  // ch 0-1: final output (post limiter + clip); ch 2-3: pre-limiter master bus
  const merger = octx.createChannelMerger(4);
  const sink = octx.createGain();
  const so = octx.createChannelSplitter(2);
  const sp = octx.createChannelSplitter(2);
  sink.connect(so);
  so.connect(merger, 0, 0);
  so.connect(merger, 1, 1);
  merger.connect(octx.destination);
  const X = new Engine(octx, sink, {
    musicVol: o.musicVol === undefined ? 1 : o.musicVol,
    sfxVol: o.sfxVol === undefined ? 1 : o.sfxVol,
    duck: 1, muted: false,
  });
  X.master.connect(sp);
  sp.connect(merger, 0, 2);
  sp.connect(merger, 1, 3);
  if (!o.live) await X.ready;      // o.live: measure the pure-synthesis fallback path instead
  const setupMs = performance.now() - t0;
  const tR = performance.now();

  // Cues run like the live lookahead scheduler would: incrementally, from
  // OfflineAudioContext.suspend() callbacks, so the graph only ever holds the nodes a real
  // session holds (scheduling a whole song up front would measure a graph nobody plays).
  const cues = [];
  let kind = 'unknown';
  if (Object.prototype.hasOwnProperty.call(SFX, name)) {
    kind = 'sfx';
    const at = PRE + (o.at || 0);
    cues.push([at, () => X.playSfx(name, o.opts || null, at)]);
  } else if (getSong(name)) {
    kind = 'music';
    if (o.only) {
      // stems (mix balance checks): only the events whose part is listed in o.only
      const src = getSong(name), keep = o.only;
      const song = Object.assign({}, src, {
        bars: src.bars.map((b) => Object.assign({}, b, { ev: b.ev.filter((e) => keep.indexOf(stemOf(e)) >= 0) })),
      });
      const tr = new Track(X, name, song, PRE);
      X.tracks[0] = tr;
      X.cur = tr;
    } else X.music(name, PRE - MUSIC_LEAD);
  } else if (name === 'stressRaw' || /^stress[2-9]?$/.test(name)) {
    kind = 'stress';
    stressCues(X, PRE, seconds, name === 'stressRaw', cues, name === 'stressRaw' ? 'boss' : 'boss' + name.slice(6));
  } else if (Object.prototype.hasOwnProperty.call(GAMEPLAY_SCN, name)) {
    kind = 'stress';
    gameplayCues(X, PRE, seconds, cues, GAMEPLAY_SCN[name]);
  } else if (/^runStart[2-9]?$/.test(name)) {
    // what main.js startGame() does: play(stage.startSfx) and music(stage.music) in the same frame
    kind = 'music';
    const n = name.slice(8);
    X.music('stage' + n, PRE - MUSIC_LEAD);
    cues.push([PRE - MUSIC_LEAD, () => X.playSfx('stageStart' + n, null, PRE - MUSIC_LEAD)]);
  } else if (Object.prototype.hasOwnProperty.call(WEAPON_SCN, name)) {
    kind = 'stress';
    weaponCues(X, PRE, seconds, WEAPON_SCN[name], cues);
  } else if (name.slice(0, 5) === 'note:') {
    // one instrument note straight into the music bus (level calibration):
    // 'note:<voice>:<midi>[:<seconds>]'; chord voices get a major triad on that root
    kind = 'note';
    const a = name.split(':'), fn = NOTE_FN[a[1]], m = +a[2] || 60, d = +a[3] || 0.5;
    const chord = fn === iPad || fn === iChoir || fn === iStab;
    const bus = { out: X.musicVol, verb: null, dly: null, panTo: null };
    if (fn) cues.push([PRE, () => fn(X, bus, PRE, chord ? [m, m + 7, m + 16] : m, d, 1, 0)]);
  } else if (name === 'hitStream' || name === 'armorStream') {
    // laser bolts (29/s) pouring into the boss: every one calls hit (vol 0.35) or, on armour,
    // hitArmor (vol 0.5), as game.js does
    kind = 'stress';
    const nm = name === 'hitStream' ? 'hit' : 'hitArmor', v = { vol: nm === 'hit' ? 0.35 : 0.5 };
    for (let t = 0.05; t < seconds; t += 0.034) { const tt = PRE + t; cues.push([tt, () => X.playSfx(nm, v, tt)]); }
  } else if (name === 'calib') {
    // 0.1-amplitude sine straight into the master: measures the chain's small-signal gain
    kind = 'calib';
    const s = octx.createOscillator();
    s.frequency.value = 440;
    const g = octx.createGain();
    g.gain.value = 0.1;
    s.connect(g); g.connect(X.master);
    s.start(0);
  }
  cues.sort((x, y) => x[0] - y[0]);
  let ci = 0;
  const LA = 0.3;
  const pump = (now) => {
    while (ci < cues.length && cues[ci][0] < now + LA) cues[ci++][1]();
    X.schedule(now + LA, now);
  };
  pump(0);
  if (typeof octx.suspend === 'function' && !o.upfront) {
    const q = 128 / sr;
    let lastQ = 0;
    for (let t = 0.1; t < PRE + seconds; t += 0.1) {
      const tq = Math.round(t / q) * q;
      if (tq <= lastQ) continue;
      lastQ = tq;
      octx.suspend(tq).then(() => { pump(tq); octx.resume(); }, noop);
    }
  } else {
    while (ci < cues.length) cues[ci++][1]();
    X.schedule(PRE + seconds + 0.5, 0);
  }
  const buf = await octx.startRendering();
  const durationMs = performance.now() - tR;
  const from = Math.floor(PRE * sr);
  let peak = 0, pre = 0, sum = 0, nan = false;
  for (let c = 0; c < 4; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v !== v || v === Infinity || v === -Infinity) { nan = true; continue; }
      if (i < from) continue;
      const a = v < 0 ? -v : v;
      if (c < 2) { if (a > peak) peak = a; sum += v * v; } else if (a > pre) pre = a;
    }
  }
  const rms = Math.sqrt(sum / (2 * (len - from)));
  const stats = {
    name, kind, seconds, peak, rms, nan, durationMs,
    prePeak: pre, setupMs, msPerSec: durationMs / seconds,
  };
  return { buf, stats, from };
}

function stressCues(X, P, seconds, raw, cues, track) {
  X.music(track || 'boss', P - 0.05);
  const names = ['explodeS', 'explodeM', 'explodeL'];
  const t0 = P + 0.05;
  if (raw) {
    // No voice limiting at all: 30 explosions + a bomb at once, full level, plus shot spam.
    const bus = { out: X.sfxVol, verb: X.sfxVerb, dly: null };
    cues.push([t0, () => {
      for (let i = 0; i < 30; i++) SFX[names[i % 3]].fn(X, bus, t0, 0, 1);
      SFX.bomb.fn(X, bus, t0, 0, 1);
    }]);
    for (let t = 0.05; t < seconds; t += 0.1) {
      const tt = P + t;
      cues.push([tt, () => { SFX.shot.fn(X, bus, tt, 0, 1); SFX.hit.fn(X, bus, tt + 0.03, 0, 1); }]);
    }
    return;
  }
  // Through the real play() path, in chronological order, like the game would call it.
  cues.push([t0, () => {
    for (let i = 0; i < 30; i++) X.playSfx(names[i % 3], null, t0);
    X.playSfx('bomb', null, t0);
  }]);
  for (let t = 0.05, k = 0; t < seconds; t += 0.1, k++) {
    const tt = P + t, kk = k;
    cues.push([tt, () => {
      X.playSfx('shot', null, tt);
      X.playSfx('hit', null, tt + 0.02);
      if (kk % 3 === 0) for (let i = 0; i < 6; i++) X.playSfx(names[i % 3], { pitch: i }, tt + 0.04);
      if (kk % 5 === 0) X.playSfx('medal', { pitch: (kk % 7) * 2 }, tt + 0.06);
    }]);
  }
}

// Weapon scenarios: [SFX name, call interval (s), play() opts, sustained]. Sustained ones get a
// 0.4 s release gap every 2 s (tests hold + restart). 'vulcan' = shot every 75 ms as game.js
// fires it; 'laserBeam' / 'plasmaBeam' = called every 1/60 s frame; 'waveGun' = a wave every
// 90 ms; 'multiSalvo' = the MULTI sub-weapon at the missile's cadence and vol; 'coinTally' =
// the results count-up ticking every frame.
const WEAPON_SCN = {
  vulcan: ['shot', 0.075, null, false],
  laserBeam: ['laser', 1 / 60, null, true],
  plasmaBeam: ['plasma', 1 / 60, null, true],
  waveGun: ['wave', 0.09, null, false],
  multiSalvo: ['multi', 0.45, { vol: 0.6 }, false],
  coinTally: ['coin', 1 / 60, null, false],
};
// Firefights: stage music (null = none), the main weapon (a WEAPON_SCN key, called with no
// release gaps) and the sub-weapon SFX.
const GAMEPLAY_SCN = {
  gameplay: { track: 'stage', weapon: 'vulcan', sub: 'missile' },
  gameplayLaser: { track: 'stage', weapon: 'laserBeam', sub: 'missile' },
  firefight: { track: null, weapon: 'vulcan', sub: 'missile' },
  gameplay2: { track: 'stage2', weapon: 'waveGun', sub: 'multi' },
  gameplay3: { track: 'stage3', weapon: 'plasmaBeam', sub: 'missile' },
  gameplay4: { track: 'stage4', weapon: 'vulcan', sub: 'multi' },
  gameplay5: { track: 'stage5', weapon: 'laserBeam', sub: 'missile' },
  gameplay6: { track: 'stage6', weapon: 'plasmaBeam', sub: 'multi' },
  gameplay7: { track: 'stage7', weapon: 'waveGun', sub: 'missile' },
  gameplay8: { track: 'stage8', weapon: 'vulcan', sub: 'multi' },
};
// Parts for stem renders (opts.only): 'mel' (the melody, its harmony and doubling), 'bass',
// 'drums', 'gtr', 'hits' (brass hits, square stabs), 'arp' (arps, bells, oud), 'pad' (pads,
// choir), 'fx' (risers).
const STEM_OF = new Map([
  [iBass, 'bass'], [iGtr, 'gtr'], [iChug, 'gtr'], [iHit, 'hits'], [iStab, 'hits'], [iArp, 'arp'], [iBell, 'arp'],
  [iPluck, 'arp'], [iGlass, 'arp'], [iPad, 'pad'], [iChoir, 'pad'], [iRiser, 'fx'],
]);
function stemOf(e) { return e.mel ? 'mel' : STEM_OF.get(e.fn) || 'drums'; }
// voices the 'note:' calibration scenario can play
const NOTE_FN = {
  lead: iLead, brass: iBrass, bell: iBell, arp: iArp, reed: iReed, pluck: iPluck, bass: iBass,
  pad: iPad, choir: iChoir, stab: iStab, kick: dKick, snare: dSnare, clank: dClank,
  dlead: iDLead, gtr: iGtr, chug: iChug, hit: iHit, riser: iRiser, drag: dDrag, glass: iGlass,
};

// A busy moment, called exactly the way js/game.js calls it: the main weapon (vulcan every
// 75 ms, or a beam every 1/60 s frame), sub-missiles at vol 0.6, hits at vol 0.35, grazes at
// 0.4, a steady trickle of kills and a medal chain, over the stage music.
function gameplayCues(X, P, seconds, cues, g) {
  if (g.track) X.music(g.track, P - 0.05);
  const r = mulberry(9);
  const w = WEAPON_SCN[g.weapon];
  for (let t = 0.05; t < seconds; t += w[1]) {
    const tt = P + t;
    cues.push([tt, () => X.playSfx(w[0], w[2], tt)]);
  }
  let chain = 0;
  for (let t = 0.05; t < seconds; t += 0.1) {
    const tt = P + t, a = r(), b2 = r(), c = r();
    cues.push([tt, () => {
      if (a < 0.6) X.playSfx('hit', { vol: 0.35, pan: b2 - 0.5 }, tt + 0.03);
      if (b2 < 0.12) X.playSfx('explodeS', { pan: c - 0.5 }, tt + 0.05);
      if (b2 > 0.96) X.playSfx('explodeM', { pan: c - 0.5 }, tt + 0.05);
      if (c < 0.05) { X.playSfx('medal', { pitch: Math.min(chain, 6) * 2 }, tt + 0.07); chain++; }
      if (c > 0.97) X.playSfx('graze', { vol: 0.4 }, tt + 0.02);
      if ((t * 10 | 0) % 5 === 0) X.playSfx(g.sub, { vol: 0.6 }, tt + 0.01);
    }]);
  }
}

// Only the player's weapon (a WEAPON_SCN entry), as the game calls it.
function weaponCues(X, P, seconds, w, cues) {
  for (let t = 0.05; t < seconds; t += w[1]) {
    if (w[3] && t % 2 > 1.6) continue;
    const tt = P + t;
    cues.push([tt, () => X.playSfx(w[0], w[2], tt)]);
  }
}

// The scenario names __renderForTest understands for the tracks this module has (the lab's
// auto test runs them all).
export function __scenarios() {
  const out = ['runStart'];
  for (let n = 2; n <= 9; n++) if (getSong('stage' + n) && SFX['stageStart' + n]) out.push('runStart' + n);
  for (const k in WEAPON_SCN) out.push(k);
  out.push('hitStream', 'armorStream');
  for (const k in GAMEPLAY_SCN) if (!GAMEPLAY_SCN[k].track || getSong(GAMEPLAY_SCN[k].track)) out.push(k);
  out.push('stress');
  for (let n = 2; n <= 9; n++) if (getSong('boss' + n)) out.push('stress' + n);
  out.push('stressRaw');
  return out;
}

// Resolves { peak, rms, nan, durationMs, prePeak, msPerSec, ... } for an SFX name, a music
// track, or a scenario: 'stress' (30 explosions + bomb + shot spam over boss music via
// play(); 'stress2' … 'stress9' over boss2 … boss9), 'stressRaw' (same, bypassing voice
// limiting), 'gameplay' / 'gameplayLaser' / 'gameplay2' … 'gameplay5' (stage music + a
// firefight exactly as game.js calls it, see GAMEPLAY_SCN), 'firefight' (the same without
// music), 'vulcan' / 'laserBeam' / 'plasmaBeam' / 'waveGun' / 'multiSalvo' / 'coinTally' (one
// weapon alone, see WEAPON_SCN), 'hitStream' / 'armorStream' (29 hits/s into a boss at the
// game's volumes), 'runStart' / 'runStart2' … 'runStart9' (a stage's fanfare + its music, as at
// the start of that stage), 'note:<voice>:<midi>[:<sec>]' (one instrument note on the music
// bus, for level calibration), 'calib' (small-signal gain of the master chain).
export async function __renderForTest(nameOrTrack, seconds, opts) {
  const r = await renderOffline(nameOrTrack, seconds || 2, opts);
  return r.stats;
}

// Same, plus the rendered AudioBuffer (4 ch: out L/R, pre-limiter L/R) for visualisation.
export async function __renderBuffer(nameOrTrack, seconds, opts) {
  return renderOffline(nameOrTrack, seconds || 2, opts);
}

// The startup bake on an offline engine: how long it took and every sample's length / peak /
// rms. upfront = the legacy path (every entry created before rendering) for comparison.
export async function __bakeStats(upfront) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const octx = new OAC(2, 128, 44100);
  const X = new Engine(octx, octx.destination, { musicVol: 1, sfxVol: 1, duck: 1, muted: false });
  await X.ready;
  let t0 = performance.now();
  if (upfront) { X.smp = null; await X.bake(true); } else { X.smp = null; await X.bake(); }
  const ms = performance.now() - t0;
  const entries = BAKE.map(([key, , sec]) => {
    const b = X.smp && X.smp[key];
    if (!b) return [key, sec, 0, 0, 0];
    let pk = 0, s = 0;
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; s += d[i] * d[i]; }
    return [key, sec, b.length, pk, Math.sqrt(s / d.length)];
  });
  return { ms, seconds: BAKE.reduce((a, e) => a + e[2] + 0.05, 0), entries };
}

// Live sync probe (harness, in the running game): the current track (name, context time of
// its first step, BPM, key) and the context time each SFX name last started. A stage fanfare
// fired together with its track starts MUSIC_LEAD after that time, i.e. on the track's first
// step. null before init().
export function __liveSync() {
  if (!E) return null;
  const tr = E.cur;
  return {
    now: ctx.currentTime, lead: MUSIC_LEAD,
    track: tr ? { name: tr.name, t0: tr.t0, req: tr.req, bar: tr.bar, step: tr.step, bpm: tr.song.bpm, key: tr.song.key, minor: tr.song.minor } : null,
    last: Object.assign({}, E.last),
  };
}

// Every stage fanfare: its theme, that theme's BPM / key / first-bar kick steps, and the
// fanfare's hit steps, melody notes and final chord (sync / key checks).
const FANFARE_OF = {
  stageStart: FANFARE1, stageStart2: FANFARE2, stageStart3: FANFARE3, stageStart4: FANFARE4, stageStart5: FANFARE5,
  stageStart6: FANFARE6, stageStart7: FANFARE7, stageStart8: FANFARE8,
};
export function __fanfareInfo() {
  const out = {};
  for (const k in FANFARE_OF) {
    const F = FANFARE_OF[k], song = getSong(F.song), steps = [], mel = [], kicks = [];
    for (let i = 0; i < F.seq.length; i += 4) { steps.push(F.seq[i]); mel.push(F.seq[i + 1], F.seq[i + 2]); }
    const ev = song.bars[0].ev;
    for (let i = 0; i < ev.length; i++) if (ev[i].fn === dKick) kicks.push(ev[i].s);
    out[k] = { song: F.song, bpm: song.bpm, key: song.key, minor: song.minor, firstChord: song.bars[0].chord, steps, mel, pad: F.pad.slice(), kicks };
  }
  return out;
}

// Loop lengths, bar counts and notation warnings of every song, plus the section map
// (name, ' = second pass, first bar, bar count, start / end in seconds from the song's start).
export function __songInfo() {
  const out = {};
  for (let i = 0; i < MUSIC_TRACKS.length; i++) {
    const s = getSong(MUSIC_TRACKS[i]);
    let events = 0;
    for (let b = 0; b < s.bars.length; b++) events += s.bars[b].ev.length;
    const barSec = s.sps * STEPS;
    out[s.name] = {
      bpm: s.bpm, key: s.key, minor: s.minor, scale: SONGDEF[s.name].scale || null, snap: s.snap, vol: s.vol,
      introBars: s.introBars, loopBars: s.loopBars,
      introSec: +s.introSec.toFixed(2),
      loopSec: s.loopFrom >= 0 ? +s.loopSec.toFixed(2) : null,
      variationCycleSec: s.loopFrom >= 0 ? +(s.loopSec * 2).toFixed(2) : null,
      lengthSec: s.loopFrom >= 0 ? null : +s.totalSec.toFixed(2),
      events, warn: s.warn,
      sections: s.sections.map((x) => ({
        name: x.name + (x.pass ? "'" : ''), bar: x.bar, bars: x.bars,
        t0: +(x.bar * barSec).toFixed(3), t1: +((x.bar + x.bars) * barSec).toFixed(3),
      })),
    };
  }
  return out;
}
