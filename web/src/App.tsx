// App shell (one 1440×900 canvas, uniformly scaled to fit the window) and global shortcuts: L library, 1–4 focus a lane, ⌘Z / ⇧⌘Z undo/redo
// (the prompt bar adds / and Esc itself).
import { useEffect, useState } from 'react';
import { Audition } from './Audition.tsx';
import { cls, useViewportFit } from './controls.tsx';
import { GlobalStrip } from './GlobalStrip.tsx';
import { Header } from './Header.tsx';
import { LibraryDrawer, LibraryRail } from './Library.tsx';
import { OperatorLanes } from './OperatorLanes.tsx';
import { PromptBar } from './PromptBar.tsx';
import { api, connect, getState, run, selectEditable, useStore } from './store.ts';

export function App() {
  const [library, setLibrary] = useState<'browse' | 'save' | null>(null);
  const editable = useStore(selectEditable);
  const hasVoice = useStore((s) => !!s.values);
  const link = useStore((s) => s.link);
  const fit = useViewportFit();

  useEffect(connect, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      const status = getState().status;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const redo = e.shiftKey;
        if (selectEditable(getState()) && (redo ? status?.canRedo : status?.canUndo)) run(api('POST', redo ? '/api/redo' : '/api/undo'));
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      } else if (e.key === 'l' || e.key === 'L') {
        setLibrary((open) => (open ? null : 'browse'));
      } else if (/^[1-4]$/.test(e.key)) {
        document.querySelector<HTMLElement>(`[data-lane="${e.key}"] [role=slider]`)?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app" style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` }}>
      <Header onSave={() => setLibrary('save')} />
      <LibraryRail open={library !== null} onOpen={() => setLibrary('browse')} />
      <main className={cls('main', !editable && 'disabled')} inert={!editable}>
        {hasVoice ? (
          <>
            <GlobalStrip />
            <OperatorLanes />
            <PromptBar libraryOpen={library !== null} />
            <Audition />
          </>
        ) : (
          <div className="empty">
            {link === 'closed'
              ? 'The editor server is not running. Start it with npm start in the project folder.'
              : 'Waiting for the reface DX. Connect it over USB; the editor finds it within 2 s.'}
          </div>
        )}
      </main>
      {library && <LibraryDrawer mode={library} onClose={() => setLibrary(null)} />}
    </div>
  );
}
