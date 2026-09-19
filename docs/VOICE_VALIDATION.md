# Voice acceptance and scale gates

Updated: 17 September 2026. Current scope: English fictional Brazil case, browser and allowlisted Twilio tests. Run fresh sessions after server changes. No actual payment is collected.

## Recorded acceptance matrix

Run each scenario at least three times before accepting a prompt/model change. Preserve recording, source session, backend response/tool timeline and resulting case ID. A mocked test cannot prove speech quality.

| Scenario | Expected evidence |
| --- | --- |
| Answer only “Yes” to the named identity question | One successful self-report tool; proactive reason for calling and one relevant question without another user prompt. Measure answer-to-delegation and result-to-explanation separately. Investigate gaps above five seconds; this is an evaluation target, not a provider SLA. |
| Silence, ambiguous greeting or wrong person | No financial disclosure and no false identity confirmation. |
| Ask for balance and payment options | BRL amounts spoken as Brazilian reais/centavos throughout; no dollars or conversion. Correct total and centavo differences. |
| Interrupt with a currency correction | Brief correction, preserve currency in subsequent replies, do not restart the whole schedule. |
| Choose three installments and explicitly accept | One agreement, one concise acknowledgment, no repeated schedule or second acceptance demand. |
| Ask a further question after acceptance | Call remains available; successful agreement alone never closes it. |
| “Please end the call” before or after confirmation | One goodbye, end_call, no new mutations, bounded close, source-end follow-up release. |
| “Stop contacting me and end the call” | Persist opt-out before ending; no future contact from the source workflow. |
| Simulate payment on the newly opened case | Correct case Payments view; virtual SMS balance answer uses that case's ledger. |
| Tool failure, delayed result, browser disconnect | No invented success, no duplicate agreement, bounded cleanup; trace distinguishes failed/uncertain from completed work. |

Inspect backend text separately from Whisper audio transcripts: speech recognition may normalize currency symbols and hallucinate during silence. Backend response completion does not itself prove spoken output or playback completion.

## Before thousands of calls

Planned, not implemented by the behavior fix:

- Replace isolated Ana fixtures with explicit portfolio case binding and durable call/session ownership.
- Apply distributed provider admission, concurrency and rate controls; handle quota failures without redial loops.
- Persist call state/events and reconcile provider disconnects, lost callbacks and worker restarts.
- Use asynchronous scalable recording/transcription storage and workers; local Whisper remains a debugging facility.
- Establish pronunciation/disclosure/consent accuracy, response latency percentiles, escalation rates, duplicate-action rate and cost per completed call on representative recordings.
- Increase provider-backed load in stages against agreed quotas; measure concurrent calls separately from daily call volume.

The 1,000-controller unit test checks only session-local close timers and isolation. It is not evidence of telephony throughput or consistent model behavior across 1,000 conversations.
