# Change Intelligence: discovery and implementation contract

## Repository discovery (2026-09-20)

The checkout was clean before discovery. README.md, AGENTS.md, user/context/release guides, configuration, schema, builder, daemon/driver, MCP dispatch and handlers, task context, Knowledge synchronization, templates/hooks, frontend navigation/hooks, query catalogue and test infrastructure were inspected. The repository MCP get_workspace_identity returned this project root and fingerprint a5a27c944d76e839. Read-only self-graph queries confirmed bridge dependencies on spec, impact, query and database modules. That graph has no workspace provenance marker and cannot establish current source truth; source inspection takes precedence. The project_db has no configured source roots. Preserve existing databases and recovery files; use isolated databases for implementation verification.

### Existing integration points

| Area | Current implementation and reuse |
| --- | --- |
| Graph | scripts/graph_builder.js parses tree-sitter facts; full/incremental deletion preserves an explicit authored-label list. backupLocksAndAffects, resolveRebuiltTargetUid and lib/rebuild-journal.cjs recover authored links using exact identity, then unique natural keys/fingerprints. Extend those hooks, including failure recovery. |
| Storage | scripts/ladybug_schema.cjs uses ONE CodeNode table with a semantic label column and one relationship table per type. server/ladybug-translate.cjs translates Cypher; elementId is a string UID. Schema reconciliation is additive. |
| Transactions | server/ladybug-daemon.cjs owns the database and serializes work with a per-database mutex. LocalSession.withTransaction encloses whole operations. Task claims and Spec imports already use dedicated daemon endpoints through ladybug-driver.cjs. Reuse this pattern for Change writes. |
| Tasks / Epics | Existing Task fields include taskId, title, description, workInstructions, status, assignedTo, wave and comments. Epic uses the same work-item fields and FULFILLED_BY membership; displayed status is derived from member Tasks. DEPENDS_ON orders Tasks, AFFECTS identifies impact, RESERVES identifies optional edit scope, TOUCHED records edits. Planning links existing Tasks rather than duplicating lifecycle/claims. |
| Knowledge | Knowledge holds name/content/category and APPLIES_TO links. DERIVES records provenance. Architecture decisions can be Knowledge with category decision; a second ADR subsystem is unnecessary. |
| Markdown | scripts/knowledge_markdown.cjs imports stable frontmatter IDs, tags, appliesTo, tasks and wiki references. Markdown owns content/outgoing links; incoming graph links survive sync. Builds/watch synchronize configured knowledge.paths. Change artifacts require a separate structured format because this importer is not a workflow state machine. |
| MCP | ToolModule definitions and handlers live under tools/handlers; tools/mcp_server.ts assembles them. graph.ts supplies driver selection and response helpers. CODEVIS_ROLE filters both advertised and callable handlers. Workers have an explicit allowlist; Lead excludes several legacy editing tools. These are cooperative tool permissions, not a sandbox for arbitrary shell edits. |
| Work UI | App.jsx orchestrates grouped navigation; AppTabBar/WorkspaceHeader and AppChrome provide shared shells. Work currently includes Kanban, Brain and Spec. InspectorSidebar and TaskDetailDialog provide selection/details. showContextSubgraph loads exact nodes outside the visible budget. useRequestLifetime prevents stale workspace responses. |
| Graph UI | No React Flow dependency or components exist. Source visualization uses react-force-graph-2d/3d, diagram views use Mermaid. Add React Flow only for the dedicated expandable Change graph; reuse navigation, CSS variables, HTTP helpers and source navigation. Keep its pure projection/layout outside App.jsx. |
| Brain / Spec | Brain persists BraindumpSession/Idea and optionally converts ideas via Claude CLI. Specs persist diagram labels, reconcile planned diagrams with source via REALIZED_BY and can emit existing Tasks. Keep these entry points; future target architecture can reference Specs instead of inventing copies of source nodes. |
| Freshness | scripts/impact/graph_freshness.cjs compares configured source inventory, source mtimes, content hashes and parseStatus. It distinguishes current, stale and unknown, including missing/deleted files and inaccessible roots. Build timestamps alone are insufficient. |
| Impact | scripts/impact/impact_reader.cjs and impact_service.cjs provide bounded callers/dependencies/tests/Knowledge/Tasks/Specs with confidence and truncation. scripts/diff provides commit graph snapshots and structural diffs. Reuse them; graph absence is not proof of runtime absence. |
| Quality | codevis quality uses analysis_quality_report/gate: internal call resolution, parse errors, capabilities, freshness and per-language JSON baselines. It already supports baseline regression thresholds. Extend with Change traceability and impact evidence instead of replacing it. |
| Queries | predefined-queries.cjs is shared by Explore/MCP: recursion, duplicate signatures/call neighborhoods, classified no-caller candidates, refactoring score, approximate cyclomatic complexity, long functions, large classes, circular imports, dependencies, state/effect scans, API/runtime queries. Metrics are evidence, not correctness proofs. |
| Tests | scripts/run-tests.mjs discovers top-level node:test files and runs serially. Tests include pure models, real temporary Ladybug databases (helpers/ladybug-session.cjs), MCP stdio/daemon integration, builder lifecycle, frontend request lifetime and security regressions. npm typecheck, build:frontend and smoke are existing gates. |
| Configuration | codevis.config.cjs is versioned; server/codevis-paths.cjs resolves project/data roots and public workspace aliases. init preserves custom fields via overrides. New workflow configuration belongs here, with workspace-specific overrides, not machine paths or runtime data. |

