/**
 * reconcile_class.js — Pure overlay logic for CLASS diagrams vs. the code graph.
 *
 * Three regions, same philosophy as the sequence overlay, applied to class
 * membership and inheritance instead of calls:
 *   ① conforms — diagram method exists on the bound code class; diagram
 *                inheritance exists as an INHERITS edge
 *   ② missing  — diagram method/inheritance absent in code
 *   ③ extra    — code method on a bound class that the diagram doesn't list
 *
 * Guards (identical intent to the sequence overlay):
 *   - BINDING GATE: a diagram class with no confirmed binding yields no drift;
 *     it surfaces in `unbound` as a question.
 *   - SCOPING: method-extra (③) is only computed for BOUND classes.
 *
 * Pure function — no Neo4j, no I/O.
 */

"use strict";

/**
 * @param {object} input
 * @param {Array}  input.classes   [{ name, methods:[{name}] }]
 * @param {object} input.bindings  className -> { uid, name }   (confirmed only)
 * @param {object} input.codeMethods className -> [{ uid, name }]  funcs in class
 * @param {Array}  input.relations [{ from, to, type }]  (type 'inherits' used)
 * @param {Array}  input.inherits  [{ fromUid, toUid }]  actual INHERITS edges (child->parent)
 */
function computeClassRegions(input) {
    const classes = input.classes || [];
    const bindings = input.bindings || {};
    const codeMethods = input.codeMethods || {};
    const relations = input.relations || [];
    const inherits = input.inherits || [];

    const methodConforms = [];
    const methodMissing = [];
    const methodExtra = [];
    const inheritsConforms = [];
    const inheritsMissing = [];
    const unboundSet = new Set();

    // ── Methods per class ────────────────────────────────────────────────
    for (const c of classes) {
        if (!bindings[c.name]) { unboundSet.add(c.name); continue; }
        const codeNames = new Set((codeMethods[c.name] || []).map(m => m.name));
        const diagramNames = new Set(c.methods.map(m => m.name));

        for (const m of c.methods) {
            if (codeNames.has(m.name)) methodConforms.push({ class: c.name, method: m.name });
            else methodMissing.push({ class: c.name, method: m.name });
        }
        // ③ scoping: extra only among bound classes
        for (const name of codeNames) {
            if (!diagramNames.has(name)) methodExtra.push({ class: c.name, method: name });
        }
    }

    // ── Inheritance ──────────────────────────────────────────────────────
    const inheritSet = new Set(inherits.map(e => `${e.fromUid} ${e.toUid}`));
    for (const r of relations) {
        if (r.type !== "inherits") continue;
        const childB = bindings[r.from];
        const parentB = bindings[r.to];
        if (!childB) unboundSet.add(r.from);
        if (!parentB) unboundSet.add(r.to);
        if (!childB || !parentB) continue; // binding gate
        if (inheritSet.has(`${childB.uid} ${parentB.uid}`)) {
            inheritsConforms.push({ child: r.from, parent: r.to });
        } else {
            inheritsMissing.push({ child: r.from, parent: r.to });
        }
    }

    return {
        methodConforms, methodMissing, methodExtra,
        inheritsConforms, inheritsMissing,
        unbound: [...unboundSet],
        summary: {
            classes: classes.length,
            methodConforms: methodConforms.length,
            methodMissing: methodMissing.length,
            methodExtra: methodExtra.length,
            inheritsConforms: inheritsConforms.length,
            inheritsMissing: inheritsMissing.length,
            unbound: unboundSet.size,
        },
    };
}

module.exports = { computeClassRegions };
