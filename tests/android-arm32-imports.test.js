const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original LP32 loader controls reach the shared LP64 owner unchanged in meaning',async t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,clang=process.env.ANDROID_CLANG,include=process.env.ANDROID_NDK_HEADERS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!clang||!include)return t.skip('Requires the shared ARM32 component and original Android headers/compiler');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-loader-abi-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {generateLoaderAbi}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const {generateSignalAbi}=await import('../src/modules/android/native/arm32/signal-abi.mjs');
  const {prepareFutexConstants}=await import('../src/modules/android/native/arm32/syscall-sources.mjs');
  prepareFutexConstants({include,output:temporary,clang});
  generateSignalAbi({include,output:temporary,clang});
  const values=generateLoaderAbi({include,output:temporary,clang});
  assert.notEqual(values.guest.RTLD_DEFAULT,values.host.RTLD_DEFAULT);assert.notEqual(values.guest.RTLD_GLOBAL,values.host.RTLD_GLOBAL);
  const file=path.join(temporary,'loader-abi.inc');fs.utimesSync(file,new Date(1000000000000),new Date(1000000000000));
  generateLoaderAbi({include,output:temporary,clang});assert.equal(fs.statSync(file).mtimeMs,1000000000000);
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'loader-abi');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,'-I'+path.resolve(generated),'-I'+path.resolve(generated,'../format'),'-I'+path.resolve(generated,'../syscalls'),'-DARM32_IMPORTS_SOURCE="'+path.join(native,'native-imports.cpp')+'"',path.join(__dirname,'fixtures/android-arm32/loader-abi-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[]),/PASS original LP32\/LP64 loader handles and complete flag family/);
});

test('original futex timeout and requeue operands retain their kernel representations',async t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,include=process.env.ANDROID_NDK_HEADERS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!include)return t.skip('Requires the shared ARM32 component and original Android headers');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-futex-abi-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {prepareFutexConstants}=await import('../src/modules/android/native/arm32/syscall-sources.mjs');
  const {generateLoaderAbi}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const {generateSignalAbi}=await import('../src/modules/android/native/arm32/signal-abi.mjs');
  generateLoaderAbi({include,output:temporary,clang:process.env.ANDROID_CLANG});
  generateSignalAbi({include,output:temporary,clang:process.env.ANDROID_CLANG});
  prepareFutexConstants({include,output:temporary,clang:process.env.ANDROID_CLANG});
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'futex-abi');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,'-I'+path.resolve(generated),'-I'+path.resolve(generated,'../format'),'-I'+path.resolve(generated,'../syscalls'),'-DARM32_IMPORTS_SOURCE="'+path.join(native,'native-imports.cpp')+'"',path.join(__dirname,'fixtures/android-arm32/futex-abi-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[]),/PASS original futex timeout, requeue and PI operands/);
});

test('Khronos counted pointer contracts follow original registry expressions',async()=>{
  const {compileGraphicsLength}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const declarations={types:{count:{kind:'Int',aliases:['GLsizei']},enumeration:{kind:'UInt',aliases:['GLenum']},pointer:{kind:'Pointer'}}};
  const parameters=[{name:'count'},{name:'pname'},{name:'strings'}],signature={parameters:['count','enumeration','pointer']};
  assert.deepEqual(compileGraphicsLength('count*4',parameters,signature,declarations),[{operation:'Parameter',value:0},{operation:'Constant',value:4},{operation:'Multiply',value:0}]);
  assert.deepEqual(compileGraphicsLength('COMPSIZE(count)',parameters,signature,declarations),[{operation:'Parameter',value:0}]);
  assert.deepEqual(compileGraphicsLength('1',parameters,signature,declarations),[{operation:'Constant',value:1}]);
  assert.equal(compileGraphicsLength('COMPSIZE(pname)',parameters,signature,declarations),null);
  assert.equal(compileGraphicsLength('COMPSIZE(strings)',parameters,signature,declarations),null);
  assert.equal(compileGraphicsLength('missing+1',parameters,signature,declarations),null);
});

