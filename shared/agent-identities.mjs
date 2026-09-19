// Display identities belong to agent roles, independently of their model/provider.
export const agentIdentities = Object.freeze({
  document_librarian: { name: 'Helena', role: 'Document librarian' },
  payment_conversation_agent: { name: 'Marina', role: 'Payment support' },
  supervisor: { name: 'Rafael', role: 'Case supervisor' },
  openai_voice: { name: 'Clara', role: 'Voice outreach' },
  voice_backend: { name: 'Lucas', role: 'Case operations' },
  inbound_triage: { name: 'Lia', role: 'Inbound triage' },
  context_router: { name: 'Bento', role: 'Context router' },
  resolution_router: { name: 'Tiago', role: 'Resolution router' },
});
