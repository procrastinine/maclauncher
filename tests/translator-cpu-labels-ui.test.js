const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite");
const { react } = require("./helpers/renderer-component");
let UI;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "translator-cpu-labels-ui.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, "translator-cpu-labels-ui.cjs"), module);
  compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  UI = compiled.exports;
});

function render(managers, selected) {
  const none = () => { throw new Error("Rendering must not act"); };
  return renderToStaticMarkup(React.createElement(UI.RuntimesView, { runtimeManagers: managers, runtimeUi: {}, runtimeManagerId: selected, runtimeSectionId: "default",
    downloadTasks: [], setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {}, onRuntimeRefresh: none, onRuntimeInstall: none,
    onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {}, onOpenSource: none }));
}
const version = "27.0.0-devel-MCLv12";
const requirement = architecture => ({ architecture, available: true, requiresDownload: true, installLabel: "Install", hostArchitectures: architecture === "x64" ? ["arm64", "x64"] : ["arm64"] });
const catalog = architecture => ({ status: "success", architecture, versions: [version], installable: true, installableVersions: [version],
  versionRequirements: { [version]: requirement(architecture) } });
const kosmic = { id: "maclauncher-kosmickrisp", label: "MacLauncher KosmicKrisp", ui: { groupId: "vulkan-drivers", sectionLabel: "MacLauncher KosmicKrisp", memberOrder: 22, management: "managed" },
  sections: [{ id: "default", label: "MacLauncher KosmicKrisp", automaticArchitecture: "arm64", launcherArchitecture: "arm64", defaultVersion: version,
    catalog: { ...catalog("arm64"), architectureCatalogs: { arm64: catalog("arm64"), x64: catalog("x64") } },
    installed: [{ version, architecture: "arm64", architectures: ["arm64"], variant: "architecture:arm64", ready: true, installDir: "/Fixture/arm64" },
      { version, architecture: "x64", architectures: ["x86_64"], variant: "architecture:x64", ready: true, installDir: "/Fixture/x64" }] }] };

test("translator rows name each CPU build, so both builds of one version read as two entries; the Build menu sits under Additional sources", () => {
  const markup = render([kosmic], kosmic.id);
  assert.deepEqual([...markup.matchAll(/data-cpu-build="([^"]+)"[^>]*>([^<]+)</g)].map(match => [match[1], match[2]]),
    [["arm64", "Apple Silicon"], ["x64", "Intel"]]);
  const versionOptions = [...markup.matchAll(/<option value="27[^"]*"[^>]*>([^<]+)<\/option>/g)].map(match => match[1]);
  assert.ok(versionOptions.length > 0 && versionOptions.every(label => !/·\s*(?:Apple Silicon|Intel|arm64|x64)/.test(label)), versionOptions.join(" | "));
  const additional = /<details class="runtimeAdditionalSources">(.*?)<\/details>/s.exec(markup)?.[1] || "";
  const build = /aria-label="Build architecture"[^>]*>(.*?)<\/select>/.exec(additional)?.[1] || "";
  assert.deepEqual([...build.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(match => match[1]), ["Automatic (Apple Silicon)", "Intel (Rosetta)"]);
  assert.equal(markup.match(/aria-label="Build architecture"/g).length, 1);
  // Other runtime views keep their Intel mark for another CPU only, and their Build menu in place.
  const other = { ...kosmic, id: "fixture-engine", ui: { management: "managed" } };
  const plain = render([other], other.id);
  assert.doesNotMatch(plain, /data-cpu-build/);
  assert.match(plain, /<span class="badge">Intel<\/span>/);
  assert.doesNotMatch(/<details class="runtimeAdditionalSources">(.*?)<\/details>/s.exec(plain)?.[1] || "", /Build architecture/);
});

test("a version names its build only when it differs from the chosen build and is not Universal", () => {
  assert.equal(UI.translatorInstallBuild({ architectures: ["x86_64", "arm64"], architecture: "arm64" }), "universal");
  assert.equal(UI.translatorInstallBuild({ architectures: ["x86_64"], architecture: "arm64" }, { architecture: "universal" }), "x64",
    "an x86_64 library installed from a list for every Mac is the x64 build");
  assert.equal(UI.translatorInstallBuild({ architectures: [], architecture: "arm64" }, { architecture: "universal" }), "universal");
  assert.equal(UI.translatorInstallBuild({ architecture: "x64" }), "x64");
  assert.equal(UI.translatorVersionBuild("1.0", { versionRequirements: { "1.0": { architecture: null } } }), "",
    "a list without a declared CPU leaves an uninstalled version unnamed");
  const mixed = { ...kosmic, sections: [{ ...kosmic.sections[0], installed: [], catalog: { ...catalog("arm64"), versions: [version, "1.2", "1.1"], installableVersions: [version, "1.2", "1.1"],
    versionRequirements: { [version]: requirement("arm64"), "1.2": requirement("x64"), "1.1": requirement("universal") } } }] };
  const options = [...render([mixed], mixed.id).matchAll(/<option value="(?:27|1\.)[^"]*"[^>]*>([^<]+)<\/option>/g)].map(match => match[1]);
  assert.equal(options.length, 3, options.join(" | "));
  assert.deepEqual(options.filter(label => label.includes("·")), options.filter(label => /^v?1\.2 · Intel/.test(label)), options.join(" | "));
  assert.equal(options.filter(label => label.includes("·")).length, 1, "the chosen build and Universal are not named");
});
