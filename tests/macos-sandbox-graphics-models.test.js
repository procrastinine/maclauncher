const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {execFileSync, spawn} = require('node:child_process');
const {once}=require('node:events');
const Sandbox = require('../src/modules/shared/runtime/macos-sandbox');
const noHelperScope = {executables:[],capabilities:'',fileExtensions:{read:[],readWrite:[]}};

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-model-grants-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stores = ['lossless-models', 'graphics-neural-models'].map(name => path.join(root, 'runtimes', name));
  const input = path.join(root, 'input'), output = path.join(root, 'output');
  for (const directory of [...stores, input, output]) fs.mkdirSync(directory, {recursive: true});
  const isolate = roots => Sandbox.isolateGraphics({RESHADE_EFFECT_MODEL_ROOTS: JSON.stringify(roots)}, input, output);
  return {root, stores, input, output, isolate};
}

test('live model grants contain only canonical distinct managed stores under one runtimes directory', async t => {
  const warnings=[];t.mock.method(console,'warn',(...args)=>warnings.push(args.join(' ')));
  const f = fixture(t), scoped = await f.isolate(f.stores);
  assert.deepEqual(scoped.readableDirectories, f.stores);
  assert.deepEqual(scoped.readable, []);
  assert.equal(scoped.graphics.RESHADE_EFFECT_MODEL_ROOTS, JSON.stringify(f.stores));
  assert.deepEqual((await f.isolate([])).readableDirectories, []);
  const omitted=async roots=>assert.deepEqual(await f.isolate(roots),{graphics:{},readable:[],readableDirectories:[],...noHelperScope});
  for (const roots of [null, {}, ['relative'], [f.root], [f.stores[0], f.stores[0]], [...f.stores, f.stores[0]]])
    await omitted(roots);
  const other = path.join(f.root, 'other', 'runtimes', 'graphics-neural-models');
  fs.mkdirSync(other, {recursive: true});
  await omitted([f.stores[0], other]);
  const alias = path.join(f.root, 'alias');fs.symlinkSync(path.dirname(f.stores[0]), alias);
  await omitted([path.join(alias, 'lossless-models')]);
  const linked = path.join(f.root, 'linked', 'runtimes');fs.mkdirSync(linked, {recursive: true});
  fs.symlinkSync(f.stores[0], path.join(linked, 'lossless-models'));
  await omitted([path.join(linked, 'lossless-models')]);
  assert.deepEqual(await Sandbox.isolateGraphics({RESHADE_EFFECT_MODEL_ROOTS:'['},f.input,f.output),{graphics:{},readable:[],readableDirectories:[],...noHelperScope});
  assert.ok(warnings.every(message=>/Additional live model access/.test(message)));
});

test('prospective model grants are noncreating, and rejected future grants preserve selected graphics', async t=>{
  const f=fixture(t),core=path.join(f.root,'core.dylib');fs.writeFileSync(core,'fixture');
  const base=await Sandbox.isolateGraphics({DYLD_INSERT_LIBRARIES:core},f.input,f.output);
  for(const store of f.stores)fs.rmdirSync(store);
  const graphics={DYLD_INSERT_LIBRARIES:core,RESHADE_EFFECT_MODEL_ROOTS:JSON.stringify(f.stores)};
  const future=await Sandbox.isolateGraphics(graphics,f.input,f.output);
  assert.deepEqual(future.readableDirectories,[...base.readableDirectories,...f.stores]);assert.ok(f.stores.every(store=>!fs.existsSync(store)));
  t.mock.method(console,'warn',()=>{throw Error('Warning sink unavailable');});
  fs.symlinkSync(f.output,f.stores[0]);
  const scoped=await Sandbox.isolateGraphics(graphics,f.input,f.output);
  assert.deepEqual(scoped,base);
});

test('spatial and LSFG adapters receive exact compiler caches without a neural binding', {skip:process.platform!=='darwin'}, async t=>{
  const f=fixture(t),core=path.join(f.root,'core.dylib');fs.writeFileSync(core,'fixture');
  const scoped=await Sandbox.isolateGraphics({DYLD_INSERT_LIBRARIES:core},f.input,f.output);
  const cacheRoot=fs.realpathSync(execFileSync('/usr/bin/getconf',['DARWIN_USER_CACHE_DIR'],{encoding:'utf8'}).trim());
  const caches=['com.apple.metal','com.apple.metalfe','com.apple.gpuarchiver'].map(name=>path.join(cacheRoot,name));
  assert.deepEqual(scoped.readableDirectories,caches);
  assert.deepEqual(scoped.fileExtensions.readWrite,caches);
  assert.deepEqual(scoped.readable,[core]);
  assert.deepEqual(scoped.executables,[]);
  assert.match(scoped.capabilities,/com\.apple\.bsd\.dirhelper/);
  assert.equal(scoped.readableDirectories.includes(cacheRoot),false);
  assert.equal(scoped.graphics.RESHADE_NEURAL_LIBRARY,undefined);
});

test('Seatbelt permits later imported models without granting writes, neighboring stores or escaped links', {skip: process.platform !== 'darwin',timeout:10000}, async t => {
  const f = fixture(t);
  for(const store of f.stores)fs.rmdirSync(store);
  const scoped = await f.isolate(f.stores);
  const files = f.stores.map(store => path.join(store, 'later', 'model.bin'));
  const neighbor = path.join(f.root, 'runtimes', 'private-store', 'secret');
  fs.mkdirSync(path.dirname(neighbor));fs.writeFileSync(neighbor, 'private');
  const alias = path.join(f.stores[0], 'escape');
  const executable = path.join(f.root, 'probe'), policy = path.join(f.root, 'sandbox.sb');
  execFileSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
    path.join(__dirname, 'fixtures/network-isolation/graphics-model-resources.c'), '-o', executable]);
  fs.writeFileSync(policy, Sandbox.profile({readDirectories: scoped.readableDirectories, readFiles: scoped.readable,
    writeDirectories: [], executables: [executable], blockNetwork: true}));
  const created = f.stores.map(store => path.join(store, 'forbidden.bin'));
  const child = spawn('/usr/bin/sandbox-exec', ['-f', policy, executable, ...files, neighbor, alias, ...created,'wait'],
    {env: Sandbox.environment(),timeout:5000});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
  let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
  const closed=once(child,'close');
  await Promise.race([once(child.stdout,'data'),closed.then(result=>{throw Error('Sandbox closed before import: '+result+' '+stderr);})]);
  assert.match(stdout,/ready/);assert.ok(f.stores.every(store=>!fs.existsSync(store)));
  // Import only after the running child has entered the sandbox, proving
  // future paths work without creating stores during graphics attachment.
  for(const file of files){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'model');}
  fs.symlinkSync(neighbor,alias);child.stdin.end('x');
  assert.deepEqual(await closed,[0,null],stdout+stderr);
  assert.match(stdout, /neighboring data and model writes are denied/);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), ['model', 'model']);
  assert.equal(fs.readFileSync(neighbor, 'utf8'), 'private');
  assert.ok(created.every(file => !fs.existsSync(file)));
});
