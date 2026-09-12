#!/usr/bin/env node

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { Parser, Language, Query } = require('web-tree-sitter');
const {
  LANG_CONFIGS,
  resolveGrammarWasm,
  safeQuery,
  extractClasses,
  extractFunctions,
  extractCalls,
  invalidateClassResolution,
} = require('../scripts/graph_builder.js').__testing__;

let language;

before(async () => {
  await Parser.init();
  language = await Language.load(resolveGrammarWasm(LANG_CONFIGS['.py'].wasm));
});

function record(values) {
  return { get: (key) => values[key] };
}

function recordingSession({ sourceFile = 'pkg_b/state.py' } = {}) {
  const calls = [];
  return {
    calls,
    async run(cypher, params = {}) {
      const normalized = cypher.replace(/\s+/g, ' ').trim();
      calls.push({ cypher: normalized, params });

      if (cypher.includes('RETURN c.uid AS uid, c.name AS name, c.file AS file')) {
        return {
          records: [
            record({ uid: 'controller-uid', name: 'Controller', file: 'app/controller.py' }),
            record({ uid: 'state-a-uid', name: 'State', file: 'pkg_a/state.py' }),
            record({ uid: 'state-b-uid', name: 'State', file: 'pkg_b/state.py' }),
          ],
        };
      }
      if (cypher.includes('[:IMPORTS]->(f:File) RETURN f.path AS file')) {
        return { records: [record({ file: sourceFile })] };
      }
      if (cypher.includes('RETURN s.localName AS localName')) {
        return {
          records: [record({
            localName: 'State',
            originalName: 'State',
            sourceFile,
          })],
        };
      }
      if (cypher.includes('RETURN f.name AS name, f.file AS file')) {
        return {
          records: [
            record({ name: '__init__', file: 'app/controller.py' }),
            record({ name: 'run', file: 'app/controller.py' }),
            record({ name: 'enter', file: sourceFile }),
          ],
        };
      }
      if (cypher.includes('RETURN s.localName AS n')) {
        return { records: [record({ n: 'State' })] };
      }
      return { records: [] };
    },
  };
}

async function extract(source, session) {
  invalidateClassResolution();
  const config = LANG_CONFIGS['.py'];
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const cached = {
    classQuery: safeQuery(language, config.classQuery),
    funcQuery: new Query(language, config.funcQuery),
    callQuery: new Query(language, config.callQuery),
    attributeTypeQuery: new Query(language, config.attributeTypeQuery),
    jsxQuery: null,
  };
  const graphMod = { int: (value) => value };
  const classBounds = await extractClasses(
    session, cached, tree, 'app/controller.py', graphMod
  );
  const funcBounds = await extractFunctions(
    session, cached, tree, 'app/controller.py', graphMod, classBounds
  );
  await extractCalls(
    session, cached, tree, 'app/controller.py', funcBounds, classBounds
  );
}

function typedCallWrites(session) {
  return session.calls.filter((call) =>
    call.cypher.includes('MATCH (targetClass:Class {uid: $targetClassUid})')
  );
}

describe('Python typed attribute calls', () => {
  it('resolves self.attr.method() through an __init__ constructor assignment', async () => {
    const session = recordingSession();
    await extract(`
from pkg_b.state import State

class Controller:
    def __init__(self):
        self.state = State()

    def run(self):
        self.state.enter()
`, session);

    const writes = typedCallWrites(session);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params.targetClassUid, 'state-b-uid');
    assert.equal(writes[0].params.targetFuncName, 'enter');
    assert.equal(writes[0].params.callerName, 'run');
    assert.ok(!writes.some((write) => write.params.targetClassUid === 'state-a-uid'));
  });

  it('uses a simple attribute type annotation when construction is indirect', async () => {
    const session = recordingSession();
    await extract(`
from pkg_b.state import State

class Controller:
    def __init__(self):
        self.state: State = make_state()

    def run(self):
        self.state.enter()
`, session);

    const writes = typedCallWrites(session);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params.targetClassUid, 'state-b-uid');
  });

  it('does not guess self.attr.method() without a constructor type', async () => {
    const session = recordingSession();
    await extract(`
class Controller:
    def run(self):
        self.state.enter()
`, session);

    assert.deepEqual(typedCallWrites(session), []);
  });

  it('does not treat deeper self.a.b.method() as a direct typed attribute', async () => {
    const session = recordingSession();
    await extract(`
from pkg_b.state import State

class Controller:
    def __init__(self):
        self.a = State()

    def run(self):
        self.a.child.enter()
`, session);

    assert.deepEqual(typedCallWrites(session), []);
    assert.ok(!session.calls.some((call) => call.cypher.includes('MERGE (caller)-[:CALLS]->(callee)')));
  });
});
