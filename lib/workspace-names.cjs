'use strict';

// Public workspace names are about intent. The legacy/internal names remain
// accepted so existing configs, scripts and databases continue to work without
// moving a single file on disk.
const ALIASES = Object.freeze({
    project_db: 'target',
    project: 'target',
    target: 'target',
    tool: 'target',
    codevis_db: 'meta',
    codevis: 'meta',
    meta: 'meta',
});

function normalizeWorkspaceName(value, fallback = 'target') {
    const raw = value == null || value === '' ? fallback : String(value).trim().toLowerCase();
    const normalized = ALIASES[raw];
    if (!normalized) {
        throw new Error(`Unknown workspace '${value}'. Use 'project_db' or 'codevis_db'.`);
    }
    return normalized;
}

function publicWorkspaceName(value) {
    return normalizeWorkspaceName(value) === 'target' ? 'project_db' : 'codevis_db';
}

// Keep the public entries and add the physical database keys expected by older
// consumers. URI readers still accept neo4jUri for pre-Ladybug configurations.
function withInternalWorkspaceAliases(config) {
    const workspaces = { ...(config?.workspaces || {}) };
    const projectDb = workspaces.project_db || workspaces.project || workspaces.target || workspaces.tool;
    const codevisDb = workspaces.codevis_db || workspaces.codevis || workspaces.meta;
    if (projectDb) workspaces.target = projectDb;
    if (codevisDb) workspaces.meta = codevisDb;
    return { ...config, workspaces };
}

module.exports = { ALIASES, normalizeWorkspaceName, publicWorkspaceName, withInternalWorkspaceAliases };
