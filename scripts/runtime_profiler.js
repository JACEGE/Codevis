// Embedded Ladybug DB via the driver-compatible compat client.
const ladybug = require('../server/ladybug-driver.cjs');
const { createHash } = require('crypto');
const config = require('../server/codevis-paths.cjs').loadConfig();

/**
 * Puppeteer is loaded on demand, not at import time.
 *
 * It is the only dependency that pulls a ~300 MB Chromium download, and the
 * runtime profiler is the only thing in the shipped package that uses it —
 * an opt-in tool most users never touch. Making it a hard dependency would tax
 * every single install for a feature nobody asked for, so it is a devDependency
 * and this is where a missing install gets explained rather than stack-traced.
 */
function loadPuppeteer() {
    try {
        return require('puppeteer');
    } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
        console.error(
            "The runtime profiler needs Puppeteer, which is not installed.\n" +
            "It is optional (a ~300 MB Chromium download), so CodeVis does not pull it in by default.\n" +
            "  npm install puppeteer\n"
        );
        process.exit(1);
    }
}

// Workspace selection via CLI: project_db (default) or codevis_db.
const targetName = process.argv[2] || 'project_db';
const validTargets = Object.keys(config.workspaces);
if (!validTargets.includes(targetName)) {
  console.error(`Invalid target '${targetName}'. Valid: ${validTargets.join(', ')}`);
  process.exit(1);
}
const targetWs = config.workspaces[targetName];
// dbUri is the current name; neo4jUri is still accepted so configs written
// by an older `codevis init` keep working.
const { auth } = targetWs;
const dbUri = targetWs.dbUri || targetWs.neo4jUri;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

// ============================================================
// UID HELPER — same algorithm as graph_builder.js
// ============================================================

