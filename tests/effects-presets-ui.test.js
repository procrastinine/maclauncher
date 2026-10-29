const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
let EffectsPresetManager, EffectsPresetMenuItems, ReShadeFilterLibrary, ShaderLibraryFamily;
async function compile(name, exported = name) {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, `../src/renderer/src/ui/components/${name}.tsx`), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, `${name}.cjs`), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);return compiled.exports[exported];
}
test.before(async () => { [EffectsPresetManager, EffectsPresetMenuItems, ReShadeFilterLibrary, ShaderLibraryFamily] = await Promise.all([compile("EffectsPresetManager"), compile("EffectsPresetPicker", "EffectsPresetMenuItems"), compile("ReShadeFilterLibrary"), compile("ShaderLibraryFamily")]); });
const empty = () => ({ schema: 1, mode: "advanced", video: [] });
test("empty preset libraries accept only notice arrays and preserve valid notices", async () => {
  for (const notices of [undefined, null, {}, "unexpected", [], [{ message: "A saved preset could not be read." }]]) {
    const harness = componentHarness(EffectsPresetManager, { api: {
      listEffectsPresets: async () => [], getEffectsPresetNotices: async () => notices,
      getEffectsPresetEditor: async () => ({ plan: empty(), catalog: [] })
    } });
    try {
      harness.render();
      const markup = renderToStaticMarkup(await harness.settle());
      assert.match(markup, /New preset/);
      assert.match(markup, /graphics-preset-name/);
      assert.equal(markup.includes("A saved preset could not be read."), Array.isArray(notices) && notices.length > 0);
    } finally { harness.close(); }
  }
});
function elements(element) { return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(elements),...elements(element.props.toolbar)] : []; }
test("one searchable shader library preserves collection identity and original filter formats", async () => {
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
    let markup = renderToStaticMarkup(family.render());for (const label of ['Own ReShade','Own MPV','Own libretro']) assert.ok(markup.includes(label));
    assert.doesNotMatch(markup, /shader-family-tab-/);assert.match(markup, /shader-library-search/);
    elements(family.render()).find(row => row.props.id === 'shader-library-search').props.onChange({target:{value:'ReShade'}});
    markup=renderToStaticMarkup(family.render());assert.match(markup,/Own ReShade/);assert.doesNotMatch(markup,/Own MPV|Own libretro/);
    assert.deepEqual(elements(family.render()).filter(row => row.type === 'option' && choices.some(choice => choice.id === row.props.value)).map(row => row.props.value),
      choices.map(choice => choice.id), 'the Library search never filters Collections');
  } finally { family.close(); }
  const requested = [], table = componentHarness(ReShadeFilterLibrary, { filters, family: 'libretro', showDownloads: false,
    api: { importReShadeFilters: async family => { requested.push(family);return []; } } });
  try {
    const markup = renderToStaticMarkup(table.render());assert.match(markup, /Own libretro/);assert.doesNotMatch(markup, /Own ReShade|Own MPV|Download shaders/);
    elements(table.render()).find(row => row.type === 'button' && row.props.children === 'Import filter…').props.onClick();
    await table.settle();assert.deepEqual(requested, ['libretro']);
  } finally { table.close(); }
});
test("shader library uses shared I/O types, explicit extents and legacy navigation aliases", () => {
  const filter = (id, traits) => ({id, name:id, path:`/Filters/${id}.mclfilter`, available:true, traits});
  const filters = [filter('purpose-tag', {category:'upscaling'}), filter('reduction', {category:'color',outputScale:{x:.5,y:.5}}),
    filter('cnn', {outputScale:{x:2,y:2}}), filter('stage', {requestedOutputExtent:true}),
    filter('dof', {sceneInputs:['depth','projectionMatrix']}), filter('relative-fog', {modelOperation:'depth-anything-v2-small'})];
  const props = {active:true,collections:[],filters,shaderCategory:'downscaling',onSelectCollection() {},children:null};
  const family = componentHarness(ShaderLibraryFamily,props);
  const visible = () => elements(family.render()).find(row => Array.isArray(row.props.filters)).props.filters.map(row=>row.id);
  const select = value => elements(family.render()).find(row=>row.props.id==='shader-library-type').props.onChange({target:{value}});
  try {
    assert.deepEqual(visible(),['reduction']);
    const options = elements(family.render()).filter(row=>row.type==='option').map(row=>row.props.children);
    assert.deepEqual(options,['All types','Image filter','Downsample','Upscale']);
    select('upscaling');assert.deepEqual(visible(),['cnn']);
    select('resize-shader');assert.deepEqual(visible(),filters.map(row=>row.id),'a retired type shows every shader');
    select('image');assert.deepEqual(visible(),['purpose-tag','stage','dof','relative-fog']);
    for(const type of ['temporal','generation']) {select(type);assert.deepEqual(visible(),[]);}
    select('all');assert.deepEqual(visible(),filters.map(row=>row.id));
  } finally {family.close();}
});
test("preset and filter explanations stay in help while file errors and editable paths remain visible", () => {
  const manager = renderToStaticMarkup(React.createElement(EffectsPresetManager, { api: {} }));
  assert.match(manager, /popover="auto" class="helpPopover">Save ordered effects for reuse\./);
  assert.doesNotMatch(manager, /<p class="detailMeta">Save ordered effects/);
  assert.match(manager, />Save<\/button>/);assert.match(manager, />Discard<\/button>/);
  const filters = renderToStaticMarkup(React.createElement(ReShadeFilterLibrary, { filters: [
    { id: 'custom', name: 'Custom filter', path: '/Shaders/filter.fx', available: false, reason: 'Choose an existing shader file.' }
  ], filtersError: 'The filter library could not be read.', api: {} }));
  assert.match(filters, /popover="auto" class="helpPopover">Shader files, color LUTs and compiled-effect descriptors share this library\./);
  assert.doesNotMatch(filters, /<p[^>]*>Shader files, color LUTs/);
  assert.doesNotMatch(filters, /class="dim settingsHint"/);
  assert.match(filters, /aria-expanded="false" aria-controls="shader-source-custom"/);
  assert.match(filters, /Choose an existing shader file\./);
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
  const harness = componentHarness(EffectsPresetMenuItems, {templates: [template], disabled: false, onApply: value => applied.push(value), onSave() {}});
  try {
    harness.render();await harness.settle();
    const find = label => elements(harness.render()).find(node => node.type === "button" && React.Children.toArray(node.props.children)[0] === label);
    find(template.name).props.onClick();assert.deepEqual(applied, [template.plan]);assert.notEqual(applied[0], template.plan);
    applied[0].video[0].settings.spatialMultiplier = .5;assert.equal(template.plan.video[0].settings.spatialMultiplier, .25);
    find("Manage presets…").props.onClick();await harness.settle();assert.deepEqual(opened, [{view: "runtimes", managerId: "graphics-presets"}]);
    template.available = false;template.reason = "Choose a compatible neural model.";
    assert.equal(find(`${template.name} · Unavailable`).props.disabled, true);
    assert.match(renderToStaticMarkup(harness.render()), /Reconstruction \+ frame generation · 4× · Unavailable<span class="menuItemDetail">Choose a compatible neural model\.<\/span>/);
  } finally {harness.close();global.window = previous;}
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
test('preset pushes update open pickers and clean drafts while preserving edits and newer catalogs',async()=>{
 const previous=global.window,listeners=new Set(),original={id:'one',name:'Original',updatedAt:1,plan:empty()},updated={...original,name:'Updated',updatedAt:2};let release,reads=0;
 const api={listEffectsPresets:()=>new Promise(resolve=>{release=resolve;}),onEffectsPresetsChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},getEffectsPresetEditor:async()=>{reads++;return{plan:empty(),catalog:[]};}};
 global.window={addEventListener(){},removeEventListener(){},MacLauncher:{launcher:api}};
 const picker=componentHarness(EffectsPresetMenuItems,{disabled:false,onApply(){},onSave(){}});
 try{
  picker.render();for(const listener of listeners)listener([updated]);release([original]);await picker.settle();
  let markup=renderToStaticMarkup(picker.render());assert.match(markup,/Updated/);assert.doesNotMatch(markup,/>Original</);
 }finally{picker.close();}
 const props={api,status:{available:true,presets:[]},selectedId:original.id},manager=componentHarness(EffectsPresetManager,props);
 const input=()=>elements(manager.render()).find(n=>n.props.id==='graphics-preset-name');
 try{
  manager.render();release([original]);await manager.settle();assert.equal(input().props.value,'Original');
  for(const listener of listeners)listener([updated]);assert.equal(input().props.value,'Updated');
  input().props.onChange({target:{value:'Local draft'}});for(const listener of listeners)listener([{...updated,name:'Other window',updatedAt:3}]);assert.equal(input().props.value,'Local draft');
  const before=reads;props.status={available:true,presets:[]};manager.render();await manager.settle();assert.equal(reads,before,'unchanged state broadcasts do not reload the catalog');
  props.status={available:true,presets:[{id:'imported',label:'New filter'}]};manager.render();await manager.settle();assert.equal(reads,before+1,'new filter metadata refreshes the common editor');
  props.status={...props.status,defaultNeuralModelVersions:{realcugan:'installed-3x'}};manager.render();await manager.settle();assert.equal(reads,before+2,'operation defaults refresh exact selected model metadata');assert.equal(input().props.value,'Local draft');
  props.status={...props.status,defaultNeuralModelVersions:{realcugan:'installed-3x'}};manager.render();await manager.settle();assert.equal(reads,before+2,'unchanged operation defaults do not reload the catalog');
 }finally{manager.close();global.window=previous;}
 assert.equal(listeners.size,0);
});
test('unified shader library preserves canonical IDs, protects managed sources and shares editable aliases',async()=>{
 const renamed=[],removed=[],included={id:'crt',presetId:'crt',implementationId:'shader:crt',name:'CRT',defaultName:'CRT',path:'/Bundled/crt.fx',format:'fx',available:true,origin:'included',canRemove:false,canRelocate:false},imported={id:'filter:uuid',presetId:'filter:uuid',implementationId:'shader:filter:uuid',filterId:'uuid',name:'Own shader',path:'/Own/same.fx',format:'fx',available:true,origin:'imported',canRemove:true,canRelocate:true};
 const api={renameReShadeShader:async(...args)=>{renamed.push(args);return true;},updateReShadeFilter:async()=>true,removeReShadeFilter:async id=>{removed.push(id);return true;},pickReShadeFilterPath:async()=>null};
 const h=componentHarness(ReShadeFilterLibrary,{filters:[included,imported],api,showDownloads:false});
 try{let tree=h.render();assert.equal(elements(tree).filter(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Replace file')).length,0);assert.equal(elements(tree).filter(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Remove filter')).length,1);
  elements(tree).find(n=>n.props['aria-controls']==='shader-source-filter:uuid').props.onClick();tree=h.render();assert.equal(elements(tree).filter(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('Replace file')).length,1);
  const name=elements(tree).find(n=>n.props.label==='Filter name: CRT');await name.props.onCommit('Living room CRT');await h.settle();assert.deepEqual(renamed,[['crt','Living room CRT']]);
  elements(h.render()).find(n=>n.props['aria-label']==='Remove filter Own shader').props.onClick();await h.settle();assert.deepEqual(removed,['uuid']);
 }finally{h.close();}
 const f=componentHarness(ShaderLibraryFamily,{active:true,collections:[],filters:[included,imported],onSelectCollection(){}});
 try{const tree=f.render(),tabs=elements(tree).filter(n=>n.props.role==='tab');assert.deepEqual(tabs.map(n=>n.props.children),['Library','Collections']);assert.equal(elements(tree).find(n=>n.props.id==='shader-collections-panel').props.hidden,true);tabs[1].props.onClick();assert.equal(elements(f.render()).find(n=>n.props.id==='shader-library-panel').props.hidden,true);}finally{f.close();}
});
