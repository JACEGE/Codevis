const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

for (const outcome of ['found', 'missing', 'graph-error']) {
    test(`read_function releases its syntax tree on ${outcome}`, async () => {
        const source = ts.createSourceFile('edit-tools.ts', fs.readFileSync(path.resolve(__dirname, '../tools/handlers/edit-tools.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
        let handler;
        const visit = node => {
            if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'read_function') handler = node.initializer;
            ts.forEachChild(node, visit);
        };
        visit(source);
        let deleted = 0;
        const tree = { delete() { deleted++; } };
        const mod = { exports: {} };
        vm.runInNewContext(ts.transpile(`module.exports = ${handler.getText(source)}`, { target: ts.ScriptTarget.ES2022 }), require('./helpers/file-publication.cjs')({
            module: mod, ...path, PROJECT_ROOT: process.cwd(), isPathAllowed: () => true,
            readFileSync: () => 'function work() {}',
            getLanguageAndQuery: async () => ({}),
            getParserInstance: () => ({ setLanguage() {}, parse: () => tree }),
            findFunctionInAST: () => outcome === 'missing' ? null : { node: { text: 'function work() {}' }, startLine: 1, endLine: 1 },
            pickDbDriver: () => ({ session: () => ({
                run: async () => { if (outcome === 'graph-error') throw new Error('offline'); return { records: [] }; },
                close: async () => {},
            }) }),
        }));
        const response = await mod.exports({ file: 'source.js', functionName: 'work' }, {});
        assert.equal(Boolean(response.isError), outcome !== 'found');
        assert.equal(deleted, 1);
    });
}
