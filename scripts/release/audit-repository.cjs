#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SENSITIVE_NAMES = /(^|\/)(\.env($|\.)|\.npmrc$|[^/]+\.(pem|key|p12|pfx)$)/i;
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['credential assignment', /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];
const ABSOLUTE_USER_PATH = /(?:[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n"']+[\\/]+|\/(?:Users|home)\/[^/\r\n"']+\/)/;

function auditFiles(files, { root = ROOT, readFile = fs.readFileSync } = {}) {
  const findings = [];
  for (const relative of files) {
    const normalized = relative.replaceAll('\\', '/');
    if (SENSITIVE_NAMES.test(normalized)) {
      findings.push({ file: normalized, line: 0, kind: 'sensitive filename' });
      continue;
    }
    let text;
    try { text = readFile(path.join(root, relative), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      for (const [kind, pattern] of SECRET_PATTERNS) {
        if (pattern.test(line)) findings.push({ file: normalized, line: index + 1, kind });
      }
      if (!normalized.startsWith('tests/') && ABSOLUTE_USER_PATH.test(line)) {
        findings.push({ file: normalized, line: index + 1, kind: 'machine-specific absolute path' });
      }
    }
  }
  return findings;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

if (require.main === module) {
  const findings = auditFiles(trackedFiles());
  if (findings.length) {
    console.error('[release-audit] Potential publish blockers:');
    for (const finding of findings) {
      console.error(`  ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.kind}`);
    }
    process.exitCode = 1;
  } else {
    console.log('[release-audit] No tracked credentials or machine-specific user paths found.');
  }
}

module.exports = { auditFiles };
