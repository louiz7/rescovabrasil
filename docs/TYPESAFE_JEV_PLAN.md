# TypeSafe Jev integration plan

Decision date: 19 September 2026. This plan introduces Jev as a typed semantic decision provider. It does not give Jev authority to contact debtors, change payment state or execute tools.

## Implementation status

Three active Jev roles are implemented for fictional demo data. Each accepted demo SMS or email message creates one idempotent `inbound-triage-v1` decision run. The worker sends compact state and eight independent Choice/Noul questions in one TypeSafe request, then stores the full typed answers, probabilities, model version, usage, latency, input hash, proposed route and applied route. The decision stores no duplicate message text, contact details or documents.

The integration uses the provider-neutral `DecisionEngine` boundary and `@typesafe-ai/sdk`. `TYPESAFE_DECISION_MODE` selects off, shadow or active behavior independently of the API key. An authenticated read endpoint at `/api/agent-workflows/decisions` exposes decision evidence. In active mode application policy may resolve an approved critical route directly, preload context for Marina or bypass Rafael with a defined dependency state. Failed, unavailable or low-confidence Jev results use the existing model path and cannot lose the operational job.

The active decision layer has three named roles:

- **Lia, inbound triage:** identifies intent and critical signals. Explicit contact-stop and wrong-person messages use deterministic acknowledgements without Marina generation. Payment reports are recorded as unverified and held without a Marina call.
- **Bento, context router:** chooses one authoritative source and preloads it before Marina answers. Marina can still invoke the existing lookup tool when the first source is insufficient.
- **Tiago, resolution router:** maps routine escalations to payment verification, document wait, missing information or policy block. Only ambiguous or complex cases continue to Rafael.

The live pt-BR/English evaluation passed 18/18 primary intents, 18/18 context-source selections, every critical signal and 10/10 escalation routes with Jev 1.13.0. Inbound decisions averaged 500 ms; escalation decisions averaged 483 ms. The local active configuration pins that evaluated model. This small, intentionally simple test set proves controlled demo behavior only; expand the corpus before real debtor traffic.

## Recommended role

Jev sits behind the provider-neutral `DecisionEngine` already defined in the target architecture. It evaluates compact structured state and returns typed judgments. Application code combines those judgments with deterministic policy and creates durable tasks or commands. Jev does not replace the coordinator, Rafael, generative conversation models, the case context service, the payment ledger or the action gateway.

One request should evaluate independent questions over the same state in parallel. Question sets, model versions, thresholds and application routing rules are versioned separately. Type safety guarantees response shape, not factual correctness or permission to act.

Relevant TypeSafe guidance:

- State and named structured fields: https://docs.typesafe.ai/concepts/state
- Intent routing: https://docs.typesafe.ai/patterns/intent-routing
- Speculative fan-out: https://docs.typesafe.ai/patterns/fan-out
- Confidence and risk-dependent thresholds: https://docs.typesafe.ai/confidence
- Closed-set function routing: https://docs.typesafe.ai/cookbooks/function_calling
- Input/output guardrails: https://docs.typesafe.ai/cookbooks/llm_guardrails
- JavaScript SDK: https://docs.typesafe.ai/sdk/javascript

## Priority 1: inbound-message triage

Run one Jev evaluation after a normalized SMS or email arrives. Shadow v1 observes the current workflow without delaying or changing route selection. A later evaluated release may place it before an expensive reasoning path. Use the latest message plus small authoritative signals: language, channel, active agreement/offer presence, case status and available capabilities. Do not send complete documents, contact details or the full case history.

Implemented v1 question set:

- `primary_intent` Choice: payment options, offer acceptance, payment report, document request, case question, dispute, wrong person, contact stop or other.
- Separate Noul questions: contact stop, wrong person, dispute, payment reported, document requested and offer acceptance. Several flags may be true at once.

Callback, missing-information and complexity judgments remain candidates for a later version. Add them only when labeled examples show that the extra token cost improves a concrete routing decision.

Code keeps precedence and authority. Existing deterministic STOP/PARAR rules run first. Jev proposes a route; application policy may use a high-confidence explicit stop, wrong-person or payment-report signal to execute the already-authorized deterministic handler. Jev never records consent, marks payment received or sends a message directly.

Expected value: fewer routine requests reach Rafael or the generative router; critical semantic signals become observable probabilities rather than hidden prompt decisions.

