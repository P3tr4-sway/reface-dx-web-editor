// Simulated reface DX (answers dump requests, follows PC / param changes / bulk writes), a simulated MIDI thru input,
// and an Editor on top of them.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { splitSysex, parseVoiceDump, buildVoiceDump, buildBulk, parseBulk } from '../shared/codec.ts';
import { withValues, type VoiceData } from '../shared/params.ts';
import type { ClaudeClient } from '../server/ai.ts';
import { DxDevice } from '../server/device.ts';
import { Editor } from '../server/editor.ts';
import type { InputPort, MidiTransport } from '../server/midi.ts';

export const fixture = parseVoiceDump(splitSysex(readFileSync(new URL('./fixtures/legendep.syx', import.meta.url))));

export class FakeDx extends EventEmitter {
  connected = false;
  portName = 'fake';
  sent: number[][] = [];
  slots = Array.from({ length: 32 }, (_, i) => withValues(fixture, { name: `Slot${i}`, lfoSpeed: i }));
  edit: VoiceData = this.slots[0];
  /** System block (spec §2.1); byte 1 = RX channel (0x10 = ALL). */
  system = new Array(32).fill(0);
  start() { this.connected = true; this.emit('connected'); }
  stop() { this.connected = false; }
  send(bytes: number[]) {
    this.sent.push(bytes);
    const reply = (msgs: number[][]) => setImmediate(() => msgs.forEach((m) => this.emit('event', { type: 'sysex', bytes: m })));
    if ((bytes[0] & 0xf0) === 0xc0) this.edit = this.slots[bytes[1]];
    else if (bytes[0] === 0xf0 && bytes[2] === 0x20) {
      reply(bytes[6] === 0x0e ? buildVoiceDump(this.edit) : [buildBulk([0, 0, 0], this.system)]);
    } else if (bytes[0] === 0xf0 && bytes[2] === 0x10) {
      const [ah, am, al, v] = bytes.slice(6, 10);
      this.edit = structuredClone(this.edit);
      (ah === 0x30 ? this.edit.common : this.edit.ops[am])[al] = v;
    } else if (bytes[0] === 0xf0 && bytes[2] === 0x00) {
      const block = parseBulk(bytes)!;
      this.edit = structuredClone(this.edit);
      if (block.address[0] === 0x30) this.edit.common = block.data;
      if (block.address[0] === 0x31) this.edit.ops[block.address[1]] = block.data;
    }
  }
}

/** Mirrors InputPort: `names` is the CoreMIDI input list, `port` the selection, open while it is listed. */
export class FakeInput extends EventEmitter {
  names = ['fake', 'Keys A', 'Keys B']; // 'fake' is FakeDx's own port: the loop guard must hide it
  port: string | null = null;
  connected = false;
  start() { this.scan(); }
  stop() { this.connected = false; }
  select(name: string | null) {
    if (name === this.port) return;
    this.connected = false;
    this.port = name;
    this.scan(true);
  }
  /** Plug / unplug: the port list as the next rescan would see it. */
  setNames(names: string[]) {
    this.names = names;
    this.scan(true);
  }
  /** Bytes from the controller, as CoreMIDI delivers them. */
  play(...messages: number[][]) {
    if (this.connected) for (const m of messages) this.emit('message', Buffer.from(m));
  }
  private scan(changed = false) {
    const present = this.port !== null && this.names.includes(this.port);
    if (present !== this.connected) { this.connected = present; changed = true; }
    if (changed) this.emit('change');
  }
}

const running: Editor[] = [];
/** Register with afterEach: stops poll timers even when a test fails. */
export function stopEditors(): void { for (const e of running.splice(0)) e.shutdown(); }

/** dataDir: reuse one to start a second editor on the same settings (persistence). */
export async function setup(claude: ClaudeClient | null = null, dataDir = mkdtempSync(join(tmpdir(), 'dxtest-'))) {
  const dx = new FakeDx();
  const input = new FakeInput();
  const device = new DxDevice(dx as unknown as MidiTransport, { paramGapMs: 0, bulkGapMs: 0, dumpTimeoutMs: 200 });
  const editor = new Editor(device, input as unknown as InputPort, dataDir, claude);
  editor.start();
  running.push(editor);
  for (let i = 0; i < 50 && !editor.state.voice; i++) await sleep(5);
  return { dx, input, editor, dataDir };
}
