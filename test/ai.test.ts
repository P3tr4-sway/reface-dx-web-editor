// AI sound design against the simulated DX with an injected fake Claude client (no network, no key).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';
import { voicesEqual } from '../shared/codec.ts';
import { getValues, type VoiceValues } from '../shared/params.ts';
import type { AiJob, ServerMessage } from '../shared/protocol.ts';
import { toAiError, toOutputShape, validateDesign, type ClaudeClient } from '../server/ai.ts';
import { ApiError, type Editor } from '../server/editor.ts';
import { setup, stopEditors, type FakeDx } from './fake-dx.ts';

afterEach(stopEditors);

type Create = (params: any, opts: { signal: AbortSignal }) => Promise<unknown>;
const client = (create: Create) => ({ beta: { messages: { create } } }) as unknown as ClaudeClient;

let fakeVoice: () => FakeDx['edit']; // the voice on the FakeDx of the current test
/** A structured-output reply: the current voice with `changes` (flat param ids). */
function design(changes: VoiceValues = {}) {
  return { ...toOutputShape({ ...getValues(fakeVoice()), ...changes }), name: 'StarDrift', summary: 'ALGO 5 · test swell', audition: 'pad' };
}
const reply = (output: unknown, extra: object = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null,
  content: [{ type: 'text', text: JSON.stringify(output) }],
  usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
  ...extra,
});

async function start(create: Create | null) {
  const s = await setup(create && client(create));
  fakeVoice = () => s.dx.edit;
  const messages: ServerMessage[] = [];
  s.editor.on('message', (m) => messages.push(m));
  return { ...s, messages, original: s.dx.edit };
}

async function finished(editor: Editor): Promise<AiJob> {
  for (let i = 0; i < 200; i++) {
    const job = editor.aiJob;
    if (job && ['done', 'error', 'cancelled'].includes(job.state)) return job;
    await sleep(5);
  }
  throw new Error('AI job did not finish');
}

const bulkWrites = (dx: FakeDx) => dx.sent.filter((b) => b[0] === 0xf0 && b[2] === 0x00).length;
const status = (code: number) => (err: unknown) => err instanceof ApiError && err.status === code;

test('a design is written as one undo step, counts changed params, clamps, and plays its phrase', async () => {
  const calls: any[] = [];
  const s = await start(async (params) => { calls.push(params); return reply(design({ algorithm: 5, 'op1.level': 90, 'op2.coarse': 40 })); });
  const { jobId } = s.editor.generate('  a glassy zither drone ');
  const job = await finished(s.editor);
  assert.equal(job.jobId, jobId);
  assert.equal(job.state, 'done', JSON.stringify(job.error));
  const [before, after] = [getValues(s.original), getValues(s.dx.edit)];
  assert.equal(after['op2.coarse'], 31, 'out-of-range value clamped');
  assert.equal(after.name, 'StarDrift');
  const changed = Object.keys(before).filter((id) => before[id] !== after[id]).length;
  assert.deepEqual(job.result, { name: 'StarDrift', summary: 'ALGO 5 · test swell', changedCount: changed, audition: 'pad' });
  assert.equal(job.usage?.estUsd, 0.005); // 100×$4 + 200×$20 + 3000×$0.20 per MTok
  assert.deepEqual(s.messages.filter((m) => m.type === 'ai').map((m) => (m as AiJob).state), ['designing', 'writing', 'done']);
  assert.deepEqual(s.messages.filter((m) => m.type === 'voice-changed').map((m) => (m as { source: string }).source), ['api']);

  const [params] = calls;
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.output_config.effort, 'low');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(!params.system[0].text.includes('zither'), 'volatile request stays out of the cached system prompt');
  assert.match(params.messages[0].content, /Request: a glassy zither drone$/);

  await sleep(200);
  assert.ok(s.messages.some((m) => m.type === 'audition' && m.ai && m.what === 'pad'));
  assert.ok(s.dx.sent.some((b) => b[0] === 0x90 && b[1] === 48), 'pad phrase note-on C3');

  await s.editor.undo();
  assert.ok(voicesEqual(s.dx.edit, s.original), 'one undo restores the previous voice');
  assert.equal(s.editor.status().canUndo, false, 'the AI write was a single undo step');
});

