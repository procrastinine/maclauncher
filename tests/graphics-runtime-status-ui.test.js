const assert=require('node:assert/strict'),path=require('node:path'),test=require('node:test'),Module=require('node:module');
const {renderToStaticMarkup}=require('react-dom/server'),{build}=require('vite'),{react,componentHarness}=require('./helpers/renderer-component');
let GraphicsRuntimeStatus;
test.before(async()=>{const result=await build({configFile:false,logLevel:'silent',build:{ssr:path.join(__dirname,'../src/renderer/src/ui/components/GraphicsRuntimeStatus.tsx'),write:false,rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs'}}}});const compiled=new Module(path.join(__dirname,'graphics-status.cjs'),module);compiled.paths=module.paths;compiled.require=id=>id==='react'?react:Module.prototype.require.call(compiled,id);compiled._compile(result.output.find(row=>row.type==='chunk').code,compiled.id);GraphicsRuntimeStatus=compiled.exports.GraphicsRuntimeStatus;});
const neural={id:'neural',kind:'neural',method:'mlx-dlss',enabled:true,settings:{modelPath:'/Models/One.dlssmodel'}};
const shader={id:'shader',kind:'shader',enabled:true,shader:{enabled:true,preset:'crt'}};
const size={width:640,height:360};
function observation(stages=[{id:'neural',completed:1,phase:'completed'}],identityState='matching'){
 return{state:'observed',contexts:[{id:'frame',pid:42,identityState,historical:false,phase:'completed',input:size,output:size,encoded:1,completed:1,presentedReal:0,presentedGenerated:0,presentedTime:0,stages:stages.map(row=>({input:size,output:size,requestedMethod:row.id==='neural'?'mlx-dlss':'crt',activeMethod:row.id==='neural'?'mlx-dlss':'crt',...row}))}]};
}
function fixture(t){
 const previous={window:global.window,document:global.document};let harness;const timers=new Map(),replies=[],reported=[];let serial=0,reads=0;
 t.after(()=>{harness?.close();Object.assign(global,previous);});
 t.mock.method(global,'setTimeout',(run,delay)=>{timers.set(++serial,{run,delay});return serial;});t.mock.method(global,'clearTimeout',id=>timers.delete(id));
 global.document={visibilityState:'visible'};global.window={MacLauncher:{launcher:{getGameGraphicsStatus:()=>{reads++;return new Promise(resolve=>replies.push(resolve));}}}};
 const props={game:{gamePath:'/Game',effects:{schema:2,mode:'advanced',enabled:true,video:[structuredClone(neural)]}},running:true,visible:true,live:true,onStatus:status=>reported.push(status)};
 harness=componentHarness(GraphicsRuntimeStatus,props);
 return{harness,props,timers,replies,reported,reads:()=>reads,markup:()=>renderToStaticMarkup(harness.render()),tick(){const [id,timer]=timers.entries().next().value||[];assert.ok(timer,'No status observation scheduled');assert.equal(timer.delay,2000);timers.delete(id);timer.run();}};
}
test('automatic current-chain observations never create a blocking UI and stop after exact completion',async t=>{
 const f=fixture(t);f.harness.render();assert.equal(f.reads(),1);assert.doesNotMatch(f.markup(),/aria-busy|Waiting for the first/);
 f.replies.shift()(observation(undefined,'previous'));await f.harness.settle();assert.equal(f.timers.size,1);
 f.tick();f.replies.shift()(observation([{id:'shader',phase:'completed',completed:4}]));await f.harness.settle();assert.equal(f.timers.size,1);
 f.tick();f.replies.shift()(observation([{id:'neural',phase:'encoded',completed:0}]));await f.harness.settle();assert.equal(f.timers.size,1);
 f.tick();f.replies.shift()(observation());await f.harness.settle();assert.equal(f.timers.size,0);assert.equal(f.reads(),4);
 f.props.game={...f.props.game};f.harness.render();assert.equal(f.reads(),4,'unchanged library broadcasts do not restart observation');
});
test('comparison-only output observes current GPU completion and Off still stops reads',async t=>{
 const f=fixture(t);f.props.game.effects={schema:2,mode:'advanced',enabled:true,video:[],output:{comparison:{mode:'wipe',position:.5,gain:1}}};
 f.harness.render();assert.equal(f.reads(),1);f.replies.shift()(observation([]));await f.harness.settle();assert.equal(f.timers.size,0);assert.equal(f.reported.at(-1).state,'observed');
 f.props.game.effects={...f.props.game.effects,enabled:false};assert.equal(f.harness.render(),null);assert.equal(f.reported.at(-1),null);assert.equal(f.reads(),1);
});
test('tone mapping only observes completed output and retains nonfatal fallback reasons',async t=>{
 const f=fixture(t);f.props.game.effects={schema:2,mode:'advanced',enabled:true,video:[],output:{toneMapping:'pbr-neutral'}};
 f.harness.render();assert.equal(f.reads(),1);const reason='PBR Neutral requires declared scene-referred source metadata; Automatic applied.';
 f.replies.shift()({state:'prepared',contexts:[],preparation:{output:{pending:[{id:'tone-mapping',reason:'Output tone mapping requires an updated graphics runtime.'}]}}});await f.harness.settle();assert.match(f.markup(),/Output: Pending. Output tone mapping requires an updated graphics runtime/);f.tick();
 f.replies.shift()(observation([{id:'output-color',requestedMethod:'pbr-neutral',activeMethod:'reinhard',phase:'completed',completed:1,reason}]));await f.harness.settle();assert.equal(f.timers.size,0);assert.match(f.markup(),/pbr-neutral → reinhard: Completed/);assert.ok(f.markup().includes(reason));
 f.props.game.effects={...f.props.game.effects,enabled:false};assert.equal(f.harness.render(),null);assert.equal(f.reported.at(-1),null);assert.equal(f.reads(),2);
});
test('all requested stages must settle in one matching current context',async t=>{
 const f=fixture(t);f.props.game.effects.video.push(shader);f.harness.render();const split=observation();split.contexts.push({...observation([{id:'shader',phase:'completed',completed:1}]).contexts[0],id:'different-source'});
 f.replies.shift()(split);await f.harness.settle();assert.equal(f.timers.size,1,'split-context receipts cannot end observation');
 f.tick();f.replies.shift()(observation([{id:'neural',phase:'completed',completed:1},{id:'shader',phase:'completed',completed:1}]));await f.harness.settle();assert.equal(f.timers.size,0);
});
test('Off, Stop and replaced selections reject late responses',async t=>{
 const f=fixture(t);f.harness.render();const older=f.replies.shift();f.props.game.effects={...f.props.game.effects,video:[{...neural,settings:{modelPath:'/Models/Two.dlssmodel'}}]};f.harness.render();const current=f.replies.shift(),reported=f.reported.length;
 older(observation());await f.harness.settle();assert.equal(f.reported.length,reported);
 f.props.game.effects={...f.props.game.effects,enabled:false};assert.equal(f.harness.render(),null);current(observation());await f.harness.settle();assert.equal(f.reported.at(-1),null);assert.equal(f.timers.size,0);
 f.props.game.effects={...f.props.game.effects,enabled:true};f.harness.render();const stopped=f.replies.shift();f.props.running=false;assert.equal(f.harness.render(),null);stopped(observation());await f.harness.settle();assert.equal(f.reported.at(-1),null);assert.equal(f.timers.size,0);
});
test('late automatic results past the bounded observation deadline are ignored',async t=>{
 const f=fixture(t);let now=1000;t.mock.method(Date,'now',()=>now);f.harness.render();now+=120001;f.replies.shift()(observation());await f.harness.settle();assert.equal(f.reported.filter(Boolean).length,0);assert.equal(f.timers.size,0);assert.doesNotMatch(f.markup(),/aria-busy/);
});
test('hidden, stopped and nonlive collapsed views do not query; closing the inspector rejects pending details',async t=>{
 const f=fixture(t);f.props.visible=false;f.harness.render();assert.equal(f.reads(),0);f.props.visible=true;f.props.live=false;f.harness.render();assert.equal(f.reads(),0);
 f.harness.render().props.children.find(child=>child?.type==='details').props.onToggle({currentTarget:{open:true}});f.harness.render();assert.equal(f.reads(),1);f.props.visible=false;f.harness.render();const before=f.reported.length;f.replies.shift()(observation());await f.harness.settle();assert.equal(f.reported.length,before);assert.equal(f.timers.size,0);
});
test('current row fallback settles observation while retaining its reason',async t=>{
 const f=fixture(t);f.harness.render();const next=observation([{id:'neural',activeMethod:'passthrough',phase:'bypassed',completed:0,reason:'Model unavailable'}]);f.replies.shift()(next);await f.harness.settle();assert.equal(f.timers.size,0);assert.match(f.markup(),/mlx-dlss → passthrough: Bypassed.*Model unavailable/);
});

test('native preparation remains pending despite cached completion counts',async t=>{
 const f=fixture(t);f.harness.render();const next=observation([{id:'neural',activeMethod:'mlx-dlss',phase:'preparing',completed:3}]);
 next.state='preparing';next.contexts[0].phase='preparing';f.replies.shift()(next);await f.harness.settle();
 assert.match(f.markup(),/Selected · Preparing…/);assert.doesNotMatch(f.markup(),/Selected · Completed processing reported/);
 assert.equal(f.timers.size,1,'a previous completion cannot settle candidate observation');
});
test('unverified or historical completions do not settle; exact cached completion does',async t=>{
 const f=fixture(t);f.harness.render();const cached=()=>observation([{id:'neural',activeMethod:'mlx-dlss-cache',phase:'encoded',completed:3}]);const unverified=cached();unverified.contexts[0].identityState='unverified';f.replies.shift()(unverified);await f.harness.settle();assert.equal(f.timers.size,1);
 f.tick();const historical=cached();historical.contexts[0].historical=true;f.replies.shift()(historical);await f.harness.settle();assert.equal(f.timers.size,1);
 f.tick();f.replies.shift()(cached());await f.harness.settle();assert.equal(f.timers.size,0);assert.match(f.markup(),/mlx-dlss → mlx-dlss-cache: Encoded/);
});
test('prepared, retained and source details remain separate from current completion',async t=>{
 const f=fixture(t);f.harness.render();const next={state:'prepared',preparation:{pending:[{id:'neural',method:'mlx-dlss',reason:'A model is not bound.',retained:true}],skipped:[{id:'old',reason:'Earlier model unavailable.'}]},contexts:[]};f.replies.shift()(next);await f.harness.settle();let markup=f.markup();assert.match(markup,/Settings prepared/);assert.match(markup,/previous setting is retained/);assert.match(markup,/Last preparation · old/);assert.doesNotMatch(markup,/Completed processing has been reported/);
 f.tick();const previous=observation(undefined,'previous');previous.contexts[0].frameSource={source:'decoded-video',inputs:[],observedAt:1};f.replies.shift()(previous);await f.harness.settle();markup=f.markup();assert.match(markup,/Source: Decoded video/);assert.match(markup,/Previous settings/);assert.match(markup,/Presented 0 real \/ 0 generated/);assert.match(markup,/Presentation has not been reported/);assert.equal(f.timers.size,1);
});
test('collapsed status separates requested selection from matching completion and never borrows the previous selection',async t=>{
 const f=fixture(t);f.harness.render();assert.match(f.markup(),/Selected · Current settings not yet confirmed/);
 f.replies.shift()(observation(undefined,'previous'));await f.harness.settle();assert.match(f.markup(),/Selected · Current settings not yet confirmed/);assert.doesNotMatch(f.markup(),/Selected · Completed processing reported/);
 f.tick();f.replies.shift()(observation());await f.harness.settle();assert.match(f.markup(),/Selected · Completed processing reported/);
 f.props.game={...f.props.game,effects:{...f.props.game.effects,video:[{...neural,settings:{modelPath:'/Models/Changed.dlssmodel'}}]}};
 assert.match(f.markup(),/Selected · Current settings not yet confirmed/);assert.doesNotMatch(f.markup(),/Selected · Completed processing reported/);
});
test('explicit matching failure stays visible with a repair route without treating missing or old reports as failure',async t=>{
 const f=fixture(t);f.harness.render();const failed=observation();failed.state='failed';failed.reason='The GPU command timed out.';failed.contexts[0].phase='failed';failed.contexts[0].historical=true;
 f.replies.shift()(failed);await f.harness.settle();assert.match(f.markup(),/Selected · Processing failed/);assert.match(f.markup(),/off and on to retry/);assert.match(f.markup(),/The GPU command timed out/);assert.equal(f.timers.size,0);
 f.props.requestKey='new request';f.harness.render();f.replies.shift()({state:'historical',contexts:[{...failed.contexts[0],phase:'completed',historical:true}]});await f.harness.settle();assert.match(f.markup(),/Selected · No recent processing confirmation/);assert.doesNotMatch(f.markup(),/Selected · Processing failed|off and on to retry/);
 f.tick();f.replies.shift()({state:'unavailable',contexts:[]});await f.harness.settle();assert.match(f.markup(),/Selected · Status unavailable/);assert.doesNotMatch(f.markup(),/Selected · Processing failed/);
});
