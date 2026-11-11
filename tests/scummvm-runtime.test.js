// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const { denied } = require('./helpers/environment.cjs');
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Catalog = require("../src/modules/scummvm/runtime/catalog");
const { createManager } = require("../src/modules/scummvm/runtime/manager");
const { extractDmg } = require("../src/modules/shared/runtime/dmg");
const { stoppedDownloads, assertConsentedDiscovery, assertReceiptOffline } = require("./helpers/catalog-only-runtime.cjs");

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
// The publisher's folders as downloads.scummvm.org lists them, from catalog rows.
function serve(pins, base = Catalog.SOURCE_URL) {
  const routes = { [base]: pins.map(pin => `<a href="${pin.version}/">${pin.version}</a>`).join("") };
  for (const pin of pins) {
    const folder = `${base}${pin.version}/`;
    routes[folder] = `<a href="../">../</a><a href="${pin.asset.filename}">x</a><a href="${pin.asset.filename}.sha256">x</a>`;
    routes[`${folder}${pin.asset.filename}.sha256`] = `${pin.asset.sha256}  ${pin.asset.filename}\n`;
  }
  return routes;
}
const listings = () => Harness.network.requests.filter(url => url === Catalog.SOURCE_URL).length;
async function discover(routes) {
  Harness.network.routes = routes;
  try { return await Catalog.source.discover({}); } finally { Harness.network.routes = null; }
}
test("ScummVM parses every stable publisher version and reads publisher checksums", () => {
  assert.deepEqual(Catalog.parseVersions('<a href="2.9.1/">x</a><a href="/frs/scummvm/2026.4.0/">x</a><a href="2.4.0/">x</a><a href="2.9.1/">x</a><a href="2.9.0rc1/">x</a><a href="../">x</a>',
    Catalog.SOURCE_URL), ["2026.4.0", "2.9.1", "2.4.0"]);
  assert.equal(Catalog.parseDigest("a".repeat(64), "runtime.dmg"), "a".repeat(64));
  assert.equal(Catalog.parseDigest("b".repeat(64) + " *runtime.dmg\n", "runtime.dmg"), "b".repeat(64));
  assert.equal(Catalog.parseDigest("c".repeat(64) + "  other.dmg\n" + "b".repeat(64) + "  runtime.dmg\n", "runtime.dmg"), "b".repeat(64));
  assert.equal(Catalog.parseDigest("b".repeat(64) + " *wrong.dmg", "runtime.dmg"), null);
  assert.equal(Catalog.parseDigest("not a checksum", "runtime.dmg"), null);
});
test("ScummVM release discovery reads every version folder and lists a release without a Mac download with its reason", async () => {
  const before = Harness.network.requests.length, routes = serve([published("2027.1.0"), published("2026.4.0"), published("2.9.1", "c".repeat(64))]);
  routes[`${Catalog.SOURCE_URL}2027.1.0/`] = '<a href="scummvm-2027.1.0-win32-x86_64.zip">x</a>';
  const rows = await discover(routes);
  assert.deepEqual(rows.map(row => row.version), ["2027.1.0", "2026.4.0", "2.9.1"]);
  assert.deepEqual(rows[0].files, []); assert.match(rows[0].installReason, /no macOS download/);
  assert.equal(rows[2].files[0].url, `${Catalog.SOURCE_URL}2.9.1/scummvm-2.9.1-macosx.dmg`); assert.equal(rows[2].files[0].digest.value, "c".repeat(64));
  assert.equal(rows[2].sourceUrl, `${Catalog.SOURCE_URL}2.9.1/`);
  assert.equal(Harness.network.requests.length - before, 6, "One listing per folder and one checksum per Mac download");
});
test("ScummVM follows a renamed Mac download with its published checksum through the release folder", async () => {
  const folder = Catalog.SOURCE_URL + "2027.1.0/";
  const names = ["scummvm-2027.1.0-macos-universal.zip", "scummvm-2027.1.0-macos-universal.zip.sha256", "scummvm-2027.1.0-win32-x86_64.zip",
    "scummvm-2027.1.0-win32-x86_64.zip.sha256", "scummvm-2027.1.0-macos-arm64.tar.xz"];
  const rows = await discover({ [Catalog.SOURCE_URL]: '<a href="2027.1.0/">2027.1.0</a>', [folder]: names.map(name => `<a href="${name}">${name}</a>`).join(""),
    [folder + names[1]]: "c".repeat(64) + "  " + names[0] });
  assert.deepEqual(rows.map(row => [row.files[0].name, row.files[0].digest?.value, row.architecture]),
    [[names[0], "c".repeat(64), "universal"], [names[4], undefined, "arm64"]], "A download without a published checksum records its own; other systems are left out");
});
test("ScummVM manager reads offline until explicit upstream refresh and retains cache on failure", async t => {
  const userDataDir = temporary(t), row = published("2.9.1"), start = listings();
  let fail = false;
  const routes = serve([row]), listing = routes[Catalog.SOURCE_URL];
  routes[Catalog.SOURCE_URL] = () => fail ? { status: 500, headers: {}, body: Buffer.from("unavailable") } : listing;
  Harness.network.routes = routes;
  t.after(() => { Harness.network.routes = null; });
  const manager = createManager();
  assert.equal(manager.getState({userDataDir}).catalog.status,"idle");
  assert.equal(manager.resolveSelection({}, {}, userDataDir).discoveryRequired,true);assert.equal(listings(),start);
  await manager.refreshCatalog({userDataDir,force:true});
  const settings = {runtimes:{scummvm:{defaultVersion:row.version}}};
  assert.equal(manager.resolveSelection({},settings,userDataDir).version,row.version);
  assert.equal(manager.resolveSelection({runtimeData:{scummvm:{version:"2026.4.0"}}},settings,userDataDir).version,"2026.4.0");
  fail=true;await assert.rejects(manager.refreshCatalog({userDataDir,force:true}));
  assert.deepEqual(manager.getState({userDataDir}).catalog.versions,[row.version]);
  const restarted=createManager(), count = listings();
  assert.deepEqual(restarted.getState({userDataDir}).catalog.versions,[row.version]);
  assert.equal(restarted.resolveSelection({}, {}, userDataDir).version,row.version,"The cached catalog supplies the default offline");
  assert.equal(listings(), count, "Cache reads stay offline");
});
test("ScummVM discovers inside a consented install and keeps earlier installations offline", { skip: process.platform !== "darwin" }, async t => {
  const downloads = stoppedDownloads(), start = listings();
  const manager = createManager({ dependencies: { downloadToFile: downloads.downloadToFile } });
  Harness.network.routes = serve([published("2026.4.0"), published("2027.1.0")]);
  t.after(() => { Harness.network.routes = null; });
  await assertConsentedDiscovery({ manager, userDataDir: temporary(t), discoveries: () => listings() - start, downloads, newestUrl: published("2027.1.0").asset.url });
  Harness.network.routes = null;
  assertReceiptOffline({ manager: createManager(), userDataDir: temporary(t),
    pin: { ...published("2026.4.0", "5614527fa57ffce14773c69923b96eeb7b1b135bcd96bfe74640ca341cad4598"), upstreamRevision: "7d2709da5136866589f7602f5f5a7b17de03420e" } });
});

