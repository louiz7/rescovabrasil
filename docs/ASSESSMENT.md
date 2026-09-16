# Product maturity assessment

Updated: 16 September 2026. Confirmed scope: exclusively purchased receivables owned by Rescova; no third-party servicing or remittance. Original lender, current owner and acquisition evidence remain separate.

Target: a Brazil collections platform that continuously coordinates case work across channels, verifies payments and takes authorized next actions with agent ownership. “Fully agentic” means routine work has executable ownership and evidence-based outcomes; it does not mean a model can invent unavailable data, permissions or payment receipts.

## Assessment method

Use the same levels after each major change: **0** absent; **1** partial implementation or isolated capability; **2** integrated and tested in controlled/demo flows; **3** verified in a bounded real-provider pilot; **4** operationally proven against representative workloads, failures and business outcomes. Record evidence and gaps, not just feature counts. A provider-backed test on a fictional case is not a production pilot.

This is a maturity rubric, not a percentage of code completed. As an engineering judgment, the coherent demo is around **60–70%** of the way to its complete import-to-payment story; readiness for a reliable autonomous collections pilot is around **25–35%**. These broad ranges depend on the pilot scope and do not predict production reliability. The biggest missing dependency is verified money state and the continuous portfolio loop, not additional model personas.

## Current baseline

| Capability | Level | Existing evidence | Missing to reach the next material milestone |
| --- | --- | --- | --- |
| Case/portfolio data and imports | 2 | CSV/XLSX validation, portfolio views and PostgreSQL persistence tested | Real lender datasets, versioned creditor policy and durable external identity mapping |
| Shared case knowledge | 2 | Cross-channel lookup, case-scoped versioned PDF/OCR/full-text retrieval; user confirmed reference retrieval and correct unknown-date answer | Unified call evidence, conflicting-source resolution tests, retrieval evaluation corpus |
| Voice | 2 | Browser demos and Twilio test integration with payment/document tools | General portfolio cases, durable linked call lifecycle/transcripts, production callback and reconnect coverage |
| SMS | 1 | Virtual SMS uses Marina and persists shared case history/acceptance | Real inbound/outbound/status adapter and live-pilot routing/eligibility |
| Email | 2 | Google Workspace fixed-mailbox test and replies work; shared offer acceptance tests | General debtor routing, delivery/bounce evidence, mailbox operating limits and pilot observation |
| Agent work execution | 2 | Durable jobs, case leases, fencing, recovery, supervisor dependencies and ingestion workers tested | Unified typed task commands, inbox/outbox, dependency deadlines and migration of legacy tasks |
| Continuous portfolio strategy | 1 | Portfolio activation and legacy dispatch exist; Rafael resolves conversation exceptions | Unified daily/due-case planning, contact budget, agreement timers and evidence-based replanning |
| Payments and reconciliation | 2 | Integrated simulator: immutable schedules, request intents, versioned event inbox, capped allocations, partial payments, refunds/reversals, notifications and balance lookup tested on SQLite/PostgreSQL | Activated provider adapter, authenticated public webhook, scheduled external reconciliation, settlement/expiry rules and live evidence |
| Policy and action authority | 1 | Contact stops, consent/offer validation and case checks in existing flows | One policy service spanning all commands and provider adapters; creditor configuration and wider scenario validation |
| Runtime and observability | 1 | PostgreSQL, independent workers, worker health and mocked concurrency benchmark | Async SQL path as needed, global quotas, distributed sessions, durable voice recovery, managed storage and tested restore |
| Evaluation and economics | 1 | Automated regression tests, model usage traces and some live user testing | Representative scenario benchmarks, groundedness/action metrics, cost budgets and confirmed recovery outcomes |
| Access and security | 1 | Single-workspace operator login and case-scoped tools | Role-based access, audit access, data lifecycle controls and deployment hardening; multi-tenancy only if future scope requires it |

The rubric totals **18/48**. This number is a progress signal across these twelve dimensions, not proof that 38% of the final engineering work is finished. It can go down when a previously assumed capability fails representative testing.

