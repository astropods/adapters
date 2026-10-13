# Changelog categories

## Summary

Sam wants to read past changes in adapters by type. Before, four entries sat loose at the top of `docs/changelog/` with no date in their names. Now every entry sits in a folder named for the type of change, such as `docs/changelog/feat/`.

## Design

4 entries moved into `feat`, `fix`, `perf`, `refactor`, `chore`, `docs`, `test`, `ci`, `security` or `revert` by what the change does. Every name now ends in its date: `{short-name}-YYYY-MM-DD.md`. The rule and the category table live in `CLAUDE.md`, the same rule as the astro repo.

## Migration

None. New changelogs go to `docs/changelog/{category}/{short-name}-YYYY-MM-DD.md`.
