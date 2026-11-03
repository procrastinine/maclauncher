// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { zip } = require("./helpers/android-packages");
const Shaders = require("../src/modules/shared/reshade/managed-shaders");
const Manager = require("../src/modules/shared/reshade/runtime/shader-library-manager");
const features = { formats: ["libplacebo", "slangp"] }, options = { macOSVersion: "14.0", graphicsArchitecture: "arm64" };
const rgb = Buffer.from("//!HOOK MAIN\n//!DESC RGB CNN Upscale\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n");
const chroma = Buffer.from("//!HOOK CHROMA\n//!BIND LUMA\n//!DESC Chroma Reconstruction\nvec4 hook(){return vec4(0);}\n");
const boundPlane = Buffer.from("//!HOOK RGB\n//!BIND LUMA\n//!DESC Video plane combine\nvec4 hook(){return vec4(0);}\n");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "managed-shaders-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
// Play passes the UI consent adapter and Install approves itself; direct calls supply one.
const approved = async () => true;
const API = "https://api.github.com/repos/";
const repository = sectionId => Shaders.Catalog.packs.find(pack => pack.id === sectionId).repository;
const blob = (name, bytes) => ({ type: "blob", path: name, size: bytes.length,
  sha: crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") });
// Install selects from the refreshed version list, which starts empty. Refresh
// reads the default branch's newest commit and, when routed, its file tree.
async function refresh(userDataDir, sectionId, sha = "a".repeat(40), date = "2026-10-21T00:00:00Z", tree) {
  Harness.network.routes = { [`${API}${repository(sectionId)}/commits`]: [{ sha, commit: { committer: { date } } }],
    ...(tree ? { [`${API}${repository(sectionId)}/git/trees/${sha}`]: tree } : {}) };
  try { await Shaders.refreshCatalog({ userDataDir, sectionId }); } finally { Harness.network.routes = null; }
}
async function install(context, routes = {}) {
  Harness.network.routes = routes;
  try { return await Shaders.installRuntime(context); } finally { Harness.network.routes = null; }
}
// A source collection downloads GitHub's archive of the selected commit.
function archiveRoutes(sectionId, archive, commits = ["a".repeat(40), "b".repeat(40)]) {
  return Object.fromEntries(commits.map(commit => [`https://codeload.github.com/${repository(sectionId)}/zip/${commit}`, archive]));
}
function packArchive() { return zip([["collection/LICENSE", Buffer.from("MIT license fixture")],
  ["collection/RGB.glsl", rgb], ["collection/CfL.hook", chroma], ["collection/Plane.glsl", boundPlane],
  ["collection/includes/common.fxh", Buffer.from("// included source")]]); }

test("shader collection versions expose only saved defaults and installation preserves explicit choices", t => {
  const userDataDir = fixture(t), sectionId = Shaders.Catalog.packs[0].id;
  const older = { version: "1.0", source: { version: "1.0" } }, newer = { version: "2.0", source: { version: "2.0" } };
  t.mock.method(Shaders, "cached", (_root, id) => id === sectionId ? { entries: [newer.source], fetchedAt: 1 } : null);
  t.mock.method(Shaders, "listInstalled", (_root, id) => id === sectionId ? [newer, older] : []);
  const section = settings => Manager.getState({ userDataDir, settings }).sections.find(row => row.id === sectionId);
  assert.equal(section({}).defaultVersion, null);
  assert.equal(section({}).catalog.recommendedVersion, undefined);
  assert.equal(section({}).catalog.latestAvailableVersion, newer.version);
  const settings = { defaultVersions: { [sectionId]: "explicit-missing" }, customDefaults: { [sectionId]: "/collection" } };
  assert.equal(section(settings).defaultVersion, "explicit-missing");
  assert.equal(Manager.updateSettingsAfterInstall(settings, { packId: sectionId, version: newer.version }), settings);
  assert.equal(Manager.updateSettingsAfterUninstall(settings, { sectionId, version: "explicit-missing" }, { userDataDir }), settings);
  const chosen = Manager.applySettingsUpdate("setDefault", { sectionId, version: older.version }, {});
  assert.equal(section(chosen).defaultVersion, older.version);
});

test("one managed shader snapshot deduplicates shared Slang dependency stats and the next read invalidates them", t => {
  const root=fixture(t),Traits=require("../src/modules/shared/reshade/shader-traits"),packId=Shaders.Catalog.packs[0].id,
    reference=path.join(root,"common.slangp");
  fs.writeFileSync(reference,'shaders = 1\nscale_type0 = source\nscale0 = 2\n');
  const effects=["first","second"].map((name,i)=>{
    const file=name+".slangp";fs.writeFileSync(path.join(root,file),'#reference "common.slangp"\n');
    Traits.analyzeFile(path.join(root,file),"slangp");
    return {id:String(i+1).repeat(16),file,format:"slangp",label:name,traitsVersion:Traits.VERSION};
  });
  const files=Object.fromEntries(effects.map(row=>[row.file,{bytes:27,sha256:row.id.repeat(4)}]));
  t.mock.method(Shaders,"listInstalled",(_userDataDir,section)=>section===packId?[{packId,root,filesRoot:root,files,effects}]:[]);
  const stat=fs.statSync;let sharedReads=0;
  t.mock.method(fs,"statSync",(...args)=>{if(args[0]===reference)sharedReads++;return stat(...args);});
  const first=Shaders.listEffects(root,features,options);assert.equal(first.length,2);assert.equal(sharedReads,1);
  assert.ok(first.every(row=>row.outputContract.scale.x===2));
  fs.writeFileSync(reference,'shaders = 1\nscale_type0 = source\nscale0 = 3\n');
  const next=Shaders.listEffects(root,features,options);assert.ok(sharedReads>1,"a later request rechecks the exact include identity");
  assert.ok(next.every(row=>row.outputContract.scale.x===3));
  fs.unlinkSync(reference);
  assert.ok(Shaders.listEffects(root,features,options).every(row=>row.outputContract.sizing==="shader"),"missing dependencies invalidate both presets");
});

test("collection entries are named after their files and listed under their collection", t => {
  const root=fixture(t),Traits=require("../src/modules/shared/reshade/shader-traits"),records=[];
  for(const [packId,names] of [["mpv-default",["shaders/FSRCNNX_x2_8-0-4-1.glsl","shaders/one/Same.glsl","shaders/two/Same.glsl"]],["anime4k",["glsl/Restore/Anime4K_Restore_CNN_S.glsl"]]]){
    const effects=names.map((file,i)=>({id:crypto.createHash("sha256").update(packId+file).digest("hex").slice(0,16),file,format:"libplacebo",
      label:file.replace(/\.glsl$/,"").replace(/_/g," "),traits:{},traitsVersion:Traits.VERSION}));
    records.push({packId,root,filesRoot:root,effects,files:Object.fromEntries(effects.map(row=>[row.file,{bytes:1,sha256:row.id.repeat(4)}]))});
  }
  t.mock.method(Shaders,"listInstalled",(_userDataDir,section)=>records.filter(record=>record.packId===section));
  const listed=Shaders.listEffects(root,features,options);
  assert.deepEqual(listed.map(row=>[row.label,row.group,row.collection]).sort(),[["Anime4K Restore CNN S","Anime4K","Anime4K collection"],
    ["FSRCNNX x2 8-0-4-1","mpv shader collection","mpv shader collection"],["one/Same","mpv shader collection","mpv shader collection"],
    ["two/Same","mpv shader collection","mpv shader collection"]]);
});

test("shader library state stays local and derived planes require a capable processor", async t => {
  const userDataDir = fixture(t);
  assert.equal(Manager.ui.groupId, "graphics"); assert.equal(Manager.ui.tabLabel, "Graphics");
  assert.equal(Manager.ui.library, "shaders");
  assert.ok(Manager.getState({ userDataDir }).sections.every(section => ["mpv","isf","magpie","reshade","libretro"].includes(section.shaderFamily)));
  assert.deepEqual(Manager.getState({ userDataDir }).sections.map(section=>section.id), ["anime4k","artcnn","cfl-prediction","mpv-default","cunny","acnet","mpv-prescalers","vidvox-isf","slang-shaders","magpie","cshade","prod80","fxshaders","ssrt3","niceguy","quint","astrayfx","otisfx"]);
  assert.deepEqual(fs.readdirSync(userDataDir), [], "status does not create storage or contact a server");
  const requests = Harness.network.requests.length;
  await assert.rejects(install({ userDataDir, sectionId: "cfl-prediction", confirmRuntimeInstall: async () => false }), /cancel/i);
  assert.equal(Harness.network.requests.length, requests, "Declining precedes catalog discovery");
  const sha = "a".repeat(40), license = Buffer.from("MIT license fixture");
  let consented = false;
  const routes = { ...archiveRoutes("cfl-prediction", packArchive()),
    [`${API}${repository("cfl-prediction")}/commits`]: () => {
      assert.equal(consented, true);return [{sha, commit:{committer:{date:"2026-10-21T00:00:00Z"}}}];
    },
    [`${API}${repository("cfl-prediction")}/git/trees/${sha}`]: { tree: [blob("LICENSE", license), blob("RGB.glsl", rgb), blob("CfL.hook", chroma)] } };
  const result = await install({ userDataDir, sectionId: "cfl-prediction", confirmRuntimeInstall: async () => {
    assert.equal(consented, false, "One prompt covers discovery and installation");consented = true;return true;
  } }, routes);
  assert.equal(result.effects.length, 3);
  const listed = Shaders.listEffects(userDataDir, features, options), color = listed.find(row => !row.nativeVideo), video = listed.find(row => row.nativeVideo);
  assert.ok(Shaders.isId(color.id)); assert.equal(color.available, true); assert.equal(video.available, false);
  assert.match(video.reason, /derived luma and chroma/);
  const derivedFeatures = {...features, providers: {libplacebo: {derivedPlanes: true}}};
  const gamePlanes = Shaders.listEffects(userDataDir, derivedFeatures, options).find(row => row.id === video.id);
  assert.equal(gamePlanes.available, true);
  assert.equal(gamePlanes.traits.requiresDerivedPlanes, true);
  assert.equal(gamePlanes.traits.requiresVideoPlanes, false);
  assert.ok(Shaders.resolveEffect(userDataDir, video.id, derivedFeatures, "window", options).file.endsWith("CfL.hook"));
  assert.equal(listed.find(row => row.label.includes("Plane")).nativeVideo, true);
  const floorLimited = Shaders.listEffects(userDataDir, { formats: ["libplacebo"], providers: { libplacebo: { minimumMacOS: "15.0" } } },
    { ...options, nativeVideo: true });
  assert.equal(floorLimited.find(row => row.nativeVideo).available, true);
  assert.equal(floorLimited.find(row => !row.nativeVideo).available, true, "mpv runs RGB prefixes in its own renderer too");
  assert.ok(listed.every(row => row.nativeVideoAvailable));
  assert.deepEqual(color.traits.outputScale, { x: 2, y: 2 });
  assert.equal(color.traits.neural, true);
  assert.throws(() => Shaders.resolveEffect(userDataDir, video.id, features, "window", options), /derived luma and chroma/);
  assert.ok(Shaders.resolveEffect(userDataDir, video.id, {}, "window", { ...options, nativeVideo: true }).file.endsWith("CfL.hook"));
  const selected = Shaders.resolveEffect(userDataDir, color.id, features, "window", options);
  assert.deepEqual(fs.readFileSync(selected.file), rgb);
  assert.equal(fs.statSync(selected.file).mode & 0o222, 0);
  assert.equal(selected.runtimeIdentity.managerId, Shaders.ID);
  fs.chmodSync(selected.file, 0o644); fs.appendFileSync(selected.file, "// changed");
  assert.throws(() => Shaders.resolveEffect(userDataDir, color.id, features, "window", options), /changed/);
  await Shaders.uninstallRuntime({ userDataDir, sectionId: "cfl-prediction", version: result.version });
  assert.deepEqual(Shaders.listEffects(userDataDir, features, options), []);
});
test("managed FX collections retain their include and texture directories through verified ordinary resolution",async t=>{
 const userDataDir=fixture(t),contents=new Map([
  ["LICENSE",Buffer.from("MIT fixture")],
  ["Shaders/Grade.fx",Buffer.from('#include "shared.fxh"\ntexture Lookup < source="lookup.png"; >;\n')],
  ["Shaders/shared.fxh",Buffer.from("// shader include\n")],
  ["Textures/lookup.png",Buffer.from("source texture fixture")]
 ]);
 const tree=[...contents].map(([file,bytes])=>blob(file,bytes)),commit="a".repeat(40),repo=repository("prod80");
 await refresh(userDataDir,"prod80");
 const installed=await install({userDataDir,sectionId:"prod80",confirmRuntimeInstall:approved},{
  [`${API}${repo}/git/trees/${commit}`]:{tree,truncated:false},
  ...Object.fromEntries([...contents].map(([file,bytes])=>[`https://raw.githubusercontent.com/${repo}/${commit}/${file}`,bytes]))
 });
 const effects=Shaders.listEffects(userDataDir,{formats:["fx"]},options);assert.equal(effects.length,1);assert.equal(effects[0].available,true);
 const resolved=Shaders.resolveEffect(userDataDir,effects[0].id,{formats:["fx"]},"window",options),root=path.join(installed.root,"files");
 assert.ok(resolved.includePaths.includes(path.join(root,"Shaders")));assert.ok(resolved.texturePaths.includes(path.join(root,"Textures")));
 assert.deepEqual(fs.readFileSync(path.join(resolved.texturePaths.at(-1),"lookup.png")),contents.get("Textures/lookup.png"));
 assert.deepEqual(Shaders.inspectCustom(root,{sectionId:"prod80"}).effects.map(row=>row.format),["fx"]);
});
// AstrayFX permits only unmodified copies, so both collections install their
// selected public commit as published: no recipe, added notice or rewrite.
test("AstrayFX and OtisFX install exact public commits unmodified with their notices and resource folders",async t=>{
 const userDataDir=fixture(t),commit="c".repeat(40),roots={};
 const collections=[
  ["astrayfx","BlueSkyDefender/AstrayFX",[
   ["Shaders/Smart_Sharp.fx",'uniform float Sharpness < ui_type = "slider"; > = 0.5;\n'],
   ["Shaders/Temporal_AA.fx",'#include "Overwatch.fxh"\n'],
   ["Shaders/Overwatch.fxh","// shared depth settings\n"]]],
  ["otisfx","FransBouma/OtisFX",[
   ["Shaders/GoldenRatio.fx",'texture texSpirals < source = "GoldenSpirals.png"; >;\n'],
   ["Textures/GoldenSpirals.png","composition guide texture fixture"]]]
 ];
 for(const [sectionId,origin,sources] of collections){
  const pack=Shaders.Catalog.packs.find(row=>row.id===sectionId);
  assert.deepEqual([pack.repository,pack.branch,pack.family,pack.delivery],[origin,"master","reshade","tree"]);
  assert.equal(pack.sourceOverlay,undefined);assert.equal(pack.bundledNotices,undefined);
  const contents=new Map([[pack.licenseFile,Buffer.from(sectionId+" license notice")],...sources.map(([file,text])=>[file,Buffer.from(text)])]);
  const tree=[...contents].map(([file,bytes])=>blob(file,bytes)),downloads=[];
  tree.push({type:"blob",path:"Previews/large.mp4",size:1e9,sha:"d".repeat(40)});
  await refresh(userDataDir,sectionId,commit,undefined,{tree,truncated:false});
  assert.deepEqual(Manager.getState({userDataDir}).sections.find(row=>row.id===sectionId).catalog.versions,["git-"+commit]);
  assert.equal(Shaders.available(userDataDir,sectionId)[0].reason,undefined);
  const installed=await install({userDataDir,sectionId,confirmRuntimeInstall:approved},{
   [`${API}${origin}/git/trees/${commit}`]:{tree,truncated:false},
   ...Object.fromEntries([...contents].map(([file,bytes])=>[`https://raw.githubusercontent.com/${origin}/${commit}/${file}`,url=>{downloads.push(url);return bytes;}]))
  });
  assert.equal(installed.source.commit,commit);assert.equal(installed.sourceOverlay,undefined);
  assert.equal(downloads.length,contents.size);assert.ok(downloads.every(url=>!url.includes("Previews")));
  roots[sectionId]=path.join(installed.root,"files");
  assert.deepEqual(Object.keys(installed.files).sort(),[...contents.keys()].sort());
  for(const [file,bytes] of contents){
   const target=path.join(roots[sectionId],file);
   assert.deepEqual(fs.readFileSync(target),bytes,file);assert.equal(fs.statSync(target).mode&0o222,0);
  }
 }
 const effects=Shaders.listEffects(userDataDir,{formats:["fx"]},options),find=label=>effects.find(row=>row.label===label);
 assert.deepEqual(effects.map(row=>[row.collection,row.label]).sort(),
  [["AstrayFX collection","Smart Sharp"],["AstrayFX collection","Temporal AA"],["OtisFX collection","GoldenRatio"]]);
 assert.ok(effects.every(row=>row.available));
 const temporal=Shaders.resolveEffect(userDataDir,find("Temporal AA").id,{formats:["fx"]},"window",options);
 assert.ok(temporal.includePaths.includes(path.join(roots.astrayfx,"Shaders")));
 const golden=Shaders.resolveEffect(userDataDir,find("GoldenRatio").id,{formats:["fx"]},"window",options);
 assert.ok(golden.texturePaths.includes(path.join(roots.otisfx,"Textures")));
});
test("older managed shader traits refresh locally without changing immutable pack metadata", async t => {
  const userDataDir = fixture(t), conditional = Buffer.from("//!DESC Example CNN x2\n//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}");
  const archive = zip([["collection/LICENSE", Buffer.from("MIT fixture")], ["collection/Network.glsl", conditional]]);
  await refresh(userDataDir, "cfl-prediction");
  const result = await install({ userDataDir, sectionId: "cfl-prediction", confirmRuntimeInstall: approved }, archiveRoutes("cfl-prediction", archive));
  assert.equal(result.effects[0].traitsVersion, require("../src/modules/shared/reshade/shader-traits").VERSION);
  const metadata = path.join(result.installDir, "pack.json"), saved = JSON.parse(fs.readFileSync(metadata, "utf8"));
  for (const effect of saved.effects) { delete effect.traitsVersion;effect.traits = { category: "effects", neural: true, outputScale: { x: 2, y: 2 } }; }
  fs.chmodSync(metadata, 0o600);fs.writeFileSync(metadata, JSON.stringify(saved));
  const originalMetadata = fs.readFileSync(metadata, "utf8"), file = path.join(result.installDir, "files", saved.effects[0].file), open = fs.openSync;
  let sourceReads = 0;t.mock.method(fs, "openSync", (...args) => { if (args[0] === file) sourceReads++;return open(...args); });
  const first = Shaders.listEffects(userDataDir, features, options)[0];
  assert.equal(first.traits.conditionalGeometry, true);assert.equal(first.traits.outputScale, undefined);assert.equal(first.category, "upscaling");
  assert.deepEqual(Shaders.listEffects(userDataDir, features, options)[0], first);assert.equal(sourceReads, 1);
  assert.equal(fs.readFileSync(metadata, "utf8"), originalMetadata);
  assert.deepEqual(fs.readFileSync(file), conditional);
});

test("shader pack defaults select matching copies and their leases without changing stable IDs or explicit versions", async t => {
  const userDataDir = fixture(t), sectionId = "cfl-prediction";
  await refresh(userDataDir, sectionId);
  const older = await install({userDataDir, sectionId, confirmRuntimeInstall: approved}, archiveRoutes(sectionId, packArchive()));
  await refresh(userDataDir, sectionId, "b".repeat(40), "2026-10-22T00:00:00Z");
  const newer = await install({userDataDir, sectionId, version: "git-" + "b".repeat(40), confirmRuntimeInstall: approved},
    archiveRoutes(sectionId, zip([["collection/LICENSE", Buffer.from("MIT fixture")], ["collection/preferred/RGB.glsl", rgb],
      ["collection/includes/common.fxh", Buffer.from("// changed include")]])));
  const id = Shaders.listEffects(userDataDir, features, options).find(row => row.traits.outputScale)?.id;
  assert.equal(Shaders.resolveEffect(userDataDir, id, features, "window", options).runtimeIdentity.version, newer.version);
  const settings = {runtimes: {[Shaders.ID]: Manager.applySettingsUpdate("setDefault", {sectionId, version: older.version}, {})}};
  const selectedOptions = {...options, settings};
  assert.equal(Manager.getState({userDataDir, settings: settings.runtimes[Shaders.ID]}).sections.find(row => row.id === sectionId).defaultVersion, older.version);
  const listed = Shaders.listEffects(userDataDir, features, selectedOptions);
  assert.equal(listed.filter(row => row.id === id).length, 1);
  assert.equal(listed.find(row => row.id === id).label, "RGB");assert.equal(listed.find(row => row.id === id).collection, "Chroma from Luma collection");
  const selected = Shaders.resolveEffect(userDataDir, id, features, "window", selectedOptions);
  assert.equal(selected.runtimeIdentity.version, older.version);assert.ok(selected.file.startsWith(older.installDir + path.sep));
  assert.equal(Shaders.resolveEffect(userDataDir, id, features, "window", {...selectedOptions, packVersion: newer.version}).runtimeIdentity.version, newer.version);
  assert.throws(() => Shaders.resolveEffect(userDataDir, id, features, "window", {...selectedOptions, packVersion: "missing"}), /not installed/);
  assert.equal(Shaders.resolveEffect(userDataDir, id, features, "window", {...selectedOptions, version: "unrelated-runtime-version"}).runtimeIdentity.version, older.version);

  const ReShade = require("../src/modules/shared/reshade");
  fs.writeFileSync(path.join(userDataDir, "runtime.json"), JSON.stringify({schema: 1, version: "fixture", minimumMacOS: "14.0", features: {shaders: features}}));
  fs.writeFileSync(path.join(userDataDir, "libreshade-macos.dylib"), "fixture");fs.writeFileSync(path.join(userDataDir, "fx-compile"), "fixture");
  const selectedEntry = {reshade: {enabled: true, preset: id}}, selectionContext = {...selectedOptions, root: userDataDir, userDataDir, graphicsHost: "window", platform: "darwin"};
  assert.equal(ReShade.resolveShaderSelection(selectedEntry, selectionContext).runtimeIdentity.version, older.version);
  assert.equal(ReShade.getState(selectionContext).presets.find(row => row.id === id).label, "RGB");
  const videoEntry = {effects: {schema: 2, mode: "advanced", video: [{id: "pack", kind: "shader", enabled: true, shader: {enabled: true, preset: id}}]}};
  const videoArgs = await require("../src/modules/video/graphics").preparePlaybackShaders(videoEntry, {...selectionContext, graphicsRuntimeRoot: userDataDir});
  assert.ok(videoArgs[0].startsWith(`--glsl-shader=${older.installDir}${path.sep}`));

  const Live = require("../src/modules/shared/reshade/live-effect"), Libplacebo = require("../src/modules/shared/reshade/libplacebo");
  let preparations = 0;const leases = [];
  t.mock.method(Libplacebo, "prepare", async file => {
    preparations++;const directory = path.join(userDataDir, "prepared-provider");fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, "effect.hook"), fs.readFileSync(file));fs.writeFileSync(path.join(directory, "metadata.json"), "{}");
    return {directory, files: [{path: "effect.hook"}], metadata:{}};
  });
  const entry = {gameId: "defaults", reshade: {enabled: true, preset: id}}, prepareOptions = {root: userDataDir, userDataDir,
    features, graphicsHost: "window", graphicsArchitecture: "arm64", settings, useRuntime: async identity => leases.push(identity.version)};
  await Live.prepare(entry, prepareOptions);await Live.prepare(entry, prepareOptions);
  assert.equal(preparations, 1);assert.deepEqual(leases, [older.version, older.version], "cached shaders retain the selected pack lease");
  await Live.prepare(entry, {...prepareOptions, settings: {runtimes: {[Shaders.ID]: {defaultVersions: {[sectionId]: newer.version}}}}});
  assert.equal(preparations, 2);assert.equal(leases.at(-1), newer.version, "a different include bundle invalidates the prepared shader cache");
});

