// Client state. The server owns the voice: this module mirrors it from the WebSocket, applies local edits
// optimistically (sent as one coalesced `set` per animation frame), reconciles with `voice-changed`, and records
// which values were moved by Claude (`api` → AI) or the hardware (`device` → DX) for the remote-change bloom.
import { useSyncExternalStore } from 'react';
import type { ParamValue, VoiceValues } from '../../shared/params.ts';
import type { AiJob, ClientMessage, PresetScan, ServerMessage, Status } from '../../shared/protocol.ts';

type RemoteSource = 'api' | 'device';
export interface RemoteMark { source: RemoteSource; from: ParamValue; to: ParamValue; at: number }
/** `prompt` = an AI prompt wrote this batch: the log reads "PROMPT → n PARAMS". */
interface LogEntry { source: RemoteSource; id: string; from: ParamValue; to: ParamValue; more: number; at: number; prompt?: number }

export interface AppState {
  link: 'connecting' | 'open' | 'closed';
  status: Status | null;
  values: VoiceValues | null;
  /** The voice as last loaded (snapshot or preset): what a double-click on a fader returns to. */
  baseline: VoiceValues | null;
  presets: PresetScan | null;
  marks: Readonly<Record<string, RemoteMark>>;
  log: LogEntry | null;
  /** Keys held on the DX right now: note → velocity. */
  dxNotes: Readonly<Record<number, number>>;
  /**
   * Keys held on the MIDI thru input (e.g. a Keystation) and delivered to the DX: note → velocity. Kept apart from
   * dxNotes so a key-up on one never darkens a key still held on the other; the keyboard lights the union.
   */
  thruNotes: Readonly<Record<number, number>>;
  /** Audition caption: last chord played on the DX or the thru input, or the AI's auto phrase. */
  lastPlay: { source: 'dx' | 'thru' | 'ai'; what?: string; notes: number[]; velocity: number } | null;
  /** Note-ons forwarded from the MIDI thru input so far: each one re-blinks the MIDI-in dot. */
  thruBlink: number;
  /** Keys sounding from an audition phrase (lit white like mouse keys) and the phrase pill that is playing. */
  appNotes: Readonly<Record<number, true>>;
  playing: string | null;
  /** Current or last AI job (server-owned), the job id the user has moved past (focus/edit), and "Restored <name>". */
  ai: AiJob | null;
  aiSeen: string | null;
  aiRestored: string | null;
  /** WebSocket round trip of our last `set`, measured to its `voice-changed` echo. null until one was measured. */
  latencyMs: number | null;
  notice: string | null;
}

// README "Remote-change indicator": same-param changes within 300 ms merge into one bloom; the chip lives 4 s.
const MERGE_MS = 300;
const CHIP_MS = 4000;
// An echo older than this is no longer matched to our own send (values the server did not change are never echoed).
const ECHO_MS = 2000;
const NOTICE_MS = 5000;
const KEY_VELOCITY = 90;
/** README "Writing to DX": the phase is shown for at least 400 ms (the bulk write itself takes ~140 ms). */
export const WRITE_MIN_MS = 400;
const RESTORED_MS = 2000;

let state: AppState = {
  link: 'connecting', status: null, values: null, baseline: null, presets: null, marks: {}, log: null,
  dxNotes: {}, thruNotes: {}, lastPlay: null, thruBlink: 0, appNotes: {}, playing: null, ai: null, aiSeen: null, aiRestored: null, latencyMs: null, notice: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getState = () => state;
export function useStore<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => select(state));
}

/** Controls accept input only with a live server link, a connected DX, a voice, and no scan/load in progress. */
export const selectEditable = (s: AppState) =>
  s.link === 'open' && !!s.status?.device.connected && !!s.values && !s.status.busy;

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(message: string): void {
  clearTimeout(noticeTimer);
  update({ notice: message });
  noticeTimer = setTimeout(() => update({ notice: null }), NOTICE_MS);
}

