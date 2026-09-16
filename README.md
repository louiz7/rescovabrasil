# Rescova Brasil

Outreach-MVP für überfällige Kreditfälle in Brasilien. React-Oberfläche auf Englisch; Schuldnerkommunikation in pt-BR, Node.js/Express, SQLite, Twilio Voice/SMS, OpenAI GPT Realtime und optional SendGrid. Produktziel und Quellenanalyse: [docs/GOAL.md](docs/GOAL.md).

## Lokal starten

Voraussetzung: Node.js **22.18 oder höher**, npm. SQLite ist in Node 22 noch experimentell; die entsprechende Laufzeitwarnung ist zu erwarten.

```sh
npm ci
npm run dev
```

Öffnen: http://127.0.0.1:5173. Demo-Passwort: **rescova-demo**. API: http://127.0.0.1:3001. Beide Prozesse starten gemeinsam. Ohne `.env` wird nur der Demo-Datenraum verwendet. Darin werden fiktive brasilianische Fälle bereitgestellt; es wird nichts versendet. `SEED_DEMO=false` startet eine leere Datenbank.

```sh
npm test
npm run build
npm start
```

Nach dem Build liefert Port 3001 auch die Oberfläche aus. Der Produktionsbuild aktiviert **keinen** Realversand. Optionaler Browsertest: `npx playwright install chromium`, danach `npm run test:e2e` (siehe Testkonfiguration).

## Kernablauf

1. Unter **Portfolios → New portfolio** Kreditgeber und Zeitzone anlegen.
2. **Import file** öffnen, CSV/XLSX laden, Spalten zuordnen und geprüfte Zeilen übernehmen. Beispiel: [examples/carteira-br.csv](examples/carteira-br.csv), einschließlich absichtlicher Datenfehler und eines Duplikats.
3. **View progress** öffnen, verfügbare Kanäle und deren Reihenfolge wählen und **Activate demo portfolio** bzw. **Go live** ausführen. Das Portfolio bleibt ohne Enddatum aktiv; **Pause portfolio** stoppt neue Kontakte.
4. Im Demo-Modus über **Simulate portfolio contact** gezielt einen Kontakt und ein Ergebnis für dieses Portfolio erzeugen. Zeitvorlauf überspringt nur im Simulator Kontaktfenster/Abstände; eine Demo erzeugt nie Provideranfragen.
5. Fortschritt in der Portfolioübersicht verfolgen; unter **View cases** einzelne Ergebnisse und Chroniken öffnen. Aufgaben unter **Follow-ups** bearbeiten. **Payment reported** und vereinbarte Beträge sind keine bestätigten Zahlungseingänge.

## Import

- CSV: UTF-8, Komma oder Semikolon, erste Zeile mit eindeutigen Headern. Excel: `.xlsx`, erstes Arbeitsblatt; keine Makros oder Formelauswertung.
- Höchstens 10 MB, 10.000 Datenzeilen und 100 Spalten; XLSX zusätzlich 50 MB deklariertes unkomprimiertes Archivvolumen.
- Beträge: `1.234,56`, `1234,56` oder `1234.56`; intern Centavos. Fehlender Betrag bleibt unbekannt. Der Pilot akzeptiert BRL; kein FX.
- Telefonnummern: brasilianische Nummer mit DDD, z. B. `(11) 99900-1001` oder `+5511999001001`. Unvollständige/ausländische Nummern werden nicht erfunden.
- Datum: `DD/MM/AAAA` oder `AAAA-MM-DD`; Zeitzonen als IANA-Wert, z. B. `America/Sao_Paulo`, `America/Manaus`, `America/Rio_Branco`.
- Referenzen innerhalb eines Portfolios eindeutig. Gleicher Kontakt über mehrere Referenzen erzeugt eine Warnung; Kontaktstopps werden trotzdem kontaktübergreifend berücksichtigt.
- Keine zusätzlichen Identifikatoren nötig: die ausdrückliche Namensbestätigung im Gespräch genügt im Pilot und wird als **Selbstauskunft** gespeichert. Kein Bank-OTP, keine PIN, kein CPF. Ohne bekannten Namen bleibt die Ansprache neutral und wird zur Klärung weitergegeben.
- Rohdaten im Importprüfbereich werden nach erfolgreicher Übernahme verworfen; der Prüfbericht bleibt. Abgebrochene Imports werden nach 24 Stunden bereinigt. Vollständige Gesprächs-Audiotranskripte werden standardmäßig nicht gespeichert.

