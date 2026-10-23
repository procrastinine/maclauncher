const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {componentSupplier}=require('./helpers/android-art-supplier');

test('original instruction islands find free VM gaps around reserved large images',{timeout:30000},t=>{
 const {ANDROID_ART_ABI_RLIB:library,ANDROID_ART_ABI_DEPS:dependencies,ANDROID_RUSTC:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![library,dependencies,compiler].every(Boolean))return t.skip('Requires the built original AIM ABI and matching Rust compiler');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-island-placement-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const probe=path.join(root,'probe');
 const built=spawnSync(compiler,['--edition=2024','-O','tests/fixtures/android-native/art-island-placement.rs','-L','dependency='+path.resolve(dependencies),'--extern','aim_linux_abi='+path.resolve(library),'-o',probe],{encoding:'utf8',timeout:25000,maxBuffer:4<<20});
 assert.ifError(built.error);assert.equal(built.status,0,built.stdout+built.stderr);
 const run=spawnSync(probe,[],{encoding:'utf8',timeout:5000});assert.ifError(run.error);assert.equal(run.status,0,run.stdout+run.stderr);
 assert.match(run.stdout,/PASS original island placement finds reachable free gap/);
 assert.match(run.stdout,/PASS reachable 48 KiB gap fits bounded original instruction island/);
 assert.match(run.stdout,/PASS far generations preserve old fetched semantics and reject original BRK collisions/);
 t.diagnostic(run.stdout.trim());
});

test('original Bionic publication rejection preserves bytes and emits bounded original-stage metadata',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, ART supplier, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-publication-rejection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const retained=process.env.ANDROID_PUBLICATION_REJECTION_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(program,args,env)=>{const r=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 run(compiler,['--target=aarch64-linux-android35','-O2','-Wall','-Wextra','-Werror','tests/fixtures/android-native/art-publication-rejection.c','-o',path.join(root,'probe')],process.env);
 const supplier=componentSupplier(path.resolve(payload)),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'rejection',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 const modes=[{name:'disabled',trace:false},{name:'enabled',trace:true},...(process.env.ANDROID_PUBLICATION_STARTUP_OBSERVATION==='1'?[{name:'startup-observed',trace:false,observed:true}]:[])];
 for(const {name,trace,observed=false}of modes){
  const result=run(runner,[...(trace?['--trace']:[]),'--inherit-env','--runtime',path.join(root,'kernel-'+name),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/probe/probe'],{...env,MACLAUNCHER_ART_NATIVE_STARTUP_OBSERVATION:observed?'1':'0'});
  if(retained){fs.writeFileSync(path.join(retained,name+'-stdout.log'),result.stdout);fs.writeFileSync(path.join(retained,name+'-stderr.log'),result.stderr);}
  const match=result.stdout.match(/PASS rejected original Bionic publication base=(0x[\da-f]+) site=(0x[\da-f]+) size=(0x[\da-f]+) original=d71f0a40 attempts=10 errno=8/);assert.ok(match,result.stdout);
  const records=result.stderr.split('\n').filter(line=>line.includes('[linux-abi] executable publication rejected'));
  assert.equal(records.length,trace||observed?8:0,result.stderr);
  const prepared=result.stderr.split('\n').filter(line=>line.includes('[linux-abi] prepared jit-final '));
  assert.equal(prepared.length,trace?2:0,result.stderr);
  if(trace)for(let index=0;index<2;index++)assert.match(prepared[index],new RegExp('0 svc, 0 mrs/0 msr tpidr_el0, 0 scs, 0 ctr_el0, '+(1-index)+' x18, 0 brk fallbacks$'));
  if(trace||observed){const [,base,site,size]=match,hi='0x'+(BigInt(base)+BigInt(size)).toString(16);for(const record of records)assert.match(record,new RegExp('stage=jit-final reason=veneer-emission pid=\\d+ tid=\\d+ site='+site+' offset=0x10 range='+base+'\\.\\.'+hi+' original=d71f0a40 errno=8(?: result=-8)?$'));}
  if(observed){assert.ok(records.every(record=>record.endsWith(' errno=8 result=-8')));assert.equal(result.stderr.split('\n').filter(line=>line.startsWith('[linux] ')).length,0,result.stderr);}
 }
});
