// Transport-independent, session-local close coordination. Transcript inactivity is
// a bounded grace period, not proof of WebRTC playback completion. Twilio also
// checks its acknowledged playback queue before closing.
export function createLiveCallEnding({
  onClose,
  playbackPending = () => false,
  schedule = setTimeout,
  cancel = clearTimeout,
  quietMs = 3500,
  maxMs = 15000,
}) {
  let requested = false,
    settled = false,
    closed = false,
    quiet,
    deadline;
  function dispose() {
    cancel(quiet);
    cancel(deadline);
  }
  function finish(reason) {
    if (closed) return;
    closed = true;
    dispose();
    onClose(reason);
  }
  function activity() {
    if (!requested || !settled || closed) return;
    cancel(quiet);
    quiet = schedule(() => {
      if (playbackPending()) activity();
      else finish('caller_requested');
    }, quietMs);
    quiet?.unref?.();
  }
  return {
    request() {
      if (requested || closed) return;
      requested = true;
      settled = false;
      deadline = schedule(() => finish('close_grace_expired'), maxMs);
      deadline?.unref?.();
    },
    settled() {
      settled = true;
      activity();
    },
    activity,
    close() {
      closed = true;
      dispose();
    },
  };
}
