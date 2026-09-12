// Preserve executable configuration, comments and user-defined fields. Only the
// wizard's own override block is replaced on subsequent runs.
const START = '\n// BEGIN CODEVIS SETUP OVERRIDES\n';
const END = '// END CODEVIS SETUP OVERRIDES\n';

export function updateConfigSource(source, values) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.indexOf(START);
  const end = start < 0 ? -1 : source.indexOf(END, start);
  if (start >= 0 && end >= 0) source = source.slice(0, start) + source.slice(end + END.length);
  const { sourceDirs, exclude, knowledgePaths, autoUpdate, locking, ros, workMode } = values;
  return `${source.trimEnd()}\n${START}{
  const config = module.exports;
  const workspace = config.workspaces?.project_db || config.workspaces?.project || config.workspaces?.target || config.workspaces?.tool || {};
  Object.assign(config, {
    workMode: ${JSON.stringify(workMode)},
    autoUpdate: { ...config.autoUpdate, enabled: ${autoUpdate} },
    locking: { ...config.locking, enabled: ${locking} },
    extractors: { ...config.extractors, ros: ${ros} },
    knowledge: { ...config.knowledge, paths: ${JSON.stringify(knowledgePaths)} },
    workspaces: {
      ...config.workspaces,
      project_db: {
        ...workspace,
        sourceDir: ${JSON.stringify(sourceDirs)},
        exclude: ${JSON.stringify(exclude)},
        extractors: { ...workspace.extractors, ros: ${ros} },
      },
    },
  });
}
${END}`;
}
