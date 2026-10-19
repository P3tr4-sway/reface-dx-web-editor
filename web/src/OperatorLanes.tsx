// The spine (algorithm diagram, one node per lane row) and the four operator lanes, OP4 at the top → OP1.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ALGORITHMS, opFrequency, type Algorithm, type ParamValue } from '../../shared/params.ts';
import { Bipolar, Chip, Enum, Fader, ScrubNumber, Toggle, cls, signed, useSize } from './controls.tsx';
import { EnvelopeEditor } from './EnvelopeEditor.tsx';
import { edit, useStore } from './store.ts';

const OPS = [4, 3, 2, 1] as const;
export const hue = (op: number) => `var(--op${op})`;

/** Depth = longest modulation path down to a carrier (README "Algorithm topology"). Edges always run high op → low op. */
export function depths(a: Algorithm): Record<number, number> {
  const d: Record<number, number> = {};
  for (const op of [1, 2, 3, 4]) {
    d[op] = a.carriers.includes(op) ? 0 : 1 + Math.max(...a.edges.filter(([s]) => s === op).map(([, t]) => d[t]));
  }
  return d;
}

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Eases numbers toward their targets (ease-out cubic); an interrupted tween continues from where it is. */
function useTween(target: number[], ms: number): number[] {
  const [now, setNow] = useState(target);
  const from = useRef(target);
  const key = target.join();
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = prefersReducedMotion() ? 1 : Math.min(1, (t - start) / ms);
      const e = 1 - (1 - k) ** 3;
      from.current = target.map((x, i) => a[i] + (x - a[i]) * e);
      setNow(from.current);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key]); // `key` encodes `target`; a new array each render must not restart the tween
  return now;
}

// Spine geometry from the Paper artboard: carriers at x 140, depth step 70, bus at x 184, node r 16.
const CARRIER_X = 140;
const BUS_X = 184;
const R = 16;

function Spine() {
  const alg = useStore((s) => s.values?.algorithm as number);
  // One subscription per value (OPS is constant): store snapshots must be primitives, not fresh arrays.
  const feedback = Object.fromEntries(OPS.map((op) => [op, useStore((s) =>
    (s.values?.[`op${op}.feedbackType`] === 'SQUARE' ? -1 : 1) * (s.values?.[`op${op}.feedback`] as number))]));
  const enabled = Object.fromEntries(OPS.map((op) => [op, useStore((s) => s.values?.[`op${op}.enabled`] === true)]));
  const [box, { h }] = useSize<HTMLDivElement>();
  const a = ALGORITHMS[alg - 1];
  const d = depths(a);
  const step = Math.min(70, (CARRIER_X - 28) / Math.max(1, ...Object.values(d)));
  const xs = useTween([1, 2, 3, 4].map((op) => CARRIER_X - d[op] * step), 240);
  const x = (op: number) => xs[op - 1];
  const y = (op: number) => ((4 - op + 0.5) * h) / 4;

  const edgePath = (s: number, t: number) => {
    const [sx, sy, tx, ty] = [x(s), y(s), x(t), y(t)];
    const blocked = OPS.some((k) => k !== s && k !== t && y(k) > sy && y(k) < ty && Math.abs(x(k) - sx) < R * 1.5);
    if (blocked) return `M${sx + R} ${sy}C${tx} ${sy} ${tx} ${sy} ${tx} ${ty - R}`; // leave sideways past nodes stacked below
    const sy2 = sy + R;
    return `M${sx} ${sy2}C${sx} ${sy2 + (ty - sy2) * 0.6} ${sx + (tx - R - sx) * 0.48} ${ty} ${tx - R} ${ty}`;
  };
  const top = Math.min(...a.carriers.map(y));
  const focusLane = (op: number) => document.querySelector<HTMLElement>(`[data-lane="${op}"] [role=slider]`)?.focus();

  return (
    <div className="spine" ref={box}>
      {h > 0 && (
        <svg width="200" height={h}>
          <defs>
            {a.edges.map(([s, t]) => (
              <linearGradient key={`${s}${t}`} id={`edge-${s}${t}`} gradientUnits="userSpaceOnUse" x1={x(s)} y1={y(s)} x2={x(t)} y2={y(t)}>
                <stop offset="0" style={{ stopColor: hue(s) }} />
                <stop offset="1" style={{ stopColor: hue(t) }} />
              </linearGradient>
            ))}
          </defs>
          {a.edges.map(([s, t]) => (
            <g key={`${s}${t}`} className={cls(!(enabled[s] && enabled[t]) && 'dim')}>
              <path d={edgePath(s, t)} stroke={`url(#edge-${s}${t})`} strokeWidth="7" opacity="0.18" fill="none" />
              <path d={edgePath(s, t)} stroke={`url(#edge-${s}${t})`} strokeWidth="2" fill="none" />
            </g>
          ))}
          {[6, 1.5].map((width) => (
            <path
              key={width} className={width === 6 ? 'bus-glow' : 'bus'} strokeWidth={width} fill="none"
              d={`${a.carriers.map((c) => `M${x(c) + R} ${y(c)}H${BUS_X}`).join('')}M${BUS_X} ${top}V${h - 20}`}
            />
          ))}
          <path d={`M${BUS_X - 5} ${h - 25}L${BUS_X} ${h - 17} ${BUS_X + 5} ${h - 25}`} className="bus" strokeWidth="1.5" fill="none" />
          {OPS.map((op) => {
            const carrier = a.carriers.includes(op);
            const loop = `M${-11.3} ${-11.3}A12 12 0 1 1 ${11.3} ${-11.3}`;
            return (
              <g
                key={op} transform={`translate(${x(op)} ${y(op)})`} className={cls('node', !enabled[op] && 'dim')}
                style={{ '--op': hue(op) } as CSSProperties} onClick={() => focusLane(op)}
              >
                {feedback[op] === 0
                  ? <path d={loop} className="loop idle" />
                  : <><path d={loop} className="loop glow" /><path d={loop} className="loop" /></>}
                {feedback[op] !== 0 && <text x="18" y="-31" className="loop-value">{signed(feedback[op])}</text>}
                <circle r={carrier ? 26 : 22} className="halo" opacity={carrier ? 0.14 : 0.08} />
                <circle r={R} className={carrier ? 'carrier' : 'modulator'} />
                <text className={carrier ? 'label carrier' : 'label'} dy="0.35em">{op}</text>
              </g>
            );
          })}
        </svg>
      )}
      <span className="spine-cap c-mod">MOD</span>
      <span className="spine-cap c-carrier">CARRIER</span>
      <span className="spine-cap c-out" style={{ top: h - 18 }}>OUT</span>
    </div>
  );
}

