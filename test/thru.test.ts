// MIDI thru against the simulated DX and a simulated controller input: allowlist, channel rewrite, stuck-note
// release, the panel's thru-note key events, loop guard, persistence, the direct send path, and the HTTP/WS API.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { ServerMessage, SystemInfo } from '../shared/protocol.ts';
import type { Editor } from '../server/editor.ts';
import { createHttpServer } from '../server/http.ts';
import { thruChannel } from '../server/thru.ts';
import { setup, stopEditors } from './fake-dx.ts';

afterEach(stopEditors);

/** Thru on "Keys A", the fake DX's sent log cleared. */
async function playing() {
  const ctx = await setup();
  ctx.editor.setThru('Keys A');
  ctx.dx.sent = [];
  return ctx;
}

/** The thru-note messages the editor broadcasts from now on, as [on, note, velocity]. */
function thruNotes(editor: Editor): [boolean, number, number][] {
  const seen: [boolean, number, number][] = [];
  editor.on('message', (m) => { if (m.type === 'thru-note') seen.push([m.on, m.note, m.velocity]); });
  return seen;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const isDumpRequest = (bytes: number[]) => bytes[0] === 0xf0 && bytes[2] === 0x20;

test('forwards notes, pitch bend, channel pressure and CC 1/7/11/64, rewritten to the DX channel', async () => {
  const { dx, input, editor } = await playing();
  input.play(
    [0x92, 60, 100], [0x82, 60, 64], [0x92, 62, 90], [0x92, 62, 0], // velocity-0 note-on = note-off
    [0xe2, 0x00, 0x60], [0xd2, 50],
    [0xb2, 1, 10], [0xb2, 7, 100], [0xb2, 11, 90], [0xb2, 64, 127], [0xb2, 64, 0],
  );
  assert.deepEqual(dx.sent, [
    [0x90, 60, 100], [0x80, 60, 0], [0x90, 62, 90], [0x80, 62, 0],
    [0xe0, 0x00, 0x60], [0xd0, 50],
    [0xb0, 1, 10], [0xb0, 7, 100], [0xb0, 11, 90], [0xb0, 64, 127], [0xb0, 64, 0],
  ]);
  assert.equal(editor.status().thru.forwarded, 11);
});

test('blocks SysEx, Program Change, clock/realtime, system common, poly aftertouch, channel-mode and FM-section CCs', async () => {
  const { dx, input, editor } = await playing();
  const blocked: [string, number[]][] = [
    ['SysEx (System block write: MIDI Control off)', [0xf0, 0x43, 0x10, 0x7f, 0x1c, 0x05, 0x00, 0x00, 0x0e, 0x00, 0xf7]],
    ['Program Change', [0xc2, 5]],
    ...[0xf8, 0xfa, 0xfb, 0xfc, 0xfe, 0xff].map((b): [string, number[]] => [`realtime ${b.toString(16)}`, [b]]),
    ['song position', [0xf2, 0x10, 0x00]],
    ['poly aftertouch', [0xa2, 60, 50]],
    ...range(120, 127).map((cc): [string, number[]] => [`channel-mode CC ${cc}`, [0xb2, cc, 0]]),
    ...[80, ...range(85, 90), ...range(102, 119)].map((cc): [string, number[]] => [`FM-section CC ${cc}`, [0xb2, cc, 64]]),
    ['bank select CC 0', [0xb2, 0, 1]],
    ['bank select CC 32', [0xb2, 32, 1]],
  ];
  for (const [what, bytes] of blocked) {
    input.play(bytes);
    assert.deepEqual(dx.sent, [], `${what} must not reach the DX`);
  }
  assert.equal(editor.status().thru.forwarded, 0);
  input.play([0x92, 0xf8, 61, 0xfe, 80]); // clock + sensing inside a note: dropped, the note survives
  assert.deepEqual(dx.sent, [[0x90, 61, 80]]);
});

test('channel: the DX receive channel, or channel 1 when it is ALL or not read yet', async () => {
  const system: SystemInfo = { txChannel: 1, rxChannel: 'ALL', localControl: true, midiControl: true, autoPowerOff: true, masterTranspose: 0 };
  assert.equal(thruChannel(null), 0);
  assert.equal(thruChannel(system), 0);
  assert.equal(thruChannel({ ...system, rxChannel: 5 }), 4);

  const { dx, input, editor } = await playing();
  const resync = async (raw: number, expect: number | 'ALL') => {
    dx.system[1] = raw;
    dx.emit('connected'); // re-reads the System block
    for (let i = 0; i < 50 && editor.status().device.system?.rxChannel !== expect; i++) await sleep(5);
    assert.equal(editor.status().device.system?.rxChannel, expect);
    dx.sent = [];
  };
  await resync(4, 5);
  input.play([0x9b, 60, 1], [0x8b, 60, 0]);
  assert.deepEqual(dx.sent, [[0x94, 60, 1], [0x84, 60, 0]]);
  await resync(0x10, 'ALL');
  input.play([0x9b, 60, 1], [0x8b, 60, 0]);
  assert.deepEqual(dx.sent, [[0x90, 60, 1], [0x80, 60, 0]]);
});

test('held notes and sustain are released when thru switches, turns off, or its input is unplugged', async () => {
  const { dx, input, editor } = await playing();
  input.play([0x90, 60, 100], [0x90, 64, 100], [0xb0, 64, 127], [0x80, 64, 0]);
  dx.sent = [];
  editor.setThru('Keys B');
  assert.deepEqual(dx.sent, [[0x80, 60, 0], [0xb0, 64, 0]], 'switch: note-off for the key still held, then sustain off');

  input.play([0x90, 67, 100]);
  dx.sent = [];
  editor.setThru(null);
  assert.deepEqual(dx.sent, [[0x80, 67, 0]], 'off: no sustain off, the pedal was never pressed');
  assert.deepEqual(editor.status().thru, { port: null, connected: false, inputs: ['Keys A', 'Keys B'], forwarded: 5 });

  editor.setThru('Keys A');
  input.play([0x90, 72, 100]);
  dx.sent = [];
  input.setNames(['fake', 'Keys B']); // Keys A unplugged mid-note
  assert.deepEqual(dx.sent, [[0x80, 72, 0]]);
  assert.equal(editor.status().thru.connected, false);
  assert.equal(editor.status().thru.port, 'Keys A', 'the selection stays and reopens on replug');

  input.setNames(['fake', 'Keys A', 'Keys B']);
  assert.equal(editor.status().thru.connected, true);
  dx.sent = [];
  input.play([0x90, 48, 70]);
  assert.deepEqual(dx.sent, [[0x90, 48, 70]]);
});

test('notes held when the DX went away are released when it reconnects', async () => {
  const { dx, input, editor } = await playing();
  input.play([0x90, 60, 100], [0xb0, 64, 127]);
  dx.connected = false;
  dx.emit('disconnected');
  dx.sent = [];
  input.play([0x80, 60, 0], [0xb0, 64, 0]); // released while the DX is gone: cannot be delivered
  editor.setThru(null); // nor can this release
  assert.deepEqual(dx.sent, []);
  assert.equal(editor.status().thru.forwarded, 2, 'undeliverable messages are not counted');
  dx.start();
  assert.deepEqual(dx.sent.slice(0, 2), [[0x80, 60, 0], [0xb0, 64, 0]]);
});

test('thru-note: every note on/off delivered to the DX, velocity 0 on off; nothing for filtered or undeliverable messages', async () => {
  const { dx, input, editor } = await playing();
  const notes = thruNotes(editor);
  input.play(
    [0x92, 57, 48], [0x92, 60, 100], [0x82, 57, 64], // off velocity 64 is not passed on
    [0x92, 62, 90], [0x92, 62, 0], // velocity-0 note-on = off
    [0x82, 70, 0], // off for a key not held: delivered to the DX, so announced (the panel's delete is a no-op)
    [0xb2, 64, 127], [0xe2, 0x00, 0x60], [0xd2, 50], [0xb2, 1, 10], // forwarded, but not keys
  );
  assert.deepEqual(notes, [[true, 57, 48], [true, 60, 100], [false, 57, 0], [true, 62, 90], [false, 62, 0], [false, 70, 0]]);
  notes.length = 0;
  input.play([0xc2, 5], [0xa2, 60, 50], [0xb2, 80, 64], [0xb2, 123, 0], [0xf0, 0x43, 0x10, 0x7f, 0x1c, 0x05, 0x00, 0x00, 0x0e, 0x00, 0xf7]);
  assert.deepEqual(notes, [], 'filtered messages announce nothing');
  input.play([0xb2, 64, 0], [0x82, 60, 0]); // pedal up after the key: the key went dark at its own off, not now
  assert.deepEqual(notes, [[false, 60, 0]]);
  notes.length = 0;
  dx.connected = false;
  dx.emit('disconnected');
  input.play([0x90, 64, 100], [0x80, 64, 0]);
  assert.deepEqual(notes, [], 'not delivered (DX absent): nothing lights');
});

test('thru-note: a release darkens every held key (switch, off, input unplugged, DX reconnect)', async () => {
  const { dx, input, editor } = await playing();
  const notes = thruNotes(editor);
  input.play([0x90, 60, 100], [0x90, 64, 100], [0xb0, 64, 127], [0x80, 64, 0]);
  notes.length = 0;
  editor.setThru('Keys B');
  assert.deepEqual(notes, [[false, 60, 0]], 'switch: only the key still physically held (64 is pedal-held, already dark)');

  input.play([0x90, 67, 100], [0x90, 69, 100]);
  notes.length = 0;
  editor.setThru(null);
  assert.deepEqual(notes, [[false, 67, 0], [false, 69, 0]], 'off');
  editor.setThru(null);
  assert.deepEqual(notes.length, 2, 'nothing held: a second release announces nothing');

  editor.setThru('Keys A');
  input.play([0x90, 72, 100]);
  notes.length = 0;
  input.setNames(['fake', 'Keys B']);
  assert.deepEqual(notes, [[false, 72, 0]], 'input unplugged mid-note');

  input.setNames(['fake', 'Keys A', 'Keys B']);
  input.play([0x90, 48, 70]);
  notes.length = 0;
  dx.connected = false;
  dx.emit('disconnected');
  editor.setThru('Keys B'); // cannot reach the DX: the key stays held (and lit) until the DX returns
  assert.deepEqual(notes, []);
  dx.start();
  assert.deepEqual(notes, [[false, 48, 0]], 'DX reconnect');
});

test('loop guard: the DX port is never listed or accepted, not even from settings.json', async () => {
  const { editor, dataDir } = await setup();
  assert.deepEqual(editor.status().thru.inputs, ['Keys A', 'Keys B']);
  assert.throws(() => editor.setThru('fake'), /"fake" is the reface DX itself; thru from it would loop/);
  assert.throws(() => editor.setThru('Nope'), /no MIDI input "Nope"; available: "Keys A", "Keys B"/);
  assert.equal(editor.status().thru.port, null);

  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ thruPort: 'fake' }));
  const restarted = await setup(null, dataDir);
  assert.equal(restarted.editor.status().thru.port, null);
});

