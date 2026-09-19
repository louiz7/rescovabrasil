const base = '/api/voice-debug';
async function jsonRequest(path, options = {}) {
  const response = await fetch(base + path, options);
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'Local voice debugging failed.');
  return data;
}
export function createVoiceDebug({ provider, onStatus = () => {} }) {
  const started = performance.now();
  const recorders = new Map();
  const pendingStreams = new Map();
  const cleanups = [];
  const events = [];
  let ended = false;
  let session;
  let finishPromise;
  const notify = (status, error) => onStatus({ status, id: session?.id, error });
  const ready = (async () => {
    try {
      const config = await jsonRequest('/sessions');
      if (!config.available || config.enabled === false) {
        notify('unavailable', config.reason || 'Local Whisper debugging is not enabled.');
        return;
      }
      if (!window.MediaRecorder)
        throw new Error('This browser does not support debug audio recording.');
      session = await jsonRequest('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      if (!ended) {
        for (const [speaker, stream] of pendingStreams) record(speaker, stream);
        notify('recording');
      }
    } catch (error) {
      notify('error', error.message);
    }
  })();
  function record(speaker, stream) {
    if (!session || ended || recorders.has(speaker) || !stream?.getAudioTracks().length) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    if (!mimeType) {
      notify('error', 'No supported audio recording format was found.');
      return;
    }
    try {
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      const chunks = [];
      const offsetMs = Math.round(performance.now() - started);
      let size = 0;
      let resolve;
      const stopped = new Promise((done) => {
        resolve = done;
      });
      const state = { recorder, chunks, offsetMs, stopped, resolve, mimeType, error: null };
      recorder.ondataavailable = ({ data }) => {
        size += data.size;
        if (size > 30 * 1024 * 1024) {
          state.error = 'Debug audio exceeded the recording size limit.';
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        if (data.size) chunks.push(data);
      };
      recorder.onerror = () => {
        state.error = 'Debug audio recording failed.';
        resolve();
        notify('error', state.error);
      };
      recorder.onstop = resolve;
      recorders.set(speaker, state);
      recorder.start(1000);
    } catch (error) {
      notify('error', error.message);
    }
  }
  function attach(speaker, stream) {
    if (ended || recorders.has(speaker)) return;
    pendingStreams.set(speaker, stream);
    record(speaker, stream);
  }
  function attachElement(element) {
    const capture = () => {
      if (ended || recorders.has('assistant')) return;
      const captureStream = element.captureStream || element.mozCaptureStream;
      if (!captureStream) {
        notify('error', 'This browser cannot capture played assistant audio for local debugging.');
        return;
      }
      try {
        const stream = captureStream.call(element);
        attach('assistant', stream);
        const added = () => attach('assistant', stream);
        stream.addEventListener('addtrack', added);
        cleanups.push(() => stream.removeEventListener('addtrack', added));
      } catch (error) {
        notify('error', error.message);
      }
    };
    element.addEventListener('playing', capture);
    cleanups.push(() => element.removeEventListener('playing', capture));
    if (!element.paused) capture();
  }
  function log(type, name, details = {}) {
    const timestampMs = Math.round(performance.now() - started);
    if (
      ended ||
      events.length >= 500 ||
      timestampMs > 300000 ||
      typeof type !== 'string' ||
      !/^(session|response|test|input_audio_buffer|tool|recording|playback|connection)[._a-z0-9-]{0,100}$/.test(
        type,
      ) ||
      /transcript|\.delta$|audio_buffer\.append/.test(type)
    )
      return;
    const toolNames = [
      'confirm_identity',
      'record_outcome',
      'agree_payment_solution',
      'get_test_context',
      'request_case_document',
      'end_call',
    ];
    const safe = {};
    for (const key of ['responseId', 'callId'])
      if (typeof details[key] === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(details[key]))
        safe[key] = details[key];
    if (typeof details.text === 'string')
      safe.text = details.text
        .slice(0, 4000)
        .replace(/\b(?:sk-|AIza)[a-zA-Z0-9_-]+/g, '[redacted]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]');
    events.push({ type, ...(toolNames.includes(name) ? { name } : {}), timestampMs, ...safe });
  }
  function finish() {
    if (finishPromise) return finishPromise;
    ended = true;
    cleanups.forEach((cleanup) => cleanup());
    for (const state of recorders.values())
      if (state.recorder.state !== 'inactive') state.recorder.stop();
    finishPromise = (async () => {
      await ready;
      if (!session) return;
      notify('uploading');
      let timelineError;
      try {
        if (events.length)
          await jsonRequest('/' + session.id + '/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events }),
          }).catch((error) => {
            timelineError = 'Audio was saved without its debug event timeline: ' + error.message;
          });
        await Promise.all(
          [...recorders].map(async ([speaker, state]) => {
            await Promise.race([
              state.stopped,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Debug recording did not finish.')), 10000),
              ),
            ]);
            if (state.error) throw new Error(state.error);
            const blob = new Blob(state.chunks, { type: state.mimeType });
            if (!blob.size) return;
            await jsonRequest(
              '/' + session.id + '/audio?speaker=' + speaker + '&offsetMs=' + state.offsetMs,
              { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob },
            );
          }),
        );
        await jsonRequest('/' + session.id + '/finish', { method: 'POST' });
        notify('queued', timelineError);
      } catch (error) {
        notify('error', error.message);
      }
    })();
    return finishPromise;
  }
  function captureFinished() {
    return Promise.race([
      Promise.all([...recorders.values()].map((state) => state.stopped)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  async function bindSource(sourceId) {
    await ready;
    if (!session) return;
    try {
      await jsonRequest('/' + session.id + '/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId }),
      });
    } catch (error) {
      notify('error', 'Recording source could not be linked: ' + error.message);
    }
  }
  return { attach, attachElement, finish, log, captureFinished, bindSource };
}