Existing semantic labels include File, Function, Class, Component, State, Effect, Endpoint, Module, Variable, ControlFlow, ASTNode, import/export symbols, DOM/runtime nodes, Task, Epic, TaskScope, Knowledge, Annotation, Idea, BraindumpSession, and Spec diagram/participant/message/class/member/use-case/activity labels. Core relationships include CONTAINS variants, DECLARES, CALLS/conditional calls, IMPORTS/IMPORTS_SYMBOL/EXPORTS_SYMBOL, INHERITS, INSTANTIATES, USES_TYPE, RENDERS, PASSES_PROP/CALLBACK, READS_STATE/WRITES_STATE, HAS_EFFECT/WATCHES, AFFECTS/RESERVES/TOUCHED, FULFILLED_BY/DEPENDS_ON, APPLIES_TO/REFERENCES/DERIVES, ANNOTATES and REALIZED_BY. ROS/runtime edges remain separate domain capabilities.

## Intended V1 contract

A Change contains ordered Phase nodes (requirements, analysis, architecture, planning, development, quality, review), individually addressable Requirement, AcceptanceCriterion and TestCase nodes. Phase metadata records role separately from agent, timestamps, revision and gate evidence. TestCase means validation intent; existing File/Function nodes remain its executable implementations and validated production source. Reuse Knowledge for decisions and existing Tasks/Epics for execution. Run history is stored with phase submissions initially; introduce AgentRun only if independently queryable scheduling needs it.

New edges: HAS_PHASE, HAS_REQUIREMENT, HAS_CRITERION, VALIDATED_BY, VALIDATES, IMPLEMENTED_BY, IMPLEMENTS, IMPACTS. Existing DERIVES links phase outputs (TestCases, decisions, Tasks); REFERENCES attaches related existing entities. Every edge serves context compilation, coverage/gates, navigation or provenance. Workflow edges never widen edit locks.

### Authority and recovery

- Source and Git remain authoritative for implementation and actual changes.
- Versioned workflow state is authoritative for Change identity, phase state, requirements, criteria, test intentions, submitted evidence and link intentions. Default root: docs/codevis; configurable workflow.artifactDir. Use state.json (readable structured equivalent to YAML; no extra YAML parser).
- Markdown phase artifacts own detailed reasoning. Each submission records its artifact path and digest. Editing an approved artifact invalidates its gate until resubmission. History uses immutable revision files, avoiding silent overwrites of human edits.
- Ladybug is the operational query projection of this versioned state plus existing authored work/source entities. It is not an independently editable second copy of workflow state. Task status and Knowledge content remain owned by their existing systems.
- Daemon operations serialize changes, compare expected revisions, atomically replace state, then transactionally project nodes/edges. Filesystem and Ladybug are not a distributed transaction: if projection fails, report that the state was saved and require resume to replay it. Never claim the phase completed in the graph on partial failure. Reads/resume reproject canonical state. Keep unresolved external references visible.
- Namespace artifacts by public workspace to avoid project/self-graph collisions. Stable source selectors retain label, file/path, owner and name in addition to elementId; resolve uniquely after rebuild, never guess ambiguous targets.

### Progressive context and gates

Expose a small MCP API: change_read (list, current state, phase context, task context, artifact, reverse lookup) and change_write (create, submit, complete, resume). Workers may read task context; workflow mutation belongs to Lead/full mode. Only current-phase instructions are returned, along with permitted actions, outputs and deterministic completion checks. Instructions guide an agent; they do not restrict arbitrary shell commands.

