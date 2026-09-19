# Rescova Brasil — Distressed-Credit Outreach MVP

## Shared operating mandate

Every agent and deterministic decision role works from the same versioned organization objective: **maximize verified recovery of Rescova-owned receivables within approved rules**. Runtime context composes that mandate with the active portfolio mandate, the role charter and the current task goal. Policy, authority, evidence and contact-stop rules remain binding. Runs retain goal and version identifiers so outcomes can be traced to the exact operating context.

Stand: 15. September 2026. Produktentscheidung des Auftraggebers: erster Markt Brasilien; Twilio- und OpenAI-Konten vorhanden. Arbeitsname Rescova. Aktualisierte Produktentscheidung: Bedienoberfläche auf Englisch; Nachrichten und Telefonate für Schuldner weiterhin in pt-BR. Dieses Dokument ist die überprüfbare Spezifikation des aktiven Entwicklungsziels.

Aktueller Abnahmeschritt nach Nutzerentscheidung: **zuerst die lokale App prüfen; Live-Test ausdrücklich später.** Der lokale Implementierungsstand ist geliefert und getestet; reale Providerabnahme wird nicht stillschweigend als bestanden betrachtet oder automatisch ausgeführt. Siehe `VALIDATION.md`.

## Langfristiges Zielbild: vollständig agentische Plattform

Produktentscheidung des Auftraggebers: Im Zielzustand läuft Rescova grundsätzlich vollständig agentisch. Spezialisierte Agenten übernehmen alle relevanten Aufgaben, kommunizieren miteinander, teilen den erforderlichen Kontext, koordinieren ihre Arbeit und übergeben Aufgaben und Ergebnisse untereinander. Das umfasst beispielsweise Gesprächsführung über verschiedene Kanäle, Gesprächsauswertung, Planung nächster Schritte, Nachrichtenformulierung, Follow-ups und operative Fallbearbeitung. Die konkrete Aufteilung der Agenten bleibt offen und entwickelt sich mit dem Produkt.

Dieses Zielbild ist bei neuen Funktionen, Technologieentscheidungen, Datenmodellen und Schnittstellen immer mitzudenken. Funktionen sollen perspektivisch durch Agenten nutzbar und miteinander kombinierbar sein; Kontext, Aufgaben, Zustände und Ergebnisse sollen zwischen ihnen weitergegeben werden können. Die Oberfläche dient langfristig insbesondere der Übersicht, Konfiguration und Kontrolle von Ausnahmen. Ungeklärte Aufgaben gehören grundsätzlich einem verantwortlichen Agenten; menschliche Bearbeitung ist keine notwendige Standard-Endstation.

Das ist die langfristige Produktausrichtung, keine Behauptung über bereits implementierte Autonomie und keine pauschale Freigabe heutiger Agenten für externe Aktionen. Aktuelle Demo-Grenzen, Berechtigungen und fachliche Regeln bleiben bestehen. Diese Festlegung verlangt weder sofort einen Agenten für jede Funktion noch ein bestimmtes Framework oder einen vorzeitigen Umbau der bestehenden Architektur.

## Produktentscheidung: Portfolio als dauerhafter Arbeitsauftrag

Das Portfolio ist die zentrale operative Einheit. Der Nutzer importiert Fälle, prüft Daten und konfiguriert zulässige Kanäle. Mit **Activate portfolio** beginnt ein dauerhafter Auftrag ohne festes Enddatum; **Pause portfolio** stoppt neue Aktionen. Eine separate Kampagne muss nicht mehr angelegt werden. Bestehende Kampagnen bleiben vorerst interne Ausführungseinheiten für Queue, Kontaktfolgen und historische Nachweise.

Im Zielzustand prüfen spezialisierte Agenten täglich den Portfoliozustand, planen zulässige nächste Schritte, führen Gespräche, verarbeiten Rückmeldungen und koordinieren Follow-ups. Sie maximieren nachhaltige Rückgewinnung innerhalb der freigegebenen Konditionen, Kontaktregeln und Fallzustände. Dauerhaft aktiv bedeutet nicht tägliche Kontaktaufnahme bei jedem Schuldner: vereinbarte Termine, Zahlungspläne, Kontaktstopps, Streitfälle und menschliche Bearbeitung bestimmen die nächste Aktion. Ein Portfolio kann aktiv bleiben, während keine Aktion fällig ist.

Jedes Portfolio erhält eine eigene Fortschrittsübersicht: Fälle und bekannter Bestand, Kontaktabdeckung, erreichte Personen, Antworten, Kontaktversuche, offene Follow-ups, wartende/gesperrte Fälle, Zahlungsvereinbarungen und jüngste Aktivitäten. Vereinbarte Beträge sind keine bestätigten Zahlungseingänge. Solange keine Zahlungsabstimmung implementiert ist, wird Rückgewinnung ausdrücklich als nicht verfügbar ausgewiesen.

