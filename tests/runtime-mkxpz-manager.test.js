const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/rgss/runtime/mkxpz-manager");
const Bundles = require("../src/modules/shared/runtime/bundled-native");
const Binary = {version:"2026-01-01T00-00-00Z_"+"a".repeat(40),appName:"PublisherFixture.app",
  executableRelative:"PublisherFixture.app/Contents/MacOS/bundle_mkxp-z",upstreamRevision:"a".repeat(40),
  executableSha256:"b".repeat(64),treeSha256:"c".repeat(64),sourceUrl:"https://github.com/mkxp-z/mkxp-z",retained:[]};
const Builds = require("../src/modules/rgss/runtime/mkxpz-builds");
const Owned = require("../src/modules/rgss/runtime/mkxpz-owned-builds");
const ADAPTED_VERSION = "2.0.0-fixture";
const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("MKXP-Z keeps exact global/game choices", t => {
  const adapted={version:ADAPTED_VERSION,appPath:"/installed/Adapted.app"},publisher={version:Binary.version,appPath:"/installed/Publisher.app"};
  t.mock.method(Manager.core,"listInstalled",()=>[adapted,publisher]);
  t.mock.method(Manager.core,"resolveOwnedRuntime",({version})=>[adapted,publisher].find(row=>row.version===version)||null);
  const settings={runtimes:{mkxpz:{defaultVersion:Binary.version}}};
  assert.equal(Manager.resolveSelection({},settings,"/unused").install,publisher);
  assert.equal(Manager.resolveSelection({runtimeData:{mkxpz:{version:ADAPTED_VERSION}}},settings,"/unused").install,adapted);
  const missing=Manager.resolveSelection({runtimeData:{mkxpz:{version:"missing"}}},settings,"/unused");
  assert.equal(missing.ready,false);assert.equal(missing.version,"missing");
});

test("MKXP-Z defaults prefer listed releases and fall back to ready installed versions", t => {
  const userDataDir=makeTempDir("maclauncher-mkxpz-default-");t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
  const older={version:"1.0.0",appPath:"/installed/Older.app",ready:true},newer={version:"2.0.0",appPath:"/installed/Newer.app",ready:true};
  let listed=[], installed=[older,{version:"3.0.0",ready:false,status:"damaged",error:"damaged"},newer];
  t.mock.method(Builds.manager,"getState",()=>({catalog:{versions:listed,versionRequirements:{}}}));
  t.mock.method(Manager.core,"listInstalled",()=>installed);
  t.mock.method(Manager.core,"resolveOwnedRuntime",({version})=>installed.find(row=>row.version===version&&row.ready)||null);
  for(const settings of [{},{defaultVersion:null},{defaultVersion:"auto"}]) {
    const state=Manager.getState({userDataDir,settings});assert.equal(state.defaultVersion,newer.version);assert.equal(state.defaultSource,"manager");
    assert.equal(Manager.resolveSelection({}, {runtimes:{mkxpz:settings}}, userDataDir).install,newer);
  }
  listed=["4.0.0"];
  assert.equal(Manager.resolveSelection({}, {}, userDataDir).version,"4.0.0");
  assert.equal(Manager.resolveSelection({}, {}, userDataDir).ready,false);
  assert.equal(Manager.getState({userDataDir,settings:{defaultVersion:older.version}}).defaultSource,"saved");
  assert.equal(Manager.resolveSelection({}, {runtimes:{mkxpz:{defaultVersion:older.version}}},userDataDir).install,older);
  assert.equal(Manager.resolveSelection({runtimeData:{mkxpz:{version:newer.version}}},{},userDataDir).install,newer);
});

