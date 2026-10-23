const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const Godot = require("../src/modules/godot/main");
const Love = require("../src/modules/love/main");
const Java = require("../src/modules/java/main");
const Flash = require("../src/modules/flash/main");

function context(runtimeId, runtimeSettings = {}) {
  return { runtimeId, userDataDir: "/test-launcher-data", settings: { runtimes: runtimeSettings } };
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
function preventDownloads(t, manager) {
  t.mock.method(manager, "installRuntime", () => { throw new Error("Runtime planning must not download or install"); });
}
function godotFixture(t, { versions = [], installed = [], refreshed = versions } = {}) {
  const manager = Godot.runtimeManagers[0], calls = [];
  let catalog = versions;
  t.mock.method(manager.core, "listInstalled", () => installed);
  t.mock.method(manager, "getState", () => ({ catalog: { versions: catalog }, installed }));
  t.mock.method(manager, "refreshCatalog", async payload => { calls.push(payload); catalog = refreshed; });
  preventDownloads(t, manager);
  return { manager, calls, installed };
}
function javaFixture(t, { sections = [], refreshed = sections, installed = null } = {}) {
  const manager = Java.runtimeManagers[0], calls = [];
  let catalog = sections;
  t.mock.method(manager, "getState", () => ({ sections: catalog }));
  t.mock.method(manager, "refreshCatalog", async payload => { calls.push(payload); catalog = refreshed; });
  t.mock.method(manager.core.java, "resolveBestInstalled", options => typeof installed === "function" ? installed(options) : installed);
  preventDownloads(t, manager);
  return { manager, calls };
}
function loveFixture(t, { stable = [], nightly = [], status = "success", nightlyDefault = null,
  installed = null, matchingNightly = null, refreshedStable = stable, refreshedNightly = nightly } = {}) {
  const manager = Love.runtimeManagers[0], calls = [];
  let stableVersions = stable, nightlyVersions = nightly, stableStatus = status;
  t.mock.method(manager, "getState", () => ({ sections: [
    { id: "stable", defaultVersion: null, catalog: { versions: stableVersions, status: stableStatus }, installed: [] },
    { id: "nightly", defaultVersion: nightlyDefault, catalog: { versions: nightlyVersions, status: "success" }, installed: [] }
  ] }));
  t.mock.method(manager, "refreshCatalog", async payload => {
    calls.push(payload);
    if (payload.sectionId === "stable") { stableVersions = refreshedStable; stableStatus = "success"; }
    else nightlyVersions = refreshedNightly;
  });
  t.mock.method(manager.core, "resolveInstalled", options => typeof installed === "function" ? installed(options) : installed);
  t.mock.method(manager.core, "resolveLatestInstalled", () => null);
  t.mock.method(manager.core, "findNightlyByBundleVersion", () => typeof matchingNightly === "function" ? matchingNightly() : matchingNightly);
  preventDownloads(t, manager);
  return { manager, calls };
}
function ruffleFixture(t, { versions = [], refreshed = versions, installed = [], resolveInstalled = () => null } = {}) {
  const manager = Flash.runtimeManagers[0], calls = [];
  let catalog = versions;
  t.mock.method(manager, "getState", () => ({ sections: [{ id: "default", catalog: { versions: catalog } }] }));
  t.mock.method(manager, "refreshCatalog", async payload => { calls.push(payload); catalog = refreshed; });
  t.mock.method(manager.core, "listInstalled", () => installed);
  t.mock.method(manager.core, "resolveInstalled", resolveInstalled);
  preventDownloads(t, manager);
  return { manager, calls };
}

test("Godot Play plans the detected release bucket instead of the unrelated manager default", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable", "3.2-stable"] });
  const entry = { moduleData: { detectedVersion: "3.2.0", detectedMajor: 3 } };
  const ctx = context("godot", { godot: { defaultVersion: "4.6-stable" } });
  const saved = structuredClone(ctx.settings);
  assert.deepEqual(await Godot.ensureRuntime(entry, ctx), { managerId: "godot", version: "3.2-stable", installOptions: { sectionId: "default", variant: "mono" } });
  assert.deepEqual(ctx.settings, saved);
  assert.equal(f.calls.length, 0);
});

