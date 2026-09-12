# Dashboard navigation

Use **Search code & work** in the header to find files, functions, classes,
modules, endpoints, Tasks, Epics and Knowledge by name or file path. Search
reads the selected database, including nodes outside the visible graph budget.
Exact names appear first. Up to 50 results are shown; refine the search when
there are more. Select a result to open Inspector and its direct connections.
Press Enter to open a single matching result, or use Tab to move through results.
Escape closes search. Inspector and Pathfinder also offer search when no node
is selected.

If search reports HTTP 404 after updating CodeVis, the running dashboard server
may still be using the previous code. Stop that dashboard process and restart
it with the same workspace and options, then retry the search. Reloading the
browser alone does not restart the server. An empty result is different: check
the database named in the search dialog and its configured sources in Settings.

The workspace button names the project or identifies the CodeVis self-graph;
click it to open Settings. The dashboard opens in **Split**, with the graph
beside Kanban. Switching to Kanban keeps the selected layout; **Panel** is an
explicit option, never an automatic switch. Empty status columns start
collapsed but remain available as drop targets and can be expanded manually.
Narrow boards scroll horizontally to keep task titles readable.

When the browser shell is disabled, its panel is collapsed initially. The
**Terminal** button shows or hides the explanation; it does not enable a shell.
An enabled terminal retains the existing resizable panel.

Explore tables show names and file paths before other properties. **Show internal
identifiers** reveals the IDs used for graph navigation. **Inspect** opens a
result's details, while **Show in graph** keeps the scan visible. Impact results
mark unverified items separately from the saved graph's relationship evidence;
expand **Evidence in the saved graph** for the underlying counts.

Use **Back** and **Forward** beside the CodeVis name to revisit previous tabs,
node selections and Graph/Split/Panel layouts. The buttons also appear in
fullscreen views. They are disabled when there is no destination in that direction.

Selecting a new destination after going back starts a new history branch.
Repeated selections do not add duplicate entries. History keeps the latest 100
destinations for the current dashboard session and clears when switching databases
or reloading the page.

Navigation changes the view only; it does not undo edits, saves or task moves.
Previously selected nodes are loaded from the current graph. If a node was
removed since it was selected, the dashboard reports that it is no longer available.
