const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const wrapper = path.resolve(__dirname, '../scripts/package-mac.mjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-package-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'bin'));
  const recorder = `const fs = require('node:fs');
    fs.appendFileSync('commands.jsonl', JSON.stringify({command: require('node:path').basename(process.argv[1]), args: process.argv.slice(2)}) + '\\n');`;
  fs.writeFileSync(path.join(root, 'scripts/check-packaging.cjs'), recorder + `
    const args = process.argv.slice(2), index = args.indexOf('--inventory');
    if (index >= 0) {
      if (!JSON.parse(fs.readFileSync(args[index + 1])).valid) process.exit(43);
    } else if (!fs.existsSync('src/resources/native-runtime-sources')) process.exit(42);`);
  for (const name of ['pnpm', 'electron-builder'])
    fs.writeFileSync(path.join(root, 'bin', name), '#!' + process.execPath + '\n' + recorder, { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(root, 'bin'), CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const key of ['CSC_LINK', 'CSC_NAME', 'MACLAUNCHER_RUNTIME_SIGN_IDENTITY']) delete env[key];
  return { root, run: args => spawnSync(process.execPath, [wrapper, '--', '--dir', '--arm64', ...args], { cwd: root, env, encoding: 'utf8' }),
    commands: () => fs.existsSync(path.join(root, 'commands.jsonl'))
      ? fs.readFileSync(path.join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('package command verifies an imported inventory without requiring local source archives', t => {
  const f = fixture(t), inventory = path.join(f.root, 'payload inventory.json');
  fs.writeFileSync(inventory, JSON.stringify({ valid: true }));
  const result = f.run(['--runtime-inventory', inventory]);
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.deepEqual(commands.map(row => row.command), ['check-packaging.cjs', 'pnpm', 'electron-builder']);
  assert.deepEqual(commands[0].args, ['source', '--arch', 'arm64', '--maximum-macos', '13.0', '--inventory', inventory]);
  assert.equal(commands[2].args.includes('--runtime-inventory'), false);
  assert.equal(commands[2].args.includes(inventory), false);
  const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/macos-app.yml'), 'utf8');
  assert.match(workflow, /run: pnpm run package:mac[^\n]*--runtime-inventory dist\/ci\/native-payload-inventory\.json/);
});

test('package command stops before the renderer and app build when inventory verification fails', t => {
  const f = fixture(t), inventory = path.join(f.root, 'invalid.json');
  fs.writeFileSync(inventory, JSON.stringify({ valid: false }));
  assert.equal(f.run(['--runtime-inventory', inventory]).status, 43);
  assert.deepEqual(f.commands().map(row => row.command), ['check-packaging.cjs']);
});

test('package command retains local source verification when no inventory is supplied', t => {
  const f = fixture(t);
  assert.equal(f.run([]).status, 42);
  assert.equal(f.commands()[0].args.includes('--inventory'), false);
  fs.mkdirSync(path.join(f.root, 'src/resources/native-runtime-sources'), { recursive: true });
  assert.equal(f.run([]).status, 0);
});

test('package command rejects an inventory flag without a value before running commands', t => {
  const f = fixture(t), result = f.run(['--runtime-inventory']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--runtime-inventory requires a value/);
  assert.deepEqual(f.commands(), []);
});
