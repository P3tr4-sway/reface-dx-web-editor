// MIDI transport: owns the CoreMIDI in/out ports of the DX, reassembles the byte stream into events,
// and watches the port list so unplug/replug is detected. Also the input-only port of MIDI thru (server/thru.ts).
import { EventEmitter } from 'node:events';
import midi from '@julusian/midi';

export type MidiEvent =
  | { type: 'sysex'; bytes: number[] }
  | { type: 'noteOn'; channel: number; note: number; velocity: number }
  | { type: 'noteOff'; channel: number; note: number }
  | { type: 'cc'; channel: number; controller: number; value: number }
  | { type: 'pc'; channel: number; program: number }
  | { type: 'pitchBend'; channel: number; value: number } // 0..16383, centre 8192
  | { type: 'pressure'; channel: number; value: number }; // channel aftertouch

const DATA_LENGTH: Record<number, number> = { 0x80: 2, 0x90: 2, 0xa0: 2, 0xb0: 2, 0xc0: 1, 0xd0: 1, 0xe0: 2 };

/**
 * Byte-stream parser. RtMidi normally hands over whole messages, but the coordinator saw CoreMIDI deliver a
 * dump fragmented across packets and several messages per callback, so this does not assume message framing.
 */
export class MidiStreamParser {
  private sysex: number[] | null = null;
  private status = 0;
  private data: number[] = [];

  feed(bytes: Iterable<number>): MidiEvent[] {
    const out: MidiEvent[] = [];
    for (const b of bytes) {
      if (b >= 0xf8) continue; // realtime (DX sends F8 clock + FE sensing) may interleave anywhere, even in SysEx
      if (this.sysex) {
        if (b < 0x80) { this.sysex.push(b); continue; }
        if (b === 0xf7) { this.sysex.push(b); out.push({ type: 'sysex', bytes: this.sysex }); this.sysex = null; continue; }
        this.sysex = null; // a status byte inside SysEx means it was truncated: drop it
      }
      if (b === 0xf0) { this.sysex = [b]; this.status = 0; continue; }
      if (b >= 0x80) { this.status = b < 0xf0 ? b : 0; this.data = []; continue; } // system common cancels running status
      if (!this.status) continue;
      this.data.push(b);
      if (this.data.length === DATA_LENGTH[this.status & 0xf0]) {
        const event = toEvent(this.status, this.data);
        if (event) out.push(event);
        this.data = [];
      }
    }
    return out;
  }
}

function toEvent(status: number, [d1, d2]: number[]): MidiEvent | null {
  const channel = status & 0x0f;
  switch (status & 0xf0) {
    case 0x90: return d2 > 0 ? { type: 'noteOn', channel, note: d1, velocity: d2 } : { type: 'noteOff', channel, note: d1 };
    case 0x80: return { type: 'noteOff', channel, note: d1 };
    case 0xb0: return { type: 'cc', channel, controller: d1, value: d2 };
    case 0xc0: return { type: 'pc', channel, program: d1 };
    case 0xe0: return { type: 'pitchBend', channel, value: d1 | (d2 << 7) };
    case 0xd0: return { type: 'pressure', channel, value: d1 };
    default: return null; // polyphonic aftertouch: the DX receives no aftertouch (spec §6.3)
  }
}

type TransportEvents = { event: [MidiEvent]; connected: []; disconnected: [] };

export class MidiTransport extends EventEmitter<TransportEvents> {
  connected = false;
  private input: midi.Input | null = null;
  private output: midi.Output | null = null;
  private timer: NodeJS.Timeout | undefined;

  readonly portName: string;
  private readonly scanMs: number;

  constructor(portName: string, scanMs = 2000) {
    super();
    this.portName = portName;
    this.scanMs = scanMs;
  }

  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.scanMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.close();
  }

  send(bytes: number[]): void {
    if (!this.output) throw new Error('reface DX not connected');
    this.output.sendMessage(bytes);
  }

  private scan(): void {
    const present = midi.Input.getPortNames().includes(this.portName) && midi.Output.getPortNames().includes(this.portName);
    if (present && !this.connected) this.open();
    else if (!present && this.connected) {
      this.close();
      this.emit('disconnected');
    }
  }

  private open(): void {
    const parser = new MidiStreamParser();
    const input = new midi.Input();
    input.ignoreTypes(false, true, true); // receive SysEx; drop clock + active sensing at the driver
    input.on('messageBuffer', (_dt, buf) => { for (const e of parser.feed(buf)) this.emit('event', e); });
    input.openPortByName(this.portName);
    const output = new midi.Output();
    output.openPortByName(this.portName);
    if (!input.isPortOpen() || !output.isPortOpen()) { // port vanished between list and open: retry next scan
      input.destroy();
      output.destroy();
      return;
    }
    this.input = input;
    this.output = output;
    this.connected = true;
    this.emit('connected');
  }

  private close(): void {
    this.input?.closePort();
    this.input?.destroy();
    this.output?.closePort();
    this.output?.destroy();
    this.input = this.output = null;
    this.connected = false;
  }
}

type InputEvents = { message: [bytes: Buffer]; change: [] };

/**
 * One selectable input-only port: the MIDI thru source. Rescanned like the DX port, so a controller that is unplugged
 * and plugged in again reopens by itself. It lists every CoreMIDI input; which of them may be used (never the DX itself)
 * is decided by server/thru.ts. Emits raw bytes; the thru parses and filters them.
 */
export class InputPort extends EventEmitter<InputEvents> {
  /** Every CoreMIDI input port name at the last scan. */
  names: string[] = [];
  port: string | null = null;
  connected = false;
  private input: midi.Input | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly scanMs: number;

  constructor(scanMs = 2000) {
    super();
    this.scanMs = scanMs;
  }

  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.scanMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.close();
  }

  /** Switch ports (null = none). A present port opens now, a missing one when it appears. */
  select(name: string | null): void {
    if (name === this.port) return;
    this.close();
    this.port = name;
    this.scan(true);
  }

  private scan(changed = false): void {
    const names = midi.Input.getPortNames();
    if (names.join('\n') !== this.names.join('\n')) {
      this.names = names;
      changed = true;
    }
    const present = this.port !== null && names.includes(this.port);
    if (present && !this.connected) changed = this.open(this.port!) || changed;
    else if (!present && this.connected) {
      this.close();
      changed = true;
    }
    if (changed) this.emit('change');
  }

  private open(name: string): boolean {
    const input = new midi.Input();
    input.ignoreTypes(true, true, true); // SysEx, clock and active sensing are never forwarded: drop them at the driver
    input.on('messageBuffer', (_dt, buf) => this.emit('message', buf));
    input.openPortByName(name);
    if (!input.isPortOpen()) { // vanished between list and open: retry next scan
      input.destroy();
      return false;
    }
    this.input = input;
    this.connected = true;
    return true;
  }

  private close(): void {
    this.input?.closePort();
    this.input?.destroy();
    this.input = null;
    this.connected = false;
  }
}
