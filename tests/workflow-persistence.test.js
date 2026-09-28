'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { createChange, validateState } = require('../lib/workflow/model.cjs');
const store = require('../lib/workflow/artifacts.cjs');
const { changeOperation } = require('../lib/workflow/service.cjs');
const { projectChange, reference } = require('../lib/workflow/projection.cjs');
const { PRESERVED_LABELS, __testing__: builder } = require('../scripts/graph_builder.js');
const input = { title: 'Refresh token rotation', description: 'Reject reused refresh tokens after rotation.', slug: 'refresh-rotation' };
function context() { return { projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-workflow-')), workspace: 'project_db', config: {} }; }
function clean(ctx) { fs.rmSync(ctx.projectRoot, { recursive: true, force: true }); }
test('versioned state resumes, isolates workspaces and refuses overwrite or path escape', async () => {
  const ctx = context();
  try {
    const s = createChange(input); store.saveState(ctx, s);
    const first = store.readState(ctx, s.slug); assert.equal(first.state.changeId, s.changeId);
    assert.throws(() => store.saveState(ctx, s), /CONFLICT/);
    s.revision++; store.saveState(ctx, s, first.hash);
    assert.throws(() => store.saveState(ctx, s, first.hash), /CONFLICT/);
    assert.equal(store.listStates({ ...ctx, workspace: 'codevis_db' }).length, 0);
    assert.throws(() => store.readState(ctx, '../escape'), /Invalid slug/);
    assert.throws(() => store.artifactRoot(ctx.projectRoot, {workflow:{artifactDir:'../outside'}}, 'project_db'), /escapes/);
    assert.throws(() => store.artifactRoot(ctx.projectRoot, {workflow:{artifactDir:'.codevis'}}, 'project_db'), /versionable/);
    const artifact = store.writeArtifact(ctx, s, 'requirements', '# Requirements\nReject old tokens.');
    assert.match(store.readArtifact(ctx, artifact), /Reject/);
    fs.appendFileSync(path.join(ctx.projectRoot, artifact.path), '\nChanged');
    assert.throws(() => store.readArtifact(ctx, artifact), /changed since/);
  } finally { clean(ctx); }
});
test('invalid entities, references and duplicate IDs are rejected', () => {
  const s = createChange(input);
  s.links.push({ from: 'requirements', to: 'missing', type: 'DERIVES' });
  assert.throws(() => validateState(s), /Unknown workflow/);
  s.links = [{ from: 'change', to: 'requirements', type: 'MALICIOUS' }];
  assert.throws(() => validateState(s), /Invalid relationship/);
});
test('failed projection retains versioned state and resume repairs the real graph', async () => {
  const ctx = context(); const db = await openTestDb();
  try {
    const failed = await changeOperation({ withTransaction: async () => { throw new Error('simulated outage'); } }, {operation:'create', ...input}, ctx);
    assert.equal(failed.status, 'PROJECTION_PENDING'); assert.equal(failed.saved, true);
    const resumed = await changeOperation(db.session, {operation:'resume', slug:input.slug}, ctx);
    assert.equal(resumed.status, 'OK'); assert.equal(resumed.graph.nodes.length, 8);
    const rows = await db.session.run('MATCH (c:Flow)-[:HAS_PHASE]->(p:Phase) RETURN count(p) AS count');
    assert.equal(Number(rows.records[0].get('count')), 7);
    await changeOperation(db.session, {operation:'resume', slug:input.slug}, ctx);
    const count = await db.session.run('MATCH (c:Flow) RETURN count(c) AS count');
    assert.equal(Number(count.records[0].get('count')), 1);
    const originalId=resumed.graph.nodes.find(n=>n.label==='Flow').id;
    await db.session.run("MATCH (n) WHERE elementId(n)=$id SET n.label='Change'",{id:originalId});
    const migrated=await changeOperation(db.session,{operation:'resume',slug:input.slug},ctx);
    assert.equal(migrated.graph.nodes.find(n=>n.label==='Flow').id,originalId);
    const legacy=await db.session.run('MATCH (n:Change) RETURN count(n) AS count');
    assert.equal(Number(legacy.records[0].get('count')),0);
  } finally { await db.cleanup(); clean(ctx); }
});
for (const mode of ['full', 'incremental']) test(mode + ' rebuild preserves workflow and test/source links', async () => {
  const db = await openTestDb(); const s = createChange(input);
  try {
    await db.session.run("MERGE (:Function {uid:'prod:old',name:'rotate',file:'src/auth.js',owner:'',bodySnippet:'return rotate()',params:'()'})");
    s.entities = [{id:'REQ-1',label:'Requirement',title:'Reject previously used tokens',content:'A used token cannot be used to create a new session.',phase:'requirements'},
      {id:'TC-1',label:'TestCase',title:'Reused token is rejected',content:'Rotate then retry the original token; expect rejection.',phase:'requirements'}];
    s.links = [{from:'change',to:'REQ-1',type:'HAS_REQUIREMENT'}, {from:'REQ-1',to:'TC-1',type:'VALIDATED_BY'},
      {from:'TC-1',to:reference({id:'prod:old',label:'Function',name:'rotate',file:'src/auth.js',owner:''}),type:'VALIDATES'},
      {from:'analysis',to:{nodeId:'prod:old'},type:'IMPACTS'}];
    await projectChange(db.session, s);
    const backup = await builder.backupLocksAndAffects(db.session);
    assert.equal(backup.workflow.length, 2);
    if (mode === 'full') await db.session.run('MATCH (n) WHERE ' + PRESERVED_LABELS.map(l=>'NOT n:'+l).join(' AND ') + ' DETACH DELETE n');
    else await builder.removeFileDerivedNodes(db.session, ['src/auth.js']);
    await db.session.run("MERGE (:Function {uid:'prod:new',name:'rotate',file:'src/auth.js',owner:'',bodySnippet:'return rotate()',params:'()'})");
    const restored = await builder.restoreLocksAndAffects(db.session, backup);
    assert.equal(restored.workflowRestored, 2);
    const rows = await db.session.run('MATCH (t:TestCase)-[:VALIDATES]->(f:Function) RETURN elementId(f) AS id');
    assert.equal(rows.records[0].get('id'), 'prod:new');
    const phases = await db.session.run('MATCH (c:Flow)-[:HAS_PHASE]->(p) RETURN count(p) AS count');
    assert.equal(Number(phases.records[0].get('count')), 7);
  } finally { await db.cleanup(); }
});