Dieser Umsetzungsschritt schafft persistente Aktivierung/Pause, automatische Aufnahme neuer geeigneter Fälle in die bestehende Ausführung und die Portfolio-Oberfläche. Die heutige Demo verarbeitet Kontakte weiterhin über den Simulator; bestehende Live-Provider-Regeln bleiben maßgeblich. Eine vollständige autonome Auswertung, Nachrichtenformulierung, tägliche Strategieplanung und Zahlungsabstimmung wird dadurch nicht als fertig behauptet. Erschöpfte oder bereits bearbeitete Fälle werden nicht blind neu eingeschrieben.

## Präzisierung: agentische Ausnahmebearbeitung

Rafael übernimmt ungeklärte virtuelle Gesprächsfälle als persistente Aufgabe `supervisor_review`, lädt aktuellen Fallkontext und entscheidet über eine Antwort durch Marina (`marina_guided_reply`), Dokumentbeschaffung durch Helena oder einen expliziten Wartezustand. `awaiting_information`, `awaiting_specialist` und `blocked_policy` halten Grund und nächsten Schritt fest. Fehlende Fähigkeiten und Freigaben dürfen nicht erfunden werden. Ein Zahlungshinweis bleibt unbestätigt, erfordert Zahlungsabstimmung und beschränkt weitere Ansprache. Kontaktstopps gelten sofort.

Für diese virtuellen Workflows ist kein menschlicher Übergabekanal konfiguriert. Der historische Wert `human_review` bleibt an kompatiblen Schnittstellen erhalten, bedeutet hier aber agentische Fallklärung und keine zugesagte menschliche Übergabe. Bestehende manuelle Operatorfunktionen, historische Aufgaben und importierte Portfolio-Queues werden mit diesem Schritt nicht pauschal migriert. Die folgenden älteren MVP-Anforderungen beschreiben diese bisherigen Grenzen; sie definieren keine dauerhafte menschliche Abhängigkeit des Zielprodukts. Neue Gesprächsworkflows folgen der agentischen Ausnahmebearbeitung und dem aktuellen Ablauf in [WORKFLOWS.md](WORKFLOWS.md).

## Ziel und Nutzen

Ein Collection-Team kann einen heterogenen Kreditbestand in eine kontrollierte Outreach-Operation überführen: importieren, Datenfehler bereinigen, Kontaktkanäle konfigurieren, das Portfolio aktivieren, echte Antworten verstehen und Fälle mit Klärungsbedarf übernehmen. Das Ergebnis ist eine laufende Web-Anwendung mit persistenter Datenbank und anschließbaren Kommunikationsdiensten, einschließlich GPT Realtime für natürliche portugiesische Telefonate.

Die zu validierende Hypothese lautet: automatisierte, respektvolle Erstansprache reduziert den manuellen Aufwand je sinnvoll geklärtem Kreditfall. Anrufvolumen allein belegt keinen Nutzen. Das MVP misst Erreichbarkeit, bestätigten Kontakt zur richtigen Person, Rückmeldungen, Eskalationen und nächste Schritte. Rückgewinnung, IRR und bestätigte Zahlungseingänge sind ohne Zahlungsdaten ausdrücklich keine MVP-Kennzahlen.

## Quellenbasis und Einordnung

Alle vier beigefügten Dokumente wurden vor der Implementierung ausgewertet. Das Tech-Deck hat 53 bildbasierte Seiten und wurde mit lokalem Apple Vision OCR erschlossen; kleine Screenshot-Beschriftungen und Zahlentabellen sind OCR-unsicher. Entscheidungsrelevant sind die gut lesbaren beschreibenden Inhalte, nicht einzelne OCR-Zahlen.

| Quelle                              | Relevante Inhalte                                                                                                                         | Konsequenz                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Investment Memo, Januar 2025        | Resolve: Datenqualität, respektvolle Multichannel-Ansprache; hybride Bearbeitung; Zahlungswille und Fähigkeit als unterschiedliche Achsen | Keine pauschalen Reminder; strukturierte Diagnose mit menschlicher Übergabe         |
| Fundraising Deck, März 2025, S. 4–7 | AssetView, Resolve und Capital als separate Fähigkeiten; kundenbezogene Workflows                                                         | MVP isoliert den Outreach-Anteil von Resolve                                        |
| Tech & Product, S. 19–21            | Upload, Validierung, Segmentierung, Kanalwahl, Workflow, Datenrückfluss                                                                   | Durchgängiger Import-zu-Ergebnis-Ablauf mit Ereignisprotokoll                       |
| Tech & Product, S. 23–30            | Chat/Callbot, Kommunikationsdienst, Queue, Qualitätssicherung                                                                             | Getrennte Kanaladapter und validierte Ergebnisse; kein direkter KI-Datenbankzugriff |
| Tech & Product, S. 31–36            | Segmentfilter, CRM, Reports, Kampagnen, Authentisierung                                                                                   | Fallauswahl, Arbeitsliste, Kampagnensteuerung und Zugangsschutz                     |
| Tech & Product, S. 12–14, 38–39     | Datenlücken; große spätere Infrastruktur                                                                                                  | Keine untrainierten Scoring-Versprechen, kein Kubernetes für den Pilot              |
| Tech & Product, S. 40–51            | Afrikanische Finanzierungs-/Rechtsstrukturen                                                                                              | Nicht auf Brasilien übertragen; kein Capital-Modul                                  |
| Replication Blueprint, S. 4–7, 9–11 | Hybridbetrieb, Datenfeedback, Kosten und nachweisbare Pilotwirkung                                                                        | Erst Erreichbarkeit und operative Wiederholbarkeit beweisen                         |

