// Audition: 37-key keyboard (keys held on the DX or the MIDI-in (thru) input in the prism, mouse- and phrase-played keys
// white), the MIDI-in selector and the phrase pills.
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { AuditionPreset } from '../../shared/protocol.ts';
import { cls } from './controls.tsx';
import { api, run, sendNote, useStore } from './store.ts';

// The reface DX's 37 keys at octave 0 (assumed C3..C6 in scientific pitch, C4 = MIDI 60 as in the server).
const LOW = 48;
const KEYS = Array.from({ length: 37 }, (_, i) => LOW + i);
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
/** Caption chip per source: IN = the MIDI-in (thru) input, as the selector is titled. */
const SOURCE_TAG = { dx: 'DX', thru: 'IN', ai: 'AI' } as const;

// Paper geometry (with the AI bar): white keys 22×56 on a 24 px pitch, black keys 14×33 starting 16 px into their white key.
const keyRect = (n: number) => {
  const whiteIndex = KEYS.filter((k) => k < n && WHITE_PCS.includes(k % 12)).length;
  return WHITE_PCS.includes(n % 12)
    ? { x: 1 + whiteIndex * 24, w: 22, h: 56, white: true }
    : { x: 1 + (whiteIndex - 1) * 24 + 16, w: 14, h: 33, white: false };
};

const SHAPES: [string, number[]][] = [
  ['maj7', [0, 4, 7, 11]], ['7', [0, 4, 7, 10]], ['m7', [0, 3, 7, 10]], ['', [0, 4, 7]], ['m', [0, 3, 7]],
  ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]],
];
function chordName(notes: number[]): string {
  const pcs = [...new Set(notes.map((n) => n % 12))];
  if (pcs.length < 3) return notes.map(noteName).join(' ');
  for (const root of pcs) {
    const set = pcs.map((p) => (p - root + 12) % 12).sort((a, b) => a - b).join();
    const hit = SHAPES.find(([, s]) => s.join() === set);
    if (hit) return NAMES[root] + hit[0];
  }
  return notes.map(noteName).join(' ');
}

function Keyboard() {
  const dx = useStore((s) => s.dxNotes);
  const thru = useStore((s) => s.thruNotes);
  const app = useStore((s) => s.appNotes);
  const [held, setHeld] = useState<number | null>(null);
  const heldRef = useRef<number | null>(null);
  const hold = (n: number | null) => {
    if (n === heldRef.current) return;
    if (heldRef.current !== null) sendNote(false, heldRef.current);
    if (n !== null) sendNote(true, n);
    heldRef.current = n;
    setHeld(n);
  };
  const noteAt = (e: PointerEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<SVGElement>('[data-note]');
    return el ? Number(el.dataset.note) : null;
  };
  useEffect(() => {
    const release = () => hold(null);
    addEventListener('blur', release);
    return () => { removeEventListener('blur', release); release(); };
  }, []); // the mount-time `hold` stays valid: it only touches a ref and a state setter
  // Black keys are drawn last so they sit on top of (and win hit-testing over) the white keys.
  const order = [...KEYS.filter((n) => keyRect(n).white), ...KEYS.filter((n) => !keyRect(n).white)];
  return (
    <svg
      className="keys" width="528" height="56" viewBox="0 0 528 56" role="group" aria-label="Keyboard: press and hold keys to play"
      onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); hold(noteAt(e)); }}
      onPointerMove={(e) => heldRef.current !== null && hold(noteAt(e) ?? heldRef.current)}
      onPointerUp={() => hold(null)} onLostPointerCapture={() => hold(null)}
    >
      <defs>
        <linearGradient id="prism" x1="0" y1="0" x2="0" y2="1">
          {[[0, 4], [0.35, 3], [0.7, 2], [1, 1]].map(([o, op]) => <stop key={op} offset={o} style={{ stopColor: `var(--op${op})` }} />)}
        </linearGradient>
      </defs>
      {order.map((n) => {
        const k = keyRect(n);
        return (
          <g key={n} data-note={n} className={cls('key', k.white ? 'white' : 'black')}>
            <rect x={k.x} y="0" width={k.w} height={k.h} rx="2" className="key-base" />
            <rect x={k.x} y="0" width={k.w} height={k.h} rx="2" className={cls('key-lit dx', (n in dx || n in thru) && 'on')} fill="url(#prism)" />
            <rect x={k.x} y="0" width={k.w} height={k.h} rx="2" className={cls('key-lit mouse', (held === n || n in app) && 'on')} />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * MIDI thru source. The native <select> is invisible and stretched over both lines, so the OS menu, keyboard use and the
 * menu's placement under the canvas scale all come from the browser (no pointer math); the two lines show the state.
 */
function MidiIn() {
  const thru = useStore((s) => s.status?.thru);
  const blink = useStore((s) => s.thruBlink);
  if (!thru) return null;
  const state = thru.port === null ? 'off' : thru.connected ? 'on' : 'missing';
  // An unplugged saved port is not in `inputs` but stays selected (it reopens when plugged in), so it keeps its option.
  const ports = thru.port !== null && !thru.inputs.includes(thru.port) ? [...thru.inputs, thru.port] : thru.inputs;
  const tip = state === 'off' ? 'MIDI in: off. Pick a controller to play the DX'
    : state === 'on' ? `MIDI in: ${thru.port} plays the DX (keys, sustain, pitch bend, mod wheel)`
    : `MIDI in: ${thru.port} is not connected; it plays the DX again when plugged in`;
  return (
    <div className={cls('midi-in', state)} title={tip}>
      <span className="title">MIDI IN<i key={blink} className={cls('thru-dot', blink > 0 && 'blink')} /></span>
      <span className="caption midi-port">{thru.port ?? 'off'}</span>
      <select aria-label="MIDI input that plays the DX" value={thru.port ?? ''} onChange={(e) => run(api('PUT', '/api/thru', { port: e.target.value || null }))}>
        <option value="">off</option>
        {ports.map((p) => <option key={p} value={p}>{p === thru.port && state === 'missing' ? `${p} (not connected)` : p}</option>)}
      </select>
    </div>
  );
}

const PHRASES: AuditionPreset[] = ['chord', 'arp', 'bass', 'lead', 'pad', 'keys'];

export function Audition() {
  const last = useStore((s) => s.lastPlay);
  const playing = useStore((s) => s.playing); // from the server's audition broadcast, whoever started the phrase
  const play = (what: AuditionPreset) => run(api('POST', '/api/audition', { what }));
  return (
    <div className="audition">
      <div className="aud-label">
        <h2 className="title">AUDITION</h2>
        {last ? (
          <span className="aud-last">
            <span className="chip dx">{SOURCE_TAG[last.source]}</span>
            {last.what && `${last.what} · `}{chordName(last.notes)} · vel {last.velocity}
          </span>
        ) : (
          <span className="aud-last">hold a key, or play the DX</span>
        )}
      </div>
      <Keyboard />
      <div className="phrases">
        <MidiIn />
        {PHRASES.map((p) => (
          // The server has no stop command, so a playing pill stays lit until its phrase ends.
          <button key={p} type="button" className={cls('phrase', playing === p && 'playing')} aria-pressed={playing === p} onClick={() => playing !== p && play(p)}>
            {playing === p && <i className="stop" />}{p}
          </button>
        ))}
      </div>
    </div>
  );
}
