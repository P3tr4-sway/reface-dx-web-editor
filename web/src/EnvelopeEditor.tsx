// 4-segment rate/level envelope (operator amp EG or the pitch EG). Handles mark the end of each segment:
// drag x = rate (further left = faster), y = level. Keyboard: Tab between handles, ↑↓ level, ←→ rate.
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clamp, cls, useSize, viewScale } from './controls.tsx';
import { edit, useStore } from './store.ts';

interface Props {
  rates: string[];
  levels: string[];
  min: number;
  max: number;
  /** Accessible name prefix, e.g. "OP1" → handles "OP1 segment 2". */
  name: string;
  variant: 'op' | 'peg';
}

interface Point { x: number; y: number }
interface Drag { i: number; scale: number; ghost: Point[] }

const PAD = { op: 6, peg: 4 };
// Segment width grows with slower rates and (more gently) with the level distance it travels, like a DX EG.
// Curve constants were fitted to the Paper artboard (OP2 lands within ~10 px of its drawn handles).
const RATE_W = (rate: number) => 8 + 200 * ((127 - rate) / 127) ** 1.3;
const RATE_OF = (w: number) => Math.round(127 - 127 * clamp((w - 8) / 200, 0, 1) ** (1 / 1.3));
const SPAN = (diff: number, range: number) => 0.5 + 0.5 * Math.sqrt(Math.abs(diff) / range);
// Sustain hold before key-off as a share of the width (Paper: 104 of 400 px for operators, ~26 of 260 for the PEG),
// and a width gain that gives the narrower PEG Paper's 56 px steps at rate 64.
const HOLD = { op: 0.26, peg: 0.1 };
const GAIN = { op: 1, peg: 1.27 };

function layout(variant: Props['variant'], r: number[], l: number[], w: number, h: number, min: number, max: number, scale?: number) {
  const pad = PAD[variant];
  const range = max - min;
  const y = (level: number) => h - pad - ((level - min) / range) * (h - 2 * pad);
  const raw = r.map((rate, i) => GAIN[variant] * RATE_W(rate) * SPAN(l[i] - l[(i + 3) % 4], range));
  const hold = w * HOLD[variant];
  // Scale down only when the voice would overflow; frozen during a drag so the handle tracks the pointer.
  const s = scale ?? Math.min(1, (w - 2 * pad - hold) / raw.reduce((a, b) => a + b, 0));
  const pts: Point[] = [{ x: pad, y: y(l[3]) }];
  let x = pad;
  raw.forEach((seg, i) => {
    if (i === 3) { x += hold; pts.push({ x, y: y(l[2]) }); }
    x += seg * s;
    pts.push({ x, y: y(l[i]) });
  });
  return { pts, scale: s, keyoff: pts[4].x };
}

export function EnvelopeEditor({ rates, levels, min, max, name, variant }: Props) {
  // Fixed-length (4) id lists, so the hook order never changes.
  const r = rates.map((id) => useStore((s) => s.values?.[id] as number));
  const l = levels.map((id) => useStore((s) => s.values?.[id] as number));
  const [box, { w, h }] = useSize<HTMLDivElement>();
  const gid = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const pad = PAD[variant];
  const { pts, scale, keyoff } = layout(variant, r, l, w, h, min, max, drag?.scale);
  const handles = [pts[1], pts[2], pts[3], pts[5]]; // pts[4] is the key-off corner, not a handle
  const line = (p: Point[]) => `M${p.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' L')}`;
  const range = max - min;

  const put = (i: number, rate: number, level: number) => {
    const v: Record<string, number> = {};
    const rr = clamp(rate, 0, 127);
    const ll = clamp(level, min, max);
    if (rr !== r[i]) v[rates[i]] = rr;
    if (ll !== l[i]) v[levels[i]] = ll;
    if (Object.keys(v).length) edit(v);
  };
  const fromPointer = (e: PointerEvent<SVGCircleElement>, d: Drag) => {
    const rect = box.current!.getBoundingClientRect(); // viewport px; w, h and pts are design px
    const px = (e.clientX - rect.left) / viewScale, py = (e.clientY - rect.top) / viewScale;
    const ll = clamp(Math.round(min + ((h - pad - py) / (h - 2 * pad)) * range), min, max);
    const prevX = d.i === 3 ? keyoff : pts[d.i].x;
    const prevLevel = l[(d.i + 3) % 4];
    const rate = RATE_OF(Math.max(0, px - prevX) / d.scale / GAIN[variant] / SPAN(ll - prevLevel, range));
    put(d.i, rate, ll);
  };
  const onKey = (i: number) => (e: KeyboardEvent) => {
    const big = e.shiftKey ? 8 : 1;
    const delta = ({ ArrowUp: [0, big], ArrowDown: [0, -big], ArrowLeft: [big, 0], ArrowRight: [-big, 0], PageUp: [0, 8], PageDown: [0, -8] } as Record<string, number[]>)[e.key];
    if (!delta) return;
    e.preventDefault();
    put(i, r[i] + delta[0], l[i] + delta[1]);
  };

  const active = drag?.i ?? hover;
  const a = active !== null ? handles[active] : null;
  return (
    <div className={cls('env', `env-${variant}`)} ref={box}>
      {w > 0 && (
        <svg width={w} height={h} className="env-svg">
          {variant === 'op' && (
            <>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2={h} gradientUnits="userSpaceOnUse">
                  <stop offset="0" style={{ stopColor: 'var(--op)', stopOpacity: 0.3 }} />
                  <stop offset="1" style={{ stopColor: 'var(--op)', stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              <path d={`M0 ${h - 0.5}H${w}`} className="env-base" />
              <path d={`M${keyoff.toFixed(1)} 0V${h}`} className="env-keyoff" />
              <path d={`${line(pts)} Z`} fill={`url(#${gid})`} />
            </>
          )}
          {variant === 'peg' && <path d={`M0 0.5H${w}M0 ${h - 0.5}H${w}`} className="env-base" />}
          {drag && <path d={line(drag.ghost)} className="env-ghost" />}
          {a && <path d={`M${a.x} ${a.y}V${h}M0 ${a.y}H${a.x}`} className={cls('env-guide', drag && 'drag')} />}
          <path d={line(pts)} className="env-glow" />
          <path d={line(pts)} className="env-line" />
          {handles.map((p, i) => (
            <circle
              key={i} cx={p.x} cy={p.y} r={i === active ? 6 : 4}
              className={cls('handle', i === hover && 'hover', drag?.i === i && 'drag')}
              role="slider" tabIndex={0} aria-label={`${name} segment ${i + 1}`} aria-valuemin={min} aria-valuemax={max}
              aria-valuenow={l[i]} aria-valuetext={`rate ${r[i]}, level ${l[i]}`}
              onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag({ i, scale, ghost: pts });
              }}
              onPointerMove={(e) => drag && fromPointer(e, drag)}
              onPointerUp={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}
              onKeyDown={onKey(i)}
            />
          ))}
        </svg>
      )}
      {a && active !== null && (
        <div className={cls('env-readout', drag && 'drag')} style={{ left: Math.min(a.x + 10, w - 96), top: Math.max(0, a.y - 22) }}>
          R{active + 1} {r[active]} · L{active + 1} {l[active]}
        </div>
      )}
      {variant === 'peg' && <><span className="peg-lim top">+48</span><span className="peg-lim bottom">−48</span></>}
    </div>
  );
}
