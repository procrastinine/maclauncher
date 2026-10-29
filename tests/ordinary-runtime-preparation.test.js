const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const { selectRuntimeVersion, managerDefaultVersion } = require("../src/modules/shared/runtime/version-choices");
function effectiveSection(section, settings = {}) {
  const saved = selectRuntimeVersion({ defaultVersion: settings.defaultVersion }).version;
  return { ...section, defaultVersion: saved || managerDefaultVersion({
    listed: (section.catalog?.versions || []).filter(version => !section.catalog?.versionRequirements?.[version]?.installReason),
    installed: (section.installed || []).filter(row => row.ready !== false).map(row => row.version)
  }), defaultSource: saved ? "saved" : "manager" };
}
const Godot = require("../src/modules/godot/main");
const Love = require("../src/modules/love/main");
const Java = require("../src/modules/java/main");
const Flash = require("../src/modules/flash/main");

// Play contexts carry the UI consent adapter; this one approves every download.
function context(runtimeId, runtimeSettings = {}) {
  return { runtimeId, userDataDir: "/test-launcher-data", settings: { runtimes: runtimeSettings }, confirmRuntimeInstall: async () => true };
}

function additionalRequirementsFixture(requirements) {
  const events = [], primary = { managerId: "host", version: "1.2.3", installOptions: { sectionId: "stable" } };
  const managers = ["host", "bridge"].map(id => ({ id, label: id,
    installRuntime: () => assert.fail("The preparation install adapter owns installations"),
    getState: () => ({ catalog: {} }) }));
  const mod = { id: "fixture", runtimeManagers: managers,
    ensureRuntime: async () => primary,
    getRuntimeRequirements: async (_entry, ctx, plan) => {
      assert.equal(ctx.runtimeId, "native"); assert.deepEqual(plan, { primary });
      return requirements;
    },
    prepareLaunch: async () => events.push("prepare") };
  const ctx = context("native");
  ctx.confirmRuntimeInstall = async plan => { events.push(`consent:${plan.managerId}`); return true; };
  const prepare = () => prepareForLaunch({ entry: {}, mod, info: { runtime: {} }, context: ctx,
    registry: { listModuleIds: () => [mod.id], getModule: () => mod },
    runAction: () => assert.fail("No preparation action was declared"),
    install: async (manager, plan) => events.push(`install:${manager.id}:${plan.version}`) });
  return { events, ctx, primary, prepare };
}

test("module-owned native bridges join the exact host plan and deduplicate before consent", async () => {
  const f = additionalRequirementsFixture([
    { managerId: "bridge", version: "0.22.0", installOptions: { sectionId: "mac", variant: "universal" } },
    { managerId: "bridge", version: "0.22.0", installOptions: { variant: "universal", sectionId: "mac" } },
    { managerId: "host", version: "1.2.3", installOptions: { sectionId: "stable" } }
  ]);
  assert.equal(await f.prepare(), true);
  assert.deepEqual(f.events, ["consent:host", "consent:bridge", "install:host:1.2.3", "install:bridge:0.22.0", "prepare"]);
});

test("declining a native bridge leaves the host and game untouched", async () => {
  const f = additionalRequirementsFixture([{ managerId: "bridge", version: "0.22.0" }]);
  f.ctx.confirmRuntimeInstall = async plan => { f.events.push(`consent:${plan.managerId}`); return plan.managerId !== "bridge"; };
  assert.equal(await f.prepare(), false);
  assert.deepEqual(f.events, ["consent:host", "consent:bridge"]);
});

test("Play without a consent adapter declines every download and installs nothing", async () => {
  const f = additionalRequirementsFixture([{ managerId: "bridge", version: "0.22.0" }]);
  delete f.ctx.confirmRuntimeInstall;
  assert.equal(await f.prepare(), false);
  assert.deepEqual(f.events, []);
});

test("included native bridge plans require no redundant download prompt", async () => {
  const f = additionalRequirementsFixture([{ managerId: "bridge", version: "included-1", requiresDownload: false }]);
  assert.equal(await f.prepare(), true);
  assert.deepEqual(f.events, ["consent:host", "install:host:1.2.3", "install:bridge:included-1", "prepare"]);
});

