# Rescova workflow map

Updated: 15 September 2026. These diagrams describe the implementation unless explicitly marked **planned**. Update this file in the same change whenever a trigger, task state, agent responsibility, or delivery mechanism changes.

## Scope and ownership

Current delivery is **virtual SMS inside the authenticated operator app**. No document is emailed or physically texted by these workflows. The workspace is single-organization; multi-tenant authorization is not implemented. Name confirmation is pilot self-report, not documentary identity verification. Do not reuse virtual-inbox authorization for releasing real documents to external recipients.

| Role | Current responsibility | Implementation |
| --- | --- | --- |
| Clara | English GPT-Live conversation | Voice model with delegated domain tools |
| Sofia | Alternative Grok conversation | Voice model using shared domain tools |
| Lucas | GPT-Live tool execution decisions | Configurable backend model |
| Helena | Resolve a document request within one case | Deterministic retrieval specialist; no additional LLM call |
| Marina | Compose follow-ups, answer written questions, request documents | Provider-independent structured model adapter |
| Rafael | Own unresolved case decisions using refreshed context | Durable supervisor_review job; bounded guidance and specialist handoff |
| Coordinator | Persist, order, schedule, cancel and retry work | Application service |

Helena currently supports exact document type matching, not open-ended semantic search. She returns source metadata and an immutable document version. This narrow contract can later be implemented with search/OCR/storage connectors without changing the conversation or delivery interface.

## 1. Accepted payment agreement

```mermaid
sequenceDiagram
    actor Debtor
    participant Voice as Clara or Sofia
    participant Tools as Domain tools
    participant Case as Case database
    participant Queue as Coordinator
    participant Marina
    participant Inbox as Virtual SMS inbox
    Debtor->>Voice: Confirm name and accept authorized solution
    Voice->>Tools: agree_payment_solution
    Tools->>Case: Save agreement and source case
    Tools->>Queue: Persist agreement_followup
    Note over Case,Queue: Atomic save; one case per provider/session
    Queue-->>Queue: Wait for observed call end
    Voice->>Queue: Source call ended
    Queue->>Marina: Agreement, payment instructions, conversation
    Marina-->>Queue: Structured reply
    Queue->>Queue: Recheck case version and contact eligibility
    Queue->>Inbox: Save simulated message and exact payment block
    Debtor->>Inbox: Reply
    Inbox->>Queue: Durable inbound message and reply job
    Queue->>Marina: Updated case context and ordered history
```

A payment report is unverified. It never reduces the balance or increases confirmed recovery. The separate payment-follow-up draft remains an operator artifact, not proof of delivery.

## 2. Document request during a call

```mermaid
sequenceDiagram
    actor Debtor
    participant Voice as Voice agent
    participant Tools as Domain tools
    participant Queue as Coordinator
    participant Helena
    participant Rafael
    participant Store as Case document library
    participant Marina
    participant Inbox as Virtual SMS inbox
    Debtor->>Voice: Please send my loan agreement
    Voice->>Tools: request_case_document
    Tools->>Tools: Check name self-report and contact state
    Tools->>Queue: Save source case, request and job atomically
    Note over Tools,Queue: No payment agreement required
    Voice-->>Debtor: Request saved for the demo inbox
    Voice->>Queue: Source call ended
    Queue->>Queue: Check case eligibility
    Queue->>Helena: Resolve request for this case and kind
    Helena->>Store: Exact case/type lookup
    alt One matching document
        Store-->>Helena: Latest immutable version
        Helena-->>Queue: Document reference and source
        Queue->>Marina: Verified document context
        Marina-->>Queue: Short follow-up
        Queue->>Queue: Recheck case and document snapshot
        Queue->>Inbox: Simulated message with exact attachment
    else Missing or ambiguous
        Helena-->>Queue: Explicit retrieval failure
        Queue->>Queue: Persist supervisor_review with retrieval failure
        Queue->>Rafael: Fresh context and retrieval failure
        Rafael-->>Queue: awaiting_information with precise dependency
        Queue->>Inbox: Resolution acknowledgment without attachment
    end
```

Every newly persisted Ana demo source receives two clearly fictional text documents. Ordinary uploaded portfolio cases are not seeded. Uploads are plain text, at most 100 KiB, attached to a specific case. Reusing a title and type creates a new version; multiple distinct titles of one type require clarification instead of guessing. A resolved request stays pinned to its selected version.

Downloads require the authenticated operator session and matching case/document IDs. Attachments are rendered from stored IDs, never model-generated URLs. Original text is downloadable; only bounded excerpts are supplied to Marina for questions. Helena currently uses the database behind a library interface; external storage connectors, PDF/OCR ingestion and semantic retrieval are **planned**.

