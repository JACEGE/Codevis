const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Parser, Language, Query } = require('web-tree-sitter');
const { __testing__ } = require('../scripts/graph_builder.js');

const {
  LANG_CONFIGS, resolveGrammarWasm, resolveImportPath,
  kotlinFunctionSemantics, kotlinReceiverTypes, pythonFunctionSemantics,
} = __testing__;
const FIXTURES = path.join(__dirname, 'fixtures', 'polyglot');

let initialized = false;
async function parse(extension, fixture) {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  const config = LANG_CONFIGS[extension];
  const language = await Language.load(resolveGrammarWasm(config.wasm));
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'));
  assert.equal(tree.rootNode.hasError, false, `${fixture} must parse without errors`);
  return { config, language, tree };
}

async function parseSource(extension, source) {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  const config = LANG_CONFIGS[extension];
  const language = await Language.load(resolveGrammarWasm(config.wasm));
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false);
  return { config, language, tree };
}

function captures(language, source, tree) {
  if (!source) return [];
  return new Query(language, source).matches(tree.rootNode)
    .flatMap((match) => match.captures)
    .map((capture) => ({ name: capture.name, text: capture.node.text }));
}

test('Kotlin and KTS expose functions, calls, classes and imports', async () => {
  const kt = await parse('.kt', 'Sample.kt');
  const funcs = captures(kt.language, kt.config.funcQuery, kt.tree);
  const calls = captures(kt.language, kt.config.callQuery, kt.tree);
  const classes = captures(kt.language, kt.config.classQuery, kt.tree);
  const imports = captures(kt.language, kt.config.importQuery, kt.tree);
  assert.ok(funcs.some((c) => c.name === 'func_name' && c.text === 'run'));
  assert.ok(calls.some((c) => c.name === 'call_target' && c.text === 'process'));
  assert.ok(classes.some((c) => c.text === 'MainActivity'));
  assert.ok(imports.some((c) => c.text === 'org.example.util.Helper'));

  const kts = await parse('.kts', 'build.gradle.kts');
  assert.ok(captures(kts.language, kts.config.callQuery, kts.tree)
    .some((c) => c.name === 'call_target'));
});

test('Python visibility, framework entry points and planned stubs are classified', () => {
  assert.deepEqual(pythonFunctionSemantics('_best_axis'), {
    visibility: 'private', isFrameworkEntrypoint: false, entryPointKind: null,
    isAbstract: false, isPlannedStub: false,
  });
  assert.equal(pythonFunctionSemantics('point_jacobian').visibility, 'public');
  assert.equal(pythonFunctionSemantics('test_clearance').entryPointKind, 'pytest-test');
  assert.equal(pythonFunctionSemantics('key', ['pytest.fixture']).entryPointKind, 'pytest-fixture');
  assert.equal(pythonFunctionSemantics('main', ['hydra.main']).entryPointKind, 'hydra-entrypoint');
  assert.equal(pythonFunctionSemantics('step', [], '{ raise NotImplementedError }').isPlannedStub, true);
  assert.equal(pythonFunctionSemantics('load', ['abstractmethod']).isAbstract, true);
});

test('TypeScript contracts and parameter counts carry analysis evidence', () => {
  const { jsTsFunctionSemantics, jsTsReceiverTypes, countParameters } = __testing__;
  const interfaceNode = { type: 'method_signature', text: 'load(url: string): Promise<void>', parent: { type: 'interface_declaration', parent: null } };
  assert.deepEqual(jsTsFunctionSemantics(interfaceNode, 'load'), { visibility: 'public', isAbstract: true });
  const privateNode = { type: 'method_definition', text: 'private parse(input: Map<string, number>, strict = true) {}', parent: null };
  assert.deepEqual(jsTsFunctionSemantics(privateNode, 'parse'), { visibility: 'private', isAbstract: false });
  assert.equal(countParameters('(input: Map<string, number>, strict = true)'), 2);
  assert.equal(countParameters('()'), 0);
  const receivers = jsTsReceiverTypes(`
    function useSource(source: FrameSource) { source.seek(0); }
    const concrete = new FileFrameSource();
    const memoized = useMemo(() => new FileFrameSource(), []);
  `);
  assert.equal(receivers.get('source'), 'FrameSource');
  assert.equal(receivers.get('concrete'), 'FileFrameSource');
  assert.equal(receivers.get('memoized'), 'FileFrameSource');
  const unrelatedProperty = jsTsReceiverTypes(`
    interface Props { source: FrameSource }
    function run() { const source = lookup(); source.seek(0); }
  `);
  assert.equal(unrelatedProperty.has('source'), false, 'interface properties must not type unrelated locals');
  const conflictingScopes = jsTsReceiverTypes(`
    function first(value: Alpha) { value.run(); }
    function second(value: Beta) { value.run(); }
  `);
  assert.equal(conflictingScopes.has('value'), false, 'conflicting file-global evidence must remain ambiguous');
});

test('Kotlin class delegation includes constructor bases and interfaces', async () => {
  const parsed = await parseSource('.kt', 'class Screen : Base(), Runnable, Comparable<Screen> {}');
  const bases = captures(parsed.language, parsed.config.classInheritanceQuery, parsed.tree)
    .filter((c) => c.name === 'base_class')
    .map((c) => c.text.replace(/<.*$/s, '').split('.').pop()).sort();
  assert.deepEqual(bases, ['Base', 'Comparable', 'Runnable']);
});