## Twilio und OpenAI anschließen

1. `.env.example` nach `.env` kopieren. Schlüssel lokal eintragen. Ein eigener Live-Datenraum wird über `OUTREACH_MODE=live` verwendet. Demo-Datenbanken können nicht in Live umgeschaltet werden.
2. Starkes `OPERATOR_PASSWORD` setzen. Der Realmodus verwendet Secure-Sitzungscookies; die Oberfläche muss über den öffentlichen **HTTPS**-Endpunkt geöffnet werden. API und WebSockets über denselben Reverse Proxy verfügbar machen.
3. `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `OPENAI_API_KEY` und `PUBLIC_BASE_URL` setzen. Der Twilio-Absender muss für das jeweilige Land/den Kanal provisioniert sein. Modellzugriff und Guthaben müssen im OpenAI-Konto vorliegen.
4. In Twilio den eingehenden SMS-Webhook auf `https://DEINE-DOMAIN/hooks/twilio/inbound` (POST) setzen. Ausgehende Status- und Voice-URLs übermittelt die App pro Versuch automatisch. Den Originalhost/-pfad beim Proxy erhalten: Signaturen werden gegen `PUBLIC_BASE_URL + originalUrl` geprüft.
5. HTTPS/WSS auf `/media/:attemptId` erlauben. Nur Twilio-signierte Handshakes werden angenommen. Codec PCMU/8 kHz. Anrufe haben eine harte Begrenzung von fünf Minuten. Es wird kein Roh-Audio aufgenommen.
6. Eine kleine reale Testdatei mit **eigenen freigegebenen Testkontakten** importieren. Empfänger in `OUTBOUND_ALLOWLIST` eintragen. Portfolio-Konfiguration und Skript prüfen, erst dann `LIVE_SEND_ENABLED=true` setzen und Server neu starten. Außerhalb der Liste wird kein Versand ausgeführt.

Die KI erhält auf Wunsch des Auftraggebers direkt die Forderungsdetails. Sie soll diese erst nach ausdrücklicher Namensbestätigung aussprechen. Diese Offenlegungsgrenze beruht auf Gesprächsanweisungen, nicht auf einer technischen Isolation der Daten vom Modell. Die Bestätigung wird ausdrücklich als Selbstauskunft protokolliert (`identity_method=self_reported_name`), nicht als dokumentarischer Identitätsnachweis. Sensible Ergebniswerte, Opt-out und Aufgaben werden zusätzlich serverseitig validiert. Ein Kontaktempfänger kann jederzeit ohne Namensbestätigung einen Kontaktstopp verlangen.

„Übergabe“ bedeutet in diesem MVP eine persistente Aufgabe für einen Menschen. Es gibt keine behauptete Live-Telefonweiterleitung und keine automatische Genehmigung von Ratenplänen. Der Agent darf nur autorisierte Fakten nennen, Zahlungsabsicht erfassen und eine Prüfung anstoßen.

## E-Mail

SendGrid braucht einen separaten API-Key und einen verifizierten Absender. Zusätzlich `EMAIL_REPLY_TO`, `EMAIL_INBOUND_SECRET` und `SENDGRID_EVENT_PUBLIC_KEY` konfigurieren.

