const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { migrateLegacySettings, convertLegacyRuntimeSettings, MIGRATION } = require('../src/core/backcompat/settings-conversions');
const { createRuntimeCoordinator } = require('../src/core/runtime-coordinator');
const { runtimeSettingAliases } = require('../src/modules/gamemaker/backcompat/runtime-settings');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'settings-backcompat-'));t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const field = {key:'softwareOpenGLFallback',type:'select',default:'auto',options:[{value:'auto'},{value:'enabled'},{value:'disabled'}]};
  const info = {id:'gamemaker',runtime:{default:'official-studio',entries:{'official-studio':{settings:{fields:[field],defaults:{softwareOpenGLFallback:'auto'}}}}}};
  const registry = {listModuleIds:()=>['gamemaker'],getModuleInfo:()=>info,getLegacyRuntimeSettingAliases:()=>runtimeSettingAliases};
  const file=path.join(root,'settings.json'), runtime=path.join(root,'runtimes/official-studio/settings.json');fs.mkdirSync(path.dirname(runtime),{recursive:true});
  return {root,file,runtime,info,registry,commit:createRuntimeCoordinator({userDataDir:root}).client().applySettings};
}
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));

test('F15 raw conversion preserves three stores current values unknown fields and coordinator concurrency before normalization',t=>{
  const f=fixture(t),raw={unknown:{keep:1},launcher:{library:{version:1,order:['b','a'],favorites:['a'],sort:{mode:'recent',direction:'desc'},unknown:'keep'}},
    modules:{gamemaker:{runtimeSettings:{'official-studio':{softwareOpenGLFallback:false,custom:'keep'}}}},dataMigrations:{other:{complete:true}}};
  save(f.file,raw);save(f.runtime,{softwareOpenGLFallback:true,unknown:{keep:2}});const before=JSON.stringify(raw);
  const next=migrateLegacySettings(raw,{userDataDir:f.root,registry:f.registry,commitSettings:(previous,value)=>{
    const fresh=JSON.parse(fs.readFileSync(f.file));fresh.concurrent='preserved';save(f.file,fresh);return f.commit(previous,value);
  }});
  assert.equal(JSON.stringify(raw),before);assert.equal(next.modules.gamemaker.runtimeSettings['official-studio'].softwareOpenGLFallback,'disabled');
  assert.equal(next.modules.gamemaker.runtimeSettings['official-studio'].custom,'keep');assert.equal(next.concurrent,'preserved');
  assert.deepEqual(next.launcher.library.sort,{mode:'custom',direction:'asc'});assert.deepEqual(next.launcher.library.order,['b','a']);assert.equal(next.launcher.library.unknown,'keep');
  assert.deepEqual(next.dataMigrations.other,{complete:true});assert.equal(next.dataMigrations[MIGRATION].complete,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.runtime)),{softwareOpenGLFallback:'enabled',unknown:{keep:2}});
  const {convertLegacyRecord}=require('../src/core/backcompat/record-conversions');
  const old={gameId:'one',moduleId:'gamemaker',runtimeId:'official-studio',networkAccess:false,runtimeSettings:{'official-studio':{softwareOpenGLFallback:true,custom:'keep'}},custom:{keep:3}};
  const entry=convertLegacyRecord(old,{userDataDir:f.root,registry:f.registry});
  assert.equal(entry.runtimeSettings['official-studio'].softwareOpenGLFallback,'enabled');assert.equal(old.runtimeSettings['official-studio'].softwareOpenGLFallback,true);assert.deepEqual(entry.custom,{keep:3});
  const actualInfo=require('../src/modules/gamemaker/manifest.json');
  const {resolveRuntimeSettingsSchema,normalizeRuntimeSettings}=require('../src/core/runtime-settings');
  const schema=resolveRuntimeSettingsSchema(actualInfo,'official-studio');
  assert.equal(schema.fields.find(field=>field.key==='softwareOpenGLFallback').legacyValues,undefined);
  for(const [stored,expected] of [[next.modules.gamemaker.runtimeSettings['official-studio'],'disabled'],[entry.runtimeSettings['official-studio'],'enabled'],[JSON.parse(fs.readFileSync(f.runtime)),'enabled']]) {
    assert.equal(normalizeRuntimeSettings(schema,stored).softwareOpenGLFallback,expected,'Final current schema consumes converted global, per-game and runtime-owned values');
  }
});