test('the selection survives a restart; an unplugged saved port opens when it appears; a bad file means off', async () => {
  const first = await setup();
  first.editor.setThru('Keys B');
  assert.deepEqual(JSON.parse(readFileSync(join(first.dataDir, 'settings.json'), 'utf8')), { thruPort: 'Keys B' });
  const second = await setup(null, first.dataDir);
  assert.deepEqual(second.editor.status().thru, { port: 'Keys B', connected: true, inputs: ['Keys A', 'Keys B'], forwarded: 0 });
  second.editor.setThru(null);
  assert.equal((await setup(null, first.dataDir)).editor.status().thru.port, null);

  writeFileSync(join(first.dataDir, 'settings.json'), JSON.stringify({ thruPort: 'Keys C' }));
  const waiting = await setup(null, first.dataDir);
  assert.deepEqual(waiting.editor.status().thru, { port: 'Keys C', connected: false, inputs: ['Keys A', 'Keys B'], forwarded: 0 });
  waiting.input.setNames(['fake', 'Keys A', 'Keys B', 'Keys C']);
  assert.equal(waiting.editor.status().thru.connected, true);

  writeFileSync(join(first.dataDir, 'settings.json'), '{"thruPort": ');
  assert.equal((await setup(null, first.dataDir)).editor.status().thru.port, null);
});

