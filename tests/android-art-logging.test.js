const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('original Bionic log callbacks retain independent shared host output',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ART_HOST_LIBRARY:host,ANDROID_ART_LOG_LIBRARY:log,ANDROID_CLANG:clang}=process.env;
 if(process.platform!=='darwin'||![payload,runner,host,log,clang].every(Boolean))return t.skip('Requires the Android image, native logging components and NDK Clang');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(program,args,options={})=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20,...options});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));supplier.components.hostLibrary=path.resolve(host);
 const binary=path.join(root,'probe');run(clang,['-O2','-std=c11','-Wall','-Wextra','-Werror',path.resolve('tests/fixtures/android-art-stack/logging.c'),'-llog','-o',binary]);
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs'),state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'logging',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/log-probe\t'+binary+'\nro\t/system/lib64/libandroid-log-stderr.so\t'+path.resolve(log)+'\n',path.join(root,'mounts')));
 const env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')};
 const args=['--inherit-env','--guest-fds','0,1,2','--path-map',map,'--no-cache','--host-module',path.resolve(host)];
 run(runner,[...args,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const result=run(runner,[...args,'/data/local/tmp/log-probe'],{env:{...env,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so'}});
 assert.match(result.stdout,/PASS original Bionic redirects stderr/);assert.match(result.stderr,/independent Android log/);assert.match(result.stderr,/after close 42/);
 t.diagnostic(result.stdout.trim());
});
