// Audition phrases: turn a preset name or an explicit chord ("C4,E4,G4") into timed note steps.
import { ParamError } from '../shared/params.ts';
import type { AuditionPreset, AuditionRequest } from '../shared/protocol.ts';

/** Each step is a chord (comma separated) played for stepSec seconds. */
const PRESETS: Record<AuditionPreset, { steps: string[]; stepSec: number }> = {
  chord: { steps: ['C4,E4,G4'], stepSec: 1.5 },
  arp: { steps: ['C4', 'E4', 'G4', 'C5', 'E5', 'C5', 'G4', 'E4'], stepSec: 0.18 },
  bass: { steps: ['C2', 'C2', 'C3', 'C2', 'D#2', 'F2', 'G2', 'A#1'], stepSec: 0.22 },
  lead: { steps: ['G4', 'A#4', 'C5', 'D5', 'F5', 'D5', 'C5'], stepSec: 0.3 },
  pad: { steps: ['C3,G3,B3,E4'], stepSec: 4 },
  keys: { steps: ['C4,E4,G4', 'A3,C4,E4', 'F3,A3,C4', 'G3,B3,D4'], stepSec: 0.6 },
};

export const AUDITION_PRESETS = Object.keys(PRESETS) as AuditionPreset[];

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Scientific pitch: C4 = MIDI 60 (the DX panel/manual calls this note C3). */
export function noteNumber(name: string): number {
  const m = /^([A-Ga-g])(#|b)?(-?\d)$/.exec(name.trim());
  if (!m) throw new ParamError(`bad note "${name}" (use names like C4, F#3, Bb2; C4 = middle C = MIDI 60)`);
  const n = (Number(m[3]) + 1) * 12 + PITCH[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  if (n < 0 || n > 127) throw new ParamError(`note "${name}" outside MIDI range`);
  return n;
}

export interface AuditionPlan { names: string[][]; steps: number[][]; stepMs: number; velocity: number }

export function planAudition(req: AuditionRequest): AuditionPlan {
  const what = (req.what ?? 'chord').trim();
  const preset = PRESETS[what as AuditionPreset];
  if (!preset && !/^[A-Ga-g][#b]?-?\d/.test(what)) {
    throw new ParamError(`unknown audition "${what}": use ${Object.keys(PRESETS).join('|')} or notes like C4,E4,G4`);
  }
  const names = (preset?.steps ?? [what]).map((step) => step.split(',').map((s) => s.trim()));
  const velocity = req.velocity ?? 100;
  if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) throw new ParamError('velocity must be an integer 1..127');
  const stepSec = req.duration ?? preset?.stepSec ?? 1.5;
  if (!(stepSec >= 0.05 && stepSec <= 10)) throw new ParamError('duration must be 0.05..10 seconds');
  return { names, steps: names.map((chord) => chord.map(noteNumber)), stepMs: Math.round(stepSec * 1000), velocity };
}
