const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const builder = require('../scripts/graph_builder.js');
const { readJournal, writeJournal } = require('../lib/rebuild-journal.cjs');
const spec = require('../scripts/spec/spec_db.cjs');

for (const change of ['changed', 'deleted']) {
  for (const failure of ['parse', 'delete']) {
    test(`incremental ${failure} failure journals ${change} file links before deletion`, async () => {
        const d = await openTestDb();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-diff-recovery-'));
        const journalPath = path.join(dir, 'recovery.json');
        try {
            const session = d.session;
            await session.run(`MERGE (f:File {path:'src/a.js'})
                CREATE (t:Task {taskId:'recover-diff'}) CREATE (k:Knowledge {name:'rule'})
                CREATE (t)-[:AFFECTS]->(f) CREATE (k)-[:APPLIES_TO]->(f)`);
            const file = path.resolve(__dirname, '../scripts/graph_builder.js');
            const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
            let block;
            const visit = n => {
                if (ts.isIfStatement(n) && n.expression.getText(tree) === 'isDiffMode') block = n.thenStatement;
                ts.forEachChild(n, visit);
            };
            visit(tree);
            const helpers = builder.__testing__;
            await assert.rejects(vm.runInNewContext(`(async()=>${block.getText(tree)})()`, {
                ...helpers, session, console, journalPath, writeJournal,
                identity: { expected: { fingerprint: 'fixture' } },
                allFiles: ['src/b.js'], allRelativePaths: new Set(['src/b.js']), baseDir: '.',
                langCache: {}, parser: {}, extractors: { enabled: [] }, recoveryRestored: false,
                relGraphPath: (_, p) => p,
                getMtimeChangedFiles: async () => change === 'changed' ? ['src/a.js'] : [],
                getDeletedFilePaths: async () => change === 'deleted' ? ['src/a.js'] : [],
                getDirectDependentFiles: async () => [],
                removeFileDerivedNodes: async (...args) => {
                    await helpers.removeFileDerivedNodes(...args);
                    if (failure === 'delete') throw new Error('injected incremental delete failure');
                },
                removeDeletedFileNodes: async () => {
                    if (change !== 'deleted') return [];
                    const backup = await helpers.backupFileLinks(session, ['src/a.js']);
                    await helpers.removeFileDerivedNodes(session, ['src/a.js']);
                    return [backup];
                },
                parseFiles: async () => { throw new Error('injected incremental parse failure'); },
            }), /injected incremental (parse|delete) failure/);
            assert.equal(Number((await session.run('MATCH ()-[:AFFECTS]->() RETURN count(*) AS n')).records[0].get('n')), 0);
            const saved = readJournal(journalPath);
            assert.ok(saved, 'authored links must survive loss of the builder process');
            assert.equal(saved.backup.affects.length, 1);
            assert.equal(saved.backup.knowledge.length, 1);
            const recovered = writeJournal(journalPath, 'fixture', await helpers.backupLocksAndAffects(session));
            await session.run("MERGE (f:File {path:'src/a.js'})");
            const restored = await helpers.restoreLocksAndAffects(session, recovered);
            assert.equal(restored.edgesRestored, 1);
            assert.equal(restored.knowledgeRestored, 1);
        } finally { await d.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('failed full build retains a durable authored-link backup for a later process', async () => {
    const d = await openTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-recovery-'));
    const journalPath = path.join(dir, 'recovery.json');
    try {
        const session = d.session;
        await session.run("MERGE (f:File {path:'src/a.js'}) CREATE (t:Task {taskId:'recover'}) CREATE (t)-[:AFFECTS]->(f)");
        const file = path.resolve(__dirname, '../scripts/graph_builder.js');
        const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        let block;
        const visit = n => {
            if (ts.isIfStatement(n) && n.elseStatement && ts.isBlock(n.elseStatement)
                && n.elseStatement.statements.some(s => ts.isVariableStatement(s)
                    && s.declarationList.declarations.some(d => d.name.getText(tree) === 'fullBackup'))) block = n.elseStatement;
            ts.forEachChild(n, visit);
        };
        visit(tree);
        await assert.rejects(vm.runInNewContext(`(async()=>${block.getText(tree)})()`, {
            session, console, journalPath, identity: { expected: { fingerprint: 'fixture' } }, writeJournal,
            ...builder.__testing__, PRESERVED_LABELS: builder.PRESERVED_LABELS,
            allFiles: ['src/a.js'], baseDir: '.', allRelativePaths: ['src/a.js'], langCache: {}, parser: {},
            extractors: { enabled: [] }, parseFiles: async () => { throw new Error('injected failure'); },
        }), /injected failure/);
        assert.equal(readJournal(journalPath).backup.affects.length, 1);
        // A new process can merge a fresh (now empty) graph backup without
        // erasing the recovery information saved by its predecessor.
        const recovered = writeJournal(journalPath, 'fixture', await builder.__testing__.backupLocksAndAffects(session));
        await session.run("MERGE (f:File {path:'src/a.js'})");
        await builder.__testing__.restoreLocksAndAffects(session, recovered);
        const result = await session.run("MATCH (t:Task {taskId:'recover'})-[:AFFECTS]->(f) RETURN count(f) AS n");
        assert.equal(Number(result.records[0].get('n')), 1);
        assert.throws(() => writeJournal(journalPath, 'another-project', recovered), /different sources/);
    } finally { await d.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spec replacement rolls back failed writes and preserves manual bindings', async () => {
    const d = await openTestDb();
    const s = d.session;
    const text = '@startuml\nclass LogicalService {\n+ run()\n}\n@enduml';
    try {
        await s.run("CREATE (c:Class {name:'Implementation', file:'src/service.js'})");
        await spec.importSpec(s, { text, specId: 'audit', kind: 'class' });
        await spec.bindSpec(s, 'audit', [{ alias: 'LogicalService', target: 'Implementation' }]);
        await s.run("MATCH (p:SpecClass {name:'LogicalService'}) CREATE (t:Task {taskId:'spec-task'}) CREATE (p)-[:APPLIES_TO]->(t)");
        const count = async () => Number((await s.run('MATCH (p:SpecClass)-[:REALIZED_BY]->(c) RETURN count(c) AS n')).records[0].get('n'));
        const imported = await spec.importSpec(s, { text, specId: 'audit', kind: 'class' });
        assert.deepEqual(imported.needsBinding, []);
        assert.equal((await s.run("MATCH (p:SpecClass)-[:APPLIES_TO]->(t:Task {taskId:'spec-task'}) RETURN p.name AS name")).records.length, 1);
        assert.equal(await count(), 1);
        const originalRun = s.run.bind(s);
        s.run = async (query, params) => {
            if (query.includes('CREATE (s:SpecClassDiagram')) throw new Error('injected post-delete failure');
            return originalRun(query, params);
        };
        await assert.rejects(spec.importSpec(s, { text: text.replace('run', 'work'), specId: 'audit', kind: 'class' }), /injected/);
        s.run = originalRun;
        assert.equal((await spec.getSpecSource(s, 'audit')).source, text);
        assert.equal(await count(), 1);
        await assert.rejects(spec.importSpec(s, { text: 'A -> B: run()', specId: 'audit', kind: 'sequence' }), /new specId/);
        assert.equal((await spec.listSpecs(s)).length, 1);
    } finally { await d.cleanup(); }
});
