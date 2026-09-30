import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';

/**
 * A project that was moved or copied (another folder, Windows → WSL) keeps a
 * codevis_graph entry pointing at the OLD location: Codex would then start the
 * old checkout and write into the old project's database. Only the location
 * values are replaced, textually, so comments and the user's own settings
 * (enabled, tool lists, timeouts) stay as they are.
 */
function relocateCodex(file, text, server, projectRoot, mcpServerPath) {
  const oldRoot = server.env?.CODEVIS_PROJECT_DIR ?? server.cwd;
  if (typeof oldRoot !== 'string' || resolve(oldRoot) === resolve(projectRoot)) return { created: false };
  // TOML basic strings escape exactly like JSON strings for paths.
  const toml = (value) => JSON.stringify(value);
  const replacements = [
    [server.command, process.execPath],
    [server.args?.[0], mcpServerPath],
    [server.cwd, projectRoot],
    [server.env?.CODEVIS_PROJECT_DIR, projectRoot],
  ].filter(([from]) => typeof from === 'string');
  let content = text;
  for (const [from, to] of replacements) content = content.split(toml(from)).join(toml(to));
  const moved = parse(content).mcp_servers?.codevis_graph;
  if (moved?.env?.CODEVIS_PROJECT_DIR !== undefined && moved.env.CODEVIS_PROJECT_DIR !== projectRoot) {
    throw new Error(`.codex/config.toml points codevis_graph at ${oldRoot}; update it to ${projectRoot} or remove that entry and rerun init. The file was not changed.`);
  }
  writeFileSync(file, content, 'utf8');
  return { created: false, relocated: oldRoot };
}

/** Add project-local MCP configuration without rewriting user-owned TOML. */
export function configureCodex(projectRoot, mcpServerPath) {
  const file = resolve(projectRoot, '.codex/config.toml');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let config;
  try {
    config = parse(existing);
  } catch {
    // Parser diagnostics can contain secrets from nearby configuration lines.
    throw new Error('Invalid .codex/config.toml; fix its TOML syntax and rerun init. The file was not changed.');
  }

  // Explicit user settings (including disabled servers and restricted tool
  // lists) take precedence. Re-init must not silently expand permissions.
  if (Object.hasOwn(config.mcp_servers || {}, 'codevis_graph')) {
    return relocateCodex(file, existing, config.mcp_servers.codevis_graph, projectRoot, mcpServerPath);
  }

  const server = {
    command: process.execPath,
    args: [mcpServerPath, 'start'],
    cwd: projectRoot,
    enabled: true,
    startup_timeout_sec: 60,
    tool_timeout_sec: 300,
    env: { CODEVIS_PROJECT_DIR: projectRoot, CODEVIS_ROLE: 'lead' },
  };
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const block = stringify({ mcp_servers: { codevis_graph: server } }).replace(/\n/g, newline);
  const content = existing + (existing && !existing.endsWith('\n') ? newline : '')
    + newline + '# CodeVis MCP (project-local). Restart Codex after setup.' + newline + block + newline;
  try {
    // Inline mcp_servers tables cannot be extended with table headers.
    // Refuse rather than losing comments by reserializing the user's file.
    parse(content);
  } catch {
    throw new Error('Cannot extend .codex/config.toml safely. Use [mcp_servers.<name>] tables instead of an inline mcp_servers value, then rerun init. The file was not changed.');
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return { created: true };
}
