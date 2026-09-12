# CodeVis

This file contains Claude-specific troubleshooting details that are easy to
get wrong when working on CodeVis itself.

## Use the graph for structure

Use `codevis_db` for CodeVis itself and `project_db` for the analysed project.
Use the graph for callers, imports, render relationships, state access and
impact radius. Read files for implementation details and use text search for
literal strings. Always verify the workspace identity before trusting results.

## UI verification

- The active dashboard theme is `frontend/src/demo-theme.css`.
- Restart the bridge after changing `server/bridge.js`.
- Rebuild the frontend and hard-refresh an open dashboard after bundle changes.
- A successful build does not prove that a component is rendered. Inspect UI
  changes in the running dashboard.

## Derived ports and workspace routing

Do not assume that the bridge uses port 4000. Ports are derived from the
canonical project path. Use `npx codevis info`, or inspect the current value:

```sh
node -e "console.log(require('./server/codevis-paths.cjs').BRIDGE_PORT)"
```

`CODEVIS_BRIDGE_PORT` and `LADYBUG_DAEMON_PORT` override the derived values.
The legacy `bolt://`-shaped storage URI also encodes workspace selection; it is
not a real network connection. Use the public workspace names at API and UI
boundaries instead of interpreting that URI yourself.

## Node identity

Use `elementId(n)` and treat the result as an opaque string. Never use `id(n)`,
`seq` or `ipv6` as stable identity. URL-encode IDs and do not parse them as
numbers. For large result sets, load the relevant edge set and filter against a
JavaScript `Set` instead of using a large `elementId(n) IN $ids` predicate.

## Ladybug query pitfalls

Ladybug can return a successful result with surprising aggregate values:

- `collect()` over an all-NULL column may return `null`, not `[]`; use
  `coalesce` before aggregation when an empty collection is required.
- Mixing `collect(DISTINCT value)` and plain `collect(value)` in one projection
  can produce incorrect trailing aggregates. Use a consistent aggregation form.
- `IN [...]` on a value projected through an aggregating `WITH` can evaluate
  incorrectly. Compute the membership flag before aggregation and carry it as a
  grouping key.
- `toInteger`, `toFloat`, and string-plus-INT64 concatenation are not generally
  portable through the compatibility layer. Prefer explicit parameters and
  application-side formatting.

Keep query behavior covered by translation fixtures; do not duplicate dialect
workarounds in callers when the compatibility layer can own them.

## Mermaid

Diagram generators put Mermaid frontmatter at line 1. Do not prepend an
`%%{init}%%` directive, because the frontmatter would then be parsed as diagram
text. Apply directives through `withMermaidTheme` in
`frontend/src/lib/loadMermaid.js`.

Load Mermaid only through that module. `initialize()` must run once; repeated
initialization can reset Mermaid's registry while another render is active.
