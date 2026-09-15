import { createVoiceDebug } from './voice-debug.mjs';
import DemoPaymentSolutions from './DemoPaymentSolutions';
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Mic, MicOff, PhoneOff, Headphones } from 'lucide-react';
import { createPcmPlayback, pcmBase64 } from './grok-audio.mjs';
import './BrowserVoiceTest.css';

async function request(path = '', method = 'GET') {
  const response = await fetch('/api/grok-voice-test' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'The Grok voice test could not be completed.');
  return data;
}
export default function GrokVoiceTest({ onCase, onDebug }) {
  const [config, setConfig] = useState(null),
    [status, setStatus] = useState('Ready'),
    [error, setError] = useState(''),
    [active, setActive] = useState(false),
    [muted, setMuted] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [confirmed, setConfirmed] = useState(false),
    [outcome, setOutcome] = useState(''),
    [agreement, setAgreement] = useState(null),
    [platform, setPlatform] = useState(null),
    [documentPlatform, setDocumentPlatform] = useState(null),
    [debugStatus, setDebugStatus] = useState(null);
  const debugCall = useRef(null);
  const mounted = useRef(true),
    live = useRef(null),
    generation = useRef(0);
  function stop(message = 'Ended') {
    generation.current++;
    const call = live.current;
    live.current = null;
    if (call) {
      clearTimeout(call.timeout);
      clearInterval(call.clock);
      call.debug?.finish();
      call.stream?.getTracks().forEach((track) => track.stop());
      call.capture?.disconnect();
      call.source?.disconnect();
      call.silent?.disconnect();
      call.playback?.close();
      call.socket?.close();
      if (call.debug)
        call.debug.captureFinished().finally(() => call.context?.close().catch(() => {}));
      else call.context?.close().catch(() => {});
      if (call.id) request('/' + call.id, 'DELETE').catch(() => {});
    }
    if (mounted.current) {
      setActive(false);
      setMuted(false);
      setStatus(message);
    }
  }
  useEffect(() => {
    mounted.current = true;
    request()
      .then((value) => mounted.current && setConfig(value))
      .catch((e) => mounted.current && setError(e.message));
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);
  async function start() {
    if (live.current) return;
    const token = ++generation.current;
    const call = {
      ready: false,
      muted: false,
      audioItems: new Set(),
      discardedAudioItems: new Set(),
    };
    live.current = call;
    debugCall.current = call;
    call.debug = createVoiceDebug({
      provider: 'grok',
      onStatus: (value) => {
        if (mounted.current && debugCall.current === call) setDebugStatus(value);
      },
    });
    const current = () => mounted.current && generation.current === token && live.current === call;
    const fail = (message) => {
      if (current()) {
        setError(message);
        stop('Test stopped');
      }
    };
    setActive(true);
    setError('');
    setElapsed(0);
    setOutcome('');
    setAgreement(null);
    setPlatform(null);
    setDocumentPlatform(null);
    setConfirmed(false);
    setStatus('Requesting microphone');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode)
        throw new Error(
          'Grok voice testing needs microphone access and AudioWorklet support on localhost or HTTPS.',
        );
      call.timeout = setTimeout(
        () => fail('The voice connection timed out. Please try again.'),
        45000,
      );
      // Create and resume in the button gesture so browser autoplay policies permit audio.
      const context = new AudioContext();
      call.context = context;
      await context.resume();
      if (!current()) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      call.stream = stream;
      call.debug.attach('user', stream);
      stream.getTracks().forEach((track) => {
        track.enabled = false;
      });
      setStatus('Preparing browser audio');
      await context.audioWorklet.addModule('/audio/grok-capture-worklet.js');
      if (!current()) return;
      call.capture = new AudioWorkletNode(context, 'grok-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      call.source = context.createMediaStreamSource(stream);
      call.silent = context.createGain();
      call.silent.gain.value = 0;
      call.source.connect(call.capture);
      call.capture.connect(call.silent);
      call.silent.connect(context.destination);
      call.debugDestination = context.createMediaStreamDestination();
      // Keep the recording clock running through pauses between assistant chunks.
      call.silent.connect(call.debugDestination);
      call.debug.attach('assistant', call.debugDestination.stream);
      call.playback = createPcmPlayback(context, call.debugDestination);
      const session = await request('/session', 'POST');
      if (!current()) {
        if (session.id) await request('/' + session.id, 'DELETE').catch(() => {});
        return;
      }
      call.id = session.id;
      const url = new URL(session.websocketPath, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/grok-test-media/'))
        throw new Error('Invalid voice relay address.');
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      call.socket = socket;
      setStatus('Connecting to Grok');
      const send = (event) => {
        if (current() && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      };
      call.capture.port.onmessage = ({ data }) => {
        if (!current() || !call.ready || call.muted || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 256000) {
          fail('The audio connection fell behind. Please try again.');
          return;
        }
        send({ type: 'input_audio_buffer.append', audio: pcmBase64(data) });
      };
      socket.onclose = () => fail('The Grok voice connection closed. You can start a new test.');
      socket.onerror = () => fail('The Grok voice connection failed. Please try again.');
      socket.onmessage = ({ data }) => {
        if (!current()) return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        call.debug?.log(event.type, event.name);
        if (event.type === 'test.ready' && !call.ready) {
          call.ready = true;
          clearTimeout(call.timeout);
          stream.getTracks().forEach((track) => {
            track.enabled = !call.muted;
          });
          call.capture.port.postMessage({ enabled: !call.muted });
          setStatus('Connected · speak in English');
          const started = Date.now();
          call.clock = setInterval(() => {
            if (!current()) return;
            const seconds = Math.floor((Date.now() - started) / 1000);
            setElapsed(seconds);
            if (seconds >= Math.min(config?.maxSeconds || 300, 300)) stop('Time limit reached');
          }, 1000);
        } else if (event.type === 'test.error')
          fail(event.message || 'Grok reported a voice test error.');
        else if (event.type === 'test.tool_result') {
          if (event.name === 'confirm_identity' && event.result?.confirmed === true)
            setConfirmed(true);
          if (
            event.name === 'agree_payment_solution' &&
            event.result?.agreed === true &&
            event.result.agreement?.demo === true
          ) {
            setAgreement(event.result.agreement);
            setPlatform(event.result.platform || event.result.agreement.platform || null);
          }
          if (event.name === 'record_outcome' && event.result?.recorded === true)
            setOutcome(event.result.outcome || 'Recorded');
          if (event.result?.documentRequested === true && event.result.platform?.caseId)
            setDocumentPlatform(event.result.platform);
        } else if (['response.output_audio.delta', 'response.audio.delta'].includes(event.type)) {
          if (event.item_id && call.discardedAudioItems.has(event.item_id)) return;
          if (event.item_id) call.audioItems.add(event.item_id);
          try {
            const result = call.playback.append(event.delta, event.item_id);
            if (result?.overflow) {
              for (const itemId of call.audioItems) call.discardedAudioItems.add(itemId);
              call.audioItems.clear();
              if (result.interrupted?.itemId)
                send({ type: 'playback.interrupted', ...result.interrupted });
              setStatus('Audio queue cleared · you can keep speaking');
            }
          } catch (e) {
            fail(e.message);
          }
        } else if (event.type === 'input_audio_buffer.speech_started') {
          for (const itemId of call.audioItems) call.discardedAudioItems.add(itemId);
          call.audioItems.clear();
          const interrupted = call.playback.interrupt();
          if (interrupted) send({ type: 'playback.interrupted', ...interrupted });
        }
      };
    } catch (e) {
      fail(
        e.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow microphone access in your browser and try again.'
          : e.message,
      );
    }
  }
  const sample = config?.case;
  return (
    <div className="browser-voice-test modal-body">
      <div className="info-box">
        <Headphones size={23} />
        <span>
          <strong>Grok microphone sandbox.</strong> This uses xAI audio and may incur API charges.
          No phone call is made, and accepted solutions create a demo case and a payment follow-up
          draft. When local debugging is enabled, recordings and local Whisper transcripts are saved
          until you delete them.
        </span>
      </div>
      <div className="voice-test-sample">
        <h3>Fictional test case</h3>
        <p>
          Play <strong>{sample?.name || 'Ana Silva'}</strong> and speak in English. A clear “Yes” to
          the named identity question is enough.
        </p>
        {sample && (
          <dl>
            <div>
              <dt>Creditor</dt>
              <dd>{sample.creditor}</dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd>{sample.reference}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd>
                {new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'BRL' }).format(
                  sample.amount_minor / 100,
                )}
              </dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>{sample.due_date}</dd>
            </div>
          </dl>
        )}
      </div>
      <DemoPaymentSolutions
        offers={config?.offers || []}
        agreement={agreement}
        platform={platform}
        onCase={onCase}
      />
      {documentPlatform && (
        <section
          className="demo-payment-agreement"
          aria-label="Saved document request"
          role="status"
        >
          <h3>Document request saved</h3>
          <p>
            {documentPlatform.reference || 'Demo case'} · Helena will retrieve the requested
            document.
          </p>
          <p>
            End the test, then open Demo SMS conversations to see the follow-up. Delivery is
            simulated.
          </p>
          {onCase && (
            <button
              type="button"
              className="secondary"
              onClick={() => onCase(documentPlatform.caseId)}
            >
              Open saved case
            </button>
          )}
        </section>
      )}
      <section className="voice-test-sample" aria-label="Conversation ideas">
        <h3>Try a conversation</h3>
        <p>
          <strong>Document workflow:</strong> Play Ana Silva, confirm your name, ask “Can you send
          me my original loan agreement?”, then click End test. Open Agents → Demo SMS conversations
          to see Helena’s retrieval and Marina’s follow-up.
        </p>
        <p>
          Ask about your balance, explain that you cannot pay, request a callback, dispute the debt,
          ask for a person, or say “Please stop contacting me.” Use your own words and follow-up
          questions.
        </p>
      </section>
      <div className="voice-test-status" role="status" aria-live="polite">
        <strong>{status}</strong>
        <span>
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} / 5:00
        </span>
      </div>
      {confirmed && <p className="success-box">Name confirmed by self-report for this test.</p>}
      {outcome && <p className="success-box">Test outcome: {outcome.replaceAll('_', ' ')}</p>}
      {error && (
        <div className="error" role="alert">
          <AlertCircle size={18} />
          {error}
        </div>
      )}
      {config && !config.available && (
        <p className="muted">
          {config.reason ||
            'Add XAI_API_KEY to the local .env and restart the server to enable the Grok test.'}
        </p>
      )}
      <div className="info-box">
        <span>
          Local Whisper debug: {debugStatus?.status || 'checked when the test starts'}
          {debugStatus?.error ? ` · ${debugStatus.error}` : ''}.{' '}
          {onDebug && (
            <button className="text-button" onClick={() => onDebug(debugStatus?.id)}>
              Open voice debug
            </button>
          )}
        </span>
      </div>
      <div className="voice-test-controls">
        {!active ? (
          <button className="primary" disabled={!config?.available} onClick={start}>
            <Mic size={17} />
            Start Grok microphone test
          </button>
        ) : (
          <>
            <button
              className="secondary"
              disabled={!live.current?.stream}
              onClick={() => {
                const call = live.current;
                if (!call) return;
                call.muted = !muted;
                setMuted(call.muted);
                call.stream?.getTracks().forEach((track) => {
                  track.enabled = call.ready && !call.muted;
                });
                call.capture?.port.postMessage({ enabled: call.ready && !call.muted });
              }}
            >
              {muted ? <MicOff size={17} /> : <Mic size={17} />}
              {muted ? 'Unmute microphone' : 'Mute microphone'}
            </button>
            <button className="secondary" onClick={() => stop()}>
              <PhoneOff size={17} />
              End Grok test
            </button>
          </>
        )}
      </div>
      <p className="muted small-text">
        Up to five minutes · {config?.model || 'Grok Voice Agent'}
        {config?.voice ? ` · ${config.voice}` : ''} · Headphones recommended
      </p>
    </div>
  );
}
