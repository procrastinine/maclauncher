const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Host = require("../src/modules/android/host");
const { runtimeProfile } = require("../src/modules/android/profile");

test("Android process history records real child completion and stays bounded inside its container", async t => {
  const History=require('../src/modules/android/process-history'),{spawn}=require('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-exits-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'app');fs.mkdirSync(directory);
  const history=History.open(directory,'owned.history');assert.equal(history.json,'[]');
  const child=spawn(process.execPath,['-e','process.exit(7)'],{stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{
    try{history.recordExit({pid:child.pid,uid:process.getuid?.()??0,processName:'owned.history',code,signal});resolve();}catch(error){reject(error);}
  });});
  let records=JSON.parse(History.open(directory,'owned.history').json);
  assert.equal(records.length,1);assert.equal(records[0].pid,child.pid);assert.equal(records[0].status,7);assert.equal(records[0].reason,1);
  history.recordExit({pid:123,uid:501,processName:'owned.history',code:null,signal:'SIGBUS'});
  records=JSON.parse(History.open(directory,'owned.history').json);
  assert.equal(records[0].reason,2);assert.equal(records[0].status,7,'Darwin SIGBUS is translated to its Android signal number');
  for(let i=0;i<40;i++)history.recordExit({pid:124+i,uid:501,processName:'owned.history',code:0,signal:null});
  records=JSON.parse(History.open(directory,'owned.history').json);assert.equal(records.length,32);
  assert.ok(fs.statSync(path.join(directory,'process-exits.json')).size<=8192);
  assert.throws(()=>History.open(directory,'other.app'),/identity/);
  fs.renameSync(directory,path.join(root,'old'));fs.mkdirSync(directory);
  assert.throws(()=>history.recordExit({pid:999,uid:501,processName:'owned.history',code:0,signal:null}),/storage changed/);
  fs.symlinkSync(path.join(root,'old/process-exits.json'),path.join(directory,'process-exits.json'));
  assert.throws(()=>History.open(directory,'owned.history'));
});

function managerFixture(installed) {
  const calls = [];
  const host = { line: 21, variant: "arm64", version: "21.0.9+10", javaPath: "/java/bin/java", installDir: "/java" };
  const manager = { id: "java", core: { java: { resolveBestInstalled(options) { calls.push(["resolve", options]); return installed ? host : null; } } },
    normalizeSettings: () => ({ lines: { 21: { defaultVersion: null } } }),
    refreshCatalog: async () => calls.push(["refresh"]),
    getState: () => ({ sections: [{ id: "21", catalog: { versions: [host.version] } }] }),
    installRuntime: async options => { calls.push(["install", options]); installed = true; } };
  const context = { userDataDir: "/state", settings: {}, useRuntime: async identity => calls.push(["lease", identity]) };
  return { manager, context, calls, host };
}

test("Android launch wire size includes UTF-8 bytes and newline for every profile", () => {
  const prepared = { metadata: { packageName: "org.example.game", versionName: "v".repeat(16384),
    launchers: [{ activity: "org.example.Main" }] }, assetsRoot: "" };
  const entry = { name: "t".repeat(16384) }, payload = { root: "/" + "r".repeat(16383), profile: {} };
  const make = () => Host.launchConfig(entry, prepared, payload, {});
  const padding = 65536 - Buffer.byteLength(JSON.stringify(make()) + "\n");
  assert.ok(padding > 0 && padding < 16384);
  prepared.assetsRoot = "a".repeat(padding);
  assert.equal(Buffer.byteLength(JSON.stringify(make()) + "\n"), 65536);
  prepared.assetsRoot += "a";
  assert.throws(make, /configuration exceeds/);
  prepared.assetsRoot = "a".repeat(padding - 1) + "é";
  assert.throws(make, /configuration exceeds/, "Byte length differs from character count");
});

test("Android presenter selects its actual core while retaining auxiliary injection adapters", t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"android-presenter-core-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const core=path.join(root,"libreshade-macos.dylib"), audio=path.join(root,"audio.dylib"), alias=path.join(root,"core-alias");
  fs.writeFileSync(core,"processor");fs.writeFileSync(audio,"audio");fs.symlinkSync(core,alias);
  t.mock.method(require("../src/modules/shared/reshade"),"runtimeRoot",()=>root);
  const graphics={DYLD_INSERT_LIBRARIES:audio+":"+alias,RESHADE_EXPLICIT_HOST:"1"};
  const prepared={metadata:{packageName:"example",launchers:[{activity:"example.Main"}]}};
  const config=Host.launchConfig({},prepared,{root:"/runtime",profile:{}},{},graphics);
  assert.equal(config.graphicsLibrary,core);assert.equal(graphics.DYLD_INSERT_LIBRARIES,audio+":"+alias);
  assert.throws(()=>Host.launchConfig({},prepared,{root:"/runtime",profile:{}},{},
    {...graphics,DYLD_INSERT_LIBRARIES:audio+":/unavailable.dylib"}),/ENOENT/);
});

test("Android launch delegates manifest metadata to the original package parser", () => {
  const metadata={packageName:"org.example.game",launchers:[{activity:"org.example.game.Main"}],
    applicationClass:"bad custom interpretation",applicationFlags:"unknown",targetSdk:"future",
    applicationMetadataInspected:false,applicationComponentsInspected:false,applicationActivitiesInspected:false,
    applicationMetadata:Object.fromEntries(Array.from({length:400},(_,i)=>["value"+i,{type:"int",value:i}]))};
  const config=Host.launchConfig({}, {metadata,sourceApk:"/private/game/base.apk"}, {root:"/runtime",profile:{}}, {});
  assert.equal(config.activityClass,"org.example.game.Main");
  assert.equal(config.sourceApk,"/private/game/base.apk");
  for(const name of ["applicationClass","targetSdk","applicationFlags","applicationMetadataJson","applicationProvidersJson","applicationServicesJson","applicationActivitiesJson","activityMetadataJson"])
    assert.equal(Object.hasOwn(config,name),false,"Runtime reads "+name+" from the original APK");
});

