/*
 * Procedural music + sound effects for World Conquest.
 *
 * Everything here is synthesised at runtime with the Web Audio API: no audio
 * files, no libraries. All motifs are generated from original rhythm cells and
 * chord progressions using a seeded PRNG, so the music varies but stays
 * structured (motif -> variation -> motif -> cadence over 8-bar sections).
 *
 * Signal chain:
 *   instrument voices -> mood bus (crossfade) -> musicGain ----------------> compressor -> master -> out
 *                                 \-> mood wet send -> musicWetGain -> reverb -/
 *   sfx voices -> sfxBus -> sfxGain -------------------------------------> compressor
 *              \-> sfxWetBus -> sfxWetGain -> reverb
 *
 * Nothing touches `window` or `AudioContext` until `audio.init()` is called.
 */

export type Mood = 'menu' | 'peace' | 'war';
export type Sfx = 'click' | 'battle' | 'chime' | 'alarm' | 'fanfare' | 'coins' | 'warhorn' | 'peace';

const STORAGE_KEY = 'wc-audio';
const LOOKAHEAD = 0.6; // seconds scheduled ahead
const TICK_MS = 100;
const FADE = 3.5; // crossfade length (s)
const MAX_VOICES = 56; // non-essential notes are dropped above this
const MUSIC_SCALE = 0.9;
const SFX_SCALE = 1.0;

// ---------------------------------------------------------------- helpers

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// ---------------------------------------------------------------- harmony

/** Pitch classes are relative to the tonic D (D = 0). MIDI 62 = D4. */
const D4 = 62;

const AEOLIAN = [0, 2, 3, 5, 7, 8, 10] as const;
const DORIAN = [0, 2, 3, 5, 7, 9, 10] as const;
const HARMONIC = [0, 2, 3, 5, 7, 8, 11] as const; // for the major V chord
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10] as const; // for the bII chord

const MIN = [0, 3, 7] as const;
const MAJ = [0, 4, 7] as const;
const MIN7 = [0, 3, 7, 10] as const;
const MAJ7 = [0, 4, 7, 11] as const;
const ADD9 = [0, 4, 7, 14] as const;
const SUS2 = [0, 2, 7] as const;

interface Chord {
  r: number; // root, semitones above D
  q: readonly number[]; // intervals
  sc?: readonly number[]; // scale override for melodic passing tones
}

const ch = (r: number, q: readonly number[], sc?: readonly number[]): Chord => ({ r, q, sc });

type Rhythm = readonly (readonly [number, number])[]; // [pos in beats (0..8), duration]

interface MNote {
  pos: number;
  dur: number;
  deg: number;
}

interface MoodDef {
  bpm: number;
  scale: readonly number[];
  progs: readonly (readonly Chord[])[];
  rhythms: readonly Rhythm[];
  reverb: number;
  seed: number;
}

const DEFS: Record<Mood, MoodDef> = {
  menu: {
    bpm: 66,
    scale: AEOLIAN,
    reverb: 0.6,
    seed: 0x5eed01,
    progs: [
      [ch(0, MIN), ch(8, MAJ), ch(3, MAJ), ch(10, MAJ)],
      [ch(0, MIN), ch(5, MIN), ch(8, MAJ), ch(7, MAJ, HARMONIC)],
      [ch(8, MAJ), ch(10, MAJ), ch(0, MIN), ch(0, SUS2)],
      [ch(0, MIN), ch(3, MAJ), ch(10, MAJ), ch(5, MIN)],
      [ch(5, MIN), ch(8, MAJ7), ch(10, MAJ), ch(0, MIN)],
    ],
    rhythms: [
      [[0, 1.5], [1.5, 0.5], [2, 2], [4, 1], [5, 1], [6, 2]],
      [[0, 2], [2, 1], [3, 1], [4, 3]],
      [[0, 1], [1, 1], [2, 1.5], [3.5, 0.5], [4, 3]],
      [[0, 3], [3, 1], [4, 1], [5, 1], [6, 1.5]],
    ],
  },
  peace: {
    bpm: 72,
    scale: DORIAN,
    reverb: 0.5,
    seed: 0x5eed02,
    progs: [
      [ch(0, MIN7), ch(5, MAJ), ch(0, MIN7), ch(5, ADD9)],
      [ch(0, MIN), ch(7, MIN), ch(5, MAJ), ch(0, MIN7)],
      [ch(3, MAJ7), ch(10, MAJ), ch(0, MIN7), ch(5, MAJ)],
      [ch(0, MIN7), ch(2, MIN), ch(3, MAJ7), ch(5, MAJ)],
    ],
    rhythms: [
      [[0, 2], [2, 0.5], [2.5, 0.5], [3, 1], [4, 3]],
      [[1, 1], [2, 1], [3, 1], [4, 2], [6, 1]],
      [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1], [4, 3.5]],
      [[0, 0.5], [0.5, 0.5], [1, 2], [3, 1], [4, 2.5]],
    ],
  },
  war: {
    bpm: 118,
    scale: AEOLIAN,
    reverb: 0.28,
    seed: 0x5eed03,
    progs: [
      [ch(0, MIN), ch(8, MAJ), ch(10, MAJ), ch(0, MIN)],
      [ch(0, MIN), ch(5, MIN), ch(7, MAJ, HARMONIC), ch(0, MIN)],
      [ch(0, MIN), ch(1, MAJ, PHRYGIAN), ch(0, MIN), ch(10, MAJ)],
      [ch(0, MIN), ch(0, MIN), ch(8, MAJ), ch(7, MAJ, HARMONIC)],
      [ch(5, MIN), ch(0, MIN), ch(7, MAJ, HARMONIC), ch(0, MIN)],
    ],
    rhythms: [
      [[0, 0.75], [0.75, 0.25], [1, 1], [2, 0.75], [2.75, 0.25], [3, 1], [4, 2], [6, 1], [7, 1]],
      [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1], [4, 3]],
      [[0, 0.5], [0.5, 0.5], [1, 1], [2, 2], [4, 0.75], [4.75, 0.25], [5, 1], [6, 2]],
    ],
  },
};

/** Chord tone pitch classes relative to D. */
function chordPcs(c: Chord): number[] {
  return c.q.map((i) => (((c.r + i) % 12) + 12) % 12);
}

const relPc = (midi: number): number => (((midi - D4) % 12) + 12) % 12;