test("ScummVM dmg extraction uses a read-only local mount and detaches after copy failures", async t => {
  const destination = temporary(t), calls = [];
  await assert.rejects(extractDmg(path.join(destination, "runtime.dmg"), destination, undefined, { payloadName: "ScummVM.app",
    run: async (_command, args) => { calls.push(args); if (args.includes("attach")) fs.mkdirSync(path.join(args[args.indexOf("--mountPoint") + 1], "ScummVM.app")); },
    copy: () => { throw new Error("copy failure"); }
  }), /copy failure/);
  assert.ok(calls[0].includes("--readOnly")); assert.equal(calls[1][0], "eject");
  assert.equal(fs.existsSync(calls[1][1]), false);
  // A macOS without `diskutil image` attaches and detaches with hdiutil.
  const fallback = [];
  await assert.rejects(extractDmg(path.join(destination, "runtime.dmg"), destination, undefined, { payloadName: "ScummVM.app",
    run: async (command, args) => {
      fallback.push([path.basename(command), ...args]);
      if (command.endsWith("diskutil") && args[0] === "image") throw new Error('diskutil: did not recognize verb "image"');
      if (args[0] === "attach") fs.mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], "ScummVM.app"));
    },
    copy: () => { throw new Error("copy failure"); }
  }), /copy failure/);
  assert.deepEqual(fallback.map(call => call.slice(0, 2)), [["diskutil", "image"], ["hdiutil", "attach"], ["hdiutil", "detach"]]);
  assert.ok(fallback[1].includes("-readonly"));
  await assert.rejects(extractDmg(path.join(destination, "wrong.zip"), destination), /disk image/);
});
test("ScummVM installs its app from another archive format with the app moved into a folder", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), app = path.join(root, "package", "ScummVM 2027.1.0", "ScummVM.app", "Contents");
  fs.mkdirSync(app, { recursive: true }); fs.writeFileSync(path.join(app, "Info.plist"), "plist");
  fs.writeFileSync(path.join(root, "package", "README.txt"), "notes");
  const archive = path.join(root, "scummvm-2027.1.0-macos-universal.zip"), destination = path.join(root, "unpacked");
  require("node:child_process").execFileSync("/usr/bin/ditto", ["-c", "-k", path.join(root, "package"), archive]);
  fs.mkdirSync(destination);
  await require("../src/modules/shared/runtime/release-files").extractPayload(archive, destination, undefined, { payloadName: "ScummVM.app", project: "ScummVM" });
  assert.deepEqual(fs.readdirSync(destination), ["ScummVM.app"]);
  assert.equal(fs.readFileSync(path.join(destination, "ScummVM.app", "Contents", "Info.plist"), "utf8"), "plist");
  assert.equal(fs.readdirSync(root).some(name => name.startsWith(".extract-")), false);
});
test("ScummVM dmg extraction detaches after an interrupted attach", async t => {
  const destination = temporary(t), calls = [], controller = new AbortController();
  const interrupted = Object.assign(new Error("attach interrupted"), { name: "AbortError" });
  await assert.rejects(extractDmg(path.join(destination, "runtime.dmg"), destination, controller.signal, { payloadName: "ScummVM.app",
    run: async (_command, args, options) => {
      calls.push(args);
      if (args.includes("attach")) {
        fs.mkdirSync(path.join(args[args.indexOf("--mountPoint") + 1], "ScummVM.app"));
        controller.abort(); throw interrupted;
      }
      assert.equal(options.signal, undefined);
    }, copy: () => assert.fail("Interrupted downloads must not copy a payload")
  }), interrupted);
  assert.equal(calls[1][0], "eject"); assert.equal(fs.existsSync(calls[1][1]), false);
});

