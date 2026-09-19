import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveCallEnding } from '../src/live-call-ending.mjs';

function clock() {
  let at = 0,
    sequence = 0;
  const timers = new Map();
  return {
    timers,
    schedule(fn, delay) {
      const id = ++sequence;
      timers.set(id, { at: at + delay, fn });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = at + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        at = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      at = target;
    },
  };
}
test('closing waits for backend continuation and quiet output; repeated request is idempotent', () => {
  const c = clock(),
    closed = [];
  const ending = createLiveCallEnding({ ...c, onClose: (reason) => closed.push(reason) });
  ending.settled(); // An earlier unrelated response is not completion of end_call.
  ending.request();
  ending.request();
  c.advance(4000);
  assert.deepEqual(closed, []);
  ending.settled();
  c.advance(3000);
  ending.activity();
  c.advance(3000);
  assert.deepEqual(closed, []);
  c.advance(500);
  assert.deepEqual(closed, ['caller_requested']);
  c.advance(20000);
  assert.equal(closed.length, 1);
  assert.equal(c.timers.size, 0);
});
test('Twilio pending playback delays close, but stalled backend/playback cannot hold it forever', () => {
  const c = clock(),
    closed = [];
  const ending = createLiveCallEnding({
    ...c,
    playbackPending: () => true,
    onClose: (r) => closed.push(r),
  });
  ending.request();
  ending.settled();
  c.advance(14000);
  assert.deepEqual(closed, []);
  c.advance(1000);
  assert.deepEqual(closed, ['close_grace_expired']);
  assert.equal(c.timers.size, 0);
});
test('1000 isolated close controllers cancel timers without cross-call effects', () => {
  const c = clock(),
    closed = [];
  const controllers = Array.from({ length: 1000 }, (_, i) =>
    createLiveCallEnding({ ...c, onClose: () => closed.push(i) }),
  );
  for (const controller of controllers) {
    controller.request();
    controller.settled();
  }
  controllers.forEach((controller, i) => {
    if (i % 2) controller.close();
  });
  c.advance(30000);
  assert.equal(closed.length, 500);
  assert.ok(closed.every((i) => i % 2 === 0));
  assert.equal(c.timers.size, 0);
});
