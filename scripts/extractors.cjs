/**
 * extractors.cjs — which optional extractors run for a workspace.
 *
 * CodeVis' core is domain-neutral: files, functions, calls, classes, imports.
 * On top of that sit *verticals* — extractors that understand one ecosystem's
 * idioms (ROS 2 publishers and services, and whatever comes next). Those must be
 * switchable, for two reasons:
 *
 *  - Cost. A vertical compiles its own tree-sitter queries and runs them over
 *    every file. A project with no ROS in it pays that on every build for
 *    nothing.
 *  - Honesty of the graph. A vertical writes domain nodes and properties. A
 *    codebase that has nothing to do with the domain should not end up with
 *    empty domain structure in its graph, and a user should not have to wonder
 *    why `Topic` nodes exist in a web app.
 *
 * The registry is the single place that knows an optional extractor exists.
 * Adding a vertical means adding an entry here and gating its calls in the
 * builder — not touching config parsing, the bridge, or the frontend.
 */

"use strict";

/**
 * Optional extractors, by name.
 *
 * `default` is what a config that never mentions the extractor gets. ROS
 * defaults to ON so existing installations keep behaving exactly as before —
 * a switch that silently removes data from someone's graph on upgrade is not a
 * switch, it is a regression.
 */
const OPTIONAL_EXTRACTORS = {
    ros: {
        default: true,
        description: "ROS 2 nodes, topics, services and actions (rclpy, rclcpp, roslib)",
    },
};

/**
 * Resolve the extractor settings for one workspace.
 *
 * Precedence, narrowest first:
 *   1. `workspaces.<name>.extractors`  — per workspace
 *   2. `extractors`                    — project-wide
 *   3. the registry default
 *
 * Unknown names are REPORTED rather than ignored: `extractors: { rso: false }`
 * would otherwise silently do nothing and leave the user convinced they had
 * switched something off.
 *
 * @returns {{ enabled: Record<string, boolean>, unknown: string[] }}
 */
function resolveExtractors(config = {}, workspaceName = null) {
    const projectLevel = isPlainObject(config.extractors) ? config.extractors : {};
    const workspace = (config.workspaces || {})[workspaceName] || {};
    const workspaceLevel = isPlainObject(workspace.extractors) ? workspace.extractors : {};

    const enabled = {};
    for (const [name, spec] of Object.entries(OPTIONAL_EXTRACTORS)) {
        const raw = workspaceLevel[name] !== undefined ? workspaceLevel[name]
            : projectLevel[name] !== undefined ? projectLevel[name]
                : spec.default;
        enabled[name] = raw !== false; // anything but an explicit false means on
    }

    const known = new Set(Object.keys(OPTIONAL_EXTRACTORS));
    const unknown = [...new Set([...Object.keys(projectLevel), ...Object.keys(workspaceLevel)])]
        .filter((name) => !known.has(name));

    return { enabled, unknown };
}

/** Log the resolution once per build, so what ran is visible afterwards. */
function reportExtractors({ enabled, unknown }, log = console.log) {
    const off = Object.entries(enabled).filter(([, on]) => !on).map(([name]) => name);
    if (off.length) log(`[extractors] disabled: ${off.join(", ")}`);
    for (const name of unknown) {
        log(`[extractors] WARNING: unknown extractor '${name}' in the config — known: ${Object.keys(OPTIONAL_EXTRACTORS).join(", ")}`);
    }
}

function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

module.exports = { OPTIONAL_EXTRACTORS, resolveExtractors, reportExtractors };
