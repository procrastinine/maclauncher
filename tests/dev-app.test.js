const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { savePlistFile, parsePlistFile } = require("app-builder-lib/out/util/plist");

test("development branding preserves the original installation and caches a matching macOS helper layout", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-dev-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousOverride = process.env.MACLAUNCHER_ELECTRON_PATH;
  delete process.env.MACLAUNCHER_ELECTRON_PATH;
  t.after(() => {
    if (previousOverride === undefined) delete process.env.MACLAUNCHER_ELECTRON_PATH;
    else process.env.MACLAUNCHER_ELECTRON_PATH = previousOverride;
  });
  const source = path.join(root, "Electron.app"), contents = path.join(source, "Contents");
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  fs.mkdirSync(path.join(contents, "MacOS"));
  fs.mkdirSync(path.join(contents, "Frameworks"));
  const binary = path.join(contents, "MacOS", "Electron");
  fs.writeFileSync(binary, "fixture executable", { mode: 0o755 });
  const original = { CFBundleName: "Electron", CFBundleExecutable: "Electron", CFBundleIdentifier: "org.electronjs.Electron", CFBundleShortVersionString: "44.5.1" };
  await savePlistFile(path.join(contents, "Info.plist"), original);
  const helperName = "Electron Helper (Renderer)";
  const helper = path.join(contents, "Frameworks", helperName + ".app", "Contents");
  fs.mkdirSync(path.join(helper, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(helper, "MacOS", helperName), "fixture helper", { mode: 0o755 });
  // Electron 44 ships this helper without CFBundleExecutable.
  await savePlistFile(path.join(helper, "Info.plist"), { CFBundleName: helperName });
  fs.writeFileSync(path.join(contents, "Frameworks", "library"), "fixture library");
  fs.symlinkSync("library", path.join(contents, "Frameworks", "alias"));
  const iconPath = path.join(root, "icon.icns"), entitlementsPath = path.join(root, "entitlements.plist");
  fs.writeFileSync(iconPath, "owned icon");
  fs.writeFileSync(entitlementsPath, "fixture entitlements");
  const { prepareDevelopmentApp } = await import(pathToFileURL(path.resolve(__dirname, "../scripts/dev-app.mjs")));
  const calls = [], options = { electronBinary: binary, platform: "darwin", cacheRoot: path.join(root, "cache"), iconPath, entitlementsPath,
    run: (command, args) => { calls.push({ command, args }); } };
  const prepared = await prepareDevelopmentApp(options), app = prepared.slice(0, prepared.lastIndexOf("/Contents/MacOS/"));
  assert.equal(path.basename(prepared), "MacLauncher");
  assert.equal(fs.readFileSync(binary, "utf8"), "fixture executable");
  assert.deepEqual(await parsePlistFile(path.join(contents, "Info.plist")), original);
  assert.equal(fs.readFileSync(path.join(app, "Contents", "MacOS", "MacLauncher"), "utf8"), "fixture executable");
  const renamedHelper = path.join(app, "Contents", "Frameworks", "MacLauncher Helper (Renderer).app", "Contents");
  assert.equal((await parsePlistFile(path.join(renamedHelper, "Info.plist"))).CFBundleExecutable, "MacLauncher Helper (Renderer)");
  assert.equal(fs.readFileSync(path.join(renamedHelper, "MacOS", "MacLauncher Helper (Renderer)"), "utf8"), "fixture helper");
  assert.equal(fs.readlinkSync(path.join(app, "Contents", "Frameworks", "alias")), "library");
  const info = await parsePlistFile(path.join(app, "Contents", "Info.plist"));
  assert.equal(info.CFBundleName, "MacLauncher");
  assert.equal(info.CFBundleDisplayName, "MacLauncher");
  assert.ok(info.CFBundleDocumentTypes.some(row => row.CFBundleTypeExtensions.includes("exe") && row.LSHandlerRank === "Owner"));
  assert.ok(info.CFBundleDocumentTypes.some(row => row.CFBundleTypeExtensions.includes("glsl") && row.LSHandlerRank === "Alternate"));
  assert.ok(info.CFBundleDocumentTypes.some(row => row.CFBundleTypeExtensions.includes("dlssmodel") && row.LSTypeIsPackage === true));
  assert.equal(calls.length, 2);
  assert.equal(await prepareDevelopmentApp(options), prepared);
  assert.equal(calls.length, 2);
  assert.equal(await prepareDevelopmentApp({ ...options, platform: "linux" }), binary);
  process.env.MACLAUNCHER_ELECTRON_PATH = binary;
  assert.equal(await prepareDevelopmentApp(options), binary);
  delete process.env.MACLAUNCHER_ELECTRON_PATH;
  fs.writeFileSync(iconPath,'changed icon');
  await assert.rejects(prepareDevelopmentApp({...options,run:()=>{throw Error('signing failed');}}),/signing failed/);
  assert.equal(fs.readdirSync(options.cacheRoot).some(name=>name.startsWith('.prepare-')),false,'Failed signing removes its entire stage');
  assert.equal(fs.readFileSync(prepared,'utf8'),'fixture executable','A failed replacement preserves the usable generation');
});