test('Kotlin qualified and delegated interfaces yield only final type names', async () => {
  const source = 'class Screen<T> : pkg.deep.Base<List<T>>(), api.Contract<Map<String,List<T>>>, Runnable by delegate {}';
  const parsed = await parseSource('.kt', source);
  const raw = captures(parsed.language, parsed.config.classInheritanceQuery, parsed.tree)
    .filter((c) => c.name === 'base_class').map((c) => c.text);
  const bases = raw.map((name) => name.replace(/<.*$/s, '').split('.').pop()).sort();
  assert.deepEqual(bases, ['Base', 'Contract', 'Runnable']);
  assert.ok(!raw.includes('pkg') && !raw.includes('deep') && !raw.includes('api'));
});

test('ambiguous callback names never become high-confidence targets', () => {
  const { selectUnambiguousCallbackTarget } = __testing__;
  assert.equal(selectUnambiguousCallbackTarget(['src/a.py', 'src/b.py'], 'src/main.py'), null);
  assert.equal(selectUnambiguousCallbackTarget(['src/a.py'], 'src/main.py'), 'src/a.py');
  assert.equal(selectUnambiguousCallbackTarget(['src/main.py', 'src/a.py'], 'src/main.py'), 'src/main.py');
});

test('Kotlin framework entry points and receiver types retain semantic evidence', () => {
  assert.deepEqual(
    kotlinFunctionSemantics('override fun onCreate(state: Bundle?) {}', 'onCreate'),
    {
      isOverride: true,
      isFrameworkEntrypoint: true,
      entryPointKind: 'android-lifecycle',
      visibility: 'public',
    }
  );
  assert.deepEqual(
    kotlinFunctionSemantics('private fun helper() {}', 'helper'),
    {
      isOverride: false,
      isFrameworkEntrypoint: false,
      entryPointKind: null,
      visibility: 'private',
    }
  );
  const receivers = kotlinReceiverTypes(`
    class Screen(private val repository: UserRepository) {
      val service: Api.Service = createService()
      val formatter = NameFormatter()
    }
  `);
  assert.equal(receivers.get('repository'), 'UserRepository');
  assert.equal(receivers.get('service'), 'Service');
  assert.equal(receivers.get('formatter'), 'NameFormatter');
});

test('Bash exposes functions, commands and sourced files', async () => {
  const parsed = await parse('.sh', 'build.sh');
  assert.ok(captures(parsed.language, parsed.config.funcQuery, parsed.tree)
    .some((c) => c.name === 'func_name' && c.text === 'build_app'));
  assert.ok(captures(parsed.language, parsed.config.callQuery, parsed.tree)
    .some((c) => c.name === 'call_target' && c.text === 'build_app'));
  assert.ok(captures(parsed.language, parsed.config.importQuery, parsed.tree)
    .some((c) => c.name === 'import_source' && c.text === './lib.sh'));
});

test('Bash quoted source and Ruby require forms expose project imports', async () => {
  const bash = await parseSource('.sh', 'source "./lib.sh"\n. \'./other.sh\'');
  assert.deepEqual(
    captures(bash.language, bash.config.importQuery, bash.tree)
      .filter((c) => c.name === 'import_source').map((c) => c.text),
    ['"./lib.sh"', "'./other.sh'"]
  );
  const ruby = await parseSource('.rb', 'require_relative "./helper"\nrequire("services/client")');
  assert.deepEqual(
    captures(ruby.language, ruby.config.importQuery, ruby.tree)
      .filter((c) => c.name === 'import_source').map((c) => c.text),
    ['"./helper"', '"services/client"']
  );
});

test('Lua exposes functions, method calls and require imports', async () => {
  const parsed = await parse('.lua', 'module.lua');
  const funcs = captures(parsed.language, parsed.config.funcQuery, parsed.tree);
  assert.ok(funcs.some((c) => c.name === 'func_name' && c.text === 'build'));
  assert.ok(funcs.some((c) => c.name === 'func_name' && c.text === 'App:start'));
  assert.ok(captures(parsed.language, parsed.config.importQuery, parsed.tree)
    .some((c) => c.name === 'import_source' && c.text === 'helper'));
});

test('Android XML is retained structurally without fake functions or calls', async () => {
  const parsed = await parse('.xml', 'AndroidManifest.xml');
  assert.equal(parsed.config.funcQuery, null);
  assert.equal(parsed.config.callQuery, null);
  const ast = captures(parsed.language, parsed.config.astQuery, parsed.tree);
  assert.ok(ast.some((c) => c.name === 'XMLElement'));
  assert.ok(ast.some((c) => c.name === 'XMLAttribute'));
});

test('new language imports resolve to project files without guessing ambiguities', () => {
  assert.equal(
    resolveImportPath('helper', 'lua/app.lua', new Set(['lua/app.lua', 'lua/helper.lua'])).resolved,
    'lua/helper.lua'
  );
  assert.equal(
    resolveImportPath('./lib.sh', 'scripts/build.sh', new Set(['scripts/build.sh', 'scripts/lib.sh'])).resolved,
    'scripts/lib.sh'
  );
  assert.equal(
    resolveImportPath(
      'org.example.Helper',
      'app/src/Main.kt',
      new Set(['app/src/Main.kt', 'app/src/util/Helper.kt'])
    ).resolved,
    'app/src/util/Helper.kt'
  );
  assert.equal(
    resolveImportPath(
      'org.example.Helper',
      'app/src/Main.kt',
      new Set(['app/src/Main.kt', 'a/Helper.kt', 'b/Helper.kt'])
    ).isExternal,
    true
  );
});
