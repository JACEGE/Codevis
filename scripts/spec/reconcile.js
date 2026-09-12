/**
 * reconcile.js — Pure overlay logic for the spec ↔ code conformance check.
 *
 * Given the parsed sequence-diagram messages, the confirmed participant→code
 * bindings, the functions in each bound scope, and the ACTUAL CALLS edges
 * among those functions (all fetched from Neo4j by the handler), compute the
 * three overlay regions:
 *
 *   ① conforms — message has a matching CALLS edge in the code        (green)
 *   ② missing  — message has no matching edge (method absent / not called)
 *   ③ extra    — a CALLS edge exists between two bound participants
 *                with no corresponding message            (drift / undocumented)
 *
 * Two guards are baked in, because they are what keeps this from being a
 * noise generator (see design notes):
 *   - BINDING GATE: a participant with no confirmed binding produces NO drift.
 *     It surfaces in `unbound` as a question to the architect, never as ②/③.
 *   - SCOPING: region ③ is computed ONLY among functions that belong to bound
 *     participants. Calls leaving that scope are the normal case, not findings.
 *
 * Pure function — no Neo4j, no I/O.
 */

"use strict";

/**
 * @param {object} input
 * @param {Array}  input.messages  [{ from, to, method, label, order, guard }]
 * @param {object} input.bindings  alias -> { uid, name, kind }  (confirmed only)
 * @param {object} input.members   alias -> [{ uid, name }]  functions in scope
 * @param {Array}  input.calls     [{ fromUid, toUid }]  actual CALLS among scope
 * @returns {{conforms:Array, missing:Array, extra:Array, unbound:Array, skipped:Array, summary:object}}
 */
function computeRegions(input) {
    const messages = input.messages || [];
    const bindings = input.bindings || {};
    const members = input.members || {};
    const calls = input.calls || [];

    // ── Lookups ──────────────────────────────────────────────────────────
    // uid -> { alias, name }   (only for functions inside a bound scope)
    const uidToMember = new Map();
    for (const [alias, fns] of Object.entries(members)) {
        for (const fn of fns) uidToMember.set(fn.uid, { alias, name: fn.name });
    }
    // alias -> Map(methodName -> uid[]) — overloads share a name and must not
    // overwrite one another. A diagram message conforms when any candidate is
    // actually called; without call evidence we keep every candidate visible.
    const methodIndex = {};
    for (const [alias, fns] of Object.entries(members)) {
        const map = new Map();
        for (const fn of fns) {
            if (!map.has(fn.name)) map.set(fn.name, []);
            map.get(fn.name).push(fn.uid);
        }
        methodIndex[alias] = map;
    }
    // Fast CALLS lookup: Set("fromUid\u0000toUid")
    const callSet = new Set(calls.map(c => `${c.fromUid}\u0000${c.toUid}`));

    const conforms = [];
    const missing = [];
    const extra = [];
    const unboundSet = new Set();
    const skipped = [];

    // ── ① / ② : walk every message ───────────────────────────────────────
    // Expected edges, keyed for the EXTRA pass: "fromAlias\u0000toAlias\u0000method"
    const expected = new Set();

    for (const m of messages) {
        // A dashed arrow is a RETURN (the reply to an earlier call), not a new
        // call assertion — checking it against CALLS would invent a backwards
        // edge and produce false "missing". Skip it from the conformance check.
        if (m.dashed) { skipped.push({ message: m, reason: "return" }); continue; }

        const fromBound = !!bindings[m.from];
        const toBound = !!bindings[m.to];

        // BINDING GATE — unbound endpoints are questions, not drift.
        if (!fromBound) unboundSet.add(m.from);
        if (!toBound) unboundSet.add(m.to);
        if (!fromBound || !toBound) {
            skipped.push({ message: m, reason: "unbound_endpoint" });
            continue;
        }
        // Free-text labels carry no callable name → cannot be checked.
        if (!m.method) {
            skipped.push({ message: m, reason: "free_text" });
            continue;
        }

        expected.add(`${m.from}\u0000${m.to}\u0000${m.method}`);

        const calleeUids = methodIndex[m.to] ? methodIndex[m.to].get(m.method) : undefined;
        if (!calleeUids || calleeUids.length === 0) {
            // Target participant has no such method in its bound scope at all.
            missing.push({ message: m, reason: "no_method" });
            continue;
        }
        // Does ANY function in `from`'s scope call ANY same-named candidate?
        // The edge identifies the overload; name order never does.
        const callerFns = members[m.from] || [];
        const calledCalleeUids = calleeUids.filter(calleeUid =>
            callerFns.some(fn => callSet.has(`${fn.uid}\u0000${calleeUid}`)));
        if (calledCalleeUids.length > 0) {
            conforms.push({
                message: m,
                calleeUid: calledCalleeUids.length === 1 ? calledCalleeUids[0] : undefined,
                calleeUids: calledCalleeUids,
            });
        } else {
            missing.push({
                message: m,
                reason: "not_called",
                calleeUid: calleeUids.length === 1 ? calleeUids[0] : undefined,
                calleeUids,
            });
        }
    }

    // ── ③ : actual calls among bound scope with no matching message ───────
    for (const c of calls) {
        const fromM = uidToMember.get(c.fromUid);
        const toM = uidToMember.get(c.toUid);
        if (!fromM || !toM) continue;            // SCOPING: both ends must be bound
        if (fromM.alias === toM.alias) continue; // internal call, not a message
        const key = `${fromM.alias}\u0000${toM.alias}\u0000${toM.name}`;
        if (expected.has(key)) continue;         // already documented (conforms/missing)
        extra.push({
            fromAlias: fromM.alias,
            toAlias: toM.alias,
            calleeName: toM.name,
            callerUid: c.fromUid,
            calleeUid: c.toUid,
        });
    }

    return {
        conforms,
        missing,
        extra,
        unbound: [...unboundSet],
        skipped,
        summary: {
            messages: messages.length,
            conforms: conforms.length,
            missing: missing.length,
            extra: extra.length,
            unbound: unboundSet.size,
            skipped: skipped.length,
        },
    };
}

module.exports = { computeRegions };
