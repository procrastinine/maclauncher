const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Catalog = require("../src/modules/scummvm/runtime/catalog");
const { createManager } = require("../src/modules/scummvm/runtime/manager");
const { extractDmg } = require("../src/modules/scummvm/runtime/dmg");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scummvm-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function published(version, sha256 = "b".repeat(64)) {
  const filename = `scummvm-${version}-macosx.dmg`;
  return { version, upstreamRevision: "a".repeat(40), upstreamTag: "v" + version, minimumMacOS: "11.0",
    hostArchitectures: ["arm64", "x64"], localBuild: false, sourceUrl: `https://github.com/scummvm/scummvm/tree/v${version}`,
    asset: { filename, url: Catalog.SOURCE_URL + version + "/" + filename, sha256 } };
}
test("ScummVM parses stable universal-era versions and validates publisher checksums", () => {
  assert.deepEqual(Catalog.parseVersions('<a href="2.9.1/">x</a><a href="2026.4.0/">x</a><a href="2.4.0/">x</a><a href="2.9.1/">x</a><a href="2.9.0rc1/">x</a>'), ["2026.4.0", "2.9.1"]);
  assert.equal(Catalog.parseDigest("a".repeat(64), "runtime.dmg"), "a".repeat(64));
  assert.equal(Catalog.parseDigest("b".repeat(64) + " *runtime.dmg\n", "runtime.dmg"), "b".repeat(64));
  assert.throws(() => Catalog.parseDigest("b".repeat(64) + " *wrong.dmg", "runtime.dmg"), /invalid/);
  assert.throws(() => Catalog.parseDigest("not a checksum", "runtime.dmg"), /invalid/);
});
test("ScummVM release discovery fetches multiple versions, skips missing Mac assets, and preserves immutable identities", async () => {
  const calls = [], tags = ["2027.1.0", "2026.4.0", "2.9.1"].map((version, i) => ({ name: "v" + version, commit: { sha: String(i + 1).repeat(40) } }));
  const discover = Catalog.createDiscovery({ fetchTags: async () => tags, request: async url => {
    calls.push(url);
    if (url === Catalog.SOURCE_URL) return { status: 200, body: Buffer.from(tags.map(tag => `<a href="${tag.name.slice(1)}/">version</a>`).join("")) };
    if (url.includes("2027.1.0")) return { status: 404, body: Buffer.alloc(0) };
    return { status: 200, body: Buffer.from("a".repeat(64)) };
  } });
  const rows = await discover(); assert.equal(rows.length, 3); assert.equal(rows[0].asset, undefined);
  assert.match(rows[0].installReason, /not available/); assert.equal(rows[2].upstreamRevision, "3".repeat(40));
  assert.ok(rows[2].asset.url.endsWith("scummvm-2.9.1-macosx.dmg")); assert.equal(calls.length, 4);
});
test("ScummVM manager reads offline until explicit upstream refresh and retains cache on failure", async t => {
  const userDataDir = temporary(t), row = published("2.9.1");
  let calls = 0, fail = false;
  const manager = createManager({ discoverCatalog: async () => { calls++;if(fail)throw Error("network failure");return [row]; } });
  assert.equal(manager.getState({userDataDir}).catalog.status,"idle");
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version,Catalog.DEFAULT_VERSION);assert.equal(calls,0);
  await manager.refreshCatalog({userDataDir,force:true});
  const settings = {runtimes:{scummvm:{defaultVersion:row.version}}};
  assert.equal(manager.resolveSelection({},settings,userDataDir).version,row.version);
  assert.equal(manager.resolveSelection({runtimeData:{scummvm:{version:"2026.4.0"}}},settings,userDataDir).version,"2026.4.0");
  fail=true;await assert.rejects(manager.refreshCatalog({userDataDir,force:true}),/network failure/);
  assert.deepEqual(manager.getState({userDataDir}).catalog.versions,[row.version]);
  const restarted=createManager({discoverCatalog:()=>assert.fail("Cache reads stay offline")});
  assert.deepEqual(restarted.getState({userDataDir}).catalog.versions,[row.version]);
  assert.equal(restarted.resolveSelection({}, {}, userDataDir).version,Catalog.DEFAULT_VERSION,"The committed initial default remains until a user chooses another version");
});

