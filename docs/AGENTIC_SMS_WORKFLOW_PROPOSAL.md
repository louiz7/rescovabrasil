# Proposal: agreement handoff to a persistent SMS agent

Status: first virtual SMS slice implemented, 14 September 2026. The original proposal below records design intent; implementation notes and model-agnostic configuration are in README.md. Physical SMS delivery remains disabled.

## Decision

Use a central, durable workflow coordinator with specialist agents. The coordinator owns task state, scheduling, conversation ownership and execution permissions. A model-based supervisor handles ambiguous routing and replanning when needed. The first fixed agreement-to-SMS route does not need an additional model decision.

This separates two responsibilities: a model decides what an appropriate next step is; application code determines whether that step may execute, persists it and survives failures. An agent is a reusable role instantiated for a case or task, not a permanent process for each debtor. An active portfolio wakes work on events or due times; it does not run an endless inference loop.

OpenAI distinguishes handoffs (a specialist owns the next conversational branch) from agents-as-tools (a manager retains the answer and calls bounded helpers), and recommends adding specialists where responsibilities actually differ. Our SMS specialist owns the text conversation; a later supervisor calls analysis/planning specialists as tools. The durable cross-channel transfer is an application task, not merely an in-memory SDK handoff. [OpenAI orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)

## First vertical slice

1. The existing voice agent calls `agree_payment_solution`. The validated agreement and its exact schedule are persisted in the platform, with an agreement version and unique source identity.
2. In the same platform transaction, create an `agreement.accepted` outbox event and a pending `agreement_followup` task. Do not re-derive whether acceptance occurred from Whisper: the successful domain tool is the source of truth.
3. Release the task after the call ends, so a subsequent correction or opt-out in that call takes precedence. Persist call-end state across both event orders and server restarts. If call closure is uncertain, wait for reconciliation; never infer success from elapsed time alone.
4. The coordinator chooses SMS under this demo's explicit channel policy, checks the bound destination and assigns the task to `payment_conversation_agent`. Missing SMS contact produces a visible blocked task. It does not silently choose email or invent a phone number.
5. The agent loads the case, accepted agreement, permitted payment instructions, language, contact state and a short handoff summary. It produces a short follow-up and submits it through the messaging tool. Amounts, installment dates and payment links come from validated records; the model cannot alter them or mark payment as received.
6. The outbound service records the pending message, performs final eligibility checks, sends through the chosen adapter and records delivery status separately from generation. A generated reply is not a sent message; a delivered SMS is not confirmed payment.
7. A reply becomes a durable inbound message and wakes the same conversation owner. The SMS agent answers follow-up questions, retrieves payment details, records a reported payment or requests review. It does not restart name/plan confirmation when the same bound demo participant continues. A changed/unrecognized contact or contradictory identity requires clarification.
8. “Stop contacting me,” a dispute or a human takeover cancels pending outbound work. “I paid” becomes an unverified payment report. A request to change the agreed plan creates review/replanning work; it does not silently replace the agreement.

For the first demo, use a clearly labeled virtual SMS inbox in the app: real OpenAI-generated messages and replies, simulated delivery. It works for browser calls without a phone number and permits rapid testing without physical texts. Twilio is a second adapter on the same task/conversation flow, activated separately for an explicitly configured SMS-capable sender and authorized recipient. Existing phone-call credentials do not establish two-way SMS capability. The fictional demo link and Pix placeholder remain nonpayable.

## Agent roles and model choice

| Role | Initial implementation | Responsibility |
| --- | --- | --- |
| Voice agent | Existing GPT Live / Grok test | Conversation and validated agreement tool |
| Payment conversation agent | `gpt-5.6-luna`, low reasoning initially | SMS formulation and multi-turn payment support |
| Supervisor | `gpt-5.6-terra`, invoked on exceptions | Resolve ambiguous next steps, route work, propose a bounded plan |
| Coordinator / delivery worker | Application code | Persist, schedule, enforce policy, execute and reconcile |

Luna is documented as a cost-sensitive high-volume text model; Terra balances intelligence and cost. Both support Responses, structured outputs and function calling. This is a proposed starting configuration, not a measured quality claim. Test English and Brazilian Portuguese, contextual acceptance, opt-out, changed terms, missing contact and misleading payment instructions before allowing automatic external sending. If Luna fails those evaluations, use Terra for the conversation role as well. Model access in this account has not been tested in this research step. [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)

