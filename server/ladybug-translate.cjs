/**
 * ladybug-translate.cjs
 * ─────────────────────────────────────────────────────────────────────────
 * Rewrites Neo4j-flavoured Cypher into Kuzu/Ladybug-flavoured Cypher for the
 * PURE SINGLE-TABLE data model, where ALL semantic node types live in one
 * physical node table `CodeNode` and the semantic type is held in a STRING
 * column called `label`.
 *
 * Why a tokenizer (and not a pile of global regexes)?
 *   String literals ('...', "..."), property-map bodies ({k:v}) and node
 *   patterns all use the colon and parenthesis characters that our rewrite
 *   rules also key off of. A naive global regex like /\((\w+):(\w+)\)/g will
 *   happily corrupt a string literal that merely contains "(x:Foo)", or a map
 *   key, or a map value. So we lex the query into a flat token stream that is
 *   aware of:
 *     - single/double quoted strings (with backslash escapes)
 *     - parameters ($foo)
 *     - identifiers / keywords
 *     - punctuation ( ) { } [ ] : . , etc.
 *   and then walk that stream applying structural rules. Strings are opaque
 *   tokens that are never inspected for rewrite content.
 *
 * Public API:
 *   translate(cypher) -> { cypher, injectNow }
 *     `injectNow` is true when at least one `timestamp()` was replaced with
 *     the `$__now` parameter; the caller is then responsible for binding
 *     `__now` to the current epoch-millis before executing.
 *
 * Rules implemented (see task spec):
 *   1. timestamp()                  -> $__now           (sets injectNow)
 *   2. id(x)        [x a var]       -> x.seq
 *      elementId(x) [x a var]       -> x.uid
 *   3. labels(x)    [x a var]       -> [x.label]
 *   4. node pattern labels:
 *        (var:Foo)                  -> (var:CodeNode {label:'Foo'})
 *        (var:Foo {k:v})            -> (var:CodeNode {label:'Foo', k:v})
 *        (:Foo)                     -> (:CodeNode {label:'Foo'})
 *        (var:CodeNode ...)         -> left as-is (already canonical)
 *        (n:A:B)                    -> first label wins, rest dropped (warn)
 *   5. boolean label predicate (NOT inside a pattern or map):
 *        var:Foo                    -> var.label = 'Foo'
 *        NOT var:Foo                -> var.label <> 'Foo'
 *   6. relationship var-length / multi-type stays AS-IS, e.g. [:A|B*1..6]
 *   7. everything else untouched.
 */

'use strict';

// ── Lexer ─────────────────────────────────────────────────────────────────
// Token kinds:
//   'string'  raw literal incl. surrounding quotes, never rewritten
//   'param'   $name
//   'ident'   identifier / keyword (case preserved)
//   'num'     numeric literal
//   'punc'    a single punctuation char ( ) { } [ ] : . , < > = etc.
//   'ws'      run of whitespace (preserved verbatim for round-tripping)
//
// We keep whitespace as its own token so the re-serialised query stays
// visually close to the input and so adjacency checks ("is there a space
// between the var and the colon?") are explicit rather than guessed.

const PUNCT = new Set([
    '(', ')', '{', '}', '[', ']', ':', '.', ',', '<', '>', '=', '+', '-',
    '*', '/', '|', '!', '?', '$', '%', '^', '&', ';', '@', '~',
]);

// On the single-table model `uid` is the PRIMARY KEY and `seq` is the numeric
// id() replacement — both REQUIRED on CREATE (Neo4j auto-assigns internal ids;
// Kuzu does not). For node patterns under a CREATE clause the translator injects
// `uid:$__uid, seq:$__seq` into the property map; the driver fills those with
// sentinels and the daemon resolves them (seq = per-db counter, uid = prefix+seq)
// so the handlers' CREATE statements stay untouched. Prefix per known label keeps
// new uids consistent with the migration scheme (task:…, knowledge:…); unknown
// labels fall back to `<lowercased-label>:`.
const CREATE_UID_PREFIX = {
    Task: 'task:',
    Knowledge: 'knowledge:',
    BraindumpSession: 'braindump:',
    Architect: 'architect:',
    User: 'user:',
};

// Single-table fold-in: secondary Neo4j labels that are NOT a node's primary
// label but a boolean facet, stored as a column. `SET n:Component` / a multi-
// label pattern `(:Function:Component)` / a predicate `n:Component` all map to
// the column here. (Mirrors ladybug_schema.cjs: :Component→isComponent, …)
const FOLD_IN_LABELS = {
    Component: 'isComponent',
    HTTPHandler: 'isHttpHandler',
    RuntimeDOM: 'isRuntime',
    Hook: 'isHook',
    // Async braucht eine eigene Spalte: signature ist Anzeige-Text und kann sich
    // ändern; ein Prefix-Test darauf wäre kein stabiler Strukturfilter.
    Async: 'isAsync',
};

const FOLD_INS_BY_PRIMARY = {
    Function: ['Hook', 'Async', 'Component'],
    DOMElement: ['RuntimeDOM'],
};

// Clause keywords that terminate a SET assignment list.
const CLAUSE_KW = new Set([
    'match', 'merge', 'create', 'return', 'with', 'where', 'delete', 'remove',
    'unwind', 'foreach', 'call', 'order', 'limit', 'skip', 'on', 'union', 'set',
    'detach', 'optional',
]);

function tokenize(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;

    while (i < n) {
        const c = src[i];

        // Whitespace run
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
            let j = i + 1;
            while (j < n && /\s/.test(src[j])) j++;
            tokens.push({ kind: 'ws', value: src.slice(i, j) });
            i = j;
            continue;
        }

        // String literal: ' or "
        if (c === "'" || c === '"') {
            const quote = c;
            let j = i + 1;
            let buf = quote;
            while (j < n) {
                const ch = src[j];
                buf += ch;
                if (ch === '\\' && j + 1 < n) {
                    // escape: take next char verbatim
                    buf += src[j + 1];
                    j += 2;
                    continue;
                }
                if (ch === quote) {
                    j++;
                    break;
                }
                j++;
            }
            tokens.push({ kind: 'string', value: buf });
            i = j;
            continue;
        }

        // Backtick-quoted identifier (Neo4j escaped name). Downstream rules
        // consume identifiers by value (not source spelling), so strip the
        // delimiters here. Neo4j represents a literal backtick by doubling it.
        if (c === '`') {
            let j = i + 1;
            let buf = '';
            let closed = false;
            while (j < n) {
                if (src[j] === '`') {
                    if (src[j + 1] === '`') {
                        buf += '`';
                        j += 2;
                        continue;
                    }
                    j++;
                    closed = true;
                    break;
                }
                buf += src[j];
                j++;
            }
            if (!closed) {
                throw new Error(`Unterminated backtick-quoted identifier at offset ${i}`);
            }
            tokens.push({ kind: 'ident', value: buf });
            i = j;
            continue;
        }

        // Parameter $name
        if (c === '$') {
            let j = i + 1;
            let buf = '$';
            while (j < n && /[A-Za-z0-9_]/.test(src[j])) { buf += src[j]; j++; }
            tokens.push({ kind: 'param', value: buf });
            i = j;
            continue;
        }

        // Number (simple: digits, optional dot, optional exponent)
        if (/[0-9]/.test(c)) {
            let j = i + 1;
            while (j < n && /[0-9._eE+-]/.test(src[j])) {
                // stop if this looks like the start of something else; keep simple
                if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
                j++;
            }
            tokens.push({ kind: 'num', value: src.slice(i, j) });
            i = j;
            continue;
        }

        // Identifier / keyword
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
            tokens.push({ kind: 'ident', value: src.slice(i, j) });
            i = j;
            continue;
        }

        // Punctuation (single char). Multi-char operators like <=, <>, =~ are
        // left as adjacent single-char punc tokens; that's fine because we
        // never need to interpret them, only pass them through.
        if (PUNCT.has(c)) {
            tokens.push({ kind: 'punc', value: c });
            i++;
            continue;
        }

        // Anything else: emit as a 1-char "other" token, passed through verbatim.
        tokens.push({ kind: 'punc', value: c });
        i++;
    }

    return tokens;
}

// ── Token-stream helpers ────────────────────────────────────────────────────

/** Index of the next non-whitespace token at or after `from`, or -1. */
function nextNonWs(tokens, from) {
    for (let k = from; k < tokens.length; k++) {
        if (tokens[k].kind !== 'ws') return k;
    }
    return -1;
}

/** Index of the previous non-whitespace token at or before `from`, or -1. */
function prevNonWs(tokens, from) {
    for (let k = from; k >= 0; k--) {
        if (tokens[k].kind !== 'ws') return k;
    }
    return -1;
}

function isPunc(tok, ch) {
    return tok && tok.kind === 'punc' && tok.value === ch;
}