## Latest increment: activity and agent task visibility

The implementation in this increment projects persisted communications by channel and exposes existing agent work in a dedicated task list. Exact source coverage, provenance and any unavailable history must be explicit in the UI. Historical manual tasks are not silently converted into completed agent work. The task screen is a read projection over existing execution, not yet a new general-purpose ticket orchestrator.

This improves oversight and makes gaps visible; it does **not** change the payment level, turn virtual SMS into real SMS, or establish production capacity. Verification for the increment is appended below when complete. Prior baseline: 202 Node tests, 22 browser tests, successful build; 200 mocked cases across four worker processes with no duplicate outputs. That benchmark uses mocked model/provider latency and is not a live-call throughput claim.

## Critical missing end-to-end behavior

1. A verified financial state and allocation ledger that can distinguish promised, reported, processing, received, allocated, refunded and disputed payments.
2. Canonical agent tasks with accountable roles, due timers, dependencies, completion contracts and durable inbox/outbox effects.
3. An active portfolio planner using these tasks and current eligibility, rather than separate demo and legacy execution paths.
4. Real SMS and generalized email/calling adapters sharing case identity, traceable conversation state and contact policy.
5. A pilot-ready operating environment: quotas, budgets, restore/replay, case identity, role-based access controls, source-linked call history and quality evaluation.

The next delivery target is **M2: a canonical task/outbox/timer layer with one migrated document workflow and a sandbox payment-verification workflow**, followed by M3 payment reconciliation. See [AGENTIC_ROADMAP.md](AGENTIC_ROADMAP.md) for sequence, situations, acceptance tests and effort ranges.

## Update record for future substantial changes

Append a dated entry with: scope; previously missing behavior now executable; exact tests/live evidence; unresolved failure modes and dependencies; changes to the matrix; next milestone and revised estimate. Mention the assessment delta in the user-facing delivery summary. Planned features remain planned until exercised; adding names, models or UI cards does not raise a capability's score.


### Verified delivery: 16 September 2026 — activity and agent work

Delivered channel-filtered actual outreach records, separate provider-backed/simulated counts, queued-versus-attempt distinction, and explicit unavailable delivery/read evidence. Virtual SMS completion status is correctly treated as simulated delivery. The Agent tasks view shows current ownership and dependencies, links to existing controls and isolates legacy follow-ups. Local PostgreSQL dashboard and agent-task endpoints return HTTP 200; the UI was inspected on the current workspace.

Validation: **208 Node tests passed with PostgreSQL enabled; 24 browser tests passed (23-suite run plus the new focused channel/mobile test); build and diff/format checks passed.** Tests used isolated data and mocked communications. No synthetic live outreach was initiated for this change.

Maturity delta: greater visibility and source coverage; no promotion to real-pilot or verified-payments maturity. Canonical task commands and payment reconciliation remain the next executable gaps. Confirmed product scope is collection of Rescova-owned purchased receivables only; third-party remittance is removed from the near-term plan. The original creditor remains separately recorded from Rescova as current owner. Engineering estimate remains approximately 4–8 focused engineering weeks to the defined controlled pilot, subject to provider fit and field validation.


### Presentation refinement — 16 September 2026

Outreach Overview now uses one stacked chart and a compact channel/color legend, with one aggregate external/simulated split. Detailed per-channel status lists and explanatory paragraphs were removed from this summary; backend evidence and task state remain unchanged. This is a presentation refinement with no maturity-score change.

Next concrete delivery: give the existing document-request-to-email workflow one durable parent ticket, linked child work, explicit dependencies, bounded retries and a completion contract based on provider submission evidence. Reuse current workers and email delivery records; do not introduce parallel executors. Demonstrate restart/replay safety, delayed document availability and a contact stop during generation. Payment verification should then reuse this contract once the payment adapter and ledger exist.


### Durable document fulfillment — 16 September 2026

