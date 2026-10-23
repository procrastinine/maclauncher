const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original Bionic math namespace and floating-point environment keep the Android ARM64 ABI',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon');
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,prepared=process.env.ANDROID_NATIVE_MATH_BUILD;
  if(!runtime||!prepared)return t.skip('Requires the prepared native math closure and runtime dependencies');
  const product=JSON.parse(fs.readFileSync(path.join(prepared,'prepared.json')));
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-math-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,env:{...process.env,DYLD_LIBRARY_PATH:path.join(runtime,'native')}});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const library=path.join(temporary,'math.dylib');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-dynamiclib',...product.objects,path.join(runtime,'native/libklepton-jvm.dylib'),'-o',library]);
  fs.writeFileSync(path.join(temporary,'math-expected.inc'),product.entries.filter(entry=>entry.owner!=='binary128').map(entry=>'assert(lookup('+JSON.stringify(entry.name)+'));').join('\n'));
  const binary=path.join(temporary,'probe');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-std=c11','-O2','-fno-builtin','-I'+temporary,path.join(__dirname,'fixtures/android-native/math-boundary.c'),'-o',binary]);
  assert.match(run(binary,[library]),/PASS complete float\/double namespace/);
  const names=new Set(product.entries.map(entry=>entry.name));
  assert.equal(names.size,product.entries.length);
  for(const entry of product.entries)assert.equal(entry.owner==='binary128',entry.type.includes('long double'));
});
