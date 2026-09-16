import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, run, event, task } from '../server/db.mjs';
import { ensureDemoVoiceCase } from '../server/demo-platform.mjs';
import { loadCaseKnowledge, lookupCaseInformation } from '../server/case-context.mjs';

test('shared knowledge reloads all case notes and tasks without mixing cases or inventing transcript coverage', () => {
  const db = openDb();
  try {
    const a = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'knowledge-a' },
    );
    const b = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'knowledge-b' },
    );
    event(
      db,
      a.caseId,
      'call_outcome',
      { note: 'Caller can discuss payment after Friday.', outcome: 'callback_requested' },
      'voice',
    );
    event(db, b.caseId, 'private_other_case', 'Other case only');
    task(db, a.caseId, 'Check requested callback', '2026-10-01T12:00:00Z');
    run(db, "UPDATE tasks SET note='Prefers email documents' WHERE case_id=?", a.caseId);
    const k = loadCaseKnowledge(db, a.caseId);
    assert.ok(k.activity.some((x) => x.detail.includes('Friday')));
    assert.equal(k.followups[0].note, 'Prefers email documents');
    assert.ok(k.documentEvidence.length >= 2);
    assert.ok(k.documentEvidence.every((d) => d.content.includes('Ana')));
    assert.doesNotMatch(JSON.stringify(k), /Other case only/);
    assert.match(k.coverage.voice, /not automatically/);
    run(db, "UPDATE tasks SET note='Prefers SMS replies' WHERE case_id=?", a.caseId);
    assert.equal(loadCaseKnowledge(db, a.caseId).followups[0].note, 'Prefers SMS replies');
  } finally {
    db.close();
  }
});

test('targeted case facts preserve missing values and source creditor without leaking sensitive fields', () => {
  const db = openDb();
  try {
    const { caseId } = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'lookup-facts' },
    );
    run(db, "UPDATE cases SET verification_hash='private-hash' WHERE id=?", caseId);
    const result = lookupCaseInformation(db, caseId, { topic: 'case_details' });
    assert.equal(result.facts.creditor, 'Banco Horizonte (fictional)');
    assert.equal(result.facts.dueDate, null);
    assert.ok(result.missing.includes('dueDate'));
    assert.doesNotMatch(JSON.stringify(result), /private-hash|verification_hash|source_import/);
    run(db, "UPDATE portfolios SET creditor='' WHERE id=?", result.facts.portfolioId);
    assert.equal(lookupCaseInformation(db, caseId, { topic: 'case_details' }).facts.creditor, null);
    assert.ok(
      lookupCaseInformation(db, caseId, { topic: 'case_details' }).missing.includes('creditor'),
    );
    assert.throws(() => lookupCaseInformation(db, 'absent', { topic: 'case_details' }), {
      status: 404,
    });
    for (const offset of [-1, 0.5, '10', Number.MAX_SAFE_INTEGER])
      assert.throws(() => lookupCaseInformation(db, caseId, { topic: 'activity', offset }), {
        status: 400,
      });
  } finally {
    db.close();
  }
});

test('document lookups are case scoped and expose every content page without hidden truncation', () => {
  const db = openDb();
  try {
    const a = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'lookup-doc-a' },
    );
    const b = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'lookup-doc-b' },
    );
    const documentId = lookupCaseInformation(db, a.caseId, { topic: 'documents' }).items[0].id;
    const content = 'A'.repeat(6000) + 'B'.repeat(6000) + 'end of document';
    run(db, 'UPDATE case_documents SET content=? WHERE id=?', content, documentId);
    assert.throws(
      () => lookupCaseInformation(db, b.caseId, { topic: 'document_content', documentId }),
      { status: 404 },
    );
    assert.throws(() => lookupCaseInformation(db, a.caseId, { topic: 'document_content' }), {
      status: 400,
    });
    let offset = 0,
      reconstructed = '';
    do {
      const page = lookupCaseInformation(db, a.caseId, {
        topic: 'document_content',
        documentId,
        offset,
      });
      assert.equal(page.document.id, documentId);
      assert.equal(page.totalCharacters, content.length);
      assert.ok(page.content.length <= 6000);
      reconstructed += page.content;
      offset = page.nextOffset;
      assert.equal(page.hasMore, offset !== null);
    } while (offset !== null);
    assert.equal(reconstructed, content);
    assert.equal(
      lookupCaseInformation(db, a.caseId, { topic: 'documents' }).items[0].content,
      undefined,
    );
  } finally {
    db.close();
  }
});

test('activity pages are bounded, complete, current, case scoped and flagged internal', () => {
  const db = openDb();
  try {
    const a = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'lookup-events-a' },
    );
    const b = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'lookup-events-b' },
    );
    for (let i = 0; i < 26; i++) event(db, a.caseId, 'test', { n: i });
    event(db, b.caseId, 'private-other-case', 'secret-other-case');
    let offset = 0,
      records = [];
    do {
      const page = lookupCaseInformation(db, a.caseId, { topic: 'activity', offset });
      assert.ok(page.items.length <= 10);
      records.push(...page.items);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(records.filter((row) => row.kind === 'test').length, 26);
    assert.ok(records.every((row) => row.internalOnly));
    assert.doesNotMatch(JSON.stringify(records), /secret-other-case/);
    assert.equal(
      lookupCaseInformation(db, a.caseId, { topic: 'payment_terms' }).items.filter(
        (row) => row.kind === 'approved_demo_offer',
      ).length,
      3,
    );
    run(db, 'UPDATE cases SET amount_minor=200 WHERE id=?', a.caseId);
    assert.deepEqual(lookupCaseInformation(db, a.caseId, { topic: 'payment_terms' }).items, []);
  } finally {
    db.close();
  }
});

test('case history distinguishes unsent email from provider submitted and inbound messages', () => {
  const db = openDb();
  try {
    const { caseId } = ensureDemoVoiceCase(
      db,
      { mode: 'demo' },
      { provider: 'openai', sessionId: 'lookup-history' },
    );
    db.exec(`CREATE TABLE agent_conversations (id TEXT PRIMARY KEY,case_id TEXT);
      CREATE TABLE agent_messages (id TEXT PRIMARY KEY,conversation_id TEXT,direction TEXT,body TEXT,status TEXT,channel TEXT,created_at TEXT);
      CREATE TABLE email_deliveries (id TEXT,message_id TEXT,status TEXT);`);
    run(db, 'INSERT INTO agent_conversations VALUES (?,?)', 'c', caseId);
    for (const [id, direction, channel] of [
      ['draft', 'outbound', 'email'],
      ['submitted', 'outbound', 'email'],
      ['in', 'inbound', 'email'],
      ['sms', 'outbound', 'virtual_sms'],
    ])
      run(
        db,
        'INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?)',
        id,
        'c',
        direction,
        'Test message',
        direction === 'outbound' ? 'sent' : 'received',
        channel,
        new Date().toISOString(),
      );
    run(db, 'INSERT INTO email_deliveries VALUES (?,?,?)', 'd', 'submitted', 'submitted');
    const rows = lookupCaseInformation(db, caseId, { topic: 'conversation_history' }).items;
    assert.equal(rows.find((row) => row.id === 'draft').communicationState, 'not_confirmed_sent');
    assert.equal(rows.find((row) => row.id === 'submitted').communicationState, 'submitted');
    assert.equal(rows.find((row) => row.id === 'in').communicationState, 'received');
    assert.equal(rows.find((row) => row.id === 'sms').communicationState, 'sent_in_demo');
  } finally {
    db.close();
  }
});