test("shared dependency consent and progress retain the module's asset label", async () => {
  const reports = [], consents = [], installs = [];
  const manager = { id: "host", label: "Game runtime", installRuntime() {}, getState: () => ({ catalog: {} }) };
  const mod = { id: "fixture", runtimeManagers: [manager], ensureRuntime: async () => null,
    getRuntimeRequirements: async () => [{ managerId: "host", version: "assets-1.0", label: "Game assets",
      progressLabel: "Downloading game assets…", requiresDownload: true, installOptions: { assetId: "shared" } }] };
  const ctx = context("native");
  ctx.confirmRuntimeInstall = async plan => { consents.push(plan); return true; };
  assert.equal(await prepareForLaunch({ entry: {}, mod, info: { runtime: {} }, context: ctx,
    registry: { listModuleIds: () => [mod.id], getModule: () => mod },
    report: state => reports.push(state), runAction: () => assert.fail("No game preparation action"),
    install: async (selected, payload, labels) => installs.push({ selected: selected.id, payload, labels }) }), true);
  assert.equal(consents[0].label, "Game assets");
  assert.deepEqual(reports[0], { phase: "install", label: "Downloading game assets…", managerId: "host", version: "assets-1.0" });
  assert.deepEqual(installs, [{ selected: "host", payload: { assetId: "shared", version: "assets-1.0" },
    labels: { label: "Game assets", progressLabel: "Downloading game assets…" } }]);
});

test("download consent uses the selected section's display label while installation retains the exact version", async () => {
  const rawVersion = "snapshot-" + "a".repeat(40) + "-" + "b".repeat(64);
  for (const [map, explicit, expected] of [
    ["section", undefined, "Snapshot · 2026-10-10"],
    ["catalog", undefined, "Snapshot · 2026-10-10"],
    ["section", "Translated snapshot", "Translated snapshot"],
    [null, undefined, undefined]
  ]) {
    const consents = [], installations = [];
    const selected = { id: "selected", catalog: { versionRequirements: { [rawVersion]: { requiresDownload: true } } } };
    if (map === "section") selected.versionLabels = { [rawVersion]: "Snapshot · 2026-10-10" };
    if (map === "catalog") selected.catalog.versionLabels = { [rawVersion]: "Snapshot · 2026-10-10" };
    const manager = { id: "fixture", label: "Player", installRuntime() {}, getState: () => ({
      sections: [{ id: "unrelated", versionLabels: { [rawVersion]: "Different channel" }, catalog: {} }, selected]
    }) };
    const mod = { id: "fixture", runtimeManagers: [manager], ensureRuntime: async () => ({
      managerId: manager.id, version: rawVersion, ...(explicit ? { versionLabel: explicit } : {}),
      installOptions: { sectionId: "selected", variant: "arm64" }
    }) };
    const ctx = context("managed");
    ctx.confirmRuntimeInstall = async plan => { consents.push(plan); return true; };
    assert.equal(await prepareForLaunch({ entry: {}, mod, info: { runtime: {} }, context: ctx,
      registry: { listModuleIds: () => [mod.id], getModule: () => mod },
      runAction: () => assert.fail("No game preparation action"),
      install: async (target, plan) => installations.push({ id: target.id, plan }) }), true);
    assert.equal(consents.length, 1);
    assert.equal(consents[0].versionLabel, expected);
    assert.equal(consents[0].version, rawVersion);
    assert.equal(consents[0].label, "Player");
    assert.deepEqual(installations, [{ id: manager.id, plan: { sectionId: "selected", variant: "arm64", version: rawVersion } }]);
  }
});

test("invalid additional runtime plans fail before consent or installation", async () => {
  for (const requirements of [null, {}, [{ managerId: "bridge" }], [{ managerId: "bridge", version: 22 }]]) {
    const f = additionalRequirementsFixture(requirements);
    await assert.rejects(f.prepare(), /exact manager\/version plans/);
    assert.deepEqual(f.events, []);
  }
});

test("unknown additional runtime managers prevent every installation", async () => {
  const f = additionalRequirementsFixture([{ managerId: "unknown", version: "1.0.0" }]);
  await assert.rejects(f.prepare(), /cannot be installed automatically/);
  assert.deepEqual(f.events, []);
});

test("cold Play consents before discovery and resumes with the manager default", async () => {
  for (const approved of [false, true]) for (const hasSelection of [false, true]) {
    const events = [];let versions=[];
    const manager = {id:"cold-player",label:"Cold player",getState:({settings}={})=>effectiveSection({
      supportsDefault:true,catalog:{versions:versions.filter(version=>!/-.*(?:beta|alpha|rc)/i.test(version))},installed:[]},settings),
      refreshCatalog:async()=>{events.push("discover");versions=["3.0.0-beta1","2.0.0","1.0.0"];},installRuntime(){}};
    if(hasSelection) manager.resolveSelection=(_entry,settings)=>({version:manager.getState({settings:settings.runtimes[manager.id]}).defaultVersion,
      ready:false,requiresDownload:true,discoveryRequired:versions.length===0});
    const mod={id:"cold-module",runtimeManagers:[manager],prepareLaunch:async()=>events.push("prepare")};
    const ctx={...context("native"),confirmRuntimeInstall:async()=>{events.push("consent");return approved;}};
    const prepare=()=>prepareForLaunch({entry:{},mod,info:{runtime:{manager:{native:manager.id}}},context:ctx,
      registry:{listModuleIds:()=>[mod.id],getModule:()=>mod},runAction:()=>assert.fail("No game action"),
      install:async(_manager,plan)=>{assert.equal(plan.version,"2.0.0");events.push("install");}});
    assert.equal(await prepare(),approved);
    assert.deepEqual(events,approved?["consent","discover","install","prepare"]:["consent"]);
    assert.deepEqual(ctx.settings.runtimes,{},"Play does not save a manual preference");
  }
});

