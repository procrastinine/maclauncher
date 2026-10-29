const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const Processes = require("../src/core/processes");

const FlashModule = require("../src/modules/flash/main");

const RuffleManager = FlashModule.runtimeManagers[0];
const RuffleCore = RuffleManager.core;
const ProjectorManager = FlashModule.runtimeManagers.find(manager => manager.id === "flash-projector");

test("projector uses the shared window graph while Off stays inert and scene inputs remain absent",async t=>{
  const ReShade=require("../src/modules/shared/reshade"),Native=require("../src/modules/shared/runtime/bundled-native"),Models=require("../src/modules/shared/reshade/models"),Neural=require("../src/modules/shared/reshade/neural");
  const directory=makeTempDir("flash-graphics-"),root=path.join(directory,"runtime"),userDataDir=path.join(directory,"profile");t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(root,{recursive:true});for(const file of ["libreshade-macos.dylib","fx-compile"])fs.writeFileSync(path.join(root,file),"fixture");
  fs.writeFileSync(path.join(root,"runtime.json"),JSON.stringify({schema:1,version:"fixture",minimumMacOS:"13.0",features:require("../src/modules/shared/reshade/features.json")}));
  t.mock.method(Native,"systemVersionSync",()=>"27.0");t.mock.method(Models,"listInstalled",()=>assert.fail("image-only graphs do not discover Lossless models"));t.mock.method(Neural,"listModels",()=>assert.fail("image-only graphs do not discover neural models"));
  const host=FlashModule.manifest.runtime.entries.projector.graphicsHost;assert.equal(host,"window");
  const entry={gameId:"flash-image",effects:{schema:2,mode:"advanced",enabled:false,video:[{id:"resize",kind:"upscale",method:"bilinear",enabled:true,extent:{relativeTo:"presentation",factor:1},settings:{}}]}},options={root,userDataDir,graphicsHost:host,verify:()=>true,diagnostics:false,gpuTiming:false,trace:false,execute:()=>assert.fail("no source compilation for Off or a native kernel")};
  const off=await ReShade.prepare(entry,options),offDocument=JSON.parse(fs.readFileSync(off.RESHADE_EFFECT_PLAN));assert.deepEqual(offDocument.nodes,[]);assert.equal(require("../src/modules/shared/effects/execution-requirements").analyze(entry).needed.processor,false);
  assert.equal(fs.existsSync(path.join(userDataDir,"runtimes","graphics-neural-models")),false);assert.equal(fs.existsSync(path.join(userDataDir,"runtimes","lossless-models")),false);
  const on=await ReShade.prepare({...entry,effects:{...entry.effects,enabled:true}},options),document=JSON.parse(fs.readFileSync(on.RESHADE_EFFECT_PLAN));assert.ok(document.nodes.some(row=>row.id==="resize"&&row.enabled));assert.equal(on.RESHADE_EXPLICIT_HOST,undefined);assert.equal(on.RESHADE_TEMPORAL_METHOD,undefined);
});

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createAppBundle(appPath, executableName) {
  const execPath = path.join(appPath, "Contents", "MacOS", executableName);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"),
    `<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executableName}</string></dict></plist>`);
  return { execPath };
}

function createRuffleInstall(userDataDir, version, executableName = "Ruffle") {
  const appPath = path.join(userDataDir, "runtimes", "ruffle", version, "Ruffle.app");
  const { execPath } = createAppBundle(appPath, executableName);
  return { appPath, execPath };
}

