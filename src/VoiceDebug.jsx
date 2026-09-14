import React, { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
const base = '/api/voice-debug';
async function request(path = '/sessions', method = 'GET') {
  const response = await fetch(base + path, { method });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not load local voice debugging.');
  return result;
}
const timestamp = (seconds) =>
  `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
export default function VoiceDebug({ initialId = '' }) {
  const [list, setList] = useState(null),
    [selected, setSelected] = useState(initialId),
    [detail, setDetail] = useState(null),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let stopped = false,
      timer;
    async function load() {
      try {
        const value = await request();
        if (stopped) return;
        setList(value);
        if (selected) {
          const row = await request('/' + selected);
          if (!stopped) setDetail(row);
        }
        setError('');
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(load, 3000);
    }
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected]);
  async function remove() {
    if (!selected) return;
    setDeleting(true);
    try {
      await request('/' + selected, 'DELETE');
      setSelected('');
      setDetail(null);
      setList(await request());
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  }
  return (
    <div className="modal-body browser-voice-test">
      <div className="info-box">
        <span>
          <strong>Local Whisper transcripts.</strong> Audio is recorded separately for you and the
          played assistant voice, then transcribed on this computer. These are local transcriptions,
          not provider transcript events. Recordings and transcripts remain until deleted here.
          Transcription can contain mistakes.
        </span>
      </div>
      {list && !list.available && (
        <p className="error">{list.reason || 'Local Whisper debugging is not configured.'}</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        <span>Debug session</span>
        <select
          aria-label="Debug session"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setDetail(null);
          }}
        >
          <option value="">Select a recorded session</option>
          {(list?.sessions || []).map((session) => (
            <option value={session.id} key={session.id}>
              {session.provider} · {session.status} ·{' '}
              {session.createdAt || session.created_at || session.id}
            </option>
          ))}
        </select>
      </label>
      {!list ? (
        <p>Loading debug sessions…</p>
      ) : (
        !list.sessions?.length && (
          <p>
            No debug recordings yet. Start a browser voice test with local debugging enabled, then
            end it to queue transcription.
          </p>
        )
      )}
      {selected && !detail && <p>Loading transcript…</p>}
      {detail && (
        <>
          <div className="voice-test-status">
            <strong>
              {detail.provider} · {detail.status}
            </strong>
            <span>
              <RefreshCw size={13} /> Refreshes every 3 seconds
            </span>
          </div>
          {detail.provider === 'twilio' && (
            <p className="info-box">
              For Twilio calls, assistant audio is the outbound stream with an estimated playback
              timeline. It is not a recording of what the handset actually played.
            </p>
          )}
          {detail.error && (
            <p className="error" role="alert">
              {detail.error}
            </p>
          )}
          <div className="form-grid">
            {['user', 'assistant'].map((speaker) => (
              <div key={speaker}>
                <p>
                  <strong>
                    {speaker === 'user'
                      ? 'Your recorded microphone'
                      : 'Recorded assistant playback'}
                  </strong>
                </p>
                <audio
                  controls
                  preload="none"
                  src={`${base}/${detail.id}/audio/${speaker}`}
                  style={{ width: '100%' }}
                  aria-label={
                    speaker === 'user' ? 'Your recorded microphone' : 'Recorded assistant playback'
                  }
                />
              </div>
            ))}
          </div>
          <section aria-label="Local Whisper transcript">
            <h3>Whisper transcript</h3>
            {detail.segments?.length ? (
              <ol className="demo-payment-schedule">
                {detail.segments.map((segment, index) => (
                  <li key={index}>
                    <strong>
                      {timestamp(segment.start)}–{timestamp(segment.end)} ·{' '}
                      {segment.speaker === 'user' ? 'You' : 'Assistant'}
                    </strong>
                    <p>{segment.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p>
                No local transcript is available yet. End the voice test and wait for its recordings
                to finish uploading and transcribing.
              </p>
            )}
          </section>
          {detail.events?.length > 0 && (
            <details>
              <summary>Debug event timeline</summary>
              <ol className="demo-payment-schedule">
                {detail.events.map((event, index) => (
                  <li key={index}>
                    {timestamp((event.timestampMs || 0) / 1000)} · {event.type}
                    {event.name ? ` · ${event.name}` : ''}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <button className="secondary" disabled={deleting} onClick={remove}>
            <Trash2 size={16} />
            {deleting ? 'Deleting…' : 'Delete recording and transcript'}
          </button>
        </>
      )}
    </div>
  );
}