Requirements require substantive problem/scope/non-goals/constraints and acceptance criteria, explicit disposition of blocking questions, and behavioral test intent. Analysis requires facts/approximations/inferences, impact predictions, freshness evidence, risks and additional regression intent with reasons. Architecture captures simplicity, interfaces, compatibility and alternatives as reasoned judgment. Planning links Tasks with requirement/TestCase coverage. Development maps intended tests to actual test symbols. Quality checks evidence and traceability, current graph, tests and impact drift. Review records an explicit disposition of findings. Deterministic checks verify structure, references and evidence freshness; semantic approval is recorded judgment, never advertised as mathematically verified.

Task context follows explicit IMPLEMENTS links to requirements/criteria/tests, AFFECTS and VALIDATES to source, plus bounded impact and APPLIES_TO Knowledge. Include selection reasons and truncation; do not attach every artifact. Predicted/actual impact compares a recorded Git base and source selectors, shows additions/deletions and scope explanations. Policies support info/warning/error; baseline deltas distinguish existing, unchanged, improved, new and worsened findings. No universal fatal LOC threshold.

### Work / Changes UI

Use the existing full-screen Work shell with a catalogue and React Flow canvas. Default nodes are Change and seven phases. Expand phases to requirements/criteria/test intentions, decisions, Tasks, source and quality evidence. Click opens a persistent inspector with artifact text, role/agent history and explicit related nodes; hover is supplemental. Focus a requirement/test to inspect traceability, filter source/complete nodes, and navigate exact source IDs through the existing graph callback. Reverse lookup is an API contract even before source Inspector displays it. Display intended tests separately from executable tests and recorded execution results; missing execution is unknown, never passing.

Target graph/scaffolding and worker scheduling remain optional extensions. Planned entities must have a separate identity namespace and reference approved Specs; they must not masquerade as parsed source facts. Existing waves and claims remain the worker strategy.

## Milestones and acceptance

0. Discovery: document verified architecture, authority, integration boundaries and acceptance checks before production changes.
1. Persistent model: schema/projection, versioned artifacts, revision conflicts/recovery and rebuild survival. Tests exercise real Ladybug, temporary artifact roots, cross-workspace isolation, invalid references and failed projection recovery.
2. Progressive protocol: requirements/test intent before implementation, phase submissions/gates, persisted resume, existing Task/Knowledge links and focused context. Test rejection without advancement, stale revisions/artifacts, worker permissions and the full workflow through MCP.
3. Change quality: traceability, recorded test evidence, Git predicted/actual scope, baseline/delta and policy levels exposed through CLI/shared queries. Test missing/stale evidence, new versus legacy findings and unexpected impact disposition.
4. Interactive Work graph: React Flow expansion/focus/inspector/filters, task/source navigation and evidence branches. Verify pure graph behavior, workspace lifetime, build, running dashboard and regression/smoke checks.

Each milestone requires relevant new/regression tests, static/quality checks, diff inspection and a local commit. No push. Optional target graph and scaffolding are deferred; the implemented/remaining scope must be recorded honestly.

## Verification log

- Discovery baseline: all 1,203 existing tests passed. Local commit ca77404.
- Persistence milestone: 31 focused real-database/schema/rebuild/recovery tests and TypeScript checks passed. Versioned state survives projection failure, rejects revision/hash overwrite and unsafe artifact paths; real full/incremental rebuilds preserve Change/test/source relationships. The existing self-graph quality command was run and reports stale graph (zero stored parser errors), so it cannot certify current-source quality. Its unverified legacy database was not rebuilt.

## Using the protocol

Create with `change_write({operation:"create",slug:"rotation",title:"Refresh token rotation",description:"Reject previously used refresh tokens."})`. Read `change_read({slug:"rotation",view:"context"})` for the current contract. Submit `markdown`, structured `data`, `entities` and `links` with `expectedRevision`; use the returned revision for `complete`. `GATE_BLOCKED` saves the findings without advancing. `resume` repairs the graph projection from state. `reopen` requires a reason and invalidates downstream approval/check evidence. Workers have read-only workflow access; this does not replace existing task permissions.

Entity IDs such as REQ-1, AC-1 and TC-1 are local to a Change. Link endpoints are these IDs or `{nodeId: "exact elementId"}` for existing Tasks, Knowledge, Specs or source. Requirements/criteria and behavioral tests are authored during Requirements. Analysis can add test intent with reasons. Planning links existing Tasks via IMPLEMENTS; Development links TestCases via IMPLEMENTED_BY and VALIDATES. Explicitly configure test directories in sourceDir so executable tests are indexed.

