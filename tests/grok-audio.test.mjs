import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcmPlayback } from '../src/grok-audio.mjs';
function fixture() {
  const sources = [];
  const context = {
    currentTime: 0,
    destination: {},
    createBuffer: (_channels, n, rate) => ({
      duration: n / rate,
      getChannelData: () => new Float32Array(n),
    }),
    createBufferSource: () => {
      const source = {
        connect() {},
        disconnect() {},
        start(at) {
          this.at = at;
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, sources, playback: createPcmPlayback(context) };
}
const second = Buffer.alloc(48000).toString('base64');
test('Grok may deliver a thirty-second response in a burst without stopping playback', () => {
  const h = fixture();
  for (let i = 0; i < 30; i++) assert.equal(h.playback.append(second, 'a'), undefined);
  assert.equal(h.sources.length, 30);
  assert.ok(Math.abs(h.sources[29].at - 29.025) < 0.00001);
  h.context.currentTime = 3.525;
  const interrupted = h.playback.interrupt();
  assert.equal(interrupted.itemId, 'a');
  assert.equal(interrupted.audioEndMs, 3500);
  assert.ok(h.sources.every((s) => s.stopped));
  h.playback.close();
});
test('oversized queues recover without killing conversation and subsequent audio still plays', () => {
  const h = fixture();
  let recovery;
  for (let i = 0; i < 121; i++) {
    recovery = h.playback.append(second, 'a');
    if (recovery) break;
  }
  assert.equal(recovery.overflow, true);
  assert.deepEqual(recovery.interrupted, { itemId: 'a', audioEndMs: 0 });
  assert.ok(h.sources.every((s) => s.stopped));
  assert.equal(h.playback.append(second, 'b'), undefined);
  assert.equal(h.sources.at(-1).stopped, undefined);
  h.playback.close();
});
