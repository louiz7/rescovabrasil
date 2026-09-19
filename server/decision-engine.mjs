import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';

export const INBOUND_TRIAGE_VERSION = 'inbound-triage-v1';
export const ESCALATION_ROUTING_VERSION = 'escalation-routing-v1';

const intentCriteria = {
  payment_options: 'The participant asks how, when, or through which method they can pay.',
  offer_acceptance:
    'The participant accepts or confirms a specific payment offer or installment plan.',
  payment_report: 'The participant says a payment was already made.',
  document_request:
    'The participant asks for a contract, statement, receipt, or another case document.',
  case_question:
    'The participant asks for information about the debt, creditor, balance, dates, or case.',
  dispute: 'The participant denies, challenges, or disputes the debt or its details.',
  wrong_person:
    'The participant says the contact belongs to someone else or denies being the named person.',
  contact_stop: 'The participant asks Rescova to stop contacting them.',
  other: 'No other category clearly describes the main intent.',
};

export function inboundTriageQuestions() {
  return {
    primary_intent: choice(
      'Choose the participant message primary intent. Use only `message.text` and supplied case state. Do not invent missing facts.',
      intentCriteria,
    ),
    contact_stop: noul('Does `message.text` ask Rescova to stop all further contact?', {
      true: 'An explicit request to stop, unsubscribe, opt out, or not be contacted.',
      false: 'No explicit request to stop all contact.',
    }),
    wrong_person: noul(
      'Does `message.text` state that this is the wrong person or wrong contact?',
      {
        true: 'The sender explicitly says the contacted phone, email, or person does not match the intended named person.',
        false:
          'No contact-identity mismatch. Denying or disputing the debt alone is not a wrong-person statement.',
      },
    ),
    debt_dispute: noul('Does `message.text` dispute the debt, ownership, balance, or obligation?', {
      true: 'The sender explicitly denies or challenges the validity, ownership, amount, or obligation.',
      false:
        'No explicit dispute. A question, payment report, payment difficulty, contact-stop request, or wrong-contact statement alone is not a debt dispute.',
    }),
    payment_reported: noul('Does `message.text` report that a payment was already made?', {
      true: 'The sender claims a completed payment, transfer, or settlement.',
      false: 'No completed payment is reported.',
    }),
    document_requested: noul('Does `message.text` request a case document or payment receipt?', {
      true: 'The sender asks Rescova to provide or resend a document.',
      false: 'No document is requested.',
    }),
    offer_acceptance: noul(
      'Does `message.text` accept a specific payment offer that the case state says was presented?',
      {
        true: 'Clear acceptance of a presented offer or installment plan.',
        false: 'No clear acceptance, or no presented offer exists.',
      },
    ),
    context_source: choice(
      'Choose the single most useful authoritative context source for answering `message.text`. Select none when the message needs no case lookup.',
      {
        none: 'No case lookup is needed, including clear contact stops, wrong-person notices, thanks, or small talk.',
        case_details:
          'Creditor, portfolio, reference, recorded balance, dates, identity, or general case facts.',
        payment_terms:
          'Authorized payment offers, installments, discounts, due dates, or agreement terms.',
        payment_status:
          'Reported, pending, received, allocated, refunded, reversed, or remaining payment state.',
        documents: 'Available contracts, statements, receipts, attachments, or document metadata.',
        activity: 'Previous contact attempts, follow-ups, outcomes, or communication activity.',
        conversation_history:
          'Earlier statements or commitments made in this cross-channel conversation.',
      },
    ),
  };
}

export function escalationRoutingQuestions() {
  return {
    route: choice(
      'Choose the narrowest existing capability that can resolve the escalation. Do not invent capabilities or authorize external or financial actions.',
      {
        payment_verification:
          'The participant reports payment and the case must wait for verified payment-provider evidence.',
        document_wait:
          'A required document is missing or ambiguous and the case must wait for case-scoped evidence.',
        missing_information:
          'A specific factual input is missing and a participant or source update is required.',
        policy_block:
          'The requested action is outside authorized terms, contact policy, recipient identity, or available capabilities.',
        supervisor_reasoning:
          'The case contains a genuine contradiction, complex dispute, or uncertain strategy that needs Rafael reasoning.',
      },
    ),
    requires_supervisor_reasoning: noul(
      'Does resolving this escalation require open-ended case reasoning by Rafael rather than one defined dependency state?',
      {
        true: 'Evidence conflicts, policy interpretation is ambiguous, or no defined dependency route is sufficient.',
        false:
          'A defined payment, document, information, or policy dependency fully represents the next step.',
      },
    ),
  };
}

function routeCandidate(answers) {
  const intent = answers.primary_intent;
  return {
    route: intent.choice,
    confidence: intent.confidence,
    probabilities: intent.probabilities,
    contextRoute: answers.context_source.choice,
    contextConfidence: answers.context_source.confidence,
  };
}

export function createDecisionEngine(config, { client } = {}) {
  const provider = config.decisionProvider || 'typesafe';
  if (provider !== 'typesafe') throw new Error(`Unsupported decision provider: ${provider}`);
  const available = Boolean(config.typeSafeApiKey);
  let sdk = client;

  function getClient() {
    if (!available) throw new Error('TypeSafe decision provider is not configured.');
    if (!sdk)
      sdk = new TypeSafeClient({
        apiKey: config.typeSafeApiKey,
        baseURL: config.typeSafeBaseUrl || undefined,
        defaultModel: config.typeSafeModel || 'jev-latest',
        timeout: config.typeSafeTimeoutMs || 10000,
        logLevel: 'warn',
      });
    return sdk;
  }

  return {
    provider,
    available,
    async evaluateInboundTriage(state, { signal } = {}) {
      const started = Date.now();
      const result = await getClient().systemOne(
        {
          state,
          questions: inboundTriageQuestions(),
          model: config.typeSafeModel || 'jev-latest',
        },
        {
          signal,
          timeout: config.typeSafeTimeoutMs || 10000,
          retry: { maxRetries: 1 },
        },
      );
      return {
        provider,
        model: result.model,
        questionSet: INBOUND_TRIAGE_VERSION,
        answers: result.answers,
        proposedRoute: routeCandidate(result.answers),
        usage: result.usage,
        latencyMs: Date.now() - started,
      };
    },
    async evaluateEscalationRouting(state, { signal } = {}) {
      const started = Date.now();
      const result = await getClient().systemOne(
        {
          state,
          questions: escalationRoutingQuestions(),
          model: config.typeSafeModel || 'jev-latest',
        },
        {
          signal,
          timeout: config.typeSafeTimeoutMs || 10000,
          retry: { maxRetries: 1 },
        },
      );
      return {
        provider,
        model: result.model,
        questionSet: ESCALATION_ROUTING_VERSION,
        answers: result.answers,
        proposedRoute: {
          route: result.answers.route.choice,
          confidence: result.answers.route.confidence,
          probabilities: result.answers.route.probabilities,
          requiresSupervisorProbability: result.answers.requires_supervisor_reasoning.noul,
        },
        usage: result.usage,
        latencyMs: Date.now() - started,
      };
    },
  };
}
