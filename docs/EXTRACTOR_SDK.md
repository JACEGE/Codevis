# Extractor SDK contract

CodeVis language extractors are declarative tree-sitter configurations in
`scripts/graph_builder.js`. Every configuration is validated when the builder
module loads, before a database session or build marker is created. A misspelled
field or invalid required query therefore fails as `INVALID_EXTRACTOR_CONFIG`
instead of silently producing a partial graph.

`createExtractorRegistry()` is the supported registration boundary. It
validates before mutation, rejects accidental replacement, freezes registered
configuration objects and supports explicit extension aliases. The current
builder exposes its registry as `__testing__.EXTRACTOR_REGISTRY`; a later plugin
loader can use the same boundary without changing extraction semantics.

## Required fields

- `wasm`: path to the tree-sitter grammar WASM file;
- at least one non-empty `astQuery`, `funcQuery` or `callQuery`. Structural
  formats such as XML may expose only syntax without pretending they contain
  functions or calls.

Optional `funcQuery`, `callQuery` and other query fields correspond to graph capabilities such as classes,
imports, callbacks, inheritance, state, JSX, control flow and type references.
The validator rejects unknown fields so a typo cannot look like supported
coverage. `EXTRACTOR_CAPABILITIES` exposes the effective capability matrix for
tests and future diagnostics.

## Adding a language

1. Add the grammar dependency and WASM path.
2. Add one `LANG_CONFIGS` entry for the extension.
3. Start with functions, calls, imports and the generic AST query.
4. Add real-grammar positive and forbidden-edge fixtures in
   `tests/treesitter.test.js` or `tests/polyglot-parsers.test.js`.
5. Run `node --test tests/extractor-contract.test.js tests/treesitter.test.js`,
   then the complete suite.

The contract validates shape, not semantic correctness. Every query must still
be compiled and exercised against its real grammar; adversarial forbidden-edge
tests remain mandatory for receiver and scope resolution.

The shared corpus lives in `tests/fixtures/adversarial/parser-cases.json`.
Each case is valid source code plus a forbidden caller/target pair. Add a case
whenever a parser audit finds a plausible but unsupported dispatch shape; the
real extractor must then prove it does not invent a confident `CALLS` edge.
Keep positive resolution fixtures alongside these negative cases so safety
guards cannot silently disable ordinary calls.

## Regression baselines

After a representative full build, store measured internal-call resolution per
language with `codevis quality --write-baseline codevis-quality.json`. CI can
then run `codevis quality --baseline codevis-quality.json --max-regression 1`.
This fails when a measured language loses more than one percentage point or
gains parse errors. Legacy overall counters and unmeasured languages are omitted
rather than being presented as internal-call coverage.
