const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Linux UDP multicast uses original native sockets and device ownership',{timeout:180000},t=>{
 const source=process.env.ANDROID_AIM_SOURCE,target=process.env.ANDROID_AIM_CARGO_TARGET;
 if(process.platform!=='darwin'||!source||!target)return t.skip('Requires adapted AIM source and the component Cargo target');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-multicast-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 fs.mkdirSync(path.join(temporary,'src'));fs.mkdirSync(path.join(temporary,'state'));
 fs.copyFileSync(path.resolve('tests/fixtures/android-art-network/multicast.rs'),path.join(temporary,'src/main.rs'));
 fs.copyFileSync(path.resolve(source,'Cargo.lock'),path.join(temporary,'Cargo.lock'));
 fs.writeFileSync(path.join(temporary,'Cargo.toml'),'[package]\nname="android-art-multicast-probe"\nversion="0.0.0"\nedition="2024"\n[dependencies]\naim-linux-abi={path='+JSON.stringify(path.resolve(source,'crates/aim-linux-abi'))+'}\nlibc="0.2"\n[profile.release]\nstrip=false\n');
 const run=(command,args,timeout)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer:4<<20});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout+r.stderr;};
 run('cargo',['build','--offline','--release','-j','2','--manifest-path',path.join(temporary,'Cargo.toml'),'--target-dir',path.resolve(target)],150000);
 const output=run(path.resolve(target,'release/android-art-multicast-probe'),[path.join(temporary,'state')],15000);
 assert.match(output,/PASS original Linux UDP multicast scalars, widths, interfaces, memberships, errors and real loopback delivery/);t.diagnostic(output.split('\n').find(line=>line.startsWith('PASS ')));
});

test('original Bionic retains multicast initialization and interface state across fork',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang,ANDROID_ART_MULTICAST_BASELINE:baseline}=process.env;
 if(process.platform!=='darwin'||!payload||!runner||!clang)return t.skip('Requires the Android image, executor and NDK');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-multicast-guest-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const run=(command,args,env=process.env,status=0)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,env,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.status,status,r.stdout+r.stderr);return r.stdout+r.stderr;};
 const guest=path.join(root,'probe');run(clang,['-O1',path.resolve('tests/fixtures/android-art-network/multicast-guest.c'),'-o',guest]);
 for(const [name,executor]of [...(baseline?[['previous',baseline]]:[]),['current',runner]]){
  const state=path.join(root,name);fs.mkdirSync(state);
  const map=publishPathMap(state,'multicast',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/multicast-probe\t'+guest+'\n',path.join(state,'mounts')));
  const env={...environment(supplier),DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')},args=['--inherit-env','--guest-fds','0,1,2','--path-map',map,'--no-cache','--host-module',c.hostLibrary];
  run(executor,[...args,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],env);
  const output=run(executor,[...args,'/data/local/tmp/multicast-probe'],env,name==='previous'?2:0);
  assert.match(output,name==='previous'?/Original Bionic multicast loopback errno=92/:/PASS original Bionic multicast initialization and forked interface state/);
 }
 t.diagnostic('Original Bionic socket options and original fork preserve the Linux interface records');
});