test("Android staging preserves declared contracts and rejects incomplete component support", () => {
  const pins = { version: "0.1.0", javaMajor: 21, applicationMetadataVersion: 1,
    applicationMetadataEntriesVersion: 1, canvasPresentationVersion: 1 };
  assert.deepEqual(runtimeProfile(pins), { id: "klepton-jvm-0.1.0-arm64", javaMajor: 21,
    nativeLoadTarget: "maclauncher.android.bridge.GuestNativeLoader", applicationMetadataVersion: 1,
    applicationMetadataEntriesVersion: 1, canvasPresentationVersion: 1 });
  const next = { ...pins, applicationMetadataVersion: 1, applicationMetadataEntriesVersion: 1, applicationComponentsVersion: 1 };
  assert.equal(runtimeProfile(next).applicationComponentsVersion, 1);
  assert.equal(runtimeProfile({ ...next, applicationInfoVersion: 1 }).applicationInfoVersion, 1);
  assert.equal(runtimeProfile({ ...next, activityMetadataVersion: 1 }).activityMetadataVersion, 1);
  assert.equal(runtimeProfile({ ...next, producerResolutionVersion: 1 }).producerResolutionVersion, 1);
  const platform={...next,frameworkBaseVersion:1,servicePackagesVersion:1,providerConnectionsVersion:1,processAuthorityVersion:1,platformServicesVersion:1};
  assert.equal(runtimeProfile(platform).platformServicesVersion,1);
  assert.throws(()=>runtimeProfile({...platform,processAuthorityVersion:undefined}),/platform services/);
  assert.throws(() => runtimeProfile({ ...next, producerResolutionVersion: 1, canvasPresentationVersion: undefined }), /render resolution/);
  assert.throws(() => runtimeProfile({ ...next, applicationInfoVersion: 2 }), /application identity/);
  for (const key of ["applicationMetadataVersion", "applicationMetadataEntriesVersion", "applicationComponentsVersion", "canvasPresentationVersion"])
    for (const value of [0, 2, "1", false])
      assert.throws(() => runtimeProfile({ ...next, [key]: value }), /Unsupported Android/);
  for (const key of ["applicationMetadataVersion", "applicationMetadataEntriesVersion"])
    assert.throws(() => runtimeProfile({ ...next, [key]: undefined }), /Unsupported Android/);
  const plain = runtimeProfile({ version: "0.1.0", javaMajor: 21 });
  assert.deepEqual(Object.keys(plain).sort(), ["id", "javaMajor", "nativeLoadTarget"]);
});

test("Android reuses and leases ARM Java 21 without fetching", async () => {
  const fixture = managerFixture(true);
  assert.equal(await Host.ensureJava(fixture.context, fixture), fixture.host);
  assert.deepEqual(fixture.calls.map(item => item[0]), ["resolve", "lease"]);
  assert.equal(fixture.calls[0][1].strictVariant, true);
  assert.equal(fixture.calls[0][1].line, 21);
  assert.equal(fixture.calls[1][1].variant, "arm64");
});

test("Android shared Java fallback preserves an unavailable saved preference", async () => {
  const fixture = managerFixture(true), chosen = "21.0.8+9";
  const settings = { lines: { 21: { defaultVersion: chosen } } };
  fixture.context.settings = { runtimes: { java: settings } };
  fixture.manager.normalizeSettings = value => value;
  fixture.manager.core.java.resolveBestInstalled = options => {
    fixture.calls.push(["resolve", options]);
    return options.version == null ? fixture.host : null;
  };
  assert.equal(await Host.ensureJava(fixture.context, fixture), fixture.host);
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === "resolve").map(([, options]) => options.version), [chosen, null]);
  assert.deepEqual(fixture.calls.map(([kind]) => kind), ["resolve", "resolve", "lease"]);
  assert.equal(settings.lines[21].defaultVersion, chosen, "Installed reuse does not rewrite the saved preference");
});

test("Android missing Java follows consent and cancellation before installation", async () => {
  const fixture = managerFixture(false);
  await assert.rejects(Host.ensureJava(fixture.context, { ...fixture, confirm: async () => { throw Error("canceled"); } }), /canceled/);
  assert.equal(fixture.calls.some(item => item[0] === "install"), false);
  const accepted = managerFixture(false);
  await Host.ensureJava(accepted.context, { ...accepted, confirm: async (_context, options) => {
    accepted.calls.push(["consent", options]);
  } });
  assert.deepEqual(accepted.calls.map(item => item[0]), ["resolve", "resolve", "refresh", "consent", "install", "resolve", "lease"]);
  assert.equal(accepted.calls.find(item => item[0] === "install")[1].version, accepted.host.version);
  assert.equal(accepted.calls.find(item => item[0] === "install")[1].variant, "arm64");
});

test("Android installed-only Java selection never refreshes or installs a missing runtime", async () => {
  const fixture = managerFixture(false);
  await assert.rejects(Host.ensureJava(fixture.context, { ...fixture, installedOnly: true }), /Java 21 is not installed/);
  assert.deepEqual(fixture.calls.map(item => item[0]), ["resolve", "resolve"]);
  const installed = managerFixture(true);
  assert.equal(await Host.ensureJava(installed.context, { ...installed, installedOnly: true }), installed.host);
  assert.deepEqual(installed.calls.map(item => item[0]), ["resolve", "lease"]);
});

test("Android missing saved Java choice installs that version after consent and preserves cancellation", async () => {
  for (const canceled of [true, false]) {
    const fixture = managerFixture(true), chosen = "21.0.8+9", selected = { ...fixture.host, version: chosen };
    fixture.context.settings = { runtimes: { java: { lines: { 21: { defaultVersion: chosen } } } } };
    fixture.manager.normalizeSettings = settings => settings;
    let installed = false;
    fixture.manager.core.java.resolveBestInstalled = options => {
      fixture.calls.push(["resolve", options]);
      return options.version === chosen && installed ? selected : null;
    };
    fixture.manager.refreshCatalog = async () => assert.fail("An explicit choice does not need automatic discovery");
    fixture.manager.installRuntime = async options => {
      assert.equal(options.version, chosen); installed = true;
    };
    const operation = Host.ensureJava(fixture.context, { manager: fixture.manager, confirm: async (_context, plan) => {
      assert.equal(plan.version, chosen);
      if (canceled) throw Error("canceled");
    } });
    if (canceled) await assert.rejects(operation, /canceled/);
    else assert.equal(await operation, selected);
    assert.equal(installed, !canceled);
    assert.deepEqual(fixture.calls.filter(([kind]) => kind === "resolve").map(([, options]) => options.version),
      canceled ? [chosen, null] : [chosen, null, chosen]);
    assert.equal(fixture.context.settings.runtimes.java.lines[21].defaultVersion, chosen);
  }
});

