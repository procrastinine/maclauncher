const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('explicit native startup observation preserves pre-handler app faults without consuming ART null faults',{timeout:180000},t=>{
 const source=process.env.ANDROID_AIM_SOURCE,target=process.env.ANDROID_AIM_CARGO_TARGET;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!source||!target)return t.skip('Requires Apple Silicon and an AIM diagnostic projection');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-startup-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 fs.mkdirSync(path.join(temporary,'src'));fs.copyFileSync(path.resolve('tests/fixtures/android-art-faults/startup.rs'),path.join(temporary,'src/main.rs'));
 fs.writeFileSync(path.join(temporary,'Cargo.toml'),'[package]\nname="android-art-startup-probe"\nversion="0.0.0"\nedition="2024"\n[dependencies]\naim-linux-abi={path='+JSON.stringify(path.resolve(source,'crates/aim-linux-abi'))+'}\nlibc="0.2"\n');
 fs.copyFileSync(path.resolve(source,'Cargo.lock'),path.join(temporary,'Cargo.lock'));
 const run=(command,args,timeout=15000)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer:4<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result;};
 run('cargo',['build','--offline','--release','-j','2','--manifest-path',path.join(temporary,'Cargo.toml'),'--target-dir',path.resolve(target)],150000);
 const binary=path.resolve(target,'release/android-art-startup-probe');
 for(const mode of ['enabled','disabled','system','reused','bounds','retired','origin']){
  const result=run(binary,[mode]);assert.match(result.stdout,/PASS actual app-library SIGILL and MAPERR preserve registers, guest continuation and errno/);
  const lines=result.stderr;
  assert.equal((lines.match(/handled fault/g)||[]).length,['disabled','system','reused'].includes(mode)?0:mode==='bounds'?16:mode==='origin'?3:2,lines);
  if(mode==='origin'){
   assert.match(lines,/module_origin=lr pc=0x0000000000000000/);
   assert.match(lines,/instruction=unreadable/);
  }
  if(mode==='enabled'){
   assert.match(lines,/signal=0x0000000000000004 code=0x0000000000000001/);
   assert.match(lines,/signal=0x000000000000000b code=0x0000000000000001/);
   assert.match(lines,/instruction=0x0000000000000000/);assert.match(lines,/instruction=0x00000000f9000020/);
   assert.match(lines,/addr=0x0000000000000000/);
   for(const value of ['x0=0x0000000000001122','x5=0x0000000000005566','x16=0x0000000000007788'])assert.ok(lines.includes(value),lines);
  }
 }
});