test('every original OpenSL and OpenMAX tagged payload retains its declared type',async t=>{
  const generated=process.env.ANDROID_ARM32_IMPORTS,include=process.env.ANDROID_NDK_HEADERS;
  if(!generated||!include)return t.skip('Requires original extracted NDK declarations and headers');
  const {readMediaTags,emitDescriptors}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const guest=JSON.parse(fs.readFileSync(path.join(generated,'guest-ast.json'))),host=JSON.parse(fs.readFileSync(path.join(generated,'host-ast.json')));
  const mediaTags=readMediaTags({include,guest,host,clang:process.env.ANDROID_CLANG});
  const original=Object.entries(guest.types).filter(([name,type])=>/^(SL|XA)(Android)?Data(Locator|Format)_/.test(name)&&type.kind==='Record').map(([name])=>name).sort();
  assert.deepEqual(mediaTags.map(row=>row.name).sort(),original);assert.ok(original.length>0);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-media-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  emitDescriptors({guest,host,output:temporary,mediaTags});
  const source=fs.readFileSync(path.join(temporary,'native-imports.inc'),'utf8');
  for(const row of mediaTags){assert.ok(source.includes('"'+row.name+' *"'));assert.ok(source.includes(`{${row.family},${row.guest},${row.host},`));}
});

test('original OpenSL and OpenMAX interface arrays retain their declared cardinality',async t=>{
  const generated=process.env.ANDROID_ARM32_IMPORTS;if(!generated)return t.skip('Requires original extracted NDK declarations');
  const {mediaInterfaceCounts}=await import('../src/modules/android/native/arm32/media-lengths.mjs');
  const {emitDescriptors}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const guest=JSON.parse(fs.readFileSync(path.join(generated,'guest-ast.json'))),host=JSON.parse(fs.readFileSync(path.join(generated,'host-ast.json')));
  const expected=Object.entries(guest.types).filter(([,type])=>type.kind.startsWith('Function')&&type.parameters.some(name=>/^const (SL|XA)InterfaceID \*$/.test(name)));
  assert.ok(expected.length>0);
  for(const [name,type]of expected){
    const plans=mediaInterfaceCounts(type,guest);assert.equal(plans.length,2,name);
    const ids=type.parameters.findIndex(name=>/^const (SL|XA)InterfaceID \*$/.test(name));
    assert.deepEqual(plans.map(plan=>plan.parameter),[ids,ids+1]);
    for(const plan of plans)assert.deepEqual(plan.instructions,[{operation:'Parameter',value:ids-1}]);
  }
  for(const name of ['slCreateEngine','xaCreateEngine'])assert.equal(mediaInterfaceCounts(guest.types[guest.functions[name].type],guest).length,2);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-media-counts-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  emitDescriptors({guest,host,output:directory});
  const source=fs.readFileSync(path.join(directory,'native-imports.inc'),'utf8');
  assert.match(source,/typedCounts\[\]=\{\{/);assert.equal((source.match(/static constexpr CountPlan mediaCounts/g)||[]).length,expected.length);
});

test('ARM32 OpenSL and OpenMAX preserve counted arrays and scoped interface outputs',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!runtime)return t.skip('Requires the ARM32 component, original NDK descriptors and Android runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-media-calls-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'probe');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  require('./helpers/android-arm32-shapes').writeShapes(generated,temporary);
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,path.join(__dirname,'fixtures/android-arm32/imports-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),'--media-counts']),/PASS original SL\/XA counted interface arrays/);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),'--media-scoped']),/PASS original scoped OpenSL IID output and exact interface bounds/);
});

test('ARM32 graphics convert complete original Khronos counted pointer arrays',async t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,registry=process.env.ANDROID_GL_REGISTRY,python=process.env.ANDROID_PYTHON;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!registry||!python)return t.skip('Requires the ARM32 component and original Khronos registry');
  const {emitDescriptors,readGraphicsLengths,compileGraphicsLength}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-graphics-counts-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const guest=JSON.parse(fs.readFileSync(path.join(generated,'guest-ast.json'))),host=JSON.parse(fs.readFileSync(path.join(generated,'host-ast.json'))),graphicsLengths=readGraphicsLengths({python,registry});
  // Every registry count on a pointer-width-changing original declaration has
  // the same generic plan, independent of command spelling or imported games.
  let converted=0;
  for(const [name,parameters] of Object.entries(graphicsLengths)){
    const fn=guest.functions[name],nativeFn=host.functions[name];if(!fn||!nativeFn)continue;
    const signature=guest.types[fn.type],native=host.types[nativeFn.type];
    parameters.forEach((parameter,index)=>{
      if(!parameter.length)return;const type=guest.types[signature.parameters[index]],nativeType=host.types[native.parameters[index]];
      if(type?.kind!=='Pointer')return;
      if(guest.types[type.element]?.size===host.types[nativeType.element]?.size)return;
      assert.ok(compileGraphicsLength(parameter.length,parameters,signature,guest),name+': '+parameter.length);converted++;
    });
  }
  assert.ok(converted>0);
  emitDescriptors({guest,host,output:temporary,graphicsLengths});
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'graphics-counts');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,path.join(__dirname,'fixtures/android-arm32/graphics-array-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  const output=run(binary,[]);
  assert.match(output,/PASS original Khronos counted pointer arrays/);
  assert.match(output,/PASS original GL provider resolved once per native plan with live binding state and separate owners/);
});

