import { readFile } from 'node:fs/promises';
import { createDecisionEngine } from '../server/decision-engine.mjs';
import { configuration } from '../server/providers.mjs';

const examples = JSON.parse(
  await readFile(new URL('../tests/fixtures/jev-inbound-eval.json', import.meta.url), 'utf8'),
);
const flags = [
  'contact_stop',
  'wrong_person',
  'debt_dispute',
  'payment_reported',
  'document_requested',
  'offer_acceptance',
];
const expectedContextByIntent = {
  payment_options: 'payment_terms',
  offer_acceptance: 'payment_terms',
  payment_report: 'payment_status',
  document_request: 'documents',
  case_question: 'case_details',
  dispute: 'case_details',
  wrong_person: 'none',
  contact_stop: 'none',
  other: 'none',
};
const engine = createDecisionEngine(configuration(process.env));
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < examples.length) {
    const example = examples[cursor++];
    const result = await engine.evaluateInboundTriage({
      message: { text: example.text, channel: 'sms', language: example.language },
      case: {
        status: 'ready',
        currency: 'BRL',
        hasAcceptedAgreement: false,
        presentedOfferCount: example.presentedOfferCount || 0,
        suppressed: false,
      },
      capabilities: [
        'answer_case_question',
        'present_payment_options',
        'accept_presented_offer',
        'retrieve_document',
      ],
    });
    results.push({ example, result });
  }
}

await Promise.all(Array.from({ length: 4 }, worker));
results.sort((a, b) => a.example.id.localeCompare(b.example.id));

const intentCorrect = results.filter(
  ({ example, result }) => result.answers.primary_intent.choice === example.intent,
).length;
const flagMetrics = Object.fromEntries(
  flags.map((flag) => {
    let truePositive = 0,
      falsePositive = 0,
      falseNegative = 0;
    for (const { example, result } of results) {
      const expected = Boolean(example.flags?.[flag]);
      const predicted = result.answers[flag].noul >= 0.5;
      if (expected && predicted) truePositive++;
      else if (!expected && predicted) falsePositive++;
      else if (expected) falseNegative++;
    }
    return [
      flag,
      {
        precision: truePositive / Math.max(1, truePositive + falsePositive),
        recall: truePositive / Math.max(1, truePositive + falseNegative),
        truePositive,
        falsePositive,
        falseNegative,
        errors: results
          .filter(({ example, result }) => {
            const expected = Boolean(example.flags?.[flag]);
            return result.answers[flag].noul >= 0.5 !== expected;
          })
          .map(({ example, result }) => ({
            id: example.id,
            expected: Boolean(example.flags?.[flag]),
            probability: result.answers[flag].noul,
          })),
      },
    ];
  }),
);
const intentAccuracy = intentCorrect / results.length;
const contextCorrect = results.filter(
  ({ example, result }) =>
    result.answers.context_source.choice ===
    (example.contextSource || expectedContextByIntent[example.intent]),
).length;
const contextAccuracy = contextCorrect / results.length;
const critical = ['contact_stop', 'wrong_person', 'debt_dispute', 'payment_reported'];
const passed =
  intentAccuracy >= 0.8 &&
  contextAccuracy >= 0.8 &&
  critical.every((flag) => flagMetrics[flag].recall === 1 && flagMetrics[flag].precision >= 0.8);
const failures = results
  .filter(({ example, result }) => result.answers.primary_intent.choice !== example.intent)
  .map(({ example, result }) => ({
    id: example.id,
    expected: example.intent,
    actual: result.answers.primary_intent.choice,
    confidence: result.answers.primary_intent.confidence,
  }));
const totalUsage = results.reduce(
  (usage, { result }) => ({
    inputTokens: usage.inputTokens + result.usage.input_tokens,
    outputTokens: usage.outputTokens + result.usage.output_tokens,
  }),
  { inputTokens: 0, outputTokens: 0 },
);

const escalationExamples = JSON.parse(
  await readFile(new URL('../tests/fixtures/jev-escalation-eval.json', import.meta.url), 'utf8'),
);
const escalationResults = [];
let escalationCursor = 0;
async function escalationWorker() {
  while (escalationCursor < escalationExamples.length) {
    const example = escalationExamples[escalationCursor++];
    const result = await engine.evaluateEscalationRouting({
      escalation: { reason: example.reason },
      case: example.case || {},
      capabilities: [
        'payment_verification_wait',
        'document_evidence_wait',
        'missing_information_wait',
        'policy_block',
        'supervisor_reasoning',
      ],
    });
    escalationResults.push({ example, result });
  }
}
await Promise.all(Array.from({ length: 4 }, escalationWorker));
escalationResults.sort((a, b) => a.example.id.localeCompare(b.example.id));
const escalationCorrect = escalationResults.filter(
  ({ example, result }) => result.proposedRoute.route === example.route,
).length;
const escalationAccuracy = escalationCorrect / escalationResults.length;
const escalationFailures = escalationResults
  .filter(({ example, result }) => result.proposedRoute.route !== example.route)
  .map(({ example, result }) => ({
    id: example.id,
    expected: example.route,
    actual: result.proposedRoute.route,
    confidence: result.proposedRoute.confidence,
  }));
const completePass = passed && escalationAccuracy >= 0.8;

console.log(
  JSON.stringify(
    {
      passed: completePass,
      model: [...new Set(results.map(({ result }) => result.model))],
      examples: results.length,
      intentAccuracy,
      contextAccuracy,
      flagMetrics,
      failures,
      totalUsage,
      averageLatencyMs: Math.round(
        results.reduce((sum, { result }) => sum + result.latencyMs, 0) / results.length,
      ),
      escalation: {
        examples: escalationResults.length,
        accuracy: escalationAccuracy,
        failures: escalationFailures,
        averageLatencyMs: Math.round(
          escalationResults.reduce((sum, { result }) => sum + result.latencyMs, 0) /
            escalationResults.length,
        ),
      },
    },
    null,
    2,
  ),
);
if (!completePass) process.exitCode = 1;
