# A next release channel published on every merge

## Summary

Preview tracks the bleeding edge of this repo so a regression surfaces there
before it can reach a stable channel. Publishing was dispatch-only, so the
bleeding edge only existed once someone remembered to cut a release, and cutting
one moved `latest` for everybody at the same time. There was no way to run
unreleased adapters in preview without shipping them to prod.

Every push to `main` now publishes a canary of each changed package under the
`next` dist-tag. `latest` stays a deliberate dispatch. The PyPI publishers fire
on a merge that touches their package, so bumping a version in `pyproject.toml`
is the whole release act rather than a dispatch someone has to remember.

## Design

| | trigger | consumer |
|---|---|---|
| `next` | every push to `main` | preview |
| `latest` | **Publish** with `channel: latest` | prod |

**Both channels live in `publish.yml`.** npm registers a trusted publisher
against `(repo, workflow filename, environment)`, so a workflow per channel
would need a second registration on npmjs.com and would publish nothing until
someone made it. One file, two jobs, selected by event and input.

**Canary cross-dependencies are pinned with `--exact`.** Lerna's canary mode
rewrites intra-workspace ranges to the canary version, which is what stops
`@astropods/adapter-mastra@next` from resolving a stable `adapter-core`
underneath it. By default it writes those ranges with a caret, and
`^0.10.1-next.0` also admits the later stable `0.10.1`. npm takes the highest
match, so the whole `next` set would drift back onto stable the moment a release
shipped. `--exact` pins them instead.

**The `next` job skips the `latest` job's own commit.** `lerna version` pushes a
version commit to `main`, and an App token push triggers workflows. Without the
`chore(release):` guard, publishing stable would immediately publish canaries of
the versions that had just gone out. `lerna.json` now states that commit message
explicitly rather than leaving the guard to match a default.

**`lerna changed` gates the canary.** It exits non-zero when nothing has changed
since the last release tag, which is the steady state right after a stable
publish. Without the gate, lerna would publish a canary of every package on
every merge. `ignoreChanges` already excludes markdown and tests, so a docs-only
merge is a no-op.

**PyPI publishers check the version exactly.** They grepped `pip index versions`
for the version string, which is a substring match: `0.4.0` matched `0.4.01` and
reported the release as already published, skipping it in silence. Now that the
publishers run automatically, a silent skip would be much harder to notice, so
they query the PyPI JSON API for an exact version instead.

There is no `next` channel on PyPI. It has no dist-tags, and the analogue is a
`.devN` prerelease stream that needs a target-version convention stable releases
must then stay ahead of. That is a separate decision.

## Migration

None. `latest` publishes exactly the versions it did before, from the same
dispatch, and the default channel on that dispatch is still `latest`.

Consumers see a new `next` dist-tag. Nothing resolves it unless it asks for it by
name: `npm install` without a tag still takes `latest`, and a caret range never
matches a prerelease.
