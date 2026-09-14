# Pilotabnahme Brasilien

Dieses Protokoll trennt lokale Funktionsprüfung und externe Abnahme. Der lokale Demo-Modus kontaktiert niemanden. Vorhandene Twilio-/OpenAI-Konten allein bestätigen noch keine laufende Verbindung.

## Fachlich festgelegt

- Brasilien, pt-BR, BRL, pro Fall konfigurierbare IANA-Zeitzone.
- KI bekommt Forderungskontext sofort. Ausdrückliches Ja zum Namen genügt im MVP, als Selbstauskunft gespeichert. Kein zusätzliches OTP/CPF/Betreuungscode.
- Nur Outreach und strukturierte Nacharbeit. Kein Inkasso-Scoring, Payment, Rabattversprechen oder automatische Ratenplangenehmigung.
- „Schon bezahlt“ stoppt die Sequenz und verlangt menschliche Prüfung; Saldo bleibt unverändert.
- Kein Live-Transfer versprochen: Übergabe als priorisierte Aufgabe.

## Noch praktisch zu prüfen

| Prüfung | Nachweis | Status |
|---|---|---|
| Twilio Voice → OpenAI → pt-BR-Antwort hörbar | Eigene freigegebene Testnummer, Call-SID, Zeitpunkt; keine Secrets im Protokoll | Offen: lokale Zugangskonfiguration |
| Unterbrechung und natürlicher Dialog | Testperson unterbricht, KI stoppt Ausgabe und hört zu | Lokal per Ereignistest; real offen |
| Namensbestätigung | Selbstauskunft-Ereignis, kein Identitätsnachweis behauptet | Lokal per Tooltest; real offen |
| Betrag/Referenz korrekt | Nach Bestätigung exakt importierte Daten; unbekannte Werte nicht erfunden | Kontext/Tools lokal geprüft; Sprachabnahme offen |
| Zahlung bereits erfolgt / Forderung bestritten | Saldo unverändert, hohe Priorität, keine weitere Queue-Aktion | Lokal automatisiert; real offen |
| Rückruf | Bestätigter Zeitpunkt einschließlich lokaler Zeitzone, sichtbare Aufgabe | Lokal automatisiert; real offen |
| SMS Zustellung und Rückantwort | Message-SIDs, signierte Callbacks, richtige Fallzuordnung | Lokale Verträge geprüft; real offen |
| Opt-out am Telefon / per SMS | Alle bekannten identischen Kontakte gestoppt, auch nach Neuimport | Lokal automatisiert; real offen |
| E-Mail und Antwort | Verifizierter SendGrid-Absender, Inbound-Parse-Domain, authentisierte Antwort | Lokale Verträge geprüft; separater Providerzugang offen |
| Öffentlicher Zugang | HTTPS/WSS, Secure-Cookie, Signaturprüfung mit tatsächlich vom Provider verwendeter URL | Lokal Signaturen geprüft; Deployment offen |
| WhatsApp | Anwendbarkeit der aktuellen Einschränkung auf Geschäftsmodell geklärt | Outbound im MVP gesperrt |

## Anrufskript zur Abnahme

1. KI stellt sich als virtuelle KI-Assistentin von Rescova vor und fragt nach der gewünschten Person und Gesprächsbereitschaft.
2. Bei eindeutigem Ja zum vollständigen Namen: Selbstauskunft speichern. Bei anderer Person, Schweigen, unklarem Namen oder fehlendem Namen keine Forderungsdetails aussprechen.
3. Nach Namensbestätigung Gläubiger und offenen Fall sachlich erklären. Die Testperson fragt den Betrag ab; Antwort muss dem Import entsprechen.
4. Testperson äußert nacheinander in getrennten Testfällen: „Já paguei“, „Não reconheço essa dívida“, „Estou sem renda“, „Quero falar com uma pessoa“, „Não me ligue mais“.
5. UI und Providerportal abgleichen: genau ein Versuch je Test, korrektes Ergebnis, passende Aufgabe/Sperre, kein zusätzlicher automatischer Versand.
6. Negativtest: Netzunterbrechung oder Providerfehler erzeugt nachvollziehbaren Prüfbedarf und keine blinde Wiederholung.

## Aktivierungsdaten

Schlüssel nur in der git-ignorierten `.env`, nicht in diesem Protokoll. Benötigt werden öffentlicher HTTPS/WSS-Endpunkt, Twilio-Account/Absender, OpenAI-Key und eine explizite Liste freigegebener eigener Testempfänger. `LIVE_SEND_ENABLED` ist standardmäßig `false`. Details im README.

Die technische Prüfung enthält keine allgemeine Rechtsfreigabe für Brasilien. Verantwortlicher und Gläubiger legen Mandat, zulässige Kontaktzeiten/-kanäle, Datenübermittlung, Retention und das Skript für den konkreten Pilot fest. Die BFREE-Unterlagen belegen diese brasilianischen Voraussetzungen nicht.