test("ScummVM dmg extraction uses a read-only local mount and detaches after copy failures", async t => {
  const destination = temporary(t), calls = [];
  await assert.rejects(extractDmg(path.join(destination, "runtime.dmg"), destination, undefined, {
    run: async (_command, args) => { calls.push(args); if (args[0] === "attach") fs.mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], "ScummVM.app")); },
    copy: () => { throw new Error("copy failure"); }
  }), /copy failure/);
  assert.ok(calls[0].includes("-readonly")); assert.equal(calls[1][0], "detach");
  assert.equal(fs.existsSync(calls[1][1]), false);
  await assert.rejects(extractDmg(path.join(destination, "wrong.zip"), destination), /disk image/);
});
test("ScummVM dmg extraction detaches after an interrupted attach", async t => {
  const destination = temporary(t), calls = [], controller = new AbortController();
  const interrupted = Object.assign(new Error("attach interrupted"), { name: "AbortError" });
  await assert.rejects(extractDmg(path.join(destination, "runtime.dmg"), destination, controller.signal, {
    run: async (_command, args, options) => {
      calls.push(args);
      if (args[0] === "attach") {
        fs.mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], "ScummVM.app"));
        controller.abort(); throw interrupted;
      }
      assert.equal(options.signal, undefined);
    }, copy: () => assert.fail("Interrupted downloads must not copy a payload")
  }), interrupted);
  assert.equal(calls[1][0], "detach"); assert.equal(fs.existsSync(calls[1][1]), false);
});

