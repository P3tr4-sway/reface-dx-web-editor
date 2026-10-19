// The editor: single owner of the device and the current voice. HTTP and WebSocket clients both go
// through these methods, so the CLI/AI and the web panel always see one consistent state.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ccToValues, voicesEqual, toHex } from '../shared/codec.ts';
import {
  PARAMS, ParamError, coerceValues, deriveVoice, getParam, getValues, withValues, type VoiceData,
} from '../shared/params.ts';
import type {
  AiJob, ApplyResponse, AuditionRequest, AuditionResponse, BusyState, ChangeSource, LoadResponse, ParamChange, PatchInfo,
  PresetScan, ServerMessage, Status, SystemInfo, ThruStatus, VoiceResponse,
} from '../shared/protocol.ts';
import { AI_MODEL, AiFailure, designVoice, logAiJob, toAiError, type ClaudeClient } from './ai.ts';
import { planAudition } from './audition.ts';
import type { DxDevice } from './device.ts';
import type { InputPort } from './midi.ts';
import { VoiceState } from './state.ts';
import * as storage from './storage.ts';
import { Thru } from './thru.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// spec §6.1: panel edits are not announced, so the device is polled. 1.5 s idle/poll keeps a dump (~20 ms
// measured) far from any write burst while still showing panel edits within ~3 s.
const POLL_MS = 1500;
const IDLE_BEFORE_POLL_MS = 1500;
const STORE_NOTE = 'loaded into edit buffer — press STORE on the DX to keep';
const PROMPT_MAX = 500;
const AI_AUDITION_DELAY_MS = 150; // design/README.md "Auto phrase": starts 150 ms after the write completes

export const slotLabel = (slot: number) => `${(slot >> 3) + 1}-${(slot & 7) + 1}`;

/** "2-3" (bank-voice) or "0".."31" (program number). */
export function parseSlot(text: string): number {
  const bv = /^([1-4])-([1-8])$/.exec(text);
  const slot = bv ? (Number(bv[1]) - 1) * 8 + Number(bv[2]) - 1 : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(slot >= 0 && slot <= 31)) throw new ApiError(400, `bad slot "${text}": use bank-voice 1-1..4-8 or 0..31`);
  return slot;
}

function parseSystem(d: number[]): SystemInfo {
  return {
    txChannel: d[0] === 0x7f ? null : d[0] + 1,
    rxChannel: d[1] === 0x10 ? 'ALL' : d[1] + 1,
    localControl: d[6] === 1,
    masterTranspose: d[7] - 64,
    autoPowerOff: d[0x0c] === 1,
    midiControl: d[0x0e] === 1,
  };
}

const voiceName = (v: VoiceData) => getValues(v).name as string;
function uniqueIndex<T>(items: T[], match: (item: T) => boolean): number | null {
  const hits = items.flatMap((item, i) => (match(item) ? [i] : []));
  return hits.length === 1 ? hits[0] : null;
}

export class Editor extends EventEmitter<{ message: [ServerMessage] }> {
  readonly state = new VoiceState();
  presets: PresetScan | null = null;
  /** Current or last AI job (GET /api/ai, part of the WS snapshot). */
  aiJob: AiJob | null = null;
  private aiAbort: AbortController | null = null;
  private system: SystemInfo | null = null;
  private busy: BusyState | null = null;
  private loading = false;
  private lastWriteAt = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly sounding = new Set<number>();
  private readonly thru: Thru;
  private readonly device: DxDevice;
  private readonly dataDir: string;
  private readonly claude: ClaudeClient | null;

  /** thruInput = the MIDI thru source port; claude = null when the server has no ANTHROPIC_API_KEY: AI requests then answer 503. */
  constructor(device: DxDevice, thruInput: InputPort, dataDir: string, claude: ClaudeClient | null = null) {
    super();
    this.device = device;
    this.dataDir = dataDir;
    this.claude = claude;
    this.thru = new Thru(thruInput, device.transport, () => this.system);
    this.thru.on('change', () => this.emit('message', { type: 'thru', thru: this.thru.status() }));
    this.thru.on('note', (on, note, velocity) => this.emit('message', { type: 'thru-note', on, note, velocity }));
    device.on('note', (on, note, velocity) => this.emit('message', { type: 'note', on, note, velocity }));
    device.on('cc', (controller, value) => this.onDeviceCc(controller, value));
    device.on('pc', (program) => void this.onDevicePc(program));
  }

