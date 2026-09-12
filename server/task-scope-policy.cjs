'use strict';
const MODES = ['inherit', 'open', 'strict', 'flexible'];
function validateScopeMode(mode) {
    if (!MODES.includes(mode)) throw new Error('Edit mode must be inherit, open, strict or flexible.');
    return mode;
}
async function readScopePolicy(session, taskId) {
    const result = await session.run(`MATCH (t) WHERE (t:Task OR t:Epic) AND t.taskId=$taskId
        OPTIONAL MATCH (e:Epic)-[:FULFILLED_BY]->(t)
        RETURN t.scopeMode AS mode,t.activeScopeMode AS activeMode,t.status AS status,
            t.assignedTo AS agentId,e.scopeMode AS epicMode`, { taskId });
    if (!result.records.length) return null;
    const r = result.records[0];
    const mode = r.get('mode') || 'inherit';
    const epicModes = [...new Set(result.records.map(row => row.get('epicMode')).filter(m => m && m !== 'inherit'))];
    const inherited = epicModes.includes('strict') ? 'strict' : epicModes.includes('flexible') ? 'flexible' : epicModes[0] || 'flexible';
    const planned = mode === 'inherit' ? inherited : mode;
    const active = !['backlog','todo','open','done'].includes(r.get('status'));
    return { mode, effectiveMode: active && r.get('activeMode') ? r.get('activeMode') : planned,
        nextMode: planned, agentId: r.get('agentId'), status: r.get('status') };
}
module.exports = { validateScopeMode, readScopePolicy };