- Event Webhook: `https://DEINE-DOMAIN/hooks/sendgrid/events`. **Signed Event Webhook** aktivieren, Verification Key in `.env` setzen. Verarbeitet werden Zustell-/Fehlerereignisse und Abmeldungen; Open-/Tracking-Pixel werden nicht als Antwort gewertet.
- SendGrid Inbound Parse (MX und empfangende Domain konfigurieren): `https://rescova:DEIN_SECRET@DEINE-DOMAIN/hooks/email/inbound`. Authentisierung per HTTP Basic über TLS. Erwartet `from`, `text`, `headers` mit `Message-ID`; Anhänge werden ignoriert. Alternativ kann ein vertrauenswürdiger Mailadapter JSON `{ "messageId": "...", "from": "...", "text": "..." }` mit derselben Authentisierung liefern.
- Nachrichten werden nur zu früheren ausgehenden Versuchen zugeordnet. Mehrdeutige Kontakte erzeugen Klärungsaufgaben; Freitext wird nicht als bestätigte finanzielle Aussage klassifiziert. Eindeutige Stopps werden direkt berücksichtigt.

## WhatsApp

Der Kanal ist in Modell und Oberfläche vorhanden, aber Outbound bleibt für diesen Debt-Collection-Anwendungsfall gesperrt. Die gelesene [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy) führt Debt Collection unter Einschränkungen auf. Vorlagenfreigabe und Opt-in allein klären diese Einschränkung nicht. Es gibt keinen Schalter zur Umgehung durch anders formulierte Nachrichten.

## Betriebsgrenzen

- Ein Arbeitsbereich, ein Operator-Passwort, ein Serverprozess. Keine Multi-Tenant-SaaS-Freigabe, Benutzerrollen oder horizontale Skalierung. API liest Falllisten paginiert; Importlimit ist ausdrücklich begrenzt.
- Queue ist persistent/transaktional, Provideraufrufe sind naturgemäß nicht atomar mit der Datenbank. Ein Timeout/Absturz beim Versand kann bedeuten, dass der Provider bereits gesendet hat. Solche Fälle werden angehalten und müssen im Providerportal abgeglichen werden; keine automatische Wiederholung.
- Kanalwechsel erst nach Wartezeit ohne Antwort. Ein angenommener Anruf zählt nicht als bestätigte Identität. Providerfehler werden nicht als Zahlungsunwilligkeit interpretiert.
- Default Mo–Fr 09–18 Uhr, 24h Abstand, maximal 3 Versuche. Diese Werte sind Produktdefaults, keine pauschale Rechtsfreigabe. Landes-/kommunale Regeln, Feiertage, Mandat und individuelle Präferenzen müssen zum Pilot passen. Ausschlusstage und lokale Zeitzone sind konfigurierbar.
- Opt-out sperrt Fall und bekannte identische Kontaktadressen. Eine erledigte Aufgabe hebt keine Sperre auf. Die Oberfläche kann geprüfte ungesperrte Fälle begründet wieder freigeben; aufgehobene Opt-outs brauchen einen außerhalb des Pilots validierten neuen Autorisierungsprozess.
- Lokale SQLite-Dateien sind nicht durch die Anwendung verschlüsselt. Zugriff über restriktive Betriebssystemrechte und verschlüsselten Datenträger; für öffentlichen Betrieb HTTPS, sichere Serverkonfiguration und passende Datenverarbeitungsverträge vorsehen. Auditeinträge sind für Operatoren nicht editierbar, aber nicht kryptografisch manipulationssicher gegenüber Datenbankadministratoren.
- End-to-End-Telefonie, Sprachqualität, Akzentverständnis, Kosten und tatsächliche Zustellung können erst mit konfigurierten Konten und freigegebenen Testempfängern abgenommen werden. Lokale Tests sind kein Nachweis eines realen Anrufs.

## Daten und Aufbewahrung

Daten standardmäßig unter `data/`, getrennt nach Betriebsmodus; das Verzeichnis ist git-ignoriert. `.env` und SQLite-Dateien niemals committen. Vor einem Backup den Prozess geordnet stoppen und die Datenbank samt eventuell verbleibenden `-wal`/`-shm` Dateien sichern; für laufenden Betrieb ist ein konsistentes SQLite-Backupverfahren erforderlich. Ein Restore muss mit demselben Betriebsmodus erfolgen.