## Priority 2: targeted context routing before Marina

The inbound batch also selects `case_details`, `payment_terms`, `payment_status`, `documents`, `activity`, `conversation_history` or `none`. At sufficient confidence, application code performs one case-scoped lookup before Marina runs. This can remove a generative lookup round while preserving the existing bounded lookup loop as fallback.

## Priority 3: unresolved-work routing before Rafael

When Marina cannot resolve a request, Jev chooses among existing closed-set capabilities: targeted case lookup, Helena document retrieval, payment-status verification, missing-information wait, blocked-policy state or Rafael reasoning. Closed-set tool and argument selection fits Jev; free-text query generation remains with code or a generative model.

This route is active for the fictional demo. Low confidence, a `requires_supervisor_reasoning` result or unavailable Jev falls back to Rafael. Provider failure cannot lose or repeatedly execute work. The durable resolution records Tiago as owner when he selected a defined dependency; those jobs no longer inflate Rafael's completed-work count.

## Next candidate: outbound semantic verifier

Evaluate generated SMS/email replies before delivery, initially without blocking. Compare the draft with compact authoritative facts and policy. Ask independent questions for:

- unauthorized or changed payment terms;
- unsupported claim that payment, delivery or case closure occurred;
- coercive threat or invented legal consequence;
- disclosure of internal notes, secrets or unnecessary sensitive data;
- contradiction with current creditor, agreement, balance or document evidence;
- failure to respect opt-out, dispute or wrong-person state.

Application policy turns probabilities into pass, regenerate, route to Rafael or block. Exact numeric/payment checks remain deterministic. Jev does not rewrite the reply.

## Later uses

- Post-call and completed-task quality classification once durable normalized call evidence exists.
- Portfolio next-action prioritization after the bounded planner and outcome dataset exist.
- Retrieval reranking only if measured lexical-search failures justify it.
- Real-time voice routing only after Portuguese accuracy and end-to-end latency pass a dedicated evaluation. GPT Live keeps current voice/tool control meanwhile.

## Integration boundary

Add a separate interface rather than extending the generative model adapter:

```ts
interface DecisionEngine {
  evaluate(input: {
    purpose: string;
    state: unknown;
    questionSet: string;
    traceId: string;
  }): Promise<DecisionEvaluation>;
}
```

The TypeSafe implementation uses `@typesafe-ai/sdk` server-side with `TYPESAFE_API_KEY`. Pin the evaluated Jev model version before activation; do not rely on a moving alias after thresholds are calibrated. A provider outage returns an explicit unavailable result and uses the existing workflow path.

Persist a decision run with purpose, case/task correlation, input evidence references and hash, question-set version, provider/model version, all returned probabilities/confidence, threshold-policy version, proposed route, applied route, latency, usage and eventual outcome label. Avoid storing duplicate raw PII in the decision log.

## Rollout

1. **Access and contract check:** **partially complete.** The key and SDK work with synthetic data. Provider privacy, retention, training, region, subprocessors and DPA review remains open before real debtor data.
2. **Shadow triage:** **completed for demo SMS/email.**
3. **Threshold calibration:** evaluate per flag and per route. Critical opt-out, wrong-person, dispute and payment-report failures are assessed separately from overall routing accuracy. Cookbook thresholds are not production defaults.
4. **Shadow output verification:** record findings beside actual model replies and compare them with deterministic checks and observed failures.
5. **Low-risk activation:** **implemented as advisory active routing.** Results at or above 0.75 are supplied to Marina; lower-confidence or failed decisions use Marina fallback. External actions and agreement/payment mutations remain behind existing validation.
6. **Controlled gating:** enable output blocking or regeneration only after held-out and live-shadow evidence meets defined thresholds. Monitor drift by language, channel, question-set and model version.

## Exit criteria for first activation

- Held-out pt-BR and English evaluation results documented per intent and critical flag.
- No regression in deterministic opt-out, consent, payment or contact-policy behavior.
- Jev outage, timeout, malformed result and low-confidence paths preserve one durable explainable task.
- No Jev result directly creates an external side effect.
- Latency, token use, provider cost and Rafael-volume change are measured from shadow traffic.
- Every applied route can be reconstructed from evidence, question/model versions, probabilities, threshold policy and code decision.
