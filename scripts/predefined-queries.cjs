/**
 * predefined-queries.cjs — shared catalogue of ready-to-run Cypher queries.
 *
 * Single source of truth for predefined Cypher queries used by:
 *   - tools/handlers/query-tools.ts  (MCP tool `predefined_queries`)
 *   - server/bridge.js               (POST /api/graph/query scan buttons)
 *
 * Both consumers require() this file directly so the list never diverges.
 * Adding a query here automatically makes it available in both the MCP tool
 * and the Explore tab in the dashboard.
 */

'use strict';

const PREDEFINED_QUERIES = [
    {
        name: "direct_recursion",
        description: "Find functions that call themselves directly (direct recursion).",
        query: "MATCH (f:Function)-[:CALLS]->(f) RETURN elementId(f) AS uid, f.ipv6 AS ipv6, f.name AS function, f.file AS file"
    },
    {
        name: "call_graph_coverage",
        description: "Internal call-resolution coverage per file. Third-party/library calls are reported separately and do not depress the percentage.",
        query: "MATCH (f:File) WHERE f.internalCallSites > 0 RETURN f.path AS file, f.callSites AS allSites, f.externalCallSites AS externalSites, f.internalCallSites AS internalSites, f.callsResolved AS resolved, round(100.0 * f.callsResolved / f.internalCallSites, 1) AS percent ORDER BY percent ASC LIMIT 40"
    },
    {
        name: "call_resolution_quality",
        description: "How each call edge was resolved. 'module' and 'imported-symbol' name exactly one target file; 'same-file' is a bare name match and the weakest evidence.",
        query: "MATCH ()-[r:CALLS]->() RETURN r.resolvedBy AS resolvedBy, count(*) AS edges ORDER BY edges DESC"
    },
    {
        name: "recursion",
        description: "Find functions participating in direct or indirect call cycles up to 5 hops.",
        // Starts at 1, not 2: direct recursion is a self-loop and was invisible
        // to this query for as long as the builder refused to write self-calls.
        // Do not project nodes(path) here. The compatibility translator can
        // match this variable-length self-cycle, but Ladybug currently returns
        // an empty node list for the named path. That used to produce twenty
        // empty cycles with `hops = -1`, which looked like a successful scan.
        // Return the verified cycle members instead; `direct_recursion` remains
        // the exact one-hop companion query.
        query: "MATCH (f:Function)-[:CALLS*1..5]->(f) RETURN DISTINCT elementId(f) AS uid, f.ipv6 AS ipv6, f.name AS recursiveFunction, f.file AS file LIMIT 20"
    },
    {
        name: "duplicate_functions_by_callees",
        description: "Find pairs of functions that call the same sub-functions (>=2 shared callees) — strong indicator of code duplication.",
        query: "MATCH (f1:Function)-[:CALLS]->(shared)<-[:CALLS]-(f2:Function) WHERE f1 <> f2 AND f1.name < f2.name WITH f1, f2, collect(shared.name) AS sharedCallees WHERE size(sharedCallees) >= 2 RETURN elementId(f1) AS uid, f1.ipv6 AS ipv6, f1.name AS funcA, f1.file AS fileA, f2.name AS funcB, f2.file AS fileB, sharedCallees, size(sharedCallees) AS overlap ORDER BY overlap DESC"
    },
    {
        name: "duplicate_functions_by_signature",
        description: "Find functions with identical parameter signatures but different names — potential aliases or duplicates.",
        query: "MATCH (f1:Function), (f2:Function) WHERE f1 <> f2 AND f1.name < f2.name AND f1.params = f2.params AND f1.params <> '()' RETURN f1.name AS funcA, f1.file AS fileA, f2.name AS funcB, f2.file AS fileB, f1.params AS sharedSignature"
    },
    {
        name: "duplicate_functions_by_callers_and_callees",
        description: "Find pairs called by the same functions AND calling the same sub-functions — strongest duplication signal.",
        query: "MATCH (caller)-[:CALLS]->(f1:Function)-[:CALLS]->(callee) MATCH (caller)-[:CALLS]->(f2:Function)-[:CALLS]->(callee) WHERE f1 <> f2 AND f1.name < f2.name WITH f1, f2, collect(DISTINCT callee.name) AS sharedCallees, collect(DISTINCT caller.name) AS sharedCallers WHERE size(sharedCallees) >= 1 AND size(sharedCallers) >= 1 RETURN f1.name AS funcA, f2.name AS funcB, sharedCallers, sharedCallees ORDER BY size(sharedCallees) DESC"
    },
    {
        name: "dead_code",
        description: "Classify no-caller functions with counter-evidence. Stale graphs must suppress this query at the UI/API boundary.",
        // PASSES_CALLBACK excluded too: `self.create_timer(0.1, self.on_tick)` never
        // shows up as a CALLS edge (the timer fires it, no code does), so without this
        // every ROS timer/subscription/parameter callback read as dead.
        query: "MATCH (f:Function) WHERE NOT ()-[:CALLS]->(f) AND NOT ()-[:RENDERS]->(f) OPTIONAL MATCH (task:Task)-[:AFFECTS]->(f) OPTIONAL MATCH (callbackSource)-[:PASSES_CALLBACK]->(f) OPTIONAL MATCH (spec)-[:REALIZED_BY]->(f) WITH f, count(DISTINCT task) AS taskSignals, count(DISTINCT callbackSource) AS callbackSignals, count(DISTINCT spec) AS specSignals RETURN elementId(f) AS uid, f.ipv6 AS ipv6, f.name AS function, f.file AS file, CASE WHEN f.isFrameworkEntrypoint = true THEN 'framework_entrypoint' WHEN callbackSignals > 0 THEN 'callback_target' WHEN f.isAbstract = true THEN 'abstract_contract' WHEN f.isPlannedStub = true OR taskSignals > 0 OR specSignals > 0 THEN 'planned_stub' WHEN f.visibility = 'public' THEN 'public_no_static_caller' ELSE 'private_no_caller' END AS category, CASE WHEN f.isFrameworkEntrypoint = true OR callbackSignals > 0 OR f.isAbstract = true OR f.isPlannedStub = true OR taskSignals > 0 OR specSignals > 0 THEN 'none' WHEN f.visibility = 'public' THEN 'low' ELSE 'medium' END AS analysisConfidence, f.visibility AS visibility, f.entryPointKind AS frameworkKind, taskSignals, specSignals, callbackSignals > 0 AS passedAsCallback ORDER BY category, file"
    },
    {
        name: "most_called_functions",
        description: "Find the most frequently called functions — hot paths and central utilities.",
        query: "MATCH ()-[:CALLS]->(f:Function) RETURN f.name AS function, f.file AS file, count(*) AS calledBy ORDER BY calledBy DESC LIMIT 20"
    },
    {
        name: "most_complex_functions",
        description: "Rank explainable refactoring candidates using LOC, decisions, internal fan-out, state writes and module spread; fan-out alone is never a finding.",
        query: "MATCH (f:Function) OPTIONAL MATCH (f)-[:CALLS]->(callee:Function) OPTIONAL MATCH (f)-[:CONTAINS_FLOW]->(flow:ControlFlow) OPTIONAL MATCH (f)-[:WRITES_STATE]->(state:State) WITH f, collect(DISTINCT callee) AS callees, collect(DISTINCT flow) AS flows, collect(DISTINCT state) AS states, collect(DISTINCT callee.file) AS modules, max(flow.depth) AS maxNesting WITH f, coalesce(size(callees), 0) AS internalFanOut, coalesce(size(flows), 0) AS decisions, coalesce(size(states), 0) AS stateWrites, coalesce(size(modules), 0) AS moduleSpread, coalesce(maxNesting, 0) AS maxNesting, coalesce(f.endLine - f.startLine + 1, 0) AS lines, coalesce(f.parameterCount, 0) AS parameters WITH f, internalFanOut, decisions, stateWrites, moduleSpread, maxNesting, lines, parameters, lines + decisions * 5 + maxNesting * 6 + stateWrites * 4 + moduleSpread * 3 + CASE WHEN parameters > 5 THEN (parameters - 5) * 3 ELSE 0 END + CASE WHEN internalFanOut > 8 THEN (internalFanOut - 8) * 2 ELSE 0 END AS refactoringScore RETURN elementId(f) AS uid, f.ipv6 AS ipv6, f.name AS function, f.file AS file, lines, parameters, decisions, maxNesting, internalFanOut, stateWrites, moduleSpread, refactoringScore, CASE WHEN refactoringScore >= 120 AND decisions >= 6 THEN 'high' WHEN refactoringScore >= 70 THEN 'medium' ELSE 'low' END AS analysisConfidence ORDER BY refactoringScore DESC LIMIT 40"
    },
    {
        name: "cyclomatic_complexity",
        description: "Approximate cyclomatic complexity from parsed branch/loop/control-flow nodes (1 + decision points).",
        query: "MATCH (f:Function) OPTIONAL MATCH (f)-[:CONTAINS_FLOW]->(flow:ControlFlow) RETURN elementId(f) AS uid, f.ipv6 AS ipv6, f.name AS function, f.file AS file, 1 + count(flow) AS cyclomaticComplexity ORDER BY cyclomaticComplexity DESC LIMIT 40"
    },
    {
        name: "long_functions",
        description: "Functions ranked by source lines, a direct maintainability signal independent of call resolution.",
        query: "MATCH (f:Function) WHERE f.startLine IS NOT NULL AND f.endLine IS NOT NULL RETURN elementId(f) AS uid, f.ipv6 AS ipv6, f.name AS function, f.file AS file, f.endLine - f.startLine + 1 AS lines ORDER BY lines DESC LIMIT 40"
    },
    {
        name: "large_classes",
        description: "Classes ranked by method count and source lines.",
        query: "MATCH (c:Class) OPTIONAL MATCH (c)-[:CONTAINS]->(f:Function) RETURN elementId(c) AS uid, c.ipv6 AS ipv6, c.name AS class, c.file AS file, count(f) AS methods, c.endLine - c.startLine + 1 AS lines ORDER BY methods DESC, lines DESC LIMIT 40"
    },
    {
        name: "magic_numbers",
        description: "Unexplained numeric literals that repeat across the codebase, ranked by how many files share them. A value in three files is a constant that was never given a name.",
        // Die Form entscheidet, nicht der Wert: Ladybug kennt weder toInteger
        // noch toFloat, ein Groessenvergleich ist damit unmoeglich. Drei
        // Stellen oder zwei Nachkommastellen trennt 2000 und 0.05 von 3 und 1.0
        // — und genau die kleinen Zahlen sind das Rauschen, das jede
        // Haeufigkeitsliste sonst anfuehrt.
        //
        // Alle collect() hier sind DISTINCT: ein einfaches collect() als
        // LETZTE Aggregation liefert null, sobald vorher ein collect(DISTINCT)
        // steht. Gemischt wird deshalb nicht.
        //
        // HTTP-Status und CSS-Schriftstaerken haben eine vereinbarte Bedeutung
        // und sind nie magisch. Sie fliegen nicht raus (500 kann auch eine
        // Puffergroesse sein), sondern sinken ueber `conventional` ans Ende.
        //
        // `conventional` wird deshalb schon im aggregierenden WITH auf
        // lit.value gebildet und nicht danach: `IN [...]` liefert in Ladybug
        // immer false, sobald die Spalte aus einem WITH mit Aggregation kommt.
        // Als zusaetzlicher Gruppierungsschluessel ist es unschaedlich — der
        // Wert haengt allein von number ab. `=` und `=~` sind nicht betroffen.
        //
        // In RETURN taucht `conventional` nicht auf: eine 0/1-Spalte ist
        // Sortiermechanik, keine Auskunft. `numberKind` sagt dasselbe lesbar.
        // ORDER BY greift trotzdem darauf zu — das kann Ladybug.
        query: "MATCH (lit:ASTNode) WHERE (lit.value =~ '-?[0-9]{3,}' OR lit.value =~ '-?[0-9]*[.][0-9]{2,}') AND NOT lit.value IN ['100','1000','10000','100000','1000000','100.0','1000.0','10.00','0.00','0.000','0.0000','1.00','1.000','2.00'] AND NOT lit.file CONTAINS '/test' AND NOT lit.file CONTAINS '.test.' AND NOT lit.file CONTAINS '.spec.' AND NOT lit.file CONTAINS '/spec/' AND NOT lit.file CONTAINS '__tests__' WITH lit.value AS number, CASE WHEN lit.value IN ['200','201','204','301','302','304','400','401','403','404','409','422','429','500','502','503','300','600','700','800','900'] THEN 1 ELSE 0 END AS conventional, count(lit) AS occurrences, collect(DISTINCT lit.file) AS files WHERE occurrences >= 2 RETURN number, occurrences, size(files) AS fileCount, files, CASE WHEN conventional = 1 THEN 'standard_code' WHEN number =~ '-?[0-9]*[.][0-9]{2,}' THEN 'precise_decimal' WHEN number =~ '-?[0-9]{4,}' THEN 'large_integer' ELSE 'integer' END AS numberKind, CASE WHEN conventional = 1 THEN 'low' WHEN size(files) >= 3 THEN 'high' WHEN size(files) >= 2 THEN 'medium' ELSE 'low' END AS analysisConfidence ORDER BY conventional ASC, fileCount DESC, occurrences DESC LIMIT 40"
    },
    {
        name: "magic_number_sites",
        description: "Every unexplained numeric literal with its exact file, line and enclosing function — the read-the-code companion to magic_numbers. Includes values that occur only once.",
        // Kein WITH, keine Aggregation: hier zaehlt die einzelne Fundstelle.
        // coalesce ist Pflicht — Literale auf Modulebene haben keine
        // umschliessende Funktion, und eine nackte NULL-Spalte laesst die
        // Zeile so aussehen, als waere die Zuordnung fehlgeschlagen.
        query: "MATCH (lit:ASTNode) WHERE (lit.value =~ '-?[0-9]{3,}' OR lit.value =~ '-?[0-9]*[.][0-9]{2,}') AND NOT lit.value IN ['100','1000','10000','100000','1000000','100.0','1000.0','10.00','0.00','0.000','0.0000','1.00','1.000','2.00'] AND NOT lit.file CONTAINS '/test' AND NOT lit.file CONTAINS '.test.' AND NOT lit.file CONTAINS '.spec.' AND NOT lit.file CONTAINS '/spec/' AND NOT lit.file CONTAINS '__tests__' OPTIONAL MATCH (fn:Function)-[:CONTAINS_AST]->(lit) RETURN elementId(lit) AS uid, lit.value AS number, lit.file AS file, lit.startLine AS line, coalesce(fn.name, '(module level)') AS function ORDER BY file, line LIMIT 200"
    },
    {
        name: "entry_points",
        description: "Find top-level entry points: functions/files that call others but are not called themselves.",
        query: "MATCH (f:Function)-[:CALLS]->() WHERE NOT ()-[:CALLS]->(f) RETURN DISTINCT elementId(f) AS uid, f.ipv6 AS ipv6, f.name AS entryPoint, f.file AS file"
    },
    {
        name: "circular_imports",
        description: "Find files that import each other in a circle.",
        query: "MATCH path = (a:File)-[:IMPORTS*2..6]->(a) RETURN elementId(a) AS uid, a.ipv6 AS ipv6, [n IN nodes(path) | n.path] AS importCycle LIMIT 10"
    },
    {
        name: "api_endpoints",
        description: "List all detected HTTP API endpoints and their handler functions.",
        query: "MATCH (handler:Function)-[:HANDLES]->(ep:Endpoint) RETURN elementId(handler) AS uid, handler.ipv6 AS ipv6, ep.url AS url, ep.method AS method, handler.name AS handler, handler.file AS file ORDER BY url"
    },
    {
        name: "functions_fetching_api",
        description: "Find all functions that call external HTTP endpoints.",
        query: "MATCH (f:Function)-[:FETCHES]->(ep:Endpoint) RETURN f.name AS function, f.file AS file, ep.url AS url, ep.method AS method ORDER BY url"
    },
    {
        name: "external_dependencies",
        description: "List all external npm / pip modules imported by the project.",
        query: "MATCH (f:File)-[:IMPORTS]->(m:Module) RETURN m.name AS module, collect(DISTINCT f.path) AS usedIn ORDER BY module"
    },
    {
        name: "call_chain",
        description: "Trace the full call chain from a specific function (replace 'myFunction' with the target name).",
        query: "MATCH path = (start:Function {name: 'myFunction'})-[:CALLS*1..8]->(endFn:Function) RETURN [n IN nodes(path) | n.name] AS callChain LIMIT 30"
    },
    {
        name: "callers_of_function",
        description: "Find all functions that directly call a specific function (replace 'myFunction').",
        query: "MATCH (caller)-[:CALLS]->(f:Function {name: 'myFunction'}) RETURN caller.name AS caller, caller.file AS file"
    },
    {
        name: "files_overview",
        description: "Overview of all parsed files with their language and function count.",
        query: "MATCH (f:File) OPTIONAL MATCH (f)-[:CONTAINS]->(func:Function) RETURN f.path AS file, f.language AS lang, count(func) AS functions ORDER BY functions DESC"
    },
    {
        name: "react_state_writers",
        description: "Find which React components write to which state variables.",
        query: "MATCH (f:Function)-[:WRITES_STATE]->(s:State) RETURN f.name AS component, s.name AS stateSetter, f.file AS file ORDER BY file"
    },
    {
        name: "functions_with_errors",
        description: "Same as get_runtime_errors but as a raw Cypher query — lists nodes with logged runtime errors.",
        query: "MATCH (n) WHERE n.lastError IS NOT NULL RETURN elementId(n) AS uid, n.ipv6 AS ipv6, n.name AS function, n.file AS file, n.lastError AS error, n.lastErrorTimestamp AS timestamp ORDER BY timestamp DESC"
    },
    {
        name: "user_events",
        description: "List all recorded user events (clicks, etc.) with their execution paths.",
        query: "MATCH (u:User)-[:PERFORMED]->(evt:UserEvent) RETURN evt.eventType AS type, evt.componentName AS component, evt.targetTestId AS testId, evt.executionPathNames AS path, evt.executionPathHex AS hexPath, evt.timestamp AS timestamp ORDER BY timestamp DESC LIMIT 30"
    },
    {
        name: "execution_path_for_event",
        description: "Get the full execution path for a specific UserEvent (replace EVENT_UID_HERE). Shows each step in order.",
        // `order` ist ein reserviertes Wort und muss in Backticks stehen,
        // sonst ist die ganze Abfrage ein Parser-Fehler.
        query: "MATCH (evt:UserEvent {uid: 'EVENT_UID_HERE'})-[step:EXECUTION_STEP]->(fn:Function) RETURN step.`order` AS stepOrder, fn.name AS function, fn.file AS file, fn.uid AS uid ORDER BY stepOrder"
    },
    {
        name: "click_to_state_changes",
        description: "Trace how a click on a component leads to state changes. Replace 'ComponentName'.",
        query: "MATCH (evt:UserEvent {componentName: 'ComponentName'})-[:EXECUTION_STEP]->(fn:Function)-[:WRITES_STATE]->(s:State) RETURN evt.timestamp AS occurredAt, fn.name AS writer, s.name AS state ORDER BY evt.timestamp DESC LIMIT 20"
    },
    {
        name: "dom_elements",
        description: "List all statically extracted DOM elements with event handlers.",
        query: "MATCH (dom:DOMElement) WHERE NOT dom:RuntimeDOM RETURN dom.elementId AS id, dom.tagName AS tag, dom.testId AS testId, dom.file AS file, dom.eventHandlers AS events, dom.startLine AS line ORDER BY dom.file, dom.startLine"
    },
    {
        name: "dom_to_handler_chain",
        description: "For each DOM element with an event handler, show the full call chain from handler to callees.",
        query: "MATCH (dom:DOMElement)-[ev:ON_EVENT]->(handler:Function) OPTIONAL MATCH path = (handler)-[:CALLS*1..4]->(callee:Function) RETURN dom.testId AS testId, dom.tagName AS tag, ev.event AS event, handler.name AS handler, [n IN nodes(path) | n.name] AS callChain LIMIT 30"
    },
    {
        name: "runtime_dom_tree",
        description: "Show the runtime DOM tree structure as captured by the profiler.",
        query: "MATCH (parent:RuntimeDOM)-[:HAS_CHILD]->(child:RuntimeDOM) RETURN parent.tagName AS parentTag, parent.testId AS parentTestId, child.tagName AS childTag, child.testId AS childTestId, child.xpath AS xpath LIMIT 50"
    },
    {
        name: "most_clicked_components",
        description: "Components ranked by total clicks from runtime profiler.",
        query: "MATCH (u:User)-[r:CLICKS_ON]->(c:Function) RETURN c.name AS component, r.count AS clicks ORDER BY clicks DESC LIMIT 20"
    },
    {
        name: "execution_path_frequency",
        description: "Find the most common execution paths (by hex fingerprint).",
        query: "MATCH (evt:UserEvent) RETURN evt.executionPathHex AS pathHex, evt.executionPathNames AS pathNames, count(*) AS freq ORDER BY freq DESC LIMIT 15"
    },
    {
        name: "click_full_trace",
        description: "For a given component, trace: User click component called functions state changes. Replace 'ComponentName'.",
        query: "MATCH (u:User)-[:PERFORMED]->(evt:UserEvent {componentName: 'ComponentName'})-[:TRIGGERS]->(comp:Function) OPTIONAL MATCH (comp)-[:CALLS*1..5]->(callee:Function) OPTIONAL MATCH (callee)-[:WRITES_STATE]->(s:State) RETURN evt.timestamp AS occurredAt, comp.name AS component, collect(DISTINCT callee.name) AS calledFunctions, collect(DISTINCT s.name) AS stateChanges ORDER BY occurredAt DESC LIMIT 10"
    },
    {
        name: "component_accepts_props",
        description: "Show which props each component declares in its destructured parameters.",
        query: "MATCH (f:Function) WHERE f.acceptsProps IS NOT NULL AND size(f.acceptsProps) > 0 RETURN f.name AS component, f.file AS file, f.acceptsProps AS acceptedProps ORDER BY f.file"
    },
    {
        name: "missing_props",
        description: "For each (parent child) call site, find props the child accepts but the parent never passes — catches missing prop bugs. Excludes call sites that use JSX spread.",
        query: "MATCH (parent:Function)-[r:PASSES_PROP]->(child:Function) WHERE child.acceptsProps IS NOT NULL AND (r.hasSpread IS NULL OR r.hasSpread = false) WITH parent, child, r.props AS passed, child.acceptsProps AS accepted UNWIND accepted AS ap WITH parent, child, passed, ap WHERE NOT ap IN passed WITH parent, child, passed, collect(ap) AS missing WHERE size(missing) > 0 RETURN elementId(parent) AS uid, parent.ipv6 AS ipv6, parent.name AS parent, child.name AS child, missing AS missingProps, passed AS passedProps ORDER BY size(missing) DESC"
    },
    {
        name: "missing_props_including_spread",
        description: "Same as missing_props but INCLUDES call sites with JSX spread.",
        query: "MATCH (parent:Function)-[r:PASSES_PROP]->(child:Function) WHERE child.acceptsProps IS NOT NULL WITH parent, child, r.props AS passed, child.acceptsProps AS accepted, r.hasSpread AS hasSpread, r.spreadVars AS spreadVars UNWIND accepted AS ap WITH parent, child, passed, hasSpread, spreadVars, ap WHERE NOT ap IN passed WITH parent, child, passed, hasSpread, spreadVars, collect(ap) AS missing WHERE size(missing) > 0 RETURN parent.name AS parent, child.name AS child, missing AS missingProps, passed AS passedProps, hasSpread, spreadVars ORDER BY size(missing) DESC"
    },
    {
        name: "effect_watches",
        description: "Show which useEffect/useMemo/useCallback hooks watch which state variables.",
        query: "MATCH (func:Function)-[:HAS_EFFECT]->(eff:Effect)-[:WATCHES]->(s:State) RETURN func.name AS component, func.file AS file, eff.hookType AS hook, eff.startLine AS line, s.name AS watchedState, eff.deps AS allDeps ORDER BY func.file"
    },
    {
        name: "untracked_state_deps",
        description: "Find state variables written by a component but not watched by any useEffect — potential stale closure or missing reactivity.",
        query: "MATCH (func:Function)-[:WRITES_STATE]->(s:State) WHERE NOT ()-[:WATCHES]->(s) RETURN func.name AS component, s.name AS state, func.file AS file ORDER BY func.file"
    },
    {
        name: "all_effects",
        description: "List all useEffect/useMemo/useCallback hooks with their dependency arrays.",
        query: "MATCH (func:Function)-[:HAS_EFFECT]->(eff:Effect) RETURN func.name AS component, func.file AS file, eff.hookType AS hook, eff.startLine AS line, eff.deps AS deps ORDER BY func.file, eff.startLine"
    },
    {
        name: "find_by_name",
        description: "Find ANY node by name across all types. Replace 'myName' with the target.",
        query: "MATCH (n) WHERE n.name = 'myName' RETURN n.name AS name, labels(n) AS types, n.file AS file, n.startLine AS line"
    },
    {
        name: "verify_terms",
        description: "Verify multiple terms at once against the graph. Returns which terms were found and which NOT FOUND.",
        // Ohne Struct-Liste und ohne toString(): auf `matches[0].name` kann
        // Ladybug nicht zugreifen (Listen sind zudem 1-basiert), und die
        // Funktion toString existiert dort nicht. Zählen statt basteln.
        query: "WITH ['term1', 'term2', 'term3'] AS terms UNWIND terms AS term OPTIONAL MATCH (n) WHERE n.name = term WITH term, count(n) AS treffer, collect(n.file) AS dateien RETURN term, treffer, dateien ORDER BY term"
    },
    {
        name: "ipv6_overview",
        description: "Overview of IPv6 address distribution across node types and mask levels.",
        query: "MATCH (n) WHERE n.ipv6 IS NOT NULL RETURN labels(n)[0] AS type, n.ipv6mask AS mask, count(n) AS count ORDER BY mask, count DESC"
    },
    {
        name: "ipv6_file_subnets",
        description: "List all file-level subnets (/48) with their IPv6 prefix and contained node count.",
        // Ohne OPTIONAL MATCH: mit nachgestelltem WHERE verliert Ladybug `f`
        // aus dem Scope ("Variable f is not in scope"). Dateien ohne indizierte
        // Kinder fallen damit raus — sie hatten ohnehin count 0.
        query: "MATCH (f:File)-[:CONTAINS]->(n) WHERE f.ipv6 IS NOT NULL AND n.ipv6 IS NOT NULL RETURN f.path AS file, f.ipv6 AS subnet, count(n) AS nodes ORDER BY file"
    },
    {
        name: "ipv6_hierarchy",
        description: "Show the full IPv6 hierarchy for a specific file. Replace 'App.jsx' with the target filename.",
        query: "MATCH (f:File) WHERE f.path CONTAINS 'App.jsx' OPTIONAL MATCH (f)-[:CONTAINS]->(n) WHERE n.ipv6 IS NOT NULL RETURN f.path AS file, f.ipv6 AS fileAddr, n.name AS node, labels(n)[0] AS type, n.ipv6 AS nodeAddr, n.ipv6mask AS mask, n.startLine AS line ORDER BY n.ipv6"
    },
    {
        name: "ipv6_lookup",
        description: "Find the node at a specific IPv6 address. Replace the address.",
        query: "MATCH (n {ipv6: 'fd00:0001:12a5:0001:0000:000d:0000:0000'}) RETURN n.name AS name, labels(n) AS type, n.file AS file, elementId(n) AS uid, n.ipv6 AS ipv6, n.ipv6mask AS mask"
    },
    {
        name: "ipv6_subnet_members",
        description: "Find all nodes sharing the same /64 subnet prefix (same top-level declaration). Replace the first 4 groups.",
        query: "MATCH (n) WHERE n.ipv6 STARTS WITH 'fd00:0001:12a5:0001' RETURN n.name AS name, labels(n)[0] AS type, elementId(n) AS uid, n.ipv6 AS ipv6, n.ipv6mask AS mask, n.startLine AS line ORDER BY n.ipv6"
    },
    {
        name: "ipv6_node_by_name",
        description: "Get the IPv6 address and subnet mask for a node by name. Replace 'myFunction'.",
        query: "MATCH (n) WHERE n.name = 'myFunction' AND n.ipv6 IS NOT NULL RETURN n.name AS name, labels(n)[0] AS type, n.file AS file, elementId(n) AS uid, n.ipv6 AS ipv6, n.ipv6mask AS mask"
    }
];

module.exports = { PREDEFINED_QUERIES };
