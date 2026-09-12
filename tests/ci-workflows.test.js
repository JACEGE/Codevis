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
