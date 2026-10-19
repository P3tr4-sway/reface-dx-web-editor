import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MidiStreamParser, type MidiEvent } from '../server/midi.ts';
import { splitSysex } from '../shared/codec.ts';

const dump = [...readFileSync(new URL('./fixtures/legendep.syx', import.meta.url))];

test('SysEx fragmented across packets is reassembled; F8/FE interleaved anywhere are ignored', () => {
  const p = new MidiStreamParser();
  const events: MidiEvent[] = [];
  // realtime bytes may legally appear inside a SysEx (MIDI 1.0); the DX sends F8 clock constantly
  const stream = [0xf8, ...dump.slice(0, 20), 0xfe, 0xf8, ...dump.slice(20)];
  for (let i = 0; i < stream.length; i += 7) events.push(...p.feed(stream.slice(i, i + 7)));
  assert.deepEqual(events, splitSysex(dump).map((bytes) => ({ type: 'sysex', bytes })));
});

test('several channel messages in one packet; velocity-0 note-on is a note-off; running status', () => {
  const p = new MidiStreamParser();
  const events = p.feed([0x90, 60, 100, 0xf8, 64, 90, 0x90, 60, 0, 0x80, 64, 0, 0xb0, 85, 99, 0xc0, 5]);
  assert.deepEqual(events, [
    { type: 'noteOn', channel: 0, note: 60, velocity: 100 },
    { type: 'noteOn', channel: 0, note: 64, velocity: 90 },
    { type: 'noteOff', channel: 0, note: 60 },
    { type: 'noteOff', channel: 0, note: 64 },
    { type: 'cc', channel: 0, controller: 85, value: 99 },
    { type: 'pc', channel: 0, program: 5 },
  ]);
});

test('a truncated SysEx interrupted by a new status byte is dropped, not glued to the next message', () => {
  const p = new MidiStreamParser();
  const events = p.feed([0xf0, 0x43, 0x00, 0x90, 60, 1, ...dump.slice(0, 13)]);
  assert.deepEqual(events, [
    { type: 'noteOn', channel: 0, note: 60, velocity: 1 },
    { type: 'sysex', bytes: dump.slice(0, 13) },
  ]);
});
