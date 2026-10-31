const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");
const { react } = require("./helpers/renderer-component");
const Architecture = require("../src/modules/shared/runtime/architecture");
const Host = require("../src/modules/shared/runtime/host-capabilities");
const { withRunnableBuilds } = require("../src/modules/shared/runtime/host-settings");
const { createProjectBuildManager } = require("../src/modules/shared/runtime/project-build-manager");

// A released launcher reads MacLauncher Builds catalogs at Refresh. Versions that
// Builds publishes later, for one CPU, both CPUs or as Universal packages, must be
// listed, chosen by default for the right CPU and labelled in Runtimes with no
// launcher update.
const repository = "ExampleOwner/runtime-builds";
function record(projectId, version, arch, extra = {}) {
  const tag = `${projectId}/v${version}/${arch}`, filename = `${projectId}-${version}-${arch}.tar.gz`;
  return { schemaVersion: 2, id: projectId, version, arch, launcherArchitectures: arch === "universal" ? ["arm64", "x64"] : [arch],
    minimumMacOS: "13.0", manifestRelative: "runtime.json", manifestSha256: "a".repeat(64), sourceSha256: "b".repeat(64),
    updatePolicy: "manual", tag, ...extra,
    asset: { filename, bytes: 1, sha256: Buffer.from(`${version}/${arch}`).toString("hex").padEnd(64, "0").slice(0, 64),
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
}
const published = {
  "dual-cpu": [record("dual-cpu", "1.0.0-MCLv1", "arm64"), record("dual-cpu", "1.0.0-MCLv1", "x64")],
  "universal-only": [record("universal-only", "1.0.0-MCLv1", "universal")],
  "apple-only": [record("apple-only", "1.0.0-MCLv1", "arm64")]
};
// Later Builds publications: a new version with both CPU assets, and a new
// Universal version, each with a field this launcher does not know.
function publishLater() {
  const later = { publishedAt: "2027-01-01T00:00:00Z" };
  published["dual-cpu"].unshift(record("dual-cpu", "2.0.0-MCLv1", "arm64", later), record("dual-cpu", "2.0.0-MCLv1", "x64", later));
  published["universal-only"].unshift(record("universal-only", "2.0.0-MCLv1", "universal", later));
  published["apple-only"].unshift(record("apple-only", "2.0.0-MCLv1", "arm64", later));
}
const fetchUrlBuffer = async url => {
  const projectId = path.basename(new URL(url).pathname, ".json");
  assert.equal(url, `https://raw.githubusercontent.com/${repository}/main/catalogs/${projectId}.json`);
  return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: 2, projectId, updatePolicy: "manual", packages: published[projectId] })) };
};
// Three launchers: the Apple Silicon app, the Intel app on Apple Silicon and an Intel Mac.
const launchers = { arm64: { cpu: "arm64", hardware: "arm64" }, x64: { cpu: "x64", hardware: "arm64" }, intel: { cpu: "x64", hardware: "x64" } };
const create = (launcher, projectId) => Architecture.withArchitecture(launchers[launcher].cpu, () => createProjectBuildManager({ projectId, label: projectId, repository,
  manifestRelative: "runtime.json", sourceRelative: null, executableRelative: "native", validateManifest: () => {}, verifyPayload: () => {},
  dependencies: { systemVersionSync: () => "26.0", fetchUrlBuffer,
    hostCapabilities: { platform: "darwin", hardwareArch: launchers[launcher].hardware, rosettaAvailable: launchers[launcher].hardware === "arm64" } } }));
const cpu = (catalog, version) => catalog?.versionRequirements?.[version]?.architecture;

let RuntimesView;
const states = {};
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "runtime-tabs-components.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "builds-architecture-components.cjs"), module);
  compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ RuntimesView } = compiled.exports);
});