function isIdent(tok) {
    return tok && tok.kind === 'ident';
}

// Cypher keywords that may immediately precede a bare identifier but where a
// following `ident : Label` is NOT a boolean label predicate. We are quite
// permissive: rule 5 only fires when the construct genuinely looks like a
// standalone boolean predicate (var followed by `:` followed by a Label ident,
// not inside () or {} and not a map entry / RETURN alias). The structural
// depth tracking below handles the "not inside a pattern/map" part; this set
// guards against map-literal / case-label confusions that share the colon.

// ── Core translate ──────────────────────────────────────────────────────────

function translate(cypher) {
    if (typeof cypher !== 'string') {
        return { cypher, injectNow: false, creates: [] };
    }

    const tokens = tokenize(cypher);
    let injectNow = false;
    // Collects one entry per CREATE node pattern that got uid/seq injected:
    //   { uidParam, seqParam, prefix }   (consumed by the compat driver)
    const acc = { creates: [] };

    // Track structural nesting so we know whether a `var:Label` colon is:
    //   - inside () => part of a node/rel pattern  (rule 4, handled separately)
    //   - inside {} => a map key/value             (leave alone)
    //   - at depth 0 (or inside boolean WHERE expr) => boolean predicate (rule 5)
    // We compute paren/brace/bracket depth on the fly during the main pass.

    // --- Pass 1: function-call rewrites: timestamp(), id(x), elementId(x), labels(x)
    // These are local, token-window rewrites and don't depend on nesting depth.
    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.kind !== 'ident') continue;
        const lower = t.value.toLowerCase();

        if (lower === 'timestamp') {
            // timestamp()  ->  $__now
            const open = nextNonWs(tokens, k + 1);
            if (open !== -1 && isPunc(tokens[open], '(')) {
                const close = nextNonWs(tokens, open + 1);
                if (close !== -1 && isPunc(tokens[close], ')')) {
                    // Replace the whole span k..close with a single param token.
                    tokens.splice(k, close - k + 1, { kind: 'param', value: '$__now' });
                    injectNow = true;
                    continue;
                }
            }
            continue;
        }

        if (lower === 'id' || lower === 'elementid') {
            // id(x) -> x.seq ; elementId(x) -> x.uid   (x must be a bare var)
            const open = nextNonWs(tokens, k + 1);
            if (open === -1 || !isPunc(tokens[open], '(')) continue;
            const argIdx = nextNonWs(tokens, open + 1);
            if (argIdx === -1 || !isIdent(tokens[argIdx])) continue;
            const close = nextNonWs(tokens, argIdx + 1);
            if (close === -1 || !isPunc(tokens[close], ')')) continue;

            const varName = tokens[argIdx].value;
            const suffix = lower === 'id' ? '.seq' : '.uid';
            // Replace span k..close with: <var> . seq|uid
            tokens.splice(k, close - k + 1,
                { kind: 'ident', value: varName },
                { kind: 'punc', value: '.' },
                { kind: 'ident', value: suffix.slice(1) },
            );
            continue;
        }

        if (lower === 'labels') {
            // labels(x)    -> [x.label]      (list form)
            // labels(x)[0] -> x.label        (scalar; Kuzu lists are 1-indexed so
            //                                 [x.label][0] would be null — and the
            //                                 app uses labels(n)[0] to read the
            //                                 primary label). Both forms also work
            //                                 on Neo4j (x is a bare var).
            const open = nextNonWs(tokens, k + 1);
            if (open === -1 || !isPunc(tokens[open], '(')) continue;
            const argIdx = nextNonWs(tokens, open + 1);
            if (argIdx === -1 || !isIdent(tokens[argIdx])) continue;
            const close = nextNonWs(tokens, argIdx + 1);
            if (close === -1 || !isPunc(tokens[close], ')')) continue;

            const varName = tokens[argIdx].value;

            // Look ahead for a trailing `[0]` → emit the scalar column directly.
            const b1 = nextNonWs(tokens, close + 1);
            const i0 = b1 !== -1 ? nextNonWs(tokens, b1 + 1) : -1;
            const b2 = i0 !== -1 ? nextNonWs(tokens, i0 + 1) : -1;
            const indexZero = b1 !== -1 && isPunc(tokens[b1], '[') &&
                i0 !== -1 && tokens[i0].kind === 'num' && tokens[i0].value === '0' &&
                b2 !== -1 && isPunc(tokens[b2], ']');

            if (indexZero) {
                // Replace span k..b2 with: <var> . label
                tokens.splice(k, b2 - k + 1,
                    { kind: 'ident', value: varName },
                    { kind: 'punc', value: '.' },
                    { kind: 'ident', value: 'label' },
                );
            } else {
                // Replace span k..close with: [ <var> . label ]
                tokens.splice(k, close - k + 1,
                    { kind: 'punc', value: '[' },
                    { kind: 'ident', value: varName },
                    { kind: 'punc', value: '.' },
                    { kind: 'ident', value: 'label' },
                    { kind: 'punc', value: ']' },
                );
            }
            continue;
        }

        if (lower === 'type') {
            // type(r) -> label(r)   (Kuzu/Ladybug: Relationship-Typ = Rel-Tabellenname)
            const open = nextNonWs(tokens, k + 1);
            if (open === -1 || !isPunc(tokens[open], '(')) continue;
            const argIdx = nextNonWs(tokens, open + 1);
            if (argIdx === -1 || !isIdent(tokens[argIdx])) continue;
            const close = nextNonWs(tokens, argIdx + 1);
            if (close === -1 || !isPunc(tokens[close], ')')) continue;

            const varName = tokens[argIdx].value;
            // Replace span k..close with: label ( <var> )
            tokens.splice(k, close - k + 1,
                { kind: 'ident', value: 'label' },
                { kind: 'punc', value: '(' },
                { kind: 'ident', value: varName },
                { kind: 'punc', value: ')' },
            );
            continue;
        }
    }

    // --- Pass 1.2: named paths. Kuzu has no `MATCH p = (…)` binding; it exposes
    // path nodes/rels via the recursive-rel variable. Strip `p =`, ensure the
    // recursive rel has a variable, and rewrite `nodes(p)`/`rels(p)` to operate
    // on that variable (`nodes(r)`/`rels(r)` are valid on a RECURSIVE_REL).
    rewriteNamedPaths(tokens);

    // --- Pass 1.3: list comprehensions → Kuzu list_transform / list_filter.
    //   [v IN L | E]          -> list_transform(L, v -> E)
    //   [v IN L WHERE P]      -> list_filter(L, v -> P)
    //   [v IN L WHERE P | E]  -> list_transform(list_filter(L, v -> P), v -> E)
    rewriteListComprehensions(tokens);

    // --- Pass 1.4: MERGE on a labelled node → MERGE on the uid PK. Kuzu requires
    // the primary key in the MERGE pattern; the app MERGEs on business keys
    // (name+file, url, …). We rewrite to `MERGE (v:CodeNode {uid: <expr>}) ON
    // CREATE SET v.label=…, <props>, v.seq=$__seqN`, deriving uid from an explicit
    // `{uid:…}` (kept canonical, e.g. Effect) or generically from label+props.
    rewriteMergeForLadybug(tokens, acc);

    // --- Pass 1.5: `SET var:Label` (Neo4j label-add) → single-table column.
    // Must run before rule 5 (which would otherwise turn it into `var.label =
    // 'Label'` and clobber the primary label). Component/HTTPHandler/RuntimeDOM
    // fold to their boolean columns; any other (AST/ControlFlow subtype) → astType.
    rewriteSetLabels(tokens);

    // --- Pass 2: node-pattern labels (rule 4) and boolean label predicates (rule 5).
    // We walk with nesting depths. A node pattern is detected by `(` ... and a
    // label colon directly after the optional variable. We rewrite in place.
    rewriteStructural(tokens, acc);

    // --- Pass 3: collapse multi-type rel patterns. The app builds edge filters
    // as `:A|:B` (each type colon-prefixed); Kuzu wants ONE leading colon:
    // `[:A|:B*1..6]` -> `[:A|B*1..6]`. Drop any ':' inside `[...]` that directly
    // follows a '|'.
    collapseRelTypeColons(tokens);

    // --- Pass 4: list indices are 1-based in Kuzu (0-based in Neo4j). Increment a
    // numeric index that directly follows an operand: `xs[0]` -> `xs[1]`. Skips
    // list literals (`IN [1,2]`), rel var-length (`-[:R*0..2]`) and variable
    // indices (`xs[i]`, left as-is). `labels(x)[0]` was already folded to the
    // scalar `x.label` in pass 1.
    incrementListIndices(tokens);

    // Re-serialise
    const out = tokens.map(t => t.value).join('');
    return { cypher: out, injectNow, creates: acc.creates };
}

