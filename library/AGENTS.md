# Library Agent Scope

`library/**` is owned by the `library` Codex agent for library-related work.

Directory roles:

- `library/libs/**`: reusable library implementation. Public APIs, exported types, and reusable behavior belong here.
- `library/src/**`: demo/showcase application for development scenarios and integration validation. Do not treat this as public library implementation.
- `library/test/**`: tests for the library and demo integration behavior.
- `library/docs/**`: library documentation and generated/reference docs.
- `library/scripts/**`: development and build tooling.

Use `library/src/**` changes only to support demonstrations, development scenarios, or integration validation. Keep public APIs and reusable implementation under `library/libs/**`.

Do not edit `site/**` from library-only work. If a change requires `site/**`, escalate to the parent so it can coordinate the API/data contract with the `frontend` agent.
