import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRegistry } from '../server/agent-registry.mjs';

const config = {
  mode: 'demo',
  agentWorkflowsEnabled: true,
  agentSms: { provider: 'compatible', model: 'text-test', apiKey: 'private-text-key' },
  agentSupervisor: {
    provider: 'openai',
    model: 'supervisor-test',
    apiKey: 'private-supervisor-key',
  },
  openaiKey: 'private-voice-key',
  liveModel: 'voice-test',
  liveBackendModel: 'tools-test',
};

test('agent registry preserves configured profiles and tracked metrics without inventing runtime data', () => {
  const tracked = { running: 1, queued: 2, completed: 3, failed: 0 };
  const registry = agentRegistry(config, {
    agentStats: () => ({ payment_conversation_agent: tracked }),
  });
  const marina = registry.agents.find((agent) => agent.id === 'payment_conversation_agent');
  assert.equal(marina.name, 'Marina');
  assert.equal(marina.model, 'text-test');
  assert.equal(marina.provider, 'compatible');
  assert.equal(marina.configured, true);
  assert.deepEqual(marina.stats, tracked);
  assert.match(marina.scope, /SMS.*Gmail/);
  assert.equal(
    registry.agents.some((a) => a.id === 'grok_voice'),
    false,
  );
  assert.equal(registry.agents.find((a) => a.id === 'openai_voice').name, 'Clara');
  assert.equal(JSON.stringify(registry).includes('private-'), false);
  assert.equal(
    registry.agents.find((agent) => agent.id === 'document_librarian').model,
    'Deterministic retrieval',
  );
});

test('agent map relationships reference existing distinct nodes and distinguish shared services from agents', () => {
  const registry = agentRegistry(config, {});
  const nodes = [...registry.agents, registry.coordinator, ...registry.infrastructure];
  const ids = new Set(nodes.map((node) => node.id));
  assert.equal(ids.size, nodes.length);
  assert.equal(registry.agents.length, 5);
  assert.equal(registry.coordinator.id, 'coordinator');
  assert.equal(registry.coordinator.kind, 'Application service');
  const edges = new Set();
  for (const edge of registry.relationships) {
    assert.ok(ids.has(edge.from), edge.from);
    assert.ok(ids.has(edge.to), edge.to);
    assert.notEqual(edge.from, edge.to);
    assert.ok(['handoff', 'information'].includes(edge.kind));
    assert.ok(edge.label);
    const key = `${edge.from}:${edge.to}:${edge.kind}`;
    assert.ok(!edges.has(key), `Duplicate relationship ${key}`);
    edges.add(key);
  }
  assert.ok(
    registry.relationships.some(
      (edge) => edge.from === 'supervisor' && edge.to === 'payment_conversation_agent',
    ),
  );
  assert.ok(
    registry.relationships.some(
      (edge) => edge.to === 'payment_ledger' && edge.kind === 'information',
    ),
  );
  for (const agent of registry.agents) {
    assert.ok(agent.responsibilities.length <= 3);
    assert.ok(agent.limitations.length <= 3);
  }
});

test('disabled workflows remain explicit independently of provider configuration', () => {
  const registry = agentRegistry({ ...config, mode: 'live' }, {});
  assert.equal(registry.enabled, false);
  for (const id of ['payment_conversation_agent', 'supervisor', 'document_librarian']) {
    assert.equal(registry.agents.find((agent) => agent.id === id).execution, 'Disabled');
  }
});
