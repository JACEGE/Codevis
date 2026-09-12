# User workflow

## Initialise

From the project root:

```bash
npx codevis init
npx codevis info
```

For a greenfield project with no source code yet, use `npx codevis init new`.
It records `workMode: "planning"`, leaves `sourceDir` empty, disables automatic
updates, and makes CLI/MCP build requests return without starting the graph
builder. Kanban, Tasks, Epics, Knowledge and Specs remain available.

After code has been written, switch explicitly:

```bash
npx codevis init code                 # detects conventional source folders
# or: npx codevis init code --source ./src,./packages
npx codevis build full
```

Restart an already running dashboard so it loads the new configuration. MCP
graph-update requests reload the work mode automatically. Existing Tasks,
Knowledge and Specs remain in the database when source code is first parsed.

`init code` keeps configured source directories when present, otherwise it
detects `src`, `app`, `lib`, `server`, `client`, `packages`, or `tools`. If none
exists, it stops with an actionable error instead of scanning the whole project.

`init` creates the configuration, `.codevis/`, MCP registration, Claude hooks
and agent templates. It detects common source folders. Choose `.`/`all` to scan
the entire repository (standard dependency/build directories remain excluded),
or decline the fallback to create a planning-only project with `sourceDir: []`.
Kanban, Knowledge and Spec still work without source; planning mode skips code
builds and watchers. Code mode with empty/missing sources reports an error.

Running `codevis init` again detects the saved configuration and offers to keep
it unchanged, adjust it interactively, or recreate it from defaults. Adjust mode
uses the current source directories, exclude globs, Markdown Knowledge paths,
automatic-update setting, experimental locking setting, and ROS extractor as
defaults. Before changing the
configuration, CodeVis saves `codevis.config.cjs.bak`; it never resets the graph
database. Unattended changes can use `--source`, `--exclude`, `--knowledge`,
`--watch`/`--no-watch`, `--locking`/`--no-locking`, and `--ros`/`--no-ros`.
`--recreate` starts from the
generated defaults instead of the saved wizard values.

