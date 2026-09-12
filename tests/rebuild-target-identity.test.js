const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { PRESERVED_LABELS, __testing__: { backupLocksAndAffects, restoreLocksAndAffects, removeFileDerivedNodes } } = require('../scripts/graph_builder.js');

for (const mode of ['full', 'incremental']) for (const renamed of [false, true]) {
    test(`${mode} rebuild preserves exact method ownership${renamed ? ' after a rename' : ''}`, async () => {
        const { session, cleanup } = await openTestDb();
        const file = 'src/classes.js';
        const create = name => session.run(`
            CREATE (:Function {name:$name, owner:'A', file:$file, bodySnippet:'return 1;', params:'()'})
            CREATE (:Function {name:$name, owner:'B', file:$file, bodySnippet:'return 2;', params:'()'})
        `, { name, file });
        try {
            await create('run');
            await session.run(`
                MATCH (a:Function {owner:'A'})
                CREATE (t:Task {taskId:'identity-task'})
                CREATE (k:Knowledge {name:'Keep ownership'})
                CREATE (t)-[:AFFECTS]->(a)
                CREATE (t)-[:TOUCHED {kind:'edit', at:42}]->(a)
                CREATE (k)-[:APPLIES_TO]->(a)
                SET a.locked=true, a.lockedBy='worker', a.lockGroup='identity-task'
            `);
            const backup = await backupLocksAndAffects(session, mode === 'incremental' ? 'AND n.file = $file' : '', mode === 'incremental' ? { file } : {});
            if (mode === 'incremental') await removeFileDerivedNodes(session, [file]);
            else await session.run('MATCH (n) WHERE ' + PRESERVED_LABELS.map(label => `NOT n:${label}`).join(' AND ') + ' DETACH DELETE n');
            await create(renamed ? 'execute' : 'run');
            const result = await restoreLocksAndAffects(session, backup);
            assert.equal(result.edgesRestored, 1);
            assert.equal(result.touchedRestored, 1);
            assert.equal(result.knowledgeRestored, 1);
            assert.equal(result.lockRestored, 1);
            for (const relationship of ['AFFECTS', 'TOUCHED', 'APPLIES_TO']) {
                const links = await session.run(`MATCH ()-[:${relationship}]->(f:Function) RETURN f.owner AS owner`);
                assert.deepEqual(links.records.map(row => row.get('owner')), ['A']);
            }
            const locks = await session.run('MATCH (f:Function) WHERE f.locked = true RETURN f.owner AS owner');
            assert.deepEqual(locks.records.map(row => row.get('owner')), ['A']);
        } finally { await cleanup(); }
    });
}