test("ArtCNN installation downloads only selected shader source paths and verifies Git blobs", async t => {
  const userDataDir = fixture(t), downloads = [];
  const files = new Map([["GLSL/model.glsl", rgb], ["GLSL/Experiments/YCbCr.glsl", Buffer.from("//!HOOK NATIVE\n//!DESC YCbCr\nvec4 hook(){return vec4(0);}")],
    ["LICENSE", Buffer.from("MIT fixture")], ["README.md", Buffer.from("shader documentation")]]);
  const tree = [...files].map(([name, bytes]) => blob(name, bytes)), commit = "a".repeat(40), repo = repository("artcnn");
  tree.push({ type: "blob", path: "ONNX/large.onnx", size: 1e9, sha: "a".repeat(40) });
  await refresh(userDataDir, "artcnn");
  await install({ userDataDir, sectionId: "artcnn", confirmRuntimeInstall: approved }, {
    [`${API}${repo}/git/trees/${commit}`]: { tree, truncated: false },
    ...Object.fromEntries([...files].map(([name, bytes]) => [`https://raw.githubusercontent.com/${repo}/${commit}/${name}`, url => { downloads.push(url); return bytes; }]))
  });
  assert.equal(downloads.length, 4); assert.ok(downloads.every(url => !url.includes("ONNX")));
  const rows = Shaders.listEffects(userDataDir, features, options);
  assert.equal(rows.filter(row => row.nativeVideo).length, 1);
  assert.equal(rows.find(row => row.nativeVideo).traits.rgbCompatible, true);
  assert.equal(rows.find(row => row.nativeVideo).traits.requiresDerivedPlanes, false,
    "a directory preference does not fabricate a plane requirement for an ordinary NATIVE hook");
});

