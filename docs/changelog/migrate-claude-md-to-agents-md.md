# Migrate CLAUDE.md to AGENTS.md

## Summary

Rename `CLAUDE.md` to `AGENTS.md` so this repo matches the one convention used across the Astro monorepo. Claude Code, Codex, Cursor, and other coding agents all read `AGENTS.md`, so one file serves them all without a per-tool duplicate. Companion PRs land the same rename in the sibling submodules and in the outer `astropods/astro` repo; those pointers will bump once this merges.

## Design

A straight `git mv CLAUDE.md AGENTS.md`, no content changes. One reference inside `docs/agent-auth-sdk-spec.md` to "CLAUDE.md's workflow step 4" is rewritten to point at `AGENTS.md`.

## Migration

No action required.
