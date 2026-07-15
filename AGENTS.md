# Repository instructions

This repository has three primary ownership areas:

- `site/**`: frontend application
- `demo/**`: NestJS demo and development host
- `lib/**`: reusable npm library

## Delegation

- Delegate frontend UI, UX, visualization, browser behavior, and files under
  `site/**` to the `frontend` agent.
- Delegate reusable library, NestJS integration, public API, types, tests,
  documentation, and files under `lib/**` or `demo/**` to the `library` agent.
- For work touching `site/**` and `lib/**`, use both agents.
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

- `lib/src/**`: reusable implementation
- `demo/src/**`: demo/showcase and development application
- `demo/test/**`: demo integration tests
- `demo/docs/**`: legacy demo documentation
- `demo/scripts/**`: demo development tooling