// ---- WebSocket ----
let ws: WebSocket | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function connect(): void {
  clearTimeout(retryTimer);
  const old = ws;
  ws = null;
  old?.close();
  // The snapshot carries no held keys and thru note-offs sent while the socket was down are lost: a new socket starts dark.
  update({ link: 'connecting', dxNotes: {}, thruNotes: {} });
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => { attempt = 0; update({ link: 'open' }); };
  sock.onmessage = (e) => onMessage(JSON.parse(e.data as string) as ServerMessage);
  sock.onclose = () => {
    if (ws !== sock) return; // replaced by a manual retry
    ws = null;
    update({ link: 'closed' });
    retryTimer = setTimeout(connect, Math.min(5000, 250 * 2 ** attempt++)); // backoff 250 ms → 5 s
  };
}

function send(msg: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export const sendNote = (on: boolean, note: number) => send({ type: 'note', on, note, velocity: KEY_VELOCITY });

function onMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'state':
      sent.clear();
      pending = {};
      return update({ status: msg.status, values: msg.voice?.values ?? null, baseline: msg.voice?.values ?? null, presets: msg.presets, ai: msg.ai });
    case 'voice-changed': return applyChanges(msg);
    case 'presets': return update({ presets: msg.scan });
    case 'device': return update({ status: state.status && { ...state.status, device: msg.device } });
    case 'busy': return update({ status: state.status && { ...state.status, busy: msg.busy } });
    case 'thru': return update({ status: state.status && { ...state.status, thru: msg.thru } });
    case 'thru-note': {
      const thruNotes = heldAfter(state.thruNotes, msg);
      if (!msg.on) return update({ thruNotes });
      return update({ thruNotes, thruBlink: state.thruBlink + 1, lastPlay: { source: 'thru', notes: sortedNotes(thruNotes), velocity: msg.velocity } });
    }
    case 'note': {
      const dxNotes = heldAfter(state.dxNotes, msg);
      return update({ dxNotes, lastPlay: msg.on ? { source: 'dx', notes: sortedNotes(dxNotes), velocity: msg.velocity } : state.lastPlay });
    }
    case 'audition': return onAudition(msg);
    case 'ai': return onAi(msg);
    case 'error': return notify(msg.message);
  }
}

/** Held keys (note → velocity) after one key event from the DX or the thru input. An off for a key not held changes nothing. */
function heldAfter(held: Readonly<Record<number, number>>, { on, note, velocity }: { on: boolean; note: number; velocity: number }) {
  const next = { ...held };
  if (on) next[note] = velocity;
  else delete next[note];
  return next;
}
const sortedNotes = (held: Readonly<Record<number, number>>) => Object.keys(held).map(Number).sort((a, b) => a - b);

let auditionTimers: ReturnType<typeof setTimeout>[] = [];
/** Mirrors the server's schedule (step i on at i*stepMs, off 90 % later) so the keys light while they sound. */
function onAudition(msg: Extract<ServerMessage, { type: 'audition' }>): void {
  auditionTimers.forEach(clearTimeout);
  const at = (ms: number, patch: Partial<AppState>) => setTimeout(() => update(patch), ms);
  auditionTimers = msg.steps.flatMap((notes, i) => [
    at(i * msg.stepMs, { appNotes: Object.fromEntries(notes.map((n) => [n, true])) }),
    at(i * msg.stepMs + Math.round(msg.stepMs * 0.9), { appNotes: {} }),
  ]);
  auditionTimers.push(at(msg.steps.length * msg.stepMs, { playing: null }));
  update({ playing: msg.what, lastPlay: msg.ai ? { source: 'ai', what: msg.what, notes: msg.steps[0], velocity: msg.velocity } : state.lastPlay });
}

let writingAt = 0;
function onAi({ type: _, ...job }: Extract<ServerMessage, { type: 'ai' }>): void {
  if (job.state === 'writing') writingAt = performance.now();
  const apply = () => {
    if (job.state !== 'done') return update({ ai: job });
    // The whole batch reads as one log entry; its first change stays the jump target.
    update({ ai: job, log: state.log?.source === 'api' ? { ...state.log, prompt: job.result!.changedCount } : state.log });
  };
  const wait = job.state === 'done' ? WRITE_MIN_MS - (performance.now() - writingAt) : 0;
  if (wait <= 0) return apply();
  setTimeout(() => state.ai?.jobId === job.jobId && apply(), wait);
}

