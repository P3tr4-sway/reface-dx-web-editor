// Current voice state: values (as raw bytes), current slot, dirty flag, undo/redo, and the write generation
// that keeps a dump requested before a write from overwriting newer state.
import { voicesEqual } from '../shared/codec.ts';
import { getValues, type VoiceData } from '../shared/params.ts';
import type { ChangeSource, ParamChange } from '../shared/protocol.ts';

const HISTORY_LIMIT = 200;

export class VoiceState {
  voice: VoiceData | null = null;
  currentSlot: number | null = null;
  /** Cached stored voices by slot (from preset scans/loads); used for `dirty`. */
  readonly stored = new Map<number, VoiceData>();
  /** Bumped by every state change except a dump acceptance; a dump is valid only if it was requested at the same generation. */
  writeGen = 0;
  private undoStack: VoiceData[] = [];
  private redoStack: VoiceData[] = [];
  private batch: { source: ChangeSource; at: number } | null = null;

  private readonly now: () => number;
  private readonly batchMs: number;

  constructor(now: () => number = Date.now, batchMs = 500) {
    this.now = now;
    this.batchMs = batchMs;
  }

  /** Apply a new voice. Returns the param-level diff. Non-undo changes are recorded for undo (bursts batched). */
  commit(next: VoiceData, source: ChangeSource): ParamChange[] {
    this.writeGen++;
    return this.apply(next, source);
  }

  /** Apply a dump requested at generation `genAtRequest`; null if a newer local change happened meanwhile. */
  acceptDump(voice: VoiceData, genAtRequest: number): ParamChange[] | null {
    if (genAtRequest !== this.writeGen) return null;
    return this.apply(voice, 'device');
  }

  undo(): VoiceData | null { return this.step(this.undoStack, this.redoStack); }
  redo(): VoiceData | null { return this.step(this.redoStack, this.undoStack); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  get dirty(): boolean | null {
    const stored = this.currentSlot === null ? undefined : this.stored.get(this.currentSlot);
    return stored && this.voice ? !voicesEqual(stored, this.voice) : null;
  }

  private apply(next: VoiceData, source: ChangeSource): ParamChange[] {
    const prev = this.voice;
    this.voice = next;
    if (!prev) return [];
    const before = getValues(prev);
    const changes = Object.entries(getValues(next))
      .filter(([id, value]) => before[id] !== value)
      .map(([id, value]) => ({ id, value }));
    if (changes.length && source !== 'undo') this.record(prev, source);
    return changes;
  }

  private record(prev: VoiceData, source: ChangeSource): void {
    const now = this.now();
    const sameBurst = this.batch && this.batch.source === source && now - this.batch.at < this.batchMs;
    this.batch = { source, at: now };
    if (sameBurst) return;
    this.undoStack.push(prev);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private step(from: VoiceData[], to: VoiceData[]): VoiceData | null {
    const target = from.pop();
    if (!target || !this.voice) return null;
    to.push(this.voice);
    this.batch = null;
    return target;
  }
}