function makeUid(label, name, file) {
    const raw = `${label}::${name}::${file || ''}`;
    return createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

// ============================================================
// NEO4J HELPERS
// ============================================================

async function saveRenderEdge(driver, sourceName, targetName) {
    if (!sourceName || !targetName || sourceName === targetName) return;
    const session = driver.session();
    try {
        await session.executeWrite(tx =>
            tx.run(
                `
                MERGE (source:Function {name: $sourceName})
                MERGE (target:Function {name: $targetName})
                MERGE (source)-[r:RUNTIME_RENDERS]->(target)
                ON CREATE SET r.count = 1, r.lastSeen = timestamp()
                ON MATCH SET r.count = r.count + 1, r.lastSeen = timestamp()
                RETURN source.name, target.name, r.count
                `,
                { sourceName, targetName }
            )
        );
    } catch (error) {
        console.error(`Fehler beim Speichern der Render-Beziehung: ${error.message}`);
    } finally {
        await session.close();
    }
}

async function saveDOMSnapshot(driver, domTree) {
    if (!domTree || !domTree.children) return;
    const session = driver.session();
    try {
        const timestamp = Date.now();

        const insertNode = async (node, parentUid) => {
            const uid = makeUid('DOMElement', node.id || node.tag + '_' + node.path, '');
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MERGE (dom:DOMElement:RuntimeDOM {uid: $uid})
                    SET dom.tagName    = $tagName,
                        dom.testId     = $testId,
                        dom.elementId  = $elementId,
                        dom.className  = $className,
                        dom.xpath      = $xpath,
                        dom.textSnippet = $textSnippet,
                        dom.snapshotAt = $timestamp
                    `,
                    {
                        uid,
                        tagName: node.tag,
                        testId: node.testId || null,
                        elementId: node.id || null,
                        className: node.className || null,
                        xpath: node.path || null,
                        textSnippet: (node.text || '').substring(0, 80) || null,
                        timestamp
                    }
                )
            );

            if (node.testId) {
                await session.executeWrite(tx =>
                    tx.run(
                        `
                        MATCH (rdom:RuntimeDOM {uid: $uid})
                        OPTIONAL MATCH (sdom:DOMElement {testId: $testId})
                        WHERE NOT sdom:RuntimeDOM
                        WITH rdom, sdom WHERE sdom IS NOT NULL
                        MERGE (rdom)-[:MAPS_TO_STATIC]->(sdom)
                        `,
                        { uid, testId: node.testId }
                    )
                );
            }

            if (parentUid) {
                await session.executeWrite(tx =>
                    tx.run(
                        `
                        MATCH (parent:RuntimeDOM {uid: $parentUid})
                        MATCH (child:RuntimeDOM {uid: $childUid})
                        MERGE (parent)-[:HAS_CHILD]->(child)
                        `,
                        { parentUid, childUid: uid }
                    )
                );
            }

            if (node.children) {
                for (const child of node.children) {
                    await insertNode(child, uid);
                }
            }
        };

        await insertNode(domTree, null);
        console.log(`[DOM] ✓ DOM-Snapshot mit ${countNodes(domTree)} Knoten gespeichert.`);
    } catch (error) {
        console.error(`Fehler beim DOM-Snapshot: ${error.message}`);
    } finally {
        await session.close();
    }
}

function countNodes(node) {
    let count = 1;
    if (node.children) {
        for (const child of node.children) count += countNodes(child);
    }
    return count;
}

async function saveUserEvent(driver, eventData) {
    const session = driver.session();
    try {
        const eventUid = makeUid('UserEvent', `${eventData.eventType}_${eventData.timestamp}`, '');

        const pathUids = eventData.executionPath.map(step => step.uid);
        const pathHex = pathUids.join('');

        await session.executeWrite(tx =>
            tx.run(
                `
                MERGE (u:User {name: 'DefaultUser'})
                CREATE (evt:UserEvent {
                    uid:                    $eventUid,
                    eventType:              $eventType,
                    timestamp:              $timestamp,
                    targetTestId:           $targetTestId,
                    targetTagName:          $targetTagName,
                    componentName:          $componentName,
                    componentNameLeaf:      $componentNameLeaf,
                    executionPathHex:       $pathHex,
                    executionPathUids:      $pathUids,
                    executionPathNames:     $pathNames,
                    executionPathNamesUser: $pathNamesUser
                })
                MERGE (u)-[:PERFORMED]->(evt)
                `,
                {
                    eventUid,
                    eventType: eventData.eventType,
                    timestamp: eventData.timestamp,
                    targetTestId: eventData.targetTestId || null,
                    targetTagName: eventData.targetTagName || null,
                    componentName: eventData.componentName || null,
                    componentNameLeaf: eventData.componentNameLeaf || null,
                    pathHex,
                    pathUids,
                    pathNames: eventData.executionPath.map(s => s.name),
                    pathNamesUser: (eventData.executionPathUser || []).map(s => s.name)
                }
            )
        );

        if (eventData.targetTestId) {
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MATCH (evt:UserEvent {uid: $eventUid})
                    OPTIONAL MATCH (dom:DOMElement {testId: $testId})
                    WITH evt, dom WHERE dom IS NOT NULL
                    MERGE (evt)-[:CLICKED_ELEMENT]->(dom)
                    `,
                    { eventUid, testId: eventData.targetTestId }
                )
            );
        }

        // Link to the user-facing component (filtered) — primary CLICKS_ON target
        if (eventData.componentName) {
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MATCH (evt:UserEvent {uid: $eventUid})
                    MERGE (c:Function {name: $compName})
                    MERGE (evt)-[:TRIGGERS]->(c)
                    WITH evt, c
                    MATCH (u:User {name: 'DefaultUser'})
                    MERGE (u)-[r:CLICKS_ON]->(c)
                    ON CREATE SET r.count = 1, r.lastClicked = $ts
                    ON MATCH SET r.count = r.count + 1, r.lastClicked = $ts
                    `,
                    { eventUid, compName: eventData.componentName, ts: eventData.timestamp }
                )
            );
        }

        // Also link to the raw leaf component (e.g. @mantine/core/Box) for full traceability
        if (eventData.componentNameLeaf && eventData.componentNameLeaf !== eventData.componentName) {
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MATCH (evt:UserEvent {uid: $eventUid})
                    MERGE (c:Function {name: $compName})
                    MERGE (evt)-[:TRIGGERS_LEAF]->(c)
                    `,
                    { eventUid, compName: eventData.componentNameLeaf }
                )
            );
        }

        for (let i = 0; i < eventData.executionPath.length; i++) {
            const step = eventData.executionPath[i];
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MATCH (evt:UserEvent {uid: $eventUid})
                    MERGE (fn:Function {name: $funcName})
                    MERGE (evt)-[:EXECUTION_STEP {order: $order}]->(fn)
                    `,
                    { eventUid, funcName: step.name, order: ladybug.int(i) }
                )
            );
        }

        for (let i = 0; i < eventData.executionPath.length - 1; i++) {
            const curr = eventData.executionPath[i];
            const next = eventData.executionPath[i + 1];
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MATCH (a:Function {name: $currName})
                    MATCH (b:Function {name: $nextName})
                    MERGE (a)-[r:EXECUTION_NEXT]->(b)
                    ON CREATE SET r.count = 1, r.lastSeen = $ts
                    ON MATCH SET r.count = r.count + 1, r.lastSeen = $ts
                    `,
                    { currName: curr.name, nextName: next.name, ts: eventData.timestamp }
                )
            );
        }

        const pathStr = eventData.executionPath.map(s => s.name).join(' → ');
        const pathStrUser = (eventData.executionPathUser || []).map(s => s.name).join(' → ');
        console.log(`[Event] ✓ ${eventData.eventType} → ${eventData.componentName || eventData.componentNameLeaf}`);
        console.log(`[Event]   User-Pfad:  ${pathStrUser || '(leer)'}`);
        console.log(`[Event]   Voll-Pfad:  ${pathStr}`);
        console.log(`[Event]   Hex-Path: ${pathHex.substring(0, 64)}${pathHex.length > 64 ? '…' : ''}`);

        return eventUid;
    } catch (error) {
        console.error(`Fehler beim Speichern des UserEvents: ${error.message}`);
        return null;
    } finally {
        await session.close();
    }
}