test("additional deferred companions share the complete consent boundary", async () => {
  const f = additionalRequirementsFixture([{ managerId: "bridge", version: null, discoveryRequired: true }]);
  // Its manager owns deferred discovery, as project Builds managers do.
  f.ctx.confirmRuntimeInstall = async plan => { f.events.push(`consent:${plan.managerId}`); return false; };
  assert.equal(await f.prepare(), false);
  assert.deepEqual(f.events, ["consent:host"]);
});
test("a companion with cached choices uses its manager default before consent", async () => {
  const version=managerDefaultVersion({listed:["2.0.0","1.0.0"]});
  const f=additionalRequirementsFixture([{managerId:"bridge",version}]);
  assert.equal(await f.prepare(),true);
  assert.deepEqual(f.events,["consent:host","consent:bridge","install:host:1.2.3","install:bridge:2.0.0","prepare"]);
});

function preventDownloads(t, manager) {
  t.mock.method(manager, "installRuntime", () => { throw new Error("Runtime planning must not download or install"); });
}
function godotFixture(t, { versions = [], installed = [], refreshed = versions, mode = "all" } = {}) {
  const manager = Godot.runtimeManagers[0], calls = [];
  let catalog = versions, catalogMode = mode;
  t.mock.method(manager.core, "listInstalled", () => installed);
  t.mock.method(manager, "getState", ({settings}={}) => effectiveSection({ catalog: { versions: catalog, mode: catalogMode, status: "success" }, installed },settings));
  t.mock.method(manager, "refreshCatalog", async payload => { calls.push(payload); catalog = refreshed; catalogMode = "all"; });
  preventDownloads(t, manager);
  return { manager, calls, installed };
}
function javaFixture(t, { sections = [], refreshed = sections, installed = null } = {}) {
  const manager = Java.runtimeManagers[0], calls = [];
  let catalog = sections;
  t.mock.method(manager, "getState", ({settings}={}) => ({ sections: catalog.map(section=>effectiveSection(section,settings?.lines?.[section.id])) }));
  t.mock.method(manager, "refreshCatalog", async payload => { calls.push(payload); catalog = refreshed; });
  t.mock.method(manager.core.java, "resolveBestInstalled", options => typeof installed === "function" ? installed(options) : installed);
  preventDownloads(t, manager);
  return { manager, calls };
}
function loveFixture(t, { stable = [], nightly = [], status = "success", nightlyDefault = null,
  installed = null, matchingNightly = null, refreshedStable = stable, refreshedNightly = nightly } = {}) {
  const manager = Love.runtimeManagers[0], calls = [];
  let stableVersions = stable, nightlyVersions = nightly, stableStatus = status;
  t.mock.method(manager, "getState", ({settings}={}) => ({ sections: [
    effectiveSection({ id: "stable", catalog: { versions: stableVersions, status: stableStatus }, installed: [] },settings?.stable),
    effectiveSection({ id: "nightly", catalog: { versions: nightlyVersions, status: "success" }, installed: [] },settings?.nightly || {defaultVersion:nightlyDefault})
  ] }));
  t.mock.method(manager, "refreshCatalog", async payload => {
    calls.push(payload);
    if (payload.sectionId === "stable") { stableVersions = refreshedStable; stableStatus = "success"; }
    else nightlyVersions = refreshedNightly;
  });
  t.mock.method(manager.core, "resolveInstalled", options => typeof installed === "function" ? installed(options) : installed);
  t.mock.method(manager.core, "findNightlyByBundleVersion", () => typeof matchingNightly === "function" ? matchingNightly() : matchingNightly);
  preventDownloads(t, manager);
  return { manager, calls };
}
function ruffleFixture(t, { versions = [], refreshed = versions, installed = [], resolveInstalled = () => null } = {}) {
  const manager = Flash.runtimeManagers[0], calls = [];
  let catalog = versions;
  t.mock.method(manager, "getState", ({settings}={}) => { const section=effectiveSection({id:"default",installed,catalog:{versions:catalog}},settings);return {...section,sections:[section]}; });
  t.mock.method(manager, "refreshCatalog", async payload => { calls.push(payload); catalog = refreshed; });
  t.mock.method(manager.core, "listInstalled", () => installed);
  t.mock.method(manager.core, "resolveInstalled", resolveInstalled);
  preventDownloads(t, manager);
  return { manager, calls };
}