test("owned NFC builds bind the full source adaptation and executable without claiming publisher bytes", () => {
  const source = require("../src/modules/rgss/overlays/mkxpz-filename-nfc/source.json");
  const pin = { version: "owned-nfc-fixture", sourceKind: "owned-source-adaptation", adaptationId: source.id,
    patchSha256: source.patch.sha256, headerSha256: source.addedFiles[0].sha256, implementationSha256: source.addedFiles[1].sha256,
    upstreamRevision: source.upstream.revision, executableRelative: "mkxp-z.aarch64.app/Contents/MacOS/bundle_mkxp-z",
    arch: "arm64", minimumMacOS: "11.0", executableSha256: "a".repeat(64) };
  const manifest = { version: pin.version, arch: pin.arch, minimumMacOS: pin.minimumMacOS,
    upstreamRevision: pin.upstreamRevision, executableRelative: pin.executableRelative,
    files: [{ path: pin.executableRelative, sha256: pin.executableSha256 }], provenance: {
      sourceKind: pin.sourceKind, verifiedBuild: true, sourceRevision: pin.upstreamRevision,
      adaptationId: source.id, patchSha256: source.patch.sha256,
      headerSha256: source.addedFiles[0].sha256, implementationSha256: source.addedFiles[1].sha256 } };
  assert.equal(Owned.validate(manifest, pin), manifest);
  for (const [key, value] of [["sourceKind", "publisher-binary"], ["verifiedBuild", false],
    ["implementationSha256", "b".repeat(64)], ["patchSha256", "b".repeat(64)]]) {
    const changed = structuredClone(manifest); changed.provenance[key] = value;
    assert.throws(() => Owned.validate(changed, pin), /source adaptation/);
  }
  const changed = structuredClone(manifest); changed.files[0].sha256 = "b".repeat(64);
  assert.throws(() => Owned.validate(changed, pin), /source adaptation/);
  assert.throws(() => Owned.validate(manifest, { ...pin, version: "other" }), /source adaptation/);
});

function createInstall(userDataDir, version) {
  const installDir = path.join(userDataDir, "runtimes", "mkxpz", version);
  const appDir = path.join(installDir, "Z-universal.app");
  fs.mkdirSync(appDir, { recursive: true });
  return { installDir, appDir };
}

function createBundledFixture(t, pin = Binary) {
  const resourceRoot = makeTempDir("maclauncher-mkxpz-resources-");
  t.after(() => fs.rmSync(resourceRoot, { recursive: true, force: true }));
  const directory = path.join(resourceRoot, "mkxpz", pin.version, "arm64");
  const payload = path.join(directory, "files"), executableRelative = pin.executableRelative || pin.appName + "/Contents/MacOS/Z-universal";
  fs.mkdirSync(path.dirname(path.join(payload, executableRelative)), { recursive: true });
  fs.mkdirSync(path.join(payload, "licenses"));
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, executableRelative), executable, { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "licenses", "LICENSE"), "License", { mode: 0o644 });
  const manifest = { schemaVersion: 1, managerId: "mkxpz", version: pin.version, upstreamRevision: pin.upstreamRevision,
    platform: "darwin", arch: "arm64", minimumMacOS: "11.0", executableRelative,
    provenance: { sourceRevision: pin.upstreamRevision, sourceKind: "reviewed-binary", verifiedBuild: false },
    notices: [{ name: "MKXP-Z", license: "GPL-2.0", sourceUrl: pin.sourceUrl, path: "licenses/LICENSE" }], dependencies: [],
    files: [{ path: executableRelative, size: executable.length, sha256: Bundles.digest(executable), mode: 0o755, architectures: ["arm64"] },
      { path: "licenses/LICENSE", size: 7, sha256: Bundles.digest(Buffer.from("License")), mode: 0o644 }] };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { resourceRoot, payload, directory };
}

