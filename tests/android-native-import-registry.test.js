const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('native import registration is concurrent, idempotent and preserves owner precedence',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires clang and pthreads');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'native-imports-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const native=path.resolve(__dirname,'../src/modules/android/native'),binary=path.join(temporary,'registry');
 for(const [command,args]of [['clang',['-std=c11','-O2','-pthread','-I'+native,path.join(native,'native-import-registry.c'),path.join(__dirname,'fixtures/android-native/import-registry.c'),'-o',binary]],[binary,[]]]){const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);}
 const {prepareImportRegistry}=await import('../src/modules/android/native/import-registry-source.mjs');const shim=path.join(temporary,'shim.c');
 fs.writeFileSync(shim,'void *(*kl_shim_override)(const char *name);\nvoid *lookup(const char *name){if (kl_shim_override) { void *o = kl_shim_override(name); if (o) return o; }\n    if (ndk) return ndk;\nreturn 0;}');prepareImportRegistry(shim);assert.doesNotMatch(fs.readFileSync(shim,'utf8'),/kl_shim_override/);
});
