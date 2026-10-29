const assert=require('node:assert/strict'),path=require('node:path'),test=require('node:test'),Module=require('node:module');
const {build}=require('vite'),{react,componentHarness}=require('./helpers/renderer-component');
let ImplementationPicker,matchingImplementations;
test.before(async()=>{const result=await build({configFile:false,logLevel:'silent',build:{ssr:path.join(__dirname,'../src/renderer/src/ui/components/ImplementationPicker.tsx'),write:false,
  rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs'}}}});
  const compiled=new Module(path.join(__dirname,'implementation-picker.cjs'),module);compiled.paths=module.paths;compiled.require=id=>id==='react'?react:Module.prototype.require.call(compiled,id);
  compiled._compile(result.output.find(row=>row.type==='chunk').code,compiled.id);({ImplementationPicker,matchingImplementations}=compiled.exports);});
const options=[{value:'off',label:'Off'},{value:'warm',label:'Warm tint',keywords:'Colour grade'},{value:'cool',label:'Cool tint'},{value:'blocked',label:'Unavailable tint',disabled:true},{value:'__manage',label:'Manage filters…'}];
function nodes(value){if(!value||typeof value!=='object')return[];return[value,...[value.props?.children].flat(Infinity).flatMap(nodes)];}
test('filter search combines terms and matches names, accents and declared keywords',()=>{
  assert.deepEqual(matchingImplementations(options,'tint GRÁDE').map(row=>row.value),['warm']);
  assert.deepEqual(matchingImplementations(options,'cool').map(row=>row.value),['cool']);
  assert.deepEqual(matchingImplementations(options,'nothing'),[]);
});
test('closed large shader choosers mount no option rows and reopen with the full searchable library',t=>{
  const previous={window:global.window,document:global.document};t.after(()=>Object.assign(global,previous));
  global.window={addEventListener(){},removeEventListener(){}};global.document={addEventListener(){},removeEventListener(){}};
  const library=Array.from({length:2000},(_,i)=>({value:String(i),label:`Filter ${i}`,keywords:'Slang'})),h=componentHarness(ImplementationPicker,
    {id:'library',value:'1',options:library,label:'Image filter',onChange(){}});
  try {
    let tree=h.render();assert.equal(nodes(tree).filter(row=>row.props?.role==='option').length,0);
    nodes(tree).find(row=>row.props?.popover==='auto').props.onToggle({newState:'open'});
    tree=h.render();assert.equal(nodes(tree).filter(row=>row.props?.role==='option').length,library.length);
    const input=nodes(tree).find(row=>row.type==='input');input.props.onChange({target:{value:'Slang 1999'}});
    assert.deepEqual(nodes(h.render()).filter(row=>row.props?.role==='option').map(row=>row.props['data-picker-value']),['1999']);
    library[1999].label='Renamed source';assert.deepEqual(matchingImplementations(library,'Slang 1999'),[]);
    assert.equal(matchingImplementations(library,'renamed')[0],library[1999]);
    nodes(h.render()).find(row=>row.props?.popover==='auto').props.onToggle({newState:'closed'});
    assert.equal(nodes(h.render()).filter(row=>row.props?.role==='option').length,0);
  } finally {h.close();}
});
test('small method lists retain a native select and the same accessible name',()=>{
  const changes=[],h=componentHarness(ImplementationPicker,{id:'resize',value:'warm',options,label:'Downsample',onChange:event=>changes.push(event.target.value)});
  const select=h.render();assert.equal(select.type,'select');assert.equal(select.props['aria-label'],'Downsample');
  select.props.onChange({target:{value:'cool'}});assert.deepEqual(changes,['cool']);h.close();
});
test('search keyboard skips disabled choices, selects with Enter and restores focus; Escape keeps selection',t=>{
  const previous={window:global.window,document:global.document,CSS:global.CSS,innerWidth:global.innerWidth,innerHeight:global.innerHeight};let h;t.after(()=>{h?.close();Object.assign(global,previous);});
  global.window={addEventListener(){},removeEventListener(){}};global.document={addEventListener(){},removeEventListener(){}};global.CSS={escape:value=>value};
  let visible=false,focused=0,searched=0;const changes=[];
  h=componentHarness(ImplementationPicker,{id:'image',value:'warm',options,label:'Image filter',searchable:true,onChange:event=>changes.push(event.target.value)});
  let tree=h.render(),all=nodes(tree),trigger=all.find(row=>row.type==='button'&&row.props.role==='combobox'),panel=all.find(row=>row.props?.popover==='auto'),input=all.find(row=>row.type==='input');
  trigger.props.ref.current={focus(){focused++;},getBoundingClientRect(){return{bottom:100,top:70,left:20,width:240};}};
  panel.props.ref.current={style:{},matches(){return visible;},showPopover(){visible=true;},hidePopover(){visible=false;},getBoundingClientRect(){return{width:320,height:200};},querySelector(){return null;}};
  input.props.ref.current={focus(){searched++;}};global.innerWidth=1200;global.innerHeight=800;
  const key=(key)=>({key,preventDefault(){},stopPropagation(){}});
  trigger.props.onKeyDown(key('ArrowDown'));assert.equal(visible,true);assert.equal(searched,1);
  panel.props.onToggle({newState:'open'});tree=h.render();all=nodes(tree);input=all.find(row=>row.type==='input');
  input.props.onChange({target:{value:'tint'}});tree=h.render();input=nodes(tree).find(row=>row.type==='input');
  input.props.onKeyDown(key('ArrowDown'));tree=h.render();input=nodes(tree).find(row=>row.type==='input');
  input.props.onKeyDown(key('Enter'));assert.deepEqual(changes,['cool']);assert.equal(visible,false);assert.equal(focused,1);
  panel=nodes(tree).find(row=>row.props?.popover==='auto');panel.props.onKeyDown(key('Escape'));assert.deepEqual(changes,['cool']);assert.equal(focused,2);
  trigger.props.onKeyDown(key('ArrowDown'));tree=h.render();input=nodes(tree).find(row=>row.type==='input');
  input.props.onKeyDown(key('Enter'));assert.deepEqual(changes,['cool'],'reselecting the current choice does not save or rebuild it');assert.equal(focused,3);
});
test('shared picker closes on a second trigger click after native dismissal and keeps group context and actions in empty searches',t=>{
 const previous={window:global.window,document:global.document,CSS:global.CSS,innerWidth:global.innerWidth,innerHeight:global.innerHeight};
 t.after(()=>Object.assign(global,previous));Object.assign(global,{window:{addEventListener(){},removeEventListener(){}},document:{addEventListener(){},removeEventListener(){}},CSS:{escape:v=>v},innerWidth:1200,innerHeight:800});
 const grouped=[{value:'bilinear',label:'Bilinear',group:'Simple algorithms'},{value:'mfx',label:'MetalFX temporal',group:'Neural'},
  {value:'manual',label:'Import custom…',action:true},{value:'__manage',label:'Manage filters…'}],h=componentHarness(ImplementationPicker,{id:'shared',value:'bilinear',options:grouped,label:'Method',searchable:true,onChange(){}});
 try{let tree=h.render(),trigger=nodes(tree).find(n=>n.props.role==='combobox'&&n.type==='button'),panel=nodes(tree).find(n=>n.props.popover==='auto'),visible=false;
  trigger.props.ref.current={getBoundingClientRect(){return{bottom:100,top:70,left:20,width:240};}};
  panel.props.ref.current={style:{},matches(){return visible;},showPopover(){visible=true;},hidePopover(){visible=false;},getBoundingClientRect(){return{width:320,height:200};},querySelector(){return null;}};
  nodes(tree).find(n=>n.type==='input').props.ref.current={focus(){}};
  trigger.props.onPointerDown();trigger.props.onClick({preventDefault(){}});assert.equal(visible,true);
  tree=h.render();let input=nodes(tree).find(n=>n.type==='input');input.props.onChange({target:{value:'metalfx'}});tree=h.render();
  assert.deepEqual(nodes(tree).filter(n=>n.props.className==='implementationGroup').map(n=>n.props.children),['Neural']);
  nodes(tree).find(n=>n.type==='input').props.onChange({target:{value:'no match'}});tree=h.render();
  assert.equal(nodes(tree).filter(n=>n.props.role==='option').length,0);for(const label of ['Import custom…','Manage filters…'])assert.ok(nodes(tree).some(n=>n.type==='button'&&n.props.children===label));
  trigger=nodes(tree).find(n=>n.type==='button'&&n.props.role==='combobox');trigger.props.onPointerDown();visible=false;trigger.props.onClick({preventDefault(){}});
  assert.equal(visible,false);assert.equal(nodes(h.render()).find(n=>n.type==='button'&&n.props.role==='combobox').props['aria-expanded'],false);
 }finally{h.close();}
});
test('a shown More option joins its group, so each heading is listed once as in the native select',t=>{
 const previous={window:global.window,document:global.document};t.after(()=>Object.assign(global,previous));
 global.window={addEventListener(){},removeEventListener(){}};global.document={addEventListener(){},removeEventListener(){}};
 const options=[{value:'metalfx',label:'MetalFX',group:'Recommended'},{value:'lanczos',label:'Lanczos',group:'Simple algorithms'},
  {value:'xbr',label:'xBR',group:'Native algorithms'},{value:'hermite',label:'Hermite',group:'Simple algorithms',more:true}];
 const listed=tree=>nodes(tree).filter(n=>n.props?.role==='option').map(n=>n.props['data-picker-value']);
 const headings=tree=>nodes(tree).filter(n=>n.props?.className==='implementationGroup').map(n=>n.props.children);
 // A selected More option is shown without expanding; otherwise More reveals it.
 for(const value of ['hermite','metalfx']){
  const h=componentHarness(ImplementationPicker,{id:'merged',value,options,label:'Upscale',searchable:true,onChange(){}});
  try{nodes(h.render()).find(n=>n.props?.popover==='auto').props.onToggle({newState:'open'});
   let tree=h.render();
   if(value==='metalfx'){assert.deepEqual(listed(tree),['metalfx','lanczos','xbr']);nodes(tree).find(n=>n.props?.className==='implementationMore').props.onClick();tree=h.render();}
   assert.deepEqual(listed(tree),['metalfx','lanczos','hermite','xbr']);
   assert.deepEqual(headings(tree),['Recommended','Simple algorithms','Native algorithms']);
  }finally{h.close();}
 }
});
test('specialised options stay behind More until chosen or searched, and the selected one is always listed',t=>{
 const previous={window:global.window,document:global.document};t.after(()=>Object.assign(global,previous));
 global.window={addEventListener(){},removeEventListener(){}};global.document={addEventListener(){},removeEventListener(){}};
 const tiered=[{value:'metalfx',label:'MetalFX',group:'Recommended'},{value:'lanczos',label:'Lanczos',group:'Simple algorithms'},
  {value:'robidoux',label:'Robidoux',group:'Simple algorithms',more:true},{value:'hermite',label:'Hermite',group:'Simple algorithms',more:true},{value:'__manage',label:'Manage filters…'}];
 const listed=tree=>nodes(tree).filter(n=>n.props?.role==='option').map(n=>n.props['data-picker-value']),more=tree=>nodes(tree).find(n=>n.props?.className==='implementationMore');
 for(const [value,expected] of [['metalfx',['metalfx','lanczos']],['hermite',['metalfx','lanczos','hermite']]]){
  const h=componentHarness(ImplementationPicker,{id:'tiered',value,options:tiered,label:'Upscale',searchable:true,onChange(){}});
  try{nodes(h.render()).find(n=>n.props?.popover==='auto').props.onToggle({newState:'open'});
   let tree=h.render();assert.deepEqual(listed(tree),expected);assert.equal(more(tree).props.children.join(''),`More (${4-expected.length})…`);
   nodes(tree).find(n=>n.type==='input').props.onChange({target:{value:'robi'}});tree=h.render();assert.deepEqual(listed(tree),['robidoux']);assert.equal(more(tree),undefined);
   nodes(tree).find(n=>n.type==='input').props.onChange({target:{value:''}});tree=h.render();
   more(tree).props.onClick();tree=h.render();assert.deepEqual(listed(tree),['metalfx','lanczos','robidoux','hermite']);assert.equal(more(tree),undefined);
  }finally{h.close();}
 }
});
