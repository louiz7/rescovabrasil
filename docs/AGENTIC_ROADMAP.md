# Roadmap to autonomous collections

Decision date: 16 September 2026. This document is a proposal for the next infrastructure increments. Current execution is documented in WORKFLOWS.md; this roadmap does not enable money movement or new outreach.

## Design decision

Build an event-driven case system with durable agent-owned tasks and a common capability layer. Keep one written conversation role (Marina) across email and SMS, voice specialists for synchronous calls, Helena for evidence, and Rafael for ambiguous case decisions. Add a payment-reconciliation role only when its tools and ledger exist. Agent identities are logical roles: workers process many cases; there is no permanently running model or process per debtor.

The coordinator owns scheduling, deadlines, dependencies, deduplication and atomic state transitions. Rafael reasons about exceptions or material strategy changes, not every database read or incoming status callback. The application enforces authorized financial terms, contact eligibility and stale-state checks at execution time. Deterministic services are capabilities within an agentic system; a model need not decide whether two transaction IDs are identical.

## Architecture alignment review — 18 September 2026

The current direction already matches important production patterns: asynchronous durable work, specialized roles, explicit dependencies, provider-neutral model/tool boundaries, shared case context, evidence-based payment state, idempotency and bounded retries. Retain the modular monolith and PostgreSQL workers; no agent framework, peer-agent protocol or service split is justified yet.

Changes required before wider autonomy:

1. Extend canonical tasks with a machine-readable goal, completion criteria, progress state, maximum planning steps, tool-call budget, cost/time budget and stop reason. Current task type/state/deadline data is necessary but does not fully represent delegated intent.
2. Route every consequential tool call through one action gateway. Voice and written workflows currently expose several execution paths; converge them on versioned atomic commands with the same policy, authority, freshness, idempotency and outbox checks.
3. Complete one correlated decision log across model decision, proposed action, policy result, tool execution and observed outcome. Existing task runs, audit events and provider records are partial foundations rather than one end-to-end explanation.
4. Separate working memory, canonical case facts and derived memory in the context contract. Add provenance, validity/expiry and conflict state so an agent summary cannot become authoritative merely because another agent consumed it.
5. Implement a bounded observe-decide-act-evaluate planner. Existing flows are mostly predefined pipelines with exception handling; continuous portfolio work still needs explicit progress evaluation, replanning triggers and termination rules.
6. Add risk-based independent validation for consequential messages, document release, changed payment terms and closure decisions. Deterministic validation remains preferred where rules are exact; a validator model handles semantic claims only.
7. Enforce system-level admission, concurrency and cost budgets with graceful degradation. Individual retry limits exist, but global per-provider and per-portfolio reasoning/tool budgets remain missing.

Jev is integrated behind a separate provider-neutral `DecisionEngine`, not the generative model adapter. It classifies inbound intent, selects one context source and routes routine unresolved work to defined dependency states. It batches atomic questions, persists probabilities/model/schema versions and routes low-confidence or open-ended cases to the existing model path. It never changes balances, releases documents, sends messages or executes tools. Application policy may act on evaluated high-confidence signals through existing deterministic handlers. A data-processing review remains required before using real debtor data.

TypeSafe access is available. Active fictional-demo roles now cover inbound triage, context routing and unresolved-work routing before Rafael. Outbound semantic verification, voice routing, portfolio prioritization and retrieval reranking remain later evidence-driven uses. The detailed integration and activation gates are in [TYPESAFE_JEV_PLAN.md](TYPESAFE_JEV_PLAN.md).

## 1. Honest activity reporting and task visibility — current implementation slice

Project existing provider records into one outreach view with daily buckets and call/SMS/email breakdowns. Preserve source IDs and avoid counting a generated email and its Gmail delivery as two messages. Browser conversations, virtual SMS and simulated portfolio attempts must remain distinguishable from provider-backed transport, even when all happen in a demo workspace.

Use evidence-specific labels: queued, attempted, submitted, provider-confirmed delivery, connected, name-confirmed, response received, failed, uncertain. Different channels support different subsets. An unavailable delivery/read metric is unknown, not zero confirmed successes. Provider-backed tests are still tests; do not call them production campaigns.

