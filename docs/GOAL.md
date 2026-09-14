# Rescova Brasil — Distressed-Credit Outreach MVP

Stand: 14. September 2026. Produktentscheidung des Auftraggebers: erster Markt Brasilien; Twilio- und OpenAI-Konten vorhanden. Arbeitsname Rescova. Aktualisierte Produktentscheidung: Bedienoberfläche auf Englisch; Nachrichten und Telefonate für Schuldner weiterhin in pt-BR. Dieses Dokument ist die überprüfbare Spezifikation des aktiven Entwicklungsziels.

Aktueller Abnahmeschritt nach Nutzerentscheidung: **zuerst die lokale App prüfen; Live-Test ausdrücklich später.** Der lokale Implementierungsstand ist geliefert und getestet; reale Providerabnahme wird nicht stillschweigend als bestanden betrachtet oder automatisch ausgeführt. Siehe `VALIDATION.md`.

## Langfristiges Zielbild: vollständig agentische Plattform

Produktentscheidung des Auftraggebers: Im Zielzustand läuft Rescova grundsätzlich vollständig agentisch. Spezialisierte Agenten übernehmen alle relevanten Aufgaben, kommunizieren miteinander, teilen den erforderlichen Kontext, koordinieren ihre Arbeit und übergeben Aufgaben und Ergebnisse untereinander. Das umfasst beispielsweise Gesprächsführung über verschiedene Kanäle, Gesprächsauswertung, Planung nächster Schritte, Nachrichtenformulierung, Follow-ups und operative Fallbearbeitung. Die konkrete Aufteilung der Agenten bleibt offen und entwickelt sich mit dem Produkt.

Dieses Zielbild ist bei neuen Funktionen, Technologieentscheidungen, Datenmodellen und Schnittstellen immer mitzudenken. Funktionen sollen perspektivisch durch Agenten nutzbar und miteinander kombinierbar sein; Kontext, Aufgaben, Zustände und Ergebnisse sollen zwischen ihnen weitergegeben werden können. Die Oberfläche dient langfristig insbesondere der Übersicht, Konfiguration und menschlichen Bearbeitung von Ausnahmen.

Das ist die langfristige Produktausrichtung, keine Behauptung über bereits implementierte Autonomie und keine pauschale Freigabe heutiger Agenten für externe Aktionen. Aktuelle Demo-Grenzen, Berechtigungen und fachliche Regeln bleiben bestehen. Diese Festlegung verlangt weder sofort einen Agenten für jede Funktion noch ein bestimmtes Framework oder einen vorzeitigen Umbau der bestehenden Architektur.

## Produktentscheidung: Portfolio als dauerhafter Arbeitsauftrag

Das Portfolio ist die zentrale operative Einheit. Der Nutzer importiert Fälle, prüft Daten und konfiguriert zulässige Kanäle. Mit **Activate portfolio** beginnt ein dauerhafter Auftrag ohne festes Enddatum; **Pause portfolio** stoppt neue Aktionen. Eine separate Kampagne muss nicht mehr angelegt werden. Bestehende Kampagnen bleiben vorerst interne Ausführungseinheiten für Queue, Kontaktfolgen und historische Nachweise.

Im Zielzustand prüfen spezialisierte Agenten täglich den Portfoliozustand, planen zulässige nächste Schritte, führen Gespräche, verarbeiten Rückmeldungen und koordinieren Follow-ups. Sie maximieren nachhaltige Rückgewinnung innerhalb der freigegebenen Konditionen, Kontaktregeln und Fallzustände. Dauerhaft aktiv bedeutet nicht tägliche Kontaktaufnahme bei jedem Schuldner: vereinbarte Termine, Zahlungspläne, Kontaktstopps, Streitfälle und menschliche Bearbeitung bestimmen die nächste Aktion. Ein Portfolio kann aktiv bleiben, während keine Aktion fällig ist.

Jedes Portfolio erhält eine eigene Fortschrittsübersicht: Fälle und bekannter Bestand, Kontaktabdeckung, erreichte Personen, Antworten, Kontaktversuche, offene Follow-ups, wartende/gesperrte Fälle, Zahlungsvereinbarungen und jüngste Aktivitäten. Vereinbarte Beträge sind keine bestätigten Zahlungseingänge. Solange keine Zahlungsabstimmung implementiert ist, wird Rückgewinnung ausdrücklich als nicht verfügbar ausgewiesen.

Dieser Umsetzungsschritt schafft persistente Aktivierung/Pause, automatische Aufnahme neuer geeigneter Fälle in die bestehende Ausführung und die Portfolio-Oberfläche. Die heutige Demo verarbeitet Kontakte weiterhin über den Simulator; bestehende Live-Provider-Regeln bleiben maßgeblich. Eine vollständige autonome Auswertung, Nachrichtenformulierung, tägliche Strategieplanung und Zahlungsabstimmung wird dadurch nicht als fertig behauptet. Erschöpfte oder bereits bearbeitete Fälle werden nicht blind neu eingeschrieben.

## Ziel und Nutzen

Ein Collection-Team kann einen heterogenen Kreditbestand in eine kontrollierte Outreach-Operation überführen: importieren, Datenfehler bereinigen, Kontaktkanäle konfigurieren, das Portfolio aktivieren, echte Antworten verstehen und Fälle mit Klärungsbedarf übernehmen. Das Ergebnis ist eine laufende Web-Anwendung mit persistenter Datenbank und anschließbaren Kommunikationsdiensten, einschließlich GPT Realtime für natürliche portugiesische Telefonate.