test("ordinary projector launch uses its managed universal install without Rosetta or SWF copies", async t => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir);
    const swfPath = path.join(gameDir, "game $(literal).swf");
    const swfBytes = Buffer.from("FWS\x0a\x08\x00\x00\x00", "binary");
    fs.writeFileSync(swfPath, swfBytes);
    const userDataDir = path.join(root, "userData");
    const version = "35.0.0.60";
    const appPath = path.join(userDataDir, "runtimes", "flash-projector", version, "payload", "files", "Flash Player.app");
    const { execPath } = createAppBundle(appPath, "Flash Player");
    const entry = { gamePath: swfPath, moduleData: { swfPath }, runtimeData: { projector: { version } } };
    const settings = { runtimes: { "flash-projector": { defaultVersion: version } } };
    t.mock.method(ProjectorManager, "resolveSelection", (selectedEntry, selectedSettings, selectedUserDataDir) => {
      assert.equal(selectedEntry, entry);
      assert.equal(selectedSettings, settings);
      assert.equal(selectedUserDataDir, userDataDir);
      return { ready: true, version, install: { version, appPath, executablePath: execPath } };
    });

    const launches = [];
    let rosetta = 0;
    assert.equal(await FlashModule.ensureRuntime(entry, { runtimeId: "projector", settings, userDataDir }), null);
    const result = await FlashModule.launchRuntime("projector", entry, {
      settings,
      userDataDir,
      ensureRosetta: async () => { rosetta++; },
      gameArguments: ["--title", "A quoted game", "", "$(literal)"],
      spawnDetachedChecked: async (cmd, args, options, needsRosetta) => {
        launches.push({ cmd, args, options, needsRosetta });
        return { pid: 1234 };
      },
      logger: { info: () => {} }
    });

    assert.ok(result);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].cmd, execPath);
    assert.deepEqual(launches[0].args, [swfPath, "--title", "A quoted game", "", "$(literal)"]);
    assert.equal(launches[0].options.cwd, path.dirname(swfPath));
    assert.equal(launches[0].needsRosetta, false);
    assert.equal(rosetta, 0);
    assert.deepEqual(fs.readFileSync(swfPath), swfBytes);
    assert.deepEqual(fs.readdirSync(gameDir), [path.basename(swfPath)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projector graphics follows the selected native executable and both translation metadata names",async t=>{
  const Native=require("../src/modules/shared/runtime/local-native"),directory=makeTempDir("flash-architecture-");t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const swfPath=path.join(directory,"game.swf");fs.writeFileSync(swfPath,"FWS");const entry={gamePath:swfPath,moduleData:{swfPath}},executablePath=path.join(directory,"Player");let install={executablePath},architectures=["arm64","x86_64"];
  t.mock.method(ProjectorManager,"resolveSelection",()=>({ready:true,install}));t.mock.method(Native,"readMachOArchitectures",file=>{assert.equal(file,executablePath);return architectures;});
  const context={runtimeId:"projector",settings:{},userDataDir:directory};assert.deepEqual(FlashModule.resolveGraphicsInputs(entry,context),{architecture:process.arch==="x64"?"x86_64":process.arch});
  architectures=["x86_64"];assert.deepEqual(FlashModule.resolveGraphicsInputs(entry,context),{architecture:"x86_64"});
  for(const key of ["requiresRosetta","needsRosetta"]){install={executablePath,[key]:true};assert.deepEqual(FlashModule.resolveGraphicsInputs(entry,context),{architecture:"x86_64"});let observed;
    await FlashModule.launchRuntime("projector",entry,{...context,gameArguments:[],spawnDetachedChecked:async(_cmd,_args,_options,translation)=>{observed=translation;return {pid:1234};}});assert.equal(observed,true);
  }
  install=null;assert.equal(FlashModule.resolveGraphicsInputs(entry,context),null);
});

