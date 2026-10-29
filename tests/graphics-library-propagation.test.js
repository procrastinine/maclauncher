const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Sandbox = require('../src/modules/shared/runtime/macos-sandbox');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selected-graphics-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const inputs = path.join(root, 'inputs'), output = path.join(root, 'output');
  fs.mkdirSync(inputs);fs.mkdirSync(output);
  const put = name => {const file = path.join(root, name);fs.mkdirSync(path.dirname(file), {recursive:true});fs.writeFileSync(file, 'owned code');return file;};
  return {root, inputs, output, put};
}
// Every selected Metal adapter compiles shaders through the OS compiler caches.
const compilerCaches = directories => directories.length === 3 && directories.every(directory => /\/C\/com\.apple\.(?:metal|metalfe|gpuarchiver)$/.test(directory));
const unavailable = {graphics: {}, readable: [], readableDirectories: [], executables: [], capabilities: '', fileExtensions: {}};

test('graphics isolation retains every explicit canonical adapter without ambient injection or parent access', async t => {
  t.mock.method(console,'warn',()=>{});
  const f = fixture(t), core = f.put('selected/core.dylib'), audio = f.put('selected/audio.dylib');
  const alias = path.join(f.root, 'alias.dylib');fs.symlinkSync(core, alias);
  const ambient = f.put('ambient.dylib'), previous = process.env.DYLD_INSERT_LIBRARIES;
  process.env.DYLD_INSERT_LIBRARIES=ambient;
  t.after(()=>{if(previous===undefined)delete process.env.DYLD_INSERT_LIBRARIES;else process.env.DYLD_INSERT_LIBRARIES=previous;});
  const scoped = await Sandbox.isolateGraphics({DYLD_INSERT_LIBRARIES:alias+':'+audio+':'+core,
    DYLD_LIBRARY_PATH:'/unselected', API_TOKEN:'private'}, f.inputs, f.output);
  assert.deepEqual(scoped.graphics, {DYLD_INSERT_LIBRARIES:core+':'+audio});
  assert.deepEqual(scoped.readable, [core, audio]);assert.ok(compilerCaches(scoped.readableDirectories), scoped.readableDirectories.join());
  assert.deepEqual((await Sandbox.isolateGraphics({}, f.inputs, f.output)).graphics, {});
  for(const library of [path.join(f.root,'missing.dylib'),'relative.dylib'])
    assert.deepEqual(await Sandbox.isolateGraphics({DYLD_INSERT_LIBRARIES:library},f.inputs,f.output),unavailable);
});

test('included graphics providers receive exact code access without making unused providers mandatory', async t => {
  t.mock.method(console,'warn',()=>{});
  const f = fixture(t), root = path.join(f.root,'runtime');
  const core = f.put('runtime/libreshade-macos.dylib'), shader = f.put('runtime/libvkd3d-shader.dylib');
  const sidecar = f.put('runtime/libplacebo/libshaderc_shared.1.dylib');f.put('runtime/unrelated.dylib');
  fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({features: {shaders: {formats: ['isf']}}}));
  t.mock.method(require('../src/modules/shared/reshade'), 'runtimeRoot', () => root);
  const selected = {DYLD_INSERT_LIBRARIES:core};
  const scoped = await Sandbox.isolateGraphics(selected,f.inputs,f.output);
  assert.deepEqual(new Set(scoped.readable),new Set([core,shader,sidecar]));
  assert.ok(compilerCaches(scoped.readableDirectories));assert.equal(scoped.graphics.RESHADE_ISF_CACHE_ROOT, path.join(f.output, 'isf-cache'));
  const outside = f.put('outside.dylib');fs.symlinkSync(outside,path.join(root,'librashader.dylib'));
  assert.deepEqual(await Sandbox.isolateGraphics(selected,f.inputs,f.output),unavailable);
});

