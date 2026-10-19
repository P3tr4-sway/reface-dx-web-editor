// The control vocabulary (design/README.md "Control vocabulary"): every control binds to one param id.
// Fader and Bipolar share one Slider; ScrubNumber, Enum and Toggle cover the rest.
import {
  useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject,
} from 'react';
import { PARAM_BY_ID, type IntParam, type ParamValue } from '../../shared/params.ts';
import { edit, useStore, type RemoteMark } from './store.ts';

export const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function useParam(id: string) {
  const value = useStore((s) => s.values?.[id]);
  const mark = useStore((s) => s.marks[id]);
  return { value, mark, set: (v: ParamValue) => edit({ [id]: v }) };
}

// The 1440×900 design canvas is scaled uniformly to fit the window (App). Layout, SVG and ResizeObserver sizes are
// all in design px; pointer events arrive in viewport px, so pointer coordinates are divided by viewScale at input.
const DESIGN_W = 1440;
const DESIGN_H = 900;
export let viewScale = 1;

/** Scale and centring offset of the canvas for the current window; follows resizes. */
export function useViewportFit(): { scale: number; x: number; y: number } {
  const get = () => {
    const scale = Math.min(innerWidth / DESIGN_W, innerHeight / DESIGN_H);
    return { scale, x: Math.round((innerWidth - DESIGN_W * scale) / 2), y: Math.round((innerHeight - DESIGN_H * scale) / 2) };
  };
  const [fit, setFit] = useState(get);
  useEffect(() => {
    const onResize = () => setFit(get());
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  viewScale = fit.scale;
  return fit;
}

/** Re-render every `ms` while `on` (log age, elapsed seconds). */
export function useTick(ms: number, on = true): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
}

export function useSize<T extends Element>(): [RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Pointer drag with capture; reports per-event deltas in design px so Shift (fine) can change mid-drag. */
function useDrag(h: { start: () => void; move: (dx: number, dy: number, fine: boolean) => void; end?: (moved: boolean) => void }) {
  const last = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const stop = () => {
    if (!last.current) return;
    const { moved } = last.current;
    last.current = null;
    setDragging(false);
    h.end?.(moved);
  };
  return {
    dragging,
    handlers: {
      onPointerDown(e: PointerEvent<HTMLElement>) {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = { x: e.clientX, y: e.clientY, moved: false };
        setDragging(true);
        h.start();
      },
      onPointerMove(e: PointerEvent<HTMLElement>) {
        const l = last.current;
        if (!l) return;
        const dx = e.clientX - l.x, dy = e.clientY - l.y;
        if (!l.moved && Math.abs(dx) + Math.abs(dy) < 3) return; // a click, not a drag
        l.moved = true;
        l.x = e.clientX;
        l.y = e.clientY;
        h.move(dx / viewScale, dy / viewScale, e.shiftKey);
      },
      onPointerUp: stop,
      onLostPointerCapture: stop,
    },
  };
}

export function Chip({ mark }: { mark: RemoteMark }) {
  return <span className={cls('chip', mark.source === 'api' ? 'ai' : 'dx')}>{mark.source === 'api' ? 'AI' : 'DX'}</span>;
}

interface SliderProps {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  reset: number | undefined;
  mark: RemoteMark | undefined;
  /** Remote change start value in this slider's domain (bloom ghost trail). */
  ghostFrom?: number;
  text: string;
  valuetext?: string;
  variant: 'op' | 'global' | 'mini';
  bipolar?: boolean;
  ends?: [string, string];
}

function Slider(p: SliderProps) {
  const track = useRef<HTMLDivElement>(null);
  const acc = useRef(p.value);
  const put = (n: number) => { const v = clamp(Math.round(n), p.min, p.max); if (v !== p.value) p.onChange(v); };
  const drag = useDrag({
    start: () => { acc.current = p.value; },
    move: (dx, _dy, fine) => {
      acc.current = clamp(acc.current + (dx / track.current!.clientWidth) * (p.max - p.min) * (fine ? 0.25 : 1), p.min, p.max);
      put(p.bipolar && Math.abs(acc.current) <= 3 ? 0 : acc.current); // README: bipolar snaps to 0 within ±3
    },
  });
  const onKeyDown = (e: KeyboardEvent) => {
    const step = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 8, PageDown: -8 } as Record<string, number>)[e.key];
    const next = step ? p.value + step : e.key === 'Home' ? p.min : e.key === 'End' ? p.max : null;
    if (next === null) return;
    e.preventDefault();
    put(next);
  };
  const pct = (v: number) => ((v - p.min) / (p.max - p.min)) * 100;
  const at = pct(p.value);
  const origin = p.bipolar ? pct(0) : 0;
  const ghost = p.mark && p.ghostFrom !== undefined ? pct(p.ghostFrom) : null;
  return (
    <div
      className={cls('slider', p.variant, p.bipolar && 'bipolar', drag.dragging && 'dragging')}
      role="slider" tabIndex={0} aria-label={p.label} aria-valuemin={p.min} aria-valuemax={p.max} aria-valuenow={p.value}
      aria-valuetext={p.valuetext ?? p.text} data-param={p.id} {...drag.handlers} onKeyDown={onKeyDown}
      onWheel={(e) => put(p.value + (e.deltaY < 0 ? 1 : -1))}
      onDoubleClick={() => p.reset !== undefined && put(p.reset)}
    >
      <div className="s-row">
        <span className="s-label">{p.label}</span>
        <span className="s-value">
          {p.mark && <Chip key={`chip${p.mark.at}`} mark={p.mark} />}
          <span key={`num${p.mark?.at}`} className={cls('num', p.mark && 'bloom')}>{p.text}</span>
        </span>
      </div>
      <div className="track" ref={track}>
        {p.bipolar && <i className="notch" style={{ left: `${origin}%` }} />}
        <i className="fill" style={{ left: `${Math.min(origin, at)}%`, width: `${Math.abs(at - origin)}%` }} />
        {ghost !== null && (
          <i key={p.mark!.at} className="ghost" style={{ left: `${Math.min(ghost, at)}%`, width: `${Math.abs(at - ghost)}%` }} />
        )}
        {p.variant !== 'mini' && (
          <i className="thumb" style={{ left: `${at}%` }}>{p.mark && <i key={p.mark.at} className="thumb-bloom" />}</i>
        )}
      </div>
      {p.ends && (
        <div className="ends">
          <span className={cls(p.value < 0 && 'on')}>{p.ends[0]}</span>
          <span className={cls(p.value > 0 && 'on')}>{p.ends[1]}</span>
        </div>
      )}
    </div>
  );
}