test("explicit shader version refresh persists cached snapshots without shader downloads", async t => {
  const userDataDir = fixture(t), before = Harness.network.requests.length;
  // Refresh reads the default branch's newest commit and that commit's file listing only.
  const tree = { truncated: false, tree: ["LICENSE", "CfL_Prediction.glsl"].map(path => ({ path, type: "blob", size: 64 })) };
  await refresh(userDataDir, "cfl-prediction", undefined, undefined, tree);
  const requests = Harness.network.requests.slice(before).map(url => new URL(url).pathname.replace(/^.*\/(commits|git\/trees)(?:\/.*)?$/, "$1"));
  assert.deepEqual(requests, ["commits", "git/trees"]);
  const state = Manager.getState({ userDataDir }).sections.find(row => row.id === "cfl-prediction");
  assert.equal(state.catalog.status, "success"); assert.deepEqual(state.catalog.versions, ["git-" + "a".repeat(40)]);
  assert.equal(Shaders.listInstalled(userDataDir).length, 0);
});

test("shader archives reject traversal, aliases and case collisions", t => {
  const root = fixture(t), destination = path.join(root, "out"); fs.mkdirSync(destination);
  const rejects = [zip([["../escape.glsl", rgb]]), zip([["root/A.glsl", rgb], ["root/a.glsl", chroma]])];
  const alias = zip([["root/link.glsl", Buffer.from("../../escape")]]), central = alias.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  alias.writeUInt32LE((0o120777 << 16) >>> 0, central + 38); rejects.push(alias);
  for (const [index, bytes] of rejects.entries()) {
    const file = path.join(root, index + ".zip"); fs.writeFileSync(file, bytes);
    assert.throws(() => Shaders.__test.extract(file, destination), /unsafe/);
    fs.rmSync(destination, { recursive: true }); fs.mkdirSync(destination);
  }
  assert.equal(fs.existsSync(path.join(root, "escape.glsl")), false);
});

