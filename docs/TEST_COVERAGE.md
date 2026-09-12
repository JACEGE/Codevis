# Regression coverage and remaining gaps

This records checked failure paths, not a claim that the repository is bug-free.
The number printed by `npm test` counts test cases; it is not a coverage percentage
or a release gate by itself.

## File editing and recovery

| Behavior | Evidence |
| --- | --- |
| Single and batch replacement preserve symlinks and update their physical target | `tests/edit-transaction.test.js`; both real-file symlink cases failed before the fix |
| Rewrite, patch, insert, rollback, move and rename preserve links | Real filesystem cases in their recovery/validation test files |
| Two aliases of one file are edited together | `tests/multi-file-conflict.test.js` merges sequential patches through two real symlinks |
| Moved and renamed modules still execute | `tests/move-file-recovery.test.js` and `tests/rename-file-recovery.test.js` launch Node on the resulting files, including symlinked importers |
| Runtime module extensions resolve to source files | `tests/move-imports.test.js` covers JS, TS, TSX, MTS, CTS and extensionless symlink imports |
| Publication preserves mode bits before replacing existing files | `tests/file-publication.test.js` covers six modes and failures while reading metadata, applying permissions and renaming |
| Unix executable/private modes survive real replacement | Native POSIX cases in `tests/edit-transaction.test.js`; skipped on Windows and requiring Linux/macOS CI |
| A changed or dangling link cannot redirect publication | `tests/file-publication.test.js` uses real file and directory links |
| Links cannot bypass allowed project directories | The production containment helper is exercised with project, external, configured-extra and installed-package paths |
| Partial writes, failed commits and newer external edits retain recoverable content | Single, multi-file, rename and move recovery tests inject failures at staging, scope checks, commit and compensation |
| Rollback verifies the backup's physical source file | `tests/rollback-edit.test.js`, including redirected links, mismatched files and legacy backups |
| Syntax trees are released on success and failure | `tests/read-function-lifetime.test.js` and allocation tracking in `tests/single-edit-recovery.test.js` |

## Dashboard request ordering

`tests/kanban-request-lifetime.test.js` covers overlapping idea/task updates,
mixed drag and bulk moves, partial epic failures, live replacements and workspace
switches. `tests/optimistic-updates.test.js` checks all completion orders and
success/failure combinations for three overlapping updates, plus React StrictMode.
The browser rollback smoke scripts exercise the built UI with intercepted writes.

## Checks still needed for a release

- Run the exact release commit through the full OS/Node matrix in
  `.github/workflows/ci.yml`. A local Windows pass does not establish POSIX mode
  preservation or native Linux/macOS database compatibility.
- Add static checking or equivalent lint coverage for frontend JavaScript and
  JSX. The root TypeScript check does not inspect those files; the frontend
  build and browser regressions cover different failure modes.
- Exercise forced process termination at each multi-file publication step, not
  only caught filesystem exceptions. The tests above do not establish one
  atomic transaction across all files after an operating-system/process crash.
- Check custom Windows ACLs, ownership, extended attributes and network-mounted
  filesystems if those environments are supported. The mode tests establish
  copying ordinary Unix permission bits, not all filesystem metadata.
- Expand end-to-end tests for a lost HTTP response after the server commits a
  write. Rejected mock requests do not prove recovery from that ambiguous outcome.
- Review and verify unrelated concurrent working-tree changes before including
  them in a release.

Add tests when a supported behavior or failure boundary lacks evidence. Do not
inflate the count by repeating equivalent assertions to reach a round number.
