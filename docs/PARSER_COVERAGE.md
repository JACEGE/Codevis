# Parser coverage and roadmap

CodeVis treats static analysis as evidence, not runtime truth. A parser feature
is complete only when the graph records both its positive evidence and the
reason/confidence used to derive it.

## Coverage metrics

Call coverage measures project-internal candidates only. Calls into libraries,
frameworks, generated bindings, and dynamic objects are counted separately as
external sites; they do not lower internal resolution coverage. Per-file output
therefore exposes `allSites`, `externalSites`, `internalSites`, `resolved`, and
the internal percentage.

A stale graph suppresses confidence-sensitive scans. Public APIs, framework
entrypoints, callbacks, abstract contracts, planned stubs, and spec/task-linked
functions are counter-evidence in dead-code classification.

## Supported evidence today

- scoped same-file and import-backed `CALLS`, with `resolvedBy` on edges;
- constructed JavaScript/TypeScript receivers and selected typed receivers;
- conservative C++ receiver dispatch for typed values, pointers, references,
  smart-pointer factories, and class-qualified calls;
- explicit-receiver safety across JavaScript/TypeScript, Java, Go, Rust, Ruby,
  Lua and C++, including chained receivers and lexical parameter shadowing;
- scope-sensitive Python single-assignment aliases for direct calls and
  callback arguments, with reassignment and parameter-shadow guards;
- Java qualified/generic bases, Kotlin qualified/delegated interfaces, Ruby
  singleton methods and require imports, and quoted Bash source imports;
- Python module aliases, imported classes, and one-hop typed `self` attributes;
- callbacks including JAX-style higher-order calls through `PASSES_CALLBACK`;
- pytest tests, fixtures and hooks, Hydra/CLI entrypoints, Android lifecycle,
  React roots, public/private visibility, abstract methods and planned stubs;
- JSX render relations, React state/effect/ref models, inheritance and class
  members across the supported languages;
- source mtime, parse time/hash/status, call counts and stale-graph gating;
- repository Markdown Knowledge, imported PlantUML specs, and explicit bindings.

## General roadmap

### Class extraction edge cases

Anonymous JS/JSX/TS/TSX default-export classes use the file stem as their
graph name (`Store.js` -> `Store`), or `Store:default` when that stem collides
with a declared class/binding. Their methods, fields and direct bases are
recorded under that same identity, including a parenthesized default class
expression and the existing conservative mixin-argument inheritance model.

Anonymous C/C++ `typedef struct` definitions use the first direct value alias
as their class name. Pointer-only aliases are not value types, and additional
aliases do not create duplicate class bodies. General typedef alias resolution
is not implied by this support.

Defined C++ enums are Class nodes with `kind: 'enumeration'`, with enumerator
names in the attribute compartment and an `<<enumeration>>` diagram stereotype.
Forward declarations and type mentions do not create boxes. Numeric enumerator
values are not evaluated or displayed.

TypeScript accessors (including static, typed/private and override fields) are
extracted. The bundled TS/TSX grammar cannot directly parse all accessor
modifier combinations or a method named `accessor`. On affected syntax-error
files, `scripts/parser/parse-source.cjs` uses the TypeScript compiler's syntax
tree to identify these exact class-member tokens and retries a position-preserving
compatibility parse. The public tree-sitter input callback then serves original
source text to extractors: names, snippets, line numbers and offsets stay original.
This models class structure, not accessor desugaring or generated storage.

The fallback runs only for TS/TSX, rejects TypeScript parse diagnostics, and
accepts the retry only if tree-sitter reports no remaining syntax errors.
Unrelated syntax errors stay visible. TypeScript is a lazy-loaded runtime
dependency so the same behavior is available in installed packages.

### Broader work

The following remain cross-project parser work, not project-specific rules:

1. Python re-export chains through `__init__.py` and `__all__`.
2. Complete interface/protocol implementation and dispatch edges.
3. Typed field reads plus produced/consumed return and parameter types.
4. Hydra/YAML composition, overrides, key reads, and unused-key analysis.
5. Callback roles for scan/loop bodies and React render-loop state warnings.
6. Test-to-contract `VERIFIES` evidence.
7. Milestone nodes and `PLANNED_FOR` links extracted from docs/stubs.
8. Parser-version and partial-region diagnostics on every file.
9. Optional C/C++ semantic extraction from `compile_commands.json` and Clang:
   include paths and defines first, then overload/template identities, virtual
   dispatch candidates, and function-pointer targets. Tree-sitter remains the
   fast fallback when no compilation database is available.

Every addition needs deterministic fixtures for aliases, framework entrypoints,
callbacks, typed dispatch, incremental add/rename/delete, and stale confidence.
Names from one repository must never be hard-coded into generic extractors.