test('F15 completed raw settings return unchanged before registry filesystem hooks or writes',t=>{
  const raw={dataMigrations:{[MIGRATION]:{complete:true,retained:[{runtimeId:'old',reason:'unreadable'}]}}};
  for(const method of ['lstatSync','readFileSync','writeFileSync'])t.mock.method(fs,method,()=>assert.fail('Completed conversion has no filesystem work'));
  assert.equal(migrateLegacySettings(raw,{registry:{listModuleIds:()=>assert.fail('No metadata discovery')},commitSettings:()=>assert.fail('No write')}),raw);
});

test('F15 runtime-owned malformed document is preserved before attributable conversion and unknown members survive',t=>{
  const f=fixture(t),raw={modules:{},launcher:{library:{version:2,sort:{mode:'recent',direction:'desc'}}}};save(f.file,raw);
  const broken='{"softwareOpenGLFallback":true,"unknown":{"keep":1},';fs.writeFileSync(f.runtime,broken);
  const next=migrateLegacySettings(raw,{userDataDir:f.root,registry:f.registry,commitSettings:f.commit});
  const copy=fs.readdirSync(path.dirname(f.runtime)).find(name=>name.startsWith('settings.unreadable-'));
  assert.ok(copy);assert.equal(fs.readFileSync(path.join(path.dirname(f.runtime),copy),'utf8'),broken);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.runtime)),{softwareOpenGLFallback:'enabled',unknown:{keep:1}});
  assert.deepEqual(next.launcher.library.sort,raw.launcher.library.sort);assert.equal(next.modules.gamemaker,undefined);
});

test('F15 unavailable old runtime document is diagnosed once while its real explicit choice survives the memoized narrow fallback',t=>{
  const f=fixture(t),raw={modules:{}};save(f.file,raw);save(f.runtime,{softwareOpenGLFallback:true});
  const lstat=fs.lstatSync;let probes=0,warnings=0;
  t.mock.method(fs,'lstatSync',(file,...args)=>{if(file===f.runtime){probes++;throw Object.assign(Error('unavailable runtime document'),{code:'EACCES'});}return lstat(file,...args);});
  const next=migrateLegacySettings(raw,{userDataDir:f.root,registry:f.registry,commitSettings:f.commit,logger:{warn(){warnings++;}}});
  assert.equal(next.dataMigrations[MIGRATION].complete,true);assert.equal(next.dataMigrations[MIGRATION].retained[0].runtimeId,'official-studio');
  migrateLegacySettings(next,{userDataDir:f.root,registry:f.registry,commitSettings:()=>assert.fail('No retry')});assert.equal(probes,1);assert.equal(warnings,1);
  let reads=0;const registry={getLegacyRuntimeSettingAliases(){reads++;return runtimeSettingAliases;}};
  const converted=convertLegacyRuntimeSettings(f.info,'official-studio',{softwareOpenGLFallback:true,unknown:1},registry);
  assert.equal(converted.softwareOpenGLFallback,'enabled');
  assert.deepEqual(convertLegacyRuntimeSettings(f.info,'official-studio',{softwareOpenGLFallback:true,unknown:2},registry),{softwareOpenGLFallback:'enabled',unknown:2});assert.equal(reads,1);
  const {createRuntimeSettingsStore}=require('../src/core/runtime-settings');
  assert.equal(createRuntimeSettingsStore({userDataDir:f.root}).readDefaults('official-studio',f.info).softwareOpenGLFallback,'enabled');
  assert.equal(createRuntimeSettingsStore({userDataDir:f.root}).readDefaults('official-studio',f.info).softwareOpenGLFallback,'enabled');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.runtime)),{softwareOpenGLFallback:true},'unsafe original is never replaced');
});