/** Close voicing of the chord placed in [lo, lo + 12). */
function voicing(c: Chord, lo: number): number[] {
  const out = c.q.map((i) => {
    let n = D4 - 12 + c.r + i;
    while (n < lo) n += 12;
    while (n >= lo + 12) n -= 12;
    return n;
  });
  return out.sort((a, b) => a - b);
}

/** Chord root in [lo, lo + 12). */
function rootIn(c: Chord, lo: number): number {
  let n = D4 - 24 + c.r;
  while (n < lo) n += 12;
  while (n >= lo + 12) n -= 12;
  return n;
}

/** Bass root, D2..C#3 (36..47). */
const bassOf = (c: Chord): number => rootIn(c, 36);

function degToMidi(deg: number, base: number, scale: readonly number[]): number {
  const oct = Math.floor(deg / 7);
  const idx = ((deg % 7) + 7) % 7;
  return base + 12 * oct + scale[idx];
}

/** Move a pitch to the nearest chord tone (prefers staying / moving down). */
function snap(midi: number, c: Chord): number {
  const pcs = chordPcs(c);
  for (let k = 0; k <= 6; k++) {
    if (pcs.includes(relPc(midi - k))) return midi - k;
    if (pcs.includes(relPc(midi + k))) return midi + k;
  }
  return midi;
}

// ---------------------------------------------------------------- melody generation

function clampDeg(d: number): number {
  return Math.max(-3, Math.min(10, d));
}

function makeMotif(rng: Rng, rhythms: readonly Rhythm[]): MNote[] {
  const r = pick(rng, rhythms);
  let deg = pick(rng, [0, 2, 4, 4, 7]);
  let last = 0;
  const out: MNote[] = [];
  r.forEach(([pos, dur], i) => {
    if (i > 0) {
      let step: number;
      const sign = rng() < 0.5 ? -1 : 1;
      if (Math.abs(last) >= 3) {
        // after a leap, step back the other way
        step = -Math.sign(last) * (rng() < 0.75 ? 1 : 2);
      } else {
        const x = rng();
        step = x < 0.5 ? sign : x < 0.74 ? 2 * sign : x < 0.86 ? 3 * sign : x < 0.92 ? 4 * sign : 0;
      }
      let nd = deg + step;
      if (nd > 9 || nd < -2) nd = deg - step;
      last = nd - deg;
      deg = nd;
    }
    out.push({ pos, dur, deg });
  });
  return out;
}

function varyMotif(a: MNote[], rng: Rng): MNote[] {
  const k = rng();
  let out: MNote[];
  if (k < 0.3) {
    out = a.map((n) => ({ ...n, deg: n.deg + 1 })); // sequence up a step
  } else if (k < 0.5) {
    out = a.map((n) => ({ ...n, deg: n.deg - 1 })); // sequence down
  } else if (k < 0.75) {
    const d = rng() < 0.5 ? 2 : -2;
    out = a.map((n, i) => (i >= a.length - 2 ? { ...n, deg: n.deg + d } : n)); // new ending
  } else {
    // ornament the longest note with an upper neighbour
    let li = 0;
    a.forEach((n, i) => {
      if (n.dur > a[li].dur) li = i;
    });
    out = [];
    a.forEach((n, i) => {
      if (i === li && n.dur >= 1) {
        out.push({ pos: n.pos, dur: 0.5, deg: n.deg + 1 });
        out.push({ pos: n.pos + 0.5, dur: n.dur - 0.5, deg: n.deg });
      } else out.push(n);
    });
  }
  return out.map((n) => ({ ...n, deg: clampDeg(n.deg) }));
}

function cadenceOf(a: MNote[], rng: Rng): MNote[] {
  const shift = rng() < 0.5 ? 0 : -1;
  const head = a
    .filter((n) => n.pos < 4)
    .map((n) => ({ pos: n.pos, dur: Math.min(n.dur, 4 - n.pos), deg: clampDeg(n.deg + shift) }));
  const lastDeg = head.length ? head[head.length - 1].deg : 2;
  let end = 0;
  for (const c of [0, 4, 7]) if (Math.abs(c - lastDeg) < Math.abs(end - lastDeg)) end = c;
  head.push({ pos: 4, dur: 3.5, deg: end });
  return head;
}

// ---------------------------------------------------------------- synth voices

interface Graph {
  comp: DynamicsCompressorNode;
  master: GainNode;
  reverb: ConvolverNode;
  reverbOut: GainNode;
  musicGain: GainNode;
  musicWet: GainNode;
  sfxGain: GainNode;
  sfxWet: GainNode;
  sfxBus: GainNode;
  sfxWetBus: GainNode;
}

class Synth {
  voices = 0;

  constructor(
    readonly ctx: AudioContext,
    private readonly noise: AudioBuffer,
  ) {}

  canPlay(essential: boolean): boolean {
    return essential || this.voices < MAX_VOICES;
  }

  private osc(type: OscillatorType, freq: number, t: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    o.start(t);
    return o;
  }

  private noiseSrc(t: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(t, Math.random() * (this.noise.duration - 0.1));
    return s;
  }

  private gain(v = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /** Connect `node` to `out`, optionally through a stereo panner. */
  private route(node: AudioNode, out: AudioNode, pan: number, nodes: AudioNode[]): void {
    if (pan !== 0 && typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      p.connect(out);
      nodes.push(p);
    } else node.connect(out);
  }

  /** Register a voice: stop sources at `end` and disconnect everything afterwards. */
  private finish(sources: AudioScheduledSourceNode[], nodes: AudioNode[], end: number): void {
    if (!sources.length) return;
    this.voices++;
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      this.voices--;
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      for (const s of sources) {
        try {
          s.disconnect();
        } catch {
          /* ignore */
        }
      }
    };
    for (const s of sources) {
      try {
        s.stop(end);
      } catch {
        /* ignore */
      }
    }
    sources[0].onended = cleanup;
  }

  /** Attack-hold-release envelope with click-free ramps. Returns end time. */
  private ahr(p: AudioParam, t: number, a: number, peak: number, holdUntil: number, r: number): number {
    const top = Math.max(t + a, holdUntil);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.setValueAtTime(peak, top);
    p.linearRampToValueAtTime(0, top + r);
    return top + r;
  }

