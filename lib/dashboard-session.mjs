import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
const { publicWorkspaceName } = createRequire(import.meta.url)('./workspace-names.cjs');

function identity(value) {
  if (typeof value !== 'string' || !value) return null;
  let result = resolve(value);
  try { result = realpathSync(result); } catch { /* Compare the reported spelling. */ }
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

export function dashboardMatches(status, { projectRoot, dataDir }) {
  const project = identity(projectRoot), data = identity(dataDir);
  return project !== null && data !== null
    && identity(status?.projectRoot) === project && identity(status?.dataDir) === data;
}

/** Reuse only this project's bridge. Never switch a foreign service's database. */
export async function reuseDashboard({ port, projectRoot, dataDir, db, webShell = false, fetchImpl = fetch }) {
  const base = `http://127.0.0.1:${port}`;
  let response;
  try {
    response = await fetchImpl(`${base}/api/status`, { signal: AbortSignal.timeout(2000) });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') return null;
    throw new Error(`Cannot identify the dashboard on port ${port}: ${error.message}`);
  }
  let status;
  try { status = await response.json(); } catch { /* Not a CodeVis response. */ }
  if (!response.ok || !dashboardMatches(status, { projectRoot, dataDir })) {
    throw new Error(`Port ${port} belongs to another service or project. Use --port with a free port; no database was switched.`);
  }
  if (webShell && !status.webShellEnabled) {
    throw new Error('The running dashboard has its browser shell disabled. Stop it before restarting with --web-shell.');
  }
  if (db && publicWorkspaceName(status.activeDb) !== publicWorkspaceName(db)) {
    const switched = await fetchImpl(`${base}/api/switch-db`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: publicWorkspaceName(db) }), signal: AbortSignal.timeout(60000),
    });
    const result = await switched.json();
    if (!switched.ok) throw new Error(`Could not switch the running dashboard: ${result.error || `HTTP ${switched.status}`}. Use Settings to unlock a protected database.`);
    if (publicWorkspaceName(result.activeDb) !== publicWorkspaceName(db)) throw new Error('The running dashboard did not confirm the requested database.');
    status = { ...status, activeDb: result.activeDb };
  }
  return status;
}