function Frequency({ n }: { n: number }) {
  const p = (k: string) => `op${n}.${k}`;
  const mode = useStore((s) => s.values?.[p('freqMode')]);
  const coarse = useStore((s) => s.values?.[p('coarse')]);
  const fine = useStore((s) => s.values?.[p('fine')]);
  const f = opFrequency({ [p('freqMode')]: mode!, [p('coarse')]: coarse!, [p('fine')]: fine! }, n);
  const mark = useStore((s) => s.marks[p('coarse')] ?? s.marks[p('fine')] ?? s.marks[p('freqMode')]);
  return (
    <>
      {mark && <span key={mark.at} className="freq-chip"><Chip mark={mark} /></span>}
      <ScrubNumber id={p('coarse')} label={`OP${n} coarse (drag the frequency vertically)`} className="freq" pxPerStep={6}>
        {f.estimated && <span className="approx" title="fixed-mode Hz is an estimate (spec §3.2 unresolved)">≈</span>}
        {f.display.replace(' Hz', '')}
        {f.mode === 'FIXED' && <span className="hz">Hz</span>}
      </ScrubNumber>
      <div className="freq-row">
        <Enum id={p('freqMode')} label={`OP${n} frequency mode`} className="op-enum" options={[{ value: 'RATIO', label: 'RATIO' }, { value: 'FIXED', label: 'FIXED' }]} />
        <span className="cfd">
          <ScrubNumber id={p('coarse')} label={`OP${n} coarse`} prefix="c" />
          <ScrubNumber id={p('fine')} label={`OP${n} fine`} prefix="f" />
          <ScrubNumber id={p('detune')} label={`OP${n} detune`} prefix="d" format={(v) => signed(v as number)} />
        </span>
      </div>
    </>
  );
}

function Feedback({ n }: { n: number }) {
  const level = `op${n}.feedback`, type = `op${n}.feedbackType`;
  const fb = useStore((s) => s.values?.[level] as number);
  const sq = useStore((s) => s.values?.[type] === 'SQUARE');
  const mark = useStore((s) => s.marks[level] ?? s.marks[type]);
  const value = sq ? -fb : fb;
  // README: one bipolar control; positive = SAW, negative = SQUARE. 0 keeps the stored type.
  const onChange = (v: number) => edit(v === 0 ? { [level]: 0 } : { [level]: Math.abs(v), [type]: v > 0 ? 'SAW' : 'SQUARE' });
  const text = value > 0 ? `+${value} saw` : value < 0 ? `−${-value} sq` : '0';
  const ghostFrom = mark && typeof mark.from === 'number' ? (sq ? -mark.from : mark.from) : undefined;
  return (
    <Bipolar
      id={level} label="feedback" ends={['← square', 'saw →']}
      bind={{ value, min: -127, max: 127, onChange, mark, ghostFrom, text, valuetext: value ? `${signed(value)}, ${sq ? 'square' : 'saw'}` : '0' }}
    />
  );
}