  start(): void {
    const latest = storage.loadLatestScan(this.dataDir);
    if (latest) {
      this.presets = latest.scan;
      latest.voices.forEach((v, slot) => this.state.stored.set(slot, v));
    }
    const t = this.device.transport;
    t.on('connected', () => { this.emitDevice(); void this.sync(); });
    t.on('disconnected', () => {
      this.system = null;
      this.state.currentSlot = null; // the DX may come back power-cycled on another slot
      this.emitDevice();
    });
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    t.start();
    this.thru.restore(storage.readSettings(this.dataDir).thruPort);
    this.thru.start();
  }

  shutdown(): void {
    clearInterval(this.pollTimer);
    this.thru.stop(); // its note-offs + sustain off: all-notes-off alone leaves pedal-held notes sounding
    this.device.allNotesOffNow([...this.sounding]);
    this.device.transport.stop();
  }

  status(): Status {
    const { state } = this;
    return {
      device: { connected: this.device.connected, port: this.device.transport.portName, system: this.system },
      voiceName: state.voice ? voiceName(state.voice) : null,
      currentSlot: state.currentSlot,
      currentSlotLabel: state.currentSlot === null ? null : slotLabel(state.currentSlot),
      dirty: state.dirty,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      busy: this.busy,
      presetsScannedAt: this.presets?.scannedAt ?? null,
      ai: { configured: this.claude !== null, model: AI_MODEL },
      thru: this.thru.status(),
    };
  }

  voice(raw = false): VoiceResponse {
    const v = this.state.voice;
    if (!v) throw new ApiError(503, 'voice not read from the DX yet (is it connected? see /api/status)');
    const values = getValues(v);
    return {
      values, derived: deriveVoice(values), currentSlot: this.state.currentSlot, dirty: this.state.dirty,
      ...(raw ? { raw: { common: toHex(v.common), ops: v.ops.map(toHex) } } : {}),
    };
  }

  snapshot(): ServerMessage {
    return { type: 'state', status: this.status(), voice: this.state.voice ? this.voice() : null, presets: this.presets, ai: this.aiJob };
  }

  /** Partial edit. clamp=true for slider input (WS); the HTTP API rejects out-of-range values instead. */
  set(input: Record<string, unknown>, source: 'ui' | 'api', clamp = false): ApplyResponse {
    const voice = this.writableVoice();
    const values = coerceValues(input, clamp);
    const changes = this.state.commit(withValues(voice, values), source);
    // Send every requested value, not only the diff: the device may hold an unpolled panel edit.
    for (const [id, value] of Object.entries(values)) this.device.setParam(getParam(id), value);
    this.lastWriteAt = Date.now();
    this.emitChanges(source, changes);
    return { applied: Object.entries(values).map(([id, value]) => ({ id, value })), dirty: this.state.dirty };
  }

  /** Whole voice from values; every param id is required. */
  async put(input: Record<string, unknown>): Promise<ApplyResponse> {
    const missing = PARAMS.filter((p) => !(p.id in input)).map((p) => p.id);
    if (missing.length) throw new ParamError(`PUT needs every param; missing ${missing.length}: ${missing.slice(0, 8).join(', ')}`);
    const applied = await this.writeWhole(withValues(this.writableVoice(), coerceValues(input)), 'api');
    return { applied, dirty: this.state.dirty };
  }

  async undo(redo = false): Promise<ApplyResponse> {
    this.writableVoice();
    const target = redo ? this.state.redo() : this.state.undo();
    if (!target) throw new ApiError(409, redo ? 'nothing to redo' : 'nothing to undo');
    return { applied: await this.writeWhole(target, 'undo'), dirty: this.state.dirty };
  }

  async refresh(): Promise<VoiceResponse> {
    this.requireConnected();
    const gen = this.state.writeGen;
    const changes = this.state.acceptDump(await this.device.readVoice(), gen);
    if (changes?.length) this.emitChanges('device', changes);
    return this.voice();
  }