function createHostedFixture(t, mutateManifest) {
  const root=makeTempDir('mkxpz-public-baseline-'),userDataDir=path.join(root,'empty-data'),directory=path.join(root,'package');
  fs.mkdirSync(userDataDir);fs.mkdirSync(directory);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // An existing signed macOS executable tests the real shared Mach-O/signature
  // verifier; this fixture is not a publisher artifact or a clean-Mac run.
  const executable=Binary.executableRelative || Binary.appName+'/Contents/MacOS/Z-universal';
  const files=[[executable,fs.readFileSync('/usr/bin/true'),0o755],['licenses/LICENSE',Buffer.from('fixture license'),0o644]];
  for(const[name,bytes,mode]of files){fs.mkdirSync(path.dirname(path.join(directory,name)),{recursive:true});fs.writeFileSync(path.join(directory,name),bytes,{mode});}
  const plist=Binary.appName+'/Contents/Info.plist';
  fs.writeFileSync(path.join(directory,plist),'<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.maclauncher.mkxpz.fixture</string><key>CFBundleExecutable</key><string>'+path.basename(executable)+'</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  // Only this temporary fixture is signed; publisher inputs remain read-only.
  require('node:child_process').execFileSync('/usr/bin/codesign',['--force','--sign','-',path.join(directory,Binary.appName)],{stdio:'pipe'});
  files[0][1]=fs.readFileSync(path.join(directory,executable));
  for(const name of[plist,Binary.appName+'/Contents/_CodeSignature/CodeResources'])files.push([name,fs.readFileSync(path.join(directory,name)),0o644]);
  const architectures=require('../src/modules/shared/runtime/local-native').readMachOArchitectures('/usr/bin/true');
  const manifest={schemaVersion:1,managerId:'mkxpz',version:Binary.version,upstreamRevision:Binary.upstreamRevision,platform:'darwin',arch:'universal',minimumMacOS:'11.0',executableRelative:executable,
    provenance:{sourceRevision:Binary.upstreamRevision,sourceKind:'reviewed-binary',verifiedBuild:false,inputExecutableSha256:Binary.executableSha256,inputArtifactTreeSha256:Binary.treeSha256},
    dependencies:[],notices:[{name:'MKXP-Z',license:'GPL-3.0',sourceUrl:Binary.sourceUrl,path:'licenses/LICENSE'}],
    files:files.map(([name,bytes,mode])=>({path:name,size:bytes.length,mode,sha256:Bundles.digest(bytes),...(name===executable?{architectures}:{} )}))};
  fs.mkdirSync(path.join(directory,'files'));
  for (const name of fs.readdirSync(directory).filter(name=>name!=='files')) fs.renameSync(path.join(directory,name),path.join(directory,'files',name));
  mutateManifest?.(manifest);const serialized=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'manifest.json'),serialized);
  const archive=Buffer.from('exact fixture public archive'),repository='procrastinine/maclauncher-builds',tag='mkxpz/v'+Binary.version+'/universal',filename='mkxpz-'+Binary.version+'-universal.tar.gz';
  const record={schemaVersion:2,id:'mkxpz',version:Binary.version,arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:'11.0',manifestRelative:'manifest.json',manifestSha256:Bundles.digest(serialized),sourceSha256:Bundles.digest(serialized),updatePolicy:'manual',tag,
    asset:{filename,bytes:archive.length,sha256:Bundles.digest(archive),url:'https://github.com/'+repository+'/releases/download/'+encodeURIComponent(tag)+'/'+filename}};
  const wrapper={...record,sourceRelative:'manifest.json',files:[...manifest.files.map(file=>({...file,path:'files/'+file.path})),{path:'manifest.json',size:serialized.length,mode:0o644,sha256:Bundles.digest(serialized)}]};
  const calls={catalog:0,downloads:0},control={};
  const manager=Builds.createManager({systemVersionSync:()=> '26.0',fetchUrlBuffer:async url=>{assert.equal(url,'https://raw.githubusercontent.com/'+repository+'/main/catalogs/mkxpz.json');calls.catalog++;return {status:200,body:Buffer.from(JSON.stringify({schemaVersion:2,projectId:'mkxpz',updatePolicy:'manual',packages:[record]}))};},
    downloadToFile:async(url,destination,{signal,onProgress})=>{assert.equal(url,record.asset.url);calls.downloads++;onProgress?.({downloaded:archive.length,total:archive.length});await control.download?.(signal);signal?.throwIfAborted();fs.writeFileSync(destination,archive);},
    extractArchive:async(_archive,destination)=>{fs.writeFileSync(path.join(destination,'runtime-package.json'),JSON.stringify(wrapper));fs.cpSync(directory,path.join(destination,'files'),{recursive:true});}});
  const previous=Builds.manager;Builds.manager=manager;t.after(()=>{Builds.manager=previous;});
  t.mock.method(Manager.core,'canUseGh',()=>assert.fail('A public baseline must not invoke gh or require authentication'));
  return {root,userDataDir,manager,calls,control,record,executable};
}

test("normalizeSettings preserves exact choices and the committed MKXP-Z initial default", () => {
  assert.equal(Manager.distributionRequired, false);
  assert.equal(Manager.delivery.included, "none");
  const normalized = Manager.normalizeSettings({
    defaultVersion: " 2026-01-12T18-22-32Z_794d1897abe529a23f3f2f9c4f72d711a3b18391 "
  });
  assert.equal(
    normalized.defaultVersion,
    "2026-01-12T18-22-32Z_794d1897abe529a23f3f2f9c4f72d711a3b18391"
  );

  const fallback = Manager.normalizeSettings({});
  assert.equal(fallback.defaultVersion, null);
  assert.equal(Manager.normalizeSettings({defaultVersion:" auto "}).defaultVersion,null);
});

