'use strict';
const path = require('node:path');
// Runner output only: console output arrives as other events and is not JSON evidence.
module.exports = async function* codeflowReporter(source) {
  const tests = [];
  for await (const event of source) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const data = event.data;
    if (data.details?.type === 'suite' || !data.file) continue;
    tests.push({ file: path.relative(process.cwd(), data.file).replace(/\\/g, '/'),
      name: data.name, line: data.line,
      status: data.skip ? 'skipped' : data.todo ? 'todo' : event.type === 'test:pass' ? 'pass' : 'fail',
      durationMs: data.details?.duration_ms,
      message: data.details?.error?.cause?.message || data.details?.error?.message });
  }
  yield JSON.stringify({ version: 1, tests }) + '\n';
};
