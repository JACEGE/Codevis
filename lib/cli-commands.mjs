export const commandDefinitions = Object.freeze({
  init: {
    load: () => import("./commands/init.mjs"),
    description: "Initialize CodeVis in the current project",
    help: { usage: "codevis init [new|code] [options]", arguments: ["new         Start in planning mode without graph builds", "code        Switch to code mode; detects source folders"], options: ["--source <paths>       Source roots for code mode, comma-separated or repeated", "--exclude <globs>      Exclusions, comma-separated or repeated", "--knowledge <paths>    Knowledge paths", "--watch | --no-watch   Configure automatic updates", "--locking | --no-locking  Configure experimental multi-agent locking", "--ros | --no-ros       Configure ROS extraction", "--recreate             Replace existing configuration", "-y, --yes              Run unattended", "--antigravity          Configure Antigravity MCP"] },
  },
  build: {
    load: () => import("./commands/build.mjs"),
    description: "Build project_db or codevis_db (mode: full|diff)",
    help: { usage: "codevis build [workspace] [mode]", arguments: ["workspace   project_db (default) or codevis_db", "mode        diff (default) or full"] },
  },
  watch: {
    load: () => import("./commands/watch.mjs"),
    description: "Watch source files and update project_db after changes settle",
    help: { usage: "codevis watch [options]", options: ["--debounce <ms>        Delay after the last change", "--max-wait <ms>        Maximum delay before rebuilding"] },
  },
  "diff-graph": {
    load: () => import("./commands/diff-graph.mjs"),
    description: "Diff the code graph of a branch against another",
    help: { usage: "codevis diff-graph <ref> [options]", arguments: ["ref         Branch or commit to compare"], options: ["--base <ref>           Base ref (default: HEAD)", "--ws <workspace>       project_db (default) or codevis_db", "--format <type>        text, mermaid, or json", "--out <path>           Write output inside the project", "--limit <n>            Positive results-per-section limit", "--rebuild              Ignore cached graphs", "--clean                Remove caches afterwards", "--keep-daemon          Leave comparison daemons running"] },
  },
  impact: {
    load: () => import("./commands/impact.mjs"),
    description: "Explain callers, dependencies and related project knowledge",
    help: { usage: "codevis impact <name> [options]", arguments: ["name        Node name; alternatively use --id"], options: ["--id <elementId>       Exact graph node identity", "--file <path>          Disambiguate by source file", "--label <label>        Restrict node label", "--db <workspace>       project_db or codevis_db", "--profile <profile>    fast, balanced, or deep", "--direction <value>    in, out, or both", "--depth <0-8>          Traversal depth", "--max-nodes <1-2000>   Result node ceiling", "--max-paths <1-10>     Paths retained per node", "--relations <list>     Comma-separated edge types", "--json                 Machine-readable output"] },
  },
  quality: {
    load: () => import("./commands/quality.mjs"),
    description: "Report measured parser resolution and declared capabilities",
    help: { usage: "codevis quality [options]", options: ["--db <workspace>       project_db or codevis_db", "--json                 Machine-readable output", "--min-resolution <pct> Fail below internal resolution", "--max-parse-errors <n> Fail above parse errors", "--require-capability <name>  Require an extractor capability", "--baseline <path>      Compare with a saved baseline", "--write-baseline <path>  Save the current baseline", "--max-regression <pct> Allowed baseline regression"] },
  },
  info: {
    load: () => import("./commands/info.mjs"),
    description: "Show ports, daemon state, database size and problems",
    help: { usage: "codevis info [--json]", options: ["--json                 Machine-readable diagnostics"] },
  },
  dashboard: {
    load: () => import("./commands/dashboard.mjs"),
    description: "Serve the graph dashboard and Kanban",
    help: { usage: "codevis dashboard [options]", options: ["--db <workspace>       project_db or codevis_db", "--port <n>             Override derived port", "--no-open              Do not open a browser", "--watch | --no-watch   Override automatic updates", "--web-shell            Enable the browser shell for this run"] },
  },
  start: {
    load: () => import("./commands/start.mjs"),
    description: "Start the MCP server (stdio transport)",
    help: { usage: "codevis start", note: "Starts the MCP stdio transport. Normally launched by your editor." },
  },
  stop: {
    load: () => import("./commands/stop.mjs"),
    description: "Stop this project's dashboard and database daemon cleanly",
    help: { usage: "codevis stop [--force]", options: ["--force                Hard-kill if clean shutdown fails (may lose WAL writes)"] },
  },
  kanban: {
    load: () => import("./commands/kanban.mjs"),
    description: "Show the task Kanban board in the terminal or browser",
    help: { usage: "codevis kanban [--watch [seconds]] | codevis kanban --web [--port <n>]", options: ["--watch [seconds]      Refresh terminal board continuously", "--web                  Open the browser Kanban", "--port <n>             Web Kanban port (default: 4200)"] },
  },
});

export const commandNames = Object.freeze(Object.keys(commandDefinitions));
