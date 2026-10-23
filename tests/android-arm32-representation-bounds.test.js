const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('persistent ARM32 representations expose exact original type bounds',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!runtime)return t.skip('Requires the built ARM32 component, original declarations and shared native owner');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-representation-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  require('./helpers/android-arm32-shapes').writeShapes(generated,temporary);
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32');
  const binary=path.join(temporary,'bounds');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,path.join(__dirname,'fixtures/android-arm32/representation-bounds-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS exact original ARM32 pointer\/table bounds and retirement/);
});

test('ARM32 native resource release retires aliases before physical storage',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!runtime)return t.skip('Requires the built ARM32 component, original declarations and shared native owner');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-release-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const declarations=target=>JSON.parse(fs.readFileSync(path.join(generated,target+'-ast.json')));
  const record=declarations=>{const {types}=declarations;let type=types[types[declarations.functions.getaddrinfo.type].parameters[3]];while(type.kind==='Pointer')type=types[type.element];assert.equal(type.kind,'Record');return type;};
  const guest=declarations('guest'),host=declarations('host'),g=record(guest),h=record(host);
  const field=(type,name)=>{const value=type.fields.find(f=>f.name===name);assert.ok(value&&value.offset>=0&&value.offset%8===0);return value;};
  const address=host.types[host.types[field(h,'ai_addr').type].element];
  const sizes={guestSize:g.size,hostSize:h.size,addressBytes:address.size,lengthHost:field(h,'ai_addrlen').offset/8,allocationAlignment:host.types.max_align_t.alignment};
  for(const [name,member]of [['next','ai_next'],['canonical','ai_canonname'],['address','ai_addr']]){sizes[name+'Guest']=field(g,member).offset/8;sizes[name+'Host']=field(h,member).offset/8;}
  fs.writeFileSync(path.join(temporary,'resource-shapes.h'),'#pragma once\nnamespace resource_shapes {\n'+Object.entries(sizes).map(([name,value])=>`inline constexpr unsigned ${name}=${value};`).join('\n')+'\n}\n');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'release');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,path.join(__dirname,'fixtures/android-arm32/resource-release-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS native release, alias reuse, realloc failure and complete typed resolver retirement/);
});

test('ARM32 byte spans use guest layouts while typed interfaces keep native identity',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!runtime)return t.skip('Requires the built ARM32 component, original declarations and shared native owner');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-byte-view-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  require('./helpers/android-arm32-shapes').writeShapes(generated,temporary);
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'byte-view');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,path.join(__dirname,'fixtures/android-arm32/byte-view-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS ARM32 byte views, aliases, vector IO and original typed interfaces/);
});
