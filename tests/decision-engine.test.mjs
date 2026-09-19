import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine, INBOUND_TRIAGE_VERSION } from '../server/decision-engine.mjs';
import { openDb, one } from '../server/db.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { createAgentWorkflows } from '../server/agent-workflows.mjs';
import { createDecisionRuns } from '../server/decision-runs.mjs';

const answers = {
  primary_intent: {
    type: 'choice',
    choice: 'payment_options',
    confidence: 0.91,
    probabilities: { payment_options: 0.91, other: 0.09 },
  },
  contact_stop: { type: 'noul', noul: 0.01 },
  wrong_person: { type: 'noul', noul: 0.01 },
  debt_dispute: { type: 'noul', noul: 0.02 },
  payment_reported: { type: 'noul', noul: 0.03 },
  document_requested: { type: 'noul', noul: 0.05 },
  offer_acceptance: { type: 'noul', noul: 0.1 },
  context_source: {
    type: 'choice',
    choice: 'payment_terms',
    confidence: 0.93,
    probabilities: { payment_terms: 0.93, none: 0.07 },
  },
};

test('TypeSafe decision engine batches independent inbound judgments in one request', async () => {
  const calls = [];
  const client = {
    systemOne(request, options) {
      calls.push({ request, options });
      return Promise.resolve({
        model: 'jev-test',
        answers,
        usage: { input_tokens: 20, output_tokens: 8 },
      });
    },
  };
  const engine = createDecisionEngine(
    {
      decisionProvider: 'typesafe',
      typeSafeApiKey: 'test-key',
      typeSafeModel: 'jev-test',
      typeSafeTimeoutMs: 2500,
    },
    { client },
  );
  const result = await engine.evaluateInboundTriage({
    message: { text: 'Can I pay in installments?', channel: 'sms', language: 'en' },
    case: { presentedOfferCount: 0 },
  });
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].request.questions).length, 8);
  assert.equal(calls[0].request.questions.primary_intent.type, 'choice');
  assert.equal(calls[0].request.questions.contact_stop.type, 'noul');
  assert.equal(result.questionSet, INBOUND_TRIAGE_VERSION);
  assert.equal(result.proposedRoute.route, 'payment_options');
  assert.equal(result.proposedRoute.contextRoute, 'payment_terms');
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 8 });
});

test('TypeSafe decision engine routes standard escalation dependencies in one request', async () => {
  const calls = [];
  const client = {
    systemOne(request) {
      calls.push(request);
      return Promise.resolve({
        model: 'jev-test',
        answers: {
          route: {
            type: 'choice',
            choice: 'payment_verification',
            confidence: 0.96,
            probabilities: { payment_verification: 0.96, supervisor_reasoning: 0.04 },
          },
          requires_supervisor_reasoning: { type: 'noul', noul: 0.03 },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    },
  };
  const engine = createDecisionEngine(
    { decisionProvider: 'typesafe', typeSafeApiKey: 'test-key', typeSafeModel: 'jev-test' },
    { client },
  );
  const result = await engine.evaluateEscalationRouting({
    escalation: { reason: 'Payment requires verified provider evidence.' },
  });
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].questions).length, 2);
  assert.equal(result.proposedRoute.route, 'payment_verification');
  assert.equal(result.proposedRoute.requiresSupervisorProbability, 0.03);
});

test('shadow triage persists one decision without storing raw message or changing workflow', async (t) => {
  const db = openDb();
  const config = {
    mode: 'demo',
    agentWorkflowsEnabled: true,
    typeSafeShadowEnabled: true,
    typeSafeApiKey: 'test-key',
    decisionProvider: 'typesafe',
  };
  const source = { provider: 'openai', sessionId: 'decision-shadow-test' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const decisionStates = [];
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async () => ({ action: 'reply', text: 'Operational reply.' }),
    evaluateDecision: async (state) => {
      decisionStates.push(state);
      return {
        model: 'jev-test',
        answers,
        proposedRoute: { route: 'payment_options', confidence: 0.91 },
        usage: { input_tokens: 20, output_tokens: 8 },
        latencyMs: 4,
      };
    },
  });
  t.after(async () => {
    await workflow.closeAll();
    db.close();
  });
  const request = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'decision-shadow-document',
    deliveryChannel: 'virtual_sms',
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  await workflow.tick();
  const before = workflow.detail(request.conversationId).tasks.length;
  workflow.receiveInbound(request.conversationId, {
    text: 'Can I pay this in installments?',
    requestId: 'decision-shadow-inbound',
  });
  workflow.receiveInbound(request.conversationId, {
    text: 'Can I pay this in installments?',
    requestId: 'decision-shadow-inbound',
  });
  const peer = createDecisionRuns(db, config, {
    evaluateDecision: async (state) => {
      decisionStates.push(state);
      return {
        model: 'jev-test',
        answers,
        proposedRoute: { route: 'payment_options', confidence: 0.91 },
        usage: { input_tokens: 20, output_tokens: 8 },
        latencyMs: 4,
      };
    },
  });
  await Promise.all([workflow.tick(), peer.drain()]);
  await peer.close();

  assert.equal(decisionStates.length, 1);
  assert.equal(decisionStates[0].message.text, 'Can I pay this in installments?');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM decision_runs').n, 1);
  const decision = one(db, 'SELECT * FROM decision_runs');
  assert.equal(decision.status, 'completed');
  assert.equal(decision.applied_route, null);
  assert.equal(decision.proposed_route.includes('payment_options'), true);
  assert.equal(JSON.stringify(decision).includes('Can I pay this in installments?'), false);
  assert.equal(workflow.detail(request.conversationId).tasks.length, before + 1);
  assert.equal(workflow.detail(request.conversationId).messages.at(-1).body, 'Operational reply.');
});

