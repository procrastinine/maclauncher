const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {componentSupplier}=require('./helpers/android-art-supplier');

test('original Linux signal frames preserve virtual x18 while the host register stays reserved',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, the ART supplier, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-register-signals-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const retained=process.env.ANDROID_REGISTER_SIGNALS_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20,...options});assert.ifError(result.error);return result;};
 const built=run(compiler,['--target=aarch64-linux-android35','-O2','-Wall','-Wextra','-Werror','tests/fixtures/android-native/art-register-signals.c','-o',path.join(root,'probe')]);
 assert.equal(built.status,0,built.stdout+built.stderr);
 const supplier=componentSupplier(path.resolve(payload)),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'signals',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 const execute=program=>run(program,['--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/probe/probe'],{env});
 if(process.env.ANDROID_ART_ORIGINAL_RUN){const old=execute(process.env.ANDROID_ART_ORIGINAL_RUN);if(retained){fs.writeFileSync(path.join(retained,'original-stdout.log'),old.stdout);fs.writeFileSync(path.join(retained,'original-stderr.log'),old.stderr);}assert.equal(old.status,31,old.stdout+old.stderr);assert.match(old.stdout,/synchronous guest x18: observed=0 restored=0x1234/);}
 const result=execute(runner);if(retained){fs.writeFileSync(path.join(retained,'stdout.log'),result.stdout);fs.writeFileSync(path.join(retained,'stderr.log'),result.stderr);}
 assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/synchronous guest x18: observed=0x1234 restored=0x5678/);
 assert.match(result.stdout,/asynchronous guest x18: observed=0x2345 restored=0x6789/);
 assert.match(result.stdout,/thread guest x18: child restored=0x789a parent preserved=0x6789/);
 assert.match(result.stdout,/fork guest x18: child inherited=0x6789 parent preserved=0x6789/);
 assert.match(result.stdout,/PASS original Bionic signal handlers read and restore virtual x18/);
});
