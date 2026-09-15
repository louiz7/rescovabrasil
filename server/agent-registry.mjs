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
      ...agentIdentities.document_librarian,
      description:
        'Retrieves case documents for Marina. Exact case/type matching with immutable source versions.',
      provider: 'local',
      model: 'Deterministic retrieval',
      configured: true,
      execution: enabled ? 'On document request' : 'Disabled',
      scope: 'Demo case documents',
      capabilities: [
        'Find case documents',
        'Preserve source versions',
        'Flag missing or ambiguous evidence',
        'Hand documents to Marina',
      ],
    },
    {
      id: 'payment_conversation_agent',
      name: 'Payment conversation agent',
      description:
        'Follows up on demo agreements and document requests, and continues the virtual SMS conversation.',
      ...profile('sms'),
      execution: enabled ? 'Automatic after call end' : 'Disabled',
      scope: 'Virtual SMS',
      capabilities: [
        'Read accepted agreement',
        'Request and explain case documents',
        'Reply to messages',
        'Record outcomes',
        'Request specialist review',
      ],
    },
    {
      id: 'supervisor',
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
        'Recheck new case facts',
        'Track blocked work and next actions',
      ],
    },
    {
      id: 'openai_voice',
      name: 'GPT Live voice agent',
      description: 'Conducts the existing English demo conversation and delegates domain tools.',
      provider: 'openai',
      model: config.liveModel,
      configured: !!config.openaiKey,
      execution: 'Manual test',
      scope: 'Browser and Twilio test',
      capabilities: ['Voice conversation', 'Delegate identity, payment and document tools'],
    },
    {
      id: 'voice_backend',
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
        'Read authorized offers',
        'Save payment agreement',
        'Request case documents',
        'Record outcomes',
      ],
    },
    {
      id: 'grok_voice',
      name: 'Grok voice agent',
      description: 'Alternative browser voice agent using the same demo domain tools.',
      provider: 'xai',
      model: config.xaiVoiceModel,
      configured: !!config.xaiKey,
      execution: 'Manual test',
      scope: 'Browser test',
      capabilities: [
        'Voice conversation',
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
      name: 'Workflow coordinator',
      kind: 'Application service',
      description:
        'Persists tasks, waits for call completion, assigns conversation ownership and validates actions. No model required.',
    },
  };
}