Die BFREE-Kennzahlen sind Unternehmensangaben verschiedener Stichtage, teils intern widersprüchlich (u. a. 3/6 Mio. Personen, 42/45 Partner, Wachstum und Umsatz). Sie sind weder verifizierte Benchmarks noch Ziele dieser App. Die 72/8/6/14-Prozent-Segmente werden nicht als brasilianische Verteilung angenommen. Es werden keine fremden Schulden-, Kontakt- oder Mitarbeiterdaten aus den Unterlagen als Demodaten importiert.

## Eigene Produktentscheidungen

1. Kreditfall, Kontaktversuch und Ergebnis sind getrennte Objekte. Ein Fall kann mehrere Versuche und eine sich ändernde Situation haben. Zustellung, angenommener Anruf und Identitätsbestätigung sind unterschiedliche Ereignisse.
2. Import ist ein überprüfbarer Prozess mit Spaltenzuordnung und Vorschau. Fehlende Beträge bleiben unbekannt, nicht null. Unbekannte Währung wird nicht still in BRL umgerechnet. Jede Zeile bekommt Fehler/Warnungen und eine Herkunft.
3. Referenz ist innerhalb eines Portfolios eindeutig. Gleiches Telefon bei unterschiedlichen Fällen ist ein Prüfhinweis, kein automatischer Merge. Importbestätigung ist idempotent und prüft Duplikate erneut.
4. Kampagnen wählen Kanäle in Reihenfolge. Es wird nicht auf allen Kanälen gleichzeitig kontaktiert. Nicht vorhandene oder gesperrte Kanäle werden begründet übersprungen; Fallback erfolgt nur nach einer Wartezeit und ohne zwischenzeitliche Antwort.
5. Jeder Versand prüft den aktuellen Zustand erneut. Pause, Opt-out, bestrittene Forderung und laufende menschliche Bearbeitung überstimmen alte Queue-Einträge.
6. Kontaktstopps gelten auch für andere Fälle mit derselben Kontaktadresse innerhalb dieses Arbeitsbereichs. Das verhindert Kontakt über einen anderen Kampagnenweg nach einem Widerspruch. Wiederfreigaben sind begründete menschliche Aktionen; kein automatischer Neustart durch Neuimport.
7. Zahlungsfähigkeit und Zahlungsabsicht werden nur aus Aussagen erfasst, mit Quelle/Notiz. Religion, Geschlecht und andere sensible Merkmale dienen nicht der Priorisierung. Keine ML-Segmentierung ohne valide Trainings- und Wirkungsdaten.
8. „Já paguei“ legt eine Prüfaufgabe an und stoppt weitere automatische Ansprache. Es ändert weder Saldo noch Zahlungsstatus. Ratenwünsche werden dokumentiert, aber nicht genehmigt.
9. Ein Rückruf braucht Datum und Zeitzone. Ein menschlicher Bearbeitungsauftrag hat Grund, Verantwortlichen, Fälligkeit und Erledigungsnotiz. Menschliche Eskalation ist ein regulärer erfolgreicher Ausgang.
10. Erstnachrichten nennen keine Schuldsumme oder Vertragsdetails. Telefonate stellen die KI und Organisation offen vor. **Nach ausdrücklicher Nutzerentscheidung erhält die KI die Forderungsdetails bereits bei Gesprächsbeginn als Kontext. Eine ausdrückliche Namensbestätigung genügt im Pilot und wird als Selbstauskunft protokolliert.** Es wird kein zusätzlicher Betreuungscode verlangt. Secrets bleiben außerhalb des Prompts. Die Gesprächsregel verlangt Namensbestätigung vor der Offenlegung gegenüber dem Gesprächspartner. Das ist eine Prompt-Vorgabe, keine technische Garantie gegen fehlerhafte mündliche Offenlegung und keine dokumentarische Identitätsprüfung. Fehlt der Name oder ist die Antwort unklar, bleibt das Gespräch neutral und führt zur Klärung.
11. Kein vollautomatisches Freigeben von Rabatten, Ratenplänen, Zahlungslinks oder rechtlichen Konsequenzen. Kein Gespräch mit Familie/Arbeitgebern über die Forderung. Keine Aufzeichnung von Roh-Audio im MVP.
12. Testbetrieb und Realbetrieb sind getrennte Datenräume. Demo-Ergebnisse werden ausdrücklich als simuliert markiert. Ein Simulationsbutton darf niemals einen Provider erreichen.

