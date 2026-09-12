const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const panel = fs.readFileSync(path.join(root, 'frontend', 'src', 'components', 'DocumentationPanel.jsx'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const frontendPkg = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'package.json'), 'utf8'));

test('rendered documentation links reach packaged guides while anchors and screenshots stay local', () => {
  const sourceCallback = require('./helpers/source-callback.cjs');
  const { JSDOM } = require(path.join(root, 'frontend/node_modules/jsdom'));
  const createDOMPurify = require(path.join(root, 'frontend/node_modules/dompurify'));
  const { marked } = require(path.join(root, 'frontend/node_modules/marked'));
  const window = new JSDOM('').window;
  try {
    const render = sourceCallback(path.join(root, 'frontend/src/components/DocumentationPanel.jsx'), 'renderMarkdown', {
      marked, DOMPurify: createDOMPurify(window), addHeadingIds: html => html,
      resolveDocumentationPath: (currentPath, linkedPath) => `${currentPath === 'README.md' ? '' : 'docs/'}${linkedPath}`,
    });
    const html = render('[Guide](docs/USER_WORKFLOW.md#build-and-open)\n[Roadmap](docs/PRODUCT_ROADMAP.md)\n[Here](#install)\n![Graph](docs/screenshots/overview.png)\n[Bad](javascript:alert%281%29)');
    assert.match(html, /href="#doc=docs%2FUSER_WORKFLOW\.md&amp;anchor=build-and-open"/);
    assert.match(html, /href="#doc=docs%2FPRODUCT_ROADMAP\.md"/);
    assert.match(html, /href="#install"/);
    assert.match(html, /src="docs\/screenshots\/overview.png"/);
    assert.doesNotMatch(html, /href="javascript:/);
  } finally { window.close(); }
});

test('dashboard documentation sanitizes rendered Markdown before inserting HTML', () => {
  assert.match(panel, /import DOMPurify from 'dompurify'/);
  assert.match(panel, /DOMPurify\.sanitize\(html/);
  assert.match(panel, /FORBID_TAGS:[\s\S]*'iframe'[\s\S]*'form'/);
  assert.doesNotMatch(panel, /html:\s*addHeadingIds\(marked\.parse/);
});

test('the shipped dashboard documentation exposes CLI and agent function references', () => {
  assert.match(readme, /^## CLI command reference$/m);
  assert.match(readme, /^## MCP tools$/m);
  assert.match(readme, /codevis help <command>/);
  assert.match(readme, /`project_db`, `codevis_db`, `predefined_queries`/);
  assert.match(readme, /\*\*Epics:\*\*.*`create_epic`.*`set_epic_task_order`/);
  assert.match(readme, /\| 📚 Context \|/);
  assert.doesNotMatch(readme, /uids come from a per-database sequence counter/);
  assert.match(readme, /Kotlin\s+delegation, Go embedding, and Rust trait implementations/);
});

test('dashboard guide links stay on the version-matched local documentation endpoint', () => {
  assert.match(panel, /api\/docs\?file=/);
  assert.match(panel, /a\[href\^=\"#doc=\"\]/);
  assert.doesNotMatch(panel, /github\.com\/JACEGE\/Codevis\/blob\/main/);
});

test('release dependency audit covers the separately locked frontend', () => {
  assert.match(pkg.scripts['audit:dependencies'], /npm --prefix frontend audit --omit=dev/);
  assert.ok(frontendPkg.dependencies.dompurify);
  assert.equal(frontendPkg.dependencies['node-pty'], undefined);
  assert.equal(frontendPkg.dependencies.ws, undefined);
});

test('the browser sanitizer removes executable Markdown while preserving documentation markup', async () => {
  const { JSDOM } = require(path.join(root, 'frontend', 'node_modules', 'jsdom'));
  const createDOMPurify = require(path.join(root, 'frontend', 'node_modules', 'dompurify'));
  const { marked } = require(path.join(root, 'frontend', 'node_modules', 'marked'));
  const window = new JSDOM('').window;
  try {
    const DOMPurify = createDOMPurify(window);
    const dirty = `# Safe heading

| A | B |
| - | - |
| 1 | 2 |

<img src=x onerror="globalThis.pwned=1">
<script>globalThis.pwned=2</script>
<iframe srcdoc="<script>parent.pwned=3</script>"></iframe>
<form><input autofocus onfocus="globalThis.pwned=4"></form>
[bad](javascript:globalThis.pwned=5)`;
    const html = DOMPurify.sanitize(marked.parse(dirty, { gfm: true }), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option'],
    });
    assert.match(html, /<h1>Safe heading<\/h1>/);
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /onerror|onfocus|<script|<iframe|<form|<input|href=["']javascript:/i);
  } finally {
    window.close();
  }
});
