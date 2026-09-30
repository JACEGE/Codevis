# Changelog

All notable changes to CodeVis are documented here.

## Unreleased

- Security: the lock-guard and bash-guard PreToolUse hooks no longer answer
  `permissionDecision: "allow"` when they have nothing to block. That answer
  made Claude Code skip its permission prompt, so in a default setup (locking
  off, no agent id) every Bash command and Edit/Write ran without asking. The
  hooks now exit silently and leave the decision to the user's own rules.
  Re-run `codevis init` in existing projects to update the copied hooks.
- Explore shows whole nodes and relationships (`RETURN f, r, g`) as readable
  cells and puts them on the query graph; they appeared as `[object Object]`
  and were all reported as not representable.
- Settings disables the CodeVis database switch when no `codevis_db` workspace
  is configured (`/api/status` now reports `availableWorkspaces`); a refused
  switch names public workspace names instead of internal aliases.
- `update_epic` returns `status: "OK"` again; the epic's own status is now
  `epicStatus` (it used to overwrite the call status, e.g. `"backlog"`).
- `list_ideas` honours `status: "promoted"`; `delete_idea` reports an unknown id.
- `get_runtime_errors` returns `[]` instead of `null` for nodes without callers.
- The `execution_path_for_event` predefined query and the runtime profiler use
  the schema's `stepOrder`; the query failed to parse and steps were never written.
- `codevis init -y` defaults to the detected source folders (else the whole
  project) instead of a missing `./src`; re-init re-points the touch recorder
  of a copied project; an unparsable `.mcp.json` or settings file is named.
- The touch recorder keeps a task claim when `complete_task` was refused.
- `rollback_edit` refuses (`NEWER_EDITS`) when the file was edited again after
  the backup, instead of silently discarding those edits; `force: true`
  overrides.
- `insert_code` keeps the file's line endings, keeps a single final newline at
  `end_of_file`, and inserts `before_function` above its doc comment and
  decorators.
- `edit_code_patch`, `multi_file_edit` and `rewrite_function` follow a CRLF
  file's line endings; multi-line `oldString` values now match in CRLF files.
- `rename_function` and `move_function` update the graph again: they tried to
  change the node's `uid`, which is the primary key, so every call wrote the
  files and then failed with the graph still on the old name or file. The node
  is now updated in place and keeps its identity, locks and links.
- Python renames also rename call sites in the declaration's own file.
- `move_function` refuses (`SOURCE_CALLERS`) when functions left in the source
  file still call the moved one, unless `allowSourceCallers: true` is passed.
- Kept Spec write-back inside its project: a `sourceFile` that is absolute or
  escapes its root via `..` is no longer written by `PUT /api/spec/:specId`.
- Denied `approve_release`, `reject_release` and `recover_stale_edit` to a
  worker-role server without an agent id; they previously skipped the lead check.
- Made those lead tools act on exactly one node: a shared name now returns
  `AMBIGUOUS` with candidates, and `nodeId`/`file` select the node.
  `approve_release` now reports tasks it unblocked.
- Stale-edit recovery (MCP and dashboard sweep) now finds backups by their
  hashed agent/file identity, so crashed edits are actually restored and never
  from another agent's or file's backup.
- Graph read routes reject an unknown `db` with HTTP 400 instead of silently
  answering from the active database.
- Incremental builds re-attach code edges from files that are not reparsed
  (C imports B imports the changed A); `IMPORTS`/`RESOLVES_TO` from C into B
  were lost until the next full build.
- Unresolved imports keep distinct module names: `./missing`, `@scope/a` and
  quoted headers are no longer collapsed to `.`, `@scope` or their first folder.
- The Cypher translator escapes labels it turns into string literals and keeps
  backtick-quoted identifiers quoted (``(n:`Fo'o`)``, ``r.`order` ``).
- ROS tab: a valid diagram after a render error is shown again, and the SVG
  download follows the current diagram.
- Pathfinder reloads the call tree when the selection changed on another tab.
- The recovery-journal warning now says that builds stay in full mode until
  the missing code is restored or the journal is archived.
- Waves are a real barrier: backlog tasks of an inactive wave can no longer be
  claimed (`WAVE_INACTIVE`) or handed out by `get_next_task`. Unplanned
  backlog tasks stay claimable.
- `get_next_task` applies the `DEPENDS_ON` order with or without an epic and
  falls through to the next candidate when the top one is already claimed or
  conflicts, instead of returning that failure on every call.
- `complete_task`: a task's creator may complete it only while nobody else is
  assigned; the assignee, `user` and `lead-*` agents are unchanged.
- Moving a task to `review` releases its locks on every path (Kanban drag and
  `update_task_status` as well as `complete_task`).
- `POST /api/tasks` rejects malformed `targetNodes` with 400 and removes the
  new task if linking fails, so a retry no longer duplicates it.
