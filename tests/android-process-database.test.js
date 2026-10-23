const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Complete original Bionic account database retains Android IDs, layouts and per-thread state',async t=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon');
 const bionic=process.env.ANDROID_BIONIC_SOURCE,core=process.env.ANDROID_SYSTEM_CORE_SOURCE,build=process.env.ANDROID_BUILD_SOURCE,python=process.env.PYTHON,home=process.env.JAVA_HOME;
 if(!bionic||!core||!build||!python||!home)return t.skip('Requires pinned Bionic, SystemCore and build sources, Python and JDK');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-process-database-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const {prepareProcessDatabase}=await import('../src/modules/android/native/process-abi/database.mjs');
 const result=prepareProcessDatabase({bionicSource:bionic,coreSource:core,buildSource:build,python,build:temporary});
 const {preparePrctlConstants}=await import('../src/modules/android/native/process-abi/prctl.mjs');
 preparePrctlConstants({bionicSource:bionic,output:path.join(temporary,'process-abi')});
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const source=path.resolve(__dirname,'../src/modules/android/native');
 const nativeObjects=['process-identity','thread-identity','framework-process'].map(name=>{
  const object=path.join(temporary,name+'.o');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-std=gnu11','-Wall','-Wextra','-Werror','-I'+temporary,'-I'+home+'/include','-I'+home+'/include/darwin','-c',source+'/'+name+'.c','-o',object]);
  return object;
 });
 const executable=path.join(temporary,'probe');
 run('clang++',['-std=c++20','-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-Wl,-dead_strip','-Wno-nullability-completeness','-I'+home+'/include','-I'+home+'/include/darwin','-I'+temporary+'/process-database/include',path.join(__dirname,'fixtures/android-native/process-database.cpp'),...nativeObjects,...result.objects,'-o',executable]);
 const root=path.join(temporary,'guest');fs.mkdirSync(root+'/etc',{recursive:true});
 fs.writeFileSync(root+'/etc/passwd','system_fixture:x:6001:6001:Fixture:/system:/system/bin/sh\n');
 fs.writeFileSync(root+'/etc/group','system_fixture:x:6001:\n');
 assert.match(run(executable,[root]),/PASS original Bionic account module/);
 const symbols=run('nm',['-gU',...result.objects]);
 for(const name of result.functions)assert.match(symbols,new RegExp('\\b_klj_bionic_'+name+'\\b'));
 assert.equal(result.functions.length,18);
});