## Funktionaler Umfang und Abnahme

### A. Portfolios und Import

- Portfolio mit Kreditgeber, Brasilienprofil und IANA-Zeitzone anlegen.
- CSV (Komma/Semikolon, UTF-8, quoted Felder) und XLSX importieren; Größen-/Zeilenlimits und fehlende Datei sauber behandeln.
- Spalten frei auf Referenz, Name, Telefon, E-Mail, Saldo, Währung, Fälligkeit, Sprache und Zeitzone abbilden. Portugiesische und englische Header vorschlagen.
- +55 mit DDD normalisieren; keine unbekannte Auslandsvorwahl erfinden. BRL in Centavos, pt-BR-Beträge und TT/MM/JJJJ prüfen. Rohdaten bleiben im begrenzten Importprüfbereich, nicht im Modellprompt.
- Vorschau zählt gültige, fehlerhafte und doppelte Zeilen. Nur gültige freigegebene Zeilen übernehmen; unverwendbare Datensätze bleiben als Importfehler sichtbar/exportierbar. Wiederholte Bestätigung erzeugt keine Dubletten.

### B. Fälle und Nacharbeit

- Suche, Portfolio-/Statusfilter, Fallauswahl, fehlende Kontaktmöglichkeiten sichtbar.
- Detailansicht mit Kontaktdaten, Saldo, Ergebnissen, Versuchen, Nachrichten und Audit-Timeline.
- Ergebniswerte: nicht erreicht; ungültiger Kontakt; Rückruf; bereits bezahlt gemeldet; zahlungsbereit; aktuell nicht zahlungsfähig; bestritten; menschliche Klärung; Opt-out.
- Follow-up zuweisen, terminieren, mit Notiz abschließen. Abschluss einer Aufgabe hebt einen Kontaktstopp nicht still auf.
- Maschinenlesbarer CSV-Export mit Schutz gegen Spreadsheet-Formelinjektion.

### C. Kampagnen und Queue

- Entwurf aus explizit ausgewählten Fällen eines Portfolios und geordneter Kanalliste.
- Vorschau zeigt kontaktierbare/gesperrte Fälle und Kanalverfügbarkeit; Start, Pause und Fortsetzen sind nachvollziehbar.
- Persistente Arbeitsschritte, einmaliger aktiver Versand je Kontakt, kanalübergreifender Abstand und Versuchslimit. Neustart darf zweifelhafte externe Sendungen nicht blind wiederholen.
- Standard-Pilotfenster Mo–Fr 09–18 Uhr, mindestens 24 Stunden Abstand und maximal drei Schritte. Dies sind konservative Produktdefaults, keine Behauptung brasilienweit gesetzlich gültiger Uhrzeiten. Länder-/Portfoliozeitzone und Ausschlusstage sind konfigurierbar.
- Opt-out/Dispute/Human-review sofort in die Queue zurückspielen. Nichtzustellung und Nichtantwort getrennt behandeln. Provider-Ausfall ist kein Schuldnerergebnis.

### D. Kommunikation und Realtime

- Twilio Programmable Voice mit bidirektionalen Media Streams, OpenAI Realtime WebSocket, PCMU/8 kHz passend zu Twilio, pt-BR-Prompt und Unterbrechungsbehandlung.
- Servervalidierte Tools für Identität, Ergebnis und Übergabe. Die KI kennt den Saldo als Kontext, soll ihn aber vor Identitätsbestätigung nicht nennen. Prompt-Injection aus Importdaten und Gespräch darf keine serverseitigen Ergebnisfreigaben ersetzen. Strukturierte Ergebnisse und kurze Notizen statt standardmäßiger Speicherung vollständiger Audiotranskripte.
- Twilio SMS mit Statuscallbacks und eingehenden Antworten; STOP/PARAR/SAIR/weitere eindeutige Stopps führen zur Sperre. Unklare Antworten gehen in die menschliche Arbeitsliste, nicht in eine erfundene Zusage.
- E-Mail über SendGrid (separater API-Key, auch bei Twilio-Konto erforderlich), Zustellereignisse und geschützter Antwort-Ingress. Ohne konfigurierten Provider als nicht verfügbar anzeigen.
- WhatsApp wird sichtbar geführt, für Debt-Collection-Outbound aber aufgrund der aktuellen Meta-Policy gesperrt. Eine genehmigte Vorlage allein beweist keine Zulässigkeit des Geschäftsfalls. Keine Umgehung durch neutralen Text.
- Signaturprüfung, Replay-/Duplikatschutz, Provider-SID-Zuordnung und sichere Behandlung verspäteter Ereignisse.
- Übergabe mindestens als persistente priorisierte Arbeitsaufgabe; keine behauptete Live-Weiterleitung ohne funktionierende Telefonie-Verbindung.

