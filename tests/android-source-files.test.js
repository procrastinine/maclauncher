const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-source-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('Pinned source export preserves unchanged files and removes superseded selected originals',async t=>{
  const root=fixture(t),checkout=path.join(root,'original'),output=path.join(root,'source');fs.mkdirSync(checkout);
  const git=(...args)=>execFileSync('git',['-C',checkout,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();git('init');
  const commit=()=>{git('add','-A');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','source');return git('rev-parse','HEAD');};
  fs.mkdirSync(path.join(checkout,'one'));fs.mkdirSync(path.join(checkout,'two'));
  fs.writeFileSync(path.join(checkout,'one/data'),Buffer.from([0,1,255]));fs.writeFileSync(path.join(checkout,'one/run'),'#!/bin/sh\n', {mode:0o755});
  fs.symlinkSync('data',path.join(checkout,'one/link'));fs.writeFileSync(path.join(checkout,'two/kept'),'second selection');const first=commit();
  const {exportSources}=await import('../src/modules/android/native/binder-rpc/build.mjs');
  exportSources(checkout,first,['one','two'],output);const tracked=['one/data','one/run','one/link'];
  const before=tracked.map(file=>fs.lstatSync(path.join(output,file),{bigint:true}).mtimeNs);
  exportSources(checkout,first,['one'],output);assert.deepEqual(tracked.map(file=>fs.lstatSync(path.join(output,file),{bigint:true}).mtimeNs),before);
  assert.equal(fs.statSync(path.join(output,'one/run')).mode&0o777,0o755);assert.equal(fs.readlinkSync(path.join(output,'one/link')),'data');
  fs.writeFileSync(path.join(output,'generated'),'owned output');fs.unlinkSync(path.join(checkout,'one/run'));fs.writeFileSync(path.join(checkout,'one/data'),'changed');
  const second=commit();exportSources(checkout,second,['one'],output);
  assert.equal(fs.readFileSync(path.join(output,'one/data'),'utf8'),'changed');assert(!fs.existsSync(path.join(output,'one/run')));
  assert.equal(fs.readFileSync(path.join(output,'two/kept'),'utf8'),'second selection');assert.equal(fs.readFileSync(path.join(output,'generated'),'utf8'),'owned output');
  assert.throws(()=>exportSources(checkout,first,['one'],output),/revision does not match/);
  // The original release inventory owns a bare object store, without a branch
  // or worktree. Export exactly the pinned commit, preserving its old bytes.
  const bare=path.join(root,'inventory.git'),bareOutput=path.join(root,'bare-source');
  execFileSync('git',['clone','--bare',checkout,bare],{stdio:'pipe'});
  execFileSync('git',['-C',bare,'symbolic-ref','HEAD','refs/heads/unborn']);
  exportSources(bare,first,['one'],bareOutput);
  assert.deepEqual(fs.readFileSync(path.join(bareOutput,'one/data')),Buffer.from([0,1,255]));
  assert.equal(fs.readlinkSync(path.join(bareOutput,'one/link')),'data');
  assert.equal(fs.statSync(path.join(bareOutput,'one/run')).mode&0o777,0o755);
});
test('Strict source adaptations publish only changed final content and leave prior inputs on failure',async t=>{
  const root=fixture(t),destination=path.join(root,'projected');
  const {prepareSourceTree}=await import('../src/modules/android/native/upstream/source-files.mjs');
  const prepare=(text,extra=false)=>temporary=>{fs.writeFileSync(path.join(temporary,'source.c'),'original');fs.writeFileSync(path.join(temporary,'source.c'),text);if(extra)fs.writeFileSync(path.join(temporary,'removed.h'),'old');};
  prepareSourceTree(destination,prepare('adapted',true));const file=path.join(destination,'source.c'),before=fs.statSync(file,{bigint:true});
  prepareSourceTree(destination,prepare('adapted'));assert.equal(fs.statSync(file,{bigint:true}).mtimeNs,before.mtimeNs);assert(!fs.existsSync(path.join(destination,'removed.h')));
  assert.throws(()=>prepareSourceTree(destination,temporary=>{prepare('failed')(temporary);throw Error('bad anchor');}),/bad anchor/);
  assert.equal(fs.readFileSync(file,'utf8'),'adapted');assert.deepEqual(fs.readdirSync(root),['projected']);
  prepareSourceTree(destination,prepare('new adaptation'));assert.equal(fs.readFileSync(file,'utf8'),'new adaptation');
});
test('KeyMint property adapters preserve unchanged compiler inputs',async t=>{
  const root=fixture(t),libbase=path.join(root,'libbase'),bionic=path.join(root,'bionic'),output=path.join(root,'properties');
  for(const [file,content]of [
    [path.join(libbase,'properties.cpp'),'#if defined(__BIONIC__)\nint property_value;\n#endif\n'],
    [path.join(libbase,'include/android-base/properties.h'),'#if !defined(__BIONIC__)\nvoid alternate_properties();\n#endif\n'],
    [path.join(bionic,'libc/include/sys/system_properties.h'),'#include <sys/cdefs.h>\nint property_get();\n'],
  ]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
  const {preparePropertyHeaders}=await import('../src/modules/android/native/keystore/property-sources.mjs');
  const first=preparePropertyHeaders({output,libbase,bionic}),files=first.adaptations.map(row=>row.destination);
  const times=()=>files.map(file=>fs.statSync(file,{bigint:true}).mtimeNs),before=times();
  assert.deepEqual(preparePropertyHeaders({output,libbase,bionic}),first);assert.deepEqual(times(),before);
  assert.match(fs.readFileSync(first.source,'utf8'),/#if 1/);
  fs.appendFileSync(path.join(libbase,'properties.cpp'),'int changed_property;\n');
  preparePropertyHeaders({output,libbase,bionic});const after=times();
  assert.ok(after[0]>before[0]);assert.deepEqual(after.slice(1),before.slice(1),'Unchanged generated headers keep their timestamps');
});
test('Original libcore supplier reuses objects and preserves adapted-source and published-library timestamps',async t=>{
  const names=['AOSP_LIBCORE_SOURCE','AOSP_ART_SOURCE','ANDROID_BINDER_OUTPUT','ANDROID_BINDER_LIBRARY','PYTHON','NINJA'];
  if(process.platform!=='darwin'||names.some(name=>!process.env[name]))return t.skip('Requires original source suppliers, Binder library and configured build tools');
  const root=fixture(t);
  const {buildLibcore}=await import('../src/modules/android/native/libcore/build.mjs');
  const options={libcoreSource:path.resolve(process.env.AOSP_LIBCORE_SOURCE),artSource:path.resolve(process.env.AOSP_ART_SOURCE),
    binder:{library:path.resolve(process.env.ANDROID_BINDER_LIBRARY),output:path.resolve(process.env.ANDROID_BINDER_OUTPUT)},output:path.join(root,'libcore'),python:process.env.PYTHON,ninja:process.env.NINJA};
  const result=buildLibcore(options),objects=path.join(options.output,'objects/libandroid-libcore.dylib');
  const retained=[result.library,path.join(result.source,'libcore/luni/src/main/native/libcore_io_Memory.cpp'),
    path.join(result.source,'art/runtime/native/libcore_io_Memory.cc'),...fs.readdirSync(objects).filter(name=>name.endsWith('.o')).map(name=>path.join(objects,name))];
  assert.equal(retained.length,6,'Both original Memory units and the JNI adapter compile separately');
  const timestamps=retained.map(file=>fs.statSync(file,{bigint:true}).mtimeNs),bytes=fs.readFileSync(result.library);
  fs.writeFileSync(path.join(result.source,'superseded.h'),'old source');buildLibcore(options);
  assert.deepEqual(retained.map(file=>fs.statSync(file,{bigint:true}).mtimeNs),timestamps);
  assert.ok(fs.readFileSync(result.library).equals(bytes));assert(!fs.existsSync(path.join(result.source,'superseded.h')));
});
test('Native configuration and original CMake depfiles reuse products and rebuild changed headers',async t=>{
  if(process.platform!=='darwin')return t.skip('Requires the Darwin build tools');
  const ninja=process.env.NINJA||'ninja';try{execFileSync(ninja,['--version'],{stdio:'pipe'});}catch{return t.skip('Requires the native build Ninja supplier');}
  const root=fixture(t),source=path.join(root,'source'),build=path.join(root,'build');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'CMakeLists.txt'),'cmake_minimum_required(VERSION 3.16)\nproject(source_cache C)\nadd_library(example STATIC example.c)\n');
  fs.writeFileSync(path.join(source,'example.c'),'#include "value.h"\nint value(void){return VALUE;}\n');fs.writeFileSync(path.join(source,'value.h'),'#define VALUE 17\n');
  const {configureCmake}=await import('../src/modules/android/native/upstream/native-configure.mjs');const options={source,build,ninja,args:['-DCMAKE_BUILD_TYPE=Release']};
  assert(configureCmake(options));const compile=()=>execFileSync('cmake',['--build',build],{stdio:'pipe',encoding:'utf8'});compile();
  const library=path.join(build,'libexample.a'),before=fs.statSync(library,{bigint:true}).mtimeNs,bytes=fs.readFileSync(library);
  assert.equal(configureCmake(options),false);compile();assert.equal(fs.statSync(library,{bigint:true}).mtimeNs,before);
  fs.writeFileSync(path.join(source,'value.h'),'#define VALUE 18\n');assert.equal(configureCmake(options),false);compile();assert(!fs.readFileSync(library).equals(bytes));
});
