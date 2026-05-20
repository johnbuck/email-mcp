# CLAUDE.md

Guidance for Claude (Code Action, managed Code Review, local Claude Code
sessions) when working in this repository.

## What this repo is

An open-source **MCP (Model Context Protocol) server** providing
comprehensive email capabilities over IMAP and SMTP. It exposes tools,
prompts, and resources to AI assistants for reading, sending,
scheduling, organising, and analysing email across multiple accounts.

- **Language / runtime**: TypeScript (ESM), Node.js ≥ 24.
- **Package manager**: pnpm 9 (do not introduce npm or yarn).
- **Transport modes**: stdio (default), Streamable HTTP.
- **License**: LGPL-3.0-or-later.
- **Public repo**: be mindful that issue and PR comments are world-readable.

See `README.md` for the feature list and `docs/` for deeper guides.

## Stack and tooling

| Concern | Tool |
|---|---|
| Format / import organisation | Biome (`pnpm format`, `pnpm format:check`) |
| Lint | ESLint (Airbnb Extended + TS strict) (`pnpm lint`) |
| Combined static checks | `pnpm check` (Biome + ESLint) |
| Type-check | `pnpm typecheck` |
| Unit tests | Vitest (`pnpm test`) |
| Integration tests | Vitest with `vitest.config.integration.ts` (`pnpm test:integration`) — uses testcontainers |
| Pre-commit hooks | lefthook |
| Versioning / changelog | cocogitto (`cog`) |
| Release | goreleaser |

Always run `pnpm check && pnpm typecheck && pnpm test` before declaring
work done. For changes touching IMAP/SMTP behaviour, run
`pnpm test:integration` as well.

## Conventions to follow

- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`, `ci:`). cocogitto enforces this. Use `pnpm commit`
  if unsure.
- **Branches**: topic branches off `develop`. PRs target `develop`.
  `main` is the release line, fed by `develop` → `main` merges.
- **Files layout**: business logic in `src/services/`, MCP wiring in
  `src/tools/`, `src/prompts/`, `src/resources/`. Keep them decoupled —
  services must be unit-testable without mocking MCP transports.
- **Workflows**: lowercase kebab-case `name:`, explicit `permissions:`
  block per workflow, prefer the shared workflows under
  `codefuturist/shared-workflows` over re-implementing common steps.

## What to do / not do

- **Prefer editing existing files** over creating new ones.
- **Do not** hardcode credentials, API keys, OAuth client secrets, or
  example email addresses with real domains in source or tests.
- **Do not** log passwords, OAuth tokens, or full message bodies at
  `info` or above — they may end up in user-shared logs.
- **Do not** bump `engines.node` below 24 (existing baseline).
- **Do not** add a new transport without updating both `README.md` and
  the MCP capability negotiation.
- **TypeScript**: keep `strict` on, no `any` without an explicit
  comment justifying it.
- **Async correctness**: IMAP IDLE, watcher, scheduler, and rate-limiter
  code is concurrency-sensitive. Don't fire-and-forget promises; await
  or attach `.catch(...)`.
- **Public API**: tool names, parameter schemas, and resource URIs are
  part of the MCP API surface. Renames or schema changes are breaking
  changes and need a major version bump (see `cog.toml`).

## Validation before you call it done

1. `pnpm check` — Biome + ESLint clean.
2. `pnpm typecheck` — no type errors.
3. `pnpm test` — unit tests green.
4. `pnpm test:integration` — only if touching IMAP/SMTP, watcher,
   scheduler, or transport code.
5. For Docker-affecting changes: `pnpm docker:build` succeeds.
6. For workflow changes: `actionlint` clean (`pnpm report` includes it).