### E. Oberfläche, Sicherheit, Betrieb

- Klar gestaltete responsive englische Oberfläche: Overview, Portfolios, Cases, Campaigns, Follow-ups, Settings.
- Leere Zustände, Lade-/Fehlerzustände, klarer Demo-Hinweis, keine erfundenen Leistungsdaten.
- Authentisierte API und Operator-Zugriff; Sitzungen geschützt, Secrets nur serverseitig, kein Klartext-Schlüssel in UI/Logs. Lokal an Loopback binden.
- Ein Arbeitsbereich mit Operator-Zugang als Pilotgrenze; keine behauptete SaaS-Mandantenfähigkeit.
- SQLite/WAL für einen Einzelprozess-Piloten, transaktionale Queue und Audit. Migration auf PostgreSQL/mehrere Worker erst mit gemessener Last erforderlich. Keine Behauptung von Millionenskalierung ohne Lasttest.
- Dokumentierter Start, Beispielimport, Provider-Konfiguration, sichere lokale Tests, Backup/Retention und Grenzen.

## Architektur

Modularer Node.js-Monolith: React/Vite-Oberfläche → authentisierte Express-API → Domänenmodule für Import, Fälle, Kampagnen, Policy und Queue → SQLite. Kommunikationsadapter sprechen Twilio/SendGrid; ein WebSocket-Gateway verbindet Twilio-Media-Streams mit OpenAI. Webhooks ändern dieselben Fall-/Versuchszustände wie manuelle Bearbeitung. Der Worker läuft mit demselben Prozess, reserviert Arbeit transaktional und trennt Simulation von Provider-Versand.

Die Architektur minimiert anfänglichen Betriebsaufwand und hält Domänenlogik providerunabhängig testbar. Sie verwendet bewusst keine BFREE-spezifischen Microservices, Zahlungsinfrastruktur, Scoringmodelle oder Investmentkomponenten. Node 22 SQLite ist experimentell; das ist eine dokumentierte Pilotabhängigkeit.

## Brasilien und externe Abhängigkeiten

LGPD und CDC sind relevante Grundlagen; diese technischen Kontrollen ersetzen keine Prüfung des konkreten Gläubigermandats, der Rechtsgrundlage, der Aufbewahrung, internationaler Datenübermittlung und lokaler/Anatel-Telefonievorgaben. Brasilien hat mehrere Zeitzonen; America/Sao_Paulo ist nur der konfigurierbare Default. Staatliche/kommunale Regeln und Feiertage müssen im konkreten Pilotprofil hinterlegt werden.

Vor einer realen Pilotabnahme werden lokale Secrets, öffentlicher HTTPS/WSS-Endpunkt, erreichbare Twilio-Absender, passende Messaging-Berechtigungen, freigegebene Testempfänger und das freigegebene Gläubigerskript benötigt. Vorhandene Konten bedeuten nicht, dass diese Konfiguration schon vorliegt. Bis dahin sind externe Anrufe/Versand nicht praktisch verifiziert. Die Entwicklung und lokale Vertrags-/Integrationstests laufen davon unabhängig weiter.

Primärquellen (am 14.09.2026 gelesen):

- LGPD: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm
- CDC, insbesondere Art. 42 und 71: https://www.consumidor.gov.br/pages/conteudo/publico/102
- WhatsApp: https://business.whatsapp.com/policy
- Twilio Media Streams: https://www.twilio.com/docs/voice/media-streams/websocket-messages
- Twilio Signaturen: https://www.twilio.com/docs/global-infrastructure/firewall-configurations/media-streams-configuration
- OpenAI Realtime: https://developers.openai.com/api/docs/guides/realtime-conversations
- OpenAI WebSockets: https://developers.openai.com/api/docs/guides/voice-websockets

## Fertigstellungsnachweis

Automatisierte Tests müssen relevante Risiken abdecken: defekte und wiederholte Imports, Opt-out vor Versand, Pause/Resume, konkurrierende Kampagnen, Wiederanlauf nach unklarem Versand, Cross-Case-Kontaktstopps, gefälschte/doppelte Provider-Webhooks, unbestätigte Identität und unzulässige Modellaktionen. Der Produktionsbuild muss funktionieren; Browserprüfungen müssen den Import → Portfolio-Aktivierung → Simulation → Ergebnis → Nacharbeit-Ablauf tatsächlich ausführen. Externe Smoke-Tests werden getrennt protokolliert und erst nach erfolgreicher Durchführung als bestanden bezeichnet.

