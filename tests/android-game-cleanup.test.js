const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Module=require('../src/modules/android/main'),Catalog=require('../src/modules/android/service-packages');
const Cleanup=require('../src/core/storage-maintenance');
function put(file,bytes='owned'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;}
function fixture(t){
  const userDataDir=fs.mkdtempSync(path.join(os.tmpdir(),'android-game-cleanup-'));
  t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
  const gameId='removed-game',otherId='retained-game',provider='example.provider',retired='example.retired',application='example.game';
  const identities={[provider]:10000,[retired]:10001,[application]:10002},record={packageName:application,gameId,scope:'application',
    preparedKey:'a'.repeat(64),sourceNames:['base.apk'],nativeDirectory:'input/lib/arm64-v8a',processName:application,enabled:true,firstInstallTime:1,lastUpdateTime:1};
  put(path.join(userDataDir,'android/services/catalog.json'),JSON.stringify({schemaVersion:1,nextUid:10003,identities,packages:[record]}));
  const apps=path.join(userDataDir,'android/apps'),roots=[provider,retired].map(name=>path.join(apps,Catalog.dataId(name,gameId)));
  for(const root of roots)put(path.join(root,'data/files/provider-save'));
  const retained=[put(path.join(apps,otherId,'data/files/game-save'),'other game'),
    put(path.join(apps,Catalog.dataId(provider,otherId),'data/files/provider-save'),'other provider'),
    put(path.join(apps,Catalog.codeId(provider),'prepared/shared-code'),'shared APK'),
    put(path.join(apps,Catalog.dataId(provider,gameId)+'-unknown','keep'),'not exact'),
    put(path.join(userDataDir,'original-saves/keep'),'original'),
    put(path.join(userDataDir,'android/.test-preloads/keep'),'diagnostic')];
  const own=put(path.join(apps,gameId,'data/files/save'),'removed game');
  const retiredPackages=[];
  t.mock.method(require('../src/modules/android/account-owner'),'removePackages',async(_context,packages)=>retiredPackages.push(...packages));
  return{userDataDir,gameId,apps,roots,retained,own,retiredPackages,entry:{gameId},context:{userDataDir}};
}

test('Android game cleanup removes only exact caller provider roots, including previously removed providers, without scanning apps',async t=>{
  const f=fixture(t),readdir=fs.readdirSync.bind(fs);
  t.mock.method(fs,'readdirSync',(...args)=>{assert.notEqual(path.resolve(String(args[0])),f.apps,'Explicit cleanup must not enumerate all Android apps');return readdir(...args);});
  assert.equal(await Module.cleanupGameData(f.entry,f.context),true);
  for(const root of f.roots)assert.equal(fs.existsSync(root),false);
  assert.equal(fs.existsSync(f.own),false);
  for(const file of f.retained)assert.equal(fs.existsSync(file),true);
  assert.deepEqual(f.retiredPackages,['example.game']);
  const catalog=Catalog.read(f.userDataDir);assert.deepEqual(catalog.packages,[]);
  assert.equal(catalog.identities['example.provider'],10000,'Shared package/UID identity stays available');
  assert.equal(await Module.cleanupGameData(f.entry,f.context),true,'Repeated removal is safe');
});

test('Interrupted Android provider deletion leaves guarded trash for quiet upkeep and retains retryable game data',async t=>{
  const f=fixture(t),remove=Cleanup.removeTrash;
  const failure=Object.assign(Error('interrupted guarded deletion'),{code:'EIO'});
  t.mock.method(Cleanup,'removeTrash',async()=>{throw failure;});
  await assert.rejects(Module.cleanupGameData(f.entry,f.context),failure);
  assert.equal(fs.existsSync(f.own),true);assert.equal(Catalog.read(f.userDataDir).packages.length,1);
  const trash=fs.readdirSync(f.apps).filter(name=>Cleanup.TRASH.test(name));assert.equal(trash.length,1);
  Cleanup.removeTrash=remove;
  await Module.cleanupGameData(f.entry,f.context);
  const store=require('../src/modules/android/derived-stores').find(item=>item.id==='android-service-data-trash');
  assert.equal(store.match.test(path.basename(f.roots[0])),false,'Upkeep never selects normal provider data');
  const busy=await Cleanup.maintainStorage({userDataDir:f.userDataDir,stores:[store],running:{other:true}});
  assert.equal(busy.skipped,'running');assert.equal(fs.existsSync(path.join(f.apps,trash[0])),true);
  const completed=await Cleanup.maintainStorage({userDataDir:f.userDataDir,stores:[store]});
  assert.deepEqual(completed.errors,[]);assert.equal(fs.existsSync(path.join(f.apps,trash[0])),false);
  for(const file of f.retained)assert.equal(fs.existsSync(file),true);
});

test('Android caller cleanup refuses a replaced provider-root alias and preserves its external target',async t=>{
  const f=fixture(t),outside=path.join(f.userDataDir,'unrelated'),target=put(path.join(outside,'keep'),'external bytes');
  fs.rmSync(f.roots[0],{recursive:true});fs.symlinkSync(outside,f.roots[0]);
  await assert.rejects(Module.cleanupGameData(f.entry,f.context),/alias|link|regular directory/i);
  assert.equal(fs.readFileSync(target,'utf8'),'external bytes');assert.equal(fs.existsSync(f.own),true);
  assert.equal(Catalog.read(f.userDataDir).packages.length,1);
});
