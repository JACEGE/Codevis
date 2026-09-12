#!/usr/bin/env node
/**
 * reset_user_events.js — Manuelles Zurücksetzen aller getrackten Laufzeitdaten
 *
 * Löscht aus dem ausgewählten CodeVis-Graphen:
 *   - Alle UserEvent-Knoten (+ PERFORMED, TRIGGERS, EXECUTION_STEP, CLICKED_ELEMENT)
 *   - Alle RuntimeDOM-Knoten (+ HAS_CHILD, MAPS_TO_STATIC)
 *   - Alle RUNTIME_RENDERS-Kanten
 *   - Alle CLICKS_ON-Kanten (User → Function)
 *   - Alle VisibleComponent-Knoten (+ SHOWS, MAPS_TO)
 *   - Alle EXECUTION_NEXT-Kanten
 *   - Alle TRIGGERS_RENDER-Kanten
 *   - lastError / lastErrorStack / lastErrorTimestamp auf Function-Knoten
 *   - User-Knoten
 *
 * Die statische Analyse (Funktionen, States, DOMElements, CALLS, RENDERS etc.)
 * bleibt vollständig erhalten!
 *
 * Nutzung:
 *   node scripts/reset_user_events.js <workspace>          — Interaktiv mit Bestätigung
 *   node scripts/reset_user_events.js <workspace> --force  — Ohne Bestätigung
 *
 * Workspaces: project_db, codevis_db
 */

// Embedded Ladybug DB via the driver-compatible compat client.
const ladybug = require('../server/ladybug-driver.cjs');
const { loadConfig } = require('../server/codevis-paths.cjs');
const { normalizeWorkspaceName, publicWorkspaceName } = require('../lib/workspace-names.cjs');
const readline = require('readline');

async function main() {
  if (!process.argv[2]) throw new Error('Specify a workspace: project_db or codevis_db.');
  const config = loadConfig();
  const targetName = normalizeWorkspaceName(process.argv[2]);
  const force = process.argv.includes('--force');

  if (!config.workspaces[targetName]) throw new Error(`Workspace '${publicWorkspaceName(targetName)}' is not configured.`);

  const ws = config.workspaces[targetName];
  const { auth } = ws;
  const dbUri = ws.dbUri || ws.neo4jUri;
  const driver = ladybug.driver(dbUri, ladybug.auth.basic(auth.user, auth.pass));

  try {
    await driver.verifyConnectivity();
    console.log(`Verbunden mit CodeVis (${targetName})\n`);

    const session = driver.session();
    const counts = {};

    const countQuery = async (label, query) => {
      const result = await session.run(query);
      counts[label] = result.records[0].get('count').toNumber();
    };

    await countQuery('UserEvent-Knoten',      'MATCH (e:UserEvent) RETURN count(e) AS count');
    await countQuery('RuntimeDOM-Knoten',      'MATCH (d:RuntimeDOM) RETURN count(d) AS count');
    await countQuery('User-Knoten',            'MATCH (u:User) RETURN count(u) AS count');
    await countQuery('RUNTIME_RENDERS-Kanten', 'MATCH ()-[r:RUNTIME_RENDERS]->() RETURN count(r) AS count');
    await countQuery('CLICKS_ON-Kanten',       'MATCH ()-[r:CLICKS_ON]->() RETURN count(r) AS count');
    await countQuery('VisibleComponent-Knoten', 'MATCH (vc:VisibleComponent) RETURN count(vc) AS count');
    await countQuery('EXECUTION_NEXT-Kanten',  'MATCH ()-[r:EXECUTION_NEXT]->() RETURN count(r) AS count');
    await countQuery('TRIGGERS_RENDER-Kanten', 'MATCH ()-[r:TRIGGERS_RENDER]->() RETURN count(r) AS count');
    await countQuery('Funktionen mit Errors',  'MATCH (n) WHERE n.lastError IS NOT NULL RETURN count(n) AS count');

    await session.close();

    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    if (total === 0) {
      console.log('Keine Laufzeitdaten vorhanden. Nichts zu loeschen.');
      return;
    }

    console.log('Folgende Laufzeitdaten werden geloescht:');
    console.log('-'.repeat(45));
    for (const [label, count] of Object.entries(counts)) {
      if (count > 0) {
        console.log(`  ${count.toString().padStart(5)}  ${label}`);
      }
    }
    console.log('-'.repeat(45));
    console.log(`  ${total.toString().padStart(5)}  Gesamt\n`);
    console.log('Die statische Analyse (Functions, States, CALLS, RENDERS, DOMElements) bleibt erhalten!\n');

    if (!force) {
      const confirmed = await confirm('Wirklich alle Laufzeitdaten loeschen? (j/N) ');
      if (!confirmed) {
        console.log('Abgebrochen.');
        return;
      }
    }

    const deleteSession = driver.session();
    console.log('\nLoesche Laufzeitdaten...');

    await deleteSession.run('MATCH (e:UserEvent) DETACH DELETE e');
    console.log('  UserEvent-Knoten geloescht');

    await deleteSession.run('MATCH (d:RuntimeDOM) DETACH DELETE d');
    console.log('  RuntimeDOM-Knoten geloescht');

    await deleteSession.run('MATCH (vc:VisibleComponent) DETACH DELETE vc');
    console.log('  VisibleComponent-Knoten geloescht');

    await deleteSession.run('MATCH ()-[r:RUNTIME_RENDERS]->() DELETE r');
    console.log('  RUNTIME_RENDERS-Kanten geloescht');

    await deleteSession.run('MATCH ()-[r:CLICKS_ON]->() DELETE r');
    console.log('  CLICKS_ON-Kanten geloescht');

    await deleteSession.run('MATCH ()-[r:EXECUTION_NEXT]->() DELETE r');
    console.log('  EXECUTION_NEXT-Kanten geloescht');

    await deleteSession.run('MATCH ()-[r:TRIGGERS_RENDER]->() DELETE r');
    console.log('  TRIGGERS_RENDER-Kanten geloescht');

    await deleteSession.run(
      'MATCH (n) WHERE n.lastError IS NOT NULL REMOVE n.lastError, n.lastErrorStack, n.lastErrorTimestamp'
    );
    console.log('  Runtime-Error-Properties bereinigt');

    await deleteSession.run('MATCH (u:User) DETACH DELETE u');
    console.log('  User-Knoten geloescht');

    await deleteSession.close();

    // Verification
    const verifySession = driver.session();
    const remaining = await verifySession.run(
      `MATCH (n) WHERE n:UserEvent OR n:RuntimeDOM OR n:VisibleComponent OR n:User
       RETURN count(n) AS count`
    );
    const remainingCount = remaining.records[0].get('count').toNumber();
    await verifySession.close();

    if (remainingCount === 0) {
      console.log('\nAlle Laufzeitdaten wurden zurueckgesetzt. Der statische Graph ist unveraendert.');
    } else {
      console.log(`\nEs verbleiben noch ${remainingCount} Runtime-Knoten. Bitte pruefen.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Fehler:', error.message);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'j' || answer.toLowerCase() === 'y');
    });
  });
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exitCode = 1;
});
