const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server'),{build}=require('vite'),{react,componentHarness}=require('./helpers/renderer-component');
let RuntimesView,RuntimeSetupSelector;
async function compile(name,hooks=false){const result=await build({configFile:false,logLevel:'silent',build:{ssr:path.join(__dirname,`../src/renderer/src/ui/components/${name}.tsx`),write:false,rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs',codeSplitting:false}}}});const m=new Module(path.join(__dirname,name+'.cjs'),module);m.paths=module.paths;if(hooks)m.require=id=>id==='react'?react:Module.prototype.require.call(m,id);m._compile(result.output.find(x=>x.type==='chunk').code,m.id);return m.exports[name];}
test.before(async()=>{[RuntimesView,RuntimeSetupSelector]=await Promise.all([compile('RuntimesView',true),compile('RuntimeSetupSelector',true)]);});
// The library lists these download sources beside the declared default source, which names the release page.
function mockSources(t,rows){const declared=require('../src/modules/shared/reshade/neural/setup').sourceFor();t.mock.method(require('../src/modules/shared/reshade/neural/catalog'),'sources',()=>[...rows,declared]);}
const elements=node=>React.isValidElement(node)?[node,...React.Children.toArray(node.props.children).flatMap(elements)]:[];
test('model library shares operation defaults and compact explicit acquisition without changing other preferences',t=>{
 const Models=require('../src/modules/shared/reshade/neural/models'),Setup=require('../src/modules/shared/reshade/neural/setup'),manager=require('../src/modules/shared/reshade/runtime/neural-models-manager');
 const version=c=>'sha256-'+c.repeat(64),nr=version('a'),two=version('b'),three=version('c'),rife=version('d');
 const rows=[{version:nr,versionLabel:'NR',operation:'mlx-dlss',ready:true},{version:two,versionLabel:'CUGAN2x',operation:'realcugan',curatedDefault:true,ready:true},{version:three,versionLabel:'CUGAN3x',operation:'realcugan',ready:true},{version:rife,versionLabel:'RIFE',operation:'rife',ready:true}];
 t.mock.method(Models,'listManaged',()=>rows);t.mock.method(Models,'listInstalled',()=>rows);mockSources(t,[{version:'source-one',files:[{}],label:'Original source',description:'Original model',weightTerms:'Original terms'}]);t.mock.method(Setup,'sourceInstalled',()=>null);
 const previous={defaultVersion:rife,defaultVersions:{'mlx-dlss':nr,realcugan:three,rife}},state=manager.getState({settings:previous});
 assert.equal(state.setupPresentation.mode,'table');assert.equal(state.setupActions[0].id,'downloadModel:source-one');assert.equal(state.registrationPresentation.label,'Use existing package…');
 assert.equal(state.defaultSelections.find(x=>x.id==='realcugan').version,three);assert.equal(state.defaultSelections.find(x=>x.id==='mlx-dlss').version,nr);
 const selected=manager.updateSettingsAfterDefault(manager.applySettingsUpdate('setDefault',{version:two},previous),{version:two},{previousSettings:previous});
 assert.deepEqual(selected.defaultVersions,{'mlx-dlss':nr,realcugan:two,rife});
 const cleared=manager.updateSettingsAfterDefault(manager.applySettingsUpdate('setDefault',{version:null},selected),{version:null},{previousSettings:selected});assert.deepEqual(cleared.defaultVersions,{'mlx-dlss':nr,rife});
});
test('model downloads use one shared picker and defaults stay visible per operation with offline render',async()=>{
 const actions=Array.from({length:20},(_,i)=>({id:'source-'+i,label:'Model '+i,buttonLabel:'Download model…',description:'Terms '+i,available:true,installed:i===1})),chosen=[];
 const picker=componentHarness(RuntimeSetupSelector,{id:'models',actions,label:'Download',searchLabel:'Search model downloads',busy:false,onAction:id=>chosen.push(id)});
 try{let tree=picker.render();const select=elements(tree).find(n=>typeof n.type==='function'&&n.props.options);assert.equal(select.props.searchLabel,'Search model downloads');select.props.onChange({target:{value:'source-7'}});tree=picker.render();elements(tree).find(n=>n.type==='button'&&n.props.children==='Download model…').props.onClick();assert.deepEqual(chosen,['source-7']);select.props.onChange({target:{value:'source-1'}});assert.equal(elements(picker.render()).find(n=>n.type==='button'&&n.props.children==='Installed').props.disabled,true);}finally{picker.close();}
 const manager={id:'model-library',label:'Neural models',ui:{groupId:'graphics',tabLabel:'Graphics',management:'managed'},sections:[{id:'default',label:'Models',supportsDefault:true,defaultVersion:'rife',defaultSelections:[{id:'nr',label:'NR',version:'nr'},{id:'realcugan',label:'Real-CUGAN',version:'three'},{id:'rife',label:'RIFE',version:'rife'}],setupPresentation:{mode:'select',label:'Download',searchLabel:'Search model downloads'},setupActions:actions,catalog:{delivery:'local-files',versions:[],importable:true,importLabel:'Import model…',installable:false},installed:[{version:'nr',ready:true},{version:'two',ready:true},{version:'three',ready:true},{version:'rife',ready:true}]}]};
 const noNetwork=()=>assert.fail('Rendering must remain offline');const html=renderToStaticMarkup(React.createElement(RuntimesView,{runtimeManagers:[manager],runtimeUi:{},runtimeManagerId:manager.id,runtimeSectionId:'default',downloadTasks:[],downloadsOpen:false,setDownloadsOpen(){},setRuntimeManagerId(){},setRuntimeSectionId(){},updateRuntimeUiSection(){},onRuntimeRefresh:noNetwork,onRuntimeInstall:noNetwork,onRuntimeSetDefault(){},onRuntimeSetupAction(){},onRuntimeImport(){},onRuntimeUninstall(){},onCancelDownload(){},onOpenSource:noNetwork}));
 assert.equal((html.match(/class="runtimeSetup runtimeSetupSelector"/g)||[]).length,1);assert.equal((html.match(/>Download model…<\/button>/g)||[]).length,1);assert.equal((html.match(/>Default<\/span>/g)||[]).length,3);// Per-operation defaults are badges; one Default menu cannot hold them, so none is offered.
 assert.doesNotMatch(html,/>Set default<|runtimeDefaultSelect/);assert.match(html,/Automatic for Real-CUGAN/);assert.match(html,/Search model downloads/);assert.doesNotMatch(html,/class="runtimeSetupRow"/);
});
test('registered sources share installed/default state and partially default packages keep their default action',t=>{
 const Models=require('../src/modules/shared/reshade/neural/models'),Setup=require('../src/modules/shared/reshade/neural/setup'),manager=require('../src/modules/shared/reshade/runtime/neural-models-manager');
 const version=c=>'sha256-'+c.repeat(64),a=version('a'),b=version('b'),nr=version('c'),external='/Existing/NR.dlssmodel';
 const shared=id=>({version:id,versionLabel:id===a?'SR A':'SR B',operation:'mlx-sr-image',compatibleMethods:['mlx-sr-image','mlx-sr-scene'],ready:true});
 const managed=[shared(a),shared(b),{version:nr,operation:'mlx-dlss',ready:true}],registered={version:external,operation:'mlx-dlss',ready:true};
 t.mock.method(Models,'listManaged',()=>managed);t.mock.method(Models,'listInstalled',()=>[...managed,registered]);mockSources(t,[{version:'registered-source',label:'NR',description:'Original source',weightTerms:'Terms'}]);t.mock.method(Setup,'sourceInstalled',rows=>rows.find(row=>row.version===external));
 const previous={defaultVersion:nr,customDefaults:{default:external},defaultVersions:{'mlx-sr-image':a,'mlx-sr-scene':b}},state=manager.getState({settings:previous});
 assert.equal(state.setupActions[0].installed,true);assert.equal(state.defaultSelections.find(row=>row.id==='mlx-dlss').version,external);
 assert.deepEqual(state.defaultSelections.find(row=>row.id==='mlx-sr-scene').compatibleVersions,[a,b]);
 const render=section=>renderToStaticMarkup(React.createElement(RuntimesView,{runtimeManagers:[{id:manager.id,label:manager.label,ui:manager.ui,sections:[{...section,installed:managed.slice(0,2)}]}],runtimeManagerId:manager.id,runtimeSectionId:'default',runtimeUi:{},downloadTasks:[],downloadsOpen:false,setDownloadsOpen(){},setRuntimeManagerId(){},setRuntimeSectionId(){},updateRuntimeUiSection(){},onRuntimeRefresh(){},onRuntimeInstall(){},onRuntimeSetDefault(){},onRuntimeUninstall(){},onCancelDownload(){}}));
 const entries=markup=>(markup.match(/<div class="runtimeModelDefault">/g)||[]).length,defaultsOf=markup=>(markup.match(/<span class="badge badgeAccent">Default<\/span>/g)||[]).length;
 assert.equal(entries(render(state.sections[0])),4,'both packages list each compatible operation');
 const next=manager.updateSettingsAfterDefault(manager.applySettingsUpdate('setDefault',{version:a},previous),{version:a},{previousSettings:previous});assert.equal(next.defaultVersions['mlx-sr-image'],a);assert.equal(next.defaultVersions['mlx-sr-scene'],a);assert.equal(next.defaultVersions['mlx-dlss'],external);
 const updated=manager.getState({settings:next});assert.equal(defaultsOf(render(updated.sections[0])),2,'exactly one package is the default per compatible operation');
 assert.equal((render(updated.sections[0]).match(/>Make default<\/button>/g)||[]).length,2,'the other package offers Make default for both');
});
test('download source selection follows imports and removal without reviving a stale source or mislabeling another action',async()=>{
 const first={id:'a',label:'A',buttonLabel:'Download model…',available:true},second={id:'b',label:'B',buttonLabel:'Download model…',available:true},props={id:'source',actions:[first,second],label:'Download',busy:false,onAction(){assert.fail('Browsing must not acquire a model');}},h=componentHarness(RuntimeSetupSelector,props);
 const select=()=>elements(h.render()).find(n=>typeof n.type==='function'&&n.props.options),button=()=>elements(h.render()).find(n=>n.type==='button');
 try{
  select().props.onChange({target:{value:'b'}});assert.equal(select().props.value,'b');props.actions=[first,{...second,installed:true}];assert.equal(select().props.value,'b');assert.equal(button().props.children,'Installed');assert.equal(button().props.disabled,true);
  props.actions=[first];await h.settle();props.actions=[first,second];assert.equal(select().props.value,'a');
  props.busy=true;assert.equal(button().props.disabled,true);assert.equal(button().props.children,'Download model…');props.busy=false;assert.equal(button().props.disabled,false);
 }finally{h.close();}
});
test('operation grouping filters installed and downloadable models together and official XeSS links remain explicit',async t=>{
 const manager=require('../src/modules/shared/reshade/runtime/neural-models-manager'),Models=require('../src/modules/shared/reshade/neural/models'),Setup=require('../src/modules/shared/reshade/neural/setup');
 const rows=[{version:'nr',operation:'mlx-dlss',ready:true},{version:'sr',operation:'realcugan',ready:true},{version:'rife',operation:'rife',ready:true}];
 t.mock.method(Models,'listManaged',()=>rows);t.mock.method(Models,'listInstalled',()=>rows);mockSources(t,rows.map(row=>({...row,method:row.operation,files:[{}],label:row.version,description:'Original',weightTerms:'Terms'})));t.mock.method(Setup,'sourceInstalled',()=>null);
 const state=manager.getState({settings:{}});assert.equal(state.installed.find(row=>row.version==='sr').itemGroup,'upscaling');assert.equal(state.setupActions.find(row=>row.id==='downloadModel:rife').itemGroup,'generation');
 const props={runtimeManagers:[{...state,ui:manager.ui}],runtimeUi:{},runtimeManagerId:state.id,runtimeSectionId:'default',downloadTasks:[],downloadsOpen:false,setDownloadsOpen(){},setRuntimeManagerId(){},setRuntimeSectionId(){},updateRuntimeUiSection(){},onRuntimeRefresh(){},onRuntimeInstall(){},onRuntimeSetDefault(){},onRuntimeUninstall(){},onCancelDownload(){},onRuntimeSetupAction(){}};
 const h=componentHarness(RuntimesView,props);try{elements(h.render()).find(n=>n.props.id==='runtime-item-group').props.onChange({target:{value:'upscaling'}});const tree=h.render(),table=elements(tree).find(n=>n.props.actions&&n.props.installed&&n.props.onInstall);assert.deepEqual(table.props.actions.map(row=>row.id),['downloadModel:sr']);assert.deepEqual(table.props.installed.map(row=>row.version),['sr']);assert.match(renderToStaticMarkup(tree),/Image → upscaled image/);}finally{h.close();}
 const Xess=require('../src/modules/shared/reshade/xess');
 t.mock.method(Xess,'state',()=>({available:true,provider:{generation:false}}));
 // XeSS SDK versions come from Intel's own releases; a host without a compatible GPU compute host cannot install them.
 const xessManager=require('../src/modules/shared/reshade/runtime/xess-manager'),xess=xessManager.getState({});assert.ok(xess.catalog.sourceUrl.startsWith('https://github.com/intel/xess'));assert.doesNotMatch(String(xess.catalog.installReason||''),/GPU compute host/);
 t.mock.method(Xess,'state',()=>({available:false,reason:'GPU compute host unavailable'}));
 const unavailable=xessManager.getState({});assert.equal(unavailable.catalog.installable,false);assert.match(unavailable.catalog.installReason,/GPU compute host unavailable/);
 assert.ok(unavailable.sections.every(section=>section.catalog.installable===false));
});
// Owner, 11-17 7:24 PM: every row offers Make default; the table reads Default or Make default per operation.
test('model rows offer Make default per operation, forwarding the exact operation scope without changing another default',()=>{
 const defaults=[],a={version:'a',operation:'mlx-sr-image',compatibleMethods:['mlx-sr-image','mlx-sr-scene'],ready:true},b={...a,version:'b'},section={id:'default',setupPresentation:{mode:'table'},installed:[a,b],setupActions:[],catalog:{delivery:'local-files',versions:[],installable:false},defaultSelections:[{id:'mlx-sr-image',label:'DLSS SR image',version:'a',compatibleVersions:['a','b']},{id:'mlx-sr-scene',label:'DLSS SR scene',version:'b',compatibleVersions:['a','b']}]},manager={id:'models',label:'Models',ui:{groupId:'graphics',tabLabel:'Graphics'},sections:[section]},props={runtimeManagers:[manager],runtimeManagerId:'models',runtimeSectionId:'default',runtimeUi:{},downloadTasks:[],downloadsOpen:false,setDownloadsOpen(){},setRuntimeManagerId(){},setRuntimeSectionId(){},updateRuntimeUiSection(){},onRuntimeRefresh(){},onRuntimeInstall(){},onRuntimeSetDefault:(...args)=>defaults.push(args),onRuntimeUninstall(){},onCancelDownload(){}};
 const h=componentHarness(RuntimesView,props);try{const table=elements(h.render()).find(n=>n.props.onInstall&&n.props.onDefault&&n.props.installed),rows=componentHarness(table.type,table.props);
  try{const tree=rows.render(),markup=renderToStaticMarkup(tree);assert.doesNotMatch(markup,/type="radio"/);
   const buttons=elements(tree).filter(n=>n.type==='button'&&n.props.children==='Make default');
   assert.deepEqual(buttons.map(n=>n.props['aria-label']).sort(),['Make a the default for DLSS SR scene','Make b the default for DLSS SR image']);
   assert.equal((markup.match(/<div class="runtimeModelDefault"><span>DLSS SR (image|scene)<\/span><span class="badge badgeAccent">Default<\/span><\/div>/g)||[]).length,2,'each operation\'s default reads Default');
   buttons.find(n=>n.props['aria-label']==='Make a the default for DLSS SR scene').props.onClick();assert.deepEqual(defaults,[['models','default','a',undefined,'mlx-sr-scene']]);assert.equal(section.defaultSelections[0].version,'a');
  }finally{rows.close();}
 }finally{h.close();}
});
test('partial installed dependencies keep the normal completion action instead of an Installed dead end',async()=>{
 const RuntimeCatalogSources=await compile('RuntimeCatalogSources',true),installs=[],model={version:'pinned-sdk',ready:true,missingComponents:['interpolate']},section={id:'default',installed:[model],catalog:{versions:['pinned-sdk'],installable:true,versionRequirements:{'pinned-sdk':{available:false,requiresDownload:true,installLabel:'Complete install'}}}},props={managerId:'graphics-xess',section,ui:{installVersion:{},remoteOpen:{}},busy:false,variant:'',downloads:[],onSelect(){},onInstall:(...args)=>installs.push(args),onRefresh(){}};
 const h=componentHarness(RuntimeCatalogSources,props);try{let tree=h.render(),button=elements(tree).find(n=>n.type==='button'&&n.props.children==='Complete install');assert.ok(button);assert.equal(button.props.disabled,false);assert.match(renderToStaticMarkup(tree),/pinned-sdk · Download needed/);button.props.onClick();assert.deepEqual(installs,[['pinned-sdk',undefined]]);
  model.missingComponents=[];tree=h.render();assert.equal(elements(tree).some(n=>n.type==='button'&&n.props.className==='btn small primary'),false,'the version menu tags a complete install; no install button repeats it');assert.match(renderToStaticMarkup(tree),/pinned-sdk · Installed/);assert.doesNotMatch(renderToStaticMarkup(tree),/Download needed/);
 }finally{h.close();}
});
test('the model table names a model without a help button, sizes its columns and keeps its trash quiet (GUI 0877 R26)',()=>{
 const a={version:'a',operation:'mlx-sr-image',compatibleMethods:['mlx-sr-image'],ready:true,purpose:'Upscales images with a fixture model.'},section={id:'default',setupPresentation:{mode:'table'},installed:[a],setupActions:[],catalog:{delivery:'local-files',versions:[],installable:false},defaultSelections:[{id:'mlx-sr-image',label:'DLSS SR image',version:'a',compatibleVersions:['a']}]},manager={id:'models',label:'Models',ui:{groupId:'graphics',tabLabel:'Graphics'},sections:[section]},props={runtimeManagers:[manager],runtimeManagerId:'models',runtimeSectionId:'default',runtimeUi:{},downloadTasks:[],downloadsOpen:false,setDownloadsOpen(){},setRuntimeManagerId(){},setRuntimeSectionId(){},updateRuntimeUiSection(){},onRuntimeRefresh(){},onRuntimeInstall(){},onRuntimeSetDefault(){},onRuntimeUninstall(){},onCancelDownload(){}};
 const h=componentHarness(RuntimesView,props);try{const table=elements(h.render()).find(n=>n.props.onInstall&&n.props.onDefault&&n.props.installed),rows=componentHarness(table.type,table.props);
  try{const markup=renderToStaticMarkup(rows.render());
   assert.doesNotMatch(markup,/helpTipButton/,'a model\'s purpose is its name\'s tooltip, not a help button');
   assert.match(markup,/<td><span title="Upscales images with a fixture model\.">/);
   assert.match(markup,/class="btn small iconOnly danger"[^>]*aria-label="[^"]+"/,'the trash uses the muted icon colour of other installed rows');
  }finally{rows.close();}
 }finally{h.close();}
 const css=require('node:fs').readFileSync(path.join(__dirname,'../src/renderer/src/ui/styles.css'),'utf8');
 // GUI 0966 N3a/N3b: at the Runtimes window's default width (1100 px, 813 px of table) each column holds its widest
 // one-line content: the system font at the table's 12 px, measured with CoreText and matching the 0966 capture to
 // 0.1 px. Lead, 11-17 8:1x PM: the frame generators' label must not wrap either, so it reads "Frames → in-between frames"
 // (166 px) instead of "Two frames → intermediate frames" (197 px). Every input and output label the table can show,
 // for every operation and declared scale, has a measured width here and fits.
 const widths=['first-child','nth-child(2)','nth-child(3)','nth-child(4)','nth-child(5)'].map(n=>Number(new RegExp(`\\.runtimeModelTable th:${n.replace(/[()]/g,'\\$&')} \\{ width: (\\d+)%; \\}`).exec(css)?.[1]));
 assert.equal(widths.reduce((a,b)=>a+b,0),100,`column widths ${widths.join('/')} fill the table`);
 assert.equal(require('../src/core/utility-window-model.mjs').utilityWindowDefinition('runtimes').width,1100);
 assert.match(css,/\.filterLibraryTable th, \.filterLibraryTable td \{ padding: 8px 6px;/);
 assert.match(css,/\.filterLibraryTable th:first-child, \.filterLibraryTable td:first-child \{ padding-left: 0; \}/);
 assert.match(css,/\.filterLibraryTable th:last-child, \.filterLibraryTable td:last-child \{ padding-right: 0; \}/);
 const badge=37.81+8,makeDefault=72.97+2*8+2,install=33.49+2*8+2,gap=8;
 const content=[['Model: DLSSMac 0.1.6 · HT71 neural rendering model',257.89,6],['Input → output: Scene → upscaled image · 4×',167.06,12],
  ['Status: Not installed',71.2,12],['Default for: DLSS neural rendering + Default',126.99+gap+badge,12],['Default for: Real-ESRGAN + Make default',78.25+gap+makeDefault,12],
  ['Actions: Install',install,6]];
 const measured={'Image → same-size image':147.88,'Image → upscaled image':140.84,'Image → upscaled image · 1×':164.27,'Image → upscaled image · 2×':165.95,
  'Image → upscaled image · 3×':166.23,'Image → upscaled image · 4×':166.43,'Scene → upscaled image':141.47,'Scene → upscaled image · 1×':164.91,
  'Scene → upscaled image · 2×':166.58,'Scene → upscaled image · 3×':166.86,'Scene → upscaled image · 4×':167.06,'Frames → in-between frames':165.73,
  'Image → relative depth':129.76};
 const {MODEL_OPERATIONS}=require('../src/modules/shared/effects/operation-contracts.mjs'),{modelPresentation}=require('../src/modules/shared/effects/presentation.mjs');
 const declared=require('node:fs').readFileSync(path.join(__dirname,'../src/modules/shared/reshade/neural/model-source.json'),'utf8');
 const scales=new Set([...declared.matchAll(/"intrinsicScale": *(\d+)/g)].map(match=>Number(match[1])));
 for(const operation of Object.values(MODEL_OPERATIONS))for(const scale of operation.scales||[])scales.add(scale);
 for(const id of Object.keys(MODEL_OPERATIONS))for(const scale of [undefined,...scales]){
  const label=modelPresentation(id,scale).inputOutputLabel;
  assert.ok(Object.hasOwn(measured,label),`"${label}" has a measured width`);
  content.push([`Input → output: ${label}`,measured[label],12]);
 }
 for(const [label,width,padding] of content){const column=['Model','Input','Status','Default','Actions'].findIndex(name=>label.startsWith(name)),box=widths[column]/100*813-padding;
  assert.ok(box>=width,`${label} (${width.toFixed(1)} px) fits its ${widths[column]}% column (${box.toFixed(1)} px)`);}
 // The library tables keep their header visible and the Actions heading over its buttons (GUI 0877 R26, S8).
 assert.match(css,/\.filterLibraryTable thead th \{ position: sticky;/);
 assert.match(css,/\.filterLibraryTable th:last-child \{ text-align: right; \}/);
 assert.match(css,/\.filterLibraryScroll \{ min-width: 0; overflow-x: clip; overflow-y: visible; \}/);
});

// GUI 0945 R26b: the Operation menu stretched across the pane under its own label column, unlike the Version row below it.
// R31: a Default for choice sat above the row's baseline, aligned by its radio. S11: the sticky header stopped at the
// view's top padding, so rows scrolled through the gap above it.
test('the Operation menu reads as the Version row, Default choices share the row baseline and the header meets the view top (GUI 0945 R26b, R31, S11)',()=>{
 const {computedValue}=require('./helpers/css-cascade.cjs'),css=require('node:fs').readFileSync(path.join(__dirname,'../src/renderer/src/ui/styles.css'),'utf8');
 const a={version:'a',operation:'mlx-sr-image',compatibleMethods:['mlx-sr-image'],ready:true,itemGroup:'upscaling'};
 const section={id:'default',setupPresentation:{mode:'table'},installed:[a],setupActions:[],itemGroups:[{id:'upscaling',label:'Upscaling',operations:['mlx-sr-image']}],
  catalog:{delivery:'local-files',versions:[],installable:false},defaultSelections:[{id:'mlx-sr-image',label:'DLSS SR image',version:'a',compatibleVersions:['a']}]};
 const manager={id:'models',label:'Models',ui:{groupId:'graphics',tabLabel:'Graphics'},sections:[section]};
 const markup=renderToStaticMarkup(React.createElement(RuntimesView,{runtimeManagers:[manager],runtimeManagerId:'models',runtimeSectionId:'default',runtimeUi:{},downloadTasks:[],downloadsOpen:false,
  setDownloadsOpen(){},setRuntimeManagerId(){},setRuntimeSectionId(){},updateRuntimeUiSection(){},onRuntimeRefresh(){},onRuntimeInstall(){},onRuntimeSetDefault(){},onRuntimeUninstall(){},onCancelDownload(){}}));
 assert.match(markup,/<div class="runtimeSourceRow runtimeItemGroupRow"><label for="runtime-item-group" class="runtimeSourceName">Operation<\/label><select id="runtime-item-group" class="input inputSmall runtimeVersionSelect runtimeItemGroup"/);
 const row=[{tag:'div',classes:['runtimeSectionBody']},{tag:'div',classes:['runtimeSourceRow','runtimeItemGroupRow']}],menu=[...row,{tag:'select',classes:['input','inputSmall','runtimeVersionSelect','runtimeItemGroup'],id:'runtime-item-group'}];
 assert.equal(computedValue(css,row,'display')?.value,'flex','the menu keeps its own width instead of filling a grid cell');
 assert.equal(computedValue(css,menu,'width')?.value,'auto');
 const choice=[{tag:'table',classes:['filterLibraryTable','runtimeModelTable']},{tag:'tbody'},{tag:'tr'},{tag:'td'},{tag:'div',classes:['runtimeModelDefault']}];
 assert.equal(computedValue(css,choice,'align-items')?.value,'baseline','the choice\'s text gives the cell its baseline');
 assert.equal(computedValue(css,choice,'flex-wrap')?.value,'wrap','a narrow column keeps the button below its operation');
 for(const [body,padding] of [[['launcherViewBody','runtimeViewBody'],'12px'],[['launcherViewBody','settingsViewBody'],'16px']]){
  const view={tag:'div',classes:body};
  assert.equal(computedValue(css,[view],'--view-padding-top')?.value,padding,body.join(' '));
  assert.equal(computedValue(css,[view],'padding-top')?.value,'var(--view-padding-top)',body.join(' '));
  const heading=[view,{tag:'div',classes:['filterLibraryScroll']},{tag:'table',classes:['filterLibraryTable']},{tag:'thead'},{tag:'tr'},{tag:'th'}];
  assert.equal(computedValue(css,heading,'top')?.value,'calc(-1 * var(--view-padding-top, 0px))','the header row sticks at the view\'s top edge');
 }
});
