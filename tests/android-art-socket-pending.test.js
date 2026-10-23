const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('original Bionic pending-byte queries preserve Linux descriptor owners and payload counts',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang,ANDROID_ART_PENDING_BASELINE:baseline}=process.env;
 if(process.platform!=='darwin'||!payload||!runner||!clang)return t.skip('Requires the Android image, executor and NDK');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-socket-pending-'));t.after(()=>{const writable=directory=>{fs.chmodSync(directory,0o700);for(const item of fs.readdirSync(directory,{withFileTypes:true}))if(item.isDirectory())writable(path.join(directory,item.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const retained=process.env.ANDROID_ART_PENDING_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});const children=[];
 const run=(command,args,env=process.env,status=0)=>{const result=spawnSync(command,args,{env,encoding:'utf8',timeout:20000,maxBuffer:2<<20});if(result.pid)children.push(result.pid);assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,status,result.stdout+result.stderr);return result.stdout+result.stderr;};
 const {componentSupplier}=require('./helpers/android-art-supplier'),supplier=componentSupplier(path.resolve(payload)),c=supplier.components;
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const guest=path.join(root,'probe');run(clang,['-O1','-Wall','-Wextra','-Werror',path.resolve('tests/fixtures/android-art-network/pending-guest.c'),'-o',guest]);
 for(const[name,executor]of [...(baseline?[['previous',path.resolve(baseline)]]:[]),['current',path.resolve(runner)]]){
  const state=path.join(root,name);fs.mkdirSync(state);const map=publishPathMap(state,'pending',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/pending-probe\t'+guest+'\n',path.join(state,'mounts'))),env={...environment(supplier),DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')},args=['--inherit-env','--guest-fds','0,1,2','--path-map',map,'--no-cache','--host-module',c.hostLibrary];
  run(executor,[...args,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],env);
  const output=run(executor,[...args,'/data/local/tmp/pending-probe'],env,name==='previous'?2:0);if(retained)fs.writeFileSync(path.join(retained,name+'.log'),output);
  assert.match(output,name==='previous'?/FAIL original Bionic FIONREAD owner\/payload mismatches/:/PASS original Bionic UDP first-datagram FIONREAD counts, zero-length packets, IPv4\/IPv6 FD0 reuse\/dup2 and TCP byte counts; anonymous Linux owner errors and pipe counts/);t.diagnostic(name+': '+output.trim());
 }
 const alive=children.filter(pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}});assert.deepEqual(alive,[],'Exact synchronous component processes are reaped');if(retained)fs.writeFileSync(path.join(retained,'cleanup.json'),JSON.stringify({pids:children,alive},null,2)+'\n');
});
