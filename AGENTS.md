# Repository instructions

This repository has two primary ownership areas:

- `site/**`: frontend application
- `library/**`: reusable library workspace

## Delegation

- Delegate frontend UI, UX, visualization, browser behavior, and files under
  `site/**` to the `frontend` agent.
- Delegate reusable library, NestJS integration, public API, types, tests,
  documentation, and files under `library/**` to the `library` agent.
- For work touching both areas, use both agents.
- For cross-area work, define or verify the library API/data contract first,
  then integrate it in the frontend.
- The parent agent coordinates final integration and resolves contract mismatch.

## Skills

- For pnpm workspace, dependency, script, or lockfile tasks, read and apply the
  installed `pnpm` skill before editing.
- When a task may need an additional reusable capability, use the installed
  `find-skills` skill to search for a suitable project skill before creating a
  bespoke workflow.

## Library structure

- `library/libs/**`: reusable implementation
- `library/src/**`: demo/showcase and development application
- `library/test/**`: tests
- `library/docs/**`: documentation
- `library/scripts/**`: build and development tooling
