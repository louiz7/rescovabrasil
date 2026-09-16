# Payment simulation and provider boundary

## Implemented scope

Accepted demo agreements now create durable collection agreements, dated installments, one payment-request intent per installment and agent-owned payment tasks. The existing voice/text agreement flows remain the entry point. Payment amounts use integer minor units and currency; agreement terms are immutable. An original receivable, agreed amount, received amount and remaining installment amount are distinct facts.

**Only the simulator is activated.** No payment provider credentials, real checkout, real Pix charge or public payment webhook is enabled. `payments.example.invalid` links cannot collect money. Simulator evidence must never clear a real-payment report or be described as real recovery. The portfolio reports simulated receipts separately from actual recovery, which remains unavailable.

## Provider integration contract

`server/payment-provider.mjs` defines the replaceable boundary; `server/payments.mjs` owns accounting and workflow policy.

- `createRequest(request)`: async; receives immutable internal request ID/idempotency key, amount, currency, case/agreement/installment references and mode. Returns provider request reference and HTTPS payment URL. Request intents persist before network work. Retrying or recovering a crash uses the same key; attempts are bounded to three. Exhaustion creates a Rafael dependency task.
- `retrievePayment(storedPayment)`: async; returns an authoritative cumulative snapshot for reconciliation. The service checks payment/request correlation before applying it. Simulator retrieval explicitly reports unavailable, since simulator events are supplied through the authenticated test command.
- `verifyAndNormalizeWebhook(rawBody, headers)`: async; authenticates the original raw bytes using the provider's signature, timestamp and replay requirements, then returns a normalized snapshot. The simulator rejects public webhooks. There is intentionally no unauthenticated route feeding `applyEvent`.

Normalized snapshots contain `eventId`, `requestId`, `paymentId`, `version`, `currency`, `amountMinor` (immutable gross), `refundedMinor` (cumulative refund) and `status`: processing, succeeded, failed, refunded or reversed. Adapter IDs must be stable safe internal identifiers; namespace/hash provider payment IDs by provider/account/mode to avoid collisions, while retaining raw references in the adapter mapping. Internal case/request mapping must come from persisted request records, not a caller-supplied case ID. The adapter must supply reliable monotonic versions of authoritative payment snapshots. If the provider has no suitable version, fetch its current state and establish serialized reconciliation ordering; arrival timestamps alone are insufficient.

`applyEvent` is a trusted internal boundary. It validates currency, identity, immutable gross amount and transitions. The event inbox deduplicates provider/mode/event IDs, rejects conflicting duplicates/equal-version snapshots, records stale versions without changing balances, and applies snapshots atomically with allocations and tasks under the case lease. This supports snapshots arriving out of order. Provider-specific delta webhooks must be converted into authoritative cumulative snapshots before ingestion.

Activating a real integration requires its adapter and contract tests, provider/account selection at agreement/request registration, explicitly enabled sandbox/live configuration, authenticated raw-body webhook routing, and activation of provider reconciliation scheduling. The existing registration is intentionally restricted to demo agreements and the simulator. These activation gates are explicit changes, not a replacement of the ledger, case lookup or agent workflows. Live provider behavior still needs tested account eligibility, request expiry, settlement semantics, rate limits, reconciliation and operational recovery. Do not silently enable live requests by inserting credentials.

## Financial and agent behavior

- Processing/failed payments contribute no receipt. Succeeded payments contribute their gross amount; refunds reduce it; full reversals contribute zero.
- Allocation is capped at the targeted installment's remaining amount. Excess stays visible as unallocated credit and creates/reopens a Rafael reconciliation dependency; agents cannot silently shift it to another installment or issue a refund.
- All accepted events remain in the event inbox. Allocations are a reproducible projection over current versioned payment snapshots, not model-authored balances.
- Paid installments cancel pending reminders. Refunds/reversals recompute remaining amounts and reopen previously paid-cancelled reminders; they also create a payment-update task. Already delivered reminders remain historical evidence and are not resent automatically.
- Each installment has one due-date reminder. The simulator date control can exercise due/overdue behavior without changing the machine clock. Repeated ticks do not repeat delivered messages. A broader recurring collection cadence, reminder-before-due policy, payment retry strategy and generalized scheduling engine remain future work.
- Request readiness, source-call completion, conversation state, contact stops, suppression, portfolio pause, disputes and reported-payment restrictions are rechecked before notifications. In-flight payments hold reminders. Excess credit holds further collection reminders pending reconciliation.
- Initial instructions reuse the explicitly linked existing agreement message and its channel; email completion requires Gmail submission evidence. No second independent instruction message is generated. New payment updates/reminders are deliberately **virtual SMS only**, written into the shared conversation. They do not automatically send Gmail or real SMS.
- Marina owns deterministic payment notification tasks. Rafael owns unresolved payment reports, request creation failures and credit allocation dependencies. A task does not imply an unavailable specialist capability has been implemented. No model is needed to recompute money or render an exact payment receipt.
- Marina/Rafael retrieve `payment_status` through the shared case-scoped lookup. It includes source mode, installment balances, request references and task state. Voice agents retrieve bounded payment summaries through `get_test_context` after identity confirmation. New financial evidence participates in stale-generation checks. No agent gets a tool to mark money received or overwrite balances.
- A debtor saying “I paid” remains a separate recorded report and a reconciliation task, not provider evidence. Real-payment claims stay held while only simulation is connected.

## API and testing

Authenticated app routes:

- `GET /api/cases/:id/payments`: current agreements, requests, payments, tasks and summary.
- `POST /api/cases/:id/payments/simulate`: simulator input `{requestId,eventId,paymentId,status,amountMinor,currency,version}`. Use the same event ID and payload for a network retry. Reuse payment ID and increment version for status changes. For `refunded`, the UI amount is **cumulative refunded amount**; the service retains the original gross. `reversed` reverses the full original payment. A second real-world transfer would use a new payment ID.
- `POST /api/cases/:id/payments/tick`: optional `{date:"YYYY-MM-DD"}` for a single simulation scheduling pass. It does not persist a new global date. Worker ticks run automatically through the existing agent worker and case leases.

Quick test:

1. Complete a browser demo call or text conversation, accept an authorized plan and end the call. Existing accepted demos are imported into financial records without changing their terms.
2. Open the case's **Payments** tab. Inspect the schedule, request status and remaining amount. Initial requested-channel instructions still use the existing agreement handoff.
3. Select installment 1, create a succeeded payment for part of its amount, then record a second payment for the remainder (or change the same processing payment to succeeded without changing its gross amount).
4. Check the virtual SMS conversation for Marina's payment update. Ask “How much is left on my first installment?” and “What is still due on the whole plan?” The reply must use current lookup evidence and explicitly remain a demo.
5. Run scheduled checks on installment 1's due date. A fully paid installment should have no pending reminder; future installments remain queued.
6. Select an existing successful payment and simulate a cumulative refund or full reversal. Balances and pending work must change. Retry an identical event through the API to confirm no duplicate allocation or message.
7. Test an excess payment, processing state, paused portfolio and opt-out. Excess needs Rafael reconciliation; processing/restrictions must not create a collection reminder.

Tests use mocks/simulation, including SQLite and isolated PostgreSQL schemas. They establish controlled behavior, not real-provider settlement or production capacity.