test('unchanged ARM32 declarations retain compiler input timestamps',async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-declarations-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const {emitDescriptors}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const declarations=kind=>({types:{length:{name:'length',kind,size:4,alignment:4},signature:{name:'signature',kind:'FunctionProto',size:1,alignment:4,result:'length',parameters:['length']}},functions:{exchange:{symbol:'exchange',type:'signature',parameters:['length']}},variables:{}});
  const guest=declarations('Int'),host=declarations('UInt');
  emitDescriptors({guest,host,output:temporary});const file=path.join(temporary,'native-imports.inc'),original=fs.readFileSync(file,'utf8');
  assert.match(original,/Kind::Signed,4,4.*"length",JniValue::None,Kind::Unsigned/);
  fs.utimesSync(file,new Date(1000000000000),new Date(1000000000000));const timestamp=fs.statSync(file).mtimeMs;
  emitDescriptors({guest,host,output:temporary});assert.equal(fs.statSync(file).mtimeMs,timestamp);assert.equal(fs.readFileSync(file,'utf8'),original);
  host.types.length.size=8;emitDescriptors({guest,host,output:temporary});assert.notEqual(fs.readFileSync(file,'utf8'),original);assert.notEqual(fs.statSync(file).mtimeMs,timestamp);
});

test('original EGL opaque values preserve identities without reading resource bytes',async t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,include=process.env.ANDROID_NDK_HEADERS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!include)return t.skip('Requires the shared ARM32 component and original Android declarations');
  const {emitDescriptors}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-egl-values-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const guest=JSON.parse(fs.readFileSync(path.join(generated,'guest-ast.json'))),host=JSON.parse(fs.readFileSync(path.join(generated,'host-ast.json')));
  emitDescriptors({guest,host,output:temporary});
  for(const header of ['EGL','KHR'])fs.cpSync(path.join(include,header),path.join(temporary,header),{recursive:true});
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'egl-values');
  const args=['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,'-I'+path.resolve(generated),'-I'+path.resolve(generated,'../format'),'-I'+path.resolve(generated,'../syscalls'),'-DARM32_IMPORTS_SOURCE="'+path.join(native,'native-imports.cpp')+'"',path.join(__dirname,'fixtures/android-arm32/egl-values-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-Wl,-rpath,'+path.resolve(build),'-o',binary];
  const compiled=spawnSync('clang++',args,{encoding:'utf8',timeout:60000});assert.ifError(compiled.error);assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/PASS original EGL opaque tokens, mapped identities, labels, retirement and ordinary buffer bounds/);
});

