const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

test('native clipboard helper observes activation and released shortcuts before authenticated IPC', {timeout:20000},async t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-clipboard-helper-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'helper'),state=path.join(root,'input');fs.writeFileSync(state,'0 0');
 const compilation=spawnSync('clang++',['-std=c++20','-fobjc-arc','-mmacosx-version-min=13.0','-Isrc/modules/android/native','tests/fixtures/android-clipboard/HelperProbe.mm','-framework','AppKit','-framework','Carbon','-framework','CoreGraphics','-o',binary],{encoding:'utf8'});
 assert.equal(compilation.status,0,compilation.stderr);
 // Keep the real broker API (one executable, no input flags) while supplying a
 // fixture-only process entry point that receives its private input file.
 const entry=path.join(root,'entry');fs.writeFileSync(entry,`#!${process.execPath}\nconst child=require('node:child_process').spawn(${JSON.stringify(binary)},[${JSON.stringify(state)}],{stdio:'inherit'});child.once('exit',(code)=>process.exit(code??1));\n`,{mode:0o700});
 const children=[],broker=require('../src/modules/android/clipboard').create(entry,{onSpawn:c=>children.push(c)});t.after(()=>broker.close());
 const set=(pid,operation)=>{const temporary=state+'.tmp';fs.writeFileSync(temporary,pid+' '+operation);fs.renameSync(temporary,state);};
 const observed=async(pid,operation)=>{const expected=pid+' '+operation,deadline=Date.now()+3000;for(;;){try{if(fs.readFileSync(state+'.observed','utf8')===expected){await delay(20);return;}}catch{}if(Date.now()>deadline)assert.fail('native observer did not sample '+expected);await delay(5);}};
 const gesture=async operation=>{set(101,operation);await observed(101,operation);await delay(40);set(101,0);await observed(101,0);await delay(100);};
 broker.enroll(101);set(101,0);await observed(101,0);
 assert.deepEqual(await broker.transfer(101,'paste'),{allowed:false},'enrollment and focus grant no clipboard access');
 await gesture(2);
 assert.deepEqual(await broker.transfer(101,'paste'),{allowed:true,text:'fixture initial λ'},'released Cmd-V survives observer and IPC latency');
 assert.deepEqual(await broker.transfer(101,'paste'),{allowed:false},'one gesture allows one transfer');
 await gesture(1);
 assert.deepEqual(await broker.transfer(101,'copy','fixture copied 🐦'),{allowed:true,text:''});
 await gesture(2);
 assert.deepEqual(await broker.transfer(101,'paste'),{allowed:true,text:'fixture copied 🐦'},'actual private pasteboard carries copied Unicode text');
 set(101,2);await observed(101,2);set(202,0);await delay(100);
 assert.deepEqual(await broker.transfer(101,'paste'),{allowed:false},'background process cannot consume its prior gesture');
 broker.retire(101);broker.enroll(101);set(101,0);await observed(101,0);
 assert.deepEqual(await broker.transfer(101,'paste'),{allowed:false},'retirement removes unconsumed gestures');
 await broker.close();assert.equal(children[0].exitCode,0,'EOF retires the native run loop and helper');
});
