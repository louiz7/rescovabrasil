import { agentIdentities } from '../shared/agent-identities.mjs';
export function agentRegistry(config, workflows) {
  const stats = workflows.agentStats?.() || {};
  const profile = (role) => {
    const p = role === 'sms' ? config.agentSms : config.agentSupervisor;
    return { provider: p?.provider || 'openai', model: p?.model || null, configured: !!p?.apiKey };
  };
  const enabled = config.mode === 'demo' && config.agentWorkflowsEnabled;
  const rows = [
    {
      id: 'document_librarian',
      kind: 'retrieval',
      responsibilities: [
        'Retrieve case-scoped evidence',
        'Preserve source and version references',
        'Flag missing or ambiguous documents',
      ],
      limitations: [
        'Deterministic retrieval, not an LLM',
        'Only indexed or stored case documents',
        'External release is limited to seeded demo documents',
      ],
      ...agentIdentities.document_librarian,
      description:
        'Finds case documents and relevant passages with source, version and page references.',
      provider: 'local',
      model: 'Deterministic retrieval',
      configured: true,
      execution: enabled ? 'On document request' : 'Disabled',
      scope: 'Case documents and evidence',
      capabilities: [
        'Find case documents and passages',
        'Preserve source versions',
        'Flag missing or ambiguous evidence',
        'Supply evidence for SMS and email',
      ],
    },
    {
      id: 'payment_conversation_agent',
      kind: 'conversation',
      responsibilities: [
        'Continue written conversations across channels',
        'Explain and save authorized agreements',
        'Retrieve needed facts before answering',
      ],
      limitations: [
        'SMS is simulated; email uses the configured test mailbox',
        'Cannot change balances or verify live payments',
        'New terms require existing authorization',
      ],
      name: 'Payment conversation agent',
      description:
        'Continues case conversations across SMS and email, explains payment options and fulfills document requests.',
      ...profile('sms'),
      execution: enabled ? 'On messages and follow-ups' : 'Disabled',
      scope: 'Virtual SMS and Gmail test',
      capabilities: [
        'Explain and accept approved payment offers',
        'Look up current case and payment facts',
        'Request and explain case documents',
        'Reply across SMS and email',
        'Record outcomes',
        'Request specialist review',
      ],
    },
    {
      id: 'supervisor',
      kind: 'supervision',
      responsibilities: [
        'Resolve exceptions with fresh case evidence',
        'Guide Marina or request missing information',
        'Record unresolved dependencies and next actions',
      ],
      limitations: [
        'Runs on escalation, not every message',
        'Cannot grant new payment terms or verify live receipt',
        'Missing capabilities remain explicitly blocked',
      ],
      name: 'Case supervisor',
      description:
        'Owns exception resolution, guides Marina and tracks cases awaiting information or policy clearance.',
      ...profile('supervisor'),
      execution: enabled ? 'On demand' : 'Disabled',
      scope: 'Case decisions',
      capabilities: [
        'Resolve case exceptions',
        'Request case documents',
        'Guide Marina with approved options',
        'Look up case evidence and payment state',
        'Track blocked work and next actions',
      ],
    },
    {
      id: 'openai_voice',
      kind: 'voice',
      name: 'GPT Live voice agent',
      description: 'Conducts the English demo conversation and delegates case actions to Lucas.',
      provider: 'openai',
      model: config.liveModel,
      configured: !!config.openaiKey,
      execution: 'Manual test',
      scope: 'Browser and Twilio test',
      capabilities: ['Voice conversation', 'Delegate identity, payment and document tools'],
      responsibilities: [
        'Conduct demo calls',
        'Ask for consent and clarify intent',
        'Delegate case actions to Lucas',
      ],
      limitations: ['Started through browser or Twilio tests', 'Uses fictional demo cases'],
    },
    {
      id: 'voice_backend',
      kind: 'tools',
      responsibilities: [
        'Execute delegated case tools',
        'Save authorized demo agreements and outcomes',
        'Create document and follow-up requests',
      ],
      limitations: [
        'Invoked by Clara during GPT Live tests',
        'Tool actions remain application-validated',
        'Payment state is simulated',
      ],
      name: 'Voice tools agent',
      description:
        'Handles delegated identity, outcome and payment-solution tools during GPT Live calls.',
      provider: 'openai',
      model: config.liveBackendModel,
      configured: !!config.openaiKey,
      execution: 'During voice tests',
      scope: 'Voice domain tools',
      capabilities: [
        'Confirm self-reported name',
        'Read authorized offers and simulated payment state',
        'Save payment agreement',
        'Request case documents',
        'Record outcomes',
      ],
    },
  ];
  return {
    enabled: !!enabled,
    agents: rows.map((row) => ({
      ...row,
      ...agentIdentities[row.id],
      stats: stats[row.id] || null,
    })),
    coordinator: {
      id: 'coordinator',
      name: 'Workflow coordinator',
      kind: 'Application service',
      description:
        'Persists tasks, waits for call completion, assigns conversation ownership and validates actions. No model required.',
    },
    infrastructure: [
      {
        id: 'shared_context',
        name: 'Shared case context',
        kind: 'Application service',
        description:
          'Case-scoped facts, conversation history, documents and delivery evidence, retrieved on demand.',
      },
      {
        id: 'payment_ledger',
        name: 'Payment ledger',
        kind: 'Application service',
        description:
          'Structured installments, simulated payment evidence and allocations. Financial changes follow validated events, not generated text.',
      },
    ],
    relationships: [
      { from: 'openai_voice', to: 'voice_backend', label: 'Delegate case tools', kind: 'handoff' },
      {
        from: 'voice_backend',
        to: 'coordinator',
        label: 'Save follow-up requests',
        kind: 'handoff',
      },
      {
        from: 'coordinator',
        to: 'payment_conversation_agent',
        label: 'Dispatch conversation work',
        kind: 'handoff',
      },
      {
        from: 'coordinator',
        to: 'document_librarian',
        label: 'Retrieve requested documents',
        kind: 'handoff',
      },
      {
        from: 'coordinator',
        to: 'supervisor',
        label: 'Dispatch exception reviews',
        kind: 'handoff',
      },
      {
        from: 'payment_conversation_agent',
        to: 'supervisor',
        label: 'Request exception resolution',
        kind: 'handoff',
      },
      {
        from: 'supervisor',
        to: 'payment_conversation_agent',
        label: 'Provide reply guidance',
        kind: 'handoff',
      },
      {
        from: 'document_librarian',
        to: 'payment_conversation_agent',
        label: 'Supply document evidence',
        kind: 'information',
      },
      {
        from: 'payment_conversation_agent',
        to: 'shared_context',
        label: 'Look up case facts',
        kind: 'information',
      },
      {
        from: 'supervisor',
        to: 'shared_context',
        label: 'Look up case facts',
        kind: 'information',
      },
      {
        from: 'shared_context',
        to: 'payment_ledger',
        label: 'Read payment evidence',
        kind: 'information',
      },
      {
        from: 'voice_backend',
        to: 'payment_ledger',
        label: 'Read demo payment state',
        kind: 'information',
      },
    ],
  };
}
