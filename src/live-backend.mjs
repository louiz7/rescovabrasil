// GPT-Live owns speech. This helper continues only delegated Responses tool work.
export function createLiveBackend({ send, execute, onResult = () => {}, onError = () => {} }) {
  const responses = new Map();
  const currentByDelegation = new Map();
  const calls = new Map();
  const active = new Set();
  const commands = new Map();
  let closed = false;
  let continuing = null;
  let sequence = 0;
  const eventId = () => `live_backend_${++sequence}`;
  function emit(event, kind) {
    const id = eventId();
    if (send({ ...event, event_id: id }) === false) return null;
    commands.set(id, kind);
    return id;
  }
  function flush() {
    if (closed || active.size || continuing) return;
    const waiting = [...responses.values()].filter(
      (response) =>
        response.terminal && !response.failed && !response.continued && response.calls.size,
    );
    if (
      !waiting.length ||
      waiting.some((response) => [...response.calls].some((id) => !calls.get(id)?.settled))
    )
      return;
    for (const response of waiting) {
      for (const id of response.calls) {
        const call = calls.get(id);
        if (call.sent) continue;
        if (
          !emit(
            {
              type: 'response.item.create',
              item: {
                type: 'function_call_output',
                call_id: id,
                output: JSON.stringify(call.result),
              },
            },
            { type: 'tool', callId: id },
          )
        )
          return;
        call.sent = true;
      }
    }
    continuing = emit({ type: 'response.create' }, { type: 'continue' });
    if (continuing) for (const response of waiting) response.continued = true;
  }
  function handle(envelope) {
    if (closed) return;
    if (envelope.type === 'error') {
      const error = envelope.error || {};
      const command = commands.get(error.client_event_id);
      if (command?.type === 'continue' && error.client_event_id === continuing) continuing = null;
      // Do not automatically replay an operation whose acceptance is uncertain.
      onError(error.message || 'A GPT-Live command was rejected.');
      return;
    }
    if (envelope.type !== 'response.event' || !envelope.event) return;
    const event = envelope.event;
    const delegationId = envelope.delegation_id;
    if (event.type === 'response.created') {
      const id = event.response?.id;
      if (!id || responses.has(id)) return;
      continuing = null;
      responses.set(id, {
        id,
        delegationId,
        calls: new Set(),
        terminal: false,
        failed: false,
        continued: false,
      });
      currentByDelegation.set(delegationId, id);
      active.add(id);
      return;
    }
    const id = event.response?.id || event.response_id || currentByDelegation.get(delegationId);
    const response = responses.get(id);
    if (!response || response.delegationId !== delegationId) return;
    if (event.type === 'response.output_item.done') {
      const item = event.item;
      if (
        response.terminal ||
        item?.type !== 'function_call' ||
        !item.call_id ||
        calls.has(item.call_id)
      )
        return;
      const call = { settled: false, sent: false, result: null };
      calls.set(item.call_id, call);
      response.calls.add(item.call_id);
      Promise.resolve()
        .then(() => {
          if (closed) return;
          return execute({
            name: item.name,
            args: JSON.parse(item.arguments || '{}'),
            callId: item.call_id,
          });
        })
        .then((result) => {
          if (closed) return;
          call.result = result ?? { error: 'No tool result returned.' };
          call.settled = true;
          onResult({ name: item.name, callId: item.call_id, result: call.result });
          flush();
        })
        .catch((error) => {
          if (closed) return;
          call.result = { error: error.message || 'Tool execution failed.' };
          call.settled = true;
          onError(call.result.error);
          flush();
        });
    }
    if (
      [
        'response.completed',
        'response.failed',
        'response.incomplete',
        'response.cancelled',
        'response.canceled',
      ].includes(event.type)
    ) {
      if (response.terminal) return;
      response.terminal = true;
      response.failed = event.type !== 'response.completed';
      active.delete(id);
      if (response.failed)
        onError(
          event.response?.error?.message ||
            'Delegated work did not complete. The voice session remains connected.',
        );
      flush();
    }
  }
  return {
    handle,
    close() {
      closed = true;
      responses.clear();
      calls.clear();
      active.clear();
      commands.clear();
      currentByDelegation.clear();
    },
  };
}