test('failed active evaluation falls back to Marina and remains visible', async (t) => {
  const db = openDb();
  const config = {
    mode: 'demo',
    agentWorkflowsEnabled: true,
    typeSafeDecisionMode: 'active',
    typeSafeApiKey: 'test-key',
    decisionProvider: 'typesafe',
  };
  const source = { provider: 'openai', sessionId: 'decision-failure-test' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const triage = [];
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async ({ context }) => {
      if (context.semanticTriage) triage.push(context.semanticTriage);
      return { action: 'reply', text: 'Operational reply survived.' };
    },
    evaluateDecision: async () => {
      throw new Error('Synthetic TypeSafe outage');
    },
  });
  t.after(async () => {
    await workflow.closeAll();
    db.close();
  });
  const request = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'decision-failure-document',
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  await workflow.tick();
  workflow.receiveInbound(request.conversationId, {
    text: 'Can I pay in installments?',
    requestId: 'decision-failure-inbound',
  });
  await workflow.tick();

  const decision = one(db, 'SELECT * FROM decision_runs');
  assert.equal(decision.status, 'failed');
  assert.equal(decision.error, 'Synthetic TypeSafe outage');
  assert.equal(JSON.parse(decision.applied_route).route, 'marina_fallback');
  assert.equal(triage[0].reason, 'decision_unavailable');
  assert.equal(
    workflow.detail(request.conversationId).messages.at(-1).body,
    'Operational reply survived.',
  );
});

test('active triage is consumed before Marina generation and records applied route', async (t) => {
  const db = openDb();
  const config = {
    mode: 'demo',
    agentWorkflowsEnabled: true,
    typeSafeDecisionMode: 'active',
    typeSafeApiKey: 'test-key',
    typeSafeActiveMinConfidence: 0.75,
    decisionProvider: 'typesafe',
  };
  const source = { provider: 'openai', sessionId: 'decision-active-test' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const triage = [],
    preloaded = [];
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async ({ context }) => {
      if (context.semanticTriage) {
        triage.push(context.semanticTriage);
        preloaded.push(context.lookupResults);
      }
      return { action: 'reply', text: 'Active triage reply.' };
    },
    evaluateDecision: async () => ({
      model: 'jev-test',
      answers,
      proposedRoute: {
        route: 'payment_options',
        confidence: 0.91,
        contextRoute: 'payment_terms',
        contextConfidence: 0.93,
      },
      usage: { input_tokens: 20, output_tokens: 8 },
      latencyMs: 4,
    }),
  });
  t.after(async () => {
    await workflow.closeAll();
    db.close();
  });
  const request = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'decision-active-document',
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  await workflow.tick();
  workflow.receiveInbound(request.conversationId, {
    text: 'Can I pay in installments?',
    requestId: 'decision-active-inbound',
  });
  await workflow.tick();

  assert.equal(triage.length, 1);
  assert.equal(triage[0].route, 'payment_options');
  assert.equal(triage[0].flags.payment_reported, 0.03);
  assert.equal(preloaded[0][0].query.topic, 'payment_terms');
  const decision = one(db, 'SELECT * FROM decision_runs');
  assert.equal(JSON.parse(decision.applied_route).route, 'payment_options');
  assert.equal(
    workflow.detail(request.conversationId).messages.at(-1).body,
    'Active triage reply.',
  );
});

test('active critical triage resolves contact stop without a Marina model call', async (t) => {
  const db = openDb();
  const config = {
    mode: 'demo',
    agentWorkflowsEnabled: true,
    typeSafeDecisionMode: 'active',
    typeSafeApiKey: 'test-key',
    typeSafeActiveMinConfidence: 0.75,
  };
  const source = { provider: 'openai', sessionId: 'decision-direct-stop-test' };
  const saved = ensureDemoVoiceCase(db, config, source);
  let modelCalls = 0;
  const stopAnswers = structuredClone(answers);
  stopAnswers.primary_intent = {
    type: 'choice',
    choice: 'contact_stop',
    confidence: 0.98,
    probabilities: { contact_stop: 0.98, other: 0.02 },
  };
  stopAnswers.contact_stop = { type: 'noul', noul: 0.99 };
  stopAnswers.context_source = {
    type: 'choice',
    choice: 'none',
    confidence: 0.99,
    probabilities: { none: 0.99, case_details: 0.01 },
  };
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async () => {
      modelCalls++;
      return { action: 'reply', text: 'Initial document reply.' };
    },
    evaluateDecision: async () => ({
      model: 'jev-test',
      answers: stopAnswers,
      proposedRoute: {
        route: 'contact_stop',
        confidence: 0.98,
        contextRoute: 'none',
        contextConfidence: 0.99,
      },
      usage: { input_tokens: 20, output_tokens: 8 },
      latencyMs: 4,
    }),
  });
  t.after(async () => {
    await workflow.closeAll();
    db.close();
  });
  const request = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'decision-stop-document',
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  await workflow.tick();
  assert.equal(modelCalls, 1);
  workflow.receiveInbound(request.conversationId, {
    text: 'Please remove this contact from your collection messages.',
    requestId: 'decision-direct-stop',
  });
  await workflow.tick();
  assert.equal(modelCalls, 1);
  assert.equal(workflow.detail(request.conversationId).conversation.status, 'opted_out');
  assert.match(workflow.detail(request.conversationId).messages.at(-1).body, /will not send/);
});

