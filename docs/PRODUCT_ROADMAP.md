# Product roadmap

This roadmap prioritizes features by shared value for people and coding agents.
It is separate from parser implementation details: parser quality is evidence
infrastructure, while the items below turn that evidence into safer decisions
and useful workflows.

## Priority 0: trustworthy evidence — in progress

Before adding more inferred relations, CodeVis must prove that its extractors
neither miss ordinary language constructs nor invent confident edges. A
multilingual adversarial conformance suite records, for every fixture:

- the valid source construct;
- relations that must exist;
- relations that must not exist;
- the evidence and confidence required for a match;
- whether compiler or framework metadata is necessary.

Scope-sensitive symbol and type resolution takes precedence over raising a
headline coverage percentage. Unknown or ambiguous targets remain visible as
such instead of becoming arbitrary graph edges.

## Priority 1: explainable impact analysis — delivered

CodeVis has one bounded impact service shared by CLI, MCP and dashboard. Given a file,
class or function it should return direct and transitive dependants, relevant
tests, Tasks, Specs and Knowledge, plus the exact graph path and confidence for
each result. This helps a person answer “what could break?” and gives an agent a
small, justified context instead of an unweighted graph dump.

Delivered surfaces:

- `codevis impact <file|symbol>`;
- an MCP impact tool with stable structured output;
- a dashboard view that explains every included path;
- limits for direction, depth, relation classes and confidence.

## Priority 2: change intelligence — first slice delivered

Git diff can feed changed symbols into the shared impact service and report
affected callers, tests, work items and documentation. Compare before/after
snapshots for new cycles, removed contracts and architecture drift. This reuses
the impact service instead of introducing a second traversal model.

## Priority 3: living project knowledge — next

Extend Markdown Knowledge with backlinks, embedded graph views and staleness
evidence. A document becomes suspect when referenced symbols disappear or the
linked code changes after the document was verified. Staleness is a warning,
not proof that prose is wrong.

## Priority 4: visible analysis quality — first slice delivered

CodeVis exposes measured call-resolution quality without presenting it as total
parser coverage. Continue the surface toward directory and file detail:

- exact, likely, possible and unknown relations;
- internal, external and unresolved call sites;
- parse failures and unsupported regions;
- stale graph state and parser version;
- the largest actionable coverage gaps.

Machines receive the same fields through MCP/API that people see in the UI.

## Priority 5: cost and extensibility

Add `architecture`, `standard` and `deep` analysis profiles so projects can
trade graph size and build time for AST/control-flow detail. The initial
extractor contract is documented and tested; versioning and third-party
compatibility still need to be formalized. Optional Clang data from
`compile_commands.json` and equivalent language services belong behind that
interface; Tree-sitter remains the fast, portable baseline.

## Experimental direction: runtime UI inspection

CodeVis may connect runtime DOM states and browser interactions with source
components, event handlers and errors. An earlier navigation-crawler prototype
exists in the development history, but runtime UI inspection is not part of the
current beta.

## Remaining delivery order

1. Continue adversarial multilingual parser conformance and scope-safe evidence.
2. Make long-running builds observable through an asynchronous status contract.
3. Extend Knowledge staleness and Git-diff evidence.
4. Add analysis profiles and formalize the extractor SDK.
5. Add optional compiler integrations where measured gaps justify them.

