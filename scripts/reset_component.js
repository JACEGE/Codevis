#!/usr/bin/env node
/**
 * reset_component.js — Löscht RuntimeDOM-Knoten einer bestimmten Komponente/Seite
 *
 * Nutzung:
 *   node scripts/reset_component.js <workspace> <ComponentName>        — Löscht RuntimeDOM-Knoten
 *   node scripts/reset_component.js <workspace> <ComponentName> --list — Nur anzeigen
 *
 * Beispiel:
 *   node scripts/reset_component.js project_db App
 *   node scripts/reset_component.js codevis_db Dashboard --list
 *
 * Workspaces: project_db, codevis_db
 */

// Embedded Ladybug DB via the driver-compatible compat client.
const ladybug = require('../server/ladybug-driver.cjs');
const { execFileSync } = require('child_process');
const path = require('path');
const { loadConfig, PROJECT_ROOT } = require('../server/codevis-paths.cjs');
const { normalizeWorkspaceName, publicWorkspaceName } = require('../lib/workspace-names.cjs');

async function main() {
  if (!process.argv[2]) throw new Error('Specify a workspace: project_db or codevis_db.');
  const config = loadConfig();
  const targetName = normalizeWorkspaceName(process.argv[2]);
  const componentName = process.argv[3];
  const listOnly = process.argv.includes('--list');

  if (!config.workspaces[targetName]) throw new Error(`Workspace '${publicWorkspaceName(targetName)}' is not configured.`);

  if (!componentName || componentName.startsWith('--')) {
    console.error('Kein Komponentenname angegeben.');
    console.error('   Nutzung: node scripts/reset_component.js <workspace> <ComponentName> [--list]');
    console.error('\n   Verfuegbare Komponenten mit RuntimeDOM-Knoten:');
    await listAllComponents(config.workspaces[targetName]);
    process.exitCode = 1;
    return;
  }

  const ws = config.workspaces[targetName];
  const { auth } = ws;
  const dbUri = ws.dbUri || ws.neo4jUri;
  const driver = ladybug.driver(dbUri, ladybug.auth.basic(auth.user, auth.pass));
  const session = driver.session();

  try {
    const findResult = await session.run(`
      MATCH (func:Function)-[:RUNTIME_RENDERS]->(dom:RuntimeDOM)
      WHERE func.name = $name OR func.file CONTAINS $name
      RETURN count(DISTINCT dom) AS domCount
    `, { name: componentName });

    const totalDom = findResult.records.reduce(
      (sum, r) => sum + r.get('domCount').toNumber(), 0
    );

    const filesResult = await session.run(`
      MATCH (func:Function)
      WHERE func.name = $name OR func.file CONTAINS $name
      RETURN DISTINCT func.file AS file, func.name AS funcName
      LIMIT 20
    `, { name: componentName });

    console.log(`\nKomponente: ${componentName}`);
    console.log(`   RuntimeDOM-Knoten: ${totalDom}`);
    console.log(`   Betroffene Funktionen:`);
    for (const r of filesResult.records) {
      console.log(`     - ${r.get('funcName')} (${r.get('file')})`);
    }

    if (totalDom === 0) {
      console.log('\nKeine RuntimeDOM-Knoten fuer diese Komponente gefunden.');
      console.log('   Tipp: Nutze --list um alle Komponenten mit RuntimeDOM-Knoten zu sehen.');
      return;
    }

    if (listOnly) {
      console.log('\n   (--list Modus: Keine Aenderungen vorgenommen)');
      return;
    }

    console.log('\nLoesche RuntimeDOM-Knoten...');
    await session.run(`
      MATCH (func:Function {name: $name})-[:RUNTIME_RENDERS]->(dom:RuntimeDOM)
      DETACH DELETE dom
    `, { name: componentName });

    await session.run(`
      MATCH (func:Function)-[:RUNTIME_RENDERS]->(dom:RuntimeDOM)
      WHERE func.file CONTAINS $name
      DETACH DELETE dom
    `, { name: componentName });

    console.log(`   RuntimeDOM-Knoten fuer "${componentName}" geloescht`);

    console.log('\nStarte Smart-Parse...');
    execFileSync(process.execPath, [path.join(__dirname, 'graph_builder.js'), publicWorkspaceName(targetName), 'diff'], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: 'inherit'
    });

    console.log(`\nFertig! "${componentName}" wurde zurueckgesetzt und neu geparst.`);

  } catch (err) {
    console.error('Fehler:', err.message);
    process.exitCode = 1;
  } finally {
    await session.close();
    await driver.close();
  }
}

async function listAllComponents(ws) {
  const { auth } = ws;
  const dbUri = ws.dbUri || ws.neo4jUri;
  const driver = ladybug.driver(dbUri, ladybug.auth.basic(auth.user, auth.pass));
  const session = driver.session();
  try {
    const result = await session.run(`
      MATCH (func:Function)-[:RUNTIME_RENDERS]->(dom:RuntimeDOM)
      RETURN func.name AS component, func.file AS file, count(dom) AS domNodes
      ORDER BY domNodes DESC
      LIMIT 20
    `);
    for (const r of result.records) {
      console.log(`     - ${r.get('component')} (${r.get('domNodes')} DOM-Nodes) -- ${r.get('file')}`);
    }
    if (result.records.length === 0) {
      console.log('     (keine RuntimeDOM-Knoten vorhanden)');
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exitCode = 1;
});