async function saveRouteEvent(driver, routeData) {
    const session = driver.session();
    try {
        const eventUid = makeUid('RouteEvent', `${routeData.to}_${routeData.timestamp}`, '');
        await session.executeWrite(tx =>
            tx.run(
                `
                MERGE (u:User {name: 'DefaultUser'})
                CREATE (evt:RouteEvent {
                    uid:       $eventUid,
                    fromRoute: $from,
                    toRoute:   $to,
                    timestamp: $timestamp
                })
                MERGE (u)-[:NAVIGATED]->(evt)
                `,
                { eventUid, from: routeData.from || null, to: routeData.to, timestamp: routeData.timestamp }
            )
        );
        console.log(`[Route] ✓ Navigation: ${routeData.from || '?'} → ${routeData.to}`);
    } catch (error) {
        console.error(`Fehler beim Speichern des RouteEvents: ${error.message}`);
    } finally {
        await session.close();
    }
}

async function saveRuntimeError(driver, errorData) {
    const session = driver.session();
    try {
        const ts = Date.now();
        await session.executeWrite(tx =>
            tx.run(
                `
                MERGE (fn:Function {name: $funcName})
                SET fn.lastError = $message,
                    fn.lastErrorStack = $stack,
                    fn.lastErrorTimestamp = $ts
                `,
                {
                    funcName: errorData.componentName || 'unknown',
                    message: errorData.message,
                    stack: (errorData.stack || '').substring(0, 500),
                    ts
                }
            )
        );
    } catch (err) {
        console.error(`Fehler beim Speichern des Runtime-Errors: ${err.message}`);
    } finally {
        await session.close();
    }
}

// ============================================================
// NEW: Save visible components captured after a click
// ============================================================

async function saveVisibleComponents(driver, eventUid, components) {
    if (!components || components.length === 0) return;
    const session = driver.session();
    try {
        for (const comp of components) {
            const uid = makeUid('VisibleComponent', `${comp.name}_${eventUid}`, '');
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MERGE (vc:VisibleComponent {uid: $uid})
                    SET vc.name        = $name,
                        vc.isVisible   = $isVisible,
                        vc.boundingBox = $boundingBox,
                        vc.textSnippet = $textSnippet,
                        vc.capturedAt  = $capturedAt
                    WITH vc
                    MATCH (evt:UserEvent {uid: $eventUid})
                    MERGE (evt)-[:SHOWS]->(vc)
                    `,
                    {
                        uid,
                        name: comp.name,
                        isVisible: comp.isVisible,
                        boundingBox: JSON.stringify(comp.boundingBox || {}),
                        textSnippet: (comp.textSnippet || '').substring(0, 120) || null,
                        capturedAt: comp.capturedAt,
                        eventUid
                    }
                )
            );

            // Link to static Function node if one exists with this name
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MATCH (vc:VisibleComponent {uid: $uid})
                    OPTIONAL MATCH (fn:Function {name: $name})
                    WHERE NOT fn:RuntimeDOM AND NOT fn:VisibleComponent
                    WITH vc, fn WHERE fn IS NOT NULL
                    MERGE (vc)-[:MAPS_TO]->(fn)
                    `,
                    { uid, name: comp.name }
                )
            );
        }
        const visibleCount = components.filter(c => c.isVisible).length;
        console.log(`[Visible] ✓ ${components.length} Komponenten gespeichert (${visibleCount} im Viewport)`);
    } catch (error) {
        console.error(`Fehler beim Speichern der VisibleComponents: ${error.message}`);
    } finally {
        await session.close();
    }
}

