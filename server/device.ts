// reface DX device operations on top of the transport: one serialized outbound queue, dump requests with
// footer wait / timeout / retry, and incoming note/CC/PC events.
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Address, type Bytes, type BulkBlock, ADDR_HEADER, ADDR_SYSTEM, buildDumpRequest, buildVoiceDump, isFooter,
  isHeader, paramChanges, parseBulk, parseVoiceDump, SYSTEM_SIZE, toHex,
} from '../shared/codec.ts';
import type { ParamDef, ParamValue, VoiceData } from '../shared/params.ts';
import type { MidiEvent, MidiTransport } from './midi.ts';

type QueueItem =
  | { key: string; message: Bytes }
  | { job: () => unknown; resolve: (v: any) => void; reject: (e: unknown) => void };

/**
 * Single serialized outbound queue. Param changes coalesce per key (latest value wins) but never across a
 * non-param job, so a later param can not jump ahead of a bulk write that would overwrite it.
 */
export class OutQueue {
  private items: QueueItem[] = [];
  private running = false;
  private waiters: (() => void)[] = [];

  private readonly send: (bytes: Bytes) => void;
  private readonly paramGapMs: number;

  constructor(send: (bytes: Bytes) => void, paramGapMs: number) {
    this.send = send;
    this.paramGapMs = paramGapMs;
  }

  setParam(key: string, message: Bytes): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!('key' in item)) break;
      if (item.key === key) { item.message = message; return; }
    }
    this.items.push({ key, message });
    void this.pump();
  }

  run<T>(job: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.items.push({ job, resolve, reject });
      void this.pump();
    });
  }

  get idle(): boolean { return !this.running && this.items.length === 0; }

  drained(): Promise<void> {
    return this.idle ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await Promise.resolve(); // let synchronously enqueued changes coalesce before the first send
    while (this.items.length) {
      const item = this.items.shift()!;
      if ('key' in item) {
        try {
          this.send(item.message);
        } catch (err) { // only failure: device unplugged mid-queue; the reconnect re-sync restores truth
          console.warn(`[queue] dropped param ${item.key}: ${(err as Error).message}`);
          continue;
        }
        if (this.paramGapMs > 0) await sleep(this.paramGapMs);
      } else {
        try { item.resolve(await item.job()); } catch (err) { item.reject(err); }
      }
    }
    this.running = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

export interface DeviceTiming {
  /** Gap after each parameter change (measured on the device, docs/architecture.md). */
  paramGapMs: number;
  /** Gap between the 7 messages of a bulk write (spec §6.5). */
  bulkGapMs: number;
  /** Max wait for a complete dump reply before one retry. */
  dumpTimeoutMs: number;
}

interface Collector {
  messages: Bytes[];
  isComplete: (block: BulkBlock) => boolean;
  finish: (err: Error | null, messages?: Bytes[]) => void;
}

type DeviceEvents = {
  note: [on: boolean, note: number, velocity: number];
  cc: [controller: number, value: number];
  pc: [program: number];
};

export class DxDevice extends EventEmitter<DeviceEvents> {
  readonly queue: OutQueue;
  private collector: Collector | null = null;

  readonly transport: MidiTransport;
  private readonly timing: DeviceTiming;

  constructor(transport: MidiTransport, timing: DeviceTiming) {
    super();
    this.transport = transport;
    this.timing = timing;
    this.queue = new OutQueue((bytes) => transport.send(bytes), timing.paramGapMs);
    transport.on('event', (e) => this.onEvent(e));
  }

  get connected(): boolean { return this.transport.connected; }

  setParam(def: ParamDef, value: ParamValue): void {
    for (const { address, message } of paramChanges(def, value)) this.queue.setParam(toHex(address), message);
  }

  writeVoice(voice: VoiceData): Promise<void> {
    return this.queue.run(async () => {
      for (const message of buildVoiceDump(voice)) {
        this.transport.send(message);
        await sleep(this.timing.bulkGapMs);
      }
    });
  }

  readVoice(): Promise<VoiceData> {
    return this.queue.run(() => this.requestVoice());
  }

  /** Program Change then dump, as one queue job so nothing can interleave (PC = slot 0..31, spec §6.2). */
  selectAndRead(slot: number): Promise<VoiceData> {
    return this.queue.run(() => {
      this.transport.send([0xc0, slot]);
      return this.requestVoice();
    });
  }

  /** Read-only: the System block is never written by this editor. */
  readSystem(): Promise<number[]> {
    return this.queue.run(async () => {
      const [msg] = await this.request(ADDR_SYSTEM, (b) => b.address[0] === 0 && b.data.length === SYSTEM_SIZE);
      return parseBulk(msg)!.data;
    });
  }

  sendNotes(on: boolean, notes: number[], velocity: number): Promise<void> {
    return this.queue.run(() => {
      for (const n of notes) this.transport.send(on ? [0x90, n, velocity] : [0x80, n, 0]);
    });
  }

  /** Bypasses the queue on purpose: used at shutdown when queued jobs may never run. */
  allNotesOffNow(sounding: number[]): void {
    if (!this.connected) return;
    for (const n of sounding) this.transport.send([0x80, n, 0]);
    this.transport.send([0xb0, 123, 0]);
  }

  private async requestVoice(): Promise<VoiceData> {
    return parseVoiceDump(await this.request(ADDR_HEADER, isFooter));
  }

  private async request(address: Address, isComplete: (b: BulkBlock) => boolean): Promise<Bytes[]> {
    try {
      return await this.requestOnce(address, isComplete);
    } catch (err) {
      console.warn(`[device] dump ${toHex(address)} failed (${(err as Error).message}), retrying once`);
      return this.requestOnce(address, isComplete);
    }
  }

  private requestOnce(address: Address, isComplete: (b: BulkBlock) => boolean): Promise<Bytes[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`no complete reply within ${this.timing.dumpTimeoutMs} ms`)),
        this.timing.dumpTimeoutMs);
      const finish = (err: Error | null, messages?: Bytes[]) => {
        clearTimeout(timer);
        this.collector = null;
        if (err) reject(err); else resolve(messages!);
      };
      this.collector = { messages: [], isComplete, finish };
      this.transport.send(buildDumpRequest(address));
    });
  }

  private onEvent(e: MidiEvent): void {
    switch (e.type) {
      case 'sysex': return this.onSysex(e.bytes);
      case 'noteOn': return void this.emit('note', true, e.note, e.velocity);
      case 'noteOff': return void this.emit('note', false, e.note, 0);
      case 'cc': return void this.emit('cc', e.controller, e.value);
      case 'pc': return void this.emit('pc', e.program);
    }
  }

  private onSysex(bytes: Bytes): void {
    const c = this.collector;
    if (!c) return; // unsolicited SysEx: nothing is waiting for it
    let block: BulkBlock | null;
    try {
      block = parseBulk(bytes);
    } catch (err) {
      return c.finish(new Error(`malformed dump: ${(err as Error).message}`));
    }
    if (!block) return;
    if (isHeader(block)) c.messages = [];
    c.messages.push(bytes);
    if (c.isComplete(block)) c.finish(null, c.messages);
  }
}
