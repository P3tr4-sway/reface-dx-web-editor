// AI prompt bar (design/README.md "AI prompt bar"): one input and one status line, no transcript. The job is
// server-owned (WS `ai` messages, also started from the CLI); this component derives what to show from it.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AiErrorKind } from '../../shared/protocol.ts';
import { cls, useTick } from './controls.tsx';
import { WRITE_MIN_MS, api, dismissAi, run, useStore } from './store.ts';

const MAX = 280;
const COUNTER_FROM = 240;
const STILL_S = 15;
const SLOW_S = 30;
const EXAMPLES = ['interstellar pad', 'glassy 80s e-piano', 'make it brighter and shorter'];
const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);
const UNREACHABLE = "Couldn't reach Claude";
/** Headline + fixed detail per kind; null detail = the server's message ("API error 529") + "· nothing was changed". */
const ERRORS: Record<AiErrorKind, [string, string | null]> = {
  auth: [UNREACHABLE, null], network: [UNREACHABLE, null], rate: [UNREACHABLE, null], timeout: [UNREACHABLE, null],
  refused: ['Claude declined this request', 'describe a sound instead'],
  invalid: ["That result wasn't a valid voice", 'nothing was written to the DX'],
};

const Lock = () => (
  <svg width="10" height="12" viewBox="0 0 10 12" className="glyph" aria-hidden>
    <rect x="0.6" y="5" width="8.8" height="6.4" rx="1.2" /><path d="M2.6 5V3.4a2.4 2.4 0 014.8 0V5" />
  </svg>
);

