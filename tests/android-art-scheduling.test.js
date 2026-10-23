const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process'),{once}=require('node:events'),{createInterface}=require('node:readline');

test('original Android scheduling worker changes actual Darwin priorities, including cross-thread requests',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang,ANDROID_AIM_SOURCE:source}=process.env;
 if(process.platform!=='darwin'||![payload,runner,clang,source].every(Boolean))return t.skip('Requires the Android image, adapted executor, NDK and pinned AIM source');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-priority-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(command,args,options={})=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,...options});assert.ifError(r.error);assert.equal(r.signal,null,r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const guest=path.join(root,'worker'),probe=path.join(root,'priority');
 run(clang,['-O1','-D_GNU_SOURCE','-Wall','-Werror','-o',guest,path.resolve(source,'crates/aim-linux-abi/tests/ndk/t_qos.c')]);
 run('clang',['-O2','-Wall','-Wextra','-Werror','-o',probe,path.resolve('tests/fixtures/android-art-stack/thread-priority.c')]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 if(process.env.ANDROID_ART_HOST_LIBRARY)c.hostLibrary=path.resolve(process.env.ANDROID_ART_HOST_LIBRARY);
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'priority',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/priority-worker\t'+guest+'\n',path.join(root,'mounts')));
 const env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')};
 const args=['--inherit-env','--path-map',map,'--no-cache','--host-module',c.hostLibrary];
 run(runner,[...args,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const child=spawn(runner,[...args,'/data/local/tmp/priority-worker'],{env,detached:true,stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit');let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-100000);});
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};
 const timer=setTimeout(kill,15000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)kill();});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const steps=[['default',31],['utility',20],['background',4],['default',31],['background',4],['foreground',33],['urgent-audio',47],['fifo',47],['default',31],['fifo',47]];
 for(const [step,priority] of steps){
  const line=await lines.next();assert.equal(line.value,step,stderr);
  assert.equal(Number(run(probe,[String(child.pid),'qos-worker']).trim()),priority,step);
  child.stdin.write('\n');
 }
 assert.equal((await lines.next()).value,'PASS',stderr);
 const [code,signal]=await exited;assert.equal(signal,null,stderr);assert.equal(code,0,stderr);
 t.diagnostic('All ten original scheduling stages match actual Darwin worker priorities');
});
