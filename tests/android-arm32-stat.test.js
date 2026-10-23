const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

function statShapes(directory,output){
  const read=target=>JSON.parse(fs.readFileSync(path.join(directory,target+'-ast.json'),'utf8'));
  const guest=read('guest'),host=read('host'),records=new Map();
  const functions=Object.entries(guest.functions).filter(([name])=>/^(?:stat|lstat|fstat|fstatat)(?:64)?$/.test(name)).sort(([a],[b])=>Number(a.startsWith('fstatat'))-Number(b.startsWith('fstatat'))||a.localeCompare(b));
  assert.equal(functions.length,8,'The original declarations retain the complete stat family');
  const fields=(g,h,go=0,ho=0,prefix='')=>g.fields.flatMap(field=>{
    assert.equal(field.bits,0);assert.ok(field.offset>=0&&field.offset%8===0);
    const type=guest.types[field.type],name=prefix+field.name,gOffset=go+field.offset/8;
    const padding=/^__(?:pad|unused)\d+$/.test(field.name);
    const original=h.fields.find(value=>value.name===(field.name==='__st_ino'?'st_ino':field.name));
    if(padding)return [{name,guestOffset:gOffset,guestSize:type.size,hostOffset:0,hostSize:0,padding:true}];
    assert.ok(original,'An original semantic field needs its native owner: '+name);
    assert.equal(original.bits,0);assert.ok(original.offset>=0&&original.offset%8===0);
    const native=host.types[original.type],hOffset=ho+original.offset/8;
    if(type.kind==='Record'){assert.equal(native.kind,'Record');return fields(type,native,gOffset,hOffset,name+'.');}
    assert.ok(type.size>0&&type.size<=8&&native.size>0&&native.size<=8,name);
    return [{name,guestOffset:gOffset,guestSize:type.size,hostOffset:hOffset,hostSize:native.size,padding:false}];
  });
  const entries=functions.map(([name,fn])=>{
    const gt=guest.types[fn.type],ht=host.types[host.functions[name].type];
    const index=gt.parameters.findIndex(id=>guest.types[id].kind==='Pointer'&&guest.types[guest.types[id].element]?.kind==='Record');
    assert.ok(index>=0);const g=guest.types[guest.types[gt.parameters[index]].element],h=host.types[host.types[ht.parameters[index]].element];
    if(!records.has(g.name))records.set(g.name,{id:records.size,guest:g.size,host:h.size,fields:fields(g,h)});
    const record=records.get(g.name),kind=name.startsWith('fstatat')?3:name.startsWith('fstat')?2:name.startsWith('lstat')?1:0;
    return `{${JSON.stringify(name)},${kind},${record.guest},${record.host},fields${record.id},std::size(fields${record.id})}`;
  });
  const lists=[...records.values()].map(record=>'inline constexpr Field fields'+record.id+'[]={\n'+record.fields.map(field=>`{${JSON.stringify(field.name)},${field.guestOffset},${field.guestSize},${field.hostOffset},${field.hostSize},${field.padding}}`).join(',\n')+'\n};').join('\n');
  fs.writeFileSync(path.join(output,'stat-shapes.h'),'#pragma once\n#include <iterator>\nnamespace stat_shapes {\nstruct Field {const char *name;unsigned guestOffset,guestSize,hostOffset,hostSize;bool padding;};\nstruct Function {const char *name;unsigned kind,guestSize,hostSize;const Field *fields;unsigned count;};\n'+lists+'\ninline constexpr Function functions[]={\n'+entries.join(',\n')+'\n};\n}\n');
}

test('ARM32 original stat family preserves native fields, inode aliases and output bounds',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated||!runtime)return t.skip('Requires the built ARM32 component, original declarations and shared native owner');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-stat-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  statShapes(generated,temporary);
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(temporary,'stat');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+temporary,path.join(__dirname,'fixtures/android-arm32/stat-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),temporary]),/PASS all original ARM32 stat variants, fields, inode aliases, guards and failure semantics/);
});