test("Godot Play prefers the detected recommendation over the global choice, which applies without detection", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable", "3.2-stable"] });
  const entry = { moduleData: { detectedVersion: "3.2.0", detectedMajor: 3 } };
  const ctx = context("godot", { godot: { defaultVersion: "4.6-stable" } });
  const saved = structuredClone(ctx.settings);
  assert.deepEqual(await Godot.ensureRuntime(entry, ctx), { managerId: "godot", version: "3.2-stable", installOptions: { sectionId: "default", variant: "mono" } });
  assert.equal((await Godot.ensureRuntime(entry, context("godot"))).version, "3.2-stable");
  assert.equal((await Godot.ensureRuntime({}, ctx)).version, "4.6-stable");
  assert.deepEqual(ctx.settings, saved);
  assert.equal(f.calls.length, 0);
});

test("Godot Play reuses a matching x.y runtime for detected x.y.0 without refresh", async t => {
  const f = godotFixture(t, { installed: [{ version: "3.2-stable", variant: "mono", appPath: "/ready/Godot.app" }] });
  assert.equal(await Godot.ensureRuntime({ moduleData: { detectedVersion: "3.2.0", detectedMajor: 3 } }, context("godot")), null);
  assert.equal(f.calls.length, 0);
});

test("Godot major-only detection refreshes full history, then uses that major's default", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable"], mode: "latest", refreshed: ["4.6-stable", "3.5.3-stable", "3.4.5-stable"] });
  const entry = { moduleData: { detectedVersion: "3.1.x", detectedMajor: 3 } };
  const plan = await Godot.ensureRuntime(entry, context("godot"));
  assert.equal(plan.version, null); assert.equal(plan.discoveryRequired, true);
  assert.equal(f.calls.length, 0, "Planning stays offline before consent");
  await f.manager.refreshCatalog({ latestOnly: false });
  assert.equal((await Godot.ensureRuntime(entry, context("godot"))).version,"3.5.3-stable");
  assert.equal((await Godot.ensureRuntime(entry, context("godot", { godot: { defaultVersions: { 4: "4.6-stable" } } }))).version,"3.5.3-stable");
  assert.equal((await Godot.ensureRuntime(entry, context("godot", { godot: { defaultVersions: { 3: "3.4.5-stable", 4: "4.6-stable" } } }))).version, "3.4.5-stable");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].latestOnly, false);
});

test("Godot explicit version overrides detection and fails rather than changing release buckets", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable", "4.1.3-stable", "3.2-stable"] });
  const entry = { moduleData: { detectedVersion: "3.2", detectedMajor: 3 }, runtimeData: { godot: { version: "4.1.3" } } };
  assert.equal((await Godot.ensureRuntime(entry, context("godot"))).version, "4.1.3-stable");
  entry.runtimeData.godot.version = "4.1.2";
  assert.equal((await Godot.ensureRuntime(entry, context("godot"))).version, "4.1.2");
  assert.equal(f.calls.length, 0, "Unknown exact metadata is acquired only after download consent");
});

test("Godot native app selection does not inspect catalogs or install another runtime", async t => {
  const manager = Godot.runtimeManagers[0];
  t.mock.method(manager, "getState", () => { throw new Error("Native apps do not need a runtime catalog"); });
  assert.equal(await Godot.ensureRuntime({}, context("native")), null);
});

test("Java Play uses the detected line before the global line and takes the patch from that line's default", async t => {
  const f = javaFixture(t, { sections: [{ id: "8", catalog: { versions: ["8.0.482+8"] } }, { id: "17", catalog: { versions: ["17.0.18+8"] } }] });
  const ctx = context("java", { java: { defaultLine: 8, lines: { 8: { defaultVersion: "8.0.482+8" }, 17: { defaultVersion: "17.0.18+8" } } } });
  const saved = structuredClone(ctx.settings);
  const plan = await Java.ensureRuntime({ moduleData: { requiredJava: 17 }, runtimeData: { java: { line: null, variant: "arm64" } } }, ctx);
  assert.deepEqual(plan, { managerId: "java", version: "17.0.18+8", installOptions: { sectionId: "17", line: 17, variant: "arm64" } });
  assert.equal((await Java.ensureRuntime({}, ctx)).version, "8.0.482+8");
  const unset = await Java.ensureRuntime({ moduleData: { requiredJava: 17 } }, context("java", { java: { defaultLine: 8 } }));
  assert.equal(unset.installOptions.line, 17); assert.equal(unset.version, "17.0.18+8"); assert.notEqual(unset.selectionRequired, true);
  assert.deepEqual(ctx.settings, saved);
  assert.equal(f.calls.length, 0);
});

test("Java Play preserves exact overrides for a higher compatible line and architecture", async t => {
  const f = javaFixture(t);
  const plan = await Java.ensureRuntime({ moduleData: { requiredJava: 17 }, runtimeData: { java: { line: 21, version: "21.0.8+9", variant: "x64" } } }, context("java"));
  assert.deepEqual(plan, { managerId: "java", version: "21.0.8+9", installOptions: { sectionId: "21", line: 21, variant: "x64" } });
  assert.equal(f.calls.length, 0);
});

