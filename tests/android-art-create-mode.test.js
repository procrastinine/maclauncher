const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('original Bionic mode000 creation retains its unprivileged creator and setgid parent',{timeout:60000},async t=>{
 const{ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang,ANDROID_ART_CREATE_MODE_BASELINE:baseline}=process.env;
 if(process.platform!=='darwin'||!payload||!runner||!clang)return t.skip('Requires Android image, executor and NDK');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-create-mode-'));t.after(()=>{const writable=d=>{fs.chmodSync(d,0o700);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())writable(path.join(d,e.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const retained=process.env.ANDROID_ART_CREATE_MODE_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});const pids=[];
 const invoke=(file,args,env=process.env)=>{const r=spawnSync(file,args,{env,encoding:'utf8',timeout:20000,maxBuffer:1<<20});if(r.pid)pids.push(r.pid);assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);return r;};
 const probe=path.join(root,'probe'),compile=invoke(clang,['-O1','-Wall','-Wextra','-Werror',path.resolve('tests/fixtures/android-native/art-create-mode.c'),'-o',probe]);assert.equal(compile.status,0,compile.stderr);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));const{layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 for(const[name,executor]of[...(baseline?[['previous',path.resolve(baseline)]]:[]),['current',path.resolve(runner)]]){
  const state=path.join(root,name);fs.mkdirSync(state);const map=publishPathMap(state,'mode',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/mode-probe\t'+probe+'\nrw\t/data/local/tmp/mode-state\t'+state+'\n',path.join(state,'mounts'))),env={...environment(supplier),DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')};
  const r=invoke(executor,['--inherit-env','--guest-fds','0,1,2','--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/mode-probe','/data/local/tmp/mode-state'],env);if(retained)fs.writeFileSync(path.join(retained,name+'.log'),r.stdout+r.stderr);
  assert.equal(r.status,name==='previous'?2:0,r.stdout+r.stderr);assert.match(r.stdout+r.stderr,name==='previous'?/FAIL owner fchmod0400 errno1/:/PASS original Bionic app mode000 create\/write\/fchmod0400, uid10154 inheritedgid20154 and guest DAC/);
 }
 const alive=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}});assert.deepEqual(alive,[]);if(retained)fs.writeFileSync(path.join(retained,'cleanup.json'),JSON.stringify({pids,alive},null,2)+'\n');
});
