'use strict';
const { createHash } = require('node:crypto');

// The daemon owns the connection mutex throughout this operation. The parser
// sends a complete file snapshot; no transaction spans client HTTP requests.
async function syncGraphFile(session, snapshot) {
    if (!snapshot || typeof snapshot.file !== 'string' || !snapshot.file
        || !['sync', 'commit'].includes(snapshot.mode)
        || !Number.isFinite(snapshot.mtime) || snapshot.mtime < 0
        || !Array.isArray(snapshot.functions)
        || (snapshot.mode === 'commit' && (typeof snapshot.taskId !== 'string' || !snapshot.taskId))) {
        throw new Error('Invalid graph file snapshot');
    }
    const functions = snapshot.functions.map(fn => {
        if (!fn || typeof fn.name !== 'string' || !fn.name || typeof fn.snippet !== 'string'
            || !Number.isInteger(fn.startLine) || fn.startLine < 1
            || !Number.isInteger(fn.endLine) || fn.endLine < fn.startLine
            || !Array.isArray(fn.calls) || fn.calls.some(name => typeof name !== 'string' || !name)) {
            throw new Error('Invalid function in graph file snapshot');
        }
        return { name:fn.name, startLine:fn.startLine, endLine:fn.endLine, snippet:fn.snippet, calls:[...fn.calls] };
    });
    const { file, mtime, taskId, mode } = snapshot;
    if (typeof session.withTransaction !== 'function') throw new Error('Atomic graph file sync requires a local transaction');
    return session.withTransaction(async tx => {
        const graph = await tx.run('MATCH (n:Function {file:$file}) RETURN n.name AS name,n.removedFromDisk AS removed', { file });
        const graphNames = new Set(graph.records.map(r => r.get('name')).filter(name => typeof name === 'string'));
        const activeNames = new Set(graph.records.filter(r => !r.get('removed')).map(r => r.get('name')));
        const diskNames = new Set(functions.map(fn => fn.name));
        if (functions.length) {
            await tx.run(`UNWIND $functions AS fn
                MATCH (n:Function {name:fn.name, file:$file})
                SET n.startLine=fn.startLine,n.endLine=fn.endLine,n.bodySnippet=fn.snippet,n.removedFromDisk=false`,
            { functions:functions.map(({ calls, ...fn }) => fn), file });
        }
        const created = functions.filter(fn => !graphNames.has(fn.name)).map(fn => {
            const uid = createHash('sha256').update(`Function::${fn.name}::${file}`).digest('hex').slice(0, 16);
            return { name:fn.name, startLine:fn.startLine, endLine:fn.endLine, snippet:fn.snippet,
                uid, ipv6:`fd00:0001:${uid.slice(0, 4)}:${uid.slice(4, 8)}:0000:0000:0000:0000` };
        });
        if (created.length) {
            await tx.run(`UNWIND $functions AS fn
                MERGE (f:File {path:$file})
                MERGE (n:Function {uid:fn.uid})
                SET n.name=fn.name,n.file=$file,n.startLine=fn.startLine,n.endLine=fn.endLine,
                    n.bodySnippet=fn.snippet,n.nodeId=fn.uid,n.ipv6=fn.ipv6
                MERGE (f)-[:CONTAINS]->(n)`, { functions:created, file });
            if (mode === 'commit') await tx.run(`UNWIND $names AS name
                MATCH (n:Function {name:name,file:$file}), (t:Task {taskId:$taskId})
                MERGE (t)-[:CREATED]->(n)`, { names:created.map(fn => fn.name), file, taskId });
        }
        const removed = [...(mode === 'commit' ? activeNames : graphNames)].filter(name => !diskNames.has(name));
        if (removed.length) {
            await tx.run(mode === 'commit'
                ? `UNWIND $names AS name
                   MATCH (n:Function {name:name,file:$file}), (t:Task {taskId:$taskId})
                   WHERE NOT coalesce(n.removedFromDisk,false)
                   SET n.removedFromDisk=true,n.removedBy=$taskId,n.removedAt=timestamp()
                   MERGE (t)-[:REMOVED]->(n)`
                : `UNWIND $names AS name MATCH (n:Function {name:name,file:$file}) SET n.removedFromDisk=true`,
            { names:removed, file, ...(mode === 'commit' ? { taskId } : {}) });
        }
        const edited = functions.filter(fn => graphNames.has(fn.name));
        if (mode === 'commit' && edited.length) await tx.run(`UNWIND $names AS name
            MATCH (n:Function {name:name,file:$file}), (t:Task {taskId:$taskId})
            MERGE (t)-[:AFFECTS]->(n)`, { names:edited.map(fn => fn.name), file, taskId });

        // Only replace outgoing CALLS of the parsed functions. Incoming edges,
        // identities, and authored links never enter the deletion set.
        if (functions.length) await tx.run(`UNWIND $names AS name
            MATCH (caller:Function {name:name,file:$file})-[r:CALLS]->() DELETE r`,
        { names:[...diskNames], file });
        // Match the previous per-function replacement behavior for duplicate
        // names: the last extracted body supplies the outgoing calls.
        const calls = [...new Map(functions.map(fn => [fn.name, fn])).values()]
            .flatMap(fn => [...new Set(fn.calls)].map(callee => ({ caller:fn.name, callee })));
        const chunkSize = 1000;
        for (let offset = 0; offset < calls.length; offset += chunkSize) {
            await tx.run(`UNWIND $calls AS call
                MATCH (caller:Function {name:call.caller,file:$file})
                MATCH (callee:Function {name:call.callee})
                WHERE callee.file=$file
                   OR EXISTS { MATCH (:File {path:$file})-[:IMPORTS]->(:File {path:callee.file}) }
                   ${mode === 'sync' ? 'OR (NOT EXISTS { MATCH (:File {path:$file})-[:IMPORTS]->() } AND callee.file <> $file)' : ''}
                MERGE (caller)-[:CALLS]->(callee)`, { calls:calls.slice(offset, offset + chunkSize), file });
        }
        await tx.run('MERGE (f:File {path:$file}) SET f.lastSeenMtime=$mtime', { file, mtime });
        return mode === 'commit'
            ? { created:created.map(fn => fn.name), removed, updated:edited.length, callsResynced:functions.length }
            : { newFunctions:created.length, removed:removed.length, updated:functions.length, callsResynced:functions.length };
    });
}
module.exports = { syncGraphFile };