Configure `workflow.artifactDir`, `workflow.checks: [{name,command,args,timeoutMs}]` and `workflow.policies` in codevis.config.cjs (workspace overrides supported). From the project root run `codevis quality --change rotation --run-checks --json`. Checks execute outside the daemon mutex; recording fails if the source or Change revision changes meanwhile. A subsequent source/config edit invalidates evidence. Process exit status is recorded evidence, not proof of assertions or per-case coverage. Individual TestCase execution stays unknown without an attributed runner result.

Quality policies accept info/warning/error. `metrics` maps fileLOC, functionLOC, complexity and dependencies to `{limit,level}`. Existing unchanged/improved debt is informational; new/worsened debt uses the configured level. `unexpectedImpact` and `unvalidatedSource` default to warning. Quality submissions can provide `impactExplanations: [{nodeId or file, reason, acceptedBy}]` to disposition individual unexpected changes. Snapshots retain the Git base, dirty baseline file hashes and source-range hashes, including deleted symbols and untracked files. Long-cycle absence and static reachability are not proven.

Milestones 2 and 3 are integrated for verification: completing Quality/Review depends on the actual evidence collector, so the protocol is committed only with that collector working. Tests cover the full Requirements-to-Done path, restart/resume and Worker mutation denial.

- Protocol/quality verification: 47 focused tests passed, including actual MCP role/restart checks, a full workflow through Done, source changes invalidating check evidence, delta classification, and existing analysis/query tests. TypeScript checks passed. Source Analysis captures the baseline before development; checks run outside the daemon mutex.

The Work → Changes view uses [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes) inside the existing dashboard shell. It starts with eight nodes, expands explicit relationships, supports requirement/TestCase focus and source/incomplete filters, and opens exact source/Task identities in the existing Inspector. Quality expands into checks, traceability, impact and findings. Agent identity, role, gate state and submission revisions remain inspectable.

MCP reads default to bounded phase context; write responses return current instructions, state summary and gate findings. Full graph/baseline state is opt-in with `view: "graph"`. This avoids sending the baseline symbol inventory to the agent after every phase.

## V1 boundaries and verification

Workflow writes are local; CodeVis does not commit or push artifacts automatically. Commit docs/codevis alongside the corresponding code changes. Git must be initialized before the analysis baseline can be captured. Restart existing MCP/daemon/dashboard processes after upgrading, then hard-refresh the dashboard after rebuilding its bundle.

Target graph editing and optional scaffolding are design extensions, not implemented features. Existing worker task/claim/wave tools remain the execution strategy; there is no new agent runtime. The source Inspector now offers CodeFlow Trace; individual TestCase results are now supported through the versioned stdout report contract below. Reverse lookup and suite-level execution evidence are available. V1 UI authors Flows and inspects/gates phases; structured phase submissions use MCP. Metric thresholds and unexpected impact are warnings by default, with explicit configurable error levels.

UI verification used an isolated real workspace populated through MCP, including a parsed production function, intended tests, architecture Knowledge and an active Task. The running dashboard verified eight-node initial view, hierarchical expansion, requirement focus, node inspection, blocked gate findings, expanded quality evidence and exact source navigation into Inspector. Full regression: 1,222 passing tests, including request-lifetime checks. TypeScript, frontend production build and fresh-install smoke checks passed. The existing legacy self-graph remains stale; its freshness warning is documented above rather than represented as a passing current-source quality result.

## CodeFlow product terminology and graph integration

The product is now **CodeFlow** and a requested modification is a **Flow**.
The canonical graph root label is Flow. Existing state files, slugs, changeId
fields and node IDs remain stable; Resume updates legacy Change projections
in place. Existing change_read/change_write and --change remain compatible;
flow_read/flow_write and --flow are the preferred names. The artifact directory
is unchanged to preserve version history. The main graph now includes workflow
labels and semantic edges at every detail level. Its type filters, legend and
2D/3D renderer share workflow glyph definitions. Tasks stay diamonds, Knowledge
stays cylindrical, Specs retain their tetrahedra and Epic wireframes retain
their original meaning. See [the user guide](CHANGES_GUIDE.md).

## Idea origin, templates and trace decisions

Flow kinds use Idea.kind independently of existing category/intent metadata.
Promotion runs through the daemon workflow operation and stores the immutable
original Idea text plus stable selectors for directly linked context. The Idea
is not archived or deleted; repeated identical requests for the same slug are
idempotent, and a different slug can create another Flow. PROMOTED_TO is an
existing relation. Task creation remains gated by Planning.

