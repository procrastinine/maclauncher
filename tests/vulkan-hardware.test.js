const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Vulkan = require("../src/modules/shared/vulkan");
const Managed = require("../src/modules/shared/vulkan/managed");
const Preparation = require("../src/core/runtime-preparation");
const { hashFile } = require("../src/modules/shared/runtime/pinned-native-manager");

const apple = { platform: "darwin", hardwareArch: "arm64", macOSVersion: "26.0" };
const intel = { ...apple, hardwareArch: "x64", launcherArch: "x64" };
const options = { architecture: "x64", preferredBackend: "kosmickrisp", required: true };

function fixture(t, architecture = "x64") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-hardware-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A bounded Mach-O header is enough to exercise admission; no native code runs.
  const image = Buffer.alloc(48);
  for (const [offset, value] of [[0, 0xfeedfacf], [4, architecture === "x64" ? 0x01000007 : 0x0100000c], [12, 6], [16, 1], [20, 16],
    [32, 0x24], [36, 16], [40, 13 << 16], [44, 26 << 16]]) image.writeUInt32LE(value, offset);
  const managers = ["moltenvk", "kosmickrisp"].map(backend => {
    const installDir = path.join(root, backend), names = backend === "moltenvk" ? ["libMoltenVK.dylib"]
      : ["libvulkan_kosmickrisp.dylib", "libvulkan.1.dylib"];
    fs.mkdirSync(installDir);
    for (const name of names) fs.writeFileSync(path.join(installDir, name), image);
    const install = { version: "fixture", installDir, executablePath: path.join(installDir, names[0]),
      installationMetadata: { libraries: names.map(file => ({ file, sha256: hashFile(path.join(installDir, file)) })) } };
    const pin = { version: "fixture", architecture };
    const manager = { id: "vulkan-" + backend, label: backend, backend, present: true, catalogReady: true, pin, install,
      core: { listInstalled() { return manager.present ? [install] : []; }, listCatalog: () => [pin] },
      getState: () => ({ catalog: { versions: manager.catalogReady ? ["fixture"] : [] } }),
      resolveSelection(_entry, settings, _data, selection) {
        return { version: selection.version || settings?.runtimes?.[this.id]?.defaultVersion || (this.catalogReady ? "fixture" : null),
          discoveryRequired: !this.catalogReady,
          ready: this.present, install: this.present ? install : null };
      }, installRuntime() {}, async refreshCatalog() { this.catalogReady = true; }
    };
    return manager;
  });
  const kosmic = managers[1], adapted = { id: "maclauncher-kosmickrisp:fixture", backend: "kosmickrisp",
    projectId: "maclauncher-kosmickrisp", version: "fixture", label: "MacLauncher KosmicKrisp",
    library: path.join(kosmic.install.installDir, "libvulkan.1.dylib"), driver: kosmic.install.executablePath,
    readable: kosmic.install.installationMetadata.libraries.map(row => path.join(kosmic.install.installDir, row.file)) };
  const context = { userDataDir: root, settings: { runtimes: { "vulkan-kosmickrisp": {
    defaultVersion: "fixture", defaultArchitecture: "arm64" }, [Managed.projectId]: { defaultArchitecture: "arm64" } } }, runtimeSettings: { vulkanRuntime: "auto" } };
  const managedManager = { id: Managed.projectId, label: "MacLauncher KosmicKrisp", present: false, catalogReady: true,
    pin: { version: "fixture", architecture }, selections: [],
    core: { listCatalog: () => [managedManager.pin] },
    getState: () => ({ catalog: { versions: managedManager.catalogReady ? ["fixture"] : [] },
      installed: managedManager.present ? [{ version: "fixture" }] : [] }),
    resolveSelection(_entry, settings, _data, selection) {
      const cpu = selection.architecture || settings?.runtimes?.[this.id]?.defaultArchitecture;
      this.selections.push(cpu);
      const compatible = cpu === architecture;
      return { version: selection.version || (this.catalogReady ? "fixture" : null), discoveryRequired: !this.catalogReady,
        ready: this.present && compatible, install: this.present && compatible ? { ...kosmic.install,
          payloadRoot: kosmic.install.installDir, manifest: { minimumMacOS: "26.0", runtimeFiles: { loader: "libvulkan.1.dylib" },
            files: kosmic.install.installationMetadata.libraries.map(row => ({ path: row.file, architectures: [architecture] })) } } : null };
    }, installRuntime() {}, async refreshCatalog() { this.catalogReady = true; }
  };
  return { context, managers, adapted, managedManager, dependencies: { ...options, architecture, managers, adaptedManager: managedManager,
    adapted: { installed: () => [], resolve: item => item } } };
}