Die zu validierende Hypothese lautet: automatisierte, respektvolle Erstansprache reduziert den manuellen Aufwand je sinnvoll geklärtem Kreditfall. Anrufvolumen allein belegt keinen Nutzen. Das MVP misst Erreichbarkeit, bestätigten Kontakt zur richtigen Person, Rückmeldungen, Eskalationen und nächste Schritte. Rückgewinnung, IRR und bestätigte Zahlungseingänge sind ohne Zahlungsdaten ausdrücklich keine MVP-Kennzahlen.

## Quellenbasis und Einordnung

Alle vier beigefügten Dokumente wurden vor der Implementierung ausgewertet. Das Tech-Deck hat 53 bildbasierte Seiten und wurde mit lokalem Apple Vision OCR erschlossen; kleine Screenshot-Beschriftungen und Zahlentabellen sind OCR-unsicher. Entscheidungsrelevant sind die gut lesbaren beschreibenden Inhalte, nicht einzelne OCR-Zahlen.

| Quelle | Relevante Inhalte | Konsequenz |
|---|---|---|
| Investment Memo, Januar 2025 | Resolve: Datenqualität, respektvolle Multichannel-Ansprache; hybride Bearbeitung; Zahlungswille und Fähigkeit als unterschiedliche Achsen | Keine pauschalen Reminder; strukturierte Diagnose mit menschlicher Übergabe |
| Fundraising Deck, März 2025, S. 4–7 | AssetView, Resolve und Capital als separate Fähigkeiten; kundenbezogene Workflows | MVP isoliert den Outreach-Anteil von Resolve |
| Tech & Product, S. 19–21 | Upload, Validierung, Segmentierung, Kanalwahl, Workflow, Datenrückfluss | Durchgängiger Import-zu-Ergebnis-Ablauf mit Ereignisprotokoll |
| Tech & Product, S. 23–30 | Chat/Callbot, Kommunikationsdienst, Queue, Qualitätssicherung | Getrennte Kanaladapter und validierte Ergebnisse; kein direkter KI-Datenbankzugriff |
| Tech & Product, S. 31–36 | Segmentfilter, CRM, Reports, Kampagnen, Authentisierung | Fallauswahl, Arbeitsliste, Kampagnensteuerung und Zugangsschutz |
| Tech & Product, S. 12–14, 38–39 | Datenlücken; große spätere Infrastruktur | Keine untrainierten Scoring-Versprechen, kein Kubernetes für den Pilot |
| Tech & Product, S. 40–51 | Afrikanische Finanzierungs-/Rechtsstrukturen | Nicht auf Brasilien übertragen; kein Capital-Modul |
| Replication Blueprint, S. 4–7, 9–11 | Hybridbetrieb, Datenfeedback, Kosten und nachweisbare Pilotwirkung | Erst Erreichbarkeit und operative Wiederholbarkeit beweisen |

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


### Separate Grok voice comparison sandbox

Add an independent browser microphone test for xAI Grok alongside GPT-Live and Twilio. Keep operator UI and conversations in English with the same fictional Ana Silva case and shared isolated tools. Browser sessions must never send telephone calls or modify imported portfolios. Stream PCM audio over an authenticated app WebSocket; keep the permanent xAI key server-side. Preserve explicit name self-report once per session, allow hypothetical conversation scenarios, and record actual expressed outcomes only. Support audio interruption, mute, end, startup errors, and a five-minute session limit. Configure XAI_API_KEY locally, with optional XAI_VOICE_MODEL and XAI_VOICE defaults. Verify lifecycle, authorization, tool continuation and UI using simulated providers before any live xAI test.


### Integrate accepted demo solutions with the platform

Accepted voice-demo payment solutions must persist in the demo workspace as a case in a dedicated portfolio, with the accepted schedule, an operational review task and a payment follow-up job. OpenAI, Grok and Twilio share this behavior. Session/agreement identity prevents duplicate records. Follow-ups initially support SMS/email with clearly nonpayable demo links and Pix placeholders; operators can edit drafts in the case detail. No real sending is included in this iteration. Later stop-contact/dispute/review outcomes must update the saved case and cancel drafts. Browser speech remains ephemeral and existing imported cases stay separate.


## Model-independent agent execution and first automated handoff

New product requirement: agent roles, task state, domain tools and conversation memory must be independent of a particular model/provider. Per-role profiles select provider, model and API endpoint. Provider adapters translate only request/response formats; workflow records and business actions use normalized contracts. OpenRouter and compatible providers can be selected without rewriting the payment workflow. Model/provider capabilities and role-level evaluation remain required; interchangeable transport does not imply identical model behavior.

The first implemented handoff is an accepted demo payment solution → observed end of source call → persistent virtual SMS agent conversation. The coordinator creates and serializes durable jobs, the lightweight text model formulates replies, and a stronger supervisor is consulted on ambiguity. An Agents overview exposes actual implemented roles/configuration and tracked workflow jobs. This is automatic virtual delivery with real model generation, not enabled physical SMS. Existing live voice adapters remain separate. Full autonomous portfolio planning remains a later step.