test('graphics isolation cancellation during an awaited grant cannot become original-render fallback', async t=>{
  const f=fixture(t),core=f.put('core.dylib'),realpath=fs.promises.realpath;
  const controller=new AbortController(),cancelled=Object.assign(Error('Stopped'),{code:'ABORT_ERR'});
  t.mock.method(fs.promises,'realpath',async(file,...args)=>{
    if(file===core){controller.abort(cancelled);throw cancelled;}
    return realpath(file,...args);
  });
  await assert.rejects(Sandbox.isolateGraphics({DYLD_INSERT_LIBRARIES:core},f.inputs,f.output,controller.signal),error=>error===cancelled);
});

test('included graphics core is locally available with a declared native dependency closure', () => {
  const ReShade = require('../src/modules/shared/reshade'), root = ReShade.runtimeRoot();
  const manifest = require('../src/modules/shared/reshade/distribution-supplementals.json')[0];
  assert.equal(manifest.id,'reshade');
  for (const name of ['libreshade-macos.dylib','libvkd3d-shader.dylib']) {
    const row = manifest.files.find(file => file.path===name);assert.ok(row,name);
    const actual=fs.statSync(path.join(root,name));assert.ok(actual.isFile());assert.equal(actual.size,row.size);
  }
});

test('every effective runtime entry passes its graphics metadata and selection through the core process handoff', async t => {
  const f=fixture(t), Registry=require('../src/modules/registry'), ReShade=require('../src/modules/shared/reshade');
  const {EventEmitter}=require('node:events'), {createLauncher}=require('../src/core/launcher');
  const selected='/included/core.dylib:/owned/audio.dylib', calls=[];
  const modelRoots=JSON.stringify(['/managed/runtimes/lossless-models','/managed/runtimes/graphics-neural-models']);
  let expected;
  t.mock.method(ReShade,'prepare',async(_entry,options)=>{
    assert.equal(options.graphicsHost,expected.graphicsHost||null);
    assert.equal(options.explicitHost,expected.graphicsHost==='explicit');
    assert.equal(options.graphicsArchitecture,expected.graphicsArchitecture);
    return {DYLD_INSERT_LIBRARIES:selected,RESHADE_EFFECT:'/selected/prepared.fx',RESHADE_EFFECT_MODEL_ROOTS:modelRoots};
  });
  const registry={...Registry,getModule:id=>({...Registry.getModule(id),getSteamApiRequirement:undefined})};
  const launcher=createLauncher({registry,userDataDir:f.root,spawn:(command,args,options)=>{
    calls.push({command,args,env:options.env});const child=new EventEmitter();child.unref=()=>{};
    process.nextTick(()=>child.emit('spawn'));return child;
  }});
  const settings=launcher.loadSettings();let count=0;
  const effects={schema:2,mode:'advanced',enabled:true,video:[{id:'shader',kind:'shader',enabled:true,shader:{enabled:true,preset:'crt'}}]};
  for(const module of Registry.listModules())for(const [runtimeId,row] of Object.entries(Registry.getModuleInfo(module.id).runtime?.entries||{})){
    if(row.launch===false)continue;
    expected=row;
    const entry={moduleId:module.id,gameId:'graphics-'+count,gamePath:path.join(f.root,'game'),effects};
    const context=launcher.getLaunchContext(entry,settings,{runtimeId,gameEffects:true});
    // Provider input discovery is covered by each producer; this contract
    // verifies effective metadata and the final shared spawn merge itself.
    context.graphicsInputs=null;
    await context.spawnDetachedChecked('/owned/runtime',['--game'],{networkIsolationApplied:true,
      env:{DYLD_INSERT_LIBRARIES:'/owned/runtime-adapter.dylib',KEEP:'1'}});
    assert.equal(calls.at(-1).env.DYLD_INSERT_LIBRARIES,'/owned/runtime-adapter.dylib:'+selected,module.id+'/'+runtimeId);
    assert.equal(calls.at(-1).env.RESHADE_EFFECT,'/selected/prepared.fx');
    assert.equal(calls.at(-1).env.RESHADE_EFFECT_MODEL_ROOTS,modelRoots,module.id+'/'+runtimeId);count++;
  }
  assert.ok(count>100);assert.equal(calls.length,count);
});