test("x64 Vulkan consumers prefer KosmicKrisp on Apple Silicon and retain MoltenVK fallback", t => {
  const { context, managers, managedManager, dependencies } = fixture(t), saved = JSON.stringify(context.settings);
  for (const launcherArch of ["arm64", "x64"]) {
    const selected = { ...dependencies, hostCapabilities: { ...apple, launcherArch } };
    assert.equal(Vulkan.resolve(context, selected).backend, "kosmickrisp");
    assert.deepEqual(Vulkan.requirements(context, selected), []);
    managers[1].present = false;
    assert.equal(Vulkan.resolve(context, selected).backend, "moltenvk");
    managers[0].present = false;
    assert.equal(Vulkan.requirements(context, selected)[0].managerId, Managed.projectId);
    managedManager.pin.architecture = "arm64";
    assert.equal(Vulkan.requirements(context, selected)[0].managerId, "vulkan-moltenvk");
    managedManager.pin.architecture = "x64";
    for (const manager of managers) manager.present = true;
  }
  assert.equal(JSON.stringify(context.settings), saved, "consumer CPU and admission preserve saved defaults");
});

test("Intel hardware and older macOS exclude installed and offered KosmicKrisp and fall back offline", t => {
  const { context, managers, dependencies, adapted } = fixture(t);
  for (const hostCapabilities of [intel, { ...apple, macOSVersion: "15.7" }]) {
    const selected = { ...dependencies, hostCapabilities, adapted: { installed: () => [adapted] } };
    assert.deepEqual(Vulkan.installed(context, selected).map(row => row.backend), ["moltenvk"]);
    assert.ok(Vulkan.choices(context, selected).vulkanRuntimes.every(row => !row.value.startsWith("kosmickrisp")));
    assert.equal(Vulkan.resolve(context, selected).backend, "moltenvk");
    assert.deepEqual(Vulkan.requirements(context, selected), []);
    for (const manager of managers) manager.present = false;
    assert.equal(Vulkan.requirements(context, selected)[0].managerId, "vulkan-moltenvk");
    for (const manager of managers) manager.present = true;
  }
});

test("saved KosmicKrisp selections retain their identity and reject only known incompatible hosts", t => {
  const { context, managedManager, dependencies, adapted } = fixture(t);
  managedManager.present = true;
  const selected = { ...dependencies,
    adapted: { installed: () => [adapted], resolve: item => item } };
  for (const request of ["kosmickrisp:fixture", "kosmickrisp:auto", "maclauncher-kosmickrisp:fixture", "kosmickrisp:maclauncher"]) {
    context.runtimeSettings.vulkanRuntime = request;
    const saved = JSON.stringify(context);
    for (const hostCapabilities of [intel, { ...apple, macOSVersion: "15.7" }]) {
      const unavailable = { ...selected, hostCapabilities }, reason = hostCapabilities === intel ? /Apple Silicon/ : /macOS 26/;
      assert.throws(() => Vulkan.resolve(context, unavailable), reason);
      assert.throws(() => Vulkan.requirements(context, unavailable), reason);
    }
    for (const launcherArch of ["arm64", "x64"]) {
      const available = { ...selected, hostCapabilities: { ...apple, launcherArch } };
      assert.equal(Vulkan.resolve(context, available).backend, "kosmickrisp");
      assert.deepEqual(Vulkan.requirements(context, available), []);
    }
    assert.equal(JSON.stringify(context), saved);
  }
  assert.equal(Vulkan.resolve(context, { ...selected, hostCapabilities: {} }).backend, "kosmickrisp",
    "unknown host facts keep their existing eligibility");
});

test("KosmicKrisp choices use compact CPU labels and retain their order", t => {
  for (const architecture of ["x64", "arm64"]) {
    const { context, dependencies } = fixture(t, architecture);
    const selected = { ...dependencies, hostCapabilities: apple };
    const choices = Vulkan.choices(context, selected).vulkanRuntimes;
    assert.ok(choices.some(row => row.value === "moltenvk:fixture"));
    const kosmic = choices.filter(row => row.value.startsWith("kosmickrisp"));
    assert.ok(!kosmic.some(row => row.value === Managed.selectionId), "An uninstalled provider is not an inspector choice");
    assert.ok(kosmic.length > 0);
    const cpu = architecture === "x64" ? "Intel" : "Apple Silicon";
    assert.ok(kosmic.every(row => row.label.includes("(" + cpu + ")")));
    assert.ok(kosmic.every(row => !row.label.includes("Intel build for Intel programs")));
    if (architecture === "arm64") {
      assert.equal(Vulkan.resolve(context, { ...selected, preferredBackend: undefined }).backend, "moltenvk");
      for (const manager of dependencies.managers) manager.present = false;
      const plan = Vulkan.requirements(context, selected)[0];
      assert.equal(plan.managerId, "vulkan-kosmickrisp");
      assert.equal(plan.optional, undefined);
    }
  }
});

