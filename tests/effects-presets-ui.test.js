const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
let EffectsPresetManager, EffectsPresetPicker, SettingsView, ReShadeFilterLibrary, ShaderLibraryFamily;
async function compile(name) {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, `../src/renderer/src/ui/components/${name}.tsx`), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, `${name}.cjs`), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);return compiled.exports[name];
}
test.before(async () => { [EffectsPresetManager, EffectsPresetPicker, SettingsView, ReShadeFilterLibrary, ShaderLibraryFamily] = await Promise.all([compile("EffectsPresetManager"), compile("EffectsPresetPicker"), compile("SettingsView"), compile("ReShadeFilterLibrary"), compile("ShaderLibraryFamily")]); });
const empty = () => ({ schema: 1, mode: "advanced", video: [] });
function elements(element) { return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(elements)] : []; }
test("shader family tabs and collection selection preserve original identities and import only the chosen family", async () => {
  const filters = [{ id: 'fx', name: 'Own ReShade', path: '/Shaders/own.fx', format: 'fx', available: true },
    { id: 'slang', name: 'Own libretro', path: '/Shaders/own.slangp', format: 'slangp', available: true },
    { id: 'mpv', name: 'Own MPV', path: '/Shaders/own.hook', format: 'libplacebo', available: true }];
  const choices = ['one', 'two'].map(id => ({ id: JSON.stringify(['original-manager', id]), sectionId: id,
    managerId: 'original-manager', label: id, section: { id, shaderFamily: 'mpv' } }));
  const selected = [], props = { active: true, collections: choices, selectedId: choices[0].id, requestedSectionId: 'one',
    filters, onSelectCollection: choice => selected.push(choice), children: null };
  const family = componentHarness(ShaderLibraryFamily, props);
  try {
    const select = elements(family.render()).find(row => row.props.id === 'shader-collection');
    select.props.onChange({ target: { value: choices[1].id } });assert.equal(selected[0], choices[1]);
    elements(family.render()).find(row => row.props.id === 'shader-family-tab-reshade').props.onClick();
    const markup = renderToStaticMarkup(family.render());assert.match(markup, /Own ReShade/);assert.doesNotMatch(markup, /Own MPV|Own libretro/);
    assert.doesNotMatch(markup, /<summary>Collections/);
  } finally { family.close(); }
  const requested = [], table = componentHarness(ReShadeFilterLibrary, { filters, family: 'libretro', showDownloads: false,
    api: { importReShadeFilters: async family => { requested.push(family);return []; } } });
  try {
    const markup = renderToStaticMarkup(table.render());assert.match(markup, /Own libretro/);assert.doesNotMatch(markup, /Own ReShade|Own MPV|Download shaders/);
    elements(table.render()).find(row => row.type === 'button' && row.props.children === 'Import filter…').props.onClick();
    await table.settle();assert.deepEqual(requested, ['libretro']);
  } finally { table.close(); }
});
test("preset and filter explanations stay in help while file errors and editable paths remain visible", () => {
  const manager = renderToStaticMarkup(React.createElement(EffectsPresetManager, { api: {} }));
  assert.match(manager, /popover="auto" class="helpPopover">Save ordered effects for reuse\./);
  assert.doesNotMatch(manager, /<p class="detailMeta">Save ordered effects/);
  assert.match(manager, />Save<\/button>/);assert.match(manager, />Discard<\/button>/);
  const picker = renderToStaticMarkup(React.createElement(EffectsPresetPicker, { plan: empty(), disabled: false, onApply() {} }));
  assert.match(picker, /popover="auto" class="helpPopover">Apply replaces this chain with a copy\./);
  assert.doesNotMatch(picker, /<p class="detailMeta">Apply replaces/);
  const filters = renderToStaticMarkup(React.createElement(ReShadeFilterLibrary, { filters: [
    { id: 'custom', name: 'Custom filter', path: '/Shaders/filter.fx', available: false, reason: 'Choose an existing shader file.' }
  ], filtersError: 'The filter library could not be read.', api: {} }));
  assert.match(filters, /popover="auto" class="helpPopover">ReShade \.fx/);
  assert.doesNotMatch(filters, /class="filterLibraryFormat"|class="dim settingsHint"/);
  assert.match(filters, /aria-label="Filter path: Custom filter"[^>]*value="\/Shaders\/filter\.fx"/);
  assert.match(filters, /role="status">Choose an existing shader file\./);
  assert.match(filters, /role="alert">The filter library could not be read\./);
});
test("contextual templates apply an independent chain without saving or editing a global preset", async () => {
  const previous = global.window, applied = [], opened = [];
  global.window = {addEventListener() {}, removeEventListener() {}, MacLauncher: {launcher: {
    listEffectsPresets: async () => [], openUtilityWindow: async value => opened.push(value),
    saveEffectsPreset: () => assert.fail("Applying a template must not save a preset")
  }}};
  const template = {id: "reconstruction-4x", name: "Reconstruction + frame generation · 4×", available: true,
    plan: {...empty(), video: [{id: "reduce", kind: "spatial", method: "downsample", enabled: true, settings: {spatialMultiplier: .25}}]}};
  const harness = componentHarness(EffectsPresetPicker, {plan: empty(), templates: [template], disabled: false, onApply: async value => applied.push(value)});
  try {
    harness.render();await harness.settle();
    const find = label => elements(harness.render()).find(node => node.type === "button" && node.props.children === label);
    elements(harness.render()).find(node => node.props.id === "effects-preset").props.onChange({target: {value: "template:reconstruction-4x"}});
    find("Apply").props.onClick();assert.deepEqual(applied, [template.plan]);assert.notEqual(applied[0], template.plan);
    applied[0].video[0].settings.spatialMultiplier = .5;assert.equal(template.plan.video[0].settings.spatialMultiplier, .25);
    find("Manage presets…").props.onClick();await harness.settle();assert.deepEqual(opened, [{view: "settings", sectionId: "graphics:presets"}]);
    template.available = false;template.reason = "Choose a compatible neural model.";
    assert.equal(find("Apply").props.disabled, true);
    assert.match(renderToStaticMarkup(harness.render()), /disabled=""[^>]*title="Choose a compatible neural model\."/);
    assert.match(renderToStaticMarkup(harness.render()), /Reconstruction \+ frame generation · 4×: Choose a compatible neural model\./);
  } finally {harness.close();global.window = previous;}
});
test("Graphics settings exposes separate accessible filter and Advanced preset tabs", () => {
  const markup = renderToStaticMarkup(React.createElement(SettingsView, { state: { modules: [] }, sectionId: "graphics:presets",
    showIcons: true, showNonDefaultTags: false, onSetLauncherSettings() {}, onSetModuleSettings() {} }));
  assert.match(markup, /role="tab"[^>]*id="graphics-settings-tab-filters"/);
  assert.match(markup, /role="tab"[^>]*id="graphics-settings-tab-presets"[^>]*aria-selected="true"/);
  assert.match(markup, /role="tabpanel"[^>]*aria-labelledby="graphics-settings-tab-presets"/);
  assert.match(markup, /Advanced graphics presets/);assert.doesNotMatch(markup, /Return to simple/);
});
test("Download shaders opens the shared managed shader library", async () => {
  const opened = [], api = { openUtilityWindow: async request => { opened.push(request);return true; } };
  const harness = componentHarness(ReShadeFilterLibrary, { filters: [], api });
  try {
    const button = elements(harness.render()).find(node => node.type === "button" && node.props.children === "Download shaders…");
    assert.equal(button.props.disabled, false);button.props.onClick();await harness.settle();
    assert.deepEqual(opened, [{ view: "runtimes", managerId: "graphics-shader-library" }]);
  } finally { harness.close(); }
});
test("preset editing stays in a local draft until Save and Discard restores the selected snapshot", async () => {
  const original = { id: "ed5f88b7-4041-4d1e-a223-30d3267d9ada", name: "Film", updatedAt: 1, plan: empty() };
  const saves = [], api = { listEffectsPresets: async () => [structuredClone(original)],
    getEffectsPresetEditor: async () => ({ mode: "advanced", live: false, plan: empty(), catalog: [] }),
    saveEffectsPreset: async value => { saves.push(structuredClone(value));return { ...value, id: original.id, updatedAt: 2 }; } };
  const harness = componentHarness(EffectsPresetManager, { api, status: { available: true, presets: [] }, selectedId: original.id });
  try {
    harness.render();await harness.settle();
    const find = id => elements(harness.render()).find(node => node.props.id === id);
    find("graphics-preset-name").props.onChange({ target: { value: "Cinema" } });
    assert.equal(saves.length, 0);assert.equal(find("graphics-preset-selection").props.disabled, true);
    const discard = elements(harness.render()).find(node => node.type === "button" && node.props.children === "Discard");discard.props.onClick();
    assert.equal(find("graphics-preset-name").props.value, "Film");
    find("graphics-preset-name").props.onChange({ target: { value: "Cinema" } });
    elements(harness.render()).find(node => node.type === "button" && node.props.children === "Save").props.onClick();
    await harness.settle();assert.equal(saves.length, 1);assert.equal(saves[0].name, "Cinema");assert.equal(saves[0].updatedAt, 1);
    assert.equal(original.name, "Film");assert.deepEqual(original.plan, empty());
    const editor = elements(harness.render()).find(node => typeof node.type === "function" && node.props.editor);
    editor.props.editor.onChange({ ...empty(), renderResolution: { height: 480 } });
    assert.equal(saves.length, 1);assert.equal(find("graphics-preset-selection").props.disabled, true);
  } finally { harness.close(); }
});