  async loadPreset(slotText: string): Promise<LoadResponse> {
    const slot = parseSlot(slotText);
    this.requireAiIdle();
    this.writableVoice();
    const wasDirty = this.state.dirty;
    this.loading = true;
    let v: VoiceData;
    try {
      v = await this.device.selectAndRead(slot);
    } finally {
      this.loading = false;
    }
    this.state.currentSlot = slot;
    this.state.stored.set(slot, v);
    this.emitChanges('preset', this.state.commit(v, 'preset'));
    const warning = wasDirty === true ? 'the previous voice had unsaved edits; they were discarded on the DX (undo writes them back into the edit buffer)'
      : wasDirty === null ? 'previous voice state unknown; any unsaved edits were discarded on the DX (undo writes them back)' : undefined;
    return { slot, label: slotLabel(slot), name: voiceName(v), ...(warning ? { warning } : {}),
      note: `edit buffer now holds stored voice ${slotLabel(slot)}` };
  }

  /** Read all 32 stored voices (PC + dump each) while preserving the edit buffer; writes a backup. */
  async scanPresets(): Promise<PresetScan> {
    this.requireAiIdle();
    this.writableVoice();
    const setBusy = (done: number, message: string) => {
      this.busy = { task: 'scan', done, total: 32, message };
      this.emit('message', { type: 'busy', busy: this.busy });
    };
    setBusy(0, 'saving edit buffer');
    let editBuffer: VoiceData | null = null;
    const voices: VoiceData[] = [];
    try {
      const saved = (editBuffer = await this.device.readVoice());
      for (let slot = 0; slot < 32; slot++) {
        voices.push(await this.device.selectAndRead(slot));
        setBusy(slot + 1, `${slotLabel(slot)} ${voiceName(voices[slot])}`);
      }
      voices.forEach((v, slot) => this.state.stored.set(slot, v));
      const originalSlot = this.state.currentSlot ?? uniqueIndex(voices, (v) => voicesEqual(v, saved))
        ?? uniqueIndex(voices, (v) => voiceName(v) === voiceName(saved));
      if (originalSlot !== null) await this.device.selectAndRead(originalSlot);
      const rewrite = originalSlot === null || !voicesEqual(voices[originalSlot], saved);
      if (rewrite) await this.device.writeVoice(saved);
      const final = await this.device.readVoice();
      this.state.currentSlot = originalSlot;
      this.emitChanges('device', this.state.commit(final, 'device'));
      const scan = {
        scannedAt: new Date().toISOString(),
        presets: voices.map((v, slot) => ({ slot, label: slotLabel(slot), name: voiceName(v) })),
        originalSlot,
        editBufferPreserved: voicesEqual(final, saved),
        editBufferRewritten: rewrite,
      };
      this.presets = { ...scan, backupDir: storage.saveBackup(this.dataDir, scan, voices) };
      this.emit('message', { type: 'presets', scan: this.presets });
      return this.presets;
    } catch (err) {
      if (!editBuffer || voices.length === 32) throw err;
      // Failed while the DX sat on another slot: put the user's voice back into the edit buffer.
      this.state.currentSlot = null;
      const restored = await this.device.writeVoice(editBuffer).then(() => 'edit buffer restored', (e) => `edit buffer NOT restored (${e.message})`);
      throw new ApiError(502, `scan failed at ${slotLabel(voices.length)} (${(err as Error).message}); ${restored}`);
    } finally {
      this.busy = null;
      this.emit('message', { type: 'busy', busy: null });
    }
  }

  audition(req: AuditionRequest, ai = false): AuditionResponse {
    this.requireConnected();
    const plan = planAudition(req);
    plan.steps.forEach((notes, i) => {
      setTimeout(() => this.sendNotes(true, notes, plan.velocity), i * plan.stepMs);
      // small gap re-triggers repeated notes
      setTimeout(() => this.sendNotes(false, notes, plan.velocity), i * plan.stepMs + Math.round(plan.stepMs * 0.9));
    });
    this.emit('message', { type: 'audition', what: (req.what ?? 'chord').trim(), steps: plan.steps, stepMs: plan.stepMs, velocity: plan.velocity, ai });
    return { played: plan.names, durationMs: plan.steps.length * plan.stepMs };
  }

