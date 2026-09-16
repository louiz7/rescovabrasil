import { createHash } from 'node:crypto';

const MAILBOX = 'louiz@rescova.de';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 2_000_000;

function failure(message, uncertain = false) {
  return Object.assign(new Error(message), { uncertain });
}
function header(value, name, max = 998) {
  const result = String(value || '');
  if (/[\r\n\0]/.test(result) || result.length > max) throw failure(`Invalid ${name}.`);
  return result;
}
function messageReferences(value) {
  const result = header(Array.isArray(value) ? value.join(' ') : value, 'message references');
  if (result && !/^(?:<[^<>\s]+@[^<>\s]+>)(?: +<[^<>\s]+@[^<>\s]+>)*$/.test(result))
    throw failure('Invalid message references.');
  return result;
}
function wrappedBase64(content) {
  return (
    Buffer.from(content)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') || ''
  );
}
function encodeMime(input) {
  const id = header(input.id, 'delivery ID', 200);
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw failure('Invalid delivery ID.');
  // Destinations are owned by this adapter, never supplied by a model or caller.
  for (const key of ['to', 'from', 'cc', 'bcc', 'recipient', 'sender']) {
    if (input[key] !== undefined) throw failure('Email test destinations cannot be overridden.');
  }
  const subject = header(input.subject, 'subject', 300);
  const digest = createHash('sha256').update(id).digest('hex');
  const messageId = `<rescova.${digest}@rescova.de>`;
  const boundary = `rescova_${digest}`;
  const references = messageReferences(input.references || input.inReplyTo);
  const inReplyTo = messageReferences(input.inReplyTo);
  const headers = [
    `From: Rescova Marina <${MAILBOX}>`,
    `To: ${MAILBOX}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `X-Rescova-Delivery: ${id}`,
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  const text = String(input.text || '');
  if (!text.trim() || Buffer.byteLength(text) > 100_000)
    throw failure('Email text is empty or too large.');
  const parts = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrappedBase64(text),
  ];
  const attachments = input.attachments || [];
  if (!Array.isArray(attachments) || attachments.length > 10)
    throw failure('Too many email attachments.');
  let bytes = Buffer.byteLength(text);
  for (const attachment of attachments) {
    const name = header(attachment.filename || 'document.txt', 'attachment filename', 180);
    const mimeType = header(attachment.mimeType || 'application/octet-stream', 'attachment type');
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType))
      throw failure('Invalid attachment type.');
    const content = Buffer.from(attachment.content || '');
    bytes += content.length;
    if (bytes > 5_000_000) throw failure('Email attachments are too large.');
    const safeName = name.replace(/[^a-zA-Z0-9._ -]/g, '_');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      '',
      wrappedBase64(content),
    );
  }
  parts.push(`--${boundary}--`, '');
  return { raw: Buffer.from(parts.join('\r\n')).toString('base64url'), messageId };
}
function bodyText(part, depth = 0) {
  if (!part || depth > 12 || part.filename) return '';
  if (part.mimeType === 'text/plain' && part.body?.data)
    return Buffer.from(part.body.data.slice(0, 140_000), 'base64url')
      .toString('utf8')
      .slice(0, 100_000);
  return (part.parts || [])
    .slice(0, 30)
    .map((child) => bodyText(child, depth + 1))
    .filter(Boolean)
    .join('\n')
    .slice(0, 100_000);
}
function normalize(message) {
  const headers = new Map(
    (message.payload?.headers || []).map((item) => [
      String(item.name).toLowerCase(),
      String(item.value),
    ]),
  );
  const get = (name) => headers.get(name) || '';
  const automatic = Boolean(
    (get('auto-submitted') && get('auto-submitted').toLowerCase() !== 'no') ||
    /^(bulk|list|junk)$/i.test(get('precedence')) ||
    get('x-autoreply') ||
    get('x-autorespond') ||
    /mailer-daemon|postmaster/i.test(get('from')) ||
    /multipart\/report|message\/delivery-status/i.test(get('content-type')) ||
    /multipart\/report|message\/delivery-status/i.test(message.payload?.mimeType || ''),
  );
  return {
    id: message.id,
    threadId: message.threadId,
    messageId: get('message-id'),
    inReplyTo: get('in-reply-to'),
    references: get('references'),
    from: get('from'),
    to: get('to'),
    subject: get('subject'),
    text: bodyText(message.payload),
    ownDeliveryId: get('x-rescova-delivery'),
    automatic,
    date:
      Number.isFinite(Number(message.internalDate)) && message.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : get('date'),
  };
}

export function createGmailTransport(config, { fetchImpl = fetch } = {}) {
  let token = null;
  let expiresAt = 0;
  let tokenPromise;
  let verified = false;
  const configured = Boolean(
    config.gmailClientId && config.gmailClientSecret && config.gmailRefreshToken,
  );
  async function jsonResponse(response, label, sending = false) {
    if (!response.ok)
      throw failure(
        `${label} failed (HTTP ${response.status}).`,
        sending && response.status >= 500,
      );
    try {
      const text = await response.text();
      if (text.length > MAX_BODY)
        throw failure(`${label} response exceeded the size limit.`, sending);
      return JSON.parse(text);
    } catch (error) {
      throw failure(`${label} returned an unreadable response.`, sending);
    }
  }
  async function accessToken() {
    if (!configured) throw failure('Gmail OAuth is not configured.');
    if (token && Date.now() < expiresAt) return token;
    if (!tokenPromise)
      tokenPromise = (async () => {
        let response;
        try {
          response = await fetchImpl('https://oauth2.googleapis.com/token', {
            method: 'POST',
            signal: AbortSignal.timeout(20_000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: config.gmailClientId,
              client_secret: config.gmailClientSecret,
              refresh_token: config.gmailRefreshToken,
              grant_type: 'refresh_token',
            }).toString(),
          });
        } catch {
          throw failure('Gmail authorization could not be reached.');
        }
        const data = await jsonResponse(response, 'Gmail authorization');
        if (!data.access_token) throw failure('Gmail authorization returned no access token.');
        token = data.access_token;
        expiresAt = Date.now() + Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000;
        return token;
      })().finally(() => {
        tokenPromise = null;
      });
    return tokenPromise;
  }
  async function request(path, body, beforeSend) {
    const authorization = await accessToken();
    // Revalidate durable workflow state after auth awaits, immediately before network delivery.
    if (beforeSend) await beforeSend();
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${authorization}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw failure('Gmail request could not be completed.', Boolean(body));
    }
    if (response.status === 401) {
      token = null;
      verified = false;
    }
    return jsonResponse(response, 'Gmail request', Boolean(body));
  }
  async function verifyMailbox() {
    const profile = await request('/profile');
    if (String(profile.emailAddress).toLowerCase() !== MAILBOX)
      throw failure('Gmail must be connected as louiz@rescova.de for this test.');
    verified = true;
    return { emailAddress: MAILBOX };
  }
  return {
    status: () => ({ configured, provider: 'gmail', sender: MAILBOX, recipient: MAILBOX }),
    verifyMailbox,
    async send(input) {
      const { raw, messageId } = encodeMime(input);
      const threadId = input.threadId ? header(input.threadId, 'thread ID', 100) : null;
      if (threadId && !/^[a-zA-Z0-9_-]+$/.test(threadId)) throw failure('Invalid thread ID.');
      if (threadId && !input.inReplyTo) throw failure('A thread reply requires In-Reply-To.');
      if (!verified) await verifyMailbox();
      const result = await request(
        '/messages/send',
        { raw, ...(threadId ? { threadId } : {}) },
        input.beforeSend,
      );
      if (!result.id || !result.threadId)
        throw failure('Gmail send returned no message identifiers.', true);
      return {
        providerMessageId: result.id,
        threadId: result.threadId,
        messageId,
        status: 'submitted',
      };
    },
    async getThread(threadId) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(threadId || '')))
        throw failure('Invalid thread ID.');
      if (!verified) await verifyMailbox();
      const result = await request(`/threads/${encodeURIComponent(threadId)}?format=full`);
      const messages = result.messages || [];
      if (!Array.isArray(messages) || messages.length > 200)
        throw failure('Gmail thread exceeded the message limit.');
      return messages.map(normalize);
    },
  };
}