test("Java Play reuses the existing compatible-line installation when no exact patch is selected", async t => {
  const f = javaFixture(t, { installed: options => options.line === 17 && options.version === null
    ? { javaPath: "/ready/bin/java", version: "17.0.17+10", variant: "arm64", requiresRosetta: false } : null });
  const ctx = context("java", { java: { defaultLine: 17 } });
  assert.equal(await Java.ensureRuntime({ moduleData: { requiredJava: 17 } }, ctx), null);
  assert.equal(f.calls.length, 0);
});

test("Java empty catalog planning discovers the detected line and uses its patch default", async t => {
  const f = javaFixture(t, { refreshed: [{ id: "17", catalog: { versions: ["17.0.18+8"] } }] });
  const plan = await Java.ensureRuntime({ moduleData: { runtimeLine: 17 } }, context("java"));
  assert.equal(plan.version, null); assert.equal(plan.discoveryRequired, true);
  assert.equal(f.calls.length, 0);
  await f.manager.refreshCatalog({ sectionId: plan.installOptions.sectionId });
  const refreshed = await Java.ensureRuntime({ moduleData: { runtimeLine: 17 } }, context("java"));
  assert.equal(refreshed.version, "17.0.18+8"); assert.notEqual(refreshed.selectionRequired, true);
  assert.equal(refreshed.installOptions.sectionId, "17");
  assert.deepEqual(f.calls.map(call => call.sectionId), ["17"]);
});

test("Java unsupported lines and missing Rosetta fail before any runtime download", async t => {
  const f = javaFixture(t, { installed: { javaPath: "/ready/bin/java", requiresRosetta: true } });
  await assert.rejects(Java.ensureRuntime({ moduleData: { requiredJava: 27 } }, context("java")), /requires Java 27.*up to Java 25/);
  t.mock.method(f.manager.core.java, "isRosettaAvailable", () => false);
  await assert.rejects(Java.ensureRuntime({ moduleData: { requiredJava: 8 } }, context("java")), { code: "ROSETTA_REQUIRED" });
  assert.equal(f.calls.length, 0);
});

test("Java installed Intel runtimes use the injected shared prerequisite before launch planning", async t => {
  const f = javaFixture(t, { installed: { javaPath: "/ready/bin/java", requiresRosetta: true } });
  let available = false, installed = 0;
  t.mock.method(f.manager.core.java, "isRosettaAvailable", () => available);
  const ctx = context("java");
  ctx.ensureRosetta = async () => { installed += 1; available = true; };
  assert.equal(await Java.ensureRuntime({ moduleData: { requiredJava: 8 } }, ctx), null);
  assert.equal(await Java.ensureRuntime({ moduleData: { requiredJava: 8 } }, ctx), null);
  assert.equal(installed, 1);
  assert.equal(f.calls.length, 0);
});

test("LÖVE Play prefers a detected release over the global release choice, which applies without detection", async t => {
  const f = loveFixture(t, { stable: ["11.5", "11.4"], nightly: ["new-nightly"] });
  const ctx = context("love", { love: { stable: { defaultVersion: "11.4" }, nightly: { defaultVersion: "new-nightly" } } });
  const saved = structuredClone(ctx.settings);
  assert.deepEqual(await Love.ensureRuntime({ moduleData: { detectedVersion: "11.5" } }, ctx), { managerId: "love", version: "11.5", installOptions: { sectionId: "stable" } });
  assert.equal((await Love.ensureRuntime({ moduleData: { detectedVersion: "11.5" } }, context("love"))).version, "11.5");
  assert.equal((await Love.ensureRuntime({}, context("love", { love: { stable: { defaultVersion: "11.4" } } }))).version, "11.4");
  assert.deepEqual(ctx.settings, saved);
  assert.equal(f.calls.length, 0);
});

