import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checksum, splitSysex, parseVoiceDump, buildVoiceDump, parseBulk, buildParamChange, buildDumpRequest,
  paramChanges, fromHex, ADDR_COMMON, ccToValues,
} from '../shared/codec.ts';
import { getValues, getParam, deriveVoice } from '../shared/params.ts';

const fixtureBytes = [...readFileSync(new URL('./fixtures/legendep.syx', import.meta.url))];
const fixtureMsgs = splitSysex(fixtureBytes);

test('checksum: spec §1.5 worked examples', () => {
  assert.equal(checksum([0x05, 0x0e, 0x0f, 0x00]), 0x5e); // header
  assert.equal(checksum([0x05, 0x0f, 0x0f, 0x00]), 0x5d); // footer
  const op1 = fromHex('01 76 59 13 48 0C 7F 7F 27 05 00 00 00 03 00 01 01 16 76 7B 00 00 00 4E 41 00 00 00');
  assert.equal(checksum([0x05, 0x31, 0x00, 0x00, ...op1]), 0x4e);
  // pitfall from spec §1.5 (SK): sum & 0x7f == 0 must give 0, not 0x80
  assert.equal(checksum([0x40, 0x40]), 0x00);
});

test('fixture: 7 messages, 241 bytes, every checksum valid', () => {
  assert.equal(fixtureBytes.length, 241);
  assert.equal(fixtureMsgs.length, 7);
  for (const m of fixtureMsgs) assert.ok(parseBulk(m));
});

test('codec round-trip of the LegendEP fixture is byte-exact', () => {
  const voice = parseVoiceDump(fixtureMsgs);
  assert.deepEqual(buildVoiceDump(voice).flat(), fixtureBytes);
});

test('fixture decodes to the documented ground truth (spec §0.1)', () => {
  const v = getValues(parseVoiceDump(fixtureMsgs));
  assert.equal(v.name, 'LegendEP');
  assert.equal(v.algorithm, 8);
  assert.equal(v.fx1Type, 'CHO');
  assert.equal(v.fx2Type, 'REV');
  assert.equal(v.transpose, 0);
  assert.equal(v.pitchBendRange, 2);
  assert.equal(v['op1.level'], 0x78);
  assert.equal(v['op2.detune'], 8); // raw 0x48
  assert.equal(v['op2.velocitySens'], 0x41);
  assert.equal(v['op2.kslLeftDepth'], 0x0d);
  const d = deriveVoice(v);
  assert.deepEqual(d.algorithm.carriers, [1, 3]);
  assert.deepEqual(d.fx1, ['DEPTH', 'RATE']);
  assert.equal(d.frequencies[0].display, '1.00');
});

test('parseBulk rejects corruption', () => {
  const bad = [...fixtureMsgs[1]];
  bad[20] ^= 0x01;
  assert.throws(() => parseBulk(bad), /checksum/);
  const short = [...fixtureMsgs[2]];
  short.splice(12, 1);
  assert.throws(() => parseBulk(short), /byte count/);
  assert.equal(parseBulk([0xf0, 0x7e, 0x7f, 0x06, 0x02, 0x43, 0, 0x41, 0x53, 6, 0, 0, 0, 0x7f, 0xf7]), null);
});

test('parseVoiceDump rejects an incomplete dump', () => {
  assert.throws(() => parseVoiceDump(fixtureMsgs.slice(0, 6)), /header \+ 5 blocks \+ footer/);
});

test('message builders match the device-verified bytes', () => {
  assert.deepEqual(buildDumpRequest([0x0e, 0x0f, 0x00]), fromHex('F0 43 20 7F 1C 05 0E 0F 00 F7'));
  assert.deepEqual(buildParamChange([0x30, 0x00, 0x12], [0x40]), fromHex('F0 43 10 7F 1C 05 30 00 12 40 F7'));
  const [lvl] = paramChanges(getParam('op3.level'), 100);
  assert.deepEqual(lvl.message, fromHex('F0 43 10 7F 1C 05 31 02 12 64 F7'));
  const name = paramChanges(getParam('name'), 'AB');
  assert.equal(name.length, 10);
  assert.deepEqual(name[0].address, [...ADDR_COMMON.slice(0, 2), 0]);
  assert.deepEqual(name.map((n) => n.message[9]), [0x41, 0x42, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);
});

test('FM-section CC map (spec §6.3)', () => {
  assert.deepEqual(ccToValues(80, 0), { algorithm: 1 });
  assert.deepEqual(ccToValues(80, 81), { algorithm: 8 }); // transmitted value for ALGO 8
  assert.deepEqual(ccToValues(80, 127), { algorithm: 12 });
  assert.deepEqual([0, 12, 23, 35, 46, 58, 69, 81, 92, 104, 115, 127].map((v) => ccToValues(80, v)!.algorithm),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(ccToValues(85, 99), { 'op1.level': 99 });
  assert.deepEqual(ccToValues(110, 127), { 'op3.feedbackType': 'SQUARE' });
  assert.deepEqual(ccToValues(117, 0), { 'op4.freqMode': 'RATIO' });
  assert.deepEqual(ccToValues(119, 42), { 'op4.fine': 42 });
  assert.equal(ccToValues(7, 100), null);
  assert.equal(ccToValues(91, 1), null);
});