test("Android launch keeps metadata libraries outside the guest class path and uses shared explicit graphics", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = managerFixture(true), payload = { root, profile: { demandDexVersion: 1, angleVulkanVersion: 1 } };
  fs.writeFileSync(path.join(root, "android-host.jar"), "host");
  const entry = { gameId: "example", gamePath: path.join(root, "original.apk"), name: "Example" };
  const prepared = { metadata: { packageName: "org.example.game", versionName: "1", versionCode: 1,
    launchers: [{ activity: "org.example.game.Main" }] }, convertedJar: path.join(root, "converted.jar"),
    filesRoot: root, cacheRoot: root, assetsRoot: root, nativeRoot: root, resourcesRoot: root, sourceApk: entry.gamePath };
  let call, focused, spawnTime;
  const applicationExecutable = "/owned/Example.app/Contents/MacOS/Example";
  const ownedChild = { pid: 1 };
  const context = { ...fixture.context, userDataDir: root, audioMuted: true, gameArguments: ["--windowed", "A name", ""], runtimeSettings: { width: 800, height: 480, angleBackend: "vulkan" },
    getGameEffectsEnvironment: async () => ({ RESHADE_EXPLICIT_HOST: "1", DYLD_INSERT_LIBRARIES: path.join(root, "graphics.dylib") }),
    spawnDetachedChecked: async (...args) => { call = args; spawnTime = Date.now(); return ownedChild; } };
  await Host.launch(entry, context, payload, { ...fixture, prepare: async () => prepared,
    focusOwnedNativeGame: (child, identity) => {
      focused = { child, identity };
      return new Promise(() => {}); // Registration must not delay the launch response.
    },
    prepareSandbox: async options => {
      assert.equal(options.angleBackend, "vulkan");
      assert.equal(options.dataRoot, path.join(root, "android/apps/example/data"));
      assert.equal(options.graphics.DYLD_INSERT_LIBRARIES, path.join(root, "graphics.dylib"));
      assert.ok(options.argumentAgent.endsWith("arguments.jar"));
      return { command: "/usr/bin/sandbox-exec", prefix: ["-f", "private-profile", applicationExecutable], executablePath: applicationExecutable,
        javaArguments: ["-Duser.home=private-home"], environment: { HOME: "private-home" }, graphics: {} };
    } });
  assert.equal(call[0], "/usr/bin/sandbox-exec");
  assert.equal(call[2].graphicsExecutable, applicationExecutable);
  assert.equal(call[1].includes("-Dmaclauncher.dex.demand=true"),true);
  assert.ok(call[1].some(argument=>argument.startsWith("-javaagent:")&&argument.endsWith("=jvm")));
  assert.deepEqual(JSON.parse(call[2].env.MACLAUNCHER_GAME_ARGUMENTS),context.gameArguments);
  assert.equal(focused.child, ownedChild);
  assert.equal(focused.identity.executablePath, applicationExecutable, "Focus follows the prepared Java application executable");
  assert.ok(focused.identity.launchedAt <= spawnTime);
  const startup = call[1].indexOf("-XstartOnFirstThread"), classPath = call[1][startup + 4].split(path.delimiter);
  assert.deepEqual(call[1].slice(startup, startup + 4), ["-XstartOnFirstThread", "-Xdock:name=Example", "-XX:+ErrorFileToStderr", "-cp"]);
  assert.equal(call[1][startup + 5], "maclauncher.android.Host");
  // The owned text-input classes precede the host archive; metadata libraries stay out.
  assert.equal(classPath.length, 2);
  assert.equal(path.dirname(classPath[0]), path.join(root, "text-input"));
  assert.equal(classPath[1], path.join(root, "android-host.jar"));
  assert.equal(call[1].includes(prepared.convertedJar), false);
  const config = JSON.parse(fs.readFileSync(call[1][call[1].indexOf("--config") + 1]));
  assert.equal(config.width, 800);
  assert.equal(config.height, 480);
  assert.equal(Object.hasOwn(config,'audioMuted'),false,'Diagnostic muting is not an Android launch configuration field');
  assert.equal(config.graphicsLibrary, path.join(root, "graphics.dylib"));
  assert.equal(config.convertedJar, prepared.convertedJar);
  assert.equal(call[2].cwd, prepared.filesRoot);
  const controller = new AbortController();
  let spawned = false;
  await assert.rejects(Host.launch(entry, { ...context, signal: controller.signal,
    spawnDetachedChecked: async () => { spawned = true; } }, payload, { ...fixture, prepare: async () => prepared,
    prepareSandbox: async () => { controller.abort(); return {}; } }), { name: "AbortError" });
  assert.equal(spawned, false, "Cancellation during sandbox preparation must not start Java");
});

test("Android prepares the selected JVM image before services or sandbox and preserves setup cancellation", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-host-image-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=managerFixture(true),payload={root,profile:{}},context={...fixture.context,userDataDir:root},calls=[];
  const declined=Error('Original image setup canceled');
  await assert.rejects(Host.launch({gameId:'image'},context,payload,{...fixture,
    prepare:async()=>{calls.push('package');return {nativeRoot:root,metadata:{}};},
    prepareRuntimeImage:async options=>{assert.equal(options.payload,payload);assert.equal(options.context,context);assert.equal(options.nativeAbi,'arm64-v8a');calls.push('image');throw declined;},
    prepareInstalledServices:()=>assert.fail('Services must wait for the required image'),
    prepareSandbox:()=>assert.fail('Sandbox preparation must remain cached-only')
  }),error=>error===declined);
  assert.deepEqual(calls,['package','image']);
});

