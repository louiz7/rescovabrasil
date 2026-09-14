import WebSocket, { WebSocketServer } from 'ws';
import { validTwilio } from './providers.mjs';
import { liveVoiceInstructions, liveBackendInstructions, liveTools } from './browser-voice.mjs';
import { createLiveBackend } from '../src/live-backend.mjs';

const pathPattern = /^\/twilio-test-media\/([a-f0-9-]{36})\/?$/;
export function validTestHandshake(config, path, signature) {
  if (!pathPattern.test(path || '') || typeof signature !== 'string') return false;
  try {
    const base = new URL(config.publicUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
      return false;
    const url = config.publicUrl.replace(/\/$/, '') + path.replace(/\/$/, '');
    return [
      url,
      url + '/',
      url.replace(/^https:/, 'wss:'),
      url.replace(/^https:/, 'wss:') + '/',
    ].some((value) => validTwilio(config, value, {}, signature));
  } catch {
    return false;
  }
}
export function bridgeTwilioTest(
  twilio,
  session,
  config,
  { connect = (url, options) => new WebSocket(url, options) } = {},
) {
  let debugStart = 0,
    debugOutputEnd = 0;
  let openai,
    streamSid,
    started = false,
    ready = false,
    closed = false,
    inputBytes = 0,
    queuedBytes = 0,
    sequence = 0;
  const input = [],
    marks = new Map();
  const send = (socket, event) => {
    if (closed || socket?.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 256000) {
      fail('Audio connection is too slow.');
      return false;
    }
    socket.send(JSON.stringify(event));
    return true;
  };
  const backend = createLiveBackend({
    send: (event) => send(openai, event),
    execute: ({ name, args, callId }) => session.execute(name, args, callId),
    onError: (message) => session.update('in-progress', message),
  });
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(startTimeout);
    backend.close();
    input.length = 0;
    marks.clear();
    if (openai?.readyState === WebSocket.OPEN)
      openai.send(JSON.stringify({ type: 'session.close' }));
    openai?.close();
    twilio.close();
  };
  const fail = (message) => {
    if (closed) return;
    session.update('in-progress', message);
    close();
    void session.finish(message);
  };
  const startTimeout = setTimeout(() => fail('GPT-Live phone audio did not start in time.'), 20000);
  startTimeout.unref?.();
  session.onClose = close;
  twilio.on('message', (raw) => {
    if (closed) return;
    try {
      const event = JSON.parse(raw.toString());
      if (event.event === 'start') {
        if (started) return fail('Repeated phone stream start.');
        const s = event.start,
          format = s?.mediaFormat;
        if (
          !s ||
          s.accountSid !== config.accountSid ||
          !session.providerSid ||
          s.callSid !== session.providerSid ||
          !s.streamSid ||
          (event.streamSid && event.streamSid !== s.streamSid)
        )
          return fail('Phone stream identity mismatch.');
        if (
          format?.encoding !== 'audio/x-mulaw' ||
          Number(format.sampleRate) !== 8000 ||
          Number(format.channels) !== 1
        )
          return fail('Unsupported phone audio format.');
        started = true;
        debugStart = Date.now();
        session.startDebug?.();
        streamSid = s.streamSid;
        session.update('in-progress', 'Phone audio connected; starting GPT-Live.');
        openai = connect('wss://api.openai.com/v1/live/sessions', {
          headers: { Authorization: 'Bearer ' + config.openaiKey },
          maxPayload: 1024 * 1024,
        });
        openai.on('open', () =>
          send(openai, {
            type: 'session.start',
            event_id: 'phone_start',
            session: {
              model: config.liveModel || 'gpt-live-1',
              store: false,
              instructions: liveVoiceInstructions.replaceAll('browser test', 'phone test'),
              audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
              delegation: {
                type: 'responses',
                responses: {
                  model: config.liveBackendModel || 'gpt-5.6-terra',
                  instructions: liveBackendInstructions().replaceAll(
                    'browser voice test',
                    'phone voice test',
                  ),
                  tools: liveTools,
                  tool_choice: 'auto',
                  parallel_tool_calls: false,
                },
              },
            },
          }),
        );
        openai.on('message', (data) => {
          if (closed) return;
          try {
            const e = JSON.parse(data.toString());
            if (e.type === 'session.started') {
              if (ready) return;
              ready = true;
              clearTimeout(startTimeout);
              session.update('in-progress', 'GPT-Live is connected.');
              for (const audio of input)
                send(openai, { type: 'session.input_audio.append', audio });
              input.length = 0;
              inputBytes = 0;
              send(openai, {
                type: 'session.instructions.append',
                event_id: 'phone_greeting',
                delegation_id: null,
                content:
                  'Speak English. Greet now: Hello, I am Rescova, an AI virtual assistant. Am I speaking to Ana Silva, and can you speak privately? Then listen. Do not disclose any debt details before backend name confirmation.',
              });
            } else if (
              e.type === 'session.instructions.appended' &&
              e.client_event_id === 'phone_greeting'
            )
              send(openai, {
                type: 'session.commentary.append',
                event_id: 'phone_begin',
                delegation_id: null,
                content: 'Begin the conversation now following those instructions.',
              });
            else if (e.type === 'session.output_audio.delta') {
              if (!ready || typeof e.delta !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(e.delta))
                return fail('Invalid GPT-Live audio.');
              const bytes = Buffer.from(e.delta, 'base64').length;
              if (!bytes) return;
              queuedBytes += bytes;
              if (queuedBytes > 80000) return fail('Phone playback is falling behind.');
              const offset = Math.max(Date.now() - debugStart, debugOutputEnd);
              session.debugAudio?.({
                speaker: 'assistant',
                audio: Buffer.from(e.delta, 'base64'),
                encoding: 'pcmu',
                sampleRate: 8000,
                timestampMs: offset,
              });
              debugOutputEnd = offset + bytes / 8;
              const mark = 'audio_' + ++sequence;
              marks.set(mark, bytes);
              send(twilio, { event: 'media', streamSid, media: { payload: e.delta } });
              send(twilio, { event: 'mark', streamSid, mark: { name: mark } });
            } else if (e.type === 'session.closed') {
              close();
              void session.finish('GPT-Live session ended.');
            } else if (e.type === 'error' && !ready)
              fail('GPT-Live rejected phone session startup.');
            else backend.handle(e);
          } catch {
            fail('Invalid GPT-Live event.');
          }
        });
        openai.on('error', () => fail('GPT-Live connection failed.'));
        openai.on('close', () => {
          if (!closed) fail('GPT-Live connection closed.');
        });
      } else if (event.event === 'media') {
        if (!started || event.streamSid !== streamSid) return fail('Phone stream mismatch.');
        const audio = event.media?.payload;
        if (
          typeof audio !== 'string' ||
          audio.length > 32000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)
        )
          return fail('Invalid phone audio.');
        session.debugAudio?.({
          speaker: 'user',
          audio: Buffer.from(audio, 'base64'),
          encoding: 'pcmu',
          sampleRate: 8000,
          timestampMs: Number.isFinite(Number(event.media?.timestamp))
            ? Number(event.media.timestamp)
            : Date.now() - debugStart,
        });
        if (ready) send(openai, { type: 'session.input_audio.append', audio });
        else {
          inputBytes += Buffer.from(audio, 'base64').length;
          if (inputBytes > 80000) return fail('GPT-Live audio startup timed out.');
          input.push(audio);
        }
      } else if (event.event === 'mark') {
        if (event.streamSid !== streamSid) return fail('Phone playback stream mismatch.');
        const name = event.mark?.name;
        if (marks.has(name)) {
          queuedBytes -= marks.get(name);
          marks.delete(name);
        }
      } else if (event.event === 'stop') {
        if (event.streamSid !== streamSid) return fail('Phone stop stream mismatch.');
        close();
        void session.finish('Phone audio ended.');
      }
    } catch {
      fail('Invalid phone stream event.');
    }
  });
  twilio.on('error', () => fail('Phone audio connection failed.'));
  twilio.on('close', () => {
    if (!closed) {
      close();
      void session.finish('Phone audio disconnected.');
    }
  });
  return { close };
}
export function attachTwilioTest(server, tests, config) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/twilio-test-media/')) return;
    const match = req.url.match(pathPattern),
      session = match && tests.getSession(match[1]);
    if (
      !session ||
      session.closed ||
      session.streamClaimed ||
      !config.twilioTestEnabled ||
      !validTestHandshake(config, req.url, req.headers['x-twilio-signature'])
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    session.streamClaimed = true;
    try {
      wss.handleUpgrade(req, socket, head, (ws) => bridgeTwilioTest(ws, session, config));
    } catch {
      socket.destroy();
      void session.finish('Phone stream upgrade failed.');
    }
  });
  return wss;
}
