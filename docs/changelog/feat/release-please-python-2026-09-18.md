# Version the Python packages from conventional commits

## Summary

`core-py` and `langchain` carry their version as a literal in `pyproject.toml`,
bumped by hand. Nothing enforces the bump, and the PyPI workflows treat an
already-published version as success, so a forgotten bump is silent.

It already cost a release. `92200ad` added the adapter-core auth SDK and left
`version` at `0.7.0`, which had shipped two weeks earlier. Every push since
skipped the upload with a `::notice::`, and the auth module sat unpublished for
a week. The npm packages never hit this, because `lerna version` derives their
bumps from conventional commits. Lerna only sees directories with a
`package.json`, and neither Python package has one, so both sit outside it.

## Design

`release-please` versions the two Python packages. It reads the same
conventional commits lerna does, and its `python` release type writes
`pyproject.toml` directly. Commitlint already gates commit format on every PR
(`.github/workflows/conventional-commits.yml`), so the input needed no work.

Configuration is the manifest form, which is the mode that supports more than
one package:

```json
{
  "packages": {
    "packages/core-py":   { "release-type": "python", "package-name": "astropods-adapter-core" },
    "packages/langchain": { "release-type": "python", "package-name": "astropods-adapter-langchain" }
  }
}
```

Merging a release PR rewrites `pyproject.toml`, writes `CHANGELOG.md`, and
tags. The existing PyPI workflows need no change: they already trigger on
pushes touching `packages/core-py/**` and `packages/langchain/**`, and the
release commit touches `pyproject.toml`. Their "already published" check stops
being the thing that swallows a release and becomes a plain idempotency guard.

**This does not compete with lerna.** The two never consider the same package,
because lerna requires a `package.json`. Tags do not collide either: lerna tags
`@astropods/adapter-core@0.7.0`, release-please tags
`astropods-adapter-core-v0.8.0`.

`separate-pull-requests` is on, matching lerna's `version: independent`. It also
buys a correct title, because the plugin that combines packages into one PR
renders `${component}` and `${version}` empty. The title pattern is
`chore(release): publish${component} ${version}`, with no space after `publish`
since `${component}` supplies its own. That yields
`chore(release): publish astropods-adapter-core 0.8.0`, which commitlint
accepts, and which `publish.yml`'s next job skips on its existing
`chore(release):` guard rather than firing a pointless canary run.

Verified against the real repository rather than by reading the config, using
`release-please release-pr --dry-run` with `--target-branch` set to this branch:

```
✔ Building candidate release pull request for path: packages/core-py
✔ No commits for path: packages/langchain, skipping
title: chore(release): publish astropods-adapter-core 0.8.0
<details><summary>astropods-adapter-core: 0.8.0</summary>
```

It derives `0.8.0` from the two unreleased auth commits, a `feat` and a `fix`,
which is the number the manual audit reached. `langchain` is correctly left
alone.

`bootstrap-sha` is `d6abb78`, the commit that released core-py `0.7.0` and
langchain `0.4.0` on 2026-08-27. Without it release-please walks the whole
history on its first run. The manifest is seeded at those same two versions, so
the first release PR proposes only what is genuinely unreleased.

The `python` strategy also targets `setup.py`, `setup.cfg`, and
`src/<pkg>/__init__.py`. Only `pyproject.toml` exists here, and `__init__.py`
declares no `__version__`, so the other updaters are inert.

## Migration

Close PR #84. It bumps core-py to `0.8.0` by hand, which is the release this
system produces on its own, and landing both would burn `0.8.1` on an empty
diff.

Releasing a Python package is now: land a `feat:` or `fix:` commit touching it,
then merge the release PR. Do not hand-edit `version` in `pyproject.toml`.

`astropods-messaging`, in the messaging repo, still versions by hand. It has the
same gap and is not covered here.
