// Parameter schema for the reface DX voice: the single source of truth for server, CLI and web UI.
// One param = one hardware byte (except `name` = the 10 name bytes). Values use the panel/display
// domain (docs/sysex-spec.md §2.2/§2.3); raw<->value is bijective over each param's range.

/** Raw voice bytes as they appear in a bulk dump: Common block (38) + 4 Operator blocks (28 each). */
export interface VoiceData {
  common: number[];
  ops: number[][];
}
export const COMMON_SIZE = 38;
export const OP_SIZE = 28;
export const NAME_LENGTH = 10;

export type ParamValue = number | string | boolean;
export type VoiceValues = Record<string, ParamValue>;

interface ParamBase {
  id: string;
  label: string;
  group: string;
  description: string;
  block: 'common' | 'op';
  /** Operator number 1..4 for op params, null for common params. */
  op: number | null;
  /** Byte offset inside the block (address low byte). */
  offset: number;
}
/** raw = value + bias; value range is [min, max] in the display domain. */
export type IntParam = ParamBase & { kind: 'int'; min: number; max: number; bias: number };
export type EnumParam = ParamBase & { kind: 'enum'; options: readonly string[] };
export type BoolParam = ParamBase & { kind: 'bool' };
export type StringParam = ParamBase & { kind: 'string'; length: number };
export type ParamDef = IntParam | EnumParam | BoolParam | StringParam;

/** Invalid id/value supplied by a client. The server maps it to HTTP 400. */
export class ParamError extends Error {}

export const PART_MODES = ['POLY', 'MONO-FULL', 'MONO-LEGATO'] as const;
export const LFO_WAVES = ['SIN', 'TRI', 'SAW-UP', 'SAW-DOWN', 'SQUARE', 'S&H8', 'S&H'] as const;
export const FX_TYPES = ['THRU', 'DIST', 'T.WAH', 'CHO', 'FLA', 'PHA', 'DLY', 'REV'] as const;
export const KSL_CURVES = ['-LIN', '-EXP', '+EXP', '+LIN'] as const;
export const FEEDBACK_TYPES = ['SAW', 'SQUARE'] as const;
export const FREQ_MODES = ['RATIO', 'FIXED'] as const;

type Common = Omit<ParamBase, 'block' | 'op'>;
const c = (p: Common & DefTail): ParamDef => ({ ...p, block: 'common', op: null }) as ParamDef;
type DefTail =
  | { kind: 'int'; min: number; max: number; bias: number }
  | { kind: 'enum'; options: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'string'; length: number };
const u7 = { kind: 'int', min: 0, max: 127, bias: 0 } as const;
const signed = (range: number) => ({ kind: 'int', min: -range, max: range, bias: 64 }) as const;

