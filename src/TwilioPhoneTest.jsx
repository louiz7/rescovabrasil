import DemoPaymentSolutions from './DemoPaymentSolutions';
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Phone, PhoneOff, RefreshCw } from 'lucide-react';
import './TwilioPhoneTest.css';

const terminalStatuses = new Set([
  'completed',
  'failed',
  'canceled',
  'cancelled',
  'busy',
  'no-answer',
  'ended',
]);
const pendingRequests = new Map();
const normalizeCall = (value) =>
  value
    ? {
        ...value,
        status: value.status || value.state,
        identityConfirmed:
          value.identityConfirmed || value.identityConfirmation === 'self_reported_name',
      }
    : null;
const statusLabels = {
  starting: 'Starting call',
  initiated: 'Initiated',
  queued: 'Queued',
  initiating: 'Starting call',
  creating: 'Starting call',
  ringing: 'Ringing',
  'in-progress': 'Call in progress',
  answered: 'Answered',
  connected: 'Connected',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
  cancelled: 'Canceled',
  busy: 'Line busy',
  'no-answer': 'No answer',
  ending: 'Ending call',
  ended: 'Ended',
  unknown: 'Call status uncertain',
};
const outcomeLabels = {
  not_reached: 'Not reached',
  invalid_contact: 'Invalid contact',
  callback: 'Callback requested',
  paid_reported: 'Payment reported',
  willing_to_pay: 'Willing to pay',
  unable_to_pay: 'Unable to pay',
  disputed: 'Debt disputed',
  human_review: 'Human review requested',
  opt_out: 'Do not contact',
};
async function request(path = '', method = 'GET', body) {
  const response = await fetch('/api/twilio-test' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'The phone test request could not be completed.');
  return data;
}

