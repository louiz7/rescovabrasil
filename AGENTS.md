# Project instructions

Follow `/Users/louizel-hosri/.codex/RTK.md` for shell commands.

## Communication mode

Use the installed `caveman` skill in its default `full` mode for work in this project unless the user asks for another level or turns it off. Keep persisted code, documentation, commit messages, tickets, and third-party messages in normal prose as required by the skill.

## TypeSafe development

Use the project-installed `typesafe-ai` skill for work involving Jev, typed semantic decisions, routing, ranking, extraction, verification or the planned `DecisionEngine`. Follow its live-documentation requirement and keep deterministic rules, authorization and side effects in application code.

## Product direction

Read the long-term product direction in [docs/GOAL.md](docs/GOAL.md). Rescova is intended to become a fully agentic platform: specialized agents handle all relevant tasks, communicate with one another, share context, coordinate work, and hand off tasks and results.

Keep that destination in mind when designing features, selecting technologies, and shaping data models and interfaces. Prefer capabilities that agents can invoke and compose, with explicit shared task state and results. The eventual UI supports oversight, configuration, and exceptions. Do not mistake current manual steps or demo-only limitations for the final product design.

This direction does not require an immediate architecture rewrite, a particular agent framework, or a separate agent for every function today. It does not authorize external actions beyond the user's current scope or override existing permissions and domain rules.


## Workflow documentation

Maintain [docs/WORKFLOWS.md](docs/WORKFLOWS.md) alongside code changes that alter workflow triggers, agent ownership, task states, or delivery. Keep Mermaid diagrams aligned with the implementation and explicitly label planned behavior.


## Product maturity assessment

After each substantial feature, architecture or workflow change, update [docs/ASSESSMENT.md](docs/ASSESSMENT.md). Record what now works, the evidence and limitations, remaining gaps to autonomous collections, the next milestone and any revised effort estimate. Keep demo behavior, provider-backed tests and production readiness separate. Include a short assessment delta in the final response. Do not increase readiness simply because more agents or UI elements exist.