const COMMON_PARAMS: ParamDef[] = [
  c({ id: 'name', label: 'Name', group: 'voice', offset: 0x00, kind: 'string', length: NAME_LENGTH,
    description: 'Voice name, up to 10 printable ASCII chars (space padded on the device).' }),
  c({ id: 'transpose', label: 'Transpose', group: 'voice', offset: 0x0c, ...signed(24),
    description: 'Voice transpose in semitones.' }),
  c({ id: 'partMode', label: 'Mode', group: 'voice', offset: 0x0d, kind: 'enum', options: PART_MODES,
    description: 'POLY; MONO-FULL = portamento on every note; MONO-LEGATO = portamento only on legato notes.' }),
  c({ id: 'portamento', label: 'Portamento', group: 'voice', offset: 0x0e, ...u7,
    description: 'Portamento (glide) time; 0 = off.' }),
  c({ id: 'pitchBendRange', label: 'PB Range', group: 'voice', offset: 0x0f, ...signed(24),
    description: 'Pitch bend range in semitones (negative presumably inverts the bend).' }),
  c({ id: 'algorithm', label: 'Algorithm', group: 'voice', offset: 0x10, kind: 'int', min: 1, max: 12, bias: -1,
    description: 'FM algorithm 1..12: which operators are carriers (heard) and which modulate others. See derived.algorithm.' }),
  c({ id: 'lfoWave', label: 'LFO Wave', group: 'lfo', offset: 0x11, kind: 'enum', options: LFO_WAVES,
    description: 'LFO waveform. S&H8 = sample&hold 8 steps per cycle.' }),
  c({ id: 'lfoSpeed', label: 'LFO Speed', group: 'lfo', offset: 0x12, ...u7, description: 'LFO rate.' }),
  c({ id: 'lfoDelay', label: 'LFO Delay', group: 'lfo', offset: 0x13, ...u7,
    description: 'Time before the LFO fades in after note-on.' }),
  c({ id: 'lfoPitchModDepth', label: 'LFO PMD', group: 'lfo', offset: 0x14, ...u7,
    description: 'LFO pitch modulation (vibrato) depth for operators with lfoPitchMod on. 0 = none.' }),
  ...[1, 2, 3, 4].map((i) => c({ id: `pegRate${i}`, label: `PEG Rate ${i}`, group: 'pitchEg', offset: 0x14 + i, ...u7,
    description: `Pitch EG rate ${i} (0 slow .. 127 fast). Applies to operators with pitchEgOn.` })),
  ...[1, 2, 3, 4].map((i) => c({ id: `pegLevel${i}`, label: `PEG Level ${i}`, group: 'pitchEg', offset: 0x18 + i, ...signed(48),
    description: `Pitch EG level ${i} in semitones (-48..+48 = ±4 octaves); level 4 is the rest/release pitch.` })),
  ...[1, 2].flatMap((n) => {
    const base = n === 1 ? 0x1d : 0x20;
    return [
      c({ id: `fx${n}Type`, label: `FX${n} Type`, group: 'fx', offset: base, kind: 'enum', options: FX_TYPES,
        description: `Effect ${n} type (effects run in series). Param meanings per type: derived.fx${n}.` }),
      c({ id: `fx${n}Param1`, label: `FX${n} Param 1`, group: 'fx', offset: base + 1, ...u7,
        description: `Effect ${n} parameter 1 (DIST drive, T.WAH sens, CHO/FLA/PHA/DLY/REV depth).` }),
      c({ id: `fx${n}Param2`, label: `FX${n} Param 2`, group: 'fx', offset: base + 2, ...u7,
        description: `Effect ${n} parameter 2 (DIST tone, T.WAH resonance, CHO/FLA/PHA rate, DLY/REV time).` }),
    ];
  }),
];