Mode switches and adjustments preserve custom config fields, executable
expressions and comments through a managed override block at the end of the
file. Repeated adjustments replace that block. Only `--recreate` (or the
wizard's Recreate choice) discards custom configuration. Init installs its exact
CodeVis version as a local dev dependency when missing, and fails if installation
fails. Node 22.12 or newer is required. Generated hooks also work in ESM projects.

## The two databases

- `project_db` contains project code and that project's Tasks, Epics, Knowledge
  and Specs. It is the default.
- `codevis_db` is the optional protected CodeVis self-graph. Unlock it in
  Settings using the configured `CODEVIS_META_UNLOCK_SECRET`.

Work items belong beside the code they describe. This keeps `AFFECTS`,
`FULFILLED_BY`, `APPLIES_TO` and Spec-to-code edges inside one database.

Each successful build records the project root and resolved source directories
beside that database. A later build stops before writing if those sources no
longer match, instead of silently mixing another project's graph and work items.
Older databases have no marker; `codevis info` and Settings call them unverified
until their next successful build.
Before rebuilding an unverified database, confirm that the configured sources
belong to its existing graph. If no sources are configured, identify that project
first; rebuilding an unrelated checkout cannot verify the stored graph.

New installations store both databases in `<project>/.codevis`. A historical
CodeVis checkout may still select `<project>/data` when it contains
`ladybug-target` or `ladybug-meta`; `codevis info` reports that legacy mode unless
`CODEVIS_DATA_DIR` explicitly selects the location. Keeping it is supported.
To migrate, stop attached MCP clients and watchers so they cannot restart the daemon,
then run `npx codevis stop`. Move the `ladybug-*` database and recovery files and the
`.workspace-*.json` markers from `data/` to `.codevis/`. Alternatively set
`CODEVIS_DATA_DIR` explicitly. Never move an open Ladybug database.

## Build and open

```bash
npx codevis build
npx codevis dashboard --db project_db
```

Use `build full` after parser/schema changes and the incremental default after
ordinary edits. `codevis info` shows daemon, dashboard, source paths, stale
builds and quarantined WAL, checkpoint and shadow recovery files. A healthy
fallback daemon port published in the pidfile needs no manual port change.
Both normal and `--json` info output return a nonzero exit status for hard errors.

Full and incremental builds save affected authored code relationships to a recovery journal beside the
database before deleting derived nodes. If a build fails or its process stops,
the next build automatically runs in full mode and restores those relationships.
Do not delete the `*.rebuild-recovery.json` file while recovery is pending.
Unresolved targets keep the journal and produce a warning; restore missing code
or review the saved relationships before archiving a journal for intentionally
removed targets. Recovery requires the original source configuration.

### Repository Markdown Knowledge

Configure one or more documentation roots:

```js
knowledge: { paths: ["./docs/knowledge"] }
```

Every Markdown document needs a stable frontmatter `id`. `appliesTo` accepts a
repository-relative file or `path#symbol`, `tasks` accepts task IDs, and wiki
links create Knowledge-to-Knowledge references:

```md
---
id: clearance-gradient
title: Clearance Gradient Convention
category: convention
tags: [geometry, safety]
appliesTo:
  - src/geometry.py
  - src/obs.py#build_observation
tasks:
  - task-123
---

# Clearance Gradient Convention

See [[kinematics-convention]].
```

Markdown is authoritative for document content and outgoing links. Full and
incremental builds synchronize it; `codevis watch` also watches the configured
Knowledge paths. Missing code, task, and wiki-link targets are reported as
`[knowledge] unresolved` instead of being silently ignored.

The Inspector displays the source path for Markdown Knowledge and does not
offer database-only edits that would disappear on the next sync. Edit that
file instead. Database-authored Knowledge remains editable in the Inspector.
Wiki links resolve exact document IDs first; a title is accepted only when
unique. Repeated syncs preserve existing node identities and incoming links,
including documents imported by older versions with generated node IDs.

Markdown replacement is one database transaction: a failed write preserves the
previous documents and links. Missing or unreadable configured roots stop the
sync before any writes; an existing empty directory can intentionally remove its
documents. Overlapping roots import each physical file once. After upgrading to
atomic Markdown synchronization, stop and restart CodeVis and its MCP clients;
an older daemon reports that it must be restarted before accepting the new sync.

To keep the graph current without relying on an agent, run `npx codevis watch`.
It watches only configured source paths and supported file types, groups rapid
saves into one incremental build, and queues one follow-up update when files
change during a build. Set `autoUpdate.enabled: true` in `codevis.config.cjs` to
start the watcher with `codevis dashboard`; `--watch` and `--no-watch` override
that setting for one dashboard run.

The watcher does not rebuild the whole graph for a rename. Incremental builds
detect deleted paths before removing their old nodes, use the old incoming edges
to invalidate direct importers/callers, and parse the new/changed files plus
those dependents. A uniquely matching Function body/parameter fingerprint
carries locks and authored `AFFECTS`, `TOUCHED` and `APPLIES_TO` links across a
Function or file rename. Ambiguous fingerprints are never guessed; the build
logs a failed restore instead. Full builds remain appropriate after parser,
schema or `sourceDir` changes.

## Dashboard workflow

- **Kanban:** create, edit and move Tasks/Epics; inspect locks.
- **Context:** search/sort Knowledge, Epics and Tasks, then show or inspect them.
- **Inspector:** source, properties and all relationships of the selected node;
  start an A→Z route and review proposed semantic annotations here.
- **Pathfinder:** walk callers/callees or choose a destination and find a bounded
  shortest route using `CALLS`, conditional calls and optionally `RENDERS`.
- **Explore:** predefined scans and read-only Cypher.
- **Spec / Diagrams:** import PlantUML/WSD and connect design nodes to code.
- **Settings:** database, graph detail, node budget, source paths and layout.

Diagram replacement is a single database transaction: a failed import keeps the
previous diagram. Unchanged participants retain manual code bindings and links
to emitted Tasks. Changing diagram kind requires a new spec ID. Switching
workspaces clears the Spec editor, and late responses cannot reopen its previous
workspace's diagram. Save or copy a draft before switching workspaces.

After upgrading to transactional spec imports, stop CodeVis and restart the
dashboard and MCP clients. Older running daemons reject the new import endpoint
instead of falling back to a nontransactional replacement.

Multi-file edits validate every staged file while holding the complete file-lock
set. An intervening edit returns `CONFLICT` before any staged file is committed;
read the current files and retry. These locks coordinate CodeVis writers and do
not prevent an external editor from saving files.

File locks use the canonical file path, so directory aliases share a lock and
long paths do not become oversized lock filenames. After upgrading the lock
protocol, stop and restart all CodeVis editing clients together. Recovery keeps
small `.stale-*` directories to prevent a delayed process from taking a new
writer's lock; retain them while clients are running. They are local runtime
state, not source files.

File edits resolve symbolic links before taking file locks and preserve the links
when publishing changes to their targets. Link targets must be within the project
or an explicitly configured source directory. Dangling links and paths redirected
during publication are rejected. Existing files retain ordinary permission bits,
including Unix executable/private modes.

New backup tokens identify their physical source file within the project. `rollback_edit`
rejects a token for a different file, including files with the same basename in
different directories. Legacy tokens without file identity are retained and
return `UNBOUND_BACKUP` with the backup path for manual inspection and restoration.

`rollback_edit` replaces the file atomically and keeps its backup until graph
synchronization succeeds. `GRAPH_SYNC_FAILED` with `fileRestored: true` means
the file was restored but the graph still needs repair; inspect the file and
rebuild the graph before continuing. The returned backup token remains available.

`move_function` holds source, destination and discovered importer file locks
together, prepares all changes, and writes the destination before removing the source declaration.
Write failures roll back committed file changes and return backup tokens for
both files. `rolledBack: false` means manual recovery is still needed; inspect
`rollbackErrors` and preserve the backups. A backup with `existed: false`
represents a previously absent target, not an existing empty file.
If a later graph operation fails, `filesCommitted: true` distinguishes an
already completed file move from an unchanged filesystem: inspect the files
and resync the graph rather than blindly retrying the move. This is not an
atomic transaction spanning files and the database.

Named and default JavaScript/TypeScript imports are updated by syntax, retaining aliases,
unmoved bindings and explicit runtime extensions. Namespace imports, affected re-exports and moves
into a file that already imports the moved binding are rejected before writing;
resolve those bindings explicitly first. Import discovery still depends on the
static graph, so review the result and run the project's checks after a move.
Split multi-declarator statements before moving an individual function; the
tool rejects them instead of moving additional bindings unintentionally. A
default export cannot be moved into a file that already has a default export.

`rename_function` prepares the declaration and discovered callers before writing
any of them. It locks the complete prepared set and rechecks snapshots; an
intervening save returns `CONFLICT` without overwriting it. Parse failures leave
the declaration unchanged. Commit failures roll back written files and return
backup tokens plus any rollback errors. Later graph failures report whether
the file changes were already committed.
For JavaScript/TypeScript, rename uses symbol resolution across these file
snapshots: same-file calls, template expressions and shorthand properties are
updated while unrelated local bindings and property names stay unchanged.
Conflicting destination names are rejected. Other languages still use the
conservative tree-sitter path; this is not a whole-project language-server scan.

Click a graph node to select it. Click the selected node again for the local
actions: details, direct relations or two-hop context.

The Filter slider and Settings field share one node budget. The slider supports
single-node steps; its right endpoint and **All** remove the budget, including
for future graph growth. Empty graphs report zero and disable the slider.
**Select all / none** changes only the types listed in the current filter;
visibility choices for other detail levels are preserved.
If a graph-scope update fails or times out, the dashboard shows an error and
**Retry graph update**, while retaining the last loaded graph. A failed change
is not labelled as applied. Late status responses from an earlier workspace or
detail level cannot replace a newer selection.

Agents can call `find_path` with exact `elementId` strings for the same route
search without constructing raw Cypher. They can also call
`propose_annotation` with a tag, evidence, confidence and relevance weight.
Annotations start as `proposed`; accepting or rejecting them in Inspector does
not change code-derived relationships or authoritative Markdown Knowledge.

Tags retain their review status through rebuilds and uniquely recognized
Function renames or moves between files. If a target cannot be resolved uniquely,
`list_annotations` still returns the tag with `targetMissing: true` and its old
target ID; CodeVis does not guess a new target. Task/Knowledge links attached
directly to File nodes also survive incremental reparsing of that file.

## Agent workflow

Restart the MCP client after `init`, verify the CodeVis server is connected,
then follow this sequence:

1. call `get_workspace_identity` and confirm that its project root is the
   repository you intend to change;
2. inspect graph and relevant Knowledge;
3. create or claim a Task;
4. edit through scoped tools;
5. run tests and complete the Task.

Task synchronization includes affected code, File nodes, recorded `TOUCHED`
relationships, and explicit file scopes. `sync_task` reports `SYNC_FAILED` and
lists failed files instead of reporting success after a missing file or parse
failure. If `complete_task` returns that status with `newStatus: "review"`, the
task transition and lock release already completed; repair the files and retry
with `sync_task`.

MCP file synchronization sends one prepared file snapshot to the daemon. Its
function metadata, outgoing call changes, task links and freshness marker are
committed in one transaction. Failed writes leave the previous file graph
intact; incoming calls and authored links to retained functions survive.
After upgrading, restart CodeVis and its MCP clients to load the new endpoint.
An older daemon rejects the request with a restart instruction.
This optimization retains immediate edit synchronization. Task-only checkpoint
publication and private draft graphs are not enabled by this change.

Wave planning remains experimental. Previewing a plan leaves stored dependencies
unchanged; `commit: true` persists it. Cyclic dependencies return `CYCLE` before
scheduling, and long dependency chains retain their full execution order.
Completing an unknown wave returns `NOT_FOUND`. A failed wave sync keeps the next
wave pending; repair the failed files and retry `complete_wave`.

Multi-agent locking is experimental and disabled by default. Tasks always keep
their `AFFECTS` links, while disabled locking creates no reservations and edit
tools require none. From the project root, enable or disable it with:

```bash
npx codevis init --locking -y
npx codevis init --no-locking -y
```

These commands preserve the existing configuration and update the locking
setting. Alternatively, set this field in `codevis.config.cjs` (`false` to disable):

```js
locking: { enabled: true }
```

Then restart the dashboard and MCP client. `CODEVIS_LOCKING=on` or `off`
overrides the config for one process. When enabled, plan/activate the smallest
necessary lock scope before editing and release it when finished.

Every MCP response also carries workspace provenance in `_meta`. This makes a
stale MCP process detectable when multiple CodeVis projects are open. If the
identity is wrong, restart the MCP client from the intended project; use
`npx codevis info` to compare the CLI, bridge and data directories.

Dead-code results and impact radius are candidates, not proofs. Dynamic dispatch,
reflection, generated code and runtime-only entry points may be absent.

## Task edit scopes

With locking enabled, keep the planned edit scope separate from impact:
`AFFECTS` describes affected code; `RESERVES` describes files the task intends
to edit. File-backed nodes always claim their entire file, even at depth zero.
Plans can overlap without blocking each other. Only an active claim owns a file.

1. Create a task with `files: ["src/service.ts", "src/new-helper.ts"]`, or call
   `plan_task_scope({ taskId, agentId, files, db: "project_db" })` before claiming.
   Use exact project-relative paths, not directories or globs. New files need
   not exist. Explicit files take precedence over inferred impact when creating
   a task; otherwise its affected nodes seed the scope.
2. Call `claim_task({ taskId, agentId, db: "project_db" })`. The complete scope
   and task assignment succeed together or remain unchanged. Use `get_task`
   to inspect `editScope`, separately from `affectedNodes`.
3. Before editing another file, call
   `expand_task_scope({ taskId, agentId, files: ["src/extra.ts"], db: "project_db" })`.
   This revalidates the existing scope and acquires the addition atomically.
4. On `LOCK_CONFLICT` / `COORDINATE_SCOPE`, report the owning task and agent.
   Do not loop or wait while holding competing claims. Neither task is
   automatically preempted. The coordinator checkpoints unfinished work and
   explicitly returns one task to `todo` using `update_task_status`, releasing
   its claims, before the other task retries. A `blocked` status alone does
   not release claims. Resume by claiming again.
5. Renew with `extend_locks` before the five-minute lease expires.
   `complete_task` releases the task's claims and moves it to review.

Durable file scopes survive code-node rebuilds and protect newly parsed nodes
through the edit guard. MCP editing tools check ownership before writing; the
optional raw-write hook permits creation of a new, owned file. This is
cooperative coordination, not an OS sandbox: arbitrary shell writes and
unhooked editors can bypass it. Keep all participating clients on the same
locking configuration and restart older daemons/clients after upgrading.

### Selecting an edit mode

Open a Task card on the Kanban board and use **Edit mode**. Open an Epic and
use **Default edit mode** for its tasks. `Inherit` uses the Epic's default,
falling back to Flexible. A task's effective mode is fixed when it is claimed;
changing an Epic default does not change active work. Checkpoint and return
an active task to To Do before changing its mode.

- **Open:** MCP edits may touch free files without a planned scope. Other
  tasks' live file claims still block the edit. Pass `taskId` to editing tools.
- **Strict:** edit only the claimed planned files, including planned new files.
  Return the task to To Do to replan; active scope expansion is rejected.
- **Flexible:** edit the claimed scope and explicitly expand into free files.
  Expansion conflicts return immediately without partial acquisition.

The project locking switch remains the master control; disabled means these
modes are not enforced. Raw-write hooks remain more conservative and require
explicit file claims; use MCP edit tools for Open mode. These controls are
cooperative, not an OS security boundary.

### Creating work manually

Use **New Task** or **New Epic** at the top of the Kanban board. The dialog
shows the destination database and creates the item in Backlog. Fill in its
title, description, work instructions and priority; validation failures keep
the draft open. Details open after creation so you can choose the edit mode.
Empty epics remain visible above the columns; drag a task onto one to add it.

Graph islands are separate from dead-code candidates; neither determines
write ownership.

## Stop cleanly

```bash
npx codevis stop
```

This stops the dashboard first and checkpoints the embedded databases. Avoid
killing the daemon directly; a hard kill can leave a WAL that must be
quarantined on the next start.
