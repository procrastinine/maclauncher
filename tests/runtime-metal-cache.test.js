const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {prepare} = require('../src/modules/shared/runtime/metal-cache');
const {profile} = require('../src/modules/shared/runtime/macos-sandbox');

test('Native Metal cache grants only the exact application cache and reuses existing contents', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metal cache ')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const system = path.join(root, 'system-cache');
  fs.mkdirSync(system, {recursive:true});
  const options = {identifier:'com.maclauncher.metal.test'};
  const result = await prepare(options, async () => system);
  assert.equal(fs.realpathSync(result.directory), result.directory);
  fs.writeFileSync(path.join(result.directory, 'shader'), 'cache');
  assert.deepEqual(await prepare(options, async () => system), result);
  assert.equal(fs.readFileSync(path.join(result.directory, 'shader'), 'utf8'), 'cache');
  const policy = profile({readDirectories:[], readFiles:[], writeDirectories:result.writeDirectories, executables:[],
    machServices:result.machServices,fileExtensions:result.fileExtensions});
  assert.ok(policy.includes('(literal '+JSON.stringify(system)+')'));
  assert.ok(policy.includes('(subpath '+JSON.stringify(result.directory)+')'));
  assert.ok(!policy.includes('(subpath '+JSON.stringify(system)+')'));
  fs.renameSync(result.directory,result.directory+'.saved');fs.symlinkSync(root,result.directory);
  await assert.rejects(prepare(options, async () => system), /must not be aliases/);
  assert.equal(fs.readlinkSync(result.directory), root);
});