Expose current jobs, supervisor dependencies and ingestion/delivery work in Agent tasks. Link to existing conversation and case actions. Historical manual follow-ups retain their actual state and ownership; relabeling them as Rafael's completed work would invent execution. This first projection is not yet the canonical ticket engine described next.

Acceptance: all displayed totals reconcile with persisted source rows; no draft or cancelled-before-send row counts as an actual send; inbound responses are separate from outbound attempts; zero-activity days remain visible; channel filters work and provenance counts remain distinct.

## 2. Canonical task contracts, event inbox/outbox and timers — next priority

Introduce additive tables, migrate one workflow at a time and keep existing source IDs. Do not dual-run legacy and new handlers for the same event. Start with document fulfillment and verification of a reported payment in sandbox.

| Object            | Essential fields and responsibility                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| case_events       | workspace/case IDs, event ID/type/version, actor, occurred/received timestamps, source object/provider ID, correlation/causation IDs, structured evidence reference                                                                           |
| agent_tasks       | ID/type/schema version, case/portfolio, accountable role, required capability, source event, parent/dependency IDs, priority, due_at, next_run_at, dedupe key, state, attempt budget, policy version, expected case version, result reference |
| task_runs         | task/run IDs, worker and fencing token, started/finished timestamps, model/profile/prompt/tool versions, input evidence IDs, result, latency, usage/cost, retry reason                                                                        |
| event_inbox       | provider/account/event identity, validated payload reference, received/processed timestamps, processing state; unique provider event key                                                                                                      |
| command_outbox    | immutable command/idempotency key, case/task reference, validated destination/content reference, policy version, dispatch state and provider result                                                                                           |
| task_dependencies | dependency kind/reference, resume event, deadline, retry policy, terminal disposition                                                                                                                                                         |

Use the existing PostgreSQL workers and leases. Write state changes and outbox rows in one transaction; publish after commit. No Kafka or separate orchestration framework is required for this stage. Provider duplicates and out-of-order callbacks must not repeat agreement creation, email sending or payment allocation. Aim for effectively-once local effects through uniqueness and replay-safe handlers, not an unsupported exactly-once external-delivery promise.

Normalize states: ready, scheduled, running, waiting_input, waiting_provider, blocked_policy, blocked_capability, retry_scheduled, completed, failed_terminal, cancelled. Keep uncertain external outcomes as an explicit delivery/payment substate that requires reconciliation, not automatic resend. Every nonterminal task has one owner and a next event or deadline that can move it forward. A dependency does not spin an LLM continuously.

A task is complete only when its own completion contract is satisfied. An email composition task can complete when the outbox command exists; a send task completes at provider submission; neither implies the debtor has paid. Parent tasks depend on the appropriate evidence, not merely child process exit.

Priorities and dependencies should let an urgent opt-out or verified payment cancel stale pending outreach rather than sit behind a failed reply. Separate conversation order from independent evidence gathering and critical case-state updates. Recheck current case version, contact policy and balance immediately before every external action.

Acceptance: kill/restart a worker mid-step, replay one event ten times, deliver callbacks out of order, change contact eligibility while a model runs, and let a timer expire. Each scenario must leave one explainable outcome and no duplicate customer action.

## 3. Payment records and reconciliation — build in sandbox before real collection

Create a provider-neutral PaymentProvider interface: createPaymentRequest, getPaymentStatus, verifyAndNormalizeEvent, listReconciliationCandidates. Bind every request to case, agreement, installment, creditor/merchant account, currency and expected amount. Do not expose arbitrary API calls or secret keys as model tools.

Separate receivable, authorized agreement, installment schedule, payment request, provider transaction, allocation and ledger entry. Store amounts as integer minor units. Keep immutable monetary postings and explicit reversal/refund entries; never overwrite an old payment to hide a reversal. Track gross debtor payment, fees and net settlement to Rescova separately. Allocation rules for partial/extra/late payments are configured, deterministic and auditable. Discount write-offs occur only under the accepted settlement conditions.