// Idents that are NOT value-producing operands, so a following `[` is a list
// literal (`IN [1,2]`), not an index expression.
const NON_OPERAND_KW = new Set([
    'in', 'and', 'or', 'xor', 'not', 'as', 'by', 'when', 'then', 'else', 'distinct',
    'contains', 'starts', 'ends', 'where', 'return', 'with', 'set', 'merge', 'match',
    'create', 'unwind', 'delete', 'remove', 'on', 'order', 'limit', 'skip', 'union',
    'optional', 'foreach', 'call', 'detach',
]);

function incrementListIndices(tokens) {
    let k = 0;
    while (k < tokens.length) {
        if (isPunc(tokens[k], '[')) {
            const prev = prevNonWs(tokens, k - 1);
            const operand = prev !== -1 && (
                isPunc(tokens[prev], ')') || isPunc(tokens[prev], ']') ||
                tokens[prev].kind === 'param' || tokens[prev].kind === 'string' || tokens[prev].kind === 'num' ||
                (isIdent(tokens[prev]) && !NON_OPERAND_KW.has(tokens[prev].value.toLowerCase()))
            );
            if (operand) {
                const numIdx = nextNonWs(tokens, k + 1);
                const closeIdx = numIdx !== -1 ? nextNonWs(tokens, numIdx + 1) : -1;
                if (numIdx !== -1 && tokens[numIdx].kind === 'num' && /^[0-9]+$/.test(tokens[numIdx].value) &&
                    closeIdx !== -1 && isPunc(tokens[closeIdx], ']')) {
                    tokens[numIdx] = { kind: 'num', value: String(parseInt(tokens[numIdx].value, 10) + 1) };
                }
            }
        }
        k++;
    }
}

/**
 * Walk the token stream tracking ( ) { } [ ] depth, applying:
 *   - rule 4 inside node patterns `(...)`
 *   - rule 5 for boolean `var:Label` predicates outside patterns/maps
 *
 * Mutates `tokens` in place.
 */
function rewriteStructural(tokens, acc) {
    // We process node patterns first by scanning for '(' that begins a node
    // pattern. To keep the indices valid while we splice, we rebuild forward.
    // `clause` tracks the most recent top-level clause keyword so a CREATE node
    // pattern can be told apart from a MATCH/MERGE one (only CREATE needs uid/seq
    // injected). MERGE deliberately does NOT inject — adding uid/seq to a MERGE
    // pattern would change its match key; the handlers only ever MERGE on
    // already-bound vars, never on a labelled new node.
    let k = 0;
    let clause = null;
    while (k < tokens.length) {
        const t = tokens[k];

        if (isIdent(t)) {
            const kw = t.value.toLowerCase();
            if (kw === 'match' || kw === 'merge' || kw === 'create' || kw === 'where' ||
                kw === 'with' || kw === 'return' || kw === 'set' || kw === 'delete' ||
                kw === 'remove' || kw === 'unwind' || kw === 'foreach' || kw === 'call') {
                clause = kw;
            }
        }

        if (isPunc(t, '(')) {
            // Examine the inside of this paren group up to the matching ')'
            // BUT a node pattern's label sits right after `(` and an optional
            // variable, before the first `{`, `)`, or `-`/`<`/`[` (rel) token.
            const consumed = tryRewriteNodePattern(tokens, k, clause === 'create', acc);
            if (consumed > 0) {
                k += consumed; // advance past the (possibly grown) pattern
                continue;
            }
        }

        k++;
    }

    // Now rule 5: boolean label predicates. Re-tokenised positions are fine
    // since pass for rule 4 is complete. We look for the pattern:
    //   <ident var> : <ident Label>
    // where the colon is NOT inside () or {} (i.e. not a pattern/map) and the
    // preceding meaningful token is not '.' or another colon. Optional leading
    // NOT flips = to <>.
    rewriteBooleanLabelPredicates(tokens);
}

/**
 * True if the paren group opening at `open` is immediately followed (after its
 * matching ')') by a relationship token (`-` or `<`). Used to tell a WHERE
 * pattern-existence predicate `(a:File)-[…]->(…)` apart from a boolean grouping
 * `(n:A OR n:B)`, which is not followed by a relationship.
 */
function patternFollowedByRel(tokens, open) {
    let depth = 0;
    for (let k = open; k < tokens.length; k++) {
        if (isPunc(tokens[k], '(')) depth++;
        else if (isPunc(tokens[k], ')')) {
            depth--;
            if (depth === 0) {
                const nxt = nextNonWs(tokens, k + 1);
                return nxt !== -1 && (isPunc(tokens[nxt], '-') || isPunc(tokens[nxt], '<'));
            }
        }
    }
    return false;
}

/**
 * If the `(` at index `open` begins a node pattern with a label, rewrite the
 * label into the single-table form and return the number of tokens the
 * (rewritten) pattern occupies so the caller can advance. Returns 0 if this
 * paren is not a label-bearing node pattern we should touch.
 */
