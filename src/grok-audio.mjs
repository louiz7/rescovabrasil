export function pcmBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export function createPcmPlayback(context, recordingDestination = null) {
  const sources = new Set();
  let segments = [];
  let nextAt = 0;
  const offsets = new Map();
  let closed = false;
  function interrupt() {
    const now = context.currentTime;
    const newest = segments.at(-1);
    const newestStart = newest?.itemId
      ? segments.find((segment) => segment.itemId === newest.itemId)
      : null;
    const unheardNewest = newestStart && newestStart.start > now;
    const heard = unheardNewest
      ? newestStart
      : segments.filter((segment) => segment.start <= now).at(-1);
    const result = heard?.itemId
      ? {
          itemId: heard.itemId,
          audioEndMs: unheardNewest
            ? 0
            : Math.floor(
                heard.offsetMs + Math.max(0, Math.min(now, heard.end) - heard.start) * 1000,
              ),
        }
      : null;
    for (const source of sources) {
      try {
        source.stop();
      } catch {}
      source.disconnect();
    }
    sources.clear();
    segments = [];
    nextAt = 0;
    offsets.clear();
    return result;
  }
  function append(base64, itemId) {
    if (closed) return;
    if (typeof base64 !== 'string' || base64.length > 262144)
      throw new Error('Invalid audio packet received.');
    const raw = atob(base64);
    if (!raw.length || raw.length % 2) throw new Error('Invalid PCM audio received.');
    const count = raw.length / 2;
    const now = context.currentTime;
    const start = Math.max(now + 0.025, nextAt);
    // Generation can legitimately run much faster than playback. Bound memory,
    // not ordinary response length; recover without closing the conversation.
    if (start + count / 24000 - now > 120 || sources.size >= 4096) {
      const interrupted = interrupt();
      return { overflow: true, interrupted: interrupted || { itemId, audioEndMs: 0 } };
    }
    const buffer = context.createBuffer(1, count, 24000);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) {
      const value = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
      samples[i] = (value >= 32768 ? value - 65536 : value) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    if (recordingDestination) source.connect(recordingDestination);
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
    };
    sources.add(source);
    const previous = segments.filter((segment) => segment.end <= now).at(-1);
    segments = segments.filter((segment) => segment.end > now);
    if (previous) segments.unshift(previous);
    const offsetMs = offsets.get(itemId) || 0;
    nextAt = start + buffer.duration;
    segments.push({ itemId, offsetMs, start, end: nextAt });
    offsets.set(itemId, offsetMs + buffer.duration * 1000);
    source.start(start);
  }
  return {
    append,
    interrupt,
    close() {
      closed = true;
      interrupt();
    },
  };
}