async function prepareFixture(t, { decline = false, fail, host = apple, moltenInstalled = false } = {}) {
  const result = fixture(t), { context, managers, managedManager, dependencies } = result;
  for (const manager of managers) manager.present = false;
  managers[0].present = moltenInstalled;
  managers[0].catalogReady = false;
  managedManager.catalogReady = false;
  const events = [], warnings = [], offered = [], reports = [];
  context.logger = { warn: (...args) => warnings.push(args.join(" ")) };
  context.confirmRuntimeInstall = async plan => {
    offered.push(plan); events.push("consent:" + plan.managerId);
    assert.equal(plan.installOptions.architecture, "x64");
    return !decline || plan.managerId !== Managed.projectId;
  };
  const selected = { ...dependencies, hostCapabilities: host, adapted: Managed.createProvider(managedManager) };
  for (const manager of [...managers, managedManager]) manager.refreshCatalog = async input => {
    events.push("refresh:" + manager.id);
    assert.equal(input.architecture, "x64");
    if (manager === managedManager && fail === "refresh") throw new Error("preferred refresh failed");
    manager.catalogReady = true;
  };
  const mod = { id: "vulkan-fixture", runtimeManagers: [...managers, managedManager],
    getRuntimeRequirements: () => Vulkan.requirements(context, selected), prepareLaunch: () => events.push("prepare") };
  const saved = JSON.stringify(context.settings);
  assert.equal(await Preparation.prepareForLaunch({ entry: {}, mod, info: {}, context, report: state => reports.push(state),
    registry: { listModuleIds: () => [mod.id], getModule: () => mod },
    install: async (manager, input) => {
      events.push("install:" + manager.id);
      assert.equal(input.architecture, "x64");
      if (manager === managedManager && ["download", "install"].includes(fail)) throw new Error("preferred " + fail + " failed");
      manager.present = true;
    } }), true);
  assert.equal(JSON.stringify(context.settings), saved);
  return { ...result, events, warnings, offered, reports, selected, resolved: Vulkan.resolve(context, selected) };
}

test("first Intel Vulkan Play offers the managed Intel package once and installs it for either Apple Silicon launcher", async t => {
  for (const launcherArch of ["arm64", "x64"]) await t.test(launcherArch, async t => {
    const result = await prepareFixture(t, { host: { ...apple, launcherArch } });
    assert.deepEqual(result.events, ["consent:" + Managed.projectId, "refresh:" + Managed.projectId, "install:" + Managed.projectId, "prepare"]);
    assert.equal(result.resolved.projectId, Managed.projectId);
    assert.equal(result.offered[0].label, "KosmicKrisp (Intel)");
    assert.ok(result.managedManager.selections.every(architecture => architecture === "x64"), "provider resolution follows the consumer despite saved ARM defaults");
    assert.deepEqual(result.warnings, []);
  });
});

test("declining first Intel KosmicKrisp consent continues with consented MoltenVK in the same Play", async t => {
  const result = await prepareFixture(t, { decline: true });
  assert.deepEqual(result.events, ["consent:" + Managed.projectId, "consent:vulkan-moltenvk", "refresh:vulkan-moltenvk", "install:vulkan-moltenvk", "prepare"]);
  assert.equal(result.resolved.backend, "moltenvk");
  assert.deepEqual(result.warnings, []);
});

test("preferred catalog, download and install failures warn and continue with MoltenVK", async t => {
  for (const fail of ["refresh", "download", "install"]) await t.test(fail, async t => {
    const result = await prepareFixture(t, { fail });
    assert.equal(result.resolved.backend, "moltenvk");
    assert.equal(result.offered.filter(plan => plan.managerId === Managed.projectId).length, 1);
    assert.equal(result.offered.filter(plan => plan.managerId === "vulkan-moltenvk").length, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], new RegExp("preferred " + fail + " failed"));
    assert.ok(result.reports.some(state => state.phase === "prepare" && /could not be installed\. Using moltenvk\./.test(state.label)),
      "the existing preparation status shows the fallback warning while MoltenVK consent is pending");
    assert.equal(result.events.at(-1), "prepare");
  });
});

