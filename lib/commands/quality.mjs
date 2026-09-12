import { resolve, dirname } from "path";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import ui from "../terminal-ui.cjs";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const ladybug = require(resolve(packageRoot, "server/ladybug-driver.cjs"));
const paths = require(resolve(packageRoot, "server/codevis-paths.cjs"));
const { normalizeWorkspaceName } = require(resolve(packageRoot, "lib/workspace-names.cjs"));
const { buildAnalysisQualityReport } = require(resolve(packageRoot, "scripts/parser/analysis_quality_report.cjs"));
const { createQualityBaseline, evaluateQualityBaseline, evaluateQualityGates } = require(resolve(packageRoot, "scripts/parser/analysis_quality_gate.cjs"));
const { __testing__: { EXTRACTOR_CAPABILITIES } } = require(resolve(packageRoot, "scripts/graph_builder.js"));
export function parseArgs(argv) {
  const opts = { db: "project_db", json: false, minResolution: null, maxParseErrors: null, requiredCapabilities: [], baseline: null, writeBaseline: null, maxRegression: 0 };
  const valueAfter = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") opts.db = valueAfter(i++, arg);
    else if (arg === "--json") opts.json = true;
    else if (arg === "--min-resolution") opts.minResolution = Number(valueAfter(i++, arg));
    else if (arg === "--max-parse-errors") opts.maxParseErrors = Number(valueAfter(i++, arg));
    else if (arg === "--require-capability") opts.requiredCapabilities.push(valueAfter(i++, arg));
    else if (arg === "--baseline") opts.baseline = valueAfter(i++, arg);
    else if (arg === "--write-baseline") opts.writeBaseline = valueAfter(i++, arg);
    else if (arg === "--max-regression") opts.maxRegression = Number(valueAfter(i++, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }
  normalizeWorkspaceName(opts.db);
  if (opts.minResolution != null && (!Number.isFinite(opts.minResolution) || opts.minResolution < 0 || opts.minResolution > 100)) throw new Error("--min-resolution must be from 0 to 100");
  if (opts.maxParseErrors != null && (!Number.isInteger(opts.maxParseErrors) || opts.maxParseErrors < 0)) throw new Error("--max-parse-errors must be a non-negative integer");
  if (!Number.isFinite(opts.maxRegression) || opts.maxRegression < 0 || opts.maxRegression > 100) throw new Error("--max-regression must be from 0 to 100");
  if (opts.baseline && opts.writeBaseline) throw new Error("Use either --baseline or --write-baseline, not both");
  return opts;
}
export function renderQuality(report) {
  const freshness = report.graphFreshness?.state || "unknown";
  const lines = [ui.title("CodeVis", "analysis quality"), `  Graph: ${freshness}`];
  if (freshness !== "current") lines.push("  Rebuild the graph before using these measurements as a quality gate or baseline.");
  lines.push(ui.section("Languages"));
  for (const row of report.measured) {
    const legacy = row.legacyOverallResolutionPercent != null;
    const resolution = row.internalResolutionPercent != null ? `${row.internalResolutionPercent}% internal`
      : legacy ? `${row.legacyOverallResolutionPercent}% legacy overall` : "n/a";
    const calls = legacy ? `all calls ${row.resolvedInternalSites}/${row.allSites}` : `internal calls ${row.resolvedInternalSites}/${row.internalSites}`;
    const state = freshness !== "current" || row.parseErrors > 0 ? ui.badge("WARN", "yellow") : ui.badge("OK", "green");
    lines.push(`  ${state} ${row.language.padEnd(8)} files ${String(row.files).padStart(4)}  parse errors ${String(row.parseErrors).padStart(3)}  ${calls}  resolution ${resolution}`);
  }
  lines.push("", ui.section("Notes"), `  ${report.note}`);
  return lines.join("\n");
}

export default async function quality(argv) {
  const opts = parseArgs(argv);
  const workspace = normalizeWorkspaceName(opts.db);
  const config = paths.loadConfig();
  const ws = config.workspaces?.[workspace];
  if (!ws) throw new Error(`Workspace ${opts.db} is not configured.`);
  const driver = ladybug.driver(ws.dbUri || ws.neo4jUri, ladybug.auth.basic(ws.auth.user, ws.auth.pass));
  const session = driver.session();
  try {
    const report = await buildAnalysisQualityReport(session, EXTRACTOR_CAPABILITIES, {
      projectRoot: paths.PROJECT_ROOT, sourceDirs: ws.sourceDir || [], exclude: ws.exclude || [],
    });
    const absoluteGate = evaluateQualityGates(report, opts);
    const baselineGate = opts.baseline
      ? evaluateQualityBaseline(report, JSON.parse(readFileSync(resolve(opts.baseline), "utf8")), opts)
      : { passed: true, failures: [] };
    const gate = { passed: absoluteGate.passed && baselineGate.passed, failures: [...absoluteGate.failures, ...baselineGate.failures] };
    console.log(opts.json ? JSON.stringify({ ...report, gate }, null, 2) : renderQuality(report));
    if (!gate.passed) {
      const error = new Error(`Analysis quality gate failed: ${JSON.stringify(gate.failures)}`);
      error.code = "QUALITY_GATE_FAILED";
      throw error;
    }
    if (opts.writeBaseline) writeFileSync(resolve(opts.writeBaseline), `${JSON.stringify(createQualityBaseline(report), null, 2)}\n`);
  } finally {
    await session.close();
    await driver.close();
  }
}
