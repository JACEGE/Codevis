/**
 * reconcile_usecase.js — Pure overlay for USE-CASE diagrams vs. the code graph.
 *
 * A use case is a capability; the overlay answers "is it implemented?" — i.e.
 * is it bound to a code node (function/endpoint/component/class). Plus, for
 * include/extend relations between use cases whose impls are both functions,
 * it checks whether the CALLS edge exists.
 *
 *   implemented   — use case bound to code
 *   unimplemented — use case with no binding (the coverage gap → tasks)
 *   relationConforms / relationMissing — include/extend vs CALLS
 *
 * Actors and actor→use-case associations are informational (passed through),
 * not a conformance check. Pure function — no Neo4j, no I/O.
 */

"use strict";

function computeUseCaseRegions(input) {
    const usecases = input.usecases || [];
    const bindings = input.bindings || {};   // usecaseId -> { uid, name }
    const relations = input.relations || []; // [{ from, to, type }]
    const calls = input.calls || [];         // CALLS among bound use-case impls

    const implemented = [];
    const unimplemented = [];
    for (const uc of usecases) {
        if (bindings[uc.id]) implemented.push({ id: uc.id, name: uc.name, uid: bindings[uc.id].uid });
        else unimplemented.push({ id: uc.id, name: uc.name });
    }

    const callSet = new Set(calls.map(c => `${c.fromUid} ${c.toUid}`));
    const relationConforms = [];
    const relationMissing = [];
    for (const r of relations) {
        const a = bindings[r.from], b = bindings[r.to];
        if (!a || !b) continue; // binding gate — need both ends bound
        if (callSet.has(`${a.uid} ${b.uid}`)) relationConforms.push({ from: r.from, to: r.to, type: r.type });
        else relationMissing.push({ from: r.from, to: r.to, type: r.type });
    }

    return {
        implemented, unimplemented, relationConforms, relationMissing,
        summary: {
            usecases: usecases.length,
            implemented: implemented.length,
            unimplemented: unimplemented.length,
            relationConforms: relationConforms.length,
            relationMissing: relationMissing.length,
        },
    };
}

module.exports = { computeUseCaseRegions };
