/**
 * codevis-paths — single source of truth for "where does this project's graph live".
 *
 * Every process that touches the embedded DB (daemon, driver, graph builder,
 * bridge) resolves its paths here, so they can never disagree about which
 * database they are talking to.
 *
 * Why this exists: the paths used to be derived from the *package* directory
 * (`path.resolve(__dirname, '..')`). That is correct while CodeVis runs from a
 * git checkout and catastrophic once it is installed as a dependency — the data
 * would land in `node_modules/codevis/data`, i.e. inside a directory npm
 * considers disposable. A single `npm install` would delete the graph.
 *
 * The data therefore lives in the *project* being analysed, which also makes
 * parallel instances work: two projects = two data dirs = two daemons.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOOPBACK_HOST, parsePort } = require('../lib/network-options.cjs');

const CONFIG_NAMES = ['codevis.config.cjs', 'codevis.config.js'];

/**
 * The directory that owns the graph, in order of precedence:
 *   1. CODEVIS_PROJECT_DIR — set explicitly (init writes it into .mcp.json, so
 *      the MCP server gets it even though Claude Code spawns it with an
 *      arbitrary cwd).
 *   2. The nearest ancestor of cwd holding a codevis config — the usual case for
 *      CLI invocations from anywhere inside the project.
 *   3. cwd, as a last resort.
 *
 * Deliberately never the package directory: see the file header.
 */
/**
 * Canonical spelling of an absolute path.
 *
 * Windows only: the drive letter's case depends on how the process was launched
 * — `C:\...` from a shell, `c:\...` from the CODEVIS_PROJECT_DIR that init wrote
 * into .mcp.json — and `path.resolve` preserves whatever it was given. Since the
 * data dir derived from this is used as the daemon's IDENTITY (a driver compares
 * the dir it wants against the dir a daemon reports), the two spellings made a
 * project fail to recognise its own daemon. Fixing it here means every consumer
 * agrees by construction rather than each having to remember to normalise.
 */
function canonicalize(p) {
    const resolved = path.resolve(p);
    if (process.platform !== 'win32') return resolved;
    return resolved.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
}

