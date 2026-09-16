# Test the document fulfillment ticket

Use the local demo at http://127.0.0.1:5173. Existing OpenAI and Google Workspace configuration is required for browser voice and real test email. Test sender and recipient remain `louiz@rescova.de`. These steps send a real email to that configured test mailbox; SMS remains virtual. No payment is collected.

## Happy path

1. Open **Browser voice test** and start a fresh Ana Silva demo conversation. Confirm your name when asked.
2. Say: **“Please send my loan agreement to me by email.”** Use a fresh demo case so the seeded fictional contract is the sole matching loan agreement.
3. End the call. A requested handoff waits for call completion. Open **Agent tasks** and locate **Document fulfillment**. The parent ticket holds the request through retrieval, composition and sending; linked child records are not separate duplicate queue entries.
4. Click **View ticket**. It shows Helena's document retrieval, Marina's response, and submission of the linked email. Wait for **Completed**, then check **Closed** if it disappears from the active list. A successful email ticket contains a Gmail submission reference and a pinned document version. Submission does not prove mailbox delivery or reading; inspect the test inbox as the external check.
5. Open Gmail at `louiz@rescova.de` and inspect the message and attachment. Reply in that email thread, for example **“Which bank was this originally from?”** Marina should use the same case context. Registered test threads are polled; allow the next polling cycle and model generation.

For a cross-channel continuation, open the ticket's **Conversation**, use the existing demo SMS composer, ask for installment options and clearly accept one explained option. Verify the agreement in the case. Agreement handling is the existing demo capability; it does not collect money or turn this document ticket into a payment ticket.

## What the ticket means

- Waiting for call end: no follow-up is sent while the source call is still active.
- Waiting for information: no unambiguous matching document exists. The existing worker checks for a changed document catalog; waiting does not repeatedly call a model.
- Awaiting configuration / paused / blocked policy: the ticket retains the dependency and next action instead of pretending to send.
- Completed: the exact linked email was submitted with provider evidence.
- Simulated completed: the attachment was published in the virtual SMS inbox; no physical SMS was sent.
- Uncertain: the provider outcome is unresolved. Do not resend blindly; inspect the existing email delivery evidence.
- Failed: processing exhausted its configured budget or fulfillment deadline; inspect the recorded reason.

The current real-email adapter permits seeded fictional demo documents only. Uploaded PDFs support retrieval and virtual-SMS testing, but uploading an arbitrary document does not authorize external email release. Multiple matching titles are an explicit ambiguity, not permission to choose an arbitrary contract.

## Automated failure-path checks

The regression suite exercises repeated triggers, restart of workflow instances, immutable document versions, a missing document becoming available, stopped contact during generation, uncertain delivery, bounded retries and deadline expiry using isolated data and mocked providers. PostgreSQL variants run with `TEST_DATABASE_URL`. No database editing is needed for the happy-path test above.

The seven-day deadline and generation retry budget bound this document workflow. This is the first ticket type implemented on the existing workers; it is not yet a universal ticket engine or a payment reconciliation service.
