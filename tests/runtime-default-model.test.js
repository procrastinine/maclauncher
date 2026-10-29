const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuntimeManagers } = require('../src/core/runtime-preparation');
const { managerDefaultVersion, selectRuntimeVersion } = require('../src/modules/shared/runtime/version-choices');

test('registry runtime defaults remain selectable with absent or cleared preferences', async t => {
  const registry = require('../src/modules/registry');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-default-model-'));
  t.after(() => fs.rmSync(userDataDir, {recursive:true,force:true}));
  const managers = listRuntimeManagers(registry);
  assert.ok(managers.length > 40, 'Exercise the actual composed manager registry');
  for (const manager of managers) for (const settings of [{}, {defaultVersion:null}]) {
    const state = await manager.getState({settings,userDataDir,runtimeSettings:{}});
    for (const section of state.sections || [state]) {
      const listed = (section.catalog?.installableVersions || section.catalog?.versions || []).filter(version =>
        typeof version === 'string' && !section.catalog?.versionRequirements?.[version]?.installReason && section.availabilityByVersion?.[version]?.unavailable !== true);
      const installed = (section.installed || []).filter(row=>row.ready !== false && row.status !== 'damaged').map(row=>row.version);
      if (section.supportsDefault === false || (!listed.length && !installed.length)) continue;
      const label = `${manager.id}/${section.id || 'default'}`;
      assert.ok(section.defaultVersion, label+' has an effective default');
      assert.equal(section.defaultSource, 'manager', label+' derives an unsaved default');
      assert.equal(section.selectionRequired, undefined, label+' never requires a choice');
      assert.doesNotMatch(section.reason || '', /Choose an? .*version.*Runtimes/i, label);
      const selection = selectRuntimeVersion({defaultVersion:section.defaultVersion,
        fallback:managerDefaultVersion({listed,installed})});
      assert.ok(selection.version, label+' resolves without a game override');
    }
  }
});

test('Play discovers a known game-recommended version after consent and installs the same resolved version', async () => {
  const events = []; let discovered = false;
  const manager = { id:'known-runtime', label:'Known runtime', installRuntime() {},
    getState:()=>({catalog:{versions:discovered?['2.0']:[]}}),
    refreshCatalog:async()=>{events.push('discover');discovered=true;},
    resolveSelection:()=>({version:'2.0',ready:false,discoveryRequired:!discovered}) };
  const mod = {id:'known-module',runtimeManagers:[manager]};
  const {prepareForLaunch}=require('../src/core/runtime-preparation');
  assert.equal(await prepareForLaunch({entry:{},mod,info:{runtime:{manager:{runner:manager.id}}},
    context:{runtimeId:'runner',settings:{runtimes:{}},confirmRuntimeInstall:async()=>{events.push('consent');return true;}},
    registry:{listModuleIds:()=>[mod.id],getModule:()=>mod},runAction:()=>assert.fail('No action'),
    install:async(_manager,payload)=>{events.push('install:'+payload.version);} }),true);
  assert.deepEqual(events,['consent','discover','install:2.0']);
});

test('an empty catalog after consented discovery reports availability without forcing a choice', async () => {
  const events=[];
  const manager={id:'empty-runtime',label:'Empty runtime',installRuntime(){},getState:()=>({catalog:{versions:[]},installed:[]}),
    refreshCatalog:async()=>events.push('discover')};
  const mod={id:'empty-module',runtimeManagers:[manager]};
  const {prepareForLaunch}=require('../src/core/runtime-preparation');
  await assert.rejects(prepareForLaunch({entry:{},mod,info:{runtime:{manager:{runner:manager.id}}},
    context:{runtimeId:'runner',settings:{runtimes:{}},confirmRuntimeInstall:async()=>{events.push('consent');return true;}},
    registry:{listModuleIds:()=>[mod.id],getModule:()=>mod},runAction:()=>assert.fail('No action'),
    install:()=>assert.fail('No version exists')}),/No Empty runtime versions are available to download\./);
  assert.deepEqual(events,['consent','discover']);
});

test('first Java line installation saves the default and later installations retain saved preferences', () => {
  const manager=require('../src/modules/java/runtime/java-runtime-manager');
  const first=manager.updateSettingsAfterInstall({}, {version:'21.0.10+7',variant:'arm64',line:21},{sectionId:'21'});
  assert.equal(first.defaultLine,21);
  assert.equal(first.lines[21].defaultVersion,'21.0.10+7');
  assert.equal(first.lines[21].defaultVariant,'arm64');
  assert.equal(manager.updateSettingsAfterInstall(first,{version:'21.0.11+1',variant:'x64',line:21},{sectionId:'21'}),first);
  assert.deepEqual(manager.updateSettingsAfterInstall({},{version:'21.0.10+7',line:21},{sectionId:'21',preserveDefaults:true}),{});
});

test('first installs save defaults without replacing existing SDK, LÖVE, NW.js or Ruffle choices', () => {
  const sdk=require('../src/modules/renpy/runtime/sdk-runtime-manager');
  const sdkFirst=sdk.updateSettingsAfterInstall({}, {version:'8.6.1'}, {major:8});
  assert.equal(sdkFirst.v8.defaultVersion,'8.6.1');
  assert.equal(sdk.updateSettingsAfterInstall(sdkFirst,{version:'8.7.0'},{major:8}),sdkFirst);
  const love=require('../src/modules/love/runtime/love-runtime-manager');
  const loveFirst=love.updateSettingsAfterInstall({}, {version:'11.5'}, {sectionId:'stable'});
  assert.equal(loveFirst.stable.defaultVersion,'11.5');
  assert.equal(love.updateSettingsAfterInstall(loveFirst,{version:'11.6'},{sectionId:'stable'}).stable.defaultVersion,'11.5');
  const nwjs=require('../src/modules/shared/web/runtime/nwjs-manager');
  const nwFirst=nwjs.updateSettingsAfterInstall({}, {version:'0.117.0'});
  assert.equal(nwFirst.defaultVersion,'0.117.0');
  assert.equal(nwjs.updateSettingsAfterInstall(nwFirst,{version:'0.118.0'}),nwFirst);
  const ruffle=require('../src/modules/flash/runtime/ruffle-runtime-manager');
  const first=ruffle.updateSettingsAfterInstall({}, {version:'nightly-2026-10-28'});
  assert.equal(first.defaultVersion,'nightly-2026-10-28');
  assert.equal(ruffle.updateSettingsAfterInstall(first,{version:'nightly-2026-10-29'}),first);
});

test('catalog discovery still needs consent when the deferred package declares no download', async () => {
  const manager={id:'local-build',label:'Local build',installRuntime(){},getState:()=>({}),refreshCatalog:()=>assert.fail('Declined discovery stays offline')};
  const mod={id:'local-module',runtimeManagers:[manager],ensureRuntime:()=>({managerId:manager.id,version:null,discoveryRequired:true,requiresDownload:false})};
  const {prepareForLaunch}=require('../src/core/runtime-preparation');let approvals=0;
  const ready=await prepareForLaunch({entry:{},mod,info:{runtime:{}},context:{runtimeId:'runner',settings:{runtimes:{}},
    confirmRuntimeInstall:async()=>{approvals++;return false;}},registry:{listModuleIds:()=>[mod.id],getModule:()=>mod},
    runAction:()=>assert.fail('No action'),install:()=>assert.fail('No install')});
  assert.equal(ready,false);assert.equal(approvals,1);
});