const intDef = (id: string) => PARAM_BY_ID.get(id) as IntParam;

export function Fader({ id, label, variant = 'op' }: { id: string; label: string; variant?: SliderProps['variant'] }) {
  const { min, max } = intDef(id);
  const { value, mark, set } = useParam(id);
  const reset = useStore((s) => s.baseline?.[id]) as number | undefined;
  const v = value as number;
  return (
    <Slider id={id} label={label} min={min} max={max} value={v} onChange={set} reset={reset} mark={mark}
      ghostFrom={mark?.from as number} text={String(v)} variant={variant} />
  );
}

interface BipolarProps {
  id: string;
  label: string;
  variant?: SliderProps['variant'];
  /** Composite binding (feedback = level + type); defaults to the param itself. */
  bind?: { value: number; min: number; max: number; onChange: (v: number) => void; mark?: RemoteMark; ghostFrom?: number; text: string; valuetext: string };
  ends?: [string, string];
}

export function Bipolar({ id, label, variant = 'op', bind, ends }: BipolarProps) {
  const own = useParam(id);
  const def = intDef(id);
  const b = bind ?? {
    value: own.value as number, min: def.min, max: def.max, onChange: own.set, mark: own.mark,
    ghostFrom: own.mark?.from as number, text: signed(own.value as number), valuetext: signed(own.value as number),
  };
  return (
    <Slider id={id} label={label} min={b.min} max={b.max} value={b.value} onChange={b.onChange} reset={0} mark={b.mark}
      ghostFrom={b.ghostFrom} text={b.text} valuetext={b.valuetext} variant={variant} bipolar ends={ends} />
  );
}

