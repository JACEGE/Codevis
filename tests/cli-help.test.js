const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'codevis.mjs');
const definitions = import(pathToFileURL(path.join(root, 'lib', 'cli-commands.mjs')).href);
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

test('general help lists every registered command and uses one invocation style', async () => {
  const { commandNames: commands } = await definitions;
  const output = run('help');
  for (const command of commands) assert.match(output, new RegExp(`^  ${command.replace('-', '\\-')}\\b`, 'm'));
  assert.doesNotMatch(output, /npx codevis/);
  assert.match(output, /codevis help <command>/);
});

test('every command exposes detailed help through both supported forms', async () => {
  const { commandNames: commands } = await definitions;
  for (const command of commands) {
    const explicit = run('help', command);
    const flag = run(command, '--help');
    assert.match(explicit, /USAGE/);
    assert.match(explicit, new RegExp(`codevis ${command.replace('-', '\\-')}`));
    assert.strictEqual(flag, explicit);
  }
});

test('init help includes optional locking controls', () => {
  const output = run('help', 'init');
  assert.match(output, /--locking \| --no-locking/);
  assert.match(output, /codevis init \[new\|code\]/);
  assert.match(output, /Start in planning mode without graph builds/);
});

test('unknown detailed help fails without running a command', () => {
  const result = spawnSync(process.execPath, [cli, 'help', 'missing'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Unknown command: missing/);
});

test('commands reject unknown or incomplete arguments before doing work', () => {
  const cases = [
    [['init', '--soruce', 'src'], /Unknown option/],
    [['build', 'full', 'extra'], /Unexpected argument/],
    [['info', '--wat'], /Unknown option/],
    [['dashboard', '--port'], /needs a value/],
    [['start', '--wat'], /Unknown option/],
    [['stop', '--wat'], /Unknown option/],
    [['kanban', '--wat'], /Unknown option/],
  ];
  for (const [args, message] of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 1, `${args.join(' ')} should fail`);
    assert.match(result.stderr, message);
  }
});
