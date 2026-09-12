# Database names

CodeVis exposes two database names:

- `project_db` — the repository being analysed; default for builds, work items
  and MCP operations.
- `codevis_db` — CodeVis' protected self-graph used when developing CodeVis.

New configuration files use `workspaces.project_db` and
`workspaces.codevis_db`. The primary read-only MCP query tools use the same
names: `project_db` and `codevis_db`.

For compatibility, `project`, `target` and `tool` still resolve to
`project_db`; `codevis` and `meta` resolve to `codevis_db`. `tool_db` and
`meta_db` remain deprecated MCP aliases for one compatibility cycle.

The embedded storage files keep their historical names (`ladybug-target` and
`ladybug-meta`). They are implementation details, and retaining them avoids a
risky data/WAL migration for existing projects.

## Dashboard selection and project identity

`codevis dashboard --db codevis_db` selects that workspace. If a dashboard
already runs on this project's port, the command verifies its project root
and data directory, then switches that running bridge instead of launching
a competing process. All connected dashboard tabs follow the change. Without
an explicit database, reopening preserves the running bridge's selection;
a fresh bridge defaults to `project_db` unless `CODEVIS_DEFAULT_DB` overrides it.
Protected workspace switches still require unlocking through Settings.

The active selection lives in the bridge process, not browser local storage
or a global "last project" setting. The project is resolved from
`CODEVIS_PROJECT_DIR`, otherwise the nearest parent of the current directory
containing `codevis.config.cjs` or `codevis.config.js`. Data normally lives in
that project's `.codevis` directory; existing legacy `data` directories and
explicit data-path overrides are preserved. CodeVis does not pick a database
by its most recent modification time. Run `npx codevis info` to see the actual
project, data directory, services and database timestamps.

User-facing CLI output, documentation, APIs and MCP handlers use the public
names. `target` and `meta` remain only at the embedded storage boundary where
they address the historical files.
