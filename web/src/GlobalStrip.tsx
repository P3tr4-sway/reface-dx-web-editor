// Global strip: algorithm picker · common · LFO · pitch EG · effects. White = global (README "Rules").
import type { CSSProperties } from 'react';
import { ALGORITHMS, FX_PARAM_NAMES, FX_TYPES, LFO_WAVES, type Algorithm } from '../../shared/params.ts';
import { Bipolar, Enum, Fader, ScrubNumber, cls, signed } from './controls.tsx';
import { EnvelopeEditor } from './EnvelopeEditor.tsx';
import { depths, hue } from './OperatorLanes.tsx';
import { useStore } from './store.ts';

function Thumb({ a }: { a: Algorithm }) {
  const d = depths(a);
  const at = (op: number) => [22 - d[op] * 6, 5 + (4 - op) * 8];
  return (
    <svg width="26" height="34" viewBox="0 0 26 34" aria-hidden>
      {a.edges.map(([s, t]) => <path key={`${s}${t}`} d={`M${at(s)}L${at(t)}`} className="t-edge" />)}
      {[1, 2, 3, 4].map((op) => {
        const [cx, cy] = at(op);
        const carrier = a.carriers.includes(op);
        return <circle key={op} cx={cx} cy={cy} r={carrier ? 2.6 : 2.2} className={carrier ? 't-carrier' : 't-mod'} style={{ '--op': hue(op) } as CSSProperties} />;
      })}
    </svg>
  );
}

/** Independent modulation stacks = connected components of the operator graph. */
function stacks(a: Algorithm): number {
  const root = [0, 1, 2, 3, 4];
  const find = (x: number): number => (root[x] === x ? x : (root[x] = find(root[x])));
  for (const [s, t] of a.edges) root[find(s)] = find(t);
  return new Set([1, 2, 3, 4].map(find)).size;
}

function AlgorithmPicker() {
  const alg = useStore((s) => s.values?.algorithm as number);
  const mark = useStore((s) => s.marks.algorithm);
  const a = ALGORITHMS[alg - 1];
  const k = stacks(a);
  return (
    <section className="panel algo-panel">
      <div className="algo-head">
        <h2 className="title">ALGORITHM</h2>
        <span key={mark?.at} className={cls('algo-no', mark && 'bloom')}>{String(alg).padStart(2, '0')}</span>
      </div>
      <Enum
        id="algorithm" label="Algorithm" className="algo-grid"
        options={ALGORITHMS.map((x, i) => ({ value: i + 1, label: <Thumb a={x} />, title: `Algorithm ${i + 1}${x.confidence === 'inferred' ? ' (numbering inferred, unverified)' : ''}` }))}
      />
      <span className="caption">{k} stack{k > 1 ? 's' : ''} · out {a.carriers.join('+')}</span>
    </section>
  );
}

function Common() {
  return (
    <section className="panel common">
      <h2 className="title">COMMON</h2>
      <Bipolar id="transpose" label="transpose" variant="global" />
      <div className="enum-row">
        <span className="s-label">mode</span>
        <Enum id="partMode" label="Part mode" options={[{ value: 'POLY', label: 'POLY' }, { value: 'MONO-FULL', label: 'MONO' }, { value: 'MONO-LEGATO', label: 'LEGATO' }]} />
      </div>
      <Fader id="portamento" label="portamento" variant="global" />
      <Bipolar id="pitchBendRange" label="pitch bend" variant="global" />
    </section>
  );
}

// LFO glyphs from the Paper artboard (16×12 grid), in LFO_WAVES order.
const WAVE_GLYPHS: Record<string, [string, number]> = {
  SIN: ['M1 6C3 -1.5 6 -1.5 8 6S13 13.5 15 6', 1.4],
  TRI: ['M1 6L4.5 2L11.5 10L15 6', 1.2],
  'SAW-UP': ['M1 10L8 2V10L15 2V10', 1.2],
  'SAW-DOWN': ['M1 2V10L8 2V10L15 2', 1.2],
  SQUARE: ['M1 10V2H8V10H15V2', 1.2],
  'S&H8': ['M1 7H3V3H5V9H7V5H9V8H11V2H13V6H15', 1.1],
  'S&H': ['M1 5H4.5V10H8V2.5H11.5V7.5H15', 1.1],
};
const WAVE_NAMES: Record<string, string> = {
  SIN: 'SINE', TRI: 'TRIANGLE', 'SAW-UP': 'SAW UP', 'SAW-DOWN': 'SAW DOWN', SQUARE: 'SQUARE', 'S&H8': 'S&H 8', 'S&H': 'S&H',
};

function Lfo() {
  const wave = useStore((s) => s.values?.lfoWave as string);
  return (
    <section className="panel lfo">
      <div className="title-row"><h2 className="title">LFO</h2><span className="title-value">{WAVE_NAMES[wave]}</span></div>
      <Enum
        id="lfoWave" label="LFO wave" className="waves"
        options={LFO_WAVES.map((w) => ({
          value: w, title: WAVE_NAMES[w],
          label: <svg width="22" height="14" viewBox="0 0 16 12" aria-label={WAVE_NAMES[w]}><path d={WAVE_GLYPHS[w][0]} strokeWidth={WAVE_GLYPHS[w][1]} /></svg>,
        }))}
      />
      <Fader id="lfoSpeed" label="speed" variant="global" />
      <Fader id="lfoDelay" label="delay" variant="global" />
      <Fader id="lfoPitchModDepth" label="pitch mod depth" variant="global" />
    </section>
  );
}

function PitchEg() {
  const ids = (k: string) => [1, 2, 3, 4].map((i) => `peg${k}${i}`);
  return (
    <section className="panel peg">
      <div className="title-row"><h2 className="title">PITCH EG</h2><span className="title-note">±48 st</span></div>
      <EnvelopeEditor rates={ids('Rate')} levels={ids('Level')} min={-48} max={48} name="Pitch EG" variant="peg" />
      <div className="peg-nums">
        <span className="cap">rate</span>
        {ids('Rate').map((id, i) => <ScrubNumber key={id} id={id} label={`Pitch EG rate ${i + 1}`} />)}
        <span className="cap">level</span>
        {ids('Level').map((id, i) => <ScrubNumber key={id} id={id} label={`Pitch EG level ${i + 1}`} format={(v) => signed(v as number)} />)}
      </div>
    </section>
  );
}

function Effect({ n }: { n: 1 | 2 }) {
  const type = useStore((s) => s.values?.[`fx${n}Type`] as string);
  const names = FX_PARAM_NAMES[type];
  return (
    <div className="fx-unit">
      <Enum id={`fx${n}Type`} label={`Effect ${n} type`} className="fx-types" options={FX_TYPES.map((t) => ({ value: t, label: t }))} />
      {/* THRU has no parameters: both faders are shown disabled (README) */}
      <div className={cls('fx-params', !names && 'thru')} inert={!names}>
        <Fader id={`fx${n}Param1`} label={names?.[0].toLowerCase() ?? 'param 1'} variant="mini" />
        <Fader id={`fx${n}Param2`} label={names?.[1].toLowerCase() ?? 'param 2'} variant="mini" />
      </div>
    </div>
  );
}

function Effects() {
  return (
    <section className="panel fx">
      <div className="title-row"><h2 className="title">EFFECTS</h2><span className="title-note">1 → 2</span></div>
      <Effect n={1} />
      <Effect n={2} />
    </section>
  );
}

export function GlobalStrip() {
  return (
    <div className="strip">
      <AlgorithmPicker />
      <Common />
      <Lfo />
      <PitchEg />
      <Effects />
    </div>
  );
}
