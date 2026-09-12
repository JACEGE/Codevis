#!/usr/bin/env node

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { readRosModel } = require('../scripts/ros/ros_db.cjs');

function record(values) {
  return { get: (key) => values[key] };
}

it('does not choose an arbitrary ROS class for an ambiguously-owned method', async () => {
  const session = {
    async run(cypher) {
      if (cypher.includes('WHERE c.isRosNode = true') && cypher.includes('RETURN c.uid AS uid')) {
        return {
          records: [
            record({ uid: 'node-a', name: 'Node', file: 'pkg_a/node.py', nodeName: 'a', base: 'Node' }),
            record({ uid: 'node-b', name: 'Node', file: 'pkg_b/node.py', nodeName: 'b', base: 'Node' }),
          ],
        };
      }
      if (cypher.includes('RETURN t.name AS name')) {
        return cypher.includes('MATCH (t:Topic)')
          ? { records: [record({ name: '/events', kind: 'topic', msgType: 'Msg', dynamic: false })] }
          : { records: [] };
      }
      if (cypher.includes('MATCH (c:Class)-[:CONTAINS]->(f:Function)')) {
        return {
          records: [
            record({
              classUid: 'node-a', className: 'Node', classFile: 'pkg_a/node.py',
              fnName: 'publish', fnFile: 'shared/generated.py',
            }),
            record({
              classUid: 'node-b', className: 'Node', classFile: 'pkg_b/node.py',
              fnName: 'publish', fnFile: 'shared/generated.py',
            }),
          ],
        };
      }
      if (cypher.includes('[r:PUBLISHES_TOPIC]')) {
        return {
          records: [record({
            srcLabel: 'Function',
            srcName: 'publish',
            srcFile: 'shared/generated.py',
            srcPath: null,
            srcUid: 'function-publish',
            srcIsRosNode: false,
            iface: '/events',
            msgType: 'Msg',
            callback: null,
          })],
        };
      }
      return { records: [] };
    },
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const model = await readRosModel(session);
    const edge = model.edges.find((candidate) => candidate.iface === '/events');

    assert.ok(edge);
    assert.equal(edge.nodeId, 'function-publish');
    assert.notEqual(edge.nodeId, 'node-a');
    assert.notEqual(edge.nodeId, 'node-b');
    assert.ok(warnings.some((message) => message.includes('ambiguous ROS method owner')));
  } finally {
    console.warn = originalWarn;
  }
});