The supervisor is logically central but not a single shared conversation for every portfolio. It receives scoped case/portfolio context and acts on a finite task. Routine incoming replies stay with the SMS agent. Later daily portfolio planning wakes on a schedule, inspects changed state and assigns tasks through the same coordinator.

## Runtime and shared state

Updated by the model-agnostic requirement: use a small normalized provider runner in the existing Node service, with OpenAI Responses and OpenRouter/compatible Chat Completions adapters. The earlier Agents SDK recommendation is deferred. Reuse existing domain functions as narrow tools. The runner produces validated domain decisions and allows one bounded supervisor consultation; the application retains durable business state and the message queue. No separate service for every agent is necessary now. [OpenAI runtime comparison](https://developers.openai.com/api/docs/guides/agents)

Choose one history strategy: an application-backed persistent history for each conversation. Store authoritative agreement/case state separately and reload it through tools. Do not mix full local replay with chained provider history, which risks duplicating context. [OpenAI state strategies](https://developers.openai.com/api/docs/guides/agents/running-agents)

Proposed records:

- `agent_tasks`: case, portfolio, purpose, assigned role, state, due time, attempt count, lease, idempotency key, source event and state version.
- `conversations`: case, channel, transport, destination binding, owning role, language, status and durable session reference.
- `conversation_messages`: inbound/outbound direction, body, source/provider ID, sequence, status and timestamps.
- `agent_runs`: role/model/prompt version, task, tools, result, latency, token usage and trace ID.
- `outbox_events`: typed events committed with domain changes; consumed idempotently.

Existing agreement and follow-up records should be extended or linked, not duplicated with divergent terms. Keep the existing human `tasks` table for operator exceptions: its one-open-task-per-case constraint is unsuitable for independent agent jobs. The existing audit event log also needs explicit processing/checkpoint state before it can drive reliable subscriptions. Agent-to-agent communication uses typed tasks/events and bounded results, with references to shared case state. It does not broadcast all transcripts to every agent.

## Reliability and permission boundaries

Commit agreement/event/task atomically in the persistent platform database. Consume events idempotently and preserve ordering within a case. A transactional outbox addresses the failure gap between saving a record and notifying downstream work. [AWS outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

Allow one writer per conversation; serialize incoming turns and reject stale actions against a changed case version. Recheck pause, opt-out, review state and agreement version at send time, not only when drafting. A task purpose distinguishes initial outreach, agreement fulfillment and inbound replies. Apply appropriate limits per purpose; do not reuse prospecting delays blindly for a live text dialogue and do not remove shared contact stops.

Use bounded model/tool iterations, retry budgets and visible terminal states. On ambiguous provider-send timeouts, reconcile before another attempt. Local idempotency alone cannot guarantee exactly-once external SMS delivery. Trace the whole agreement → task → agent → outbound → reply path with a common correlation ID.

SQLite and one worker are sufficient to validate this slice. Preserve repository/queue interfaces so PostgreSQL and a durable workflow runtime can replace them when multiple workers and long-running timers justify it. Do not add Kafka, a distributed agent mesh or an autonomous supervisor loop merely because many agent roles are planned.

## Existing code and required changes

The app already persists voice-demo agreements, creates platform cases and follow-up drafts, and cancels drafts on relevant stop/review outcomes. Those are useful integration points. Current drafts intentionally cannot send; promoting a draft must be an explicit new workflow state.

Current inbound processing targets live outreach attempts, parses Brazilian phone numbers and sends ordinary replies to human review. It is not yet a persistent conversational SMS router and would reject the existing German test destination. The sandbox needs its own explicit contact binding; real test routing must support configured international E.164 contacts without weakening Brazilian portfolio import validation.

Demo agreement cases currently start under human review. Introduce a specific authorization for demo agreement fulfillment; do not globally bypass `review_required`, opt-out or the existing suppression checks. Likewise, the isolated voice-demo portfolio must remain excluded from prospecting activation. Demo conversation permission belongs to the accepted-agreement test workflow.

## UI and acceptance criteria

Add a Conversations tab to the case and an activity stream showing agreement saved, task queued, SMS agent started, message sent in demo, reply received and escalation. Show active role, transport and current task state. The virtual debtor pane lets the operator reply as the demo participant.

Acceptance: one accepted demo agreement starts exactly one initial follow-up after call closure; the agent retains context across multiple replies and server restart; duplicate events/replies do not duplicate work; stop/correction between drafting and sending cancels the send; human takeover stops automatic replies; unknown destinations block clearly; payment reports never increase verified recovery. Normal successful demo follow-ups do not require manual draft approval.
