import { createVoiceDebug } from './voice-debug.mjs';
import DemoPaymentSolutions from './DemoPaymentSolutions';
import React, { useEffect, useRef, useState } from 'react';
import { Headphones, Mic, MicOff, PhoneOff, Play, AlertCircle } from 'lucide-react';
import './BrowserVoiceTest.css';
import { createLiveBackend } from './live-backend.mjs';

async function request(path, method = 'GET', body) {
  const response = await fetch('/api/voice-test' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'The voice test could not be completed.');
  return data;
}

export default function BrowserVoiceTest({ onCase, onDebug }) {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState('');
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [agreement, setAgreement] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [documentPlatform, setDocumentPlatform] = useState(null);
  const [debugStatus, setDebugStatus] = useState(null);
  const debugCall = useRef(null);
  const audio = useRef(null);
  const live = useRef(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  function stop(message = 'Ended') {
    generation.current += 1;
    const call = live.current;
    live.current = null;
    if (call) {
      clearTimeout(call.timeout);
      clearInterval(call.clock);
      clearTimeout(call.closeTimeout);
      call.debug?.finish();
      call.backend?.close();
      call.channel?.close();
      call.peer?.close();
      call.stream?.getTracks().forEach((track) => track.stop());
      if (call.id) request('/' + call.id, 'DELETE').catch(() => {});
    }
    if (audio.current) {
      audio.current.pause();
      audio.current.srcObject = null;
    }
    if (mounted.current) {
      setActive(false);
      setMuted(false);
      setPlaybackBlocked(false);
      setStatus(message);
    }
  }

  function end(message = 'Finishing the conversation…') {
    const call = live.current;
    if (!call || call.closing) return;
    if (!call.ready || call.channel?.readyState !== 'open') {
      stop('Ended');
      return;
    }
    call.closing = true;
    clearInterval(call.clock);
    call.backend?.close();
    call.stream?.getTracks().forEach((track) => {
      track.enabled = false;
    });
    setMuted(true);
    setStatus(message);
    call.channel.send(JSON.stringify({ type: 'session.close', event_id: 'close_session' }));
    call.closeTimeout = setTimeout(() => stop('Ended · final usage unconfirmed'), 15000);
  }

  useEffect(() => {
    mounted.current = true;
    request('')
      .then((value) => mounted.current && setConfig(value))
      .catch((e) => mounted.current && setError(e.message));
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);

  async function start() {
    if (live.current) return;
    setError('');
    setOutcome(null);
    setAgreement(null);
    setPlatform(null);
    setDocumentPlatform(null);
    setConfirmed(false);
    setElapsed(0);
    setActive(true);
    setStatus('Requesting microphone');
    const token = ++generation.current;
    const call = { ready: false, closing: false, greetingId: null };
    live.current = call;
    debugCall.current = call;
    call.debug = createVoiceDebug({
      provider: 'openai',
      onStatus: (value) => {
        if (mounted.current && debugCall.current === call) setDebugStatus(value);
      },
    });
    if (audio.current) call.debug.attachElement(audio.current);
    const current = () => mounted.current && generation.current === token && live.current === call;
    const send = (event) => {
      if (!current() || call.channel?.readyState !== 'open') return false;
      call.channel.send(JSON.stringify(event));
      return true;
    };
    call.backend = createLiveBackend({
      send,
      execute: (body) => request('/' + call.id + '/tool', 'POST', body),
      onResult: ({ name, result }) => {
        if (!current()) return;
        // Managed Responses delegation returns this result to Live. UI feedback
        // must not inject a second instruction that interrupts ongoing speech.
        if (name === 'confirm_identity' && result.confirmed === true) setConfirmed(true);
        if (
          name === 'agree_payment_solution' &&
          result.agreed === true &&
          result.agreement?.demo === true
        ) {
          setAgreement(result.agreement);
          setPlatform(result.platform || result.agreement.platform || null);
        }
        if (name === 'record_outcome' && result.recorded === true)
          setOutcome(result.outcome || 'Recorded');
        if (result.documentRequested === true && result.platform?.caseId)
          setDocumentPlatform(result.platform);
      },
      onError: (message) => current() && setError(message),
    });
    const fail = (message) => {
      if (!current()) return;
      setError(message);
      stop('Test stopped');
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error('Microphone testing requires a supported browser on localhost or HTTPS.');
      call.timeout = setTimeout(() => fail('Connection timed out. Please try again.'), 45000);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      call.stream = stream;
      call.debug.attach('user', stream);
      setStatus('Connecting to OpenAI');
      const peer = new RTCPeerConnection();
      call.peer = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.ontrack = (event) => {
        if (!current() || !audio.current) return;
        audio.current.srcObject = event.streams[0] || new MediaStream([event.track]);
        audio.current.play().catch(() => current() && setPlaybackBlocked(true));
      };
      peer.onconnectionstatechange = () => {
        if (['failed', 'disconnected'].includes(peer.connectionState))
          fail('The audio connection was lost. Start a new test to reconnect.');
      };
      const channel = peer.createDataChannel('oai-events');
      call.channel = channel;
      channel.onopen = () => {
        if (current()) setStatus('Waiting for GPT-Live to start');
      };
      channel.onclose = () =>
        current() && fail('The connection closed before final session confirmation.');
      channel.onerror = () => fail('The voice data connection failed. Please try again.');
      channel.onmessage = ({ data }) => {
        if (!current()) return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        call.debug?.log(
          event.type === 'response.event' ? event.event?.type : event.type,
          event.event?.item?.name,
        );
        if (event.type === 'session.closed') {
          stop('Ended · session finalized');
          return;
        }
        if (call.closing) return;
        if (event.type === 'session.started' && !call.ready) {
          call.ready = true;
          clearTimeout(call.timeout);
          setStatus('Connected · speak in English');
          const started = Date.now();
          const maxSeconds = Math.min(config?.maxSeconds || 300, 300);
          call.clock = setInterval(() => {
            if (!current()) return;
            const seconds = Math.floor((Date.now() - started) / 1000);
            setElapsed(seconds);
            if (seconds >= maxSeconds) end('Time limit reached · finishing');
          }, 1000);
          call.greetingId = `greeting_${token}`;
          send({
            type: 'session.instructions.append',
            event_id: call.greetingId,
            delegation_id: null,
            content:
              'Conduct the entire conversation in English. Greet immediately without waiting for the caller. Introduce yourself transparently as an AI virtual assistant, then ask only one question: Am I speaking with Ana Silva? Pause and listen. Do not bundle this with a privacy or consent question. A clear yes answering this named question is sufficient self-reported name confirmation: have the backend record it with confirm_identity, without demanding that the caller repeat the full name. Do not repeat the identity question while the result is pending. Follow the startup instructions and disclose debt details only after successful confirmation.',
          });
        } else if (
          event.type === 'session.instructions.appended' &&
          call.greetingId &&
          event.client_event_id === call.greetingId
        ) {
          call.greetingId = null;
          send({
            type: 'session.commentary.append',
            event_id: `greeting_start_${token}`,
            delegation_id: null,
            content: 'Begin the conversation now, following the instructions provided.',
          });
        } else if (event.type === 'error' && event.error?.client_event_id === call.greetingId) {
          call.greetingId = null;
        }
        call.backend.handle(event);
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            peer.removeEventListener('icegatheringstatechange', changed);
            reject(new Error('Timed out gathering audio connection candidates.'));
          }, 10000);
          function changed() {
            if (peer.iceGatheringState !== 'complete') return;
            clearTimeout(timeout);
            peer.removeEventListener('icegatheringstatechange', changed);
            resolve();
          }
          peer.addEventListener('icegatheringstatechange', changed);
          changed();
        });
      }
      if (!current()) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('Missing local audio connection offer.');
      const session = await request('/session', 'POST', { sdp });
      if (!current()) {
        if (session.id) await request('/' + session.id, 'DELETE').catch(() => {});
        return;
      }
      call.id = session.id;
      await peer.setRemoteDescription({ type: 'answer', sdp: session.sdp });
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
          Speak with the AI using your microphone. This uses OpenAI and may incur API charges. No
          Twilio call is made, and accepted solutions create a demo case and a payment follow-up
          draft. When local voice debugging is enabled, recordings and local Whisper transcripts are
          saved until you delete them.
        </span>
      </div>
      <div className="voice-test-sample">
        <h3>Fictional test case</h3>
        <p>
          Play the role of <strong>{sample?.name || 'Ana Silva'}</strong> and speak in English.
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
        <p>
          The AI already has these details. It should introduce itself and ask you to confirm your
          name before discussing the debt.
        </p>
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
        <p>When asked whether you are Ana Silva, a clear “Yes” is enough. Then try one of these:</p>
        <ul>
          <li>“What is my outstanding balance?”</li>
          <li>“Can you send me my original loan agreement?”</li>
          <li>“I cannot afford to pay right now.”</li>
          <li>“Could someone call me back tomorrow afternoon?”</li>
          <li>“I do not recognize this debt.”</li>
          <li>“I would like to speak to a person.”</li>
          <li>“Please stop contacting me.”</li>
        </ul>
        <p>
          <strong>Document workflow:</strong> Play Ana Silva, confirm your name, ask for the
          original loan agreement, then click End test. Open Agents → Demo SMS conversations to see
          Helena’s retrieval and Marina’s follow-up.
        </p>
        <p>
          Use your own words and ask follow-up questions. These are fictional scenarios; no real
          debt or payment is changed.
        </p>
      </section>
      <div className="voice-test-status" role="status" aria-live="polite">
        <strong>{status}</strong>
        <span>
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} / 5:00
        </span>
      </div>
      {confirmed && <p className="success-box">Name confirmed by self-report for this test.</p>}
      {outcome && (
        <p className="success-box">Test outcome: {String(outcome).replaceAll('_', ' ')}</p>
      )}
      {error && (
        <div className="error" role="alert">
          <AlertCircle size={18} />
          {error}
        </div>
      )}
      {config && !config.available && (
        <p className="muted">
          {config.reason ||
            'Add an OpenAI API key to the local .env and restart the server to enable the voice test.'}
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
      <audio ref={audio} autoPlay />
      {playbackBlocked && (
        <button
          className="secondary"
          onClick={() =>
            audio.current
              ?.play()
              .then(() => setPlaybackBlocked(false))
              .catch(() => setError('Audio playback is blocked. Check browser audio permissions.'))
          }
        >
          <Play size={16} />
          Enable speaker audio
        </button>
      )}
      <div className="voice-test-controls">
        {!active ? (
          <button className="primary" disabled={!config?.available} onClick={start}>
            <Mic size={17} />
            Start microphone test
          </button>
        ) : (
          <>
            <button
              className="secondary"
              disabled={!live.current?.stream || live.current?.closing}
              onClick={() => {
                const next = !muted;
                live.current?.stream?.getAudioTracks().forEach((track) => {
                  track.enabled = !next;
                });
                setMuted(next);
              }}
            >
              {muted ? <MicOff size={17} /> : <Mic size={17} />}
              {muted ? 'Unmute microphone' : 'Mute microphone'}
            </button>
            <button className="secondary" onClick={() => end()}>
              <PhoneOff size={17} />
              End test
            </button>
          </>
        )}
      </div>
      <p className="muted small-text">
        Up to five minutes · {config?.model || 'GPT-Live'} · Headphones recommended
      </p>
    </div>
  );
}
