import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';

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
    return { created: false };
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
