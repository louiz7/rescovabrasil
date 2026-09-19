# Rescova Brasil

Agentic debt-recovery platform for Rescova-owned purchased receivables in Brazil. Current MVP imports portfolios, coordinates voice/SMS/email outreach, keeps case context and documents available to agents, records outcomes and simulates an autonomous portfolio cycle.

## Operating model

Every runtime receives one versioned goal hierarchy:

1. **Organization mandate:** maximize verified recovery of Rescova-owned receivables within approved rules.
2. **Portfolio mandate:** portfolio objective, success measure, ownership and currency constraints.
3. **Role charter:** each agent's responsibility and limits.
4. **Task goal:** the current bounded job.

Policy and stop rules remain deterministic application controls. Debtor messages and uploaded documents are evidence, never instructions. Autonomous runs and model runs record goal, mandate, role and policy versions for audit and replay.

Main roles: Mateo plans portfolio work; Clara handles voice; Lucas executes gated voice tools; Marina handles written conversations; Helena retrieves documents; Rafael resolves complex uncertainty; Tiago owns payment-verification dependencies; Lia and Bento provide typed routing and context selection.

## Run locally

Requires Node.js 22.18+.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173` and sign in with `rescova-demo`. API runs at `http://127.0.0.1:3001`. Default demo mode uses fictional data and never contacts providers.

```sh
npm test
npm run build
npm run test:e2e
```

## Test current flow

1. Open **Portfolios** and select **Autonomous collections demo**.
2. Activate it with voice, SMS and email.
3. Run **Simulate autonomous cycle**.
4. Inspect Mateo's run, assigned agent tasks, case outcomes and zero provider contacts.
5. Run it again. Unchanged state must create no duplicate actions.
6. Open **Browser voice test** to test Clara and Lucas with GPT Live.
7. Open **Demo SMS conversations** to continue the same case with Marina and request documents from Helena.

Browser voice test uses fictional Ana Silva data. It can consume OpenAI API credits but places no phone call. Twilio tests require explicit enablement, an allowlisted recipient and a public HTTPS/WSS callback.

## Configuration

Copy `.env.example` to `.env`. Never commit `.env`, API keys or databases. Key groups:

- OpenAI: `OPENAI_API_KEY`, Live and backend model settings.
- Twilio: account SID, token, sender number, public URL and allowlist.
- Gmail/email: configured OAuth values and sender settings.
- TypeSafe: API key and active decision mode.
- Workflows: agent workflow and autonomous planner flags.

Provider and model adapters are replaceable. Business state, authorization, financial truth, idempotency and side effects stay in application code.

## Current boundaries

- Autonomous portfolio delivery is simulated. No planner run contacts a provider.
- Browser/Twilio voice harnesses use fixed fictional test cases.
- Payment ledger and reconciliation are simulated; reported payment is never verified receipt.
- PagBrasil is intended Brazil payment provider, pending eligibility and sandbox access.
- SQLite supports local development. PostgreSQL worker paths exist, but production scaling, provider throughput and full operational recovery still require validation.

## Documentation

- [Product goal](docs/GOAL.md)
- [Workflow diagrams](docs/WORKFLOWS.md)
- [Maturity assessment](docs/ASSESSMENT.md)
- [Operations](docs/OPERATIONS.md)
- [Validation](docs/VALIDATION.md)
- [Payments](docs/PAYMENTS.md)
