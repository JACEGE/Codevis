# CodeFlow: from idea to reviewed code

A Flow keeps one requested modification, its requirements, test intentions,
implementation Tasks and review evidence together across agent sessions.
Use it for a feature, a bug fix or a refactor that needs traceability.

## Where to start

Choose **Work → CodeFlow**. The top menu has two levels: select a section,
then choose a view. Work contains CodeFlow, Task board, Ideas and Specs.
Analyze contains Knowledge, Inspector, Pathfinder and Queries. Model contains
code diagrams. System contains Docs and Settings. The layout buttons switch
between Code graph, Split view and Full view; they do not switch databases.

1. Choose **New Flow** and describe the desired behavior.
2. Open **What to do next** to see the current role, goal and completion checks.
3. Ask your connected Lead agent to resume that Flow through CodeVis MCP.
   The agent reads the current phase, writes its artifact and structured result,
   then asks CodeVis to validate completion.
4. Review the graph and the recorded reasoning. **Validate & advance** advances
   only if the current gate passes. Failure keeps the phase open and shows why.
5. Commit the versioned artifacts alongside the implementation when ready.
   CodeVis does not commit or push automatically.

The dashboard creates Flows and lets you inspect and validate them.
Structured phase authoring currently happens through MCP; clicking a phase
does not launch an agent or execute tests.

## Which Work view should I use?

| View | Use it for |
| --- | --- |
| CodeFlow | One coherent request, from requirements to review |
| Task board | Individual implementation Tasks, assignments and dependencies |
| Ideas | Capture rough thoughts before deciding what to build (the Brain feature) |
| Specs | Design diagrams and their links to actual code |

A Flow sits above Tasks. Existing Tasks and Knowledge are linked into the
Flow, so their identities and status remain shared with the other views.

## Read the Flow graph

The graph contains the Flow and seven phases, and opens at the current phase. Expand only the branch you
need; click any node to open its inspector. Requirements expand into acceptance
criteria and TestCases. TestCases represent intended validation and can exist
before any test code exists. **Implementation missing** means no executable
test is linked. **Result: not recorded** is unknown, not a passing result.

Select a requirement or TestCase and choose **Focus relationships** to inspect
its connected Tasks and code. Enable **Source symbols** to include code nodes.
**Show in Code Graph** opens the same stored entity in the main 2D/3D graph.
The node types also appear in its Filter and Legend. Click an edge's endpoint
and inspect its relationships; hover an edge to read its direction and type.

| Graph type | Meaning | Main-graph shape |
| --- | --- | --- |
| Flow | Requested modification | Hexagon / hexagonal prism |
| Phase | Current workflow role and gate | Ring / torus |
| Requirement | Intended behavior | Document / thin slab |
| AcceptanceCriterion | Individually checkable success condition | Small document / slab |
| TestCase | Validation intent | Triangle / triangular prism |
| SourceAnalysis | Recorded facts, approximations, inference and risks | Flat hexagon / plate |
| ArchitectureDecision | Major approved design decision | Pentagon / square pyramid |

Shape identifies the entity type. Workflow status colors distinguish pending, active and completed phases; status text remains explicit. Existing lock colors still take precedence. These
are persisted graph types, not copies of source symbols. Existing Task diamonds, Knowledge cylinders, Spec tetrahedra and Epic wireframes retain their meanings. The database stores:

- Flow → HAS_PHASE → Phase
- Flow → HAS_REQUIREMENT → Requirement
- Requirement → HAS_CRITERION → AcceptanceCriterion
- Requirement or criterion → VALIDATED_BY → TestCase
- TestCase → IMPLEMENTED_BY → existing test source
- TestCase → VALIDATES → existing production source
- Task → IMPLEMENTS → Requirement or TestCase
- Task → AFFECTS → source; Phase → IMPACTS → predicted source

SourceAnalysis is projected from its recorded analysis submission. Major decisions may use ArchitectureDecision nodes; existing decision Knowledge can also be referenced without copying it. Role and agent history are stored in the Phase node.

The vertical phase sequence and quality evidence groups are presentation
helpers. They are not extra database edges or independently stored node types.
Phase results and quality evidence remain in versioned Flow state.

## Work with a connected agent

Tell the Lead: “Use CodeVis to resume Flow <slug>. Read the current phase
context and follow its contract. Define test intent before implementation.”

The agent uses flow_read with operation list to find Flows, and view
context to get current instructions. flow_write supports create, submit,
complete, resume and reopen. Mutations use the returned expected revision;
stale revisions fail rather than overwrite newer work. Workers can read
focused task context but cannot advance the workflow.