Use signed provider webhooks as the primary signal, persisted before acknowledgment; reconcile missed/ambiguous events through bounded API reads and a periodic service. Retrieve current provider state when necessary. Stripe, for example, documents duplicate and unordered events and recommends asynchronous handling and signature verification: [Stripe webhooks](https://docs.stripe.com/webhooks). Mutating provider requests need stable idempotency keys: [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).

A successful payment transaction is not proof that an entire debt is discharged: compare amount, currency, installment allocation, agreed settlement conditions and prior reversals. Keep claimed_paid, processing, succeeded, allocated, settled, refunded and disputed distinct where supported. A debtor's “I paid” creates verification work and suppresses collection reminders while evidence is unresolved; it does not reduce the balance.

A future payment agent, provisionally named Theo, owns reconciliation exceptions and invokes scoped tools. Confirmed ledger changes create tasks for Marina to acknowledge receipt, advance the schedule, or confirm closure. The exact financial calculation and posting are performed by the payment service. Theo is planned, not a configured employee in today's agent registry.

**Provider fit is unresolved.** The user confirmed that Rescova will exclusively collect receivables it has purchased and owns. This is not a third-party servicing scope. Purchasing and collecting owned receivables differs from collecting for another creditor. Stripe's Brazil-facing prohibited-business list expressly includes debt-collection agencies, but that wording alone does not establish how Stripe would classify Rescova's actual ownership and funds-flow model. Do not treat this as a finding that Rescova is prohibited, or that a working test account proves live eligibility. Validate the actual business model with the provider and retain the adapter boundary. Source: [Stripe Brazil prohibited and restricted businesses](https://stripe.com/br/legal/restricted-businesses), checked 16 September 2026. Provider classification is an open selection input; it does not block a provider-neutral sandbox ledger.

Confirmed design: Rescova is the current receivable owner and payment recipient; preserve the original lender separately for provenance and debtor explanations. Store acquisition/assignment evidence and distinguish purchase price from the debtor's outstanding balance; the price Rescova paid for the portfolio must not change the amount owed. No third-party funds allocation or remittance workflow is in scope. Before live collection, confirm the specific Rescova legal entity and merchant account, required Pix/boleto/card rails, settlement currency and fee treatment. These choices affect money allocation and reconciliation; model selection does not resolve them.

Acceptance: full/partial/duplicate/late payment, wrong currency, wrong case, wrong merchant account, missing callback, provider timeout, refund and chargeback. Exactly one valid allocation; no premature closure; reminders stop or resume according to current policy and evidence.

## 4. Portfolio planner and unified eligibility

An active portfolio creates durable planning work. A lightweight scheduler wakes due cases; Rafael is invoked for genuine choice/ambiguity with a bounded budget. The planner chooses the next allowed action, channel and time using current debt state, promised payments, channel availability, prior outcomes and debtor preferences. It also supports “wait” and “stop”; active does not mean repeated daily outreach.

Move the existing legacy dispatcher toward the same task and eligibility contracts. The policy service handles local time windows, channel/contact preferences, cross-case contact stops, attempt budgets, hardship/dispute states, offer permissions and payment holds. Persist the reason for each next action and the policy version. A delayed task always rechecks eligibility at execution.

Connect real Twilio SMS inbound/outbound/status callbacks to Marina's existing conversation service. Link production-capable calling to the same case/task identity rather than spawning a new fictional Ana case. Retain browser tests as a separate provenance. Gmail test transport must evolve beyond one fixed recipient and registered demo threads; evaluate mailbox quotas, identity/routing and bounce evidence for the actual operating volume.

Acceptance: import a portfolio, activate it, choose eligible contacts, handle conversation/document request/payment acceptance, reconcile a sandbox payment and close the obligation without manual task creation. Verify a missed installment schedules one appropriate action, and opt-out/dispute/paid cases do not receive stale reminders.

## 5. Operational readiness and measured intelligence

Before a real multi-portfolio pilot: role-based access, case/portfolio access boundaries, durable distributed sessions, encrypted managed storage/secrets, backup restore drills, auditable provider callbacks, per-provider global concurrency/rate budgets, model cost limits, dead-letter diagnostics, queues/latency alerts and replay tools. Move beyond the synchronous SQL compatibility adapter when measured contention/latency warrants it; multiple API replicas require externalized voice/session state or explicit affinity and durable recovery.

Add a case-based evaluation set: missing/conflicting evidence, multiple loans for one person, ambiguous acceptance, changed terms, hardship, disputes, language switching, outdated offers, duplicate messages and model/provider outages. Judge grounded answers, correct tool actions, unauthorized-action rate, retrieval accuracy, task success, time-to-resolution, tokens/cost and confirmed recovery. Do not optimize merely for message volume or promise rate.

All channels need a coherent, source-backed case timeline and call summaries/transcripts linked to the same identity. Multi-tenant SaaS isolation is optional future scope, not a prerequisite for Rescova operating its own portfolios. A completed model run is not a successful collection. Introduce semantic retrieval only if measured lexical-search failures justify it; a knowledge graph is not on the critical path.

## Suggested handling of common situations

| Trigger                                                   | Accountable role / task                                       | Next action and completion evidence                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Email my contract” during a call                         | Helena retrieves; Marina fulfills after call                  | Pin approved document version; send on requested allowed channel; preserve provider submission reference                                                              |
| “I accept those installments” by SMS after an email offer | Marina / record agreement                                     | Read shared offer and delivery evidence; validate latest consent and exact terms; save once; schedule confirmation and installment monitoring                         |
| “I already paid”                                          | Theo planned / verify payment; Rafael while capability absent | Immediately hold collection reminders; match provider/ledger evidence; confirm allocation or request specific missing information; never mark paid from wording alone |
| Installment overdue                                       | Planner; Rafael if ambiguous                                  | Reconcile first; respect grace/wait states; then one proportionate reminder on an eligible channel                                                                    |
| Wrong phone number or opt-out                             | Coordinator policy update                                     | Block applicable destination/contact scope immediately; cancel pending prohibited commands; no blind channel switching to evade stop                                  |
| Debtor cannot pay                                         | Marina gathers only relevant facts; Rafael decides            | Explain existing permitted options or wait state; schedule agreed revisit; never invent discounts or threats                                                          |
| Document missing or contradictory                         | Helena / evidence request; Rafael / resolve conflict          | Identify source gap, request data via configured connector, wait for evidence event; no repeated unsupported assertions                                               |
| Gmail send times out                                      | Delivery service / reconcile uncertain send                   | Check stored provider identifiers/evidence; hold duplicate sends; retain explicit unresolved status if certainty cannot be established                                |
| Partial payment / refund                                  | Payment service; Theo handles exception                       | Post allocation/reversal once; recalculate current balance deterministically; planner evaluates appropriate next action                                               |
| Provider or model outage                                  | Coordinator / retry                                           | Bounded retries with backoff; preserve idempotency, budget and original channel; emit actionable blocked task when exhausted                                          |

## Milestones and indicative engineering effort

Estimates are planning ranges, not delivery promises. Assume one focused developer, existing code retained, a single-tenant Brazil pilot, and no provider onboarding delays. Include implementation and automated tests, not legal/provider approval or sustained production observation.

| Milestone                                                              | Incremental estimate                | Exit condition                                                             |
| ---------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| M1: truthful activity and agent task visibility                        | Current increment                   | Source-backed channel view and agent queue with explicit legacy gaps       |
| M2: canonical tasks, inbox/outbox, timers and one migrated workflow    | 4–7 working days                    | Replay/crash/dependency tests pass; no dual execution                      |
| M3: provider-neutral payment sandbox and reconciliation                | 5–10 working days                   | Ledger/payment edge-case suite and payment-to-follow-up loop pass          |
| M4: autonomous portfolio loop plus real channel integration            | 7–12 working days                   | Full bounded pilot workflow closes from import to verified sandbox payment |
| M5: deployment, identity/isolation, observability and evaluation gates | 10–20 working days, partly parallel | Pilot release checklist and restore/load/adversarial tests pass            |

A coherent controlled pilot is roughly 4–8 engineering weeks after this slice under those assumptions. A robust production platform requires additional field evidence and provider/operational work; a credible fixed completion date is not available yet. Re-estimate after each milestone using actual observed task complexity and failure rates.
