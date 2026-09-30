const { it } = require('node:test');
const assert = require('node:assert/strict');
const { openTestDb } = require('./helpers/ladybug-session.cjs');
const { readRosModel } = require('../scripts/ros/ros_db.cjs');
const { buildRosDiagram } = require('../scripts/ros/ros_diagram.js');

// A Python and a C++ node publish the same topic. Each connection must name
// its own class, method, file and line; the method used to be matched by
// topic alone, so the Python node was credited with the C++ constructor.
it('each ROS connection carries its own method, file and line', async () => {
    const { session, cleanup } = await openTestDb();
    try {
        await session.run(`CREATE (a:Class {name:'Talker', file:'a.py', isRosNode:true, rosNodeName:'talker'})
            CREATE (fa:Function {name:'__init__', file:'a.py', owner:'Talker'})
            CREATE (b:Class {name:'Driver', file:'b.cpp', isRosNode:true, rosNodeName:'driver'})
            CREATE (fb:Function {name:'Driver', file:'b.cpp', owner:'Driver'})
            CREATE (t:Topic {name:'/cmd_vel', rosKind:'topic'})
            CREATE (a)-[:PUBLISHES_TOPIC {line:14, msgType:'Twist'}]->(t)
            CREATE (fa)-[:PUBLISHES_TOPIC {line:14, msgType:'Twist'}]->(t)
            CREATE (b)-[:PUBLISHES_TOPIC {line:10, msgType:'geometry_msgs/msg/Twist'}]->(t)
            CREATE (fb)-[:PUBLISHES_TOPIC {line:10, msgType:'geometry_msgs/msg/Twist'}]->(t)`);
        const model = await readRosModel(session, {});
        const nodeName = new Map(model.nodes.map(n => [n.id, n.name]));
        const ends = model.edges.filter(e => nodeName.get(e.nodeId) === 'Talker' || nodeName.get(e.nodeId) === 'Driver')
            .map(e => ({ node: nodeName.get(e.nodeId), via: e.viaFunction, file: e.file, line: e.line, direction: e.direction }));
        const byNode = Object.fromEntries(ends.map(e => [e.node, e]));
        assert.deepEqual(byNode.Talker, { node: 'Talker', via: '__init__', file: 'a.py', line: 14, direction: 'provide' });
        assert.deepEqual(byNode.Driver, { node: 'Driver', via: 'Driver', file: 'b.cpp', line: 10, direction: 'provide' });
    } finally { await cleanup(); }
});

it('the Mermaid diagram frames topics, services and actions in their own colour', () => {
    const src = buildRosDiagram({
        nodes: [{ id: 'n1', name: 'Robot' }],
        interfaces: [{ name: '/cmd_vel', kind: 'topic' }, { name: '/reset', kind: 'service' }, { name: '/aim', kind: 'action' }],
        edges: [
            { nodeId: 'n1', iface: '/cmd_vel', relType: 'PUBLISHES_TOPIC' },
            { nodeId: 'n1', iface: '/reset', relType: 'PROVIDES_SERVICE' },
            { nodeId: 'n1', iface: '/aim', relType: 'USES_ACTION' },
        ],
    }, { format: 'mermaid' });
    assert.match(src, /style cmd_vel stroke:#0ea5e9,stroke-width:3px/);
    assert.match(src, /style reset stroke:#f59e0b,stroke-width:3px/);
    assert.match(src, /style aim stroke:#a855f7,stroke-width:3px/);
    assert.doesNotMatch(src, /style Robot /, 'node classes keep the theme frame');
});
