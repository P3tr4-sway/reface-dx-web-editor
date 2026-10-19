import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { OutQueue } from '../server/device.ts';

function recorder() {
  const sent: number[][] = [];
  return { sent, send: (bytes: number[]) => { sent.push(bytes); } };
}

test('param changes coalesce per key while queued: latest value wins', async () => {
  const { sent, send } = recorder();
  const q = new OutQueue(send, 0);
  const busy = q.run(() => sleep(30)); // keeps the pump busy so the params pile up
  for (let i = 1; i <= 100; i++) q.setParam('A', [i]);
  q.setParam('B', [7]);
  await busy;
  await q.drained();
  assert.deepEqual(sent, [[100], [7]]);
});

test('coalescing never moves a param across a non-param job (ordering preserved)', async () => {
  const { sent, send } = recorder();
  const q = new OutQueue(send, 0);
  q.run(() => sleep(10));
  q.setParam('A', [1]);
  q.run(() => { sent.push(['bulk'.length]); }); // stands in for a bulk write that overwrites A
  q.setParam('A', [2]);
  q.setParam('A', [3]);
  await q.drained();
  assert.deepEqual(sent, [[1], [4], [3]]);
});

test('param gap is honoured between messages', async () => {
  const { sent, send } = recorder();
  const q = new OutQueue(send, 15);
  const t0 = performance.now();
  q.setParam('A', [1]);
  q.setParam('B', [2]);
  q.setParam('C', [3]);
  await q.drained();
  assert.equal(sent.length, 3);
  assert.ok(performance.now() - t0 >= 30, 'two gaps of 15 ms between three messages');
});

test('a failing job rejects its caller but does not stall the queue', async () => {
  const { sent, send } = recorder();
  const q = new OutQueue(send, 0);
  const failing = q.run(() => { throw new Error('timeout'); });
  q.setParam('A', [9]);
  await assert.rejects(failing, /timeout/);
  await q.drained();
  assert.deepEqual(sent, [[9]]);
  assert.equal(await q.run(() => 42), 42);
});