function tryRewriteNodePattern(tokens, open, inCreate, acc) {
    // Find matching close paren at the same depth.
    let depth = 0;
    let close = -1;
    for (let k = open; k < tokens.length; k++) {
        if (isPunc(tokens[k], '(')) depth++;
        else if (isPunc(tokens[k], ')')) {
            depth--;
            if (depth === 0) { close = k; break; }
        }
    }
    if (close === -1) return 0;

    // Guard: a '(' only begins a NODE PATTERN in *pattern position*. In
    // *expression position* — e.g. `WHERE n.x = 1 AND (n:Function OR n:Class)` —
    // the parens are a boolean grouping and the inner `n:Label` are predicates
    // (rule 5), NOT a node pattern. Without this guard rule 4 mis-rewrites the
    // first `(n:Function ...` into `(n:CodeNode {label:'Function'} OR ...`,
    // which is a parser error. Disambiguate via the token immediately before '('.
    const prevTok = prevNonWs(tokens, open - 1);
    if (prevTok !== -1) {
        const pt = tokens[prevTok];
        let introducer = false;
        if (isIdent(pt)) {
            const kw = pt.value.toLowerCase();
            // MATCH/MERGE/CREATE/OPTIONAL precede a pattern; any other ident
            // (AND/OR/WHERE/XOR or a function name like count/size) does not.
            introducer = kw === 'match' || kw === 'merge' || kw === 'create' || kw === 'optional';
            // `WHERE NOT (a:File)-[…]->(…)` is a pattern-existence predicate — the
            // '(' after NOT starts a node pattern, NOT a boolean group. Disambiguate
            // by the relationship that must follow the closing ')': a boolean group
            // like `NOT (n:A OR n:B)` is not followed by a relationship and stays
            // with rule 5.
            if (!introducer && kw === 'not') {
                introducer = patternFollowedByRel(tokens, open);
            }
        } else if (pt.kind === 'punc') {
            if (pt.value === ',' || pt.value === '-') {
                introducer = true; // pattern list, or relationship `-(`
            } else if (pt.value === '>') {
                // relationship arrow `->(`: the '>' must itself follow a '-'
                const pp = prevNonWs(tokens, prevTok - 1);
                introducer = pp !== -1 && isPunc(tokens[pp], '-');
            } else if (pt.value === '=') {
                // named-path binding `MATCH p = (…)-…`: the '(' after '=' begins the
                // path's first node pattern. (A value expression `= (a + 1)` has no
                // `var:Label` inside, so it is left untouched below anyway.)
                introducer = true;
            } else if (pt.value === '(') {
                // `shortestPath((…)-…)` / `allShortestPaths((…))`: the inner '(' is a
                // node pattern when the enclosing call is a path function.
                const pp = prevNonWs(tokens, prevTok - 1);
                if (pp !== -1 && isIdent(tokens[pp])) {
                    const fn = tokens[pp].value.toLowerCase();
                    introducer = fn === 'shortestpath' || fn === 'allshortestpaths';
                }
            }
        }
        if (!introducer) return 0;
    }

    // Inside: [ws] [var] [ws] : [ws] Label [ (:Label2)* ] [ws] [ { ... } ] [ws]
    // First meaningful token after '('
    let p = nextNonWs(tokens, open + 1);
    if (p === -1 || p >= close) return 0; // empty ()

    // Optional variable
    let varName = null;
    let colonIdx = -1;
    if (isIdent(tokens[p])) {
        const after = nextNonWs(tokens, p + 1);
        if (after !== -1 && isPunc(tokens[after], ':')) {
            varName = tokens[p].value;
            colonIdx = after;
        } else {
            // ident not followed by ':' → e.g. (n {..}) or (n) — no label. nothing to do.
            return 0;
        }
    } else if (isPunc(tokens[p], ':')) {
        // anonymous (:Label)
        varName = null;
        colonIdx = p;
    } else {
        // starts with { or something else — not a label pattern
        return 0;
    }

    // Label ident must follow the colon
    const labelIdx = nextNonWs(tokens, colonIdx + 1);
    if (labelIdx === -1 || labelIdx >= close || !isIdent(tokens[labelIdx])) return 0;
    const firstLabel = tokens[labelIdx].value;

    // Already canonical? leave it.
    if (firstLabel === 'CodeNode') return 0;

    // Collect any extra labels `:B:C` (multi-label) — keep first, drop rest.
    let scan = nextNonWs(tokens, labelIdx + 1);
    let lastLabelTokenIdx = labelIdx; // end of the label chain we will replace
    const extraLabels = [];
    while (scan !== -1 && scan < close && isPunc(tokens[scan], ':')) {
        const lbl = nextNonWs(tokens, scan + 1);
        if (lbl === -1 || lbl >= close || !isIdent(tokens[lbl])) break;
        extraLabels.push(tokens[lbl].value);
        lastLabelTokenIdx = lbl;
        scan = nextNonWs(tokens, lbl + 1);
    }
    // Zusatzlabels dürfen nur modellierte Fold-ins sein. Stilles Verwerfen
    // erzeugte sonst gültige, aber falsche Leermengen bei Strukturabfragen.
    const primaryLabel = FOLD_IN_LABELS[firstLabel] ? null : firstLabel;
    const foldInLabels = primaryLabel ? extraLabels : [firstLabel, ...extraLabels];
    const unsupported = foldInLabels.filter(label => !FOLD_IN_LABELS[label]);
    if (unsupported.length > 0) {
        throw new Error(
            `unsupported multi-label node pattern (${varName || ''}:${firstLabel}:${extraLabels.join(':')}): ` +
            `no fold-in column for ${unsupported.join(', ')}`,
        );
    }

    // CREATE needs uid (PK) + seq (id()-replacement) which the handlers' CREATE
    // statements omit (Neo4j auto-assigns them). Build the injection tokens
    //   uid:$__uidN, seq:$__seqN
    // and register the param names so the driver/daemon can fill them.
    let idTokens = null;
    if (inCreate && acc) {
        const idx = acc.creates.length;
        const sfx = idx === 0 ? '' : String(idx + 1); // '', '2', '3', …
        const prefixLabel = primaryLabel || firstLabel;
        const prefix = CREATE_UID_PREFIX[prefixLabel] || (prefixLabel.toLowerCase() + ':');
        acc.creates.push({ uidParam: '__uid' + sfx, seqParam: '__seq' + sfx, prefix });
        idTokens = [
            { kind: 'ident', value: 'uid' }, { kind: 'punc', value: ':' }, { kind: 'param', value: '$__uid' + sfx },
            { kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' },
            { kind: 'ident', value: 'seq' }, { kind: 'punc', value: ':' }, { kind: 'param', value: '$__seq' + sfx },
        ];
    }

    // Is there an existing inline property map after the label chain?
    const mapStart = nextNonWs(tokens, lastLabelTokenIdx + 1);
    const hasMap = mapStart !== -1 && mapStart < close && isPunc(tokens[mapStart], '{');

    // Build replacement tokens for the span colonIdx .. (label chain end / map).
    // Target shapes:
    //   (var:Foo)          -> (var:CodeNode {label:'Foo'})
    //   (var:Foo {k:v})    -> (var:CodeNode {label:'Foo', k:v})
    //   (:Foo)             -> (:CodeNode {label:'Foo'})

    if (hasMap) {
        // Splice label:'Foo', into the existing map right after its '{'.
        // We rewrite the colon..lastLabel span to ":CodeNode" and leave the
        // existing whitespace before the map intact (so we add NO trailing
        // space here — otherwise `(t:Task {..})` would gain a double space),
        // then inject `label:'Foo', ` right after the map's '{'.
        const repl = [
            { kind: 'punc', value: ':' },
            { kind: 'ident', value: 'CodeNode' },
        ];

        // 1) Replace colonIdx..lastLabelTokenIdx with ":CodeNode".
        tokens.splice(colonIdx, lastLabelTokenIdx - colonIdx + 1, ...repl);

        // Recompute indices after the first splice for the map's '{'.
        const delta = repl.length - (lastLabelTokenIdx - colonIdx + 1);
        const newClose = close + delta;
        // Find the '{' again from the colon area.
        const braceIdx = (() => {
            for (let k = colonIdx; k < newClose; k++) {
                if (isPunc(tokens[k], '{')) return k;
            }
            return -1;
        })();
        if (braceIdx !== -1) {
            // Peek: is the map empty? `{}` or `{ }`
            const afterBrace = nextNonWs(tokens, braceIdx + 1);
            const mapEmpty = afterBrace !== -1 && isPunc(tokens[afterBrace], '}');
            const inject = [];
            if (primaryLabel) {
                inject.push(
                    { kind: 'ident', value: 'label' },
                    { kind: 'punc', value: ':' },
                    { kind: 'string', value: `'${primaryLabel}'` },
                );
            }
            for (const label of foldInLabels) {
                if (inject.length) inject.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' });
                inject.push(
                    { kind: 'ident', value: FOLD_IN_LABELS[label] },
                    { kind: 'punc', value: ':' },
                    { kind: 'ident', value: 'true' },
                );
            }
            if (idTokens) {
                if (inject.length) inject.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' });
                inject.push(...idTokens);
            }
            if (!mapEmpty) {
                inject.push({ kind: 'punc', value: ',' });
                inject.push({ kind: 'ws', value: ' ' });
            }
            tokens.splice(braceIdx + 1, 0, ...inject);
        }
    } else {
        // No existing map → replace colon..lastLabel with ":CodeNode {label:'Foo'}"
        const full = [
            { kind: 'punc', value: ':' },
            { kind: 'ident', value: 'CodeNode' },
            { kind: 'ws', value: ' ' },
            { kind: 'punc', value: '{' },
        ];
        if (primaryLabel) {
            full.push(
                { kind: 'ident', value: 'label' }, { kind: 'punc', value: ':' },
                { kind: 'string', value: `'${primaryLabel}'` },
            );
        }
        for (const label of foldInLabels) {
            if (full[full.length - 1].value !== '{') full.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' });
            full.push(
                { kind: 'ident', value: FOLD_IN_LABELS[label] }, { kind: 'punc', value: ':' },
                { kind: 'ident', value: 'true' },
            );
        }
        if (idTokens) {
            if (full[full.length - 1].value !== '{') full.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' });
            full.push(...idTokens);
        }
        full.push({ kind: 'punc', value: '}' });
        tokens.splice(colonIdx, lastLabelTokenIdx - colonIdx + 1, ...full);
    }

    // After rewriting, recompute the matching close to return how far to skip.
    // Simplest correct approach: re-find the matching ')' from `open`.
    let d = 0;
    let newClose = -1;
    for (let k = open; k < tokens.length; k++) {
        if (isPunc(tokens[k], '(')) d++;
        else if (isPunc(tokens[k], ')')) {
            d--;
            if (d === 0) { newClose = k; break; }
        }
    }
    if (newClose === -1) return tokens.length - open; // shouldn't happen
    return newClose - open + 1;
}

/**
 * Rewrite boolean label predicates outside of patterns/maps:
 *   var:Foo        -> var.label = 'Foo'
 *   NOT var:Foo    -> var.label <> 'Foo'
 *
 * Heuristics for "this colon is a boolean label predicate":
 *   - we are at paren/brace/bracket depth 0 (boolean expression context such
 *     as WHERE; the structural rewrite for node patterns has already run, so
 *     any remaining `var:Label` at depth 0 must be a predicate, not a pattern)
 *   - token sequence: <ident> [ws] ':' [ws] <ident>
 *   - the ident before the colon is NOT preceded by '.' (so it's a variable,
 *     not a property access) and NOT preceded by ':' (chained label)
 *   - the colon is not immediately followed by another ':' (multi-label noise)
 *
 * NOTE: at depth>0 we deliberately do nothing: inside () it's a pattern label
 * (handled by rule 4), inside {} it's a map entry, inside [] it's a rel type /
 * list. This keeps map keys and pattern labels safe.
 */
function rewriteBooleanLabelPredicates(tokens) {
    let depth = 0;        // () depth
    let brace = 0;        // {} depth
    let bracket = 0;      // [] depth

    let k = 0;
    while (k < tokens.length) {
        const t = tokens[k];
        if (t.kind === 'punc') {
            if (t.value === '(') { depth++; k++; continue; }
            if (t.value === ')') { depth--; k++; continue; }
            if (t.value === '{') { brace++; k++; continue; }
            if (t.value === '}') { brace--; k++; continue; }
            if (t.value === '[') { bracket++; k++; continue; }
            if (t.value === ']') { bracket--; k++; continue; }

            // Fire at ANY paren depth (boolean groups like `(n:A OR n:B)` live
            // at depth>0), but never inside a map `{}` (brace) or rel type `[]`
            // (bracket). Genuine node-pattern labels have already been rewritten
            // to the canonical `:CodeNode` by rule 4, so a remaining `var:Label`
            // here is a boolean predicate — UNLESS the label IS `CodeNode`, in
            // which case it is rule-4 output and must be left untouched.
            if (t.value === ':' && brace === 0 && bracket === 0) {
                const before = prevNonWs(tokens, k - 1);
                const after = nextNonWs(tokens, k + 1);
                if (before === -1 || after === -1) { k++; continue; }
                if (!isIdent(tokens[before]) || !isIdent(tokens[after])) { k++; continue; }
                if (tokens[after].value === 'CodeNode') { k++; continue; }

                // var must not be a property access (preceded by '.') or part
                // of a label chain (preceded by ':'); and the Label must not be
                // followed by another ':' (multi-label, not a predicate).
                const beforeBefore = prevNonWs(tokens, before - 1);
                if (beforeBefore !== -1 &&
                    (isPunc(tokens[beforeBefore], '.') || isPunc(tokens[beforeBefore], ':'))) {
                    k++; continue;
                }
                const afterAfter = nextNonWs(tokens, after + 1);
                if (afterAfter !== -1 && isPunc(tokens[afterAfter], ':')) {
                    k++; continue;
                }
                // Avoid RETURN/WITH alias `expr AS name`-style colons? Those use
                // AS, not ':', so no conflict. Avoid map-literal `{a:1}` — handled
                // by brace depth. Avoid CASE labels — Cypher CASE uses WHEN/THEN.

                const varName = tokens[before].value;
                const label = tokens[after].value;

                // Detect leading NOT (case-insensitive) to pick = vs <>.
                const notIdx = prevNonWs(tokens, before - 1);
                let op = '=';
                if (notIdx !== -1 && isIdent(tokens[notIdx]) &&
                    tokens[notIdx].value.toLowerCase() === 'not') {
                    op = '<>';
                    // Drop the NOT token (and fold following whitespace).
                    // Replace from notIdx..after with: var.label <> 'Label'
                    const repl = buildPredicateTokens(varName, op, label);
                    tokens.splice(notIdx, after - notIdx + 1, ...repl);
                    k = notIdx + repl.length;
                    continue;
                }

                const repl = buildPredicateTokens(varName, op, label);
                tokens.splice(before, after - before + 1, ...repl);
                k = before + repl.length;
                continue;
            }
        }
        k++;
    }
}

/**
 * Inside relationship brackets `[...]`, drop any ':' that directly follows a
 * '|'. Turns the app's `:A|:B` multi-type syntax into Kuzu's `:A|B`.
 */
function collapseRelTypeColons(tokens) {
    let bracket = 0;
    let k = 0;
    while (k < tokens.length) {
        const t = tokens[k];
        if (isPunc(t, '[')) { bracket++; k++; continue; }
        if (isPunc(t, ']')) { bracket--; k++; continue; }
        if (bracket > 0 && isPunc(t, ':')) {
            const prev = prevNonWs(tokens, k - 1);
            if (prev !== -1 && isPunc(tokens[prev], '|')) {
                tokens.splice(k, 1); // remove the redundant ':'
                continue;            // re-evaluate at the same index
            }
        }
        k++;
    }
}

function buildPredicateTokens(varName, op, label) {
    // Fold-in label predicate: `n:Component` → `n.isComponent = true`.
    // The NEGATED form must be NULL-safe: the boolean facet column is NULL on
    // every node that never had the label, and `NULL <> true` is NULL — which
    // silently drops ALL rows (this made full-mode clears delete nothing).
    // `NOT n:Component` → `coalesce(n.isComponent, false) <> true`.
    const col = FOLD_IN_LABELS[label];
    if (col) {
        const colRef = op === '<>'
            ? [
                { kind: 'ident', value: 'coalesce' },
                { kind: 'punc', value: '(' },
                { kind: 'ident', value: varName },
                { kind: 'punc', value: '.' },
                { kind: 'ident', value: col },
                { kind: 'punc', value: ',' },
                { kind: 'ws', value: ' ' },
                { kind: 'ident', value: 'false' },
                { kind: 'punc', value: ')' },
            ]
            : [
                { kind: 'ident', value: varName },
                { kind: 'punc', value: '.' },
                { kind: 'ident', value: col },
            ];
        return [
            ...colRef,
            { kind: 'ws', value: ' ' },
            { kind: 'punc', value: op[0] },
            ...(op.length > 1 ? [{ kind: 'punc', value: op[1] }] : []),
            { kind: 'ws', value: ' ' },
            { kind: 'ident', value: 'true' },
        ];
    }
    return [
        { kind: 'ident', value: varName },
        { kind: 'punc', value: '.' },
        { kind: 'ident', value: 'label' },
        { kind: 'ws', value: ' ' },
        { kind: 'punc', value: op[0] },
        ...(op.length > 1 ? [{ kind: 'punc', value: op[1] }] : []),
        { kind: 'ws', value: ' ' },
        { kind: 'string', value: `'${label}'` },
    ];
}

// ── named paths → recursive-rel variable ──────────────────────────────────────

/** Rewrite `func(pathVar)` calls to `newFunc(relVar)` across the token stream. */
function rewritePathFnRefs(tokens, fnNames, pathVar, newFn, relVar) {
    for (let i = 0; i < tokens.length; i++) {
        if (isIdent(tokens[i]) && fnNames.includes(tokens[i].value.toLowerCase())) {
            const op = nextNonWs(tokens, i + 1);
            const arg = op !== -1 ? nextNonWs(tokens, op + 1) : -1;
            const cl = arg !== -1 ? nextNonWs(tokens, arg + 1) : -1;
            if (op !== -1 && isPunc(tokens[op], '(') && arg !== -1 && isIdent(tokens[arg]) &&
                tokens[arg].value === pathVar && cl !== -1 && isPunc(tokens[cl], ')')) {
                tokens[i] = { kind: 'ident', value: newFn };
                tokens[arg] = { kind: 'ident', value: relVar };
            }
        }
    }
}

function rewriteNamedPaths(tokens) {
    let k = 0;
    while (k < tokens.length) {
        if (isIdent(tokens[k]) && tokens[k].value.toLowerCase() === 'match') {
            const pv = nextNonWs(tokens, k + 1);
            const eq = pv !== -1 ? nextNonWs(tokens, pv + 1) : -1;
            const par = eq !== -1 ? nextNonWs(tokens, eq + 1) : -1;
            if (pv !== -1 && isIdent(tokens[pv]) && eq !== -1 && isPunc(tokens[eq], '=') &&
                par !== -1 && isPunc(tokens[par], '(')) {
                const pathVar = tokens[pv].value;
                // Find the recursive rel `[ … * … ]` within the pattern (scan from the
                // opening paren to the next clause keyword).
                let relVar = null;
                let bdepth = 0;
                for (let i = par; i < tokens.length; i++) {
                    const t = tokens[i];
                    if (isIdent(t) && bdepth === 0) {
                        const kw = t.value.toLowerCase();
                        if (['where', 'return', 'with', 'merge', 'create', 'set', 'unwind', 'optional', 'match', 'order', 'call'].includes(kw)) break;
                    }
                    if (isPunc(t, '[')) {
                        bdepth++;
                        // Is this a recursive rel? look for '*' before the matching ']'.
                        const close = findMatchingBracket(tokens, i);
                        let hasStar = false;
                        for (let j = i + 1; j < close; j++) if (isPunc(tokens[j], '*')) { hasStar = true; break; }
                        if (hasStar) {
                            const first = nextNonWs(tokens, i + 1);
                            if (first !== -1 && isIdent(tokens[first])) {
                                relVar = tokens[first].value; // already has a var
                            } else {
                                relVar = pathVar + '_rel';
                                tokens.splice(i + 1, 0, { kind: 'ident', value: relVar });
                            }
                            break;
                        }
                        bdepth--; // not recursive; don't track depth into it
                    }
                }
                if (relVar) {
                    rewritePathFnRefs(tokens, ['nodes'], pathVar, 'nodes', relVar);
                    rewritePathFnRefs(tokens, ['relationships', 'rels'], pathVar, 'rels', relVar);
                    // Remove the `pathVar =` binding so it becomes a plain MATCH.
                    tokens.splice(pv, eq - pv + 1);
                }
            }
        }
        k++;
    }
}

// ── list comprehension → list_transform / list_filter ────────────────────────

function findMatchingBracket(tokens, open) {
    let d = 0;
    for (let i = open; i < tokens.length; i++) {
        if (isPunc(tokens[i], '[')) d++;
        else if (isPunc(tokens[i], ']')) { d--; if (d === 0) return i; }
    }
    return -1;
}

function sliceTrim(tokens, a, b) {
    const out = [];
    for (let i = a; i <= b; i++) out.push({ ...tokens[i] });
    while (out.length && out[0].kind === 'ws') out.shift();
    while (out.length && out[out.length - 1].kind === 'ws') out.pop();
    return out;
}

function lambdaTokens(varName, body) {
    return [
        { kind: 'ident', value: varName }, { kind: 'ws', value: ' ' },
        { kind: 'punc', value: '-' }, { kind: 'punc', value: '>' }, { kind: 'ws', value: ' ' },
        ...body,
    ];
}

function callTokens(fn, argGroups) {
    const toks = [{ kind: 'ident', value: fn }, { kind: 'punc', value: '(' }];
    argGroups.forEach((g, i) => {
        if (i > 0) toks.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' });
        toks.push(...g);
    });
    toks.push({ kind: 'punc', value: ')' });
    return toks;
}

function rewriteOneComprehension(tokens, open, varIdx, inIdx, close) {
    const varName = tokens[varIdx].value;
    let whereIdx = -1, pipeIdx = -1, depth = 0;
    for (let i = inIdx + 1; i < close; i++) {
        const t = tokens[i];
        if (t.kind === 'punc') {
            if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
            else if (t.value === ')' || t.value === ']' || t.value === '}') depth--;
            else if (t.value === '|' && depth === 0 && pipeIdx === -1) pipeIdx = i;
        } else if (isIdent(t) && depth === 0 && pipeIdx === -1 && whereIdx === -1 &&
            t.value.toLowerCase() === 'where') {
            whereIdx = i;
        }
    }
    const listEnd = (whereIdx !== -1 ? whereIdx : (pipeIdx !== -1 ? pipeIdx : close)) - 1;
    const listExpr = sliceTrim(tokens, inIdx + 1, listEnd);
    if (listExpr.length === 0) return 0;

    let base = listExpr;
    if (whereIdx !== -1) {
        const predEnd = (pipeIdx !== -1 ? pipeIdx : close) - 1;
        const pred = sliceTrim(tokens, whereIdx + 1, predEnd);
        base = callTokens('list_filter', [listExpr, lambdaTokens(varName, pred)]);
    }
    let result = base;
    if (pipeIdx !== -1) {
        const mapExpr = sliceTrim(tokens, pipeIdx + 1, close - 1);
        result = callTokens('list_transform', [base, lambdaTokens(varName, mapExpr)]);
    }
    tokens.splice(open, close - open + 1, ...result);
    return open + result.length;
}

function rewriteListComprehensions(tokens) {
    let k = 0;
    while (k < tokens.length) {
        if (isPunc(tokens[k], '[')) {
            const v = nextNonWs(tokens, k + 1);
            const inIdx = v !== -1 ? nextNonWs(tokens, v + 1) : -1;
            if (v !== -1 && isIdent(tokens[v]) && inIdx !== -1 && isIdent(tokens[inIdx]) &&
                tokens[inIdx].value.toLowerCase() === 'in') {
                const close = findMatchingBracket(tokens, k);
                if (close !== -1) {
                    const next = rewriteOneComprehension(tokens, k, v, inIdx, close);
                    if (next > 0) { k = next; continue; }
                }
            }
        }
        k++;
    }
}

// ── MERGE → uid PK rewrite ────────────────────────────────────────────────────

function findMatchingParen(tokens, open) {
    let d = 0;
    for (let i = open; i < tokens.length; i++) {
        if (isPunc(tokens[i], '(')) d++;
        else if (isPunc(tokens[i], ')')) { d--; if (d === 0) return i; }
    }
    return -1;
}

/** Parse a property map `{ k1: v1, k2: v2 }` → [{key, valTokens:[…]}]. */
function parseMapEntries(tokens, braceOpen, braceClose) {
    const entries = [];
    let i = nextNonWs(tokens, braceOpen + 1);
    while (i !== -1 && i < braceClose) {
        if (!isIdent(tokens[i])) break;
        const key = tokens[i].value;
        const colon = nextNonWs(tokens, i + 1);
        if (colon === -1 || !isPunc(tokens[colon], ':')) break;
        let j = nextNonWs(tokens, colon + 1);
        let depth = 0;
        const valTokens = [];
        while (j !== -1 && j < braceClose) {
            const tj = tokens[j];
            if (tj.kind === 'punc') {
                if (tj.value === '(' || tj.value === '[' || tj.value === '{') depth++;
                else if (tj.value === ')' || tj.value === ']' || tj.value === '}') depth--;
                else if (tj.value === ',' && depth === 0) break;
            }
            valTokens.push(tj);
            j++;
        }
        while (valTokens.length && valTokens[valTokens.length - 1].kind === 'ws') valTokens.pop();
        entries.push({ key, valTokens });
        if (j < braceClose && isPunc(tokens[j], ',')) i = nextNonWs(tokens, j + 1);
        else break;
    }
    return entries;
}

const PLUS = () => [{ kind: 'ws', value: ' ' }, { kind: 'punc', value: '+' }, { kind: 'ws', value: ' ' }];

/** Build a deterministic uid expression `'Label||k1=' + v1 + '||k2=' + v2 …`. */
function buildGenericUidTokens(label, entries) {
    if (entries.length === 0) return [{ kind: 'string', value: `'${label}'` }];
    // Sort keys canonically so the derived uid does NOT depend on the order the
    // caller wrote the MERGE props: `MERGE (s {name,file})` and `MERGE (s {file,name})`
    // are the same logical node and must derive the SAME uid — otherwise Kuzu
    // treats them as two different primary keys and you get duplicate nodes for
    // one logical node. This is the single place uids are generated, so sorting
    // here keeps every read and write of a given node's uid consistent.
    const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const toks = [];
    sorted.forEach((e, i) => {
        if (i > 0) toks.push(...PLUS());
        toks.push({ kind: 'string', value: i === 0 ? `'${label}||${e.key}='` : `'||${e.key}='` });
        toks.push(...PLUS());
        toks.push(...e.valTokens.map(t => ({ ...t })));
    });
    return toks;
}

/**
 * Neutralise a `SET <var>.uid = <expr>` assignment (uid is the PK now and cannot
 * be SET) by turning it into the no-op `<var>.label = <var>.label`, which keeps
 * the SET list shape (commas) intact. Scans from `from` to the next clause that
 * ends the SET region.
 */
function stripUidSet(tokens, from, varName) {
    for (let i = from; i < tokens.length; i++) {
        const t = tokens[i];
        if (isIdent(t)) {
            const kw = t.value.toLowerCase();
            if (kw === 'return' || kw === 'merge' || kw === 'match' || kw === 'create' || kw === 'union') return;
            if (t.value === varName) {
                const dot = nextNonWs(tokens, i + 1);
                const uid = dot !== -1 ? nextNonWs(tokens, dot + 1) : -1;
                if (dot !== -1 && isPunc(tokens[dot], '.') && uid !== -1 && isIdent(tokens[uid]) && tokens[uid].value === 'uid') {
                    const eq = nextNonWs(tokens, uid + 1);
                    if (eq !== -1 && isPunc(tokens[eq], '=')) {
                        let j = nextNonWs(tokens, eq + 1), depth = 0, end = eq;
                        while (j !== -1 && j < tokens.length) {
                            const tj = tokens[j];
                            if (tj.kind === 'punc') {
                                if ('([{'.includes(tj.value)) depth++;
                                else if (')]}'.includes(tj.value)) { if (depth === 0) break; depth--; }
                                else if (tj.value === ',' && depth === 0) break;
                            }
                            if (isIdent(tj) && depth === 0 &&
                                ['return', 'merge', 'match', 'create', 'with', 'union', 'on'].includes(tj.value.toLowerCase())) break;
                            if (tj.kind !== 'ws') end = j; // don't swallow trailing whitespace separator
                            j++;
                        }
                        const noop = [
                            { kind: 'ident', value: varName }, { kind: 'punc', value: '.' }, { kind: 'ident', value: 'label' },
                            { kind: 'ws', value: ' ' }, { kind: 'punc', value: '=' }, { kind: 'ws', value: ' ' },
                            { kind: 'ident', value: varName }, { kind: 'punc', value: '.' }, { kind: 'ident', value: 'label' },
                        ];
                        tokens.splice(i, end - i + 1, ...noop);
                        return;
                    }
                }
            }
        }
    }
}

function rewriteOneMerge(tokens, open, acc) {
    const close = findMatchingParen(tokens, open);
    if (close === -1) return 0;
    // Only standalone node patterns (no relationship hanging off the right).
    const afterClose = nextNonWs(tokens, close + 1);
    if (afterClose !== -1 && (isPunc(tokens[afterClose], '-') || isPunc(tokens[afterClose], '<'))) return 0;

    let p = nextNonWs(tokens, open + 1);
    if (p === -1 || p >= close) return 0;
    let varName = null, colonIdx = -1;
    if (isIdent(tokens[p])) {
        const a = nextNonWs(tokens, p + 1);
        if (a !== -1 && isPunc(tokens[a], ':')) { varName = tokens[p].value; colonIdx = a; }
        else return 0; // bound var, no label (e.g. (cls)-[…])
    } else if (isPunc(tokens[p], ':')) { colonIdx = p; }
    else return 0;
    if (!varName) return 0; // ON CREATE SET needs a variable; the app always names MERGE nodes

    const labelIdx = nextNonWs(tokens, colonIdx + 1);
    if (labelIdx === -1 || labelIdx >= close || !isIdent(tokens[labelIdx])) return 0;
    const primaryLabel = tokens[labelIdx].value;
    if (primaryLabel === 'CodeNode') return 0;

    let scan = nextNonWs(tokens, labelIdx + 1);
    let lastLabelIdx = labelIdx;
    const extraLabels = [];
    while (scan !== -1 && scan < close && isPunc(tokens[scan], ':')) {
        const lbl = nextNonWs(tokens, scan + 1);
        if (lbl === -1 || lbl >= close || !isIdent(tokens[lbl])) break;
        extraLabels.push(tokens[lbl].value); lastLabelIdx = lbl;
        scan = nextNonWs(tokens, lbl + 1);
    }
    const unsupported = extraLabels.filter(label => !FOLD_IN_LABELS[label]);
    if (unsupported.length > 0) {
        throw new Error(
            `unsupported multi-label node pattern (${varName}:${primaryLabel}:${extraLabels.join(':')}): ` +
            `no fold-in column for ${unsupported.join(', ')}`,
        );
    }

    const mapStart = nextNonWs(tokens, lastLabelIdx + 1);
    const hasMap = mapStart !== -1 && mapStart < close && isPunc(tokens[mapStart], '{');
    let mapEntries = [];
    if (hasMap) {
        let d = 0, mapClose = -1;
        for (let i = mapStart; i <= close; i++) {
            if (isPunc(tokens[i], '{')) d++;
            else if (isPunc(tokens[i], '}')) { d--; if (d === 0) { mapClose = i; break; } }
        }
        if (mapClose !== -1) mapEntries = parseMapEntries(tokens, mapStart, mapClose);
    }

    const uidEntry = mapEntries.find(e => e.key === 'uid');
    const uidTokens = uidEntry
        ? uidEntry.valTokens.map(t => ({ ...t }))
        : buildGenericUidTokens(primaryLabel, mapEntries);
    const onCreateProps = uidEntry ? mapEntries.filter(e => e.key !== 'uid') : mapEntries.slice();

    const idx = acc.creates.length;
    const sfx = idx === 0 ? '' : String(idx + 1);
    acc.creates.push({ uidParam: null, seqParam: '__seq' + sfx, prefix: null });

    // New node pattern: ( var : CodeNode { uid: <uidTokens> } )
    const pat = [{ kind: 'punc', value: '(' }, { kind: 'ident', value: varName },
        { kind: 'punc', value: ':' }, { kind: 'ident', value: 'CodeNode' }, { kind: 'ws', value: ' ' },
        { kind: 'punc', value: '{' }, { kind: 'ident', value: 'uid' }, { kind: 'punc', value: ':' }, { kind: 'ws', value: ' ' },
        ...uidTokens, { kind: 'punc', value: '}' }, { kind: 'punc', value: ')' }];

    // ON CREATE SET items
    const assign = (col, valToks) => [
        { kind: 'ident', value: varName }, { kind: 'punc', value: '.' }, { kind: 'ident', value: col },
        { kind: 'ws', value: ' ' }, { kind: 'punc', value: '=' }, { kind: 'ws', value: ' ' }, ...valToks,
    ];
    const items = [assign('label', [{ kind: 'string', value: `'${primaryLabel}'` }])];
    for (const e of onCreateProps) items.push(assign(e.key, e.valTokens.map(t => ({ ...t }))));
    const managedFoldIns = FOLD_INS_BY_PRIMARY[primaryLabel] || extraLabels;
    for (const label of managedFoldIns) {
        const value = extraLabels.includes(label) ? 'true' : 'false';
        items.push(assign(FOLD_IN_LABELS[label], [{ kind: 'ident', value }]));
    }
    items.push(assign('seq', [{ kind: 'param', value: '$__seq' + sfx }]));

    const onCreate = [{ kind: 'ws', value: ' ' }, { kind: 'ident', value: 'ON' }, { kind: 'ws', value: ' ' },
        { kind: 'ident', value: 'CREATE' }, { kind: 'ws', value: ' ' }, { kind: 'ident', value: 'SET' }, { kind: 'ws', value: ' ' }];
    items.forEach((it, i) => { if (i > 0) onCreate.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' }); onCreate.push(...it); });

    // Fehlende Facetten werden unbedingt auf false gesetzt: Ohne diesen Zweig
    // blieb z.B. isComponent nach entferntem JSX bei Smart-Builds dauerhaft true.
    const resetSet = [];
    const absentFoldIns = managedFoldIns.filter(label => !extraLabels.includes(label));
    if (absentFoldIns.length > 0) {
        resetSet.push(
            { kind: 'ws', value: ' ' }, { kind: 'ident', value: 'SET' }, { kind: 'ws', value: ' ' },
        );
        absentFoldIns.forEach((label, i) => {
            if (i > 0) resetSet.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' });
            resetSet.push(...assign(FOLD_IN_LABELS[label], [{ kind: 'ident', value: 'false' }]));
        });
    }

    const replacement = [...pat, ...onCreate, ...resetSet];
    tokens.splice(open, close - open + 1, ...replacement);

    if (!uidEntry) stripUidSet(tokens, open + replacement.length, varName);

    // Explizite true-Facetten gehören auch in den normalen SET-Zweig, damit
    // bestehende Knoten unabhängig vom ON-CREATE-Pfad aktualisiert werden.
    const presentAssignments = extraLabels.map(label => assign(
        FOLD_IN_LABELS[label], [{ kind: 'ident', value: 'true' }],
    ));
    if (presentAssignments.length > 0) {
        let setIdx = -1;
        for (let i = open + replacement.length; i < tokens.length; i++) {
            if (isIdent(tokens[i]) && tokens[i].value.toLowerCase() === 'set') { setIdx = i; break; }
            if (isIdent(tokens[i]) && ['match', 'merge', 'create', 'return', 'with', 'union'].includes(tokens[i].value.toLowerCase())) break;
        }
        const injected = [];
        presentAssignments.forEach((assignment, i) => {
            if (i > 0) injected.push({ kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' });
            injected.push(...assignment);
        });
        injected.push(
            { kind: 'punc', value: ',' }, { kind: 'ws', value: ' ' },
            ...assign('label', [
                { kind: 'ident', value: varName }, { kind: 'punc', value: '.' }, { kind: 'ident', value: 'label' },
            ]),
        );
        if (setIdx !== -1) {
            injected.push({ kind: 'punc', value: ',' });
            tokens.splice(setIdx + 1, 0, { kind: 'ws', value: ' ' }, ...injected);
        } else {
            tokens.splice(open + replacement.length, 0,
                { kind: 'ws', value: ' ' }, { kind: 'ident', value: 'SET' }, { kind: 'ws', value: ' ' }, ...injected);
        }
    }
    return open + replacement.length;
}

function rewriteMergeForLadybug(tokens, acc) {
    let k = 0;
    while (k < tokens.length) {
        const t = tokens[k];
        if (isIdent(t) && t.value.toLowerCase() === 'merge') {
            const open = nextNonWs(tokens, k + 1);
            if (open !== -1 && isPunc(tokens[open], '(')) {
                const next = rewriteOneMerge(tokens, open, acc);
                if (next > 0) { k = next; continue; }
            }
        }
        k++;
    }
}

/**
 * Pass 1.5 — rewrite `SET var:Label` (Neo4j dynamic label-add) into a single-
 * table column assignment. Walks SET assignment lists (from a `SET` keyword up
 * to the next clause keyword) and, at statement level (not inside ()/{}/[]),
 * converts a `var : Label` item:
 *   Component/HTTPHandler/RuntimeDOM → `var.<col> = true`
 *   anything else (AST / ControlFlow subtype) → `var.astType = 'Label'`
 */
function rewriteSetLabels(tokens) {
    let inSet = false;
    let depth = 0, brace = 0, bracket = 0;
    let k = 0;
    while (k < tokens.length) {
        const t = tokens[k];
        if (t.kind === 'punc') {
            if (t.value === '(') depth++;
            else if (t.value === ')') depth--;
            else if (t.value === '{') brace++;
            else if (t.value === '}') brace--;
            else if (t.value === '[') bracket++;
            else if (t.value === ']') bracket--;
        }
        if (isIdent(t)) {
            const kw = t.value.toLowerCase();
            if (kw === 'set') { inSet = true; k++; continue; }
            if (inSet && CLAUSE_KW.has(kw)) { inSet = false; }
        }
        if (inSet && depth === 0 && brace === 0 && bracket === 0 && isPunc(t, ':')) {
            const before = prevNonWs(tokens, k - 1);
            const after = nextNonWs(tokens, k + 1);
            if (before !== -1 && after !== -1 && isIdent(tokens[before]) && isIdent(tokens[after])) {
                const bb = prevNonWs(tokens, before - 1);
                const isProp = bb !== -1 && isPunc(tokens[bb], '.');
                if (!isProp) {
                    const varName = tokens[before].value;
                    const label = tokens[after].value;
                    const col = FOLD_IN_LABELS[label];
                    const rhs = col
                        ? { kind: 'ident', value: 'true' }
                        : { kind: 'string', value: `'${label}'` };
                    const repl = [
                        { kind: 'ident', value: varName },
                        { kind: 'punc', value: '.' },
                        { kind: 'ident', value: col || 'astType' },
                        { kind: 'ws', value: ' ' },
                        { kind: 'punc', value: '=' },
                        { kind: 'ws', value: ' ' },
                        rhs,
                    ];
                    tokens.splice(before, after - before + 1, ...repl);
                    k = before + repl.length;
                    continue;
                }
            }
        }
        k++;
    }
}

// ── Self-test fixtures ──────────────────────────────────────────────────────
// Input/expected pairs covering every translation rule. Exported so the unit
// test suite (tests/translate.test.js) runs them in CI; `node
// server/ladybug-translate.cjs` still works as a quick manual check.
const SELF_TEST_CASES = [
        // 1. timestamp()
        ['SET n.createdAt = timestamp()', 'SET n.createdAt = $__now'],
        ['WHERE n.lockExpires <= timestamp()', 'WHERE n.lockExpires <= $__now'],
        // 2. id() / elementId()
        ['RETURN id(n) AS id', 'RETURN n.seq AS id'],
        ['RETURN id(n) AS id, labels(n) AS labels',
            'RETURN n.seq AS id, [n.label] AS labels'],
        ['RETURN elementId(n) AS eid', 'RETURN n.uid AS eid'],
        // 3. labels()
        ['RETURN labels(x) AS labels', 'RETURN [x.label] AS labels'],
        ['RETURN labels(n)[0] AS type', 'RETURN n.label AS type'],
        ['collect(DISTINCT {name: n.name, type: labels(n)[0], file: n.file})',
            'collect(DISTINCT {name: n.name, type: n.label, file: n.file})'],
        // 4. node pattern labels
        ['MATCH (n:Function) RETURN n', "MATCH (n:CodeNode {label:'Function'}) RETURN n"],
        ['MATCH (n:`Weird Label`) RETURN n', "MATCH (n:CodeNode {label:'Weird Label'}) RETURN n"],
        ['MATCH (a:`Weird Label`)-[:CALLS]->(b:`Weird Label`) RETURN a,b',
            "MATCH (a:CodeNode {label:'Weird Label'})-[:CALLS]->(b:CodeNode {label:'Weird Label'}) RETURN a,b"],
        ['MATCH (:Function) RETURN 1', "MATCH (:CodeNode {label:'Function'}) RETURN 1"],
        ['MATCH (t:Task {taskId:$x})',
            "MATCH (t:CodeNode {label:'Task', taskId:$x})"],
        ['MATCH (n:CodeNode {label:\'Function\'}) RETURN n',
            "MATCH (n:CodeNode {label:'Function'}) RETURN n"], // already canonical
        ['MATCH (a:Function)-[:CALLS|RENDERS*1..3]->(b:Component) RETURN a,b',
            "MATCH (a:CodeNode {label:'Function'})-[:CALLS|RENDERS*1..3]->(b:CodeNode {isComponent:true}) RETURN a,b"],
        // 5. boolean label predicates
        ['MATCH (n) WHERE n:Function RETURN n',
            "MATCH (n) WHERE n.label = 'Function' RETURN n"],
        ['MATCH (n) WHERE n:Function OR n:Component OR n:Task OR n:Knowledge RETURN n',
            "MATCH (n) WHERE n.label = 'Function' OR n.isComponent = true OR n.label = 'Task' OR n.label = 'Knowledge' RETURN n"],
        ['MATCH (n) WHERE NOT n:Function RETURN n',
            "MATCH (n) WHERE n.label <> 'Function' RETURN n"],
        // 6. string-literal & map-key safety (must NOT be corrupted)
        ["MATCH (n) WHERE n.name = 'id(x):Foo timestamp()' RETURN n.value",
            "MATCH (n) WHERE n.name = 'id(x):Foo timestamp()' RETURN n.value"],
        ["RETURN {a:1, b:'x:Y'} AS m", "RETURN {a:1, b:'x:Y'} AS m"],
        // combined realistic
        ['MATCH (n) WHERE n:Function RETURN id(n) AS id, labels(n) AS labels, n.startLine AS startLine',
            "MATCH (n) WHERE n.label = 'Function' RETURN n.seq AS id, [n.label] AS labels, n.startLine AS startLine"],
        // 7. boolean label predicate GROUP in expression position — the '(' is a
        //    grouping paren, NOT a node pattern (rule-4 guard + rule-5 relax).
        ['MATCH (t:Task {taskId: $x}), (n) WHERE n.name = $y AND (n:Function OR n:Class OR n:Component OR n:File) MERGE (t)-[:AFFECTS]->(n)',
            "MATCH (t:CodeNode {label:'Task', taskId: $x}), (n) WHERE n.name = $y AND (n.label = 'Function' OR n.label = 'Class' OR n.isComponent = true OR n.label = 'File') MERGE (t)-[:AFFECTS]->(n)"],
        // 9b. SET label-add (Neo4j dynamic label) → single-table column
        ['MATCH (cf:ControlFlow {elementId:$e, file:$p}) SET cf:IfStatement, cf.kind=$k',
            "MATCH (cf:CodeNode {label:'ControlFlow', elementId:$e, file:$p}) SET cf.astType = 'IfStatement', cf.kind=$k"],
        ['SET handler:HTTPHandler', 'SET handler.isHttpHandler = true'],
        // 9c. list comprehensions → list_transform / list_filter
        ['RETURN [n IN xs | n.name] AS r', 'RETURN list_transform(xs, n -> n.name) AS r'],
        ['RETURN [p IN accepted WHERE NOT p IN passed] AS m', 'RETURN list_filter(accepted, p -> NOT p IN passed) AS m'],
        ['RETURN [m IN matches WHERE m.name IS NOT NULL | m.file] AS d',
            'RETURN list_transform(list_filter(matches, m -> m.name IS NOT NULL), m -> m.file) AS d'],
        // 8. multi-type rel built as `:A|:B` collapses to Kuzu `:A|B`
        ['MATCH (a:Function)-[:CALLS|:RENDERS*1..2]-(b) RETURN count(b) AS c',
            "MATCH (a:CodeNode {label:'Function'})-[:CALLS|RENDERS*1..2]-(b) RETURN count(b) AS c"],
        // 10. NEGATED fold-in labels must be NULL-safe: the boolean facet
        //     column is NULL on nodes that never had the label, and a bare
        //     `col <> true` is NULL -> the whole WHERE matches nothing (this
        //     is the bug that made full-mode clears delete nothing).
        ['MATCH (n) WHERE NOT n:RuntimeDOM RETURN n',
            'MATCH (n) WHERE coalesce(n.isRuntime, false) <> true RETURN n'],
        ['MATCH (n) WHERE NOT n:RuntimeDOM AND NOT n:Counter AND NOT n:Task DETACH DELETE n',
            "MATCH (n) WHERE coalesce(n.isRuntime, false) <> true AND n.label <> 'Counter' AND n.label <> 'Task' DETACH DELETE n"],
        ['MATCH (n) WHERE NOT n:Component RETURN n',
            'MATCH (n) WHERE coalesce(n.isComponent, false) <> true RETURN n'],
];

module.exports = { translate, SELF_TEST_CASES };

// Run directly:  node server/ladybug-translate.cjs
if (require.main === module) {
    let pass = 0;
    let fail = 0;
    for (const [input, expected] of SELF_TEST_CASES) {
        const { cypher } = translate(input);
        const ok = cypher === expected;
        if (ok) pass++; else fail++;
        // eslint-disable-next-line no-console
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input)}`);
        if (!ok) {
            // eslint-disable-next-line no-console
            console.log(`        expected: ${JSON.stringify(expected)}`);
            // eslint-disable-next-line no-console
            console.log(`        got:      ${JSON.stringify(cypher)}`);
        }
    }
    // eslint-disable-next-line no-console
    console.log(`\n${pass}/${pass + fail} passed, ${fail} failed.`);
    process.exit(fail === 0 ? 0 : 1);
}
