const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { FileMatcher, getMainFileMatchers, getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher");
const { doMergeConfigs } = require("app-builder-lib/out/util/config/config");
const Content = require("../scripts/runtime-content.cjs");

const projectRoot = path.resolve(__dirname, "..");
function packageConfig() { return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")); }
function selectedBy(matcher, relative) {
  return matcher.createFilter()(path.join(matcher.from, relative), { isDirectory: () => false });
}

test("Python resource traversal excludes the ctypes test extension and preserves ctypes runtime inputs", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "python-runtime-content-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const testExtension = "python/lib/python3.12/lib-dynload/_ctypes_test.cpython-312-darwin.so";
  const runtime = ["python/lib/python3.12/lib-dynload/_ctypes.cpython-312-darwin.so", "python/lib/python3.12/ctypes/__init__.py"];
  for (const file of [...runtime, testExtension]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "Synthetic Python component");
  }
  const matcher = new FileMatcher(root, "/resources", value => value, Content.withExclusions(["python/**"]));
  const selected = await require("builder-util").walk(root, matcher.createFilter());
  assert.deepEqual(selected.map(file => path.relative(root, file)).sort(), runtime.sort());
  assert.throws(() => Content.assertRuntimePath(testExtension), /Python test extension/);
  for (const file of runtime) assert.doesNotThrow(() => Content.assertRuntimePath(file));
});

