const fs = require('node:fs');
const path = require('node:path');

const DOCUMENTATION_FILES = Object.freeze([
  'README.md',
  'docs/README.md',
  'docs/USER_WORKFLOW.md',
  'docs/NAVIGATION.md',
  'docs/DATABASE_NAMES.md',
  'docs/CONTEXT_WORKFLOW.md',
  'docs/DEAD_CODE_AND_LIMITS.md',
  'docs/PARSER_COVERAGE.md',
  'docs/EXTRACTOR_SDK.md',
  'docs/PRODUCT_ROADMAP.md',
  'docs/TEST_COVERAGE.md',
]);

const allowedFiles = new Set(DOCUMENTATION_FILES);

function normalizeDocumentationFile(value) {
  const normalized = String(value || 'README.md').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  return allowedFiles.has(normalized) ? normalized : null;
}

function readDocumentationFile(root, requestedFile, readFile = fs.readFileSync) {
  const relative = normalizeDocumentationFile(requestedFile);
  if (!relative) {
    const error = new Error('Documentation file not found');
    error.status = 404;
    throw error;
  }
  return {
    relative,
    markdown: readFile(path.join(root, ...relative.split('/')), 'utf8'),
  };
}

module.exports = { DOCUMENTATION_FILES, normalizeDocumentationFile, readDocumentationFile };
