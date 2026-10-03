# CodeVis agent guide

This file is the shared project memory for coding agents. Keep durable workflow
and architecture rules here; keep user-facing behavior in `README.md` and
focused guides in `docs/`. Claude-specific deep troubleshooting notes remain in
`CLAUDE.md`.

## Start here

- Read `README.md` for product behavior and setup, then the relevant guide in
  `docs/` before changing a subsystem.
- Preserve unrelated working-tree changes. Do not add `Co-Authored-By` trailers.
- Use the CodeVis MCP graph for structural questions such as callers, imports,
  render relationships, state access and impact radius. Use file reads for
  implementation details and `rg` for literal text searches.
- Before trusting MCP results when several projects may be open, call
  `get_workspace_identity` and verify the project root/fingerprint.

## Architecture

- `scripts/graph_builder.js`: tree-sitter parsing and full/incremental graph builds.
- `server/ladybug-daemon.cjs`: the single writer for the embedded Ladybug database.
- `server/bridge.js`: REST/WebSocket bridge used by the dashboard.
- `tools/mcp_server.ts` and `tools/handlers/`: MCP surface for agents.
- `frontend/src/`: React/Three.js dashboard. Semantic colours live in
  `frontend/src/theme/tokens.js` (CSS, canvas, Mermaid and terminal), shared
  control geometry/states in `frontend/src/theme/controls.css`, and layout in
  `frontend/src/demo-theme.css`. Use `ui-button` variants or `buttonStyle()`;
  do not redefine button radii, padding or raw UI colours in individual panels.
  Data-category palettes remain separate from UI accents.
- `frontend/src/hooks/`, `frontend/src/graph/`, `frontend/src/pathfinder/`: shared
  dashboard state and pure graph/pathfinder models. Keep `App.jsx` focused on
  orchestration and put canvas presentation helpers outside `GraphScene.jsx`.
- `server/query-security.cjs`: read-only Explore-query guard shared by the
  bridge and its tests; do not duplicate this security logic in test files.
- `lib/commands/`: `codevis` CLI commands.

The public databases are `project_db` (the current project, default) and
`codevis_db` (the optional CodeVis self-graph). Legacy internal aliases still
exist; new documentation and UI should use the public names.

## Development and verification

```bash
npm test
npm run build:frontend
npm run smoke
```

Run the smallest relevant test first, then the broader suite when the change
warrants it. A green frontend build does not prove a UI change is visible:
inspect it in the running dashboard. Restart the bridge after editing
`server/bridge.js`, and hard-refresh an already open dashboard after rebuilding
the hashed frontend bundle.

Use `npx codevis info` first for daemon, bridge, database or workspace issues.
Ports are derived from the project path and are not generally `4000`.

## Graph invariants

- Use `elementId(n)` for node identity in queries and APIs. Treat IDs as strings;
  URL-encode them and never parse them as integers.
- `seq` and `ipv6` are not stable unique identifiers.
- Code nodes may be rebuilt, while Tasks, Knowledge, Specs and other work items
  must survive a graph rebuild.
- Static analysis is conservative. Missing `CALLS` edges and dead-code results
  are evidence to investigate, not proof of runtime reachability.
- For large result sets, avoid `WHERE elementId(n) IN $ids`; load the relevant
  edge set and filter against a JavaScript `Set`.

## Multi-agent locking

Locking is optional and disabled by default. Do not acquire locks unless it is
enabled for the project and useful for active multi-agent coordination. When it
is enabled, lock only the smallest affected subgraph (`depth=0` for a single
component when possible), work in the shared checkout, and always release locks
when finished. Locking and wave scheduling are experimental, so tests and normal
source-control review remain required.

