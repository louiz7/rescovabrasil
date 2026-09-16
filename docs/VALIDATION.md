# Nachweisstand

Datum: 14.09.2026. Lokal auf macOS, Node 22.18.0. Entwicklung aus einem leeren Repository; die vier beigefügten Quellen wurden zuvor ausgewertet (Tech-Deck per lokalem OCR). Aktuelle fachliche Entscheidungen stehen in `GOAL.md`.

## Bestanden

- `npm test`: **39/39** automatisierte Domänen-, API- und Realtime-Protokolltests, keine übersprungenen Tests. Darunter Import/Formatfehler/Duplikate, CSV/XLSX, Selbstauskunft, sensible Ergebnisfreigaben, Kontaktstopps/Neuimport, Pause, Absturz während des Versands, Kanalwechsel, Abstände, Queue-Fairness, Signaturprüfung, Ereigniswiederholung und Audio-Unterbrechung.
- `npm run build`: Produktionsbundle erfolgreich erstellt.
- `npm run test:e2e`: **2/2** Browserprüfungen bestanden, mit isolierter temporärer Demo-Datenbank und ohne Providerverkehr:
  - Portfolio → CSV mit fehlerhaften/duplizierten Zeilen → geprüfter Import → Kampagne → Start/Pause/Fortsetzen → simulierte Antwort → Aufgabe zuweisen/abschließen → unveränderter Saldo und persistenter Zustand nach Neuladen.
  - Mobile Navigation und Speicherung der Kontaktregeln bei 390 × 844 Pixeln, ohne horizontalen Seitenüberlauf.
- Desktop (1440 Pixel) und Mobile (390 Pixel) visuell im Chromium geprüft; keine JavaScript-Laufzeitfehler im vollständigen Testablauf.
- `npm audit`: **0 bekannte Schwachstellen** zum Zeitpunkt der Prüfung nach Aktualisierung betroffener Abhängigkeiten. Dies ist keine Garantie auf Fehlerfreiheit.
- `npm run benchmark`: **10.000 synthetische Fälle** im Einzelprozess und SQLite im Arbeitsspeicher: Validierung 242 ms, Übernahme 448 ms, Kampagnenanlage 287 ms, erste Queue-Reservierung 11 ms; **0 externe Requests**. Die Werte sind lokale Einzelmessungen, kein Produktionsdurchsatz/SLA. Der Test prüft zudem Fallanzahl und Verwendbarkeit.

## Im Test gefundene und behobene Probleme

- Ungültige Importzeilen konnten eine später gültige gleiche Referenz vorzeitig als Duplikat blockieren.
- Ungültige optionale Rückrufdaten konnten statt eines Validierungsfehlers einen internen Fehler erzeugen.
- Dauerhaft blockierte Kontakte am Anfang einer großen Queue konnten spätere kontaktierbare Fälle verzögern; solche Einträge bekommen jetzt einen späteren Prüfzeitpunkt.
- Realtime-Toolergebnisse konnten vor dem Ende der ursprünglichen Modellantwort eine überlappende Antwort auslösen. Die Bridge wartet auf das passende `response.done`.
- Verabschiedungen werden erst nach Bestätigung des tatsächlich abgespielten Audioendes beendet.
- Bei der Integrationsprüfung wurden veraltete Feldnamen zwischen API und UI (`reason`, `kind`) korrigiert und die Selbstauskunft-Semantik abgestimmt. Der vollständige Browserablauf prüft die resultierenden Ansichten.

## Offen und nicht als bestanden ausgegeben

- Echte Twilio-Anrufe/SMS, hörbare GPT-Realtime-Sprachqualität, Latenz, Kosten, tatsächliche Zustellung und reale Nutzerreaktionen.
- Öffentlicher HTTPS/WSS-Endpunkt, lokale Twilio-/OpenAI-Schlüssel sowie freigegebene reale Testempfänger wurden noch nicht eingerichtet bzw. bereitgestellt. Konten existieren laut Auftraggeber.
- SendGrid-Absender, Inbound-Parse-Domain und tatsächlicher E-Mail-Antwortpfad.
- WhatsApp-Outbound ist aufgrund der dokumentierten Policy-Einschränkung gesperrt.
- Betriebliche und rechtliche Freigabe des konkreten Brasilien-Piloten; horizontaler Lasttest, Multi-Tenancy und vollständiger Retentions-/Löschprozess sind kein behaupteter Lieferumfang.

