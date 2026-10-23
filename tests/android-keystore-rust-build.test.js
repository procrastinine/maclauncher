const test=require('node:test');
const assert=require('node:assert/strict');

test('Rust service dependency resolution preserves inherited Android target dependencies',async()=>{
  const {properties}=await import('../src/modules/android/native/keystore/rust/blueprint.mjs');
  const modules=new Map(Object.entries({
    transport:{properties:{name:'transport',rustlibs:['binder'],target:{android:{rustlibs:['properties']}}}},
    defaults:{properties:{name:'defaults',defaults:['transport'],rustlibs:['crypto'],features:['watchdog']}},
    service:{properties:{name:'service',defaults:['defaults'],rustlibs:['database'],target:{android:{rustlibs:['files']}}}},
  }));
  const p=properties(modules,'service');
  assert.deepEqual(p.rustlibs,['binder','properties','crypto','database','files']);
  assert.deepEqual(p.features,['watchdog']);
});

test('Rust dependency resolution identifies missing declarations and default cycles during builds',async()=>{
  const {properties}=await import('../src/modules/android/native/keystore/rust/blueprint.mjs');
  assert.throws(()=>properties(new Map(),'service'),/Missing upstream build declaration/);
  const modules=new Map([
    ['a',{properties:{name:'a',defaults:['b']}}],
    ['b',{properties:{name:'b',defaults:['a']}}],
  ]);
  assert.throws(()=>properties(modules,'a'),/Circular upstream defaults/);
});

test('Rust crate publication reuses Cargo artifacts and retires removed original sources',async t=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
  if(process.platform!=='darwin')return t.skip('Requires Darwin native adapters');
  const cargo=process.env.ANDROID_CARGO||'cargo';
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-rust-publication-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
  const sources={boringssl:path.join(root,'boringssl'),security:path.join(root,'security'),logging:path.join(root,'logging')};
  const sys=path.join(sources.boringssl,'src/rust/bssl-sys/src');
  write(path.join(sys,'lib.rs'),'include!(concat!(env!("OUT_DIR"),"/bindgen.rs"));\npub fn value()->i32{GENERATED}\n');
  write(path.join(sys,'removed.rs'),'pub const REMOVED:i32=1;\n');
  write(path.join(sources.boringssl,'src/rust/bssl-crypto/src/lib.rs'),'pub fn crypto()->i32{1}\n');
  write(path.join(sources.security,'keystore2/src/crypto/crypto.cpp'),'extern "C" int crypto_value(){return 7;}\n');
  const include=path.join(root,'include');fs.mkdirSync(include);
  const modules=new Map([
    ['libkeystore2_crypto_bindgen',{properties:{wrapper_src:'include/crypto.hpp',bindgen_flags:[]}}],
    ['libkeystore2_crypto',{properties:{srcs:['crypto.cpp']}}],
  ]);
  let binding=7;const calls=[];
  const workspace=path.join(root,'rust'),context={modules,sources,workspace,foundation:{crypto:{include}},versions:{bindgen:{version:'0.69.4'}},
    runCargo(args){
      calls.push(args);assert.equal(args[args.indexOf('--manifest-path')+1],path.join(workspace,'bindgen-tool/Cargo.toml'));
      const output=args.at(-1);assert.equal(args.at(-2),'--');
      // A small generator fixture exercises the production publication owner;
      // it does not emulate BoringSSL or compile the full KeyStore service.
      write(path.join(output,'bssl_wrapper.c'),'int wrapper_value(void){return 7;}\n');
      write(path.join(output,'bssl_bindings.rs'),'pub const GENERATED:i32='+binding+';\n');
      write(path.join(output,'keystore2_bindings.rs'),'pub const KEY:i32=7;\n');
    }};
  const {prepareCrypto}=await import('../src/modules/android/native/keystore/rust/crypto.mjs');
  prepareCrypto(context);
  const manifest=path.join(workspace,'platform/bssl-sys/Cargo.toml');
  const build=()=>execFileSync(cargo,['build','--offline','--manifest-path',manifest,'--message-format=json','--target-dir',path.join(root,'cargo-target')],
    {encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,CARGO_INCREMENTAL:'0'}}).trim().split('\n').map(line=>JSON.parse(line));
  const artifact=messages=>messages.find(message=>message.reason==='compiler-artifact'&&message.target.name==='bssl_sys');
  const first=artifact(build());assert.equal(first.fresh,false);
  const retained=['bindgen-tool/Cargo.toml','bindgen-tool/src/main.rs','generated-crypto/bssl_bindings.rs','platform/bssl-sys/Cargo.toml','platform/bssl-sys/build.rs','platform/bssl-sys/src/lib.rs','platform/keystore2_crypto_bindgen/lib.rs'];
  const times=()=>retained.map(file=>fs.statSync(path.join(workspace,file),{bigint:true}).mtimeNs);
  const before=times(),product=first.filenames.find(file=>file.endsWith('.rlib')),productTime=fs.statSync(product,{bigint:true}).mtimeNs;
  fs.unlinkSync(path.join(sys,'removed.rs'));
  write(path.join(workspace,'generated-crypto/obsolete.rs'),'old generated source');
  prepareCrypto(context);
  assert.deepEqual(times(),before,'Only final changed bytes may touch Cargo inputs');
  assert(!fs.existsSync(path.join(workspace,'platform/bssl-sys/src/removed.rs')));
  assert(!fs.existsSync(path.join(workspace,'generated-crypto/obsolete.rs')));
  assert.notEqual(calls[0].at(-1),calls[1].at(-1),'Generator output staging may change without changing tool source');
  assert.equal(artifact(build()).fresh,true,'Unrelated native preparation must reuse the real Cargo product');
  assert.equal(fs.statSync(product,{bigint:true}).mtimeNs,productTime);
  binding=8;prepareCrypto(context);
  assert.equal(artifact(build()).fresh,false,'Changed generated bindings must invalidate the actual Rust dependency');
  assert.equal(fs.statSync(path.join(workspace,'bindgen-tool/src/main.rs'),{bigint:true}).mtimeNs,before[1]);
});
