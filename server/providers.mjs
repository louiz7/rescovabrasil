import { createHmac, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { clean, assert } from './domain.mjs';

export function configuration(env = process.env) {
  const mode = env.OUTREACH_MODE === 'live' ? 'live' : 'demo';
  const publicUrl = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const agentProfile = (role, defaultModel) => {
    const provider = env[`AGENT_${role}_PROVIDER`] || 'openai';
    return {
      provider,
      model: env[`AGENT_${role}_MODEL`] || defaultModel,
      baseUrl:
        env[`AGENT_${role}_BASE_URL`] ||
        (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'),
      apiKey:
        env[`AGENT_${role}_API_KEY`] ||
        (provider === 'openrouter'
          ? env.OPENROUTER_API_KEY
          : provider === 'openai'
            ? env.OPENAI_API_KEY
            : ''),
    };
  };
  return {
    agentWorkflowsEnabled: env.AGENT_WORKFLOWS_ENABLED === 'true',
    agentSms: agentProfile('SMS', 'gpt-5.6-luna'),
    agentSupervisor: agentProfile('SUPERVISOR', 'gpt-5.6-terra'),
    agentTimeoutMs: 30000,
    appWorkersEnabled: env.APP_WORKERS_ENABLED !== 'false',
    agentWorkerConcurrency: Math.max(1, Math.min(32, Number(env.AGENT_WORKER_CONCURRENCY) || 4)),
    emailWorkerConcurrency: Math.max(1, Math.min(16, Number(env.EMAIL_WORKER_CONCURRENCY) || 2)),
    workerLeaseMs: Math.max(5000, Number(env.WORKER_LEASE_MS) || 60000),
    workerBatchSize: Math.max(1, Math.min(200, Number(env.WORKER_BATCH_SIZE) || 40)),
    documentIngestConcurrency: Math.max(
      1,
      Math.min(4, Number(env.DOCUMENT_INGEST_CONCURRENCY) || 1),
    ),
    documentStorageDir: env.DOCUMENT_STORAGE_DIR || 'data/documents',
    documentOcrLanguage: env.DOCUMENT_OCR_LANGUAGE || 'eng',
    documentPdftoppmPath: env.DOCUMENT_PDFTOPPM_PATH || '/opt/homebrew/bin/pdftoppm',
    documentTesseractPath: env.DOCUMENT_TESSERACT_PATH || '/opt/homebrew/bin/tesseract',
    mode,
    port: Number(env.PORT || 3001),
    host: env.HOST || '127.0.0.1',
    publicUrl,
    password: env.OPERATOR_PASSWORD || (mode === 'demo' ? 'rescova-demo' : ''),
    liveEnabled: env.LIVE_SEND_ENABLED === 'true',
    twilioTestEnabled: env.TWILIO_TEST_ENABLED === 'true',
    allowlist: (env.OUTBOUND_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    fromPhone: env.TWILIO_PHONE_NUMBER,
    openaiKey: env.OPENAI_API_KEY,
    voiceDebugEnabled: env.VOICE_DEBUG_ENABLED === 'true',
    whisperPython: env.WHISPER_PYTHON || '',
    whisperModel: env.WHISPER_MODEL || '',
    ffmpegPath: env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg',
    voiceDebugDir: env.VOICE_DEBUG_DIR || 'data/voice-debug',
    realtimeModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
    liveModel: env.OPENAI_LIVE_MODEL || 'gpt-live-1',
    liveBackendModel: env.OPENAI_LIVE_BACKEND_MODEL || 'gpt-5.6-terra',
    emailTestEnabled: env.EMAIL_TEST_ENABLED === 'true',
    gmailClientId: env.GMAIL_CLIENT_ID || '',
    gmailClientSecret: env.GMAIL_CLIENT_SECRET || '',
    gmailRefreshToken: env.GMAIL_REFRESH_TOKEN || '',
    sendgridKey: env.SENDGRID_API_KEY,
    fromEmail: env.EMAIL_FROM,
    replyEmail: env.EMAIL_REPLY_TO,
    sendgridPublicKey: env.SENDGRID_EVENT_PUBLIC_KEY,
    inboundSecret: env.EMAIL_INBOUND_SECRET,
    dbPath: env.DATABASE_URL || env.DATABASE_PATH || `data/rescova-${mode}.sqlite`,
  };
}
export function capabilities(config) {
  const global =
    config.mode === 'demo'
      ? null
      : !config.liveEnabled
        ? 'Live sending is disabled in configuration'
        : !/^https:\/\//.test(config.publicUrl)
          ? 'Configure PUBLIC_BASE_URL with HTTPS'
          : !config.allowlist.length
            ? 'Configure authorized test recipients'
            : null;
  const cap = (available, reason) => ({
    available: !global && available,
    reason: global || (available ? null : reason),
  });
  const twilio = !!(config.accountSid && config.authToken && config.fromPhone);
  return {
    sms: cap(config.mode === 'demo' || twilio, 'Configure Twilio and an SMS-enabled number'),
    voice: cap(
      config.mode === 'demo' || (twilio && config.openaiKey),
      'Configure Twilio Voice and OpenAI',
    ),
    email: cap(
      config.mode === 'demo' ||
        !!(
          config.sendgridKey &&
          config.fromEmail &&
          config.replyEmail &&
          config.inboundSecret &&
          config.sendgridPublicKey
        ),
      'Configure SendGrid, sender, replies and event signatures',
    ),
    whatsapp: {
      available: false,
      reason: 'WhatsApp policy restricts debt collection; sending blocked',
    },
  };
}
export const xmlEscape = (v) =>
  String(v).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
export function neutralMessage(name) {
  return `Olá${name ? ', ' + name.split(' ')[0] : ''}. Aqui é a Rescova, assistente de atendimento. Gostaríamos de falar com você em particular. Você pode responder para solicitar atendimento humano. Para não receber novos contatos, responda SAIR. Não solicitamos senhas ou dados bancários.`;
}
export function twilioSignature(token, url, params = {}) {
  let data = url;
  for (const key of Object.keys(params).sort())
    for (const value of [
      ...new Set(Array.isArray(params[key]) ? params[key] : [params[key]]),
    ].sort())
      data += key + value;
  return createHmac('sha1', token).update(data).digest('base64');
}
export function safeEqual(a, b) {
  const x = Buffer.from(a || ''),
    y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
export function validTwilio(config, url, params, signature) {
  return !!config.authToken && safeEqual(twilioSignature(config.authToken, url, params), signature);
}
export function validSendgrid(config, raw, timestamp, signature) {
  if (
    !config.sendgridPublicKey ||
    !timestamp ||
    !signature ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 600
  )
    return false;
  try {
    return verifySignature(
      'sha256',
      Buffer.concat([Buffer.from(timestamp), raw]),
      { key: Buffer.from(config.sendgridPublicKey, 'base64'), format: 'der', type: 'spki' },
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}
export async function dispatch(config, attempt, c, fetchImpl = fetch) {
  assert(config.mode === 'live' && config.liveEnabled, 'Live sending is disabled.');
  assert(capabilities(config)[attempt.channel]?.available, 'Channel unavailable.');
  assert(
    config.allowlist.includes(attempt.destination.toLowerCase()),
    'Recipient is not on the authorized test allowlist.',
  );
  const message = neutralMessage(c.name);
  if (attempt.channel === 'email') {
    const response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.sendgridKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [
          { to: [{ email: attempt.destination }], custom_args: { attempt_id: attempt.id } },
        ],
        from: { email: config.fromEmail, name: 'Rescova' },
        reply_to: { email: config.replyEmail },
        subject: 'Atendimento Rescova',
        content: [{ type: 'text/plain', value: message }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    assert(response.ok, `SendGrid did not confirm sending (HTTP ${response.status}).`);
    return { status: 'accepted', sid: response.headers.get('x-message-id') || null, message };
  }
  const voice = attempt.channel === 'voice';
  const params = new URLSearchParams({
    To: attempt.destination,
    From: config.fromPhone,
    StatusCallback: `${config.publicUrl}/hooks/twilio/status/${attempt.id}`,
  });
  if (voice) {
    params.set('Url', `${config.publicUrl}/hooks/twilio/voice/${attempt.id}`);
    params.set('Timeout', '25');
    params.set('TimeLimit', '300');
    ['initiated', 'ringing', 'answered', 'completed'].forEach((v) =>
      params.append('StatusCallbackEvent', v),
    );
  } else params.set('Body', message);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/${voice ? 'Calls' : 'Messages'}.json`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(20000),
  });
  assert(response.ok, `Twilio did not confirm sending (HTTP ${response.status}).`);
  const result = await response.json();
  assert(typeof result.sid === 'string', 'Twilio returned a response without an identifier.');
  return { status: 'queued', sid: result.sid, message: voice ? null : message };
}