test("Android viewport and environment reject incompatible host overrides", () => {
  assert.throws(() => Host.viewport({ width: 8193 }), /dimensions/);
  assert.throws(() => Host.viewport({ height: "480" }), /dimensions/);
  assert.deepEqual(Host.hostEnvironment({ PATH: "/bin", DYLD_LIBRARY_PATH: "/other", RESHADE_EFFECT: "stale",
    KL_ANGLE_DIR: "/other", KL_ANGLE_BACKEND: "vulkan", KLEPTON_FRAME_LIBRARY: "/other", JAVA_TOOL_OPTIONS: "-agentlib:other", CLASSPATH: "/sdk",
    SECRET_TOKEN: "private", HOME: "/personal" }), { PATH: "/usr/bin:/bin" });
  const prepared = { metadata: { packageName: "org.example.game", launchers: [{ activity: "org.example.Main" }] } };
  assert.throws(() => Host.launchConfig({}, prepared, { root: "/runtime" }, {}, { DYLD_INSERT_LIBRARIES: "/other" }), /explicit GPU host/);
});
test("Android renderer choices follow the installed provider and retain Metal defaults", t => {
  const Runtime = require('../src/modules/android/runtime'), module = require('../src/modules/android/main');
  const manifest = require('../src/modules/android/manifest.json');
  const schema = manifest.runtime.entries.klepton.settings;
  assert.equal(schema.defaults.angleBackend, 'metal');
  assert.notEqual(schema.fields.find(field => field.key === 'angleBackend').gameOnly, true);
  assert.notEqual(schema.fields.find(field => field.key === 'vulkanRuntime').gameOnly, true);
  let profile = {};
  t.mock.method(Runtime, 'resolveSelected', () => ({ profile }));
  assert.deepEqual(module.actions.listAngleBackends().angleBackends.map(item => item.value), ['metal']);
  assert.equal(Host.angleBackend({}, { profile }), 'metal');
  assert.throws(() => Host.angleBackend({runtimeSettings:{angleBackend:'vulkan'}}, { profile }), /does not contain/);
  profile = { angleVulkanVersion: 1 };
  assert.deepEqual(module.actions.listAngleBackends().angleBackends.map(item => item.value), ['metal','vulkan']);
  assert.deepEqual(module.settingsActions.listAngleBackends(), module.actions.listAngleBackends());
  const {resolveModuleRuntimeSettings,resolveRuntimeSettingsForEntry} = require('../src/core/runtime-settings');
  const settings = {modules:{android:{runtimeSettings:{klepton:{angleBackend:'vulkan',vulkanRuntime:'kosmickrisp:installed'}}}}};
  const defaults = resolveModuleRuntimeSettings(settings,'android',manifest,'klepton');
  assert.equal(defaults.angleBackend,'vulkan'); assert.equal(defaults.vulkanRuntime,'kosmickrisp:installed');
  const game = resolveRuntimeSettingsForEntry({runtimeSettings:{klepton:{angleBackend:'metal'}}},settings,manifest,'klepton');
  assert.equal(game.angleBackend,'metal'); assert.equal(game.vulkanRuntime,'kosmickrisp:installed');
  assert.equal(Host.angleBackend({runtimeSettings:{angleBackend:'vulkan'}}, { profile }), 'vulkan');
  assert.throws(() => Host.angleBackend({runtimeSettings:{angleBackend:'inherited'}}, { profile }), /Select Metal or Vulkan/);
});
test("Tablet window dimensions preserve explicit sizes", () => {
  const manifest = require('../src/modules/android/manifest.json');
  const defaults = Host.viewport();
  assert.deepEqual(defaults, { width: 1280, height: 800 });
  assert.equal(manifest.runtime.entries.klepton.settings.defaults.width, defaults.width);
  assert.equal(manifest.runtime.entries.klepton.settings.defaults.height, defaults.height);
  const prepared = { metadata: { packageName: 'org.example.game', launchers: [{ activity: 'org.example.Main' }] } };
  const payload = { root: '/runtime', profile: {} };
  const config = Host.launchConfig({}, prepared, payload, { width: 800, height: 480 });
  assert.equal(config.width, 800);assert.equal(config.height, 480);
  assert.equal(Object.hasOwn(Host.launchConfig({}, prepared, { root: '/runtime', profile: {} }, {}), 'densityDpi'), false);
});
test("Canvas-capable Android hosts get an included presenter with all effects off", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-canvas-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "android-host.jar"), "host");
  const fixture = managerFixture(true), calls = [];
  const prepared = { metadata: { packageName: "org.example.game", launchers: [{ activity: "org.example.game.Main" }] },
    filesRoot: root, cacheRoot: root, assetsRoot: root, nativeRoot: root, resourcesRoot: root };
  const entry = { gameId: "canvas", name: "Canvas" }, library = path.join(root, "graphics.dylib");
  const context = { ...fixture.context, userDataDir: root, app: { name: "fixture" },
    getGameEffectsEnvironment: async () => ({}),
    spawnDetachedChecked: async (_command, args, options) => { assert.equal(args.includes("-Dmaclauncher.dex.demand=true"),false);assert.equal(options.graphicsExecutable,fixture.host.javaPath);calls.push(JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1]))); return { pid: 1 }; } };
  const dependencies = { ...fixture, prepare: async () => prepared,
    prepareSandbox: async options => ({ command: "/usr/bin/sandbox-exec", prefix: ["-f", "profile", options.javaPath],
      javaArguments: [], environment: {}, graphics: options.graphics }), resolvePresentationLibrary: ({ app }) => {
    assert.equal(app, context.app); calls.push("presenter"); return library;
  } };
  await Host.launch(entry, context, { root, profile: { canvasPresentationVersion: 1 } }, dependencies);
  assert.equal(calls[0], "presenter"); assert.equal(calls[1].graphicsLibrary, library);
  assert.equal(fs.existsSync(path.join(root, "games/canvas/effects")), false);
  calls.length = 0;
  await Host.launch(entry, context, { root, profile: {} }, dependencies);
  assert.equal(calls.length, 1); assert.equal(calls[0].graphicsLibrary, undefined);
  calls.length = 0;
  context.getGameEffectsEnvironment = async () => ({ DYLD_INSERT_LIBRARIES: library, RESHADE_EXPLICIT_HOST: "1" });
  await Host.launch(entry, context, { root, profile: { canvasPresentationVersion: 1 } }, dependencies);
  assert.equal(calls.length, 1); assert.equal(calls[0].graphicsLibrary, library);
  await assert.rejects(Host.launch(entry, context, { root, profile: { canvasPresentationVersion: 2 } }, dependencies), /presentation profile/);
  context.getGameEffectsEnvironment = async () => ({ DYLD_INSERT_LIBRARIES: library, RESHADE_EXPLICIT_HOST: "1",
    RESHADE_SPATIAL_METHOD: "metalfx", RESHADE_RESOLUTION_MULTIPLIER: "2" });
  let selectedGraphics;const warnings=[];
  await Host.launch(entry, { ...context, logger: { warn: message => { warnings.push(message); } } }, { root, profile: { canvasPresentationVersion: 1 } }, {
    ...dependencies, prepareSandbox: async options => { selectedGraphics = options.graphics; return dependencies.prepareSandbox(options); }
  });
  assert.ok(warnings.some(message => /using Auto/.test(message)));assert.equal(selectedGraphics.RESHADE_RESOLUTION_MULTIPLIER, undefined);
  assert.equal(selectedGraphics.RESHADE_SPATIAL_METHOD, "metalfx");
  await Host.launch(entry, context, { root, profile: { canvasPresentationVersion: 1, producerResolutionVersion: 1 } }, dependencies);
});

test("Independent Android package and metadata preparation overlap and retain cleanup ownership", {timeout:10000}, async t => {
  for (const failing of [false, true]) await t.test(failing ? "metadata failure joins the package lease" : "both inputs precede spawn", async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-launch-overlap-"));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.writeFileSync(path.join(root,"android-host.jar"),"host");
    const fixture=managerFixture(true), deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
    const metadata=deferred(),installation=deferred(),metadataStarted=deferred(),installationStarted=deferred();
    const failure=Error("original metadata failure");let spawned=0,released=0,settled=false;
    t.mock.method(require('../src/modules/android/package-metadata'),'applyLaunchIdentity',async()=>{metadataStarted.resolve();await metadata.promise;});
    const prepared={metadata:{packageName:"example.overlap",launchers:[{activity:"example.overlap.Main"}]},filesRoot:root,cacheRoot:root,assetsRoot:root,nativeRoot:root,resourcesRoot:root};
    const context={...fixture.context,userDataDir:root,getGameEffectsEnvironment:async()=>({}),spawnDetachedChecked:async()=>{spawned++;return{pid:1};}};
    const operation=Host.launch({gameId:"overlap"},context,{root,profile:{}},{...fixture,prepare:async()=>prepared,
      prepareInstalledServices:async()=>{installationStarted.resolve();return installation.promise;},
      resolveVulkan:async()=>({}),focusOwnedNativeGame:()=>{},
      prepareSandbox:async options=>({command:"java",prefix:[],javaArguments:[],environment:{},graphics:options.graphics})});
    operation.then(()=>{settled=true;},()=>{settled=true;});
    await Promise.all([metadataStarted.promise,installationStarted.promise]);
    assert.equal(spawned,0);
    if(failing){
      metadata.reject(failure);await new Promise(resolve=>setImmediate(resolve));
      assert.equal(settled,false,"Failure cleanup retains the in-flight package lease");
      installation.resolve({release:async()=>{released++;}});
      await assert.rejects(operation,error=>error===failure);
      assert.equal(released,1);assert.equal(spawned,0);
    }else{
      installation.resolve(null);await new Promise(resolve=>setImmediate(resolve));assert.equal(spawned,0);
      metadata.resolve();await operation;assert.equal(spawned,1);
    }
  });
});