Requirements come first, then source analysis, architecture, planning,
development, quality and review. Architecture and review record an attributed
approval. Gates check structure and evidence; humans and agents still judge
whether requirements and design decisions make sense.

## Tests, impact and quality

Include test directories in sourceDir so the graph can index executable tests.
Configure workflow.checks in codevis.config.cjs, then run:

~~~sh
npx codevis quality --flow <slug> --run-checks --json
~~~

**Quality evidence** opens recorded checks, traceability, metric deltas and
predicted versus actual impact. An unexpected changed symbol is a review
signal; policy decides whether it blocks completion. Legacy debt is compared
with the analysis baseline. Source edits invalidate old test evidence.
Suite exit codes and opt-in individual TestCase observations are recorded separately.
See Record individual TestCase results below.

## Saving, resuming and troubleshooting

Artifacts default to docs/codevis/changes/<workspace>/<slug>/. state.json owns
workflow state; immutable Markdown revisions hold reasoning. Git records their
history. workflow.artifactDir can change the root. The graph is their queryable
projection, while source, Tasks and Knowledge keep their existing ownership.

- **Resume saved state** repairs the graph projection and returns the current role.
- **Gate blocked:** inspect the current phase and resolve each reported issue.
- **Revision conflict:** refresh and read the latest result before retrying.
- **Stale graph:** rebuild the intended workspace before relying on impact or quality.
- **No Git repository:** initialize Git before completing source analysis.
- **After upgrading:** restart dashboard, daemon and MCP clients; hard-refresh
  the browser after rebuilding the frontend.

For schema, authority, recovery and protocol details, see the architecture guide
in **System → Docs → CodeFlow architecture** or [CHANGE_INTELLIGENCE.md](CHANGE_INTELLIGENCE.md).

## Promote an Idea to CodeFlow

The Idea Dump on **Work → Task board** is the unstructured inbox. Choose the
Idea kind independently of its suggested promotion targets. **Promote to
CodeFlow** opens a small dialog with title, kind, initial request and a preview
of explicitly linked Knowledge, Specs and source. Creation starts Requirements
Discovery, preserves the original Idea and creates an Idea → PROMOTED_TO → Flow
edge. It creates no Tasks or Epic. One Idea can produce multiple Flows.

Suggested-target chips are metadata, not conversion buttons. Existing Task
promotion remains available through the Lead's promote_idea_to_task tool;
manual Task/Epic creation remains on the board. Epic + Tasks means work is
already understood and needs organization. CodeFlow means it needs engineering
analysis first. Do not put trivial work through every phase unnecessarily.

All kinds currently use the versioned engineering template. Bug and refactor
kinds receive relevant guidance, but this is not yet a separate shortened bug
workflow. Each Flow stores the template ID, version and phase order so future
templates can evolve without changing a Flow already in progress.

## Trace why code changes

Select a source node and choose **Trace → CodeFlow context** in its actions or
Inspector. A requirement offers **Trace implementation**. The result includes
recorded requirement/criterion/test intent, implementing Tasks, production and
test source, relevant phases and the originating Idea. Flow links open the
process view. The trace avoids expanding a whole Flow into unrelated sibling
requirements and reports its 200-node cap when reached. Missing-link findings
are incomplete-view signals when the result is truncated.

The graph toolbar offers **All, Code, CodeFlow, Testing, Architecture, Quality**
perspectives. Node filters and **Relationships** filters are separate. A preset
sets the starting edge selection; you can then change individual edge types.
The **Test source** switch controls actual test code, independently of TestCase
intent. Presets only filter loaded graph data; the existing node budget and
detail settings still apply. Nothing is removed from storage by a view filter.

Testing keeps unvalidated requirements visible. Quality emphasizes traceability
and affected code; suite executions and metric deltas are reviewed under
CodeFlow → Quality evidence. These views do not claim runtime coverage.

## Record individual TestCase results

Suite success and TestCase success are separate. Existing checks still record
exit codes. To collect individual observations, configure a check that emits
one versioned JSON report on stdout. CodeVis includes a node:test reporter:

~~~js
// codevis.config.cjs (merge into your existing configuration)
const { pathToFileURL } = require('node:url');
module.exports = {
  workflow: {
    checks: [{
      name: 'unit',
      command: process.execPath,
      args: [
        '--test',
        '--test-reporter',
        pathToFileURL(require.resolve('codevis/lib/workflow/node-test-reporter.cjs')).href,
        'tests/auth.test.cjs'
      ],
      testReport: 'codevis-json'
    }],
    policies: { testResults: 'error' } // optional; missing/skipped results otherwise warn
  }
};
~~~

