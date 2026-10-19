// MIDI thru: plays a hardware controller (e.g. a Keystation) into the DX. One allowlist decides what may reach the
// instrument; held notes and the sustain pedal are tracked so a port switch, an unplug or a DX reconnect cannot hang notes.
import { EventEmitter } from 'node:events';
import { ParamError } from '../shared/params.ts';
import type { SystemInfo, ThruStatus } from '../shared/protocol.ts';
import { MidiStreamParser, type InputPort, type MidiEvent, type MidiTransport } from './midi.ts';

const SUSTAIN = 64;
/**
 * Controllers forwarded: the always-on ones the DX recognises (spec §6.3): 1 modulation, 7 volume, 11 expression,
 * 64 sustain. Every other CC is dropped, in particular 80 and 85-119 (FM-section CCs: with MIDI Control ON they silently
 * edit the voice), 120-127 (channel mode; 122 is Local Control, a System setting) and 0/32 (bank select, unknown to the DX).
 */
const THRU_CCS = new Set([1, 7, 11, SUSTAIN]);

/**
 * The thru allowlist: the message to send to the DX on `channel` (0..15) for one input event, or null to drop it.
 * Never reaching this point: realtime bytes (F8 clock, FE active sensing, FA/FB/FC; MidiStreamParser drops them, and they
 * must not reach the DX: F8 switches it to external sync, and after one FE it mutes on 350 ms of silence, spec §1.6),
 * system common (F1-F6) and polyphonic aftertouch (not parsed into events).
 */
export function thruMessage(e: MidiEvent, channel: number): number[] | null {
  switch (e.type) {
    case 'noteOn': return [0x90 | channel, e.note, e.velocity];
    case 'noteOff': return [0x80 | channel, e.note, 0];
    case 'pitchBend': return [0xe0 | channel, e.value & 0x7f, e.value >> 7];
    case 'pressure': return [0xd0 | channel, e.value]; // harmless: the DX does not receive aftertouch (spec §6.3)
    case 'cc': return THRU_CCS.has(e.controller) ? [0xb0 | channel, e.controller, e.value] : null;
    case 'pc': return null; // Program Change loads a stored voice and discards unsaved edits
    case 'sysex': return null; // could write the System block (or the voice); this editor never writes System
  }
}

/** The DX receive channel as 0..15: System RX channel, or channel 1 when it is ALL or not read yet. */
export function thruChannel(system: SystemInfo | null): number {
  return system && system.rxChannel !== 'ALL' ? system.rxChannel - 1 : 0;
}

/**
 * Forwards the selected input to the DX output directly, not through OutQueue: a queued note would wait behind a dump
 * (until its reply, ~20 ms; 2 × 2 s if it never comes) or a bulk write (~140 ms). transport.send() hands CoreMIDI one whole message
 * per call (RtMidi MidiOutCore::sendMessage, one MIDIPacket), so a thru message can only fall between two messages,
 * never inside an outgoing SysEx.
 *
 * Events: `change` = selection, connection or input list; `note` = a note on/off actually delivered to the DX (velocity 0
 * on off; a velocity-0 note-on arrives as an off), plus one off per held note when `release()` silences them, so a
 * listener that lights keys from these events always matches `held` (sustain is not a key: pedal-held notes are dark).
 */
export class Thru extends EventEmitter<{ change: []; note: [on: boolean, note: number, velocity: number] }> {
  private forwarded = 0;
  /** Notes sounding on the DX from this input: key = channel << 7 | note. */
  private readonly held = new Set<number>();
  /** DX channels whose sustain pedal is down. */
  private readonly sustained = new Set<number>();
  private parser = new MidiStreamParser();
  /** Input state at the previous change event. */
  private last: { port: string | null; connected: boolean } = { port: null, connected: false };

  private readonly input: InputPort;
  private readonly out: MidiTransport;
  private readonly system: () => SystemInfo | null;

  constructor(input: InputPort, out: MidiTransport, system: () => SystemInfo | null) {
    super();
    this.input = input;
    this.out = out;
    this.system = system;
    input.on('message', (bytes) => { for (const e of this.parser.feed(bytes)) this.forward(e); });
    input.on('change', () => this.onInputChange());
    out.on('connected', () => this.release()); // the DX may have kept sounding notes held when its cable went out
  }

  status(): ThruStatus {
    return { port: this.input.port, connected: this.input.connected, inputs: this.inputs(), forwarded: this.forwarded };
  }

  /** Choose a present input, or null for off. */
  select(port: string | null): void {
    if (port === this.out.portName) throw new ParamError(`"${port}" is the reface DX itself; thru from it would loop`);
    if (port !== null && !this.inputs().includes(port)) {
      throw new ParamError(`no MIDI input "${port}"; available: ${this.inputs().map((n) => `"${n}"`).join(', ') || 'none'}`);
    }
    this.use(port);
  }

  /** Startup: the saved port may be unplugged right now and opens when it appears; the DX's own port is still refused. */
  restore(port: string | null): void {
    this.use(port === this.out.portName ? null : port);
  }

  start(): void { this.input.start(); }

  stop(): void {
    this.release();
    this.input.stop();
  }

  /**
   * Note-offs for every held note, then sustain off, on the channels they went out on. While the DX is absent the
   * state is kept: its reconnect calls this again.
   */
  release(): void {
    if (!this.out.connected) return;
    try {
      for (const key of this.held) this.out.send([0x80 | (key >> 7), key & 0x7f, 0]);
      for (const channel of this.sustained) this.out.send([0xb0 | channel, SUSTAIN, 0]);
    } catch (err) { // unplugged mid-release: the reconnect releases again
      console.warn(`[thru] release failed: ${(err as Error).message}`);
      return;
    }
    const released = [...this.held];
    this.held.clear();
    this.sustained.clear();
    for (const key of released) this.emit('note', false, key & 0x7f, 0);
  }

  /** Selectable inputs. Never the DX's own port: its output fed back into it would loop. */
  private inputs(): string[] {
    return this.input.names.filter((name) => name !== this.out.portName);
  }

  private use(port: string | null): void {
    if (port === this.input.port) return;
    this.release(); // the old port's note-offs will never arrive
    this.parser = new MidiStreamParser(); // no half message carried over from the old port
    this.input.select(port);
  }

  private onInputChange(): void {
    const { connected, port } = this.input;
    if (port !== null && (port !== this.last.port || connected !== this.last.connected)) {
      console.log(`[thru] "${port}" ${connected ? 'connected' : 'not connected'}`);
    }
    if (this.last.connected && !connected) this.release(); // unplugged mid-note: its note-offs will never come
    this.last = { port, connected };
    this.emit('change');
  }

  private forward(e: MidiEvent): void {
    const channel = thruChannel(this.system());
    const bytes = thruMessage(e, channel);
    if (!bytes || !this.out.connected) return;
    try {
      this.out.send(bytes);
    } catch { // the DX vanished since the last port scan: nothing sounds, nothing to track
      return;
    }
    if (e.type === 'noteOn') this.held.add((channel << 7) | e.note);
    else if (e.type === 'noteOff') this.held.delete((channel << 7) | e.note);
    else if (e.type === 'cc' && e.controller === SUSTAIN) {
      if (e.value >= 64) this.sustained.add(channel);
      else this.sustained.delete(channel);
    }
    this.forwarded++;
    if (e.type === 'noteOn') this.emit('note', true, e.note, e.velocity);
    else if (e.type === 'noteOff') this.emit('note', false, e.note, 0);
  }
}
