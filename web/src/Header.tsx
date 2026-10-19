// Header: link status, slot + voice name, dirty state, activity log (latest AI/DX change), undo/redo, save.
import { PARAM_BY_ID, type ParamValue } from '../../shared/params.ts';
import { cls, useTick } from './controls.tsx';
import { api, connect, run, useStore } from './store.ts';

const show = (v: ParamValue) => (typeof v === 'boolean' ? (v ? 'ON' : 'OFF') : String(v));

function ActivityLog() {
  const log = useStore((s) => s.log);
  const notice = useStore((s) => s.notice);
  useTick(1000);
  if (notice) return <div className="activity notice" role="status">{notice}</div>;
  if (!log) return <div className="activity" />;
  // The feedback type has no control of its own: it lives in the bipolar feedback slider.
  const target = log.id.replace(/feedbackType$/, 'feedback');
  const age = Math.round((performance.now() - log.at) / 1000);
  return (
    <button type="button" className="activity" title="Jump to this control" onClick={() => document.querySelector<HTMLElement>(`[data-param="${target}"]`)?.focus()}>
      <span className={cls('chip big', log.source === 'api' ? 'ai' : 'dx')}>{log.source === 'api' ? 'AI' : 'DX'}</span>
      <span className="log-text">
        {log.prompt !== undefined ? `PROMPT → ${log.prompt} PARAMS`
          : <>{PARAM_BY_ID.get(log.id)!.label.toUpperCase()} {show(log.from)}→{show(log.to)}{log.more > 0 && ` +${log.more}`}</>}
      </span>
      <span className="log-age">{age < 1 ? 'now' : `${age}s`}</span>
    </button>
  );
}

const UNDO = ['M7 5L3 9l4 4', 'M3 9h9a4.5 4.5 0 010 9H9'];
const REDO = ['M13 5l4 4-4 4', 'M17 9H8a4.5 4.5 0 000 9h3'];

export function Header({ onSave }: { onSave: () => void }) {
  const link = useStore((s) => s.link);
  const status = useStore((s) => s.status);
  const latency = useStore((s) => s.latencyMs);
  const linked = link === 'open' && status?.device.connected;
  const ready = linked && !status.busy;
  return (
    <header className="header">
      <div className="mark" aria-hidden><i /><i /><i /><i /></div>
      <div className="brand">
        <div className="brand-name">reface DX</div>
        {linked ? (
          // "USB": the CoreMIDI port named after the instrument is its USB-MIDI interface.
          <div className="link"><i className="ldot" />LINKED · USB{latency !== null && ` · ${latency}ms`}</div>
        ) : (
          <div className="link down">
            <i className="ldot" />
            <span>{link === 'open' ? 'NO DX FOUND' : link === 'connecting' ? 'CONNECTING' : 'SERVER OFFLINE'}</span>
            <button type="button" className="retry" onClick={connect}>retry</button>
          </div>
        )}
      </div>
      <div className="voice">
        <span className="slot">{status?.currentSlotLabel ?? '—'}</span>
        <h1 className="vname">{status?.voiceName ?? '—'}</h1>
        {status?.dirty ? (
          <>
            <span className="dirty"><i />EDITED</span>
            <span className="store-hint"><span className="store-key">STORE</span>on the DX keeps it</span>
          </>
        ) : (
          <span className="clean"><i />{status?.dirty === false ? `IN SYNC WITH ${status.currentSlotLabel}` : 'SLOT UNKNOWN'}</span>
        )}
      </div>
      <div className="actions">
        <ActivityLog />
        <div className="history">
          {([['Undo', UNDO, '/api/undo', status?.canUndo], ['Redo', REDO, '/api/redo', status?.canRedo]] as const).map(([label, d, path, can]) => (
            <button key={label} type="button" className="icon-btn" aria-label={label} disabled={!ready || !can} onClick={() => run(api('POST', path))}>
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>{d.map((p) => <path key={p} d={p} />)}</svg>
            </button>
          ))}
        </div>
        <button type="button" className="pill-btn" disabled={!ready} onClick={onSave}>SAVE AS PATCH</button>
      </div>
    </header>
  );
}