function findProjectRoot() {
    if (process.env.CODEVIS_PROJECT_DIR) {
        return canonicalize(process.env.CODEVIS_PROJECT_DIR);
    }
    let dir = process.cwd();
    for (;;) {
        if (CONFIG_NAMES.some((n) => fs.existsSync(path.join(dir, n)))) return canonicalize(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break; // hit the filesystem root
        dir = parent;
    }
    return canonicalize(process.cwd());
}

const PROJECT_ROOT = findProjectRoot();

/**
 * Data dir: `<project>/.codevis`.
 *
 * Legacy: the CodeVis repo itself has always kept its graph in `<repo>/data`.
 * If that directory already holds a database we keep using it, so an existing
 * checkout does not silently start from an empty graph after this change.
 */
function findDataDir() {
    if (process.env.CODEVIS_DATA_DIR) return canonicalize(process.env.CODEVIS_DATA_DIR);
    const legacy = path.join(PROJECT_ROOT, 'data');
    if (['ladybug-target', 'ladybug-meta'].some((name) => fs.existsSync(path.join(legacy, name)))) return legacy;
    return path.join(PROJECT_ROOT, '.codevis');
}

const DATA_DIR = findDataDir();
const LEGACY_DATA_DIR = canonicalize(path.join(PROJECT_ROOT, 'data'));
const USING_LEGACY_DATA_DIR = DATA_DIR === LEGACY_DATA_DIR;

const DB_PATHS = {
    meta: process.env.LADYBUG_META_PATH || path.join(DATA_DIR, 'ladybug-meta'),
    target: process.env.LADYBUG_TARGET_PATH || path.join(DATA_DIR, 'ladybug-target'),
};

const PIDFILE = process.env.LADYBUG_PIDFILE || path.join(DATA_DIR, '.ladybug-daemon.pid');

function workspaceIdentity(config, workspaceName) {
    const { normalizeWorkspaceName, publicWorkspaceName } = require('../lib/workspace-names.cjs');
    const internalName = normalizeWorkspaceName(workspaceName);
    const publicName = publicWorkspaceName(internalName);
    const workspace = config.workspaces?.[internalName] || {};
    const sourceDirs = (Array.isArray(workspace.sourceDir) ? workspace.sourceDir : [workspace.sourceDir])
        .filter(Boolean)
        .map((entry) => canonicalize(path.resolve(PROJECT_ROOT, entry)))
        .sort();
    const identity = { projectRoot: PROJECT_ROOT, workspace: publicName, sourceDirs };
    const comparable = process.platform === 'win32'
        ? { ...identity, projectRoot: identity.projectRoot.toLowerCase(), sourceDirs: sourceDirs.map((entry) => entry.toLowerCase()) }
        : identity;
    return {
        ...identity,
        fingerprint: crypto.createHash('sha256').update(JSON.stringify(comparable)).digest('hex').slice(0, 16),
    };
}

function workspaceIdentityPath(workspaceName) {
    const { publicWorkspaceName } = require('../lib/workspace-names.cjs');
    return path.join(DATA_DIR, `.workspace-${publicWorkspaceName(workspaceName)}.json`);
}

function readWorkspaceIdentity(workspaceName) {
    try {
        return JSON.parse(fs.readFileSync(workspaceIdentityPath(workspaceName), 'utf8'));
    } catch (_) {
        return null;
    }
}

function workspaceIdentityStatus(config, workspaceName) {
    const expected = workspaceIdentity(config, workspaceName);
    const recorded = readWorkspaceIdentity(workspaceName);
    return { expected, recorded, mismatch: Boolean(recorded && recorded.fingerprint !== expected.fingerprint) };
}

function writeWorkspaceIdentity(config, workspaceName) {
    const identity = { ...workspaceIdentity(config, workspaceName), recordedAt: new Date().toISOString() };
    const destination = workspaceIdentityPath(workspaceName);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
    return identity;
}

/**
 * Daemon port, derived from the project root.
 *
 * A fixed port would make the *second* project silently attach to the *first*
 * project's daemon — same port, healthy /health, so the driver happily attaches
 * and then reads a completely foreign graph. Hashing the project root gives each
 * project its own daemon while staying deterministic (no port file to keep in
 * sync between the spawning driver and the spawned daemon).
 *
 * Range 7600-7999. Collisions across two different projects are possible but
 * harmless: the daemon binds first and the loser fails its health check, spawns
 * nothing, and surfaces a normal connection error rather than corrupting data.
 */
function resolvePort() {
    if (process.env.LADYBUG_DAEMON_PORT) {
        return parsePort(process.env.LADYBUG_DAEMON_PORT, 'LADYBUG_DAEMON_PORT');
    }
    // Case-insensitive: Windows hands us the same path with differing drive-letter
    // case depending on how the process was launched.
    const key = path.resolve(PROJECT_ROOT).toLowerCase();
    const digest = crypto.createHash('sha1').update(key).digest();
    return 7600 + (digest.readUInt16BE(0) % 400);
}

const DAEMON_PORT = resolvePort();

/**
 * Bridge/dashboard port. Same reasoning as the daemon port: a fixed 4000 means
 * the second project's dashboard cannot start (or, worse, its frontend talks to
 * the first project's bridge). CODEVIS_BRIDGE_PORT overrides.
 */
function resolveBridgePort() {
    if (process.env.CODEVIS_BRIDGE_PORT) {
        return parsePort(process.env.CODEVIS_BRIDGE_PORT, 'CODEVIS_BRIDGE_PORT');
    }
    const key = path.resolve(PROJECT_ROOT).toLowerCase();
    const digest = crypto.createHash('sha1').update(`bridge:${key}`).digest();
    return 4000 + (digest.readUInt16BE(0) % 400); // 4000-4399
}

const BRIDGE_PORT = resolveBridgePort();

/**
 * The project's codevis config, loaded from the *project* — not from the package
 * dir, which holds no config once CodeVis is installed as a dependency.
 * `.cjs` wins: that is what `codevis init` generates.
 */
function loadConfig() {
    const { withInternalWorkspaceAliases } = require('../lib/workspace-names.cjs');
    for (const name of CONFIG_NAMES) {
        const p = path.join(PROJECT_ROOT, name);
        if (fs.existsSync(p)) {
            delete require.cache[require.resolve(p)];
            return withInternalWorkspaceAliases(require(p));
        }
    }
    throw new Error(
        `No codevis config found in ${PROJECT_ROOT}. Run 'npx codevis init' in your project first.`
    );
}

module.exports = {
    PROJECT_ROOT,
    DATA_DIR,
    DB_PATHS,
    PIDFILE,
    DAEMON_PORT,
    BRIDGE_PORT,
    USING_LEGACY_DATA_DIR,
    HOST: LOOPBACK_HOST,
    loadConfig,
    workspaceIdentity,
    workspaceIdentityPath,
    readWorkspaceIdentity,
    workspaceIdentityStatus,
    writeWorkspaceIdentity,
};