async function retirementFixture(t, { reservationFailure, serviceClose } = {}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-jvm-retirement-")),fixture=managerFixture(true);
  const generation=path.join(root,"prepared","a".repeat(64));fs.mkdirSync(generation,{recursive:true});
  fs.writeFileSync(path.join(root,"android-host.jar"),"host");
  const calls=[];let child;
  t.after(async()=>{
    if(child?.exitCode==null&&child?.signalCode==null&&child?.pid){const done=new Promise(resolve=>child.once('exit',resolve));try{process.kill(-child.pid,'SIGKILL');}catch{}await done;}
    await child?.runtimeRetirement?.catch(()=>{});fs.rmSync(root,{recursive:true,force:true});
  });
  t.mock.method(require('../src/modules/android/service-processes'),'reserveProfileOwners',async()=>({close:async()=>{calls.push('reservation');if(reservationFailure)throw reservationFailure;}}));
  const prepared={root:generation,metadata:{packageName:"example.retirement",launchers:[{activity:"example.retirement.Main"}]},
    filesRoot:root,cacheRoot:root,assetsRoot:root,nativeRoot:root,resourcesRoot:root};
  const context={...fixture.context,userDataDir:root,getGameEffectsEnvironment:async()=>({}),logger:{warn:()=>{}},
    spawnDetachedChecked:async()=>{
      child=require('node:child_process').spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('ready\\n');"],{detached:true,stdio:['pipe','pipe','pipe']});
      await require('node:events').once(child.stdout,'data');return child;
    }};
  const dependencies={...fixture,prepare:async()=>prepared,resolveVulkan:async()=>({}),focusOwnedNativeGame:()=>{},
    prepareSandbox:async options=>({command:'java',prefix:[],javaArguments:[],environment:{},graphics:options.graphics}),
    prepareInstalledServices:async()=>({release:async()=>calls.push('installed')}),
    prepareServiceConnections:async options=>({stdio:value=>value,connect:async()=>{},
      close:async()=>{calls.push('services');await options.installed.release();await serviceClose?.();},
      requireRetired:()=>{assert.ok(child.exitCode!=null||child.signalCode!=null);}})};
  return {root,generation,calls,context,dependencies,launch:()=>Host.launch({gameId:'retirement'},context,{root,profile:{}},dependencies)};
}

test('ordinary JVM exit attempts later owners after cleanup failure and publishes one retirement result',{timeout:10000},async t=>{
  const first=Error('service retirement failure'),later=Error('reservation retirement failure');
  const fixture=await retirementFixture(t,{reservationFailure:later,serviceClose:async()=>{throw first;}});
  const child=await fixture.launch();assert.equal(fs.readdirSync(fixture.generation).filter(name=>name.startsWith('.use-')).length,1);
  const exit=require('node:events').once(child,'exit');child.stdin.end();await exit;
  const retirement=child.runtimeRetirement;assert.ok(retirement);
  await assert.rejects(retirement,error=>error===first);
  assert.deepEqual(fixture.calls,['services','installed','reservation']);
  assert.equal(fs.readdirSync(fixture.generation).filter(name=>name.startsWith('.use-')).length,0);
  child.emit('close',0,null);assert.equal(child.runtimeRetirement,retirement);assert.equal(fixture.calls.length,3);
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});

test('ordinary JVM Stop retains prepared ownership until service retirement completes',{timeout:10000},async t=>{
  let ready,complete;const closing=new Promise(resolve=>{ready=resolve;}),barrier=new Promise(resolve=>{complete=resolve;});
  const fixture=await retirementFixture(t,{serviceClose:async()=>{ready();await barrier;}}),child=await fixture.launch();
  let settled=false;
  const stopped=require('../src/core/process-lifecycle').requestProcessStop(child);stopped.finally(()=>{settled=true;});
  await closing;assert.ok(child.signalCode);assert.equal(settled,false);
  assert.equal(fs.readdirSync(fixture.generation).filter(name=>name.startsWith('.use-')).length,1);
  complete();assert.equal(await stopped,true);await child.runtimeRetirement;
  assert.deepEqual(fixture.calls,['services','installed','reservation']);
  assert.equal(fs.readdirSync(fixture.generation).filter(name=>name.startsWith('.use-')).length,0);
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});

test('JVM startup preserves its original failure when reservation cleanup fails',{timeout:10000},async t=>{
  const original=Error('original metadata failure'),later=Error('reservation cleanup failure');
  const fixture=await retirementFixture(t,{reservationFailure:later});
  t.mock.method(require('../src/modules/android/package-metadata'),'applyLaunchIdentity',async()=>{throw original;});
  await assert.rejects(fixture.launch(),error=>error===original);
  assert.deepEqual(fixture.calls,['installed','reservation']);
  assert.equal(fs.readdirSync(fixture.generation).filter(name=>name.startsWith('.use-')).length,0);
});

test("Android provider Activities receive the scoped common presenter without game effects", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-provider-presentation-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,"android-host.jar"),"host");
  const fixture=managerFixture(true), {EventEmitter}=require("node:events"), child=new EventEmitter();
  child.pid=1;let environment,serviceConfig;
  const prepared={metadata:{packageName:"example.game",launchers:[{activity:"example.game.Main"}]},sourceApk:path.join(root,"base.apk"),filesRoot:root,cacheRoot:root,assetsRoot:root,nativeRoot:root,resourcesRoot:root};
  const library=path.join(root,"graphics.dylib"),scoped=path.join(root,"scoped-graphics.dylib");
  const context={...fixture.context,userDataDir:root,getGameEffectsEnvironment:async()=>({DYLD_INSERT_LIBRARIES:library,RESHADE_EXPLICIT_HOST:"1",RESHADE_EFFECT:"crt"}),spawnDetachedChecked:async()=>({pid:2})};
  await Host.launch({gameId:"provider-presentation"},context,{root,profile:{canvasPresentationVersion:1,demandDexVersion:1}},{...fixture,prepare:async()=>prepared,
    focusOwnedNativeGame:()=>{},prepareInstalledServices:async()=>({}),
    prepareServiceConnections:async options=>{
      const service={record:{packageName:"example.provider"},prepared:{...prepared,metadata:{...prepared.metadata,packageName:"example.provider"}},storage:{root,dataRoot:root,launchFile:path.join(root,"service.json"),logFile:path.join(root,"service.log")}};
      await options.launchService(service,{serviceProcess:1},[],{});
      return {stdio:value=>value,connect:async()=>{},close:async()=>{}};
    },
    prepareSandbox:async options=>{if(options.config.serviceProcess){serviceConfig=options.config;assert.equal(options.graphics.RESHADE_EFFECT,undefined);assert.equal(options.graphics.DYLD_INSERT_LIBRARIES,library);}
      return {command:"java",prefix:[],javaArguments:[],environment:{HOME:root},graphics:{...options.graphics,DYLD_INSERT_LIBRARIES:scoped}};},
    spawnService:async(_command,args,options)=>{assert.equal(args.includes("-Dmaclauncher.dex.demand=true"),true);environment=options.env;return child;}
  });
  child.emit("close",0,null);
  assert.equal(serviceConfig.graphicsLibrary,library);
  assert.equal(environment.DYLD_INSERT_LIBRARIES,scoped,"Native Canvas uses the sandbox-owned presenter path");
  assert.equal(environment.RESHADE_EXPLICIT_HOST,"1");assert.equal(environment.RESHADE_EFFECT,undefined);
});

