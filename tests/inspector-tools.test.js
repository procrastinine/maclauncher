const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { writeZipArchive } = require('./helpers/zip-fixture');
let ui;
test.before(async () => {
  const Module = require('node:module'), { build } = require('vite');
  const bundle = await build({configFile:false,logLevel:'silent',build:{
    ssr:path.join(__dirname,'ui-audit-components.tsx'),write:false,
    rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs',codeSplitting:false}}
  }});
  const compiled = new Module(path.join(__dirname,'inspector-tools.cjs'),module); compiled.paths=module.paths;
  compiled._compile(bundle.output.find(row=>row.type==='chunk').code,compiled.id); ui=compiled.exports;
});
function temporary(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'inspector-tools-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root;
}
test('all shipped inspector actions resolve to implemented tools and reachable groups', () => {
  const registry=require('../src/modules/registry');
  for(const manifest of registry.listModules()) {
    const actions=manifest.ui?.actions||[], groups=ui.moduleToolGroups(actions,manifest.ui?.actionGroups);
    const reachable=new Set(groups.flatMap(group=>group.actions));
    assert.equal(new Set(actions.map(action=>action.id)).size,actions.length,manifest.id);
    for(const action of actions) {
      assert.equal(typeof registry.getModule(manifest.id).actions[action.id],'function',`${manifest.id}/${action.id}`);
      if(action.inspector!==false) assert.ok(reachable.has(action.id),`${manifest.id}/${action.id}: visible route`);
    }
  }
  const Godot=require('../src/modules/godot/main').manifest;
  for(const id of ['gdreRecover','gdreListFiles','gdreDecompile','gdreBinToTxt','gdreTxtToBin'])
    assert.ok(Godot.ui.actions.some(action=>action.id===id),`Godot ${id}`);
  for(const id of ['mv','mz']) assert.equal(registry.getModule(id).save.structured.inspectAction,'inspectStructuredSave');
});
test('tool groups keep primary work visible with supporting actions in More and results outside it', () => {
  const actions=[{id:'export',label:'Export source',kind:'primary'},
    {id:'refresh',label:'Refresh status',autoRun:true,icon:'refresh',iconOnly:true},
    {id:'reveal',label:'Reveal source',disabledWhen:[{key:'moduleData.ready',falsy:true}]}];
  const markup=renderToStaticMarkup(React.createElement(ui.ModuleTools,{
    game:{gamePath:'/game',moduleData:{ready:false}},groups:[{id:'source',label:'Source',actions:actions.map(a=>a.id)}],
    actions,busy:{},results:{export:{path:'/Exports/source'}},onAction(){},onRevealPath(){}
  }));
  assert.match(markup, /aria-label="Export source"/);
  assert.match(markup, /aria-label="More source actions"[^>]*aria-expanded="false"/);
  const menu=markup.match(/<div[^>]*popover="auto" class="moduleToolMenuItems">[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(menu,/aria-label="Export source"/);
  assert.match(menu,/aria-label="Refresh status"[^>]*>[^<]*<svg|aria-label="Refresh status"/);
  assert.match(menu,/disabled=""[^>]*aria-label="Reveal source"/);
  const paths=[{id:'done',label:'Inspect',resultFields:[{key:'path',label:'Output folder',format:'path'}]}];
  const result=renderToStaticMarkup(React.createElement(ui.ModuleTools,{
    game:{gamePath:'/game'},groups:[{id:'advanced',label:'Advanced',collapsed:true,actions:['done']}],
    actions:paths,results:{done:{path:'/Exports/source'}},busy:{},onAction(){},onRevealPath(){}
  }));
  assert.match(result,/<\/details>[\s\S]*class="moduleResultGroup"/);
  assert.match(result,/aria-label="Reveal output folder"/);
});
test('inline video graphics actions keep Preview and Export visible with cancellation and revealable output', () => {
  const manifest = require('../src/modules/video/manifest.json'), actions = manifest.ui.actions;
  const properties = {game:{gamePath:'/Video/source.mp4'},groups:ui.moduleToolGroups(actions,manifest.ui.actionGroups),
    actions,busy:{},results:{exportVideo:{output:'/Exports/processed.mp4'}},onAction(){},onCancel(){},onRevealPath(){}};
  const markup = renderToStaticMarkup(React.createElement(ui.ModuleTools,properties));
  assert.match(markup,/aria-label="Preview settings"/);assert.match(markup,/aria-label="Export video…"/);
  assert.doesNotMatch(markup,/Process with neural model|Process video…/);
  assert.doesNotMatch(markup,/More video processing actions/);assert.match(markup,/aria-label="Reveal exported video"/);
  const running = renderToStaticMarkup(React.createElement(ui.ModuleTools,{...properties,busy:{exportVideo:true}}));
  assert.match(running,/aria-label="Cancel Export video"/);assert.doesNotMatch(running,/Reveal exported video/);
});
test('video Preview and Export delegate the saved graphics settings without creating another editor', async () => {
  const filename = require.resolve('../src/modules/video/main'), localRequire = require('node:module').createRequire(filename), seen = [], expected = [];
  const tools = Object.fromEntries(['previewVideo','exportVideo','processVideo'].map(name => [name,async (...args) => {
    seen.push([name,...args]);return expected;
  }]));
  const scope = {module:{exports:{}},process,require:id=>id==='./tools'?tools:localRequire(id)};
  require('node:vm').runInNewContext(fs.readFileSync(filename,'utf8'),scope);
  const entry = {gamePath:'/Video/source.mp4',graphics:{spatialMethod:'metalfx'},effects:{schema:1,mode:'advanced',video:[]}}, before = structuredClone(entry), payload = {}, context = {};
  for (const name of ['previewVideo','exportVideo','processVideo']) assert.equal(await scope.module.exports.actions[name](entry,payload,context),expected);
  for (const [index,row] of seen.entries()) {
    assert.equal(row[0],['previewVideo','exportVideo','processVideo'][index]);assert.equal(row[1],entry);assert.equal(row[2],payload);assert.equal(row[3],context);
  }
  assert.deepEqual(entry,before);
});
test('declared orphan tools remain reachable while specialized controls and hidden actions stay separate', () => {
  const actions=[{id:'known',label:'Known'}, {id:'new',label:'New tool'},
    {id:'special',label:'Cheat action',inspector:false}, {id:'hidden',label:'Wrong runtime',hiddenWhen:[{key:'runtimeId',notEquals:'other'}]}];
  const groups=[{id:'known',label:'Source',actions:['known','special']},
    {id:'dedicated',label:'Dedicated',actions:['special']}], before=JSON.stringify(groups);
  const resolved=ui.moduleToolGroups(actions,groups);
  const markup=renderToStaticMarkup(React.createElement(ui.ModuleTools,{
    game:{gamePath:'/game',runtimeId:'current'},groups:resolved,actions,results:{},busy:{},onAction(){}
  }));
  assert.equal(JSON.stringify(groups),before);
  assert.ok(resolved.every(group=>!group.actions.includes('special')));
  assert.ok(!resolved.some(group=>group.id==='dedicated'));
  assert.match(markup,/<details class="moduleToolGroup"><summary>More tools<\/summary>/);
  assert.match(markup,/aria-label="New tool"/);
  assert.doesNotMatch(markup,/Cheat action|Wrong runtime/);
});
test('Construct bundle tools extract and reveal real resources without removing a foreign folder', async t => {
  const root=temporary(t), source=path.join(root,'game.nw'), context={userDataDir:path.join(root,'data')};
  writeZipArchive(source,[{name:'index.html',data:'<html>Made with Construct</html>'},{name:'c2runtime.js',data:'original'}]);
  const original=fs.readFileSync(source), module=require('../src/modules/construct/main');
  const entry={gameId:'construct-tools',gamePath:source,moduleData:{packagedType:'nwjs',packagedPath:source}};
  assert.equal((await module.actions.extractGame(entry,{},context)).extractedReady,true);
  let revealed;context.ui={shell:{showItemInFolder:target=>revealed=target}};
  module.actions.revealExtraction(entry,{},context);
  assert.equal(revealed,entry.moduleData.extractedRoot);
  assert.match(fs.readFileSync(path.join(revealed,'index.html'),'utf8'),/Made with Construct/);
  const foreign=path.join(root,'original-folder');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'keep'),'original');
  assert.throws(()=>module.actions.removeExtraction({...entry,moduleData:{...entry.moduleData,extractedRoot:foreign}}, {},context),/outside/);
  assert.equal(fs.readFileSync(path.join(foreign,'keep'),'utf8'),'original');
  module.actions.removeExtraction(entry,{},context); assert.equal(fs.existsSync(revealed),false);
  assert.deepEqual(fs.readFileSync(source),original);
});
test('Godot file listing preserves actual CLI output as a revealable owned report', async t => {
  const root=temporary(t), source=path.join(root,'original.pck'), cli=path.join(root,'gdre');
  fs.writeFileSync(source,'Original pack');
  fs.writeFileSync(cli,`#!${process.execPath}\nprocess.stdout.write('res://場景/main.tscn\\nres://scripts/main.gdc\\n');\n`,{mode:0o755});
  const runtime=require('../src/modules/godot/runtime/gdsdecomp-runtime'), previous=runtime.listInstalled;
  runtime.listInstalled=()=>[{version:'fixture',cliPath:cli}];t.after(()=>runtime.listInstalled=previous);
  const entry={gameId:'godot-tools',moduleData:{packPath:source}}, context={userDataDir:path.join(root,'data'),settings:{}};
  const result=await require('../src/modules/godot/main').actions.gdreListFiles(entry,{},context);
  assert.match(result.reportPath,/modules\/godot\/reports\/pack-files\.txt$/);
  assert.equal(fs.readFileSync(result.reportPath,'utf8'),'res://場景/main.tscn\nres://scripts/main.gdc\n');
  assert.equal(entry.moduleData.gdreLastActionOutput,result.reportPath);
  assert.equal(fs.readFileSync(source,'utf8'),'Original pack');
});
