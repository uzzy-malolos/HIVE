# Independent coding workspace forks

`forkCodingSession(repositoryRoot, sourceId, { signal?, sessionId? })` in
`src/coding/fork.ts` creates a new coding session, branch, and managed worktree
from a settled coding run. `sessionId` is optional and is useful to integrations;
existing session IDs, branches, and directories are never reused.

The source session lease stays held from loading and validation through the final
copy and persisted fork. A second lease reserves the new identity. An active,
archived, drifted, rebound, or missing source fails before copying. The source
worktree and its Git index are never staged, reset, committed, or rewritten.
Read-only Git inspections disable optional index writes without changing
repository configuration. Managed workspace fingerprints hash raw working-file
bytes, file modes, `HEAD`, and logical index entries and flags. They do not run
Git status, diff, clean filters, textconv, or fsmonitor. Reads stream through a
64 KiB buffer and check file/index identity and consistency before publication.

The new branch starts at the exact verified source `HEAD` with `--no-checkout`,
so creating a fork does not execute checkout hooks or smudge filters. HIVE writes
the verified snapshot directly. Git creation observes cancellation and a 30-second
timeout. A bounded in-memory
snapshot reproduces the complete regular Git index and Git-visible working files,
including different staged and unstaged contents, binary data, rename/delete
states, executable index modes, and regular untracked files. Byte hashes and file
modes are compared after copying; the source must still match its snapshot and
saved managed-worktree fingerprint. Ignored untracked files and `.hivemind`
runtime metadata are excluded. Dependency sharing follows the existing managed
worktree behavior after files and ignore rules are restored; only ignored
dependency directories are shared, and they are not copied.

Private storage and credential-file paths, symlinks, hard links, submodules,
unresolved entries, split indexes, sparse/skip-worktree indexes, and unsafe path
names are rejected explicitly. Example environment templates such as
`.env.example` are allowed; actual environment files are not. The snapshot is
limited to 64 MiB per file, 256 MiB total, and 100,000 Git-visible paths. This
operation does not infer or sanitize arbitrary secrets embedded in ordinary
source code: it preserves allowed source bytes exactly.

A workspace fork retains historical turn provenance while assigning its own session and
event identities. Current tasks, validation, review, integrations, and verdict
evidence start empty and blocked. A fresh follow-up turn revalidates the new
workspace. Historical acceptance of the source cannot authorize a commit of the
fork. Subsequent source and fork turns operate on independent files and branches.

A failed copy removes only the newly allocated, verified managed worktree and its
new branch through `WorktreeManager`. If cleanup cannot establish ownership or
finish, the error identifies the preserved recovery path. HIVE never deletes a
replacement directory: exact device/inode identity is checked before writes and
cleanup in addition to Git registration. A nonzero Git creation exit preserves
ambiguous partial or concurrently created state with explicit recovery paths.
HIVE never silently reuses a partial fork. Existing metadata-only
plan/session forks remain available through the same API, without requiring a
Git repository.

## Existing workspace adoption

Raw v2 fingerprints intentionally differ from the previous Git-diff based
fingerprints. A session saved by an older HIVE version must be inspected and
explicitly adopted before a new turn or fork; there is no automatic migration
of accepted evidence. The same operation can accept deliberate edits made
outside HIVE's guarded local commands:

```text
hive sessions adopt SESSION
hive sessions adopt SESSION --confirmed --fingerprint HASH_FROM_PREVIEW
```

The first command prints the canonical managed path, saved/current hashes and
confirmation command. Inspect its files before confirming. Confirmation holds
the session lease, verifies the exact preview hash again and updates session
metadata only. File bytes and the index stay unchanged. Previous validation
and review become stale, the verdict becomes `BLOCKED`, and a fresh turn must
revalidate the workspace. Archived, active, missing, rebound or incorrectly
registered worktrees cannot be adopted. A changed preview must be inspected
again. Existing sessions are never adopted as a side effect of an upgrade.

Verification lives in `tests/coding-worktree-fork.test.mjs`; these tests create
real temporary Git repositories and exercise independent follow-up turns,
source-index preservation, mixed index/working changes, private-file rejection,
busy leases, collisions, and injected copy failure cleanup.
`tests/coding-workspace-fingerprint.test.mjs` covers raw integrity and
non-execution of configured filters; `tests/cli-workspace-adopt.test.mjs` covers
explicit adoption, stale previews and lease/ownership rejection.
