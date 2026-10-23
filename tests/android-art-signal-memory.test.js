const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Original Bionic signal-mask syscall contains bad user pointers without changing mask semantics',async t=>{
 const payload=process.env.ANDROID_ART_PAYLOAD,compiler=process.env.ANDROID_CLANG,runner=process.env.ANDROID_ART_LINUX_RUN;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!payload||!compiler||!runner)return t.skip('Requires the original ART image, Android Clang and adapted native runner');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-signal-copy-'));
 t.after(()=>{const writable=d=>{fs.chmodSync(d,0o700);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())writable(path.join(d,e.name));};writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const supplier=require('./helpers/android-art-supplier').componentSupplier(payload);
 const run=(program,args,env)=>{const r=spawnSync(program,args,{env,encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 run(compiler,['--target=aarch64-linux-android35','-O2','-Wl,-z,max-page-size=16384',path.join(__dirname,'fixtures/android-test/ArtSignalMemoryProbe.c'),'-o',path.join(root,'probe')],process.env);
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'signals',prepareMountParents(layout({supplier,state})+'rw\t/data/local/tmp/signal-probe\t'+root+'\n',path.join(root,'mounts')));
 const result=run(runner,['--inherit-env','--runtime',path.join(root,'kernel'),'--path-map',map,'--cache',path.join(root,'cache'),'--host-module',supplier.components.hostLibrary,'/data/local/tmp/signal-probe/probe'],environment(supplier));
 assert.match(result.stdout,/PASS original Linux signal masks retain valid semantics and contain invalid user pointers/);
});
