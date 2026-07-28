# Contributing to adapters

Framework adapters that connect agents (Mastra, AI SDK, Claude Agent SDK,
LangChain, …) to the Astro messaging bridge. A Bun + Lerna workspace of
independently-versioned TypeScript and Python packages.

## Packages

TypeScript (`packages/`):

- `core` — `@astropods/adapter-core`: framework-agnostic `AgentAdapter` interface
  and the gRPC `MessagingBridge`
- `mastra` — `@astropods/adapter-mastra`
- `ai-sdk` — `@astropods/adapter-ai-sdk`
- `claude-agent-sdk` — `@astropods/adapter-claude-agent-sdk`
- `langchain-js` — `@astropods/adapter-langchain`

Python (`packages/`):

- `core-py` — `astropods-adapter-core`
- `langchain` — `astropods-adapter-langchain`

## Prerequisites

- [Bun](https://bun.sh) (use `bunx <cmd>`, not `npx`)
- Python 3.10+ (CI runs 3.12) for the Python packages

## Setup & build

`bun install` pulls everything you need, including the gRPC types
(`@astropods/messaging`) from public npm.

```sh
bun install
bunx lerna run build            # build all TS packages
```

Per package / focused:

```sh
cd packages/<pkg> && bun run build                                   # single TS package (tsc)
bunx lerna run build --scope @astropods/adapter-mastra --include-dependencies
cd packages/core-py && pip install -e ".[dev]"                       # a Python package
```

## Tests & checks

```sh
bunx lerna run test             # all TS package tests (each runs `bun test`)
cd packages/<pkg> && bun test   # a single TS package
cd packages/core-py && pytest   # Python tests (after `pip install -e ".[dev]"`)
bunx lerna run typecheck        # typecheck (note: currently only langchain-js defines this script)
```

There is no repo-wide ESLint/Prettier config; TypeScript is kept honest by
`tsc` in `strict` mode. CI (`.github/workflows/test.yml`) gates PRs on build →
typecheck → test, plus a `claude-agent-sdk` SDK-version matrix and a Python
matrix.

## Commits & pull requests

- **Conventional Commits are enforced** (`commitlint` via the
  `conventional-commits` workflow). Use `feat(core): …`, `fix(mastra): …`,
  `chore: …`, `ci: …`, etc.
- Branch off `main` (`feat/…`, `fix/…`, `chore/…`); PRs are **squash-merged**
  (linear history, PR number in the subject).
- Optional design note: add `docs/changelog/<slug>.md` with **Summary / Design /
  Migration** sections for non-trivial changes. Per-package `CHANGELOG.md` files
  are generated automatically, don't edit them by hand.

## Adding a new adapter

Implement the `AgentAdapter` interface from `@astropods/adapter-core` (see
`packages/core/README.md`) and wire it up with `serve()`. Model the package after
an existing adapter (e.g. `packages/mastra`).