test("Godot Play reuses a matching x.y runtime for detected x.y.0 without refresh", async t => {
  const f = godotFixture(t, { installed: [{ version: "3.2-stable", variant: "mono", appPath: "/ready/Godot.app" }] });
  assert.equal(await Godot.ensureRuntime({ moduleData: { detectedVersion: "3.2.0", detectedMajor: 3 } }, context("godot")), null);
  assert.equal(f.calls.length, 0);
});

test("Godot major-only detection refreshes full history and stays within that major", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable"], refreshed: ["4.6-stable", "3.5.3-stable", "3.4.5-stable"] });
  const plan = await Godot.ensureRuntime({ moduleData: { detectedVersion: "3.1.x", detectedMajor: 3 } }, context("godot"));
  assert.equal(plan.version, "3.5.3-stable");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].latestOnly, false);
});

test("Godot explicit version overrides detection and fails rather than changing release buckets", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable", "4.1.3-stable", "3.2-stable"] });
  const entry = { moduleData: { detectedVersion: "3.2", detectedMajor: 3 }, runtimeData: { godot: { version: "4.1.3" } } };
  assert.equal((await Godot.ensureRuntime(entry, context("godot"))).version, "4.1.3-stable");
  entry.runtimeData.godot.version = "4.1.2";
  await assert.rejects(Godot.ensureRuntime(entry, context("godot")), /4\.1\.2 was not found/);
  assert.equal(f.calls.length, 1);
});

test("Godot native app selection does not inspect catalogs or install another runtime", async t => {
  const manager = Godot.runtimeManagers[0];
  t.mock.method(manager, "getState", () => { throw new Error("Native apps do not need a runtime catalog"); });
  assert.equal(await Godot.ensureRuntime({}, context("native")), null);
});

test("Auto Java Play uses the detected LTS line instead of the manager default line", async t => {
  const f = javaFixture(t, { sections: [{ id: "8", catalog: { versions: ["8.0.482+8"] } }, { id: "17", catalog: { versions: ["17.0.18+8"] } }] });
  const ctx = context("java", { java: { defaultLine: 8 } }), saved = structuredClone(ctx.settings);
  const plan = await Java.ensureRuntime({ moduleData: { requiredJava: 17 }, runtimeData: { java: { line: null, variant: "arm64" } } }, ctx);
  assert.deepEqual(plan, { managerId: "java", version: "17.0.18+8", installOptions: { sectionId: "17", line: 17, variant: "arm64" } });
  assert.deepEqual(ctx.settings, saved);
  assert.equal(f.calls.length, 0);
});

test("Java Play preserves exact overrides for a higher compatible line and architecture", async t => {
  const f = javaFixture(t);
  const plan = await Java.ensureRuntime({ moduleData: { requiredJava: 17 }, runtimeData: { java: { line: 21, version: "21.0.8+9", variant: "x64" } } }, context("java"));
  assert.deepEqual(plan, { managerId: "java", version: "21.0.8+9", installOptions: { sectionId: "21", line: 21, variant: "x64" } });
  assert.equal(f.calls.length, 0);
});

test("Java Play reuses the existing compatible-line fallback without downloading its preferred patch", async t => {
  const f = javaFixture(t, { installed: options => options.line === 17 && options.version === null
    ? { javaPath: "/ready/bin/java", version: "17.0.17+10", variant: "arm64", requiresRosetta: false } : null });
  const ctx = context("java", { java: { defaultLine: 8, lines: { 17: { defaultVersion: "17.0.18+8" } } } });
  assert.equal(await Java.ensureRuntime({ moduleData: { requiredJava: 17 } }, ctx), null);
  assert.equal(f.calls.length, 0);
});

