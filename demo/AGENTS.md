# Demo Agent Scope

`demo/**` is owned by the `library` Codex agent for demo and integration work.

Directory roles:

- `demo/src/**`: demo/showcase application for development scenarios and integration validation.
- `demo/test/**`: demo integration tests.
- `demo/docs/**`: legacy demo documentation and generated/reference docs.
- `demo/scripts/**`: development and build tooling.

Use `demo/src/**` changes only to support demonstrations, development scenarios, or integration validation. Keep public APIs and reusable implementation under `lib/**`.

Do not edit `site/**` from library-only work. If a change requires `site/**`, escalate to the parent so it can coordinate the API/data contract with the `frontend` agent.
