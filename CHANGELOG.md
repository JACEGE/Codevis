# Changelog

All notable changes to CodeVis are documented here.

## Unreleased

No changes yet.

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
