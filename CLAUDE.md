# adapters

Bridges between agent frameworks and the Astro runtime (messaging, streaming,
voice, observability).

This repo is normally checked out as `astropods/astro`'s `modules/adapters`
submodule. That repo's `agents.md` (Writing style, Development Workflow)
applies here too; where this file says something different, this file wins.

## Changelogs

Every PR adds a changelog at `docs/changelog/{category}/{short-name}-YYYY-MM-DD.md` (e.g. `docs/changelog/fix/trace-search-2026-03-10.md`).

The category is the type of change, never a person, a coding agent, or a branch prefix:

| Category | Use for |
|---|---|
| `feat` | A new capability, endpoint, command, page, or integration |
| `fix` | A bug or broken behavior |
| `perf` | Faster or cheaper, same behavior |
| `refactor` | Restructured code, same behavior |
| `chore` | Cleanup, dead code, dependencies, config, tooling, polish |
| `docs` | Docs, specs, and design proposals |
| `test` | Tests and test harnesses only |
| `ci` | CI and GitHub Actions |
| `security` | Closes a security hole or hardens access |
| `revert` | Reverts an earlier change |

If no category fits, add a new one that future changes of that type can share, and add it to this table. The short name describes the change; it does not repeat the category (`fix/trace-search`, not `fix/fix-trace-search`).
