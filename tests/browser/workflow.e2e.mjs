import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

async function login(page) {
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'Every conversation, a new way forward.' }),
  ).toBeVisible();
}
test('portfolio → reviewed import → activation → pause/resume → progress and human follow-up persist', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await page.getByRole('button', { name: 'Portfolios', exact: true }).click();
  await page.getByRole('button', { name: 'New portfolio', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Portfolio name').fill('Piloto E2E Brasil');
  await dialog.getByLabel('Creditor', { exact: true }).fill('Creditor de teste');
  await dialog.getByRole('button', { name: 'Create portfolio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Piloto E2E Brasil' })).toBeVisible();
  await page.getByRole('button', { name: 'Import file', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Case file').setInputFiles(resolve('examples/carteira-br.csv'));
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog.getByLabel('Contract reference')).toHaveValue('referencia');
  await expect(dialog.getByText('Verification code', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Validate data', exact: true }).click();
  await expect(dialog.getByText('No valid contact details')).toBeVisible();
  await expect(dialog.getByText('Duplicate reference in this portfolio')).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 4 cases', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Cases', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open case EXEMPLO-001' })).toBeVisible();
  const imported = await (await page.request.get('/api/cases')).json();
  expect(imported.total).toBe(4);
  const portfolioId = imported.rows[0].portfolio_id;
  const portfolioState = async () =>
    (await page.request.get('/api/portfolios/' + portfolioId)).json();
  expect(imported.rows.find((c) => c.reference === 'EXEMPLO-001').amount_minor).toBe(123456);
  await expect(page.getByRole('button', { name: 'New campaign', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Campaigns', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Portfolios', exact: true }).click();
  await page.getByRole('button', { name: 'View progress', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Portfolio overview', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Activate demo portfolio', exact: true }).click();
  await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Pause portfolio', exact: true }).click();
  await expect(dialog.getByText('Paused', { exact: true })).toBeVisible();
  const paused = await portfolioState();
  expect(paused.status).toBe('paused');
  expect(paused.metrics.cases).toBe(4);
  const pausedStep = await page.request.post('/api/demo/step', {
    data: { outcome: 'paid_reported' },
  });
  expect((await pausedStep.json()).processed).toBe(0);
  expect((await portfolioState()).metrics.attempts).toBe(0);
  await page.reload();
  await page.getByRole('button', { name: 'Portfolios', exact: true }).click();
  await page.getByRole('button', { name: 'View progress', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Paused', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume portfolio', exact: true }).click();
  await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Simulate portfolio contact', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel("Person's response").selectOption('paid_reported');
  await dialog.getByRole('button', { name: 'Simulate next contact' }).click();
  await expect(dialog.getByRole('status')).toContainText('Simulated contact: Ana Exemplo');
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  const progress = await portfolioState();
  expect(progress.status).toBe('active');
  expect(progress.metrics).toMatchObject({
    cases: 4,
    attemptedCases: 1,
    attempts: 1,
    responses: 1,
    reviewCases: 1,
    openFollowups: 1,
    coveragePercent: 25,
    recoveredAmountMinor: null,
  });
  expect(progress.outcomes).toContainEqual({ outcome: 'paid_reported', count: 1 });
  await page.getByRole('button', { name: 'Portfolios', exact: true }).click();
  await page.getByRole('button', { name: 'View progress', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Portfolio progress', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('progressbar', { name: 'Contact coverage' })).toHaveAttribute(
    'value',
    '25',
  );
  await expect(dialog.getByText('Payment reported', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(/Agreements and reported payments are not verified recoveries/),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Agent tasks/ }).click();
  await page.getByText(/^Legacy follow-ups ·/).click();
  await expect(page.getByRole('cell', { name: 'Payment reported', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View record', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Assignee', { exact: true }).fill('Operador E2E');
  await dialog.getByRole('combobox', { name: 'Status', exact: true }).selectOption('done');
  await dialog
    .getByLabel('Notes / resolution', { exact: false })
    .fill('Solicitada conciliação ao credor. Saldo não alterado.');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await (await page.request.get('/api/cases')).json();
  const c = after.rows.find((c) => c.reference === 'EXEMPLO-001');
  expect(c.amount_minor).toBe(123456);
  expect(c.outcome).toBe('paid_reported');
  expect(c.review_required).toBe(1);
  await page.getByRole('button', { name: 'Cases', exact: true }).click();
  await page.getByRole('button', { name: 'Open case EXEMPLO-001' }).click();
  await expect(
    page.getByRole('dialog').getByText('Outcome recorded', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Every conversation, a new way forward.' }),
  ).toBeVisible();
  expect((await (await page.request.get('/api/dashboard')).json()).attempts).toBe(1);
  expect(errors).toEqual([]);
});

test('mobile navigation and policy form remain usable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByText('Demo environment')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Contact policy' })).toBeVisible();
  await page.getByLabel('Contact interval (hours)').fill('48');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('status')).toContainText('Contact policy updated');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  expect((await (await page.request.get('/api/settings')).json()).policy.gapHours).toBe(48);
});

test('browser voice entry is separate from simulation and explains missing OpenAI configuration', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Grok browser test', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browser voice test', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Fictional test case', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start microphone test' })).toBeDisabled();
  await expect(dialog.getByText(/Add an OpenAI API key/)).toBeVisible();
  await expect(dialog.getByText('BROWSER-TEST-001', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Twilio phone test is blocked without configuration and opens through its deep link', async ({
  page,
}) => {
  const errors = [];
  const outboundRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/twilio-test/calls'))
      outboundRequests.push(request.url());
  });
  await login(page);
  await expect(page.getByRole('button', { name: 'Browser voice test', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Twilio phone test', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('This makes a real phone call.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Phone test enabled', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Public HTTPS/WSS callback URL', { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Call my test number', exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel('I authorize a real call to this test number')).toBeDisabled();
  await expect(dialog.getByLabel('Approved test number').locator('option')).toHaveCount(1);
  await expect(dialog.getByText('Fictional test case', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.goto('/?twilioTest=1');
  await expect(
    dialog.getByRole('heading', { name: 'Twilio phone test', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Call my test number', exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  expect(outboundRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('GPT-Live identity confirmation continues backend work without interrupting live audio', async ({
  page,
}) => {
  const errors = [];
  let identityRequest;
  const openaiDebugUploads = [];
  let openaiDebugFinished = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.voiceSentEvents = [];
    window.voicePeerClosed = false;
    window.voiceChannelClosed = false;
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const output = context.createMediaStreamDestination();
      oscillator.connect(output);
      oscillator.start();
      window.voiceTestTrack = output.stream.getAudioTracks()[0];
      window.voiceTestStream = output.stream;
      return output.stream;
    };
    window.RTCPeerConnection = class {
      constructor() {
        this.iceGatheringState = 'complete';
        this.connectionState = 'new';
      }
      addTrack() {}
      createDataChannel() {
        const channel = {
          readyState: 'connecting',
          send(data) {
            window.voiceSentEvents.push(JSON.parse(data));
          },
          close() {
            this.readyState = 'closed';
            window.voiceChannelClosed = true;
            this.onclose?.();
          },
        };
        window.voiceTestChannel = channel;
        return channel;
      }
      async createOffer() {
        return { type: 'offer', sdp: 'fake-browser-offer' };
      }
      async setLocalDescription(description) {
        this.localDescription = description;
      }
      async setRemoteDescription() {
        this.connectionState = 'connected';
        window.voiceTestChannel.readyState = 'open';
        window.voiceTestChannel.onopen?.();
        this.ontrack?.({ streams: [window.voiceTestStream], track: window.voiceTestTrack });
      }
      close() {
        this.connectionState = 'closed';
        window.voicePeerClosed = true;
      }
    };
    window.emitVoiceEvent = (event) =>
      window.voiceTestChannel.onmessage({ data: JSON.stringify(event) });
  });
  await page.route(/\/api\/voice-test(?:\/.*)?$/, async (route) => {
    const req = route.request();
    if (req.url().endsWith('/tool')) {
      identityRequest = route;
      return;
    }
    if (req.method() === 'DELETE') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (req.method() === 'POST') {
      await route.fulfill({ status: 201, json: { id: 'fake-live-test', sdp: 'fake-live-answer' } });
      return;
    }
    await route.fulfill({
      json: {
        available: true,
        model: 'gpt-live-1',
        maxSeconds: 300,
        case: {
          name: 'Ana Silva',
          creditor: 'Fictional bank',
          reference: 'BROWSER-TEST-001',
          amount_minor: 125000,
          due_date: '2026-08-01',
        },
      },
    });
  });
  await page.route(/\/api\/voice-debug(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    expect([
      '/api/voice-debug/sessions',
      '/api/voice-debug/openai-debug-fake',
      '/api/voice-debug/openai-debug-fake/audio',
      '/api/voice-debug/openai-debug-fake/events',
      '/api/voice-debug/openai-debug-fake/finish',
    ]).toContain(url.pathname);
    if (url.pathname.endsWith('/audio')) {
      openaiDebugUploads.push({
        speaker: url.searchParams.get('speaker'),
        bytes: req.postDataBuffer().length,
      });
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname.endsWith('/events')) {
      const events = req.postDataJSON().events;
      expect(events.some((event) => event.type === 'rate_limits.updated')).toBe(false);
      expect(
        events.every(
          (event) =>
            /^(session|response|test|input_audio_buffer|tool|recording|playback|connection)[._a-z0-9-]{0,100}$/.test(
              event.type,
            ) && event.timestampMs <= 300000,
        ),
      ).toBe(true);
      // Optional diagnostic events must never prevent recorded audio from uploading.
      await route.fulfill({ status: 503, json: { error: 'Timeline temporarily unavailable.' } });
      return;
    }
    if (url.pathname.endsWith('/finish')) {
      openaiDebugFinished = true;
      await route.fulfill({ json: { status: 'queued' } });
      return;
    }
    if (req.method() === 'POST') {
      await route.fulfill({ json: { id: 'openai-debug-fake' } });
      return;
    }
    await route.fulfill({ json: { enabled: true, available: true, sessions: [] } });
  });
  await login(page);
  await page.getByRole('button', { name: 'Browser voice test', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Start microphone test', exact: true }).click();
  await expect(dialog.locator('.voice-test-status')).toContainText('Waiting for GPT-Live to start');
  await page.evaluate(() =>
    window.emitVoiceEvent({ type: 'session.started', session: { id: 'live_fake' } }),
  );
  const greetingId = await page.evaluate(
    () =>
      window.voiceSentEvents.find((event) => event.type === 'session.instructions.append').event_id,
  );
  await page.evaluate(
    (id) => window.emitVoiceEvent({ type: 'session.instructions.appended', client_event_id: id }),
    greetingId,
  );
  await expect
    .poll(() => page.evaluate(() => window.voiceSentEvents.map((event) => event.type)))
    .toEqual(['session.instructions.append', 'session.commentary.append']);
  await page.evaluate(() => {
    window.emitVoiceEvent({ type: 'rate_limits.updated' });
    window.emitVoiceEvent({
      type: 'session.output_transcript.delta',
      delta: 'Thank you, I can help with that.',
      start_ms: 1000,
      end_ms: 2500,
    });
    window.emitVoiceEvent({
      type: 'response.event',
      delegation_id: 'delegation_identity',
      event: { type: 'response.created', response: { id: 'response_identity' } },
    });
    window.emitVoiceEvent({
      type: 'response.event',
      delegation_id: 'delegation_identity',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_identity',
          name: 'confirm_identity',
          arguments: '{"confirmed":true,"name":"Ana Silva"}',
        },
      },
    });
    window.emitVoiceEvent({
      type: 'response.event',
      delegation_id: 'delegation_identity',
      event: { type: 'response.completed', response: { id: 'response_identity', output: [] } },
    });
  });
  await expect.poll(() => !!identityRequest).toBe(true);
  expect(identityRequest.request().postDataJSON()).toEqual({
    name: 'confirm_identity',
    args: { confirmed: true, name: 'Ana Silva' },
    callId: 'call_identity',
  });
  expect(await page.evaluate(() => window.voiceSentEvents.length)).toBe(2);
  await expect(dialog.locator('audio')).toHaveJSProperty('paused', false);
  await expect(dialog.locator('.voice-test-status')).toContainText('0:01');
  await identityRequest.fulfill({
    json: { confirmed: true, identityMethod: 'self_reported_name' },
  });
  await expect(
    dialog.getByText('Name confirmed by self-report for this test.', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.voiceSentEvents.slice(2).map((event) => event.type)))
    .toEqual(['response.item.create', 'response.create']);
  const transmitted = await page.evaluate(() => window.voiceSentEvents);
  expect(transmitted[2].item.type).toBe('function_call_output');
  expect(transmitted[2].item.call_id).toBe('call_identity');
  expect(JSON.parse(transmitted[2].item.output).confirmed).toBe(true);
  expect(transmitted.filter((event) => event.type === 'session.instructions.append')).toHaveLength(
    1,
  );
  expect(transmitted.filter((event) => event.type === 'session.commentary.append')).toHaveLength(1);
  expect(transmitted.filter((event) => event.type === 'session.thinking.append')).toHaveLength(0);
  expect(
    await page.evaluate(() => ({
      peerClosed: window.voicePeerClosed,
      channelClosed: window.voiceChannelClosed,
      trackState: window.voiceTestTrack.readyState,
    })),
  ).toEqual({ peerClosed: false, channelClosed: false, trackState: 'live' });
  await expect(dialog.locator('audio')).toHaveJSProperty('paused', false);
  await expect(dialog.locator('.voice-test-status')).toContainText('Connected');
  expect(errors).toEqual([]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.voiceTestTrack.readyState)).toBe('ended');
  await expect.poll(() => openaiDebugFinished).toBe(true);
  expect(openaiDebugUploads.map((upload) => upload.speaker).sort()).toEqual(['assistant', 'user']);
  expect(openaiDebugUploads.every((upload) => upload.bytes > 0)).toBe(true);
});

test('voice debug UI paths match the authenticated backend routes', async ({ page }) => {
  await login(page);
  const listing = await page.request.get('/api/voice-debug/sessions');
  expect(listing.status()).toBe(200);
  expect((await listing.json()).sessions).toEqual(expect.any(Array));
  const id = '00000000-0000-0000-0000-000000000000';
  const root = '/api/voice-debug/' + id;
  const responses = [
    await page.request.get(root),
    await page.request.get(root + '/audio/assistant'),
    await page.request.post(root + '/audio?speaker=user&offsetMs=0', {
      headers: { 'Content-Type': 'audio/webm' },
      data: Buffer.from('not-a-recording'),
    }),
    await page.request.post(root + '/events', { data: { events: [] } }),
    await page.request.post(root + '/finish', { data: {} }),
    await page.request.delete(root),
  ];
  for (const response of responses) {
    expect(response.status()).toBe(404);
    expect((await response.json()).error).toBe('Debug recording not found.');
  }
});
