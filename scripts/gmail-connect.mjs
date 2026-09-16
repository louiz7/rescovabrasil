import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first. See docs/EMAIL_TEST.md.',
  );
  process.exit(1);
}
const redirect = 'http://127.0.0.1:53682/oauth/google/callback';
const state = randomBytes(32).toString('hex');
const verifier = randomBytes(32).toString('base64url');
const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
url.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope:
    'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
  access_type: 'offline',
  prompt: 'consent',
  login_hint: 'louiz@rescova.de',
  state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
}).toString();
let processing = false;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const request = new URL(req.url, redirect);
  const returnedState = Buffer.from(request.searchParams.get('state') || '');
  if (
    request.pathname !== '/oauth/google/callback' ||
    returnedState.length !== state.length ||
    !timingSafeEqual(returnedState, Buffer.from(state))
  ) {
    res.writeHead(400);
    res.end('Invalid OAuth callback.');
    return;
  }
  if (processing) {
    res.writeHead(409);
    res.end('Connection already being processed.');
    return;
  }
  processing = true;
  try {
    if (!request.searchParams.get('code')) throw new Error('Authorization was not granted.');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: request.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error('Google did not authorize the connection. Check OAuth setup.');
    const tokens = await response.json();
    if (!tokens.refresh_token || !tokens.access_token)
      throw new Error('No offline refresh token returned. Reconnect with consent.');
    const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!profile.ok || (await profile.json()).emailAddress?.toLowerCase() !== 'louiz@rescova.de')
      throw new Error('Authorize the louiz@rescova.de mailbox only.');
    const env = await readFile('.env', 'utf8');
    const line = `GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`;
    await writeFile(
      '.env',
      /^GMAIL_REFRESH_TOKEN=.*$/m.test(env)
        ? env.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, () => line)
        : env + '\n' + line + '\n',
      { mode: 0o600 },
    );
    await chmod('.env', 0o600);
    res.end(
      'Google Workspace connected. Refresh token saved privately to .env. You can close this tab.',
    );
    console.log(
      'Connected louiz@rescova.de. Token saved to .env (not printed). Set EMAIL_TEST_ENABLED=true and restart the app when ready to test.',
    );
  } catch (error) {
    res.writeHead(400);
    res.end(error.message);
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    server.close();
  }
});
server.on('error', () => {
  console.error('Cannot start local OAuth callback on port 53682.');
  process.exitCode = 1;
  clearTimeout(timeout);
});
const timeout = setTimeout(() => {
  console.error('OAuth connection timed out. Run the command again.');
  server.close();
  process.exitCode = 1;
}, 5 * 60000);
server.listen(53682, '127.0.0.1', () => {
  console.log(
    'Opening Google authorization. Use louiz@rescova.de. If no browser opens, open this URL:\n' +
      url.toString(),
  );
  if (process.platform === 'darwin')
    spawn('open', [url.toString()], { stdio: 'ignore' }).on('error', () => {});
});