test('ScummVM installs an actual read-only DMG, re-signs nested Sparkle without changing content, and verifies offline reuse', {skip:process.platform==='darwin'?denied('diskImage'):'Requires macOS',timeout:120000}, async t => {
  const {execFileSync,execFile}=require('node:child_process'),{promisify}=require('node:util');
  const Native=require('../src/modules/shared/runtime/local-native'),Signing=require('../src/modules/scummvm/runtime/signing');
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
  const before=Signing.inventory(app);
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
  Harness.network.routes=serve([pin]);t.after(()=>{Harness.network.routes=null;});
  const manager=createManager({dependencies:{downloadToFile:async(url,target)=>{
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
    else if(!nativePaths.includes(file.path)&&!file.path.endsWith('/_CodeSignature/CodeResources'))assert.equal(Native.hashFile(target),file.sha256,file.path);
  }
  assert.equal(Signing.inventory(app).sha256,before.sha256);assert.equal(Native.hashFile(dmg),archiveSha256);
  const record=JSON.parse(fs.readFileSync(path.join(installed.installDir,'runtime.json')));
  assert.equal(record.binarySha256,Native.hashFile(installed.executablePath));assert.equal(record.installationMetadata.signedTreeSha256,after.sha256);
  const offline=createManager({dependencies:{downloadToFile:()=>assert.fail('Verified installed copy must not download')}});
  const entry={runtimeData:{scummvm:{version}}};
  assert.equal(offline.resolveSelection(entry,{},userDataDir).ready,true);
  assert.equal(offline.resolveSelection({}, {}, userDataDir).version,version);
  await offline.installRuntime({userDataDir,version});assert.equal(downloads,1);
  offline.getState({userDataDir});let hashes=0;const originalHash=Native.hashFile;
  const mock=t.mock.method(Native,'hashFile',(...args)=>{hashes++;return originalHash(...args);});
  offline.getState({userDataDir});offline.getState({userDataDir});assert.equal(hashes,0,'Unchanged status uses identities instead of rehashing native files');
  assert.equal(offline.resolveSelection(entry,{},userDataDir).ready,true);assert.equal(hashes,0,'Warm selection does not repeat whole-tree hashes');mock.mock.restore();
  // The inspector's worker keeps the verified application and its native
  // images until the runtime inventory changes.
  const Revision=require('../src/core/runtime-inventory-revision');
  Revision.activate({retainReads:true});t.after(()=>Revision.activate({retainReads:false}));
  const requirements=()=>Signing.launchRequirements(offline.resolveSelection(entry,{},userDataDir).install);
  offline.getState({userDataDir});const expected=requirements();
  let walks=0;const readdir=fs.readdirSync;
  const walking=t.mock.method(fs,'readdirSync',function(target,...args){if(String(target).startsWith(installedApp))walks++;return readdir.call(this,target,...args);});
  offline.getState({userDataDir});assert.deepEqual(requirements(),expected);assert.deepEqual(requirements(),expected);
  assert.equal(walks,0,'The inspector worker does not walk a verified application again');walking.mock.restore();
  Revision.advance();
  fs.appendFileSync(path.join(installedApp,'Contents/Resources/COPYRIGHT'),'changed');
  const damaged=offline.getState({userDataDir});
  assert.equal(damaged.installed.find(row=>row.version===version).ready,false);
  assert.equal(damaged.catalog.versionRequirements[version].available,false);
  assert.equal(offline.resolveSelection(entry,{},userDataDir).ready,false);
  Revision.activate({retainReads:false});
  assert.equal(Signing.inventory(app).sha256,before.sha256);assert.equal(Native.hashFile(dmg),archiveSha256);

  // Reproduce a pre-signing installation from the same verified publisher
  // image and its ordinary historical runtime.json, without a DMG cache.
  const legacyProfile=path.join(root,'legacy-profile');
  const legacy=createManager({dependencies:{downloadToFile:()=>assert.fail('Legacy preparation stays offline')}});
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
