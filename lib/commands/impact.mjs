#!/usr/bin/env node

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import ui from "../terminal-ui.cjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const ladybug = require(resolve(packageRoot, "server/ladybug-driver.cjs"));
const paths = require(resolve(packageRoot, "server/codevis-paths.cjs"));
const { normalizeWorkspaceName } = require(resolve(packageRoot, "lib/workspace-names.cjs"));
const { analyzeImpactFromSession } = require(resolve(packageRoot, "scripts/impact/impact_reader.cjs"));

export function parseArgs(argv) {
    const opts = { name: null, nodeId: null, file: null, label: null, db: "project_db", profile: "balanced", direction: null,
        depth: null, maxNodes: null, maxPathsPerNode: null, relations: null, json: false };
    const valueAfter = (index, flag) => {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
        return value;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--id") opts.nodeId = valueAfter(i++, arg);
        else if (arg === "--file") opts.file = valueAfter(i++, arg);
        else if (arg === "--label") opts.label = valueAfter(i++, arg);
        else if (arg === "--db") opts.db = valueAfter(i++, arg);
        else if (arg === "--profile") opts.profile = valueAfter(i++, arg);
        else if (arg === "--direction") opts.direction = valueAfter(i++, arg);
        else if (arg === "--depth") opts.depth = Number(valueAfter(i++, arg));
        else if (arg === "--max-nodes") opts.maxNodes = Number(valueAfter(i++, arg));
        else if (arg === "--max-paths") opts.maxPathsPerNode = Number(valueAfter(i++, arg));
        else if (arg === "--relations") opts.relations = valueAfter(i++, arg).split(",").filter(Boolean);
        else if (arg === "--json") opts.json = true;
        else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        else if (!opts.name) opts.name = arg;
        else throw new Error(`Unexpected argument: ${arg}`);
    }
    if (!opts.nodeId && !opts.name) throw new Error("Missing node. Usage: codevis impact <name> [--file path] or --id <elementId>");
    if (!["fast", "balanced", "deep"].includes(opts.profile)) throw new Error("--profile must be fast, balanced, or deep");
    if (opts.direction != null && !["in", "out", "both"].includes(opts.direction)) throw new Error("--direction must be in, out, or both");
    if (opts.depth != null && (!Number.isInteger(opts.depth) || opts.depth < 0 || opts.depth > 8)) throw new Error("--depth must be an integer from 0 to 8");
    if (opts.maxNodes != null && (!Number.isInteger(opts.maxNodes) || opts.maxNodes < 1 || opts.maxNodes > 2000)) throw new Error("--max-nodes must be from 1 to 2000");
    if (opts.maxPathsPerNode != null && (!Number.isInteger(opts.maxPathsPerNode) || opts.maxPathsPerNode < 1 || opts.maxPathsPerNode > 10)) throw new Error("--max-paths must be from 1 to 10");
    normalizeWorkspaceName(opts.db);
    return opts;
}

function nodeLine(node) {
    const where = node.file ? ` (${node.file}${node.startLine ? `:${node.startLine}` : ""})` : "";
    return `${node.name} [${node.label}]${where}`;
}

export function renderImpact(result) {
    const graphState = ui.badge(result.graphFreshness.state.toUpperCase(), result.graphFreshness.state === "stale" ? "yellow" : "green");
    const lines = [ui.title("CodeVis", `Impact of ${nodeLine(result.seed)}`), ui.section("Scope"), `  Profile: ${result.profile}, direction: ${result.direction}, depth: ${result.depth}, graph: ${graphState}`, ""];
    if (result.analysisQuality) {
        const c = result.analysisQuality.confidence;
        lines.push(ui.section("Evidence"), `  ${c.exact} exact  ${c.likely} likely  ${c.possible} possible  ${c.unknown} unknown`);
        if (result.analysisQuality.limitations.length) lines.push(`Limitations: ${result.analysisQuality.limitations.join(', ')}`);
        lines.push("");
    }
    lines.push(ui.section("Impacted nodes"));
    if (!result.impacted.length) lines.push("  No impacted nodes found.");
    for (const node of result.impacted) {
        const path = node.paths[0]?.map((step) => `${step.relType}${step.direction === "in" ? "←" : "→"}`).join(" ") || "";
        lines.push(`  ${node.distance} hop  ${node.confidence.padEnd(8)} ${nodeLine(node)}${path ? `  via ${path}` : ""}`);
    }
    for (const [section, values] of Object.entries(result.attachments)) {
        if (!values.length) continue;
        lines.push("", `${section[0].toUpperCase() + section.slice(1)} (${values.length})`);
        for (const node of values) lines.push(`  ${nodeLine(node)}`);
    }
    if (result.testSelection?.selected?.length) {
        lines.push("", `Tests to run first (${result.testSelection.selected.length})`);
        for (const test of result.testSelection.selected) lines.push(`  ${test.confidence.padEnd(8)} ${nodeLine(test)}`);
    } else if (result.testSelection) {
        lines.push("", `Tests: ${result.testSelection.note}`);
    }
    if (result.knowledgeReview?.candidates?.length) {
        lines.push("", `Knowledge to review (${result.knowledgeReview.candidates.length})`);
        for (const knowledge of result.knowledgeReview.candidates) lines.push(`  ${nodeLine(knowledge)}`);
        lines.push(`  ${result.knowledgeReview.note}`);
    }
    if (result.truncation.truncated) lines.push("", `TRUNCATED: at least ${result.truncation.omittedNodes} node(s) omitted (max ${result.truncation.maxNodes}).`);
    if (result.graphFreshness.state === "stale") lines.push("", "WARNING: graph is stale; all impact confidence is unknown.");
    return lines.join("\n");
}

export default async function impact(argv) {
    const opts = parseArgs(argv);
    const workspace = normalizeWorkspaceName(opts.db);
    const config = paths.loadConfig();
    const wsConfig = config.workspaces?.[workspace];
    if (!wsConfig) throw new Error(`Workspace ${opts.db} is not configured.`);
    const driver = ladybug.driver(wsConfig.dbUri || wsConfig.neo4jUri, ladybug.auth.basic(wsConfig.auth.user, wsConfig.auth.pass));
    const session = driver.session();
    try {
        const result = await analyzeImpactFromSession(session, {
            seed: opts.nodeId ? { id: opts.nodeId } : { name: opts.name, file: opts.file, label: opts.label },
            profile: opts.profile, ...(opts.direction ? { direction: opts.direction } : {}),
            ...(opts.depth != null ? { depth: opts.depth } : {}), ...(opts.maxNodes != null ? { maxNodes: opts.maxNodes } : {}),
            ...(opts.maxPathsPerNode != null ? { maxPathsPerNode: opts.maxPathsPerNode } : {}), relations: opts.relations || undefined,
            projectRoot: paths.PROJECT_ROOT, sourceDirs: wsConfig.sourceDir || [], exclude: wsConfig.exclude || [],
        });
        console.log(opts.json ? JSON.stringify(result, null, 2) : renderImpact(result));
    } finally {
        await session.close();
        await driver.close();
    }
}