test("shader archives bound inflation when central metadata understates the expanded size", t => {
  const root = fixture(t), destination = path.join(root, "out"); fs.mkdirSync(destination);
  const archive = zip([["large.glsl", Buffer.alloc(128 * 1024, 120)]]);
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(64, central + 24);
  const file = path.join(root, "lying-size.zip"); fs.writeFileSync(file, archive);
  assert.throws(() => Shaders.__test.extract(file, destination), error =>
    error.code === "ERR_BUFFER_TOO_LARGE" || /expanded size/.test(error.message));
  assert.deepEqual(fs.readdirSync(destination), []);
});

test("cancelled shader downloads leave no partial installation", async t => {
  const userDataDir = fixture(t), controller = new AbortController();
  await refresh(userDataDir, "cfl-prediction");
  const before = Harness.network.requests.length;
  await assert.rejects(install({ userDataDir, sectionId: "cfl-prediction" }), { name: "AbortError" });
  assert.equal(Harness.network.requests.length, before, "A context without consent cannot download");
  await assert.rejects(install({ userDataDir, sectionId: "cfl-prediction", signal: controller.signal, confirmRuntimeInstall: approved },
    archiveRoutes("cfl-prediction", () => { controller.abort(); return Buffer.from("partial"); })), { name: "AbortError" });
  assert.deepEqual(Shaders.listInstalled(userDataDir), []);
  assert.ok(fs.readdirSync(Shaders.directory(userDataDir, "cfl-prediction")).every(name => !name.startsWith(".install-")));
});


test("held coarse times invalidate shader source and shared Slang include content revisions", t => {
  const {holdFileTimes} = require("./helpers/held-file-times.cjs"), Traits = require("../src/modules/shared/reshade/shader-traits"), root = fixture(t);
  const include = path.join(root, "common.slangp"), file = path.join(root, "effect.slangp");
  fs.writeFileSync(include, 'shaders = 1\nscale_type0 = source\nscale0 = 2\n');
  fs.writeFileSync(file, '#reference "common.slangp"\n');holdFileTimes(t, [include, file]);
  const first = Traits.withMetadataSnapshot(() => Traits.analyzeFile(file, "slangp"));
  assert.equal(first.traits.outputScale.x, 2);
  fs.writeFileSync(include, 'shaders = 1\nscale_type0 = source\nscale0 = 3\n');
  const next = Traits.withMetadataSnapshot(() => Traits.analyzeFile(file, "slangp"));
  assert.equal(next.traits.outputScale.x, 3);assert.notEqual(next.sourceRevision, first.sourceRevision);
  fs.writeFileSync(file, 'shaders = 1\nscale0 = 4\n    ');
  const source = Traits.analyzeFile(file, "slangp");assert.notEqual(source.sourceRevision, next.sourceRevision);
});
