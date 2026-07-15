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

## Library structure

- `library/libs/**`: reusable implementation
- `library/src/**`: demo/showcase and development application
- `library/test/**`: tests
- `library/docs/**`: documentation
- `library/scripts/**`: build and development tooling