- The Pathfinder returns routes it already found instead of `SEARCH_LIMIT`.
- Daemon election: several daemons started at once against a stale instance
  marker could each delete the others' fresh marker and all own the same
  database. Removing a stale marker is now serialised and re-checked.
- `codevis stop` reports success only once the daemon process has exited; it
  used to report success while the daemon was still draining queries and
  checkpointing. A shutting-down daemon answers new requests with 503.
- A project reached through a symlink or with different letter case is
  recognised as the same data directory instead of spawning a second daemon.
- File locks whose owner PID was reused by a younger process are reclaimed.
- MCP tool handlers resolve the project root through one helper
  (`CODEVIS_PROJECT_DIR`, else the nearest `codevis.config.cjs`) instead of
  falling back to the CodeVis package directory.
- `codevis watch` skips the same directories as the builder, so edits under
  `vendor/`, `coverage/` or test folders no longer start empty builds.
- Fixed races: overlapping MCP change polls, daemon port probes redirecting
  in-flight requests, and touch-journal cleanup dropping concurrent entries.
- Braindump and Spec workers pass their prompt after `--`, so text starting
  with `-` is no longer parsed as a CLI option.
- Dashboard: the class diagram no longer shows a stale SVG after a failed
  render, ROS filter toggles cannot be overwritten by older responses, and
  task, epic, idea and comment ids are URL-encoded.

## 1.0.0-beta.4 - 2026-09-12

- Prevented edits from being attributed to an arbitrary Task when one agent has
  multiple active Tasks; callers can now provide the intended `taskId`.
- Routed exposed MCP tools through the operation-history logger and included the
  MCP session and process identities in workspace metadata.
- Removed maintainer-specific wording from the public Idea tools and switched
  package/license attribution to the public `JACEGE` identity.
- Consolidated durable release caveats into the active guides and removed dated
  review and workstation-specific benchmark archives from the repository.

## 1.0.0-beta.3 - 2026-09-12

- Added planning-first project initialization, manual dashboard task creation,
  task edit modes, Epic workflows, and role-correct MCP tool surfaces.
- Made work-item, Knowledge, Markdown, Epic, wave, and graph synchronization
  atomic under retries and concurrent requests; preserved authored links through
  incremental-build failures.
- Hardened AST editing, cross-file rename/move operations, rollback and stale-edit
  recovery while preserving physical file identity and permissions.
- Bound async dashboard, Brain, Spec, terminal, and MCP work to the originating
  workspace and request lifetime so late results cannot overwrite newer state.
- Improved dashboard navigation, request feedback, responsive editors, Kanban
  readability, graph sizing/retention, layout pausing, and Back/Forward history.
- Expanded parser and relationship coverage for TypeScript class variants,
  C/C++ declarations, Kotlin, Go, Rust, ROS, and cross-file analysis; tightened
  analysis freshness and incomplete-scan reporting.
- Batched file graph synchronization through the single-writer daemon and added
  reproducible performance checkpoints.
- Strengthened release verification across Linux, Windows, and macOS, including
  dependency auditing, packaged fresh-install workflows, and workspace diagnostics.
- Shipped the active guide set through a version-matched in-app reader, an
  indexed historical archive, and refreshed documentation screenshots.
- Migrated the embedded terminal from deprecated `xterm` to `@xterm/xterm`.

## 1.0.0-beta.2

- Added `codevis init new` planning mode and `init code` for the first code build.
- Preserved custom configuration during mode switches and escaped generated paths.
- Fixed stale MCP work-mode configuration and project-root handling for builds.
- Made generated Claude hooks compatible with ESM projects and migrated registrations.
- Replaced global npm linking with exact-version local installation and explicit errors.
- Raised the supported Node minimum to 22.12, matching production dependencies.
- Fixed Task/Epic creation without an explicit author and protected invalid
  existing integration JSON from silent replacement during init.
- Expanded tarball smoke coverage to real npm-exec onboarding, ESM hooks,
  live MCP mode switches and work-item preservation through full builds.
- Fixed the terminal Kanban's aggregate ordering query and title-width calculation;
  CLI build, dashboard, watch, Kanban and stop now share project-root discovery.

- Fixed CI dependency installation on Ubuntu and Windows for Node 20 and 22.
- Hardened the Windows daemon-marker lifecycle test against slow process exit.
- Replaced and expanded dashboard documentation screenshots in light mode.
- Clarified that saving Brain entries is provider-independent while automatic
  graph conversion currently requires Claude Code CLI.

## 1.0.0-beta.1

Initial public beta.

- Embedded Ladybug graph database with project-local storage.
- Code graph construction, querying, impact analysis, and MCP tools.
- Dashboard with graph exploration, Kanban tasks, specifications, and diagrams.
- Agent task coordination and experimental node/subgraph locking.
- Conservative dead-code, recursion, complexity, and return-value analysis.
- Fresh-install smoke coverage for the packaged CLI and dashboard.

Beta note: APIs and graph schemas may still change before the stable 1.0 release.
