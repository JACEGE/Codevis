# Context workflow

The dashboard uses one shared selection across the graph, Context and Inspector.
Work items always come from the selected database (`project_db` or
`codevis_db`); legacy aliases (`project`/`target`/`tool`, `codevis`/`meta`) remain
accepted. The Context catalogue does not depend on the graph rendering
budget.

## UI behaviour

- **Context** replaces the former Knowledge-only navigator and lists Knowledge,
  Epics and Tasks with independent visibility toggles and one search field.
- Clicking an item's title opens it in Inspector.
- In a Kanban task's detail dialog, click an affected node's name to close the
  dialog and show that exact node and its direct relationships in the graph.
  This loads nodes outside the current graph budget too. Save or cancel task
  and comment drafts before navigating; use the Inspector tab for node details.
- **Show** loads a relationship subgraph from the database. Knowledge and Tasks
  use one hop. Epics use two hops so Epic -> Task -> affected code is visible.
- Clicking the already selected graph node a second time opens node actions:
  Show details, Show relations (one hop), and Show context (two hops).
- **Direct connections** and **Surrounding context** show loading feedback while
  fetching one or two hops. Large neighbourhoods can take several seconds.
  Failed requests keep the previous graph visible and offer a retry; missing
  nodes and requests exceeding 60 seconds produce a visible error.
- Inspector owns the detailed view for code, Knowledge, Tasks and Epics.
  Database-authored Knowledge is editable by exact node ID. Markdown Knowledge
  shows its source path and must be edited in that file, then synchronized.
- Workspace changes and graph resets clear temporary context/query graphs.
  Late requests cannot restore an earlier workspace or replace newer navigation.
- Opening task details or switching dashboard tabs does not request a full graph
  reload. Full-screen views retain the canvas and pause its renderer and layout
  worker until the graph is visible again.
- Browser windows share the bridge's loaded graph. Receiving another window's
  graph update does not reapply saved filters or budgets; an explicit filter,
  budget or detail-level change requests new graph data.

## Backend contract

`GET /api/context?db=<workspace>` returns stable `elementId` identifiers grouped
as `knowledge`, `epics`, and `tasks`. `POST /api/graph/subgraph` remains the one
implementation for resolving these identifiers and expanding relationships.

MCP `create_knowledge`, `link_knowledge` and `list_knowledge` also expose or
accept `nodeId`. Legacy name lookups must resolve uniquely. Both MCP and the
Inspector reject edits to Markdown-owned content/outgoing links; edit the
source document instead. `list_knowledge` includes IDs for the Knowledge and
its linked code/Task nodes, including File nodes without a `name` property.

This separation is intentional: the catalogue answers what exists, while the
subgraph route answers what should be rendered. It avoids duplicating graph
serialization and prevents work items outside the initial node cap from
disappearing from navigation.
