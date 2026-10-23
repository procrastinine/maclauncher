const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('Android process_vm operations share logical identity and fault-safe native vectors',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(process.platform!=='darwin'||!runtime)return t.skip('Requires the macOS Android native runtime');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-process-memory-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const native=path.resolve('src/modules/android/native'),binary=path.join(root,'probe'),ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
 const run=(file,args)=>{const result=spawnSync(file,args,{encoding:'utf8',timeout:10000,env:{...process.env,DYLD_LIBRARY_PATH:path.resolve(runtime,'native')}});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-std=c11','-Wall','-Wextra','-Werror','-I'+native,native+'/process-memory.c',path.resolve('tests/fixtures/android-native/process-memory.c'),path.resolve(runtime,'native/libklepton-jvm.dylib'),'-o',binary]);
 assert.match(run(binary,[ids]),/PASS original process_vm vector order/);
});