## Aktualisierung: Browser-Sprachtest mit GPT-Live

Auf ausdrücklichen Hinweis des Auftraggebers verwendet der Browser-Sprachtest jetzt GPT-Live (`gpt-live-1`) für die Gesprächsführung und einen getrennten Responses-Backend-Agenten (`gpt-5.6-terra`) für Namensbestätigung und Ergebniserfassung. Testsprache ist vorläufig Englisch. Die bislang getrennte Twilio-Telefonie bleibt GPT Realtime/pt-BR und deaktiviert. Es werden ausschließlich der feste fiktive Testfall und eine flüchtige isolierte Datenbank verwendet. GPT-Live steuert Sprache und Unterbrechungen; die App führt autorisierte Fachfunktionen aus und verwaltet Sitzung und Ergebnisse. Grundlage: https://developers.openai.com/api/docs/guides/live und die verlinkten WebRTC-/Delegations-/Migrationsleitfäden.

### Voice provider selection — updated 16 September 2026

The Grok comparison sandbox has been retired. Keep Clara as the GPT Live voice agent, Lucas for delegated case tools, and both browser and Twilio testing. Remove Sofia from the active team; retain historical test records.

### Integrate accepted demo solutions with the platform

Accepted voice-demo payment solutions must persist in the demo workspace as a case in a dedicated portfolio, with the accepted schedule, an operational review task and a payment follow-up job. GPT Live browser and Twilio tests share this behavior; historical Grok results remain readable. Session/agreement identity prevents duplicate records. Follow-ups initially support SMS/email with clearly nonpayable demo links and Pix placeholders; operators can edit drafts in the case detail. No real sending is included in this iteration. Later stop-contact/dispute/review outcomes must update the saved case and cancel drafts. Browser speech remains ephemeral and existing imported cases stay separate.

## Model-independent agent execution and first automated handoff

New product requirement: agent roles, task state, domain tools and conversation memory must be independent of a particular model/provider. Per-role profiles select provider, model and API endpoint. Provider adapters translate only request/response formats; workflow records and business actions use normalized contracts. OpenRouter and compatible providers can be selected without rewriting the payment workflow. Model/provider capabilities and role-level evaluation remain required; interchangeable transport does not imply identical model behavior.

The first implemented handoff is an accepted demo payment solution → observed end of source call → persistent virtual SMS agent conversation. The coordinator creates and serializes durable jobs, the lightweight text model formulates replies, and Rafael owns unresolved requests through durable supervisor jobs, guided Marina replies, document delegation and explicit dependency states. An Agents overview exposes actual implemented roles/configuration and tracked workflow jobs. This is automatic virtual delivery with real model generation, not enabled physical SMS. Existing live voice adapters remain separate. Generalized live portfolio execution remains a later step.

### Autonomous portfolio planner — 19 September 2026

Mateo is the portfolio-planning role. For an active portfolio he derives a closed set of permitted next actions from canonical case state, contact availability, channel order and deterministic policy. Jev may select among that closed set; low confidence, invalid output or provider failure falls back to configured channel order. Mateo persists idempotent tasks for Clara, Marina, Helena, Rafael or Tiago and never sends, suppresses, changes financial state or releases documents itself.

The first implementation is a fully synthetic work cycle with seven scenario profiles. It records planning runs, decision evidence, action commands, simulated attempts and structured outcomes, then creates waiting or scheduled child work. Execution rechecks pause, suppression, contact destination, attempt budget and concurrent actions immediately before side effects. This establishes the canonical observe-decide-act-feedback shape without claiming real autonomous outreach. The next architecture step is to migrate existing channel executors behind the same command and evidence contract, then add event-triggered replanning and global budgets.

### Agentic target architecture refinement — 18 September 2026

Rescova's target architecture follows a constrained observe-decide-act-evaluate loop. Goals, success criteria, authority, budgets and stopping conditions are durable task data rather than prompt-only instructions. The coordinator remains the durable control plane; specialized agents choose bounded next actions, while deterministic policy and capability services authorize and execute side effects. Every external action produces evidence that updates canonical case state and may trigger replanning.

Agent roles stay narrow and explicit. Each role has versioned goals, available tools, authority limits and completion contracts. Agents never receive raw provider credentials or unrestricted database/API access. Atomic domain tools pass through one mediated action layer that validates current case version, contact policy, financial authority, idempotency and resource limits before writing an outbox command. High-impact outputs can require an independent validator or stronger specialist before execution without making human review the standard destination.