export function PromptBar({ libraryOpen }: { libraryOpen: boolean }) {
  const job = useStore((s) => s.ai);
  const seen = useStore((s) => s.aiSeen);
  const restored = useStore((s) => s.aiRestored);
  const configured = useStore((s) => !!s.status?.ai.configured);
  const connected = useStore((s) => !!s.status?.device.connected);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const busy = job?.state === 'designing' || job?.state === 'writing';
  const fresh = !!job && job.jobId !== seen;
  const mode = busy ? job!.state : !connected ? 'nodx' : !configured ? 'nokey'
    : fresh && job.state === 'done' ? 'done' : fresh && job.state === 'error' ? 'error' : 'idle';
  const off = mode === 'nodx' || mode === 'nokey';
  const r = job?.result;
  const total = r?.changedCount ?? 0;

  useTick(1000, busy);
  const elapsed = busy ? Math.max(0, Math.floor((Date.now() - Date.parse(job!.startedAt)) / 1000)) : 0;

  // Any job (from this tab, another tab or the CLI) shows its prompt; it stays for Retry and ↑.
  useEffect(() => { if (job) setText(job.prompt); }, [job?.jobId]); // once per job, not on every progress message

  // Writing phase: fill + "n/total" run over the phase's minimum display time (the bulk write is atomic).
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (mode !== 'writing') return setProgress(0);
    const t0 = performance.now();
    let raf = requestAnimationFrame(function tick() {
      const k = Math.min(1, (performance.now() - t0) / WRITE_MIN_MS);
      setProgress(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [mode]);
  const written = Math.round(progress * total);

  const cancel = () => run(api('POST', '/api/ai/cancel'));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (libraryOpen) return; // Esc closes the drawer first; "/" is ignored while it is open
      if (e.key === 'Escape' && mode === 'designing') cancel();
      else if (e.key === '/' && !off && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as HTMLElement).closest('input, textarea')) {
        e.preventDefault();
        returnTo.current = document.activeElement as HTMLElement | null;
        input.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [libraryOpen, mode, off]);

  const change = (value: string) => {
    setText(value);
    if (mode === 'error' || mode === 'done') dismissAi(); // the input can keep focus through Done (it was focused at submit)
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (prompt && !busy && !off) run(api('POST', '/api/ai/generate', { prompt }));
  };
  const onFocus = () => {
    if (mode !== 'done') return;
    dismissAi(); // Done ends on focus; the last prompt comes back selected for a follow-up
    requestAnimationFrame(() => input.current?.select());
  };

  const said = mode === 'designing' ? (elapsed >= STILL_S ? 'Still designing' : 'Designing')
    : mode === 'writing' ? 'Writing to DX'
    : mode === 'done' ? `Done. ${r!.name}. ${r!.summary.replaceAll(' · ', ', ')}. ${total} parameters changed. Playing ${r!.audition} phrase.`
    : restored ? `Restored ${restored}.`
    : fresh && job.state === 'cancelled' ? 'Cancelled. Nothing was changed.' : '';
  const [head, detail] = job?.error ? ERRORS[job.error.kind] : ['', null];

  return (
    <form className={cls('aibar', off && 'off')} aria-label="Design a sound with AI" aria-busy={busy} onSubmit={submit}>
      <div className="ai-label"><b>PROMPT</b>claude opus 5.5</div>
      <div
        className={cls('field', mode, off && 'off', busy && 'busy')}
        onClick={(e) => { if (!off && !(e.target as HTMLElement).closest('button')) input.current?.focus(); }}
      >
        <span className="ai-mark" aria-hidden>AI</span>
        {busy && <Lock />}
        {mode === 'nokey' && (
          <svg width="16" height="12" viewBox="0 0 16 12" className="glyph key" aria-hidden><circle cx="4.5" cy="6" r="3" /><path d="M7.5 6H15M12.5 6V8.6M14.6 6V8" /></svg>
        )}
        {mode === 'nodx' && <span className="ring" aria-hidden><i /></span>}
        {off && (
          <span id="ai-hint" className="hint">
            {mode === 'nokey' ? <>Add <b>ANTHROPIC_API_KEY</b> to <b>.env</b> and restart the server</> : 'Connect the reface DX to design a sound'}
          </span>
        )}
        {mode === 'done' && (
          <div className="result">
            <svg width="12" height="12" viewBox="0 0 12 12" className="check" aria-hidden><path d="M2 6.4L4.9 9.2 10 3" /></svg>
            <span className="done-label">DONE</span>
            <span className="result-name">{r!.name}</span>
            <span className="summary" title={r!.summary}>{r!.summary}</span>
          </div>
        )}
        <input
          ref={input} className="prompt" type="text" value={text} maxLength={MAX} autoComplete="off" spellCheck={false}
          aria-label="Describe a sound" aria-keyshortcuts="/" placeholder="Describe a sound…"
          readOnly={busy} aria-readonly={busy || undefined} disabled={off} aria-describedby={off ? 'ai-hint' : undefined}
          onChange={(e) => change(e.target.value)} onFocus={onFocus}
          onKeyDown={(e) => {
            if (busy) return; // Esc cancels through the window listener
            if (e.key === 'Escape') {
              e.preventDefault();
              if (text) change('');
              else { input.current?.blur(); returnTo.current?.focus(); }
            } else if (e.key === 'ArrowUp' && !text && job) {
              e.preventDefault();
              change(job.prompt);
            }
          }}
        />

        {mode === 'idle' && !text && (
          <div className="examples">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="ex" aria-label={`Use example: ${x}`} onClick={() => { change(x); input.current?.focus(); }}>{x}</button>
            ))}
          </div>
        )}
        {mode === 'idle' && restored && <span className="ai-note">Restored {restored}</span>}
        {busy && (
          <div className="phases">
            <div className="steps">
              <span className={cls('step', mode === 'designing' ? 'active' : 'done')}>
                <i />DESIGNING{elapsed >= SLOW_S && mode === 'designing' && <span className="slow">· taking longer than usual</span>}
              </span>
              <i className="rule" />
              <span className={cls('step', mode === 'writing' && 'active')}><i />WRITING TO DX{mode === 'writing' && <span className="of">{written}/{total}</span>}</span>
            </div>
            <span className="elapsed" aria-hidden>{elapsed}s</span>
          </div>
        )}
        {mode === 'done' && <span className="changed">{total} param{total === 1 ? '' : 's'} changed</span>}
        {mode === 'error' && (
          <div className="ai-error" role="alert">
            <svg width="14" height="14" viewBox="0 0 14 14" className="info" aria-hidden><circle cx="7" cy="7" r="6" /><path d="M7 3.6V8" /><circle cx="7" cy="10.2" r="0.85" className="dot" /></svg>
            <span className="err-head">{head}</span>
            <span className="err-detail" title={job!.error!.message}>{detail ?? `${job!.error!.message} · nothing was changed`}</span>
          </div>
        )}

        <div className="ai-actions">
          {(mode === 'idle' || mode === 'error') && text.length >= COUNTER_FROM && <span className="count">{text.length}/{MAX}</span>}
          {mode === 'idle' && <kbd className="slash" aria-hidden>/</kbd>}
          {(mode === 'idle' || off) && <button type="submit" className="ai-pill primary" disabled={off}>GENERATE<span className="k">↵</span></button>}
          {mode === 'error' && <button type="submit" className="ai-pill primary">RETRY<span className="k">↵</span></button>}
          {busy && (
            <button type="button" className="ai-pill" aria-keyshortcuts="Escape" disabled={mode === 'writing'} onClick={cancel}>cancel<span className="k">esc</span></button>
          )}
          {mode === 'done' && (
            <>
              <button type="button" className="ai-pill" aria-keyshortcuts="Meta+Z Control+Z" onClick={() => run(api('POST', '/api/undo'))}>
                undo<span className="k">{MAC ? '⌘Z' : 'Ctrl+Z'}</span>
              </button>
              <button type="button" className="ai-pill play" aria-label={`Play the ${r!.audition} phrase again`} onClick={() => run(api('POST', '/api/audition', { what: r!.audition }))}>
                <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden><path d="M1 0.8L7.2 4.5 1 8.2Z" /></svg>play again<span className="k">{r!.audition}</span>
              </button>
            </>
          )}
        </div>

        {(mode === 'idle' || mode === 'done') && <i className="line rest" aria-hidden />}
        {mode === 'done' && <i className="line flash" aria-hidden />}
        {mode === 'designing' && <span className="line-clip" aria-hidden><i className="comet" /></span>}
        {mode === 'writing' && (
          <span className="line-clip" role="progressbar" aria-label="Writing to DX" aria-valuemin={0} aria-valuemax={total} aria-valuenow={written}>
            <i className="wfill" style={{ width: `calc((100% - 10px) * ${progress})` }} />
          </span>
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said}</div>
    </form>
  );
}
