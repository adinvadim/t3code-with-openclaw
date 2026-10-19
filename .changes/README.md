# Release-note fragments

Add one uniquely named `.changes/<id>.md` per user-visible change. Internal and
test-only changes need none. Use English, one Markdown bullet per line:

```md
## Changes

- Explain the change from the user's perspective.
```

The release workflow adds these notes before GitHub's existing generated notes.
It pins the target commit and previous tag in the same channel. Collection reads
Git history, so stable and nightly independently include changes in their own
ranges even when stable cleanup already removed a file. Reusing fragment IDs is
unsupported; create a new file for a new change.

Stable finalization commits the assembled section to `CHANGELOG.md` and consumes
only included files whose contents still match the release snapshot. Nightly
keeps the native lifecycle: no bookkeeping commit or version bump. Its next range
starts at the previous nightly tag, so unchanged fragments are not repeated.
New and modified files on main remain pending. Cleanup retains private recovery
copies under `.changes/.recovery/` for an already-open writer.

The workflow uploads the exact notes snapshot before publication. Retrying stable
finalization uses that artifact, appends no duplicate section and retries only
matching cleanup. No test tag or workflow dispatch is needed for validation;
both publish real packages and deployments.
