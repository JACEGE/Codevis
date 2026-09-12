const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the compact Done cards import their agent-color helper', () => {
    const source = fs.readFileSync(path.join(__dirname, '../frontend/src/components/KanbanDoneColumn.jsx'), 'utf8');
    assert.match(source, /import \{ getAgentColor \} from '\.\/KanbanTaskCard';/);
    assert.match(source, /getAgentColor\(task\.assignedTo\)/);
});

test('bulk move relies on requestJson rejection instead of reading Response.ok from JSON', () => {
    const source = fs.readFileSync(path.join(__dirname, '../frontend/src/hooks/useBulkTaskMove.js'), 'utf8');
    assert.doesNotMatch(source, /requestJson\([\s\S]*?\/status[\s\S]*?\.then\(res =>[^}]*res\.ok/);
});

test('comment item routes place the id before the database query string', () => {
    const source = fs.readFileSync(path.join(__dirname, '../frontend/src/hooks/useTaskDetails.js'), 'utf8');
    assert.match(source, /comments\$\{suffix\}\?db=/);
    assert.doesNotMatch(source, /comments\?db=.*\$\{suffix\}/);
});