function opParams(n: number): ParamDef[] {
  const o = (p: Omit<Common, 'id' | 'group'> & { id: string } & DefTail): ParamDef =>
    ({ ...p, id: `op${n}.${p.id}`, label: `OP${n} ${p.label}`, group: `op${n}`, block: 'op', op: n }) as ParamDef;
  return [
    o({ id: 'enabled', label: 'On', offset: 0x00, kind: 'bool', description: 'Operator on/off.' }),
    ...[1, 2, 3, 4].map((i) => o({ id: `egRate${i}`, label: `EG Rate ${i}`, offset: i, ...u7,
      description: `Amplitude EG rate ${i} (0 slow .. 127 fast). 1 attack, 2 decay, 3 sustain slope, 4 release.` })),
    ...[1, 2, 3, 4].map((i) => o({ id: `egLevel${i}`, label: `EG Level ${i}`, offset: 4 + i, ...u7,
      description: `Amplitude EG level ${i} (0 silent .. 127). Level 3 = sustain, level 4 = level after release.` })),
    o({ id: 'rateScaling', label: 'Rate Scaling', offset: 0x09, ...u7,
      description: 'Keyboard rate scaling: higher notes get faster envelopes.' }),
    o({ id: 'kslLeftDepth', label: 'KSL Left Depth', offset: 0x0a, ...u7,
      description: 'Keyboard level scaling depth below the C3 break point; sign/shape comes from kslLeftCurve.' }),
    o({ id: 'kslRightDepth', label: 'KSL Right Depth', offset: 0x0b, ...u7,
      description: 'Keyboard level scaling depth above the C3 break point; sign/shape comes from kslRightCurve.' }),
    o({ id: 'kslLeftCurve', label: 'KSL Left Curve', offset: 0x0c, kind: 'enum', options: KSL_CURVES,
      description: 'Left scaling curve: - = level falls away from C3, + = rises; LIN or EXP shape.' }),
    o({ id: 'kslRightCurve', label: 'KSL Right Curve', offset: 0x0d, kind: 'enum', options: KSL_CURVES,
      description: 'Right scaling curve: - = level falls away from C3, + = rises; LIN or EXP shape.' }),
    o({ id: 'ampModDepth', label: 'AMD', offset: 0x0e, ...u7,
      description: 'LFO amplitude modulation depth (tremolo on a carrier, timbre wobble on a modulator).' }),
    o({ id: 'lfoPitchMod', label: 'LFO PM', offset: 0x0f, kind: 'bool',
      description: 'Apply the common LFO pitch modulation (lfoPitchModDepth) to this operator.' }),
    o({ id: 'pitchEgOn', label: 'PEG', offset: 0x10, kind: 'bool',
      description: 'Apply the common pitch EG to this operator.' }),
    o({ id: 'velocitySens', label: 'Velocity Sens', offset: 0x11, ...u7,
      description: 'Output level velocity sensitivity (0 none .. 127 max).' }),
    o({ id: 'level', label: 'Level', offset: 0x12, ...u7,
      description: 'Output level. Carrier: volume. Modulator: modulation depth (brightness).' }),
    o({ id: 'feedback', label: 'Feedback', offset: 0x13, ...u7,
      description: 'Self-feedback amount (every operator has its own). Adds harmonics/noise.' }),
    o({ id: 'feedbackType', label: 'FB Type', offset: 0x14, kind: 'enum', options: FEEDBACK_TYPES,
      description: 'Feedback character: SAW (all harmonics) or SQUARE (odd harmonics).' }),
    o({ id: 'freqMode', label: 'Freq Mode', offset: 0x15, kind: 'enum', options: FREQ_MODES,
      description: 'RATIO = frequency follows the key; FIXED = fixed Hz regardless of key.' }),
    o({ id: 'coarse', label: 'Coarse', offset: 0x16, kind: 'int', min: 0, max: 31, bias: 0,
      description: 'Frequency coarse. RATIO: 0 = 0.5, 1..31 = integer ratio. FIXED: decade selector. See derived frequency.' }),
    o({ id: 'fine', label: 'Fine', offset: 0x17, kind: 'int', min: 0, max: 99, bias: 0,
      description: 'Frequency fine: RATIO adds fine/100 (fine*0.005 when coarse=0).' }),
    o({ id: 'detune', label: 'Detune', offset: 0x18, ...signed(64), max: 63,
      description: 'Fine detune -64..+63, about 0.59 cent per step (measured, spec §2.4). Small values thicken the sound.' }),
  ];
}

export const PARAMS: readonly ParamDef[] = [...COMMON_PARAMS, ...[1, 2, 3, 4].flatMap(opParams)];
export const PARAM_BY_ID: ReadonlyMap<string, ParamDef> = new Map(PARAMS.map((p) => [p.id, p]));

export function getParam(id: string): ParamDef {
  const def = PARAM_BY_ID.get(id);
  if (!def) throw new ParamError(`unknown parameter "${id}" (see GET /api/params or "dx params")`);
  return def;
}

function blockOf(voice: VoiceData, def: ParamDef): number[] {
  return def.block === 'common' ? voice.common : voice.ops[def.op! - 1];
}