Für abgebrochene Imports und technische Wiederholungsbelege steht `npm run maintenance` bereit. Finanzfall-/Nachrichten-/Ergebnishistorie wird nicht eigenmächtig gelöscht: die konkrete Retentionsfrist und Löschprozesse sind vor Realbetrieb vom Verantwortlichen festzulegen. Der MVP trainiert keine Modelle mit Gesprächsdaten und exportiert keine Daten an Analytics-Drittanbieter.

## Browser voice test (no phone call)

Open `http://127.0.0.1:5173/?voiceTest=1`, sign in, then start the browser voice test and allow microphone access. It uses the configured `OPENAI_API_KEY`, `OPENAI_LIVE_MODEL` (default `gpt-live-1`) and `OPENAI_LIVE_BACKEND_MODEL` (default `gpt-5.6-terra`) with your browser microphone and speakers. GPT-Live handles continuous speech; a managed Responses backend handles name confirmation and outcome tools. No Twilio setup, public callback URL, campaign or phone number is needed. This is a real OpenAI audio session with API usage, not the offline outcome simulator.

The fixed synthetic borrower is Ana Silva, case BROWSER-TEST-001, BRL 1,250.00 owed to the fictional Banco Horizonte. The browser test AI currently speaks English for testing. Production debtor outreach remains Brazilian Portuguese. Test identity confirmation and outcomes use an isolated in-memory case; they do not change your imported portfolio or outreach metrics. Stop using End test; sessions also expire after five minutes. Use headphones to reduce echo. Microphone access requires localhost or HTTPS.

The server exchanges the browser SDP offer with [OpenAI Live sessions](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live). The permanent API key stays on the server. Audio is sent to OpenAI for the requested conversation. When local voice debugging is enabled, the app also retains recordings and local Whisper transcripts as described below.


## Twilio phone test

Open `http://127.0.0.1:5173/?twilioTest=1` or choose **Twilio phone test** on Overview. This places a real telephone call only after you select an approved number and explicitly confirm authorization. The English conversation uses the same synthetic Ana Silva case and GPT-Live/Responses tools as the browser test. Results stay separate from imported portfolios and campaigns. Name confirmation is recorded as self-reported. The call is capped at five minutes.

Configure these values in the local `.env`, then restart the server:

- `TWILIO_ACCOUNT_SID`: Twilio account SID.
- `TWILIO_AUTH_TOKEN`: account auth token; remains server-side.
- `TWILIO_PHONE_NUMBER`: your Twilio Voice-capable caller number in E.164 format.
- `PUBLIC_BASE_URL`: public HTTPS origin forwarding to the app backend on port 3001, with WebSocket upgrades supported. Preserve paths and forward `/hooks/twilio-test/*` and `/twilio-test-media/*`; a tunnel to Vite alone is insufficient.
- `OUTBOUND_ALLOWLIST`: your authorized recipient number(s), comma-separated, in E.164 format.
- `OPENAI_API_KEY`: existing key with access to the configured Live and backend models.
- `TWILIO_TEST_ENABLED=true`: enable this isolated test. Campaign dispatch remains governed independently by `OUTREACH_MODE` and `LIVE_SEND_ENABLED`.

The panel reports configuration presence, not provider credentials or network reachability verification. The app submits per-call voice/status callback URLs automatically. **End call** requests Twilio termination; closing the panel leaves the call running and you can reopen it. An uncertain provider response blocks another call until reconciliation; retrying the same request never redials. When local voice debugging is enabled, this harness records incoming and outbound audio for local Whisper transcription. Test call status, recipient number and derived tool results are retained locally.

## Demo payment solutions

The GPT Live browser and Twilio voice tests share the fictional payment catalog in `examples/demo-payment-offers.json`: 10% discount for payment today (BRL1,125 on a BRL1,250 balance), or three/six interest-free monthly installments totaling BRL1,250, beginning in seven days. Dates follow the case timezone, America/Sao_Paulo. Integer minor-unit arithmetic distributes centavos exactly and month-end dates are clamped to the target month's final day.

