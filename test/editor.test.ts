// Editor against a simulated reface DX (answers dump requests, follows PC / param changes / bulk writes).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { voicesEqual } from '../shared/codec.ts';
import { withValues, getValues } from '../shared/params.ts';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createHttpServer } from '../server/http.ts';
import { setup, stopEditors } from './fake-dx.ts';

afterEach(stopEditors);

test('audition sends note-on and matching note-off for every note', async () => {
  const { dx, editor } = await setup();
  dx.sent = [];
  editor.audition({ what: 'C4,E4,G4', duration: 0.05, velocity: 90 });
  await sleep(120);
  assert.deepEqual(dx.sent, [[0x90, 60, 90], [0x90, 64, 90], [0x90, 67, 90], [0x80, 60, 0], [0x80, 64, 0], [0x80, 67, 0]]);
});

test('WS note messages hold notes, and closing the socket releases the ones still held', async () => {
  const { dx, editor, dataDir } = await setup();
  const server = createHttpServer(editor, dataDir);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
  try {
    await new Promise((resolve) => ws.once('message', resolve)); // state snapshot
    dx.sent = [];
    ws.send(JSON.stringify({ type: 'note', on: true, note: 60, velocity: 80 }));
    ws.send(JSON.stringify({ type: 'note', on: true, note: 64 }));
    ws.send(JSON.stringify({ type: 'note', on: false, note: 60 }));
    ws.send(JSON.stringify({ type: 'note', on: true, note: 200 }));
    const reply = await new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
    assert.match((reply as { message: string }).message, /note must be an integer 0\.\.127/);
    ws.close();
    await sleep(50);
    assert.deepEqual(dx.sent, [[0x90, 60, 80], [0x90, 64, 100], [0x80, 60, 0], [0x80, 64, 0]]);
  } finally {
    ws.terminate();
    server.close();
  }
});

test('set writes param changes that land in the device edit buffer', async () => {
  const { dx, editor } = await setup();
  editor.set({ 'op1.level': '33', name: 'Hi' }, 'api');
  await editor.refresh();
  assert.equal(getValues(dx.edit)['op1.level'], 33);
  assert.equal(getValues(dx.edit).name, 'Hi');
  assert.equal(editor.status().canUndo, true);
});

test('preset scan preserves an edited buffer whose slot is unknown, and writes backups', async () => {
  const { dx, editor, dataDir } = await setup();
  dx.edit = withValues(dx.slots[13], { 'op2.level': 1 }); // unsaved edit on slot 2-6, server never saw the PC
  await editor.refresh();
  const scan = await editor.scanPresets();
  assert.equal(scan.originalSlot, 13, 'found by unique name match');
  assert.equal(scan.editBufferRewritten, true);
  assert.equal(scan.editBufferPreserved, true);
  assert.ok(voicesEqual(dx.edit, withValues(dx.slots[13], { 'op2.level': 1 })));
  assert.equal(scan.presets[31].name, 'Slot31');
  const files = readdirSync(join(dataDir, 'backups', readdirSync(join(dataDir, 'backups'))[0]));
  assert.equal(files.length, 34);
  assert.ok(files.includes('2-6_Slot13.syx') && files.includes('all.syx') && files.includes('presets.json'));
  assert.equal(editor.status().dirty, true);
});

test('a scan that fails midway writes the saved edit buffer back and reports the failure', async () => {
  const { dx, editor } = await setup();
  const edited = withValues(dx.slots[3], { lfoDelay: 99 });
  dx.edit = edited;
  await editor.refresh();
  const realSend = dx.send.bind(dx);
  dx.send = (bytes: number[]) => { // slot 2-1 never answers a dump request (first try and retry)
    if (dx.edit === dx.slots[8] && bytes[0] === 0xf0 && bytes[2] === 0x20) { dx.sent.push(bytes); return; }
    realSend(bytes);
  };
  await assert.rejects(editor.scanPresets(), /scan failed at 2-1.*edit buffer restored/);
  assert.ok(voicesEqual(dx.edit, edited), 'device edit buffer holds the user voice again');
  assert.equal(editor.status().busy, null);
});