test("LÖVE Play reuses an installed matching development bundle without refreshing artifacts", async t => {
  const nightly = { channel: "nightly", version: "installed-hash", buildKey: "installed-hash", appPath: "/ready/love.app", ready: true };
  const f = loveFixture(t, { stable: ["11.5"], matchingNightly: nightly,
    installed: options => options.channel === "nightly" && options.version === nightly.version ? nightly : null });
  assert.equal(await Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" } }, context("love")), null);
  assert.equal(f.calls.length, 0);
});

test("LÖVE unreleased detection checks releases and bounded artifacts before using the nightly default", async t => {
  const f = loveFixture(t, { status: "idle", refreshedStable: ["11.5"], refreshedNightly: ["2026-10-01T01-00-00Z-abcdef0"] });
  const plan = await Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" } }, context("love"));
  assert.equal(plan.version, null); assert.equal(plan.discoveryRequired, true);
  assert.equal(f.calls.length, 0);
  await f.manager.refreshCatalog({ sectionId: "stable", latestOnly: false });
  const nightly = await Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" } }, context("love"));
  assert.equal(nightly.installOptions.sectionId, "nightly");
  await f.manager.refreshCatalog({ sectionId: "nightly", latestOnly: true });
  const selected=await Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" } }, context("love"));
  assert.equal(selected.version,"2026-10-01T01-00-00Z-abcdef0");assert.equal(selected.installOptions.sectionId,"nightly");
  assert.deepEqual(f.calls.map(call => [call.sectionId, call.latestOnly]), [["stable", false], ["nightly", true]]);
});

test("LÖVE explicit releases never fall back to another nightly build", async t => {
  const f = loveFixture(t, { stable: ["11.5"], nightly: ["available-nightly"] });
  const selected = await Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" }, runtimeData: { love: { channel: "stable", version: "12.0" } } }, context("love"));
  assert.equal(selected.version, "12.0"); assert.equal(selected.installOptions.sectionId, "stable");
  assert.deepEqual(f.calls, []);
});

test("LÖVE saved nightly builds load their exact artifact metadata instead of a newer build", async t => {
  const f = loveFixture(t, { stable: ["11.5"], nightly: ["new-hash"], refreshedNightly: ["new-hash", "old-hash"] });
  const entry = { moduleData: { detectedVersion: "12.0" }, runtimeData: { love: { channel: "nightly", version: "old-hash" } } };
  assert.deepEqual(await Love.ensureRuntime(entry, context("love")), { managerId: "love", version: "old-hash", installOptions: { sectionId: "nightly" } });
  assert.deepEqual(f.calls, [], "Exact artifact discovery waits for approved installation");
});

test("LÖVE missing explicit artifacts remain exact before consent and native app mode remains local", async t => {
  const f = loveFixture(t, { nightly: ["new-hash"] });
  assert.equal((await Love.ensureRuntime({ runtimeData: { love: { channel: "nightly", version: "expired-hash" } } }, context("love"))).version, "expired-hash");
  const before = f.calls.length;
  assert.equal(await Love.ensureRuntime({}, context("native")), null);
  assert.equal(f.calls.length, before);
});

test("Ruffle Play preserves an explicit version instead of downloading the manager default", async t => {
  const f = ruffleFixture(t, { installed: [{ version: "nightly-2026-01-01" }] });
  const ctx = context("ruffle", { ruffle: { defaultVersion: "nightly-2026-01-01" } }), saved = structuredClone(ctx.settings);
  assert.deepEqual(await Flash.ensureRuntime({ runtimeData: { ruffle: { version: "nightly-2026-02-02" } } }, ctx), { managerId: "ruffle", version: "nightly-2026-02-02", installOptions: { sectionId: "default" } });
  assert.deepEqual(ctx.settings, saved);
  assert.equal(f.calls.length, 0);
});

test("Ruffle Play keeps an exact global choice instead of substituting another installed version", async t => {
  const f = ruffleFixture(t, { installed: [{ version: "nightly-2026-02-02" }, {version: "nightly-2026-01-01"}], resolveInstalled: options => options.version === "nightly-2026-02-02" ? { appPath: "/ready/Ruffle.app" } : null });
  assert.equal((await Flash.ensureRuntime({}, context("ruffle", {ruffle: {defaultVersion: "nightly-2026-01-01"}}))).version, "nightly-2026-01-01");
  assert.equal(f.calls.length, 0);
});

test("shared preparation uses effective manager defaults, exact overrides and CPU compatibility", async () => {
  for(const [override,expected] of [[{},"3"],[{version:"2"},null],[{version:"4"},"4"],[{version:"1"},"1"]]) {
    const installs=[],uses=[];
    const section=effectiveSection({supportsDefault:true,defaultVariant:"arm64",installed:[
      {version:"4",variant:"x64",ready:true},{version:"3",variant:"arm64",ready:false},{version:"2",variant:"arm64",ready:true}
    ],catalog:{versions:["3","2","1"]}});
    const manager={id:"player",getState:()=>section,installRuntime(){assert.fail("adapter owns install");},refreshCatalog(){assert.fail("cached choices need no network");}};
    const mod={id:"example",runtimeManagers:[manager]},ctx={...context("runner"),recordRuntimeUse:use=>uses.push(use)};
    assert.equal(await prepareForLaunch({entry:{runtimeData:{runner:override}},mod,info:{runtime:{manager:{runner:"player"}}},context:ctx,
      registry:{listModuleIds:()=>[mod.id],getModule:()=>mod},runAction:()=>assert.fail("no game actions"),install:async(_manager,plan)=>installs.push(plan)}),true);
    if(expected)assert.equal(installs[0].version,expected);
    else {assert.equal(installs.length,0);assert.equal(uses[0].version,"2");assert.equal(uses[0].variant,"arm64");}
  }
  const manager={id:"cleared-player",getState:({settings}={})=>effectiveSection({supportsDefault:true,installed:[{version:"2",ready:true}],catalog:{versions:["2"]}},settings),installRuntime(){}};
  const mod={id:"cleared-module",runtimeManagers:[manager]};
  assert.equal(await prepareForLaunch({entry:{},mod,info:{runtime:{manager:{runner:manager.id}}},context:context("runner",{[manager.id]:{defaultVersion:null}}),
    registry:{listModuleIds:()=>[mod.id],getModule:()=>mod},runAction:()=>assert.fail("no extra action"),install:()=>assert.fail("ready manager default needs no install")}),true);
});

test("Ruffle first install refreshes full releases only when the catalog is empty", async t => {
  const f = ruffleFixture(t, { refreshed: ["nightly-2026-02-02", "nightly-2026-01-01"] });
  const plan = await Flash.ensureRuntime({}, context("ruffle"));
  assert.equal(plan.version, null); assert.equal(plan.discoveryRequired, true);
  assert.equal(f.calls.length, 0, "Planning does not discover a package before consent");
});

test("managed Adobe projector plans its own download without consulting Ruffle", async t => {
  const ruffle = Flash.runtimeManagers.find(manager => manager.id === "ruffle");
  t.mock.method(ruffle, "getState", () => { throw new Error("Projector selection cannot consult Ruffle"); });
  t.mock.method(ruffle, "refreshCatalog", () => { throw new Error("Projector planning remains offline"); });
  const manager = Flash.runtimeManagers.find(manager => manager.id === "flash-projector");
  t.mock.method(manager, "resolveSelection", () => ({ ready: false, version: "35.0.0.60-MCLv1" }));
  assert.deepEqual(await Flash.ensureRuntime({}, context("projector")), { managerId: "flash-projector", version: "35.0.0.60-MCLv1", installOptions: { sectionId: "default" } });
});

test("an installed Adobe projector needs no dependency prompt or download", async t => {
  const manager = Flash.runtimeManagers.find(manager => manager.id === "flash-projector");
  t.mock.method(manager, "resolveSelection", () => ({ ready: true, version: "35.0.0.60-MCLv1" }));
  assert.equal(await Flash.ensureRuntime({}, context("projector")), null);
});

test("shared headless preparation installs the detected Godot once and skips the legacy installer", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable", "3.2-stable"] });
  const entry = { moduleData: { detectedVersion: "3.2.0", detectedMajor: 3 } }, ctx = context("godot");
  const approvals = [], installs = [], actions = [];
  ctx.confirmRuntimeInstall = async plan => { approvals.push(plan.version); return true; };
  const prepare = () => prepareForLaunch({ entry, mod: Godot, info: Godot.manifest, context: ctx,
    registry: { listModuleIds: () => ["godot"], getModule: () => Godot },
    runAction: async id => { actions.push(id); assert.equal(id, "runtimeStatus"); return Godot.actions[id](entry, {}, ctx); },
    install: async (manager, payload) => { installs.push(payload.version); f.installed.push({ version: payload.version, variant: payload.variant, appPath: "/ready/Godot.app" }); }
  });
  assert.equal(await prepare(), true);
  assert.equal(await prepare(), true);
  assert.deepEqual(installs, ["3.2-stable"]);
  assert.deepEqual(approvals, ["3.2-stable"]);
  assert.deepEqual(actions, ["runtimeStatus", "runtimeStatus"]);
  assert.deepEqual(ctx.settings.runtimes, {});
});