Das lokale MVP kann geprüft werden. Der Auftraggeber hat den Live-Test ausdrücklich auf später verschoben und möchte zuerst die lokale App prüfen. Die echte Provider-/Pilotabnahme bleibt als separater nächster Schritt offen; dafür keine automatische Aktivierung oder erneute Rückfrage im lokalen Prüfschritt. Die nötigen Schritte und Prüffälle stehen in `PILOT.md` und im README. Bis dahin ist kein externer Empfänger kontaktiert worden.

## English operator interface

The operator interface, accessibility labels, import validation, backend errors, campaign statuses and generated follow-up reasons now use English. Brazil stays the target market: BRL, Brazilian contact details and time zones, and pt-BR debtor conversations. Existing known system/demo labels are translated for display without rewriting stored audit records or borrower replies. The CSV template uses supported English headers.

After this change: all 39 domain/API/Realtime tests and both desktop/mobile browser workflows passed; the production build and formatting check passed. The local demo server was restarted to load the updated code and `.env`. An OpenAI key is present with a plausible format; provider authentication and Realtime access have not been tested. Twilio credentials, sender number, public callback URL and authorized recipients remain unconfigured, and live sending remains disabled.

## Browser voice test

Implemented a browser WebRTC test using a fixed fictional case and isolated in-memory outcome handling. It requires only the configured OpenAI key; Twilio remains disabled. Authenticated session creation, ownership, idempotent tools, data isolation, missing/rejected credentials, redacted errors and expiry/hangup are covered by three additional API tests (42 total passing).

A short real OpenAI browser session was successfully established using Chromium with a synthetic microphone device: the data channel connected, one incoming audio track was attached and playback was active. The test was ended and the provider session hung up. This confirms the configured key can establish the requested gpt-realtime browser session; it does not establish human microphone quality, speech recognition accuracy or the deferred Twilio telephone acceptance. No real telephone recipient was contacted. The operator can open `/?voiceTest=1` and allow their own microphone to conduct that browser conversation.

## GPT-Live migration and overlapping-response regression

