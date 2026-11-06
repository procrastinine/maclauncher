const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const registry = require('../src/modules/registry');
const {runRuntimeManagerAction} = require('../src/core/runtime-manager-service');
const Dependencies = require('../src/modules/shared/runtime/package-dependencies');
const {withRuntimeCoordinator} = require('../src/core/coordinated-runtime-managers');
const coordinator = {acquireMutation: async () => 'fixture', extendMutation: async () => {}, release: async () => {}};
const write = (file, bytes) => {fs.mkdirSync(path.dirname(file), {recursive:true});fs.writeFileSync(file,bytes);};
const files = root => fs.existsSync(root) ? fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(root,e.name)):[path.join(root,e.name)]) : [];

// Installed-download disk fixtures exercise the real removal paths, including
// damaged payloads. No executable is started and no catalog is refreshed.
function installFixture(manager, userDataDir) {
  const core=manager.core, architecture=process.arch;
  let version='1.0.0', directory, sectionId='default', variant;
  if(manager.id === 'crossover') return []; // Reference-only application, never a downloaded runtime.
  if(core?.Catalog?.packs) return core.Catalog.packs.map(pack => stage(core.installRoot(userDataDir,pack.id,version),{version,sectionId:pack.id,architecture}));
  if(core?.java) return [core.java,core.vineflower].map((provider,index)=>{
    const line=provider.LTS_LINES?.[0] || 21, v=index?'1.0.0':line+'.0.0';
    const dir=provider.getInstallDir({userDataDir,version:v,line,variant:architecture});
    return stage(dir,{version:v,sectionId:index?'vineflower':'java'+line,line,variant:architecture,architecture});
  });
  if(manager.id === 'ilspy') {
    directory=require('../src/modules/shared/runtime/managed-decompiler').installRoot(userDataDir,version);
    write(path.join(directory,'tool.json'),JSON.stringify({catalogEntry:{version,url:'https://example.invalid/ilspy.zip'}}));
  } else if(core?.removeModel) {
    version='sha256-'+'a'.repeat(64);
    directory=path.join(userDataDir,'runtimes',core.ID || 'lossless-models',version);
  } else if(core?.Source) {
    version=core.Source.version;directory=core.directory(userDataDir);
  } else if(manager.id === 'gamemaker-official') { version='2026.1.0.1'; directory=path.join(userDataDir,'runtimes',manager.id,version); }
  else if(manager.id === 'mpv-plugins') return Object.keys(require('../src/modules/video/plugins').packages).map(sectionId=>
    stage(path.join(userDataDir,'runtimes',manager.id,sectionId,version),{version,sectionId,architecture}));
  else if(core?.normalizeMajor) {version='8.0.0';sectionId='v8';directory=path.join(core.installRootDir(userDataDir),'8',version);}
  else if(core?.installRootDir && !core.getInstallDir) directory=path.join(core.installRootDir(userDataDir),version);
  else
  if(core?.getInstallDir) directory=core.getInstallDir({userDataDir,version,architecture});
  else if(core?.installRoot) directory=core.installRoot(userDataDir,version);
  else throw Error('No fixture adapter for '+manager.id);
  const payload=stage(directory,{version,architecture,sectionId,variant});
  if(core?.rememberResolvedVersion) {
    const state=manager.getState({userDataDir,settings:{}});
    const section=state.sections?.find(section=>section.installed?.some(row=>row.installDir===directory));
    assert.ok(section,manager.id+' exposes its damaged download');payload.sectionId=section.id;
  }
  return [payload];
}

function stage(directory,payload) {
  const {version,architecture}=payload;
  write(path.join(directory,'runtime.json'),JSON.stringify({version,source:'download',upstreamRevision:'a'.repeat(40),architecture,executableRelative:'engine',
    catalogEntry:{version,upstreamRevision:'a'.repeat(40),architecture}}));
  write(path.join(directory,'engine'),'offline damaged fixture');
  write(path.join(directory,'support','library.dylib'),'support fixture');
  write(path.join(directory,'.partial'),'interrupted file');
  return {...payload,installDir:directory};
}

test('all registry downloads are removable in registry and reverse order without touching user data',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('No network'));
  const managers=[...new Map([...registry.listSharedRuntimeManagers(),...registry.listModuleIds().flatMap(id=>registry.getModule(id)?.runtimeManagers||[])].map(m=>[m.id,m])).values()];
  const failures=[];
  for(const reverse of [false,true]) {
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-trash-all-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    write(path.join(root,'games','fixture','save.dat'),'owner data');
    write(path.join(root,'settings.json'),JSON.stringify({runtimes:{}}));
    write(path.join(root,'steam-environments','fixture','save.dat'),'Steam bottle save');
    const shared={project:'fixture-shared',release:'1.0.0',sha256:'b'.repeat(64)}, library=Dependencies.directory(root,shared);
    // Existing coordination metadata is not a downloaded artifact. Preserve it,
    // just like settings, rather than unlinking a lock another process can use.
    fs.mkdirSync(path.dirname(library),{recursive:true});await Dependencies.collect(root);
    const preserved = new Map(files(root).map(file=>[file,fs.readFileSync(file)]));
    const installed=[];
    for(const manager of managers)try {installed.push(...installFixture(manager,root).map(payload=>({manager,payload})));}catch(error){failures.push(manager.id+': '+error.message);}
    write(path.join(library,'runtime.json'),JSON.stringify({version:shared.release,archiveSha256:shared.sha256,catalogEntry:{projectPackage:{id:shared.project}}}));
    write(path.join(library,'files','shared.dylib'),'shared library fixture');
    t.diagnostic(`${reverse?'reverse':'registry'} order: ${installed.length} downloaded fixture rows`);
    let users=0;
    for(const {manager,payload} of installed)if(manager.core?.rememberResolvedVersion) {
      users++;write(path.join(payload.installDir,'project-package.json'),JSON.stringify({dependencies:[shared]}));
    }
    await Dependencies.collect(root);assert.ok(fs.existsSync(library),'referenced library remains');
    for(const {manager,payload} of reverse?[...installed].reverse():installed)try {
      if(manager.core?.rememberResolvedVersion) {
        await runRuntimeManagerAction({manager,action:'uninstall',payload,userDataDir:root,runtimeCoordinator:coordinator,logger:{warn(){}}});
        if(--users)assert.ok(fs.existsSync(library),'another installed runtime still uses the library');
        else assert.equal(fs.existsSync(library),false,'the last removal collects the shared library');
      } else await withRuntimeCoordinator(coordinator,root,()=>manager.uninstallRuntime({...payload,userDataDir:root}));
    }catch(error){failures.push(manager.id+' remove: '+error.message);}
    for(const [file,bytes] of preserved)assert.deepEqual(fs.readFileSync(file),bytes);
    failures.push(...files(root).filter(f=>!preserved.has(f)).map(f=>(reverse?'reverse':'registry')+' leftover: '+path.relative(root,f)));
  }
  t.diagnostic(`${managers.length} registered managers; reference-only CrossOver has no downloaded fixture`);
  assert.deepEqual(failures,[]);
});