test('development cache retention protects current, fallback, running and leased generations',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {pruneDevelopmentApps}=await import('../scripts/dev-app.mjs');
  const generation=(n,at)=>{const file=path.join(root,String(n).repeat(24));fs.mkdirSync(file);fs.writeFileSync(path.join(file,'ready.json'),'{}');fs.utimesSync(path.join(file,'ready.json'),at,at);return file;};
  const stale=generation(1,1),running=generation(2,2),leased=generation(3,3),fallback=generation(4,4),current=generation(5,5);
  fs.mkdirSync(path.join(root,'.generation-leases'));fs.writeFileSync(path.join(root,'.generation-leases/8888.json'),JSON.stringify({pid:8888,paths:[leased]}));
  const activeStage=path.join(root,'.prepare-8888-test'),deadStage=path.join(root,'.prepare-9999-test');fs.mkdirSync(activeStage);fs.mkdirSync(deadStage);
  const external=fs.mkdtempSync(path.join(os.tmpdir(),'dev-retention-external-'));t.after(()=>fs.rmSync(external,{recursive:true,force:true}));
  fs.symlinkSync(external,path.join(root,'6'.repeat(24)));fs.writeFileSync(path.join(external,'keep'),'data');
  pruneDevelopmentApps(root,current,{processes:null});assert(fs.existsSync(stale),'Failed process inspection disables deletion');
  pruneDevelopmentApps(root,current,{processes:running+'/MacLauncher.app/Contents/MacOS/MacLauncher',alive:pid=>pid===8888});
  assert(!fs.existsSync(stale));for(const file of [current,fallback,running,leased,activeStage])assert(fs.existsSync(file));
  assert(!fs.existsSync(deadStage));assert.equal(fs.readFileSync(path.join(external,'keep'),'utf8'),'data');
  pruneDevelopmentApps(root,current,{processes:'',alive:()=>false});
  assert(!fs.existsSync(running));assert(!fs.existsSync(leased));assert(fs.existsSync(fallback));
});

test("packaged Finder file associations are written before signing without losing custom types", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-app-types-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contents = path.join(root, "MacLauncher.app", "Contents");
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  const infoPath = path.join(contents, "Info.plist");
  const custom = { CFBundleTypeName: "Custom document", CFBundleTypeExtensions: ["custom"] };
  await savePlistFile(infoPath, { CFBundleName: "MacLauncher", CFBundleIconFile: "icon.icns", CFBundleDocumentTypes: [custom] });
  const afterPack = require("../scripts/after-pack");
  const Python = require('../scripts/python-resources.cjs'), pythonProfile = require('../src/modules/shared/runtime/embedded-python.json');
  const pythonSource = path.join(root, 'src/resources/python'), pythonResources = path.join(contents, 'Resources/python');
  for (const file of [...Python.requiredFiles, 'bin/python3', ...Object.keys(Python.configuration().aliases)]) {
    const target = path.join(pythonSource, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.startsWith('bin/') ? 'same producer interpreter' : 'runtime module', { mode: file.startsWith('bin/') ? 0o755 : 0o644 });
  }
  fs.writeFileSync(path.join(pythonSource, 'runtime.json'), JSON.stringify(pythonProfile));
  fs.cpSync(pythonSource, pythonResources, { recursive: true });
  const pythonBefore = Python.verifySourcePython({ sourceRoot: pythonSource });
  const archiveSource = path.join(root, 'archive-source');
  for (const [name, value] of Object.entries({ 'package.json': JSON.stringify(require('../package.json')),
    'dist/renderer/index.html': '<html></html>', 'src/main/bootstrap.js': 'module.exports = {}' })) {
    fs.mkdirSync(path.dirname(path.join(archiveSource, name)), { recursive: true });
    fs.writeFileSync(path.join(archiveSource, name), value);
  }
  await require('@electron/asar').createPackage(archiveSource, path.join(contents, 'Resources', 'app.asar'));
  const context = { electronPlatformName: "darwin", appOutDir: root, arch: 3,
    packager: { info: { projectDir: root }, appInfo: { productFilename: "MacLauncher", version: require('../package.json').version } } };
  let checked = 0;
  const dependencies = { verifyAppInputs({ appPath, archive }) {
    assert.equal(appPath, path.join(root, 'MacLauncher.app'));
    assert.equal(archive, path.join(contents, 'Resources/app.asar')); checked++;
  } };
  await afterPack(context, { dependencies });
  await afterPack(context, { dependencies });
  assert.equal(checked, 2);
  assert.deepEqual(Python.verifySourcePython({ sourceRoot: pythonSource }), pythonBefore);
  assert.equal(Python.assertPackagedPython({ resourceRoot: pythonResources }).version, pythonProfile.version);
  for (const [alias, target] of Object.entries(Python.configuration().aliases)) {
    assert.equal(fs.lstatSync(path.join(pythonSource, alias)).isFile(), true, 'Projection preserves the producer interpreter copies');
    assert.equal(fs.readlinkSync(path.join(pythonResources, alias)), target);
  }
  const info = await parsePlistFile(infoPath);
  assert.equal(info.CFBundleDisplayName, "MacLauncher");
  assert.deepEqual(info.CFBundleDocumentTypes[0], custom);
  assert.equal(info.CFBundleDocumentTypes.filter(row => row.CFBundleTypeName === "Game").length, 1);
  const game = info.CFBundleDocumentTypes.find(row => row.CFBundleTypeName === "Game");
  for (const extension of ["exe", "pck", "love", "jar", "swf"]) assert.ok(game.CFBundleTypeExtensions.includes(extension));
  assert.equal(game.LSHandlerRank, "Owner");
  const shaders = info.CFBundleDocumentTypes.find(row => row.CFBundleTypeName === "Graphics shader or filter");
  const sources = require("../src/modules/shared/reshade/shader-providers").sourceExtensions.map(extension => extension.slice(1));
  assert.deepEqual([...shaders.CFBundleTypeExtensions].sort(), [...sources].sort(), "Finder associations cover every graphics source format");
  assert.equal(shaders.LSHandlerRank, "Alternate");
  assert.equal(info.CFBundleDocumentTypes.filter(row => row.CFBundleTypeName === "Neural rendering model").length, 1);
});