test("ruffle runtime launch resolves installed runtime version", async () => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const userDataDir = path.join(root, "userData");
    const version = "nightly-2026-03-06";
    const { appPath, execPath } = createRuffleInstall(userDataDir, version);

    const swfPath = path.join(root, "game.swf");
    fs.writeFileSync(swfPath, "FWS");

    const launches = [];
    const result = await FlashModule.launchRuntime("ruffle", {
      gamePath: swfPath,
      moduleData: { swfPath },
      runtimeData: {
        ruffle: {
          version
        }
      }
    }, {
      userDataDir,
      gameArguments: ["--title", "A quoted game", "", "$(literal)"],
      settings: {
        runtimes: {
          ruffle: {
            defaultVersion: version
          }
        }
      },
      spawnDetachedChecked: async (cmd, args, options) => {
        launches.push({ cmd, args, options });
        return { pid: 2345 };
      },
      logger: { info: () => {} }
    });

    assert.ok(result);
    assert.equal(launches.length, 1);
    const expected = FlashModule.__test.ruffleLaunchCommand(appPath, execPath, swfPath, ["--title", "A quoted game", "", "$(literal)"]);
    assert.equal(launches[0].cmd, expected.command);
    assert.deepEqual(launches[0].args, expected.args);
    assert.equal(launches[0].options.cwd, process.platform === "darwin" ? appPath : path.dirname(swfPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtimeStatus reports ruffle readiness from installed runtimes", () => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const userDataDir = path.join(root, "userData");
    const entry = {
      gamePath: path.join(root, "game.swf"),
      moduleData: {
        swfPath: path.join(root, "game.swf")
      },
      runtimeData: {}
    };

    const missing = FlashModule.actions.runtimeStatus(entry, {}, {
      settings: { runtimes: { ruffle: {} } },
      userDataDir
    });
    assert.equal(missing.ready, false);
    assert.equal(missing.installed, false);

    const version = "nightly-2026-03-06";
    createRuffleInstall(userDataDir, version);
    const installed = FlashModule.actions.runtimeStatus(entry, {}, {
      settings: {
        runtimes: {
          ruffle: {
            defaultVersion: version
          }
        }
      },
      userDataDir
    });
    assert.equal(installed.ready, true);
    assert.equal(installed.installed, true);
    assert.equal(installed.resolvedVersion, version);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed Ruffle tracks its contained executable and keeps the literal SWF argument", t => {
  const root = makeTempDir("maclauncher-flash-module-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "nightly version", "Ruffle.app");
  const { execPath } = createAppBundle(app, "ruffle");
  const swf = "/games/name $(literal).swf";
  assert.deepEqual(FlashModule.__test.ruffleLaunchCommand(app, execPath, swf), {
    command: execPath, args: [swf]
  });
});

test("stopping a managed Flash app terminates the tracked native process", async t => {
  const root = makeTempDir("maclauncher-flash-module-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "userData");
  const version = "nightly-2026-03-06";
  const { execPath } = createRuffleInstall(userDataDir, version);
  fs.writeFileSync(execPath, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  const swfPath = path.join(root, "game.swf");
  fs.writeFileSync(swfPath, "FWS");
  const child = await FlashModule.launchRuntime("ruffle", {
    gamePath: swfPath, moduleData: { swfPath }, runtimeData: { ruffle: { version } }
  }, { userDataDir, settings: {}, spawnDetachedChecked: Processes.spawnDetachedChecked });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  assert.ok(child.pid > 0);
  process.kill(child.pid, 0);
  const exit = once(child, "exit");
  assert.equal(child.kill("SIGTERM"), true);
  await exit;
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("installRuntime persists per-game version only when explicitly requested", async t => {
  const root = makeTempDir("maclauncher-flash-module-");
  const originalResolveInstalled = RuffleCore.resolveInstalled;
  const originalInstallRuntime = RuffleManager.installRuntime;

  try {
    const userDataDir = path.join(root, "userData");
    const installedVersion = "nightly-2026-03-06";
    t.mock.method(RuffleManager, "getState", () => ({sections: [{defaultVersion: installedVersion, defaultSource: "manager", catalog: {versions: [installedVersion]}}]}));
    t.mock.method(RuffleManager, "refreshCatalog", () => assert.fail("cached release metadata needs no network"));

    RuffleCore.resolveInstalled = () => null;
    RuffleManager.installRuntime = async () => ({ version: installedVersion });

    const noOverrideEntry = {
      gamePath: path.join(root, "game.swf"),
      moduleData: {
        swfPath: path.join(root, "game.swf")
      },
      runtimeData: {}
    };

    const noOverride = await FlashModule.actions.installRuntime(noOverrideEntry, {}, {
      settings: {
        runtimes: {
          ruffle: {
            defaultVersion: installedVersion
          }
        }
      },
      userDataDir,
      logger: { info: () => {} },
      downloads: null
    });

    assert.equal(noOverride.version, installedVersion);
    assert.equal(noOverrideEntry.runtimeData.ruffle, undefined);

    const explicitEntry = {
      gamePath: path.join(root, "game.swf"),
      moduleData: {
        swfPath: path.join(root, "game.swf")
      },
      runtimeData: {}
    };

    const explicit = await FlashModule.actions.installRuntime(
      explicitEntry,
      { version: installedVersion },
      {
        settings: {
          runtimes: {
            ruffle: {
              defaultVersion: installedVersion
            }
          }
        },
        userDataDir,
        logger: { info: () => {} },
        downloads: null
      }
    );

    assert.equal(explicit.version, installedVersion);
    assert.equal(explicitEntry.runtimeData.ruffle.version, installedVersion);
  } finally {
    RuffleCore.resolveInstalled = originalResolveInstalled;
    RuffleManager.installRuntime = originalInstallRuntime;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing projector returns its exact managed install requirement without launching another backend", async t => {
  const root = makeTempDir("maclauncher-flash-module-");
  try {
    const swfPath = path.join(root, "game.swf");
    fs.writeFileSync(swfPath, "FWS");

    const version = "35.0.0.60";
    const reason = `Adobe Flash Player ${version} is not installed. Install it from Runtimes.`;
    t.mock.method(ProjectorManager, "resolveSelection", () => ({ ready: false, version, reason }));
    t.mock.method(ProjectorManager, "installRuntime", () => assert.fail("Preparation must return a requirement before download consent"));
    const entry = { gamePath: swfPath, moduleData: { swfPath }, runtimeData: { projector: { version } } };
    const context = {
      runtimeId: "projector",
      userDataDir: path.join(root, "userData"),
      settings: {},
      spawnDetachedChecked: async () => assert.fail("An uninstalled player must not launch"),
      logger: { info: () => {} }
    };
    assert.deepEqual(await FlashModule.ensureRuntime(entry, context), {
      managerId: "flash-projector", version, installOptions: { sectionId: "default" }
    });
    assert.deepEqual(FlashModule.actions.runtimeStatus(entry, {}, context), {
      ready: false, installed: false, requiredVersion: version, resolvedVersion: version
    });

    await assert.rejects(
      () => FlashModule.launchRuntime("projector", entry, context),
      { message: reason }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cold Ruffle Play confirms before catalog discovery, installs its committed fallback and reuses it offline", async t => {
  const root = makeTempDir("maclauncher-ruffle-cold-"); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const userDataDir = path.join(root,"userData"), swfPath = path.join(root,"game.swf"), version = "nightly-2026-03-06";
  fs.writeFileSync(swfPath,"FWS");
  const entry = {moduleId:FlashModule.id,runtimeId:"ruffle",gamePath:swfPath,moduleData:{swfPath},runtimeData:{}}, before = structuredClone(entry), events = [];
  let approve = false;
  t.mock.method(RuffleCore,"fetchAvailableVersions",async()=>{events.push(["catalog"]);return{versions:[version],releasesByVersion:{},source:"fixture"};});
  t.mock.method(RuffleCore,"installVersion",async options=>{events.push(["install",options.version]);return {...createRuffleInstall(userDataDir,options.version),version:options.version};});
  const {prepareForLaunch}=require("../src/core/runtime-preparation"), context={userDataDir,runtimeId:"ruffle",settings:{},confirmRuntimeInstall:async plan=>{events.push(["consent",plan.version]);return approve;}};
  const options={entry,mod:FlashModule,info:FlashModule.manifest,context,registry:{listModuleIds:()=>[FlashModule.id],getModule:()=>FlashModule},
    install:(manager,payload)=>manager.installRuntime({userDataDir,...payload}),
    runAction:name=>FlashModule.actions[name](entry,{},context)};
  assert.equal(await prepareForLaunch(options),false);
  assert.deepEqual(events,[["consent",null]],"Decline precedes all catalog I/O");
  approve=true;assert.equal(await prepareForLaunch(options),true);
  assert.deepEqual(events,[["consent",null],["consent",null],["catalog"],["install",version]]);
  const count=events.length;assert.equal(await prepareForLaunch(options),true);assert.equal(events.length,count);
  assert.deepEqual(entry,before);
});