test("JVM application services retain the explicitly selected platform supplier and default to their own payload", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-platform-supplier-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,"android-host.jar"),"host");
  const fixture=managerFixture(true),profile={processIdentityVersion:1,platformServicesVersion:1,systemServicesVersion:1,sharedAccountsVersion:1,frameworkServicesVersion:1};
  const payload={root,profile,runtimeIdentity:{platformHash:"a".repeat(64)}};
  const platform={root:path.join(root,"retained-platform"),profile,runtimeIdentity:{platformHash:"b".repeat(64)}};
  const prepared={metadata:{packageName:"example.platform",launchers:[{activity:"example.platform.Main"}]},sourceApk:path.join(root,"base.apk"),filesRoot:root,cacheRoot:root,assetsRoot:root,nativeRoot:root,resourcesRoot:root};
  const context={...fixture.context,userDataDir:root,getGameEffectsEnvironment:async()=>({})};
  t.mock.method(require('../src/modules/android/google-accounts'),'selected',()=>null);
  t.mock.method(require('../src/modules/android/platform-services/client'),'retainExisting',async()=>null);
  t.mock.method(require('../src/modules/android/runtime'),'resolveForLaunch',async()=>assert.fail('A JVM launch must not replace its selected payload with the included default'));
  const reached=Error("service owner selection observed");
  for(const explicit of [false,true]){
    let resolved=0,observed;
    await assert.rejects(Host.launch({gameId:"platform-supplier"},context,payload,{...fixture,prepare:async()=>prepared,
      prepareInstalledServices:async()=>({services:[],google:{enabled:false},release:async()=>{}}),resolveVulkan:async()=>({}),
      ...(explicit?{resolvePlatformRuntime:async()=>{resolved++;return platform;}}:{}),
      prepareServiceConnections:async options=>{observed=options;throw reached;}
    }),error=>error===reached);
    const expected=explicit?platform:payload;
    assert.equal(resolved,explicit?1:0);
    assert.equal(observed.platformOptions.runtimeRoot,expected.root);
    assert.equal(observed.accountOptions.runtimeIdentity,expected.runtimeIdentity);
    assert.equal(observed.config.runtimeRoot,payload.root,'Application execution retains its own Java/native payload');
    assert.equal(observed.descriptorSender,path.join(payload.root,'native/android-supervisor-send'));
  }
});

test("Android rejects a busy platform owner before APK preparation and releases compatible reservations on failure", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-owner-conflict-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,"save.dat"),"retained save");
  const fixture=managerFixture(true),profile={processIdentityVersion:1,platformServicesVersion:1,systemServicesVersion:1,sharedAccountsVersion:1,frameworkServicesVersion:1};
  const payload={root,profile},context={...fixture.context,userDataDir:root};
  const client=require('../src/modules/android/platform-services/client'),requested=[],released=[];
  const conflict=Object.assign(Error("Close running Android games before changing the Android runtime."),{code:"EBUSY"});
  let busy=true,prepared=0,spawned=0;
  t.mock.method(require('../src/modules/android/google-accounts'),'selected',()=>null);
  t.mock.method(client,'retainExisting',async options=>{
    requested.push(options.role);if(busy&&options.role==='system')throw conflict;
    return{close:async()=>{released.push(options.role);}};
  });
  context.spawnDetachedChecked=async()=>{spawned++;assert.fail('A rejected owner must not spawn the application');};
  const preparationFailure=Error('original package preparation failed');
  const dependencies={...fixture,prepare:async()=>{prepared++;throw preparationFailure;}};
  await assert.rejects(Host.launch({gameId:'same-data'},context,payload,dependencies),error=>error===conflict);
  assert.equal(prepared,0);assert.equal(spawned,0);
  assert.deepEqual(requested,['keystore','system']);assert.deepEqual(released,['keystore']);
  assert.deepEqual(fs.readdirSync(root),['save.dat'],'Owner conflict must not prepare or write application data');
  assert.equal(fs.readFileSync(path.join(root,'save.dat'),'utf8'),'retained save');
  busy=false;requested.length=0;released.length=0;
  await assert.rejects(Host.launch({gameId:'same-data'},context,payload,dependencies),error=>error===preparationFailure);
  assert.equal(prepared,1);assert.equal(spawned,0);
  assert.deepEqual(requested,['keystore','system','accounts']);
  assert.deepEqual(released.sort(),['accounts','keystore','system']);
  assert.deepEqual(fs.readdirSync(root),['save.dat']);
});

test("Android runtime diagnostics retain a bounded tail and release stream listeners", t => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const file = path.join(root, "runtime.log"), messages = [];
  Host.captureStderr(child, file, root, { error: message => messages.push(message) });
  for (let i = 0; i < 100; i++) child.stderr.emit("data", Buffer.alloc(65536, 65));
  child.stderr.emit("error", new Error("pipe interrupted"));
  child.stderr.emit("data", Buffer.from("\nactual startup failure\n"));
  assert.equal(fs.readFileSync(file, "utf8"), "");
  child.emit("close", 1, null);
  const saved = fs.readFileSync(file);
  assert.equal(saved.length, 32768);
  assert.equal(saved.subarray(-24).toString().endsWith("actual startup failure\n"), true);
  assert.match(saved.toString(), /Runtime stderr could not be read: pipe interrupted/);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  child.emit("close", 1, null);
  assert.equal(messages.length, 1);
});

