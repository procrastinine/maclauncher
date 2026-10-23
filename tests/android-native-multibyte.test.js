const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original Bionic multibyte family retains exact state, UTF conversions and aliases',t=>{
  const library=process.env.ANDROID_CTYPE_LIBRARY,metadata=process.env.ANDROID_CTYPE_METADATA,ast=process.env.ANDROID_ARM32_IMPORTS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!library||!metadata||!ast)return t.skip('Requires the original compiled Bionic family and declarations');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-multibyte-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const names=JSON.parse(fs.readFileSync(metadata)).exports;
  const declarations=JSON.parse(fs.readFileSync(path.join(ast,'host-ast.json'))),size=declarations.types.mbstate_t.size;
  for(const [name,fn]of Object.entries(declarations.functions))if(fn.type.includes('mbstate_t'))assert.ok(names.includes(name),'Every original stateful declaration retains its family implementation: '+name);
  fs.writeFileSync(path.join(temporary,'exports.h'),'inline constexpr const char* exports[]={'+names.map(JSON.stringify).join(',')+'};\n');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  const binary=path.join(temporary,'multibyte');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+temporary,path.join(__dirname,'fixtures/android-native-multibyte.cpp'),'-o',binary]);
  assert.match(run(binary,[path.resolve(library),String(size)]),/PASS original Bionic multibyte states, guards, error mapping, aliases and iconv/);
});

test('actual ARM32 conversion retains the original four-byte multibyte state',t=>{
  const library=process.env.ANDROID_CTYPE_LIBRARY,component=process.env.ANDROID_ARM32_BUILD,runtime=process.env.KLEPTON_NATIVE_RUNTIME,ast=process.env.ANDROID_ARM32_IMPORTS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!library||!component||!runtime||!ast)return t.skip('Requires the compiled original family, ARM32 component and shared native owner');
  const read=target=>JSON.parse(fs.readFileSync(path.join(ast,target+'-ast.json')));
  assert.equal(read('guest').types.mbstate_t.size,4);assert.equal(read('host').types.mbstate_t.size,8);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-multibyte-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  const binary=path.join(temporary,'multibyte');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+path.resolve(__dirname,'../src/modules/android/native/arm32'),path.join(__dirname,'fixtures/android-arm32/multibyte-probe.cpp'),path.resolve(component,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(component),'-o',binary]);
  assert.match(run(binary,[path.resolve(library),path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS actual ARM32 four-byte state, partial UTF-8, native conversion and exact guards/);
});