Templates live in lib/workflow/templates.cjs. Creation snapshots ID, version and
phase order; readers and reopening use the stored order. V1 registers the
engineering sequence and adds kind guidance. New templates require explicit
contract/gate support, not unchecked arbitrary phase names.

SourceAnalysis is a real graph projection of the latest submitted analysis,
with IMPACTS and DERIVES links to affected code and discovered TestCases. It is
separate from Phase scheduling metadata. ArchitectureDecision is an optional
architecture-owned entity; existing Knowledge remains reusable via REFERENCES.
Trace selects obligations and proof first, then adds container/provenance
ancestors without following a Flow into unrelated requirements. It returns
existing source IDs, bounded results and missing-link findings. Presets are
view filters and never delete semantic graph data.

Agent runs and gate evidence remain persisted Phase metadata rather than new
independently scheduled graph types. Target graph editing, external CI result imports and shorter per-kind workflows
remain future milestones.

## CodeFlow follow-up milestone verification

The complete regression run passed 1,229 tests. A subsequently added real-database
SourceAnalysis/ArchitectureDecision test and the final focused promotion, trace,
request-lifetime, route and MCP runs also passed. TypeScript checking, the
frontend production build and packed fresh-install smoke test passed.

Live dashboard checks used an isolated parsed project: Idea promotion retained
the original Idea, started Requirements without Tasks, and opened the new Flow.
Source-to-CodeFlow Trace, missing-test evidence, Testing preset, relationship
filters, main graph shapes, inspectors and in-app documentation were inspected.
This validates the integration; context savings and regression prevention still
need measurement on real project work. The legacy self-graph was not rebuilt.

## Observed TestCase results

Acceptance contract (before implementation): a passing suite alone never marks a
TestCase passing. Development records explicit selectors (check, relative test
file, exact test name, optional line) tied to an existing IMPLEMENTED_BY target.
All bindings and all linked implementations must be accounted for; duplicate
selector matches are ambiguous, skipped/todo are not passes. One executable
test may protect several intents, and one intent may require several tests.

Reuse workflow.checks and its source/configuration fingerprint, immutable
execution artifact and daemon revision check. Add a bounded, versioned JSON
report on command stdout, with a bundled node:test reporter. Parse observed
output in the daemon; do not accept agent-authored PASS fields. Persist the
normalized observations and bindings in Flow state and project last-recorded
evidence onto TestCase nodes. Live reads recheck source, configuration, intent,
links and artifact integrity; stale evidence must never appear as current PASS.
Malformed/missing reports block their configured check. Individual failures
block Quality; missing/skipped results are warnings by default, configurable
with workflow.policies.testResults. Existing checks without reports still work.

V1 does not infer code coverage, import CI artifacts of unknown provenance,
resolve duplicate test names heuristically, or create a second test-source graph.

Verification for observed TestCase results: 1,235 tests passed in the complete
regression suite. TypeScript with unused checks, frontend production build,
and packed fresh-install smoke passed. An isolated live Flow ran two real
node:test behaviors against its production token function through codevis quality.
Both TestCases showed PASS and linked immutable execution artifacts. A later
source edit changed both to stale on refresh, including the main Code Graph
inspector. Existing suite-only checks remain compatible. No reliability or
context-efficiency improvement percentage is claimed from this small pilot.

## CodeFlow navigation decisions

Keep one React Flow instance per workspace/Flow. Camera movement is an explicit
request, not a side effect of every graph refresh or focus remount. A small
navigation hook owns presentation state; pure helpers find a shortest expansion
path, search existing nodes and wrap dense focused layers. The viewport uses
React Flow camera methods. No new graph relationships or backend API are needed.
Acceptance: search a hidden TestCase in a 60-case Flow, reveal it at readable
zoom, navigate phases, preserve camera on refresh, and restore the previous
view after focus. Unit tests cover cyclic provenance, search bounds, zoom and
large-layer layout; final acceptance also requires the running dashboard.

Navigation verification: the complete regression run passed 1,239 tests. The
subsequently added overview-bounds test and final focused run (11 tests) passed.
TypeScript checking, the frontend build and packed fresh-install smoke passed.
The dashboard pilot contained 60 TestCases: a hidden TC-057 was centered at
100% zoom; refresh and focus/back preserved the exact viewport transform.
The 62-node requirement focus wrapped into three-column rows, Overview fitted
the graph, Read selected restored readable zoom, and phase/Flow switches
selected the correct current context. Focus omits redundant expansion buttons.
