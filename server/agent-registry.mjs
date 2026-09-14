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
      id: 'payment_conversation_agent',
      name: 'Payment conversation agent',
      description:
        'Follows up on accepted demo agreements and continues the virtual SMS conversation.',
      ...profile('sms'),
      execution: enabled ? 'Automatic after call end' : 'Disabled',
      scope: 'Virtual SMS',
      capabilities: [
        'Read accepted agreement',
        'Reply to messages',
        'Record outcomes',
        'Request specialist review',
      ],
    },
    {
      id: 'supervisor',
      name: 'Case supervisor',
      description:
        'Helps the conversation agent resolve uncertain next steps. Runs only when requested.',
      ...profile('supervisor'),
      execution: enabled ? 'On demand' : 'Disabled',
      scope: 'Case decisions',
      capabilities: ['Review scoped case context', 'Recommend next action', 'Escalate to a person'],
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
      capabilities: ['Voice conversation', 'Delegate identity and payment tools'],
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
      capabilities: ['Voice conversation', 'Save payment agreement', 'Record outcomes'],
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