test("working MoltenVK suppresses a new offer and Intel hardware only offers MoltenVK", async t => {
  const installed = await prepareFixture(t, { moltenInstalled: true });
  assert.deepEqual(installed.events, ["prepare"]);
  assert.equal(installed.resolved.backend, "moltenvk");
  const incompatible = await prepareFixture(t, { host: intel });
  assert.deepEqual(incompatible.events, ["consent:vulkan-moltenvk", "refresh:vulkan-moltenvk", "install:vulkan-moltenvk", "prepare"]);
  assert.equal(incompatible.resolved.backend, "moltenvk");
});

test("unversioned managed Vulkan choices skip an ARM-only install for an Intel consumer", async t => {
  for (const provider of Managed.providers) await t.test(provider.projectId, t => {
    const { context, adapted } = fixture(t, "arm64"), calls = [];
    context.runtimeSettings.vulkanRuntime = provider.selectionId;
    context.settings.runtimes[provider.projectId] = { defaultVersion: "older", defaultArchitecture: "arm64" };
    const oldInstall = { version: "older", installDir: path.dirname(adapted.driver) };
    const pins = [{ version: "older", architecture: "arm64" }, { version: "newer", architecture: "x64" }];
    const installs = new Map([["older", oldInstall]]);
    const manager = { id: provider.projectId, label: "Managed Vulkan",
      core: { listCatalog: () => pins },
      getState: () => ({ catalog: { versions: pins.map(pin => pin.version), installableVersions: pins.map(pin => pin.version) } }),
      resolveSelection(_entry, settings, _data, options) {
        calls.push(options);
        const version = options.version || settings.runtimes[this.id].defaultVersion;
        return { version, ready: installs.has(version), install: installs.get(version) || null };
      }
    };
    const dependencies = { architecture: "x64", hostCapabilities: apple, managers: [], adaptedManager: manager,
      adapted: { installed: () => [{ ...adapted, version: "older", projectId: provider.projectId }] } };
    const saved = JSON.stringify(context.settings);
    assert.deepEqual(Vulkan.requirements(context, dependencies), [{ managerId: provider.projectId,
      version: "newer", requiresDownload: true, installOptions: { architecture: "x64" } }]);
    assert.equal(calls.at(-1).version, "newer");
    assert.ok(Vulkan.choices(context, dependencies).vulkanRuntimes.some(row => row.value === provider.selectionId && row.label.endsWith("(not installed)")));
    context.runtimeSettings.vulkanRuntime = provider.prefix + "older";
    assert.throws(() => Vulkan.requirements(context, dependencies), /no compatible x64 library/,
      "an exact game version is not replaced by another catalog version");
    assert.equal(JSON.stringify(context.settings), saved, "manager defaults remain unchanged");
    const other = fixture(t, "x64").adapted;
    pins.push({ version: "other", architecture: "x64" });
    installs.set("other", { version: "other", installDir: path.dirname(other.driver) });
    dependencies.adapted.installed = () => [{ ...other, version: "other", projectId: provider.projectId }];
    context.runtimeSettings.vulkanRuntime = provider.selectionId;
    context.settings.runtimes[provider.projectId].defaultVersion = "newer";
    assert.deepEqual(Vulkan.requirements(context, dependencies), [{ managerId: provider.projectId,
      version: "newer", requiresDownload: true, installOptions: { architecture: "x64" } }],
    "a compatible saved default is not replaced by another installed version");
  });
});

test("inspector Vulkan choices omit cached catalog releases and retain only a missing saved choice", t => {
  const { context, managers, dependencies } = fixture(t);
  managers[1].present = false;
  managers[0].getState = () => ({ catalog: { versions: ["fixture", "1.4.0-rc1", "1.4.0-rc2"] } });
  managers[0].core.listCatalog = () => ["fixture", "1.4.0-rc1", "1.4.0-rc2"].map(version => ({ version, architecture: "x64" }));
  const selected = { ...dependencies, hostCapabilities: apple };
  assert.deepEqual(Vulkan.choices(context, selected).vulkanRuntimes.map(row => row.value), ["auto", "moltenvk:fixture"]);
  context.runtimeSettings.vulkanRuntime = "moltenvk:1.4.0-rc1";
  const choices = Vulkan.choices(context, selected).vulkanRuntimes;
  assert.deepEqual(choices.map(row => row.value), ["auto", "moltenvk:fixture", "moltenvk:1.4.0-rc1"]);
  assert.match(choices.at(-1).label, /1\.4\.0-rc1 \(not installed\)$/);
});
