import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBackend } from '../src/live-backend.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wrap = (event, delegation_id = 'd1') => ({ type: 'response.event', delegation_id, event });
const created = (id) => wrap({ type: 'response.created', response: { id } });
const done = (id) => wrap({ type: 'response.completed', response: { id, output: [] } });
const tool = (id) =>
  wrap({
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: id,
      name: 'confirm_identity',
      arguments: '{"confirmed":true,"name":"Ana Silva"}',
    },
  });
function harness(execute = async () => ({ confirmed: true })) {
  const sent = [],
    errors = [],
    results = [];
  const manager = createLiveBackend({
    send: (e) => {
      sent.push(e);
      return true;
    },
    execute,
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e),
  });
  return { manager, sent, errors, results };
}
test('Live speech and transcript events never trigger manual response creation', () => {
  const h = harness();
  for (const type of [
    'session.started',
    'session.input_transcript.delta',
    'session.output_transcript.delta',
    'input_audio_buffer.committed',
    'response.done',
  ])
    h.manager.handle({ type });
  assert.deepEqual(h.sent, []);
});
test('completion notification waits for the non-tool backend continuation', async () => {
  const settled = [],
    sent = [];
  const manager = createLiveBackend({
    send: (event) => sent.push(event),
    execute: async () => ({ endCall: true }),
    onSettled: (event) => settled.push(event),
  });
  manager.handle(created('r1'));
  manager.handle(tool('c1'));
  manager.handle(done('r1'));
  await tick();
  assert.equal(settled.length, 0);
  manager.handle(created('r2'));
  manager.handle(done('r2'));
  manager.handle(done('r2'));
  assert.deepEqual(settled, [{ responseId: 'r2' }]);
  manager.close();
});
test('backend continuation waits for all tools and completed lifecycle even when terminal output is empty', async () => {
  const pending = new Map();
  const h = harness(({ callId }) => new Promise((resolve) => pending.set(callId, resolve)));
  h.manager.handle(created('r1'));
  h.manager.handle(tool('c1'));
  h.manager.handle(tool('c2'));
  await tick();
  pending.get('c2')({ confirmed: true });
  await tick();
  assert.equal(h.sent.length, 0);
  h.manager.handle(done('r1'));
  assert.equal(h.sent.length, 0);
  pending.get('c1')({ confirmed: true });
  await tick();
  assert.deepEqual(
    h.sent.map((e) => e.type),
    ['response.item.create', 'response.item.create', 'response.create'],
  );
  assert.deepEqual(
    h.sent.slice(0, 2).map((e) => e.item.call_id),
    ['c1', 'c2'],
  );
  assert.ok(h.sent.every((e) => e.event_id));
  assert.deepEqual(Object.keys(h.sent[2]).sort(), ['event_id', 'type']);
  h.manager.handle(tool('c1'));
  h.manager.handle(done('r1'));
  await tick();
  assert.equal(h.sent.length, 3);
});
test('stale completion never releases another active backend response', async () => {
  const h = harness();
  h.manager.handle(created('r1'));
  h.manager.handle(tool('c1'));
  await tick();
  h.manager.handle(created('r2'));
  h.manager.handle(done('r1'));
  assert.equal(h.sent.length, 0);
  h.manager.handle(done('r1'));
  assert.equal(h.sent.length, 0);
  h.manager.handle(done('r2'));
  assert.equal(h.sent.filter((e) => e.type === 'response.create').length, 1);
});
test('cancelled partial function calls do not deadlock later delegated work', async () => {
  const h = harness();
  h.manager.handle(created('r1'));
  h.manager.handle(wrap({ type: 'response.function_call_arguments.delta', delta: '{"' }));
  h.manager.handle(wrap({ type: 'response.cancelled', response: { id: 'r1', output: [] } }));
  h.manager.handle(created('r2'));
  h.manager.handle(tool('c2'));
  h.manager.handle(done('r2'));
  await tick();
  assert.equal(h.sent.filter((e) => e.type === 'response.create').length, 1);
});
test('recoverable command errors do not close the voice handler; closure drops pending tool output', async () => {
  let resolve;
  const h = harness(() => new Promise((r) => (resolve = r)));
  h.manager.handle({
    type: 'error',
    error: { message: 'Conversation already has an active response in progress: resp_test' },
  });
  assert.equal(h.errors.length, 1);
  h.manager.handle(created('r1'));
  h.manager.handle(tool('c1'));
  h.manager.handle(done('r1'));
  await tick();
  h.manager.close();
  resolve({ confirmed: true });
  await tick();
  assert.equal(h.sent.length, 0);
});