test("Android live logs coalesce writes, stay bounded and retain their original inode", t => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-live-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const file = path.join(root, "runtime.log"), prior = path.join(root, "prior.log");
  Host.captureStderr(child, file, root);
  child.stderr.emit("data", Buffer.from("still loading\n"));
  t.mock.timers.tick(999); assert.equal(fs.statSync(file).size, 0);
  t.mock.timers.tick(1); assert.equal(fs.readFileSync(file, "utf8"), "still loading\n");
  child.stderr.emit("data", Buffer.alloc(65536, 65));
  t.mock.timers.tick(1000); assert.equal(fs.statSync(file).size, 32768);
  // A new launch/path must not receive old process output.
  fs.renameSync(file, prior); fs.writeFileSync(file, "new launch\n");
  const fatal = "[android-host] Failure:\njava.lang.IllegalStateException: actual error\n";
  child.stderr.emit("data", Buffer.from(fatal));
  t.mock.timers.tick(1000); assert.equal(fs.readFileSync(prior, "utf8"), fatal);
  child.emit("close", 1, null); t.mock.timers.tick(10000);
  assert.equal(fs.readFileSync(file, "utf8"), "new launch\n");
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("Android JVM crash diagnostics retain the failure header and bounded tail across fragmented writes", t => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-crash-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const header = "# A fatal error has been detected by the Java Runtime Environment:\n# SIGSEGV in original native method\n";
  for (const large of [false, true]) {
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    const file = path.join(root, "runtime.log");
    Host.captureStderr(child, file, root);
    child.stderr.emit("data", Buffer.alloc(50000, 65));
    // The JVM can split its marker at any byte boundary in stderr's pipe.
    for (const byte of Buffer.from(header)) child.stderr.emit("data", Buffer.from([byte]));
    if (large) for (let i = 0; i < 100; i++) child.stderr.emit("data", Buffer.alloc(65536, 66));
    child.stderr.emit("data", Buffer.from("final native state\n"));
    child.emit("close", null, "SIGABRT");
    const report = fs.readFileSync(file);
    assert.equal(report.length, large ? 32768 : Buffer.byteLength(header + "final native state\n"));
    assert.ok(report.toString().startsWith(header));
    assert.ok(report.toString().endsWith("final native state\n"));
    assert.equal(report.includes("diagnostics truncated"), large);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("error"), 0);
    assert.deepEqual(fs.readdirSync(root), ["frame-times.0.jsonl", "frame-times.1.jsonl", "runtime.log"]);
  }
});

test("Android host failures survive guest exit zero and noisy teardown without retaining listeners", t => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-host-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const header = "[android-host] Failure:\njava.lang.UnsupportedOperationException: unavailable Android service\n";
  for (const large of [false, true]) {
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    const file = path.join(root, "runtime.log"), messages = [];
    Host.captureStderr(child, file, root, { error: message => messages.push(message) });
    child.stderr.emit("data", Buffer.from("ordinary startup\n"));
    for (const byte of Buffer.from(header)) child.stderr.emit("data", Buffer.from([byte]));
    if (large) for (let i = 0; i < 100; i++) child.stderr.emit("data", Buffer.alloc(65536, 65));
    child.stderr.emit("data", Buffer.from("guest shutdown complete\n"));
    child.emit("close", 0, null);
    child.emit("close", 0, null);
    const report = fs.readFileSync(file);
    assert.ok(report.toString().startsWith(header));
    assert.ok(report.toString().endsWith("guest shutdown complete\n"));
    assert.equal(report.length, large ? 32768 : Buffer.byteLength(header + "guest shutdown complete\n"));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Runtime reported a failure \(0\)/);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("error"), 0);
    assert.equal(child.listenerCount("close"), 0);
  }
  const child = new EventEmitter(); child.stderr = new EventEmitter();
  const messages = [], file = path.join(root, "normal.log");
  Host.captureStderr(child, file, root, { error: message => messages.push(message) });
  child.stderr.emit("data", Buffer.from("[android-host] Normal close\n"));
  child.emit("close", 0, null);
  assert.equal(messages.length, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "[android-host] Normal close\n");
});

test("Android concurrent failure reports retain an earlier secondary report before a delayed primary", t => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-concurrent-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secondary = "[android-host] Secondary failure:\njava.lang.IllegalStateException: owner cleanup failed\n";
  const primary = "[android-host] Failure:\njava.lang.IllegalStateException: worker formatting finished later\n";
  for (const delayed of ["", primary]) {
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    const messages = [], file = path.join(root, "runtime.log");
    Host.captureStderr(child, file, root, { error: message => messages.push(message) });
    child.stderr.emit("data", Buffer.from("ordinary startup\n"));
    for (const byte of Buffer.from(secondary)) child.stderr.emit("data", Buffer.from([byte]));
    if (delayed) child.stderr.emit("data", Buffer.from(delayed));
    child.stderr.emit("data", Buffer.from("guest shutdown complete\n"));
    child.emit("close", 0, null);
    assert.equal(fs.readFileSync(file, "utf8"), secondary + delayed + "guest shutdown complete\n");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Runtime reported a failure \(0\)/);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.listenerCount("close"), 0);
  }
});
test("Android native fatal diagnostics survive exit zero, fragmented writes and noisy teardown", t => {
  const { EventEmitter } = require("node:events");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-native-fatal-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const messages=[
    "FORTIFY: pthread_mutex_lock called on a destroyed mutex (0x1234)",
    "[linux-abi] fatal signal 11 at pc 0x1234 (libnative.so)",
    "[linux-abi] fatal software SIGABRT at current guest syscall boundary: pc 0x1234",
    "[6/app_process64] JNI FatalError called: native library could not load",
    "JNI DETECTED ERROR IN APPLICATION: invalid JNI reference",
    "libc: Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE)",
    "[6/libc] Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE)",
    "[7/libc] Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)",
    "[6/AndroidRuntime] FATAL EXCEPTION: main"
  ];
  for(const header of messages)for(const noisy of [false,true]){
    const message=header.replace(/^\[\d+\/[^\]]+\]\s*/,"");
    const child=new EventEmitter();child.stderr=new EventEmitter();
    const errors=[],file=path.join(root,"runtime.log");
    Host.captureStderr(child,file,root,{error:message=>errors.push(message)});
    child.stderr.emit("data",Buffer.from("ordinary startup\n"));
    for(const byte of Buffer.from(header+"\n"))child.stderr.emit("data",Buffer.from([byte]));
    if(noisy){
      for(let i=0;i<20;i++)child.stderr.emit("data",Buffer.alloc(65536,65));
      child.stderr.emit("data",Buffer.from("\njava.lang.IllegalStateException: later cleanup error\n"));
    }
    child.stderr.emit("data",Buffer.from("shutdown finished\n"));
    child.emit("close",0,null);
    assert.equal(errors.length,1,header);
    const report=fs.readFileSync(file,"utf8");
    assert.ok(report.includes(message),header);assert.ok(report.endsWith("shutdown finished\n"));
    assert.ok(Buffer.byteLength(report)<=32768);
    assert.ok(child.completionDiagnostics.message.includes(message));
    assert.equal(child.stderr.listenerCount("data"),0);assert.equal(child.listenerCount("close"),0);
  }
});
test("Android background worker diagnostics remain visible without turning normal close into failure", t => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-worker-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();child.stderr = new EventEmitter();
  const messages = [], file = path.join(root, "runtime.log");
  Host.captureStderr(child, file, root, { error: message => messages.push(message) });
  child.stderr.emit("data", Buffer.from("[android-host] Background worker error:\njava.lang.NoClassDefFoundError: optional.sdk.Callback\n"));
  child.stderr.emit("data", Buffer.from("[linux-abi] software SIGABRT request guest_tid=0x2cf pc=0x1234\n"));
  child.emit("close", 0, null);
  assert.deepEqual(messages, []);assert.equal(child.completionDiagnostics.message, undefined);
  assert.match(fs.readFileSync(file, "utf8"), /optional.sdk.Callback/);
});

