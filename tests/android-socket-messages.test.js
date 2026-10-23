const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('Original socket ancillary conversion preserves descriptor limits, flags and truncation cleanup',async t=>{
 const original=process.env.KLEPTON_SOURCE,descriptors=process.env.ANDROID_DESCRIPTOR_BUILD,jdk=process.env.JAVA_HOME,core=process.env.KLEPTON_CORE;
 if(process.platform!=='darwin'||!original||!descriptors||!jdk||!core)return t.skip('Requires pinned source, built descriptor owner, JDK headers and native core');
 const root=path.resolve(__dirname,'../src/modules/android/native'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-socket-messages-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const source=fs.readFileSync(path.join(original,'runtime/libc/kl_shim.c'),'utf8');
 const from=source.indexOf('typedef struct {\n    void     *msg_name;'),to=source.indexOf('static ssize_t kl_sendmsg(',from);
 assert.ok(from>0&&to>from);const warn=source.indexOf('static void kl_net_warn_once('),end=source.indexOf('\n}',warn);
 fs.writeFileSync(path.join(tmp,'original-message-types.h'),source.slice(warn,end+2)+'\n'+source.slice(from,to));
 const binary=path.join(tmp,'probe');const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-Wl,-dead_strip','-I'+root,'-I'+tmp,'-I'+jdk+'/include','-I'+jdk+'/include/darwin',path.join(__dirname,'fixtures/android-native/socket-messages.c'),root+'/guest-paths.c',path.join(descriptors,'bridge.o'),path.join(descriptors,'build/src/libepoll-shim.a'),core,'-Wl,-rpath,'+path.dirname(core),'-o',binary]);
 assert.match(run(binary,[]),/PASS original ancillary layouts, 253 rights, host passthrough, CLOEXEC and CTRUNC cleanup/);
});
