import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitSysex, parseVoiceDump, voicesEqual } from '../shared/codec.ts';
import {
  PARAMS, getParam, decodeValue, encodeValue, withValues, getValues, coerceValue, coerceValues, ParamError,
  opFrequency, type VoiceData,
} from '../shared/params.ts';

const fixture = parseVoiceDump(splitSysex(readFileSync(new URL('./fixtures/legendep.syx', import.meta.url))));

function voiceWithByte(def: (typeof PARAMS)[number], raw: number): VoiceData {
  const v: VoiceData = { common: [...fixture.common], ops: fixture.ops.map((o) => [...o]) };
  (def.block === 'common' ? v.common : v.ops[def.op! - 1])[def.offset] = raw;
  return v;
}

test('schema: ids unique, 124 params, every (block, offset) byte covered at most once', () => {
  assert.equal(new Set(PARAMS.map((p) => p.id)).size, PARAMS.length);
  assert.equal(PARAMS.length, 24 + 4 * 25);
  const seen = new Set<string>();
  for (const p of PARAMS) {
    const len = p.kind === 'string' ? p.length : 1;
    for (let i = 0; i < len; i++) {
      const key = `${p.block}${p.op}:${p.offset + i}`;
      assert.ok(!seen.has(key), `byte ${key} mapped twice`);
      seen.add(key);
    }
  }
});

test('every non-string param: raw<->value bijection over its full range', () => {
  for (const def of PARAMS) {
    if (def.kind === 'string') continue;
    const values = def.kind === 'int' ? Array.from({ length: def.max - def.min + 1 }, (_, i) => def.min + i)
      : def.kind === 'enum' ? [...def.options] : [false, true];
    const raws = new Set<number>();
    for (const value of values) {
      const [raw] = encodeValue(def, value);
      assert.ok(raw >= 0 && raw <= 0x7f, `${def.id}=${value} -> raw ${raw} not 7-bit`);
      assert.equal(decodeValue(def, voiceWithByte(def, raw)), value, `${def.id} round trip of ${value}`);
      raws.add(raw);
    }
    assert.equal(raws.size, values.length, `${def.id} not injective`);
  }
});

test('raw ranges match spec §2 (non-zero minimums)', () => {
  const raw = (id: string, v: number | string) => encodeValue(getParam(id), v)[0];
  assert.deepEqual([raw('transpose', -24), raw('transpose', 24)], [0x28, 0x58]);
  assert.deepEqual([raw('pegLevel1', -48), raw('pegLevel1', 48)], [0x10, 0x70]);
  assert.deepEqual([raw('algorithm', 1), raw('algorithm', 12)], [0x00, 0x0b]);
  assert.deepEqual([raw('op1.detune', -64), raw('op1.detune', 63)], [0x00, 0x7f]);
  assert.deepEqual([raw('op4.fine', 99), raw('op4.coarse', 31)], [0x63, 0x1f]);
  assert.equal(raw('lfoWave', 'S&H'), 6);
  assert.equal(raw('op1.kslRightCurve', '+LIN'), 3);
});

test('name: padded to 10 on encode, trimmed on decode; reserved bytes preserved', () => {
  const v = withValues(fixture, { name: 'Bell', 'op2.level': 5 });
  assert.equal(getValues(v).name, 'Bell');
  assert.deepEqual(v.common.slice(0, 10), [...'Bell      '].map((c) => c.charCodeAt(0)));
  assert.equal(getValues(v)['op2.level'], 5);
  assert.deepEqual(v.common.slice(0x0a, 0x0c), fixture.common.slice(0x0a, 0x0c));
  assert.deepEqual(v.ops[1].slice(0x19), fixture.ops[1].slice(0x19));
  assert.ok(voicesEqual(withValues(fixture, getValues(fixture)), fixture), 'values -> bytes -> values is identity');
});

test('coerceValue: validation errors are actionable, clamp pins numbers', () => {
  assert.equal(coerceValue(getParam('op1.level'), '100'), 100);
  assert.throws(() => coerceValue(getParam('op1.level'), 128), /op1\.level: 128 out of range 0\.\.127/);
  assert.equal(coerceValue(getParam('op1.level'), 128, true), 127);
  assert.equal(coerceValue(getParam('transpose'), -99, true), -24);
  assert.throws(() => coerceValue(getParam('op1.level'), 1.5), /integer/);
  assert.throws(() => coerceValue(getParam('op1.level'), ''), /integer/);
  assert.equal(coerceValue(getParam('partMode'), 'mono-legato'), 'MONO-LEGATO');
  assert.throws(() => coerceValue(getParam('partMode'), 'MONO'), /one of POLY\|MONO-FULL\|MONO-LEGATO/);
  assert.equal(coerceValue(getParam('op3.enabled'), 'off'), false);
  assert.throws(() => coerceValue(getParam('op3.enabled'), 'maybe'), /true\|false/);
  assert.throws(() => coerceValue(getParam('name'), 'ÄÖÜ'), /printable ASCII/);
  assert.throws(() => coerceValue(getParam('name'), 'ElevenChars'), /max 10/);
  assert.throws(() => coerceValues({ nope: 1, 'op1.level': 999 }), (err: unknown) =>
    err instanceof ParamError && /unknown parameter "nope"/.test(err.message) && /op1\.level/.test(err.message));
});

test('derived frequency (spec §3)', () => {
  const f = (mode: string, coarse: number, fine: number) =>
    opFrequency({ 'op1.freqMode': mode, 'op1.coarse': coarse, 'op1.fine': fine }, 1);
  assert.equal(f('RATIO', 0, 0).value, 0.5);
  assert.equal(f('RATIO', 0, 9).display, '0.545');
  assert.equal(f('RATIO', 2, 50).value, 2.5);
  assert.equal(f('RATIO', 31, 99).display, '31.99');
  assert.equal(f('FIXED', 0, 0).value, 1);
  assert.equal(f('FIXED', 16, 0).display, '100.0 Hz');
  assert.equal(Math.round(f('FIXED', 31, 99).value), 9772);
  assert.equal(f('FIXED', 8, 0).estimated, true);
});