test("shared LÖVE preparation installs a chosen nightly once without another legacy download", async t => {
  let installed = null;
  const f = loveFixture(t, { stable: ["11.5"], nightly: ["newer-hash", "selected-hash"],
    installed: options => options.channel === "nightly" && options.version === installed?.buildKey ? installed : null });
  const entry = { moduleData: { detectedVersion: "12.0" }, runtimeData: { love: { channel: "nightly", version: "selected-hash" } } };
  const ctx = context("love"), installs = [];
  const prepare = () => prepareForLaunch({ entry, mod: Love, info: Love.manifest, context: ctx,
    registry: { listModuleIds: () => ["love"], getModule: () => Love },
    runAction: async id => { assert.equal(id, "runtimeStatus"); return Love.actions[id](entry, {}, ctx); },
    install: async (manager, payload) => { installs.push(payload.version); installed = { channel: "nightly", buildKey: payload.version, appPath: "/ready/love.app", bundleVersionNormalized: "12.0" }; }
  });
  assert.equal(await prepare(), true);
  assert.equal(await prepare(), true);
  assert.deepEqual(installs, ["selected-hash"]);
  assert.equal(f.calls.length, 0);
});

test("cold LÖVE preparation keeps declared-version evidence through consented release and nightly discovery", async t => {
  let installed = null, approvals = 0;
  const f = loveFixture(t, { status: "idle", refreshedStable: ["11.5"], refreshedNightly: ["declared-development-build"],
    installed: options => options.channel === "nightly" && options.version === installed?.buildKey ? installed : null });
  const entry = { moduleData: { detectedVersion: "12.0" } }, ctx = context("love"), installs = [];
  ctx.confirmRuntimeInstall = async () => { approvals++; return true; };
  const prepare = () => prepareForLaunch({ entry, mod: Love, info: Love.manifest, context: ctx,
    registry: { listModuleIds: () => [Love.id], getModule: () => Love },
    runAction: async id => Love.actions[id](entry, {}, ctx),
    install: async (_manager, payload) => { installs.push(payload); installed = { channel: "nightly", buildKey: payload.version,
      appPath: "/ready/love.app", bundleVersionNormalized: "12.0" }; } });
  assert.equal(await prepare(),true);
  assert.equal(approvals, 2);
  assert.deepEqual(f.calls.map(call => call.sectionId), ["stable", "nightly"]);
  assert.deepEqual(f.calls.map(call => call.latestOnly), [false, true], "Development-family discovery keeps the bounded latest-artifact query");
  assert.deepEqual(installs, [{sectionId:"nightly",version:"declared-development-build"}]);
  entry.runtimeData = { love: { channel: "nightly", version: "declared-development-build" } };
  assert.equal(await prepare(), true); assert.equal(await prepare(), true);
  assert.equal(approvals, 2);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(installs, [{ sectionId: "nightly", version: "declared-development-build" }]);
});