test("Android requested Stop crosses the real backend owner before actual SIGTERM and keeps prior diagnostics nonterminal", async t => {
  const { once } = require("node:events");
  const { createBackendService } = require("../src/core/backend-worker-client");
  const { processStopBinding, requestProcessStop } = require("../src/core/process-lifecycle");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-owned-diagnostic-stop-"));
  const logs=[],service=createBackendService({userDataDir:root,workerPath:path.join(__dirname,"fixtures/android-host-stop-worker.cjs"),
    onEvent:(event,payload)=>{if(event==="log"&&payload.level==="error")logs.push(...payload.args);}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const child=(await service.launchEntry({gameId:"fixture",gamePath:path.join(root,"fixture-game")},{})).child;
  t.after(()=>{if(child.exitCode==null&&child.signalCode==null)try{process.kill(child.pid,"SIGKILL");}catch{}});
  const binding=processStopBinding(child);
  assert.ok(binding?.token,"The real backend child must retain requested Stop intent before signaling");
  const closed=once(child,"close");
  assert.equal(await requestProcessStop(child),true);assert.deepEqual(await closed,[null,"SIGTERM"]);
  if(child.completionDiagnostics?.pending)await once(child,"diagnostics");
  assert.equal(child.stopRequested,true);assert.equal(child.completionDiagnostics.message,"");
  assert.deepEqual(logs,[]);
  assert.match(fs.readFileSync(path.join(root,"runtime.log"),"utf8"),/optional.telemetry.Adapter/);
});

test("Android expected Stop termination is neutral while unexpected signals and fatal reports remain errors", t => {
  const { EventEmitter } = require("node:events");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-stop-diagnostics-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [requested,code,signal,fatal,expected] of [
    [true,null,"SIGTERM",false,false],[true,143,null,false,false],[true,0,null,false,false],
    [false,null,"SIGTERM",false,true],[false,null,"SIGSEGV",false,true],
    [true,null,"SIGSEGV",false,true],[true,null,"SIGABRT",false,true],[true,null,"SIGKILL",false,true],
    [true,null,"SIGTERM",true,true],[true,0,null,true,true]
  ]) {
    const child=new EventEmitter();child.stderr=new EventEmitter();child.stopRequested=requested;
    const errors=[],file=path.join(root,"runtime.log");
    Host.captureStderr(child,file,root,{error:message=>errors.push(message)});
    child.stderr.emit("data",Buffer.from("java.lang.ClassNotFoundException: optional.telemetry.Adapter\n"));
    if(fatal)child.stderr.emit("data",Buffer.from("[android-host] Failure:\njava.lang.IllegalStateException: actual owner failure\n"));
    child.emit("close",code,signal);
    assert.equal(errors.length,expected?1:0,JSON.stringify({requested,code,signal,fatal}));
    assert.equal(Boolean(child.completionDiagnostics.message),expected);
    assert.match(fs.readFileSync(file,"utf8"),fatal?/actual owner failure/:/optional.telemetry.Adapter/);
    assert.equal(child.stderr.listenerCount("data"),0);
  }
});

test("Android reports the actual exception through process completion and the launcher log", async t => {
  const { spawn } = require("node:child_process");
  const { observeGameProcess } = require("../src/core/game-process-events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const message = "java.lang.IllegalStateException: Back callbacks require the window owner thread";
  const report = "[android-host] Failure:\n" + message + "\n[thread id=1 name=main role=owner]\n\tat actual.Game.create(Game.java:1)\n";
  const child = spawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(report)});process.exitCode=1;`], { stdio: ["ignore", "ignore", "pipe"] });
  const logs = [], events = [];
  Host.captureStderr(child, path.join(root, "runtime.log"), root, { error: line => logs.push(line) });
  const failure = await new Promise((resolve, reject) => {
    child.once("error", reject);
    observeGameProcess(child, { onExit: () => events.push("exit"), onFailure: value => { events.push("failure");resolve(value); } });
  });
  assert.deepEqual(events, ["exit", "failure"]);
  assert.equal(failure.diagnostics.message, message);
  assert.match(logs[0], /IllegalStateException: Back callbacks require the window owner thread/);
  assert.equal(fs.readFileSync(failure.diagnostics.logFile, "utf8"), report);
  assert.equal(child.listenerCount("diagnostics"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("Android diagnostic finalization cannot recreate deleted storage or replace a later launch log", t => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-diagnostic-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const replace of [false, true]) {
    const directory = path.join(root, replace ? "replaced" : "removed");fs.mkdirSync(directory);
    const child = new EventEmitter();child.stderr = new EventEmitter();
    const file = path.join(directory, "runtime.log");
    Host.captureStderr(child, file, directory);
    child.stderr.emit("data", "[android-host] Failure:\njava.lang.IllegalStateException: old launch\n");
    child.emit("exit", 1, null);
    fs.rmSync(directory, { recursive: true });
    if (replace) { fs.mkdirSync(directory);fs.writeFileSync(file, "new launch"); }
    child.emit("close", 1, null);
    if (replace) assert.equal(fs.readFileSync(file, "utf8"), "new launch");
    else assert.equal(fs.existsSync(directory), false);
    assert.match(child.completionDiagnostics.message, /old launch/);
    assert.equal(child.stderr.listenerCount("data"), 0);
  }
});

test("Android stderr held open after exit has a bounded diagnostic drain", async t => {
  const { EventEmitter, once } = require("node:events");
  const { PassThrough } = require("node:stream");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-diagnostic-drain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter();child.stderr = new PassThrough();
  const pipeClosed = once(child.stderr, "close");
  const file = path.join(root, "runtime.log");
  Host.captureStderr(child, file, root);
  child.stderr.emit("data", "[android-host] Failure:\njava.lang.IllegalStateException: retained pipe\n");
  child.emit("exit", 1, null);
  assert.equal(child.completionDiagnostics.pending, true);
  t.mock.timers.tick(1000);
  assert.equal(child.completionDiagnostics.pending, false);
  assert.equal(child.stderr.destroyed, true);
  await pipeClosed;
  assert.equal(child.stderr.closed, true);
  assert.match(fs.readFileSync(file, "utf8"), /retained pipe/);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("error"), 0);
  assert.equal(child.stderr.listenerCount("close"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("close"), 0);
});

test("Android launch leaves theme resolution to the original manifest parser",()=>{
 const metadata={packageName:"org.example.game",launchers:[{activity:"org.example.Main"}],applicationTheme:0x7f130001,activityThemes:{"org.example.Main":0x7f130002}};
 const config=Host.launchConfig({}, {metadata}, {root:"/runtime",profile:{themeResourcesVersion:1}}, {});
 assert.equal(Object.hasOwn(config,"applicationTheme"),false);assert.equal(Object.hasOwn(config,"activityTheme"),false);
});
