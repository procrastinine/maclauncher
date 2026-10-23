const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original Bionic far instructions retain generations, mapping failures, signals, move and fork owners',{timeout:90000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, ART supplier, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-far-veneer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const retained=process.env.ANDROID_FAR_VENEER_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const built=spawnSync(compiler,['-O2','-Wall','-Wextra','-Werror','tests/fixtures/android-native/art-far-veneer.c','-o',path.join(root,'probe')],{encoding:'utf8',timeout:30000,maxBuffer:4<<20});
 assert.ifError(built.error);assert.equal(built.status,0,built.stdout+built.stderr);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'far',prepareMountParents(layout({supplier,state})+'rw\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 const result=spawnSync(runner,[...(process.env.ANDROID_FAR_VENEER_TRACE==='1'?['--trace']:[]),'--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/probe/probe','/data/local/tmp/probe'],{env,encoding:'utf8',timeout:60000,maxBuffer:4<<20});
 if(retained){fs.writeFileSync(path.join(retained,'stdout.log'),result.stdout||'');fs.writeFileSync(path.join(retained,'stderr.log'),result.stderr||'');}
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 for(const message of ['original far instruction hardware semantics','replacement has distinct fetched instruction identity','original BRK collision refusal preserves old bytes and RX permission','original BRK move collision preserves source and destination','translation refusal preserves old bytes and RX permission','original and software SIGTRAP delivery','far dynamic SP completion preserves stack and registers','far PC relative instruction preserves original address','moved far instruction retains hardware semantics','DONTUNMAP retains executable source and destination owners','fork restores immutable far instruction owners'])assert.ok(result.stdout.includes('PASS '+message),result.stdout+result.stderr);
 t.diagnostic(result.stdout.trim());
});
