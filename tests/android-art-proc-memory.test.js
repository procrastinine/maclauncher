const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original Bionic smaps reports per-mapping usage and live resident-page growth',async t=>{
 const payload=process.env.ANDROID_ART_PAYLOAD,compiler=process.env.ANDROID_CLANG,runner=process.env.ANDROID_ART_LINUX_RUN,aim=process.env.ANDROID_AIM_SOURCE;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!payload||!compiler||!runner||!aim)return t.skip('Requires original Android image/compiler and pinned AIM source/runner');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-proc-memory-'));
 t.after(()=>{const writable=d=>{fs.chmodSync(d,0o700);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())writable(path.join(d,e.name));};writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const supplier=require('./helpers/android-art-supplier').componentSupplier(payload);
 const run=(program,args,env)=>{const r=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const original=path.join(aim,'crates/aim-linux-abi/tests/ndk/t_proc.c');
 run(compiler,['--target=aarch64-linux-android35','-D_GNU_SOURCE','-O2','-ffunction-sections','-Wl,--gc-sections','-Wl,-z,max-page-size=16384','-DAIM_PROC_TEST="'+original+'"',path.join(__dirname,'fixtures/android-art/ProcMemoryProbe.c'),'-o',path.join(root,'probe')],process.env);
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'proc-memory',prepareMountParents(layout({supplier,state})+'rw\t/data/local/tmp/proc-memory-probe\t'+root+'\n',path.join(root,'mounts')));
 const result=run(runner,['--inherit-env','--runtime',path.join(root,'kernel'),'--path-map',map,'--no-cache','/data/local/tmp/proc-memory-probe/probe'],environment(supplier));
 assert.match(result.stdout,/ok smaps\nPASS/);
});
