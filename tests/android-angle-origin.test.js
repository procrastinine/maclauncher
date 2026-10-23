const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Metal framebuffer flip preserves Android buffer origins and CPU Canvas row order',t=>{
 const provider=process.env.ANDROID_ANGLE_ORIGIN,headers=process.env.ANDROID_ANGLE_HEADERS;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!provider||!headers)return t.skip('Requires Metal ANGLE supplier and original headers');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-angle-origin-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:60000,maxBuffer:1<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const binary=path.join(temporary,'probe');run('/usr/bin/xcrun',['clang++','-std=c++20','-arch','arm64','-mmacosx-version-min=13.0','-fobjc-arc','-Wall','-Wextra','-Werror','-I'+path.resolve(headers),path.resolve('tests/fixtures/android-native/angle-framebuffer-origin.mm'),'-framework','Metal','-framework','Foundation','-o',binary]);
 const output=run(binary,[path.resolve(provider)]);assert.match(output,/PASS Metal Android buffer orientation/);t.diagnostic(output.trim());
});
