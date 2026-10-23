const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {componentSupplier}=require('./helpers/android-art-supplier');

test('original Bionic copied ELF generations retain edits and translate newly written instructions',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:compiler}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,compiler].every(Boolean))return t.skip('Requires Apple Silicon, ART supplier, runner and Android Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-file-copy-publication-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(program,args,env)=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result;};
 for(const library of [false,true])run(compiler,['--target=aarch64-linux-android35','-O2','-Wall','-Wextra','-Werror',...(library?['-DLIBRARY','-shared','-fPIC','-Wl,-z,max-page-size=4096']:[]),'tests/fixtures/android-native/art-file-copy-publication.c','-o',path.join(root,library?'libcopied.so':'probe')],process.env);
 const supplier=componentSupplier(path.resolve(payload)),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'code',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/probe\t'+root+'\n',path.join(root,'mounts'))),env=environment(supplier);delete env.CLASSPATH;
 const result=run(runner,['--inherit-env','--runtime',path.join(root,'kernel'),'--host-module',supplier.components.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/probe/probe','/data/local/tmp/probe/libcopied.so'],env);
 const retained=process.env.ANDROID_FILE_COPY_PUBLICATION_OUTPUT;
 if(retained){fs.mkdirSync(retained,{recursive:true});fs.writeFileSync(path.join(retained,'stdout.log'),result.stdout);fs.writeFileSync(path.join(retained,'stderr.log'),result.stderr);}
 assert.match(result.stdout,/copied publication old=d28000e0 new=1[4567][\da-f]{6} later=1[4567][\da-f]{6}/);
 assert.match(result.stdout,/PASS original Bionic copied ELF republishes current instructions/);
});
