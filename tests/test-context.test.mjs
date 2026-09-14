import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedDatabase, executeTestTool } from '../server/browser-voice.mjs';
test('test state remembers name confirmation across delegations and protects unconfirmed details', () => {
  const db = isolatedDatabase('test-state');
  try {
    const before = executeTestTool(db, 'test-state', 'get_test_context', {});
    assert.equal(before.confirmed, false);
    assert.equal(before.case, undefined);
    assert.equal(before.authorizedOffers, undefined);
    executeTestTool(db, 'test-state', 'confirm_identity', { confirmed: true, name: 'Ana Silva' });
    for (let i = 0; i < 3; i++) {
      const state = executeTestTool(db, 'test-state', 'get_test_context', {});
      assert.equal(state.confirmed, true);
      assert.equal(state.assurance, 'self_reported_name');
      assert.equal(state.case.amount_minor, 125000);
    }
    executeTestTool(db, 'test-state', 'record_outcome', {
      outcome: 'willing_to_pay',
      willingness: 'yes',
      ability: 'unknown',
      note: 'Caller explicitly expressed willingness.',
    });
    const after = executeTestTool(db, 'test-state', 'get_test_context', {});
    assert.equal(after.confirmed, true);
    assert.equal(after.outcome, 'willing_to_pay');
    assert.equal(after.authorizedOffers.length, 3);
    const agreement = executeTestTool(db, 'test-state', 'agree_payment_solution', {
      offerId: 'three_installments',
      accepted: true,
    });
    assert.equal(agreement.agreed, true);
    assert.equal(agreement.agreement.totalMinor, 125000);
    const updated = executeTestTool(db, 'test-state', 'get_test_context', {});
    assert.equal(updated.agreement.id, agreement.agreement.id);
    assert.equal(updated.case.amount_minor, 125000);
  } finally {
    db.close();
  }
});