New behavior: a durable parent document ticket correlates the requested document, existing executor job, pinned document version, composed message and delivery evidence. It waits for call end, waits without model retries for absent/ambiguous evidence, resumes when a unique matching document appears, holds uncertain sends, and enforces a generation retry budget and seven-day deadline. Agent tasks shows one parent with inspectable child stages instead of duplicate rows. Existing historical jobs are not silently migrated or resent.

Maturity delta: agent execution remains level 2, with stronger crash/replay/dependency coverage for this first workflow. This completes the document-ticket portion of M2, not the complete generic inbox/outbox/timer platform. Current remaining gaps: external evidence connectors and release-policy resolution, automated reconciliation of uncertain sends, a universal task command contract, payment ledger/provider adapter and continuous portfolio planning. Payment maturity remains 0; no money collection is introduced. Next concrete slice: provider-neutral sandbox payment records and a “reported paid” verification task with deterministic allocation and evidence-based follow-up. Reuse the document contract's ownership and completion conventions; full pilot engineering estimate remains 4–8 weeks, with scope re-estimated after payment tests.

The model/provider-backed happy path is ready for the user's existing browser/Gmail setup; automated verification uses isolated cases and mocked providers. Test procedure: [DOCUMENT_TICKET_TEST.md](DOCUMENT_TICKET_TEST.md). Exact validation results are recorded below after the final run.


Final validation for this increment: **222 Node tests passed with PostgreSQL enabled (zero failures/skips), 25 browser tests passed, production build and changed-file formatting/diff checks passed.** Fourteen new ticket scenarios run across SQLite/PostgreSQL. Local PostgreSQL API verified authenticated task access, authentication enforcement and missing-ticket 404 responses. No new real provider send/call was initiated for verification. Parent status and step evidence are visible through the authenticated detail endpoint and the responsive ticket dialog.


### Shared modal spacing — 16 September 2026

Dialog content now receives its outer padding from the shared Modal component, with aligned headers/footers, responsive insets and consistent form-field/grid spacing. Existing component body wrappers no longer add duplicate outer padding. Desktop/mobile ticket and portfolio forms were visually inspected with no horizontal overflow; all 25 browser tests and the production build passed. Presentation only: no workflow or maturity-level change.


### Supervisor loop correction — 16 September 2026

A real local demo exposed 31 supervisor executions after “3 installments please”: payment consent validation called the supervisor referral path again from supervisor/guided jobs, bypassing per-job retry limits. Missing consent for valid sent offers now produces a Marina clarification without supervisor work. A referral guard prevents supervisor/guided jobs from referring back to Rafael, and current resolution transitions synchronize outstanding escalation records. The affected settled conversation's 30 stale queued/guidance records were reconciled to resolved, retaining all 31 executed jobs as history.

Evidence: Node suite 210 passed, 14 skipped (224 total); all 15 payment-agreement tests additionally passed against isolated PostgreSQL schemas. Regression covers two presented offers, selection without consent, subsequent explicit acceptance, repeated worker ticks, supervisor payment rejection and stale escalation state. No new external messages were sent for verification. Live-model conversational retest remains to be done. This fixes a demonstrated reliability defect; maturity scores and estimates stay unchanged. Global agent budgets and broader adversarial workflow evaluations remain gaps; next milestone remains sandbox payment verification and the shared task/outbox/timer layer.


### Payment simulation foundation — 16 September 2026

Accepted demo agreements now initialize structured installments and provider request intents. The simulator uses a replaceable async provider contract; request retries reuse stable idempotency keys. Versioned events, allocations and notification tasks update atomically under case leases. Duplicate/stale snapshots, partial receipts, cumulative refunds, full reversals, excess credit, suppression and pending payments have explicit behavior. Payment requests and reconciliation dependencies are visible in case Payments and agent work; the portfolio shows simulated receipts separately from real recovery. Initial instruction tasks correlate to existing agreement delivery evidence instead of sending another independent message.

