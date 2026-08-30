# Vendored agent assets

The skills and agents listed below are copied from [ECC](https://github.com/affaan-m/ECC)
(MIT). They are third-party content, not maintained here.

| Field | Value |
|---|---|
| Source | `affaan-m/ECC` |
| Version | `v2.2.0` |
| Commit | `d8e6a51` |
| License | MIT — see [`LICENSE-ECC`](./LICENSE-ECC) |

## What was taken

**Skills** (`.claude/skills/`)

| Skill | Why it is here |
|---|---|
| `nestjs-patterns` | `lib/` and `demo/` are NestJS |
| `nuxt4-patterns` | `site/` is Nuxt 4, and the viewer turns on SSR/hydration behaviour |
| `vue-patterns` | the viewer's components and Pinia stores |
| `hexagonal-architecture` | `lib/` is ports and adapters |
| `contract-first` | the public API and `GraphOutput` are versioned cross-package contracts |
| `api-design` | `lib/src/index.ts` and the inspector's HTTP routes |
| `opensource-pipeline` | npm publish with provenance, version stamped from the release tag |
| `ecc-security-review` | the token guard, the proxy, and Direct Run |

**Agents** (`.claude/agents/`) — `typescript-reviewer`, `vue-reviewer`,
`security-reviewer`, `silent-failure-hunter`. All four are read-only
(Read/Grep/Glob/Bash).

## What was deliberately left out

- **ECC's hooks.** They run Node on nearly every tool call, and several block:
  `pre:config-protection` refuses edits to linter and formatter configs,
  `gateguard-fact-force` blocks the first Edit/Write per file. Nothing here
  executes; these are instruction files only.
- **ECC's rules.** They are always-loaded context, paid for on every turn.
- **ECC's own `CLAUDE.md`, `AGENTS.md`, and `RULES.md`**, which would collide
  with this repository's.
- **`tdd-guide`**, which mandates 80% coverage — not this repository's rule.
- **`e2e-testing`**, which is Playwright-specific; the demo's e2e suites are
  Jest and supertest.

## Local modifications

`ecc-security-review` is ECC's `security-review`, renamed (directory and
frontmatter `name`) because Claude Code ships a built-in skill under that name.
Nothing else was changed.

## Updating

Copy from a newer ECC tag and re-apply the rename above. These files are
vendored on purpose rather than installed as a plugin: a plugin would also
activate ECC's hooks for every contributor.