The existing identity and outcome functions remain, with `agree_payment_solution` added as an action and `get_test_context` retained for state/offer lookup. After self-reported identity confirmation, the agent receives current dated offers, briefly summarizes the selected total, payment amounts/count, frequency and first/final dates, then submits the selected offer ID with `accepted:true` after one clear contextual acceptance. Equal payments may be grouped; centavo differences and date exceptions stay exact. Reading every month aloud and asking for a second confirmation are not required. Consent already given survives backend delegation. The application computes terms and rejects unknown/customized offers, unconfirmed identity, blocked contact or conflicting agreements. The same offer can be retried without creating another agreement. Only fictional test data is affected; no payment is taken, no real contract is created, and no balance is cleared. Accepted agreements in the demo workspace now create a durable case under Voice test demos, a review task, and an unsent payment follow-up draft. Audio and transcripts are retained only when local voice debugging is enabled. The Twilio harness also retains its derived agreement with the test call record. Production campaign behavior is unchanged.


## Platform cases and payment follow-up drafts

An accepted agreement in an OpenAI or Twilio demo test creates one idempotent platform case per provider/session. The case includes the agreement schedule and an open review task. Browser tests use the synthetic email ana.silva@example.invalid; Twilio tests use the authorized test phone for an SMS draft. Payment instructions default to an explicitly nonpayable example.invalid link and the invalid placeholder DEMO-PIX-NOT-PAYABLE.

Open the saved case to inspect or edit the follow-up channel (SMS/email), recipient and payment instructions. Saving regenerates the preview; missing values block readiness, and cancellation is supported. These jobs are reviewable drafts, are never claimed by the campaign dispatcher, and cannot send messages. An opt-out, dispute, wrong contact, human-review request or reported payment after acceptance updates the saved case and cancels pending follow-ups. Existing imported cases are not modified by the demo session.


## GPT-Live tool results and speech continuity

