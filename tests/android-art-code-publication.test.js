const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {componentSupplier}=require('./helpers/android-art-supplier');
test('original Bionic modified ELF code receives register translation at executable publication',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, ART supplier, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-code-publication-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const retained=process.env.ANDROID_CODE_PUBLICATION_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(program,args,env)=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(result.error);return result;};
 for(const library of [false,true]){const built=run(compiler,['--target=aarch64-linux-android35','-O2','-Wall','-Wextra','-Werror',...(library?['-DLIBRARY','-shared','-fPIC']:[]),'tests/fixtures/android-native/art-code-publication.c','-ldl','-o',path.join(root,library?'libpublished.so':'probe')],process.env);assert.equal(built.status,0,built.stderr);}
 const supplier=componentSupplier(path.resolve(payload)),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'code',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 for(const mode of ['rw','rwx']){
  const result=run(runner,['--inherit-env','--runtime',path.join(root,'kernel-'+mode),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/probe/probe','/data/local/tmp/probe/libpublished.so',mode],env);
  if(retained){fs.writeFileSync(path.join(retained,mode+'-stdout.log'),result.stdout);fs.writeFileSync(path.join(retained,mode+'-stderr.log'),result.stderr);}
  assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS original Bionic modified ELF code reads guest TLS/);
 }
});