interface ScrubProps {
  id: string;
  label: string;
  prefix?: string;
  format?: (v: ParamValue) => string;
  className?: string;
  /** Custom display (the big frequency number); disables click-to-type. */
  children?: ReactNode;
  /** Pixels of vertical drag per step. */
  pxPerStep?: number;
}

/** Int or enum value: drag ↕ (Shift = fine), ↑↓ keys, or click to type. */
export function ScrubNumber({ id, label, prefix = '', format = String, className, children, pxPerStep = 4 }: ScrubProps) {
  const def = PARAM_BY_ID.get(id)!;
  const { value, mark, set } = useParam(id);
  const options = def.kind === 'enum' ? def.options : null;
  const [min, max] = options ? [0, options.length - 1] : [(def as IntParam).min, (def as IntParam).max];
  const index = options ? options.indexOf(value as string) : (value as number);
  const put = (n: number) => {
    const i = clamp(Math.round(n), min, max);
    const v = options ? options[i] : i;
    if (v !== value) set(v);
  };
  const [typing, setTyping] = useState(false);
  const acc = useRef(index);
  const drag = useDrag({
    start: () => { acc.current = index; },
    move: (_dx, dy, fine) => { acc.current = clamp(acc.current - dy / (pxPerStep * (fine ? 4 : 1)), min, max); put(acc.current); },
    end: (moved) => { if (!moved && !children) setTyping(true); },
  });
  const text = format(value as ParamValue);
  const commit = (input: string) => {
    setTyping(false);
    const s = input.trim().replace('−', '-');
    if (options) {
      const i = options.findIndex((o) => o.toLowerCase() === s.toLowerCase() || format(o).toLowerCase() === s.toLowerCase());
      if (i >= 0) put(i);
    } else if (/^[+-]?\d+$/.test(s)) put(Number(s));
  };
  if (typing) {
    return (
      <input
        className={cls('scrub-input', className)} aria-label={label} defaultValue={text} autoFocus size={Math.max(2, text.length + 1)}
        onFocus={(e) => e.currentTarget.select()} onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
          if (e.key === 'Escape') setTyping(false);
        }}
      />
    );
  }
  return (
    <span
      className={cls('scrub', className, drag.dragging && 'dragging')} role="spinbutton" tabIndex={0} aria-label={label}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={index} aria-valuetext={text} data-param={id} {...drag.handlers}
      onKeyDown={(e) => {
        const step = ({ ArrowUp: 1, ArrowDown: -1, PageUp: 8, PageDown: -8 } as Record<string, number>)[e.key];
        if (step) { e.preventDefault(); put(index + step); }
        if (e.key === 'Enter' && !children) setTyping(true);
      }}
    >
      <span key={mark?.at} className={cls(mark && 'bloom')}>{children ?? prefix + text}</span>
    </span>
  );
}

export interface EnumOption { value: ParamValue; label: ReactNode; title?: string }

/** "Lightboard": every option visible; ←/→ step, click selects. */
export function Enum({ id, label, options, className }: { id: string; label: string; options: EnumOption[]; className?: string }) {
  const { value, mark, set } = useParam(id);
  const i = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    set(options[clamp(i + d, 0, options.length - 1)].value);
  };
  return (
    <div className={cls('enum', className)} role="radiogroup" aria-label={label} tabIndex={0} data-param={id} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={`${o.value}${on && mark ? mark.at : ''}`} type="button" role="radio" aria-checked={on} tabIndex={-1}
            title={o.title} className={cls('opt', on && mark && 'bloom')} onClick={() => set(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Operator power (pill) or per-op switch (lit dot + label; the whole label is the hit area). */
export function Toggle({ id, label, variant }: { id: string; label: string; variant: 'pill' | 'dot' }) {
  const { value, mark, set } = useParam(id);
  return (
    <button
      type="button" role="switch" aria-checked={value === true} aria-label={label} data-param={id}
      className={cls('toggle', variant)} onClick={() => set(!value)}
    >
      <i key={mark?.at} className={cls('knob', mark && 'bloom')} />
      {variant === 'dot' && <span>{label}</span>}
    </button>
  );
}