/** Done / error stay until the user moves on: focusing the prompt field or editing any control. */
export function dismissAi(): void {
  if (state.ai && state.aiSeen !== state.ai.jobId) update({ aiSeen: state.ai.jobId });
}

// ---- Optimistic edits ----
let pending: VoiceValues = {};
let frame = 0;
/** Values we sent per param, oldest first, so their echoes can be recognised (and timed) instead of applied. */
const sent = new Map<string, { value: ParamValue; t: number }[]>();

export function edit(values: VoiceValues): void {
  if (!state.values) return;
  dismissAi();
  update({ values: { ...state.values, ...values } });
  Object.assign(pending, values);
  frame ||= requestAnimationFrame(flush);
}

function flush(): void {
  frame = 0;
  const values = pending;
  pending = {};
  if (ws?.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  for (const [id, value] of Object.entries(values)) {
    const log = (sent.get(id) ?? []).filter((e) => now - e.t < ECHO_MS);
    log.push({ value, t: now });
    sent.set(id, log);
  }
  send({ type: 'set', values });
}

/** Round-trip ms if this change is the echo of one of our own sends, else null. */
function ownEcho(id: string, value: ParamValue, now: number): number | null {
  const log = sent.get(id);
  const i = log?.findIndex((e) => e.value === value) ?? -1;
  if (!log || i < 0) return null;
  const rtt = now - log[i].t;
  log.splice(0, i + 1);
  if (!log.length) sent.delete(id);
  return rtt;
}

function applyChanges(msg: Extract<ServerMessage, { type: 'voice-changed' }>): void {
  if (!state.values) return update({ status: msg.status });
  const now = performance.now();
  const values = { ...state.values };
  const marks = { ...state.marks };
  const remote = msg.source === 'api' || msg.source === 'device' ? msg.source : null;
  let latencyMs = state.latencyMs;
  let log = state.log;
  for (const { id, value } of msg.changes) {
    if (msg.source === 'ui') {
      const rtt = ownEcho(id, value, now);
      if (rtt !== null) { latencyMs = Math.round(rtt); continue; }
      if (id in pending || sent.has(id)) continue; // a newer local edit of this param is still in flight
    }
    if (remote && values[id] !== value) {
      const prev = marks[id];
      const merge = prev && prev.source === remote && now - prev.at < MERGE_MS;
      const mark: RemoteMark = { source: remote, from: merge ? prev.from : values[id], to: value, at: now };
      marks[id] = mark;
      setTimeout(() => expire(id, mark), CHIP_MS);
      if (!log || log.at !== now) log = { source: remote, id, from: mark.from, to: value, more: 0, at: now };
      else log = { ...log, more: log.more + 1 };
    }
    values[id] = value;
  }
  update({ values, marks, log, latencyMs, status: msg.status, baseline: msg.source === 'preset' ? values : state.baseline });
  // Done (and its undo button) describes the AI write only while nothing has changed since (the write's own change
  // arrives during `writing`). Undo of it (bar button or ⌘Z) says what came back for 2 s; any other change just ends Done.
  if (state.ai?.state === 'done' && state.aiSeen !== state.ai.jobId) {
    const restored = msg.source === 'undo' ? msg.status.voiceName : null;
    update({ aiSeen: state.ai.jobId, aiRestored: restored });
    if (restored) setTimeout(() => update({ aiRestored: null }), RESTORED_MS);
  }
}

function expire(id: string, mark: RemoteMark): void {
  if (state.marks[id] !== mark) return; // superseded by a newer change
  const { [id]: _, ...marks } = state.marks;
  update({ marks });
}

// ---- HTTP API (everything that is not a high-rate edit) ----
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Fire-and-forget API call; failures surface as the header notice. */
export function run(promise: Promise<unknown>): void {
  promise.catch((err: Error) => notify(err.message));
}