/** Raw bytes for a (valid) value, starting at def.offset. */
export function encodeValue(def: ParamDef, value: ParamValue): number[] {
  switch (def.kind) {
    case 'int': return [(value as number) + def.bias];
    case 'enum': return [def.options.indexOf(value as string)];
    case 'bool': return [value ? 1 : 0];
    case 'string': return [...(value as string).padEnd(def.length, ' ')].map((ch) => ch.charCodeAt(0));
  }
}

export function decodeValue(def: ParamDef, voice: VoiceData): ParamValue {
  const block = blockOf(voice, def);
  const raw = block[def.offset];
  switch (def.kind) {
    case 'int': return raw - def.bias;
    case 'enum': return def.options[raw];
    case 'bool': return raw !== 0;
    case 'string':
      return String.fromCharCode(...block.slice(def.offset, def.offset + def.length)).trimEnd();
  }
}

export function getValues(voice: VoiceData): VoiceValues {
  return Object.fromEntries(PARAMS.map((def) => [def.id, decodeValue(def, voice)]));
}

/** New VoiceData with the given (already coerced) values written; all other bytes, incl. reserved, are kept. */
export function withValues(voice: VoiceData, values: VoiceValues): VoiceData {
  const next: VoiceData = { common: [...voice.common], ops: voice.ops.map((op) => [...op]) };
  for (const [id, value] of Object.entries(values)) {
    const def = getParam(id);
    const bytes = encodeValue(def, value);
    blockOf(next, def).splice(def.offset, bytes.length, ...bytes);
  }
  return next;
}

/**
 * Validate a client-supplied value (JSON or CLI string) into the display domain.
 * clamp=true pins out-of-range numbers to the range (slider input); otherwise they are rejected.
 */
export function coerceValue(def: ParamDef, input: unknown, clamp = false): ParamValue {
  const bad = (why: string): never => { throw new ParamError(`${def.id}: ${why}`); };
  switch (def.kind) {
    case 'int': {
      const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
      if (typeof n !== 'number' || !Number.isInteger(n)) return bad(`expected an integer ${def.min}..${def.max}, got ${JSON.stringify(input)}`);
      if (n >= def.min && n <= def.max) return n;
      return clamp ? Math.min(def.max, Math.max(def.min, n)) : bad(`${n} out of range ${def.min}..${def.max}`);
    }
    case 'enum': {
      const hit = typeof input === 'string' && def.options.find((o) => o.toUpperCase() === input.trim().toUpperCase());
      return hit || bad(`expected one of ${def.options.join('|')}, got ${JSON.stringify(input)}`);
    }
    case 'bool': {
      if (typeof input === 'boolean') return input;
      const s = String(input).trim().toLowerCase();
      if (['true', 'on', '1'].includes(s)) return true;
      if (['false', 'off', '0'].includes(s)) return false;
      return bad(`expected true|false|on|off, got ${JSON.stringify(input)}`);
    }
    case 'string': {
      if (typeof input !== 'string') return bad(`expected a string, got ${JSON.stringify(input)}`);
      if (!/^[\x20-\x7e]*$/.test(input)) return bad('only printable ASCII (0x20-0x7E) is allowed');
      if (input.length > def.length) {
        return clamp ? input.slice(0, def.length).trimEnd() : bad(`max ${def.length} characters, got ${input.length}`);
      }
      return input.trimEnd();
    }
  }
}

/** Coerce a partial {id: value} map; throws ParamError listing every problem at once. */
export function coerceValues(input: Record<string, unknown>, clamp = false): VoiceValues {
  const out: VoiceValues = {};
  const errors: string[] = [];
  for (const [id, raw] of Object.entries(input)) {
    try {
      out[id] = coerceValue(getParam(id), raw, clamp);
    } catch (err) {
      if (!(err instanceof ParamError)) throw err;
      errors.push(err.message);
    }
  }
  if (errors.length) throw new ParamError(errors.join('; '));
  return out;
}

