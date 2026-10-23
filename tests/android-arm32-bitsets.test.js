const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');

test('original ARM32 packed fd_set bits retain native select semantics and exact bounds',t=>{
 const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!runtime)return t.skip('Requires the ARM32 component, original declarations and shared native owner');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-bitsets-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const read=target=>JSON.parse(fs.readFileSync(path.join(generated,target+'-ast.json'),'utf8')),guest=read('guest'),host=read('host');
 const shapes=target=>{
  const fn=target.types[target.functions.select.type],set=target.types[target.types[fn.parameters[1]].element],time=target.types[target.types[fn.parameters[4]].element];
  assert.equal(set.kind,'Record');assert.equal(set.fields.length,1);const field=set.fields[0],array=target.types[field.type],word=target.types[array.element];
  assert.equal(array.kind,'ConstantArray');assert.equal(field.offset,0);assert.equal(array.size,set.size);assert.equal(word.size*array.count,set.size);
  return {bytes:set.size,word:word.size,count:array.count,time:time.size};
 };
 const g=shapes(guest),h=shapes(host);assert.equal(g.bytes,h.bytes);assert.notEqual(g.count,h.count);assert.notEqual(g.word,h.word);
 fs.writeFileSync(path.join(temporary,'bitset-shapes.h'),'#pragma once\nnamespace shapes {\n'+Object.entries({guestBytes:g.bytes,hostBytes:h.bytes,guestTime:g.time,hostTime:h.time}).map(([key,value])=>`inline constexpr unsigned ${key}=${value};`).join('\n')+'\n}\n');
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.ifError(result.error);assert.equal(result.status,0,[result.signal,result.stdout,result.stderr].filter(Boolean).join('\n'));return result.stdout;};
 const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'bitsets');
 run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,path.join(__dirname,'fixtures/android-arm32/fdset-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
 assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS original packed fd_set select bits, exact spans, guards and errors/);
});
