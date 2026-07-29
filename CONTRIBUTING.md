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

## Contributions of source code

All such contributions should be in the form of pull requests.

By opening a pull request

- You agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
- When you open a pull request with your contributions, **you are certifying that you wrote the code** in the corresponding patch pursuant to the [Developer Certificate of Origin](#developer-certificate-of-origin) included below for your reference.

## Developer Certificate of Origin

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
1 Letterman Drive
Suite D4700
San Francisco, CA, 94129

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
