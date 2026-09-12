/**
 * reconcile_activity.js — Pure overlay for ACTIVITY diagrams vs. the code graph.
 *
 * An activity describes the steps of a process. Bind the activity to ONE
 * process function; its actions become expected callees. Matching is done on a
 * normalised (lowercase, alphanumeric-only) form so prose steps line up with
 * camelCase / snake_case functions ("Charge Payment" ~ chargePayment / charge_payment).
 *
 *   conforms — an action whose method matches a function the process calls
 *   missing  — an action with no matching call from the process
 *   extra    — the process calls a function that no action covers (scoped to
 *              the process's direct callees)
 *
 * Pure function — no Neo4j, no I/O.
 */

"use strict";

function norm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function computeActivityRegions(input) {
    const actions = input.actions || [];
    const processBound = !!input.processBound;
    const processCallees = input.processCallees || []; // [{ name }]

    if (!processBound) {
        return {
            unbound: true, conforms: [], missing: [], ambiguous: [], extra: [], skipped: [],
            summary: { actions: actions.length, conforms: 0, missing: 0, ambiguous: 0, extra: 0, skipped: 0, unbound: true },
        };
    }

    const calleeByNorm = new Map();
    for (const c of processCallees) {
        const n = norm(c.name);
        if (!n) continue;
        if (!calleeByNorm.has(n)) calleeByNorm.set(n, []);
        const candidates = calleeByNorm.get(n);
        if (!candidates.includes(c.name)) candidates.push(c.name);
    }

    const conforms = [];
    const missing = [];
    const ambiguous = [];
    const skipped = [];
    const coveredCallees = new Set();
    const ambiguousCallees = new Set();
    for (const a of actions) {
        if (!a.method) { skipped.push({ action: a.name, reason: "no_method" }); continue; }
        const candidates = calleeByNorm.get(norm(a.method)) || [];
        if (candidates.length === 0) {
            missing.push({ action: a.name, method: a.method });
            continue;
        }

        const exact = candidates.filter(name => name === a.method);
        if (exact.length === 1) {
            coveredCallees.add(exact[0]);
            conforms.push({ action: a.name, callee: exact[0] });
        } else if (candidates.length === 1) {
            coveredCallees.add(candidates[0]);
            conforms.push({ action: a.name, callee: candidates[0] });
        } else {
            // Normalisation erased the distinction. Do not choose by row order
            // and do not call any candidate definite undocumented drift.
            candidates.forEach(name => ambiguousCallees.add(name));
            ambiguous.push({ action: a.name, method: a.method, candidates: [...candidates] });
        }
    }

    const extra = [];
    for (const names of calleeByNorm.values()) {
        for (const name of names) {
            if (!coveredCallees.has(name) && !ambiguousCallees.has(name)) extra.push({ callee: name });
        }
    }

    return {
        unbound: false, conforms, missing, ambiguous, extra, skipped,
        summary: {
            actions: actions.length,
            conforms: conforms.length,
            missing: missing.length,
            ambiguous: ambiguous.length,
            extra: extra.length,
            skipped: skipped.length,
        },
    };
}

module.exports = { computeActivityRegions, norm };
