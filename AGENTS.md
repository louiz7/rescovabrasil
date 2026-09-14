# Project instructions

Follow `/Users/louizel-hosri/.codex/RTK.md` for shell commands.

## Product direction

Read the long-term product direction in [docs/GOAL.md](docs/GOAL.md). Rescova is intended to become a fully agentic platform: specialized agents handle all relevant tasks, communicate with one another, share context, coordinate work, and hand off tasks and results.

Keep that destination in mind when designing features, selecting technologies, and shaping data models and interfaces. Prefer capabilities that agents can invoke and compose, with explicit shared task state and results. The eventual UI supports oversight, configuration, and exceptions. Do not mistake current manual steps or demo-only limitations for the final product design.

This direction does not require an immediate architecture rewrite, a particular agent framework, or a separate agent for every function today. It does not authorize external actions beyond the user's current scope or override existing permissions and domain rules.
