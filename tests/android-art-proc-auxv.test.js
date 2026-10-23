const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {componentSupplier}=require('./helpers/android-art-supplier');

test('original Bionic proc auxiliary vector matches the loader and survives fork and exec',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, the ART supplier, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-proc-auxv-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const retained=process.env.ANDROID_PROC_AUXV_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(program,args,env)=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(result.error);return result;};
 const built=run(compiler,['--target=aarch64-linux-android35','-O2','-Wall','-Wextra','-Werror','tests/fixtures/android-native/art-proc-auxv.c','-o',path.join(root,'probe')],process.env);
 assert.equal(built.status,0,built.stdout+built.stderr);fs.symlinkSync('probe',path.join(root,'exec-probe'));
 const supplier=componentSupplier(path.resolve(payload)),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);const byPid=path.join(root,'by-pid');fs.mkdirSync(byPid);
 const map=publishPathMap(state,'auxv',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 const execute=(program,name)=>{const result=run(program,['--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--by-pid',byPid,'--path-map',map,'--no-cache','/data/local/tmp/probe/probe'],env);if(retained){fs.writeFileSync(path.join(retained,name+'-stdout.log'),result.stdout);fs.writeFileSync(path.join(retained,name+'-stderr.log'),result.stderr);}return result;};
 if(process.env.ANDROID_ART_ORIGINAL_RUN){const before=execute(process.env.ANDROID_ART_ORIGINAL_RUN,'original');assert.equal(before.status,21,before.stdout+before.stderr);assert.match(before.stderr,/\/proc\/self\/auxv: No such file or directory/);}
 const result=execute(runner,'fixed');assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/PASS exec refreshed original Bionic auxiliary vector/);
 assert.match(result.stdout,/PASS original Bionic auxiliary vector: values, aliases, thread, saved snapshot, fork, exec and remote process/);
 t.diagnostic(result.stdout.trim());
});