test("Java empty catalog refresh is confined to the detected line", async t => {
  const f = javaFixture(t, { refreshed: [{ id: "17", catalog: { versions: ["17.0.18+8"] } }] });
  const plan = await Java.ensureRuntime({ moduleData: { runtimeLine: 17 } }, context("java"));
  assert.equal(plan.version, "17.0.18+8");
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

test("LÖVE Play selects the detected stable release without changing defaults", async t => {
  const f = loveFixture(t, { stable: ["11.5", "11.4"], nightly: ["new-nightly"] });
  const ctx = context("love", { love: { stable: { defaultVersion: "11.4" }, nightly: { defaultVersion: "new-nightly" } } });
  const saved = structuredClone(ctx.settings);
  assert.deepEqual(await Love.ensureRuntime({ moduleData: { detectedVersion: "11.5" } }, ctx), { managerId: "love", version: "11.5", installOptions: { sectionId: "stable" } });
  assert.deepEqual(ctx.settings, saved);
  assert.equal(f.calls.length, 0);
});

test("LÖVE Play reuses an installed matching development bundle without refreshing artifacts", async t => {
  const f = loveFixture(t, { stable: ["11.5"], matchingNightly: { channel: "nightly", buildKey: "installed-hash", appPath: "/ready/love.app" } });
  assert.equal(await Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" } }, context("love")), null);
  assert.equal(f.calls.length, 0);
});

test("LÖVE unreleased detection checks releases before a bounded latest-artifact fallback", async t => {
  const f = loveFixture(t, { status: "idle", refreshedStable: ["11.5"], refreshedNightly: ["2026-10-01T01-00-00Z-abcdef0"] });
  const plan = await Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" } }, context("love"));
  assert.deepEqual(plan, { managerId: "love", version: "2026-10-01T01-00-00Z-abcdef0", installOptions: { sectionId: "nightly" } });
  assert.deepEqual(f.calls.map(call => [call.sectionId, call.latestOnly]), [["stable", false], ["nightly", true]]);
});

test("LÖVE explicit releases never fall back to another nightly build", async t => {
  const f = loveFixture(t, { stable: ["11.5"], nightly: ["available-nightly"] });
  await assert.rejects(Love.ensureRuntime({ moduleData: { detectedVersion: "12.0" }, runtimeData: { love: { channel: "stable", version: "12.0" } } }, context("love")), /release v12\.0 was not found/);
  assert.deepEqual(f.calls.map(call => call.sectionId), ["stable"]);
});

test("LÖVE saved nightly builds load their exact artifact metadata instead of a newer build", async t => {
  const f = loveFixture(t, { stable: ["11.5"], nightly: ["new-hash"], refreshedNightly: ["new-hash", "old-hash"] });
  const entry = { moduleData: { detectedVersion: "12.0" }, runtimeData: { love: { channel: "nightly", version: "old-hash" } } };
  assert.deepEqual(await Love.ensureRuntime(entry, context("love")), { managerId: "love", version: "old-hash", installOptions: { sectionId: "nightly" } });
  assert.deepEqual(f.calls.map(call => [call.sectionId, call.latestOnly]), [["nightly", false]]);
});

test("LÖVE missing explicit artifacts fail before download and native app mode remains local", async t => {
  const f = loveFixture(t, { nightly: ["new-hash"] });
  await assert.rejects(Love.ensureRuntime({ runtimeData: { love: { channel: "nightly", version: "expired-hash" } } }, context("love")), /expired-hash is not available/);
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

test("Ruffle Play reuses the latest installed runtime when no version is selected", async t => {
  const f = ruffleFixture(t, { installed: [{ version: "nightly-2026-02-02" }, {version: "nightly-2026-01-01"}], resolveInstalled: options => options.version === "nightly-2026-02-02" ? { appPath: "/ready/Ruffle.app" } : null });
  assert.equal(await Flash.ensureRuntime({}, context("ruffle", {ruffle: {defaultVersion: "nightly-2026-01-01"}})), null);
  assert.equal(f.calls.length, 0);
});

test("shared preparation ignores game global pins and keeps exact overrides, CPU compatibility and deliberate tool defaults", async () => {
  for (const [supportsDefault, override, installed, expected] of [
    [false, {}, true, null], [undefined, {}, true, null],
    [false, {version: "1"}, true, "1"], [false, {}, false, "3"], [true, {}, true, "1"]
  ]) {
    const installs = [], uses = [];
    const section = {supportsDefault, defaultVersion: "1", defaultVariant: "arm64", installed: installed ? [
      {version: "4", variant: "x64", ready: true}, {version: "3", variant: "arm64", ready: false},
      {version: "2", variant: "arm64", ready: true}
    ] : [], catalog: {latestInstalledVersion: "4", recommendedVersion: "3", versions: ["4", "3", "2", "1"]}};
    const manager = {id: "player", getState: () => section, installRuntime() {assert.fail("adapter owns installation");},
      refreshCatalog() {assert.fail("an installed compatible runtime requires no network");}};
    const mod = {id: "example", runtimeManagers: [manager]};
    const ctx = {...context("runner"), recordRuntimeUse: use => uses.push(use)};
    await prepareForLaunch({entry: {runtimeData: {runner: override}}, mod,
      info: {runtime: {manager: {runner: "player"}}}, context: ctx,
      registry: {listModuleIds: () => [mod.id], getModule: () => mod},
      runAction: () => assert.fail("no game actions"), install: async (_manager, plan) => installs.push(plan)});
    if (expected) assert.equal(installs[0].version, expected);
    else {assert.equal(installs.length, 0);assert.equal(uses[0].version, "2");assert.equal(uses[0].variant, "arm64");}
  }
});

test("Ruffle first install refreshes full releases only when the catalog is empty", async t => {
  const f = ruffleFixture(t, { refreshed: ["nightly-2026-02-02", "nightly-2026-01-01"] });
  assert.equal((await Flash.ensureRuntime({}, context("ruffle"))).version, "nightly-2026-02-02");
  assert.equal((await Flash.ensureRuntime({}, context("ruffle"))).version, "nightly-2026-02-02");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].latestOnly, false);
});

test("included Adobe projector needs no dependency prompt or Ruffle release lookup", async t => {
  const ruffle = Flash.runtimeManagers.find(manager => manager.id === "ruffle");
  t.mock.method(ruffle, "getState", () => { throw new Error("Projector selection cannot consult Ruffle"); });
  t.mock.method(ruffle, "refreshCatalog", () => { throw new Error("Projector planning remains offline"); });
  assert.equal(await Flash.ensureRuntime({}, context("projector")), null);
});

test("a missing included Adobe projector asks for app repair rather than a runtime download", async t => {
  const manager = Flash.runtimeManagers.find(manager => manager.id === "flash-projector");
  t.mock.method(manager, "resolveSelection", () => ({ ready: false, version: "35.0.0.60", reason: "Included Flash Player is missing. Reinstall MacLauncher." }));
  await assert.rejects(Flash.ensureRuntime({}, context("projector")), /Included Flash Player is missing.*Reinstall MacLauncher/);
});

test("shared headless preparation installs the detected Godot once and skips the legacy installer", async t => {
  const f = godotFixture(t, { versions: ["4.6-stable", "3.2-stable"] });
  const entry = { moduleData: { detectedVersion: "3.2.0", detectedMajor: 3 } }, ctx = context("godot", { godot: { defaultVersion: "4.6-stable" } });
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
  assert.equal(ctx.settings.runtimes.godot.defaultVersion, "4.6-stable");
});

test("shared LÖVE preparation installs a matching nightly once without another legacy download", async t => {
  let installed = null;
  const f = loveFixture(t, { stable: ["11.5"], nightly: ["selected-hash"], matchingNightly: () => installed });
  const entry = { moduleData: { detectedVersion: "12.0" } }, ctx = context("love"), installs = [];
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