  /** Start an AI sound-design job; progress and the result arrive as WS `ai` messages (and GET /api/ai). */
  generate(input: unknown): { jobId: string } {
    const prompt = typeof input === 'string' ? input.trim() : '';
    if (!prompt || prompt.length > PROMPT_MAX) throw new ApiError(400, `prompt must be 1..${PROMPT_MAX} characters`);
    if (!this.claude) throw new ApiError(503, 'AI not configured: add ANTHROPIC_API_KEY to .env and restart the server');
    this.requireAiIdle();
    this.writableVoice();
    const abort = (this.aiAbort = new AbortController());
    this.aiJob = { jobId: randomUUID().slice(0, 8), state: 'designing', prompt, startedAt: new Date().toISOString() };
    this.emit('message', { type: 'ai', ...this.aiJob });
    void this.runAi(this.claude, abort.signal);
    return { jobId: this.aiJob.jobId };
  }

  cancelGenerate(): { jobId: string } {
    if (!this.aiAbort || !this.aiJob) throw new ApiError(409, 'no AI job is running');
    if (this.aiJob.state === 'writing') throw new ApiError(409, 'already writing to the DX (atomic, well under 1 s); undo it afterwards');
    this.aiAbort.abort();
    return { jobId: this.aiJob.jobId };
  }

  private async runAi(claude: ClaudeClient, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const update = (patch: Partial<AiJob>) => {
      this.aiJob = { ...this.aiJob!, ...patch };
      this.emit('message', { type: 'ai', ...this.aiJob });
    };
    try {
      const { values, derived } = this.voice();
      const { design, usage, model } = await designVoice(claude, this.aiJob!.prompt, { values, derived }, signal);
      if (signal.aborted) throw signal.reason; // cancelled after the reply arrived: still write nothing
      const voice = this.writableVoice();
      const next = withValues(voice, design.values);
      const [before, after] = [getValues(voice), getValues(next)];
      const changedCount = PARAMS.filter((p) => before[p.id] !== after[p.id]).length;
      update({ state: 'writing', usage, result: { name: design.name, summary: design.summary, changedCount, audition: design.audition } });
      await this.writeWhole(next, 'api'); // one bulk write = one undo step, rendered as the AI chip (source api)
      update({ state: 'done' });
      logAiJob(this.aiJob!, Date.now() - startedAt, `${model} · ${design.clamped} clamped`);
      setTimeout(() => {
        try {
          this.audition({ what: design.audition }, true);
        } catch (err) { // the DX vanished in the last 150 ms
          console.warn(`[ai] audition skipped: ${(err as Error).message}`);
        }
      }, AI_AUDITION_DELAY_MS);
    } catch (err) {
      if (signal.aborted) update({ state: 'cancelled' });
      else update({ state: 'error', error: toAiError(err), ...(err instanceof AiFailure && err.usage ? { usage: err.usage } : {}) });
      logAiJob(this.aiJob!, Date.now() - startedAt);
    } finally {
      this.aiAbort = null;
    }
  }

