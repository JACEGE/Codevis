const test = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { PRESERVED_LABELS, __testing__: { backupFileLinks, backupLocksAndAffects, restoreLocksAndAffects, removeFileDerivedNodes } } = require('../scripts/graph_builder.js');
const annotations = require('../scripts/annotations/annotation_db.cjs');

for (const mode of ['full', 'incremental']) {
    test(`${mode} rebuild preserves File task, knowledge, history and lock targets`, async () => {
        const { session, cleanup } = await openTestDb();
        try {
            await session.run(`MERGE (f:File {path:'src/a.js'})
                CREATE (t:Task {taskId:'file-task'}) CREATE (k:Knowledge {name:'rule'})
                CREATE (t)-[:AFFECTS]->(f) CREATE (t)-[:TOUCHED {at:42,kind:'edit'}]->(f)
                CREATE (k)-[:APPLIES_TO]->(f)
                SET f.locked=true, f.lockGroup='file-task', f.lockedBy='worker'`);
            const backup = mode === 'full' ? await backupLocksAndAffects(session) : await backupFileLinks(session, ['src/a.js']);
            for (const key of ['affects', 'knowledge', 'touched', 'locks']) assert.equal(backup[key].length, 1);
            await removeFileDerivedNodes(session, ['src/a.js']);
            await session.run("MERGE (f:File {path:'src/a.js'}) RETURN f");
            const restored = await restoreLocksAndAffects(session, backup);
            for (const key of ['edgesRestored', 'knowledgeRestored', 'touchedRestored', 'lockRestored']) assert.equal(restored[key], 1);
        } finally { await cleanup(); }
    });

    for (const change of ['unchanged', 'rename', 'move', 'ambiguous']) {
        test(`${mode} annotation-only rebuild: ${change}`, async () => {
            const { session, cleanup } = await openTestDb();
            const create = (name, file) => session.run(`MERGE (f:Function {name:$name,file:$file,owner:''})
                SET f.bodySnippet='return bill * 1.2;', f.params='bill' RETURN elementId(f) AS uid`, { name, file });
            try {
                const original = await create('run', 'src/a.js');
                const tag = await annotations.createAnnotation(session, { targetNode:original.records[0].get('uid'), tag:'domain:billing', evidence:'Computes the billed amount.', confidence:0.9, weight:0.8 });
                await annotations.updateAnnotationStatus(session, tag.annotationId, 'accepted');
                const backup = mode === 'full' ? await backupLocksAndAffects(session) : await backupFileLinks(session, ['src/a.js']);
                assert.equal(backup.annotations.length, 1);
                if (mode === 'full') await session.run('MATCH (n) WHERE ' + PRESERVED_LABELS.map(label=>`NOT n:${label}`).join(' AND ') + ' DETACH DELETE n');
                else await removeFileDerivedNodes(session, ['src/a.js']);
                const rebuilt = await create(change === 'unchanged' ? 'run' : 'execute', change === 'move' ? 'src/b.js' : 'src/a.js');
                if (change === 'ambiguous') await create('duplicate', 'src/a.js');
                await restoreLocksAndAffects(session, backup);
                await annotations.relinkAnnotations(session);
                const listed = await annotations.listAnnotations(session);
                assert.equal(listed.length, 1);
                assert.equal(listed[0].status, 'accepted');
                assert.equal(listed[0].confidence, 0.9);
                assert.equal(listed[0].targetMissing, change === 'ambiguous');
                assert.equal(listed[0].targetNode, change === 'ambiguous' ? tag.targetNode : rebuilt.records[0].get('uid'));
                if (change === 'ambiguous') {
                    const reviewed = await annotations.updateAnnotationStatus(session, tag.annotationId, 'rejected');
                    assert.equal(reviewed.targetMissing, true);
                    assert.equal(reviewed.status, 'rejected');
                }
            } finally { await cleanup(); }
        });
    }
}
