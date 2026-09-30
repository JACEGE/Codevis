const test = require('node:test');
const assert = require('node:assert/strict');
const { SHAPES, PHASE_LINKS, allowedLinks } = require('../lib/workflow/submission.cjs');
const { phaseInstructions } = require('../lib/workflow/instructions.cjs');
const fs = require('node:fs');
const path = require('node:path');

test('every phase tells the agent which links it accepts, from the table the check enforces', () => {
    const planning = phaseInstructions({ status: 'active', currentPhase: 'planning', revision: 1 });
    assert.deepEqual(planning.allowedLinks.map(l => l.type), ['IMPLEMENTS', 'REFERENCES']);
    assert.deepEqual(planning.allowedLinks[0], { type: 'IMPLEMENTS', from: ['Task'], to: ['Requirement', 'TestCase'] });
    assert.ok(allowedLinks('analysis').some(l => l.type === 'IMPACTS' && /analysis/.test(l.from[0])));
    for (const type of Object.keys(PHASE_LINKS)) assert.ok(SHAPES[type], type + ' has a shape');
    // Every authorable type is allowed in at least one phase.
    const phases = ['requirements', 'analysis', 'architecture', 'planning', 'development', 'quality', 'review'];
    for (const type of Object.keys(SHAPES)) assert.ok(phases.some(p => allowedLinks(p).some(l => l.type === type)), type);
});

test('the MCP schema lists exactly the authorable link types', () => {
    const source = fs.readFileSync(path.join(__dirname, '../tools/handlers/change-tools.ts'), 'utf8');
    const listed = /type:\{type:'string',enum:\[([^\]]+)\]/.exec(source.slice(source.indexOf('links:')))[1].match(/'([A-Z_]+)'/g).map(s => s.slice(1, -1));
    assert.deepEqual([...listed].sort(), Object.keys(SHAPES).sort());
});