// ============================================================
// NEW: Save background re-renders triggered by a click
// ============================================================

async function saveBackgroundRenders(driver, eventUid, renders) {
    if (!renders || renders.length === 0) return;
    const session = driver.session();
    try {
        const unique = [...new Map(renders.map(r => [r.name, r])).values()];
        for (const r of unique) {
            if (!r.name || r.name.length <= 2) continue;
            await session.executeWrite(tx =>
                tx.run(
                    `
                    MATCH (evt:UserEvent {uid: $eventUid})
                    MERGE (fn:Function {name: $name})
                    MERGE (evt)-[rel:TRIGGERS_RENDER]->(fn)
                    ON CREATE SET rel.count = 1, rel.firstSeen = $ts
                    ON MATCH SET rel.count = rel.count + 1, rel.lastSeen = $ts
                    `,
                    { eventUid, name: r.name, ts: r.ts || Date.now() }
                )
            );
        }
        console.log(`[BgRender] ✓ ${unique.length} Hintergrund-Renders gespeichert`);
    } catch (error) {
        console.error(`Fehler beim Speichern der Background-Renders: ${error.message}`);
    } finally {
        await session.close();
    }
}

// ============================================================
// PROFILER LOGIC
// ============================================================

async function main() {
    let driver;
    let browser;

    try {
        driver = ladybug.driver(dbUri, ladybug.auth.basic(auth.user, auth.pass));
        await driver.verifyConnectivity();
        console.log("✓ Erfolgreich mit der CodeVis-Datenbank verbunden.");

        const puppeteer = loadPuppeteer();
        const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            executablePath: CHROME_PATH,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                // Remote-Debug-Port: erlaubt externen Browser-Treibern,
                // sich anzudocken und Klicks programmatisch auszulösen — diese feuern denselben
                // Click-Listener und werden ganz normal als UserEvents geloggt.
                `--remote-debugging-port=${process.env.PROFILER_DEBUG_PORT || 9222}`,
            ],
        });

        const page = (await browser.pages())[0];
        console.log("🚀 Chrome-Browser wird gestartet. Bitte klicke dich nun durch deine App, um Render-, Klick- und Ausführungspfad-Daten zu sammeln.\n");

        page.on('console', msg => {
            if (msg.type() === 'log') {
                console.log(`${msg.text()}`);
            } else if (msg.type() === 'error') {
                console.error(`[Browser Error] ${msg.text()}`);
            } else if (msg.type() === 'warn') {
                console.warn(`[Browser Warn] ${msg.text()}`);
            }
        });

        page.on('error', err => {
            console.error(`[Page Error] ${err.message}`);
        });

        // ============================================================
        // REACT DEVTOOLS HOOK — installed BEFORE the page loads so that
        // React finds it on startup and calls onCommitFiberRoot on every
        // commit (initial mount + all re-renders).
        // ============================================================
        await page.evaluateOnNewDocument(() => {
            window.__profilerQueue = { renders: [] };

            // React 16+ checks for this object at startup.
            // It calls hook.inject(renderer) to register itself, then
            // hook.onCommitFiberRoot(rendererID, fiberRoot) after every commit.
            window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
                supportsFiber: true,
                isDisabled: false,
                _nextId: 1,
                renderers: new Map(),

                inject(renderer) {
                    const id = this._nextId++;
                    this.renderers.set(id, renderer);
                    return id;
                },

                onCommitFiberRoot(rendererID, root) {
                    if (!root || !root.current || !window.__profilerQueue) return;
                    // Walk the committed tree and collect non-trivial component names.
                    const walk = (fiber) => {
                        if (!fiber) return;
                        try {
                            if (fiber.type && typeof fiber.type !== 'string') {
                                const name = fiber.type.displayName || fiber.type.name || '';
                                if (name.length > 2) {
                                    window.__profilerQueue.renders.push({ name, ts: Date.now() });
                                }
                            }
                            if (fiber.child) walk(fiber.child);
                            if (fiber.sibling) walk(fiber.sibling);
                        } catch (_) {}
                    };
                    walk(root.current);
                },

                onCommitFiberUnmount() {},
                onPostCommitFiberRoot() {},
                onScheduleFiberRoot() {},
                checkDCE() {},
                setStrictMode() {},
            };
        });

        // ============================================================
        // EXPOSE NODE.JS CALLBACKS TO THE BROWSER PAGE
        // ============================================================

        await page.exposeFunction("onRenderDetected", async (renderData) => {
            await saveRenderEdge(driver, renderData.source, renderData.target);
        });

        await page.exposeFunction("onUserEvent", async (eventData) => {
            console.log(`[Browser→Node] UserEvent: ${eventData.eventType} auf ${eventData.componentName || eventData.targetTestId}`);
            // saveUserEvent now returns the eventUid so we can pass it back
            const eventUid = makeUid('UserEvent', `${eventData.eventType}_${eventData.timestamp}`, '');
            await saveUserEvent(driver, eventData);
            return eventUid;
        });

        await page.exposeFunction("onDOMSnapshot", async (domTree) => {
            console.log(`[Browser→Node] DOM-Snapshot empfangen (${countNodes(domTree)} Knoten)`);
            await saveDOMSnapshot(driver, domTree);
        });

        await page.exposeFunction("onRuntimeError", async (errorData) => {
            console.log(`[Browser→Node] Runtime-Error: ${errorData.message}`);
            await saveRuntimeError(driver, errorData);
        });

        await page.exposeFunction("onProfilerLog", async (message) => {
            console.log(`[Browser] ${message}`);
        });

        await page.exposeFunction("onVisibleComponents", async (eventUid, components) => {
            console.log(`[Browser→Node] ${components.length} sichtbare Komponenten nach Klick`);
            await saveVisibleComponents(driver, eventUid, components);
        });

        await page.exposeFunction("onBackgroundRenders", async (eventUid, renders) => {
            console.log(`[Browser→Node] ${renders.length} Hintergrund-Renders nach Klick`);
            await saveBackgroundRenders(driver, eventUid, renders);
        });

        await page.exposeFunction("onRouteChange", async (routeData) => {
            console.log(`[Browser→Node] Route-Wechsel: ${routeData.from} → ${routeData.to}`);
            await saveRouteEvent(driver, routeData);
        });

        await page.goto(APP_URL, { waitUntil: "networkidle2" });
        console.log(`\n✓ App geladen von ${APP_URL}\n`);

        // ============================================================
        // INJECT THE IN-PAGE TRACKING SCRIPT
        // ============================================================
        await page.evaluate(() => {

            // ----------------------------------------------------------
            // HELPER: FNV-1a hash (browser-side UID, matches makeUid logic)
            // ----------------------------------------------------------
            const fnv1aHash = (str) => {
                let h1 = 0x811c9dc5 >>> 0;
                let h2 = 0x811c9dc5 >>> 0;
                for (let i = 0; i < str.length; i++) {
                    const c = str.charCodeAt(i);
                    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
                    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
                }
                return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
            };

            const makeBrowserUid = (label, name) => fnv1aHash(`${label}::${name}::`);

            // ----------------------------------------------------------
            // REACT FIBER HELPERS
            // ----------------------------------------------------------
            const getFiber = (el) => {
                const key = Object.keys(el).find(k =>
                    k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
                );
                return key ? el[key] : null;
            };

            const getComponentName = (fiber) => {
                let f = fiber;
                while (f) {
                    if (f.type && typeof f.type !== 'string') {
                        const name = f.type.displayName || f.type.name;
                        if (name && name.length > 2) return name;
                    }
                    f = f.return;
                }
                return null;
            };

            // Walk fiber chain from leaf → root, collect component names (root→leaf order)
            const traceExecutionPath = (startFiber) => {
                const path = [];
                const seen = new Set();
                let f = startFiber;
                while (f) {
                    if (f.type && typeof f.type !== 'string') {
                        const name = f.type.displayName || f.type.name;
                        if (name && name.length > 2 && !seen.has(name)) {
                            seen.add(name);
                            path.push({ name, uid: makeBrowserUid('Function', name) });
                        }
                    }
                    f = f.return;
                }
                return path.reverse();
            };

            // ----------------------------------------------------------
            // USER-COMPONENT FILTER
            // Erkennt ob ein Komponentenname zu einer externen Lib gehört
            // ----------------------------------------------------------
            const LIB_PREFIXES = [
                '@mantine/', '@coreui/', '@mui/', '@tabler/',
                'react-router', 'react-dom', 'react-select',
            ];
            const LIB_EXACT = new Set([
                'Router', 'BrowserRouter', 'Provider', 'FiberProvider',
                'RendererComponent', 'Suspense', 'StrictMode',
            ]);

            const isUserComponent = (name) => {
                if (!name) return false;
                if (LIB_EXACT.has(name)) return false;
                if (LIB_PREFIXES.some(p => name.startsWith(p))) return false;
                return true;
            };

            // Nur eigene Komponenten aus dem Pfad behalten, Tag bleibt erhalten
            const filterUserPath = (fullPath) =>
                fullPath.filter(step => isUserComponent(step.name));

            // Erste eigene Komponente im Pfad (von hinten, also nächste zum Klick)
            const getUserComponentName = (fullPath) => {
                for (let i = fullPath.length - 1; i >= 0; i--) {
                    if (isUserComponent(fullPath[i].name)) return fullPath[i].name;
                }
                return null;
            };

            // ----------------------------------------------------------
            // FIBER ROOT HELPERS — walk the ENTIRE mounted tree
            // ----------------------------------------------------------

            // React 18 stores a __reactContainer$xxx key on the root container element
            // pointing to the HostRoot fiber.
            const getFiberRoot = () => {
                const candidates = [
                    document.getElementById('root'),
                    document.getElementById('app'),
                    document.body.firstElementChild,
                    document.body,
                ];
                for (const el of candidates) {
                    if (!el) continue;
                    // React 18: __reactContainer$xxx → HostRoot fiber
                    const containerKey = Object.keys(el).find(k => k.startsWith('__reactContainer$'));
                    if (containerKey) return el[containerKey];
                    // Fallback: get any fiber and traverse up to the root
                    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
                    if (fiberKey) {
                        let fiber = el[fiberKey];
                        while (fiber.return) fiber = fiber.return;
                        return fiber;
                    }
                }
                return null;
            };

            // DFS walk over the fiber tree
            const walkFiberTree = (fiber, callback, depth = 0, maxDepth = 80) => {
                if (!fiber || depth > maxDepth) return;
                try { callback(fiber, depth); } catch (_) {}
                if (fiber.child) walkFiberTree(fiber.child, callback, depth + 1, maxDepth);
                if (fiber.sibling) walkFiberTree(fiber.sibling, callback, depth, maxDepth);
            };

            // Detect whether the app is running in development mode
            // (CRA dev builds preserve _debugSource with file/line info)
            const detectDevMode = () => {
                const root = getFiberRoot();
                if (!root) return false;
                let found = false;
                walkFiberTree(root, (fiber) => {
                    if (!found && fiber._debugSource != null) found = true;
                }, 0, 5);
                return found;
            };

            // Collect all currently mounted, named React components visible in the viewport
            const getVisibleComponents = () => {
                const components = [];
                const seen = new Set();
                const vpW = window.innerWidth;
                const vpH = window.innerHeight;
                const root = getFiberRoot();
                if (!root) return components;

                walkFiberTree(root, (fiber) => {
                    if (!fiber.type || typeof fiber.type === 'string') return;
                    const name = fiber.type.displayName || fiber.type.name || '';
                    if (name.length <= 2 || seen.has(name)) return;
                    seen.add(name);

                    // stateNode is the DOM element for HostComponent fibers one level down,
                    // but for composite components we need to find the nearest DOM node.
                    let domNode = null;
                    // Try the component's own stateNode first (works for class components)
                    if (fiber.stateNode && fiber.stateNode.nodeType === 1) {
                        domNode = fiber.stateNode;
                    } else if (fiber.child) {
                        // Walk down to find the first real DOM node
                        let f = fiber.child;
                        while (f && !domNode) {
                            if (f.stateNode && f.stateNode.nodeType === 1) domNode = f.stateNode;
                            f = f.child;
                        }
                    }

                    let isVisible = false;
                    let boundingBox = null;
                    let textSnippet = null;

                    if (domNode) {
                        try {
                            const rect = domNode.getBoundingClientRect();
                            isVisible = rect.width > 0 && rect.height > 0 &&
                                rect.top < vpH && rect.bottom > 0 &&
                                rect.left < vpW && rect.right > 0;
                            boundingBox = {
                                top: Math.round(rect.top),
                                left: Math.round(rect.left),
                                width: Math.round(rect.width),
                                height: Math.round(rect.height),
                            };
                            textSnippet = (domNode.textContent || '').trim().substring(0, 80) || null;
                        } catch (_) {}
                    }

                    // Also include components that have _debugSource (dev mode) even without a DOM node
                    const debugSource = fiber._debugSource;
                    components.push({
                        name,
                        isVisible,
                        boundingBox,
                        textSnippet,
                        capturedAt: Date.now(),
                        sourceFile: debugSource ? debugSource.fileName : null,
                        sourceLine: debugSource ? debugSource.lineNumber : null,
                    });
                });

                return components;
            };

            // ----------------------------------------------------------
            // DOM SNAPSHOT
            // ----------------------------------------------------------
            const captureDOM = (el, pathPrefix = '', maxDepth = 8) => {
                if (maxDepth <= 0) return null;
                if (!el || el.nodeType !== 1) return null;
                const tag = el.tagName.toLowerCase();
                const skip = new Set(['script', 'style', 'link', 'meta', 'noscript']);
                if (skip.has(tag)) return null;

                const testId = el.getAttribute('data-testid');
                const elId = el.id || null;
                const className = (typeof el.className === 'string' ? el.className : '').substring(0, 80) || null;
                const xpath = pathPrefix + '/' + tag + (elId ? `#${elId}` : '');

                const children = [];
                for (let i = 0; i < el.children.length && children.length < 50; i++) {
                    const child = captureDOM(el.children[i], xpath, maxDepth - 1);
                    if (child) children.push(child);
                }

                let text = null;
                if (el.childNodes.length > 0 && el.childNodes[0].nodeType === 3) {
                    text = el.childNodes[0].textContent.trim().substring(0, 80);
                }

                return { tag, id: elId, testId, className, path: xpath, text, children };
            };

            // ----------------------------------------------------------
            // MUTATION OBSERVER — legacy component render tracking
            // ----------------------------------------------------------
            const profilerState = { components: new Set() };

            const extractComponentName = (element) => {
                if (element.getAttribute && element.getAttribute('data-testid')) {
                    return element.getAttribute('data-testid');
                }
                if (element.id && element.id.length > 2) return element.id;
                if (element.className && typeof element.className === 'string') {
                    const classes = element.className.split(' ').filter(c => c.length > 3 && !c.includes('-'));
                    if (classes.length > 0) return classes[0];
                }
                return null;
            };

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === 1) {
                                const name = extractComponentName(node);
                                if (name && !profilerState.components.has(name)) {
                                    profilerState.components.add(name);
                                    window.onRenderDetected({ source: 'DOM', target: name });
                                }
                            }
                        });
                    }
                });
            });

            observer.observe(document.body, { childList: true, subtree: true });
            console.log('[Profiler] ✓ MutationObserver installiert');

            // ----------------------------------------------------------
            // DEV-MODE CHECK
            // ----------------------------------------------------------
            const isDevMode = detectDevMode();
            if (!isDevMode) {
                console.warn('[Profiler] ⚠️  Produktions-Build erkannt (kein _debugSource). Komponentennamen können geminfiziert sein.');
                console.warn('[Profiler]    Tipp: App im Entwicklungsmodus starten (react-scripts start) für vollständige Namen.');
            } else {
                console.log('[Profiler] ✓ Entwicklungsmodus erkannt — vollständige Komponentennamen verfügbar.');
            }

            // ----------------------------------------------------------
            // CLICK HANDLER
            // ----------------------------------------------------------
            document.addEventListener('click', (event) => {
                const timestamp = Date.now();
                const targetEl = event.target;

                // Find data-testid on target or ancestors
                let testId = null;
                let searchEl = targetEl;
                let depth = 0;
                while (searchEl && !testId && depth < 15) {
                    testId = searchEl.getAttribute ? searchEl.getAttribute('data-testid') : null;
                    if (!testId) { searchEl = searchEl.parentElement; depth++; }
                }

                // Find React component via fiber
                let componentNameLeaf = null;
                let executionPath = [];
                let el = targetEl;
                let fiberDepth = 0;
                while (el && !componentNameLeaf && fiberDepth < 25) {
                    const fiber = getFiber(el);
                    if (fiber) {
                        componentNameLeaf = getComponentName(fiber);
                        executionPath = traceExecutionPath(fiber);
                    }
                    if (!componentNameLeaf) { el = el.parentElement; fiberDepth++; }
                }

                // Filtered path: only user-defined components
                const executionPathUser = filterUserPath(executionPath);
                // Best component name: innermost user-defined component
                const componentName = getUserComponentName(executionPath) || componentNameLeaf;

                const eventData = {
                    eventType: 'click',
                    timestamp,
                    targetTestId: testId,
                    targetTagName: targetEl.tagName ? targetEl.tagName.toLowerCase() : null,
                    componentName,
                    componentNameLeaf,
                    executionPath,
                    executionPathUser
                };

                // Compute the same UID that Node.js will use for this event
                const eventUid = makeBrowserUid('UserEvent', `click_${timestamp}`);

                if (componentName || testId) {
                    console.log(`[Click] 🖱️  ${componentName} (leaf: ${componentNameLeaf})`);
                    console.log(`[Click]   User-Pfad: ${executionPathUser.map(s => s.name).join(' → ')}`);
                    window.onUserEvent(eventData);

                    // Clear the render queue NOW so we only capture re-renders
                    // that happen as a result of this click.
                    if (window.__profilerQueue) window.__profilerQueue.renders = [];

                    // After React has had time to re-render (1.5 s), capture:
                    //  1. Which components are visible in the viewport
                    //  2. Which components re-rendered (from the DevTools hook queue)
                    setTimeout(() => {
                        const visibleComponents = getVisibleComponents();
                        if (visibleComponents.length > 0) {
                            console.log(`[Visible] 📷 ${visibleComponents.length} Komponenten erfasst (${visibleComponents.filter(c => c.isVisible).length} sichtbar)`);
                            window.onVisibleComponents(eventUid, visibleComponents);
                        }

                        const renders = window.__profilerQueue ? [...window.__profilerQueue.renders] : [];
                        if (window.__profilerQueue) window.__profilerQueue.renders = [];
                        if (renders.length > 0) {
                            console.log(`[BgRender] ⚙️  ${renders.length} Hintergrund-Renders nach Klick`);
                            window.onBackgroundRenders(eventUid, renders);
                        }

                        scheduleDOMSnapshot();
                    }, 1500);
                } else {
                    console.log(`[Click] Kein React-Komponentenname gefunden`);
                }
            }, true);
            console.log('[Profiler] ✓ Click-Listener mit Execution-Path-Tracking installiert');

            // ----------------------------------------------------------
            // ERROR TRACKING
            // ----------------------------------------------------------
            window.addEventListener('error', (event) => {
                window.onRuntimeError({
                    message: event.message,
                    stack: event.error ? event.error.stack : '',
                    componentName: null
                });
            });

            window.addEventListener('unhandledrejection', (event) => {
                window.onRuntimeError({
                    message: event.reason ? event.reason.message || String(event.reason) : 'Unhandled Promise Rejection',
                    stack: event.reason && event.reason.stack ? event.reason.stack : '',
                    componentName: null
                });
            });
            console.log('[Profiler] ✓ Error-Tracking installiert');

            // ----------------------------------------------------------
            // DOM SNAPSHOT — triggered after click (via setTimeout above)
            // ----------------------------------------------------------
            let snapshotTimer = null;

            const scheduleDOMSnapshot = () => {
                if (snapshotTimer) clearTimeout(snapshotTimer);
                snapshotTimer = setTimeout(() => {
                    snapshotTimer = null;
                    const domTree = captureDOM(document.body);
                    if (domTree) {
                        console.log('[DOM] 📸 Snapshot nach Klick');
                        window.onDOMSnapshot(domTree);
                    }
                }, 500);
            };

            // Initial snapshot after page load
            setTimeout(() => {
                const domTree = captureDOM(document.body);
                if (domTree) window.onDOMSnapshot(domTree);

                // Also capture initial visible components
                const initialVisible = getVisibleComponents();
                if (initialVisible.length > 0) {
                    console.log(`[Visible] 🏁 Initial: ${initialVisible.length} Komponenten gemounted`);
                    // Use a placeholder event UID for the initial snapshot
                    window.onVisibleComponents('__initial__', initialVisible);
                }
            }, 3000);

            console.log('[Profiler] ✓ DOM-Snapshot: initial + nach jedem Klick');
        });

        console.log("\nℹ️  Profiler ist aktiv. Schließe den Browser oder drücke Strg+C im Terminal, um zu beenden.");
        console.log("   Erfasst: Renders, Klicks mit Ausführungspfad, Sichtbare Komponenten, Hintergrund-Renders, DOM-Struktur, Runtime-Errors\n");

        await new Promise(resolve => browser.on('disconnected', resolve));

    } catch (error) {
        console.error("\nFehler im Profiler:", error.message);
    } finally {
        console.log("\n👋 Profiler wird beendet...");
        if (browser && browser.process() != null) await browser.close();
        if (driver) await driver.close();
        console.log("Die Laufzeitdaten wurden in CodeVis gespeichert.");
        process.exit(0);
    }
}

// ============================================================
// START & SHUTDOWN
// ============================================================

process.on('SIGINT', () => {
    console.log("\nStrg+C erkannt, fahre herunter...");
});

main();
