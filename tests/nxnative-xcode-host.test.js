const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Prepare = require('../src/modules/nxnative/prepare');
const manifest = require('../src/modules/nxnative/manifest.json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nxnative-xcode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = path.join(root, 'prepared'), host = path.join(root, 'host');
  fs.mkdirSync(prepared);fs.mkdirSync(path.join(root, 'original'));fs.writeFileSync(host, 'packaged');
  const elf = path.join(prepared, 'game.elf'), file = path.join(prepared, 'launch.json');
  fs.writeFileSync(elf, 'synthetic');
  const launch = { schemaVersion: 1, command: host, args: [elf], cwd: prepared, env: {} };
  const context = { userDataDir: root, runtimeSettings: {} }, entry = { gameId: 'fixture' };
  const runtime = { root, host, cli: 'stub', config: {}, source: { root, revision: 'a'.repeat(40) } };
  return { root, prepared, host, file, launch, context, runtime,
    validate() { fs.writeFileSync(file, JSON.stringify(launch));return Prepare.validateLaunch(file, prepared, runtime, { sourceRoot: path.join(root, 'original') }, entry, context); } };
}

test('Xcode host option defaults off and older tools only receive an optional variable', async t => {
  const f = fixture(t), settings = manifest.runtime.entries.nxnative.settings;
  assert.equal(settings.defaults.buildUpstreamHost, false);
  assert.match(settings.fields.find(row => row.key === 'buildUpstreamHost').description, /Needs Xcode/);
  const cache = path.join(f.root, 'runtimes/nxnative/upstream-hosts');
  for (const enabled of [false, true]) {
    f.context.runtimeSettings.buildUpstreamHost = enabled;
    let environment;
    await Prepare.runCli(f.runtime, ['prepare'], path.join(f.root, 'preparation'), f.context, {
      runCommand: async (_command, _args, options) => { environment = options.env; }
    });
    assert.equal(environment.NXNATIVE_UPSTREAM_HOST_CACHE, enabled ? cache : undefined);
    assert.equal(fs.existsSync(cache), false, 'passing the flag never creates or builds a host');
    assert.equal(f.validate().command, f.host, 'a packaged host keeps its original launch path');
  }
});

test('only the opted-in regular managed-cache host is accepted', t => {
  const f = fixture(t), cache = path.join(f.root, 'runtimes/nxnative/upstream-hosts');
  const built = path.join(cache, 'a'.repeat(40), '0100000000000000', 'dmhost');
  fs.mkdirSync(path.dirname(built), { recursive: true });fs.writeFileSync(built, 'upstream');
  f.launch.command = built;
  assert.throws(() => f.validate(), /managed runtime/);
  f.context.runtimeSettings.buildUpstreamHost = true;
  assert.equal(f.validate().command, built);
  fs.unlinkSync(f.host);
  assert.equal(f.validate().command, built, 'a built host remains usable if the packaged host is unavailable');
  const other = path.join(f.root, 'other-host');fs.writeFileSync(other, 'untrusted');
  fs.unlinkSync(built);fs.symlinkSync(other, built);
  assert.throws(() => f.validate(), /managed runtime/);
  fs.unlinkSync(built);fs.rmSync(cache, { recursive: true });
  const outside = path.join(f.root, 'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside, 'dmhost'), 'outside');
  fs.symlinkSync(outside, cache);f.launch.command = path.join(cache, 'dmhost');
  assert.throws(() => f.validate(), /managed runtime/);
});


test('managed reads remain additive alongside the opt-in upstream host route', t => {
  const f=fixture(t),payload=path.join(f.root,'package');fs.mkdirSync(payload);
  f.runtime.managed=true;f.runtime.root=payload;f.runtime.host=path.join(payload,'renamed-host');
  fs.writeFileSync(f.runtime.host,'packaged');f.launch.command=f.runtime.host;
  f.launch.schemaVersion=99;f.launch.args.push('--additive-option');
  assert.equal(f.validate().command,f.runtime.host);
  const built=path.join(f.root,'runtimes/nxnative/upstream-hosts/current/dmhost');
  fs.mkdirSync(path.dirname(built),{recursive:true});fs.writeFileSync(built,'upstream');f.launch.command=built;
  assert.throws(()=>f.validate(),/managed runtime/);
  f.context.runtimeSettings.buildUpstreamHost=true;
  assert.equal(f.validate().command,built);assert.deepEqual(f.validate().args,f.launch.args);
});

test('the opt-in flag reaches a packaged CLI without a Python or source environment', async t => {
  const f=fixture(t);delete f.runtime.source;f.context.runtimeSettings.buildUpstreamHost=true;
  let environment;
  await Prepare.runCli(f.runtime,['prepare'],path.join(f.root,'preparation'),f.context,{
    runCommand:async(_command,_args,options)=>{environment=options.env;}
  });
  assert.equal(environment.NXNATIVE_UPSTREAM_HOST_CACHE,path.join(f.root,'runtimes/nxnative/upstream-hosts'));
});