Memory is layered: bounded working context for one run; authoritative shared case state with provenance and conflict handling; and retrieved document/history evidence with retention and relevance rules. Generated summaries and agent observations are derived memory, never silent replacements for source facts. Model reasoning, action requests, policy decisions, tool results and observed outcomes remain correlated in a queryable decision log.

Routine tasks use shallow reactive decisions. Ambiguous strategy uses bounded planning with maximum steps, time, tool calls and cost. Completion, waiting, blocked capability, exhausted budget and impossible goals are explicit terminal or resumable outcomes. Under load or uncertainty, the system reduces capability, waits, requests missing information or routes to Rafael; it does not expand authority or loop indefinitely.

Future decision models such as Jev may provide typed routing, scoring and confidence estimates behind a provider-neutral `DecisionEngine`. They do not replace the coordinator, policy service, ledger, task state, generative conversation agents or tool execution. New decision models enter in shadow mode, use version-pinned schemas and thresholds, and gain authority only after case-based evaluation.

TypeSafe access is available as of 19 September 2026. Jev is active for fictional demo traffic as inbound triage, targeted context routing before Marina and closed-set dependency routing before Rafael. Outbound semantic verification remains planned. See [TYPESAFE_JEV_PLAN.md](TYPESAFE_JEV_PLAN.md). Jev receives no direct tool, delivery or financial authority; application policy executes permitted deterministic actions.

## Document librarian and workflow map — 15 September 2026

The next implemented slice is voice document request → case-scoped Helena retrieval → Marina virtual SMS fulfillment → continued written conversation. A document request does not require accepting a payment agreement. Cases expose immutable uploaded text documents and retrieval status; new Ana demo sources include explicitly fictional artifacts. Helena starts as a deterministic retrieval specialist, with a storage interface that can evolve to external connectors and semantic retrieval. This does not yet authorize real external document delivery or implement PDF/OCR processing.

[WORKFLOWS.md](WORKFLOWS.md) is the maintained workflow map. Update its Mermaid diagrams whenever an implementation change affects task triggers, ownership, delivery, or lifecycle. Diagrams distinguish current execution from planned continuous portfolio autonomy.

## Google Workspace email and written acceptance — 16 September 2026

The demo now supports an explicitly activated real email transport using the existing Google Workspace mailbox `louiz@rescova.de` as both sender and sole test recipient. Marina owns written conversations across virtual SMS and email; the persistent coordinator and delivery adapter handle transport without adding a separate email reasoning agent. Gmail OAuth setup is required before sending; no SendGrid account or DNS changes are needed for this pilot. Mailbox polling reads only registered test threads. Real delivery is gated separately from virtual generation, and uncertain sends are never blindly retried.

Written conversations can now accept a previously explained authorized offer through the shared payment agreement persistence. Application-rendered exact terms, latest-message consent, offer expiry, existing agreement authority and email-submission evidence are checked before saving. Helena can supply seeded fictional documents for email; wider external document release and inbound attachment handling are not part of this slice. See EMAIL_TEST.md and WORKFLOWS.md.

### Channel decisions belong to the agents

An explicit caller request such as “send my loan agreement by email” must create and execute the delivery task after call end without an operator selecting Email test or pressing Send. Missing transport configuration is an explicit durable dependency; it resumes when configured. SMS and email are routes into one case context, not separate agent memories. Marina can use an offer presented by email when processing acceptance via SMS, preserving evidence and idempotent agreement storage. Individual messages and queued tasks retain their channel, so concurrent inputs cannot redirect work. The Email test screen is monitoring/troubleshooting, not a mandatory workflow step. The currently implemented SMS route is still virtual; this does not claim real Twilio SMS handling.

### Always-current shared case knowledge

Marina must communicate from the case's complete relevant knowledge across channels, not only the last message or attachment. Each turn reloads recorded case/portfolio facts, notes, outcomes, tasks, agreements, delivery evidence and available document knowledge. Missing facts must be distinguished from omitted or unavailable context; conflicting sources need explicit resolution. The shared context service is the basis for all conversational roles. Current limits (document excerpts and transcripts not yet attached automatically) are explicit gaps to close, not intended product constraints.

### On-demand context refinement

Always-current knowledge does not mean injecting the complete case into every model request. Conversational agents receive a small working context and invoke case-scoped lookup tools when a question requires more information. Helena owns the evolving document-retrieval capability; structured financial facts remain exact database reads. Retrieval results carry source/version/page metadata and explicit missing/conflict signals. Search/RAG can extend this interface without changing conversation or delivery logic. A knowledge graph is not an immediate requirement. Token usage and lookup latency should be measured, not assumed to improve merely because another agent is added.

### Scalable execution and document evidence — 16 September 2026

The implemented foundation now supports PostgreSQL persistence and independent background worker processes. Agents and email delivery share expiring case ownership with fencing, preserving case ordering while independent cases run concurrently. Missing or interrupted model work can resume; uncertain external sends are held without blind retries. One API process is still required for in-memory sessions, voice and the legacy dispatcher. Concurrency controls are per process, not a claim of unlimited provider capacity.

