// Library rail (dot map of the 4×8 banks) and drawer (load stored voices / local patches, save, scan).
import { useEffect, useState } from 'react';
import type { LoadResponse, PatchInfo, PresetEntry } from '../../shared/protocol.ts';
import { cls } from './controls.tsx';
import { api, notify, run, selectEditable, useStore } from './store.ts';

const BANKS = [0, 1, 2, 3];
const VOICES = [0, 1, 2, 3, 4, 5, 6, 7];

export function LibraryRail({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const slot = useStore((s) => s.status?.currentSlot ?? null);
  return (
    <nav className="rail" aria-label="Library">
      <button type="button" className={cls('lib-btn', open && 'on')} aria-label="Open library (L)" aria-expanded={open} onClick={onOpen}>
        <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden><path d="M1 1.5H15M1 6H15M1 10.5H10" /></svg>
      </button>
      <span className="rail-cap">LIB</span>
      <div className="voice-map" aria-hidden>
        <div className="vm-row">{BANKS.map((b) => <span key={b}>{b + 1}</span>)}</div>
        {VOICES.map((v) => <div key={v} className="vm-row">{BANKS.map((b) => <i key={b} className={cls(slot === b * 8 + v && 'lit')} />)}</div>)}
      </div>
      <button type="button" className="mine" aria-label="My patches" onClick={onOpen}><i /><i /><i /><span>MINE</span></button>
    </nav>
  );
}

interface Pending { what: string; load: () => Promise<{ note: string; warning?: string }> }

export function LibraryDrawer({ mode, onClose }: { mode: 'browse' | 'save'; onClose: () => void }) {
  const presets = useStore((s) => s.presets);
  const status = useStore((s) => s.status);
  const editable = useStore(selectEditable);
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [patches, setPatches] = useState<PatchInfo[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(mode === 'save' ? (status?.voiceName ?? '') : null);
  const [closing, setClosing] = useState(false);
  const busy = status?.busy;

  const refreshPatches = () => api<PatchInfo[]>('GET', '/api/patches').then(setPatches, (e: Error) => notify(e.message));
  useEffect(() => { void refreshPatches(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirm) setConfirm(null);
      else setClosing(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [confirm]);

  const load = (p: Pending) => run(p.load().then((r) => {
    setConfirm(null);
    setMessage([r.warning, r.note].filter(Boolean).join(' · '));
  }));
  // Loading replaces the DX edit buffer, so ask first unless the voice is known to be unedited.
  const request = (p: Pending) => (status?.dirty === false ? load(p) : setConfirm(p));
  const save = (name: string) => run(api<{ name: string }>('POST', '/api/patches', { name }).then(() => {
    setNaming(null);
    setMessage(`saved "${name}" on this computer · press STORE on the DX to keep it on the instrument`);
    return refreshPatches();
  }));
  const match = (name: string) => !query || name.toLowerCase().includes(query.trim().toLowerCase());

  const cell = (p: PresetEntry) => {
    const current = status?.currentSlot === p.slot;
    return (
      <button
        key={p.slot} type="button" className={cls('cell', current && 'current', !match(p.name) && 'miss')} disabled={!editable || !match(p.name)}
        onClick={() => request({ what: `${p.label} ${p.name}`, load: () => api<LoadResponse>('POST', `/api/presets/${p.label}/load`) })}
        onDoubleClick={() => run(api('POST', '/api/audition', { what: 'chord' }))}
      >
        <span className="cell-slot">{p.label}</span>
        <span className="cell-name">{p.name}</span>
        {current && (status?.dirty ? <i className="edited-dot" title="edited" /> : <span className="prism" aria-label="loaded"><i /><i /><i /><i /></span>)}
        {!current && <span className="cell-hint">load ↵</span>}
      </button>
    );
  };

  return (
    <>
      <div className={cls('backdrop', closing && 'closing')} onClick={() => setClosing(true)} />
      <section className={cls('drawer', closing && 'closing')} aria-label="Library" onAnimationEnd={(e) => closing && e.target === e.currentTarget && onClose()}>
        <div className="drawer-head">
          <h2 className="title">LIBRARY</h2>
          {confirm ? (
            <div className="confirm" role="alertdialog" aria-label="Replace the edited voice?">
              <span>Load {confirm.what}? The edited voice on the DX is replaced (undo brings it back).</span>
              <button type="button" className="mini-pill on" autoFocus onClick={() => load(confirm)}>load</button>
              <button type="button" className="mini-pill" onClick={() => setConfirm(null)}>cancel</button>
            </div>
          ) : (
            <span className="drawer-note" role="status">{message ?? '32 voices on the DX · click to load, double-click to audition'}</span>
          )}
          <label className="search">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><circle cx="5" cy="5" r="4" /><path d="M8 8l3 3" /></svg>
            <input type="search" placeholder="search voices" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search voices" />
          </label>
          <button type="button" className="esc" onClick={() => setClosing(true)}><span className="kbd">ESC</span>close</button>
        </div>
        <div className="banks">
          {presets ? BANKS.map((b) => (
            <div key={b} className="bank">
              <h3 className="bank-head">BANK {b + 1}</h3>
              {presets.presets.filter((p) => p.slot >> 3 === b).map(cell)}
            </div>
          )) : (
            <div className="scan-empty">
              {busy ? (
                <>
                  <span>reading the DX · {busy.done}/{busy.total} · {busy.message}</span>
                  <div className="scan-bar"><i style={{ width: `${(busy.done / busy.total) * 100}%` }} /></div>
                </>
              ) : (
                <>
                  <span>No voice list yet. Scanning reads all 32 stored voices from the DX (about 8 s) and keeps your edit buffer.</span>
                  <button type="button" className="mini-pill on" disabled={!editable} onClick={() => run(api('POST', '/api/presets/scan'))}>scan the DX</button>
                </>
              )}
            </div>
          )}
          <div className="patches">
            <h3 className="bank-head">MY PATCHES <span className="count">{patches.length}</span></h3>
            {patches.filter((p) => match(p.name) || match(p.voiceName)).map((p) => (
              <button
                key={p.name} type="button" className="patch" disabled={!editable}
                onClick={() => request({ what: `patch "${p.name}"`, load: () => api('POST', `/api/patches/${encodeURIComponent(p.name)}/load`) })}
              >
                <span className="cell-name">{p.name}</span>
                <span className="patch-meta">{new Date(p.savedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }).toLowerCase()} · {p.voiceName}</span>
              </button>
            ))}
            {naming === null ? (
              <button type="button" className="save-current" disabled={!editable} onClick={() => setNaming(status?.voiceName ?? '')}>+ save current</button>
            ) : (
              <form className="save-form" onSubmit={(e) => { e.preventDefault(); save(naming.trim()); }}>
                <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} aria-label="Patch name" maxLength={64} />
                <button type="submit" className="mini-pill on" disabled={!naming.trim()}>save</button>
              </form>
            )}
            <p className="patch-note">Patches live on this computer. To keep a sound on the DX itself, press STORE on the hardware.</p>
          </div>
        </div>
      </section>
    </>
  );
}
