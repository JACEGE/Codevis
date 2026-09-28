'use strict';
// Shared conservative resolution for rebuilt source and durable workflow references.
async function resolveRebuiltTargetUid(session, entry) {
  const labels = (entry.nodeLabels || []).filter(l => !['_internal'].includes(l));
  const labelFilter = labels.map(l => `n:${l}`).join(' OR ');
  const whereLabels = labelFilter ? `AND (${labelFilter})` : '';
  const isFile = labels.includes('File');
  if (entry.uid) {
    const byId = await session.run(
      `MATCH (n) WHERE elementId(n) = $uid ${whereLabels}
       RETURN elementId(n) AS uid, n.name AS name, n.file AS file, n.path AS path`,
      { uid: entry.uid }
    );
    if (byId.records.length === 1) return {
      uid: byId.records[0].get('uid'), name: byId.records[0].get('name'),
      file: byId.records[0].get('file'), path: byId.records[0].get('path'), renamed: false,
    };
  }
  const exact = await session.run(
    isFile
      ? `MATCH (n {path: $path}) WHERE true ${whereLabels} RETURN elementId(n) AS uid, n.name AS name, n.file AS file, n.path AS path`
      : `MATCH (n {name: $name, file: $file}) WHERE coalesce(n.owner, '') = $owner ${whereLabels} RETURN elementId(n) AS uid, n.name AS name, n.file AS file, n.path AS path`,
    { name: entry.name, file: entry.file, path: entry.path, owner: entry.owner || '' }
  );
  if (exact.records.length === 1) return {
    uid: exact.records[0].get('uid'), name: exact.records[0].get('name'),
    file: exact.records[0].get('file'), path: exact.records[0].get('path'), renamed: false,
  };

  if (!labels.includes('Function') || !entry.bodySnippet) return null;
  const fingerprint = await session.run(
    `MATCH (n:Function)
     WHERE n.bodySnippet = $bodySnippet AND n.params = $params
     RETURN elementId(n) AS uid, n.name AS name, n.file AS file`,
    { bodySnippet: entry.bodySnippet, params: entry.params }
  );
  const candidates = fingerprint.records.map(r => ({
    uid: r.get('uid'), name: r.get('name'), file: r.get('file'),
  }));
  const sameFile = candidates.filter(c => c.file === entry.file);
  const chosen = sameFile.length === 1 ? sameFile[0] : candidates.length === 1 ? candidates[0] : null;
  if (!chosen) return null;
  console.log(`  Rename detected: '${entry.name}' (${entry.file}) -> '${chosen.name}' (${chosen.file}).`);
  return { ...chosen, path: null, renamed: true };
}


module.exports = { resolveRebuiltTargetUid };