test("normalized Builder FileSets preserve the source allowlist without adding a repository-wide matcher", () => {
  for (const normalizeFirst of [false, true]) {
    const original = packageConfig().build;
    const build = normalizeFirst ? Content.applyBuildPolicy(doMergeConfigs([original])) :
      doMergeConfigs([Content.applyBuildPolicy(original)]);
    const packager = { info: { projectDir: projectRoot, buildResourcesDir: "build", config: build,
      isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
    const matchers = getMainFileMatchers(projectRoot, "/packaged-app", value => value, build.mac, packager,
      path.join(projectRoot, build.directories.output), false);
    assert.equal(matchers.length, 1, "Only the launcher source FileSet is present; Android metadata comes from its sealed Builds helper");
    for (const relative of [".local", "game_tests", "docs", "scripts", ".local/runtime/file.js",
      "game_tests/runtime/file.js", "docs/README.md", "src/modules/example/tests/probe.js"]) {
      for (const directory of [false, true]) {
        assert.equal(matchers.some(matcher => matcher.createFilter()(path.join(projectRoot, relative),
          { isDirectory: () => directory })), false, `Excluded input selected: ${relative}`);
      }
    }
    for (const relative of ["src/main/bootstrap.js", "dist/renderer/index.html", "package.json", "LICENSE"])
      assert.equal(matchers.some(matcher => selectedBy(matcher, relative)), true, `Application input excluded: ${relative}`);
  }
});

test("source-directory aliases and live Android source mappings are excluded", () => {
  const build = Content.applyBuildPolicy(doMergeConfigs([packageConfig().build]));
  const packager = { info: { projectDir: projectRoot, buildResourcesDir: "build", config: build,
    isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
  const matchers = getMainFileMatchers(projectRoot, "/packaged-app", value => value, build.mac, packager,
    path.join(projectRoot, build.directories.output), false);
  const application = matchers.find(matcher => matcher.from === projectRoot);
  const aliases = ["src/resources", "src/external", "src/renderer", "src/modules/bgi/native",
    "src/modules/shared/reshade/native", "src/modules/shared/reshade/neural/native",
    "src/modules/renpy/resources/unren", "src/modules/renpy/resources/universal-renpy-walkthrough",
    "src/modules/android/native", "src/modules/android/art/boot-image-driver.rs",
    ...["native", "java", "adapters", "licenses", "tools", "composer", "graphics", "sensors"]
      .map(name => "src/modules/android/art/" + name)];
  for (const alias of aliases) {
    assert.equal(selectedBy(application, alias), false, `Build-source symlink selected: ${alias}`);
    if (!alias.endsWith(".rs")) assert.equal(selectedBy(application, alias + "/source.c"), false, `Build-source child selected: ${alias}`);
  }
  assert.equal(matchers.some(matcher => matcher.from.endsWith("src/external/maclauncher-android")), false);
  assert.equal(build.files.some(rule => typeof rule === 'object' && rule.from?.includes('maclauncher-android')), false);
  assert.equal(fs.existsSync(path.join(projectRoot,'src/android-runtime')),false,'The old mapped Android source tree is absent');
  assert.equal(matchers.some(matcher => selectedBy(matcher,'src/external/maclauncher-android/src/modules/android/apk.js')),false);

});

test("Android source exporters remain excluded from actual ASAR files while metadata uses a sealed resource package", async t => {
  const asar = require("@electron/asar"), Check = require("../scripts/check-packaging.cjs");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "android-source-alias-package-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const source = path.join(root,"source"), stage = path.join(root,"stage"), config = packageConfig();
  const put = (file, text = "module.exports = {};") => {const target = path.join(source,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
  put("package.json",JSON.stringify({name:config.name,version:config.version,productName:config.build.productName,main:config.main}));
  for (const file of ["dist/renderer/index.html","src/main/bootstrap.js","src/modules/android/runtime-source.js",
    "src/modules/android/provider-main.js","src/modules/example/source-loader.mjs"]) put(file);
  const canonical = "src/external/maclauncher-android";
  const plan = require('../scripts/distribution-model.cjs').createPlan({arch:'arm64', maximumMacOS:'26.0'});
  const helper = plan.supplementals.find(item => item.id === 'android-launcher');
  assert.ok(helper, 'The Android metadata closure has a declared Builds helper');
  const inputs = helper.files.filter(file => file.path.startsWith('files/runtime/'));
  assert.equal(inputs.length, 12);
  for (const file of inputs) put(canonical+"/"+file.path.slice('files/runtime/'.length));
  const aliases = ["source-archive.mjs","source-hwui.mjs"].map(name => "src/modules/android/art/"+name);
  for (const alias of aliases) {put(canonical+"/"+alias);fs.mkdirSync(path.dirname(path.join(source,alias)),{recursive:true});fs.symlinkSync("../../../external/maclauncher-android/"+alias,path.join(source,alias));}
  const matchersFor = build => {
    build = Content.applyBuildPolicy(doMergeConfigs([structuredClone(build)]));
    const info = {projectDir:source,buildResourcesDir:"build",config:build,isPrepackedAppAsar:false,debugLogger:{isEnabled:false}};
    return getMainFileMatchers(source,stage,value=>value,build.mac,{info},path.join(source,build.directories.output),false);
  };
  // Reproduce the former normalized selection against actual aliases: ASAR
  // retains the link but its source-only canonical target was never selected.
  const previous = structuredClone(config);previous.build.files = previous.build.files.map(row => typeof row === "string" ? row.replace(",source-archive,source-hwui,",",") : row);
  const oldMain = matchersFor(previous.build).find(matcher => matcher.from === source);
  for (const alias of aliases) assert.equal(selectedBy(oldMain,alias),true);
  const walk = require("builder-util").walk;
  const before = path.join(root,"before.asar");await asar.createPackageFromFiles(source,before,await walk(source,oldMain.createFilter()));
  assert.throws(()=>Check.inspectAsar(before,{version:config.version,product:config.build.productName},{packageConfig:previous}),/link is missing its target/);
  // Apply the actual normalized launcher FileSet; the sealed helper stays outside ASAR.
  const selected = [];
  for (const matcher of matchersFor(config.build)) for (const file of await walk(matcher.from,matcher.createFilter())) {
    const destination = path.join(matcher.to,path.relative(matcher.from,file));
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(file,destination);selected.push(path.relative(stage,destination));
  }
  for (const alias of aliases) assert.equal(selected.includes(alias),false);
  for (const file of ["src/modules/android/runtime-source.js","src/modules/android/provider-main.js","src/modules/example/source-loader.mjs",
    ]) assert.ok(selected.includes(file),file);
  assert.equal(selected.some(file=>file.startsWith("src/android-runtime/")),false);
  const rule = require("../scripts/distribution-model.cjs").resourceRules(plan).find(rule=>rule.from==="src/resources");
  const resourceMatcher = new FileMatcher(path.join(projectRoot,rule.from),"/resources",value=>value,rule.filter);
  for(const file of inputs) {
    assert.equal(selectedBy(resourceMatcher,"native-runtimes/"+helper.directoryRelative+"/"+file.path),true);
    assert.equal(require("../src/modules/shared/runtime/bundled-native").digest(fs.readFileSync(path.join(projectRoot,"src/resources/native-runtimes",helper.directoryRelative,file.path))),file.sha256);
  }
  assert.equal(selected.some(file=>file.startsWith("src/external/")),false);
  const after = path.join(root,"after.asar");await asar.createPackage(stage,after);
  assert.equal(Check.inspectAsar(after,{version:config.version,product:config.build.productName},{packageConfig:config}).archiveLinks,0);
});
test("late root FileSet exclusions survive Builder merging and npm filters retain runtime entry points", () => {
  const input = packageConfig().build, flash = '!src/modules/flash/resources/flash-player{,/**}';
  input.files = input.files.filter(pattern => pattern !== flash); input.files.push(flash);
  for (const normalizeFirst of [false, true]) {
    const build = normalizeFirst ? Content.applyBuildPolicy(doMergeConfigs([structuredClone(input)])) :
      doMergeConfigs([Content.applyBuildPolicy(structuredClone(input))]);
    const info = { projectDir: projectRoot, buildResourcesDir: 'build', config: build,
      isPrepackedAppAsar: false, debugLogger: { isEnabled: false } };
    const matchers = getMainFileMatchers(projectRoot, '/stage', value => value, build.mac, { info }, path.join(projectRoot, build.directories.output), false);
    for (const relative of ['src/modules/flash/resources/flash-player', 'src/modules/flash/resources/flash-player/Flash Player.app/Contents/MacOS/Flash Player'])
      assert.equal(matchers.some(m => selectedBy(m, relative)), false, relative);
    const modules = getNodeModuleFileMatcher(projectRoot, '/stage', value => value, build.mac, info);
    for (const relative of ['node_modules/undici/docs/docs/api/Socks5ProxyAgent.md', 'node_modules/smart-buffer/docs/README_v3.md', 'node_modules/steam-session/src/LoginSession.ts',
      'node_modules/bytebuffer/dist/bytebuffer.min.js.gz', 'node_modules/bytebuffer/dist/bytebuffer-dataview.min.js.gz', 'node_modules/long/dist/long.min.js.gz',
      'node_modules/react/index.js', 'node_modules/react/cjs/react.production.js', 'node_modules/react-dom/client.js', 'node_modules/scheduler/cjs/scheduler.production.js'])
      assert.equal(selectedBy(modules, relative), false, relative);
    for (const relative of ['src/modules/flash/runtime/projector-manager.js', 'src/modules/flash/resources/icon.png'])
      assert.equal(matchers.some(m => selectedBy(m, relative)), true, relative);
    for (const relative of ['node_modules/steam-session/dist/index.js', 'node_modules/steam-session/dist/LoginSession.js', 'node_modules/steam-session/package.json',
      'node_modules/steam-session/LICENSE', 'node_modules/undici/index.js', 'node_modules/undici/lib/dispatcher/client.js', 'node_modules/undici/lib/llhttp/llhttp_simd.wasm',
      'node_modules/undici/LICENSE', 'node_modules/smart-buffer/build/smartbuffer.js', 'node_modules/bytebuffer/dist/bytebuffer-node.js',
      'node_modules/long/dist/long.js', ...['react','react-dom','scheduler'].flatMap(name => ['LICENSE','package.json'].map(file => 'node_modules/'+name+'/'+file))])
      assert.equal(selectedBy(modules, relative), true, relative);
  }
});
test('the production renderer bundles React without external Node runtime imports', async () => {
  const { build } = await import('vite');
  const result = await build({ configFile: path.join(projectRoot, 'vite.config.mjs'), logLevel: 'silent',
    build: { write: false, emptyOutDir: false } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => output.output || []);
  const chunks = outputs.filter(output => output.type === 'chunk');
  assert.ok(chunks.some(output => output.code.includes('react.transitional.element')), 'The renderer contains its React runtime');
  assert.ok(chunks.some(output => output.code.includes('createRoot')), 'The renderer contains its DOM root implementation');
  for (const chunk of chunks) {
    assert.ok(![...chunk.imports,...chunk.dynamicImports].some(name => /^(?:react(?:-dom)?|scheduler)(?:\/|$)/.test(name)));
    assert.doesNotMatch(chunk.code, /(?:require\s*\(|from\s*|import\s*\()['"](?:react(?:-dom)?|scheduler)(?:\/|['"])/);
  }
});
test('source-only helper producers and Python SDK inputs are omitted while consumed source contracts and runtime modules remain', () => {
  const plan = require('../scripts/distribution-model.cjs').createPlan({ arch: 'arm64', maximumMacOS: '13.0' });
  const build = Content.applyBuildPolicy(doMergeConfigs([packageConfig().build]));
  const info = { projectDir: projectRoot, buildResourcesDir: 'build', config: build, isPrepackedAppAsar: false, debugLogger: { isEnabled: false } };
  const matchers = getMainFileMatchers(projectRoot, '/stage', value => value, build.mac, { info }, path.join(projectRoot, build.directories.output), false);
  for (const file of ['src/modules/rgss/overlays/mkxpz-config.c', 'src/modules/rgss/overlays/mkxpz-identity.m',
    'src/modules/rgss/overlays/mkxpz-filename-nfc/macos-filename-nfc.c', 'src/modules/rgss/overlays/mkxpz-filename-nfc/macos-filename-nfc.h',
    'src/modules/shared/runtime/steamworks/native/offline-0.5.0/source/offline.cpp', 'src/modules/shared/runtime/steamworks/native/ticket-0.1.0/source/ticket.cpp',
    'src/modules/shared/runtime/steamworks/native/offline-0.5.0/build.cjs', 'src/modules/shared/runtime/steamworks/native/ticket-0.1.0/build.cjs'])
    assert.equal(matchers.some(m => selectedBy(m, file)), false, file);
  for (const file of ['src/modules/siglus/native/adapter.m', 'src/modules/siglus/native-host/host.m',
    'src/modules/nscripter/runtime/portable-native/CMakeLists.txt', 'src/modules/shared/runtime/steamworks/native/offline-0.5.0/contracts.json',
    'src/modules/minori/runtime/probe.rs', 'src/modules/mages/native/ffmpeg-probe.c'])
    assert.equal(matchers.some(m => selectedBy(m, file)), true, file);
  const resource = require('../scripts/distribution-model.cjs').resourceRules(plan).find(r => r.from === 'src/resources');
  const matcher = new FileMatcher(path.join(projectRoot, resource.from), '/resources', value => value, resource.filter);
  for (const file of ['python/bin/python3', 'python/lib/python3.12/ctypes/__init__.py',
    'python/lib/python3.12/site-packages/pefile.py', 'python/lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so', '7zip/7zz'])
    assert.equal(selectedBy(matcher,file),true,'Original stock helper input excluded: '+file);
  for (const file of ['python/bin/python', 'python/bin/python3.12', 'python/lib/libpython3.12.dylib',
    'python/include/Python.h', 'python/lib/python3.12/ensurepip/__init__.py', 'python/lib/python3.12/site-packages/pip/__main__.py',
    'RPGMakerDecrypter/RPGMakerDecrypter-cli'])
    assert.equal(selectedBy(matcher,file),false,'Development input or raw custom helper selected: '+file);
  const B = require('../src/modules/shared/runtime/bundled-native');
  for (const [id,suffixes] of [['steam-api-helper',['libsteam_api.dylib']]]) {
    const helper = plan.supplementals.find(item=>item.id===id); assert.ok(helper,id);
    for(const suffix of suffixes) {
      const record=helper.files.find(file=>file.path===suffix); assert.ok(record,suffix);
      const relative='native-runtimes/'+helper.directoryRelative+'/'+record.path;
      assert.equal(selectedBy(matcher,relative),true,relative);
      assert.equal(B.digest(fs.readFileSync(path.join(projectRoot,'src/resources',relative))),record.sha256,relative);
    }
    assert.equal(helper.files.some(file=>/\/(?:include|ensurepip|pip)(?:\/|$)|\/config-3\.12-darwin\//.test(file.path)),false,'SDK and installer inputs stay out of the helper');
  }
  for (const id of ['python','sevenzip','evbunpack','rpgmaker-decrypter','gamemaker-opengl-helper','innoextract']) assert.equal(plan.supplementals.some(item=>item.id===id),false,id);
  const upstream = require('../scripts/distribution-model.cjs').resourceRules(plan).find(rule=>rule.from==='src/external');
  const upstreamMatcher = new FileMatcher(path.join(projectRoot,upstream.from),'/resources/external',value=>value,upstream.filter);
  assert.equal(selectedBy(upstreamMatcher,'evbunpack/evbunpack/__main__.py'),true);
  assert.equal(selectedBy(upstreamMatcher,'evbunpack/LICENSE'),true);

});

test("first-party fixtures and managed engines stay out of ASAR while declared helpers remain selected", () => {
  const {build}=packageConfig();
  const packager={info:{projectDir:projectRoot,buildResourcesDir:"build",config:build,
    isPrepackedAppAsar:false,debugLogger:{isEnabled:false}}};
  const matchers=getMainFileMatchers(projectRoot,"/packaged-app",value=>value,build.mac,packager,
    path.join(projectRoot,build.directories.output),false);
  const selected=relative=>matchers.some(matcher=>selectedBy(matcher,relative));
  for(const file of ["tests/core-launcher.test.js","tests/fixtures/graphics/probe.mm",
    "src/modules/shared/reshade/native/test/temporal-plan.mm","src/modules/shared/reshade/native/opengl-test.mm",
    "src/modules/shared/reshade/native/depth-opengl-test.fx","src/modules/shared/reshade/temporal/fsr/projection-test.mjs",
    "src/modules/crossover/temporal/dxmt/forwarder-test.c","src/modules/crossover/temporal/dxmt/test.mjs",
    "src/modules/crossover/temporal/streamline/test-forwarders.mjs","src/modules/crossover/temporal/streamline/camera-test.cpp",
    "src/modules/shared/reshade/native/effects-plan.mm","src/modules/shared/reshade/native/build.mjs",
    "src/modules/shared/reshade/neural/native/Package.swift","src/modules/shared/reshade/neural/build.mjs",
    "src/modules/shared/reshade/libplacebo-build.mjs",
    "src/modules/shared/reshade/xess/native/host.cpp","src/modules/shared/reshade/xess/native/host-vulkan.cpp",
    "src/modules/shared/reshade/xess/native/build.mjs","src/modules/shared/reshade/xess/native/vulkan-source.json",
    "src/modules/shared/reshade/isf/CMakeLists.txt","src/modules/shared/reshade/isf/build.mjs",
    "src/modules/shared/reshade/isf/isolate-compiler.mjs","src/modules/shared/reshade/isf/provider.mm",
    "src/modules/shared/reshade/generation/fsr3/backend.mm","src/modules/shared/reshade/generation/fsr3/metal-backend.hpp",
    "src/modules/shared/reshade/generation/fsr3/build.mjs",
    "src/renderer/src/App.tsx","src/renderer/public/icon.png","src/modules/shared/reshade/plan.d.mts",
    "src/renderer/__tests__/controls.test.tsx","src/core/fixtures/launch.json","src/runtime/player.spec.js"])
    assert.equal(selected(file),false,`Test-only application input included: ${file}`);
  for(const file of ["src/core/launcher.js","src/modules/shared/reshade/index.js",
    "src/modules/shared/reshade/features.json","src/modules/shared/reshade/effects/crt.fx",
    "src/modules/shared/reshade/xess/index.js","src/modules/shared/reshade/xess/library.js",
    "src/modules/shared/reshade/xess/source.json","src/modules/shared/reshade/xess/INTEL-LICENSE.txt",
    "src/modules/shared/reshade/isf/index.js","src/modules/shared/reshade/isf/source.json",
    "src/modules/shared/reshade/generation/fsr3/index.js","src/modules/shared/reshade/generation/fsr3/source.json",
    "src/modules/shared/reshade/shader-collection/crt-royale/Shaders/crt-royale/lib/special-functions.fxh",
    "src/modules/android/included-files.js","src/modules/rgss/evb-files.py",
    "src/modules/shared/installers/native/inno-inspect.cpp","src/modules/bgi/inspect.js"])
    assert.equal(selected(file),true,`Runtime or developer input unintentionally excluded: ${file}`);
  for(const file of ['src/modules/android/providers/aim/resources/maclauncher-aim',
    'src/modules/siglus/resources/native-host/macos-universal/siglus-host','src/modules/siglus/resources/rlvm-adapter/rlvm-adapter.dylib',
    'src/modules/vnds/resources/0.0.13-838e47b-mac-v1/main.lua','src/modules/kirikiri/resources/kag3-polyfill/KAGParser.tjs'])
    assert.equal(selected(file),false,'Managed adaptation included in ASAR: '+file);
  const distribution=require('../scripts/distribution-model.cjs'),plan=distribution.createPlan({arch:'arm64',maximumMacOS:'26.0'});
  const resource=distribution.resourceRules(plan).find(item=>item.from==='src/resources');
  const resources=new FileMatcher(path.join(projectRoot,resource.from),'/resources',value=>value,resource.filter);
  for(const helper of plan.supplementals) {
    assert.equal(helper.files.some(file=>/(?:^|\/)source\.tar\.gz$/.test(file.path)),false,'Corresponding source stays in Builds source: '+helper.id);
    for(const file of [helper.files.find(file=>file.path===helper.manifestRelative),...helper.notices.map(notice=>helper.files.find(file=>file.path===notice.path))]) {
      assert.ok(file); assert.equal(selectedBy(resources,'native-runtimes/'+helper.directoryRelative+'/'+file.path),true);
      assert.match(file.sha256,/^[a-f0-9]{64}$/);
    }
  }

});

test("managed Android runtime payloads are excluded while owned integration helpers remain included", () => {
  const distribution = require('../scripts/distribution-model.cjs');
  const plan = distribution.createPlan({arch:'arm64', maximumMacOS:'26.0'});
  const managed = new Set(['android', 'android-art', 'android-aim']);
  assert.equal(plan.packages.some(item => managed.has(item.managerId)), false);
  assert.equal(plan.supplementals.some(item => managed.has(item.id)), false);
  const helper = plan.supplementals.find(item => item.id === 'android-privacy');
  assert.ok(helper);
  const development = JSON.parse(fs.readFileSync(path.join(projectRoot,'src/modules/android/managed-packages.json')));
  const original = development.find(item => item.id === 'android-privacy');
  const locked = require('../build/runtime-packages.json').packages.find(item => item.id === 'android-privacy');
  assert.equal(helper.version, locked.version); assert.equal(helper.manifestSha256, locked.manifestSha256);
  assert.equal(helper.sourceSha256, original.sourceSha256);
  assert.deepEqual(helper.files.find(file => file.path === 'clipboard-helper'), original.files.find(file => file.path === 'clipboard-helper'));
  assert.deepEqual(helper.notices, original.notices, 'Native helper bytes and license declarations survive the binary-only projection');
  const planned = distribution.resourceRules(plan,Content.applyBuildPolicy(doMergeConfigs([packageConfig().build])).extraResources).find(item => item.from === 'src/resources');
  const matcher = new FileMatcher(path.join(projectRoot,planned.from),'/packaged-resources',value=>value,planned.filter);
  for (const id of managed) for (const file of ['runtime.json','manifest.json','source.tar.gz','files/source.tar.gz','native/libklepton-jvm.dylib','art/host/linux-run','files/bin/aimctl'])
    assert.equal(selectedBy(matcher,`native-runtimes/${id}/version/arm64/${file}`),false,`Managed Android payload included: ${id}/${file}`);
  assert.equal(selectedBy(matcher,`native-runtimes/${helper.directoryRelative}/${helper.manifestRelative}`),true);

  assert.equal(planned.filter.some(pattern => !pattern.startsWith('!') && /^native-runtimes\/(android|android-art|android-aim)\//.test(pattern)), false);
});

test("planned resources retain stock suppliers and sealed custom helpers while excluding managed and local payloads", () => {
  const pkg=packageConfig(),Model=require('../scripts/distribution-model.cjs');
  const plan=Model.createPlan({arch:'arm64',maximumMacOS:'26.0'});
  const resources=Model.resourceRules(plan,Content.applyBuildPolicy(doMergeConfigs([pkg.build])).extraResources).find(item=>item.from==='src/resources');
  assert.ok(resources);const matcher=new FileMatcher(path.join(projectRoot,resources.from),'/resources',value=>value,resources.filter);
  assert.equal(selectedBy(matcher,'maclauncher.png'),true);
  for(const file of ['7zip/7zz','7zip/LICENSE.txt','python/bin/python3','python/lib/python3.12/ctypes/__init__.py'])
    assert.equal(selectedBy(matcher,file),true,file);
  for(const id of ['steam-api-helper']) {
    const helper=plan.supplementals.find(item=>item.id===id);assert.ok(helper,id);
    for(const file of helper.files)assert.equal(selectedBy(matcher,'native-runtimes/'+helper.directoryRelative+'/'+file.path),true,file.path);
  }
  for(const file of ['7zip/.env.local','RPGMakerDecrypter/RPGMakerDecrypter-cli','python/bin/python3-config',
    'native-runtimes/obsolete/1.0/arm64/manifest.json','native-runtimes/mkxpz/version/arm64/files/bin/runner',
    'native-runtimes/vnds-love/version/universal/engine/main.lua','native-runtimes/android-aim/version/arm64/bin/aimctl',
    'python-old-fixture/bin/python3','unapproved-payload/private.json','python/.env.local'])
    assert.equal(selectedBy(matcher,file),false,'Unlisted or managed payload selected: '+file);
  const sample=plan.supplementals[0];
  for(const suffix of ['.env.local','.local/config.json','.git/config','localconfig.json','build.log','session.har','__pycache__/tool.pyc'])
    assert.equal(selectedBy(matcher,'native-runtimes/'+sample.directoryRelative+'/'+suffix),false,suffix);
});

test("application packaging preserves code and artwork while excluding local files", () => {
  const { build } = packageConfig();
  const packager = { info: { projectDir: projectRoot, buildResourcesDir: "build", config: build,
    isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
  const matchers = getMainFileMatchers(projectRoot, "/packaged-app", value => value, build.mac, packager,
    path.join(projectRoot, build.directories.output), false);
  const selected = relative => matchers.some(matcher => selectedBy(matcher, relative));
  for (const file of ["src/main/bootstrap.js", "src/modules/core/launcher.js", "src/runtime/electron-game.js",
    "src/modules/bgi/main.js", "src/modules/bgi/archive.js", "src/modules/bgi/inspect.js",
    "src/modules/rgss/resources/icon.png", "src/modules/rgss/runtime/mkxpz-builds.js",
    "src/modules/rgss/resources/soundfont/GMGSx.SF2", "src/modules/rgss/assets.js", "src/modules/rgss/rtp.js",
    "dist/renderer/index.html", "package.json", "LICENSE"])
    assert.equal(selected(file), true, `Application file excluded: ${file}`);
  for (const file of [".local/example/private.json", "src/modules/example/.local/private.json", "src/modules/example/.env.local",
    "src/modules/example/localconfig.json", "src/modules/example/build.log", "src/modules/example/__pycache__/tool.pyc",
    "src/resources/python/bin/python3", "src/external/example/vendor.js", "src/modules/rgss/resources/mkxpz/runtime.app/Contents/MacOS/runner",
    "src/modules/rgss/resources/rtp/Standard/Audio/BGM/sample.mid",
    "src/modules/rgss/resources/rtp/RPGVX/Graphics/Characters/sample.png",
    "src/modules/rgss/resources/rtp/RPGVXAce/Fonts/VL-Gothic-Regular.ttf",
    "src/modules/bgi/native/probe-main.c", "src/modules/bgi/native/build.js", "src/modules/bgi/native/versions/probe-v1/vm-guards.c",
    "docs/README.md", "scripts/dev.mjs"])
    assert.equal(selected(file), false, `Local or separately packaged file included: ${file}`);
});

test("all directory resource rules exclude local configuration and generated diagnostics", () => {
  for (const resource of packageConfig().build.extraResources) {
    const matcher = new FileMatcher(path.join(projectRoot, resource.from), "/packaged-resources", value => value, resource.filter);
    const base = resource.from === "src/resources" ? "native-runtimes/engine" :
      resource.from === "src/external" ? "evbunpack" : resource.from.endsWith("unren") ? "third_party/rpatool" : "__urw";
    for (const suffix of [".env", ".env.local", ".local/private.json", "localconfig.json", "build.log", "session.har", "__pycache__/tool.pyc"]) {
      const file = `${base}/${suffix}`;
      assert.equal(selectedBy(matcher, file), false, `Private artifact selected by ${resource.from}: ${suffix}`);
    }
  }
});

test("MVMZ and Kawariki patch inputs are bundled without a separate runtime manager", () => {
  const pkg=packageConfig(),external=pkg.build.extraResources.find(rule=>rule.from==='src/external');
  assert.ok(external);
  const matcher=new FileMatcher(path.join(projectRoot,external.from),'/packaged-resources/external',value=>value,external.filter);
  for(const file of ['evbunpack/evbunpack/__init__.py','evbunpack/LICENSE',
    'rpgmakermlinux-cicpoffs/Kawariki-patches/preload.rb',
    'rpgmakermlinux-cicpoffs/nwjs/packagefiles/rpgmaker-mv-pixi5/js/rpg_core.js',
    'rpgmakermlinux-cicpoffs/nwjs/packagefiles/filestoexport/plugins/Clipboard_llule.js',
    'rpgmakermlinux-cicpoffs/nwjs/nwjs/packagefiles/plugins/CustomizeMaxSaveFile.js'])
    assert.equal(selectedBy(matcher,file),true,file);
  assert.ok(!pkg.build.files.includes('!src/modules/rgss/overlays/kawariki{,/**}'));
  assert.ok(!pkg.build.files.includes('!src/modules/shared/mvmz/plugins{,/**}'));
  assert.ok(!require('../src/modules/mv/main').runtimeManagers.some(item=>item.id==='nwjs-adaptations'));
  const version=require('../src/modules/mv/libs/catalog').getVersion('mv-pixi','pixi5-cicpoffs');
  assert.ok(fs.existsSync(path.join(version.bundleRoot,'js/rpg_core.js')));
  assert.equal(version.packageId,undefined);
});

test("VNDS interpreter retains its ordinary managed requirement", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vnds-managed-resource-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const requirement=require('../src/modules/vnds/main').getRuntimeRequirements({}, {userDataDir:root,settings:{}});
  assert.equal(requirement.length,1);assert.equal(requirement[0].managerId,'vnds-love');assert.equal(requirement[0].requiresDownload,true);
});

test("Flash Player is excluded from app files and unpacked resources", () => {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const asarUnpack = Array.isArray(pkg?.build?.asarUnpack) ? pkg.build.asarUnpack : [];

  assert.ok(!asarUnpack.some(pattern => pattern.includes("flash-player")));
  assert.ok(pkg.build.files.includes("!src/modules/flash/resources/flash-player{,/**}"));
});

test("Builder preserves existing signatures of unpacked native helpers without skipping app signing", async () => {
  const { MacTargetHelper } = require("app-builder-lib/out/mac/MacTargetHelper");
  const helper = new MacTargetHelper({ config: { electronVersion: packageConfig().devDependencies.electron } });
  helper.getOptionsForFile = async () => () => ({});
  const app = "/application/MacLauncher.app";
  const options = await helper.buildSignOptions(app, { name: "-" }, "distribution", false,
    packageConfig().build.mac, undefined, require("builder-util").Arch.arm64);
  assert.deepEqual(packageConfig().build.mac.signIgnore,['native-runtimes/']);
  const plan=require('../scripts/distribution-model.cjs').createPlan({arch:'arm64',maximumMacOS:'26.0'});
  for(const id of ['steam-api-helper']) {
    const helper=plan.supplementals.find(item=>item.id===id),file=helper.files.find(file=>file.architectures);
    assert.ok(file,id);assert.equal(options.ignore(app+'/Contents/Resources/native-runtimes/'+helper.directoryRelative+'/'+file.path),true,id);
  }
  for(const relative of ['7zip/7zz','python/bin/python3','python/lib/python3.12/lib-dynload/_ctypes.cpython-312-darwin.so'])
    assert.equal(options.ignore(app+'/Contents/Resources/'+relative),false,'Stock helper must retain normal app signing: '+relative);
  for(const file of ['src/modules/siglus/resources/native-host/macos-universal/siglus-host','src/modules/android/providers/aim/resources/maclauncher-aim'])
    assert.equal(options.ignore(app+'/Contents/Resources/app.asar.unpacked/'+file),false,'Removed app-native exception remains active: '+file);
  assert.equal(options.ignore(app+'/Contents/Resources/native-runtimes-other/helper'),false);
  assert.equal(options.ignore(app), false);
  assert.equal(options.ignore(`${app}/Contents/MacOS/MacLauncher`), false);
  assert.equal(options.ignore(`${app}/Contents/Frameworks/Electron Framework.framework/Electron Framework`), false);
});

test("MacLauncher ships a valid macOS icon and a 1024px Dock raster", () => {
  const root = path.resolve(__dirname, '..');
  const icns = fs.readFileSync(path.join(root, 'build', 'icon.icns'));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const png = fs.readFileSync(path.join(root, 'src', 'resources', 'maclauncher.png'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.ok(fs.existsSync(path.join(root, 'src', 'renderer', 'src', 'ui', 'assets', 'maclauncher.svg')));
});