test("Refresh lists later Builds versions for each CPU and Universal, and picks the launcher's own build by default", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "builds-architecture-refresh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const managers = Object.fromEntries(Object.keys(launchers).map(launcher =>
    [launcher, Object.fromEntries(Object.keys(published).map(projectId => [projectId, create(launcher, projectId)]))]));
  for (const launcher of Object.keys(launchers)) for (const manager of Object.values(managers[launcher])) {
    const userDataDir = path.join(directory, launcher);
    await manager.refreshCatalog({ userDataDir, force: true });
  }
  publishLater();
  for (const launcher of Object.keys(launchers)) {
    const userDataDir = path.join(directory, launcher), own = launchers[launcher].cpu, other = own === "arm64" ? "x64" : "arm64";
    states[launcher] = {};
    for (const [projectId, manager] of Object.entries(managers[launcher])) {
      await manager.refreshCatalog({ userDataDir, force: true });
      const state = manager.getState({ userDataDir });
      states[launcher][projectId] = JSON.parse(JSON.stringify({ ...state, id: projectId, label: projectId }));
      const label = `${launcher} ${projectId}`;
      assert.equal(state.launcherArchitecture, own, label);
      if (projectId === "apple-only") {
        assert.deepEqual(state.catalog.architectureCatalogs.arm64.versions, ["2.0.0-MCLv1", "1.0.0-MCLv1"], label);
        assert.equal(cpu(state.catalog.architectureCatalogs.arm64, "2.0.0-MCLv1"), "arm64", label);
        const selected = manager.resolveSelection(null, {}, userDataDir);
        if (launcher === "intel") {
          // No build this Mac can run: nothing is listed or chosen.
          assert.equal(state.automaticArchitecture, "x64", label);
          assert.deepEqual(state.catalog.versions, [], label);
          assert.equal(state.defaultVersion, null, label);
          assert.equal(selected.version, null, label);
          assert.equal(selected.reason, "No apple-only versions are available to download.", label);
          continue;
        }
        // Apple Silicon builds are automatic in both apps on Apple Silicon: the
        // Intel app has no Intel build of this runtime. Play and Install follow it.
        assert.equal(state.automaticArchitecture, "arm64", label);
        assert.deepEqual(state.catalog.versions, ["2.0.0-MCLv1", "1.0.0-MCLv1"], label);
        assert.equal(state.defaultVersion, "2.0.0-MCLv1", label);
        assert.equal(selected.version, "2.0.0-MCLv1", label);
        assert.equal(selected.architecture, "arm64", label);
        assert.equal(selected.requiresDownload, true, label);
        assert.equal(manager.chooseArchitecture(null, {}, userDataDir), "arm64", `${label}: Install uses the same build`);
        // A saved Intel choice with no Intel build gives way as well.
        assert.equal(manager.resolveSelection(null, { runtimes: { "apple-only": { defaultArchitecture: "x64" } } }, userDataDir).architecture, "arm64", label);
        continue;
      }
      assert.equal(state.automaticArchitecture, own, `${label}: the launcher's own CPU has a build`);
      assert.ok(state.catalog.versions.includes("2.0.0-MCLv1") && state.catalog.versions.includes("1.0.0-MCLv1"), `${label}: lists the new version`);
      assert.equal(state.defaultVersion, "2.0.0-MCLv1", `${label}: the new version is the default`);
      const selected = manager.resolveSelection(null, {}, userDataDir);
      assert.equal(selected.version, "2.0.0-MCLv1", label);
      assert.equal(selected.architecture, own, `${label}: Play uses the launcher's own CPU`);
      for (const version of ["1.0.0-MCLv1", "2.0.0-MCLv1"]) assert.ok(state.catalog.architectureCatalogs[other].versions.includes(version), `${label}: the other CPU lists ${version}`);
      if (projectId === "dual-cpu") {
        assert.equal(cpu(state.catalog, "2.0.0-MCLv1"), own, `${label}: the default list holds the launcher's build`);
        assert.equal(cpu(state.catalog.architectureCatalogs[other], "2.0.0-MCLv1"), other, `${label}: the other list holds the other CPU's build`);
        assert.equal(state.catalog.versionRequirements["2.0.0-MCLv1"].installReason, null);
      } else {
        for (const catalog of [state.catalog, state.catalog.architectureCatalogs[other]]) assert.equal(cpu(catalog, "2.0.0-MCLv1"), "universal", label);
      }
    }
  }
});