test('resolution router handles payment verification dependency without Rafael generation', async (t) => {
  const db = openDb();
  const config = {
    mode: 'demo',
    agentWorkflowsEnabled: true,
    typeSafeDecisionMode: 'active',
    typeSafeApiKey: 'test-key',
    typeSafeActiveMinConfidence: 0.75,
  };
  const source = { provider: 'openai', sessionId: 'decision-resolution-test' };
  const saved = ensureDemoVoiceCase(db, config, source);
  let modelCalls = 0;
  const paidAnswers = structuredClone(answers);
  paidAnswers.primary_intent = {
    type: 'choice',
    choice: 'payment_report',
    confidence: 0.98,
    probabilities: { payment_report: 0.98, other: 0.02 },
  };
  paidAnswers.payment_reported = { type: 'noul', noul: 0.99 };
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async () => {
      modelCalls++;
      return { action: 'reply', text: 'Initial document reply.' };
    },
    evaluateDecision: async () => ({
      model: 'jev-test',
      answers: paidAnswers,
      proposedRoute: {
        route: 'payment_report',
        confidence: 0.98,
        contextRoute: 'payment_status',
        contextConfidence: 0.96,
      },
      usage: { input_tokens: 20, output_tokens: 8 },
      latencyMs: 4,
    }),
    evaluateEscalationDecision: async () => ({
      model: 'jev-test',
      answers: {
        route: {
          type: 'choice',
          choice: 'payment_verification',
          confidence: 0.97,
          probabilities: { payment_verification: 0.97, supervisor_reasoning: 0.03 },
        },
        requires_supervisor_reasoning: { type: 'noul', noul: 0.02 },
      },
      proposedRoute: {
        route: 'payment_verification',
        confidence: 0.97,
        requiresSupervisorProbability: 0.02,
      },
      usage: { input_tokens: 10, output_tokens: 3 },
      latencyMs: 3,
    }),
  });
  t.after(async () => {
    await workflow.closeAll();
    db.close();
  });
  const request = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'decision-resolution-document',
  });
  workflow.sourceEnded(source.provider, source.sessionId);
  await workflow.tick();
  assert.equal(modelCalls, 1);
  workflow.receiveInbound(request.conversationId, {
    text: 'I already paid this by Pix.',
    requestId: 'decision-payment-report',
  });
  await workflow.tick();
  assert.equal(modelCalls, 1);
  assert.equal(
    workflow.detail(request.conversationId).conversation.resolution.status,
    'awaiting_specialist',
  );
  assert.equal(
    workflow.detail(request.conversationId).conversation.resolution.owner,
    'resolution_router',
  );
  assert.equal(one(db, "SELECT COUNT(*) n FROM agent_model_runs WHERE role='supervisor'").n, 0);
  assert.equal(workflow.agentStats().supervisor.completed, 0);
  assert.equal(
    one(db, 'SELECT resolved_by FROM agent_jobs WHERE purpose=?', 'supervisor_review').resolved_by,
    'resolution_router',
  );
  assert.equal(one(db, 'SELECT status FROM decision_role_runs').status, 'completed');
});

test('disabled shadow mode records no decisions', async (t) => {
  const db = openDb();
  const config = { mode: 'demo', agentWorkflowsEnabled: true, typeSafeShadowEnabled: false };
  const source = { provider: 'openai', sessionId: 'decision-disabled-test' };
  const saved = ensureDemoVoiceCase(db, config, source);
  const workflow = createAgentWorkflows(db, config, {
    runAgent: async () => ({ action: 'reply', text: 'Operational reply.' }),
  });
  t.after(async () => {
    await workflow.closeAll();
    db.close();
  });
  const request = workflow.documentRequested({
    ...source,
    caseId: saved.caseId,
    kind: 'loan_agreement',
    requestId: 'decision-disabled-document',
  });
  workflow.receiveInbound(request.conversationId, {
    text: 'Send a statement.',
    requestId: 'decision-disabled-inbound',
  });
  assert.equal(one(db, 'SELECT COUNT(*) n FROM decision_runs').n, 0);
});
