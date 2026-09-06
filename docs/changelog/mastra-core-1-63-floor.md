# Raise the Mastra adapter's `@mastra/core` floor to 1.63.0

## Summary

The adapter declared `@mastra/core >=1.14.0` as its peer range, but the code
stopped supporting anything below 1.63.0 when it adopted that release's
breaking changes. `getConfig()` no longer calls `listTools()`, which became
async in 1.63.0; it reads the synchronous raw-field snapshot instead (see
`src/adapter.ts`). Against 1.14–1.62 the install resolved cleanly with no peer
warning, and the mismatch only showed up at runtime. The range now states what
the code actually requires.

## Design

The peer range is the contract, so it moves to `>=1.63.0`. It stays optional
via `peerDependenciesMeta`, so agents that never construct a Mastra `Agent` are
unaffected.

The dev dependency moves to `^1.64.0`, the current release. The build and the
48-test suite pass against both 1.63.0 (the floor) and 1.64.0 (the ceiling of
the caret range), so the declared range is exercised at both ends rather than
only where the lockfile happens to sit.

## Migration

Agents already on `@mastra/core` 1.63.0 or later need no action. An agent
pinned below 1.63.0 now gets a peer warning on install instead of a silent
runtime failure, and should upgrade `@mastra/core` to `^1.64.0`. Bumping the
whole `@mastra/*` family together is required: `@mastra/memory` below 1.28.x
has a `recall()` return type that no longer satisfies core 1.63+, so upgrading
core alone fails typecheck.
