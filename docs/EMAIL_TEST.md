# Google Workspace email demo

The email demo sends **from and to louiz@rescova.de only**. It uses Gmail directly, not SendGrid. No DNS changes, public webhook or ngrok are needed: the local worker polls only the Gmail threads created by agent-requested email delivery or optional manual tests every 15 seconds. The app must remain running.

This is real email delivery of fictional demo data. It is separate from `LIVE_SEND_ENABLED` and the portfolio outreach adapter. Ordinary portfolio activation does not start email sending. An explicit email request during a demo call or written conversation creates the delivery task automatically. Uploaded case documents are not externally released by this test: only the seeded fictional Ana documents are allowed.

## One-time Google setup

1. In Google Cloud Console, create/select a project owned by your Workspace organization and enable **Gmail API**.
2. Configure Google Auth Platform branding/audience. Use **Internal** for your organization where available. Otherwise configure a testing audience and explicitly add `louiz@rescova.de` as a test user. Your Workspace admin may need to allow the app.
3. Add scopes `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/gmail.readonly`. Read access is required to fetch replies. Google grants mailbox-wide read access; application code reads only the explicitly linked test threads. It does not scan unrelated mail.
4. Create an OAuth client of type **Web application**. Add this exact authorized redirect URI:
   `http://127.0.0.1:53682/oauth/google/callback`
5. Put its client ID and client secret in the prepared `.env` variables `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`. Do not put credentials in chat or commit them.
6. From the project directory run `npm run gmail:connect`. Sign in as `louiz@rescova.de` and grant access. The local helper validates the account and stores `GMAIL_REFRESH_TOKEN` directly in `.env`; it never prints the token. Port 53682 must be free. The helper times out after five minutes.
7. Set `EMAIL_TEST_ENABLED=true` in `.env`; keep `OUTREACH_MODE=demo` and `AGENT_WORKFLOWS_ENABLED=true`. Restart with `npm run dev`.

The UI shows credential presence, not proof that Google has accepted the connection. Activation verifies the mailbox. Refresh-token expiration/revocation or Workspace restrictions appear as connection failures; reconnect when necessary. This is a pilot mailbox integration, not a bulk collection-email infrastructure claim.

## Full test: call → document → email → installments

1. Open http://127.0.0.1:5173 and sign in.
2. Start the GPT Live **browser voice test**. Confirm you are Ana Silva and ask: “Please send me my loan agreement by email.” Do not accept a payment plan yet, so the email conversation can exercise a new agreement.
3. End the call. Helena retrieves the document, Marina composes the follow-up and the email worker sends it automatically. No per-case preview/start click is required. This preserves the observed-call-end gate.
4. Open **Email test** from Overview or Agents (direct link: http://127.0.0.1:5173/?emailTest=1) to monitor the automatic delivery. If Google is not configured/enabled, the request stays `awaiting_configuration` and resumes once setup is complete. The preview/send controls are optional troubleshooting tools for older virtual-only conversations.
5. Open `louiz@rescova.de` in Gmail. Find the `[Rescova demo …]` thread, inspect/download the fictional loan agreement, and reply within that thread: “Can I pay in three installments?” Use Reply, not a newly composed email or forwarded thread. The application ignores its own outgoing emails and automatic replies.
6. Wait for the next 15-second synchronization or click **Sync replies** in Email test. Marina should explain the authorized terms by email, without asking for name confirmation again.
7. To test switching channels, open that same case's agent conversation in the app and use **Send demo SMS**: “Yes, I accept the three-installment plan.” Marina retains the email offer and document history. The shared payment tool saves one agreement and follow-up record, and confirms the stored schedule in demo SMS. It does not resend that SMS reply by email. Alternatively, reply in Gmail and the confirmation stays in email. Check the same case in the platform.
8. Ask for an account statement to exercise Helena, or ask something unsupported to see Rafael's tracked resolution under **Agents → Supervisor escalations**.
9. Test “STOP” last. It stops the case conversation and prevents subsequent email delivery. Use a fresh browser demo session for another test.

Alternative: request a document by email, then accept a solution in the same voice call. The saved email preference also routes subsequent agreement follow-up through email after call end. An ordinary voice agreement without an email preference still follows the default virtual SMS path.

## Controls and interpretation

- **Cross-channel context:** each message and queued task retains its own channel. SMS and email share one case conversation and one agreement; switching channels does not restart identity confirmation. SMS here is still the virtual demo inbox, not physical Twilio SMS delivery.
- **Pause email** stops further thread synchronization and new delivery for that binding; it cannot recall an email already submitted. Resume through the same preview/start control. Global shutdown: set `EMAIL_TEST_ENABLED=false` and restart.
- **Submitted** means Gmail accepted the send request. Gmail API does not provide this integration with recipient-delivery or read receipts; we never label it delivered/read on that basis.
- **Uncertain** means a timeout, malformed send response, or restart left delivery unconfirmed. No automatic resend occurs. Inspect Gmail before further action. Later outbound messages in that conversation remain held; this MVP does not offer a blind retry button.
- **Failed** similarly holds later messages; check the connection and delivery record. Use a new demo conversation after resolving configuration rather than assuming a failed/uncertain send is safe to repeat.
- Email thread replies must come from the fixed test mailbox and reference an actual outbound message. Unknown participants, unrelated mail, auto-replies, and duplicate provider IDs never become agent input.
- Only bounded fresh plain text is supplied to the agent; quoted previous mail is stripped. Incoming attachments/HTML-only messages are not processed in this slice. Replies over 2,000 fresh-text characters are recorded as rejected; send a shorter reply. Later messages, including STOP, continue to be processed.
- External document delivery is intentionally limited to the seeded fictional documents. General external document authorization, inbound attachments/OCR, arbitrary recipients, bounce reconciliation and higher-volume sending are future work.

## Official references

- Gmail sending: https://developers.google.com/workspace/gmail/api/guides/sending
- Gmail thread requirements: https://developers.google.com/workspace/gmail/api/guides/threads
- OAuth server flow: https://developers.google.com/identity/protocols/oauth2/web-server
- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