test("Runtimes shows the later versions in one list with a Build switch only where another CPU has its own builds", () => {
  assert.ok(states.arm64 && states.x64 && states.intel, "the Refresh test ran first");
  const appleSilicon = architecture => Host.architectureSupport(architecture, { platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true });
  const intelMac = architecture => Host.architectureSupport(architecture, { platform: "darwin", hardwareArch: "x64", rosettaAvailable: false });
  // Installed rows as the shared manager records them: the package CPU and the build choice.
  const installedRows = (launcher, projectId) => (projectId === "dual-cpu" ? ["arm64", "x64"] : projectId === "apple-only" ? ["arm64"] : ["universal"]).map(architecture => ({
    ...Architecture.tagInstall({ version: "2.0.0-MCLv1", architecture, ready: true, removable: true }, architecture),
    variant: `architecture:${architecture === "universal" ? launchers[launcher].cpu : architecture}`, installDir: `/fixture/${architecture}` }));
  function render(launcher, projectId, support, installArchitecture) {
    const state = withRunnableBuilds(states[launcher][projectId], support);
    const installed = installedRows(launcher, projectId);
    const manager = { ...state, ui: {}, installed, sections: state.sections.map(section => ({ ...section, installed })) };
    return renderToStaticMarkup(React.createElement(RuntimesView, {
      runtimeManagers: [manager], runtimeManagerId: projectId, runtimeSectionId: "default",
      runtimeUi: { [projectId]: { remoteOpen: {}, installVersion: {}, installVariant: {}, installedSort: {},
        installArchitecture: installArchitecture ? { default: installArchitecture } : {} } },
      downloadTasks: [], downloadsOpen: false, setDownloadsOpen() {}, setRuntimeManagerId() {}, setRuntimeSectionId() {},
      updateRuntimeUiSection() {}, onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {},
      onCancelDownload() {}, onOpenSource() {} }));
  }
  const buildChoices = markup => [...(/<select[^>]*aria-label="Build architecture"[^>]*>(.*?)<\/select>/.exec(markup)?.[1] || "")
    .matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(match => match[1]);
  const tags = markup => markup.split('class="saveRow"').slice(1).map(row => /class="badge">(Apple Silicon|Intel|Universal)<\/span>/.exec(row)?.[1] || null);
  const lists = markup => ["2.0.0-MCLv1", "1.0.0-MCLv1"].every(version => new RegExp(`<option[^>]*value="${version.replace(/\./g, "\\.")}"`).test(markup));

  // Apple Silicon app: the new version for both CPUs, Intel one switch away, only the Intel installation tagged.
  const apple = render("arm64", "dual-cpu", appleSilicon);
  assert.ok(lists(apple));
  assert.deepEqual(buildChoices(apple), ["Automatic (Apple Silicon)", "Intel (Rosetta)"]);
  assert.deepEqual(tags(apple).sort(), ["Intel", null]);
  const appleIntelList = render("arm64", "dual-cpu", appleSilicon, "x64");
  assert.match(appleIntelList, /<option value="x64" selected="">Intel \(Rosetta\)<\/option>/);
  assert.ok(lists(appleIntelList));
  // Intel app on Apple Silicon: Intel by default, Apple Silicon offered and tagged.
  const rosetta = render("x64", "dual-cpu", appleSilicon);
  assert.ok(lists(rosetta));
  assert.deepEqual(buildChoices(rosetta), ["Automatic (Intel)", "Apple Silicon"]);
  assert.deepEqual(tags(rosetta).sort(), ["Apple Silicon", null]);
  // Intel Mac: Apple Silicon builds are not offered.
  const intel = render("intel", "dual-cpu", intelMac);
  assert.ok(lists(intel));
  assert.deepEqual(buildChoices(intel), []);
  // An Apple-Silicon-only runtime: its builds are the automatic list with no
  // switch and no tag in both apps on Apple Silicon; an Intel Mac lists none.
  const appleOnly = (launcher, support, choice) => render(launcher, "apple-only", support, choice);
  for (const launcher of ["arm64", "x64"]) {
    const markup = appleOnly(launcher, appleSilicon);
    assert.ok(lists(markup), `${launcher}: Apple Silicon builds listed`);
    assert.deepEqual(buildChoices(markup), [], `${launcher}: no Build switch`);
    assert.deepEqual(tags(markup), [null], `${launcher}: the automatic build carries no tag`);
  }
  assert.deepEqual(buildChoices(appleOnly("intel", intelMac)), []);
  assert.ok(!lists(appleOnly("intel", intelMac, "arm64")));
  // Universal packages: one list in every app, no switch and no tag.
  for (const [launcher, support] of [["arm64", appleSilicon], ["x64", appleSilicon], ["intel", intelMac]]) {
    const markup = render(launcher, "universal-only", support);
    assert.ok(lists(markup), `${launcher}: universal versions listed`);
    assert.deepEqual(buildChoices(markup), [], `${launcher}: no Build switch for Universal packages`);
    assert.deepEqual(tags(markup), [null], `${launcher}: no tag on a Universal installation`);
  }
});
