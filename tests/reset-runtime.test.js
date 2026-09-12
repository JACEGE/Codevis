const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function runReset(script, args, { failQuery = false, count = 0 } = {}) {
  const filename = path.resolve(__dirname, '../scripts', script);
  const realRequire = createRequire(filename);
  const state = { queries: [], launches: [], closed: 0, configReads: 0 };
  const session = {
    async run(query) {
      state.queries.push(query);
      if (failQuery) throw new Error('database unavailable');
      return { records: [{ get: (key) => ['count', 'domCount', 'domNodes'].includes(key)
        ? { toNumber: () => count } : 'App' }] };
    },
    async close() {},
  };
  const driver = { session: () => session, verifyConnectivity: async () => {}, async close() { state.closed++; } };
  const fakeProcess = { argv: ['node', filename, ...args], execPath: process.execPath, exitCode: 0 };
  const context = vm.createContext({
    process: fakeProcess, __dirname: path.dirname(filename), console: { log() {}, error() {} },
    require(name) {
      if (name === '../server/codevis-paths.cjs') return {
        PROJECT_ROOT: '/sample project',
        loadConfig() {
          state.configReads++;
          return { workspaces: { target: { dbUri: 'bolt://localhost:7687', auth: {} } } };
        },
      };
      if (name === '../server/ladybug-driver.cjs') return { driver: () => driver, auth: { basic() {} } };
      if (name === 'child_process') return { execFileSync: (...values) => state.launches.push(values) };
      return realRequire(name);
    },
  });
  const source = fs.readFileSync(filename, 'utf8').replace('main().catch(', 'globalThis.completion = main().catch(');
  vm.runInContext(source, context, { filename });
  await context.completion;
  return { ...state, exitCode: fakeProcess.exitCode };
}

for (const [script, args] of [
  ['reset_user_events.js', ['project_db', '--force']],
  ['reset_component.js', ['project_db', 'App', '--list']],
]) {
  test(`${script} resolves project config and accepts public workspace names`, async () => {
    const result = await runReset(script, args);
    assert.equal(result.configReads, 1);
    assert.ok(result.queries.length > 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.closed, 1);
    assert.equal(result.queries.some(query => /DELETE|REMOVE/.test(query)), false);
  });
  test(`${script} fails visibly on database errors`, async () => {
    const result = await runReset(script, args, { failQuery: true });
    assert.equal(result.exitCode, 1);
    assert.equal(result.closed, 1);
  });
  test(`${script} requires an explicit workspace before touching data`, async () => {
    const result = await runReset(script, []);
    assert.equal(result.exitCode, 1);
    assert.equal(result.configReads, 0);
    assert.equal(result.queries.length, 0);
  });
}

test('component reset starts the packaged builder in the selected project without a shell', async () => {
  const result = await runReset('reset_component.js', ['project_db', 'App'], { count: 1 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.launches.length, 1);
  const [executable, args, options] = result.launches[0];
  assert.equal(executable, process.execPath);
  assert.equal(args[0], path.resolve(__dirname, '../scripts/graph_builder.js'));
  assert.equal(args[1], 'project_db');
  assert.equal(options.cwd, '/sample project');
  assert.equal(options.windowsHide, true);
});
