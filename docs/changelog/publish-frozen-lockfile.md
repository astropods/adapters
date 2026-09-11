# Publish installs from the lockfile

## Summary

Both publish jobs ran `bun install`, which rewrites `bun.lock` whenever the
runner's bun is newer than the one that generated it. `lerna` refuses to version
or publish from a dirty tree, so the job died at the publish step:

```
lerna ERR! EUNCOMMIT Working tree has uncommitted changes, please commit or
lerna ERR! EUNCOMMIT  M bun.lock
```

`setup-bun@v2` is unpinned, so the version that broke it arrived on its own:
the run resolved bun 1.4.2 against a lockfile written by an older one.

## Design

Both jobs now run `bun install --frozen-lockfile`. It installs exactly what the
lockfile pins and fails if the lockfile cannot satisfy `package.json`, so a
genuine dependency drift is a loud error rather than a silent rewrite. A publish
job wanting to resolve something the lockfile did not already pin is the
problem, not the lockfile.

Reproduced and verified under the bun the failing run used, rather than the one
on a developer's machine, because the older bun leaves the tree clean and hides
it:

```bash
bun install                    # ' M bun.lock'  — the failure
bun install --frozen-lockfile  # exit 0, clean  — the fix
```

**Why the merge that shipped this looked fine.** A push to `main` gates on
`lerna changed` and returns early when no package directory changed, which is
every CI-only commit. The gate short-circuited before reaching the publish step,
so the first run to reach it was the `channel: next` dispatch, whose
`--force-publish` skips that gate by design.

**The stable channel was latently broken too.** `latest` runs `lerna version`,
which performs the same working-tree check, so it would have failed on the next
release for the same reason. Both jobs are fixed, not just the one that
surfaced it.

Pinning `bun-version` in `setup-bun` would also have prevented this, and is
worth doing for build reproducibility, but it is a separate change: it trades an
unannounced break for a version someone has to remember to bump.

## Migration

None. Re-run **Publish** with `channel: next` to prime the channel; the failed
run published nothing.
