const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Module = require("node:module");
const React = require("react");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { DownloadManager, runDownloadTask } = require("../src/modules/shared/runtime/download-manager");

async function compile(file, name, react) {
  const { build } = require("vite");
  const bundle = await build({ configFile: false, logLevel: "silent", build: { ssr: true, write: false,
    rollupOptions: { input: path.resolve(__dirname, file), external: id => /^react(?:-dom)?(?:\/|$)/.test(id),
      output: { format: "cjs", codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, name), module);
  compiled.paths = module.paths;
  if (react) compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  return compiled.exports;
}

test("the inspector lists damaged installations for repair and hides builds this Mac cannot run", async () => {
  const model = await compile("../src/renderer/src/ui/components/runtime-inspector-model.ts", "runtime-repair-model.cjs");
  const section = { id: "default", installed: [
    { version: "3.0", ready: true },
    { version: "2.0", ready: false, status: "damaged", variant: "architecture:x64", architecture: "x64" },
    { version: "1.5", ready: false, status: "incomplete", architecture: "arm64" },
    { version: "1.4", ready: false, architectureSupported: false },
    { version: "1.3", ready: false, status: "unsupported-host" },
    { version: "/Applications/Runtime.app", ready: false, external: true }] };
  assert.deepEqual(model.runtimeInspectorVersions(section), ["3.0", "2.0", "1.5"]);
  assert.deepEqual(model.runtimeInspectorVersions(section, "1.4"), ["3.0", "2.0", "1.5", "1.4"], "A saved choice stays visible");
  const missing = model.runtimeInspectorVersionOptions({ ...section, catalog: { versions: ["9.0-rc1"] } }, "9.0-rc1");
  assert.equal(missing.filter(option => option.version === "9.0-rc1").length, 1);
  assert.ok(missing.find(option => option.version === "9.0-rc1").label.endsWith(" (not installed)"));
  assert.ok(!model.runtimeInspectorVersions({ ...section, catalog: { versions: ["9.0-rc1"] } }).includes("9.0-rc1"),
    "A catalog-only candidate is not offered without a saved choice");
  assert.equal(model.runtimeInspectorInstall(section, "2.0").availability, "needsRepair");
  assert.equal(model.runtimeInspectorInstall(section, "1.4").availability, "unavailable");
  assert.equal(model.runtimeInspectorInstall(section, "9.0").availability, null);
  // Repair installs the same build again; an architecture variant names its build.
  assert.deepEqual(model.runtimeInspectorRepair(section, "2.0"), { sectionId: "default", version: "2.0", variant: "architecture:x64", architecture: undefined });
  assert.deepEqual(model.runtimeInspectorRepair(section, "1.5"), { sectionId: "default", version: "1.5", variant: undefined, architecture: "arm64" });
  for (const version of ["3.0", "1.4", "1.3", "/Applications/Runtime.app", "9.0"]) assert.equal(model.runtimeInspectorRepair(section, version), null, version);
  // A usable copy of the same version needs no repair.
  assert.equal(model.runtimeInspectorRepair({ installed: [{ version: "2.0", ready: false }, { version: "2.0", ready: true }] }, "2.0"), null);
});

test("the inspector separates installed CPU copies and stores the selected CPU with the plain version", async t => {
  const model = await compile("../src/renderer/src/ui/components/runtime-inspector-model.ts", "runtime-cpu-model.cjs");
  const version = "MCLv8", installed = [
    { version, architecture: "arm64", variant: "architecture:arm64", ready: true },
    { version, architecture: "x64", variant: "architecture:x64", ready: true }
  ];
  const section = { installed }, options = model.runtimeInspectorVersionOptions(section);
  const plain = model.runtimeInspectorVersionOptions({ installed: [installed[0]] })[0];
  assert.equal(plain.value, version);
  assert.equal(plain.architecture, undefined, "An unlabelled single-CPU option does not pin the CPU");
  assert.deepEqual(options.map(option => option.label), [plain.label + " (Apple Silicon)", plain.label + " (Intel)"],
    "CPU suffixes compose the shared version label without replacing its wording");
  assert.deepEqual(model.runtimeInspectorVersions(section), [version], "The existing plain version API stays unchanged");
  const { react, componentHarness } = require("./helpers/renderer-component");
  const { GameDetails } = await compile("../src/renderer/src/ui/components/GameDetails.tsx", "runtime-cpu-details.cjs", react);
  const state = require("./library-layout-fixture").createLibraryFixture(), updates = [], repairs = [];
  Object.assign(state.runtimeManagers["fixture-manager"], { launcherArchitecture: "arm64", defaultArchitecture: "arm64" });
  for (const item of state.runtimeManagers["fixture-manager"].sections) {
    item.installed = installed; item.defaultVersion = version; item.variants = []; item.defaultVariant = undefined;
  }
  const actions = new Proxy({ onSetRuntimeData: (...args) => updates.push(args), onInstallRuntime: (...args) => repairs.push(args) },
    { get: (target, key) => target[key] || (async () => {}) });
  const nodes = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(nodes)] : [];
  const render = runtimeData => {
    const harness = componentHarness(GameDetails.type, { g: { ...state.recents[0], runtimeData: { managed: runtimeData } }, state,
      moduleInfo: state.modules[0], actions, moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null, runtimeStatusEntry: null });
    t.after(() => harness.close());
    return nodes(harness.render());
  };
  const picker = all => all.find(node => node.props["aria-label"] === "Managed runtime version");
  const first = picker(render({ version, architecture: "arm64", variant: "architecture:arm64" }));
  const renderedOptions = nodes(first).filter(node => node.type === "option").slice(1);
  assert.deepEqual(renderedOptions.map(node => React.Children.toArray(node.props.children).join("")), options.map(option => option.label));
  const intel = renderedOptions.find(node => String(node.props.children).endsWith("(Intel)"));
  first.props.onChange({ target: { value: intel.props.value } });
  assert.deepEqual(updates, [[state.recents[0].gamePath, "managed", { version, architecture: "x64", variant: null }]],
    "The UI-only option key is not stored as a version, and a stale CPU variant is cleared");
  first.props.onChange({ target: { value: "" } });
  assert.deepEqual(updates[1], [state.recents[0].gamePath, "managed", { version: null, architecture: null, variant: null }],
    "Default clears only the explicit CPU choice and its legacy architecture variant");
  assert.equal(picker(render({ version, architecture: "x64" })).props.value, intel.props.value);
  for (const item of state.runtimeManagers["fixture-manager"].sections) item.installed = [installed[0]];
  picker(render({ version, architecture: "x64", variant: "architecture:x64" })).props.onChange({ target: { value: version } });
  assert.deepEqual(updates.at(-1), [state.recents[0].gamePath, "managed", { version, architecture: null, variant: null }],
    "Picking a single-CPU version clears the saved CPU and its legacy variant");
  picker(render({ version: "missing", architecture: "x64" })).props.onChange({ target: { value: "missing" } });
  assert.deepEqual(updates.at(-1), [state.recents[0].gamePath, "managed", { version: "missing", architecture: null }],
    "A missing saved version also leaves installed-copy selection automatic");
  const intelDamaged = { ...installed[1], ready: false, status: "damaged" };
  for (const item of state.runtimeManagers["fixture-manager"].sections) item.installed = [installed[0], intelDamaged];
  const damaged = render({ version, architecture: "x64" });
  damaged.find(node => node.props["aria-label"] === "Repair runtime version").props.onClick();
  assert.deepEqual(repairs, [["fixture-manager", "stable", version, "architecture:x64", undefined]],
    "Repair targets the selected Intel copy even while the Apple Silicon copy works");
  state.runtimeManagers["fixture-manager"].defaultArchitecture = "x64";
  render({}).find(node => node.props["aria-label"] === "Repair runtime version").props.onClick();
  assert.deepEqual(repairs[1], repairs[0], "The explicit global CPU default also selects its own repair target");
});

test("Repair beside the Version menu reinstalls the game's damaged version through the shared install action", async t => {
  const { react, componentHarness } = require("./helpers/renderer-component");
  const { GameDetails } = await compile("../src/renderer/src/ui/components/GameDetails.tsx", "runtime-repair-details.cjs", react);
  const state = require("./library-layout-fixture").createLibraryFixture();
  for (const section of state.runtimeManagers["fixture-manager"].sections) section.installed = [
    { version: "2.0", variant: "arm64", ready: false, status: "damaged", installDir: "/Runtimes/2.0" },
    { version: "1.0", variant: "arm64" },
    { version: "1.5", variant: "arm64", ready: false, architectureSupported: false }];
  const installs = [];
  const actions = new Proxy({ onInstallRuntime: async (...args) => { installs.push(args); } }, { get: (target, key) => target[key] || (async () => {}) });
  const nodes = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(nodes)] : [];
  const render = (runtimeData, runtimeAutomaticEntry = null) => {
    const harness = componentHarness(GameDetails.type, { g: { ...state.recents[0], runtimeData: { managed: runtimeData } }, state,
      moduleInfo: state.modules[0], actions, moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null, runtimeStatusEntry: null,
      runtimeAutomaticEntry });
    t.after(() => harness.close());
    return nodes(harness.render());
  };
  const optionLabels = all => nodes(all.find(node => node.props["aria-label"] === "Managed runtime version"))
    .filter(node => node.type === "option").map(node => [node.props.value, React.Children.toArray(node.props.children).join("")]);
  const chosen = render({ version: "2.0" });
  assert.deepEqual(optionLabels(chosen).slice(1), [["2.0", "v2.0 · Needs repair"], ["1.0", "v1.0"]],
    "The damaged version stays in the menu, and a build this Mac cannot run is left out");
  chosen.find(node => node.props["aria-label"] === "Repair runtime version").props.onClick();
  assert.deepEqual(installs, [["fixture-manager", "stable", "2.0", "arm64", undefined]]);
  // Without a choice, the default version Play uses is the one repaired.
  assert.ok(render({}).some(node => node.props["aria-label"] === "Repair runtime version"));
  const other = render({ version: "1.0" });
  assert.equal(other.some(node => node.props["aria-label"] === "Repair runtime version"), false, "A usable choice needs no repair");
  assert.deepEqual(optionLabels(render({ version: "1.5" })).slice(1).map(([value]) => value), ["2.0", "1.5", "1.0"],
    "A saved choice this Mac cannot run stays visible");
  assert.ok(optionLabels(render({ version: "9.0" })).some(([value, label]) => value === "9.0" && label === "v9.0"),
    "A saved absent version reads as itself until Play's answer for it arrives");
  const answer = { runtimeId: state.recents[0].runtimeId, value: { managerId: "fixture-manager", version: null, choice: { requested: "9.0", version: "9.0" } } };
  assert.ok(optionLabels(render({ version: "9.0" }, answer)).some(([value, label]) => value === "9.0" && label === "v9.0 (not installed)"),
    "A saved absent version is shown plainly as not installed once Play's answer arrives");
});

test("installing a damaged version replaces the damaged copy in the shared install; usable, unavailable and included copies stay", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-runtime-repair-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  // `task` opens the manager's own download task; `existing` returns the
  // damaged copy unchanged when one is present, as a manager whose own record
  // still reads as installed does.
  function fixture(rows, { task = false, existing = false } = {}) {
    const calls = [];
    const manager = { id: `repair-${Math.random().toString(16).slice(2)}`, getState: () => ({ sections: [{ id: "default", installed: rows }] }),
      uninstallRuntime: async payload => {
        calls.push(["uninstall", payload.version, payload.variant, payload.architecture, payload.installDir]);
        rows = rows.filter(row => row.installDir !== payload.installDir);
        return true;
      },
      installRuntime: async payload => {
        const run = async progress => {
          const copy = existing && rows.find(row => row.version === payload.version);
          if (copy) { calls.push(["existing", payload.version]); return copy; }
          calls.push(["install", payload.version, payload.variant, payload.architecture]);
          progress?.({ detail: "Downloading…" });
          const row = { version: payload.version, ready: true, installDir: path.join(userDataDir, payload.version) };
          rows = [...rows, row];
          return row;
        };
        if (!task) return run();
        return runDownloadTask(payload.downloads, { label: "Runtime", managerId: manager.id, version: payload.version, kind: "runtime" },
          ({ onProgress }) => { calls.push(["task"]); return run(onProgress); });
      } };
    return { manager, calls };
  }
  const install = (manager, payload, downloads) => runRuntimeManagerAction({ manager, action: "install", userDataDir, downloads,
    payload: { sectionId: "default", ...payload } });
  const copy = { version: "2.0", ready: false, status: "incomplete", installDir: path.join(userDataDir, "2.0") };

  const damaged = fixture([copy]);
  await install(damaged.manager, { version: "2.0" });
  assert.deepEqual(damaged.calls, [["uninstall", "2.0", undefined, undefined, copy.installDir], ["install", "2.0", undefined, undefined]]);

  // The removal is the first step of the installation's own download task.
  const details = [], downloads = new DownloadManager({ progressThrottleMs: 0,
    onChange: () => details.push(...downloads.list().map(item => item.detail).filter(Boolean)) });
  const tasked = fixture([copy], { task: true });
  await install(tasked.manager, { version: "2.0" }, downloads);
  assert.deepEqual(tasked.calls, [["uninstall", "2.0", undefined, undefined, copy.installDir], ["task"], ["install", "2.0", undefined, undefined]]);
  assert.ok(details.includes("Removing damaged installation…"), "The removal reports through the installation's task");

  // A manager that opens no task of its own and returns the damaged copy gets
  // that copy removed and installs again.
  const kept = fixture([copy], { existing: true });
  await install(kept.manager, { version: "2.0" }, downloads);
  assert.deepEqual(kept.calls, [["existing", "2.0"], ["uninstall", "2.0", undefined, undefined, copy.installDir], ["install", "2.0", undefined, undefined]]);

  // Each build is repaired on its own: a damaged Intel build beside an
  // Apple Silicon one, chosen through the Runtimes Build menu or the inspector.
  const builds = () => fixture([
    { version: "2.0", ready: false, variant: "architecture:x64", architecture: "x64", installDir: path.join(userDataDir, "x64") },
    { version: "2.0", ready: false, variant: "architecture:arm64", architecture: "arm64", installDir: path.join(userDataDir, "arm64") }]);
  const runtimes = builds();
  await install(runtimes.manager, { version: "2.0", architecture: "x64" });
  assert.deepEqual(runtimes.calls[0], ["uninstall", "2.0", "architecture:x64", "x64", path.join(userDataDir, "x64")]);
  const inspector = builds();
  await install(inspector.manager, { version: "2.0", variant: "architecture:arm64" });
  assert.deepEqual(inspector.calls[0], ["uninstall", "2.0", "architecture:arm64", "arm64", path.join(userDataDir, "arm64")]);

  for (const rows of [
    [{ version: "2.0", ready: false, installDir: "/a" }, { version: "2.0", ready: true, installDir: "/b" }],
    [{ version: "2.0", ready: false, status: "unsupported-host", installDir: "/a" }],
    [{ version: "2.0", ready: false, architectureSupported: false, installDir: "/a" }],
    [{ version: "2.0", ready: false, external: true, installDir: "/a" }],
    [{ version: "2.0", ready: false, readOnly: true, removable: false, installDir: "/a" }],
    [{ version: "2.0", ready: false, status: "damaged-bundled", bundledExecution: "direct", installDir: "/a" }],
    [{ version: "2.0", ready: false, included: true, installDir: "/a" }],
    [{ version: "1.0", ready: false, installDir: "/a" }]]) {
    const other = fixture(rows);
    await install(other.manager, { version: "2.0" });
    assert.deepEqual(other.calls.map(call => call[0]), ["install"], JSON.stringify(rows));
  }
});