Marina and Rafael retrieve current payment state on demand; confirmed voice sessions get compact current summaries. Financial versions participate in stale model-output checks. No LLM writes balances. A debtor report remains unverified while only the simulator is connected. New payment updates/reminders are virtual SMS, shared in the case conversation; initial agreed email delivery keeps the existing Gmail evidence requirements.

Evidence: **253 backend tests passed, none skipped**, with TEST_DATABASE_URL enabled for isolated PostgreSQL tests; **27 browser tests passed**, including real isolated backend agreement → UI payment → task → portfolio flow (only external model/voice mocked). Build passed. Integration tests prove a fresh Marina lookup after partial/full installment payment, no duplicate instructions, and cancellation of paid-installment reminders while later ones stay queued. No live-provider financial test was run.

Assessment delta: payment/reconciliation rises from 0 to 2 for controlled simulation, total **18/48**. The demo is more complete, but the prior production-pilot readiness range of 25–35% stays unchanged pending real-provider evidence. This is not a live payment integration or a general autonomous collection strategy. Provider mode/registration activation, signed webhook routing, periodic external reconciliation, unmatched provider-event resolution, expiring payment requests, real notification channels, recurring cadence and operational recovery remain gaps. Rafael's excess-credit/request-failure tasks wait for authorized capabilities; no refund/credit-allocation agent is falsely claimed operational.

Next milestone: choose an eligible payment provider/account and implement its sandbox adapter against the existing contract, including callback verification, ordering/replay tests and reconciliation. Follow with reminder cadence, inbox/outbox migration and production operations. Indicative effort remains scope-dependent: adapter sandbox integration and evidence typically require a focused implementation milestone rather than a platform rewrite; no reliable live date can be assigned before provider/account requirements are known.

### Agent oversight UI — 16 September 2026

Replaced expanded agent cards with a compact team directory, per-agent detail views and an interactive collaboration map. Details expose owner-filtered durable work, recorded runs, responsibilities, limits, setup and connections; Rafael's escalation history lives on his own page. The map separates six agent identities from deterministic workflow/context/payment services and distinguishes handoffs from information access. Connections are registry descriptions of supported integration, not live traffic or executive reporting lines. Shared foundation nodes can be selected to inspect their dependencies.

Validation: production build; five registry/task-projection tests on SQLite and PostgreSQL; full 27-test browser suite, with focused navigation/mobile/connection checks after final polish. Scope is oversight and accurate capability metadata; execution policy and workflow triggers are unchanged. Assessment remains 18/48 and pilot estimate unchanged. Next functional milestone remains a provider-backed sandbox payment integration.

### Task timing clarity — 16 September 2026

Agent tasks and per-agent detail views separate Ready now, Scheduled and Waiting. The overview metric now counts due/running work. Future execution dates use the case timezone, document fulfillment deadlines do not delay runnable work, and dependency states take precedence over dates. Scheduled work sorts by earliest due date before pagination. This is a read-only presentation change; reminder execution and financial state are unchanged. The current Marina dataset correctly projects 0 ready, 12 scheduled and 0 waiting. Readiness remains 18/48; next functional milestone is unchanged.

Verification for task timing: 7 backend checks including PostgreSQL timezone-boundary/filter tests, 9 relevant browser cases (agent detail/navigation, timing tabs, ticket view and mobile overflow) and production build passed. Future tasks remain scheduled rather than being deleted or prematurely completed.

### GPT Live focus — 16 September 2026

Retired the Grok comparison test, its runtime/API/WebSocket wiring, dedicated audio assets and Sofia's active registry entry. Clara remains the GPT Live voice agent, Lucas remains the delegated case-tool agent, and browser/Twilio testing is retained. The team map reflects five agents. Historical provider records and recordings remain readable. This reduces maintained surface area; it adds no autonomous capability or production-readiness points. Assessment stays 18/48 and the next functional milestone remains payment-provider sandbox integration.

Verification: 250 backend tests passed with PostgreSQL enabled and no skips; production build passed. Browser verification covers retained voice flows and the revised team map. No provider call was initiated for this cleanup.
