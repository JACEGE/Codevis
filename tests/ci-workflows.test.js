const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('CI installs dependencies required by frontend-backed tests', () => {
    const source = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(source, /npm ci --prefix frontend/);
    assert.match(source, /frontend\/package-lock\.json/);
});

test('Linux CI selects sandbox-compatible system Chrome before installing or running browser tests', () => {
    const source = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const start = source.indexOf('- name: Use sandboxed system Chrome on Linux');
    const install = source.indexOf('- run: npm ci');
    assert.ok(start >= 0 && start < install, 'configure Chrome before Puppeteer installation');
    const setup = source.slice(start, install);
    assert.match(setup, /if: runner\.os == 'Linux'/);
    assert.match(setup, /shell: bash/);
    assert.match(setup, /test -x \/opt\/google\/chrome\/chrome/);
    assert.match(setup, /echo "PUPPETEER_EXECUTABLE_PATH=\/opt\/google\/chrome\/chrome" >> "\$GITHUB_ENV"/);
    assert.match(setup, /\/opt\/google\/chrome\/chrome --version/);
    assert.doesNotMatch(source, /--no-sandbox|--disable-setuid-sandbox|apparmor_restrict_unprivileged_userns|SKIP_BROWSER_TESTS/);
});