test('F15 failed raw commit keeps converted working settings in memory without retrying file probes or automatic writes',t=>{
  const f=fixture(t),raw={modules:{gamemaker:{runtimeSettings:{'official-studio':{softwareOpenGLFallback:true}}}},dataMigrations:{current:{complete:true}}};save(f.file,raw);save(f.runtime,{softwareOpenGLFallback:false});
  let commits=0,warnings=0;const options={userDataDir:f.root,registry:f.registry,commitSettings(){commits++;throw Error('settings read-only');},logger:{warn(){warnings++;}}};
  const first=migrateLegacySettings(raw,options),second=migrateLegacySettings(raw,options);
  assert.equal(first.modules.gamemaker.runtimeSettings['official-studio'].softwareOpenGLFallback,'enabled');assert.deepEqual(second,first);assert.equal(commits,1);assert.equal(warnings,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),raw);assert.deepEqual(first.dataMigrations.current,{complete:true});
});

test('F15 exact old booleans convert while absent current strings malformed values and current dynamic choices stay intact',t=>{
  const f=fixture(t);save(f.file,{});save(f.runtime,{softwareOpenGLFallback:'false',unknown:true});const inode=fs.statSync(f.runtime).ino;
  const raw={modules:{gamemaker:{runtimeSettings:{'official-studio':{softwareOpenGLFallback:'enabled',unknown:'keep'}}}}};
  save(f.file,raw);
  const next=migrateLegacySettings(raw,{userDataDir:f.root,registry:f.registry,commitSettings:f.commit});
  assert.equal(next.modules.gamemaker.runtimeSettings['official-studio'].softwareOpenGLFallback,'enabled');assert.equal(fs.statSync(f.runtime).ino,inode);
  const {normalizeRuntimeSettingValue}=require('../src/core/runtime-setting-values.mjs');
  assert.equal(normalizeRuntimeSettingValue({type:'select',optionsAction:'list',options:[]},'/exact/custom/runtime',''),'/exact/custom/runtime');
  assert.equal(normalizeRuntimeSettingValue(f.info.runtime.entries['official-studio'].settings.fields[0],true,'auto'),'auto');
});

test('current settings reads keep exact bytes and defer completion to an ordinary settings write',t=>{
  const f=fixture(t),raw={modules:{gamemaker:{runtimeSettings:{'official-studio':{softwareOpenGLFallback:'enabled'}}}},unknown:{keep:true}};
  const bytes=JSON.stringify(raw);fs.writeFileSync(f.file,bytes);
  let commits=0;
  const next=migrateLegacySettings(raw,{userDataDir:f.root,registry:f.registry,commitSettings(){commits++;assert.fail('A current settings read must not write');}});
  assert.equal(next,raw);assert.equal(commits,0);assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
  const noDiscovery={listModuleIds(){assert.fail('A checked profile must not be discovered again');}};
  assert.equal(migrateLegacySettings(raw,{userDataDir:f.root,registry:noDiscovery}),raw);
  const saved=f.commit(raw,{...raw,launcher:{showIcons:false}});
  assert.equal(saved.launcher.showIcons,false);assert.deepEqual(saved.unknown,{keep:true});
  assert.equal(saved.dataMigrations[MIGRATION].complete,true);
  assert.equal(migrateLegacySettings(saved,{registry:noDiscovery}),saved);
});

test('an empty settings read creates no file and runtime-only legacy conversion still records completion',t=>{
  const empty=fixture(t),raw={};
  assert.equal(migrateLegacySettings(raw,{userDataDir:empty.root,registry:empty.registry,commitSettings(){assert.fail('No marker-only settings file');}}),raw);
  assert.equal(fs.existsSync(empty.file),false);
  const legacy=fixture(t);save(legacy.runtime,{softwareOpenGLFallback:false,unknown:'keep'});
  const next=migrateLegacySettings({}, {userDataDir:legacy.root,registry:legacy.registry,commitSettings:legacy.commit});
  assert.equal(next.dataMigrations[MIGRATION].complete,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(legacy.runtime)),{softwareOpenGLFallback:'disabled',unknown:'keep'});
});