The reporter uses [Node's custom reporter interface](https://nodejs.org/download/release/v22.17.0/docs/api/test.html#custom-reporters).
Use a file URL for an absolute reporter path on Windows. Include your test
directory in sourceDir and rebuild to make executable test nodes addressable.

During Development, submit IMPLEMENTED_BY links and optional testBindings
through flow_write. Bindings replace the Flow's entire binding list, so include
the ones you want to retain:

~~~json
{
  "operation": "submit",
  "slug": "refresh-token-rotation",
  "expectedRevision": 12,
  "markdown": "# Development\nImplemented token rotation and its intended rejection behavior.",
  "data": {
    "summary": "Rotation rejects any reuse of the previous token.",
    "validation": "The public behavior is checked by the linked executable test."
  },
  "links": [{
    "from": "TC-001",
    "type": "IMPLEMENTED_BY",
    "to": { "nodeId": "<exact test File or Function elementId>" }
  }],
  "testBindings": [{
    "testCaseId": "TC-001",
    "check": "unit",
    "file": "tests/auth.test.cjs",
    "name": "reject reuse",
    "implementation": { "nodeId": "<same exact test source elementId>" }
  }]
}
~~~

Use the exact reporter test name, not a guessed source-symbol name. An optional
line disambiguates tests with the same file/name. If multiple observations still
match (for example repeated attempts), the result stays unresolved. One test
may be bound to several TestCases; a TestCase may require several tests. Every
binding must resolve and every IMPLEMENTED_BY target needs a selector before
the TestCase can be PASS. Selectors describe execution identity, not code coverage.

Run the existing command:

~~~sh
npx codevis quality --flow refresh-token-rotation --run-checks --json
~~~

Read results through flow_read with view tests, the TestCase inspector, or
Quality evidence → TestCase execution. TestCase cards show PASS, FAIL, Skipped,
TODO, unknown or stale. The main Code Graph inspector checks freshness when
opened; Refresh test evidence checks again. The process view's Refresh reloads
its evidence. Inspectors expose the execution timestamp, observations and the
immutable execution artifact.

A failed observed test blocks Quality. Missing, skipped, TODO or stale results
warn by default; testResults: 'error' makes them blocking. Suite failures and
malformed configured reports block independently. Editing source, check
configuration, intent, source links or bindings invalidates prior evidence.
Reopening a phase clears active evidence; historical artifacts remain in Git.
A graph property is the last recorded observation, with fingerprint/time; it
does not claim that the current working tree is still passing.

### Other test runners

An adapter may emit the same small format; there are no built-in JUnit, Jest or
Vitest importers yet. stdout must contain only this report; use stderr for other
logs. CodeVis captures stdout from the configured process during this run, so
there is no stale report-file import:

~~~json
{
  "version": 1,
  "tests": [{
    "file": "tests/auth.test.cjs",
    "name": "reject reuse",
    "line": 12,
    "status": "pass",
    "durationMs": 4.2
  }]
}
~~~

Supported statuses are pass, fail, skipped and todo. file is project-relative;
line, durationMs and message are optional. Reports are limited to 8 MiB and
10,000 observations. Passing a linked test remains evidence of its assertions,
not proof that those assertions fully satisfy the requirement. Commands and
runner adapters are trusted project configuration.

## Navigate a large Flow

A Flow opens at its current phase at readable zoom. **Current phase** returns
there; **Jump to phase** opens any other phase without changing workflow state.
Use **Find in Flow** to search IDs, titles, types or files, including collapsed
nodes. Enter opens the first result; Escape clears the search. Results open the
necessary branch and disable a conflicting incomplete/source filter so the
selected node can be shown. Search covers this Flow and its loaded evidence,
not every source symbol in the repository.

**Overview** fits the visible graph; **Read selected** returns to a readable
card. Zoom buttons, dragging and the minimap remain available. Expanding a
branch keeps the chosen card readable, while ordinary refreshes preserve the
camera. **Focus relationships** groups related nodes in rows of at most three;
**Back to Flow** restores the preceding camera, expansion and filter state.
These are view controls; they do not modify graph entities or phase approval.

### Recheck a reopened review

Reopening Review clears active execution evidence and requires a new review
submission. Run `codevis quality --flow <slug> --run-checks` in the active
Review phase, inspect its fresh results, and submit an attributed review before
validating again. A completed Flow must be reopened before recording new runs.