test('ScummVM installs an actual read-only DMG, re-signs nested Sparkle without changing content, and verifies offline reuse', {skip:process.platform!=='darwin',timeout:120000}, async t => {
  const {execFileSync,execFile}=require('node:child_process'),{promisify}=require('node:util');
  const Native=require('../src/modules/shared/runtime/local-native'),Signing=require('../src/modules/scummvm/runtime/signing');
  const {unsignedMachO}=require('../scripts/app-inputs.cjs');
  const root=temporary(t),volume=path.join(root,'volume'),app=path.join(volume,'ScummVM.app'),version='2.9.1';
  const framework=path.join(app,'Contents/Frameworks/Sparkle.framework'),current=path.join(framework,'Versions/A');
  const helper=path.join(current,'Resources/Updater.app'),source=path.join(root,'fixture.c'),librarySource=path.join(root,'sparkle.c');
  const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:'pipe',timeout:60000});
  const plist=(directory,executable,id,packageType,release)=>{
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict>'+[
      ['CFBundleExecutable',executable],['CFBundleIdentifier',id],['CFBundlePackageType',packageType],
      ['CFBundleShortVersionString',release],['CFBundleVersion',release]].map(([key,value])=>`<key>${key}</key><string>${value}</string>`).join('')+'</dict></plist>');
  };
  fs.mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});
  fs.mkdirSync(path.join(helper,'Contents/MacOS'),{recursive:true});
  plist(path.join(app,'Contents'),'scummvm','org.scummvm.fixture','APPL',version);
  plist(path.join(helper,'Contents'),'Updater','org.scummvm.fixture.updater','APPL','1.0.0');
  plist(path.join(current,'Resources'),'Sparkle','org.scummvm.fixture.sparkle','FMWK','1.0.0');
  fs.mkdirSync(path.join(app,'Contents/Resources'),{recursive:true});
  fs.writeFileSync(path.join(app,'Contents/Resources/COPYRIGHT'),'Fixture license retained unchanged.\n');
  fs.mkdirSync(path.join(current,'Headers'),{recursive:true});fs.writeFileSync(path.join(current,'Headers/Sparkle.h'),'int fixture_sparkle(void);\n');
  fs.writeFileSync(source,'int main(void){return 0;}\n');fs.writeFileSync(librarySource,'int fixture_sparkle(void){return 1;}\n');
  const compile=['-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0'];
  run('/usr/bin/xcrun',['clang',...compile,source,'-o',path.join(app,'Contents/MacOS/scummvm')]);
  run('/usr/bin/xcrun',['clang',...compile,source,'-o',path.join(helper,'Contents/MacOS/Updater')]);
  run('/usr/bin/xcrun',['clang',...compile,'-dynamiclib',librarySource,'-Wl,-install_name,@rpath/Sparkle.framework/Versions/A/Sparkle','-o',path.join(current,'Sparkle')]);
  fs.symlinkSync('A',path.join(framework,'Versions/Current'));
  fs.symlinkSync('Versions/Current/Sparkle',path.join(framework,'Sparkle'));
  fs.symlinkSync('Versions/Current/Resources',path.join(framework,'Resources'));
  fs.symlinkSync('Versions/Current/Headers',path.join(framework,'Headers'));
  const sign=file=>run('/usr/bin/codesign',['--force','--sign','-','--options','runtime','--timestamp=none',file]);
  const nativePaths=['Contents/MacOS/scummvm','Contents/Frameworks/Sparkle.framework/Versions/A/Sparkle',
    'Contents/Frameworks/Sparkle.framework/Versions/A/Resources/Updater.app/Contents/MacOS/Updater'];
  sign(helper);sign(framework);sign(app);
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  const supplied=require('node:child_process').spawnSync('/usr/bin/codesign',['-d','--verbose=4',app],{encoding:'utf8'});
  assert.equal(supplied.status,0);assert.ok(Number.parseInt(/flags=0x([a-f0-9]+)/i.exec(supplied.stderr)[1],16)&0x10000);
  const before=Signing.inventory(app),code=new Map(nativePaths.map(name=>[name,unsignedMachO(fs.readFileSync(path.join(app,name)))]));
  await assert.rejects(Signing.prepareInstall({unpacked:volume,pin:{version:'0.0.0'}}),/does not match/);
  const dmg=path.join(root,'publisher-fixture.dmg');
  run('/usr/bin/hdiutil',['create','-srcfolder',volume,'-fs','HFS+','-format','UDZO','-volname','ScummVMFixture','-ov',dmg]);
  const archiveSha256=Native.hashFile(dmg),originalPrepare=Signing.prepareInstall,signCalls=[];
  let preparations=0;
  t.mock.method(Signing,'prepareInstall',options=>{preparations++;return originalPrepare(options,{run:async(command,args,runOptions)=>{
    if(args[0]==='--force')signCalls.push(args.at(-1));return promisify(execFile)(command,args,runOptions);
  }});});
  const pin={...published(version),
    asset:{filename:'scummvm-'+version+'-macosx.dmg',url:Catalog.SOURCE_URL+version+'/scummvm-'+version+'-macosx.dmg',sha256:archiveSha256,bytes:fs.statSync(dmg).size}};
  let downloads=0;const userDataDir=path.join(root,'profile');
  const manager=createManager({discoverCatalog:async()=>[pin],dependencies:{downloadToFile:async(url,target)=>{
    assert.equal(url,pin.asset.url);downloads++;fs.copyFileSync(dmg,target);
  }}});
  await manager.refreshCatalog({userDataDir,force:true});
  const installed=await manager.installRuntime({userDataDir,version});
  const installedApp=Signing.appRoot(installed.executablePath),metadata=installed.installationMetadata;
  assert.equal(installed.version,version);assert.equal(installed.archiveSha256,archiveSha256);
  assert.equal(metadata.signing.policy,Signing.POLICY);assert.equal(metadata.signing.hardenedRuntime,false);
  assert.deepEqual(new Set(metadata.architectures),new Set(['arm64','x86_64']));assert.equal(metadata.minimumMacOS,'13.0.0');
  for(const file of metadata.signing.nativeFiles){assert.equal(Number.parseInt(file.flags,16)&0x10000,0);assert.equal(Native.hashFile(path.join(installedApp,file.path)),file.sha256);}
  assert.ok(signCalls.findIndex(file=>file.endsWith('/Updater.app'))<signCalls.findIndex(file=>file.endsWith('/Sparkle.framework')));
  assert.ok(signCalls.findIndex(file=>file.endsWith('/Sparkle.framework'))<signCalls.findIndex(file=>file.endsWith('/ScummVM.app')));
  const after=Signing.inventory(installedApp);assert.equal(after.sha256,metadata.signedTreeSha256);
  assert.deepEqual(after.files.map(file=>file.path),before.files.map(file=>file.path));
  for(const file of before.files){
    const target=path.join(installedApp,file.path);
    if(file.link)assert.equal(fs.readlinkSync(target),file.link);
    else if(code.has(file.path))assert.equal(unsignedMachO(fs.readFileSync(target)),code.get(file.path),'Only embedded signature data changes');
    else if(!file.path.endsWith('/_CodeSignature/CodeResources'))assert.equal(Native.hashFile(target),file.sha256,file.path);
  }
  assert.equal(Signing.inventory(app).sha256,before.sha256);assert.equal(Native.hashFile(dmg),archiveSha256);
  const record=JSON.parse(fs.readFileSync(path.join(installed.installDir,'runtime.json')));
  assert.equal(record.binarySha256,Native.hashFile(installed.executablePath));assert.equal(record.installationMetadata.signedTreeSha256,after.sha256);
  const offline=createManager({discoverCatalog:()=>assert.fail('Offline selection must not refresh'),dependencies:{downloadToFile:()=>assert.fail('Verified installed copy must not download')}});
  const entry={runtimeData:{scummvm:{version}}};
  assert.equal(offline.resolveSelection(entry,{},userDataDir).ready,true);
  assert.equal(offline.resolveSelection({}, {}, userDataDir).version,version);
  await offline.installRuntime({userDataDir,version});assert.equal(downloads,1);
  offline.getState({userDataDir});let hashes=0;const originalHash=Native.hashFile;
  const mock=t.mock.method(Native,'hashFile',(...args)=>{hashes++;return originalHash(...args);});
  offline.getState({userDataDir});offline.getState({userDataDir});assert.equal(hashes,0,'Unchanged status uses identities instead of rehashing native files');
  assert.equal(offline.resolveSelection(entry,{},userDataDir).ready,true);assert.equal(hashes,0,'Warm selection does not repeat whole-tree hashes');mock.mock.restore();
  fs.appendFileSync(path.join(installedApp,'Contents/Resources/COPYRIGHT'),'changed');
  const damaged=offline.getState({userDataDir});
  assert.equal(damaged.installed.find(row=>row.version===version).ready,false);
  assert.equal(damaged.catalog.versionRequirements[version].available,false);
  assert.equal(offline.resolveSelection(entry,{},userDataDir).ready,false);
  assert.equal(Signing.inventory(app).sha256,before.sha256);assert.equal(Native.hashFile(dmg),archiveSha256);

  // Reproduce a pre-signing installation from the same verified publisher
  // image and its ordinary historical runtime.json, without a DMG cache.
  const legacyProfile=path.join(root,'legacy-profile');
  const legacy=createManager({discoverCatalog:async()=>[pin],dependencies:{downloadToFile:()=>assert.fail('Legacy preparation stays offline')}});
  await legacy.refreshCatalog({userDataDir:legacyProfile,force:true});
  const legacyDirectory=legacy.core.getInstallDir({userDataDir:legacyProfile,version});
  const legacyApp=path.join(legacyDirectory,'ScummVM.app'),legacyRecordPath=path.join(legacyDirectory,'runtime.json');
  fs.mkdirSync(legacyDirectory,{recursive:true});
  const legacyRecord={...record,binarySha256:Native.hashFile(path.join(app,'Contents/MacOS/scummvm')),
    installationMetadata:{appVersion:version,architectures:metadata.architectures}};
  const legacyRecordBytes=Buffer.from(JSON.stringify(legacyRecord,null,2)+'\n');
  function resetLegacy(){
    fs.rmSync(legacyApp,{recursive:true,force:true});
    fs.cpSync(app,legacyApp,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true});
    fs.writeFileSync(legacyRecordPath,legacyRecordBytes);legacy.core.clearDisplayCache(legacyProfile);
  }
  resetLegacy();
  const legacyTree=Signing.inventory(legacyApp).sha256;
  assert.equal(legacyTree,before.sha256);
  const selected=()=>legacy.resolveSelection(entry,{},legacyProfile);
  const unchanged=()=>{
    assert.equal(Signing.inventory(legacyApp).sha256,legacyTree);
    assert.deepEqual(fs.readFileSync(legacyRecordPath),legacyRecordBytes);
    assert.deepEqual(fs.readdirSync(legacyDirectory).sort(),['ScummVM.app','runtime.json']);
  };
  let readyEvents=0,mutationEntries=0,launches=0,injection=false;
  const moduleManager=require('../src/modules/scummvm/runtime/manager');
  t.mock.method(moduleManager,'resolveSelection',(...args)=>legacy.resolveSelection(...args));
  t.mock.method(moduleManager,'prepareForGraphics',(...args)=>legacy.prepareForGraphics(...args));
  const module=require('../src/modules/scummvm/main');
  const gameRoot=path.join(root,'game-data');fs.mkdirSync(gameRoot);
  const game={...entry,gameId:'scummvm-fixture',gamePath:gameRoot};
  const {withRuntimeMutation}=require('../src/core/coordinated-runtime-managers');
  const context={userDataDir:legacyProfile,settings:{},runtimeSettings:{},
    getGameEffectsEnvironment:async()=>injection?{DYLD_INSERT_LIBRARIES:'/fixture/graphics.dylib'}:{},
    withRuntimeMutation:(identity,operation)=>{
      assert.equal(identity.managerId,'scummvm');assert.equal(identity.version,version);assert.equal(identity.sourcePath,legacyDirectory);
      return withRuntimeMutation(identity,async()=>{mutationEntries++;return operation();},{userDataDir:legacyProfile});
    },
    onRuntimeStateChange:()=>readyEvents++,
    spawnDetachedChecked:async executable=>{
      assert.equal(executable,path.join(legacyApp,'Contents/MacOS/scummvm'));launches++;return {exitCode:0};
    }};
  const originalPreparations=preparations;
  assert.equal(legacy.getState({userDataDir:legacyProfile}).installed.find(row=>row.version===version).graphicsInjectionReady,false);
  assert.equal(selected().ready,true);assert.equal(module.ensureRuntime(game,context),null);
  await legacy.refreshCatalog({userDataDir:legacyProfile,force:true});
  await module.launchRuntime('scummvm',game,context);
  unchanged();assert.equal(preparations,originalPreparations);assert.equal(mutationEntries,0);

  // Damage is rejected against the original signature before any signer runs.
  fs.appendFileSync(path.join(legacyApp,'Contents/Resources/COPYRIGHT'),'damaged');
  injection=true;
  await assert.rejects(module.launchRuntime('scummvm',game,context),/codesign|invalid|modified|sealed/i);
  assert.equal(preparations,originalPreparations);assert.equal(launches,1);
  resetLegacy();
  const originalExecutable=path.join(legacyApp,'Contents/MacOS/scummvm');
  const repairOptions={pin,resolveInstalled:()=>legacy.core.resolveInstalled({userDataDir:legacyProfile,version})};
  await assert.rejects(Signing.repairLegacyInstallation(selected().install,{...repairOptions,
    prepare:async()=>{throw Error('fixture signer failed');}}),/fixture signer failed/);
  unchanged();
  const aborted=new AbortController();
  await assert.rejects(Signing.repairLegacyInstallation(selected().install,{...repairOptions,signal:aborted.signal,
    prepare:async options=>{const result=await originalPrepare(options);aborted.abort();return result;}}),/abort/i);
  unchanged();
  const originalInode=fs.statSync(originalExecutable).ino;
  await assert.rejects(Signing.repairLegacyInstallation(selected().install,{...repairOptions,
    prepare:originalPrepare,resolveInstalled:()=>null}),/installed record check/);
  unchanged();assert.equal(fs.statSync(originalExecutable).ino,originalInode,'Failed publication restores the original bundle');

  const fallbackContext={...context};delete fallbackContext.withRuntimeMutation;
  await Promise.all([module.launchRuntime('scummvm',game,fallbackContext),module.launchRuntime('scummvm',game,context)]);
  assert.equal(preparations,originalPreparations+1,'Concurrent graphics preparations share one runtime mutation owner');
  assert.equal(readyEvents,1);assert.equal(launches,3);
  const repaired=selected();assert.equal(repaired.ready,true);assert.equal(repaired.version,version);
  assert.equal(repaired.install.installationMetadata.signing.policy,Signing.POLICY);
  assert.equal(repaired.install.installationMetadata.publisherTreeSha256,legacyTree);
  assert.equal(repaired.install.archiveSha256,archiveSha256);
  assert.equal(repaired.install.binarySha256,Native.hashFile(originalExecutable));
  assert.equal(legacy.getState({userDataDir:legacyProfile}).installed.find(row=>row.version===version).graphicsInjectionReady,true);
  await module.launchRuntime('scummvm',game,context);
  assert.equal(preparations,originalPreparations+1,'Exact offline reuse does not repeat signing');
  assert.equal(Signing.inventory(app).sha256,before.sha256);assert.equal(Native.hashFile(dmg),archiveSha256);
  assert.equal(Signing.inventory(legacyApp).sha256,repaired.install.installationMetadata.signedTreeSha256);
  fs.appendFileSync(path.join(legacyApp,'Contents/Resources/COPYRIGHT'),'damaged after repair');
  assert.equal(selected().ready,false,'Repaired offline reuse still rejects damaged resources');
});
