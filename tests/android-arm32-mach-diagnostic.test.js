const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Mach dispatch quietly forwards unowned faults while retaining owned recovery and physical failure diagnostics',async t=>{
 const source=process.env.ANDROID_DYNARMIC_SOURCE,build=process.env.ANDROID_ARM32_BUILD;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!source||!build)return t.skip('Requires original Dynarmic source and its Apple Silicon component build');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-mach-diagnostic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const native=path.resolve('src/modules/android/native'),arm32=path.join(native,'arm32');
 const {prepareExceptionHandler}=await import('../src/modules/android/native/arm32/exception-source.mjs');
 const projected=prepareExceptionHandler({source,output:path.join(root,'exception_handler_macos.cpp')});
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const objects=[];for(const name of['android-log','process-ids']){const object=path.join(root,name+'.o');run('clang',['-std=c11','-O2','-I'+native,'-c',path.join(native,name+'.c'),'-o',object]);objects.push(object);}
 const includes=['src','externals/oaknut/include','externals/fmt/include','externals/mcl/include'].map(p=>'-I'+path.resolve(source,p));
 const dependencies=[path.resolve(build,'dynarmic/externals/mcl/src/libmcl.a'),path.resolve(build,'dynarmic/externals/fmt/libfmt.a'),path.resolve(build,'dynarmic/src/dynarmic/CMakeFiles/dynarmic.dir/backend/exception_handler_macos_mig.c.o')];
 for(const [label,original,physical]of[['original',true,true],['physical',false,true],['stdio',false,false]]){
  const binary=path.join(root,label);
  run('clang++',['-std=c++20','-O2','-DFMT_CONSTEVAL=','-I'+arm32,...includes,'-DORIGINAL_REPORTER='+Number(original),'-DPHYSICAL_LOG='+Number(physical),'-DDYNARMIC_EXCEPTION_SOURCE="'+(original?path.resolve(source,'src/dynarmic/backend/exception_handler_macos.cpp'):projected)+'"',path.resolve('tests/fixtures/android-arm32/mach-diagnostic.cpp'),...dependencies,...(physical?objects:[]),'-Wl,-U,_klj_android_log_write','-o',binary]);
  const r=run(binary,[]);assert.match(r.stdout,/PASS /);
  if(label==='physical')assert.match(r.stderr,/catch_mach_exception_raise_state: Unexpected flavor/);
  else assert.equal(r.stderr,'');
  assert.doesNotMatch(r.stderr,/Unhandled EXC_BAD_ACCESS|Mach exception=|x28=/);
  t.diagnostic(r.stdout.trim());
 }
});
test('Both delivered VM components use the nonthrowing physical Mach reporter',t=>{
 const libraries=[process.env.ANDROID_ARM32_LIBRARY,process.env.ANDROID_ART_HOST_LIBRARY];
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||libraries.some(p=>!p))return t.skip('Requires both changed native VM components and original runtime closure');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-mach-delivered-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 for(const [index,library]of libraries.entries()){
  const binary=path.join(root,'probe'+index);
  run('clang++',['-std=c++20','-O2','-I'+path.resolve('src/modules/android/native/arm32'),path.resolve('tests/fixtures/android-arm32/mach-delivered.cpp'),path.resolve(library),...(index===0?[path.resolve(runtime,'native/libklepton-jvm.dylib')]:[]),'-Wl,-rpath,'+path.dirname(path.resolve(library)),'-Wl,-rpath,'+path.resolve(runtime,'native'),'-o',binary]);
  const r=run(binary,[]);assert.match(r.stdout,/PASS delivered Mach reporter/);assert.match(r.stderr,/catch_mach_exception_raise_state: Unexpected flavor/);assert.doesNotMatch(r.stderr,/Unhandled EXC_BAD_ACCESS|Mach exception=/);t.diagnostic((index?'ART: ':'JVM: ')+r.stdout.trim());
 }
});
