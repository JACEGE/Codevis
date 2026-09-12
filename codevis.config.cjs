// CodeVis configuration for THIS repository (CodeVis analysing itself).
//
// Nothing machine-specific belongs in here — the file is committed. Anything
// that depends on where a checkout happens to live comes from the environment:
//
//   CODEVIS_PROJECT_DB_SRC comma-separated source dirs for `project_db`
//                        (e.g. "C:/work/my-robot/src,C:/work/my-robot/msgs").
//   CODEVIS_*_URI/_PASS  the database is embedded, so these are not connection
//                        strings to a server: the URI's port is only how the two
//                        graphs are told apart (7687 project, 7688 CodeVis), and the
//                        credentials are unused. The older NEO4J_*_URI/_PASS
//                        names are still read so existing setups keep working.
//
// `codevis init` writes a project-specific config with real source dirs; this
// one exists so CodeVis can build a graph of its own code out of the box.

/** Source dirs for the analysed project, or an empty list when none is set. */
function targetSourceDirs() {
  const raw = process.env.CODEVIS_PROJECT_DB_SRC || process.env.CODEVIS_TARGET_SRC;
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  // CodeVis itself already has source. Greenfield projects created with
  // `codevis init new` use "planning" until `codevis init code` switches them.
  workMode: "code",
  // Experimental multi-agent node locking. Off by default: tasks still keep
  // AFFECTS links and edit tools still validate/sync code, but no lock is
  // planned or required. Set true (or CODEVIS_LOCKING=on) to enable it.
  locking: {
    enabled: false,
  },

  // Optional extractors for one ecosystem's idioms, on top of the
  // language-neutral core. See scripts/extractors.cjs.
  extractors: {
    ros: true,
  },

  // Dashboard defaults. These are opening values, not hard limits — every one of
  // them is adjustable in the running UI. They live here because the right
  // number depends on the project: a repository with 90k nodes wants a different
  // first screen than one with 900.
  dashboard: {
    // How many nodes the graph shows before the filter starts holding some back.
    // Deliberately NOT unlimited: the first screen should appear fast. The UI
    // states what it is holding back rather than trimming silently.
    visibleNodeCap: 500,
    // The opening view builds itself up node by node instead of appearing at
    // once — it shows the shape of the graph forming. Only the first
    // growthIntroNodes arrive that way; the remainder lands in one go, so the
    // animation stays an introduction and never becomes a wait.
    growthIntroNodes: 300,
    // Nodes per 100ms tick during that build-up.
    growthSpeed: 6,
  },
  workspaces: {
    // CodeVis' own code. Relative on purpose: these resolve against the project
    // root, so they work in any checkout.
    codevis_db: {
      sourceDir: [
        "./scripts", "./tools", "./frontend/src", "./server",
        "./bin", "./lib", "./tests", "./templates", "./codevis.config.cjs",
      ],
      // Optional project-root-relative globs; matching directories are pruned.
      exclude: [],
      dbUri: process.env.CODEVIS_CODEVIS_DB_URI || process.env.CODEVIS_META_URI || process.env.NEO4J_META_URI || "bolt://localhost:7688",
      auth: { user: "codevis", pass: process.env.CODEVIS_CODEVIS_DB_PASS || process.env.CODEVIS_META_PASS || process.env.NEO4J_META_PASS || "unused-with-embedded-db" },
    },
    // The project being analysed. Empty until CODEVIS_PROJECT_DB_SRC says otherwise
    // — a build then reports the empty workspace instead of silently graphing
    // whatever happened to be in someone else's directory layout.
    project_db: {
      sourceDir: targetSourceDirs(),
      exclude: [],
      dbUri: process.env.CODEVIS_PROJECT_DB_URI || process.env.CODEVIS_TARGET_URI || process.env.NEO4J_TARGET_URI || "bolt://localhost:7687",
      auth: { user: "codevis", pass: process.env.CODEVIS_PROJECT_DB_PASS || process.env.CODEVIS_TARGET_PASS || process.env.NEO4J_TARGET_PASS || "unused-with-embedded-db" },
    },
  },
};