test("Ren'Py SDK planning keeps game generation and version evidence and exact global and game choices offline", async t => {
  const Renpy = require("../src/modules/renpy/main"), manager = Renpy.runtimeManagers[0];
  t.mock.method(manager.core, "listInstalled", () => []);
  t.mock.method(manager, "getState", ({settings}={}) => ({ sections: [effectiveSection({id:"v8",catalog:{versions:["8.6.1","8.0.0"]},installed:[]},settings?.v8)] }));
  t.mock.method(manager, "refreshCatalog", () => assert.fail("SDK planning stays offline"));
  const entry = { moduleData: { major: 8 }, runtimeData: {} }, ctx = context("sdk");
  assert.deepEqual(await Renpy.ensureRuntime(entry, ctx), { managerId: "sdk", version: "8.6.1", installOptions: { major: 8, sectionId: "v8" } });
  ctx.settings.runtimes.sdk = { v8: { defaultVersion: "8.0.0" } };
  assert.equal((await Renpy.ensureRuntime(entry, ctx)).version, "8.0.0");
  entry.moduleData.version = "8.6.1";
  assert.equal((await Renpy.ensureRuntime(entry, ctx)).version, "8.6.1");
  entry.runtimeData.sdk = { version: "8.4.1" };
  assert.equal((await Renpy.ensureRuntime(entry, ctx)).version, "8.4.1");
});

test("saved Android GLES 3.2 selection joins ordinary consent, installation and offline reuse", async t => {
  const Android = require("../src/modules/android/custom-main");
  const manager = require("../src/modules/shared/vulkan/managed").manager;
  const events = [], uses = [];
  let ready = false, approved = false;
  t.mock.method(Android, "ensureRuntime", () => null);
  t.mock.method(manager, "resolveSelection", () => ({version:"selected-gles32",ready,
    install:ready ? {installDir:"/installed/graphics"} : null}));
  t.mock.method(manager, "getState", () => ({catalog:{}}));
  t.mock.method(manager, "installRuntime", async options => {
    events.push(["install",options.version]); ready = true;
  });
  const ctx = {...context("klepton"),runtimeSettings:{vulkanRuntime:"kosmickrisp:maclauncher-gles32"},
    confirmRuntimeInstall: async plan => {events.push(["consent",plan.managerId,plan.version]);return approved;},
    recordRuntimeUse: row => uses.push(row)};
  const prepare = () => prepareForLaunch({entry:{},mod:Android,info:Android.manifest,context:ctx,
    registry:{listModuleIds:()=>[Android.id],getModule:()=>Android,listSharedRuntimeManagers:()=>[manager]},
    runAction:()=>assert.fail("No extra Android setup action is required"),
    install:async (selected,options)=>selected.installRuntime(options)});
  assert.equal(await prepare(),false);
  assert.deepEqual(events,[["consent",manager.id,"selected-gles32"]]);
  approved = true;
  assert.equal(await prepare(),true);
  assert.deepEqual(events.at(-1),["install","selected-gles32"]);
  events.length = 0;
  assert.equal(await prepare(),true);
  assert.deepEqual(events,[]);
  assert.equal(uses[0].managerId,manager.id);
  assert.equal(uses[0].sourcePath,"/installed/graphics");
});