Helena now provides deterministic case-scoped full-text passage retrieval and durable PDF ingestion/OCR, with document version and page provenance. Agents retrieve relevant evidence on demand; authoritative payment records remain structured database facts. Original document storage must be shared by API and workers. Embeddings, a knowledge graph, managed object storage and horizontal API replication remain planned only when justified by operating evidence. The operational boundary and measured mocked-load benchmark are recorded in [OPERATIONS.md](OPERATIONS.md); workflow diagrams remain in [WORKFLOWS.md](WORKFLOWS.md).

### Agent work queue, outreach evidence and payment reconciliation — 16 September 2026

Follow-ups should become observable work owned by agents, with a typed task, source event, case, accountable owner, execution state, next action and completion evidence. The UI is an oversight surface, not a required human-review stage. The first view may project existing durable workflows; it must distinguish execution already implemented from historical manual records and unavailable capabilities.

Outreach reporting must reflect persisted communication evidence, separated by channel, direction and real/simulated/browser scope. Gmail submission is not proof of delivery or reading; an ended phone call is not proof of right-party contact. Plans, drafts, attempts, provider confirmations and debtor responses are distinct measures.

The target product will support receiving and reconciling payments. Payment provider adapters and an auditable monetary ledger determine verified payment state. Agents use that state to decide follow-ups; they do not infer receipt from debtor statements or write balances based on generated text. Payment processing expands the original outreach-only MVP as a future milestone; it is not already enabled. Stripe is an example interface, not an approved provider for this business model. Provider eligibility and the specific Rescova entity/merchant-account configuration remain open implementation inputs; the user confirmed collection only of Rescova-owned purchased receivables.

After every substantial change, refresh [ASSESSMENT.md](ASSESSMENT.md), with evidence, current boundaries and the next milestone toward fully agentic collections. The phased implementation proposal is [AGENTIC_ROADMAP.md](AGENTIC_ROADMAP.md).

#### Clarification: creditor ownership

Confirmed scope: Rescova collects exclusively receivables it has purchased and owns. The current legal creditor/owner is distinct from the original lender. Incoming payments settle Rescova’s own receivables; third-party servicing and remittance are out of scope. Track acquisition/assignment provenance and keep portfolio purchase price separate from the debtor balance. Do not classify provider eligibility from the generic phrase “debt collection” alone; confirm the actual ownership and funds flow.

### First durable parent workflow: document fulfillment

New document requests now have one correlated parent ticket joining Helena retrieval, Marina composition and the existing email/virtual-SMS delivery. Missing documents wait without repeated model generation and resume on evidence availability; immutable versions, source-call completion, fixed channels, bounded generation attempts and a fulfillment deadline define the contract. Email completion requires provider submission evidence for the linked attachment. This first implementation reuses existing workers and delivery records; it is not a separate general orchestration engine. Subsequent payment verification should reuse these explicit ownership, dependency and evidence conventions.

### Provider-independent payment foundation — 16 September 2026

Accepted demo plans now connect to structured installments, durable request intents, versioned simulated payment events, capped allocations and agent-owned notification/reconciliation tasks. Financial mutations are deterministic and evidence-driven; conversational agents retrieve current payment state on demand across text and voice. The simulator implements the replaceable payment-provider contract; real provider activation remains explicitly gated. Simulation is distinct from real recovery. See PAYMENTS.md for current scope, the adapter boundary and end-to-end testing; WORKFLOWS.md records executed versus planned behavior.

### Intended Brazil payment provider — 18 September 2026

Product decision: Rescova intends to use **PagBrasil** for payment collection in Brazil through its US legal entity. The target debtor experience is one provider-hosted, expiring payment link that can offer Pix, Apple Pay, Brazilian cards and other enabled local methods. Verified PagBrasil callbacks and reconciliation responses must update the internal payment ledger and trigger agent work; agents never infer receipt from conversation text or handle payment credentials.

This direction remains conditional on PagBrasil giving written underwriting approval for Rescova's exact funds flow: Rescova collects receivables it has purchased and legally owns, does not service third-party debt and does not remit collections to an originating lender. Commercial onboarding must also confirm US-entity eligibility, foreign settlement currency, FX treatment, reserves, fees, disputes, refunds and required assignment evidence. Until approval and a sandbox integration are verified, PagBrasil is the intended provider rather than an active production capability.

Keep the payment domain provider-independent. PagBrasil must implement the existing adapter contract for payment requests, retrieval, authenticated event normalization and reconciliation. Internal agreements, installments, allocations, idempotency, audit events and agent tasks must not depend on PagBrasil-specific identifiers or state names. This preserves a practical fallback to another approved provider without replacing the financial ledger or agent workflows.