test('unknown / missing params or a bad enum → invalid, nothing written', async () => {
  const s = await start(async () => {
    const output = design({ lfoWave: 'WOBBLE' });
    delete (output.operators[2] as Record<string, unknown>).fine;
    return reply({ ...output, common: { ...output.common, bogus: 1 } });
  });
  s.editor.generate('pad');
  const job = await finished(s.editor);
  assert.equal(job.error?.kind, 'invalid');
  assert.match(job.error!.message, /unknown bogus.*missing op3\.fine.*lfoWave/);
  assert.throws(() => validateDesign({ ...design(), operators: design().operators.slice(0, 3) }), /exactly 4 operators/);
  assert.equal(bulkWrites(s.dx), 0);
  assert.ok(voicesEqual(s.dx.edit, s.original));
  assert.equal(s.editor.status().canUndo, false);
});

test('a refusal → refused error, nothing written', async () => {
  const s = await start(async () => reply(null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [] }));
  s.editor.generate('pad');
  const job = await finished(s.editor);
  assert.deepEqual(job.error, { kind: 'refused', message: 'declined (cyber)' });
  assert.ok(job.usage, 'a refused call still reports its usage');
  assert.equal(bulkWrites(s.dx), 0);
});

test('a carrier in FIXED mode below 20 Hz is rejected (speaker safety); a low fixed modulator is fine', async () => {
  const s = await start(async () => reply(design({ algorithm: 1, 'op1.freqMode': 'FIXED', 'op1.coarse': 0, 'op1.fine': 50 })));
  s.editor.generate('sub drone');
  const job = await finished(s.editor);
  assert.equal(job.error?.kind, 'invalid');
  assert.match(job.error!.message, /carrier OP1 in FIXED mode at 3\.162 Hz/);
  assert.equal(bulkWrites(s.dx), 0);
  assert.doesNotThrow(() => validateDesign(design({ algorithm: 1, 'op4.freqMode': 'FIXED', 'op4.coarse': 0 })));
});

test('cancel while designing → cancelled, nothing written', async () => {
  const s = await start((_p, { signal }) => new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))));
  s.editor.generate('pad');
  await sleep(5);
  s.editor.cancelGenerate();
  const job = await finished(s.editor);
  assert.equal(job.state, 'cancelled');
  assert.equal(bulkWrites(s.dx), 0);
  assert.throws(() => s.editor.cancelGenerate(), status(409));
});

test('no API key → 503; bad prompts → 400', async () => {
  const s = await start(null);
  assert.equal(s.editor.status().ai.configured, false);
  assert.throws(() => s.editor.generate('pad'), status(503));
  const t = await start(async () => reply(design()));
  assert.throws(() => t.editor.generate('   '), status(400));
  assert.throws(() => t.editor.generate('x'.repeat(501)), status(400));
});

test('a second job, a scan or a preset load while a job runs → 409', async () => {
  const s = await start((_p, { signal }) => new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()))));
  s.editor.generate('a');
  assert.throws(() => s.editor.generate('b'), status(409));
  await assert.rejects(s.editor.scanPresets(), status(409));
  await assert.rejects(s.editor.loadPreset('1-2'), status(409));
  s.editor.cancelGenerate();
  await finished(s.editor);
});

test('SDK errors map to user-facing kinds, most specific first', () => {
  const headers = new Headers();
  assert.equal(toAiError(Anthropic.APIError.generate(401, undefined, 'bad key', headers)).kind, 'auth');
  assert.equal(toAiError(Anthropic.APIError.generate(429, undefined, 'slow down', headers)).kind, 'rate');
  assert.equal(toAiError(new Anthropic.APIConnectionTimeoutError()).kind, 'timeout');
  assert.deepEqual(toAiError(new Anthropic.APIConnectionError({})), { kind: 'network', message: 'network offline' });
  assert.deepEqual(toAiError(Anthropic.APIError.generate(529, undefined, 'overloaded', headers)), { kind: 'network', message: 'API error 529' });
});
