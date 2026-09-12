#!/usr/bin/env node

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Parser, Language, Query } = require('web-tree-sitter');
const {
  LANG_CONFIGS,
  resolveGrammarWasm,
  resolveFunctionNode,
  hasFunctionAncestorBeforeClass,
} = require('../scripts/graph_builder.js').__testing__;

let languages;

before(async () => {
  await Parser.init();
  languages = new Map();
  for (const extension of ['.py', '.js', '.ts', '.cpp']) {
    const config = LANG_CONFIGS[extension];
    const wasmPath = resolveGrammarWasm(config.wasm);
    languages.set(extension, {
      config,
      language: await Language.load(path.resolve(wasmPath)),
    });
  }
});

function functionScopes(extension, source) {
  const { config, language } = languages.get(extension);
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, config.funcQuery);
  const tree = parser.parse(source);

  return query.matches(tree.rootNode).map(match => {
    const nameCapture = match.captures.find(capture => capture.name === 'func_name');
    const functionNode = resolveFunctionNode(nameCapture.node);
    return {
      name: nameCapture.node.text,
      nestedBeforeClass: hasFunctionAncestorBeforeClass(functionNode),
    };
  });
}

describe('class method scope detection', () => {
  it('rejects a Python def nested in a method', () => {
    const scopes = functionScopes('.py', `
class Worker:
    def run(self):
        def helper():
            return 1
        return helper()
`);

    assert.deepEqual(scopes, [
      { name: 'run', nestedBeforeClass: false },
      { name: 'helper', nestedBeforeClass: true },
    ]);
  });

  it('rejects a JavaScript function nested in a method', () => {
    const scopes = functionScopes('.js', `
class Worker {
  run() {
    function helper() { return 1; }
    return helper();
  }
}
`);

    assert.deepEqual(scopes, [
      { name: 'run', nestedBeforeClass: false },
      { name: 'helper', nestedBeforeClass: true },
    ]);
  });

  it('rejects a TypeScript arrow nested in a method', () => {
    const scopes = functionScopes('.ts', `
class Worker {
  run(): number {
    const helper = (): number => 1;
    return helper();
  }
}
`);

    assert.deepEqual(scopes, [
      { name: 'run', nestedBeforeClass: false },
      { name: 'helper', nestedBeforeClass: true },
    ]);
  });

  it('keeps C++ methods direct and does not extract local lambdas as methods', () => {
    const scopes = functionScopes('.cpp', `
class Worker {
public:
  int run() {
    auto helper = []() { return 1; };
    return helper();
  }
};
`);

    assert.deepEqual(scopes, [
      { name: 'run', nestedBeforeClass: false },
    ]);
  });
});
