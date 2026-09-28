'use strict';
const path = require('node:path');
const STATUSES = new Set(['pass', 'fail', 'skipped', 'todo']);
function testFile(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error('Test file must be project-relative');
  const file = value.replace(/\\/g, '/');
  if (file.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('Invalid test file path');
  return file;
}
function parseTestReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8*1024*1024) throw new Error('Test report exceeds 8 MiB');
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('Test report stdout must be one CodeVis JSON document'); }
  if (report?.version !== 1 || !Array.isArray(report.tests) || report.tests.length > 10000) throw new Error('Expected version 1 test report with at most 10000 tests');
  return { version: 1, tests: report.tests.map(t => {
    if (!t || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 2000 || !STATUSES.has(t.status)) throw new Error('Invalid test observation');
    if (t.line != null && (!Number.isSafeInteger(t.line) || t.line < 1)) throw new Error('Invalid test line');
    if (t.durationMs != null && (!Number.isFinite(t.durationMs) || t.durationMs < 0)) throw new Error('Invalid test duration');
    return { file: testFile(t.file), name: t.name, status: t.status, ...(t.line != null ? {line:t.line} : {}),
      ...(t.durationMs != null ? {durationMs:t.durationMs} : {}), ...(t.message ? {message:String(t.message).slice(0,4000)} : {}) };
  }) };
}
function observedChecks(evidence, definitions) {
  return evidence.checks.map((check, i) => {
    const { output, testOutput, report, reportError, ...execution } = check;
    const normalized = {...definitions[i],exitCode:execution.exitCode,durationMs:execution.durationMs};
    if (definitions[i].testReport) {
      try { normalized.report = parseTestReport(testOutput); }
      catch (error) { normalized.reportError = error.message; }
    }
    return normalized;
  });
}
module.exports = { testFile, parseTestReport, observedChecks };