## 3. Written conversation and specialist requests

```mermaid
flowchart TD
    Inbound["Inbound virtual SMS"] --> Save["Save message with unique request ID"]
    Save --> Stop{"Explicit contact stop?"}
    Stop -->|Yes| Cancel["Record suppression and cancel pending work"]
    Stop -->|No| Reply["Queue ordered reply job"]
    Reply --> Context["Load case, agreement, documents and message history"]
    Context --> Marina["Marina selects a structured action"]
    Marina -->|Ordinary answer| Validate["Recheck current case before delivery"]
    Marina -->|Document request| Helena["Queue document_followup for Helena"]
    Helena --> Fulfill["Retrieve, then ask Marina to compose"]
    Fulfill --> Validate
    Marina -->|Uncertainty or unsupported request| Rafael["Queue supervisor_review for Rafael"]
    Rafael --> Fresh["Refresh case context, offers, documents and resolution history"]
    Fresh --> Decision{"Supervisor decision"}
    Decision -->|Answer or guidance| Guided["Queue marina_guided_reply"]
    Guided --> Validate
    Decision -->|Document needed| Helena
    Decision -->|Missing facts| Information["awaiting_information with next action"]
    Decision -->|Missing capability| Specialist["awaiting_specialist with required capability"]
    Decision -->|Outside authority or wrong recipient| Policy["blocked_policy with reason"]
    Marina -->|Payment reported| Verification["Record unverified report and restrict outreach"]
    Verification --> Rafael
    Marina -->|Opt out| Cancel
    Validate -->|Eligible| Deliver["Simulated message and attachment references"]
    Validate -->|Stale or blocked| Block["Cancel message and surface reason"]
```

The same source call maps to one case and one conversation whether documents or a payment agreement come first. Relevant delivered document excerpts persist through database references and are reloaded for subsequent questions. No global model conversation stores all debtors.

## 4. Durable task lifecycle

```mermaid
stateDiagram-v2
    [*] --> waiting_source_end: Request saved during call
    waiting_source_end --> queued: Observed source end
    queued --> running: Worker acquires next job
    running --> completed: Validated simulated delivery or recorded outcome
    running --> queued: Retryable failure below limit
    running --> failed: Three failed attempts
    failed --> queued: Operator retry
    queued --> paused: Operator takeover
    waiting_source_end --> paused: Operator takeover
    running --> paused: Operator takeover
    paused --> waiting_source_end: Resume before call ended
    paused --> queued: Resume after call ended
    queued --> cancelled: Suppression or blocking case change
    running --> cancelled: Stale context or contact stop
    waiting_source_end --> cancelled: Blocking outcome
    completed --> [*]
    cancelled --> [*]
```

The single-process worker serializes jobs. Restart requeues interrupted model generation, preserving request IDs and observed call-end records. Failed older jobs prevent later replies from overtaking them. Shared suppression, case restrictions and portfolio pause are checked before and after generation. A missing document creates a durable supervisor resolution, not endlessly retried generation.

Job statuses above are distinct from conversation resolution states below. A completed supervisor job can leave a conversation waiting for an actual dependency. The resolution stores its reason, next action and context; an absent capability is never represented as a completed specialist action.

```mermaid
stateDiagram-v2
    active --> active: Queue supervisor_review and marina_guided_reply
    active --> awaiting_information: Rafael identifies missing facts
    active --> awaiting_specialist: Rafael identifies unavailable capability
    active --> blocked_policy: Authority or recipient restriction
    awaiting_information --> active: New inbound clarification or eligible changed context
    awaiting_specialist --> active: New inbound clarification or eligible changed context
    blocked_policy --> active: Explicit recheck or inbound clarification subject to restrictions
    active --> stopped: Opt out
```

A recheck creates another supervisor job and re-evaluates current restrictions; it does not grant permission or clear a reported payment, dispute or contact stop. Information and specialist waits also monitor eligible context changes. An unchanged missing dependency does not create an endless model loop. There is no configured human channel for these virtual workflows. Requests for a person must be acknowledged transparently and remain blocked by that missing channel, not falsely reported as transferred.

## 5. Portfolio operation today

```mermaid
flowchart LR
    Upload["Import and validate cases"] --> Portfolio["Assign portfolio"]
    Portfolio --> Activate["Activate portfolio"]
    Activate --> Enroll["Enroll eligible cases in internal execution runs"]
    Enroll --> Attempts["Existing outreach queue and channel adapters"]
    Attempts --> Outcomes["Record attempts and outcomes"]
    Outcomes --> Overview["Portfolio progress and open tasks"]
    Activate --> Pause["Pause portfolio"]
    Pause --> Hold["Hold new work"]
```

