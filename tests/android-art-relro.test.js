const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');

test('original Bionic RELRO retains shared writable data and ordinary protection requests',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires original ART image, Apple Silicon runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-relro-'));
 t.after(()=>{const writable=d=>{fs.chmodSync(d,0o700);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())writable(path.join(d,e.name));};writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const invoke=(program,args,env)=>spawnSync(program,args,{encoding:'utf8',timeout:30000,env:env||process.env});
 const run=(program,args,env)=>{const r=invoke(program,args,env);assert.equal(r.status,0,r.stdout+r.stderr+String(r.error||r.signal||''));return r.stdout;};
 const fixture=path.join(__dirname,'fixtures/android-native/art-relro.c'),script=path.join(__dirname,'fixtures/android-native/art-relro.ld');
 run(compiler,['-O2','-fPIC','-shared','-nostdlib','-DRELRO_LIBRARY','-Wl,-z,max-page-size=65536','-Wl,-z,common-page-size=4096','-Wl,-T,'+script,fixture,'-o',path.join(root,'librelro.so')]);
 run(compiler,['-O2',fixture,'-ldl','-o',path.join(root,'probe')]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'relro',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/fixture\t'+root+'\n',path.join(root,'mounts')));
 const env=environment(supplier);delete env.CLASSPATH;
 const args=name=>['--inherit-env','--runtime',path.join(root,name),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--cache',path.join(root,'cache'),'/data/local/tmp/fixture/probe','/data/local/tmp/fixture/librelro.so'];
 if(process.env.ANDROID_ART_ORIGINAL_RUN){const before=invoke(process.env.ANDROID_ART_ORIGINAL_RUN,args('original'),env);assert.equal(before.status,2,before.stdout+before.stderr);assert.match(before.stderr,/data remains writable/);}
 assert.match(run(runner,args('corrected'),env),/PASS original loader RELRO, writable neighbor and application mprotect/);
 const memory=args('memory');memory[memory.length-1]='memory';
 const probe=invoke(runner,memory,{...env,MACLAUNCHER_ART_NATIVE_STARTUP_OBSERVATION:process.env.ANDROID_ART_MPROTECT_OBSERVATION==='1'?'1':'0'});
 assert.equal(probe.status,0,probe.stdout+probe.stderr+String(probe.error||probe.signal||''));
 assert.match(probe.stdout,/PASS anonymous BSS, clipped multi-region RX and unchanged Linux mprotect errors/);
 if(process.env.ANDROID_ART_MPROTECT_OBSERVATION==='1'){
  assert.equal((probe.stderr.match(/\[native-startup-mprotect\] stage=/g)||[]).length,8,'failed-request observation has a fixed budget');
  assert.match(probe.stderr,/stage=native .*prot=0x5 result=-12/);assert.match(probe.stderr,/stage=owner .*prot=0x5 result=-12/);
  const disabled=invoke(runner,memory,{...env,MACLAUNCHER_ART_NATIVE_STARTUP_OBSERVATION:'0'});
  assert.equal(disabled.status,0,disabled.stdout+disabled.stderr);assert.doesNotMatch(disabled.stderr,/native-startup-mprotect/);
 }
 if(process.env.ANDROID_RELRO_SQLITE){
  fs.copyFileSync(process.env.ANDROID_RELRO_SQLITE,path.join(root,'libsqlite3.so'));
  const sqlite=args('sqlite');sqlite[sqlite.length-1]='/data/local/tmp/fixture/libsqlite3.so';sqlite.push('sqlite');
  assert.match(run(runner,sqlite,env),/PASS original SQLite initialization and database lifetime/);
 }
});