test('retained original declarations refresh complete descriptors without repeating AST extraction',async t=>{
  const generated=process.env.ANDROID_ARM32_IMPORTS;
  if(!generated)return t.skip('Requires retained original Android declarations and descriptor inputs');
  const {refreshDescriptors}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-descriptor-refresh-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const originals=['guest-ast.json','host-ast.json','guest-input.json','descriptor-inputs.json'];
  for(const file of originals)fs.copyFileSync(path.join(generated,file),path.join(temporary,file));
  const astFiles=originals.slice(0,2).map(file=>path.join(temporary,file));
  const identities=astFiles.map(file=>({bytes:fs.readFileSync(file),mtime:fs.statSync(file).mtimeMs}));
  refreshDescriptors({output:temporary});
  const file=path.join(temporary,'native-imports.inc'),complete=fs.readFileSync(file,'utf8');
  const egl=complete.split('\n').filter(line=>/"EGL(?:Display|Surface)"/.test(line));
  assert.equal(egl.length,2);assert.ok(egl.every(line=>line.endsWith(',true},')));
  const host=JSON.parse(identities[1].bytes);
  assert.ok(complete.includes('nativeAllocationAlignment='+host.types.max_align_t.alignment+';'));
  assert.match(complete,/static constexpr CountPlan counts\d+/);
  assert.match(complete,/static constexpr TaggedRecord taggedRecords\[\]=\{\{/);
  // Reproduce the stale-role cache independently of the original AST. Both
  // producers must restore complete metadata before compiling a consumer.
  const stale=complete.split('\n').map(line=>egl.includes(line)?line.replace(/,true},$/,',false},'):line).join('\n');
  assert.notEqual(stale,complete);fs.writeFileSync(file,stale);
  refreshDescriptors({output:temporary});assert.equal(fs.readFileSync(file,'utf8'),complete);
  const mtime=fs.statSync(file).mtimeMs;refreshDescriptors({output:temporary});assert.equal(fs.statSync(file).mtimeMs,mtime);
  astFiles.forEach((file,index)=>{assert.deepEqual(fs.readFileSync(file),identities[index].bytes);assert.equal(fs.statSync(file).mtimeMs,identities[index].mtime);});
});

test('ARM32 AST reuse follows exact headers, extractor, configuration and tool identities',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-ast-reuse-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const {extractTargetDeclarations}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const file=name=>path.join(directory,name),owner=file('owner.h'),tool=file('libclang'),config=file('input.json'),extractor=file('extract.cjs'),result=file('ast.json'),calls=file('calls');
  fs.writeFileSync(owner,'original');fs.writeFileSync(tool,'tool-v1');
  fs.writeFileSync(config,JSON.stringify({calls,target:'armv7a-linux-androideabi36'}));
  fs.writeFileSync(extractor,"const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.argv[2]));fs.appendFileSync(c.calls,'x');fs.writeFileSync(process.argv[3],JSON.stringify({target:c.target,types:{},functions:{},variables:{},headers:[]}));\n");
  const request={python:process.execPath,extractor,config,result,inputs:[owner,tool],identity:{headerTree:'validated-ndk-v1',resources:['original-resource.h']}};
  const count=()=>fs.readFileSync(calls,'utf8').length;
  const original=await extractTargetDeclarations(request);assert.equal(count(),1);const bytes=fs.readFileSync(result),mtime=fs.statSync(result).mtimeMs;
  assert.deepEqual(await extractTargetDeclarations(request),original);assert.equal(count(),1);assert.equal(fs.statSync(result).mtimeMs,mtime);assert.deepEqual(fs.readFileSync(result),bytes);
  fs.writeFileSync(owner,'modified');await extractTargetDeclarations(request);assert.equal(count(),2);
  fs.writeFileSync(tool,'tool-v2');await extractTargetDeclarations(request);assert.equal(count(),3);
  fs.appendFileSync(extractor,'// changed extractor\n');await extractTargetDeclarations(request);assert.equal(count(),4);
  fs.writeFileSync(config,JSON.stringify({calls,target:'aarch64-linux-android36'}));assert.equal((await extractTargetDeclarations(request)).target,'aarch64-linux-android36');assert.equal(count(),5);
  request.identity.headerTree='validated-ndk-v2';await extractTargetDeclarations(request);assert.equal(count(),6);
  request.identity.resources.push('additional-resource.h');await extractTargetDeclarations(request);assert.equal(count(),7);
  fs.writeFileSync(result,'corrupted output');await extractTargetDeclarations(request);assert.equal(count(),8);
  await extractTargetDeclarations(request);assert.equal(count(),8);
});

