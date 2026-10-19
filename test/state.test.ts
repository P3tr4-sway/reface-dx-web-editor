import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitSysex, parseVoiceDump } from '../shared/codec.ts';
import { withValues, getValues } from '../shared/params.ts';
import { VoiceState } from '../server/state.ts';

const fixture = parseVoiceDump(splitSysex(readFileSync(new URL('./fixtures/legendep.syx', import.meta.url))));

function setup() {
  let now = 1000;
  const state = new VoiceState(() => now);
  state.acceptDump(fixture, state.writeGen);
  return { state, advance: (ms: number) => { now += ms; } };
}

test('a dump requested before a local write is discarded as stale', () => {
  const { state } = setup();
  const genAtRequest = state.writeGen;
  state.commit(withValues(state.voice!, { 'op1.level': 10 }), 'ui');
  // the dump that was in flight still shows the old level
  assert.equal(state.acceptDump(fixture, genAtRequest), null);
  assert.equal(getValues(state.voice!)['op1.level'], 10);
});

test('a fresh dump is applied and reports device-side changes', () => {
  const { state } = setup();
  const panelEdited = withValues(fixture, { lfoSpeed: 99, name: 'Panel' });
  const changes = state.acceptDump(panelEdited, state.writeGen);
  assert.deepEqual(changes, [{ id: 'name', value: 'Panel' }, { id: 'lfoSpeed', value: 99 }]);
  assert.deepEqual(state.acceptDump(panelEdited, state.writeGen), [], 'identical dump -> no changes');
});

test('device dumps do not bump the write generation; local writes do', () => {
  const { state } = setup();
  const g = state.writeGen;
  state.acceptDump(withValues(fixture, { lfoSpeed: 1 }), g);
  assert.equal(state.writeGen, g);
  state.commit(withValues(state.voice!, { lfoSpeed: 2 }), 'api');
  assert.equal(state.writeGen, g + 1);
});

test('undo/redo: a burst within 500 ms is one batch', () => {
  const { state, advance } = setup();
  for (let v = 1; v <= 20; v++) {
    state.commit(withValues(state.voice!, { 'op2.level': v }), 'ui');
    advance(50);
  }
  advance(600);
  state.commit(withValues(state.voice!, { algorithm: 1 }), 'ui');
  assert.equal(state.canUndo, true);

  let target = state.undo()!;
  state.commit(target, 'undo');
  assert.equal(getValues(state.voice!).algorithm, 8);
  assert.equal(getValues(state.voice!)['op2.level'], 20);

  target = state.undo()!;
  state.commit(target, 'undo');
  assert.equal(getValues(state.voice!)['op2.level'], getValues(fixture)['op2.level']);
  assert.equal(state.undo(), null, 'initial dump is not an undo step');

  target = state.redo()!;
  state.commit(target, 'undo');
  assert.equal(getValues(state.voice!)['op2.level'], 20);
  state.commit(withValues(state.voice!, { lfoDelay: 5 }), 'api');
  assert.equal(state.canRedo, false, 'a new edit clears the redo stack');
});

test('dirty compares against the cached stored voice of the current slot', () => {
  const { state } = setup();
  assert.equal(state.dirty, null, 'slot unknown');
  state.currentSlot = 3;
  assert.equal(state.dirty, null, 'no cached stored voice');
  state.stored.set(3, fixture);
  assert.equal(state.dirty, false);
  state.commit(withValues(state.voice!, { lfoDelay: 5 }), 'api');
  assert.equal(state.dirty, true);
});
