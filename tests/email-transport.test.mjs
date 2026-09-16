import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailTransport } from '../server/email-transport.mjs';

const config = {
  gmailClientId: 'client',
  gmailClientSecret: 'secret',
  gmailRefreshToken: 'refresh',
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function harness(handler = () => response({ id: 'sent-1', threadId: 'thread-1' })) {
  const calls = [];
  const transport = createGmailTransport(config, {
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      if (url.includes('oauth2.googleapis.com'))
        return response({ access_token: 'token', expires_in: 3600 });
      if (url.endsWith('/profile')) return response({ emailAddress: 'louiz@rescova.de' });
      return handler(url, init);
    },
  });
  return { transport, calls };
}
const message = {
  id: 'delivery-123',
  subject: '[Demo] Payment options — Ana',
  text: 'Hello Ana, here are your options.',
};

test('Gmail transport pins sender and recipient, encodes MIME attachments, and preserves reply thread headers', async () => {
  const { transport, calls } = harness();
  const first = await transport.send({
    ...message,
    threadId: 'thread-1',
    inReplyTo: '<prior@rescova.de>',
    references: ['<first@rescova.de>', '<prior@rescova.de>'],
    attachments: [
      { filename: 'agreement.txt', mimeType: 'text/plain', content: 'Fictional agreement' },
    ],
  });
  assert.equal(first.status, 'submitted');
  const payload = JSON.parse(calls.at(-1).body);
  assert.equal(payload.threadId, 'thread-1');
  const mime = Buffer.from(payload.raw, 'base64url').toString();
  assert.match(mime, /To: louiz@rescova.de/);
  assert.match(mime, /From: Rescova Marina <louiz@rescova.de>/);
  assert.match(mime, /X-Rescova-Delivery: delivery-123/);
  assert.match(mime, /In-Reply-To: <prior@rescova.de>/);
  assert.match(mime, /References: <first@rescova.de> <prior@rescova.de>/);
  assert.match(mime, /Content-Disposition: attachment; filename="agreement.txt"/);
  assert.ok(mime.includes(Buffer.from('Fictional agreement').toString('base64')));
  assert.ok(mime.includes(Buffer.from(message.subject).toString('base64')));
  const second = await transport.send(message);
  assert.equal(first.messageId, second.messageId);
  assert.equal(calls.filter((item) => item.url.includes('oauth2.googleapis.com')).length, 1);
  assert.equal(calls.filter((item) => item.url.endsWith('/profile')).length, 1);
});

test('Gmail transport rejects arbitrary addresses, header injection and invalid attachments before network access', async () => {
  const { transport, calls } = harness();
  for (const patch of [
    { to: 'someone@example.com' },
    { cc: ['someone@example.com'] },
    { subject: 'x\r\nBcc: secret@example.com' },
    { id: 'bad id' },
    { references: 'injected' },
    { threadId: 'thread' },
    { attachments: [{ filename: 'x\nTo: evil', content: 'a' }] },
  ]) {
    await assert.rejects(transport.send({ ...message, ...patch }));
  }
  assert.equal(calls.length, 0);
});

test('Gmail verifies exact Workspace mailbox before sending and does not expose provider secrets', async () => {
  const calls = [];
  const transport = createGmailTransport(config, {
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes('oauth2')
        ? response({ access_token: 'token' })
        : response({ emailAddress: 'other@example.com' });
    },
  });
  await assert.rejects(transport.send(message), /must be connected as louiz@rescova.de/);
  assert.equal(calls.length, 2);
  assert.equal(transport.status().configured, true);
  assert.equal(createGmailTransport({}).status().configured, false);
  await assert.rejects(createGmailTransport({}).send(message), /not configured/);
});

test('Gmail transport normalizes replies and flags outgoing mail, autoresponses, DSNs without reading attachments', async () => {
  const msg = (id, headers, mimeType = 'multipart/mixed') => ({
    id,
    threadId: 'thread-1',
    internalDate: '1000',
    payload: {
      mimeType,
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Can I pay in installments?').toString('base64url') },
        },
        {
          filename: 'secret.txt',
          mimeType: 'text/plain',
          body: { data: Buffer.from('Attachment not part of reply').toString('base64url') },
        },
      ],
    },
  });
  const { transport } = harness(() =>
    response({
      messages: [
        msg('reply', {
          From: 'Louiz <louiz@rescova.de>',
          To: 'louiz@rescova.de',
          'Message-ID': '<reply@example.com>',
          'In-Reply-To': '<sent@rescova.de>',
          References: '<sent@rescova.de>',
        }),
        msg('own', { 'X-Rescova-Delivery': 'delivery-123', 'Auto-Submitted': 'auto-generated' }),
        msg('auto', { 'Auto-Submitted': 'auto-replied' }),
        msg('dsn', { From: 'mailer-daemon@example.com' }, 'multipart/report'),
      ],
    }),
  );
  const messages = await transport.getThread('thread-1');
  assert.equal(messages[0].automatic, false);
  assert.equal(messages[0].text, 'Can I pay in installments?');
  assert.equal(messages[0].messageId, '<reply@example.com>');
  assert.equal(messages[0].date, '1970-01-01T00:00:01.000Z');
  assert.equal(messages[1].ownDeliveryId, 'delivery-123');
  assert.ok(messages.slice(1).every((item) => item.automatic));
});

test('Gmail sends are never retried and ambiguous network/server/malformed success outcomes are marked uncertain', async () => {
  for (const handler of [
    () => {
      throw new Error('secret token');
    },
    () => response({ error: 'secret' }, 503),
    () => response({}),
    () => new Response('invalid'),
  ]) {
    const { transport, calls } = harness(handler);
    await assert.rejects(
      transport.send(message),
      (error) => error.uncertain === true && !error.message.includes('secret'),
    );
    assert.equal(calls.filter((item) => item.url.endsWith('/messages/send')).length, 1);
  }
  const { transport } = harness(() => response({ error: 'secret' }, 403));
  await assert.rejects(
    transport.send(message),
    (error) => error.uncertain === false && !error.message.includes('secret'),
  );
});

test('Gmail rejects oversized thread history rather than silently skipping messages', async () => {
  const { transport } = harness(() => response({ messages: Array(201).fill({}) }));
  await assert.rejects(transport.getThread('thread-1'), /message limit/);
  await assert.rejects(transport.getThread('../profile'), /Invalid thread/);
});

test('Gmail revalidates delivery after authorization and never sends when beforeSend rejects', async () => {
  const { transport, calls } = harness();
  await assert.rejects(
    transport.send({
      ...message,
      beforeSend: async () => {
        assert.equal(calls.at(-1).url.endsWith('/profile'), true);
        throw new Error('Conversation paused');
      },
    }),
    /Conversation paused/,
  );
  assert.equal(
    calls.some((item) => item.url.endsWith('/messages/send')),
    false,
  );
  let checked = false;
  await transport.send({
    ...message,
    beforeSend: async () => {
      checked = true;
    },
  });
  assert.equal(checked, true);
});