const curveText = (v: ParamValue) => (v as string).replace('-', '−').toLowerCase();

function Scaling({ n }: { n: number }) {
  const p = (k: string) => `op${n}.${k}`;
  const ld = useStore((s) => s.values?.[p('kslLeftDepth')] as number);
  const rd = useStore((s) => s.values?.[p('kslRightDepth')] as number);
  const lc = useStore((s) => s.values?.[p('kslLeftCurve')] as string);
  const rc = useStore((s) => s.values?.[p('kslRightCurve')] as string);
  // Level away from the C3 break point: "+" curves rise, "−" fall; EXP bends, LIN is straight.
  const yl = 8 - (lc.startsWith('+') ? 1 : -1) * (ld / 127) * 7;
  const yr = 8 - (rc.startsWith('+') ? 1 : -1) * (rd / 127) * 7;
  const left = lc.endsWith('EXP') ? `M2 ${yl}Q20 ${yl} 24 8` : `M2 ${yl}L24 8`;
  const right = rc.endsWith('EXP') ? `Q28 ${yr} 46 ${yr}` : `L46 ${yr}`;
  return (
    <div className="scaling">
      <svg width="36" height="12" viewBox="0 0 48 16" aria-hidden>
        <path d="M24 1V15" className="ksl-axis" />
        <path d={left + right} className="ksl-curve" />
      </svg>
      <span>
        rs <ScrubNumber id={p('rateScaling')} label={`OP${n} rate scaling`} /> · L<ScrubNumber id={p('kslLeftDepth')} label={`OP${n} scaling left depth`} />{' '}
        <ScrubNumber id={p('kslLeftCurve')} label={`OP${n} scaling left curve`} format={curveText} /> · R
        <ScrubNumber id={p('kslRightDepth')} label={`OP${n} scaling right depth`} />{' '}
        <ScrubNumber id={p('kslRightCurve')} label={`OP${n} scaling right curve`} format={curveText} />
      </span>
    </div>
  );
}

function OperatorLane({ n }: { n: number }) {
  const p = (k: string) => `op${n}.${k}`;
  const enabled = useStore((s) => s.values?.[p('enabled')] === true);
  const alg = useStore((s) => s.values?.algorithm as number);
  const a = ALGORITHMS[alg - 1];
  const role = a.carriers.includes(n) ? 'carrier → out' : `mod → ${a.edges.filter(([s]) => s === n).map(([, t]) => t).join(' ')}`;
  const nums = (k: 'Rate' | 'Level') => [1, 2, 3, 4].map((i) => (
    <ScrubNumber key={i} id={p(`eg${k}${i}`)} label={`OP${n} EG ${k.toLowerCase()} ${i}`} />
  ));
  return (
    <section className={cls('lane', !enabled && 'off')} style={{ '--op': hue(n) } as CSSProperties} data-lane={n} aria-label={`Operator ${n}`}>
      <div className="ident">
        <div className="ident-top">
          <span className="opid">OP{n}</span>
          <span className="role">{role}</span>
          <Toggle id={p('enabled')} label={`OP${n} on`} variant="pill" />
        </div>
        <Frequency n={n} />
      </div>
      <div className="levfb">
        <Fader id={p('level')} label="level" />
        <Feedback n={n} />
      </div>
      <div className="envcol">
        <EnvelopeEditor rates={[1, 2, 3, 4].map((i) => p(`egRate${i}`))} levels={[1, 2, 3, 4].map((i) => p(`egLevel${i}`))} min={0} max={127} name={`OP${n}`} variant="op" />
        <div className="env-nums"><span className="cap">rate</span>{nums('Rate')}<span className="cap gap">level</span>{nums('Level')}</div>
      </div>
      <div className="mod">
        <div className="mod-row">
          <Fader id={p('velocitySens')} label="velocity" variant="mini" />
          <Fader id={p('ampModDepth')} label="amp mod" variant="mini" />
        </div>
        <div className="mod-row">
          <Toggle id={p('lfoPitchMod')} label="lfo → pitch" variant="dot" />
          <Toggle id={p('pitchEgOn')} label="pitch eg" variant="dot" />
        </div>
        <Scaling n={n} />
      </div>
    </section>
  );
}

export function OperatorLanes() {
  return (
    <div className="lanes-area">
      <Spine />
      <div className="lanes">{OPS.map((n) => <OperatorLane key={n} n={n} />)}</div>
    </div>
  );
}
