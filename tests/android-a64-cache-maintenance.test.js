const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original precise A64 userspace cache operations preserve state and source ownership',{timeout:30000},t=>{
 const source=process.env.ANDROID_PRECISE_SOURCE,unicorn=process.env.ANDROID_UNICORN_ARCHIVE,headers=process.env.ANDROID_UNICORN_HEADERS;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![source,unicorn,headers].every(Boolean))return t.skip('Requires Apple Silicon, original precise sources and retained Unicorn archive/headers');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-a64-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(args)=>{const result=spawnSync('clang++',args,{encoding:'utf8',timeout:25000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);};
 const object=path.join(root,'precise.o'),binary=path.join(root,'cache-maintenance');
 run(['-std=c++20','-O2','-g0','-arch','arm64','-mmacosx-version-min=13.0','-I'+headers,'-I'+source,'-c',path.join(source,'precise.cpp'),'-o',object]);
 run(['-std=c++20','-O2','-arch','arm64','-mmacosx-version-min=13.0','-I'+source,path.join(__dirname,'fixtures/android-native/a64-cache-maintenance.cpp'),object,unicorn,'-o',binary]);
 const result=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 for(const message of ['original EL0 cache maintenance and barriers preserve architectural state','privileged cache operations remain undefined at EL0','owned source changes revalidate across the original cache-maintenance sequence'])assert.ok(result.stdout.includes('PASS '+message),result.stdout+result.stderr);
 t.diagnostic(result.stdout.trim());
});
