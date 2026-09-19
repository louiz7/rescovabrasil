import { createHash } from 'node:crypto';
import { all, now, one, run } from './db.mjs';
import {
  SHARED_RECOVERY_GUARDRAILS,
  SHARED_RECOVERY_OBJECTIVE,
} from '../shared/recovery-mandate.mjs';

export { SHARED_RECOVERY_GUARDRAILS, SHARED_RECOVERY_OBJECTIVE };

const organizationVersion = 'rescova-recovery-v1';
const roleVersion = 'role-charters-v1';
const roleCharters = {
  Mateo: 'Continuously plan and coordinate the next permitted portfolio actions.',
  Clara: 'Conduct respectful voice conversations and capture structured outcomes.',
  Lucas: 'Supply verified case facts and execute gated voice tools.',
  Marina:
    'Continue debtor conversations across written channels and advance authorized resolutions.',
  Helena: 'Retrieve authoritative case documents and evidence for other agents.',
  Rafael: 'Resolve complex case uncertainty within policy and available evidence.',
  Tiago: 'Own payment-verification and explicit dependency states.',
  Lia: 'Classify inbound intent and apply only approved direct routes.',
  Bento: 'Select the smallest authoritative context needed for a task.',
};

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function ensureOperatingMandates(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS organization_mandates (
    id TEXT NOT NULL,version TEXT NOT NULL,objective TEXT NOT NULL,guardrails_json TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(id,version));
    CREATE TABLE IF NOT EXISTS portfolio_mandates (
    portfolio_id TEXT NOT NULL REFERENCES portfolios(id),version TEXT NOT NULL,objective TEXT NOT NULL,
    success_metric TEXT NOT NULL,constraints_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(portfolio_id,version));
    CREATE TABLE IF NOT EXISTS agent_role_charters (
    agent_id TEXT NOT NULL,version TEXT NOT NULL,mission TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(agent_id,version));`);
  run(
    db,
    'INSERT OR IGNORE INTO organization_mandates VALUES (?,?,?,?,?)',
    'rescova',
    organizationVersion,
    SHARED_RECOVERY_OBJECTIVE,
    JSON.stringify(SHARED_RECOVERY_GUARDRAILS),
    now(),
  );
  for (const [agentId, mission] of Object.entries(roleCharters))
    run(
      db,
      'INSERT OR IGNORE INTO agent_role_charters VALUES (?,?,?,?)',
      agentId,
      roleVersion,
      mission,
      now(),
    );
}

export function ensurePortfolioMandate(db, portfolioId) {
  ensureOperatingMandates(db);
  const portfolio = one(db, 'SELECT * FROM portfolios WHERE id=?', portfolioId);
  if (!portfolio) return null;
  run(
    db,
    'INSERT OR IGNORE INTO portfolio_mandates VALUES (?,?,?,?,?,?,?)',
    portfolioId,
    'portfolio-recovery-v1',
    `Recover the Rescova-owned receivables in ${portfolio.name}.`,
    'Verified recovered amount, with promises and reported payments tracked separately.',
    JSON.stringify({ currency: 'BRL', ownership: 'Rescova-owned purchased receivables' }),
    now(),
    now(),
  );
  return one(
    db,
    'SELECT * FROM portfolio_mandates WHERE portfolio_id=? AND version=?',
    portfolioId,
    'portfolio-recovery-v1',
  );
}

export function operatingMandate(
  db,
  { portfolioId = null, caseId = null, agentId = null, taskGoal = null } = {},
) {
  ensureOperatingMandates(db);
  if (!portfolioId && caseId)
    portfolioId =
      one(db, 'SELECT portfolio_id FROM cases WHERE id=?', caseId)?.portfolio_id || null;
  const organization = one(
    db,
    'SELECT * FROM organization_mandates WHERE id=? AND version=?',
    'rescova',
    organizationVersion,
  );
  const portfolio = portfolioId ? ensurePortfolioMandate(db, portfolioId) : null;
  const role = agentId
    ? one(
        db,
        'SELECT * FROM agent_role_charters WHERE agent_id=? AND version=?',
        agentId,
        roleVersion,
      )
    : null;
  const operation = portfolioId
    ? one(db, 'SELECT status,channels FROM portfolio_operations WHERE portfolio_id=?', portfolioId)
    : null;
  const globalPolicy = JSON.parse(
    one(db, "SELECT value FROM settings WHERE key='policy'")?.value || '{}',
  );
  const policyState = {
    global: globalPolicy,
    portfolio: operation
      ? { status: operation.status, channels: JSON.parse(operation.channels) }
      : null,
  };
  return {
    goalId: portfolioId ? `recovery:${portfolioId}` : 'recovery:organization',
    organization: {
      version: organization.version,
      objective: organization.objective,
      guardrails: JSON.parse(organization.guardrails_json),
    },
    portfolio: portfolio
      ? {
          id: portfolio.portfolio_id,
          version: portfolio.version,
          objective: portfolio.objective,
          successMetric: portfolio.success_metric,
          constraints: JSON.parse(portfolio.constraints_json),
        }
      : null,
    role: role ? { agentId: role.agent_id, version: role.version, mission: role.mission } : null,
    task: taskGoal ? { goal: taskGoal } : null,
    policyVersion: hash(policyState),
    policy: policyState,
  };
}

export function portfolioMandateView(db, portfolioId) {
  const mandate = operatingMandate(db, { portfolioId, agentId: 'Mateo' });
  if (!mandate.portfolio) return null;
  return {
    ...mandate,
    roles: all(
      db,
      'SELECT agent_id,version,mission FROM agent_role_charters WHERE version=? ORDER BY agent_id',
      roleVersion,
    ),
  };
}

export function mandateAuditFields(mandate) {
  return {
    goalId: mandate.goalId,
    organizationMandateVersion: mandate.organization.version,
    portfolioMandateVersion: mandate.portfolio?.version || null,
    roleCharterVersion: mandate.role?.version || null,
    policyVersion: mandate.policyVersion,
  };
}
