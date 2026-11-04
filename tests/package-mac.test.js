const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const wrapper = path.resolve(__dirname, '../scripts/package-mac.mjs');
const preparation = ['stage-cp932.cjs', 'prepareSevenZip', 'prepareDeclaredPublishers', 'preparePython'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-package-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'build'));
  fs.mkdirSync(path.join(root, 'src/modules/catsystem2/runtime'), { recursive: true });
  // Execute the real wrapper with all preparation dependencies owned by this
  // fixture: no publisher downloads or writes into the actual source tree.
  const localWrapper = path.join(root, 'scripts/package-mac.mjs');
  fs.copyFileSync(wrapper, localWrapper);
  fs.writeFileSync(path.join(root, 'build/runtime-packages.json'), JSON.stringify({ maximumMacOS: require('../build/runtime-packages.json').maximumMacOS }));
  const recorder = `const fs = require('node:fs');
    fs.appendFileSync('commands.jsonl', JSON.stringify({command: require('node:path').basename(process.argv[1]), args: process.argv.slice(2), maximum: process.env.MACLAUNCHER_NATIVE_MAXIMUM_MACOS}) + '\\n');`;
  fs.writeFileSync(path.join(root, 'src/modules/catsystem2/runtime/stage-cp932.cjs'), recorder);
  const recordPreparation = `const fs=require('node:fs'),assert=require('node:assert/strict');
    const record=(command,options)=>{assert.equal(options.repoRoot,process.cwd());
      fs.appendFileSync('commands.jsonl',JSON.stringify({command,args:options.arch?[options.arch]:[]})+'\\n');};`;
  fs.writeFileSync(path.join(root, 'scripts/published-inputs.cjs'), recordPreparation + `
    module.exports={prepareSevenZip:async options=>record('prepareSevenZip',options),
      prepareDeclaredPublishers:async options=>record('prepareDeclaredPublishers',options)};`);
  fs.writeFileSync(path.join(root, 'scripts/ci-macos.cjs'), recordPreparation + `
    module.exports={preparePython:async options=>record('preparePython',options)};`);
  for (const name of ['pnpm', 'electron-builder'])
    fs.writeFileSync(path.join(root, 'bin', name), '#!' + process.execPath + '\n' + recorder, { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(root, 'bin'), CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const key of ['CSC_LINK', 'CSC_NAME', 'MACLAUNCHER_RUNTIME_SIGN_IDENTITY']) delete env[key];
  return { root, run: args => spawnSync(process.execPath, [localWrapper, '--', '--dir', '--arm64', ...args], { cwd: root, env, encoding: 'utf8' }),
    commands: () => fs.existsSync(path.join(root, 'commands.jsonl'))
      ? fs.readFileSync(path.join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('package command prepares publisher resources before the renderer and app build', t => {
  const f = fixture(t), result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.deepEqual(commands.map(row => row.command), [...preparation, 'pnpm', 'pnpm']);
  assert.deepEqual(commands.find(row => row.command === 'preparePython').args, ['arm64']);
  assert.deepEqual(commands.at(-2).args, ['run', 'build']);
  assert.deepEqual(commands.at(-1).args.slice(0, 4), ['exec', 'electron-builder', '--mac', '--publish=never']);
});
test('package command builds one app architecture per run', t => {
  const f = fixture(t);
  for (const extra of [['--x64'], ['--universal']]) {
    const result = f.run(extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /one architecture per run|separate Apple Silicon and Intel apps/);
  }
  assert.deepEqual(f.commands(), []);
});

test('package command keeps runtime CLI validation and forwards the selected macOS configuration', t => {
  const f = fixture(t);
  for (const args of [['--runtime-only', 'native'], ['--runtime-sign-identity']]) {
    const result = f.run(args); assert.notEqual(result.status, 0); assert.match(result.stderr, /complete runtime distribution|requires a value/);
  }
  assert.equal(f.run(['--runtime-maximum-macos', '14.0', '--runtime-sign-identity', '-']).status, 0);
  assert.equal(f.commands().at(-1).maximum, '14.0');
});