Managed Responses delegation is the single return path for ordinary tool results. After all required function outputs are submitted with `response.item.create`, `response.create` continues backend work; it does not request a new voice turn. UI callbacks update the displayed result only. Do not append another Live instruction or commentary when identity, an outcome or a payment agreement succeeds: that duplicates the managed result and can interrupt ongoing speech. Startup greeting instructions remain separate. Use mid-conversation instructions only for deliberate redirection; there is no app-controlled wait-for-speech timer for ordinary tool results. See [OpenAI delegation guidance](https://developers.openai.com/api/docs/guides/live-delegation#send-the-right-kind-of-update).


## Local Whisper voice debugging

With `VOICE_DEBUG_ENABLED=true`, new GPT Live browser tests and the isolated Twilio phone test record both speakers and queue local transcription when the test ends. On Overview, open **Voice debug** to select a session, replay each speaker, inspect timestamped Whisper segments and tool events, or delete its recordings and transcript. End the browser test and allow uploads to finish before closing the browser tab. Browser recording requires MediaRecorder; OpenAI assistant playback additionally requires audio captureStream support (use Chrome/Chromium).

Configure `WHISPER_PYTHON` to the existing local Python executable containing Whisper, `WHISPER_MODEL` to an existing cached model directory, `FFMPEG_PATH` to ffmpeg, and optionally `VOICE_DEBUG_DIR` (default `data/voice-debug`). This machine uses MLX Whisper 0.4.3 from the existing evaluation virtual environment and its cached whisper-small-mlx model. The worker runs offline, with automatic language detection and no cloud transcription fallback or model download. Voice conversations themselves still use their selected OpenAI/xAI provider.

Recordings last at most five minutes, with uploads limited to 30 MB per speaker. One local worker processes the queue; recordings and transcripts remain in the ignored data directory until explicitly deleted. Debug access requires platform login. Incoming uploads belong to their creating login session; authenticated operators can review and delete saved debug sessions after signing in again. This is a debug facility for the three test flows, not automatic production campaign recording. Historical calls without saved audio cannot be reconstructed.

Browser assistant recordings capture played audio. Twilio assistant recordings capture the outbound stream with estimated playback timing, so they do not prove what the handset actually played. Tool timelines store event types, timestamps and approved tool names, not raw tool arguments. Whisper transcripts may contain recognition errors.


## Portfolio operations

Portfolios are the lasting work mandate. Open **Portfolios → View progress**, choose the channel order and activate the portfolio. There is no end date; pause it to stop new work. The screen shows contact coverage, reached cases, responses, attempts, open follow-ups, agreements and recent activity. Agreed amounts are promises, not recovered funds; confirmed recovery remains unavailable until payment reconciliation exists.

Campaign records remain internal queue/history objects for compatibility. Activation reuses existing work, and active portfolios admit newly imported eligible cases without requiring another campaign. Completed, exhausted, suppressed or review cases are not blindly restarted. Existing channel availability, contact limits and stop rules still apply. In demo mode use the simulator to advance work; activation itself never places a test call or sends a message. The full autonomous daily planning and post-conversation agent workflow remains the product direction, not an implemented recovery engine.

## Agent handoff and virtual SMS

Enable `AGENT_WORKFLOWS_ENABLED=true` and restart. In a new browser or Twilio demo call, accept an authorized payment solution and end the call. The persistent coordinator then runs the payment conversation agent and delivers a message to the **virtual** SMS inbox. Open **Overview → Demo SMS conversations**, or the saved case's **Conversations** tab, to reply as the demo participant. Replies use the same stored conversation. No physical SMS is dispatched by this workflow.

**Agents** lists the existing voice roles, SMS specialist and on-demand supervisor, their configured provider/model, capabilities and recorded workflow jobs/runs. The coordinator itself is an application service, not a model. Voice-session activity remains in the test/debug views; workflow jobs have their own durable history.

The default text roles use `gpt-5.6-luna` (SMS) and `gpt-5.6-terra` (supervisor). Configure each role independently:

| Setting | SMS role | Supervisor role |
| --- | --- | --- |
| Provider | `AGENT_SMS_PROVIDER` | `AGENT_SUPERVISOR_PROVIDER` |
| Model | `AGENT_SMS_MODEL` | `AGENT_SUPERVISOR_MODEL` |
| API base URL | `AGENT_SMS_BASE_URL` | `AGENT_SUPERVISOR_BASE_URL` |
| Optional role key | `AGENT_SMS_API_KEY` | `AGENT_SUPERVISOR_API_KEY` |

Supported providers: `openai` uses Responses; `openrouter` and `openai-compatible` use Chat Completions with strict structured output. OpenAI roles inherit `OPENAI_API_KEY`; OpenRouter roles inherit `OPENROUTER_API_KEY`; compatible providers require their explicit role key. For OpenRouter, set the base URL to `https://openrouter.ai/api/v1` and use that provider's fully qualified model ID, for example `openai/gpt-5.4-mini`. Set both model and URL when changing providers. The selected model/provider must support strict JSON-schema responses; unsupported configurations fail visibly. HTTP is permitted only for loopback test endpoints. OpenRouter provider fallback is disabled to avoid silently changing execution providers.

The provider adapter returns normalized decisions (`reply`, `paid_reported`, `opt_out`, `human_review`), not SDK objects. One bounded supervisor consultation is available for ambiguous situations. Domain functions and the coordinator validate actions and own persistence. This deliberately uses a small provider adapter rather than binding business logic to an OpenAI-specific agent SDK. Existing realtime voice transports retain their own provider-specific adapters.

Agreement persistence and the follow-up job are committed together. The job waits for observed source-session closure. Interrupted model generation is retryable; messages are committed once per logical job. Conversation pause preserves pending work, contact stop cancels it, and current case/payment state is checked again after generation. Initial payment details are rendered from the saved agreement; model text is checked for unrecognized links, monetary amounts and ISO dates. These checks do not constitute a general semantic guarantee for arbitrary model text.

The voice-demo portfolio remains blocked for prospecting. Virtual agreement fulfillment has a narrow authorization for the original demo-review task; disputes, opt-outs, unrelated human review and portfolio pause still block it. Existing physical SMS/email drafts remain drafts. Historical agreements are not automatically replayed into new messages. Twilio two-way SMS delivery, a daily autonomous portfolio planner and automatic payment reconciliation remain future integrations.


### Document librarian demo

Start a new Browser voice test, confirm Ana Silva and ask for the original loan agreement or account statement. After the request is saved, end the call and open **Demo SMS conversations**. Helena retrieves the case document and Marina supplies an authenticated attachment in the virtual inbox. A payment agreement is not required. Ask follow-up questions or request the other document in the same conversation.

The case **Documents** tab supports plain-text uploads up to 100 KiB, versioned by title and type. Helena currently uses deterministic case/type retrieval; Marina uses the configured text model. Delivery remains virtual. External repositories, PDF/OCR and real document sending are future integrations.

See [workflow diagrams](docs/WORKFLOWS.md) for implemented flows, task states and the planned architecture.


### Agent-owned resolution and escalation tracking

Unresolved virtual conversations now create a durable task for Rafael. He reloads the case, approved options and document catalog, then guides Marina, requests Helena, or records an explicit information/specialist/policy dependency. No automatic human task is created by the new virtual exception flow. Waiting participants can add clarification, relevant evidence changes can wake the task, and **Recheck case** requests a fresh evaluation. Contact stops and payment-verification restrictions remain enforced.

Open **Agents → Supervisor escalations** to see original reasons, case/conversation links, current status and next action, including resolved entries. Search this history to identify recurring capability or context gaps. Historical manual review records remain unchanged.


### Google Workspace email demo

Ask the voice agent to send the loan agreement **by email**: after call end, Helena and Marina fulfill the request automatically. **Email test** on Overview or Agents monitors delivery; its manual send control is optional for older conversations. Continue through Gmail or use **Send demo SMS** in the same case conversation; Marina retains the same context and offers. Sender and recipient are fixed to `louiz@rescova.de`. Set the prepared Gmail OAuth variables, run `npm run gmail:connect`, enable `EMAIL_TEST_ENABLED`, and restart. No SendGrid account, DNS changes or ngrok required. Full setup and call → document → email reply → installment acceptance test: [docs/EMAIL_TEST.md](docs/EMAIL_TEST.md).

### PostgreSQL workers and document retrieval

PostgreSQL supports durable parallel background workers with case ownership and recovery. The API can run workers locally or use separate `npm run worker` processes. Deployment, migration, health checks and measured mock throughput: [docs/OPERATIONS.md](docs/OPERATIONS.md).

Open a case's document library to upload a text file or PDF. Background ingestion extracts text and runs local OCR when needed. Marina can request case-scoped document passages from Helena, with document/version/page evidence, through the provider-neutral lookup interface. Retrieval configuration and current limits: [docs/RETRIEVAL.md](docs/RETRIEVAL.md).


### Agentic roadmap and readiness

Overview now reports recorded outreach by Calling, SMS and Email; Agent tasks exposes existing agent/worker jobs and unresolved dependencies. Legacy follow-ups remain separate until migrated to executable agent workflows. The next infrastructure milestones, owned-receivable payment model and example situations are in [docs/AGENTIC_ROADMAP.md](docs/AGENTIC_ROADMAP.md). [docs/ASSESSMENT.md](docs/ASSESSMENT.md) tracks current maturity and must be refreshed after every substantial change.


### Document fulfillment tickets

New document requests now create one durable ticket across Helena retrieval, Marina composition and delivery. Open **Agent tasks → View ticket** for the pinned version, dependencies, retry budget and provider submission evidence. Full browser-call → document email → cross-channel continuation test: [docs/DOCUMENT_TICKET_TEST.md](docs/DOCUMENT_TICKET_TEST.md). Missing documents resume when available; uncertain sends are held rather than resent. Historical requests remain unchanged.
