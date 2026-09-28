'use strict';
// These authored edges target parsed code. Other workflow relationships join
// preserved entities and survive rebuilds without recovery.
const SOURCE_RELATIONS = ['IMPACTS', 'VALIDATES', 'IMPLEMENTED_BY'];
async function backupWorkflowLinks(session, filter = '', params = {}) {
  const links = [];
  for (const type of SOURCE_RELATIONS) {
    const rows = await session.run('MATCH (a)-[r:' + type + ']->(n) ' + (filter ? 'WHERE true ' + filter : '') +
      ' RETURN elementId(a) AS from, r.kind AS kind, elementId(n) AS uid, labels(n) AS labels, n.name AS name, n.file AS file, n.path AS path, n.owner AS owner, n.bodySnippet AS bodySnippet, n.params AS params', params);
    for (const row of rows.records) links.push({ type, from: row.get('from'), kind: row.get('kind'), uid: row.get('uid'),
      nodeLabels: row.get('labels'), name: row.get('name'), file: row.get('file'), path: row.get('path'), owner: row.get('owner'), bodySnippet: row.get('bodySnippet'), params: row.get('params') });
  }
  return links;
}
async function restoreWorkflowLinks(session, links, resolveTarget) {
  let count = 0;
  for (const link of links || []) {
    if (!SOURCE_RELATIONS.includes(link.type)) throw new Error('Invalid workflow recovery relationship');
    const target = await resolveTarget(session, link);
    if (!target) continue;
    const result = await session.run('MATCH (a),(b) WHERE elementId(a)=$from AND elementId(b)=$to MERGE (a)-[r:' + link.type + ']->(b) SET r.kind=$kind RETURN count(r) AS count',
      { from: link.from, to: target.uid, kind: link.kind });
    const n = result.records[0]?.get('count'); count += n?.toNumber?.() ?? Number(n || 0);
  }
  return count;
}
module.exports = { SOURCE_RELATIONS, backupWorkflowLinks, restoreWorkflowLinks };