export default function TwilioPhoneTest({ onCase, onDebug }) {
  const [config, setConfig] = useState(null);
  const [destination, setDestination] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(true);
  const active = !!call && !terminalStatuses.has(call.status);

  async function load() {
    try {
      const data = await request();
      if (!mounted.current) return;
      setConfig(data);
      setDestination((value) =>
        data.destinations?.includes(value) ? value : data.destinations?.[0] || '',
      );
      if (data.currentCall) {
        setCall(normalizeCall(data.currentCall));
        if (!terminalStatuses.has(data.currentCall.status || data.currentCall.state))
          setDestination(data.currentCall.destination);
      }
      setError('');
    } catch (e) {
      if (mounted.current) setError(e.message);
    }
  }
  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!call?.id || !active) return;
    let stopped = false;
    let timer;
    async function poll() {
      try {
        const updated = await request('/calls/' + call.id);
        if (!stopped && mounted.current) {
          setCall(normalizeCall(updated));
          setError('');
        }
      } catch (e) {
        if (!stopped && mounted.current)
          setError('Could not refresh the call status. ' + e.message);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [call?.id, active]);

  async function start() {
    if (
      busy ||
      active ||
      !authorized ||
      !config?.available ||
      !config.destinations?.includes(destination)
    )
      return;
    let requestId = pendingRequests.get(destination);
    if (!requestId || (call && terminalStatuses.has(call.status) && !uncertain)) {
      requestId = crypto.randomUUID();
      pendingRequests.set(destination, requestId);
    }
    setBusy(true);
    setError('');
    try {
      const result = await request('/calls', 'POST', { destination, confirmed: true, requestId });
      if (!mounted.current) return;
      setCall(normalizeCall(result));
      setUncertain(false);
      setAuthorized(false);
    } catch (e) {
      if (!mounted.current) return;
      setUncertain(true);
      setError(
        e.message +
          ' The request may already have started a call. Retrying uses the same request ID to avoid redialing.',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function end() {
    if (!call?.id || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await request('/calls/' + call.id + '/end', 'POST');
      if (mounted.current)
        setCall(result.id ? normalizeCall(result) : { ...call, status: 'ending' });
    } catch (e) {
      if (mounted.current) setError('Could not confirm that the call ended. ' + e.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const sample = config?.case;
  return (
    <div className="twilio-phone-test modal-body">
      <div className="info-box">
        <Phone size={22} />
        <span>
          <strong>This makes a real phone call.</strong> Twilio calls your approved test number and
          connects you to GPT-Live. Twilio and OpenAI usage may incur charges. The conversation is
          in English and uses a fictional case. Accepted solutions create a demo case and a payment
          follow-up draft.
        </span>
      </div>
      <section className="phone-test-config">
        <div className="phone-test-section-title">
          <h3>Phone test setup</h3>
          <button
            className="icon-button"
            aria-label="Refresh phone test setup"
            onClick={load}
            disabled={busy}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {!config ? (
          <p className="muted">Loading configuration…</p>
        ) : (
          <ul className="phone-test-checks">
            {(config.checks || []).map((check) => (
              <li key={check.key}>
                <span className={check.configured ? 'phone-check-ready' : 'phone-check-missing'}>
                  {check.configured ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  {check.detail && <small>{check.detail}</small>}
                </div>
                <span>{check.configured ? 'Ready' : 'Needed'}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small-text">
          Configure the Twilio Account SID, Auth Token, caller number, OpenAI access, public
          HTTPS/WSS callback URL, approved recipient, and TWILIO_TEST_ENABLED in the local .env.
          This test is enabled separately from campaign sending.
        </p>
        {config?.fromPhone && (
          <p>
            <strong>Caller number:</strong> {config.fromPhone}
          </p>
        )}
        {config?.publicUrl && (
          <p className="phone-test-url">
            <strong>Callback URL:</strong> {config.publicUrl}
          </p>
        )}
      </section>
      <section className="phone-test-sample">
        <h3>Fictional test case</h3>
        <p>
          Play <strong>{sample?.name || 'Ana Silva'}</strong>. Confirm your name when asked, then
          discuss the fictional balance in English.
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
      </section>
      <DemoPaymentSolutions
        offers={config?.offers || []}
        agreement={call?.agreement?.demo === true ? call.agreement : null}
        platform={call?.platform || call?.agreement?.platform}
        onCase={onCase}
      />
      {call?.platform?.documentRequestId && (
        <section
          className="demo-payment-agreement"
          aria-label="Saved document request"
          role="status"
        >
          <h3>Document request saved</h3>
          <p>
            {call.platform.reference || 'Demo case'} · Helena will retrieve the requested document.
          </p>
          <p>
            {call.platform.delivery?.status === 'awaiting_configuration'
              ? 'Email requested. Delivery is waiting for email configuration.'
              : call.platform.delivery?.channel === 'email'
                ? 'Email follow-up is queued for after the call ends. Track delivery in the case conversation.'
                : 'After the call ends, open Demo SMS conversations to see the simulated follow-up.'}
          </p>
          {onCase && (
            <button
              type="button"
              className="secondary"
              onClick={() => onCase(call.platform.caseId)}
            >
              Open saved case
            </button>
          )}
        </section>
      )}
      <label className="field">
        <span>Approved test number</span>
        <select
          aria-label="Approved test number"
          value={destination}
          disabled={busy || active || uncertain}
          onChange={(e) => {
            setDestination(e.target.value);
            setAuthorized(false);
          }}
        >
          <option value="">Select an approved number</option>
          {(config?.destinations || []).map((number) => (
            <option key={number} value={number}>
              {number}
            </option>
          ))}
        </select>
      </label>
      {!active && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={authorized}
            onChange={(e) => setAuthorized(e.target.checked)}
            disabled={busy || !config?.available || !destination}
          />
          I authorize a real call to this test number
        </label>
      )}
      {config?.debugRecordingEnabled && (
        <p className="info-box">
          Local voice debugging records this phone test for Whisper transcription. Audio and
          transcripts remain available in Voice debug until deleted.
        </p>
      )}
      {call && (
        <section className="phone-test-call" aria-live="polite">
          <div className="phone-test-section-title">
            <h3>{statusLabels[call.status] || call.status}</h3>
            <span>{call.destination}</span>
          </div>
          {call.debugId && onDebug && (
            <button className="secondary" onClick={() => onDebug(call.debugId)}>
              Open debug recording
            </button>
          )}
          {call.identityConfirmed && <p>Name confirmed by self-report for this test.</p>}
          {call.outcome && (
            <p>
              <strong>Test outcome:</strong>{' '}
              {outcomeLabels[call.outcome] || call.outcome.replaceAll('_', ' ')}
            </p>
          )}
          {call.error && (
            <p className="error" role="alert">
              {call.error}
            </p>
          )}
          <small>
            Closing this panel does not end an active call. Reopen it to check progress or end the
            call.
          </small>
        </section>
      )}
      {error && (
        <div className="error" role="alert">
          <AlertCircle size={18} />
          {error}
        </div>
      )}
      <div className="phone-test-actions">
        {active ? (
          <button
            className="secondary"
            disabled={busy || call.status === 'ending' || call.endRequested}
            onClick={end}
          >
            <PhoneOff size={17} />
            {busy ? 'Ending…' : 'End phone call'}
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !authorized || !destination || !config?.available}
            onClick={start}
          >
            <Phone size={17} />
            {busy
              ? 'Starting call…'
              : uncertain
                ? 'Retry the same call request'
                : 'Call my test number'}
          </button>
        )}
      </div>
      <p className="muted small-text">
        Maximum {Math.ceil((config?.maxSeconds || 300) / 60)} minutes ·{' '}
        {config?.model || 'GPT-Live'}
        {config?.backendModel ? ` + ${config.backendModel}` : ''} · Real telephone test
      </p>
    </div>
  );
}