test('a thru note is sent at once while a dump holds the outbound queue (the web keyboard note waits)', async () => {
  const { dx, input, editor } = await playing();
  const realSend = dx.send.bind(dx);
  dx.send = (bytes: number[]) => { // the DX never answers: the queue stays blocked for 2 × 200 ms
    if (isDumpRequest(bytes)) dx.sent.push(bytes);
    else realSend(bytes);
  };
  const refresh = editor.refresh();
  await sleep(10);
  assert.ok(dx.sent.some(isDumpRequest), 'dump request is out and pending');
  editor.note(true, 62); // queued path, for contrast
  input.play([0x90, 60, 100]);
  assert.deepEqual(dx.sent.at(-1), [0x90, 60, 100], 'thru note sent synchronously');
  assert.ok(!dx.sent.some((m) => m[0] === 0x90 && m[1] === 62), 'the queued note is still waiting behind the dump');
  await assert.rejects(refresh, /no complete reply/);
  await sleep(10);
  assert.ok(dx.sent.some((m) => m[0] === 0x90 && m[1] === 62), 'the queued note went out after the dump gave up');
  editor.note(false, 62);
});

test('HTTP GET/PUT /api/thru and WS thru / thru-note messages', async () => {
  const { input, editor, dataDir } = await setup();
  const server = createHttpServer(editor, dataDir);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (body: unknown) => fetch(`${base}/api/thru`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let ws: WebSocket | undefined;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/thru`)).json(), { port: null, connected: false, inputs: ['Keys A', 'Keys B'], forwarded: 0 });
    const ok = await put({ port: 'Keys A' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { port: 'Keys A', connected: true, inputs: ['Keys A', 'Keys B'], forwarded: 0 });
    const loop = await put({ port: 'fake' });
    assert.equal(loop.status, 400);
    assert.match((await loop.json()).error, /would loop/);
    assert.equal((await put({})).status, 400);

    ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    // Buffered: thru off sends thru-note and thru back to back, and ws can emit both in one tick, before a
    // per-call once() listener for the second one exists.
    const inbox: ServerMessage[] = [];
    let wake = () => {};
    ws.on('message', (d) => { inbox.push(JSON.parse(String(d))); wake(); });
    const next = async () => {
      while (!inbox.length) await new Promise<void>((resolve) => { wake = resolve; });
      return inbox.shift()!;
    };
    const snapshot = await next();
    assert.equal(snapshot.type === 'state' && snapshot.status.thru.port, 'Keys A');
    input.play([0x90, 60, 100]);
    assert.deepEqual(await next(), { type: 'thru-note', on: true, note: 60, velocity: 100 });
    input.play([0x90, 64, 1]);
    assert.deepEqual(await next(), { type: 'thru-note', on: true, note: 64, velocity: 1 });
    input.play([0x80, 60, 0]);
    assert.deepEqual(await next(), { type: 'thru-note', on: false, note: 60, velocity: 0 });
    ws.send(JSON.stringify({ type: 'thru', port: null })); // 64 still held: thru off releases it first
    assert.deepEqual(await next(), { type: 'thru-note', on: false, note: 64, velocity: 0 });
    assert.deepEqual(await next(), { type: 'thru', thru: { port: null, connected: false, inputs: ['Keys A', 'Keys B'], forwarded: 3 } });
    assert.equal((await (await fetch(`${base}/api/status`)).json()).thru.forwarded, 3);
  } finally {
    ws?.terminate();
    server.close();
  }
});