// ---- Derived read-only helpers (not params) ----

export interface OpFrequency {
  mode: 'RATIO' | 'FIXED';
  value: number;
  display: string;
  /** true for FIXED: the coarse->decade rule is unresolved (spec §3.2, hypothesis A used). */
  estimated: boolean;
}

export function opFrequency(values: VoiceValues, n: number): OpFrequency {
  const coarse = values[`op${n}.coarse`] as number;
  const fine = values[`op${n}.fine`] as number;
  if (values[`op${n}.freqMode`] === 'RATIO') {
    const value = coarse === 0 ? 0.5 + fine * 0.005 : coarse + fine / 100;
    return { mode: 'RATIO', value, display: value.toFixed(coarse === 0 ? 3 : 2), estimated: false };
  }
  const value = 10 ** ((coarse >> 3) + fine / 100);
  return { mode: 'FIXED', value, display: `${value.toFixed(value < 10 ? 3 : value < 100 ? 2 : value < 1000 ? 1 : 0)} Hz`, estimated: true };
}

/** Parameter names per effect type (spec §4). null = unused. */
export const FX_PARAM_NAMES: Record<string, readonly [string, string] | null> = {
  THRU: null, DIST: ['DRIVE', 'TONE'], 'T.WAH': ['SENS', 'REZ'], CHO: ['DEPTH', 'RATE'],
  FLA: ['DEPTH', 'RATE'], PHA: ['DEPTH', 'RATE'], DLY: ['DEPTH', 'TIME'], REV: ['DEPTH', 'TIME'],
};

export interface Algorithm {
  carriers: number[];
  /** [source, destination]: source operator modulates destination. Every operator also has self-feedback. */
  edges: [number, number][];
  /** 'official' = Owner's Manual screen; 'community' = forum + chart agree; 'inferred' = unverified numbering. */
  confidence: 'official' | 'community' | 'inferred';
}

/** Index = algorithm - 1 (spec §5). */
export const ALGORITHMS: readonly Algorithm[] = [
  { carriers: [1], edges: [[4, 3], [3, 2], [2, 1]], confidence: 'community' },
  { carriers: [1], edges: [[4, 2], [3, 2], [2, 1]], confidence: 'community' },
  { carriers: [1], edges: [[4, 1], [3, 2], [2, 1]], confidence: 'community' },
  { carriers: [1], edges: [[4, 2], [4, 3], [2, 1], [3, 1]], confidence: 'official' },
  { carriers: [1], edges: [[2, 1], [3, 1], [4, 1]], confidence: 'community' },
  { carriers: [1, 2], edges: [[4, 3], [3, 2]], confidence: 'inferred' },
  { carriers: [1, 2], edges: [[4, 3], [3, 1], [3, 2]], confidence: 'community' },
  { carriers: [1, 3], edges: [[2, 1], [4, 3]], confidence: 'official' },
  { carriers: [1, 2, 3], edges: [[4, 1], [4, 2], [4, 3]], confidence: 'inferred' },
  { carriers: [1, 2, 3], edges: [[4, 2], [4, 3]], confidence: 'inferred' },
  { carriers: [1, 2, 3], edges: [[4, 3]], confidence: 'inferred' },
  { carriers: [1, 2, 3, 4], edges: [], confidence: 'community' },
];

export interface DerivedVoice {
  algorithm: Algorithm;
  frequencies: OpFrequency[];
  fx1: readonly [string, string] | null;
  fx2: readonly [string, string] | null;
}

export function deriveVoice(values: VoiceValues): DerivedVoice {
  return {
    algorithm: ALGORITHMS[(values.algorithm as number) - 1],
    frequencies: [1, 2, 3, 4].map((n) => opFrequency(values, n)),
    fx1: FX_PARAM_NAMES[values.fx1Type as string],
    fx2: FX_PARAM_NAMES[values.fx2Type as string],
  };
}