The browser harness now uses `gpt-live-1` and managed Responses delegation with `gpt-5.6-terra`, following the user-provided [GPT-Live guide](https://developers.openai.com/api/docs/guides/live). This replaces the old browser Realtime speech response loop. The voice model controls speech and interruption; application code only continues delegated backend tool work after collecting completed function items and submitting all results. Recoverable command errors no longer tear down the voice session.

Five regression tests cover absence of manual speech-triggered responses, delayed/reversed tool results, empty terminal output snapshots, stale response completion, partial cancelled tools and recoverable errors/cleanup. All **47 automated tests**, **3 browser tests**, production build and formatting checks passed.

A real GPT-Live browser test with a locally synthesized English microphone recording completed successfully: `session.started`, greeting instructions acknowledged, input/output transcript events, a delegated `confirm_identity` tool, self-reported-name UI confirmation, two completed backend responses, further voice output, zero API errors and confirmed `session.closed`. Only event counts and test assertions were logged; no conversation transcript was stored. This is evidence for the synthetic browser flow, not a claim of full human conversation or Twilio acceptance.


## Isolated Twilio frontend test — 2026-09-14

Added a separate real-phone test panel with approved-recipient consent, configuration checks, status polling and explicit hangup. Uses GPT-Live over WebSocket with Twilio PCMU at 8 kHz and the shared managed Responses tool handler. Test context is synthetic and portfolio data stays isolated. Persistent request IDs prevent duplicate dialing, signed callbacks bind call/account IDs, and uncertain provider creation blocks redialing.

Validation: all 56 Node tests passed, including simulated phone media, managed tool continuation, callback identity/status ordering, consent/allowlist gates, end-call lifecycle and timeout ambiguity. Production build and format checks passed. All four Playwright browser tests passed, including the disabled Twilio panel/deep link/mobile flow with zero call POSTs. No real Twilio call was placed; public HTTPS/WSS reachability and live provider behavior still require the authorized phone test.


## Grok browser sandbox — 2026-09-14

Separate xAI microphone test implemented against the official voice API reference. Five Grok backend tests pass: server-held credentials and PCM configuration, tool-output continuation/idempotency, client event restrictions and error redaction, cookie/origin/single-use handshake plus TTL, and congested/cancelled session handling. Existing suite passed before the final bounded-buffer/cancellation refinement (61 tests then; five Grok tests subsequently passed). Six Playwright tests passed, including actual AudioWorklet microphone capture with a mocked relay, playback, mute and cleanup. Production build and formatting passed. Running local config endpoint and worklet asset return200. XAI_API_KEY was initially added empty; by final smoke check a key was present and the test reported available. Model/voice defaults are set. No live xAI request has been made.


## Demo payment solution catalog and agreements — 2026-09-14

Added fixed fictional upfront/three/six-payment offers, shared by both browser providers and the isolated Twilio harness. Agent instructions require exact dated terms to be repeated and explicit acceptance before the new agreement action. Server enforces the catalog, self-report, contact state, demo-only context and idempotency. Existing agreement conflicts preserve original terms and request human review. Agreements are shown in the UI; no balance is cleared and no money moves.

All70 Node tests, six Playwright browser tests, build and formatting passed. Tests cover stable timezone/calendar dates, exact centavo totals, consent/identity gates, unauthorized terms, duplicate/conflicting acceptance, state recovery, production rejection and Twilio derived-agreement persistence. No live voice session or real telephone call was initiated for this change; conversational agreement behavior can now be tested manually.


## Platform persistence and payment follow-ups — 2026-09-14

Accepted demo agreements from both browser providers and Twilio now persist as protected platform cases, agreement schedules, open review tasks and editable SMS/email follow-up drafts. Browser defaults use a synthetic email; Twilio retains its authorized test recipient. Nonpayable demo-link/Pix placeholders are prefilled. All jobs remain outside outbound dispatch. Later outcomes update the saved case; opt-outs and other blocking outcomes cancel pending jobs, including related suppressed cases.

Validation:76 Node tests passed; targeted platform/browser suites passed again after extending cancellation to related suppressed cases. Build and formatting passed. Existing five browser flows passed, and the new agreement→savedcase→SMS/Pix draft editing→Followups flow passed after correcting its selectors. No external message or payment was sent.


## GPT-Live tool-result self-interruption — 2026-09-14

Found a duplicate voice-control path: browser and Twilio identity success callbacks appended Live instructions before the managed backend tool output/continuation. Official OpenAI guidance explicitly notes that instruction appends can interrupt current speech. Removed both result-time injections. Managed response.item.create + response.create remains the sole ordinary tool-result return path; startup greeting appends remain. Updated voice/backend prompts to finish short sentences naturally and return concise verified facts without a replacement greeting/speech.

Validation:13 relevant Node tests passed, production build and formatting passed, and a new browser regression passed with real synthetic remote audio playing through delayed identity-tool completion. It asserts peer/channel/audio remain live and no additional instruction/thinking/commentary append occurs after the startup greeting. A real45-second GPT-Live WebRTC test with synthetic caller input connected, confirmed identity, returned case details and sent only the two startup appends followed by tool outputs/backend continuations. No result-time voice instructions or command errors occurred. This verifies integration behavior; perceptual smoothness across arbitrary conversations still requires listening tests. No phone call was made.


## Local Whisper debug recording — 2026-09-14

Found existing MLX Whisper 0.4.3 in the local evaluation virtual environment, ffmpeg, and the cached whisper-small-mlx model. No package installation, model download, external transcription API, or telephone call was needed. An authenticated backend smoke test uploaded two synthetic WebM speaker tracks, including a 2.5-second assistant offset and a tool event, queued the real offline worker, and completed with four timestamped transcript segments covering both speakers. Both converted WAV playback routes returned HTTP 200. The synthetic smoke recording is labeled `synthetic-local-whisper-smoke`.

All 80 Node tests pass, including local debug upload ownership, audio/timeline bounds, safe event persistence, worker queue and shutdown recovery, and Twilio PCM capture. Browser recording tests use actual MediaRecorder with mocked providers and verify separate speaker uploads, completion order, playback capture, transcript review and deletion. These tests do not replace a fresh human browser or Twilio conversation. Production build and formatting checks pass.

A Chromium UI smoke test also used the actual running backend without mocked routes: signed in, opened Voice debug, selected the completed synthetic recording, rendered all four transcript segments and fetched both audio playback URLs successfully.


## Payment acceptance conversation — 2026-09-14

Removed the repeated full-schedule recital requirement from the shared demo payment tool description and the OpenAI frontend, delegated backend and Grok prompts. They now share one conversation policy: explain compact exact terms once, accept one clear contextual assent, preserve consent through delegation, and clarify only missing or changed terms. Equal payments can be grouped while preserving centavo differences and date exceptions. Identity, explicit consent, authorized offers, suppression and idempotent agreement storage remain enforced. Existing payment tests cover first-call success and same-offer retry without duplicate agreements. No saved transcript of the reported incident was available; no new live voice conversation was run to claim model-level verification.


## Portfolio-based ongoing operations — 2026-09-14

The primary UI now uses portfolios as persistent active/paused work mandates, with no campaign creation or campaign navigation. Existing execution history remains compatible. Each portfolio exposes coverage, attempts, confirmed contacts, responses, follow-ups, agreements, known balances and unavailable verified recovery. New eligible imports are enrolled once; exhausted and reviewed cases do not automatically restart. Legacy active/paused runs are adopted with their state preserved.

87 backend tests and all 8 browser tests pass. Browser coverage includes reviewed import, activation, pause preventing simulation, pause persisting across reload, resume, portfolio-scoped simulation, 25% coverage after one of four cases is contacted, payment-reported review and follow-up completion. Backend tests also verify unknown simulation scope rejection, cross-portfolio isolation, legacy adoption, idempotence and no invented recovered amount. Build and formatting pass. Local app restarted; authenticated browser smoke confirms portfolio detail renders and campaign navigation is absent. No external communications were initiated.

## Model-independent virtual SMS workflow and Agents overview — 2026-09-14

Implemented an atomic agreement-to-agent-job handoff, source-call end gating, persistent virtual SMS messages/history, bounded generation retries, per-conversation sequencing, pause/resume, stale-generation cancellation, and opt-out/payment-report/human-review actions. The coordinator uses normalized decisions; provider adapters support OpenAI Responses and OpenRouter/compatible Chat Completions. SMS and supervisor roles have independent profiles. Agents overview lists actual implemented roles and recorded workflow statistics without credentials.

All 106 Node tests and 10 browser tests pass. Added tests cover transaction rollback if handoff storage fails, authenticated voice agreement→call-end→virtual SMS→reply, inbound deduplication, source-end event ordering, restart recovery, cancellation during model generation, shared suppression, unauthorized payment text, model errors, and adapter request/response contracts. Browser checks cover polling without lost drafts, retry request IDs, pause/resume, model details and mobile Agents navigation. Production build and formatting checks pass. After adding startup recovery of persisted terminal Twilio source states, eight relevant integration/phone tests passed again.

Actual OpenAI API smoke tests used synthetic, in-memory demo data with the existing local key. `gpt-5.6-luna` generated the initial follow-up, then a second run answered the first-installment question correctly from the saved agreement (R$416.67, September 21, 2026). Both jobs completed and produced the expected two outbound plus one inbound virtual messages. There was no physical SMS, Twilio call or email dispatch. OpenRouter and supervisor escalation were verified with mock providers, not live credentials/model requests.

The local `.env` enables the virtual agent workflow and selects OpenAI Luna/Terra. `.env.example` leaves it opt-in. The app has been restarted; the next newly accepted voice-demo agreement can enter the workflow. Historical agreements are not bulk replayed. Uncertain call closure remains waiting rather than inventing an end event. This slice does not implement autonomous daily portfolio strategy or real two-way SMS transport.


## Document librarian and virtual fulfillment — 2026-09-15

Added case-scoped immutable text documents, demo seeds, exact-type retrieval by Helena, document requests from all three voice test adapters, and document-only source cases. The existing coordinator now handles post-call document jobs and routes attachments through Marina's virtual SMS conversation. Written replies can request another document and receive delivered evidence excerpts, with explicit truncation metadata. Agreement and document requests from one source share a case and conversation.

Validation: 121 Node tests passed, including document-only HTTP end-to-end handoff, exact authenticated attachment download, cross-case rejection, missing/ambiguous documents, request deduplication, restart, later agreement attachment, and pause/STOP during generation. All 11 browser tests and the production build passed. A real configured OpenAI model generated a document follow-up in a synthetic in-memory workflow with the correct attachment; an earlier smoke invocation entered the bounded retry state, so this is not a latency/reliability benchmark. Human voice behavior still needs a fresh listening test.

No real phone call, SMS, email or payment was initiated. Helena uses deterministic retrieval in this slice; external storage, PDF/OCR and real document release are not implemented. Workflow diagrams and future boundaries are maintained in WORKFLOWS.md.


## Durable supervisor resolution, escalation tracking and card layout — 2026-09-15

Marina now delegates uncertainty through a persisted Rafael job. Rafael reloads case evidence and can guide a Marina response, request document retrieval or retain an explicit waiting dependency. New enabled demo workflows do not create default human-review tasks. Payment reports remain unverified and collection restrictions are preserved. Historical review records are not silently rewritten. Escalation history retains original reasons, status, next steps and direct case/conversation links, including resolved work. Duplicate source events and repeated missing-document requests are bounded.

Validation: all 136 Node tests, 17 browser tests and the production build passed. A real configured OpenAI smoke test on synthetic in-memory data exercised Rafael guidance followed by Marina presenting authorized installment options. No real call, SMS, email or payment was sent. Browser regressions verify waiting-state replies/rechecks, escalation navigation and filters, independent desktop card stacks, mobile ordering, keyboard expansion and no horizontal overflow. Desktop and mobile screenshots were inspected. Agent cards no longer leave empty grid rows when their heights differ or details expand.


## Google Workspace email and written payment acceptance — 2026-09-16

Implemented a fixed-recipient Gmail transport, local OAuth setup helper, persistent per-conversation email bindings/outbox, thread-scoped reply polling and an English Email test UI. Existing agent roles and provider-neutral model adapters are reused. Written acceptance records an authorized previously presented offer through shared agreement persistence; application code renders the exact dated terms and requires submitted email evidence before email acceptance.

All 164 Node tests and 20 browser tests passed, as did the production build and diff whitespace check. After the final pause handling adjustment, all eight email-workflow regressions passed again. Mocked Gmail tests cover MIME/attachments, account verification, fixed addresses, thread headers, duplicate/own/automatic message filtering, source document isolation, uncertain-send restart behavior, pause-before-send, long-reply isolation, STOP and the full reply → offer → consent → saved agreement → payment-details email path. Existing voice, document, supervisor and portfolio regressions remain passing. An authenticated local HTTP smoke verified the new endpoint and missing-configuration status; unauthenticated access returns 401.

No real email, phone call or payment was sent. Google OAuth consent and an actual Gmail round trip remain unverified until the user creates/authorizes a Google Cloud OAuth client. EMAIL_TEST_ENABLED is false by default, including the prepared local env. Gmail API acceptance is represented as submitted, never proof of delivery/read. Incoming attachments/HTML-only mail, arbitrary recipients, operator-uploaded document release, bounce reconciliation and uncertain-send reconciliation remain out of scope. Setup and complete manual testing are documented in EMAIL_TEST.md; workflow diagrams are updated in WORKFLOWS.md.


## Agent-requested channels and cross-channel case continuity — 2026-09-16

Removed manual email activation from the required document-request workflow. Browser/OpenAI, Grok and Twilio share a document tool with email/SMS channel selection. An email request persists its delivery binding immediately, waits for observed call end, and is sent automatically when Google configuration is available. Missing configuration is durable awaiting_configuration. Written document requests can also select email. Per-message channels and per-job routing snapshots preserve one case conversation across SMS/email; a new inbound channel cannot redirect already queued work. Payment acceptance checks the channel and submission evidence of the original offer, not merely the latest inbound channel.

Validation: all 174 Node tests, 22 browser tests and the production build passed. The HTTP voice integration exercises spoken email request → no send before call end → one automatic email with exact attachment, without preview/start calls. Cross-channel regressions exercise email offer → demo SMS acceptance → one persisted agreement and SMS confirmation, missing-configuration recovery without manual per-case activation, duplicate routing stability, unsent-offer rejection and queued-channel isolation. Browser tests verify shared history, a usable demo SMS composer after email and automatic email dependency states. No real Gmail or phone messages were sent; Google OAuth remains required and SMS remains the virtual case inbox.


## Creditor context repair — 2026-09-16

Marina previously received only case name, reference and language; the portfolio creditor was omitted. Shared context now includes an allowlisted case summary and linked portfolio facts for Marina/Rafael, with source guidance and snapshot invalidation on changes. Regression coverage reproduces document email → SMS creditor question, verifies Banco Horizonte (fictional) and recorded amount/currency, preserves missing due dates as null and verifies refreshed creditor data. All 175 Node tests passed. No customer message was resent or fabricated to correct historical conversation output.


The shared knowledge extension adds case-scoped events, notes, tasks, contact attempts, payment follow-ups, document requests, delivery records and indexed excerpts to each Marina/Rafael invocation. A separate regression verifies fresh task notes, document presence and cross-case isolation. All 176 Node tests pass after this extension. Full call transcripts remain outside this context and long documents are explicitly marked as excerpts; no claim of complete transcript/document ingestion is made.


## On-demand case lookup — 2026-09-16

Replaced the broad case-knowledge prompt injection with a provider-neutral lookup action. Model input omits portfolio/detail facts and document bodies, includes the last 24 messages, and can request case details, notes/activity, documents/pages, payment terms, delivery and earlier history. The coordinator scopes queries to the current case, bounds repeated lookups and traces additional model calls. All 183 Node tests pass, including the creditor lookup integration, provider schema validation, document pagination beyond the first 6,000 characters, cross-case rejection and bounded lookup loops. Existing document tests now verify that attachment delivery does not require injecting full text into the model. No vector search or knowledge graph was installed, and no customer message was automatically resent.


## PostgreSQL, durable workers and Helena retrieval — 16 September 2026

- Full Node suite with `TEST_DATABASE_URL`: **202 passed, zero failures or skips**. Covers real PostgreSQL API/import/dashboard, cross-channel agreement acceptance, migration reconciliation, concurrent leases/fencing, worker startup/shutdown, ranked document retrieval, PDF extraction and installed OCR.
- Browser suite: **22 passed**. Production build passed; `git diff --check` clean.
- Isolated PostgreSQL workload: 200 cases, four worker processes, peak 16 simultaneous model stubs, 200 outputs, zero duplicate case generations. Elapsed 2,058 ms using a deterministic 100 ms mock; this is coordination validation, not real provider capacity.
- Migrated the local SQLite snapshot to `rescova_app`: 21 cases and 221 total persisted rows, verified during atomic migration. Original database and `data/backups/pre-postgres-20260916.sqlite` retained. Local authenticated dashboard, portfolios, agents and worker health endpoints return HTTP 200; health reports PostgreSQL and one embedded worker.
- Installed Poppler/Tesseract with English and Portuguese data. Local OCR configured `eng+por`. Document originals and database require coordinated backups; see OPERATIONS.md and RETRIEVAL.md.
- Verification used mocked communications; no synthetic live messages or calls were initiated. Existing authorized Gmail configuration remains enabled for normal app use.
- Remaining boundaries: one API process, synchronous SQL compatibility adapter, shared local document storage, no global provider quota service, no semantic embeddings/knowledge graph, no claimed production throughput for hundreds of live calls.


## Outreach projection and agent task list — 16 September 2026

208 Node tests passed with PostgreSQL enabled; 23 browser tests in the full run plus one new focused channel/mobile test passed. Production build, formatting checks on changed implementation files and diff check passed. Inspected real local PostgreSQL dashboard/task endpoints (HTTP 200) and rendered both views. No synthetic provider calls/messages initiated.

Regression checks cover zero-day calendar buckets, provider-ID deduplication, real versus simulated transport, queued/cancelled exclusions, Gmail submission evidence, virtual SMS delivery classification, actual task ownership, unresolved supervisor state, pagination, legacy task separation and mobile channel filtering. Outreach is a current-record projection: email buckets use latest send-state update; historical event times are not reconstructed. Browser sessions without debug records are not counted. See ASSESSMENT.md for current readiness and AGENTIC_ROADMAP.md for planned canonical task and payment infrastructure.


## Durable document tickets — 16 September 2026

222 Node tests passed with TEST_DATABASE_URL enabled; 25 browser tests passed; production build and changed-file formatting/diff checks passed. New tests cover request deduplication, fixed source channel, source-end wait, workflow recreation/restart, pinned document version, exact Gmail attachment/submission receipt, later document availability, no model calls while waiting, contact stop during drafting, three-attempt failure, seven-day expiry and uncertain send without resend. Existing explicit manual email activation of a completed virtual SMS remains compatible.

Local PostgreSQL API startup and endpoint access checked: unauthenticated ticket lookup 401, authenticated Agent tasks 200, unknown ticket 404. New tests used mocked providers and isolated databases; actual browser/Gmail happy path remains user-operated using DOCUMENT_TICKET_TEST.md. No historical tickets are backfilled and no old communication is replayed.