test('generated ARM32 calls retain shared native owners and pointer lifetimes',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!runtime)return t.skip('Requires the ARM32 component, generated NDK descriptors and shared Android runtime');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-imports-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'..'),native=path.join(root,'src/modules/android/native/arm32');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  for(const target of ['guest','host']){
    const declarations=JSON.parse(fs.readFileSync(path.resolve(generated,target+'-ast.json')));
    for(const type of Object.values(declarations.types))if(type.kind==='Pointer')assert.ok(type.element&&declarations.types[type.element]?.kind!=='Invalid','Original pointer/typedef has an actual pointee: '+type.name);
    assert.ok(declarations.types.jobject.aliases.includes('jobject'),'JNI reference ancestry remains available to the width adapter');
    const action=declarations.types['struct sigaction'];
    const handlers=action.fields.map(field=>declarations.types[field.type]).find(type=>type.union&&type.fields.some(field=>field.name==='sa_handler'));
    assert.ok(handlers?.fields.some(field=>field.name==='sa_sigaction'),'Anonymous signal-handler storage remains in the original declaration graph');
    for(const type of Object.values(declarations.types)){
      const links=[...(type.element?[type.element]:[]),...(type.result?[type.result]:[]),...type.parameters||[],...(type.fields||[]).map(field=>field.type)];
      for(const link of links)assert.ok(declarations.types[link],'Original type graph closes: '+type.name+' -> '+link);
    }
    // IID queries erase these types from their exported function signatures.
    // All public interface groups still enter the generated type universe.
    const descriptors=fs.readFileSync(path.resolve(generated,'native-imports.inc'),'utf8');
    const catalog=descriptors.split('static constexpr Interface interfaces[]=')[1];assert.ok(catalog);
    for(const variable of Object.values(declarations.variables))if(/^(SL|XA)_IID_/.test(variable.symbol)&&!variable.symbol.endsWith('_NULL'))assert.ok(catalog.includes('"'+variable.symbol+'"'),'Original interface has a generated typed output: '+variable.symbol);
  }
  // Exercise the actual component, not a newly compiled duplicate of its imports.
  require('./helpers/android-arm32-shapes').writeShapes(generated,temporary);
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,path.join(__dirname,'fixtures/android-arm32/imports-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-Wl,-rpath,'+path.resolve(build),'-o',path.join(temporary,'probe')]);
   const arguments_=[path.resolve(runtime,'native/libklepton-jvm.dylib')];
  assert.match(run(path.join(temporary,'probe'),arguments_),/PASS generated native ABI/);
});

test('original native callback types preserve AAPCS32 narrow parameter words',async t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated)return t.skip('Requires the ARM32 component and original generated declarations');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-callback-width-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const include=JSON.parse(fs.readFileSync(path.resolve(generated,'guest-input.json'),'utf8')).include;
  const {prepareFutexConstants}=await import('../src/modules/android/native/arm32/syscall-sources.mjs');
  const {generateLoaderAbi}=await import('../src/modules/android/native/arm32/imports-generate.mjs');
  const {generateSignalAbi}=await import('../src/modules/android/native/arm32/signal-abi.mjs');
  prepareFutexConstants({include,output:temporary,clang:process.env.ANDROID_CLANG});
  generateLoaderAbi({include,output:temporary,clang:process.env.ANDROID_CLANG});
  generateSignalAbi({include,output:temporary,clang:process.env.ANDROID_CLANG});
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'callback-width');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,'-I'+path.resolve(generated),'-I'+path.resolve(generated,'../format'),'-I'+path.resolve(generated,'../syscalls'),'-DARM32_IMPORTS_SOURCE="'+path.join(native,'native-imports.cpp')+'"',path.join(__dirname,'fixtures/android-arm32/callback-width-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[]),/PASS original typed callbacks preserve AAPCS32/);
});