test("MKXP-Z explicit global choice updates without mutating previous settings", () => {
  const settings = { defaultVersion: "old" };
  const next = Manager.applySettingsUpdate("setDefault", { version: "new" }, settings);
  assert.deepEqual(next, {defaultVersion:"new"});
  assert.deepEqual(settings,{defaultVersion:"old"});

  const unchanged = Manager.applySettingsUpdate("noop", {}, settings);
  assert.deepEqual(unchanged, settings);
});

test("listInstalled finds MKXP-Z app bundles", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    const { installDir } = createInstall(userDataDir, "2026-01-11T18-22-32Z_deadbeef");
    fs.writeFileSync(
      path.join(installDir, ".maclauncher-mkxpz.json"),
      JSON.stringify({ source: "Bundled" }, null, 2)
    );
    const installed = Manager.core.listInstalled(userDataDir);
    const match = installed.find(entry => entry.version === "2026-01-11T18-22-32Z_deadbeef");
    assert.ok(match);
    assert.equal(match.source, "Bundled");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("app resources never appear installed while existing exact writable copies remain usable", t => {
  for (const pin of [Binary, ...Binary.retained]) {
    const fixture = createBundledFixture(t, pin), data = makeTempDir("mkxpz-managed-only-");
    t.after(() => fs.rmSync(data, { recursive: true, force: true }));
    assert.deepEqual(Manager.core.listInstalled(data, { resourceRoot: fixture.resourceRoot, arch: "arm64" }), []);
    const copy = createInstall(data, pin.version);
    const installed = Manager.core.listInstalled(data);
    assert.equal(installed.length, 1); assert.equal(installed[0].installDir, copy.installDir);
    assert.equal(installed[0].version, pin.version);
    assert.equal(installed[0].included, undefined);
    assert.ok(fs.existsSync(fixture.payload));
  }
});

test("MKXP-Z first installation persists its default while preserving saved choices", () => {
  const settings = { defaultVersion: "2026-01-10T18-22-32Z_old" };
  const next = Manager.updateSettingsAfterInstall(settings, {
    version: "2026-01-12T18-22-32Z_new"
  });
  assert.equal(next, settings);
  assert.deepEqual(Manager.updateSettingsAfterInstall({}, {version:"new"}), {defaultVersion:"new"});
  assert.deepEqual(Manager.updateSettingsAfterInstall({defaultVersion:null}, {version:"new"}), {defaultVersion:"new"});
});

test("MKXP-Z removal does not persist a global version", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    createInstall(userDataDir, "2027-01-11T18-22-32Z_deadbeef");
    createInstall(userDataDir, "2027-01-12T18-22-32Z_beadfeed");

    const settings = { defaultVersion: "2026-02-01T00-00-00Z_missing" };
    const next = Manager.updateSettingsAfterUninstall(settings, {}, { userDataDir });
    assert.equal(next, undefined);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("getState exposes sections and variants", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  try {
    const state = Manager.getState({ settings: {}, userDataDir });
    assert.ok(Array.isArray(state.sections));
    assert.equal(state.sections[0].id, "default");
    assert.ok(Array.isArray(state.variants));
    assert.equal(state.variants.length, 0);
    assert.equal(state.catalog.status, "idle");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("canUseGh handles availability checks", async () => {
  const ok = await Manager.core.canUseGh({
    runCommand: () => Promise.resolve({ stdout: "", stderr: "" })
  });
  assert.equal(ok, true);

  const fail = await Manager.core.canUseGh({
    runCommand: () => Promise.reject(new Error("no gh"))
  });
  assert.equal(fail, false);
});

test('latest successful MKXP-Z run selects its compatible app before standalone or foreign CPU artifacts',()=>{
  const saved=require('./fixtures/mkxpz-artifacts/successful-run.json');
  assert.equal(saved.run.conclusion,'success');assert.equal(saved.artifacts[0].id,11271285727);
  for(const arch of['arm64','x64'])assert.equal(Manager.core.selectMacosArtifact(saved.artifacts,{arch}).id,11271002066);
  const native=saved.artifacts.filter(artifact=>!artifact.name.includes('universal'));
  assert.equal(Manager.core.selectMacosArtifact(native,{arch:'arm64'}).id,11269784663);
  assert.equal(Manager.core.selectMacosArtifact(native,{arch:'x64'}).id,11270831442);
  assert.equal(Manager.core.selectMacosArtifact(saved.artifacts.filter(artifact=>artifact.name.includes('standalone')),{arch:'arm64'}),null);
  assert.equal(Manager.core.selectMacosArtifact([{id:1,name:'macos',expired:true}]),null);
});

test("unavailable optional Actions downloads preserve the exact selection without app fallback", async t => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-runtime-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  t.mock.method(Manager.core, "canUseGh", async () => false);
  t.mock.method(Builds.manager, "refreshCatalog", async () => {});
  await assert.rejects(Manager.installRuntime({ userDataDir, version: "chosen-actions-version" }), /GitHub CLI unavailable/);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});

test('empty MKXP-Z resources install the exact public baseline without gh or a prior Refresh',{skip:process.platform!=='darwin'},async t=>{
  const f=createHostedFixture(t),events=[],downloads=new DownloadManager({progressThrottleMs:0,onChange:()=>events.push(downloads.list())});
  assert.equal(Manager.core.listInstalled(f.userDataDir).length,0);Manager.getState({userDataDir:f.userDataDir,settings:{}});
  assert.deepEqual(f.calls,{catalog:0,downloads:0},'Cold status performs no network or development-path fallback');
  const installed=await Manager.installRuntime({userDataDir:f.userDataDir,version:Binary.version,downloads});
  assert.equal(installed.version,Binary.version);assert.equal(installed.source,'MacLauncher Builds');assert.equal(installed.projectPackage,true);
  assert.equal(installed.appPath,path.join(f.userDataDir,'runtimes/mkxpz',Binary.version,'payload/files',Binary.appName));
  assert.deepEqual(f.calls,{catalog:1,downloads:1});assert.deepEqual(downloads.list(),[]);
  assert.ok(events.some(rows=>rows.some(row=>row.managerId==='mkxpz'&&row.sectionId==='default'&&row.downloaded===f.record.asset.bytes)));
  assert.equal(Manager.core.resolveOwnedRuntime({userDataDir:f.userDataDir,version:Binary.version}).appPath,installed.appPath);
  assert.equal(Manager.core.listInstalled(f.userDataDir)[0].appPath,installed.appPath);
  assert.equal((await Manager.installRuntime({userDataDir:f.userDataDir,version:Binary.version,downloads})).appPath,installed.appPath);
  assert.deepEqual(f.calls,{catalog:1,downloads:1},'An existing selected installation is not copied or downloaded again');
  const settings={defaultVersion:'explicit-older'};
  assert.equal(Manager.updateSettingsAfterInstall(settings,installed),settings,'Adding the hosted baseline preserves an existing saved default');
  assert.equal(Manager.normalizeSettings({}).defaultVersion,null);
  const license=path.join(installed.payloadRoot,'licenses/LICENSE'),changed=fs.readFileSync(license);changed[0]^=1;fs.writeFileSync(license,changed);
  assert.throws(()=>Manager.core.resolveOwnedRuntime({userDataDir:f.userDataDir,version:Binary.version}),/checksum/);
});

test('public MKXP-Z baseline cancellation cleans staging and never publishes an installation',{skip:process.platform!=='darwin'},async t=>{
  for(const origin of ['downloads','launch'])await t.test(origin,async t=>{
    const f=createHostedFixture(t),downloads=new DownloadManager(),controller=new AbortController();
    f.control.download=async signal=>{if(origin==='downloads')downloads.cancel(downloads.list()[0].id);else controller.abort();signal.throwIfAborted();};
    await assert.rejects(Manager.installRuntime({userDataDir:f.userDataDir,version:Binary.version,downloads,signal:controller.signal}),{name:'AbortError'});
    assert.deepEqual(downloads.list(),[]);
    const root=path.join(f.userDataDir,'runtimes/mkxpz');assert.ok(!fs.existsSync(path.join(root,Binary.version)));
    assert.ok(!fs.readdirSync(root).some(name=>name.startsWith('.install-')));
  });
});

test('MKXP-Z publisher packages require complete byte identity metadata',{skip:process.platform!=='darwin'},async t=>{
  const f=createHostedFixture(t,manifest=>{manifest.provenance.inputExecutableSha256='invalid';});
  await assert.rejects(Manager.installRuntime({userDataDir:f.userDataDir,version:Binary.version}),/original publisher bytes/);
  assert.ok(!fs.existsSync(path.join(f.userDataDir,'runtimes/mkxpz',Binary.version)));
  assert.equal(Manager.normalizeSettings({}).defaultVersion,null);
});

test('explicit MKXP-Z Refresh combines public baseline and optional Actions without changing selection',{skip:process.platform!=='darwin'},async t=>{
  const f=createHostedFixture(t),settings={defaultVersion:Binary.version};
  t.mock.method(Manager.core,'canUseGh',async()=>false);
  const publicCatalog=await Manager.refreshCatalog({userDataDir:f.userDataDir,force:true});
  assert.ok(publicCatalog.versions.includes(Binary.version));assert.equal(f.calls.downloads,0);
  const newer='2027-01-12T18-22-32Z_abcdef';
  t.mock.method(Manager.core,'canUseGh',async()=>true);
  t.mock.method(Manager.core,'fetchLatestAvailableVersions',async()=>({versions:[newer],entries:[{version:newer,artifactId:1}]}));
  const merged=await Manager.refreshCatalog({userDataDir:f.userDataDir,force:true});
  assert.deepEqual(merged.versions,[newer,Binary.version]);assert.equal(f.calls.downloads,0);
  const refreshed = Manager.getState({settings,userDataDir:f.userDataDir});
  assert.equal(refreshed.catalog.recommendedVersion,undefined,"A profile absent from the refreshed catalogs is not offered as a download recommendation");
  assert.equal(refreshed.defaultVersion,Binary.version,"Refresh preserves the exact explicit global choice");
  assert.equal(refreshed.notice.title,"Version sources");
  assert.deepEqual(settings,{defaultVersion:Binary.version});
  t.mock.method(f.manager,'refreshCatalog',async()=>{throw Error('Public catalog unavailable');});
  assert.ok((await Manager.refreshCatalog({userDataDir:f.userDataDir,force:true})).versions.includes(newer),'An independent public catalog failure cannot disable authenticated Actions');
  t.mock.method(f.manager,'refreshCatalog',async()=>{});
  t.mock.method(Manager.core,'fetchLatestAvailableVersions',async()=>{throw Error('Optional Actions unavailable');});
  assert.ok((await Manager.refreshCatalog({userDataDir:f.userDataDir,force:true})).versions.includes(Binary.version),'An optional Actions failure cannot disable the public baseline');
});

test('MCL snapshot comparisons remain available while installations require explicit choice', t => {
  assert(Manager.core.compareVersions('MCLv10-0101','MCLv2-1231')>0);
  assert.equal(Manager.core.formatVersionLabel('MCLv1-1003'),'MCLv1-1003');
  const previous='1.0.0-installed-fixture';
  t.mock.method(Manager.core,'resolveOwnedRuntime',({version})=>version===previous?{version}:null);
  t.mock.method(Manager.core,'listInstalled',()=>[{version:previous}]);
  const automatic=Manager.resolveSelection({}, {}, '/private/testing-data');
  assert.equal(automatic.ready,true);assert.equal(automatic.version,previous);
  assert.equal(Manager.resolveSelection({}, {runtimes:{mkxpz:{defaultVersion:previous}}}, '/private/testing-data').ready,true);
  const exact=Manager.resolveSelection({runtimeData:{mkxpz:{version:ADAPTED_VERSION}}},{},'/private/testing-data');
  assert.equal(exact.ready,false);assert.equal(exact.version,ADAPTED_VERSION);
});

test('upstream Actions labels distinguish same-day builds by UTC time without hashes',()=>{
  assert.equal(Manager.core.formatVersionLabel('2026-10-03T08-32-56Z_37a04d14413454551a7b6aadbb4e93e67168accb'),'2026-10-03 08:32');
  assert.equal(Manager.core.formatVersionLabel('2026-10-03T07-11-20Z_834ae82200000000000000000000000000000000'),'2026-10-03 07:11');
  assert.equal(Manager.core.formatVersionLabel('MCLv1-1003'),'MCLv1-1003');
});

test("consented MKXP-Z install without a selection discovers versions before asking for one", async t => {
  const userDataDir=makeTempDir("maclauncher-mkxpz-unselected-");t.after(()=>fs.rmSync(userDataDir,{recursive:true,force:true}));
  t.mock.method(Manager.core,"listInstalled",()=>[]);
  const refresh=t.mock.method(Builds.manager,"refreshCatalog",async()=>{});
  t.mock.method(Manager.core,"canUseGh",async()=>false);
  await assert.rejects(Manager.installRuntime({userDataDir,version:null}),/^Error: No MKXP-Z versions are available/);
  assert.equal(refresh.mock.callCount(),1);
});