  /** Percussive envelope. Returns end time. */
  private perc(p: AudioParam, t: number, a: number, peak: number, decay: number): number {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + decay);
    p.linearRampToValueAtTime(0, t + a + decay + 0.02);
    return t + a + decay + 0.03;
  }

  private vibrato(t: number, rate: number, depthCents: number, delay: number, sources: AudioScheduledSourceNode[], nodes: AudioNode[]): GainNode {
    const lfo = this.osc('sine', rate, t);
    const lg = this.gain(0);
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(depthCents, t + delay);
    lfo.connect(lg);
    sources.push(lfo);
    nodes.push(lg);
    return lg;
  }

  /** String ensemble pad: detuned saws -> lowpass, slow envelope, gentle vibrato. */
  strings(out: AudioNode, t: number, notes: number[], dur: number, vel: number, attack = 0.7, release = 1.3, cutoff = 1500): void {
    if (!this.canPlay(true)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const f = this.filter('lowpass', cutoff, 0.4);
    const g = this.gain();
    nodes.push(f, g);
    const vib = this.vibrato(t, 5.1, 6, 0.8, sources, nodes);
    for (const m of notes) {
      for (const d of [-8, 7]) {
        const o = this.osc('sawtooth', mtof(m), t, d + (Math.random() - 0.5) * 3);
        vib.connect(o.detune);
        o.connect(f);
        sources.push(o);
      }
    }
    f.connect(g);
    g.connect(out);
    const end = this.ahr(g.gain, t, attack, vel / Math.sqrt(notes.length * 2) / 1.6, t + dur, release);
    this.finish(sources, nodes, end + 0.05);
  }

  /** Short string notes, used for tremolo-like repeated sixteenths. */
  stringShort(out: AudioNode, t: number, notes: number[], dur: number, vel: number, pan = 0): void {
    if (!this.canPlay(false)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const f = this.filter('lowpass', 1600, 0.6);
    const g = this.gain();
    nodes.push(f, g);
    for (const m of notes) {
      const o = this.osc('sawtooth', mtof(m), t, (Math.random() - 0.5) * 10);
      o.connect(f);
      sources.push(o);
    }
    f.connect(g);
    this.route(g, out, pan, nodes);
    const peak = vel / Math.sqrt(notes.length);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.012);
    g.gain.setTargetAtTime(peak * 0.5, t + 0.02, dur * 0.4);
    g.gain.linearRampToValueAtTime(0, t + dur);
    this.finish(sources, nodes, t + dur + 0.02);
  }

  /** Low brass: saws with a filter envelope that opens on the attack. */
  brass(out: AudioNode, t: number, notes: number[], dur: number, vel: number, attack = 0.08, bright = 1, essential = true): void {
    if (!this.canPlay(essential)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const f = this.filter('lowpass', 250, 1.6);
    const g = this.gain();
    nodes.push(f, g);
    for (const m of notes) {
      for (const d of [-5, 5]) {
        const o = this.osc('sawtooth', mtof(m), t, d);
        o.connect(f);
        sources.push(o);
      }
    }
    const lo = 220;
    f.frequency.setValueAtTime(lo, t);
    f.frequency.linearRampToValueAtTime(lo + 2000 * bright, t + attack + 0.06);
    f.frequency.setTargetAtTime(lo + 800 * bright, t + attack + 0.08, 0.35);
    f.connect(g);
    g.connect(out);
    const end = this.ahr(g.gain, t, attack, vel / Math.sqrt(notes.length * 2), t + dur, Math.min(0.35, 0.1 + dur * 0.3));
    this.finish(sources, nodes, end + 0.05);
  }

  /** Solo horn (or flute-like when `flute`) lead voice with delayed vibrato. */
  lead(out: AudioNode, t: number, m: number, dur: number, vel: number, flute = false, pan = 0): void {
    if (!this.canPlay(true)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const f = this.filter('lowpass', flute ? 4200 : 1900, flute ? 0.5 : 0.9);
    const g = this.gain();
    nodes.push(f, g);
    const vib = this.vibrato(t, flute ? 5.4 : 4.8, flute ? 9 : 11, Math.min(0.6, dur * 0.6), sources, nodes);
    const freq = mtof(m);
    const parts: [OscillatorType, number, number][] = flute
      ? [
          ['sine', 1, 0.8],
          ['triangle', 2, 0.12],
        ]
      : [
          ['triangle', 1, 0.7],
          ['sine', 1, 0.45],
          ['sawtooth', 1, 0.12],
        ];
    for (const [type, mul, lvl] of parts) {
      const o = this.osc(type, freq * mul, t);
      const og = this.gain(lvl);
      vib.connect(o.detune);
      o.connect(og);
      og.connect(f);
      sources.push(o);
      nodes.push(og);
    }
    if (flute) {
      // breath
      const n = this.noiseSrc(t);
      const bp = this.filter('bandpass', freq * 2, 2);
      const ng = this.gain(0.05);
      n.connect(bp);
      bp.connect(ng);
      ng.connect(f);
      sources.push(n);
      nodes.push(bp, ng);
    }
    f.connect(g);
    this.route(g, out, pan, nodes);
    const end = this.ahr(g.gain, t, flute ? 0.06 : 0.09, vel, t + dur, 0.28);
    this.finish(sources, nodes, end + 0.05);
  }

  /** Harp / pluck. */
  harp(out: AudioNode, t: number, m: number, vel: number, pan = 0): void {
    if (!this.canPlay(false)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const freq = mtof(m);
    const f = this.filter('lowpass', 3200, 0.7);
    const g = this.gain();
    nodes.push(f, g);
    const o1 = this.osc('triangle', freq, t);
    const o2 = this.osc('sine', freq * 2, t);
    const g2 = this.gain(0.25);
    o1.connect(f);
    o2.connect(g2);
    g2.connect(f);
    sources.push(o1, o2);
    nodes.push(g2);
    f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 1.2);
    f.connect(g);
    this.route(g, out, pan, nodes);
    const decay = m > 76 ? 1.1 : 1.8;
    const end = this.perc(g.gain, t, 0.004, vel, decay);
    this.finish(sources, nodes, end);
  }

  /** Timpani hit: sine with pitch drop + overtone + noise thump. */
  timpani(out: AudioNode, t: number, m: number, vel: number, decay = 1.6, pan = 0): void {
    if (!this.canPlay(true)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const freq = mtof(m);
    const g = this.gain();
    nodes.push(g);
    const o = this.osc('sine', freq * 1.1, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.09);
    const o2 = this.osc('sine', freq * 1.5, t);
    const g2 = this.gain();
    this.perc(g2.gain, t, 0.004, 0.35, decay * 0.4);
    o.connect(g);
    o2.connect(g2);
    g2.connect(g);
    const n = this.noiseSrc(t);
    const lp = this.filter('lowpass', 380, 0.8);
    const ng = this.gain();
    this.perc(ng.gain, t, 0.002, 0.9, 0.12);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(g);
    sources.push(o, o2, n);
    nodes.push(g2, lp, ng);
    this.route(g, out, pan, nodes);
    const end = this.perc(g.gain, t, 0.005, vel, decay);
    this.finish(sources, nodes, end);
  }

  /** Timpani roll (amplitude-modulated sustain with crescendo). */
  timpRoll(out: AudioNode, t: number, m: number, dur: number, v0: number, v1: number): void {
    if (!this.canPlay(false)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const freq = mtof(m);
    const o = this.osc('sine', freq, t);
    const n = this.noiseSrc(t);
    const lp = this.filter('lowpass', 420, 0.7);
    const ng = this.gain(0.5);
    const am = this.gain(0.6);
    const lfo = this.osc('sine', 15, t);
    const lfoG = this.gain(0.4);
    const env = this.gain();
    lfo.connect(lfoG);
    lfoG.connect(am.gain);
    o.connect(am);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(am);
    am.connect(env);
    env.connect(out);
    sources.push(o, n, lfo);
    nodes.push(lp, ng, am, lfoG, env);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(v0, t + 0.05);
    env.gain.exponentialRampToValueAtTime(Math.max(v1, 0.001), t + dur);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.08);
    this.finish(sources, nodes, t + dur + 0.1);
  }

  /** Snare / side drum stroke. */
  snare(out: AudioNode, t: number, vel: number, pan = 0): void {
    if (!this.canPlay(false)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const n = this.noiseSrc(t);
    const bp = this.filter('bandpass', 2000, 0.9);
    const hp = this.filter('highpass', 600, 0.7);
    const ng = this.gain();
    n.connect(bp);
    bp.connect(hp);
    hp.connect(ng);
    const body = this.osc('triangle', 200, t);
    body.frequency.exponentialRampToValueAtTime(150, t + 0.06);
    const bg = this.gain();
    this.perc(bg.gain, t, 0.002, vel * 0.5, 0.06);
    body.connect(bg);
    const g = this.gain(1);
    ng.connect(g);
    bg.connect(g);
    this.route(g, out, pan, nodes);
    sources.push(n, body);
    nodes.push(bp, hp, ng, bg, g);
    const end = this.perc(ng.gain, t, 0.002, vel, 0.14);
    this.finish(sources, nodes, end);
  }

  /** Snare roll (fast AM noise with crescendo). */
  snareRoll(out: AudioNode, t: number, dur: number, v0: number, v1: number): void {
    if (!this.canPlay(false)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const n = this.noiseSrc(t);
    const bp = this.filter('bandpass', 2100, 0.8);
    const am = this.gain(0.55);
    const lfo = this.osc('sine', 22, t);
    const lfoG = this.gain(0.45);
    const env = this.gain();
    n.connect(bp);
    bp.connect(am);
    lfo.connect(lfoG);
    lfoG.connect(am.gain);
    am.connect(env);
    env.connect(out);
    sources.push(n, lfo);
    nodes.push(bp, am, lfoG, env);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(v0, t + 0.03);
    env.gain.exponentialRampToValueAtTime(Math.max(v1, 0.001), t + dur);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    this.finish(sources, nodes, t + dur + 0.06);
  }

  /** Deep drone: sine sub + soft triangle octave. */
  drone(out: AudioNode, t: number, m: number, dur: number, vel: number): void {
    if (!this.canPlay(true)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const g = this.gain();
    const o1 = this.osc('sine', mtof(m), t);
    const o2 = this.osc('triangle', mtof(m + 12), t);
    const g2 = this.gain(0.18);
    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(out);
    sources.push(o1, o2);
    nodes.push(g, g2);
    const end = this.ahr(g.gain, t, 1.2, vel, t + dur, 1.6);
    this.finish(sources, nodes, end + 0.05);
  }

  /** Choir "aah": saws through two formant bandpasses. */
  choir(out: AudioNode, t: number, notes: number[], dur: number, vel: number): void {
    if (!this.canPlay(true)) return;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const sum = this.gain(1);
    const f1 = this.filter('bandpass', 700, 5);
    const f2 = this.filter('bandpass', 1100, 6);
    const body = this.filter('lowpass', 500, 0.5);
    const g = this.gain();
    nodes.push(sum, f1, f2, body, g);
    const vib = this.vibrato(t, 5.6, 14, 1.0, sources, nodes);
    for (const m of notes) {
      for (const d of [-12, 11]) {
        const o = this.osc('sawtooth', mtof(m), t, d);
        vib.connect(o.detune);
        o.connect(sum);
        sources.push(o);
      }
    }
    sum.connect(f1);
    sum.connect(f2);
    sum.connect(body);
    const bg = this.gain(0.25);
    body.connect(bg);
    f1.connect(g);
    f2.connect(g);
    bg.connect(g);
    nodes.push(bg);
    g.connect(out);
    const end = this.ahr(g.gain, t, 1.1, (vel * 2.6) / Math.sqrt(notes.length * 2), t + dur, 1.5);
    this.finish(sources, nodes, end + 0.05);
  }

  /** Bell for UI chimes: inharmonic sine partials. */
  bell(out: AudioNode, t: number, freq: number, vel: number, decay = 1.2): void {
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const g = this.gain(1);
    nodes.push(g);
    for (const [mul, lvl, dk] of [
      [1, 1, 1],
      [2, 0.35, 0.6],
      [3.01, 0.15, 0.35],
      [4.2, 0.06, 0.2],
    ] as const) {
      const o = this.osc('sine', freq * mul, t);
      const og = this.gain();
      this.perc(og.gain, t, 0.003, vel * lvl, decay * dk);
      o.connect(og);
      og.connect(g);
      sources.push(o);
      nodes.push(og);
    }
    g.connect(out);
    this.finish(sources, nodes, t + decay + 0.05);
  }

  /** Metallic ping (coins). */
  ping(out: AudioNode, t: number, freq: number, vel: number, pan: number): void {
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const g = this.gain();
    const hp = this.filter('highpass', 1500, 0.7);
    nodes.push(g, hp);
    for (const [mul, lvl] of [
      [1, 1],
      [2.76, 0.5],
      [5.4, 0.25],
    ] as const) {
      const o = this.osc('sine', freq * mul, t);
      const og = this.gain(lvl);
      o.connect(og);
      og.connect(hp);
      sources.push(o);
      nodes.push(og);
    }
    hp.connect(g);
    this.route(g, out, pan, nodes);
    const end = this.perc(g.gain, t, 0.002, vel, 0.12 + Math.random() * 0.12);
    this.finish(sources, nodes, end);
  }

  /** UI tick. */
  tick(out: AudioNode, t: number, vel: number): void {
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const o = this.osc('triangle', 2100, t);
    o.frequency.exponentialRampToValueAtTime(1300, t + 0.03);
    const g = this.gain();
    const n = this.noiseSrc(t);
    const hp = this.filter('highpass', 4000, 0.7);
    const ng = this.gain();
    this.perc(ng.gain, t, 0.001, vel * 0.25, 0.012);
    o.connect(g);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(g);
    g.connect(out);
    sources.push(o, n);
    nodes.push(g, hp, ng);
    const end = this.perc(g.gain, t, 0.002, vel, 0.038);
    this.finish(sources, nodes, end);
  }

  /** Distant cannon: low noise burst + falling sine. */
  boom(out: AudioNode, t: number, vel: number): void {
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const g = this.gain(1);
    const n = this.noiseSrc(t);
    const lp = this.filter('lowpass', 900, 0.9);
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + 0.9);
    const ng = this.gain();
    this.perc(ng.gain, t, 0.006, vel, 1.4);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(g);
    const o = this.osc('sine', 95 + Math.random() * 15, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.55);
    const og = this.gain();
    this.perc(og.gain, t, 0.004, vel * 0.9, 0.9);
    o.connect(og);
    og.connect(g);
    g.connect(out);
    sources.push(n, o);
    nodes.push(g, lp, ng, og);
    this.finish(sources, nodes, t + 1.6);
  }
}

// ---------------------------------------------------------------- reverb impulse

function makeImpulse(ctx: AudioContext, seconds = 3.5): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const tc = seconds / 6.9; // -60 dB at `seconds`
  const pre = Math.floor(sr * 0.018);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    for (let i = 0; i < len; i++) {
      if (i < pre) {
        d[i] = 0;
        continue;
      }
      const tt = (i - pre) / sr;
      const x = Math.random() * 2 - 1;
      // one-pole lowpass that closes over time -> darker tail
      const a = 0.85 - 0.65 * Math.min(1, tt / seconds);
      y += a * (x - y);
      const fadeIn = Math.min(1, tt / 0.01);
      d[i] = y * Math.exp(-tt / tc) * fadeIn;
    }
  }
  return buf;
}

function makeNoise(ctx: AudioContext, seconds = 2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// ---------------------------------------------------------------- mood player

const OSTINATI: readonly (readonly (number | null)[])[] = [
  [0, null, 0, 0, 7, null, 0, 12],
  [0, 0, 7, null, 0, 0, 12, 7],
  [0, null, 0, 7, 0, null, 12, null],
];

// 16 sixteenth-note velocities per bar for the side drum march
const MARCH: readonly (readonly number[])[] = [
  [0.5, 0, 0, 0.22, 0.9, 0, 0.3, 0, 0.5, 0, 0, 0.22, 0.9, 0, 0.3, 0.3],
  [0.6, 0, 0.25, 0, 0.9, 0, 0, 0.25, 0.55, 0, 0.25, 0.25, 0.9, 0, 0.3, 0],
];

const HARP_PATTERNS: readonly (readonly number[])[] = [
  [0, 2, 3, 4, 5, 4, 3, 2],
  [0, 1, 2, 3, 4, 5, 6, 7],
  [0, 2, 1, 3, 2, 4, 3, 5],
  [7, 5, 4, 3, 2, 3, 4, 5],
];

class MoodPlayer {
  readonly bus: GainNode;
  private readonly wet: GainNode;
  private readonly def: MoodDef;
  private readonly rng: Rng;
  private nextBeat: number;
  private beat = 0;
  private section = -1;
  private prog: readonly Chord[];
  private lastProg = -1;
  private motif: MNote[] = [];
  private plan: MNote[][] = [[], [], [], []];
  private melodyOn = false;
  private flute = false;
  private ostinato: readonly (number | null)[] = OSTINATI[0];
  private march: readonly number[] = MARCH[0];
  private harpPat: readonly number[] = HARP_PATTERNS[0];
  stopAt = Infinity;
  dead = false;

  constructor(
    readonly mood: Mood,
    private readonly synth: Synth,
    musicGain: AudioNode,
    musicWet: AudioNode,
    start: number,
  ) {
    const ctx = synth.ctx;
    this.def = DEFS[mood];
    this.rng = mulberry32(this.def.seed ^ Math.floor(Math.random() * 0xffffff));
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.wet = ctx.createGain();
    this.wet.gain.value = this.def.reverb;
    this.bus.connect(musicGain);
    this.bus.connect(this.wet);
    this.wet.connect(musicWet);
    this.nextBeat = start;
    this.prog = this.def.progs[0];
  }

  fadeIn(now: number, dur: number): void {
    const g = this.bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(1, now + dur);
  }

  fadeOut(now: number, dur: number): void {
    const g = this.bus.gain;
    const cur = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(cur, now);
    g.linearRampToValueAtTime(0, now + dur);
    this.stopAt = now + dur;
  }

  get fading(): boolean {
    return this.stopAt !== Infinity;
  }

  /** Schedule all beats that start before `horizon`. */
  schedule(now: number, horizon: number): void {
    if (this.dead) return;
    if (now >= this.stopAt + 0.2) {
      this.dispose();
      return;
    }
    // fell behind (e.g. throttled background tab): resync the clock
    if (this.nextBeat < now - 0.1) this.nextBeat = now + 0.05;
    const beatDur = 60 / this.def.bpm;
    while (this.nextBeat < horizon && this.nextBeat < this.stopAt) {
      try {
        this.scheduleBeat(this.nextBeat, beatDur);
      } catch {
        /* never let a bad note kill the scheduler */
      }
      this.nextBeat += beatDur;
      this.beat++;
    }
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.bus.disconnect();
      this.wet.disconnect();
    } catch {
      /* ignore */
    }
  }

  private newSection(): void {
    const rng = this.rng;
    this.section++;
    const s = this.section;
    if (s % 2 === 0) {
      let idx = Math.floor(rng() * this.def.progs.length);
      if (idx === this.lastProg) idx = (idx + 1) % this.def.progs.length;
      if (s === 0) idx = 0; // every mood opens on its home progression
      this.lastProg = idx;
      this.prog = this.def.progs[idx];
      this.motif = makeMotif(rng, this.def.rhythms);
      this.plan = [this.motif, varyMotif(this.motif, rng), this.motif, cadenceOf(this.motif, rng)];
    } else {
      const a = this.motif;
      this.plan = [varyMotif(a, rng), a, varyMotif(a, rng), cadenceOf(varyMotif(a, rng), rng)];
    }
    switch (this.mood) {
      case 'menu':
        this.melodyOn = s >= 1;
        this.flute = false;
        break;
      case 'peace':
        this.melodyOn = s % 2 === 1;
        this.flute = s % 4 === 3;
        this.harpPat = pick(rng, HARP_PATTERNS);
        break;
      case 'war':
        this.melodyOn = s >= 2 && s % 3 !== 0;
        this.flute = false;
        this.ostinato = pick(rng, OSTINATI);
        this.march = pick(rng, MARCH);
        break;
    }
  }

  private scheduleBeat(t: number, beatDur: number): void {
    const beatInBar = this.beat % 4;
    const bar = Math.floor(this.beat / 4) % 8;
    if (bar === 0 && beatInBar === 0) this.newSection();
    const chord = this.prog[bar % 4];
    if (this.mood === 'menu') this.menuBeat(t, beatDur, bar, beatInBar, chord);
    else if (this.mood === 'peace') this.peaceBeat(t, beatDur, bar, beatInBar, chord);
    else this.warBeat(t, beatDur, bar, beatInBar, chord);
    this.melodyBeat(t, beatDur, bar, beatInBar, chord);
  }

  private melodyBeat(t: number, beatDur: number, bar: number, beatInBar: number, c: Chord): void {
    if (!this.melodyOn) return;
    const seg = this.plan[bar >> 1];
    const off = (bar & 1) * 4 + beatInBar;
    const base = this.flute ? D4 + 12 : D4;
    const vel = this.mood === 'menu' ? 0.12 : this.mood === 'war' ? 0.1 : this.flute ? 0.075 : 0.09;
    const scale = c.sc ?? this.def.scale;
    for (const n of seg) {
      if (n.pos < off || n.pos >= off + 1) continue;
      const nt = t + (n.pos - off) * beatDur;
      let m = degToMidi(n.deg, base, scale);
      const strong = Number.isInteger(n.pos) && (n.pos % 2 === 0 || n.dur >= 1);
      if (strong) m = snap(m, c);
      // gentle dynamic shaping: long notes a touch louder
      const v = vel * (n.dur >= 2 ? 1.05 : n.dur < 0.5 ? 0.8 : 0.95);
      this.synth.lead(this.bus, nt, m, n.dur * beatDur * 1.04, v, this.flute, this.flute ? 0.15 : -0.12);
    }
  }

  private menuBeat(t: number, beatDur: number, bar: number, beatInBar: number, c: Chord): void {
    const sy = this.synth;
    const out = this.bus;
    const s = this.section;
    const barDur = beatDur * 4;
    const intensity = [0.75, 1, 0.85, 1][s % 4];
    if (beatInBar === 0) {
      const first = s === 0 && bar === 0;
      sy.strings(out, t, [rootIn(c, 45), ...voicing(c, 57)], barDur + 0.2, 0.13 * intensity, first ? 2.2 : 0.7, 1.4, 1600);
      sy.drone(out, t, bassOf(c), barDur + 0.2, 0.11);
      const b = bassOf(c) + 12;
      if (s >= 1 || bar >= 4) {
        // low brass: open root/fifth/octave swell
        const vel = (bar % 4 === 0 ? 0.11 : 0.085) * intensity;
        sy.brass(out, t, [b, b + 7, b + 12], beatDur * 2.8, vel, 0.25, 0.8);
      }
      if (bar === 0 || bar === 4) sy.timpani(out, t, timpPitch(bassOf(c)), s === 0 && bar === 0 ? 0.25 : 0.4, 1.8, -0.2);
      if (s % 4 === 0 && bar < 4) {
        // rolled harp chord to open the section
        const notes = [rootIn(c, 50), ...voicing(c, 62), ...voicing(c, 74)];
        notes.forEach((m, i) => sy.harp(out, t + i * 0.07, m, 0.07, 0.3));
      }
    }
    if (beatInBar === 2 && (bar === 3 || bar === 7)) {
      const target = this.prog[(bar + 1) % 4];
      sy.timpRoll(out, t, timpPitch(bassOf(target)), beatDur * 2 - 0.02, 0.02, 0.22);
    }
    if (beatInBar === 2 && s >= 1 && intensity >= 1 && bar % 2 === 1) {
      // brass answer on beat 3
      const b = bassOf(c) + 12;
      sy.brass(out, t, [b, b + 7], beatDur * 1.6, 0.07, 0.12, 0.7);
    }
  }

  private peaceBeat(t: number, beatDur: number, bar: number, beatInBar: number, c: Chord): void {
    const sy = this.synth;
    const out = this.bus;
    const s = this.section;
    const barDur = beatDur * 4;
    if (beatInBar === 0) {
      sy.strings(out, t, [rootIn(c, 45), ...voicing(c, 57)], barDur + 0.3, 0.095, s === 0 && bar === 0 ? 2.5 : 1.2, 1.6, 1250);
      sy.drone(out, t, bassOf(c), barDur + 0.3, 0.08);
    }
    // harp arpeggio over a ladder of chord tones from D3 upwards
    const pcs = chordPcs(c);
    const ladder: number[] = [];
    for (let m = rootIn(c, 48); ladder.length < 9 && m < 90; m++) if (pcs.includes(relPc(m))) ladder.push(m);
    const sparse = s % 4 === 2; // breathing section: quarter notes only
    for (let k = 0; k < 2; k++) {
      if (sparse && k === 1) continue;
      const idx = this.harpPat[beatInBar * 2 + k];
      const m = ladder[Math.min(idx, ladder.length - 1)];
      const accent = k === 0 ? (beatInBar === 0 ? 1 : 0.85) : 0.7;
      const humanise = (this.rng() - 0.5) * 0.012;
      sy.harp(out, t + k * beatDur * 0.5 + Math.max(0, humanise), m, 0.085 * accent, (idx / 8 - 0.5) * 0.6);
    }
    if (beatInBar === 0 && bar === 0 && s > 0 && s % 4 === 0) {
      sy.timpani(out, t, timpPitch(bassOf(c)), 0.12, 2.0);
    }
  }

  private warBeat(t: number, beatDur: number, bar: number, beatInBar: number, c: Chord): void {
    const sy = this.synth;
    const out = this.bus;
    const s = this.section;
    const barDur = beatDur * 4;
    const b = bassOf(c);
    if (beatInBar === 0) {
      sy.drone(out, t, b, barDur + 0.2, 0.1);
      sy.strings(out, t, [rootIn(c, 43), rootIn(c, 43) + 7], barDur + 0.1, 0.07, 0.3, 0.6, 900);
      if (s % 2 === 1 && bar >= 4) {
        sy.choir(out, t, voicing(c, 60), barDur + 0.2, 0.1);
      }
    }
    // low brass ostinato in eighths
    for (let k = 0; k < 2; k++) {
      const i = beatInBar * 2 + k;
      const iv = this.ostinato[i];
      if (iv === null) continue;
      const m = b + iv;
      const vel = i === 0 ? 0.15 : i === 4 ? 0.13 : 0.095;
      sy.brass(out, t + k * beatDur * 0.5, [m, m + 12], beatDur * 0.32, vel, 0.02, 0.55, i % 4 === 0);
    }
    // timpani
    if (beatInBar === 0) sy.timpani(out, t, timpPitch(b), 0.5, 1.2, -0.15);
    if (beatInBar === 2) sy.timpani(out, t, timpPitch(b + 7), 0.36, 1.0, 0.15);
    // war drums: pounding low hits on the off-beats
    if (beatInBar === 1 || beatInBar === 3) sy.timpani(out, t + beatDur * 0.5, timpPitch(b) - 12, 0.22, 0.5, beatInBar === 1 ? -0.4 : 0.4);
    // horn call over the top every other bar
    if (beatInBar === 0 && bar % 2 === 1) sy.brass(out, t, voicing(c, 62).slice(-3), barDur * 0.45, 0.07, 0.15, 1.1, false);
    if (beatInBar === 3 && bar === 7) sy.timpRoll(out, t, timpPitch(b), beatDur - 0.02, 0.05, 0.3);
    // side drum march from the start
    if (s >= 0) {
      if (beatInBar === 3 && (bar === 3 || bar === 7)) {
        sy.snareRoll(out, t, beatDur * 0.95, 0.03, 0.12);
      } else {
        for (let k = 0; k < 4; k++) {
          const v = this.march[beatInBar * 4 + k];
          if (v > 0) sy.snare(out, t + k * beatDur * 0.25, v * 0.12, 0.25);
        }
      }
    }
    // string tremolo: repeated sixteenths, quiet
    const upper = voicing(c, 62).slice(-2);
    for (let k = 0; k < 4; k++) {
      sy.stringShort(out, t + k * beatDur * 0.25, upper, beatDur * 0.24, k === 0 ? 0.045 : 0.032, k % 2 ? 0.3 : -0.3);
    }
  }
}

function timpPitch(n: number): number {
  let m = n;
  while (m < 38) m += 12;
  while (m > 50) m -= 12;
  return m;
}

// ---------------------------------------------------------------- manager

interface Stored {
  music?: unknown;
  sfx?: unknown;
  muted?: unknown;
}

class AudioManager {
  private _music = 0.5;
  private _sfx = 0.7;
  private _muted = false;
  private _mood: Mood = 'menu';
  private loaded = false;

  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private synth: Synth | null = null;
  private players: MoodPlayer[] = [];
  private current: MoodPlayer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  get musicVolume(): number {
    this.load();
    return this._music;
  }
  get sfxVolume(): number {
    this.load();
    return this._sfx;
  }
  get muted(): boolean {
    this.load();
    return this._muted;
  }
  get mood(): Mood {
    return this._mood;
  }

  init(): void {
    if (typeof window === 'undefined') return;
    this.load();
    try {
      if (!this.ctx) {
        const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.build(this.ctx);
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {
          /* ignore */
        });
      }
      if (!this.current) this.startMood(this._mood, 2.5);
      if (this.timer === null) this.timer = setInterval(() => this.tick(), TICK_MS);
      this.tick();
    } catch {
      /* audio is optional */
    }
  }

  setMood(m: Mood): void {
    if (m !== 'menu' && m !== 'peace' && m !== 'war') return;
    this._mood = m;
    if (!this.ctx || !this.synth) return;
    if (this.current && this.current.mood === m && !this.current.fading) return;
    try {
      this.startMood(m, FADE);
    } catch {
      /* ignore */
    }
  }

  sfx(name: Sfx): void {
    this.load();
    const ctx = this.ctx;
    const g = this.g;
    const sy = this.synth;
    if (!ctx || !g || !sy || this._muted || this._sfx <= 0) return;
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
      const t = ctx.currentTime + 0.01;
      this.playSfx(name, t, ctx, g, sy);
    } catch {
      /* ignore */
    }
  }

  setMusicVolume(v: number): void {
    this.load();
    this._music = clamp01(v);
    this.save();
    this.applyGains();
  }

  setSfxVolume(v: number): void {
    this.load();
    this._sfx = clamp01(v);
    this.save();
    this.applyGains();
  }

  setMuted(m: boolean): void {
    this.load();
    this._muted = !!m;
    this.save();
    this.applyGains();
  }

  // ------------------------------------------------------------ internals

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Stored;
      if (typeof d.music === 'number') this._music = clamp01(d.music);
      if (typeof d.sfx === 'number') this._sfx = clamp01(d.sfx);
      if (typeof d.muted === 'boolean') this._muted = d.muted;
    } catch {
      /* ignore */
    }
  }

  private save(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ music: this._music, sfx: this._sfx, muted: this._muted }));
    } catch {
      /* ignore */
    }
  }

  private build(ctx: AudioContext): void {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.3;
    const master = ctx.createGain();
    master.gain.value = 0.85;
    comp.connect(master);
    master.connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 3.5);
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.9;
    reverb.connect(reverbOut);
    reverbOut.connect(comp);

    const musicGain = ctx.createGain();
    const musicWet = ctx.createGain();
    musicGain.connect(comp);
    musicWet.connect(reverb);

    const sfxBus = ctx.createGain();
    const sfxWetBus = ctx.createGain();
    const sfxGain = ctx.createGain();
    const sfxWet = ctx.createGain();
    sfxBus.connect(sfxGain);
    sfxGain.connect(comp);
    sfxWetBus.connect(sfxWet);
    sfxWet.connect(reverb);

    this.g = { comp, master, reverb, reverbOut, musicGain, musicWet, sfxGain, sfxWet, sfxBus, sfxWetBus };
    this.synth = new Synth(ctx, makeNoise(ctx, 2));
    const mv = this.musicTarget();
    const sv = this.sfxTarget();
    musicGain.gain.value = mv;
    musicWet.gain.value = mv;
    sfxGain.gain.value = sv;
    sfxWet.gain.value = sv;
  }

  private musicTarget(): number {
    return this._muted ? 0 : this._music * MUSIC_SCALE;
  }

  private sfxTarget(): number {
    return this._muted ? 0 : this._sfx * SFX_SCALE;
  }

  private applyGains(): void {
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    try {
      const now = ctx.currentTime;
      const mv = this.musicTarget();
      const sv = this.sfxTarget();
      for (const [p, v] of [
        [g.musicGain.gain, mv],
        [g.musicWet.gain, mv],
        [g.sfxGain.gain, sv],
        [g.sfxWet.gain, sv],
      ] as const) {
        p.cancelScheduledValues(now);
        p.setTargetAtTime(v, now, 0.05);
      }
    } catch {
      /* ignore */
    }
  }

  private startMood(m: Mood, fade: number): void {
    const ctx = this.ctx;
    const g = this.g;
    const sy = this.synth;
    if (!ctx || !g || !sy) return;
    const now = ctx.currentTime;
    if (this.current && !this.current.fading) this.current.fadeOut(now, fade);
    const p = new MoodPlayer(m, sy, g.musicGain, g.musicWet, now + 0.1);
    p.fadeIn(now, fade);
    this.current = p;
    this.players.push(p);
    this.tick();
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    for (const p of this.players) p.schedule(now, horizon);
    this.players = this.players.filter((p) => !p.dead);
  }

  private playSfx(name: Sfx, t: number, ctx: AudioContext, g: Graph, sy: Synth): void {
    // per-call send: dry to sfx bus, `wet` amount to the shared reverb
    const send = (wet: number): GainNode => {
      const n = ctx.createGain();
      const w = ctx.createGain();
      w.gain.value = wet;
      n.connect(g.sfxBus);
      n.connect(w);
      w.connect(g.sfxWetBus);
      setTimeout(() => {
        try {
          n.disconnect();
          w.disconnect();
        } catch {
          /* ignore */
        }
      }, 6000);
      return n;
    };
    switch (name) {
      case 'click':
        sy.tick(g.sfxBus, t, 0.18);
        break;
      case 'battle': {
        const out = send(0.8);
        sy.boom(out, t, 0.7);
        if (Math.random() < 0.6) sy.boom(out, t + 0.25 + Math.random() * 0.25, 0.35);
        break;
      }
      case 'chime': {
        const out = send(0.35);
        sy.bell(out, t, mtof(81), 0.16, 1.3); // A5
        sy.bell(out, t + 0.13, mtof(86), 0.14, 1.6); // D6
        break;
      }
      case 'alarm': {
        const out = send(0.4);
        const hi = 50; // D3
        const lo = 44; // Ab2 - a tritone below for urgency
        [hi, lo, hi, lo].forEach((m, i) => {
          sy.brass(out, t + i * 0.3, [m, m + 12], 0.24, 0.24, 0.03, 1.2);
        });
        sy.timpani(out, t, 38, 0.35, 1.2);
        break;
      }
      case 'fanfare': {
        const out = send(0.45);
        const notes = [62, 66, 69];
        notes.forEach((m, i) => sy.brass(out, t + i * 0.12, [m, m - 12], 0.11, 0.15, 0.02, 1.1));
        const tl = t + notes.length * 0.12;
        sy.brass(out, tl, [62, 66, 69, 74], 0.75, 0.2, 0.04, 1.2);
        sy.timpani(out, tl, 38, 0.45, 1.4);
        break;
      }
      case 'warhorn': {
        // war declared: a martial trumpet call over a timpani roll
        const out = send(0.5);
        const call: [number, number][] = [[62, 0.16], [62, 0.08], [62, 0.08], [69, 0.34], [66, 0.16], [69, 0.62]];
        let at = t;
        for (const [m, d] of call) { sy.brass(out, at, [m, m + 12], d * 0.9, 0.2, 0.015, 1.3); at += d + 0.03; }
        sy.timpRoll(out, t, 38, at - t, 0.06, 0.32);
        sy.timpani(out, at, 38, 0.6, 1.8);
        sy.boom(out, at, 0.5);
        break;
      }
      case 'peace': {
        // peace: a soft, warm major chord and bells
        const out = send(0.6);
        sy.strings(out, t, [62, 66, 69, 74], 2.6, 0.12, 0.4, 1.6, 1800);
        sy.bell(out, t + 0.3, mtof(78), 0.12, 2);
        sy.bell(out, t + 0.55, mtof(81), 0.1, 2.2);
        sy.bell(out, t + 0.8, mtof(86), 0.09, 2.6);
        break;
      }
      case 'coins': {
        const out = send(0.2);
        for (let i = 0; i < 7; i++) {
          const f = 2400 + Math.random() * 1800;
          sy.ping(out, t + i * 0.038 + Math.random() * 0.02, f, 0.08 * (1 - i * 0.08), (Math.random() - 0.5) * 0.8);
        }
        break;
      }
    }
  }
}

export const audio = new AudioManager();