  /** One held key from the web keyboard; the caller sends the matching note-off. */
  note(on: boolean, note: number, velocity = 100): void {
    if (!on && !this.device.connected) return; // nothing can still be sounding on a DX that is gone
    this.requireConnected();
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new ParamError('note must be an integer 0..127');
    if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) throw new ParamError('velocity must be an integer 1..127');
    this.sendNotes(on, [note], velocity);
  }

  /** Tracks sounding notes so shutdown can silence them. */
  private sendNotes(on: boolean, notes: number[], velocity: number): void {
    for (const n of notes) on ? this.sounding.add(n) : this.sounding.delete(n);
    this.device.sendNotes(on, notes, velocity).catch((err) => console.warn(`[notes] ${err.message}`));
  }

  /** Select the MIDI thru input (null = off). The choice is saved in data/settings.json and restored at startup. */
  setThru(port: unknown): ThruStatus {
    if (port !== null && typeof port !== 'string') throw new ApiError(400, 'body must be {"port": "<input name>"}, or {"port": null} for off');
    this.thru.select(port);
    storage.saveSettings(this.dataDir, { thruPort: port });
    return this.thru.status();
  }

  patches(): PatchInfo[] { return storage.listPatches(this.dataDir); }

  savePatch(name: string): { name: string; file: string } {
    return { name, file: storage.savePatch(this.dataDir, name, getValues(this.requireVoice())) };
  }

  /** A patch may be partial: its values are applied on top of the current voice, then bulk-written. */
  async loadPatch(name: string): Promise<ApplyResponse & { name: string; note: string }> {
    const patch = storage.readPatch(this.dataDir, name);
    if (!patch) throw new ApiError(404, `no patch "${name}" (see GET /api/patches or "dx patches")`);
    const applied = await this.writeWhole(withValues(this.writableVoice(), coerceValues(patch.values)), 'api');
    return { name: patch.name, note: STORE_NOTE, applied, dirty: this.state.dirty };
  }

  private async writeWhole(next: VoiceData, source: ChangeSource): Promise<ParamChange[]> {
    const changes = this.state.commit(next, source);
    this.lastWriteAt = Date.now();
    this.emitChanges(source, changes);
    await this.device.writeVoice(next);
    return changes;
  }

  private async sync(): Promise<void> {
    try {
      this.system = parseSystem(await this.device.readSystem());
      const gen = this.state.writeGen;
      const v = await this.device.readVoice();
      this.state.currentSlot ??= uniqueIndex([...Array(32).keys()], (s) => {
        const stored = this.state.stored.get(s);
        return !!stored && voicesEqual(stored, v);
      });
      const changes = this.state.acceptDump(v, gen);
      if (changes?.length) this.emitChanges('device', changes);
      this.emit('message', this.snapshot());
    } catch (err) {
      console.warn(`[sync] ${(err as Error).message}`);
    }
  }

  private async poll(): Promise<void> {
    if (!this.device.connected || this.busy || this.loading || !this.device.queue.idle ||
        Date.now() - this.lastWriteAt < IDLE_BEFORE_POLL_MS) return;
    if (!this.state.voice || !this.system) return this.sync();
    const gen = this.state.writeGen;
    try {
      const changes = this.state.acceptDump(await this.device.readVoice(), gen);
      if (changes?.length) this.emitChanges('device', changes);
    } catch (err) {
      console.warn(`[poll] ${(err as Error).message}`);
    }
  }

  private onDeviceCc(controller: number, value: number): void {
    const mapped = ccToValues(controller, value);
    if (!mapped || !this.state.voice || this.busy) return;
    this.emitChanges('device', this.state.commit(withValues(this.state.voice, coerceValues(mapped, true)), 'device'));
  }

  private async onDevicePc(program: number): Promise<void> {
    if (this.busy || this.loading || program > 31) return;
    console.log(`[midi] program change ${slotLabel(program)} received from the DX`);
    this.state.currentSlot = program;
    const gen = this.state.writeGen;
    try {
      const v = await this.device.readVoice();
      const changes = this.state.acceptDump(v, gen);
      if (changes === null) return; // edited meanwhile: the dump is no longer the stored voice
      this.state.stored.set(program, v);
      this.emitChanges('device', changes);
    } catch (err) {
      console.warn(`[pc] ${(err as Error).message}`);
    }
  }

  private requireConnected(): void {
    if (!this.device.connected) throw new ApiError(503, `reface DX not connected (MIDI port "${this.device.transport.portName}")`);
  }

  private requireVoice(): VoiceData {
    this.requireConnected();
    if (!this.state.voice) throw new ApiError(503, 'voice not read from the DX yet; retry in a moment');
    return this.state.voice;
  }

  /** Scan / preset load would replace the voice under a running AI job, so they wait for it. */
  private requireAiIdle(): void {
    if (this.aiAbort) throw new ApiError(409, 'busy: AI is designing a voice; retry when done or cancel it');
  }

  private writableVoice(): VoiceData {
    const voice = this.requireVoice();
    if (this.busy || this.loading) throw new ApiError(409, `busy: ${this.busy?.message ?? 'loading preset'}; retry when done`);
    return voice;
  }

  private emitChanges(source: ChangeSource, changes: ParamChange[]): void {
    if (changes.length) this.emit('message', { type: 'voice-changed', source, changes, status: this.status() });
  }

  private emitDevice(): void {
    this.emit('message', { type: 'device', device: this.status().device });
  }
}
