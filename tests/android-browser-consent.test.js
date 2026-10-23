const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {confirmGameLink}=require('../src/modules/android/browser-consent');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-browser-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const executablePath=path.join(directory,'game');fs.writeFileSync(executablePath,'owned');
 return {child:Object.assign(new EventEmitter(),{pid:123,exitCode:null,signalCode:null}),options:{executablePath,launchedAt:1700000000000,title:'Game',url:'https://example.invalid/open',platform:'darwin'}};
}
function execute(script,request,{missing=false,foreign=false,response=1000,otherFront=false,exited=false}={}){
 const state={prompts:0,activations:[],point:null},buttons=[];
 const game={isNil:()=>false,get terminated(){return state.prompts>0&&exited;},executableURL:{isNil:()=>false,URLByResolvingSymlinksInPath:{path:'/owned'}},
  launchDate:{isNil:()=>false,timeIntervalSince1970:1700000000},activateWithOptions:()=>state.activations.push('game')};
 const panel={frame:{size:{width:400,height:200}},setFrameOrigin:p=>state.point=p};
 const screen={frame:{origin:{x:0,y:0},size:{width:1920,height:1080}},visibleFrame:{origin:{x:0,y:40},size:{width:1920,height:1000}}};
 const globals={ObjC:{import:()=>{},unwrap:v=>v,deepUnwrap:v=>v,castRefToObject:v=>v},$:{
  NSRunningApplication:{runningApplicationWithProcessIdentifier:pid=>{assert.equal(pid,123);return game;}},
  NSFileManager:{defaultManager:{attributesOfItemAtPathError:()=>({isNil:()=>false,objectForKey:key=>({stringValue:foreign?'foreign':request[key]})})}},
  NSFileSystemNumber:'device',NSFileSystemFileNumber:'inode',
  CGWindowListCopyWindowInfo:()=>missing?[]:[{kCGWindowOwnerPID:123,kCGWindowLayer:0,kCGWindowAlpha:1,kCGWindowBounds:{X:100,Y:200,Width:800,Height:600}}],
  kCGWindowListOptionOnScreenOnly:1,kCGWindowListExcludeDesktopElements:16,kCGNullWindowID:0,
  NSApplication:{sharedApplication:{setActivationPolicy:()=>{},activateIgnoringOtherApps:()=>state.activations.push('helper')}},
  NSApplicationActivationPolicyAccessory:1,NSApplicationActivateAllWindows:1,NSApplicationActivateIgnoringOtherApps:2,
  NSAlert:{alloc:{init:{addButtonWithTitle:title=>buttons.push({title}),buttons:{objectAtIndex:i=>buttons[i]},window:panel,
   get runModal(){state.prompts++;return response;}}}},NSAlertSecondButtonReturn:1001,
  NSScreen:{screens:{count:1,objectAtIndex:()=>screen}},NSMakePoint:(x,y)=>({x,y}),
  NSWorkspace:{sharedWorkspace:{frontmostApplication:{isNil:()=>false,processIdentifier:otherFront?999:456}}},
  NSProcessInfo:{processInfo:{processIdentifier:456}}
 }};
 vm.createContext(globals);vm.runInContext(script,globals);const result=globals.run([JSON.stringify(request)]);
 return {result,state,buttons};
}
test('Browser approval belongs to trusted UI anchored to the requesting game, with Cancel as default',async t=>{
 const {child,options}=fixture(t);let call;
 assert.equal(await confirmGameLink(child,{...options,run:async(...args)=>{call=args;return {stdout:'open\n'};}}),true);
 assert.equal(call[0],'/usr/bin/osascript');assert.deepEqual(call[1].slice(0,3),['-l','JavaScript','-e']);assert.equal(call[2].timeout,120000);
 const request=JSON.parse(call[1][4]);assert.equal(request.pid,child.pid);assert.equal(request.url,options.url);
 const result=execute(call[1][3],request,{response:1001});
 assert.equal(result.result,'open');assert.deepEqual(result.state.point,{x:300,y:480});
 assert.deepEqual(result.buttons.map(b=>b.title),['Cancel','Open Browser']);assert.equal(result.buttons[0].keyEquivalent,'\r');assert.equal(result.buttons[1].keyEquivalent,'');
 assert.deepEqual(result.state.activations,['game','helper','game']);
 for(const mode of [{missing:true},{foreign:true}]){const denied=execute(call[1][3],request,mode);assert.equal(denied.result,'cancel');assert.equal(denied.state.prompts,0);}
 for(const mode of [{},{exited:true,response:1001}])assert.equal(execute(call[1][3],request,mode).result,'cancel');
 assert.deepEqual(execute(call[1][3],request,{otherFront:true}).state.activations,['game','helper']);
 assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('close'),0);
});
test('Closing the game cancels its trusted browser prompt; failures cannot approve a link',async t=>{
 const {child,options}=fixture(t);let invocation;
 const pending=confirmGameLink(child,{...options,run:(_cmd,_args,value)=>new Promise((_resolve,reject)=>{invocation=value;value.signal.addEventListener('abort',()=>reject(Error('closed')));})});
 await new Promise(resolve=>setImmediate(resolve));child.emit('exit',0,null);assert.equal(await pending,false);assert.equal(invocation.signal.aborted,true);
 assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('close'),0);
 for(const stdout of ['cancel\n','OPEN','open\nextra',''])assert.equal(await confirmGameLink(child,{...options,run:async()=>({stdout})}),false);
 assert.equal(await confirmGameLink(child,{...options,url:'file:///tmp/file',run:()=>assert.fail('Invalid URL created UI')}),false);
});