This existing portfolio flow is separate from isolated voice-demo fulfillment. Its legacy outcome enums, imported-case review queues and explicit operator controls remain for compatibility; this change does not migrate every historic or manual process into autonomous execution. It does not yet implement a model-driven daily strategy loop or verified payment reconciliation. Demo source portfolios stay excluded from prospecting.

## Target architecture — planned, not implemented

```mermaid
flowchart TD
    Events["Incoming messages, due dates and payment events"] --> Coordinator["Durable coordinator"]
    Coordinator --> Planner["Case planner: choose next permitted task"]
    Planner --> Voice["Voice conversation"]
    Planner --> Written["Written communication across SMS, email and WhatsApp"]
    Voice --> Context["Case context service"]
    Written --> Context
    Planner --> Context
    Voice --> Library["Helena document specialist"]
    Written --> Library
    Library --> Connectors["Approved storage connectors and evidence index"]
    Context --> Records["Authoritative case, agreement, payment and event records"]
    Written --> Delivery["Recipient and release checks plus channel delivery adapters"]
    Delivery --> Events
    Planner --> Exceptions["Specialist resolution, information dependencies and policy blockers"]
    Exceptions --> Coordinator
```

Keep domain tools, task state, storage interfaces and message contracts independent of model providers. Introduce a new agent when its responsibilities and permissions differ enough to justify it. Planned steps include real two-way delivery, stronger external document-release authorization, after-call review, payment reconciliation, and continuous portfolio planning.

## Code map and acceptance

- Source-case and agreement persistence: server/demo-platform.mjs
- Voice document tool: server/browser-voice.mjs, server/grok-voice.mjs, server/twilio-test.mjs
- Document storage/retrieval: server/documents.mjs
- Ordering, shared context, delivery and cancellation: server/agent-workflows.mjs
- Model adapter and written agent policy: server/agent-models.mjs
- Case documents and conversation attachments: src/CaseDocuments.jsx, src/AgentConversations.jsx

To test manually: start a fresh browser voice test, confirm Ana Silva, ask for the original loan agreement, wait for the saved request, and end the test. Open Demo SMS conversations, download the attachment, ask a question about it, then request the account statement. No payment acceptance is needed. Test a payment agreement in the same call to confirm both tasks share one case.


## Written payment-option questions

For document-only Ana demo conversations, Marina receives the same approved offer catalog and dated schedules as the voice tools. Questions about installments or upfront discounts use an ordinary reply, without creating an agreement or escalating a routine question. Existing accepted agreements remain authoritative. The text agent can explain offers; recording acceptance through text is not implemented yet and must not be claimed.


## Supervisor resolution contract

Marina returns an unresolved request to Rafael rather than sending it to a human queue. Primary legacy `human_review` model decisions normalize to `escalate_supervisor`; Rafael's legacy or repeated escalation output becomes an explicit policy blocker. Supervisor jobs and guided Marina replies are separate durable executions, with provider-independent contracts and run traces.

A reported payment requires authoritative verification and restricts further collection; neither Rafael nor Marina can confirm receipt or clear balances. Saving text agreements and payment verification integrations remain unavailable capabilities in this slice. Missing documents route through Helena and then to an explicit information request if retrieval is missing or ambiguous. Opt-outs stop contact immediately without waiting for Rafael. Supervision never authorizes new terms, bypasses document release restrictions or changes an operator/portfolio pause.


## Escalation tracking

The Agents overview includes **Supervisor escalations**. Each distinct referral stores its original trigger and reason, case/conversation links, current status, next action, and creation/update times. Rechecks update the same escalation; another independent referral creates a new record. Resolved and cancelled entries remain available for diagnosis. The table shows the latest 200 records; older records remain stored and are available through the paginated endpoint.

```mermaid
flowchart LR
    Referral["Marina uncertainty, missing evidence or source outcome"] --> Record["Persist escalation with case and original reason"]
    Record --> Rafael["Durable supervisor_review"]
    Rafael --> Guidance["Guidance or specialist request"]
    Guidance --> Marina["Marina supplies the result"]
    Marina --> Resolved["Mark escalation resolved"]
    Rafael --> Wait["Record dependency and next action"]
    Wait --> Recheck["New context, reply or explicit recheck"]
    Recheck --> Rafael
    Record --> History["Agents escalation history and search"]
    Resolved --> History
    Wait --> History
```

Records begin with this implementation; historical human-review tasks are not falsely reclassified as Rafael consultations. Full workflow events and model runs remain accessible through the linked conversation. The API is GET /api/agent-workflows/escalations with an optional offset; it is protected by the same workspace authentication as case data.
